import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import webpush from 'web-push';

/**
 * Web Push plumbing — POC.
 *
 * Two jobs live here: keeping per-session push subscriptions on the same
 * structural-expiry footing as the session itself (the subscription keys carry
 * the session's remaining TTL, so expiry kills notifications without anyone
 * deleting anything), and holding the VAPID identity without any key material
 * ever entering the repo (env wins; otherwise generated once and persisted in
 * the store).
 *
 * THE ONE RULE: a push payload NEVER contains a position, a note, a sketch, or
 * anything else a user produced. Payloads travel through Apple/Google/Mozilla
 * relay infrastructure; titles and bodies stay generic by design.
 */

/** URL subject — who to contact about this VAPID identity. */
export const VAPID_SUBJECT = 'https://whereareyou.stu-bot.uk';

/** Per-session subscription cap; extras beyond it are silently ignored. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** How far ahead of expiry the "expiring soon" warning fires. */
export const EXPIRY_WARNING_LEAD_MS = 5 * 60_000;

const ENDPOINT_MAX_CHARS = 2048;
const P256DH_MAX_CHARS = 256;
const AUTH_MAX_CHARS = 128;

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

/** The subset of a browser PushSubscription this server keeps. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Generic-by-design notification content. No field here may carry user content. */
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Validate an incoming PushSubscription. Anything unexpected — wrong types,
 * non-https endpoint, oversized fields — is rejected wholesale; extra browser
 * fields (expirationTime etc.) are dropped, not stored.
 */
export function parsePushSubscription(input: unknown): PushSubscriptionRecord | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const raw = input as Record<string, unknown>;

  const endpoint = raw['endpoint'];
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX_CHARS) return undefined;
  try {
    if (new URL(endpoint).protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }

  const keys = raw['keys'];
  if (typeof keys !== 'object' || keys === null) return undefined;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || p256dh === '' || p256dh.length > P256DH_MAX_CHARS) {
    return undefined;
  }
  if (typeof auth !== 'string' || auth === '' || auth.length > AUTH_MAX_CHARS) return undefined;

  return { endpoint, keys: { p256dh, auth } };
}

export interface PushStore {
  /**
   * First-writer-wins persistence of the VAPID pair: if a pair is already
   * stored (an earlier boot got there first), that one is returned and the
   * candidate is discarded. Otherwise the candidate is stored and returned.
   */
  ensureVapidKeys(candidate: VapidKeyPair): Promise<VapidKeyPair>;
  /**
   * Add a subscription for a session, deduplicated by endpoint and silently
   * ignored beyond MAX_PUSH_SUBSCRIPTIONS. `ttlMs` is the session's remaining
   * lifetime; the stored keys must not outlive it.
   */
  addSubscription(code: string, sub: PushSubscriptionRecord, ttlMs: number): Promise<void>;
  listSubscriptions(code: string): Promise<PushSubscriptionRecord[]>;
  /** Re-arm the subscription keys' TTL after a session extension. Never a delete. */
  extendTo(code: string, ttlMs: number): Promise<void>;
}

/** In-memory twin of the Redis push store, for tests and REDIS_URL-less dev. */
export class MemoryPushStore implements PushStore {
  #vapid: VapidKeyPair | undefined;
  readonly #subs = new Map<
    string,
    { expiresAt: number; byEndpoint: Map<string, PushSubscriptionRecord> }
  >();

  async ensureVapidKeys(candidate: VapidKeyPair): Promise<VapidKeyPair> {
    this.#vapid ??= candidate;
    return this.#vapid;
  }

