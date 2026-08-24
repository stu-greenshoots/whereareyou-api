import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_HISTORY,
  MAX_CHAT_TEXT_CHARS,
  MAX_EVENT_HISTORY,
  MAX_ROOM_PARTICIPANTS,
  MAX_SESSION_ZONES,
  MAX_TRAIL_FIXES,
} from '@whereareyou/protocol';
import type { Position } from '@whereareyou/protocol';
import {
  LiveRooms,
  MAX_DISCONNECTED_RETAINED,
  distanceM,
  identityKeyFor,
  type LiveRoomState,
  type LiveSocket,
} from '../src/live-rooms.js';
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

/**
 * A fix `northM` metres due north of the origin. 1° of latitude is
 * ~111,320 m, so distances here are real distances, not magic numbers —
 * the same haversine the detector runs confirms it below.
 */
const fix = (northM: number, accuracyM = 5): Position => ({
  lat: northM / 111_320,
  lon: 0,
  accuracyM,
  source: 'gnss',
  takenAt: new Date().toISOString(),
});

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

    rooms.position('CODE1', sharer.id, { lat: 51.5, lon: -0.1, accuracyM: 8, source: 'gnss', takenAt: new Date().toISOString() });
    expect(b.ofType('participant').at(-1)!['participant']).toMatchObject({
      position: { lat: 51.5, lon: -0.1, accuracyM: 8 },
    });

    const before = a.sent.length;
    rooms.position('CODE1', watcher.id, { lat: 0, lon: 0, accuracyM: 5, source: 'gnss', takenAt: new Date().toISOString() });
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

  it('places and clears a marker, distinct from position', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const first = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    rooms.join('CODE1', b, { owner: false, share: false, expiresAt: soon() });
    if (first === 'room-full') throw new Error('unreachable');

    // Even a watcher's marker counts — placing a point is a statement about
    // the world, not about where you are.
    rooms.marker('CODE1', first.id, { lat: 51.5, lon: -0.1, accuracyM: 10, source: 'manual', takenAt: new Date().toISOString() });
    const placed = b.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect(placed['marker']).toMatchObject({ lat: 51.5 });
    expect('position' in placed).toBe(false);

    rooms.marker('CODE1', first.id, null);
    const cleared = b.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect('marker' in cleared).toBe(false);
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

  it('stamps joinedAt and lastSeenAt, and touch() refreshes silently', async () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const first = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (first === 'room-full') throw new Error('unreachable');

    const second = rooms.join('CODE1', b, { owner: false, share: true, expiresAt: soon() });
    if (second === 'room-full') throw new Error('unreachable');
    const seen = second.roster[0] as unknown as Record<string, string>;
    expect(typeof seen['joinedAt']).toBe('string');
    expect(typeof seen['lastSeenAt']).toBe('string');

    await sleep(15);
    const sent = a.sent.length;
    rooms.touch('CODE1', second.id);
    // Silent: nothing broadcast, but the next fanout carries the fresh time.
    expect(a.sent.length).toBe(sent);
    rooms.position('CODE1', second.id, fix(0));
    const state = a.ofType('participant').at(-1)!['participant'] as Record<string, string>;
    expect(Date.parse(state['lastSeenAt']!)).toBeGreaterThan(Date.parse(seen['joinedAt']!));
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
    rooms.position('CODE1', second.id, { lat: 1, lon: 1, accuracyM: 5, source: 'gnss', takenAt: new Date().toISOString() });
    // The broadcast reached everyone it could and nothing blew up.
    expect(rooms.size('CODE1')).toBe(2);
    rooms.stop();
  });
});

/** A room with n members, everything unpacked and typed for poking at. */
function roomOf(n: number) {
  const rooms = new LiveRooms();
  const sockets: FakeSocket[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const socket = new FakeSocket();
    const joined = rooms.join('CODE1', socket, { owner: i === 0, share: true, expiresAt: soon() });
    if (joined === 'room-full') throw new Error('unreachable');
    sockets.push(socket);
    ids.push(joined.id);
  }
  return { rooms, sockets, ids };
}

