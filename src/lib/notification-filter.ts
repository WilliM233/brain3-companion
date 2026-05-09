/**
 * Notification filter state for [2C-17] pattern observation filter.
 *
 * Pattern observations share `/api/notifications/` with other notification
 * types — `notification_type="pattern_observation"` is the discriminator. Per
 * the [2C-17] spec, the surface for showing them is a client-side filter on
 * the existing [2C-09] view rather than a dedicated screen. This module owns
 * the filter type, its persistence under `@capacitor/preferences`, and the
 * filter application against an item list.
 */

import { Preferences } from '@capacitor/preferences';
import type { NotificationItem } from './notifications';

export const NOTIFICATION_FILTER_KEY = 'brain.ui.notifFilter';

export const PATTERN_OBSERVATION_TYPE = 'pattern_observation';

export type NotificationFilter = 'all' | 'patterns';

const VALID_FILTERS: ReadonlySet<NotificationFilter> = new Set([
  'all',
  'patterns',
]);

function isNotificationFilter(value: unknown): value is NotificationFilter {
  return typeof value === 'string' && VALID_FILTERS.has(value as NotificationFilter);
}

export async function readNotificationFilter(): Promise<NotificationFilter> {
  const { value } = await Preferences.get({ key: NOTIFICATION_FILTER_KEY });
  return isNotificationFilter(value) ? value : 'all';
}

export async function writeNotificationFilter(
  filter: NotificationFilter,
): Promise<void> {
  await Preferences.set({ key: NOTIFICATION_FILTER_KEY, value: filter });
}

export function applyNotificationFilter(
  items: NotificationItem[],
  filter: NotificationFilter,
): NotificationItem[] {
  if (filter === 'all') return items;
  return items.filter((item) => item.notification_type === PATTERN_OBSERVATION_TYPE);
}
