import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  MemoryPushStore,
  PushService,
  PushThrottle,
  VAPID_SUBJECT,
  parsePushSubscription,
  type PushSubscriptionRecord,
  type WebPushLike,
} from '../src/push.js';
import { sleep } from './helpers.js';

/**
 * The push machinery, with web-push replaced by a recorder: VAPID resolution
 * (env wins; otherwise generated once and persisted for every later boot),
 * sends that swallow per-endpoint failures, and the T-minus-5 expiry warning.
 */

function sub(n: number): PushSubscriptionRecord {
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
  };
}

/** A web-push that remembers instead of sending. */
class FakeSender implements WebPushLike {
  generated = 0;
  sent: Array<{ endpoint: string; payload: Record<string, unknown>; subject: string }> = [];
  failFor = new Set<string>();

  generateVAPIDKeys() {
    this.generated += 1;
    return { publicKey: `pub-${this.generated}`, privateKey: `priv-${this.generated}` };
  }

  async sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } },
  ): Promise<unknown> {
    if (this.failFor.has(subscription.endpoint)) throw new Error('410 Gone');
    this.sent.push({
      endpoint: subscription.endpoint,
      payload: JSON.parse(payload) as Record<string, unknown>,
      subject: options.vapidDetails.subject,
    });
    return {};
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parsePushSubscription', () => {
  it('accepts a standard PushSubscription and strips extras', () => {
    const parsed = parsePushSubscription({
      endpoint: 'https://push.example/abc',
      expirationTime: null,
      keys: { p256dh: 'k1', auth: 'k2' },
    });
    expect(parsed).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'k1', auth: 'k2' } });
  });

  it.each([
    ['not an object', 'hello'],
    ['no endpoint', { keys: { p256dh: 'a', auth: 'b' } }],
    ['non-URL endpoint', { endpoint: 'not a url', keys: { p256dh: 'a', auth: 'b' } }],
    ['http endpoint', { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }],
    ['oversized endpoint', { endpoint: `https://push.example/${'x'.repeat(2100)}`, keys: { p256dh: 'a', auth: 'b' } }],
    ['no keys', { endpoint: 'https://push.example/x' }],
    ['missing auth', { endpoint: 'https://push.example/x', keys: { p256dh: 'a' } }],
    ['empty p256dh', { endpoint: 'https://push.example/x', keys: { p256dh: '', auth: 'b' } }],
    ['oversized p256dh', { endpoint: 'https://push.example/x', keys: { p256dh: 'a'.repeat(300), auth: 'b' } }],
    ['oversized auth', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b'.repeat(200) } }],
  ])('rejects %s', (_label, input) => {
    expect(parsePushSubscription(input)).toBeUndefined();
  });
});

describe('MemoryPushStore', () => {
  it('caps subscriptions per session, silently, deduplicating by endpoint', async () => {
    const store = new MemoryPushStore();
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 5; i++) {
      await store.addSubscription('CODE1', sub(i), 60_000);
    }
    expect(await store.listSubscriptions('CODE1')).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);

    // Re-adding an endpoint already inside the cap is not "beyond the cap".
    await store.addSubscription('CODE1', sub(0), 60_000);
    expect(await store.listSubscriptions('CODE1')).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
  });

  it('expires subscriptions with their TTL, and extendTo lengthens it', async () => {
    vi.useFakeTimers();
    const store = new MemoryPushStore();
    await store.addSubscription('DIES', sub(1), 1_000);
    await store.addSubscription('LIVES', sub(2), 1_000);
    await store.extendTo('LIVES', 10_000);

    vi.advanceTimersByTime(1_500);
    expect(await store.listSubscriptions('DIES')).toHaveLength(0);
    expect(await store.listSubscriptions('LIVES')).toHaveLength(1);
  });
});

