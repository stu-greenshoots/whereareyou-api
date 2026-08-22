import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { MemorySessionStore } from '../src/store.js';

/**
 * The sketch field end-to-end through the actual routes. The invariants that
 * matter, in order: a bad sketch NEVER costs a mint; a good sketch comes back
 * byte-identical (the server is a courier, not a parser); absence is
 * preserved; and a PATCH can replace the sketch without touching expiry.
 */

const POSITION = { lat: 51.5072, lon: -0.1276, accuracyM: 8, source: 'gnss' as const };

// A real payload (the golden arrow vector from the protocol suite) and a
// charset-valid-but-meaningless one. Both must pass the server's shape check;
// only the console can tell them apart, by decoding.
const SKETCH = 'AeDU9ASfnAEgAADIAQA';
const SKETCH_2 = 'AQAA';

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

async function mint(app: FastifyInstance, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: { position: POSITION, ...extra },
  });
  return response;
}

function resolve(app: FastifyInstance, code: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/sessions/${code}`,
    headers: { authorization: 'Bearer key-alpha' },
  });
}

describe('sketch through mint and resolve', () => {
  it('returns a minted sketch byte-identical on resolve', async () => {
    const app = build();
    const minted = await mint(app, { sketch: SKETCH });
    expect(minted.statusCode).toBe(201);

    const resolved = await resolve(app, (minted.json() as { code: string }).code);
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { sketch?: string }).sketch).toBe(SKETCH);
  });

  it('omits the field entirely when no sketch was sent', async () => {
    const app = build();
    const minted = await mint(app);
    const resolved = await resolve(app, (minted.json() as { code: string }).code);
    expect('sketch' in (resolved.json() as object)).toBe(false);
  });

  it.each([
    ['oversized', 'A'.repeat(10_000)],
    ['non-string', 12345],
    ['bad charset', 'not+valid=='],
    ['empty string', ''],
  ])('still mints when the sketch is %s, dropping it silently', async (_label, sketch) => {
    const app = build();
    const minted = await mint(app, { sketch });
    expect(minted.statusCode).toBe(201);

    const resolved = await resolve(app, (minted.json() as { code: string }).code);
    expect(resolved.statusCode).toBe(200);
    expect('sketch' in (resolved.json() as object)).toBe(false);
  });
});

describe('marker through mint and resolve', () => {
  it('returns a minted marker on resolve, and keeps it out when invalid', async () => {
    const app = build();
    const marker = { lat: 51.51, lon: -0.13, accuracyM: 15, source: 'manual' as const };
    const minted = await mint(app, { marker });
    expect(minted.statusCode).toBe(201);
    const resolved = (await resolve(app, (minted.json() as { code: string }).code)).json() as {
      marker?: { lat: number };
    };
    expect(resolved.marker).toMatchObject({ lat: 51.51 });

    // A junk marker never costs the mint.
    const junk = await mint(app, { marker: { lat: 999 } });
    expect(junk.statusCode).toBe(201);
    const junkResolved = (await resolve(app, (junk.json() as { code: string }).code)).json() as object;
    expect('marker' in junkResolved).toBe(false);
  });
});

describe('markers through mint, PATCH and resolve — the mirror rule', () => {
  const spot = (lat: number) => ({ lat, lon: -0.13, accuracyM: 15, source: 'manual' as const });

  interface MarkeredResponse {
    marker?: { lat: number };
    markerIcon?: string;
    markers?: Array<{ id: string; position: { lat: number }; icon: string; name?: string }>;
  }

  async function mintAndResolve(app: FastifyInstance, extra: Record<string, unknown>) {
    const minted = await mint(app, extra);
    expect(minted.statusCode).toBe(201);
    const { code } = minted.json() as { code: string };
    return { code, resolved: (await resolve(app, code)).json() as MarkeredResponse };
  }

  it('returns the minted list plus marker/markerIcon mirroring markers[0]', async () => {
    const app = build();
    const { resolved } = await mintAndResolve(app, {
      markers: [
        { id: 'camp', position: spot(51.51), icon: 'tent', name: '  base camp  ' },
        { id: 'water', position: spot(51.52), icon: 'water' },
      ],
    });
    expect(resolved.markers).toHaveLength(2);
    expect(resolved.markers![0]).toMatchObject({ id: 'camp', icon: 'tent', name: 'base camp' });
    // The legacy pair is a read-only view of markers[0], nothing else.
    expect(resolved.marker).toMatchObject({ lat: 51.51 });
    expect(resolved.markerIcon).toBe('tent');
  });

  it('reads a legacy single-marker mint back as a one-entry list with id "legacy"', async () => {
    const app = build();
    const { resolved } = await mintAndResolve(app, { marker: spot(51.51), markerIcon: 'car' });
    expect(resolved.markers).toMatchObject([{ id: 'legacy', icon: 'car' }]);
    expect(resolved.markerIcon).toBe('car');

    // No icon supplied: the marker still stands, as a plain spot.
    const { resolved: plain } = await mintAndResolve(app, { marker: spot(51.5) });
    expect(plain.markers).toMatchObject([{ id: 'legacy', icon: 'spot' }]);
  });

  it('lets markers win over a legacy marker sent beside it — the list is authoritative', async () => {
    const app = build();
    const { resolved } = await mintAndResolve(app, {
      marker: spot(40.0),
      markerIcon: 'car',
      markers: [{ id: 'real', position: spot(51.51), icon: 'flag' }],
    });
    expect(resolved.markers).toMatchObject([{ id: 'real', icon: 'flag' }]);
    expect(resolved.marker).toMatchObject({ lat: 51.51 }); // not 40.0
    expect(resolved.markerIcon).toBe('flag'); // not 'car'
  });

  it('drops invalid entries, duplicates and overflow silently — never the mint', async () => {
    const app = build();
    const { resolved } = await mintAndResolve(app, {
      markers: [
        { id: 'bad id!', position: spot(51.5), icon: 'flag' }, // charset
        { id: 'nopos', position: { lat: 999 }, icon: 'flag' }, // position
        { id: 'good', position: spot(51.51), icon: 'flag' },
        { id: 'good', position: spot(51.52), icon: 'tent' }, // duplicate id
        { id: 'unknown-icon', position: spot(51.53), icon: 'spaceship' }, // → 'spot'
      ],
    });
    expect(resolved.markers).toMatchObject([
      { id: 'good', icon: 'flag' },
      { id: 'unknown-icon', icon: 'spot' },
    ]);

    // 25 valid entries: the first 20 survive, the rest are dropped silently.
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      position: spot(51 + i / 100),
      icon: 'flag',
    }));
    const { resolved: capped } = await mintAndResolve(app, { markers: many });
    expect(capped.markers).toHaveLength(20);
    expect(capped.markers!.at(-1)!.id).toBe('m19');

    // A markers field that is not an array at all is ignored wholesale.
    const { resolved: junk } = await mintAndResolve(app, { markers: 'nonsense' });
    expect('markers' in junk).toBe(false);
    expect('marker' in junk).toBe(false);
  });

  it('replaces the list through PATCH, and clears everything with []', async () => {
    const app = build();
    const minted = await mint(app, {
      mode: 'live',
      markers: [{ id: 'first', position: spot(51.51), icon: 'tent' }],
    });
    const { code, updateToken } = minted.json() as { code: string; updateToken: string };

    const replaced = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: {
        updateToken,
        position: POSITION,
        markers: [{ id: 'second', position: spot(51.6), icon: 'water' }],
      },
    });
    expect(replaced.statusCode).toBe(204);
    const afterReplace = (await resolve(app, code)).json() as MarkeredResponse;
    expect(afterReplace.markers).toMatchObject([{ id: 'second', icon: 'water' }]);
    expect(afterReplace.markerIcon).toBe('water');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${code}`,
      payload: { updateToken, position: POSITION, markers: [] },
    });
    expect(cleared.statusCode).toBe(204);
    const afterClear = (await resolve(app, code)).json() as MarkeredResponse;
    expect('markers' in afterClear).toBe(false);
    expect('marker' in afterClear).toBe(false);
    expect('markerIcon' in afterClear).toBe(false);
  });
});

