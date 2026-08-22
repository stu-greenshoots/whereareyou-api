import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { connectRedis } from '../src/store-redis.js';
import { RedisAccountStore, newAccountId, type AccountRecord } from '../src/account-store.js';
import { TEST_REDIS_URL, redisAvailable, redisCli } from './helpers.js';

/**
 * The Redis account store against a real Redis. The properties worth paying
 * an integration test for: the username claim is atomic (SET NX — two
 * racers, one winner), a rename releases the old name, account keys carry
 * NO TTL (persistence is the point of an account), and tokens DO.
 */

const available = redisAvailable();

if (!available) {
  console.warn(`\n*** SKIPPING REDIS ACCOUNT TESTS: no Redis at ${TEST_REDIS_URL}. ***\n`);
}

describe.skipIf(!available)('RedisAccountStore', () => {
  let redis: Redis;
  let store: RedisAccountStore;
  const cleanup: string[] = [];

  beforeAll(async () => {
    redis = await connectRedis(TEST_REDIS_URL);
    store = new RedisAccountStore(redis);
  });

  afterEach(async () => {
    if (cleanup.length > 0) await redis.del(...cleanup);
    cleanup.length = 0;
  });

  afterAll(async () => {
    await redis.quit();
  });

  function makeAccount(username: string): AccountRecord {
    const record: AccountRecord = {
      id: newAccountId(),
      username,
      passwordHash: 's1:00:00',
      createdAt: Date.now(),
    };
    cleanup.push(
      `acct:user:${record.id}`,
      `acct:name:${username.toLowerCase()}`,
      `acct:maps:${record.id}`,
    );
    return record;
  }

  it('claims a username once; the loser of the race gets false', async () => {
    const first = makeAccount('test-race-user');
    const second = { ...makeAccount('test-race-user'), id: newAccountId() };
    cleanup.push(`acct:user:${second.id}`);
    expect(await store.createAccount(first)).toBe(true);
    expect(await store.createAccount(second)).toBe(false);
    // The loser left nothing behind.
    expect(await store.getAccount(second.id)).toBeUndefined();
  });

  it('rename releases the old name for someone else to take', async () => {
    const record = makeAccount('test-old-name');
    cleanup.push('acct:name:test-new-name');
    await store.createAccount(record);
    expect(await store.renameAccount(record.id, 'test-new-name')).toBe(true);
    expect(await store.getIdByUsername('test-old-name')).toBeUndefined();
    expect((await store.getAccount(record.id))?.username).toBe('test-new-name');

    const squatter = makeAccount('test-old-name');
    expect(await store.createAccount(squatter)).toBe(true);
  });

  it('account and map keys carry NO TTL; token keys DO', async () => {
    const record = makeAccount('test-ttl-user');
    await store.createAccount(record);
    await store.putMap(record.id, { id: 'm1', name: 'spot', savedAt: Date.now(), data: '{}' });
    const token = await store.createToken(record.id);
    cleanup.push(`acct:token:${token}`);

    // Asked of Redis directly, not our own client: -1 is "no TTL".
    expect(redisCli('TTL', `acct:user:${record.id}`)).toBe('-1');
    expect(redisCli('TTL', `acct:maps:${record.id}`)).toBe('-1');
    expect(Number(redisCli('TTL', `acct:token:${token}`))).toBeGreaterThan(0);

    expect(await store.resolveToken(token)).toBe(record.id);
    await store.revokeToken(token);
    expect(await store.resolveToken(token)).toBeUndefined();
  });

  it('maps round-trip verbatim and delete individually', async () => {
    const record = makeAccount('test-maps-user');
    await store.createAccount(record);
    const data = JSON.stringify({ lat: 51.5, lon: -0.12, note: 'weir' });
    await store.putMap(record.id, { id: 'm1', name: 'the weir', savedAt: 1, data });
    await store.putMap(record.id, { id: 'm2', name: 'later', savedAt: 2, data: '{}' });

    const maps = await store.listMaps(record.id);
    expect(maps.map((m) => m.id)).toEqual(['m2', 'm1']); // newest first
    expect(maps[1]?.data).toBe(data);

    expect(await store.deleteMap(record.id, 'm1')).toBe(true);
    expect(await store.deleteMap(record.id, 'm1')).toBe(false);
    expect(await store.listMaps(record.id)).toHaveLength(1);
  });
});