describe('PushService VAPID keys', () => {
  it('lets the environment win outright — nothing generated, nothing stored', async () => {
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'env-pub', privateKey: 'env-priv' });
    expect(await service.publicKey()).toBe('env-pub');
    expect(sender.generated).toBe(0);
  });

  it('generates once on first need and reuses the persisted pair across boots', async () => {
    const sender = new FakeSender();
    const store = new MemoryPushStore(); // stands in for the Redis the boots share
    const boot1 = new PushService(store, { sender });
    const boot2 = new PushService(store, { sender });

    const key1 = await boot1.publicKey();
    const key2 = await boot2.publicKey();
    expect(key1).toBe(key2);
    // boot2 generated a candidate but the store's first-writer won.
    expect(sender.generated).toBe(2);
    expect(key1).toBe('pub-1');
  });
});

describe('PushService.sendToSession', () => {
  it('sends the generic payload to every subscription with the URL subject', async () => {
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'p', privateKey: 's' });
    await store.addSubscription('CODE1', sub(1), 60_000);
    await store.addSubscription('CODE1', sub(2), 60_000);

    await service.sendToSession('CODE1', { title: 'whereareyou', body: 'ping' });

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]!.payload).toEqual({ title: 'whereareyou', body: 'ping' });
    expect(sender.sent[0]!.subject).toBe(VAPID_SUBJECT);
  });

  it('swallows a failing endpoint and still reaches the rest', async () => {
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'p', privateKey: 's' });
    await store.addSubscription('CODE1', sub(1), 60_000);
    await store.addSubscription('CODE1', sub(2), 60_000);
    sender.failFor.add(sub(1).endpoint);

    await expect(
      service.sendToSession('CODE1', { title: 'whereareyou', body: 'ping' }),
    ).resolves.toBeUndefined();
    expect(sender.sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint]);
  });

  it('does nothing at all for a session with no subscriptions', async () => {
    const sender = new FakeSender();
    const service = new PushService(new MemoryPushStore(), { sender, publicKey: 'p', privateKey: 's' });
    await service.sendToSession('NOBODY', { title: 'whereareyou', body: 'ping' });
    expect(sender.sent).toHaveLength(0);
  });
});

describe('PushService.armExpiryWarning', () => {
  it('fires exactly five minutes before expiry', async () => {
    vi.useFakeTimers();
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'p', privateKey: 's' });
    await store.addSubscription('CODE1', sub(1), 60 * 60_000);

    service.armExpiryWarning('CODE1', Date.now() + 10 * 60_000);

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(sender.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.payload).toEqual({
      title: 'whereareyou',
      body: 'Your share expires in 5 minutes.',
    });
    service.stop();
  });

  it('skips entirely when less than five minutes remain', async () => {
    vi.useFakeTimers();
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'p', privateKey: 's' });
    await store.addSubscription('CODE1', sub(1), 60 * 60_000);

    service.armExpiryWarning('CODE1', Date.now() + 3 * 60_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sender.sent).toHaveLength(0);
    service.stop();
  });

  it('re-arming replaces the previous timer instead of stacking a second one', async () => {
    vi.useFakeTimers();
    const sender = new FakeSender();
    const store = new MemoryPushStore();
    const service = new PushService(store, { sender, publicKey: 'p', privateKey: 's' });
    await store.addSubscription('CODE1', sub(1), 120 * 60_000);

    service.armExpiryWarning('CODE1', Date.now() + 10 * 60_000);
    service.armExpiryWarning('CODE1', Date.now() + 60 * 60_000); // session extended

    // The original T-5 moment passes silently…
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(sender.sent).toHaveLength(0);
    // …and the re-armed one fires.
    await vi.advanceTimersByTimeAsync(36 * 60_000);
    expect(sender.sent).toHaveLength(1);
    service.stop();
  });
});

describe('PushThrottle', () => {
  it('allows one push per session per trigger kind per window — each axis independent', async () => {
    const throttle = new PushThrottle(60);
    expect(throttle.allow('CODE1', 'chat')).toBe(true);
    expect(throttle.allow('CODE1', 'chat')).toBe(false); // same session, same kind
    expect(throttle.allow('CODE1', 'joined')).toBe(true); // another kind is its own budget
    expect(throttle.allow('CODE2', 'chat')).toBe(true); // another session too

    await sleep(80); // the window passes
    expect(throttle.allow('CODE1', 'chat')).toBe(true);
  });
});