describe('sketch through PATCH', () => {
  async function mintLive(app: FastifyInstance, extra: Record<string, unknown> = {}) {
    const minted = await mint(app, { mode: 'live', ...extra });
    return minted.json() as { code: string; updateToken: string; expiresAt: string };
  }

  function patch(app: FastifyInstance, code: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/v1/sessions/${code}`, payload });
  }

  it('replaces the sketch on a live session without extending expiry', async () => {
    const app = build();
    const { code, updateToken, expiresAt } = await mintLive(app, { sketch: SKETCH });

    const patched = await patch(app, code, { updateToken, position: POSITION, sketch: SKETCH_2 });
    expect(patched.statusCode).toBe(204);

    const resolved = (await resolve(app, code)).json() as { sketch?: string; expiresAt: string };
    expect(resolved.sketch).toBe(SKETCH_2);
    expect(resolved.expiresAt).toBe(expiresAt);
  });

  it('leaves the stored sketch alone when the PATCH carries none', async () => {
    const app = build();
    const { code, updateToken } = await mintLive(app, { sketch: SKETCH });

    await patch(app, code, { updateToken, position: POSITION });
    expect(((await resolve(app, code)).json() as { sketch?: string }).sketch).toBe(SKETCH);
  });

  it('applies the position update even when the replacement sketch is invalid', async () => {
    const app = build();
    const { code, updateToken } = await mintLive(app, { sketch: SKETCH });

    const moved = { ...POSITION, lat: 51.6 };
    const patched = await patch(app, code, {
      updateToken,
      position: moved,
      sketch: 'not+a/sketch=',
    });
    expect(patched.statusCode).toBe(204);

    const resolved = (await resolve(app, code)).json() as {
      sketch?: string;
      position: { lat: number };
    };
    expect(resolved.position.lat).toBe(51.6);
    expect(resolved.sketch).toBe(SKETCH); // the old drawing survives
  });
});
