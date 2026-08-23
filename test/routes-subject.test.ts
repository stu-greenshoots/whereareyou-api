import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { MemorySessionStore } from '../src/store.js';

/**
 * The subject flip that rides a live upgrade.
 *
 * A "share a different location" session mints as `third-party` with its
 * position AT the marked spot. When the owner later goes live they start
 * streaming their OWN position, so the stored subject must become `self` or
 * the console's REPORTED banner mislabels the caller's moving fix as the
 * reported place. The invariants: the flip is accepted ONLY alongside the
 * one-way upgrade, only third-party → self, and it never disturbs the marked
 * spots that carry the reported place.
 */

const POSITION = { lat: 51.5072, lon: -0.1276, accuracyM: 8, source: 'gnss' as const };
const SPOT = { lat: 54.9714, lon: -2.1022, accuracyM: 40, source: 'manual' as const };
const MARKER = { id: 'spot-1', position: SPOT, icon: 'flag', name: 'blue tent by the weir' };

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

const built: { app: FastifyInstance; store: MemorySessionStore }[] = [];

function build() {
  const app = Fastify({ logger: false });
  const store = new MemorySessionStore();
  registerRoutes(app, makeConfig(), store);
  built.push({ app, store });
  return app;
}

afterEach(async () => {
  for (const { app, store } of built.splice(0)) {
    await app.close();
    store.stop();
  }
});

/** A marker-share as the web now mints it: third-party, position AT the spot. */
async function mintMarkerShare(app: FastifyInstance, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: SPOT, subject: 'third-party', markers: [MARKER], ...extra },
  });
  return response.json() as { code: string; updateToken: string };
}

function resolve(app: FastifyInstance, code: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/sessions/${code}`,
    headers: { authorization: 'Bearer key-alpha' },
  });
}

describe('subject flip on live upgrade', () => {
  it('flips third-party to self when the flip rides the upgrade', async () => {
    const app = build();
    const { code, updateToken } = await mintMarkerShare(app);

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, mode: 'live', subject: 'self' },
    });
    expect(upgraded.statusCode).toBe(204);

    const resolved = resolve(app, code);
    const session = (await resolved).json() as {
      subject: string;
      mode: string;
      position: { lat: number };
      markers?: Array<{ name?: string; position: { lat: number } }>;
    };
    expect(session.subject).toBe('self');
    expect(session.mode).toBe('live');
    // The marked spot is untouched by the flip: same place, same name.
    expect(session.markers).toHaveLength(1);
    expect(session.markers![0]!.name).toBe(MARKER.name);
    expect(session.markers![0]!.position.lat).toBe(SPOT.lat);
    // No position rode the upgrade, so the stored one still points at the spot.
    expect(session.position.lat).toBe(SPOT.lat);
  });

  it('keeps the upgrade itself subject-neutral when no flip is asked for', async () => {
    const app = build();
    const { code, updateToken } = await mintMarkerShare(app);

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, mode: 'live' },
    });
    expect(upgraded.statusCode).toBe(204);

    const session = (await resolve(app, code)).json() as { subject: string };
    expect(session.subject).toBe('third-party');
  });

  it('ignores the flip on a plain position update — it only rides the upgrade', async () => {
    const app = build();
    const { code, updateToken } = await mintMarkerShare(app, { mode: 'live' });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, position: POSITION, subject: 'self' },
    });
    expect(patched.statusCode).toBe(204);

    const session = (await resolve(app, code)).json() as { subject: string };
    expect(session.subject).toBe('third-party');
  });

  it('never flips the other way: a self session upgrading stays self', async () => {
    const app = build();
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { position: POSITION },
    });
    const { code, updateToken } = minted.json() as { code: string; updateToken: string };

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, mode: 'live', subject: 'third-party' },
    });
    expect(upgraded.statusCode).toBe(204);

    const session = (await resolve(app, code)).json() as { subject: string };
    expect(session.subject).toBe('self');
  });

  it('still refuses a subject-only PATCH on a static session', async () => {
    const app = build();
    const { code, updateToken } = await mintMarkerShare(app);

    const refused = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, position: POSITION, subject: 'self' },
    });
    expect(refused.statusCode).toBe(409);

    const session = (await resolve(app, code)).json() as { subject: string };
    expect(session.subject).toBe('third-party');
  });
});
