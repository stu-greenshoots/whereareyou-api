import { execFileSync } from 'node:child_process';
import type { StoredSession } from '../src/store.js';

export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask Redis a question through `redis-cli`, entirely outside the application's
 * own client.
 *
 * This matters for the expiry tests. If the only evidence that a key is gone
 * came from the same ioredis connection that wrote it, the test would be
 * partly checking our own code's honesty. Shelling out to `redis-cli` makes the
 * check independent: it is the datastore itself reporting on the key.
 */
export function redisCli(...args: string[]): string {
  return execFileSync('redis-cli', ['-u', TEST_REDIS_URL, ...args], {
    encoding: 'utf8',
  }).trim();
}

export function redisAvailable(): boolean {
  try {
    return redisCli('PING') === 'PONG';
  } catch {
    return false;
  }
}

let counter = 0;

/** A syntactically plausible, unique-per-test session record. */
export function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  counter += 1;
  return {
    code: `TEST${String(counter).padStart(4, '0')}`,
    position: { lat: 51.5072, lon: -0.1276, accuracyM: 8, source: 'gnss', takenAt: new Date(now).toISOString() },
    mode: 'static',
    subject: 'self',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    updateTokenHash: 'a'.repeat(64),
    ...overrides,
  };
}
