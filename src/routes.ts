import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  formatCode,
  generateCode,
  parseCode,
  toPhonetic,
  type CreateSessionResponse,
  type Position,
  type ProtocolErrorCode,
  type ResolvedSession,
} from '@whereareyou/protocol';
import type { Config } from './config.js';
import type { SessionStore, StoredSession } from './store.js';

function fail(reply: FastifyReply, status: number, error: ProtocolErrorCode, message: string) {
  return reply.status(status).send({ error, message });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokensMatch(supplied: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(supplied), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate an incoming position, returning a message on failure. */
function validatePosition(input: unknown): { position: Position } | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'position must be an object' };
  const raw = input as Record<string, unknown>;

  const lat = raw['lat'];
  const lon = raw['lon'];
  const accuracyM = raw['accuracyM'];

  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'lat must be a finite number between -90 and 90' };
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { error: 'lon must be a finite number between -180 and 180' };
  }
  if (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM < 0) {
    return { error: 'accuracyM must be a non-negative finite number' };
  }

  const source = raw['source'];
  if (source !== 'gnss' && source !== 'network' && source !== 'manual') {
    return { error: 'source must be one of: gnss, network, manual' };
  }

  // A fix timestamped in the future is either a clock problem or a forgery;
  // either way it must not be presented to a dispatcher as trustworthy.
  const takenAt = typeof raw['takenAt'] === 'string' ? raw['takenAt'] : new Date().toISOString();
  const takenAtMs = Date.parse(takenAt);
  if (!Number.isFinite(takenAtMs)) return { error: 'takenAt must be an ISO 8601 timestamp' };
  if (takenAtMs > Date.now() + 60_000) return { error: 'takenAt is in the future' };

  return { position: { lat, lon, accuracyM, source, takenAt } };
}

function toResolved(session: StoredSession): ResolvedSession {
  return {
    code: session.code,
    position: session.position,
    mode: session.mode,
    subject: session.subject,
    ...(session.note !== undefined ? { note: session.note } : {}),
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    ...(session.claimedBy !== undefined ? { claimedBy: session.claimedBy } : {}),
  };
}

/**
 * Identify the resolver making a request.
 * Returns the resolver identity, or `null` if authentication failed.
 */
function identifyResolver(config: Config, request: FastifyRequest): string | null {
  if (config.resolverMode === 'open') return 'anonymous';

  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return config.apiKeys.get(header.slice('Bearer '.length)) ?? null;
}

