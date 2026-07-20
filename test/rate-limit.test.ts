import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  MemoryRateLimitBackend,
  RateLimiter,
  type RateLimitPolicy,
  type RateSource,
} from '../src/rate-limit.js';

const DISPATCHER: RateSource[] = [
  { scope: 'ip', id: '10.0.0.5' },
  { scope: 'key', id: 'control-room-a' },
];
const ATTACKER: RateSource[] = [{ scope: 'ip', id: '203.0.113.9' }];

function limiter(overrides: Partial<RateLimitPolicy> = {}) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  return new RateLimiter(new MemoryRateLimitBackend(), policy);
}

describe('the asymmetry between a hit and a miss', () => {
  it('prices a failed resolve far above a successful one', () => {
    // The one line of policy the whole defence rests on. Raw volume does not
    // separate a dispatcher from a guesser; the miss rate does.
    expect(DEFAULT_POLICY.resolveMissCost).toBeGreaterThan(DEFAULT_POLICY.resolveHitCost * 10);
  });

  it('lets far more hits than misses through the same budget', async () => {
    const hitsAllowed = DEFAULT_POLICY.resolveBudget / DEFAULT_POLICY.resolveHitCost;
    const missesAllowed = DEFAULT_POLICY.resolveBudget / DEFAULT_POLICY.resolveMissCost;
    expect(hitsAllowed / missesAllowed).toBe(30);
  });
});

describe('normal dispatcher usage', () => {
  it('is never throttled across a sustained shift of successful resolves', async () => {
    const rl = limiter();

    // 300 successful lookups inside one window — far more than a control room
    // would do, and the limiter should not so much as flinch.
    for (let i = 0; i < 300; i++) {
      const decision = await rl.checkResolve(DISPATCHER);
      expect(decision.allowed).toBe(true);
      await rl.recordResolve(DISPATCHER, 'hit');
    }

    expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(true);
  });

  it('tolerates the occasional genuine miss mixed into real work', async () => {
    const rl = limiter();

    // A dispatcher mistypes, or hits a code that expired thirty seconds ago.
    // That is normal and must not accumulate towards a penalty.
    for (let i = 0; i < 40; i++) {
      expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(true);
      await rl.recordResolve(DISPATCHER, i % 10 === 0 ? 'miss' : 'hit');
    }

    expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(true);
  });

  it('resets the backoff streak on any success', async () => {
    const rl = limiter();

    // Four consecutive misses — one short of the threshold.
    for (let i = 0; i < 4; i++) await rl.recordResolve(DISPATCHER, 'miss');
    // A hit wipes the streak clean.
    await rl.recordResolve(DISPATCHER, 'hit');
    // Four more should therefore still not trigger backoff.
    for (let i = 0; i < 4; i++) await rl.recordResolve(DISPATCHER, 'miss');

    expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(true);
  });

  it('does not let one control room exhaust another control room budget', async () => {
    const rl = limiter();
    const other: RateSource[] = [
      { scope: 'ip', id: '10.0.0.6' },
      { scope: 'key', id: 'control-room-b' },
    ];

    for (let i = 0; i < 40; i++) await rl.recordResolve(DISPATCHER, 'miss');
    expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(false);
    expect((await rl.checkResolve(other)).allowed).toBe(true);
  });
});

