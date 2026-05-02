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
  HABITS_CACHE_KEY,
  HABITS_PATH,
  fetchActiveHabits,
  partitionAndSortHabits,
  readCachedHabits,
  writeCachedHabits,
  type HabitResponse,
} from './habits';

const PAIRING = {
  url: 'https://brain.local:8000',
  token: 'bearer-xyz',
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

function makeHabit(overrides: Partial<HabitResponse> = {}): HabitResponse {
  return {
    id: overrides.id ?? 'h-1',
    routine_id: overrides.routine_id ?? null,
    title: overrides.title ?? 'Take meds',
    description: overrides.description ?? null,
    status: overrides.status ?? 'active',
    frequency: overrides.frequency ?? 'daily',
    notification_frequency: overrides.notification_frequency ?? 'daily',
    scaffolding_status: overrides.scaffolding_status ?? 'tracking',
    accountable_since: overrides.accountable_since ?? null,
    graduation_window: overrides.graduation_window ?? null,
    graduation_target: overrides.graduation_target ?? null,
    graduation_threshold: overrides.graduation_threshold ?? null,
    friction_score: overrides.friction_score ?? null,
    position: overrides.position ?? null,
    re_scaffold_count: overrides.re_scaffold_count ?? 0,
    last_frequency_changed_at: overrides.last_frequency_changed_at ?? null,
    graduated_at: overrides.graduated_at ?? null,
    current_streak: overrides.current_streak ?? 0,
    best_streak: overrides.best_streak ?? 0,
    last_completed: overrides.last_completed ?? null,
    created_at: overrides.created_at ?? '2026-04-01T12:00:00Z',
    updated_at: overrides.updated_at ?? '2026-04-01T12:00:00Z',
    effective_graduation_params: overrides.effective_graduation_params ?? {
      window_days: 30,
      target_rate: 0.8,
      threshold_days: 5,
      source: 'friction_default',
    },
  };
}

describe('fetchActiveHabits — server contract', () => {
  it('GETs /api/habits/?status=active with bearer auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 }),
    );

    const result = await fetchActiveHabits(PAIRING);

    expect(result).toEqual({ ok: true, items: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url as string).toBe(
      `${PAIRING.url}${HABITS_PATH}?status=active`,
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(init?.method).toBe('GET');
  });

  it('parses HabitListResponse items array', async () => {
    const habit = makeHabit({ id: 'h-42', title: 'Meditate' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [habit], count: 1 }), { status: 200 }),
    );

    const result = await fetchActiveHabits(PAIRING);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe('h-42');
    }
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchActiveHabits(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'unauthorized', statusCode: 401 });
  });

  it('returns server error for non-200/401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );
    const result = await fetchActiveHabits(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'server', statusCode: 500 });
  });

  it('returns network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const result = await fetchActiveHabits(PAIRING);
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('strips trailing slash from server url', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], count: 0 }), { status: 200 }),
    );
    await fetchActiveHabits({ url: 'https://brain.local:8000/', token: 't' });
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url as string).toBe(
      `https://brain.local:8000${HABITS_PATH}?status=active`,
    );
  });
});

describe('readCachedHabits / writeCachedHabits', () => {
  it('round-trips through Preferences with the configured cache key', async () => {
    const habit = makeHabit({ id: 'h-1' });
    const now = new Date('2026-05-02T12:00:00Z');

    await writeCachedHabits([habit], now);
    const cached = await readCachedHabits();

    expect(cached).not.toBeNull();
    expect(cached?.fetched_at).toBe(now.toISOString());
    expect(cached?.items).toEqual([habit]);
    expect(prefsStore.has(HABITS_CACHE_KEY)).toBe(true);
  });

  it('returns null when no cache exists', async () => {
    expect(await readCachedHabits()).toBeNull();
  });

  it('returns null on malformed cache JSON', async () => {
    prefsStore.set(HABITS_CACHE_KEY, '{ not json');
    expect(await readCachedHabits()).toBeNull();
  });

  it('returns null when cache is missing required keys', async () => {
    prefsStore.set(HABITS_CACHE_KEY, JSON.stringify({ items: [] }));
    expect(await readCachedHabits()).toBeNull();
  });
});

describe('partitionAndSortHabits — sort contract', () => {
  it('splits graduated from primary by scaffolding_status', () => {
    const tracking = makeHabit({ id: 't', scaffolding_status: 'tracking' });
    const accountable = makeHabit({
      id: 'a',
      scaffolding_status: 'accountable',
    });
    const graduated = makeHabit({
      id: 'g',
      scaffolding_status: 'graduated',
      graduated_at: '2026-04-01T00:00:00Z',
    });

    const result = partitionAndSortHabits([graduated, tracking, accountable]);

    expect(result.primary.map((h) => h.id).sort()).toEqual(['a', 't']);
    expect(result.graduated.map((h) => h.id)).toEqual(['g']);
  });

  it('sorts primary by current_streak DESC, then last_completed DESC nulls last, then title ASC', () => {
    const items = [
      makeHabit({
        id: 'low-streak-recent',
        title: 'Z low streak recent',
        current_streak: 1,
        last_completed: '2026-05-01',
      }),
      makeHabit({
        id: 'high-streak',
        title: 'M high streak',
        current_streak: 10,
        last_completed: '2026-04-30',
      }),
      makeHabit({
        id: 'mid-streak-no-last',
        title: 'A mid streak no last',
        current_streak: 5,
        last_completed: null,
      }),
      makeHabit({
        id: 'mid-streak-with-last',
        title: 'B mid streak with last',
        current_streak: 5,
        last_completed: '2026-04-29',
      }),
      makeHabit({
        id: 'mid-streak-tied',
        title: 'A mid streak tied',
        current_streak: 5,
        last_completed: '2026-04-29',
      }),
    ];

    const result = partitionAndSortHabits(items);
    const ids = result.primary.map((h) => h.id);

    expect(ids[0]).toBe('high-streak');
    expect(ids[1]).toBe('mid-streak-tied');
    expect(ids[2]).toBe('mid-streak-with-last');
    expect(ids[3]).toBe('mid-streak-no-last');
    expect(ids[4]).toBe('low-streak-recent');
  });

  it('sorts graduated section by graduated_at DESC', () => {
    const newer = makeHabit({
      id: 'newer',
      scaffolding_status: 'graduated',
      graduated_at: '2026-04-15T00:00:00Z',
    });
    const older = makeHabit({
      id: 'older',
      scaffolding_status: 'graduated',
      graduated_at: '2026-03-01T00:00:00Z',
    });
    const middle = makeHabit({
      id: 'middle',
      scaffolding_status: 'graduated',
      graduated_at: '2026-04-01T00:00:00Z',
    });

    const result = partitionAndSortHabits([older, newer, middle]);
    expect(result.graduated.map((h) => h.id)).toEqual([
      'newer',
      'middle',
      'older',
    ]);
  });
});
