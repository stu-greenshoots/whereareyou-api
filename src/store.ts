import type { Position, SessionMode, SessionSubject } from '@whereareyou/protocol';

export interface StoredSession {
  code: string;
  position: Position;
  mode: SessionMode;
  subject: SessionSubject;
  note?: string;
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

  async size(): Promise<number> {
    this.#sweep();
    return this.#sessions.size;
  }

  stop(): void {
    clearInterval(this.#sweeper);
  }
}