describe('sharing is a switch, not a fate', () => {
  it('going dark keeps the person, drops the position, and stops honouring fixes', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.position('CODE1', ids[1]!, fix(0));
    expect(sockets[0]!.ofType('participant').at(-1)!['participant']).toMatchObject({
      id: ids[1],
      position: { lat: 0 },
    });

    expect(rooms.setShare('CODE1', ids[1]!, false)).toBe(true);
    const dark = sockets[0]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    // Present, not sharing: still in the roster, no position — and NOT a
    // ghost, which is the state this must never be mistaken for.
    expect(dark['id']).toBe(ids[1]);
    expect(dark).not.toHaveProperty('position');
    expect(dark).not.toHaveProperty('disconnectedAt');

    // A fix arriving after the switch is dropped, exactly like a watcher's.
    const before = sockets[0]!.sent.length;
    rooms.position('CODE1', ids[1]!, fix(100));
    expect(sockets[0]!.sent.length).toBe(before);
    rooms.stop();
  });

  it('resumes on the way back, and a no-op flip says nothing', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.setShare('CODE1', ids[1]!, false);

    // Already off: no change, no frame.
    const quiet = sockets[0]!.sent.length;
    expect(rooms.setShare('CODE1', ids[1]!, false)).toBe(false);
    expect(sockets[0]!.sent.length).toBe(quiet);

    expect(rooms.setShare('CODE1', ids[1]!, true)).toBe(true);
    rooms.position('CODE1', ids[1]!, fix(250));
    expect(sockets[0]!.ofType('participant').at(-1)!['participant']).toMatchObject({
      id: ids[1],
      position: { accuracyM: 5 },
    });
    rooms.stop();
  });

  it('takes the trail with it, so a late joiner gets no path they stopped sharing', () => {
    const { rooms, ids } = roomOf(2);
    rooms.position('CODE1', ids[1]!, fix(0));
    rooms.position('CODE1', ids[1]!, fix(50));

    const early = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (early === 'room-full') throw new Error('unreachable');
    expect(early.roster.find((entry) => entry.id === ids[1])!.trail).toHaveLength(2);

    rooms.setShare('CODE1', ids[1]!, false);
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    const entry = late.roster.find((member) => member.id === ids[1])!;
    expect(entry.trail).toBeUndefined();
    expect(entry.position).toBeUndefined();
    rooms.stop();
  });

  it('re-baselines occupancy silently on resume, so a dark walk fires nothing', () => {
    const { rooms, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir', center: fix(0), radiusM: 100 });
    rooms.position('CODE1', ids[1]!, fix(50)); // silent occupancy baseline: inside
    rooms.position('CODE1', ids[1]!, fix(50));

    // They go dark, walk well clear, and come back on. The first fix after
    // is state rediscovered, not a transition observed — no synthetic left.
    rooms.setShare('CODE1', ids[1]!, false);
    rooms.setShare('CODE1', ids[1]!, true);
    expect(rooms.position('CODE1', ids[1]!, fix(900))).toEqual([]);
    // And the walk back in is a real arrival again.
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toMatchObject([{ kind: 'entered', zoneId: 'z1' }]);
    rooms.stop();
  });

  it('is refused for a member the room does not have, or has already lost', () => {
    const { rooms, ids } = roomOf(2);
    expect(rooms.setShare('CODE1', 'nobody', false)).toBe(false);
    expect(rooms.setShare('NOPE1', ids[1]!, false)).toBe(false);
    rooms.disconnect('CODE1', ids[1]!);
    // A retained ghost has no wire to change its mind over.
    expect(rooms.setShare('CODE1', ids[1]!, false)).toBe(false);
    rooms.stop();
  });

  it('lets the OWNER run a session while broadcasting nothing', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.position('CODE1', ids[0]!, fix(0));
    expect(rooms.setShare('CODE1', ids[0]!, false)).toBe(true);
    const owner = sockets[1]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect(owner).toMatchObject({ id: ids[0], owner: true });
    expect(owner).not.toHaveProperty('position');
    expect(owner).not.toHaveProperty('disconnectedAt');
    rooms.stop();
  });
});

describe('the sanity of the test geometry', () => {
  it('fix(n) really is n metres from the origin, by the same haversine', () => {
    expect(distanceM(fix(0), fix(100))).toBeCloseTo(100, 0);
    expect(distanceM(fix(0), fix(130))).toBeCloseTo(130, 0);
  });
});

