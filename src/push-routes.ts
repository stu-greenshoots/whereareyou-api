import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseCode } from '@whereareyou/protocol';
import type { SessionStore } from './store.js';
import { parsePushSubscription, type PushService } from './push.js';

/**
 * Push endpoints — POC.
 *
 * Exposed exactly like the session owner-update routes: no resolver API key,
 * because the web share screen calls these the same way it PATCHes its own
 * session. Knowing a live code is the capability, as it is for live rooms.
 *
 * Log discipline: a push endpoint URL identifies a person's browser, so a
 * subscription is treated like a position — never logged, and redacted in the
 * logger config besides.
 */

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message });
}

export function registerPushRoutes(
  app: FastifyInstance,
  store: SessionStore,
  push: PushService,
): void {
  // The public half of the VAPID pair, for PushManager.subscribe() in the
  // browser. Public by nature — it ships to every subscriber anyway.
  app.get('/v1/push/config', async () => ({ vapidPublicKey: await push.publicKey() }));

  app.post<{ Params: { code: string } }>('/v1/sessions/:code/push', async (request, reply) => {
    const parsed = parseCode(request.params.code);
    if (!parsed.ok) return fail(reply, 400, 'invalid-code', `code rejected: ${parsed.reason}`);

    // Shape first, session second: a malformed body gets the same 400 whether
    // or not the code exists, so this route confirms nothing to a prober.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const subscription = parsePushSubscription(body['subscription']);
    if (subscription === undefined) {
      return fail(
        reply,
        400,
        'invalid-subscription',
        'subscription must be PushSubscription JSON: an https endpoint plus keys.p256dh and keys.auth',
      );
    }

    // Missing and expired sessions are indistinguishable, same as resolve.
    const session = await store.get(parsed.code);
    if (session === undefined) return fail(reply, 404, 'not-found', 'no session for that code');

    // The subscription lives exactly as long as the session has left — its
    // key carries the session's REMAINING TTL, so expiry structurally kills
    // notifications with no cleanup job anywhere.
    const ttlMs = await store.ttlMs(parsed.code);
    if (ttlMs <= 0) return fail(reply, 404, 'not-found', 'no session for that code');

    // Beyond the per-session cap this is a silent no-op, still 204.
    await push.subscribe(parsed.code, subscription, ttlMs);

    request.log.info({ event: 'push.subscribed', code: parsed.code }, 'push subscription stored');
    return reply.status(204).send();
  });
}
