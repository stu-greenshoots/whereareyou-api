import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Accounts and saved maps — the ONE part of this system that is allowed to
 * persist.
 *
 * Everything else here is built around expiry: sessions die, rooms die,
 * nothing outlives its TTL. An account is the opposite deal, entered into
 * knowingly: a user asked us to keep something. So account keys carry **no
 * TTL** (except login tokens), and that asymmetry is the design, not an
 * oversight.
 *
 * The store is an interface so Redis can be swapped out later (the stated
 * plan). Two rules keep that swap honest:
 *
 * - **The server never parses a saved map.** `SavedMapRecord.data` is an
 *   opaque JSON string the client wrote and the client will read back. The
 *   map's shape can evolve in the web app without an API deploy, and a
 *   future Postgres/whatever backend stores one blob column, not a schema.
 * - **Accounts are keyed by an immutable random id**, with the username as a
 *   claimable pointer to it. Renaming is then a pointer move, not a rekeying
 *   of everything the user owns.
 */

export interface AccountRecord {
  id: string;
  /** Display form, as the user typed it. Uniqueness is on the lowercase form. */
  username: string;
  /** scrypt, `s1:{saltHex}:{hashHex}`. Never plaintext. */
  passwordHash: string;
  /** Small data-URL image, or absent. The client downsizes before sending. */
  avatar?: string;
  createdAt: number;
}

export interface SavedMapRecord {
  id: string;
  name: string;
  savedAt: number;
  /** Opaque client JSON. Stored and returned verbatim, never parsed here. */
  data: string;
}

/** Ceiling on maps per account — a cap, not a quota system. */
export const MAX_SAVED_MAPS = 100;

/** Login tokens live this long, refreshed on every authenticated request. */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AccountStore {
  /** False when the username is already claimed (case-insensitive). */
  createAccount(record: AccountRecord): Promise<boolean>;
  getAccount(id: string): Promise<AccountRecord | undefined>;
  getIdByUsername(username: string): Promise<string | undefined>;
  /** Patch fields other than id/username. `avatar: undefined` in the patch is
      "leave it"; use `clearAvatar` to remove one. */
  updateAccount(id: string, patch: Partial<Pick<AccountRecord, 'passwordHash' | 'avatar'>>): Promise<boolean>;
  clearAvatar(id: string): Promise<void>;
  /** Claim the new name and release the old. False if the new name is taken. */
  renameAccount(id: string, newUsername: string): Promise<boolean>;

  createToken(accountId: string): Promise<string>;
  /** Also refreshes the token's TTL — using an account keeps you signed in. */
  resolveToken(token: string): Promise<string | undefined>;
  revokeToken(token: string): Promise<void>;

  listMaps(accountId: string): Promise<SavedMapRecord[]>;
  /** Insert or replace by map id. False when the account is at MAX_SAVED_MAPS
      and the id is new. */
  putMap(accountId: string, map: SavedMapRecord): Promise<boolean>;
  deleteMap(accountId: string, mapId: string): Promise<boolean>;
}

