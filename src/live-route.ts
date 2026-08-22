import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { parseLiveClientMessage } from '@whereareyou/protocol';
import type {
  LiveClientMessage,
  LiveEvent,
  LiveRefusalReason,
  LiveServerMessage,
  SessionMarker,
} from '@whereareyou/protocol';
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
 * truthful without ever opening a socket. The room's shared memory (zones,
 * chat, events, reached ids — whoever authored them) also writes through,
 * so a recreated room rehydrates; a joiner's POSITION still never touches
 * a datastore.
 *
 * Push triggers fire from here, throttled per session per kind. Payload
 * privacy basis (revised from "generic by design"): Web Push payloads are
 * E2E-ENCRYPTED (RFC 8291) — the Apple/Google/Mozilla relays carry
 * ciphertext they cannot read — so names and short chat snippets may
 * travel. Precise coordinates never do, as defence-in-depth: a payload's
 * end state is a lock screen. Actors with no name keep the generic bodies.
 */

/** Silence longer than one missed ping round gets the socket terminated. */
const PING_INTERVAL_MS = 30_000;
/** Per-type message floor — drop the excess, never disconnect for it. */
const MESSAGE_INTERVAL_MS = 1000;
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Frame types that REPLACE whole state, where the newest frame is the truth.
 * For these, flooring must deliver the LATEST frame once the window reopens:
 * a first-frame-wins drop leaves the room holding stale state forever (the
 * web UI commits markers on icon-pick and again on Done within the same
 * second — dropping the second loses the marker's name for everyone but its
 * author; the last stroke of a sketch burst vanishes the same way).
 * Event-shaped frames (chat, zone-create/remove) stay drop-only — replaying
 * those late would duplicate actions, not converge state.
 */
const TRAILING_TYPES: ReadonlySet<string> = new Set(['position', 'marker', 'markers', 'sketch']);

/** Chat snippet length in a push body — enough to act on, short of a screed. */
const CHAT_SNIPPET_CHARS = 100;

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

