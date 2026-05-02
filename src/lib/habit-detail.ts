/**
 * Habit detail data layer for [2C-22] habit detail + graduation dashboard +
 * lifecycle actions.
 *
 * Owns three GET fetchers (detail, graduation-status, recent completions),
 * three direct mutations (PATCH status for pause/resume, POST re-scaffold,
 * POST step-down-frequency), and per-habit Capacitor Preferences caches for
 * the two GETs that drive the on-mount paint. Mirrors the cache-and-thread
 * pattern from `lib/habits.ts`: payload + `fetched_at` provenance, so the
 * caller can thread the cache age into TanStack Query's `initialDataUpdatedAt`
 * and let the on-mount refetch fire (initialData alone reads as fresh).
 *
 * Mutations are intentionally NOT routed through the [2C-23] write queue —
 * the queue is for idempotent completion writes (server returns the existing
 * row on retry); lifecycle transitions return meaningful 422/409 detail that
 * the UI surfaces as a toast and does not retry.
 *
 * Type shapes mirror the brain3 server: `app/routers/habits.py:91-157` for
 * GET/PATCH detail, `app/routers/graduation.py:74-87` for
 * GraduationStatusResponse, `app/routers/graduation.py:202-262` for the two
 * POST mutations, and `app/routers/habits.py:294-319` for the completions
 * history endpoint.
 */

import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './pairing';
import type { HabitResponse, HabitStatus } from './habits';
import type { RoutineResponse } from './routines';

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HabitDetailResponse extends HabitResponse {
  routine: RoutineResponse | null;
}

export interface GraduationParams {
  window_days: number;
  target_rate: number;
  threshold_days: number;
  source: 'per_habit' | 'friction_default';
}

export interface CurrentMetrics {
  already_done_rate: number;
  total_notifications: number;
  already_done_count: number;
}

export interface FrequencyStepDownInfo {
  eligible: boolean;
  recommended_frequency: string | null;
  current_rate_over_recent: number;
}

export interface GraduationStatusResponse {
  habit_id: string;
  habit_name: string;
  scaffolding_status: 'tracking' | 'accountable' | 'graduated';
  notification_frequency: string;
  friction_score: number | null;
  re_scaffold_count: number;
  accountable_since: string | null;
  days_accountable: number;
  graduation_params: GraduationParams;
  current_metrics: CurrentMetrics;
  progress_summary: string;
  frequency_step_down: FrequencyStepDownInfo;
}

export interface HabitCompletionItem {
  id: string;
  habit_id: string;
  /** YYYY-MM-DD device-local calendar date. */
  completed_at: string;
  source: string;
  notes: string | null;
  /** ISO timestamp of when the completion row was created server-side. */
  created_at: string;
}

export interface ReScaffoldResult {
  success: boolean;
  habit_id: string;
  previous_scaffolding_status: string;
  previous_notification_frequency: string;
  new_notification_frequency: string;
  re_scaffold_count: number;
  tightened_params: Record<string, unknown>;
  message: string;
}

export interface FrequencyChangeResult {
  success: boolean;
  habit_id: string;
  previous_frequency: string;
  new_frequency: string;
  message: string;
}

// ---------------------------------------------------------------------------
// GET fetchers
// ---------------------------------------------------------------------------

export type FetchHabitDetailResult =
  | { ok: true; habit: HabitDetailResponse }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
    };

export async function fetchHabitDetail(
  pairing: Pairing,
  habitId: string,
): Promise<FetchHabitDetailResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const habit = (await response.json()) as HabitDetailResponse;
      return { ok: true, habit };
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

export type FetchGraduationStatusResult =
  | { ok: true; status: GraduationStatusResponse }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
    };

export async function fetchHabitGraduationStatus(
  pairing: Pairing,
  habitId: string,
): Promise<FetchGraduationStatusResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}/graduation-status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const status = (await response.json()) as GraduationStatusResponse;
      return { ok: true, status };
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

export type FetchHabitCompletionsResult =
  | { ok: true; completions: HabitCompletionItem[] }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
    };

export async function fetchHabitCompletions(
  pairing: Pairing,
  habitId: string,
  limit: number = 20,
): Promise<FetchHabitCompletionsResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}/completions?limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const completions = (await response.json()) as HabitCompletionItem[];
      return { ok: true, completions };
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

// ---------------------------------------------------------------------------
// Mutations — direct, not queued
// ---------------------------------------------------------------------------

export type PatchHabitStatusResult =
  | { ok: true; habit: HabitResponse }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'invalid'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
    };