describe('chat', () => {
  it('relays to everyone including the sender, with server-assigned id and at', () => {
    const { rooms, sockets, ids } = roomOf(2);
    const sent = rooms.chat('CODE1', ids[1]!, '  by the weir  ');
    expect(sent).toBeDefined();
    for (const socket of sockets) {
      const frame = socket.ofType('chat').at(-1)!;
      expect(frame).toMatchObject({
        id: sent!.id,
        participantId: ids[1],
        text: 'by the weir', // trimmed
        at: sent!.at,
      });
    }
    rooms.stop();
  });

  it('truncates oversize text and drops blank, never erroring', () => {
    const { rooms, sockets, ids } = roomOf(1);
    const sent = rooms.chat('CODE1', ids[0]!, 'x'.repeat(MAX_CHAT_TEXT_CHARS + 100));
    expect(sent!.text).toHaveLength(MAX_CHAT_TEXT_CHARS);
    expect(rooms.chat('CODE1', ids[0]!, '   ')).toBeUndefined();
    expect(sockets[0]!.ofType('chat')).toHaveLength(1);
    rooms.stop();
  });

  it('retains the last MAX_CHAT_HISTORY for late joiners, oldest dropped first', () => {
    const { rooms, ids } = roomOf(1);
    for (let i = 0; i < MAX_CHAT_HISTORY + 5; i++) {
      rooms.chat('CODE1', ids[0]!, `message ${i}`);
    }
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.chat).toHaveLength(MAX_CHAT_HISTORY);
    expect(late.chat[0]!.text).toBe('message 5');
    expect(late.chat.at(-1)!.text).toBe(`message ${MAX_CHAT_HISTORY + 4}`);
    rooms.stop();
  });

  it('stamps sender name and avatar at send time, surviving welcome replay after they leave', () => {
    const rooms = new LiveRooms();
    const senderSocket = new FakeSocket();
    const avatar = 'data:image/png;base64,AAAA';
    const sender = rooms.join('CODE1', senderSocket, {
      name: 'Sam',
      avatar,
      owner: true,
      share: true,
      expiresAt: soon(),
    });
    const other = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (sender === 'room-full' || other === 'room-full') throw new Error('unreachable');

    const sent = rooms.chat('CODE1', sender.id, 'by the weir');
    expect(sent).toMatchObject({ participantId: sender.id, name: 'Sam', avatar });
    // The stamp rides the live fanout frame too.
    expect(senderSocket.ofType('chat').at(-1)!).toMatchObject({ name: 'Sam', avatar });

    // The sending connection closes; its id is gone from the roster for
    // good — this is exactly the attribution bug. The stamp in the ring is
    // what a late joiner (or the sender's own next connection) resolves.
    rooms.leave('CODE1', sender.id);
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.roster.some((entry) => entry.id === sender.id)).toBe(false);
    expect(late.chat.at(-1)!).toMatchObject({
      participantId: sender.id,
      name: 'Sam',
      avatar,
      text: 'by the weir',
    });
    rooms.stop();
  });

  it('stamps nothing for an anonymous sender — no invented name, no avatar', () => {
    const { rooms, ids } = roomOf(1); // roomOf joins with neither name nor avatar
    const sent = rooms.chat('CODE1', ids[0]!, 'hello');
    expect(sent!.name).toBeUndefined();
    expect(sent!.avatar).toBeUndefined();
    // Absent means absent: the keys are not on the retained entry at all.
    expect('name' in sent!).toBe(false);
    expect('avatar' in sent!).toBe(false);
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect('name' in late.chat[0]!).toBe(false);
    rooms.stop();
  });
});

describe('zones', () => {
  const zone = (id: string, radiusM = 100) => ({ id, name: 'the weir', center: fix(0), radiusM });

  it('echoes zone-created to everyone INCLUDING the creator — the echo is the ack', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[1]!, zone('z1'));
    for (const socket of sockets) {
      const frame = socket.ofType('zone-created').at(-1)!['zone'] as Record<string, unknown>;
      expect(frame).toMatchObject({ id: 'z1', name: 'the weir', radiusM: 100, createdBy: ids[1] });
      expect(typeof frame['createdAt']).toBe('string');
    }
    rooms.stop();
  });

  it('silently drops a duplicate id and anything over the cap — no echo, no error', () => {
    const { rooms, sockets, ids } = roomOf(1);
    rooms.zoneCreate('CODE1', ids[0]!, zone('dup'));
    rooms.zoneCreate('CODE1', ids[0]!, zone('dup'));
    expect(sockets[0]!.ofType('zone-created')).toHaveLength(1);

    for (let i = 0; i < MAX_SESSION_ZONES + 3; i++) {
      rooms.zoneCreate('CODE1', ids[0]!, zone(`z${i}`));
    }
    // 'dup' + 19 more fit; the rest never echo.
    expect(sockets[0]!.ofType('zone-created')).toHaveLength(MAX_SESSION_ZONES);
    rooms.stop();
  });

  it('honours a remove only from the creator or the owner; others are silence', () => {
    const { rooms, sockets, ids } = roomOf(3); // ids[0] is the owner
    rooms.zoneCreate('CODE1', ids[1]!, zone('z1'));

    // Neither the creator nor the owner: dropped with no frame — the zone
    // stays, deliberately indistinguishable from an unknown id.
    rooms.zoneRemove('CODE1', ids[2]!, 'z1');
    for (const socket of sockets) expect(socket.ofType('zone-removed')).toHaveLength(0);

    // The creator may take their own zone back.
    rooms.zoneRemove('CODE1', ids[1]!, 'z1');
    for (const socket of sockets) {
      expect(socket.ofType('zone-removed').at(-1)).toMatchObject({ id: 'z1' });
    }

    // The owner may remove anyone's.
    rooms.zoneCreate('CODE1', ids[1]!, zone('z2'));
    rooms.zoneRemove('CODE1', ids[0]!, 'z2');
    expect(sockets[1]!.ofType('zone-removed').at(-1)).toMatchObject({ id: 'z2' });

    // Unknown ids stay silence, from anyone.
    rooms.zoneRemove('CODE1', ids[1]!, 'never-existed');
    expect(sockets[0]!.ofType('zone-removed')).toHaveLength(2);

    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.zones).toEqual([]);
    rooms.stop();
  });
});

