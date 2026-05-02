/**
 * Habits data layer for [2C-21] habit list view.
 *
 * Fetches `/api/habits/?status=active` with bearer auth and exposes the
 * Capacitor Preferences cache that backs the offline-launch fallback. The
 * cache pattern mirrors `[2C-09]` notifications.ts: a JSON blob under a
 * `brain.cache.*` key, with `fetched_at` provenance for "Showing cached data"
 * surfacing.
 *
 * Type shape mirrors `app/schemas/habits.py:111-159` (HabitResponse) on the
 * brain3 server, including the `effective_graduation_params` computed field
 * that `[2C-22]` consumes from the same cache without re-fetching.
 */

import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './pairing';

export const HABITS_CACHE_KEY = 'brain.cache.habits.active';
export const HABITS_PATH = '/api/habits/';

const FETCH_TIMEOUT_MS = 10_000;

export type HabitStatus = 'active' | 'paused' | 'graduated' | 'abandoned';
export type ScaffoldingStatus = 'tracking' | 'accountable' | 'graduated';
export type HabitFrequency =
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'weekly'
  | 'custom';

export interface EffectiveGraduationParams {
  window_days: number;
  target_rate: number;
  threshold_days: number;
  source: 'override' | 'friction_default';
}

export interface HabitResponse {
  id: string;
  routine_id: string | null;
  title: string;
  description: string | null;
  status: HabitStatus;
  frequency: HabitFrequency | null;
  notification_frequency: string;
  scaffolding_status: ScaffoldingStatus;
  accountable_since: string | null;
  graduation_window: number | null;
  graduation_target: number | null;
  graduation_threshold: number | null;
  friction_score: number | null;
  position: number | null;
  re_scaffold_count: number;
  last_frequency_changed_at: string | null;
  graduated_at: string | null;
  current_streak: number;
  best_streak: number;
  /** YYYY-MM-DD device-local calendar date, or null if never completed. */
  last_completed: string | null;
  created_at: string;
  updated_at: string;
  effective_graduation_params: EffectiveGraduationParams;
}

interface HabitListResponseBody {
  items: HabitResponse[];
  count: number;
}

export type FetchHabitsResult =
  | { ok: true; items: HabitResponse[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export async function fetchActiveHabits(
  pairing: Pairing,
): Promise<FetchHabitsResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${HABITS_PATH}?status=active`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const body = (await response.json()) as unknown;
      const items =
        body &&
        typeof body === 'object' &&
        'items' in body &&
        Array.isArray((body as HabitListResponseBody).items)
          ? (body as HabitListResponseBody).items
          : [];
      return { ok: true, items };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    return { ok: false, reason: 'server', statusCode: response.status };
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export interface CachedHabits {
  fetched_at: string;
  items: HabitResponse[];
}

export async function readCachedHabits(): Promise<CachedHabits | null> {
  const { value } = await Preferences.get({ key: HABITS_CACHE_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      'fetched_at' in parsed &&
      Array.isArray((parsed as CachedHabits).items) &&
      typeof (parsed as CachedHabits).fetched_at === 'string'
    ) {
      return parsed as CachedHabits;
    }
  } catch {
    // Fall through — treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedHabits(
  items: HabitResponse[],
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedHabits = {
    fetched_at: now.toISOString(),
    items,
  };
  await Preferences.set({
    key: HABITS_CACHE_KEY,
    value: JSON.stringify(payload),
  });
}

export interface PartitionedHabits {
  primary: HabitResponse[];
  graduated: HabitResponse[];
}

/**
 * Split active habits into primary + graduated sections and apply per-section
 * sort per spec [2C-21]:
 *
 * - primary: `current_streak` DESC, then `last_completed` DESC nulls last,
 *   then `title` ASC.
 * - graduated: `graduated_at` DESC, with title fallback when both are null.
 *
 * Pure function — caller owns the input array.
 */
export function partitionAndSortHabits(
  items: HabitResponse[],
): PartitionedHabits {
  const primary: HabitResponse[] = [];
  const graduated: HabitResponse[] = [];
  for (const habit of items) {
    if (habit.scaffolding_status === 'graduated') {
      graduated.push(habit);
    } else {
      primary.push(habit);
    }
  }

  primary.sort((a, b) => {
    if (b.current_streak !== a.current_streak) {
      return b.current_streak - a.current_streak;
    }
    if (a.last_completed === null && b.last_completed !== null) return 1;
    if (b.last_completed === null && a.last_completed !== null) return -1;
    if (a.last_completed !== null && b.last_completed !== null) {
      const cmp = b.last_completed.localeCompare(a.last_completed);
      if (cmp !== 0) return cmp;
    }
    return a.title.localeCompare(b.title);
  });

  graduated.sort((a, b) => {
    if (a.graduated_at === null && b.graduated_at !== null) return 1;
    if (b.graduated_at === null && a.graduated_at !== null) return -1;
    if (a.graduated_at !== null && b.graduated_at !== null) {
      const cmp = b.graduated_at.localeCompare(a.graduated_at);
      if (cmp !== 0) return cmp;
    }
    return a.title.localeCompare(b.title);
  });

  return { primary, graduated };
}
