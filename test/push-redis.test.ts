import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisPushStore, type PushSubscriptionRecord } from '../src/push.js';
import { RedisSessionStore, connectRedis } from '../src/store-redis.js';
import { TEST_REDIS_URL, makeSession, redisAvailable, redisCli, sleep } from './helpers.js';

/**
 * The Redis half of extend + push, against a real Redis, checked from outside
 * the application client where it matters. Two structural claims are on
 * trial: extending a session LENGTHENS its TTL without ever separating the
 * hash from its expiry, and a push-subscription key genuinely dies with its
 * TTL — no sweeper, no delete, nothing to forget to run.
 */

const available = redisAvailable();

if (!available) {
  console.warn(
    `\n*** SKIPPING REDIS PUSH/EXTEND TESTS: no Redis at ${TEST_REDIS_URL}. ***\n`,
  );
}

describe.skipIf(!available)('RedisSessionStore.extend', () => {
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

  it('lengthens the TTL and rewrites expiresAt in one step', async () => {
    const session = makeSession({ expiresAt: Date.now() + 5_000 });
    written.push(session.code);
    await store.create(session);

    const newExpiresAt = Date.now() + 90_000;
    expect(await store.extend(session.code, newExpiresAt)).toBe(true);

    // The datastore itself reports the new TTL…
    const pttl = Number(redisCli('PTTL', `sess:${session.code}`));
    expect(pttl).toBeGreaterThan(60_000);
    expect(pttl).toBeLessThanOrEqual(90_000);
    // …and the stored field agrees with it, so resolves stay truthful.
    expect(redisCli('HGET', `sess:${session.code}`, 'expiresAt')).toBe(String(newExpiresAt));
    expect((await store.get(session.code))!.expiresAt).toBe(newExpiresAt);
  });

  it('refuses to resurrect a session that no longer exists', async () => {
    const session = makeSession();
    // Never created. An extend must not conjure a TTL-less key from nothing.
    expect(await store.extend(session.code, Date.now() + 60_000)).toBe(false);
    expect(redisCli('EXISTS', `sess:${session.code}`)).toBe('0');
  });
});

describe.skipIf(!available)('RedisPushStore', () => {
  let redis: Redis;
  let store: RedisPushStore;
  const written: string[] = [];
  let previousVapid: string | null = null;

  const sub = (n: number): PushSubscriptionRecord => ({
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
  });

  beforeAll(async () => {
    redis = await connectRedis(TEST_REDIS_URL);
    store = new RedisPushStore(redis);
    // push:vapid is a real, non-expiring key a local dev server may also be
    // using; park whatever is there and put it back afterwards.
    previousVapid = await redis.get('push:vapid');
    await redis.del('push:vapid');
  });

  afterEach(async () => {
    if (written.length > 0) await redis.del(...written.map((c) => `push:${c}:subs`));
    written.length = 0;
  });

  afterAll(async () => {
    await redis.del('push:vapid');
    if (previousVapid !== null) await redis.set('push:vapid', previousVapid);
    await redis.quit();
  });

  it('persists the first VAPID pair and hands it to every later boot', async () => {
    const first = await store.ensureVapidKeys({ publicKey: 'pub-A', privateKey: 'priv-A' });
    expect(first.publicKey).toBe('pub-A');

    // A second boot arrives with its own freshly generated candidate — and loses.
    const second = await store.ensureVapidKeys({ publicKey: 'pub-B', privateKey: 'priv-B' });
    expect(second.publicKey).toBe('pub-A');

    // The key holding it never expires: server identity, not user data.
    expect(redisCli('TTL', 'push:vapid')).toBe('-1');
  });

  it('gives subscription keys the session TTL, and they die with it — structurally', async () => {
    written.push('PSHTTL1');
    await store.addSubscription('PSHTTL1', sub(1), 300);
    expect(await store.listSubscriptions('PSHTTL1')).toHaveLength(1);

    const pttl = Number(redisCli('PTTL', 'push:PSHTTL1:subs'));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(300);

    await sleep(500);
    // The datastore's own verdict, not ours: the key ceased to exist.
    expect(redisCli('EXISTS', 'push:PSHTTL1:subs')).toBe('0');
    expect(await store.listSubscriptions('PSHTTL1')).toHaveLength(0);
  });

  it('enforces the cap inside Redis and lets extendTo lengthen the TTL', async () => {
    written.push('PSHCAP1');
    for (let i = 0; i < 13; i++) {
      await store.addSubscription('PSHCAP1', sub(i), 60_000);
    }
    expect(await store.listSubscriptions('PSHCAP1')).toHaveLength(10);

    await store.extendTo('PSHCAP1', 120_000);
    const pttl = Number(redisCli('PTTL', 'push:PSHCAP1:subs'));
    expect(pttl).toBeGreaterThan(60_000);
    expect(pttl).toBeLessThanOrEqual(120_000);
  });
});
