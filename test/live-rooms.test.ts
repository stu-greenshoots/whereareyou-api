import { describe, expect, it } from 'vitest';
import { MAX_ROOM_PARTICIPANTS } from '@whereareyou/protocol';
import { LiveRooms, type LiveSocket } from '../src/live-rooms.js';
import { sleep } from './helpers.js';

/** A socket that just remembers what happened to it. */
class FakeSocket implements LiveSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  send(data: string): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m['type'] === type);
  }
}

const soon = () => Date.now() + 60_000;

describe('LiveRooms', () => {
  it('hands the newcomer the roster and tells the room about them', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();

    const first = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (first === 'room-full') throw new Error('unreachable');
    expect(first.roster).toEqual([]);

    const second = rooms.join('CODE1', b, { name: 'Sam', owner: false, share: true, expiresAt: soon() });
    if (second === 'room-full') throw new Error('unreachable');
    expect(second.roster).toHaveLength(1);
    expect(second.roster[0]!.owner).toBe(true);
    expect(a.ofType('participant')).toHaveLength(1);
    expect(a.ofType('participant')[0]!['participant']).toMatchObject({ name: 'Sam', owner: false });
    // The newcomer is not told about themselves.
    expect(b.sent).toHaveLength(0);
    rooms.stop();
  });

  it('broadcasts positions from sharers and drops them from watchers', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const sharer = rooms.join('CODE1', a, { owner: false, share: true, expiresAt: soon() });
    const watcher = rooms.join('CODE1', b, { owner: false, share: false, expiresAt: soon() });
    if (sharer === 'room-full' || watcher === 'room-full') throw new Error('unreachable');

    rooms.position('CODE1', sharer.id, { lat: 51.5, lon: -0.1, accuracyM: 8 });
    expect(b.ofType('participant').at(-1)!['participant']).toMatchObject({
      position: { lat: 51.5, lon: -0.1, accuracyM: 8 },
    });

    const before = a.sent.length;
    rooms.position('CODE1', watcher.id, { lat: 0, lon: 0, accuracyM: 5 });
    // They said they would not share; a position from them is not honoured.
    expect(a.sent.length).toBe(before);
    rooms.stop();
  });

  it('broadcasts sketches and departures, and empties cleanly', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const first = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    const second = rooms.join('CODE1', b, { owner: false, share: true, expiresAt: soon() });
    if (first === 'room-full' || second === 'room-full') throw new Error('unreachable');

    rooms.sketch('CODE1', second.id, 'AQAA');
    expect(a.ofType('participant').at(-1)!['participant']).toMatchObject({ sketch: 'AQAA' });

    rooms.leave('CODE1', second.id);
    expect(a.ofType('left')).toHaveLength(1);
    rooms.leave('CODE1', first.id);
    expect(rooms.size('CODE1')).toBe(0);
    rooms.stop();
  });

  it('refuses the seventeenth participant', () => {
    const rooms = new LiveRooms();
    for (let i = 0; i < MAX_ROOM_PARTICIPANTS; i++) {
      const joined = rooms.join('CODE1', new FakeSocket(), { owner: false, share: true, expiresAt: soon() });
      expect(joined).not.toBe('room-full');
    }
    expect(rooms.join('CODE1', new FakeSocket(), { owner: false, share: true, expiresAt: soon() })).toBe('room-full');
    rooms.stop();
  });

  it('expires the room with the session: everyone told, everyone hung up on', async () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    rooms.join('CODE1', a, { owner: true, share: true, expiresAt: Date.now() + 150 });
    rooms.join('CODE1', b, { owner: false, share: true, expiresAt: Date.now() + 150 });

    await sleep(400);
    expect(a.ofType('expired')).toHaveLength(1);
    expect(b.ofType('expired')).toHaveLength(1);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(rooms.size('CODE1')).toBe(0);
    rooms.stop();
  });

  it('survives a dead socket mid-broadcast', () => {
    const rooms = new LiveRooms();
    const dead = new FakeSocket();
    const alive = new FakeSocket();
    const first = rooms.join('CODE1', dead, { owner: false, share: true, expiresAt: soon() });
    const second = rooms.join('CODE1', alive, { owner: false, share: true, expiresAt: soon() });
    if (first === 'room-full' || second === 'room-full') throw new Error('unreachable');

    dead.closed = true; // send() now throws
    rooms.position('CODE1', second.id, { lat: 1, lon: 1, accuracyM: 5 });
    // The broadcast reached everyone it could and nothing blew up.
    expect(rooms.size('CODE1')).toBe(2);
    rooms.stop();
  });
});
