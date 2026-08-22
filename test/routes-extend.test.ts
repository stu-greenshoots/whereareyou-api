import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { LiveRooms, type LiveSocket } from '../src/live-rooms.js';
import { MemoryPushStore, PushService } from '../src/push.js';
import { registerRoutes } from '../src/routes.js';
import { MemorySessionStore } from '../src/store.js';

/**
 * POST /v1/sessions/:code/extend — the owner buys more time. What matters:
 * auth is exactly the owner-update shape (wrong token and missing session are
 * indistinguishable), the TTL bump is observable in the store, the per-call
 * and 24-hour caps hold, and an open live room hears about the new expiry.
 */

const POSITION = { lat: 51.5072, lon: -0.1276, accuracyM: 8, source: 'gnss' as const };

function makeConfig(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    resolverMode: 'apikey',
    apiKeys: new Map([['key-alpha', 'control-room-a']]),
    defaultTtlSeconds: 1800,
    minTtlSeconds: 60,
    maxTtlSeconds: 14400,
    corsOrigins: ['*'],
    redisUrl: undefined,
    rateLimit: { enabled: false, policy: undefined as never, trustProxy: false },
  };
}

class FakeSocket implements LiveSocket {
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m['type'] === type);
  }
}

const built: {
  app: FastifyInstance;
  store: MemorySessionStore;
  rooms: LiveRooms;
  push: PushService;
}[] = [];

function build() {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  const rooms = new LiveRooms();
  const push = new PushService(new MemoryPushStore(), {
    publicKey: 'test-public',
    privateKey: 'test-private',
  });
  registerRoutes(app, makeConfig(), store, { rooms, push });
  built.push({ app, store, rooms, push });
  return { app, store, rooms, push };
}

afterEach(async () => {
  for (const { app, store, rooms, push } of built.splice(0)) {
    await app.close();
    store.stop();
    rooms.stop();
    push.stop();
  }
});

async function mint(app: FastifyInstance, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION, ...extra },
  });
  return response.json() as { code: string; updateToken: string; expiresAt: string };
}

function extend(app: FastifyInstance, code: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/v1/sessions/${code}/extend`, payload });
}

describe('extend auth', () => {
  it('answers a wrong token and a missing session identically', async () => {
    const { app } = build();
    const { code } = await mint(app);

    const wrongToken = await extend(app, code, { updateToken: 'nope', addMinutes: 30 });
    expect(wrongToken.statusCode).toBe(404);

    // A checksum-valid code whose session is gone: mint one, revoke it, ask again.
    const dead = await mint(app);
    await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${dead.code}`,
      payload: { updateToken: dead.updateToken },
    });
    const missing = await extend(app, dead.code, { updateToken: dead.updateToken, addMinutes: 30 });
    expect(missing.statusCode).toBe(404);
    expect(wrongToken.body).toBe(missing.body);

    // And it must match the PATCH deny shape exactly.
    const patchDenied = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken: 'nope', position: POSITION },
    });
    expect(patchDenied.statusCode).toBe(404);
    expect(wrongToken.body).toBe(patchDenied.body);
  });

  it('rejects a missing token without revealing the session exists', async () => {
    const { app } = build();
    const { code } = await mint(app);
    const denied = await extend(app, code, { addMinutes: 30 });
    expect(denied.statusCode).toBe(404);
  });
});

