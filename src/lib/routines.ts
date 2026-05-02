/**
 * Routines data layer for [2C-21] habit list view.
 *
 * Per-row routine-name resolution: each habit with a non-null `routine_id`
 * fans out a `GET /api/routines/{routine_id}` query keyed by the routine id
 * so TanStack Query deduplicates fetches across rows. Type shape follows
 * `app/schemas/routines.py` RoutineResponse on the brain3 server. Only the
 * fields [2C-21] consumes are typed — sibling tickets ([2C-22], [2C-24])
 * extend this module as their views surface more fields.
 *
 * First-consumer-instantiates: this module is being introduced for the first
 * time by [2C-21]. The fetcher shape mirrors `lib/habits.ts` so the two
 * read-paths stay congruent for [2C-22] reuse.
 */

import type { Pairing } from './pairing';

export const ROUTINES_PATH = '/api/routines/';

const FETCH_TIMEOUT_MS = 10_000;

export interface RoutineResponse {
  id: string;
  title: string;
  /**
   * Additional fields exist server-side (domain_id, frequency, status,
   * current_streak, etc.). Sibling tickets extend this interface as needed.
   */
}

export type FetchRoutineResult =
  | { ok: true; routine: RoutineResponse }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout' | 'not_found';
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