export async function patchHabitStatus(
  pairing: Pairing,
  habitId: string,
  status: HabitStatus,
): Promise<PatchHabitStatusResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
      signal: controller.signal,
    });
    if (response.status === 200) {
      const habit = (await response.json()) as HabitResponse;
      return { ok: true, habit };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', statusCode: 404 };
    }
    if (response.status === 400 || response.status === 422) {
      return { ok: false, reason: 'invalid', statusCode: response.status };
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

export type PostReScaffoldResult =
  | { ok: true; result: ReScaffoldResult }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'invalid_state'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
      detail?: string;
    };

export async function postReScaffold(
  pairing: Pairing,
  habitId: string,
): Promise<PostReScaffoldResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}/re-scaffold`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const result = (await response.json()) as ReScaffoldResult;
      return { ok: true, result };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', statusCode: 404 };
    }
    if (response.status === 422) {
      const detail = await readDetail(response);
      return {
        ok: false,
        reason: 'invalid_state',
        statusCode: 422,
        detail,
      };
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

export type PostStepDownResult =
  | { ok: true; result: FrequencyChangeResult }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'not_found'
        | 'not_recommended'
        | 'network'
        | 'server'
        | 'timeout';
      statusCode?: number;
      detail?: string;
    };

export async function postStepDownFrequency(
  pairing: Pairing,
  habitId: string,
): Promise<PostStepDownResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}/api/habits/${habitId}/step-down-frequency`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const result = (await response.json()) as FrequencyChangeResult;
      return { ok: true, result };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', statusCode: 404 };
    }
    if (response.status === 422) {
      // Server payload: { detail: { message, evaluation } } per
      // routers/graduation.py:215-221. Surface the message verbatim.
      const detail = await readNestedMessage(response);
      return {
        ok: false,
        reason: 'not_recommended',
        statusCode: 422,
        detail,
      };
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

async function readDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (
      body &&
      typeof body === 'object' &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      return (body as { detail: string }).detail;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

async function readNestedMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (
      body &&
      typeof body === 'object' &&
      'detail' in body &&
      (body as { detail: unknown }).detail &&
      typeof (body as { detail: unknown }).detail === 'object' &&
      'message' in
        ((body as { detail: object }).detail as Record<string, unknown>) &&
      typeof (
        (body as { detail: Record<string, unknown> }).detail as Record<
          string,
          unknown
        >
      ).message === 'string'
    ) {
      return (
        (body as { detail: Record<string, unknown> }).detail as Record<
          string,
          string
        >
      ).message;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-habit Capacitor Preferences caches
// ---------------------------------------------------------------------------

export const habitDetailCacheKey = (habitId: string): string =>
  `brain.cache.habit.${habitId}`;
export const habitGraduationCacheKey = (habitId: string): string =>
  `brain.cache.habit-graduation.${habitId}`;

export interface CachedHabitDetail {
  fetched_at: string;
  habit: HabitDetailResponse;
}

export interface CachedGraduationStatus {
  fetched_at: string;
  status: GraduationStatusResponse;
}

export async function readCachedHabitDetail(
  habitId: string,
): Promise<CachedHabitDetail | null> {
  const { value } = await Preferences.get({
    key: habitDetailCacheKey(habitId),
  });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'habit' in parsed &&
      'fetched_at' in parsed &&
      typeof (parsed as CachedHabitDetail).fetched_at === 'string'
    ) {
      return parsed as CachedHabitDetail;
    }
  } catch {
    // Treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedHabitDetail(
  habitId: string,
  habit: HabitDetailResponse,
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedHabitDetail = {
    fetched_at: now.toISOString(),
    habit,
  };
  await Preferences.set({
    key: habitDetailCacheKey(habitId),
    value: JSON.stringify(payload),
  });
}

export async function readCachedGraduationStatus(
  habitId: string,
): Promise<CachedGraduationStatus | null> {
  const { value } = await Preferences.get({
    key: habitGraduationCacheKey(habitId),
  });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'status' in parsed &&
      'fetched_at' in parsed &&
      typeof (parsed as CachedGraduationStatus).fetched_at === 'string'
    ) {
      return parsed as CachedGraduationStatus;
    }
  } catch {
    // Treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedGraduationStatus(
  habitId: string,
  status: GraduationStatusResponse,
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedGraduationStatus = {
    fetched_at: now.toISOString(),
    status,
  };
  await Preferences.set({
    key: habitGraduationCacheKey(habitId),
    value: JSON.stringify(payload),
  });
}
