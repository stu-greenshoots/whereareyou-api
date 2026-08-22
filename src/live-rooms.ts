import { randomBytes } from 'node:crypto';
import { MAX_ROOM_PARTICIPANTS } from '@whereareyou/protocol';
import type { LiveParticipant, LiveServerMessage, MarkerIcon, Position } from '@whereareyou/protocol';

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
 * The session TTL still rules everything: a room schedules its own death at
 * the session's expiresAt, tells everyone, and hangs up.
 */

/** The two socket operations a room needs — real ws in prod, arrays in tests. */
export interface LiveSocket {
  send(data: string): void;
  close(): void;
}

/**
 * A participant as this server knows them: the protocol shape plus a small
 * avatar image. The avatar rides OUTSIDE the protocol types deliberately —
 * it is an app-level nicety carried by this reference server, validated in
 * live-route.ts, and a candidate for promotion into the protocol's live
 * types once its shape settles.
 */
export type RoomParticipant = LiveParticipant & { avatar?: string };

interface Member {
  socket: LiveSocket;
  state: RoomParticipant;
  share: boolean;
}

export class LiveRooms {
  readonly #rooms = new Map<string, Map<string, Member>>();
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
    },
  ): { id: string; roster: RoomParticipant[] } | 'room-full' {
    let room = this.#rooms.get(code);
    if (room === undefined) {
      room = new Map();
      this.#rooms.set(code, room);
      const timer = setTimeout(() => this.expire(code), Math.max(0, options.expiresAt - Date.now()));
      timer.unref?.();
      this.#expiries.set(code, timer);
    }
    if (room.size >= MAX_ROOM_PARTICIPANTS) return 'room-full';

    const id = randomBytes(6).toString('base64url');
    const state: RoomParticipant = {
      id,
      owner: options.owner,
      updatedAt: new Date().toISOString(),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.avatar !== undefined ? { avatar: options.avatar } : {}),
    };
    // The roster the newcomer gets is everyone already here; everyone
    // already here hears about the newcomer instead.
    const roster = [...room.values()].map((member) => member.state);
    room.set(id, { socket, state, share: options.share });
    this.#broadcast(code, { type: 'participant', participant: state }, id);
    return { id, roster };
  }

  leave(code: string, id: string): void {
    const room = this.#rooms.get(code);
    if (room === undefined || !room.delete(id)) return;
    if (room.size === 0) {
      this.#drop(code);
      return;
    }
    this.#broadcast(code, { type: 'left', participantId: id });
  }

  position(code: string, id: string, position: Position): void {
    const member = this.#rooms.get(code)?.get(id);
    // A watcher said they would not share — a position from one is dropped,
    // not honoured. The prompt's two buttons are the consent surface.
    if (member === undefined || !member.share) return;
    member.state = { ...member.state, position, updatedAt: new Date().toISOString() };
    this.#broadcast(code, { type: 'participant', participant: member.state });
  }

  /** A placed point, or null to take it back. Anyone in the room may place one. */
  marker(code: string, id: string, position: Position | null, icon?: MarkerIcon): void {
    const member = this.#rooms.get(code)?.get(id);
    if (member === undefined) return;
    if (position === null) {
      const { marker: _cleared, markerIcon: _icon, ...rest } = member.state;
      member.state = { ...rest, updatedAt: new Date().toISOString() };
    } else {
      member.state = {
        ...member.state,
        marker: position,
        ...(icon !== undefined ? { markerIcon: icon } : {}),
        updatedAt: new Date().toISOString(),
      };
    }
    this.#broadcast(code, { type: 'participant', participant: member.state });
  }

  sketch(code: string, id: string, sketch: string): void {
    const member = this.#rooms.get(code)?.get(id);
    if (member === undefined) return;
    member.state = { ...member.state, sketch, updatedAt: new Date().toISOString() };
    this.#broadcast(code, { type: 'participant', participant: member.state });
  }

  /** The session expired: tell everyone plainly, then hang up on them all. */
  expire(code: string): void {
    const room = this.#rooms.get(code);
    if (room === undefined) return;
    this.#broadcast(code, { type: 'expired' });
    for (const member of room.values()) {
      try {
        member.socket.close();
      } catch {
        // A socket that will not close is already gone.
      }
    }
    this.#drop(code);
  }

  size(code: string): number {
    return this.#rooms.get(code)?.size ?? 0;
  }

  /** Tests and shutdown: no timers left behind. */
  stop(): void {
    for (const timer of this.#expiries.values()) clearTimeout(timer);
    this.#expiries.clear();
    this.#rooms.clear();
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
    for (const [memberId, member] of room) {
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