  #live(code: string) {
    const entry = this.#subs.get(code);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#subs.delete(code);
      return undefined;
    }
    return entry;
  }

  async addSubscription(code: string, sub: PushSubscriptionRecord, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    const entry = this.#live(code) ?? { expiresAt: 0, byEndpoint: new Map() };
    if (entry.byEndpoint.size >= MAX_PUSH_SUBSCRIPTIONS && !entry.byEndpoint.has(sub.endpoint)) {
      return; // silently capped
    }
    entry.byEndpoint.set(sub.endpoint, sub);
    entry.expiresAt = Date.now() + ttlMs;
    this.#subs.set(code, entry);
  }

  async listSubscriptions(code: string): Promise<PushSubscriptionRecord[]> {
    return [...(this.#live(code)?.byEndpoint.values() ?? [])];
  }

  async extendTo(code: string, ttlMs: number): Promise<void> {
    const entry = this.#live(code);
    if (entry !== undefined) entry.expiresAt = Date.now() + ttlMs;
  }
}

const VAPID_REDIS_KEY = 'push:vapid';

function subsKey(code: string): string {
  return `push:${code}:subs`;
}

/**
 * Add a subscription unless the cap is hit, and re-arm the key's TTL to the
 * session's remaining lifetime — one atomic step, for the same reason the
 * session store scripts exist: HSET against a key that expired a moment ago
 * would recreate it with no TTL at all, and a push subscription that outlives
 * its session is exactly the record this design promises cannot exist.
 *
 * ARGV[1] = field (endpoint hash), ARGV[2] = subscription JSON,
 * ARGV[3] = cap, ARGV[4] = TTL ms.
 */
const ADD_SUB_SCRIPT = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) and redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

interface RedisWithPushCommands extends Redis {
  wayAddPushSub(key: string, field: string, json: string, cap: string, ttlMs: string): Promise<number>;
}

/**
 * Redis push store. Subscriptions for a session live in one hash,
 * `push:{code}:subs`, whose TTL tracks the session's — so expiry structurally
 * kills notifications, no sweeper, no delete. The VAPID pair lives at
 * `push:vapid` with no TTL: it is server identity, not user data.
 */
export class RedisPushStore implements PushStore {
  readonly #redis: RedisWithPushCommands;

  constructor(redis: Redis) {
    redis.defineCommand('wayAddPushSub', { numberOfKeys: 1, lua: ADD_SUB_SCRIPT });
    this.#redis = redis as RedisWithPushCommands;
  }

  async ensureVapidKeys(candidate: VapidKeyPair): Promise<VapidKeyPair> {
    // SETNX then GET rather than SET...NX GET, to stay compatible with the
    // Redis 6.x that the free tier may still be running.
    const won = await this.#redis.setnx(VAPID_REDIS_KEY, JSON.stringify(candidate));
    if (won === 1) return candidate;
    const raw = await this.#redis.get(VAPID_REDIS_KEY);
    // The only way raw is null here is the key vanishing between SETNX and GET,
    // which nothing in this codebase does; fall back to the candidate so a
    // race cannot leave us keyless.
    return raw === null ? candidate : (JSON.parse(raw) as VapidKeyPair);
  }

  async addSubscription(code: string, sub: PushSubscriptionRecord, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    const field = createHash('sha256').update(sub.endpoint).digest('hex');
    await this.#redis.wayAddPushSub(
      subsKey(code),
      field,
      JSON.stringify(sub),
      String(MAX_PUSH_SUBSCRIPTIONS),
      String(Math.ceil(ttlMs)),
    );
  }

  async listSubscriptions(code: string): Promise<PushSubscriptionRecord[]> {
    const values = await this.#redis.hvals(subsKey(code));
    return values.map((value) => JSON.parse(value) as PushSubscriptionRecord);
  }

  async extendTo(code: string, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    // PEXPIRE on a missing key is a no-op — lengthening a TTL, never deleting.
    await this.#redis.pexpire(subsKey(code), Math.ceil(ttlMs));
  }
}

/** The two web-push calls this server makes, injectable so tests never touch the network. */
export interface WebPushLike {
  generateVAPIDKeys(): VapidKeyPair;
  sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } },
  ): Promise<unknown>;
}

export interface PushServiceOptions {
  /** Real web-push by default; a recorder in tests. */
  sender?: WebPushLike | undefined;
  /** VAPID keys from the environment. When both are present they ALWAYS win. */
  publicKey?: string | undefined;
  privateKey?: string | undefined;
}

