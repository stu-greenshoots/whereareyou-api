import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { parseLiveClientMessage } from '@whereareyou/protocol';
import type { LiveRefusalReason, LiveServerMessage, SessionMarker } from '@whereareyou/protocol';
import type { WebSocket } from 'ws';
import { tokensMatch } from './routes.js';
import type { SessionStore } from './store.js';
import type { LiveRooms } from './live-rooms.js';
import { PushThrottle, type PushService } from './push.js';

/**
 * The WebSocket end of live rooms: GET /v1/sessions/:code/live upgrades, the
 * first frame must be a `hello` (10s or hang up), and everything after that
 * is fanned out by LiveRooms. This process terminates the sockets itself —
 * no external realtime service; Render passes WS upgrades through to the
 * app, and an open socket keeps the free instance awake.
 *
 * The OWNER's position, sketch and markers write through to the store on
 * every update, so a plain resolve — and the dispatcher console — stays
 * truthful without ever opening a socket. Joiners touch no datastore at all.
 *
 * Push triggers fire from here, throttled per session per kind, and their
 * payloads are generic BY DESIGN: never a position, a zone name, or a chat
 * body — those travel through Apple/Google/Mozilla relays otherwise.
 */

/** Silence longer than one missed ping round gets the socket terminated. */
const PING_INTERVAL_MS = 30_000;
/** Per-type message floor — drop the excess, never disconnect for it. */
const MESSAGE_INTERVAL_MS = 1000;
const HELLO_TIMEOUT_MS = 10_000;

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

