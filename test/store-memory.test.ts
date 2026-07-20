import { afterEach, describe, expect, it } from 'vitest';
import { MemorySessionStore } from '../src/store.js';
import { makeSession, sleep } from './helpers.js';

/**
 * The memory store is kept so the rest of the suite needs no Redis. These tests
 * pin its contract to the same shape as the Redis store, so the two remain
 * substitutable behind `SessionStore`.
 *
 * Note what is deliberately NOT asserted here: structural expiry. This store
 * cannot provide it, and writing a test that looked like it did would be worse
 * than having no test at all.
 */
describe('MemorySessionStore', () => {
  const stores: MemorySessionStore[] = [];
  const make = () => {
    const store = new MemorySessionStore();
    stores.push(store);
    return store;
  };

  afterEach(() => {
    for (const store of stores.splice(0)) store.stop();
  });

  it('round-trips a session', async () => {
    const store = make();
    const session = makeSession({ note: 'blue door' });
    await store.create(session);
    expect(await store.get(session.code)).toEqual(session);
  });

  it('stops serving a session once its expiry has passed', async () => {
    const store = make();
    const session = makeSession({ expiresAt: Date.now() + 300 });
    await store.create(session);
    await sleep(500);
    expect(await store.get(session.code)).toBeUndefined();
  });

  it('patches without replacing the whole record', async () => {
    const store = make();
    const session = makeSession();
    await store.create(session);

    expect(await store.update(session.code, { claimedBy: 'control-room-a' })).toBe(true);
    const loaded = await store.get(session.code);
    expect(loaded?.claimedBy).toBe('control-room-a');
    expect(loaded?.position).toEqual(session.position);
  });

  it('does not extend expiry on update', async () => {
    const store = make();
    const session = makeSession({ mode: 'live' });
    await store.create(session);
    await store.update(session.code, { updatedAt: Date.now() });
    expect((await store.get(session.code))?.expiresAt).toBe(session.expiresAt);
  });

  it('refuses to update a session that has expired', async () => {
    const store = make();
    const session = makeSession({ expiresAt: Date.now() + 200 });
    await store.create(session);
    await sleep(400);
    expect(await store.update(session.code, { claimedBy: 'control-room-a' })).toBe(false);
  });

  it('reports delete honestly', async () => {
    const store = make();
    const session = makeSession();
    await store.create(session);
    expect(await store.delete(session.code)).toBe(true);
    expect(await store.delete(session.code)).toBe(false);
  });

  it('excludes expired sessions from size()', async () => {
    const store = make();
    await store.create(makeSession({ expiresAt: Date.now() + 200 }));
    await store.create(makeSession());
    await sleep(400);
    expect(await store.size()).toBe(1);
  });
});