describe('zone detection — the hysteresis contract, verbatim', () => {
  it('fires entered exactly once, on the second consecutive inside fix', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir', center: fix(0), radiusM: 100 });

    // The FIRST fix seeds occupancy silently (the quiet-reconnect
    // baseline) — start outside so the walk in is an observed transition.
    expect(rooms.position('CODE1', ids[1]!, fix(200))).toEqual([]);
    // One inside fix is jitter, not an arrival.
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([]);
    // An outside fix breaks the run...
    expect(rooms.position('CODE1', ids[1]!, fix(200))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([]);
    // ...and only the second CONSECUTIVE inside fix is an entry.
    const events = rooms.position('CODE1', ids[1]!, fix(60));
    expect(events).toEqual([
      { kind: 'entered', participantId: ids[1], zoneId: 'z1', targetName: 'weir', at: expect.any(String) },
    ]);
    // Staying inside is not news.
    expect(rooms.position('CODE1', ids[1]!, fix(70))).toEqual([]);
    // Everyone heard about it exactly once.
    expect(sockets[0]!.ofType('event')).toHaveLength(1);
    rooms.stop();
  });

  it('leaves only past radius + max(accuracy, slack) — jitter at the boundary is silence', () => {
    const { rooms, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir', center: fix(0), radiusM: 100 });
    rooms.position('CODE1', ids[1]!, fix(200)); // silent occupancy baseline
    rooms.position('CODE1', ids[1]!, fix(50));
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toHaveLength(1); // entered

    // 110m is outside the radius but inside the 20m slack band: still in.
    expect(rooms.position('CODE1', ids[1]!, fix(110, 5))).toEqual([]);
    // A sloppy fix widens the band to its accuracy: 130m at ±40 is still in.
    expect(rooms.position('CODE1', ids[1]!, fix(130, 40))).toEqual([]);
    // 130m at ±5 is past 100 + max(5, 20): that is a leave, on a single fix.
    expect(rooms.position('CODE1', ids[1]!, fix(130, 5))).toEqual([
      { kind: 'left', participantId: ids[1], zoneId: 'z1', targetName: 'weir', at: expect.any(String) },
    ]);
    // And re-entering takes two consecutive fixes again.
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toHaveLength(1);
    rooms.stop();
  });

  it('starts everyone outside a re-created zone id and discards state on removal', () => {
    const { rooms, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir', center: fix(0), radiusM: 100 });
    rooms.position('CODE1', ids[1]!, fix(50));
    rooms.position('CODE1', ids[1]!, fix(50)); // entered
    rooms.zoneRemove('CODE1', ids[0]!, 'z1'); // no synthetic left
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir again', center: fix(0), radiusM: 100 });
    // Inside all along, but the new zone starts everyone outside: the entry
    // needs its two consecutive fixes from scratch.
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(50))).toEqual([
      { kind: 'entered', participantId: ids[1], zoneId: 'z1', targetName: 'weir again', at: expect.any(String) },
    ]);
    rooms.stop();
  });

  it('caps the retained event ring at MAX_EVENT_HISTORY', () => {
    const { rooms, ids } = roomOf(2);
    rooms.zoneCreate('CODE1', ids[0]!, { id: 'z1', name: 'weir', center: fix(0), radiusM: 100 });
    // Bounce across the boundary until well past the cap: each cycle is one
    // entered (two inside fixes) and one left.
    for (let i = 0; i < MAX_EVENT_HISTORY; i++) {
      rooms.position('CODE1', ids[1]!, fix(50));
      rooms.position('CODE1', ids[1]!, fix(50));
      rooms.position('CODE1', ids[1]!, fix(200));
    }
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.events).toHaveLength(MAX_EVENT_HISTORY);
    // Oldest dropped first: the ring ends on the most recent 'left'.
    expect(late.events.at(-1)!.kind).toBe('left');
    rooms.stop();
  });
});

