import { Redis } from 'ioredis';
import type { Position, SessionMode, SessionSubject } from '@whereareyou/protocol';
import type { SessionStore, StoredSession } from './store.js';

/**
 * Redis-backed session store.
 *
 * The point of this file is a single property: **a session record cannot
 * outlive its TTL.** Not "we delete it after 30 minutes" — that is policy, and
 * policy is only as true as the process that enforces it. Here the record's
 * lifetime is a property of the datastore itself. Redis holds the expiry; Redis
 * removes the key; a logically-expired key is never returned to any client,
 * ever, regardless of what this process is doing or whether it is running at
 * all.
 *
 * Consequences that are deliberate, not accidental:
 *
 * - **There is no sweeper.** No `setInterval`, no cleanup job, no scheduled
 *   delete, anywhere. If you find yourself adding one, the structural claim has
 *   already been lost and the README's privacy argument is back to being a
 *   promise rather than a mechanism.
 * - **Claim state lives inside the session hash**, as a field, not in a
 *   separate key. A separate key would need its own TTL, and two TTLs are two
 *   chances to disagree. Because `claimedBy` is a field of `sess:{code}`, the
 *   record of who resolved a code physically cannot outlive the code.
 * - **Writes never extend the TTL.** `HSET` against an existing key leaves its
 *   expiry untouched, which is precisely the behaviour a live session needs: it
 *   may keep moving, but it must not become immortal by moving.
 * - **`updateToken` is stored hashed**, as it was in the memory store. The
 *   plaintext token exists only in the mint response.
 */

const KEY_PREFIX = 'sess:';

