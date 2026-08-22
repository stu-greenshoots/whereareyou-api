import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter, RateSource } from './rate-limit.js';
import {
  MAX_SAVED_MAPS,
  canonicalUsername,
  newAccountId,
  type AccountRecord,
  type AccountStore,
  type SavedMapRecord,
} from './account-store.js';

/**
 * Account routes — register, login, profile, saved maps.
 *
 * POC-grade auth, and honest about which corners that cuts: opaque bearer
 * tokens rather than JWTs (revocable, no crypto to get wrong), scrypt for
 * passwords (in node:crypto, no new dependency), and the mint rate budget
 * reused per-IP on register/login so credential guessing at least pays the
 * same toll as minting. There is no email, no reset flow, no verification —
 * a forgotten password is a lost account, and the register screen says so.
 */

const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
/** Data-URL ceiling — the client downsizes to ~96px JPEG, a few KB. */
const AVATAR_MAX_BYTES = 64 * 1024;
const MAP_NAME_MAX = 80;
/** Opaque map blob ceiling. A sketch-heavy map is ~2–10KB encoded. */
const MAP_DATA_MAX_BYTES = 64 * 1024;

const AVATAR_PREFIX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [version, saltHex, hashHex] = stored.split(':');
  if (version !== 's1' || saltHex === undefined || hashHex === undefined) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validUsername(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) return undefined;
  // Printable, no control characters; anything a person can say aloud is fine.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}

function validAvatar(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length > AVATAR_MAX_BYTES) return undefined;
  if (!AVATAR_PREFIX.test(raw)) return undefined;
  return raw;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? undefined : token;
}

/** What the client is told about an account. Never the password hash. */
function toProfile(record: AccountRecord): { username: string; avatar?: string } {
  return {
    username: record.username,
    ...(record.avatar !== undefined ? { avatar: record.avatar } : {}),
  };
}

