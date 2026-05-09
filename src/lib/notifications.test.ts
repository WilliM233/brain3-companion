import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import {
  NOTIFICATIONS_CACHE_KEY,
  NOTIFICATIONS_PATH,
  fetchNotifications,
  partitionNotifications,
  readCachedNotifications,
  writeCachedNotifications,
  type NotificationItem,
} from './notifications';

const PAIRING = {
  url: 'https://brain.local:8000',
  token: 'bearer-abc-123',
} as const;

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefsStore.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeItem(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: overrides.id ?? 'n-1',
    notification_type: overrides.notification_type ?? 'habit_reminder',
    message: overrides.message ?? 'Take your meds',
    scheduled_at: overrides.scheduled_at ?? '2026-04-28T13:00:00Z',
    scheduled_date: overrides.scheduled_date ?? '2026-04-28',
    status: overrides.status ?? 'pending',
    expires_at: overrides.expires_at ?? '2026-04-28T15:00:00Z',
    response: overrides.response ?? null,
  };
}

describe('fetchNotifications — server contract', () => {
  it('GETs /api/notifications/ with bearer auth and a scheduled_after window', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 }),
      );

    const now = new Date(2026, 3, 28, 14, 0); // 2026-04-28 14:00 local
    const result = await fetchNotifications(PAIRING, now);

    expect(result).toEqual({ ok: true, items: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(typeof url).toBe('string');
    expect(url as string).toContain(`${PAIRING.url}${NOTIFICATIONS_PATH}`);
    expect(url as string).toContain('scheduled_after=');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bearer-abc-123');
    expect(init?.method).toBe('GET');
  });

  it('strips a trailing slash from pairing.url', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 }),
      );

    await fetchNotifications(
      { url: 'https://brain.local:8000/', token: 'tok' },
      new Date(2026, 3, 28),
    );

    const [url] = fetchSpy.mock.calls[0]!;
    expect((url as string).startsWith('https://brain.local:8000/api/notifications/')).toBe(true);
    expect((url as string).startsWith('https://brain.local:8000//api/notifications/')).toBe(false);
  });

  it('unwraps {items, count} envelope from /api/notifications/ on 200', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items, count: 2 }), { status: 200 }),
    );

    const result = await fetchNotifications(PAIRING);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items.map((i) => i.id)).toEqual(['a', 'b']);
    }
  });

  it('returns empty list when the server returns a non-envelope shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('null', { status: 200 }),
    );

    const result = await fetchNotifications(PAIRING);

    expect(result).toEqual({ ok: true, items: [] });
  });

  it('maps 401 to unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    const result = await fetchNotifications(PAIRING);

    expect(result).toEqual({ ok: false, reason: 'unauthorized', statusCode: 401 });
  });

  it('maps non-2xx, non-401 to server with the status code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const result = await fetchNotifications(PAIRING);

    expect(result).toEqual({ ok: false, reason: 'server', statusCode: 503 });
  });

  it('maps fetch rejection to network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    const result = await fetchNotifications(PAIRING);

    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});

describe('partitionNotifications', () => {
  const NOW = new Date(2026, 3, 28, 14, 30); // 2026-04-28 local

  it('places items with scheduled_date == today in the Today section regardless of status', () => {
    const items = [
      makeItem({ id: 'today-pending', scheduled_date: '2026-04-28', status: 'pending' }),
      makeItem({ id: 'today-expired', scheduled_date: '2026-04-28', status: 'expired' }),
      makeItem({ id: 'today-responded', scheduled_date: '2026-04-28', status: 'responded' }),
    ];

    const { today, earlier } = partitionNotifications(items, NOW);

    expect(today.map((i) => i.id).sort()).toEqual([
      'today-expired',
      'today-pending',
      'today-responded',
    ]);
    expect(earlier).toEqual([]);
  });

  it('places yesterday items in Earlier even when expires_at is in the future', () => {
    const items = [
      makeItem({
        id: 'yesterday-not-yet-expired',
        scheduled_date: '2026-04-27',
        status: 'pending',
        expires_at: '2030-01-01T00:00:00Z',
      }),
    ];

    const { today, earlier } = partitionNotifications(items, NOW);

    expect(today).toEqual([]);
    expect(earlier).toHaveLength(1);
    expect(earlier[0]!.date).toBe('2026-04-27');
    expect(earlier[0]!.items.map((i) => i.id)).toEqual(['yesterday-not-yet-expired']);
  });

  it('drops items strictly older than 7 days ago', () => {
    const items = [
      makeItem({ id: 'in-window', scheduled_date: '2026-04-21' }),
      makeItem({ id: 'too-old', scheduled_date: '2026-04-20' }),
    ];

    const { earlier } = partitionNotifications(items, NOW);

    const ids = earlier.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('in-window');
    expect(ids).not.toContain('too-old');
  });

  it('groups Earlier by date newest-first and sorts within group by scheduled_at desc', () => {
    const items = [
      makeItem({ id: '23-am', scheduled_date: '2026-04-23', scheduled_at: '2026-04-23T09:00:00Z' }),
      makeItem({ id: '23-pm', scheduled_date: '2026-04-23', scheduled_at: '2026-04-23T18:00:00Z' }),
      makeItem({ id: '25', scheduled_date: '2026-04-25', scheduled_at: '2026-04-25T12:00:00Z' }),
    ];

    const { earlier } = partitionNotifications(items, NOW);

    expect(earlier.map((g) => g.date)).toEqual(['2026-04-25', '2026-04-23']);
    expect(earlier[1]!.items.map((i) => i.id)).toEqual(['23-pm', '23-am']);
  });

  it('treats scheduled_date as opaque YYYY-MM-DD strings (E5 deterministic anchor)', () => {
    // E5: even if device TZ differs from server TZ, partition is based on the
    // string-equality of scheduled_date against today's local date — no TZ
    // conversion of the field itself.
    const items = [
      makeItem({ id: 'tokyo-today', scheduled_date: '2026-04-28' }),
    ];

    const { today } = partitionNotifications(items, NOW);

    expect(today.map((i) => i.id)).toEqual(['tokyo-today']);
  });
});

describe('notifications cache (Preferences-backed)', () => {
  it('returns null when no cache exists', async () => {
    const result = await readCachedNotifications();
    expect(result).toBeNull();
  });

  it('roundtrips items + fetched_at through Preferences', async () => {
    const now = new Date(2026, 3, 28, 14, 0);
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];

    await writeCachedNotifications(items, now);
    const result = await readCachedNotifications();

    expect(result).not.toBeNull();
    expect(result!.fetched_at).toBe(now.toISOString());
    expect(result!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(prefsStore.get(NOTIFICATIONS_CACHE_KEY)).toBeDefined();
  });

  it('returns null on malformed cache (treats as empty rather than throwing)', async () => {
    prefsStore.set(NOTIFICATIONS_CACHE_KEY, 'not-json');

    const result = await readCachedNotifications();

    expect(result).toBeNull();
  });

  it('returns null when payload is missing required fields', async () => {
    prefsStore.set(NOTIFICATIONS_CACHE_KEY, JSON.stringify({ items: [] }));

    const result = await readCachedNotifications();

    expect(result).toBeNull();
  });
});
