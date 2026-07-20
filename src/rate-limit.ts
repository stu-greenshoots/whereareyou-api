import { Redis } from 'ioredis';

/**
 * Rate limiting and enumeration defence.
 *
 * The central idea, and the reason this is not an off-the-shelf requests-per-
 * minute limiter:
 *
 *   **A failed resolve costs far more budget than a successful one.**
 *
 * Raw request volume does not separate an attacker from a dispatcher. A busy
 * control room during a major incident may resolve codes faster than anyone
 * guessing at them, and a patient attacker can stay under any volume threshold
 * you pick. What actually separates them is the **miss rate**. A dispatcher is
 * reading codes aloud from a caller: they almost always hit. Someone enumerating
 * the codespace almost always misses, because that is what enumeration *is* —
 * the misses are not a side effect of the attack, they are the attack.
 *
 * So the price is on the miss. A dispatcher can resolve all day and never
 * approach the limit. A guesser exhausts the same budget in seconds, and the
 * cost of continuing rises exponentially. The limiter never has to decide who
 * anyone *is*; it just makes the behaviour that only an attacker exhibits
 * expensive.
 *
 * Second deliberate asymmetry: **minting is barely limited at all.** The failure
 * modes are not symmetric. Absorbing some junk sessions costs disk. Throttling
 * somebody who is pressing the button because they are in trouble costs
 * something we are not willing to trade for tidier metrics. When in doubt on the
 * mint path, let it through.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface RateLimitPolicy {
  /** Rolling window for the resolve budget, in seconds. */
  resolveWindowSeconds: number;
  /** Budget units available per window, per source. */
  resolveBudget: number;
  /** Charge for a resolve that found a live session. */
  resolveHitCost: number;
  /**
   * Charge for a resolve that found nothing — including a malformed code, a bad
   * API key, and a code claimed by somebody else. Deliberately many times the
   * hit cost: this is the whole mechanism.
   */
  resolveMissCost: number;

  /** Mint window, in seconds. */
  mintWindowSeconds: number;
  /** Mint budget per window, per IP. Deliberately generous. */
  mintBudget: number;

  /** Consecutive misses tolerated before backoff engages. */
  missStreakThreshold: number;
  /** First backoff, in seconds. Doubles per additional consecutive miss. */
  backoffBaseSeconds: number;
  /** Ceiling on backoff, so a shared NAT is never bricked indefinitely. */
  backoffMaxSeconds: number;
  /** How long a miss streak is remembered with no further misses. */
  missStreakMemorySeconds: number;
}

export const DEFAULT_POLICY: RateLimitPolicy = {
  resolveWindowSeconds: 60,
  // 600 hits/minute/source. A control room doing one resolve every 100ms,
  // sustained, still never notices this exists.
  resolveBudget: 600,
  resolveHitCost: 1,
  // 30x. Twenty misses in a minute exhausts a budget that six hundred hits
  // would not. That ratio IS the policy.
  resolveMissCost: 30,

  mintWindowSeconds: 60,
  mintBudget: 120,

  missStreakThreshold: 5,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 300,
  missStreakMemorySeconds: 900,
};

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * The counter storage the policy runs on.
 *
 * Abstracted so the policy — the part with the actual reasoning in it — is
 * tested directly rather than through a Redis connection, and so the resolver
 * still has working limits when running memory-backed for a demo.
 */
export interface RateLimitBackend {
  /** Add `amount` to a counter, arming a TTL if it has none. Returns the new total. */
  bump(key: string, amount: number, ttlSeconds: number): Promise<number>;
  /** Current counter value, or 0. */
  peek(key: string): Promise<number>;
  /** Forget a counter entirely. */
  clear(key: string): Promise<void>;
  /** Mark a key as blocked for a duration. */
  blockFor(key: string, ttlSeconds: number): Promise<void>;
  /** Seconds of block remaining, or 0. */
  blockRemaining(key: string): Promise<number>;
}

interface MemoryEntry {
  value: number;
  expiresAtMs: number;
}

/**
 * In-process backend.
 *
 * Note the absence of a sweeper: entries are evaluated lazily on read and
 * dropped when found expired. Nothing here needs to run on a schedule, which
 * keeps this consistent with how session expiry works and means the limiter has
 * no background job to fail silently.
 */
