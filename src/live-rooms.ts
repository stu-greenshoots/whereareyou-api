import { randomBytes } from 'node:crypto';
import {
  MARKER_REACHED_RADIUS_M,
  MAX_CHAT_HISTORY,
  MAX_CHAT_TEXT_CHARS,
  MAX_EVENT_HISTORY,
  MAX_ROOM_PARTICIPANTS,
  MAX_SESSION_MARKERS,
  MAX_SESSION_ZONES,
  MAX_TRAIL_FIXES,
  ZONE_ENTER_CONSECUTIVE_FIXES,
  ZONE_LEAVE_SLACK_M,
} from '@whereareyou/protocol';
import type {
  ChatMessage,
  LiveEvent,
  LiveParticipant,
  LiveServerMessage,
  MarkerIcon,
  Position,
  SessionMarker,
  Zone,
} from '@whereareyou/protocol';

/**
 * Live rooms — who is present on a session, in this process's memory.
 *
 * Deliberately in-memory and nothing else: the session RECORD stays the
 * source of truth for the owner (the route persists owner state to the
 * store), while joiners exist only while their socket is open. Nothing about
 * a joiner ever touches a datastore — reload means rejoin. This also means
 * rooms are single-instance; that is on the deferred register, not an
 * accident.
 *
 * Live v2 adds the room's shared memory: a chat ring, named zones, a
 * detection-event ring and per-participant trails. It lives here while the
 * room does — and the durable part (zones, chat, events, reached ids; never
 * positions or trails) is written through to the session record by the
 * route, so a room recreated after its last member leaves rehydrates
 * instead of forgetting (a solo owner flipping code screen ↔ live map
 * empties the room in passing). The copy in the record shares the session's
 * TTL and dies with it. None of it may ever reach a log — chat bodies, zone
 * names, trails and avatars are user content, same discipline as positions.
 *
 * The session TTL still rules everything: a room schedules its own death at
 * the session's expiresAt, tells everyone, and hangs up.
 */

/** The two socket operations a room needs — real ws in prod, arrays in tests. */
export interface LiveSocket {
  send(data: string): void;
  close(): void;
}

interface ZoneDetection {
  /** Consecutive fixes inside the radius, toward ZONE_ENTER_CONSECUTIVE_FIXES. */
  streak: number;
  /** Currently counted inside — the hysteresis flag. */
  inside: boolean;
}

interface Member {
  socket: LiveSocket;
  state: LiveParticipant;
  share: boolean;
  /**
   * Recent honoured fixes, oldest first, ≤ MAX_TRAIL_FIXES. Sent in the
   * WELCOME roster only — never in `participant` fanout — so `state` never
   * carries it.
   */
  trail: Position[];
  /** zoneId → enter/leave hysteresis state for THIS member. */
  zoneState: Map<string, ZoneDetection>;
  /** markerId → consecutive fixes inside the reach radius. */
  markerStreaks: Map<string, number>;
  /** Marker ids this member has reached — at most once each, ever. */
  reached: Set<string>;
  /**
   * Whether this member's first honoured fix has seeded zone occupancy.
   * The seeding is SILENT: a (re)joiner discovered already inside a zone is
   * state rediscovered, not a transition observed — announcing it made
   * every screen change on a phone re-fire 'entered' (field report). Events
   * fire only on transitions seen after the baseline.
   */
  baselined: boolean;
}

interface Room {
  members: Map<string, Member>;
  /** Retained chat, oldest first, ≤ MAX_CHAT_HISTORY. */
  chat: ChatMessage[];
  /** Session-level zones, ≤ MAX_SESSION_ZONES. */
  zones: Zone[];
  /** Retained detection events, oldest first, ≤ MAX_EVENT_HISTORY. */
  events: LiveEvent[];
  /**
   * Marker ids 'reached' fired for BEFORE this room instance existed —
   * hydrated from the session record. Checked alongside each member's own
   * reached set so a room recreate (solo owner flipping code screen ↔ live
   * map) does not re-fire the same arrival, and the push with it, on every
   * rejoin. Deliberate coarseness, stated plainly: after a recreate the
   * suppression is room-wide, so a DIFFERENT participant arriving at an
   * already-reached marker fires nothing either. POC-honest — participant
   * identity does not survive connections, so per-person suppression across
   * room lifetimes has nothing to key on.
   */
  preReached: Set<string>;
  /** preReached ∪ every id fired this lifetime — what gets persisted. */
  reachedEver: Set<string>;
  /**
   * Announcement keys of every non-owner identity whose arrival has been
   * announced — `n:<hello name>` (the stable identity the web re-presents
   * per code on rejoin), or the one shared `anon` key for hellos with no
   * reusable identity. Persisted, so "X joined your share" fires once per
   * session per identity, not once per screen change. Two strangers who
   * share a name collapse to one announcement — conservative in the quiet
   * direction, stated plainly.
   */
  seenIdentities: Set<string>;
}

