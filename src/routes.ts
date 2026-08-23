import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MARKER_ICONS,
  MAX_MARKER_NAME_CHARS,
  MAX_SESSION_MARKERS,
  formatCode,
  generateCode,
  isValidLiveId,
  isValidSketchPayload,
  parseCode,
  toPhonetic,
  type CreateSessionResponse,
  type MarkerIcon,
  type Position,
  type ProtocolErrorCode,
  type ResolvedSession,
  type SessionMarker,
} from '@whereareyou/protocol';
import type { Config } from './config.js';
import type { LiveRooms } from './live-rooms.js';
import type { PushService } from './push.js';
import type { RateLimitDecision, RateLimiter, RateSource } from './rate-limit.js';
import type { SessionStore, StoredSession } from './store.js';

function fail(reply: FastifyReply, status: number, error: ProtocolErrorCode, message: string) {
  return reply.status(status).send({ error, message });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokensMatch(supplied: string, storedHash: string): boolean {
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

function validIcon(value: unknown): MarkerIcon | undefined {
  return typeof value === 'string' && (MARKER_ICONS as readonly string[]).includes(value)
    ? (value as MarkerIcon)
    : undefined;
}

/**
 * A stored session's marker list, whatever era the record is from. Records
 * written since live v2 carry `markers` (authoritative, possibly `[]` — any
 * lingering legacy fields are ignored); older records carried only the
 * single `marker`/`markerIcon` pair, which reads back as a one-entry list
 * whose id is `legacy`, per the back-compat rule.
 */
function sessionMarkers(session: StoredSession): SessionMarker[] {
  if (session.markers !== undefined) return session.markers;
  if (session.marker === undefined) return [];
  return [{ id: 'legacy', position: session.marker, icon: validIcon(session.markerIcon) ?? 'spot' }];
}

function toResolved(session: StoredSession): ResolvedSession {
  // The mirror rule: `marker`/`markerIcon` are read-only views of
  // `markers[0]`, set on every read, never independently stored truth.
  const markers = sessionMarkers(session);
  const first = markers[0];
  return {
    code: session.code,
    position: session.position,
    mode: session.mode,
    subject: session.subject,
    ...(session.note !== undefined ? { note: session.note } : {}),
    ...(session.sketch !== undefined ? { sketch: session.sketch } : {}),
    ...(first !== undefined
      ? { markers, marker: first.position, markerIcon: first.icon }
      : {}),
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    ...(session.claimedBy !== undefined ? { claimedBy: session.claimedBy } : {}),
  };
}

/**
 * Validate a REST `markers` payload. Unlike the WebSocket parser (which
 * rejects the whole frame), the REST rule is the mint's: invalid entries are
 * dropped silently, duplicates and overflow included — a bad marker must
 * never cost someone their code. Returns undefined when the field is absent
 * or not an array at all, so callers can tell "not supplied" from "empty".
 */
function validateMarkers(input: unknown): SessionMarker[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set<string>();
  const markers: SessionMarker[] = [];
  for (const entry of input) {
    if (markers.length >= MAX_SESSION_MARKERS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = raw['id'];
    if (!isValidLiveId(id) || seen.has(id)) continue;
    const validated = validatePosition(raw['position']);
    if ('error' in validated) continue;
    let name: string | undefined;
    if (raw['name'] !== undefined) {
      if (typeof raw['name'] !== 'string') continue;
      name = raw['name'].trim().slice(0, MAX_MARKER_NAME_CHARS);
      if (name === '') name = undefined;
    }
    seen.add(id);
    markers.push({
      id,
      position: validated.position,
      icon: validIcon(raw['icon']) ?? 'spot',
      ...(name !== undefined ? { name } : {}),
    });
  }
  return markers;
}

/**
 * The marker fields of a mint or PATCH body, under the back-compat rule: a
 * body carrying `markers` is authoritative and any `marker`/`markerIcon`
 * beside it are ignored; a body carrying only the legacy pair becomes a
 * one-entry list whose id is `legacy`. Undefined means "nothing supplied —
 * leave stored state alone".
 */
function markersFromBody(body: Record<string, unknown>): SessionMarker[] | undefined {
  const markers = validateMarkers(body['markers']);
  if (markers !== undefined) return markers;
  if (body['marker'] === undefined) return undefined;
  // Legacy single-marker path: validated exactly like a position, dropped
  // silently when it fails — a bad marker must never cost someone their code.
  const validated = validatePosition(body['marker']);
  if ('error' in validated) return undefined;
  return [{ id: 'legacy', position: validated.position, icon: validIcon(body['markerIcon']) ?? 'spot' }];
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
  /** Live rooms, so a session extension can re-arm an open room's expiry. */
  rooms?: LiveRooms | undefined;
  /** Web Push, for the lookup notification and expiry-warning re-arming. */
  push?: PushService | undefined;
}

/** Extension guards: per-call bounds, and the hard ceiling on total life. */
const EXTEND_MIN_MINUTES = 1;
const EXTEND_MAX_MINUTES = 180;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function registerRoutes(
  app: FastifyInstance,
  config: Config,
  store: SessionStore,
  options: RouteOptions = {},
): void {
  const { structuralExpiry = false, limiter, rooms, push } = options;

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

    // Accepted only when well-formed — length and charset, never decoded
    // here — and otherwise dropped silently while the mint proceeds. A
    // malformed sketch must never cost someone in trouble their code.
    const sketch =
      typeof body['sketch'] === 'string' && isValidSketchPayload(body['sketch'])
        ? body['sketch']
        : undefined;

    // The marked spots — the `markers` list, or the legacy single-marker
    // pair converted to one. Only the list is stored; the legacy fields are
    // recomputed as mirrors of markers[0] on every read.
    const markers = markersFromBody(body);

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
      ...(sketch !== undefined ? { sketch } : {}),
      ...(markers !== undefined && markers.length > 0 ? { markers } : {}),
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

    // Tell the sharer their code was looked up. Fire-and-forget off the hot
    // path (sendToSession never throws), and generic BY DESIGN: no position,
    // no operator identity, nothing but the fact of the lookup.
    if (push !== undefined) {
      void push.sendToSession(parsed.code, {
        title: 'whereareyou',
        body: 'An operator has looked up your code.',
      });
    }

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
    // One-way upgrade: the owner can turn a static session live ("make this
    // a live session"), and never the reverse — a code that was promised to
    // follow someone must not quietly stop doing so.
    const upgradeToLive = body['mode'] === 'live' && session.mode !== 'live';

    // A reported (third-party) share whose owner goes live starts streaming
    // the owner's OWN position, so a stored `third-party` would mislabel what
    // `position` now means — the console's REPORTED banner would be pointing
    // at the caller themselves. The upgrade may therefore carry
    // `subject: 'self'`, accepted only at that moment and only in that
    // direction: a code can never quietly become "somewhere else" after
    // minting, and an already-live session keeps the subject it was born
    // with. The marked spots keep carrying the reported place.
    const subjectFlip =
      upgradeToLive && body['subject'] === 'self' && session.subject === 'third-party';

    if (session.mode !== 'live' && !upgradeToLive) {
      return fail(reply, 409, 'not-live', 'session is static and cannot be updated');
    }

    // An upgrade-only PATCH may omit the position; anything else keeps the
    // existing rule that a PATCH is a position update.
    let position: Position | undefined;
    if (body['position'] !== undefined || !upgradeToLive) {
      const validated = validatePosition(body['position']);
      if ('error' in validated) return fail(reply, 400, 'invalid-position', validated.error);
      position = validated.position;
    }

    // A replacement sketch may ride a position update — a caller adding an
    // arrow after the code is already out. Same silent-drop rule as minting;
    // absent means "leave the stored sketch alone".
    const sketch =
      typeof body['sketch'] === 'string' && isValidSketchPayload(body['sketch'])
        ? body['sketch']
        : undefined;

    // Markers under the same rule as everywhere: `markers` authoritative
    // (an empty list clears), the legacy pair converted, absence meaning
    // "leave the stored list alone".
    const markers = markersFromBody(body);

    // Note: expiresAt is deliberately NOT extended. A live session must not
    // become immortal simply by continuing to move.
    await store.update(parsed.code, {
      ...(position !== undefined ? { position } : {}),
      ...(upgradeToLive ? { mode: 'live' as const } : {}),
      ...(subjectFlip ? { subject: 'self' as const } : {}),
      ...(sketch !== undefined ? { sketch } : {}),
      ...(markers !== undefined ? { markers } : {}),
      updatedAt: Date.now(),
    });
    return reply.status(204).send();
  });

  // ---- Extend -----------------------------------------------------------
  app.post<{ Params: { code: string } }>('/v1/sessions/:code/extend', async (request, reply) => {
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) return fail(reply, 400, 'invalid-code', `code rejected: ${parsed.reason}`);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['updateToken'] === 'string' ? body['updateToken'] : '';

    const session = await store.get(parsed.code);
    // Wrong token and missing session are indistinguishable from outside,
    // exactly as on PATCH and DELETE.
    if (session === undefined || !tokensMatch(token, session.updateTokenHash)) {
      return fail(reply, 404, 'not-found', 'no session for that code');
    }

    const addMinutes = body['addMinutes'];
    if (
      typeof addMinutes !== 'number' ||
      !Number.isInteger(addMinutes) ||
      addMinutes < EXTEND_MIN_MINUTES ||
      addMinutes > EXTEND_MAX_MINUTES
    ) {
      // Outside ProtocolErrorCode — the union has no slot for this yet, and
      // the account routes already established plain-string errors for
      // endpoints the protocol does not cover.
      return reply.status(400).send({
        error: 'invalid-extend',
        message: `addMinutes must be an integer between ${EXTEND_MIN_MINUTES} and ${EXTEND_MAX_MINUTES}`,
      });
    }

    // Cumulative cap: however many times the owner extends, the session never
    // lives past 24h from creation. createdAt IS stored, so the ceiling is
    // anchored there, not at "now". Clamping (rather than erroring) means the
    // last extension before the ceiling still grants what it can.
    const cap = session.createdAt + MAX_SESSION_LIFETIME_MS;
    const expiresAt = Math.min(session.expiresAt + addMinutes * 60_000, cap);

    if (expiresAt > session.expiresAt) {
      await store.extend(parsed.code, expiresAt);
      // Every key belonging to the session moves together: the push
      // subscriptions' TTL follows the session's new remaining lifetime.
      // (Lengthening a TTL — never a delete.)
      if (push !== undefined) await push.extendSubscriptions(parsed.code, expiresAt - Date.now());
    }

    // An open live room learns immediately: its death timer is re-armed and
    // everyone's countdown is corrected.
    if (rooms !== undefined && rooms.size(parsed.code) > 0) rooms.extend(parsed.code, expiresAt);

    // Re-arm the T-minus-5 warning against the NEW expiry — an already-armed
    // timer would otherwise fire five minutes before a moment that no longer
    // means anything.
    push?.armExpiryWarning(parsed.code, expiresAt);

    request.log.info(
      { event: 'session.extended', code: parsed.code, addMinutes },
      'session extended',
    );
    return reply.send({ expiresAt: new Date(expiresAt).toISOString() });
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
    // The room dies with the record: anyone still connected is told plainly
    // and hung up on. Without this, "Stop sharing" left joiners in a zombie
    // room, relaying live positions until the original expiry timer fired —
    // the code 404'd while the tracking quietly continued.
    if (rooms !== undefined && rooms.size(parsed.code) > 0) rooms.expire(parsed.code);
    request.log.info({ event: 'session.revoked', code: parsed.code }, 'session revoked');
    return reply.status(204).send();
  });
}
