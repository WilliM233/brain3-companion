import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { Preferences } from '@capacitor/preferences';
import {
  CHECKINS_CACHE_KEY,
  CHECKINS_PATH,
  composeNumericSubtitle,
  fetchCheckin,
  fetchCheckins,
  formatRelativeLoggedAt,
  friendlyCheckinTypeLabel,
  readCachedCheckins,
  thirtyDaysAgoLocalMidnightUtc,
  truncateFreeformPreview,
  writeCachedCheckins,
  type CheckinResponse,
} from './checkins';
import type { Pairing } from './pairing';

const PAIRING: Pairing = { url: 'https://brain.local:8000', token: 'tk-1' };

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

function makeCheckin(overrides: Partial<CheckinResponse> = {}): CheckinResponse {
  return {
    id: overrides.id ?? 'c-1',
    checkin_type: overrides.checkin_type ?? 'morning',
    energy_level: overrides.energy_level ?? null,
    mood: overrides.mood ?? null,
    focus_level: overrides.focus_level ?? null,
    freeform_note: overrides.freeform_note ?? null,
    context: overrides.context ?? null,
    logged_at: overrides.logged_at ?? '2026-05-09T08:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// thirtyDaysAgoLocalMidnightUtc
// ---------------------------------------------------------------------------

describe('thirtyDaysAgoLocalMidnightUtc', () => {
  it('returns local midnight 30 days before the supplied now', () => {
    // 2026-05-09 12:34 local — 30 days back at local midnight = 2026-04-09 00:00 local.
    const now = new Date(2026, 4, 9, 12, 34, 0);
    const result = thirtyDaysAgoLocalMidnightUtc(now);
    const parsed = new Date(result);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(9);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchCheckins (list)
// ---------------------------------------------------------------------------

describe('fetchCheckins', () => {
  it('calls the list endpoint with logged_after derived from now', async () => {
    const now = new Date(2026, 4, 9, 12, 0, 0);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await fetchCheckins(PAIRING, now);

    const callUrl = (fetchSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(callUrl.startsWith(`${PAIRING.url}${CHECKINS_PATH}`)).toBe(true);
    expect(callUrl).toContain('logged_after=');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer tk-1' });
  });

  it('parses a bare-array body into items', async () => {
    const items = [makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' })];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(items), { status: 200 }),
    );

    const result = await fetchCheckins(PAIRING);
    expect(result).toEqual({ ok: true, items });
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchCheckins(PAIRING);
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      statusCode: 401,
    });
  });

  it('returns server error on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );
    const result = await fetchCheckins(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'server', statusCode: 500 });
  });

  it('returns network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await fetchCheckins(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('treats a non-array body as empty items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );
    const result = await fetchCheckins(PAIRING);
    expect(result).toEqual({ ok: true, items: [] });
  });
});

// ---------------------------------------------------------------------------
// fetchCheckin (single)
// ---------------------------------------------------------------------------

describe('fetchCheckin', () => {
  it('returns the parsed body on 200', async () => {
    const checkin = makeCheckin({ id: 'c-9' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(checkin), { status: 200 }),
    );

    const result = await fetchCheckin(PAIRING, 'c-9');
    expect(result).toEqual({ ok: true, checkin });
  });

  it('returns not_found on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404 }),
    );
    const result = await fetchCheckin(PAIRING, 'missing');
    expect(result).toEqual({
      ok: false,
      reason: 'not_found',
      statusCode: 404,
    });
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchCheckin(PAIRING, 'c-1');
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      statusCode: 401,
    });
  });
});

// ---------------------------------------------------------------------------
// cache read/write
// ---------------------------------------------------------------------------

