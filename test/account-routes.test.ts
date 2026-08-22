import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAccountRoutes } from '../src/account-routes.js';
import { MAX_SAVED_MAPS, MemoryAccountStore } from '../src/account-store.js';

/**
 * The account routes end-to-end against the memory store. The invariants
 * that matter: credentials never leak (no hash in any response, one error
 * for both login failure kinds), usernames are claimed case-insensitively,
 * a token is required for everything personal and dies on logout, and the
 * server stores map data verbatim without parsing it.
 */

const built: FastifyInstance[] = [];

function build(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, new MemoryAccountStore());
  built.push(app);
  return app;
}

afterEach(async () => {
  for (const app of built.splice(0)) await app.close();
});

async function register(app: FastifyInstance, username = 'stu', password = 'correct-horse') {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/account/register',
    payload: { username, password },
  });
  return response;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const AVATAR = `data:image/jpeg;base64,${'A'.repeat(64)}`;

describe('register', () => {
  it('creates an account and returns a token and profile', async () => {
    const app = build();
    const response = await register(app);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.token).toBeTypeOf('string');
    expect(body.account).toEqual({ username: 'stu' });
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('refuses a duplicate username, case-insensitively', async () => {
    const app = build();
    await register(app, 'Stu');
    const response = await register(app, 'stu');
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('username-taken');
  });

  it('refuses a short username and a short password', async () => {
    const app = build();
    expect((await register(app, 'ab')).statusCode).toBe(400);
    expect((await register(app, 'valid-name', 'short')).statusCode).toBe(400);
  });
});

describe('login', () => {
  it('returns a fresh token for good credentials', async () => {
    const app = build();
    await register(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/account/login',
      payload: { username: 'STU', password: 'correct-horse' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().account.username).toBe('stu');
  });

  it('gives the SAME error for a wrong password and an unknown user', async () => {
    const app = build();
    await register(app);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/account/login',
      payload: { username: 'stu', password: 'wrong-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/v1/account/login',
      payload: { username: 'nobody-here', password: 'wrong-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });
});

describe('auth boundary', () => {
  it('refuses personal endpoints without a token', async () => {
    const app = build();
    for (const [method, url] of [
      ['GET', '/v1/account'],
      ['PATCH', '/v1/account'],
      ['GET', '/v1/account/maps'],
      ['PUT', '/v1/account/maps/m1'],
      ['DELETE', '/v1/account/maps/m1'],
      ['POST', '/v1/account/logout'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('logout revokes the token', async () => {
    const app = build();
    const { token } = (await register(app)).json();
    expect(
      (await app.inject({ method: 'POST', url: '/v1/account/logout', headers: auth(token) }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/account', headers: auth(token) })).statusCode,
    ).toBe(401);
  });
});

describe('profile', () => {
  it('renames, and refuses a rename onto a taken name', async () => {
    const app = build();
    const { token } = (await register(app)).json();
    await register(app, 'taken-name');

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { username: 'stuart' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().account.username).toBe('stuart');

    const collision = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { username: 'Taken-Name' },
    });
    expect(collision.statusCode).toBe(409);
  });

  it('changes the password only with the current one, and login follows', async () => {
    const app = build();
    const { token } = (await register(app)).json();

    const wrong = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { currentPassword: 'not-it', newPassword: 'brand-new-pass' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { currentPassword: 'correct-horse', newPassword: 'brand-new-pass' },
    });
    expect(right.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/account/login',
      payload: { username: 'stu', password: 'brand-new-pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('sets, returns and clears an avatar; refuses a non-image one', async () => {
    const app = build();
    const { token } = (await register(app)).json();

    const set = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { avatar: AVATAR },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().account.avatar).toBe(AVATAR);

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { avatar: null },
    });
    expect(cleared.json().account.avatar).toBeUndefined();

    const refused = await app.inject({
      method: 'PATCH',
      url: '/v1/account',
      headers: auth(token),
      payload: { avatar: 'data:text/html;base64,PHNjcmlwdD4=' },
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('saved maps', () => {
  it('round-trips a map verbatim, newest first', async () => {
    const app = build();
    const { token } = (await register(app)).json();

    const data = JSON.stringify({ lat: 51.5, lon: -0.12, sketch: 'AeDU9ASfnAEgAADIAQA' });
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/account/maps/map-one',
      headers: auth(token),
      payload: { name: 'Blue tent by the weir', data },
    });
    expect(put.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/v1/account/maps', headers: auth(token) });
    const { maps } = list.json();
    expect(maps).toHaveLength(1);
    expect(maps[0].name).toBe('Blue tent by the weir');
    expect(maps[0].data).toBe(data); // byte-identical — the server is a courier
  });

  it('refuses a nameless map and non-JSON data', async () => {
    const app = build();
    const { token } = (await register(app)).json();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/account/maps/m1',
          headers: auth(token),
          payload: { name: '   ', data: '{}' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/account/maps/m1',
          headers: auth(token),
          payload: { name: 'ok', data: 'not json' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('deletes a map, and 404s a second delete', async () => {
    const app = build();
    const { token } = (await register(app)).json();
    await app.inject({
      method: 'PUT',
      url: '/v1/account/maps/m1',
      headers: auth(token),
      payload: { name: 'a spot', data: '{}' },
    });
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/account/maps/m1', headers: auth(token) }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/account/maps/m1', headers: auth(token) }))
        .statusCode,
    ).toBe(404);
  });

  it('caps an account at MAX_SAVED_MAPS but always allows replacement', async () => {
    const app = build();
    const { token } = (await register(app)).json();
    for (let index = 0; index < MAX_SAVED_MAPS; index += 1) {
      const response = await app.inject({
        method: 'PUT',
        url: `/v1/account/maps/m${index}`,
        headers: auth(token),
        payload: { name: `map ${index}`, data: '{}' },
      });
      expect(response.statusCode).toBe(204);
    }
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/account/maps/one-too-many',
          headers: auth(token),
          payload: { name: 'no room', data: '{}' },
        })
      ).statusCode,
    ).toBe(409);
    // Replacing an existing map is not an addition.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/account/maps/m0',
          headers: auth(token),
          payload: { name: 'renamed', data: '{}' },
        })
      ).statusCode,
    ).toBe(204);
  });

  it("cannot see another account's maps", async () => {
    const app = build();
    const { token: alice } = (await register(app, 'alice')).json();
    const { token: bob } = (await register(app, 'bob', 'bobs-password')).json();
    await app.inject({
      method: 'PUT',
      url: '/v1/account/maps/m1',
      headers: auth(alice),
      payload: { name: 'private', data: '{}' },
    });
    const list = await app.inject({ method: 'GET', url: '/v1/account/maps', headers: auth(bob) });
    expect(list.json().maps).toHaveLength(0);
  });
});
