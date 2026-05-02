import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { Preferences } from '@capacitor/preferences';
import {
  ROUTINES_CACHE_KEY,
  ROUTINES_PATH,
  fetchActiveRoutines,
  fetchRoutine,
  readCachedRoutines,
  sortRoutinesByTitle,
  writeCachedRoutines,
  type RoutineResponse,
} from './routines';

const PAIRING = {
  url: 'https://brain.local:8000',
  token: 'bearer-routine',
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

describe('fetchRoutine', () => {
  it('GETs /api/routines/{id} with bearer auth and returns the routine', async () => {
    const routine = { id: 'r-1', title: 'Morning kit' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(routine), { status: 200 }),
    );

    const result = await fetchRoutine(PAIRING, 'r-1');

    expect(result).toEqual({ ok: true, routine });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url as string).toBe(`${PAIRING.url}${ROUTINES_PATH}r-1`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(init?.method).toBe('GET');
  });

  it('returns not_found on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404 }),
    );
    const result = await fetchRoutine(PAIRING, 'missing');
    expect(result).toEqual({ ok: false, reason: 'not_found', statusCode: 404 });
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchRoutine(PAIRING, 'r-1');
    expect(result).toEqual({ ok: false, reason: 'unauthorized', statusCode: 401 });
  });

  it('returns network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('disconnected'));
    const result = await fetchRoutine(PAIRING, 'r-1');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});

describe('fetchActiveRoutines', () => {
  it('GETs /api/routines/?status=active and returns the items array', async () => {
    const items: RoutineResponse[] = [
      {
        id: 'r-1',
        title: 'Morning kit',
        frequency: 'daily',
        status: 'active',
        current_streak: 3,
        best_streak: 7,
        last_completed: '2026-05-01',
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items, count: items.length }), { status: 200 }),
    );

    const result = await fetchActiveRoutines(PAIRING);

    expect(result).toEqual({ ok: true, items });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url as string).toBe(`${PAIRING.url}${ROUTINES_PATH}?status=active`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(init?.method).toBe('GET');
  });

  it('returns an empty list when the response body is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );
    const result = await fetchActiveRoutines(PAIRING);
    expect(result).toEqual({ ok: true, items: [] });
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchActiveRoutines(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'unauthorized', statusCode: 401 });
  });

  it('returns server on 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );
    const result = await fetchActiveRoutines(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'server', statusCode: 500 });
  });

  it('returns network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('disconnected'));
    const result = await fetchActiveRoutines(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});

describe('readCachedRoutines / writeCachedRoutines', () => {
  it('round-trips items + fetched_at through Capacitor Preferences', async () => {
    const items: RoutineResponse[] = [{ id: 'r-1', title: 'Morning kit' }];
    const now = new Date('2026-05-02T10:00:00Z');

    await writeCachedRoutines(items, now);
    const read = await readCachedRoutines();

    expect(read).toEqual({ fetched_at: now.toISOString(), items });
    expect(prefsStore.get(ROUTINES_CACHE_KEY)).toBeDefined();
  });

  it('returns null when nothing has been cached', async () => {
    const read = await readCachedRoutines();
    expect(read).toBeNull();
  });

  it('returns null when the cache is malformed', async () => {
    prefsStore.set(ROUTINES_CACHE_KEY, '{ this is not valid json');
    const read = await readCachedRoutines();
    expect(read).toBeNull();
  });

  it('returns null when the cache is missing required fields', async () => {
    prefsStore.set(ROUTINES_CACHE_KEY, JSON.stringify({ items: [] }));
    const read = await readCachedRoutines();
    expect(read).toBeNull();
  });
});

describe('sortRoutinesByTitle', () => {
  it('returns a new array sorted alphabetically by title (locale-aware)', () => {
    const items: RoutineResponse[] = [
      { id: '1', title: 'Wind-down' },
      { id: '2', title: 'Morning kit' },
      { id: '3', title: 'Evening reset' },
    ];

    const sorted = sortRoutinesByTitle(items);

    expect(sorted.map((r) => r.title)).toEqual([
      'Evening reset',
      'Morning kit',
      'Wind-down',
    ]);
    // Pure: input array is not mutated.
    expect(items.map((r) => r.title)).toEqual([
      'Wind-down',
      'Morning kit',
      'Evening reset',
    ]);
  });

  it('handles an empty list', () => {
    expect(sortRoutinesByTitle([])).toEqual([]);
  });
});