export async function registerLive(
  app: FastifyInstance,
  store: SessionStore,
  rooms: LiveRooms,
  push?: PushService,
): Promise<void> {
  await app.register(websocket);

  const throttle = new PushThrottle();

  const pinger = setInterval(() => {
    for (const client of app.websocketServer.clients) {
      const socket = client as AliveSocket;
      if (socket.isAlive === false) {
        socket.terminate(); // triggers 'close', which leaves the room
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  app.addHook('onClose', (_instance, done) => {
    clearInterval(pinger);
    rooms.stop();
    done();
  });

  app.get<{ Params: { code: string } }>(
    // The :code in the path is informative only — the hello frame carries
    // the authoritative, checksum-validated code. One less place to parse.
    '/v1/sessions/:code/live',
    { websocket: true },
    (socket: AliveSocket, request) => {
      socket.isAlive = true;
      socket.on('pong', () => {
        socket.isAlive = true;
      });

      let code: string | null = null;
      let participantId: string | null = null;
      let isOwner = false;
      const lastAt = new Map<string, number>();

      /** The per-type floor: true when this frame type must be dropped. */
      const floored = (type: string, now: number): boolean => {
        const last = lastAt.get(type) ?? 0;
        if (now - last < MESSAGE_INTERVAL_MS) return true;
        lastAt.set(type, now);
        return false;
      };

      const refuse = (reason: LiveRefusalReason): void => {
        try {
          socket.send(JSON.stringify({ type: 'refused', reason }));
        } catch {
          // Refusing a dead socket is still a refusal.
        }
        socket.close();
      };

      const notify = (kind: string, body: string): void => {
        if (push === undefined || code === null) return;
        if (!throttle.allow(code, kind)) return;
        // Fire-and-forget off the hot path; sendToSession never throws.
        void push.sendToSession(code, { title: 'whereareyou', body });
      };

      const helloTimer = setTimeout(() => socket.close(), HELLO_TIMEOUT_MS);
      helloTimer.unref();

      socket.on('message', (data: Buffer) => {
        void (async () => {
          const message = parseLiveClientMessage(data.toString());
          if (message === null) {
            // Junk before joining is a refusal; junk after is just dropped —
            // one bad frame must not eject someone whose position matters.
            if (participantId === null) {
              clearTimeout(helloTimer);
              refuse('bad-message');
            }
            return;
          }

          if (message.type === 'hello') {
            if (participantId !== null) return; // one hello per socket
            clearTimeout(helloTimer);

            const session = await store.get(message.code);
            if (session === undefined) return refuse('not-found');
            if (session.mode !== 'live') return refuse('not-live');

            isOwner =
              message.updateToken !== undefined &&
              tokensMatch(message.updateToken, session.updateTokenHash);

            const result = rooms.join(message.code, socket, {
              name: message.name,
              // Typed and validated by parseLiveClientMessage — the raw-frame
              // re-parse seam this used to need is gone with protocol v2.
              avatar: message.avatar,
              owner: isOwner,
              share: message.share,
              expiresAt: session.expiresAt,
            });
            if (result === 'room-full') return refuse('room-full');

            code = message.code;
            participantId = result.id;
            // Where the room arms its expiry timer, the T-minus-5-minutes
            // push warning is armed alongside (re-arming on every join is
            // idempotent). In-process timer — see armExpiryWarning for the
            // honest statement of what a restart loses.
            push?.armExpiryWarning(message.code, session.expiresAt);
            request.log.info(
              { event: 'live.joined', code, participantId, owner: isOwner, share: message.share },
              'joined live room',
            );
            const welcome: LiveServerMessage = {
              type: 'welcome',
              participantId,
              expiresAt: new Date(session.expiresAt).toISOString(),
              roster: result.roster,
              chat: result.chat,
              zones: result.zones,
              events: result.events,
            };
            socket.send(JSON.stringify(welcome));
            // Someone arriving on the owner's share is worth a heads-up; the
            // owner's own hello is not news to them.
            if (!isOwner) notify('joined', 'Someone joined your share.');
            return;
          }

          if (code === null || participantId === null) return; // not joined

          // Every frame of any kind proves the participant is still there —
          // even one the per-type floor is about to drop.
          rooms.touch(code, participantId);

          const now = Date.now();
          if (floored(message.type, now)) return;

          if (message.type === 'position') {
            const events = rooms.position(code, participantId, message.position);
            // Generic by design: the payload says something happened, never
            // what or where.
            if (events.length > 0) notify('event', 'Activity on your share.');
            // The owner's pin is the session — keep the record truthful for
            // anyone resolving without a socket. Never extends the TTL.
            if (isOwner) {
              await store.update(code, { position: message.position, updatedAt: now });
            }
            return;
          }

          if (message.type === 'marker' || message.type === 'markers') {
            // Legacy single-marker form becomes a whole-list write; the room
            // assigns the id (`legacy-<participantId>`). Persistence below
            // uses the session-record spelling, plain `legacy`.
            const markers: SessionMarker[] =
              message.type === 'markers'
                ? message.markers
                : message.position === null
                  ? []
                  : [{ id: 'legacy', position: message.position, icon: message.icon ?? 'spot' }];
            if (message.type === 'marker') {
              rooms.marker(code, participantId, message.position, message.icon);
            } else {
              rooms.markers(code, participantId, message.markers);
            }
            // The owner's markers persist like their position; an empty list
            // clears the record too, now that the record stores the list.
            if (isOwner) {
              await store.update(code, { markers, updatedAt: now });
            }
            return;
          }

          if (message.type === 'sketch') {
            rooms.sketch(code, participantId, message.sketch);
            if (isOwner) {
              await store.update(code, { sketch: message.sketch, updatedAt: now });
            }
            return;
          }

          if (message.type === 'chat') {
            const sent = rooms.chat(code, participantId, message.text);
            if (sent !== undefined) notify('chat', 'New message on your share.');
            return;
          }

          if (message.type === 'zone-create') {
            rooms.zoneCreate(code, participantId, {
              id: message.id,
              name: message.name,
              center: message.center,
              radiusM: message.radiusM,
            });
            return;
          }

          if (message.type === 'zone-remove') {
            rooms.zoneRemove(code, participantId, message.id);
          }
        })();
      });

      socket.on('close', () => {
        clearTimeout(helloTimer);
        if (code !== null && participantId !== null) rooms.leave(code, participantId);
      });
      socket.on('error', () => socket.terminate());
    },
  );
}