export async function registerLive(
  app: FastifyInstance,
  store: SessionStore,
  rooms: LiveRooms,
  push?: PushService,
  /** Tests only: shrink the timers so reaps and throttles are observable in ms. */
  options?: { pingIntervalMs?: number; pushThrottleWindowMs?: number },
): Promise<void> {
  await app.register(websocket);

  const throttle =
    options?.pushThrottleWindowMs !== undefined
      ? new PushThrottle(options.pushThrottleWindowMs)
      : new PushThrottle();

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
  }, options?.pingIntervalMs ?? PING_INTERVAL_MS);
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

      // Trailing-edge delivery for state-replacing frames (TRAILING_TYPES):
      // a floored frame is stashed (latest wins) and applied when the window
      // reopens, so the room converges on the sender's real state.
      const pending = new Map<string, LiveClientMessage>();
      const pendingTimers = new Map<string, NodeJS.Timeout>();
      let closed = false;

      const deferTrailing = (message: LiveClientMessage, now: number): void => {
        if (!TRAILING_TYPES.has(message.type)) return;
        pending.set(message.type, message);
        if (pendingTimers.has(message.type)) return; // one armed flush per type
        const wait = Math.max(1, (lastAt.get(message.type) ?? 0) + MESSAGE_INTERVAL_MS - now);
        const timer = setTimeout(() => {
          pendingTimers.delete(message.type);
          const stashed = pending.get(message.type);
          if (stashed === undefined || closed) return;
          pending.delete(message.type);
          const at = Date.now();
          if (floored(message.type, at)) return; // belt: the window is open by construction
          void apply(stashed, at);
        }, wait);
        timer.unref();
        pendingTimers.set(message.type, timer);
      };

      /**
       * Write the room's durable state through to the session record, so a
       * recreated room rehydrates (zones/chat/events/reached — cheap,
       * low-frequency writes; position fixes and trails stay memory-only by
       * design). Any participant's chat or zone lands here, not just the
       * owner's: the room's shared memory belongs to the session. Never
       * bumps updatedAt — that field vouches for the owner's position, and
       * someone else chatting must not make the pin look fresher than it is.
       */
      const persistLive = async (): Promise<void> => {
        if (code === null) return;
        const state = rooms.liveState(code);
        if (state === undefined) return;
        await store.update(code, { live: state });
      };

      const refuse = (reason: LiveRefusalReason): void => {
        try {
          socket.send(JSON.stringify({ type: 'refused', reason }));
        } catch {
          // Refusing a dead socket is still a refusal.
        }
        socket.close();
      };

      /**
       * `fragment` names the panel the client should open on tap. The url is
       * RELATIVE on purpose — the service worker resolves it against its own
       * location, so the GitHub Pages base needs no special-casing here —
       * and it is the app's session path, the same one shared links use.
       */
      const notify = (kind: string, body: string, fragment: 'chat' | 'activity' | 'people'): void => {
        if (push === undefined || code === null) return;
        if (!throttle.allow(code, kind)) return;
        // Fire-and-forget off the hot path; sendToSession never throws.
        void push.sendToSession(code, {
          title: 'whereareyou',
          body,
          url: `lookup?code=${code}#${fragment}`,
        });
      };

      /** '<Name> entered <Zone>' and kin; a nameless actor stays generic. */
      const eventBody = (event: LiveEvent): string => {
        if (event.name === undefined || event.targetName === undefined) {
          return 'Activity on your share.';
        }
        return event.kind === 'reached'
          ? `${event.name} reached ${event.targetName}`
          : `${event.name} ${event.kind} ${event.targetName}`;
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
              // If this join recreates the room, it comes back remembering:
              // the persisted zones/chat/events/reached ids, not a blank.
              hydrate: session.live,
              // The stable identity this wire has for a non-owner: the hello
              // name the web re-presents per code on rejoin. No name, no
              // reusable identity — one shared fallback key, announced once.
              identity: isOwner
                ? undefined
                : message.name !== undefined && message.name !== ''
                  ? `n:${message.name}`
                  : 'anon',
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
            // Someone arriving on the owner's share is worth a heads-up — the
            // FIRST time. The owner's own hello is not news to them, and a
            // reconnect of an already-announced identity (every screen change
            // on a phone is one) is not news to anyone.
            if (!isOwner && result.announce) {
              notify(
                'joined',
                message.name !== undefined
                  ? `${message.name} joined your share`
                  : 'Someone joined your share.',
                'people',
              );
            }
            // The seen-identities set just grew (or the room was recreated
            // and rehydrated) — keep the record's copy current.
            await persistLive();
            return;
          }

          if (code === null || participantId === null) return; // not joined

          // Every frame of any kind proves the participant is still there —
          // even one the per-type floor is about to drop.
          rooms.touch(code, participantId);

          const now = Date.now();
          if (floored(message.type, now)) {
            deferTrailing(message, now);
            return;
          }
          // This frame supersedes anything stashed of its type — a deferred
          // older frame must never apply after a newer one landed.
          pending.delete(message.type);
          await apply(message, now);
        })();
      });

      /** Post-join frame handling — called on receipt and from a trailing flush. */
      const apply = async (message: LiveClientMessage, now: number): Promise<void> => {
        if (closed || code === null || participantId === null || message.type === 'hello') return;

          if (message.type === 'position') {
            const events = rooms.position(code, participantId, message.position);
            // Named when the event is (payloads are E2E-encrypted — header);
            // never a coordinate. One event describes the burst: the per-kind
            // throttle would swallow the rest anyway.
            if (events.length > 0) notify('event', eventBody(events[0]!), 'activity');
            // A detection outcome is durable room memory — the events ring
            // and any newly-reached marker ids persist; the fix itself never
            // does (positions and trails are ephemeral by design).
            if (events.length > 0) await persistLive();
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
            if (sent !== undefined) {
              await persistLive();
              const snippet =
                sent.text.length > CHAT_SNIPPET_CHARS
                  ? `${sent.text.slice(0, CHAT_SNIPPET_CHARS)}…`
                  : sent.text;
              notify(
                'chat',
                sent.name !== undefined ? `${sent.name}: ${snippet}` : 'New message on your share.',
                'chat',
              );
            }
            return;
          }

          if (message.type === 'zone-create') {
            const created = rooms.zoneCreate(code, participantId, {
              id: message.id,
              name: message.name,
              center: message.center,
              radiusM: message.radiusM,
            });
            if (created !== undefined) await persistLive();
            return;
          }

          if (message.type === 'zone-remove') {
            if (rooms.zoneRemove(code, participantId, message.id)) await persistLive();
          }
      };

      socket.on('close', () => {
        clearTimeout(helloTimer);
        closed = true;
        for (const timer of pendingTimers.values()) clearTimeout(timer);
        pendingTimers.clear();
        pending.clear();
        if (code !== null && participantId !== null) rooms.leave(code, participantId);
      });
      socket.on('error', () => socket.terminate());
    },
  );
}
