/**
 * Notifications data layer for [2C-09] recent notifications view.
 *
 * Fetches `/api/notifications/?scheduled_after=<8-days-ago-local-midnight-UTC>`
 * with bearer auth, partitions the result into Today / Earlier sections by
 * device-local calendar date (the E5 contract — `scheduled_date` is a
 * `YYYY-MM-DD` string), and exposes a Capacitor Preferences cache that backs
 * the offline-launch fallback (Q7 demo-cache contribution for Chunk 2; Chunk 5
 * hardens the offline UX).
 */

import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './pairing';
import {
  eightDaysAgoLocalMidnightUtc,
  sevenDaysAgoLocalDate,
  todayLocalDate,
} from './local-date';

export const NOTIFICATIONS_CACHE_KEY = 'brain.cache.notifications';
export const NOTIFICATIONS_PATH = '/api/notifications/';

const FETCH_TIMEOUT_MS = 10_000;

export type NotificationStatus =
  | 'pending'
  | 'delivered'
  | 'responded'
  | 'expired';

export interface NotificationItem {
  id: string;
  notification_type: string;
  message: string;
  /** ISO timestamp of when the nudge was scheduled to fire. */
  scheduled_at: string;
  /** Device-local calendar date the nudge belongs to (`YYYY-MM-DD`). */
  scheduled_date: string;
  status: NotificationStatus;
  expires_at: string;
  /** The chosen canned response, or `null` if not responded. */
  response: string | null;
}

export type FetchResult =
  | { ok: true; items: NotificationItem[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export async function fetchNotifications(
  pairing: Pairing,
  now: Date = new Date(),
): Promise<FetchResult> {
  const base = pairing.url.replace(/\/$/, '');
  const scheduledAfter = eightDaysAgoLocalMidnightUtc(now);
  const url = `${base}${NOTIFICATIONS_PATH}?scheduled_after=${encodeURIComponent(scheduledAfter)}`;

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
      const items = Array.isArray(body) ? (body as NotificationItem[]) : [];
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

export interface CachedNotifications {
  fetched_at: string;
  items: NotificationItem[];
}

export async function readCachedNotifications(): Promise<CachedNotifications | null> {
  const { value } = await Preferences.get({ key: NOTIFICATIONS_CACHE_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      'fetched_at' in parsed &&
      Array.isArray((parsed as CachedNotifications).items) &&
      typeof (parsed as CachedNotifications).fetched_at === 'string'
    ) {
      return parsed as CachedNotifications;
    }
  } catch {
    // Fall through — treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedNotifications(
  items: NotificationItem[],
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedNotifications = {
    fetched_at: now.toISOString(),
    items,
  };
  await Preferences.set({
    key: NOTIFICATIONS_CACHE_KEY,
    value: JSON.stringify(payload),
  });
}

export interface EarlierGroup {
  /** `YYYY-MM-DD` device-local calendar date. */
  date: string;
  items: NotificationItem[];
}

export interface PartitionedNotifications {
  today: NotificationItem[];
  earlier: EarlierGroup[];
}

/**
 * Filter to the 8-day device-local window and split into Today vs Earlier.
 * Items strictly older than the 7-days-ago lower bound are dropped — the
 * server's `scheduled_after` filter over-fetches by one day for TZ-edge
 * safety, so the device-local cutoff is the authoritative trim.
 *
 * Today includes expired items (Q8 missed-from-today rule). Earlier excludes
 * today, groups by `scheduled_date`, sorts groups newest-first, and sorts
 * items within a group by `scheduled_at` descending.
 */
export function partitionNotifications(
  items: NotificationItem[],
  now: Date = new Date(),
): PartitionedNotifications {
  const today = todayLocalDate(now);
  const cutoff = sevenDaysAgoLocalDate(now);

  const inWindow = items.filter(
    (item) => item.scheduled_date >= cutoff && item.scheduled_date <= today,
  );

  const todayItems = inWindow
    .filter((item) => item.scheduled_date === today)
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at));

  const groups = new Map<string, NotificationItem[]>();
  for (const item of inWindow) {
    if (item.scheduled_date >= today) continue;
    const bucket = groups.get(item.scheduled_date);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.scheduled_date, [item]);
    }
  }
  const earlier: EarlierGroup[] = Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, groupItems]) => ({
      date,
      items: groupItems.sort((a, b) =>
        b.scheduled_at.localeCompare(a.scheduled_at),
      ),
    }));

  return { today: todayItems, earlier };
}