describe('marker reached — once per participant per marker id, ever', () => {
  it('fires on the second consecutive fix inside max(25m, accuracy), then never again', () => {
    const { rooms, ids } = roomOf(2);
    rooms.markers('CODE1', ids[0]!, [{ id: 'm1', position: fix(0), icon: 'meet' }]);

    // 40m out at ±5 is beyond the 25m reach radius: nothing.
    expect(rooms.position('CODE1', ids[1]!, fix(40, 5))).toEqual([]);
    // The same 40m at ±60 is within the widened effective radius — once is
    // still not enough...
    expect(rooms.position('CODE1', ids[1]!, fix(40, 60))).toEqual([]);
    // ...the second consecutive fix inside is the arrival.
    expect(rooms.position('CODE1', ids[1]!, fix(10, 5))).toEqual([
      { kind: 'reached', participantId: ids[1], markerId: 'm1', at: expect.any(String) },
    ]);
    // Sitting on the spot — or leaving and coming back — never re-fires.
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([]);
    rooms.position('CODE1', ids[1]!, fix(500));
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([]);
    rooms.stop();
  });

  it('keeps reached state across a move (same id), resets it when the id is replaced', () => {
    const { rooms, ids } = roomOf(2);
    rooms.markers('CODE1', ids[0]!, [{ id: 'm1', position: fix(0), icon: 'meet' }]);
    rooms.position('CODE1', ids[1]!, fix(10));
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toHaveLength(1); // reached m1

    // Moving the marker keeps its id — already reached, stays reached.
    rooms.markers('CODE1', ids[0]!, [{ id: 'm1', position: fix(5), icon: 'meet' }]);
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([]);
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([]);

    // Replacing it discards the old id's state; the new id is a new marker.
    rooms.markers('CODE1', ids[0]!, [{ id: 'm2', position: fix(0), icon: 'meet' }]);
    rooms.position('CODE1', ids[1]!, fix(10));
    expect(rooms.position('CODE1', ids[1]!, fix(10))).toEqual([
      { kind: 'reached', participantId: ids[1], markerId: 'm2', at: expect.any(String) },
    ]);

    // And bringing 'm1' back makes it a NEW marker: reachable again.
    rooms.markers('CODE1', ids[0]!, [{ id: 'm1', position: fix(0), icon: 'meet' }]);
    rooms.position('CODE1', ids[1]!, fix(10));
    const again = rooms.position('CODE1', ids[1]!, fix(10));
    expect(again.map((event) => event.markerId)).toEqual(['m1']);
    rooms.stop();
  });

  it('counts your own markers too — arriving at your own "meet here" is an arrival', () => {
    const { rooms, ids } = roomOf(1);
    rooms.markers('CODE1', ids[0]!, [{ id: 'mine', position: fix(0), icon: 'flag' }]);
    rooms.position('CODE1', ids[0]!, fix(10));
    expect(rooms.position('CODE1', ids[0]!, fix(10))).toEqual([
      { kind: 'reached', participantId: ids[0], markerId: 'mine', at: expect.any(String) },
    ]);
    rooms.stop();
  });
});

describe('event stamping — names survive the roster and the zone', () => {
  it('stamps actor and zone names at event time, and replay keeps them after both are gone', () => {
    const rooms = new LiveRooms();
    const ownerSocket = new FakeSocket();
    const owner = rooms.join('CODE1', ownerSocket, { owner: true, share: true, expiresAt: soon() });
    const mover = rooms.join('CODE1', new FakeSocket(), {
      name: 'Sam',
      owner: false,
      share: true,
      expiresAt: soon(),
    });
    if (owner === 'room-full' || mover === 'room-full') throw new Error('unreachable');
    rooms.zoneCreate('CODE1', owner.id, { id: 'z1', name: 'weir pool', center: fix(0), radiusM: 100 });

    rooms.position('CODE1', mover.id, fix(200)); // silent occupancy baseline
    rooms.position('CODE1', mover.id, fix(50));
    const events = rooms.position('CODE1', mover.id, fix(50));
    expect(events).toEqual([
      {
        kind: 'entered',
        participantId: mover.id,
        name: 'Sam',
        zoneId: 'z1',
        targetName: 'weir pool',
        at: expect.any(String),
      },
    ]);
    // The stamp rides the live fanout frame too.
    expect(ownerSocket.ofType('event').at(-1)!).toMatchObject({ name: 'Sam', targetName: 'weir pool' });

    // Zone deleted, actor's connection gone: the replayed event still names
    // both — the id alone would resolve to nothing at all.
    rooms.zoneRemove('CODE1', owner.id, 'z1');
    rooms.leave('CODE1', mover.id);
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.zones).toEqual([]);
    expect(late.roster.some((entry) => entry.id === mover.id)).toBe(false);
    expect(late.events.at(-1)!).toMatchObject({ kind: 'entered', name: 'Sam', targetName: 'weir pool' });
    rooms.stop();
  });

  it('stamps a named marker on reached; an anonymous actor gets no name key', () => {
    const { rooms, ids } = roomOf(2); // roomOf joins everyone anonymously
    rooms.markers('CODE1', ids[0]!, [
      { id: 'm1', position: fix(0), icon: 'meet', name: 'the bandstand' },
    ]);
    rooms.position('CODE1', ids[1]!, fix(10));
    const reached = rooms.position('CODE1', ids[1]!, fix(10));
    expect(reached).toEqual([
      {
        kind: 'reached',
        participantId: ids[1],
        markerId: 'm1',
        targetName: 'the bandstand',
        at: expect.any(String),
      },
    ]);
    // Absent means absent — nothing invented for an anonymous actor. (The
    // unnamed-marker case is pinned by the exact toEqual assertions in the
    // marker describe above: no targetName key appears there either.)
    expect('name' in reached[0]!).toBe(false);
    rooms.stop();
  });
});

