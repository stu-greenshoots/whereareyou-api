import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { parseLiveClientMessage } from '@whereareyou/protocol';
import type { LiveRefusalReason } from '@whereareyou/protocol';
import type { WebSocket } from 'ws';
import { tokensMatch } from './routes.js';
import type { SessionStore } from './store.js';
import type { LiveRooms } from './live-rooms.js';

/**
 * The WebSocket end of live rooms: GET /v1/sessions/:code/live upgrades, the
 * first frame must be a `hello` (10s or hang up), and everything after that
 * is fanned out by LiveRooms. This process terminates the sockets itself —
 * no external realtime service; Render passes WS upgrades through to the
 * app, and an open socket keeps the free instance awake.
 *
 * The OWNER's position and sketch write through to the store on every
 * update, so a plain resolve — and the dispatcher console — stays truthful
 * without ever opening a socket. Joiners touch no datastore at all.
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
): Promise<void> {
  await app.register(websocket);

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
      let lastPositionAt = 0;
      let lastSketchAt = 0;

      const refuse = (reason: LiveRefusalReason): void => {
        try {
          socket.send(JSON.stringify({ type: 'refused', reason }));
        } catch {
          // Refusing a dead socket is still a refusal.
        }
        socket.close();
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
              owner: isOwner,
              share: message.share,
              expiresAt: session.expiresAt,
            });
            if (result === 'room-full') return refuse('room-full');

            code = message.code;
            participantId = result.id;
            request.log.info(
              { event: 'live.joined', code, participantId, owner: isOwner, share: message.share },
              'joined live room',
            );
            socket.send(
              JSON.stringify({
                type: 'welcome',
                participantId,
                expiresAt: new Date(session.expiresAt).toISOString(),
                roster: result.roster,
              }),
            );
            return;
          }

          if (code === null || participantId === null) return; // not joined

          const now = Date.now();
          if (message.type === 'position') {
            if (now - lastPositionAt < MESSAGE_INTERVAL_MS) return;
            lastPositionAt = now;
            rooms.position(code, participantId, message.position);
            // The owner's pin is the session — keep the record truthful for
            // anyone resolving without a socket. Never extends the TTL.
            if (isOwner) {
              await store.update(code, { position: message.position, updatedAt: now });
            }
            return;
          }

          if (message.type === 'sketch') {
            if (now - lastSketchAt < MESSAGE_INTERVAL_MS) return;
            lastSketchAt = now;
            rooms.sketch(code, participantId, message.sketch);
            if (isOwner) {
              await store.update(code, { sketch: message.sketch, updatedAt: now });
            }
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
