import type { Position, SessionMarker, SessionMode, SessionSubject } from '@whereareyou/protocol';
import type { LiveRoomState } from './live-rooms.js';

/**
 * `live` is the room's durable state, persisted so a room recreated after
 * its last member leaves rehydrates instead of forgetting: a solo owner
 * flipping code screen ↔ live map momentarily empties the room, and the
 * zones/chat/events they come back to must still be there. Bounded by the
 * protocol caps (MAX_SESSION_ZONES / MAX_CHAT_HISTORY / MAX_EVENT_HISTORY).
 * `reachedMarkerIds` is every marker id a 'reached' has ever fired for, so
 * a rejoin does not re-fire it. `participants` is the last-known snapshots
 * of DISCONNECTED members, so "last connected" survives the room too.
 * INTERNAL ONLY: this field never appears in any REST response — chat
 * bodies, zone names and participant whereabouts are user content and the
 * resolve payload has no business carrying them.
 */
export type { LiveRoomState };

export interface StoredSession {
  code: string;
  position: Position;
  mode: SessionMode;
  subject: SessionSubject;
  note?: string;
  /** Opaque encoded sketch. Stored and returned verbatim, never parsed here. */
  sketch?: string;
  /**
   * LEGACY (pre-live-v2) single marked spot. Only records written before
   * `markers` existed carry these as stored truth; when `markers` is
   * present it is authoritative and these are ignored on read. New writes
   * set `markers` only — the legacy pair is recomputed as a mirror of
   * `markers[0]` at the response layer, never stored independently.
   */
  marker?: Position;
  markerIcon?: string;
  /** All placed markers, ≤ MAX_SESSION_MARKERS. `[]` means cleared. */
  markers?: SessionMarker[];
  /** Live-room durable state (see LiveRoomState). TTL follows the session. */
  live?: LiveRoomState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Hashed update token. Never stored or returned in plaintext. */
  updateTokenHash: string;
  /** Resolver identity that claimed this code, if any. */
  claimedBy?: string;
}

export interface SessionStore {
  create(session: StoredSession): Promise<void>;
  get(code: string): Promise<StoredSession | undefined>;
  update(code: string, patch: Partial<StoredSession>): Promise<boolean>;
  delete(code: string): Promise<boolean>;
  /**
   * Move the session's expiry to a new, later moment.
   *
   * The one sanctioned exception to "writes never extend the TTL": `update()`
   * keeps that rule so a live session cannot become immortal by moving, and
   * this method exists so the OWNER can deliberately buy more time. The caller
   * (the extend route) owns the caps; the store just applies the new expiry.
   */
  extend(code: string, expiresAt: number): Promise<boolean>;
  /** Remaining lifetime in milliseconds, or a negative number if the record is gone. */
  ttlMs(code: string): Promise<number>;
  /** Live session count. Used by /health to sanity-check the enumeration maths. */
  size(): Promise<number>;
}

/**
 * In-memory store for local development and tests.
 *
 * ⚠️ IMPORTANT — this does NOT yet deliver the "expiry is structural" property
 * the design claims. That claim rests on Redis native TTL, where the record
 * genuinely ceases to exist rather than being swept up. Here, expiry is enforced
 * on read plus a periodic sweep, which is *policy*-true only: the bytes linger
 * in the heap until the sweeper runs.
 *
 * Fine for a prototype you are clicking through. Not fine for any real
 * deployment, and not a claim to make to an emergency service. Ticket B2 swaps
 * this for the Redis implementation behind the same interface.
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(sweepIntervalMs = 30_000) {
    this.#sweeper = setInterval(() => this.#sweep(), sweepIntervalMs);
    // Do not hold the process open just to run the sweeper.
    this.#sweeper.unref?.();
  }

  #sweep(): void {
    const now = Date.now();
    for (const [code, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(code);
    }
  }

  async create(session: StoredSession): Promise<void> {
    this.#sessions.set(session.code, session);
  }

  async get(code: string): Promise<StoredSession | undefined> {
    const session = this.#sessions.get(code);
    if (session === undefined) return undefined;

    // Enforce expiry on read so a lagging sweep can never serve a stale record.
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(code);
      return undefined;
    }
    return session;
  }

  async update(code: string, patch: Partial<StoredSession>): Promise<boolean> {
    const session = await this.get(code);
    if (session === undefined) return false;
    this.#sessions.set(code, { ...session, ...patch });
    return true;
  }

  async delete(code: string): Promise<boolean> {
    return this.#sessions.delete(code);
  }

  async extend(code: string, expiresAt: number): Promise<boolean> {
    const session = await this.get(code);
    if (session === undefined) return false;
    this.#sessions.set(code, { ...session, expiresAt });
    return true;
  }

  async ttlMs(code: string): Promise<number> {
    const session = await this.get(code);
    // -2 mirrors Redis PTTL's "no such key", so callers can treat both stores alike.
    return session === undefined ? -2 : session.expiresAt - Date.now();
  }

  async size(): Promise<number> {
    this.#sweep();
    return this.#sessions.size;
  }

  stop(): void {
    clearInterval(this.#sweeper);
  }
}
