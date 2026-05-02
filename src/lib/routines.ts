/**
 * Routines data layer.
 *
 * Two read paths share this module:
 *
 * - Per-row routine-name resolution from [2C-21]: HabitsPage fans out
 *   `GET /api/routines/{id}` per habit with a non-null `routine_id`. Only
 *   `id` and `title` are read on that path.
 * - Active-routines list from [2C-24]: RoutinesPage fetches
 *   `GET /api/routines/?status=active` once and renders every field. Cache
 *   pattern mirrors `lib/habits.ts` — JSON blob under a `brain.cache.*` key
 *   with `fetched_at` provenance for the offline cache hint.
 *
 * Type shape mirrors `app/schemas/routines.py:75-92` (RoutineResponse) on the
 * brain3 server. `RoutineDetailResponse` (which adds nested schedules) is the
 * shape returned by GET /api/routines/{id}; for the list-view consumers here,
 * the schedule list is unused so we model the base RoutineResponse only.
 */

import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './pairing';

export const ROUTINES_PATH = '/api/routines/';
export const ROUTINES_CACHE_KEY = 'brain.cache.routines.active';

const FETCH_TIMEOUT_MS = 10_000;

export type RoutineFrequency =
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'weekly'
  | 'custom';
export type RoutineStatus = 'active' | 'paused' | 'retired';

export interface RoutineResponse {
  id: string;
  domain_id?: string;
  title: string;
  description?: string | null;
  frequency?: RoutineFrequency;
  status?: RoutineStatus;
  energy_cost?: number | null;
  activation_friction?: number | null;
  current_streak?: number;
  best_streak?: number;
  /** YYYY-MM-DD device-local calendar date, or null if never completed. */
  last_completed?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface RoutineListResponseBody {
  items: RoutineResponse[];
  count: number;
}

export type FetchRoutineResult =
  | { ok: true; routine: RoutineResponse }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout' | 'not_found';
      statusCode?: number;
    };

export type FetchRoutinesResult =
  | { ok: true; items: RoutineResponse[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export async function fetchRoutine(
  pairing: Pairing,
  routineId: string,
): Promise<FetchRoutineResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${ROUTINES_PATH}${routineId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const body = (await response.json()) as RoutineResponse;
      return { ok: true, routine: body };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', statusCode: 404 };
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

export async function fetchActiveRoutines(
  pairing: Pairing,
): Promise<FetchRoutinesResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${ROUTINES_PATH}?status=active`;

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
        Array.isArray((body as RoutineListResponseBody).items)
          ? (body as RoutineListResponseBody).items
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

export interface CachedRoutines {
  fetched_at: string;
  items: RoutineResponse[];
}

export async function readCachedRoutines(): Promise<CachedRoutines | null> {
  const { value } = await Preferences.get({ key: ROUTINES_CACHE_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      'fetched_at' in parsed &&
      Array.isArray((parsed as CachedRoutines).items) &&
      typeof (parsed as CachedRoutines).fetched_at === 'string'
    ) {
      return parsed as CachedRoutines;
    }
  } catch {
    // Fall through — treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedRoutines(
  items: RoutineResponse[],
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedRoutines = {
    fetched_at: now.toISOString(),
    items,
  };
  await Preferences.set({
    key: ROUTINES_CACHE_KEY,
    value: JSON.stringify(payload),
  });
}

/**
 * Sort routines alphabetically by title (ASC, locale-aware). Per spec [2C-24]
 * Escalation 7: today-scheduled-first sort was rejected because the list
 * endpoint does not return schedules inline. PO may overturn.
 *
 * Pure function — caller owns the input array.
 */
export function sortRoutinesByTitle(
  items: RoutineResponse[],
): RoutineResponse[] {
  return [...items].sort((a, b) => a.title.localeCompare(b.title));
}