export class MemoryRateLimitBackend implements RateLimitBackend {
  readonly #entries = new Map<string, MemoryEntry>();

  #live(key: string): MemoryEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async bump(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const existing = this.#live(key);
    if (existing === undefined) {
      this.#entries.set(key, { value: amount, expiresAtMs: Date.now() + ttlSeconds * 1000 });
      return amount;
    }
    // TTL deliberately untouched: this is a fixed window, so a source cannot
    // keep its own window alive by continuing to hammer it.
    existing.value += amount;
    return existing.value;
  }

  async peek(key: string): Promise<number> {
    return this.#live(key)?.value ?? 0;
  }

  async clear(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async blockFor(key: string, ttlSeconds: number): Promise<void> {
    const existing = this.#live(key);
    const until = Date.now() + ttlSeconds * 1000;
    // Never shorten an existing block.
    if (existing !== undefined && existing.expiresAtMs >= until) return;
    this.#entries.set(key, { value: 1, expiresAtMs: until });
  }

  async blockRemaining(key: string): Promise<number> {
    const entry = this.#live(key);
    if (entry === undefined) return 0;
    return Math.ceil((entry.expiresAtMs - Date.now()) / 1000);
  }
}

/**
 * Redis backend. Shares the connection with the session store.
 *
 * `bump` is a single Lua step so that INCRBY and the TTL arming cannot be
 * separated. A counter that briefly exists without a TTL is a counter that can
 * be left behind forever by a badly-timed crash — and a permanently stuck
 * counter on the resolve path means a control room that is permanently
 * throttled.
 */
const BUMP_SCRIPT = `
local total = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return total
`;

/**
 * Extend a block, never shorten one.
 *
 * Without the comparison, a later miss carrying a smaller backoff would hand an
 * attacker a way to shrink their own penalty — the opposite of exponential.
 */
const BLOCK_SCRIPT = `
if redis.call('TTL', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
end
return 1
`;

interface RedisWithCommands extends Redis {
  wayRateBump(key: string, amount: string, ttlSeconds: string): Promise<number>;
  wayRateBlock(key: string, ttlSeconds: string): Promise<number>;
}

export class RedisRateLimitBackend implements RateLimitBackend {
  readonly #redis: RedisWithCommands;

  constructor(redis: Redis) {
    redis.defineCommand('wayRateBump', { numberOfKeys: 1, lua: BUMP_SCRIPT });
    redis.defineCommand('wayRateBlock', { numberOfKeys: 1, lua: BLOCK_SCRIPT });
    this.#redis = redis as RedisWithCommands;
  }

  async bump(key: string, amount: number, ttlSeconds: number): Promise<number> {
    return this.#redis.wayRateBump(key, String(amount), String(ttlSeconds));
  }