describe('extend behaviour', () => {
  it('moves expiresAt forward by addMinutes, observably in the store', async () => {
    const { app, store } = build();
    const { code, updateToken, expiresAt } = await mint(app);
    const before = (await store.get(code))!;
    const ttlBefore = await store.ttlMs(code);

    const response = await extend(app, code, { updateToken, addMinutes: 30 });
    expect(response.statusCode).toBe(200);

    const expected = Date.parse(expiresAt) + 30 * 60_000;
    expect((response.json() as { expiresAt: string }).expiresAt).toBe(
      new Date(expected).toISOString(),
    );

    const after = (await store.get(code))!;
    expect(after.expiresAt).toBe(expected);
    expect(after.expiresAt - before.expiresAt).toBe(30 * 60_000);
    expect(await store.ttlMs(code)).toBeGreaterThan(ttlBefore);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['over the per-call cap', 181],
    ['fractional', 2.5],
    ['a string', '30'],
    ['missing', undefined],
  ])('refuses addMinutes that is %s', async (_label, addMinutes) => {
    const { app, store } = build();
    const { code, updateToken } = await mint(app);
    const before = (await store.get(code))!.expiresAt;

    const response = await extend(app, code, {
      updateToken,
      ...(addMinutes !== undefined ? { addMinutes } : {}),
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('invalid-extend');
    expect((await store.get(code))!.expiresAt).toBe(before); // untouched
  });

  it('accepts the per-call bounds themselves', async () => {
    const { app } = build();
    const { code, updateToken } = await mint(app);
    expect((await extend(app, code, { updateToken, addMinutes: 1 })).statusCode).toBe(200);
    expect((await extend(app, code, { updateToken, addMinutes: 180 })).statusCode).toBe(200);
  });

  it('never lets expiresAt pass 24h from creation, however many calls', async () => {
    const { app, store } = build();
    const { code, updateToken } = await mint(app);
    const { createdAt } = (await store.get(code))!;
    const cap = createdAt + 24 * 60 * 60 * 1000;

    // 10 × 180min = 30h of asking, on top of the 30min initial TTL.
    let last = '';
    for (let i = 0; i < 10; i++) {
      const response = await extend(app, code, { updateToken, addMinutes: 180 });
      expect(response.statusCode).toBe(200);
      last = (response.json() as { expiresAt: string }).expiresAt;
      expect(Date.parse(last)).toBeLessThanOrEqual(cap);
    }
    expect(Date.parse(last)).toBe(cap); // clamped exactly to the ceiling
    expect((await store.get(code))!.expiresAt).toBe(cap);

    // At the ceiling a further extend changes nothing, but still answers 200.
    const again = await extend(app, code, { updateToken, addMinutes: 60 });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { expiresAt: string }).expiresAt).toBe(new Date(cap).toISOString());
  });

  it('re-arms an open live room and broadcasts the new expiry frame', async () => {
    const { app, store, rooms } = build();
    const { code, updateToken } = await mint(app, { mode: 'live' });
    const session = (await store.get(code))!;

    const socket = new FakeSocket();
    const joined = rooms.join(code, socket, { owner: false, share: false, expiresAt: session.expiresAt });
    expect(joined).not.toBe('room-full');

    const response = await extend(app, code, { updateToken, addMinutes: 45 });
    expect(response.statusCode).toBe(200);
    const { expiresAt } = response.json() as { expiresAt: string };

    const frames = socket.ofType('expiry');
    expect(frames).toHaveLength(1);
    expect(frames[0]!['expiresAt']).toBe(expiresAt);
  });

  it('follows the session with the push subscription TTL and the T-5 warning', async () => {
    const { app, push } = build();
    const { code, updateToken } = await mint(app);

    const extendSubs = vi.spyOn(push, 'extendSubscriptions');
    const arm = vi.spyOn(push, 'armExpiryWarning');

    const response = await extend(app, code, { updateToken, addMinutes: 30 });
    const expiresAt = Date.parse((response.json() as { expiresAt: string }).expiresAt);

    expect(extendSubs).toHaveBeenCalledOnce();
    expect(extendSubs.mock.calls[0]![0]).toBe(code);
    // The push keys' new TTL is the session's new remaining lifetime.
    expect(extendSubs.mock.calls[0]![1]).toBeGreaterThan(expiresAt - Date.now() - 5_000);
    expect(arm).toHaveBeenCalledWith(code, expiresAt);
  });
});