describe('checkins cache', () => {
  it('readCachedCheckins returns null when nothing is stored', async () => {
    const cached = await readCachedCheckins();
    expect(cached).toBeNull();
  });

  it('round-trips items through writeCachedCheckins / readCachedCheckins', async () => {
    const items = [makeCheckin({ id: 'r-1' })];
    await writeCachedCheckins(items, new Date('2026-05-09T08:00:00Z'));
    const cached = await readCachedCheckins();
    expect(cached).toEqual({
      fetched_at: '2026-05-09T08:00:00.000Z',
      items,
    });
    expect(prefsStore.has(CHECKINS_CACHE_KEY)).toBe(true);
  });

  it('readCachedCheckins returns null on malformed JSON', async () => {
    prefsStore.set(CHECKINS_CACHE_KEY, '{not-json');
    const cached = await readCachedCheckins();
    expect(cached).toBeNull();
  });

  it('readCachedCheckins returns null when shape is wrong', async () => {
    prefsStore.set(CHECKINS_CACHE_KEY, JSON.stringify({ items: 'oops' }));
    const cached = await readCachedCheckins();
    expect(cached).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// presentation helpers
// ---------------------------------------------------------------------------

describe('friendlyCheckinTypeLabel', () => {
  it('maps each enum value to a friendly label', () => {
    expect(friendlyCheckinTypeLabel('morning')).toBe('Morning check-in');
    expect(friendlyCheckinTypeLabel('midday')).toBe('Midday check-in');
    expect(friendlyCheckinTypeLabel('evening')).toBe('Evening check-in');
    expect(friendlyCheckinTypeLabel('micro')).toBe('Micro check-in');
    expect(friendlyCheckinTypeLabel('freeform')).toBe('Freeform check-in');
  });
});

describe('composeNumericSubtitle', () => {
  it('returns null when all numeric values are null', () => {
    expect(
      composeNumericSubtitle({
        energy_level: null,
        focus_level: null,
        mood: null,
      }),
    ).toBeNull();
  });

  it('orders parts as Energy · Focus · Mood', () => {
    expect(
      composeNumericSubtitle({
        energy_level: 4,
        focus_level: 3,
        mood: 5,
      }),
    ).toBe('Energy 4 · Focus 3 · Mood 5');
  });

  it('omits null fields', () => {
    expect(
      composeNumericSubtitle({
        energy_level: null,
        focus_level: 2,
        mood: 5,
      }),
    ).toBe('Focus 2 · Mood 5');
  });
});

describe('truncateFreeformPreview', () => {
  it('returns short notes verbatim', () => {
    expect(truncateFreeformPreview('hello')).toBe('hello');
  });

  it('truncates with ellipsis at 60 chars', () => {
    const note = 'x'.repeat(75);
    const out = truncateFreeformPreview(note);
    expect(out.length).toBe(61); // 60 chars + ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(60))).toBe(true);
  });

  it('does not truncate when length === 60', () => {
    const note = 'y'.repeat(60);
    expect(truncateFreeformPreview(note)).toBe(note);
  });
});

describe('formatRelativeLoggedAt', () => {
  const NOW = new Date('2026-05-09T12:00:00Z');

  it('renders "just now" for sub-minute deltas', () => {
    expect(formatRelativeLoggedAt('2026-05-09T11:59:30Z', NOW)).toBe('just now');
  });

  it('renders minutes for sub-hour deltas', () => {
    expect(formatRelativeLoggedAt('2026-05-09T11:45:00Z', NOW)).toBe('15m ago');
  });

  it('renders hours for sub-day deltas', () => {
    expect(formatRelativeLoggedAt('2026-05-09T10:00:00Z', NOW)).toBe('2h ago');
  });

  it('renders "yesterday" for ~1 day', () => {
    expect(formatRelativeLoggedAt('2026-05-08T12:00:00Z', NOW)).toBe(
      'yesterday',
    );
  });

  it('renders multi-day deltas with d suffix', () => {
    expect(formatRelativeLoggedAt('2026-05-06T12:00:00Z', NOW)).toBe('3d ago');
  });

  it('returns the raw string on parse failure', () => {
    expect(formatRelativeLoggedAt('not-a-date', NOW)).toBe('not-a-date');
  });
});