/** What a room persists through the session record; see store.ts. */
export interface LiveRoomState {
  zones: Zone[];
  chat: ChatMessage[];
  events: LiveEvent[];
  reachedMarkerIds: string[];
  /** Announcement keys already used — see Room.seenIdentities. */
  seenIdentities: string[];
}

/** Everything a welcome needs, straight from the room's retained state. */
export interface JoinResult {
  id: string;
  roster: LiveParticipant[];
  chat: ChatMessage[];
  zones: Zone[];
  events: LiveEvent[];
  /** Whether this arrival is NEWS — an identity not yet announced on this
      session. False for reconnects of a seen identity; the route keeps the
      'joined' push behind it. */
  announce: boolean;
}

const EARTH_RADIUS_M = 6_371_000;

/**
 * Hard cap on persisted reached-marker ids: everyone in a full room reaching
 * everyone's full marker list is the natural ceiling; beyond it something is
 * feeding us junk and the oldest entries are the ones to shed.
 */
const MAX_REACHED_IDS = MAX_ROOM_PARTICIPANTS * MAX_SESSION_MARKERS;

/** Bound on persisted announcement keys; oldest shed first past it. */
const MAX_SEEN_IDENTITIES = 64;

/**
 * Great-circle distance in metres (haversine). Detection distances are tens
 * of metres to a few kilometres, where this is accurate to well under the
 * GPS error it is being compared against — no geodesy library warranted.
 */
