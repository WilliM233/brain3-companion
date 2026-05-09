/**
 * Check-ins data layer for [2C-20] recent check-ins view.
 *
 * Fetches `/api/checkins/?logged_after=<30-days-ago>` with bearer auth and
 * exposes the Capacitor Preferences cache that backs the offline-launch
 * fallback. Cache pattern mirrors `lib/habits.ts` and `lib/notifications.ts`:
 * a JSON blob under a `brain.cache.*` key, with `fetched_at` provenance for
 * "Showing cached data" surfacing.
 *
 * Type shape mirrors `app/schemas/checkins.py:68-80` (CheckinResponse) on the
 * brain3 server. The `list_checkins` endpoint returns a bare JSON array
 * (not `{items, count}`) per `app/routers/checkins.py:42`, so the parser
 * here differs slightly from the habits/routines envelope.
 */

import { Preferences } from '@capacitor/preferences';
import { parseISO, startOfDay, subDays } from 'date-fns';
import type { Pairing } from './pairing';

export const CHECKINS_CACHE_KEY = 'brain.cache.checkins';
export const CHECKINS_PATH = '/api/checkins/';

const FETCH_TIMEOUT_MS = 10_000;
const RECENT_WINDOW_DAYS = 30;
const FREEFORM_PREVIEW_MAX = 60;

export type CheckinType =
  | 'morning'
  | 'midday'
  | 'evening'
  | 'micro'
  | 'freeform';

export interface CheckinResponse {
  id: string;
  checkin_type: CheckinType;
  energy_level: number | null;
  mood: number | null;
  focus_level: number | null;
  freeform_note: string | null;
  context: string | null;
  /** ISO timestamp set server-side at insert time. */
  logged_at: string;
}

export type FetchCheckinsResult =
  | { ok: true; items: CheckinResponse[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export type FetchCheckinResult =
  | { ok: true; checkin: CheckinResponse }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout' | 'not_found';
      statusCode?: number;
    };

/**
 * UTC ISO timestamp for local midnight 30 days ago. Anchors the
 * `logged_after` filter on the device-local calendar so the window is a
 * predictable 30 days regardless of TZ.
 */
export function thirtyDaysAgoLocalMidnightUtc(now: Date = new Date()): string {
  return subDays(startOfDay(now), RECENT_WINDOW_DAYS).toISOString();
}

export async function fetchCheckins(
  pairing: Pairing,
  now: Date = new Date(),
): Promise<FetchCheckinsResult> {
  const base = pairing.url.replace(/\/$/, '');
  const loggedAfter = thirtyDaysAgoLocalMidnightUtc(now);
  const url = `${base}${CHECKINS_PATH}?logged_after=${encodeURIComponent(loggedAfter)}`;

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
      const items = Array.isArray(body) ? (body as CheckinResponse[]) : [];
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

export async function fetchCheckin(
  pairing: Pairing,
  checkinId: string,
): Promise<FetchCheckinResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${CHECKINS_PATH}${checkinId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const body = (await response.json()) as CheckinResponse;
      return { ok: true, checkin: body };
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

export interface CachedCheckins {
  fetched_at: string;
  items: CheckinResponse[];
}

export async function readCachedCheckins(): Promise<CachedCheckins | null> {
  const { value } = await Preferences.get({ key: CHECKINS_CACHE_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      'fetched_at' in parsed &&
      Array.isArray((parsed as CachedCheckins).items) &&
      typeof (parsed as CachedCheckins).fetched_at === 'string'
    ) {
      return parsed as CachedCheckins;
    }
  } catch {
    // Treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedCheckins(
  items: CheckinResponse[],
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedCheckins = {
    fetched_at: now.toISOString(),
    items,
  };
  await Preferences.set({
    key: CHECKINS_CACHE_KEY,
    value: JSON.stringify(payload),
  });
}

const FRIENDLY_LABELS: Record<CheckinType, string> = {
  morning: 'Morning check-in',
  midday: 'Midday check-in',
  evening: 'Evening check-in',
  micro: 'Micro check-in',
  freeform: 'Freeform check-in',
};

export function friendlyCheckinTypeLabel(type: CheckinType): string {
  return FRIENDLY_LABELS[type];
}

/**
 * Compose subtitle line 1 from non-null numeric values, in the spec's order
 * (Energy · Focus · Mood). Returns null if all three are null so the caller
 * can suppress the subtitle line entirely.
 */
export function composeNumericSubtitle(
  checkin: Pick<CheckinResponse, 'energy_level' | 'focus_level' | 'mood'>,
): string | null {
  const parts: string[] = [];
  if (checkin.energy_level !== null) parts.push(`Energy ${checkin.energy_level}`);
  if (checkin.focus_level !== null) parts.push(`Focus ${checkin.focus_level}`);
  if (checkin.mood !== null) parts.push(`Mood ${checkin.mood}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Truncate a freeform note to `FREEFORM_PREVIEW_MAX` chars with an ellipsis
 * suffix when it's longer. Used for the list-row subtitle preview only —
 * the detail view renders the full note.
 */
export function truncateFreeformPreview(note: string): string {
  if (note.length <= FREEFORM_PREVIEW_MAX) return note;
  return `${note.slice(0, FREEFORM_PREVIEW_MAX)}…`;
}

/**
 * Short relative-time labels per spec — "2h ago", "yesterday", "3d ago".
 * Falls back to the raw ISO string on parse failure.
 */
export function formatRelativeLoggedAt(
  iso: string,
  now: Date = new Date(),
): string {
  try {
    const then = parseISO(iso);
    const deltaMs = now.getTime() - then.getTime();
    if (Number.isNaN(deltaMs)) return iso;
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