function key(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

/**
 * Encode a session (or a patch of one) into flat Redis hash fields.
 *
 * `undefined` values are omitted rather than written as the string
 * "undefined" — a distinction that matters because `claimedBy` and `note` are
 * genuinely optional and their absence is meaningful.
 */
function encode(patch: Partial<StoredSession>): string[] {
  const fields: string[] = [];
  const put = (field: string, value: string | undefined) => {
    if (value !== undefined) fields.push(field, value);
  };

  put('code', patch.code);
  put('position', patch.position === undefined ? undefined : JSON.stringify(patch.position));
  put('mode', patch.mode);
  put('subject', patch.subject);
  put('note', patch.note);
  put('createdAt', patch.createdAt?.toString());
  put('updatedAt', patch.updatedAt?.toString());
  put('expiresAt', patch.expiresAt?.toString());
  put('updateTokenHash', patch.updateTokenHash);
  put('claimedBy', patch.claimedBy);

  return fields;
}

function decode(hash: Record<string, string>): StoredSession | undefined {
  const {
    code,
    position,
    mode,
    subject,
    note,
    createdAt,
    updatedAt,
    expiresAt,
    updateTokenHash,
    claimedBy,
  } = hash;

  // A half-written hash is not a session. Refuse it rather than handing a
  // dispatcher a record with a missing position.
  if (
    code === undefined ||
    position === undefined ||
    mode === undefined ||
    subject === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    expiresAt === undefined ||
    updateTokenHash === undefined
  ) {
    return undefined;
  }

  return {
    code,
    position: JSON.parse(position) as Position,
    mode: mode as SessionMode,
    subject: subject as SessionSubject,
    ...(note !== undefined ? { note } : {}),
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
    expiresAt: Number(expiresAt),
    updateTokenHash,
    ...(claimedBy !== undefined ? { claimedBy } : {}),
  };
}

/**
 * Patch an existing hash without touching its TTL, atomically.
 *
 * Done in Lua rather than as EXISTS-then-HSET because the gap between those two
 * commands is exactly long enough for the key to expire — and a bare `HSET`
 * against a vanished key would *recreate it with no expiry at all*, resurrecting
 * a dead session as an immortal one. That is the single worst failure this
 * store could have, so it is closed in the only place it can be closed
 * properly: server-side, in one atomic step.
 */
const UPDATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV))
return 1
`;

interface RedisWithCommands extends Redis {
  wayUpdateSession(key: string, ...fields: string[]): Promise<number>;
}

export class RedisSessionStore implements SessionStore {
  readonly #redis: RedisWithCommands;

  constructor(redis: Redis) {
    redis.defineCommand('wayUpdateSession', { numberOfKeys: 1, lua: UPDATE_SCRIPT });
    this.#redis = redis as RedisWithCommands;
  }

  /**
   * Create the hash and arm its expiry in one transaction.
   *
   * The HSET and the PEXPIRE must not be separable: a session that exists for
   * even a moment without a TTL is a session that could survive a crash between
   * the two commands and then live forever.
   */
  async create(session: StoredSession): Promise<void> {
    const ttlMs = session.expiresAt - Date.now();
    if (ttlMs <= 0) return; // Already expired on arrival; never write it at all.

    await this.#redis
      .multi()
      .hset(key(session.code), ...encode(session))
      .pexpire(key(session.code), ttlMs)
      .exec();
  }

  /**
   * No expiry check here, deliberately.
   *
   * The memory store had to re-check `expiresAt` on every read because its
   * sweeper could lag. Redis cannot lag: an expired key is never visible to a
   * client, whether or not the memory behind it has been reclaimed yet. The
   * absence of a check on this path is the difference between the two stores.
   */
  async get(code: string): Promise<StoredSession | undefined> {
    const hash = await this.#redis.hgetall(key(code));
    if (Object.keys(hash).length === 0) return undefined;
    return decode(hash);
  }

  async update(code: string, patch: Partial<StoredSession>): Promise<boolean> {
    const fields = encode(patch);
    if (fields.length === 0) return (await this.#redis.exists(key(code))) === 1;
    return (await this.#redis.wayUpdateSession(key(code), ...fields)) === 1;
  }

  async delete(code: string): Promise<boolean> {
    return (await this.#redis.del(key(code))) === 1;
  }

  /**
   * Live session count for /health.
   *
   * SCAN rather than DBSIZE because this database is shared with rate-limit
   * counters, and SCAN rather than KEYS because KEYS blocks the server. This is
   * O(keyspace) and therefore a diagnostic, not something to put on a hot path.
   */
  async size(): Promise<number> {
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await this.#redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  /** Remaining lifetime in milliseconds, or negative if the key is gone. */
  async ttlMs(code: string): Promise<number> {
    return this.#redis.pttl(key(code));
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}

/**
 * Connect to Redis, or throw.
 *
 * Explicitly not a fallback to the memory store. Silently degrading would mean
 * the resolver keeps serving traffic while quietly no longer providing the
 * property it advertises — the operator would have no idea that "expiry is
 * structural" had stopped being true. A resolver that refuses to start is a
 * problem you find out about; one that lies about its own guarantees is not.
 */
export async function connectRedis(url: string): Promise<Redis> {
  const redis = new Redis(url, {
    lazyConnect: true,
    // Fail fast at startup instead of retrying forever behind a healthy-looking
    // process. Once connected, ioredis' default reconnect behaviour resumes.
    maxRetriesPerRequest: 3,
    connectTimeout: 5_000,
    retryStrategy: () => null,
  });

  // ioredis emits `error` on a socket independently of the connect() promise.
  // Without a listener Node prints an unhandled-error warning that lands above
  // our own fatal message and buries the actual reason the process is dying.
  let connecting = true;
  let firstError: Error | undefined;
  redis.on('error', (error: Error) => {
    if (connecting && firstError === undefined) firstError = error;
  });

  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    redis.disconnect();
    // Prefer the socket-level error: "ECONNREFUSED" tells an operator what to
    // fix, where connect()'s "Connection is closed" tells them nothing.
    const cause = firstError ?? error;
    throw new Error(
      `could not connect to Redis at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  // The listener stays attached for the process's lifetime — a connection that
  // drops later must not crash the resolver — but it stops hoarding errors.
  connecting = false;
  // Restore resilient reconnection now that the initial connection has proven
  // the endpoint is real. A blip mid-shift should not kill the process.
  redis.options.retryStrategy = (times: number) => Math.min(times * 200, 5_000);
  return redis;
}
