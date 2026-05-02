import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { Preferences } from '@capacitor/preferences';
import {
  fetchHabitDetail,
  fetchHabitGraduationStatus,
  fetchHabitCompletions,
  patchHabitStatus,
  postReScaffold,
  postStepDownFrequency,
  readCachedHabitDetail,
  readCachedGraduationStatus,
  writeCachedHabitDetail,
  writeCachedGraduationStatus,
  habitDetailCacheKey,
  habitGraduationCacheKey,
  type GraduationStatusResponse,
  type HabitDetailResponse,
} from './habit-detail';

const PAIRING = { url: 'https://brain.local:8000', token: 'tk-1' };
const HABIT_ID = 'h-1';

const prefs = new Map<string, string>();

beforeEach(() => {
  prefs.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefs.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefs.set(key, value);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface StubResponse {
  status?: number;
  body?: unknown;
}

function stubFetch(response: StubResponse): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      response.body !== undefined ? JSON.stringify(response.body) : '',
      { status: response.status ?? 200 },
    ),
  );
}

describe('fetchHabitDetail', () => {
  it('returns ok+habit on 200', async () => {
    const habit: HabitDetailResponse = {
      id: HABIT_ID,
      routine_id: null,
      title: 'Read',
      description: null,
      status: 'active',
      frequency: 'daily',
      notification_frequency: 'daily',
      scaffolding_status: 'tracking',
      accountable_since: null,
      graduation_window: null,
      graduation_target: null,
      graduation_threshold: null,
      friction_score: null,
      position: null,
      re_scaffold_count: 0,
      last_frequency_changed_at: null,
      graduated_at: null,
      current_streak: 0,
      best_streak: 0,
      last_completed: null,
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
      effective_graduation_params: {
        window_days: 30,
        target_rate: 0.8,
        threshold_days: 5,
        source: 'friction_default',
      },
      routine: null,
    };
    stubFetch({ status: 200, body: habit });

    const result = await fetchHabitDetail(PAIRING, HABIT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.habit.id).toBe(HABIT_ID);
    }
  });

  it('returns not_found on 404', async () => {
    stubFetch({ status: 404 });
    const result = await fetchHabitDetail(PAIRING, HABIT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  it('returns unauthorized on 401', async () => {
    stubFetch({ status: 401 });
    const result = await fetchHabitDetail(PAIRING, HABIT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
    }
  });
});

describe('fetchHabitGraduationStatus', () => {
  it('returns ok+status on 200', async () => {
    const status: GraduationStatusResponse = {
      habit_id: HABIT_ID,
      habit_name: 'Read',
      scaffolding_status: 'tracking',
      notification_frequency: 'daily',
      friction_score: null,
      re_scaffold_count: 0,
      accountable_since: null,
      days_accountable: 0,
      graduation_params: {
        window_days: 30,
        target_rate: 0.8,
        threshold_days: 5,
        source: 'friction_default',
      },
      current_metrics: {
        already_done_rate: 0,
        total_notifications: 0,
        already_done_count: 0,
      },
      progress_summary: 'Habit is in tracking mode.',
      frequency_step_down: {
        eligible: false,
        recommended_frequency: null,
        current_rate_over_recent: 0,
      },
    };
    stubFetch({ status: 200, body: status });

    const result = await fetchHabitGraduationStatus(PAIRING, HABIT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status.habit_id).toBe(HABIT_ID);
    }
  });
});

describe('fetchHabitCompletions', () => {
  it('returns the completions list on 200', async () => {
    stubFetch({
      status: 200,
      body: [
        {
          id: 'c-1',
          habit_id: HABIT_ID,
          completed_at: '2026-05-01',
          source: 'individual',
          notes: null,
          created_at: '2026-05-01T12:00:00Z',
        },
      ],
    });
    const result = await fetchHabitCompletions(PAIRING, HABIT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.completions).toHaveLength(1);
      expect(result.completions[0]?.source).toBe('individual');
    }
  });
});

describe('patchHabitStatus', () => {
  it('PATCHes with the given status and returns ok on 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: HABIT_ID, status: 'paused' }), {
        status: 200,
      }),
    );
    const result = await patchHabitStatus(PAIRING, HABIT_ID, 'paused');
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${PAIRING.url}/api/habits/${HABIT_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'paused' }),
      }),
    );
  });
});

describe('postReScaffold', () => {
  it('returns invalid_state with the server detail on 422', async () => {
    stubFetch({
      status: 422,
      body: { detail: "Habit scaffolding_status is 'tracking', must be 'graduated'" },
    });
    const result = await postReScaffold(PAIRING, HABIT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_state');
      expect(result.detail).toContain("must be 'graduated'");
    }
  });
});

describe('postStepDownFrequency', () => {
  it('returns not_recommended with the nested message on 422', async () => {
    stubFetch({
      status: 422,
      body: {
        detail: {
          message: 'Step-down not recommended',
          evaluation: { recommend_step_down: false },
        },
      },
    });
    const result = await postStepDownFrequency(PAIRING, HABIT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_recommended');
      expect(result.detail).toBe('Step-down not recommended');
    }
  });
});

describe('Capacitor Preferences caches', () => {
  it('writeCachedHabitDetail stores under the per-habit key with fetched_at', async () => {
    await writeCachedHabitDetail(
      HABIT_ID,
      { id: HABIT_ID, routine: null } as unknown as HabitDetailResponse,
      new Date('2026-05-02T12:00:00Z'),
    );
    const stored = prefs.get(habitDetailCacheKey(HABIT_ID));
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.fetched_at).toBe('2026-05-02T12:00:00.000Z');
    expect(parsed.habit.id).toBe(HABIT_ID);
  });

  it('readCachedHabitDetail returns null for malformed payloads', async () => {
    prefs.set(habitDetailCacheKey(HABIT_ID), '{not valid json');
    const result = await readCachedHabitDetail(HABIT_ID);
    expect(result).toBeNull();
  });

  it('writeCachedGraduationStatus + readCachedGraduationStatus round-trip', async () => {
    const status: GraduationStatusResponse = {
      habit_id: HABIT_ID,
      habit_name: 'X',
      scaffolding_status: 'tracking',
      notification_frequency: 'daily',
      friction_score: null,
      re_scaffold_count: 0,
      accountable_since: null,
      days_accountable: 0,
      graduation_params: {
        window_days: 30,
        target_rate: 0.8,
        threshold_days: 5,
        source: 'friction_default',
      },
      current_metrics: {
        already_done_rate: 0,
        total_notifications: 0,
        already_done_count: 0,
      },
      progress_summary: 'Habit is in tracking mode.',
      frequency_step_down: {
        eligible: false,
        recommended_frequency: null,
        current_rate_over_recent: 0,
      },
    };
    await writeCachedGraduationStatus(HABIT_ID, status);
    const cached = await readCachedGraduationStatus(HABIT_ID);
    expect(cached).not.toBeNull();
    expect(cached!.status.habit_id).toBe(HABIT_ID);
    expect(prefs.has(habitGraduationCacheKey(HABIT_ID))).toBe(true);
  });
});