describe('the marker mirror rule in fanout', () => {
  it('mirrors markers[0] into marker/markerIcon, and clears all three together', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.markers('CODE1', ids[0]!, [
      { id: 'a', position: fix(10), icon: 'tent', name: 'camp' },
      { id: 'b', position: fix(20), icon: 'water' },
    ]);
    const placed = sockets[1]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect(placed['markers']).toHaveLength(2);
    expect(placed['marker']).toMatchObject({ lat: (placed['markers'] as Array<{ position: { lat: number } }>)[0]!.position.lat });
    expect(placed['markerIcon']).toBe('tent');

    rooms.markers('CODE1', ids[0]!, []);
    const cleared = sockets[1]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect('markers' in cleared).toBe(false);
    expect('marker' in cleared).toBe(false);
    expect('markerIcon' in cleared).toBe(false);
    rooms.stop();
  });

  it('turns a legacy write into a one-entry list with the server-assigned id', () => {
    const { rooms, sockets, ids } = roomOf(2);
    rooms.marker('CODE1', ids[0]!, fix(10), 'warning');
    const placed = sockets[1]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect(placed['markers']).toMatchObject([{ id: `legacy-${ids[0]}`, icon: 'warning' }]);
    expect(placed['markerIcon']).toBe('warning');

    rooms.marker('CODE1', ids[0]!, null);
    const cleared = sockets[1]!.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect('markers' in cleared).toBe(false);
    expect('marker' in cleared).toBe(false);
    rooms.stop();
  });
});

describe('trails', () => {
  it('carries the last MAX_TRAIL_FIXES in the welcome roster, and only there', () => {
    const { rooms, sockets, ids } = roomOf(2);
    for (let i = 0; i < MAX_TRAIL_FIXES + 5; i++) {
      rooms.position('CODE1', ids[1]!, fix(i));
    }
    // Fanned-out participant frames never carry a trail...
    for (const frame of sockets[0]!.ofType('participant')) {
      expect('trail' in (frame['participant'] as Record<string, unknown>)).toBe(false);
    }
    // ...the welcome roster does: last 20, oldest first.
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    const walker = late.roster.find((participant) => participant.id === ids[1])!;
    expect(walker.trail).toHaveLength(MAX_TRAIL_FIXES);
    expect(walker.trail![0]!.lat).toBeCloseTo(fix(5).lat, 10);
    expect(walker.trail!.at(-1)!.lat).toBeCloseTo(fix(MAX_TRAIL_FIXES + 4).lat, 10);
    rooms.stop();
  });

  it('stamps a fix that arrives without takenAt', () => {
    const { rooms, ids } = roomOf(1);
    const bare = { lat: 0, lon: 0, accuracyM: 5, source: 'gnss' } as Position;
    rooms.position('CODE1', ids[0]!, bare);
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    const entry = late.roster[0]!.trail![0]!;
    expect(typeof entry.takenAt).toBe('string');
    expect(Number.isFinite(Date.parse(entry.takenAt))).toBe(true);
    rooms.stop();
  });
});

