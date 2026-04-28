/**
 * Device-local date helpers for [2C-09] recent notifications view.
 *
 * The view's filter logic anchors on calendar dates (the E5 contract:
 * `scheduled_date` is a `YYYY-MM-DD` calendar string, not a timestamp), so
 * comparison is done in the device's local time zone. `date-fns` is used
 * because raw `Date` arithmetic across DST transitions can drift by an hour;
 * `subDays` + `startOfDay` operate in local time and normalise correctly.
 */

import { format, startOfDay, subDays } from 'date-fns';

const ISO_DATE_FORMAT = 'yyyy-MM-dd';

/** Today's local calendar date as `YYYY-MM-DD`. */
export function todayLocalDate(now: Date = new Date()): string {
  return format(now, ISO_DATE_FORMAT);
}

/** Local calendar date 7 days before today as `YYYY-MM-DD` (inclusive lower bound). */
export function sevenDaysAgoLocalDate(now: Date = new Date()): string {
  return format(subDays(startOfDay(now), 7), ISO_DATE_FORMAT);
}

/**
 * UTC ISO timestamp for local midnight 8 days ago. Used as the server's
 * `scheduled_after` filter — over-fetches by one day relative to the
 * 7-day client window to absorb TZ-edge items that the device-local filter
 * still has to evaluate.
 */
export function eightDaysAgoLocalMidnightUtc(now: Date = new Date()): string {
  return subDays(startOfDay(now), 8).toISOString();
}