export function registerRoutes(app: FastifyInstance, config: Config, store: SessionStore): void {
  app.get('/health', async () => ({
    status: 'ok',
    resolverMode: config.resolverMode,
    liveSessions: await store.size(),
  }));

  // ---- Mint -------------------------------------------------------------
  app.post('/v1/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const validated = validatePosition(body['position']);
    if ('error' in validated) return fail(reply, 400, 'invalid-position', validated.error);

    const mode = body['mode'] === 'live' ? 'live' : 'static';
    const subject = body['subject'] === 'third-party' ? 'third-party' : 'self';

    const requestedTtl =
      typeof body['ttlSeconds'] === 'number' ? body['ttlSeconds'] : config.defaultTtlSeconds;
    const ttlSeconds = Math.min(
      Math.max(requestedTtl, config.minTtlSeconds),
      config.maxTtlSeconds,
    );

    const note = typeof body['note'] === 'string' ? body['note'].slice(0, 280) : undefined;

    // Retry on the astronomically unlikely collision rather than silently
    // overwriting somebody else's live session.
    let code = generateCode();
    for (let attempt = 0; attempt < 5 && (await store.get(code)) !== undefined; attempt++) {
      code = generateCode();
    }
    if ((await store.get(code)) !== undefined) {
      return fail(reply, 503, 'not-found', 'could not allocate a free code, try again');
    }

    const updateToken = randomBytes(32).toString('base64url');
    const now = Date.now();

    await store.create({
      code,
      position: validated.position,
      mode,
      subject,
      ...(note !== undefined ? { note } : {}),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlSeconds * 1000,
      updateTokenHash: hashToken(updateToken),
    });

    request.log.info({ event: 'session.minted', code, mode, subject, ttlSeconds }, 'session minted');

    const response: CreateSessionResponse = {
      code,
      display: formatCode(code),
      phonetic: toPhonetic(code),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      updateToken,
    };
    return reply.status(201).send(response);
  });

  // ---- Resolve ----------------------------------------------------------
  app.get<{ Params: { code: string } }>('/v1/sessions/:code', async (request, reply) => {
    const resolver = identifyResolver(config, request);
    if (resolver === null) {
      return fail(reply, 401, 'unauthorised', 'a valid resolver API key is required');
    }

    // Parse and checksum-check BEFORE touching the store. Malformed guesses
    // never reach the datastore at all, which is both cheaper and a smaller
    // surface for enumeration.
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) {
      request.log.info(
        { event: 'session.resolve', outcome: 'invalid-code', reason: parsed.reason, resolver },
        'resolve rejected',
      );
      return fail(reply, 400, 'invalid-code', `code rejected: ${parsed.reason}`);
    }

    const session = await store.get(parsed.code);

    // Deliberately identical response for: never existed, expired, revoked, and
    // claimed by a different resolver. Distinguishing them would confirm to an
    // attacker that a guessed code is real — the exact signal enumeration
    // defence exists to deny.
    const deny = () => {
      request.log.info(
        { event: 'session.resolve', outcome: 'not-found', code: parsed.code, resolver },
        'resolve denied',
      );
      return fail(reply, 404, 'not-found', 'no session for that code');
    };

    if (session === undefined) return deny();

    const claimable = config.resolverMode === 'apikey';
    if (claimable) {
      if (session.claimedBy !== undefined && session.claimedBy !== resolver) return deny();
      if (session.claimedBy === undefined) {
        await store.update(parsed.code, { claimedBy: resolver });
        session.claimedBy = resolver;
      }
    }

    // Audit: records THAT a lookup happened, never where. Full accountability,
    // no location history database.
    request.log.info(
      { event: 'session.resolve', outcome: 'ok', code: parsed.code, resolver },
      'resolve ok',
    );

    return reply.send({
      ...toResolved(session),
      ...(claimable ? {} : { warning: 'resolver running in open mode; claiming disabled' }),
    });
  });

  // ---- Live update ------------------------------------------------------
  app.patch<{ Params: { code: string } }>('/v1/sessions/:code', async (request, reply) => {
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) return fail(reply, 400, 'invalid-code', `code rejected: ${parsed.reason}`);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['updateToken'] === 'string' ? body['updateToken'] : '';

    const session = await store.get(parsed.code);
    // Wrong token and missing session are indistinguishable from outside.
    if (session === undefined || !tokensMatch(token, session.updateTokenHash)) {
      return fail(reply, 404, 'not-found', 'no session for that code');
    }
    if (session.mode !== 'live') {
      return fail(reply, 409, 'not-live', 'session is static and cannot be updated');
    }

    const validated = validatePosition(body['position']);
    if ('error' in validated) return fail(reply, 400, 'invalid-position', validated.error);

    // Note: expiresAt is deliberately NOT extended. A live session must not
    // become immortal simply by continuing to move.
    await store.update(parsed.code, { position: validated.position, updatedAt: Date.now() });
    return reply.status(204).send();
  });

  // ---- Revoke -----------------------------------------------------------
  app.delete<{ Params: { code: string } }>('/v1/sessions/:code', async (request, reply) => {
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) return fail(reply, 400, 'invalid-code', `code rejected: ${parsed.reason}`);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['updateToken'] === 'string' ? body['updateToken'] : '';

    const session = await store.get(parsed.code);
    if (session === undefined || !tokensMatch(token, session.updateTokenHash)) {
      return fail(reply, 404, 'not-found', 'no session for that code');
    }

    await store.delete(parsed.code);
    request.log.info({ event: 'session.revoked', code: parsed.code }, 'session revoked');
    return reply.status(204).send();
  });
}
