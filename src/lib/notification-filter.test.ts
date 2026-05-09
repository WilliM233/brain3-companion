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
  NOTIFICATION_FILTER_KEY,
  PATTERN_OBSERVATION_TYPE,
  applyNotificationFilter,
  readNotificationFilter,
  writeNotificationFilter,
  type NotificationFilter,
} from './notification-filter';
import type { NotificationItem } from './notifications';

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

function makeItem(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: overrides.id ?? 'n-1',
    notification_type: overrides.notification_type ?? 'habit_reminder',
    delivery_type: overrides.delivery_type ?? 'notification',
    message: overrides.message ?? 'Take your meds',
    scheduled_at: overrides.scheduled_at ?? '2026-04-28T13:00:00Z',
    scheduled_date: overrides.scheduled_date ?? '2026-04-28',
    status: overrides.status ?? 'pending',
    expires_at:
      overrides.expires_at !== undefined
        ? overrides.expires_at
        : '2026-04-28T15:00:00Z',
    response: overrides.response ?? null,
    response_note: overrides.response_note ?? null,
    responded_at: overrides.responded_at ?? null,
    canned_responses: overrides.canned_responses ?? null,
    target_entity_type: overrides.target_entity_type ?? 'habit',
    target_entity_id:
      overrides.target_entity_id ?? '11111111-1111-1111-1111-111111111111',
    scheduled_by: overrides.scheduled_by ?? 'system',
    rule_id: overrides.rule_id ?? null,
    created_at: overrides.created_at ?? '2026-04-28T12:00:00Z',
    updated_at: overrides.updated_at ?? '2026-04-28T12:00:00Z',
  };
}

describe('notification filter persistence', () => {
  it('defaults to "all" when no value is stored', async () => {
    const result = await readNotificationFilter();
    expect(result).toBe('all');
  });

  it('roundtrips a written filter through Preferences', async () => {
    await writeNotificationFilter('patterns');
    const result = await readNotificationFilter();
    expect(result).toBe('patterns');
    expect(prefsStore.get(NOTIFICATION_FILTER_KEY)).toBe('patterns');
  });

  it('falls back to "all" when the stored value is not a valid filter', async () => {
    prefsStore.set(NOTIFICATION_FILTER_KEY, 'something-else');
    const result = await readNotificationFilter();
    expect(result).toBe('all');
  });

  it('persists across read calls', async () => {
    await writeNotificationFilter('patterns');
    expect(await readNotificationFilter()).toBe('patterns');
    expect(await readNotificationFilter()).toBe('patterns');

    await writeNotificationFilter('all');
    expect(await readNotificationFilter()).toBe('all');
  });
});

describe('applyNotificationFilter', () => {
  const items: NotificationItem[] = [
    makeItem({ id: 'habit-1', notification_type: 'habit_reminder' }),
    makeItem({ id: 'pattern-1', notification_type: PATTERN_OBSERVATION_TYPE }),
    makeItem({ id: 'routine-1', notification_type: 'routine_due' }),
    makeItem({ id: 'pattern-2', notification_type: PATTERN_OBSERVATION_TYPE }),
  ];

  it('returns the input unchanged when filter is "all"', () => {
    const result = applyNotificationFilter(items, 'all');
    expect(result).toEqual(items);
  });

  it('keeps only pattern_observation items when filter is "patterns"', () => {
    const result = applyNotificationFilter(items, 'patterns');
    expect(result.map((i) => i.id)).toEqual(['pattern-1', 'pattern-2']);
  });

  it('returns an empty list when no items match the active filter', () => {
    const noPatterns = items.filter(
      (i) => i.notification_type !== PATTERN_OBSERVATION_TYPE,
    );
    const result = applyNotificationFilter(noPatterns, 'patterns');
    expect(result).toEqual([]);
  });

  it('preserves input order under the patterns filter', () => {
    const ordered: NotificationItem[] = [
      makeItem({ id: 'p-late', notification_type: PATTERN_OBSERVATION_TYPE, scheduled_at: '2026-04-28T18:00:00Z' }),
      makeItem({ id: 'p-early', notification_type: PATTERN_OBSERVATION_TYPE, scheduled_at: '2026-04-28T08:00:00Z' }),
    ];
    const result = applyNotificationFilter(ordered, 'patterns');
    expect(result.map((i) => i.id)).toEqual(['p-late', 'p-early']);
  });

  it('does not mutate the input array', () => {
    const before = items.map((i) => i.id);
    applyNotificationFilter(items, 'patterns');
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('NotificationFilter type', () => {
  it('exports a string-literal union usable in narrowing', () => {
    const value: NotificationFilter = 'all';
    expect(value === 'all' || value === 'patterns').toBe(true);
  });
});
