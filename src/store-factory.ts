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
    close: () => store.close(),
  };
}
