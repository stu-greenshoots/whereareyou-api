import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { generateCode } from '@whereareyou/protocol';
import type { Config } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { registerLive } from '../src/live-route.js';
import { LiveRooms } from '../src/live-rooms.js';
import { MemorySessionStore } from '../src/store.js';
import { makeSession, sleep } from './helpers.js';

/**
 * The live room end to end: real WebSockets against a listening app. What
 * matters, in order: the handshake tells the truth (welcome/refused), state
 * fans out to the people in the room, the OWNER's updates land in the store
 * (a plain resolve must never lie), a watcher's position is never honoured,
 * and expiry ends the room for everyone.
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

const built: { app: FastifyInstance; store: MemorySessionStore; clients: TestClient[] }[] = [];

async function build() {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  registerRoutes(app, makeConfig(), store);
  await registerLive(app, store, new LiveRooms());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const entry = { app, store, clients: [] as TestClient[] };
  built.push(entry);
  return {
    app,
    store,
    url: (code: string) => `ws://127.0.0.1:${address.port}/v1/sessions/${code}/live`,
    track: (client: TestClient) => entry.clients.push(client),
  };
}

afterEach(async () => {
  for (const { app, store, clients } of built.splice(0)) {
    for (const client of clients) client.dispose();
    await app.close();
    store.stop();
  }
});

/** A ws client with an awaitable message queue. */
class TestClient {
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<(message: Record<string, unknown>) => void> = [];
  closed = false;

  private constructor(readonly ws: WebSocket) {}

  static open(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
      ws.on('close', () => {
        client.closed = true;
      });
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        const waiter = client.waiters.shift();
        if (waiter !== undefined) waiter(message);
        else client.queue.push(message);
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /** Asserts silence — no frame arrives within the window. */
  async expectNothing(windowMs = 400): Promise<void> {
    await sleep(windowMs);
    expect(this.queue).toEqual([]);
  }

  dispose(): void {
    this.ws.terminate();
  }
}

async function mintLive(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION, mode: 'live' },
  });
  return response.json() as { code: string; updateToken: string };
}

async function joined(client: TestClient, hello: Record<string, unknown>) {
  client.send({ type: 'hello', share: true, ...hello });
  return client.next();
}

describe('live room handshake', () => {
  it('welcomes the owner with an empty roster, then hands joiners the truth', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    const welcome = await joined(owner, { code, updateToken, name: 'Stu' });
    expect(welcome).toMatchObject({ type: 'welcome', roster: [] });

    const friend = await TestClient.open(url(code));
    track(friend);
    const friendWelcome = await joined(friend, { code, name: 'Sam' });
    expect(friendWelcome['type']).toBe('welcome');
    expect(friendWelcome['roster']).toMatchObject([{ name: 'Stu', owner: true }]);

    // The owner hears about the arrival.
    const arrival = await owner.next();
    expect(arrival).toMatchObject({ type: 'participant', participant: { name: 'Sam', owner: false } });
  });

  it('refuses an unknown code, a static session, and a junk first frame', async () => {
    const { app, url, track } = await build();

    const stranger = await TestClient.open(url(generateCode()));
    track(stranger);
    const refusal = await joined(stranger, { code: generateCode() });
    expect(refusal).toMatchObject({ type: 'refused', reason: 'not-found' });

    const staticMint = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { position: POSITION },
    });
    const { code } = staticMint.json() as { code: string };
    const hopeful = await TestClient.open(url(code));
    track(hopeful);
    expect(await joined(hopeful, { code })).toMatchObject({ type: 'refused', reason: 'not-live' });

    const rude = await TestClient.open(url(code));
    track(rude);
    rude.send({ nonsense: true });
    expect(await rude.next()).toMatchObject({ type: 'refused', reason: 'bad-message' });
  });

  it('lets a static session be upgraded to live, and only then join', async () => {
    const { app, url, track } = await build();
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { position: POSITION },
    });
    const { code, updateToken } = minted.json() as { code: string; updateToken: string };

    // Position-only PATCH on a static session keeps refusing — regression guard.
    const stillStatic = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, position: POSITION },
    });
    expect(stillStatic.statusCode).toBe(409);

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, mode: 'live' },
    });
    expect(upgraded.statusCode).toBe(204);

    const owner = await TestClient.open(url(code));
    track(owner);
    expect((await joined(owner, { code, updateToken }))['type']).toBe('welcome');
  });
});

describe('live room state', () => {
  it("fans a sharer's position out, and keeps the joiner out of the store", async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await owner.next(); // Sam's arrival

    friend.send({ type: 'position', position: { lat: 51.6, lon: -0.2, accuracyM: 12 } });
    const update = await owner.next();
    expect(update).toMatchObject({
      type: 'participant',
      participant: { name: 'Sam', position: { lat: 51.6, lon: -0.2, accuracyM: 12 } },
    });

    // Nothing about a joiner ever touches the datastore.
    const stored = await store.get(code);
    expect(stored!.position.lat).toBe(POSITION.lat);
  });

  it("writes the owner's position and sketch through to the store", async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code });
    await owner.next(); // arrival

    owner.send({ type: 'position', position: { lat: 52.0, lon: -1.0, accuracyM: 6 } });
    await friend.next(); // the fan-out
    owner.send({ type: 'sketch', sketch: 'AQAA' });
    await friend.next();

    const stored = await store.get(code);
    expect(stored!.position.lat).toBe(52.0);
    expect(stored!.sketch).toBe('AQAA');
  });

  it('never honours a position from a watcher', async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });

    const watcher = await TestClient.open(url(code));
    track(watcher);
    watcher.send({ type: 'hello', code, share: false, name: 'Dispatcher' });
    await watcher.next(); // welcome
    await owner.next(); // arrival

    watcher.send({ type: 'position', position: { lat: 0, lon: 0, accuracyM: 5 } });
    await owner.expectNothing();
    const stored = await store.get(code);
    expect(stored!.position.lat).toBe(POSITION.lat);
  });

  it('ends the room when the session expires', async () => {
    const { url, store, track } = await build();
    // Directly stored with a fast expiry — the API's minimum TTL is 60s and
    // this test does not have a minute.
    // A REAL code — makeSession's TEST0001 fails the wire parser's checksum,
    // which is itself the system working: junk codes never reach the store.
    const session = makeSession({ code: generateCode(), mode: 'live', expiresAt: Date.now() + 500 });
    await store.create(session);

    const friend = await TestClient.open(url(session.code));
    track(friend);
    await joined(friend, { code: session.code });

    const ending = await friend.next(2000);
    expect(ending).toMatchObject({ type: 'expired' });
    await sleep(100);
    expect(friend.closed).toBe(true);
  });
});