export function distanceM(a: Position, b: Position): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class LiveRooms {
  readonly #rooms = new Map<string, Room>();
  readonly #expiries = new Map<string, NodeJS.Timeout>();

  join(
    code: string,
    socket: LiveSocket,
    options: {
      name?: string | undefined;
      avatar?: string | undefined;
      owner: boolean;
      share: boolean;
      expiresAt: number;
      /**
       * The session record's persisted room state — used ONLY when this
       * join creates the room, so zones/chat/events survive the room's
       * last-member-leaves teardown. A room already in memory is the truth
       * and hydration is ignored.
       */
      hydrate?: LiveRoomState | undefined;
      /**
       * Announcement key for a NON-owner join — `n:<name>` or `anon`. The
       * result's `announce` says whether this key is new to the session
       * (push the arrival) or already seen (a reconnect: stay quiet).
       */
      identity?: string | undefined;
    },
  ): JoinResult | 'room-full' {
    let room = this.#rooms.get(code);
    if (room === undefined) {
      const hydrate = options.hydrate;
      const reached = (hydrate?.reachedMarkerIds ?? []).slice(0, MAX_REACHED_IDS);
      room = {
        members: new Map(),
        chat: (hydrate?.chat ?? []).slice(-MAX_CHAT_HISTORY),
        zones: (hydrate?.zones ?? []).slice(0, MAX_SESSION_ZONES),
        events: (hydrate?.events ?? []).slice(-MAX_EVENT_HISTORY),
        preReached: new Set(reached),
        reachedEver: new Set(reached),
        seenIdentities: new Set((hydrate?.seenIdentities ?? []).slice(-MAX_SEEN_IDENTITIES)),
      };
      this.#rooms.set(code, room);
      const timer = setTimeout(() => this.expire(code), Math.max(0, options.expiresAt - Date.now()));
      timer.unref?.();
      this.#expiries.set(code, timer);
    }
    // OWNER SUPERSESSION. A hello that proves the updateToken IS the owner,
    // and there is exactly one of those per session — so any owner already
    // in the room is a previous connection of the same person: the code
    // screen's headless socket whose close is still in flight, a zombie the
    // heartbeat has not reaped yet, a reconnect after radio churn. Without
    // this the owner stands in every roster twice (field-observed: "Stu"
    // and "You", both sharer, distinct join times) until the close lands or
    // the ping reaper catches up. Supersede: remove, tell the room, hang up.
    if (options.owner) {
      for (const [staleId, stale] of [...room.members]) {
        if (!stale.state.owner) continue;
        room.members.delete(staleId);
        this.#discardMarkerState(
          room,
          (stale.state.markers ?? []).map((marker) => marker.id),
        );
        this.#broadcast(code, { type: 'left', participantId: staleId });
        try {
          stale.socket.close();
        } catch {
          // A socket that will not close is already gone.
        }
      }
    }
    if (room.members.size >= MAX_ROOM_PARTICIPANTS) return 'room-full';

    const id = randomBytes(6).toString('base64url');
    const now = new Date().toISOString();
    const state: LiveParticipant = {
      id,
      owner: options.owner,
      joinedAt: now,
      lastSeenAt: now,
      updatedAt: now,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.avatar !== undefined ? { avatar: options.avatar } : {}),
    };
    // The roster the newcomer gets is everyone already here — with their
    // trails, which travel in the welcome and nowhere else; everyone already
    // here hears about the newcomer instead.
    const roster = [...room.members.values()].map((member) =>
      member.trail.length > 0 ? { ...member.state, trail: [...member.trail] } : member.state,
    );
    const identity = options.identity;
    const announce = identity !== undefined && !room.seenIdentities.has(identity);
    if (identity !== undefined) {
      room.seenIdentities.add(identity);
      if (room.seenIdentities.size > MAX_SEEN_IDENTITIES) {
        const oldest = room.seenIdentities.values().next().value;
        if (oldest !== undefined) room.seenIdentities.delete(oldest);
      }
    }
    const result: JoinResult = {
      id,
      roster,
      chat: [...room.chat],
      zones: [...room.zones],
      events: [...room.events],
      announce,
    };
    room.members.set(id, {
      socket,
      state,
      share: options.share,
      trail: [],
      zoneState: new Map(),
      markerStreaks: new Map(),
      reached: new Set(),
      baselined: false,
    });
    this.#broadcast(code, { type: 'participant', participant: state }, id);
    return result;
  }

  leave(code: string, id: string): void {
    const room = this.#rooms.get(code);
    if (room === undefined) return;
    const member = room.members.get(id);
    if (member === undefined || !room.members.delete(id)) return;
    // A leaver's markers vanish with them; discarding their detection state
    // keeps "reached at most once per marker id" honest if the id ever
    // returns as a genuinely new marker.
    this.#discardMarkerState(
      room,
      (member.state.markers ?? []).map((marker) => marker.id),
    );
    if (room.members.size === 0) {
      this.#drop(code);
      return;
    }
    this.#broadcast(code, { type: 'left', participantId: id });
  }

  /**
   * A frame of any kind arrived from this participant — refresh lastSeenAt
   * without broadcasting anything. The freshened value travels with the next
   * state fanout or welcome roster.
   */
  touch(code: string, id: string): void {
    const member = this.#rooms.get(code)?.members.get(id);
    if (member === undefined) return;
    member.state = { ...member.state, lastSeenAt: new Date().toISOString() };
  }

  /**
   * A live fix: fan it out, remember it on the trail, and run detection.
   * Returns the events the fix produced, so the route can trigger a push
   * without this class knowing pushes exist.
   */
  position(code: string, id: string, position: Position): LiveEvent[] {
    const room = this.#rooms.get(code);
    const member = room?.members.get(id);
    // A watcher said they would not share — a position from one is dropped,
    // not honoured. The prompt's two buttons are the consent surface.
    if (room === undefined || member === undefined || !member.share) return [];
    const now = new Date().toISOString();
    // A fix without takenAt is stamped with receipt time — the trail's
    // entries always say when.
    const fix: Position = position.takenAt !== undefined ? position : { ...position, takenAt: now };
    member.trail.push(fix);
    if (member.trail.length > MAX_TRAIL_FIXES) member.trail.shift();
    member.state = { ...member.state, position: fix, lastSeenAt: now, updatedAt: now };
    this.#broadcast(code, { type: 'participant', participant: member.state });

    const events = this.#detect(room, member, fix);
    for (const event of events) {
      room.events.push(event);
      if (room.events.length > MAX_EVENT_HISTORY) room.events.shift();
      this.#broadcast(code, { type: 'event', ...event });
    }
    return events;
  }

  /**
   * LEGACY single-marker form: one placed point, or null to take every
   * marker back. Becomes a one-entry (or empty) marker list whose id the
   * server assigns — `legacy-<participantId>` — per the back-compat rule.
   */
  marker(code: string, id: string, position: Position | null, icon?: MarkerIcon): void {
    this.markers(
      code,
      id,
      position === null ? [] : [{ id: `legacy-${id}`, position, icon: icon ?? 'spot' }],
    );
  }

  /**
   * Replace this participant's whole marker list. `[]` clears. The legacy
   * `marker`/`markerIcon` fields on the fanned-out participant are always
   * mirrors of `markers[0]` — never independently writable.
   */
  markers(code: string, id: string, markers: SessionMarker[]): void {
    const room = this.#rooms.get(code);
    const member = room?.members.get(id);
    if (room === undefined || member === undefined) return;
    const next = markers.slice(0, MAX_SESSION_MARKERS);
    // A marker id that disappears takes its detection state with it: if the
    // id ever comes back it is a new marker and can be reached afresh.
    const keptIds = new Set(next.map((marker) => marker.id));
    const removed = (member.state.markers ?? [])
      .map((marker) => marker.id)
      .filter((markerId) => !keptIds.has(markerId));
    this.#discardMarkerState(room, removed);

    const { marker: _marker, markerIcon: _markerIcon, markers: _markers, ...rest } = member.state;
    const first = next[0];
    member.state = {
      ...rest,
      ...(first !== undefined
        ? { markers: next, marker: first.position, markerIcon: first.icon }
        : {}),
      lastSeenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#broadcast(code, { type: 'participant', participant: member.state });
  }

  sketch(code: string, id: string, sketch: string): void {
    const member = this.#rooms.get(code)?.members.get(id);
    if (member === undefined) return;
    const now = new Date().toISOString();
    member.state = { ...member.state, sketch, lastSeenAt: now, updatedAt: now };
    this.#broadcast(code, { type: 'participant', participant: member.state });
  }

  /**
   * Say something to the room. `id` and `at` are server-assigned; the text
   * is defensively re-capped here even though the wire parser already
   * truncates. Returns the retained message, or undefined when it was
   * dropped — so the route can trigger a push on real messages only.
   *
   * The sender's `name`/`avatar` are stamped onto the message AS OF SEND
   * TIME, straight from their hello identity: participant ids are
   * per-connection, so a message resolved against the roster goes
   * anonymous the moment the sending connection closes. The stamp rides
   * the ring into welcome replay, where the roster can no longer help. An
   * anonymous sender has no name — stamp nothing, invent nothing.
   */
  chat(code: string, id: string, text: string): ChatMessage | undefined {
    const room = this.#rooms.get(code);
    const member = room?.members.get(id);
    if (room === undefined || member === undefined) return undefined;
    const body = text.trim().slice(0, MAX_CHAT_TEXT_CHARS);
    if (body === '') return undefined;
    const now = new Date().toISOString();
    member.state = { ...member.state, lastSeenAt: now };
    const message: ChatMessage = {
      id: randomBytes(9).toString('base64url'),
      participantId: id,
      ...(member.state.name !== undefined ? { name: member.state.name } : {}),
      ...(member.state.avatar !== undefined ? { avatar: member.state.avatar } : {}),
      text: body,
      at: now,
    };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
    this.#broadcast(code, { type: 'chat', ...message });
    return message;
  }

  /**
   * Create a zone. Fanned out to EVERYONE including the creator — the echo
   * is the create ack; an over-cap or duplicate-id create simply never
   * echoes. Any participant may create one (POC write posture).
   */
  zoneCreate(
    code: string,
    id: string,
    zone: { id: string; name: string; center: Position; radiusM: number },
  ): Zone | undefined {
    const room = this.#rooms.get(code);
    const member = room?.members.get(id);
    if (room === undefined || member === undefined) return undefined;
    if (room.zones.length >= MAX_SESSION_ZONES) return undefined;
    if (room.zones.some((existing) => existing.id === zone.id)) return undefined;
    const created: Zone = {
      id: zone.id,
      name: zone.name,
      center: zone.center,
      radiusM: zone.radiusM,
      createdBy: id,
      createdAt: new Date().toISOString(),
    };
    room.zones.push(created);
    // A new zone starts everyone outside — even a re-used id must not
    // inherit hysteresis state from a zone that was removed.
    for (const other of room.members.values()) other.zoneState.delete(created.id);
    this.#broadcast(code, { type: 'zone-created', zone: created });
    return created;
  }

  /**
   * Remove a zone — honoured only for the zone's CREATOR (matched by
   * same-connection participantId, the best stable identity this wire has;
   * an anonymous creator who reconnects therefore loses remove rights on
   * their own zone — stated plainly, POC-honest) or the session OWNER.
   * Anything else is silence: unknown id or unauthorised remover alike get
   * no frame and no error, deliberately indistinguishable. Supersedes the
   * original any-participant POC posture.
   */
  zoneRemove(code: string, id: string, zoneId: string): boolean {
    const room = this.#rooms.get(code);
    const member = room?.members.get(id);
    if (room === undefined || member === undefined) return false;
    const index = room.zones.findIndex((zone) => zone.id === zoneId);
    if (index === -1) return false;
    if (room.zones[index]!.createdBy !== id && !member.state.owner) return false;
    room.zones.splice(index, 1);
    // Removing a zone discards its detection state; no synthetic 'left'.
    for (const other of room.members.values()) other.zoneState.delete(zoneId);
    this.#broadcast(code, { type: 'zone-removed', id: zoneId });
    return true;
  }

  /**
   * The room's durable state, for the route to write through to the session
   * record — bounded copies, safe to serialise. Undefined when no room is
   * in memory for the code.
   */
  liveState(code: string): LiveRoomState | undefined {
    const room = this.#rooms.get(code);
    if (room === undefined) return undefined;
    return {
      zones: [...room.zones],
      chat: [...room.chat],
      events: [...room.events],
      reachedMarkerIds: [...room.reachedEver].slice(-MAX_REACHED_IDS),
      seenIdentities: [...room.seenIdentities].slice(-MAX_SEEN_IDENTITIES),
    };
  }

  /**
   * The session gained time: re-arm the room's scheduled death and tell
   * everyone the new expiresAt so their countdowns stay truthful.
   */
  extend(code: string, expiresAt: number): void {
    const room = this.#rooms.get(code);
    if (room === undefined) return;
    const previous = this.#expiries.get(code);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => this.expire(code), Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    this.#expiries.set(code, timer);
    this.#broadcast(code, { type: 'expiry', expiresAt: new Date(expiresAt).toISOString() });
  }

  /** The session expired: tell everyone plainly, then hang up on them all. */
  expire(code: string): void {
    const room = this.#rooms.get(code);
    if (room === undefined) return;
    this.#broadcast(code, { type: 'expired' });
    for (const member of room.members.values()) {
      try {
        member.socket.close();
      } catch {
        // A socket that will not close is already gone.
      }
    }
    this.#drop(code);
  }

  size(code: string): number {
    return this.#rooms.get(code)?.members.size ?? 0;
  }

  /** Tests and shutdown: no timers left behind. */
  stop(): void {
    for (const timer of this.#expiries.values()) clearTimeout(timer);
    this.#expiries.clear();
    this.#rooms.clear();
  }

  /**
   * The detection contract, verbatim from docs/specs/live-v2-contract.md:
   *
   *   ENTER a zone:   distance < radiusM on ZONE_ENTER_CONSECUTIVE_FIXES
   *                   consecutive fixes; the event fires on the last of them.
   *   LEAVE a zone:   distance > radiusM + max(fix accuracyM,
   *                   ZONE_LEAVE_SLACK_M) on a single fix, only while counted
   *                   inside. The asymmetry is hysteresis: GPS jitter at the
   *                   boundary must not fire enter/leave forever.
   *   REACH a marker: the enter test with an effective radius of
   *                   max(MARKER_REACHED_RADIUS_M, fix accuracyM), at most
   *                   once per participant per marker id, ever.
   */
  #detect(room: Room, member: Member, fix: Position): LiveEvent[] {
    const events: LiveEvent[] = [];
    const at = new Date().toISOString();
    const participantId = member.state.id;
    // First honoured fix after (re)join: seed zone occupancy SILENTLY (see
    // Member.baselined). Markers keep their normal path — 'reached' cannot
    // fire on a single fix, and already-reached ids are suppressed by the
    // persisted set, so a baseline exception would add nothing but a hole.
    const baseline = !member.baselined;
    member.baselined = true;
    // The actor's display name AT EVENT TIME, stamped for the same reason
    // chat stamps it: ids are per-connection, and replayed history outlives
    // both the roster entry and the zone. Anonymous actor: stamp nothing.
    const actor = member.state.name !== undefined ? { name: member.state.name } : {};

    for (const zone of room.zones) {
      const distance = distanceM(fix, zone.center);
      let state = member.zoneState.get(zone.id);
      if (state === undefined) {
        state = { streak: 0, inside: false };
        member.zoneState.set(zone.id, state);
      }
      if (baseline) {
        state.inside = distance < zone.radiusM;
        state.streak = 0;
        continue; // occupancy rediscovered, never announced
      }
      if (state.inside) {
        if (distance > zone.radiusM + Math.max(fix.accuracyM, ZONE_LEAVE_SLACK_M)) {
          state.inside = false;
          state.streak = 0;
          events.push({ kind: 'left', participantId, ...actor, zoneId: zone.id, targetName: zone.name, at });
        }
        // Inside the slack band: still inside. That is the hysteresis.
      } else if (distance < zone.radiusM) {
        state.streak += 1;
        if (state.streak >= ZONE_ENTER_CONSECUTIVE_FIXES) {
          state.inside = true;
          events.push({ kind: 'entered', participantId, ...actor, zoneId: zone.id, targetName: zone.name, at });
        }
      } else {
        state.streak = 0; // an outside fix breaks the consecutive run
      }
    }

    // Every marker in the room counts, whoever placed it — arriving at your
    // own "meet here" is as much an arrival as anyone else's.
    for (const other of room.members.values()) {
      for (const marker of other.state.markers ?? []) {
        // A marker already arrived at in an earlier room lifetime stays
        // arrived at — rehydrated suppression, see Room.preReached.
        if (member.reached.has(marker.id) || room.preReached.has(marker.id)) continue;
        const effectiveRadius = Math.max(MARKER_REACHED_RADIUS_M, fix.accuracyM);
        if (distanceM(fix, marker.position) < effectiveRadius) {
          const streak = (member.markerStreaks.get(marker.id) ?? 0) + 1;
          if (streak >= ZONE_ENTER_CONSECUTIVE_FIXES) {
            member.markerStreaks.delete(marker.id);
            member.reached.add(marker.id);
            room.reachedEver.add(marker.id);
            events.push({
              kind: 'reached',
              participantId,
              ...actor,
              markerId: marker.id,
              // An unnamed marker stamps nothing — never invent a label here.
              ...(marker.name !== undefined ? { targetName: marker.name } : {}),
              at,
            });
          } else {
            member.markerStreaks.set(marker.id, streak);
          }
        } else {
          member.markerStreaks.delete(marker.id);
        }
      }
    }

    return events;
  }

  /** Marker ids that left the room take their detection state with them. */
  #discardMarkerState(room: Room, markerIds: string[]): void {
    if (markerIds.length === 0) return;
    for (const member of room.members.values()) {
      for (const markerId of markerIds) {
        member.reached.delete(markerId);
        member.markerStreaks.delete(markerId);
      }
    }
  }

  #drop(code: string): void {
    this.#rooms.delete(code);
    const timer = this.#expiries.get(code);
    if (timer !== undefined) clearTimeout(timer);
    this.#expiries.delete(code);
  }

  #broadcast(code: string, message: LiveServerMessage, exceptId?: string): void {
    const room = this.#rooms.get(code);
    if (room === undefined) return;
    const data = JSON.stringify(message);
    for (const [memberId, member] of room.members) {
      if (memberId === exceptId) continue;
      try {
        member.socket.send(data);
      } catch {
        // Sending to a dead socket must not take the room down; the close
        // handler will call leave() for it.
      }
    }
  }
}
