import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCode } from '@whereareyou/protocol';
import type { Config } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { registerLive } from '../src/live-route.js';
import { LiveRooms } from '../src/live-rooms.js';
import { MemoryPushStore, PushService } from '../src/push.js';
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

const built: {
  app: FastifyInstance;
  store: MemorySessionStore;
  clients: TestClient[];
  push?: PushService;
}[] = [];

async function build(
  push?: PushService,
  options?: { pingIntervalMs?: number; pushThrottleWindowMs?: number },
) {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  // One LiveRooms shared by the REST routes and the socket route, as in
  // production — revoke and extend must reach the same rooms the sockets use.
  const rooms = new LiveRooms();
  registerRoutes(app, makeConfig(), store, { rooms });
  await registerLive(app, store, rooms, push, options);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const entry = { app, store, clients: [] as TestClient[], ...(push !== undefined ? { push } : {}) };
  built.push(entry);
  return {
    app,
    store,
    rooms,
    url: (code: string) => `ws://127.0.0.1:${address.port}/v1/sessions/${code}/live`,
    track: (client: TestClient) => entry.clients.push(client),
  };
}

afterEach(async () => {
  for (const { app, store, clients, push } of built.splice(0)) {
    for (const client of clients) client.dispose();
    await app.close();
    store.stop();
    push?.stop();
  }
});

/** A ws client with an awaitable message queue. */
class TestClient {
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<(message: Record<string, unknown>) => void> = [];
  closed = false;

  private constructor(readonly ws: WebSocket) {}