export interface AccountRouteOptions {
  limiter?: RateLimiter | undefined;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  accounts: AccountStore,
  options: AccountRouteOptions = {},
): void {
  const { limiter } = options;

  /** Per-IP throttle on the credential-shaped endpoints, borrowing the mint
      budget: cheap, already provisioned, and the right order of magnitude. */
  async function throttled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (limiter === undefined) return false;
    const sources: RateSource[] = [{ scope: 'ip', id: request.ip }];
    const decision = await limiter.checkMint(sources);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      await fail(reply, 429, 'rate-limited', `too many attempts; retry in ${decision.retryAfterSeconds}s`);
      return true;
    }
    await limiter.recordMint(sources);
    return false;
  }

  /** Resolve the bearer token or reply 401. */
  async function requireAccount(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string; token: string } | undefined> {
    const token = bearerToken(request);
    if (token === undefined) {
      await fail(reply, 401, 'unauthorised', 'this endpoint needs a Bearer login token');
      return undefined;
    }
    const id = await accounts.resolveToken(token);
    if (id === undefined) {
      await fail(reply, 401, 'unauthorised', 'that login token is not valid — sign in again');
      return undefined;
    }
    return { id, token };
  }

  app.post('/v1/account/register', async (request, reply) => {
    if (await throttled(request, reply)) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const username = validUsername(body['username']);
    if (username === undefined) {
      return fail(reply, 400, 'invalid-username', `username must be ${USERNAME_MIN}–${USERNAME_MAX} printable characters`);
    }
    const password = body['password'];
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return fail(reply, 400, 'invalid-password', `password must be at least ${PASSWORD_MIN} characters`);
    }

    const record: AccountRecord = {
      id: newAccountId(),
      username,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
    };
    const created = await accounts.createAccount(record);
    if (!created) return fail(reply, 409, 'username-taken', 'that username is already taken');

    const token = await accounts.createToken(record.id);
    request.log.info({ event: 'account.registered' }, 'account registered');
    return reply.status(201).send({ token, account: toProfile(record) });
  });

  app.post('/v1/account/login', async (request, reply) => {
    if (await throttled(request, reply)) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    // One error for both failure kinds, so login cannot be used to probe
    // which usernames exist.
    const refuse = () => fail(reply, 401, 'bad-credentials', 'wrong username or password');

    const id = await accounts.getIdByUsername(canonicalUsername(username));
    if (id === undefined) return refuse();
    const record = await accounts.getAccount(id);
    if (record === undefined) return refuse();
    if (!passwordMatches(password, record.passwordHash)) return refuse();

    const token = await accounts.createToken(record.id);
    return reply.send({ token, account: toProfile(record) });
  });

  app.post('/v1/account/logout', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;
    await accounts.revokeToken(auth.token);
    return reply.status(204).send();
  });

  app.get('/v1/account', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;
    const record = await accounts.getAccount(auth.id);
    if (record === undefined) return fail(reply, 404, 'not-found', 'account no longer exists');
    return reply.send({ account: toProfile(record) });
  });

  app.patch('/v1/account', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;
    const record = await accounts.getAccount(auth.id);
    if (record === undefined) return fail(reply, 404, 'not-found', 'account no longer exists');

    const body = (request.body ?? {}) as Record<string, unknown>;

    if (body['username'] !== undefined) {
      const username = validUsername(body['username']);
      if (username === undefined) {
        return fail(reply, 400, 'invalid-username', `username must be ${USERNAME_MIN}–${USERNAME_MAX} printable characters`);
      }
      const renamed = await accounts.renameAccount(auth.id, username);
      if (!renamed) return fail(reply, 409, 'username-taken', 'that username is already taken');
    }

    if (body['newPassword'] !== undefined) {
      const current = body['currentPassword'];
      const next = body['newPassword'];
      if (typeof current !== 'string' || !passwordMatches(current, record.passwordHash)) {
        return fail(reply, 401, 'bad-credentials', 'current password is wrong');
      }
      if (typeof next !== 'string' || next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
        return fail(reply, 400, 'invalid-password', `password must be at least ${PASSWORD_MIN} characters`);
      }
      await accounts.updateAccount(auth.id, { passwordHash: hashPassword(next) });
    }

    if (body['avatar'] === null) {
      await accounts.clearAvatar(auth.id);
    } else if (body['avatar'] !== undefined) {
      const avatar = validAvatar(body['avatar']);
      if (avatar === undefined) {
        return fail(reply, 400, 'invalid-avatar', 'avatar must be a small data:image/(png|jpeg|webp) URL');
      }
      await accounts.updateAccount(auth.id, { avatar });
    }

    const updated = await accounts.getAccount(auth.id);
    return reply.send({ account: toProfile(updated ?? record) });
  });

  app.get('/v1/account/maps', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;
    const maps = await accounts.listMaps(auth.id);
    return reply.send({ maps });
  });

  app.put<{ Params: { id: string } }>('/v1/account/maps/:id', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;

    const mapId = request.params.id;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(mapId)) {
      return fail(reply, 400, 'invalid-map', 'map id must be short and URL-safe');
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, MAP_NAME_MAX) : '';
    if (name === '') return fail(reply, 400, 'invalid-map', 'a saved map needs a name');

    // Opaque by contract: length-checked, must parse as JSON so a future
    // backend can store it in a JSON column, and otherwise never inspected.
    const data = body['data'];
    if (typeof data !== 'string' || data.length > MAP_DATA_MAX_BYTES) {
      return fail(reply, 400, 'invalid-map', `map data must be a JSON string under ${MAP_DATA_MAX_BYTES} bytes`);
    }
    try {
      JSON.parse(data);
    } catch {
      return fail(reply, 400, 'invalid-map', 'map data must be valid JSON');
    }

    const map: SavedMapRecord = { id: mapId, name, savedAt: Date.now(), data };
    const stored = await accounts.putMap(auth.id, map);
    if (!stored) {
      return fail(reply, 409, 'too-many-maps', `an account can hold ${MAX_SAVED_MAPS} saved maps — delete one first`);
    }
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/v1/account/maps/:id', async (request, reply) => {
    const auth = await requireAccount(request, reply);
    if (auth === undefined) return reply;
    const deleted = await accounts.deleteMap(auth.id, request.params.id);
    if (!deleted) return fail(reply, 404, 'not-found', 'no saved map with that id');
    return reply.status(204).send();
  });
}
