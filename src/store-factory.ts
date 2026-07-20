import type { Redis } from 'ioredis';
import { MemorySessionStore, type SessionStore } from './store.js';
import { RedisSessionStore, connectRedis } from './store-redis.js';

export type StoreKind = 'redis' | 'memory';

export interface SelectedStore {
  store: SessionStore;
  kind: StoreKind;
  /** Release whatever the store is holding: a socket, a sweeper, both. */
  close(): Promise<void>;
  /**
   * True only for stores where expiry is enforced by the datastore rather than
   * by this process. `/health` reports it so an operator can see, without
   * reading the config, whether the deployment actually delivers the guarantee
   * the protocol documentation claims.
   */
  structuralExpiry: boolean;
  /**
   * The store's Redis connection, when there is one, so other subsystems can
   * share it rather than opening their own.
   *
   * Present because the rate limiter needs Redis for exactly the same reason
   * the store does, and a second connection to the same server buys nothing but
   * another socket, another retry strategy to reason about, and another failure
   * mode. Key prefixes do not collide (`sess:` and `rl:`), which is why
   * `RedisSessionStore.size()` uses SCAN rather than DBSIZE.
   *
   * Undefined for the memory store, and callers must handle that rather than
   * assuming Redis is available.
   */
  redis?: Redis;
}

/**
 * Choose a session store from the environment.
 *
 * `REDIS_URL` set means Redis, and a Redis that will not answer means the
 * process does not start. There is deliberately no third path where a
 * misconfigured or unreachable Redis quietly becomes an in-memory store: that
 * would turn a loud failure into a silent downgrade of the one property the
 * whole design rests on.
 */
export async function createStore(redisUrl: string | undefined): Promise<SelectedStore> {
  if (redisUrl === undefined || redisUrl === '') {
    const store = new MemorySessionStore();
    return {
      store,
      kind: 'memory',
      structuralExpiry: false,
      close: async () => store.stop(),
    };
  }

  const redis = await connectRedis(redisUrl);
  const store = new RedisSessionStore(redis);
  return {
    store,
    kind: 'redis',
    structuralExpiry: true,
    redis,
    close: () => store.close(),
  };
}