describe('disconnecting is not leaving', () => {
  /** Join a named sharer the way the route would: identity keyed on the name. */
  function joinNamed(rooms: LiveRooms, socket: LiveSocket, name: string) {
    const result = rooms.join('CODE1', socket, {
      name,
      owner: false,
      share: true,
      expiresAt: soon(),
      identity: identityKeyFor(name),
    });
    if (result === 'room-full') throw new Error('unreachable');
    return result;
  }

  it('retains the member: stamped, fanned out as participant — never a left', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const owner = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (owner === 'room-full') throw new Error('unreachable');
    const sam = joinNamed(rooms, new FakeSocket(), 'Sam');
    rooms.position('CODE1', sam.id, fix(50));

    const state = rooms.disconnect('CODE1', sam.id);
    expect(a.ofType('left')).toHaveLength(0);
    const update = a.ofType('participant').at(-1)!['participant'] as Record<string, unknown>;
    expect(update).toMatchObject({
      id: sam.id,
      name: 'Sam',
      disconnectedAt: expect.any(String),
      position: { lat: fix(50).lat },
    });

    // A late joiner still sees them — greyed, at their last position.
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    const ghost = late.roster.find((entry) => entry.id === sam.id)!;
    expect(ghost).toMatchObject({ name: 'Sam', disconnectedAt: expect.any(String) });
    expect(ghost.position!.lat).toBeCloseTo(fix(50).lat, 10);

    // And the returned durable state carries the snapshot — identity and
    // whereabouts only, no trail, no markers.
    expect(state!.participants).toMatchObject([
      { id: sam.id, name: 'Sam', owner: false, disconnectedAt: expect.any(String) },
    ]);
    expect('trail' in state!.participants[0]!).toBe(false);
    rooms.stop();
  });

  it('drops the room with the last live connection, returning the state that outlives it', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const solo = rooms.join('CODE1', a, { name: 'Stu', owner: true, share: true, expiresAt: soon() });
    if (solo === 'room-full') throw new Error('unreachable');
    rooms.position('CODE1', solo.id, fix(10));

    const state = rooms.disconnect('CODE1', solo.id);
    // The room is gone from memory — the snapshot in `state` is all that
    // remains, which is exactly why disconnect() computes it itself.
    expect(rooms.size('CODE1')).toBe(0);
    expect(rooms.liveState('CODE1')).toBeUndefined();
    expect(state!.participants).toMatchObject([
      { name: 'Stu', owner: true, disconnectedAt: expect.any(String) },
    ]);
    expect(state!.participants[0]!.position!.lat).toBeCloseTo(fix(10).lat, 10);
    rooms.stop();
  });

  it('merges a reconnect of the same named identity: one entry, connected', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const owner = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (owner === 'room-full') throw new Error('unreachable');
    const sam = joinNamed(rooms, new FakeSocket(), 'Sam');
    rooms.disconnect('CODE1', sam.id);

    const back = joinNamed(rooms, new FakeSocket(), 'Sam');
    // The old entry went with a GENUINE left — this is removal, not a drop.
    expect(a.ofType('left').at(-1)).toMatchObject({ participantId: sam.id });
    // The returning Sam's own welcome holds no ghost of themselves.
    expect(back.roster.some((entry) => entry.name === 'Sam')).toBe(false);
    // The roster holds exactly one Sam, connected.
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    const sams = late.roster.filter((entry) => entry.name === 'Sam');
    expect(sams).toHaveLength(1);
    expect(sams[0]!.id).toBe(back.id);
    expect(sams[0]!.disconnectedAt).toBeUndefined();
    rooms.stop();
  });

  it('never merges away a still-connected same-name member, and anon never merges', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const owner = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (owner === 'room-full') throw new Error('unreachable');

    // Two CONNECTED Sams stand — superseding on a guessable name would let
    // anyone kick anyone (posture pinned at the route level too).
    const sam = joinNamed(rooms, new FakeSocket(), 'Sam');
    joinNamed(rooms, new FakeSocket(), 'Sam');
    expect(a.ofType('left')).toHaveLength(0);
    expect(rooms.size('CODE1')).toBe(3);

    // Two disconnected ANONYMOUS entries accumulate — strangers, not one
    // person reconnecting.
    for (let i = 0; i < 2; i += 1) {
      const anon = rooms.join('CODE1', new FakeSocket(), {
        owner: false,
        share: true,
        expiresAt: soon(),
        identity: 'anon',
      });
      if (anon === 'room-full') throw new Error('unreachable');
      rooms.disconnect('CODE1', anon.id);
    }
    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.roster.filter((entry) => entry.disconnectedAt !== undefined)).toHaveLength(2);
    void sam;
    rooms.stop();
  });

  it('caps retained disconnected members, evicting the oldest with a left', () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const owner = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon() });
    if (owner === 'room-full') throw new Error('unreachable');

    const churned: string[] = [];
    for (let i = 0; i < MAX_DISCONNECTED_RETAINED + 3; i += 1) {
      const anon = rooms.join('CODE1', new FakeSocket(), {
        owner: false,
        share: true,
        expiresAt: soon(),
        identity: 'anon',
      });
      if (anon === 'room-full') throw new Error('unreachable');
      churned.push(anon.id);
      rooms.disconnect('CODE1', anon.id);
    }

    // The three oldest were evicted, each with a genuine left.
    expect(a.ofType('left').map((frame) => frame['participantId'])).toEqual(churned.slice(0, 3));
    const state = rooms.liveState('CODE1')!;
    expect(state.participants).toHaveLength(MAX_DISCONNECTED_RETAINED);
    expect(state.participants[0]!.id).toBe(churned[3]);

    // Ghosts hold a roster place, not a seat: a full cap of them still
    // leaves every live seat open.
    const seated = rooms.join('CODE1', new FakeSocket(), { owner: false, share: true, expiresAt: soon() });
    expect(seated).not.toBe('room-full');
    rooms.stop();
  });

  it('rehydrates persisted snapshots as disconnected roster entries a reconnect can merge', () => {
    const rooms = new LiveRooms();
    const now = new Date().toISOString();
    const ghost = {
      id: 'ghost1',
      name: 'Sam',
      owner: false,
      position: fix(50),
      joinedAt: now,
      lastSeenAt: now,
      disconnectedAt: now,
      updatedAt: now,
    };
    const hydrate: LiveRoomState = {
      zones: [],
      chat: [],
      events: [],
      reachedMarkerIds: [],
      seenIdentities: ['n:Sam'],
      participants: [ghost],
    };

    const a = new FakeSocket();
    const owner = rooms.join('CODE1', a, { owner: true, share: true, expiresAt: soon(), hydrate });
    if (owner === 'room-full') throw new Error('unreachable');
    expect(owner.roster).toMatchObject([{ id: 'ghost1', name: 'Sam', disconnectedAt: now }]);

    // Sam comes back: the rehydrated ghost merges away like a live one, and
    // the identity was already seen — a reconnect, not news.
    const back = joinNamed(rooms, new FakeSocket(), 'Sam');
    expect(back.announce).toBe(false);
    expect(a.ofType('left').at(-1)).toMatchObject({ participantId: 'ghost1' });
    expect(back.roster.some((entry) => entry.id === 'ghost1')).toBe(false);
    rooms.stop();
  });

  it("composes with owner supersession: the owner's ghost goes once, by the owner path", () => {
    const rooms = new LiveRooms();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const first = rooms.join('CODE1', a, { name: 'Stu', owner: true, share: true, expiresAt: soon() });
    if (first === 'room-full') throw new Error('unreachable');
    const friend = joinNamed(rooms, b, 'Sam');
    void friend;

    // The owner's phone drops: retained like anyone else's.
    rooms.disconnect('CODE1', first.id);
    expect((b.ofType('participant').at(-1)!['participant'] as Record<string, unknown>)['disconnectedAt']).toEqual(
      expect.any(String),
    );

    // The owner reconnects: supersession takes the ghost — exactly one
    // left, exactly one owner standing. The identity merge cannot also
    // fire: an owner hello carries no identity key.
    const again = rooms.join('CODE1', new FakeSocket(), { name: 'Stu', owner: true, share: true, expiresAt: soon() });
    if (again === 'room-full') throw new Error('unreachable');
    expect(b.ofType('left')).toHaveLength(1);
    expect(b.ofType('left')[0]).toMatchObject({ participantId: first.id });

    const late = rooms.join('CODE1', new FakeSocket(), { owner: false, share: false, expiresAt: soon() });
    if (late === 'room-full') throw new Error('unreachable');
    expect(late.roster.filter((entry) => entry.owner)).toHaveLength(1);
    expect(late.roster.find((entry) => entry.owner)!.id).toBe(again.id);
    rooms.stop();
  });

  it('a rehydrated owner ghost is superseded on the owner rejoin — no duplicate Stu', () => {
    const rooms = new LiveRooms();
    const now = new Date().toISOString();
    const hydrate: LiveRoomState = {
      zones: [],
      chat: [],
      events: [],
      reachedMarkerIds: [],
      seenIdentities: [],
      participants: [
        { id: 'og', name: 'Stu', owner: true, joinedAt: now, lastSeenAt: now, disconnectedAt: now, updatedAt: now },
      ],
    };
    const owner = rooms.join('CODE1', new FakeSocket(), {
      name: 'Stu',
      owner: true,
      share: true,
      expiresAt: soon(),
      hydrate,
    });
    if (owner === 'room-full') throw new Error('unreachable');
    // The ghost was removed BEFORE the roster was cut: no double owner.
    expect(owner.roster).toEqual([]);
    rooms.stop();
  });
});
