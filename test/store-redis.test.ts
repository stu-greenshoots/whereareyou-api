import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisSessionStore, connectRedis } from '../src/store-redis.js';
import { TEST_REDIS_URL, makeSession, redisAvailable, redisCli, sleep } from './helpers.js';

/**
 * Integration tests against a real Redis. These are the reason ticket B2
 * exists: the protocol's privacy argument rests on expiry being *structural*,
 * and the only way to demonstrate that is to let real time pass against a real
 * datastore and then check — from outside the application — that the record is
 * genuinely gone.
 */

const available = redisAvailable();

if (!available) {
  // Loud, not silent. A skipped structural-expiry suite means the central claim
  // of this ticket went unverified on this run, and that should be obvious in
  // the output rather than buried in a "0 failures" summary.
  console.warn(
    `\n*** SKIPPING REDIS INTEGRATION TESTS: no Redis at ${TEST_REDIS_URL}. ***\n` +
      '*** The structural-expiry guarantee is NOT verified by this run.    ***\n',
  );
}

describe.skipIf(!available)('RedisSessionStore', () => {
  let redis: Redis;
  let store: RedisSessionStore;
  const written: string[] = [];

  beforeAll(async () => {
    redis = await connectRedis(TEST_REDIS_URL);
    store = new RedisSessionStore(redis);
  });

  afterEach(async () => {
    if (written.length > 0) await redis.del(...written.map((c) => `sess:${c}`));
    written.length = 0;
  });

  afterAll(async () => {
    await redis.quit();
  });

  const track = (code: string) => {
    written.push(code);
    return code;
  };

  // ---------------------------------------------------------------------
  // The point of the ticket.
  // ---------------------------------------------------------------------

  it('a session key genuinely ceases to exist once its TTL elapses', async () => {
    const session = makeSession({ expiresAt: Date.now() + 1_500 });
    track(session.code);
    await store.create(session);

    // Present, and Redis itself agrees it is present.
    expect(await store.get(session.code)).toBeDefined();
    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('1');

    // No polling, no sweeper, no nudge from this process. Just time passing.
    await sleep(2_200);

    // Gone through the application's own read path...
    expect(await store.get(session.code)).toBeUndefined();
    // ...and gone according to Redis, asked independently via redis-cli.
    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('0');
    // TTL of -2 is Redis for "no such key".
    expect(redisCli('TTL', `sess:${session.code}`)).toBe('-2');
  });

  it('leaves no residue of an expired session anywhere in the keyspace', async () => {
    const session = makeSession({ expiresAt: Date.now() + 1_500, claimedBy: 'control-room-a' });
    track(session.code);
    await store.create(session);
    await sleep(2_200);

    // Not just the session key: nothing keyed on that code may survive it. A
    // stray index, claim record or reverse-lookup entry would rebuild exactly
    // the location history this design exists to not have.
    const survivors = redisCli('KEYS', `*${session.code}*`);
    expect(survivors).toBe('');
  });

  it('never writes a session without an expiry armed', async () => {
    const session = makeSession({ expiresAt: Date.now() + 30_000 });
    track(session.code);
    await store.create(session);

    // -1 is Redis for "key exists but has no TTL" — an immortal session, the
    // failure mode this whole ticket is about.
    const ttl = Number(redisCli('PTTL', `sess:${session.code}`));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  // ---------------------------------------------------------------------
  // Claim state must share the session's lifetime, not outlive it.
  // ---------------------------------------------------------------------

  it('stores claim state inside the session hash so it shares the TTL', async () => {
    const session = makeSession({ expiresAt: Date.now() + 30_000 });
    track(session.code);
    await store.create(session);
    await store.update(session.code, { claimedBy: 'control-room-a' });

    expect((await store.get(session.code))?.claimedBy).toBe('control-room-a');
    // The claim is a field of the session hash, not a key of its own.
    expect(redisCli('HGET', `sess:${session.code}`, 'claimedBy')).toBe('control-room-a');
    expect(redisCli('KEYS', `*${session.code}*`)).toBe(`sess:${session.code}`);
  });

  it('does not let a claim outlive the session it claims', async () => {
    const session = makeSession({ expiresAt: Date.now() + 1_500 });
    track(session.code);
    await store.create(session);
    await store.update(session.code, { claimedBy: 'control-room-a' });

    await sleep(2_200);

    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('0');
    expect(redisCli('KEYS', `*${session.code}*`)).toBe('');
  });

  // ---------------------------------------------------------------------
  // Writes must not extend life.
  // ---------------------------------------------------------------------

  it('does not extend expiry when a live session moves', async () => {
    const session = makeSession({ mode: 'live', expiresAt: Date.now() + 10_000 });
    track(session.code);
    await store.create(session);

    const before = await store.ttlMs(session.code);
    await sleep(1_100);
    await store.update(session.code, {
      position: { lat: 52, lon: -1, accuracyM: 5, source: 'gnss', takenAt: new Date().toISOString() },
      updatedAt: Date.now(),
    });
    const after = await store.ttlMs(session.code);

    // A session that keeps moving must not become immortal by moving.
    expect(after).toBeLessThan(before);
  });

  it('does not resurrect an expired session when an update races its expiry', async () => {
    const session = makeSession({ mode: 'live', expiresAt: Date.now() + 1_200 });
    track(session.code);
    await store.create(session);
    await sleep(1_800);

    // A naive EXISTS-then-HSET would recreate the key here — and worse, recreate
    // it with no TTL at all, turning a correctly-dead session into a permanent
    // one. The update is a single atomic Lua step precisely to prevent this.
    const updated = await store.update(session.code, { updatedAt: Date.now() });

    expect(updated).toBe(false);
    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('0');
  });

  // ---------------------------------------------------------------------
  // Ordinary store contract.
  // ---------------------------------------------------------------------

  it('round-trips a session faithfully', async () => {
    const session = makeSession({ note: 'blue door, side alley', mode: 'live', subject: 'third-party' });
    track(session.code);
    await store.create(session);

    expect(await store.get(session.code)).toEqual(session);
  });

  it('omits absent optional fields rather than storing them as strings', async () => {
    const session = makeSession();
    track(session.code);
    await store.create(session);

    const loaded = await store.get(session.code);
    expect(loaded).toBeDefined();
    expect('note' in loaded!).toBe(false);
    expect('claimedBy' in loaded!).toBe(false);
  });

  it('keeps the update token hashed and never stores the plaintext', async () => {
    const session = makeSession({ updateTokenHash: 'b'.repeat(64) });
    track(session.code);
    await store.create(session);

    const raw = redisCli('HGETALL', `sess:${session.code}`);
    expect(raw).toContain('b'.repeat(64));
    expect(raw).not.toContain('updateToken\n');
  });

  it('reports delete honestly', async () => {
    const session = makeSession();
    track(session.code);
    await store.create(session);

    expect(await store.delete(session.code)).toBe(true);
    expect(await store.delete(session.code)).toBe(false);
    expect(await store.get(session.code)).toBeUndefined();
  });

  it('refuses to write a session that has already expired', async () => {
    const session = makeSession({ expiresAt: Date.now() - 1_000 });
    track(session.code);
    await store.create(session);

    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('0');
  });

  it('counts only session keys in size()', async () => {
    const session = makeSession();
    track(session.code);
    const before = await store.size();
    await store.create(session);
    expect(await store.size()).toBe(before + 1);
  });
});

describe('connectRedis', () => {
  it('throws rather than falling back when Redis is unreachable', async () => {
    // Silent degradation to the memory store would mean the resolver keeps
    // serving while no longer providing structural expiry — advertising a
    // guarantee that had quietly stopped being true.
    await expect(connectRedis('redis://127.0.0.1:6390')).rejects.toThrow(/could not connect/i);
  });
});

describe('the design rule itself', () => {
  it('contains no sweeper, cleanup job or scheduled delete', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/store-redis.ts', import.meta.url)),
      'utf8',
    );
    // Executable enforcement of the ticket's central constraint. If someone
    // later "fixes" expiry with a timer, the structural claim is gone and this
    // test says so.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(code).not.toMatch(/setInterval|setTimeout|unref|cron|sweep/i);
  });
});