export class PushService {
  readonly #store: PushStore;
  readonly #sender: WebPushLike;
  readonly #envPublicKey: string | undefined;
  readonly #envPrivateKey: string | undefined;
  #vapidPromise: Promise<VapidKeyPair> | undefined;
  readonly #warnings = new Map<string, NodeJS.Timeout>();

  constructor(store: PushStore, options: PushServiceOptions = {}) {
    this.#store = store;
    this.#sender = options.sender ?? (webpush as WebPushLike);
    this.#envPublicKey = options.publicKey;
    this.#envPrivateKey = options.privateKey;
  }

  /**
   * Resolve the VAPID pair, once per process. Env wins outright; otherwise a
   * pair is generated on first need and persisted first-writer-wins in the
   * store, so every later boot (and any concurrent instance sharing the
   * Redis) reuses the same identity. No key material in the repo, ever.
   */
  #vapid(): Promise<VapidKeyPair> {
    this.#vapidPromise ??= (async () => {
      if (this.#envPublicKey !== undefined && this.#envPrivateKey !== undefined) {
        return { publicKey: this.#envPublicKey, privateKey: this.#envPrivateKey };
      }
      return this.#store.ensureVapidKeys(this.#sender.generateVAPIDKeys());
    })();
    return this.#vapidPromise;
  }

  async publicKey(): Promise<string> {
    return (await this.#vapid()).publicKey;
  }

  async subscribe(code: string, sub: PushSubscriptionRecord, ttlMs: number): Promise<void> {
    await this.#store.addSubscription(code, sub, ttlMs);
  }

  /** After a session extension: the subscription keys follow the session's new TTL. */
  async extendSubscriptions(code: string, ttlMs: number): Promise<void> {
    await this.#store.extendTo(code, ttlMs);
  }

  /**
   * Fire the payload at every subscription on the session. Per-endpoint
   * failures are swallowed: a 410 Gone just means that browser unsubscribed,
   * and its stored key TTLs out with the session anyway. Never throws — the
   * routes call this fire-and-forget off hot paths.
   */
  async sendToSession(code: string, payload: PushPayload): Promise<void> {
    try {
      const subs = await this.#store.listSubscriptions(code);
      if (subs.length === 0) return;
      const keys = await this.#vapid();
      const body = JSON.stringify(payload);
      const vapidDetails = { subject: VAPID_SUBJECT, ...keys };
      await Promise.all(
        subs.map(async (sub) => {
          try {
            await this.#sender.sendNotification(sub, body, { vapidDetails });
          } catch {
            // Gone, throttled, unreachable — all the same to a POC: skip it.
          }
        }),
      );
    } catch {
      // A push that cannot be attempted must never surface on the calling route.
    }
  }

  /**
   * Arm (or re-arm) the "expires in 5 minutes" warning for a session.
   *
   * Honestly stated POC limitation: these are in-process setTimeout timers.
   * A restart or redeploy loses every armed warning and nothing re-arms them
   * until the session's live room is next joined or the session is extended.
   * Acceptable for the POC; a real deployment would want them derived from
   * the store on boot.
   */
  armExpiryWarning(code: string, expiresAt: number): void {
    const existing = this.#warnings.get(code);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.#warnings.delete(code);
    }
    const fireInMs = expiresAt - Date.now() - EXPIRY_WARNING_LEAD_MS;
    if (fireInMs <= 0) return; // less than five minutes left: skip, don't spam
    const timer = setTimeout(() => {
      this.#warnings.delete(code);
      void this.sendToSession(code, {
        title: 'whereareyou',
        body: 'Your share expires in 5 minutes.',
      });
    }, fireInMs);
    timer.unref?.();
    this.#warnings.set(code, timer);
  }

  /** Tests and shutdown: no timers left behind. */
  stop(): void {
    for (const timer of this.#warnings.values()) clearTimeout(timer);
    this.#warnings.clear();
  }
}
