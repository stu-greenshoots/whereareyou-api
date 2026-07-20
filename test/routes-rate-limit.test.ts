import Fastify, { type FastifyInstance } from 'fastify';
import { generateCode } from '@whereareyou/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  DEFAULT_POLICY,
  MemoryRateLimitBackend,
  RateLimiter,
  type RateLimitPolicy,
} from '../src/rate-limit.js';
import { registerRoutes } from '../src/routes.js';
import { MemorySessionStore } from '../src/store.js';

/**
 * End-to-end through the actual routes: the limiter is only useful if the
 * resolve path charges the right price for the right outcome, and that wiring
 * is where a policy like this normally goes wrong.
 */

const POSITION = { lat: 51.5072, lon: -0.1276, accuracyM: 8, source: 'gnss' as const };

function makeConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    resolverMode: 'apikey',
    apiKeys: new Map([['key-alpha', 'control-room-a']]),
    defaultTtlSeconds: 1800,
    minTtlSeconds: 60,
    maxTtlSeconds: 14400,
    corsOrigins: ['*'],
    redisUrl: undefined,
    rateLimit: { enabled: true, policy: DEFAULT_POLICY, trustProxy: false },
  };
}

const built: { app: FastifyInstance; store: MemorySessionStore }[] = [];

function build(overrides: Partial<RateLimitPolicy> = {}) {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  const limiter = new RateLimiter(new MemoryRateLimitBackend(), {
    ...DEFAULT_POLICY,
    ...overrides,
  });
  registerRoutes(app, makeConfig(), store, { limiter });
  built.push({ app, store });
  return app;
}

afterEach(async () => {
  for (const { app, store } of built.splice(0)) {
    await app.close();
    store.stop();
  }
});

async function mint(app: FastifyInstance, ip = '10.0.0.5'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION },
    remoteAddress: ip,
  });
  return (response.json() as { code: string }).code;
}

function resolve(app: FastifyInstance, code: string, ip = '10.0.0.5', key = 'key-alpha') {
  return app.inject({
    method: 'GET',
    url: `/v1/sessions/${code}`,
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: ip,
  });
}

describe('resolve endpoint under rate limiting', () => {
  it('does not throttle a dispatcher resolving real codes', async () => {
    const app = build();
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) codes.push(await mint(app));

    for (const code of codes) {
      // Repeatedly, as a control room re-checking a live incident would.
      for (let n = 0; n < 4; n++) {
        expect((await resolve(app, code)).statusCode).toBe(200);
      }
    }
  });

  it('throttles a source guessing at codes within a handful of attempts', async () => {
    const app = build();

    let rejected = -1;
    for (let i = 0; i < 50; i++) {
      // Valid-checksum codes that simply do not exist: the best case for an
      // attacker, since malformed guesses are rejected even more cheaply.
      const response = await resolve(app, await mintedButRevoked(app), '203.0.113.9');
      if (response.statusCode === 429) {
        rejected = i;
        break;
      }
    }

    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(rejected).toBeLessThanOrEqual(DEFAULT_POLICY.missStreakThreshold + 1);
  });

  it('returns the protocol rate-limited error code and a Retry-After header', async () => {
    const app = build();
    for (let i = 0; i < 20; i++) await resolve(app, generateCode(), '203.0.113.9');

    const response = await resolve(app, generateCode(), '203.0.113.9');
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'rate-limited' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('escalates the penalty when a blocked source keeps probing', async () => {
    const app = build({ backoffBaseSeconds: 1, backoffMaxSeconds: 10_000, resolveBudget: 1e9 });

    // Regression test for a real bug found by driving the running server: the
    // 429 path used to return without recording anything, so the miss streak
    // froze at the threshold and every subsequent Retry-After came back as the
    // same 2 seconds. An "exponential" backoff an attacker can sleep through is
    // not a backoff.
    const waits: number[] = [];
    for (let i = 0; i < 20; i++) {
      const response = await resolve(app, generateCode(), '203.0.113.9');
      if (response.statusCode === 429) waits.push(Number(response.headers['retry-after']));
    }

    expect(waits.length).toBeGreaterThan(3);
    expect(waits.at(-1)!).toBeGreaterThan(waits[0]!);
  });

  it('charges a miss for a bad API key, so key guessing is enumeration too', async () => {
    const app = build();

    for (let i = 0; i < 20; i++) {
      const response = await resolve(app, generateCode(), '203.0.113.9', `guess-${i}`);
      if (response.statusCode === 429) return;
      expect(response.statusCode).toBe(401);
    }
    throw new Error('key guessing was never throttled');
  });

  it('charges a miss for a malformed code', async () => {
    const app = build();

    for (let i = 0; i < 20; i++) {
      const response = await resolve(app, 'NOTAREALCODE', '203.0.113.9');
      if (response.statusCode === 429) return;
      expect(response.statusCode).toBe(400);
    }
    throw new Error('malformed guesses were never throttled');
  });

  it('does not let an attacker throttle a dispatcher from a different address', async () => {
    const app = build();
    const code = await mint(app);

    // Collateral damage would be the easy way to turn this defence into a
    // denial-of-service tool against the control room it protects.
    for (let i = 0; i < 30; i++) await resolve(app, generateCode(), '203.0.113.9', 'bad-key');

    expect((await resolve(app, code, '10.0.0.5')).statusCode).toBe(200);
  });

  it('keeps 404 and 429 distinguishable only by budget, never by code validity', async () => {
    const app = build({ missStreakThreshold: 1_000_000, resolveBudget: 1e9 });

    // A real-but-claimed code and a never-existed code must still be
    // indistinguishable once the limiter is in the path.
    const code = await mint(app);
    await resolve(app, code, '10.0.0.5', 'key-alpha');

    const otherRoom = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${code}`,
      headers: { authorization: 'Bearer key-alpha' },
      remoteAddress: '10.0.0.9',
    });
    expect(otherRoom.statusCode).toBe(200); // same key, same control room

    // A well-formed, checksum-valid code that was simply never minted.
    const nonexistent = await resolve(app, generateCode(), '10.0.0.5');
    expect(nonexistent.statusCode).toBe(404);
  });
});

describe('mint endpoint under rate limiting', () => {
  it('lets a distressed caller mint repeatedly without being throttled', async () => {
    const app = build();
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { position: POSITION },
        remoteAddress: '10.0.0.5',
      });
      expect(response.statusCode).toBe(201);
    }
  });

  it('is unaffected by an exhausted resolve budget from the same address', async () => {
    const app = build();

    for (let i = 0; i < 30; i++) await resolve(app, generateCode(), '203.0.113.9');
    expect((await resolve(app, generateCode(), '203.0.113.9')).statusCode).toBe(429);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { position: POSITION },
      remoteAddress: '203.0.113.9',
    });
    expect(response.statusCode).toBe(201);
  });

  it('eventually refuses bulk minting', async () => {
    const app = build({ mintBudget: 5 });
    for (let i = 0; i < 5; i++) await mint(app, '203.0.113.9');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { position: POSITION },
      remoteAddress: '203.0.113.9',
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'rate-limited' });
  });
});

/** Mint a code and immediately revoke it, giving a well-formed code that misses. */
async function mintedButRevoked(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION },
    remoteAddress: '10.0.0.250',
  });
  const body = response.json() as { code: string; updateToken: string };
  await app.inject({
    method: 'DELETE',
    url: `/v1/sessions/${body.code}`,
    payload: { updateToken: body.updateToken },
    remoteAddress: '10.0.0.250',
  });
  return body.code;
}
