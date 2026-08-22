import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { registerPushRoutes } from '../src/push-routes.js';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  MemoryPushStore,
  PushService,
  type PushSubscriptionRecord,
  type WebPushLike,
} from '../src/push.js';
import { registerRoutes } from '../src/routes.js';
import { MemorySessionStore } from '../src/store.js';

/**
 * The push endpoints through the actual routes: the public VAPID key handed
 * out unauthenticated (the share screen calls it exactly as it PATCHes its
 * session), subscriptions validated and capped, unknown codes answered with
 * the standard indistinguishable 404, and a dispatcher resolve firing the
 * generic lookup notification.
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

class FakeSender implements WebPushLike {
  sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  generateVAPIDKeys() {
    return { publicKey: 'generated-pub', privateKey: 'generated-priv' };
  }
  async sendNotification(subscription: PushSubscriptionRecord, payload: string): Promise<unknown> {
    this.sent.push({
      endpoint: subscription.endpoint,
      payload: JSON.parse(payload) as Record<string, unknown>,
    });
    return {};
  }
}

function subscription(n: number) {
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
  };
}

const built: { app: FastifyInstance; store: MemorySessionStore; push: PushService }[] = [];

function build() {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  const sender = new FakeSender();
  const pushStore = new MemoryPushStore();
  const push = new PushService(pushStore, { sender });
  registerRoutes(app, makeConfig(), store, { push });
  registerPushRoutes(app, store, push);
  built.push({ app, store, push });
  return { app, store, push, sender, pushStore };
}

afterEach(async () => {
  for (const { app, store, push } of built.splice(0)) {
    await app.close();
    store.stop();
    push.stop();
  }
});

async function mint(app: FastifyInstance, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION, ...extra },
  });
  return response.json() as { code: string; updateToken: string };
}

function subscribe(app: FastifyInstance, code: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/v1/sessions/${code}/push`, payload: body });
}

describe('GET /v1/push/config', () => {
  it('hands out the VAPID public key with no auth, like the owner-update routes', async () => {
    const { app } = build();
    const response = await app.inject({ method: 'GET', url: '/v1/push/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vapidPublicKey: 'generated-pub' });
  });
});

describe('POST /v1/sessions/:code/push', () => {
  it('stores a valid subscription and answers 204 with no body', async () => {
    const { app, pushStore } = build();
    const { code } = await mint(app);

    const response = await subscribe(app, code, { subscription: subscription(1) });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await pushStore.listSubscriptions(code)).toHaveLength(1);
  });

  it.each([
    ['no subscription at all', {}],
    ['a non-object subscription', { subscription: 'yes please' }],
    ['a missing endpoint', { subscription: { keys: { p256dh: 'a', auth: 'b' } } }],
    ['an http endpoint', { subscription: { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } } }],
    ['missing keys', { subscription: { endpoint: 'https://push.example/x' } }],
    ['an oversized auth', { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b'.repeat(200) } } }],
  ])('refuses %s with 400', async (_label, body) => {
    const { app } = build();
    const { code } = await mint(app);
    const response = await subscribe(app, code, body);
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('invalid-subscription');
  });

  it('answers an unknown code with the standard indistinguishable 404', async () => {
    const { app } = build();
    // A checksum-valid code whose session is gone.
    const dead = await mint(app);
    await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${dead.code}`,
      payload: { updateToken: dead.updateToken },
    });

    const response = await subscribe(app, dead.code, { subscription: subscription(1) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found', message: 'no session for that code' });
  });

  it('caps at 10 per session, silently: still 204, extras never stored', async () => {
    const { app, pushStore } = build();
    const { code } = await mint(app);

    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 3; i++) {
      const response = await subscribe(app, code, { subscription: subscription(i) });
      expect(response.statusCode).toBe(204);
    }
    expect(await pushStore.listSubscriptions(code)).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
  });
});

describe('resolve fires the lookup notification', () => {
  it('pushes the generic body to subscribers when an operator resolves', async () => {
    const { app, sender } = build();
    const { code } = await mint(app);
    await subscribe(app, code, { subscription: subscription(1) });

    const resolved = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${code}`,
      headers: { authorization: 'Bearer key-alpha' },
    });
    expect(resolved.statusCode).toBe(200);

    // The send is fire-and-forget off the resolve path; let it land.
    await vi.waitFor(() => expect(sender.sent).toHaveLength(1));
    expect(sender.sent[0]!.payload).toEqual({
      title: 'whereareyou',
      body: 'An operator has looked up your code.',
    });
    // The one rule, checked where it matters: nothing position-shaped rides along.
    const serialised = JSON.stringify(sender.sent[0]!.payload);
    expect(serialised).not.toContain('lat');
    expect(serialised).not.toContain('position');
  });

  it('stays silent for a session nobody subscribed to', async () => {
    const { app, sender } = build();
    const { code } = await mint(app);
    await app.inject({
      method: 'GET',
      url: `/v1/sessions/${code}`,
      headers: { authorization: 'Bearer key-alpha' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sender.sent).toHaveLength(0);
  });
});