export function newAccountId(): string {
  return randomBytes(9).toString('base64url');
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function canonicalUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** In-memory store for local development and tests. Persistence-free, which
    for ACCOUNTS (unlike sessions) is a genuine loss — a restart forgets every
    user. The startup log says so. */
export class MemoryAccountStore implements AccountStore {
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #names = new Map<string, string>();
  readonly #tokens = new Map<string, { accountId: string; expiresAt: number }>();
  readonly #maps = new Map<string, Map<string, SavedMapRecord>>();

  async createAccount(record: AccountRecord): Promise<boolean> {
    const name = canonicalUsername(record.username);
    if (this.#names.has(name)) return false;
    this.#names.set(name, record.id);
    this.#accounts.set(record.id, { ...record });
    return true;
  }

  async getAccount(id: string): Promise<AccountRecord | undefined> {
    const record = this.#accounts.get(id);
    return record === undefined ? undefined : { ...record };
  }

  async getIdByUsername(username: string): Promise<string | undefined> {
    return this.#names.get(canonicalUsername(username));
  }

  async updateAccount(
    id: string,
    patch: Partial<Pick<AccountRecord, 'passwordHash' | 'avatar'>>,
  ): Promise<boolean> {
    const record = this.#accounts.get(id);
    if (record === undefined) return false;
    if (patch.passwordHash !== undefined) record.passwordHash = patch.passwordHash;
    if (patch.avatar !== undefined) record.avatar = patch.avatar;
    return true;
  }

  async clearAvatar(id: string): Promise<void> {
    const record = this.#accounts.get(id);
    if (record !== undefined) delete record.avatar;
  }

  async renameAccount(id: string, newUsername: string): Promise<boolean> {
    const record = this.#accounts.get(id);
    if (record === undefined) return false;
    const next = canonicalUsername(newUsername);
    const current = canonicalUsername(record.username);
    const holder = this.#names.get(next);
    if (holder !== undefined && holder !== id) return false;
    this.#names.delete(current);
    this.#names.set(next, id);
    record.username = newUsername.trim();
    return true;
  }

  async createToken(accountId: string): Promise<string> {
    const token = newToken();
    this.#tokens.set(token, { accountId, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 });
    return token;
  }

  async resolveToken(token: string): Promise<string | undefined> {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#tokens.delete(token);
      return undefined;
    }
    entry.expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
    return entry.accountId;
  }

  async revokeToken(token: string): Promise<void> {
    this.#tokens.delete(token);
  }

  async listMaps(accountId: string): Promise<SavedMapRecord[]> {
    const maps = this.#maps.get(accountId);
    if (maps === undefined) return [];
    return [...maps.values()].sort((a, b) => b.savedAt - a.savedAt);
  }

  async putMap(accountId: string, map: SavedMapRecord): Promise<boolean> {
    let maps = this.#maps.get(accountId);
    if (maps === undefined) {
      maps = new Map();
      this.#maps.set(accountId, maps);
    }
    if (!maps.has(map.id) && maps.size >= MAX_SAVED_MAPS) return false;
    maps.set(map.id, { ...map });
    return true;
  }

  async deleteMap(accountId: string, mapId: string): Promise<boolean> {
    return this.#maps.get(accountId)?.delete(mapId) ?? false;
  }
}

/**
 * Redis-backed account store, sharing the session store's connection.
 *
 * Key shapes (none carry a TTL except tokens — see the header comment):
 *   acct:user:{id}     hash   id, username, passwordHash, avatar?, createdAt
 *   acct:name:{lower}  string -> id   (claimed with SET NX)
 *   acct:token:{tok}   string -> id   (TTL, refreshed on use)
 *   acct:maps:{id}     hash   mapId -> JSON of SavedMapRecord
 */
export class RedisAccountStore implements AccountStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  #userKey(id: string): string {
    return `acct:user:${id}`;
  }
  #nameKey(username: string): string {
    return `acct:name:${canonicalUsername(username)}`;
  }
  #mapsKey(id: string): string {
    return `acct:maps:${id}`;
  }
  #tokenKey(token: string): string {
    return `acct:token:${token}`;
  }

  async createAccount(record: AccountRecord): Promise<boolean> {
    // SET NX is the claim: whoever lands it owns the name. The user hash is
    // written after, so a lost race leaves nothing behind.
    const claimed = await this.#redis.set(this.#nameKey(record.username), record.id, 'NX');
    if (claimed === null) return false;
    await this.#redis.hset(this.#userKey(record.id), {
      id: record.id,
      username: record.username,
      passwordHash: record.passwordHash,
      createdAt: String(record.createdAt),
      ...(record.avatar !== undefined ? { avatar: record.avatar } : {}),
    });
    return true;
  }

  async getAccount(id: string): Promise<AccountRecord | undefined> {
    const hash = await this.#redis.hgetall(this.#userKey(id));
    if (hash['id'] === undefined || hash['username'] === undefined || hash['passwordHash'] === undefined) {
      return undefined;
    }
    return {
      id: hash['id'],
      username: hash['username'],
      passwordHash: hash['passwordHash'],
      createdAt: Number(hash['createdAt'] ?? 0),
      ...(hash['avatar'] !== undefined ? { avatar: hash['avatar'] } : {}),
    };
  }

  async getIdByUsername(username: string): Promise<string | undefined> {
    const id = await this.#redis.get(this.#nameKey(username));
    return id ?? undefined;
  }

  async updateAccount(
    id: string,
    patch: Partial<Pick<AccountRecord, 'passwordHash' | 'avatar'>>,
  ): Promise<boolean> {
    if ((await this.#redis.exists(this.#userKey(id))) === 0) return false;
    const fields: Record<string, string> = {};
    if (patch.passwordHash !== undefined) fields['passwordHash'] = patch.passwordHash;
    if (patch.avatar !== undefined) fields['avatar'] = patch.avatar;
    if (Object.keys(fields).length > 0) await this.#redis.hset(this.#userKey(id), fields);
    return true;
  }

  async clearAvatar(id: string): Promise<void> {
    await this.#redis.hdel(this.#userKey(id), 'avatar');
  }

  async renameAccount(id: string, newUsername: string): Promise<boolean> {
    const record = await this.getAccount(id);
    if (record === undefined) return false;
    const oldKey = this.#nameKey(record.username);
    const newKey = this.#nameKey(newUsername);
    if (oldKey !== newKey) {
      const claimed = await this.#redis.set(newKey, id, 'NX');
      if (claimed === null) return false;
      await this.#redis.del(oldKey);
    }
    await this.#redis.hset(this.#userKey(id), 'username', newUsername.trim());
    return true;
  }

  async createToken(accountId: string): Promise<string> {
    const token = newToken();
    await this.#redis.set(this.#tokenKey(token), accountId, 'EX', TOKEN_TTL_SECONDS);
    return token;
  }

  async resolveToken(token: string): Promise<string | undefined> {
    // GET + EXPIRE rather than GETEX for ioredis-version safety; the refresh
    // racing a concurrent expiry only ever errs towards signing out.
    const id = await this.#redis.get(this.#tokenKey(token));
    if (id === null) return undefined;
    await this.#redis.expire(this.#tokenKey(token), TOKEN_TTL_SECONDS);
    return id;
  }

  async revokeToken(token: string): Promise<void> {
    await this.#redis.del(this.#tokenKey(token));
  }

  async listMaps(accountId: string): Promise<SavedMapRecord[]> {
    const hash = await this.#redis.hgetall(this.#mapsKey(accountId));
    const maps: SavedMapRecord[] = [];
    for (const raw of Object.values(hash)) {
      try {
        const parsed = JSON.parse(raw) as SavedMapRecord;
        if (typeof parsed.id === 'string' && typeof parsed.name === 'string') maps.push(parsed);
      } catch {
        // A corrupt entry loses itself, not the list.
      }
    }
    return maps.sort((a, b) => b.savedAt - a.savedAt);
  }

  async putMap(accountId: string, map: SavedMapRecord): Promise<boolean> {
    const key = this.#mapsKey(accountId);
    const exists = await this.#redis.hexists(key, map.id);
    if (exists === 0 && (await this.#redis.hlen(key)) >= MAX_SAVED_MAPS) return false;
    await this.#redis.hset(key, map.id, JSON.stringify(map));
    return true;
  }

  async deleteMap(accountId: string, mapId: string): Promise<boolean> {
    return (await this.#redis.hdel(this.#mapsKey(accountId), mapId)) > 0;
  }
}
