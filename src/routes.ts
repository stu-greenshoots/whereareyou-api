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
import type { RateLimitDecision, RateLimiter, RateSource } from './rate-limit.js';
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

/**
 * The axes this request is limited on.
 *
 * IP always. Resolver key as well, when there is one, because the two catch
 * different attacks: one host grinding through the codespace is caught by IP, a
 * leaked control-room key used from everywhere is caught by the key.
 */
function rateSourcesFor(request: FastifyRequest, resolver: string | null): RateSource[] {
  const sources: RateSource[] = [{ scope: 'ip', id: request.ip }];
  // 'anonymous' is what open mode reports for everybody, so it is not an
  // identity and must not become a single shared bucket for the whole world.
  if (resolver !== null && resolver !== 'anonymous') {
    sources.push({ scope: 'key', id: resolver });
  }
  return sources;
}

function refuse(reply: FastifyReply, decision: Extract<RateLimitDecision, { allowed: false }>) {
  reply.header('Retry-After', String(decision.retryAfterSeconds));
  return fail(
    reply,
    429,
    'rate-limited',
    `too many failed lookups; retry in ${decision.retryAfterSeconds}s`,
  );
}

/**
 * Everything the routes need beyond config and the store.
 *
 * An options object rather than positional parameters: three separate tickets
 * each wanted to add a fourth argument, and the third would have had to guess
 * what the first two chose. Named fields let them converge without coordinating.
 */
export interface RouteOptions {
  /**
   * Whether expiry is enforced by the datastore itself rather than by this
   * process. Surfaced on `/health` so that "a record cannot outlive its TTL" is
   * an observable fact about a running deployment rather than a claim in a
   * README that nobody can check from outside.
   */
  structuralExpiry?: boolean | undefined;
  /** Absent means no enumeration defence — local development only. */
  limiter?: RateLimiter | undefined;
}

export function registerRoutes(
  app: FastifyInstance,
  config: Config,
  store: SessionStore,
  options: RouteOptions = {},
): void {
  const { structuralExpiry = false, limiter } = options;

  app.get('/health', async () => ({
    status: 'ok',
    resolverMode: config.resolverMode,
    liveSessions: await store.size(),
    structuralExpiry,
    rateLimiting: limiter !== undefined,
  }));

  // ---- Mint -------------------------------------------------------------
  app.post('/v1/sessions', async (request, reply) => {
    // Loose by design. Someone pressing the button because they are in trouble
    // must get through; absorbing some junk is the cheaper failure.
    const mintSources = rateSourcesFor(request, null);
    if (limiter !== undefined) {
      const decision = await limiter.checkMint(mintSources);
      if (!decision.allowed) {
        request.log.warn({ event: 'mint.rate-limited', scope: decision.scope }, 'mint throttled');
        return refuse(reply, decision);
      }
      await limiter.recordMint(mintSources);
    }

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
    const sources = rateSourcesFor(request, resolver);

    // Checked before anything else — before auth, before parsing, and long
    // before the datastore — so that a source already known to be enumerating
    // costs almost nothing to reject.
    if (limiter !== undefined) {
      const decision = await limiter.checkResolve(sources);
      if (!decision.allowed) {
        // A blocked source that keeps probing is charged for it. Without this
        // the miss streak freezes the moment the first block lands — nothing
        // further is ever recorded — and the "exponential" backoff flattens
        // into a fixed short penalty an attacker can simply sleep through.
        // Continuing to hammer a 429 is also about the clearest signal of
        // intent available: a dispatcher honours Retry-After, a scanner does
        // not.
        await limiter.recordResolve(sources, 'miss');
        request.log.warn(
          { event: 'session.resolve', outcome: 'rate-limited', scope: decision.scope },
          'resolve throttled',
        );
        return refuse(reply, decision);
      }
    }

    // Every failure path below charges a miss. Note what counts as one: a bad
    // API key, a malformed code, an unknown code, and a code owned by another
    // control room. All four are things a dispatcher reading a code off a live
    // caller essentially never does, and all four are things enumeration does
    // constantly.
    const charge = async (outcome: 'hit' | 'miss') => {
      if (limiter !== undefined) await limiter.recordResolve(sources, outcome);
    };

    if (resolver === null) {
      await charge('miss');
      return fail(reply, 401, 'unauthorised', 'a valid resolver API key is required');
    }

    // Parse and checksum-check BEFORE touching the store. Malformed guesses
    // never reach the datastore at all, which is both cheaper and a smaller
    // surface for enumeration.
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) {
      await charge('miss');
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
    const deny = async () => {
      await charge('miss');
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

    await charge('hit');

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