  static open(url: string, options?: { autoPong?: boolean }): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { autoPong: options?.autoPong ?? true });
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

  it('lets a joiner go dark and come back — still in the roster, off the map', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await owner.next(); // Sam's arrival

    friend.send({ type: 'position', position: { lat: 51.6, lon: -0.2, accuracyM: 12 } });
    expect(await owner.next()).toMatchObject({ participant: { name: 'Sam', position: { lat: 51.6 } } });

    friend.send({ type: 'share', share: false });
    const dark = (await owner.next())['participant'] as Record<string, unknown>;
    // Present, not sharing — and emphatically not a ghost: a dropped socket
    // stamps disconnectedAt and KEEPS the position, which is the opposite
    // shape and means something else entirely.
    expect(dark).toMatchObject({ name: 'Sam' });
    expect(dark).not.toHaveProperty('position');
    expect(dark).not.toHaveProperty('disconnectedAt');

    // Past the per-type floor, so nothing here is merely deferred.
    await sleep(1100);
    friend.send({ type: 'position', position: { lat: 51.7, lon: -0.3, accuracyM: 9 } });
    await owner.expectNothing();

    await sleep(1100);
    friend.send({ type: 'share', share: true });
    await owner.next(); // the resume fanout
    await sleep(1100);
    friend.send({ type: 'position', position: { lat: 51.8, lon: -0.4, accuracyM: 7 } });
    expect(await owner.next()).toMatchObject({ participant: { name: 'Sam', position: { lat: 51.8 } } });
  });

  it('lets the OWNER run the session while broadcasting nothing', async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await owner.next(); // arrival

    owner.send({ type: 'position', position: { lat: 52.0, lon: -1.0, accuracyM: 6 } });
    await friend.next();

    owner.send({ type: 'share', share: false });
    const dark = (await friend.next())['participant'] as Record<string, unknown>;
    expect(dark).toMatchObject({ name: 'Stu', owner: true });
    expect(dark).not.toHaveProperty('position');

    await sleep(1100);
    owner.send({ type: 'position', position: { lat: 53.0, lon: -2.0, accuracyM: 6 } });
    await friend.expectNothing();

    // Stated plainly: the record keeps the owner's LAST honoured fix. Going
    // dark stops the write-through; it does not rewrite what the code
    // already resolves to, and the record has no field for "not sharing".
    const stored = await store.get(code);
    expect(stored!.position.lat).toBe(52.0);

    // A joiner arriving now is welcomed to a roster with a positionless owner.
    const late = await TestClient.open(url(code));
    track(late);
    const welcome = await joined(late, { code, name: 'Late' });
    const rostered = (welcome['roster'] as Array<Record<string, unknown>>).find(
      (entry) => entry['owner'] === true,
    )!;
    expect(rostered).not.toHaveProperty('position');
    expect(rostered).not.toHaveProperty('trail');
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

  it('ends the room when the owner revokes the session — no zombie relay', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code });
    await owner.next(); // arrival

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${code}`,
      payload: { updateToken },
    });
    expect(response.statusCode).toBe(204);

    // Everyone still connected is told plainly, then hung up on — "Stop
    // sharing" must actually stop the room, not leave it relaying positions
    // until the original expiry timer fires.
    expect(await friend.next()).toMatchObject({ type: 'expired' });
    expect(await owner.next()).toMatchObject({ type: 'expired' });
    await sleep(100);
    expect(friend.closed).toBe(true);
    expect(owner.closed).toBe(true);
  });
});

describe('live v2 over the wire', () => {
  const AVATAR = 'data:image/png;base64,AAAA';

  it('carries a typed avatar through hello, and drops junk without costing the join', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, avatar: AVATAR });

    const friend = await TestClient.open(url(code));
    track(friend);
    // The avatar arrives in the roster via the protocol types — the raw-frame
    // re-parse seam is gone, so this is the parser's own field or nothing.
    const welcome = await joined(friend, { code, name: 'Sam', avatar: 'javascript:alert(1)' });
    expect(welcome['roster']).toMatchObject([{ owner: true, avatar: AVATAR }]);

    // Junk avatar: dropped silently, join intact, nothing fanned out.
    const arrival = await owner.next();
    const sam = arrival['participant'] as Record<string, unknown>;
    expect(sam['name']).toBe('Sam');
    expect('avatar' in sam).toBe(false);
  });

  it('welcomes a late joiner with retained chat, zones, events and a rich roster', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    owner.send({ type: 'chat', text: 'by the weir' });
    const chatEcho = await owner.next(); // chat fans back to the sender too
    expect(chatEcho).toMatchObject({ type: 'chat', text: 'by the weir' });
    owner.send({
      type: 'zone-create',
      id: 'z1',
      name: 'weir pool',
      center: { lat: 51.5, lon: -0.1, accuracyM: 5 },
      radiusM: 250,
    });
    expect(await owner.next()).toMatchObject({ type: 'zone-created', zone: { id: 'z1' } });
    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: { lat: 51.501, lon: -0.1, accuracyM: 5 }, icon: 'tent' }],
    });
    await owner.next(); // own participant echo

    const friend = await TestClient.open(url(code));
    track(friend);
    const welcome = await joined(friend, { code });
    expect(welcome['chat']).toMatchObject([{ text: 'by the weir' }]);
    expect(welcome['zones']).toMatchObject([{ id: 'z1', name: 'weir pool', radiusM: 250 }]);
    expect(welcome['events']).toEqual([]);
    const roster = welcome['roster'] as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      name: 'Stu',
      owner: true,
      markers: [{ id: 'm1', icon: 'tent' }],
      // The mirror rule holds in the roster too.
      markerIcon: 'tent',
    });
    expect(typeof roster[0]!['joinedAt']).toBe('string');
    expect(typeof roster[0]!['lastSeenAt']).toBe('string');
  });

  it("persists the owner's marker list to the record, and [] clears it — joiners never touch it", async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code });
    await owner.next(); // arrival

    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: { lat: 51.51, lon: -0.13, accuracyM: 5 }, icon: 'water' }],
    });
    await friend.next(); // fanout
    expect((await store.get(code))!.markers).toMatchObject([{ id: 'm1', icon: 'water' }]);

    // A joiner's markers reach the room, never the datastore.
    friend.send({
      type: 'markers',
      markers: [{ id: 'theirs', position: { lat: 51.52, lon: -0.13, accuracyM: 5 }, icon: 'flag' }],
    });
    await owner.next(); // fanout
    expect((await store.get(code))!.markers).toMatchObject([{ id: 'm1', icon: 'water' }]);

    // The legacy clear empties the stored list too, now the record holds a list.
    owner.send({ type: 'marker', position: null });
    await friend.next(); // fanout
    expect((await store.get(code))!.markers).toEqual([]);
  });

  it('delivers the newest frame of a floored state burst once the window reopens', async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code });
    await owner.next(); // arrival

    // The web UI commits markers twice in one gesture — icon pick, then Done
    // (which carries the name) — so the second frame lands inside the floor
    // window. First-frame-wins flooring would strand the room on the unnamed
    // marker forever; the trailing flush must converge on the newest frame.
    const spot = { lat: 51.51, lon: -0.13, accuracyM: 5 };
    owner.send({ type: 'markers', markers: [{ id: 'm1', position: spot, icon: 'water' }] });
    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: spot, icon: 'water', name: 'Fountain' }],
    });

    // The first frame fans out unnamed…
    const first = (await friend.next()) as {
      participant: { markers: Array<Record<string, unknown>> };
    };
    expect(first.participant.markers[0]).not.toHaveProperty('name');
    // …and the floored second applies trailing-edge, without a resend.
    expect(await friend.next()).toMatchObject({
      type: 'participant',
      participant: { markers: [{ id: 'm1', name: 'Fountain' }] },
    });
    expect((await store.get(code))!.markers).toMatchObject([{ id: 'm1', name: 'Fountain' }]);

    // Latest wins inside a burst: of two floored edits, only the second lands.
    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: spot, icon: 'water', name: 'Old fountain' }],
    });
    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: spot, icon: 'water', name: 'Trafalgar fountain' }],
    });
    expect(await friend.next()).toMatchObject({
      type: 'participant',
      participant: { markers: [{ id: 'm1', name: 'Trafalgar fountain' }] },
    });
    await friend.expectNothing(1200); // the superseded edit never surfaces

    // Event-shaped frames stay drop-only: a floored chat is not replayed late.
    owner.send({ type: 'chat', text: 'first' });
    owner.send({ type: 'chat', text: 'second' });
    expect(await friend.next()).toMatchObject({ type: 'chat', text: 'first' });
    await friend.expectNothing(1200);
  }, 10_000);
});

describe('push triggers', () => {
  function buildPush() {
    const push = new PushService(new MemoryPushStore());
    const spy = vi.spyOn(push, 'sendToSession').mockResolvedValue();
    const payloads = () =>
      spy.mock.calls.map((call) => call[1] as { title: string; body: string; url?: string });
    return { push, spy, payloads };
  }

  it("pushes rich deep-linked payloads on a join and a chat — never on the owner's own hello, once per kind per window", async () => {
    const { push, spy, payloads } = buildPush();
    const { app, url, track } = await build(push);
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });
    expect(spy).not.toHaveBeenCalled(); // your own arrival is not news

    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await owner.next(); // arrival
    expect(payloads()).toEqual([
      { title: 'whereareyou', body: 'Sam joined your share', url: `lookup?code=${code}#people` },
    ]);

    // A second joiner inside the window is throttled into silence.
    const another = await TestClient.open(url(code));
    track(another);
    await joined(another, { code });
    await owner.next();
    expect(spy).toHaveBeenCalledTimes(1);

    friend.send({ type: 'chat', text: 'up by the bridge' });
    await owner.next(); // the chat fanout
    expect(payloads().at(-1)).toEqual({
      title: 'whereareyou',
      body: 'Sam: up by the bridge',
      url: `lookup?code=${code}#chat`,
    });

    // Payloads are E2E-encrypted (RFC 8291), so names and snippets may
    // travel — precise coordinates still never do, as defence-in-depth.
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('51.5');
    }
  });

  it('keeps the generic bodies for nameless actors, deep links intact', async () => {
    const { push, payloads } = buildPush();
    const { app, url, track } = await build(push);
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken }); // anonymous owner

    owner.send({
      type: 'zone-create',
      id: 'z1',
      name: 'weir pool',
      center: { lat: 51.5, lon: -0.1, accuracyM: 5 },
      radiusM: 250,
    });
    await owner.next(); // zone-created echo

    // First fix is the silent occupancy baseline — start outside so the
    // walk in is an OBSERVED transition, per the quiet-reconnect rule.
    owner.send({ type: 'position', position: { lat: 52.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant echo — the baseline says nothing
    await sleep(1100); // past the per-type message floor
    owner.send({ type: 'position', position: { lat: 51.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant echo — one inside fix is not an event
    await sleep(1100);
    owner.send({ type: 'position', position: { lat: 51.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant echo
    expect(await owner.next()).toMatchObject({ type: 'event', kind: 'entered', zoneId: 'z1' });

    // A nameless actor keeps the generic body — so the zone name stays out
    // of this payload too; the deep link still lands on the activity panel.
    expect(payloads().at(-1)).toEqual({
      title: 'whereareyou',
      body: 'Activity on your share.',
      url: `lookup?code=${code}#activity`,
    });

    owner.send({ type: 'chat', text: 'still here' });
    await owner.next(); // the chat fanout
    expect(payloads().at(-1)).toEqual({
      title: 'whereareyou',
      body: 'New message on your share.',
      url: `lookup?code=${code}#chat`,
    });
  }, 10_000);

  it('names the detection push after its actor and zone, with the activity deep link', async () => {
    const { push, payloads } = buildPush();
    const { app, url, track } = await build(push);
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken });

    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await owner.next(); // arrival

    owner.send({
      type: 'zone-create',
      id: 'z1',
      name: 'weir pool',
      center: { lat: 51.5, lon: -0.1, accuracyM: 5 },
      radiusM: 250,
    });
    await owner.next(); // zone-created echo

    // First fix is the silent occupancy baseline — start outside so the
    // walk in is an OBSERVED transition, per the quiet-reconnect rule.
    friend.send({ type: 'position', position: { lat: 52.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant fanout — the baseline says nothing
    await sleep(1100); // past the per-type message floor
    friend.send({ type: 'position', position: { lat: 51.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant fanout — one inside fix is not an event
    await sleep(1100);
    friend.send({ type: 'position', position: { lat: 51.5, lon: -0.1, accuracyM: 5 } });
    await owner.next(); // participant fanout
    expect(await owner.next()).toMatchObject({
      type: 'event',
      kind: 'entered',
      name: 'Sam',
      targetName: 'weir pool',
    });

    expect(payloads().at(-1)).toEqual({
      title: 'whereareyou',
      body: 'Sam entered weir pool',
      url: `lookup?code=${code}#activity`,
    });
  }, 10_000);

  it('truncates the chat snippet at 100 chars with an ellipsis', async () => {
    const { push, payloads } = buildPush();
    const { app, url, track } = await build(push);
    const { code, updateToken } = await mintLive(app);
    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    owner.send({ type: 'chat', text: 'x'.repeat(300) });
    await owner.next(); // the fanout echo
    expect(payloads().at(-1)).toEqual({
      title: 'whereareyou',
      body: `Stu: ${'x'.repeat(100)}…`,
      url: `lookup?code=${code}#chat`,
    });
  });
});

describe('one owner per room — supersession and the zombie reaper', () => {
  it('a second owner connection supersedes the first: kicked, told, gone from rosters', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const stale = await TestClient.open(url(code));
    track(stale);
    const staleWelcome = await joined(stale, { code, updateToken, name: 'Stu' });
    const staleId = (staleWelcome as { participantId: string }).participantId;

    const friend = await TestClient.open(url(code));
    track(friend);
    await joined(friend, { code, name: 'Sam' });
    await stale.next(); // Sam's arrival — a watcher joining kicks nobody

    // The same person again — the live map's socket while the code screen's
    // headless one is still up (or a zombie of it). Field-observed duplicate.
    const fresh = await TestClient.open(url(code));
    track(fresh);
    const freshWelcome = await joined(fresh, { code, updateToken, name: 'Stu' });

    // The newcomer's roster holds Sam and NO previous owner.
    expect(freshWelcome['roster']).toMatchObject([{ name: 'Sam', owner: false }]);

    // Sam sees the stale owner leave, then the fresh one arrive.
    expect(await friend.next()).toMatchObject({ type: 'left', participantId: staleId });
    expect(await friend.next()).toMatchObject({
      type: 'participant',
      participant: { name: 'Stu', owner: true },
    });

    // The stale connection is hung up on.
    await vi.waitFor(() => expect(stale.closed).toBe(true));
  });

  it('a watcher rejoining does not supersede anyone', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    const sam = await TestClient.open(url(code));
    track(sam);
    await joined(sam, { code, name: 'Sam' });
    await owner.next();

    const samAgain = await TestClient.open(url(code));
    track(samAgain);
    const welcome = await joined(samAgain, { code, name: 'Sam' });
    // No identity on the watcher wire, so both Sams stand — the honest POC
    // posture (superseding same-name joins would let anyone kick anyone).
    expect((welcome['roster'] as unknown[]).length).toBe(2);
    expect(sam.closed).toBe(false);
  });

  it('reaps a member that stops answering pings — retained as disconnected, never a left', async () => {
    const { app, url, track } = await build(undefined, { pingIntervalMs: 150 });
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    // A phone whose radio died without a TCP close: the socket answers
    // nothing, but never says goodbye either. This is EXACTLY the field
    // case the retention model is for — the companion whose connection
    // drops must not simply vanish from the share.
    const zombie = await TestClient.open(url(code), { autoPong: false });
    track(zombie);
    const zombieWelcome = await joined(zombie, { code, name: 'Ghost' });
    const zombieId = (zombieWelcome as { participantId: string }).participantId;
    await owner.next(); // the ghost's arrival

    // Two ping rounds later the server terminates the SOCKET — and the
    // roster keeps the member, stamped, as a participant update.
    expect(await owner.next(3000)).toMatchObject({
      type: 'participant',
      participant: { id: zombieId, name: 'Ghost', disconnectedAt: expect.any(String) },
    });
    await vi.waitFor(() => expect(zombie.closed).toBe(true));
  });
});

describe('room state survives the room — persistence and rehydration', () => {
  it('zones, chat and events outlive the last member leaving, and reached does not re-fire', async () => {
    const { app, url, store, rooms, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    // A zone (away from the marker so it stays out of the story), a chat
    // line, a marker, and an arrival at it.
    owner.send({
      type: 'zone-create',
      id: 'z1',
      name: 'weir',
      center: { lat: 52.9, lon: -1.9, accuracyM: 5 },
      radiusM: 100,
    });
    expect(await owner.next()).toMatchObject({ type: 'zone-created', zone: { id: 'z1' } });

    owner.send({ type: 'chat', text: 'on my way' });
    expect(await owner.next()).toMatchObject({ type: 'chat', text: 'on my way' });

    owner.send({
      type: 'markers',
      markers: [{ id: 'm1', position: POSITION, icon: 'flag', name: 'meet here' }],
    });
    await owner.next(); // own fanout

    // Two consecutive fixes at the marker (the enter rule), spaced past the
    // per-type floor, and 'reached' fires.
    owner.send({ type: 'position', position: POSITION });
    await owner.next(); // own participant fanout
    await sleep(1100);
    owner.send({ type: 'position', position: POSITION });
    await owner.next(); // own participant fanout
    expect(await owner.next()).toMatchObject({ type: 'event', kind: 'reached', markerId: 'm1' });

    // The durable state lands on the session record.
    await vi.waitFor(async () => {
      const live = (await store.get(code))!.live;
      expect(live?.zones).toMatchObject([{ id: 'z1', name: 'weir' }]);
      expect(live?.chat).toMatchObject([{ text: 'on my way' }]);
      expect(live?.events).toMatchObject([{ kind: 'reached', markerId: 'm1' }]);
      expect(live?.reachedMarkerIds).toContain('m1');
    });

    // Last member leaves; the room is truly gone from memory.
    owner.ws.close();
    await vi.waitFor(() => expect(rooms.size(code)).toBe(0));

    // The rejoin — the code screen ↔ live map churn — comes back remembering.
    const again = await TestClient.open(url(code));
    track(again);
    const welcome = await joined(again, { code, updateToken, name: 'Stu' });
    expect(welcome['zones']).toMatchObject([{ id: 'z1', name: 'weir' }]);
    expect(welcome['chat']).toMatchObject([{ text: 'on my way' }]);
    expect(welcome['events']).toMatchObject([{ kind: 'reached', markerId: 'm1' }]);

    // The web replays markers on rejoin; standing at the spot again must
    // not re-fire the arrival (or the push behind it).
    again.send({
      type: 'markers',
      markers: [{ id: 'm1', position: POSITION, icon: 'flag', name: 'meet here' }],
    });
    await again.next(); // own fanout
    again.send({ type: 'position', position: POSITION });
    await again.next(); // own participant fanout
    await sleep(1100);
    again.send({ type: 'position', position: POSITION });
    await again.next(); // own participant fanout
    await sleep(400); // room for a wrong 'event' frame to arrive
    // Nothing but our own fanouts — drain and prove no event landed.
    while (true) {
      let frame: Record<string, unknown>;
      try {
        frame = await again.next(200);
      } catch {
        break;
      }
      expect(frame['type']).not.toBe('event');
    }
  }, 20_000);

  it('a room already in memory ignores hydration — live state is the truth', async () => {
    const { app, url, store, track } = await build();
    const { code, updateToken } = await mintLive(app);

    // A stale persisted blob (as if from before a deploy) …
    await store.update(code, {
      live: { zones: [], chat: [{ id: 'x', participantId: 'gone', text: 'old', at: new Date().toISOString() }], events: [], reachedMarkerIds: [], seenIdentities: [], participants: [] },
    });

    const owner = await TestClient.open(url(code));
    track(owner);
    const welcome = await joined(owner, { code, updateToken });
    // … hydrates the recreated room,
    expect(welcome['chat']).toMatchObject([{ text: 'old' }]);

    // but a SECOND joiner gets the in-memory room, not a re-read.
    owner.send({ type: 'chat', text: 'new' });
    await owner.next();
    const friend = await TestClient.open(url(code));
    track(friend);
    const friendWelcome = await joined(friend, { code });
    expect(friendWelcome['chat']).toMatchObject([{ text: 'old' }, { text: 'new' }]);
  });
});

describe('quiet reconnects — join-once announcements and the silent baseline', () => {
  function buildPush() {
    const push = new PushService(new MemoryPushStore());
    const spy = vi.spyOn(push, 'sendToSession').mockResolvedValue();
    const payloads = () =>
      spy.mock.calls.map((call) => call[1] as { title: string; body: string; url?: string });
    return { push, payloads };
  }

  it("announces an identity once per session, however often it reconnects", async () => {
    const { push, payloads } = buildPush();
    // Throttle disarmed (zero window): what this test proves must be the
    // seen-identities gate, not the push throttle riding to the rescue.
    const { app, url, store, rooms, track } = await build(push, { pushThrottleWindowMs: 0 });
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    const joinedBodies = () => payloads().filter((p) => p.body.includes('joined')).map((p) => p.body);

    // Sam churns: join, drop, rejoin, three times over — one announcement.
    // Each drop RETAINS Sam as a disconnected entry (a participant update,
    // never a left); each rejoin merges the old entry away with a genuine
    // left before the fresh arrival fans out.
    for (let round = 0; round < 3; round += 1) {
      const sam = await TestClient.open(url(code));
      track(sam);
      await joined(sam, { code, name: 'Sam' });
      if (round > 0) expect(await owner.next()).toMatchObject({ type: 'left' }); // the merged ghost
      expect(await owner.next()).toMatchObject({ type: 'participant' }); // the arrival
      sam.ws.close();
      expect(await owner.next()).toMatchObject({
        type: 'participant',
        participant: { name: 'Sam', disconnectedAt: expect.any(String) },
      });
    }
    expect(joinedBodies()).toEqual(['Sam joined your share']);

    // A genuinely new person is still news.
    const pat = await TestClient.open(url(code));
    track(pat);
    await joined(pat, { code, name: 'Pat' });
    await owner.next();
    expect(joinedBodies()).toEqual(['Sam joined your share', 'Pat joined your share']);

    // Anonymous hellos share one conservative key: announced once, ever.
    const anons: TestClient[] = [];
    for (let round = 0; round < 2; round += 1) {
      const anon = await TestClient.open(url(code));
      track(anon);
      anons.push(anon);
      await joined(anon, { code });
      await owner.next();
    }
    expect(joinedBodies()).toEqual([
      'Sam joined your share',
      'Pat joined your share',
      'Someone joined your share.',
    ]);

    // The set survives the room itself: everyone out, room gone, rejoin —
    // Sam is still not news.
    for (const client of [owner, pat, ...anons]) client.ws.close();
    await vi.waitFor(() => expect(rooms.size(code)).toBe(0));
    await vi.waitFor(async () => {
      expect((await store.get(code))!.live?.seenIdentities).toContain('n:Sam');
    });
    const ownerBack = await TestClient.open(url(code));
    track(ownerBack);
    await joined(ownerBack, { code, updateToken, name: 'Stu' });
    const samBack = await TestClient.open(url(code));
    track(samBack);
    await joined(samBack, { code, name: 'Sam' });
    await ownerBack.next();
    expect(joinedBodies()).toHaveLength(3);
  }, 15_000);

  it('seeds zone occupancy silently on rejoin; only real crossings speak', async () => {
    const { app, url, track } = await build();
    const { code, updateToken } = await mintLive(app);
    const inside = POSITION;
    const outside = { lat: 52.5, lon: -0.1276, accuracyM: 8, source: 'gnss' as const };

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });
    owner.send({
      type: 'zone-create',
      id: 'z1',
      name: 'weir',
      center: { lat: inside.lat, lon: inside.lon, accuracyM: 5 },
      radiusM: 100,
    });
    await owner.next(); // create echo

    // Sam starts outside (the silent baseline) and walks in: one 'entered'.
    let sam = await TestClient.open(url(code));
    track(sam);
    await joined(sam, { code, name: 'Sam' });
    await owner.next(); // arrival
    sam.send({ type: 'position', position: outside });
    await owner.next(); // participant fanout — baseline, silent
    await sleep(1100);
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant fanout — one inside fix is not an event
    await sleep(1100);
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant fanout
    expect(await owner.next()).toMatchObject({ type: 'event', kind: 'entered', zoneId: 'z1' });
    sam.ws.close();
    expect(await owner.next()).toMatchObject({
      type: 'participant',
      participant: { name: 'Sam', disconnectedAt: expect.any(String) },
    });

    // Sam reconnects, still inside: the old entry merges away (a genuine
    // left) and the fresh member's baseline seeds occupancy silently.
    sam = await TestClient.open(url(code));
    track(sam);
    await joined(sam, { code, name: 'Sam' });
    expect(await owner.next()).toMatchObject({ type: 'left' }); // the merged ghost
    await owner.next(); // arrival fanout
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant
    await sleep(1100);
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant
    await owner.expectNothing(600); // NO re-fired 'entered'

    // A real crossing after the rejoin still speaks — once each way.
    await sleep(1100);
    sam.send({ type: 'position', position: outside });
    await owner.next(); // participant
    expect(await owner.next()).toMatchObject({ type: 'event', kind: 'left', zoneId: 'z1' });
    await sleep(1100);
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant
    await sleep(1100);
    sam.send({ type: 'position', position: inside });
    await owner.next(); // participant
    expect(await owner.next()).toMatchObject({ type: 'event', kind: 'entered', zoneId: 'z1' });
  }, 25_000);
});

describe('disconnecting is not leaving — over the wire', () => {
  it('keeps the dropped companion on the map, and their quiet merge on return', async () => {
    const push = new PushService(new MemoryPushStore());
    const spy = vi.spyOn(push, 'sendToSession').mockResolvedValue();
    // Throttle disarmed: the no-push assertions below must be the model's
    // own silence, not the throttle riding to the rescue.
    const { app, url, store, track } = await build(push, { pushThrottleWindowMs: 0 });
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });

    const friend = await TestClient.open(url(code));
    track(friend);
    const friendWelcome = await joined(friend, { code, name: 'Sam' });
    const friendId = (friendWelcome as { participantId: string }).participantId;
    await owner.next(); // arrival

    friend.send({ type: 'position', position: { lat: 51.6, lon: -0.2, accuracyM: 12 } });
    await owner.next(); // fanout

    // The companion's phone drops. Not a left: a participant update with
    // the stamp, their last position still aboard.
    friend.ws.close();
    expect(await owner.next()).toMatchObject({
      type: 'participant',
      participant: {
        id: friendId,
        name: 'Sam',
        position: { lat: 51.6, lon: -0.2 },
        disconnectedAt: expect.any(String),
      },
    });

    // Someone joining NOW is welcomed by the ghost too.
    const watcher = await TestClient.open(url(code));
    track(watcher);
    const watcherWelcome = await joined(watcher, { code });
    await owner.next(); // the watcher's arrival
    expect(watcherWelcome['roster']).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ id: friendId, name: 'Sam', disconnectedAt: expect.any(String) }),
      ]),
    );

    // The snapshot lands in the persisted blob — whereabouts, never trails.
    await vi.waitFor(async () => {
      const live = (await store.get(code))!.live;
      expect(live?.participants).toMatchObject([{ id: friendId, name: 'Sam' }]);
    });

    // Sam returns under the same name: the ghost merges away with a
    // genuine left, and the fresh Sam stands alone, connected.
    const before = spy.mock.calls.length;
    const back = await TestClient.open(url(code));
    track(back);
    const backWelcome = await joined(back, { code, name: 'Sam' });
    expect(
      (backWelcome['roster'] as Array<Record<string, unknown>>).filter(
        (entry) => entry['name'] === 'Sam',
      ),
    ).toEqual([]);
    expect(await owner.next()).toMatchObject({ type: 'left', participantId: friendId });
    const rejoined = (await owner.next()) as { participant: Record<string, unknown> };
    expect(rejoined.participant).toMatchObject({ name: 'Sam' });
    expect('disconnectedAt' in rejoined.participant).toBe(false);

    // No push fired for the disconnect, none for the merge-reconnect —
    // the join-once identity gate holds (throttle disarmed above).
    expect(spy.mock.calls.length).toBe(before);
  }, 15_000);

  it('a recreated room greets the next joiner with the disconnected roster', async () => {
    const { app, url, store, rooms, track } = await build();
    const { code, updateToken } = await mintLive(app);

    const owner = await TestClient.open(url(code));
    track(owner);
    await joined(owner, { code, updateToken, name: 'Stu' });
    const friend = await TestClient.open(url(code));
    track(friend);
    const friendWelcome = await joined(friend, { code, name: 'Sam' });
    const friendId = (friendWelcome as { participantId: string }).participantId;
    await owner.next(); // arrival
    friend.send({ type: 'position', position: { lat: 51.6, lon: -0.2, accuracyM: 12 } });
    await owner.next(); // fanout

    // Sam drops, then the owner does: the last live connection takes the
    // room from memory with it. The blob is all that remains.
    friend.ws.close();
    await owner.next(); // the disconnect stamp
    owner.ws.close();
    await vi.waitFor(() => expect(rooms.size(code)).toBe(0));
    await vi.waitFor(async () => {
      expect((await store.get(code))!.live?.participants ?? []).toHaveLength(2);
    });

    // The next joiner is greeted by both of them — greyed, in place.
    const watcher = await TestClient.open(url(code));
    track(watcher);
    const welcome = await joined(watcher, { code });
    const roster = welcome['roster'] as Array<Record<string, unknown>>;
    expect(roster.map((entry) => entry['name']).sort()).toEqual(['Sam', 'Stu']);
    for (const entry of roster) expect(entry['disconnectedAt']).toEqual(expect.any(String));
    const sam = roster.find((entry) => entry['name'] === 'Sam')!;
    expect(sam['id']).toBe(friendId);
    expect(sam['position']).toMatchObject({ lat: 51.6, lon: -0.2 });

    // The owner's return supersedes their own rehydrated ghost — one left,
    // one Stu — while Sam's ghost stands.
    const ownerBack = await TestClient.open(url(code));
    track(ownerBack);
    const backWelcome = await joined(ownerBack, { code, updateToken, name: 'Stu' });
    expect(await watcher.next()).toMatchObject({ type: 'left' });
    expect(await watcher.next()).toMatchObject({
      type: 'participant',
      participant: { name: 'Stu', owner: true },
    });
    const backRoster = backWelcome['roster'] as Array<Record<string, unknown>>;
    expect(backRoster.filter((entry) => entry['name'] === 'Stu')).toEqual([]);
    expect(backRoster.filter((entry) => entry['name'] === 'Sam')).toHaveLength(1);
  }, 15_000);
});