  async peek(key: string): Promise<number> {
    return Number((await this.#redis.get(key)) ?? 0);
  }

  async clear(key: string): Promise<void> {
    await this.#redis.del(key);
  }

  async blockFor(key: string, ttlSeconds: number): Promise<void> {
    await this.#redis.wayRateBlock(key, String(ttlSeconds));
  }

  async blockRemaining(key: string): Promise<number> {
    const ttl = await this.#redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  }
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

/**
 * One axis a request can be limited on.
 *
 * Both are checked independently. A single attacker rotating through a stolen
 * API key is caught by the key axis; a botnet sharing one key is caught by the
 * IP axis. Either exhausting its budget is enough to reject.
 */
export interface RateSource {
  scope: 'ip' | 'key';
  id: string;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: RateSource['scope'] };

export type ResolveOutcome = 'hit' | 'miss';

export interface LimiterLogger {
  warn(payload: object, message: string): void;
  error(payload: object, message: string): void;
}

export class RateLimiter {
  readonly #backend: RateLimitBackend;
  readonly #policy: RateLimitPolicy;
  readonly #log: LimiterLogger | undefined;

  constructor(backend: RateLimitBackend, policy: RateLimitPolicy, log?: LimiterLogger) {
    this.#backend = backend;
    this.#policy = policy;
    this.#log = log;
  }

  get policy(): RateLimitPolicy {
    return this.#policy;
  }

  /**
   * May this source attempt a resolve?
   *
   * Checked before the code is even parsed, so a flood of guesses is rejected
   * without touching the datastore.
   */
  async checkResolve(sources: RateSource[]): Promise<RateLimitDecision> {
    return this.#guard(async () => {
      for (const source of sources) {
        const blocked = await this.#backend.blockRemaining(blockKey(source));
        if (blocked > 0) return denial(blocked, source.scope);

        const spent = await this.#backend.peek(budgetKey('resolve', source));
        if (spent >= this.#policy.resolveBudget) {
          return denial(this.#policy.resolveWindowSeconds, source.scope);
        }
      }
      return { allowed: true };
    });
  }

  /**
   * Charge for a completed resolve.
   *
   * Called after the outcome is known, because the outcome is what determines
   * the price. This is the inversion the ticket is about: the limiter is not
   * counting requests, it is pricing misses.
   */
  async recordResolve(sources: RateSource[], outcome: ResolveOutcome): Promise<void> {
    const cost =
      outcome === 'hit' ? this.#policy.resolveHitCost : this.#policy.resolveMissCost;

    await this.#quietly(async () => {
      for (const source of sources) {
        await this.#backend.bump(
          budgetKey('resolve', source),
          cost,
          this.#policy.resolveWindowSeconds,
        );

        if (outcome === 'hit') {
          // A hit clears the streak. A dispatcher who mistypes a code, or hits
          // one that expired thirty seconds ago, must not accumulate towards a
          // penalty just because they got two in a row wrong at some point.
          await this.#backend.clear(streakKey(source));
          continue;
        }

        const streak = await this.#backend.bump(
          streakKey(source),
          1,
          this.#policy.missStreakMemorySeconds,
        );

        if (streak >= this.#policy.missStreakThreshold) {
          const over = streak - this.#policy.missStreakThreshold;
          // Exponential: each further consecutive miss doubles the wait. The
          // point is not to punish, it is to make the cost of a scan grow
          // faster than an attacker's patience.
          const seconds = Math.min(
            this.#policy.backoffMaxSeconds,
            this.#policy.backoffBaseSeconds * 2 ** over,
          );
          await this.#backend.blockFor(blockKey(source), seconds);
          this.#log?.warn(
            { scope: source.scope, streak, backoffSeconds: seconds },
            'enumeration backoff engaged after consecutive failed resolves',
          );
        }
      }
    });
  }

  /**
   * Mint limits.
   *
   * Loose on purpose, and there is no miss concept here: minting cannot "miss".
   * The only thing being defended against is bulk junk, and the bar is set well
   * above anything a person in trouble could produce.
   */
  async checkMint(sources: RateSource[]): Promise<RateLimitDecision> {
    return this.#guard(async () => {
      for (const source of sources) {
        const spent = await this.#backend.peek(budgetKey('mint', source));
        if (spent >= this.#policy.mintBudget) {
          return denial(this.#policy.mintWindowSeconds, source.scope);
        }
      }
      return { allowed: true };
    });
  }

  async recordMint(sources: RateSource[]): Promise<void> {
    await this.#quietly(async () => {
      for (const source of sources) {
        await this.#backend.bump(budgetKey('mint', source), 1, this.#policy.mintWindowSeconds);
      }
    });
  }

  /**
   * Fail open.
   *
   * If the counter store is unreachable, the choice is between letting some
   * enumeration through and refusing to resolve codes at all. Refusing means a
   * dispatcher cannot find someone who is in trouble because a Redis fell over,
   * which is not a trade this system should ever make. It is logged at error
   * level so the degraded state is visible rather than silent.
   */
  async #guard(fn: () => Promise<RateLimitDecision>): Promise<RateLimitDecision> {
    try {
      return await fn();
    } catch (error) {
      this.#log?.error(
        { err: error },
        'rate limiter backend unavailable — failing OPEN. Enumeration defence is ' +
          'degraded until this is fixed.',
      );
      return { allowed: true };
    }
  }

  async #quietly(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.#log?.error({ err: error }, 'rate limiter could not record an outcome');
    }
  }
}

function budgetKey(kind: 'resolve' | 'mint', source: RateSource): string {
  return `rl:${kind}:${source.scope}:${source.id}`;
}

function streakKey(source: RateSource): string {
  return `rl:miss:${source.scope}:${source.id}`;
}

function blockKey(source: RateSource): string {
  return `rl:block:${source.scope}:${source.id}`;
}

function denial(retryAfterSeconds: number, scope: RateSource['scope']): RateLimitDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds), scope };
}