describe('enumeration', () => {
  it('throttles rapid misses fast', async () => {
    const rl = limiter();

    let allowedAttempts = 0;
    for (let i = 0; i < 100; i++) {
      const decision = await rl.checkResolve(ATTACKER);
      if (!decision.allowed) break;
      allowedAttempts += 1;
      await rl.recordResolve(ATTACKER, 'miss');
    }

    // Backoff engages after the streak threshold, well before the budget is
    // spent. A scan gets a handful of guesses, not hundreds.
    expect(allowedAttempts).toBeLessThanOrEqual(DEFAULT_POLICY.missStreakThreshold + 1);
    expect((await rl.checkResolve(ATTACKER)).allowed).toBe(false);
  });

  it('exhausts the budget in far fewer requests than a dispatcher uses', async () => {
    // With backoff disabled, isolate the budget mechanism alone.
    const rl = limiter({ missStreakThreshold: 1_000_000 });

    let misses = 0;
    while ((await rl.checkResolve(ATTACKER)).allowed && misses < 1_000) {
      await rl.recordResolve(ATTACKER, 'miss');
      misses += 1;
    }

    expect(misses).toBe(DEFAULT_POLICY.resolveBudget / DEFAULT_POLICY.resolveMissCost);
    expect(misses).toBeLessThan(25);
  });

  it('backs off exponentially as a miss streak lengthens', async () => {
    const rl = limiter({ backoffBaseSeconds: 1, backoffMaxSeconds: 10_000, resolveBudget: 1e9 });

    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await rl.recordResolve(ATTACKER, 'miss');
      const decision = await rl.checkResolve(ATTACKER);
      if (!decision.allowed) waits.push(decision.retryAfterSeconds);
    }

    // Each further consecutive miss roughly doubles the wait: the cost of a
    // scan grows faster than an attacker's patience.
    expect(waits.length).toBeGreaterThan(2);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    }
    expect(waits.at(-1)!).toBeGreaterThan(waits[0]! * 3);
  });

  it('caps the backoff so a shared address is never bricked forever', async () => {
    const rl = limiter({ backoffBaseSeconds: 2, backoffMaxSeconds: 300, resolveBudget: 1e9 });

    for (let i = 0; i < 40; i++) await rl.recordResolve(ATTACKER, 'miss');

    const decision = await rl.checkResolve(ATTACKER);
    expect(decision.allowed).toBe(false);
    // A whole office behind one NAT must be able to recover.
    expect(decision.allowed === false && decision.retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it('catches a leaked key used from many addresses', async () => {
    const rl = limiter({ missStreakThreshold: 1_000_000 });

    // Rotating source IPs defeats a per-IP limit entirely. The key axis is what
    // catches this.
    for (let i = 0; i < 25; i++) {
      await rl.recordResolve(
        [{ scope: 'ip', id: `198.51.100.${i}` }, { scope: 'key', id: 'leaked-key' }],
        'miss',
      );
    }

    const fresh = await rl.checkResolve([
      { scope: 'ip', id: '198.51.100.200' },
      { scope: 'key', id: 'leaked-key' },
    ]);
    expect(fresh.allowed).toBe(false);
    expect(fresh.allowed === false && fresh.scope).toBe('key');
  });
});

describe('mint limits', () => {
  it('are loose enough that a person in trouble is never throttled', async () => {
    const rl = limiter();
    const source: RateSource[] = [{ scope: 'ip', id: '10.0.0.5' }];

    // Someone panicking and jabbing the button repeatedly.
    for (let i = 0; i < 30; i++) {
      expect((await rl.checkMint(source)).allowed).toBe(true);
      await rl.recordMint(source);
    }
  });

  it('are much more permissive than the resolve miss budget', async () => {
    // Throttling a genuine caller mid-emergency is a worse failure than
    // absorbing some abuse, so the mint path is deliberately the loose one.
    const missesAllowed = DEFAULT_POLICY.resolveBudget / DEFAULT_POLICY.resolveMissCost;
    expect(DEFAULT_POLICY.mintBudget).toBeGreaterThan(missesAllowed * 5);
  });

  it('still stops bulk junk eventually', async () => {
    const rl = limiter({ mintBudget: 10 });
    const source: RateSource[] = [{ scope: 'ip', id: '203.0.113.9' }];

    for (let i = 0; i < 10; i++) await rl.recordMint(source);
    expect((await rl.checkMint(source)).allowed).toBe(false);
  });

  it('does not share a budget with the resolve path', async () => {
    const rl = limiter({ missStreakThreshold: 1_000_000 });
    const source: RateSource[] = [{ scope: 'ip', id: '203.0.113.9' }];

    // An address that has burned its resolve budget can still mint. Enumeration
    // and calling for help are different acts.
    for (let i = 0; i < 30; i++) await rl.recordResolve(source, 'miss');
    expect((await rl.checkResolve(source)).allowed).toBe(false);
    expect((await rl.checkMint(source)).allowed).toBe(true);
  });
});

describe('windows', () => {
  it('lets a budget recover once its window rolls over', async () => {
    const rl = limiter({ resolveWindowSeconds: 1, missStreakThreshold: 1_000_000 });

    for (let i = 0; i < 30; i++) await rl.recordResolve(ATTACKER, 'miss');
    expect((await rl.checkResolve(ATTACKER)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await rl.checkResolve(ATTACKER)).allowed).toBe(true);
  });

  it('does not let continued hammering extend a window', async () => {
    const rl = limiter({ resolveWindowSeconds: 1, missStreakThreshold: 1_000_000 });

    // Fixed window: a source cannot hold its own penalty window open by
    // continuing to spend inside it.
    for (let i = 0; i < 30; i++) {
      await rl.recordResolve(ATTACKER, 'miss');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await rl.checkResolve(ATTACKER)).allowed).toBe(true);
  });
});

describe('failure behaviour', () => {
  it('fails open rather than blocking dispatchers when the backend is down', async () => {
    const broken = {
      bump: async () => { throw new Error('redis gone'); },
      peek: async () => { throw new Error('redis gone'); },
      clear: async () => { throw new Error('redis gone'); },
      blockFor: async () => { throw new Error('redis gone'); },
      blockRemaining: async () => { throw new Error('redis gone'); },
    };
    const logged: string[] = [];
    const rl = new RateLimiter(broken, DEFAULT_POLICY, {
      warn: () => {},
      error: (_p, m) => void logged.push(m),
    });

    // A dispatcher must not be unable to locate someone in trouble because a
    // Redis fell over. The degradation is logged loudly instead.
    expect((await rl.checkResolve(DISPATCHER)).allowed).toBe(true);
    expect(logged.join(' ')).toMatch(/failing OPEN/i);

    await expect(rl.recordResolve(DISPATCHER, 'miss')).resolves.toBeUndefined();
  });
});
