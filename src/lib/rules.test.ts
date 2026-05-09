import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { Preferences } from '@capacitor/preferences';
import {
  RECENT_FIRES_LIMIT,
  RULES_CACHE_KEY,
  fetchRule,
  fetchRuleFires,
  fetchRules,
  formatRelativeFiredAt,
  readCachedRules,
  sortRulesForList,
  writeCachedRules,
  type RuleRead,
} from './rules';
import type { NotificationItem } from './notifications';
import type { Pairing } from './pairing';

const PAIRING: Pairing = { url: 'https://brain.local:8000', token: 'tk-1' };

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

function makeRule(overrides: Partial<RuleRead> = {}): RuleRead {
  return {
    id: overrides.id ?? 'r-1',
    name: overrides.name ?? 'Habit nudge — 3 skips',
    entity_type: overrides.entity_type ?? 'habit',
    entity_id: overrides.entity_id ?? null,
    metric: overrides.metric ?? 'consecutive_skips',
    operator: overrides.operator ?? '>=',
    threshold: overrides.threshold ?? 3,
    action: overrides.action ?? 'create_notification',
    notification_type: overrides.notification_type ?? 'habit_nudge',
    message_template:
      overrides.message_template ??
      "{entity_name} hasn't been touched in {metric_value} days",
    enabled: overrides.enabled ?? true,
    cooldown_hours: overrides.cooldown_hours ?? 24,
    is_default: overrides.is_default ?? false,
    last_triggered_at: overrides.last_triggered_at ?? null,
    created_at: overrides.created_at ?? '2026-05-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-01T00:00:00Z',
  };
}

function makeNotification(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: overrides.id ?? 'n-1',
    notification_type: overrides.notification_type ?? 'habit_nudge',
    delivery_type: overrides.delivery_type ?? 'notification',
    message: overrides.message ?? 'Test message',
    scheduled_at: overrides.scheduled_at ?? '2026-05-09T08:00:00Z',
    scheduled_date: overrides.scheduled_date ?? '2026-05-09',
    status: overrides.status ?? 'delivered',
    expires_at:
      overrides.expires_at !== undefined
        ? overrides.expires_at
        : '2026-05-09T20:00:00Z',
    response: overrides.response ?? null,
    response_note: overrides.response_note ?? null,
    responded_at: overrides.responded_at ?? null,
    canned_responses: overrides.canned_responses ?? null,
    target_entity_type: overrides.target_entity_type ?? 'habit',
    target_entity_id:
      overrides.target_entity_id ?? '11111111-1111-1111-1111-111111111111',
    scheduled_by: overrides.scheduled_by ?? 'system',
    rule_id: overrides.rule_id ?? null,
    created_at: overrides.created_at ?? '2026-05-09T07:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-09T07:00:00Z',
  };
}

// ---------------------------------------------------------------------------

describe('fetchRules — envelope handling', () => {
  it('unwraps {items, count} envelope from /api/rules/', async () => {
    const items = [makeRule({ id: 'r-a' }), makeRule({ id: 'r-b' })];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items, count: 2 }), { status: 200 }),
      );

    const result = await fetchRules(PAIRING);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(2);
      expect(result.items.map((r) => r.id)).toEqual(['r-a', 'r-b']);
    }
    expect(fetchSpy).toHaveBeenCalledWith(
      `${PAIRING.url}/api/rules/`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${PAIRING.token}` },
      }),
    );
  });

  it('returns empty list when the server returns a non-envelope shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('null', { status: 200 }),
    );
    const result = await fetchRules(PAIRING);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual([]);
  });

  it.each([
    [401, 'unauthorized'],
    [500, 'server'],
  ] as const)('maps %i to reason "%s"', async (status, reason) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status }),
    );
    const result = await fetchRules(PAIRING);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});

describe('fetchRule', () => {
  it('returns the rule on 200', async () => {
    const rule = makeRule({ id: 'r-9', name: 'Streak loss' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(rule), { status: 200 }),
    );
    const result = await fetchRule(PAIRING, 'r-9');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.name).toBe('Streak loss');
  });

  it('maps 404 to not_found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );
    const result = await fetchRule(PAIRING, 'r-x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

describe('fetchRuleFires', () => {
  it('queries /api/notifications/?rule_id=<id> and trims to limit', async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      makeNotification({ id: `n-${i}` }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items, count: 25 }), { status: 200 }),
      );

    const result = await fetchRuleFires(PAIRING, 'r-1');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${PAIRING.url}/api/notifications/?rule_id=r-1`,
      expect.any(Object),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(RECENT_FIRES_LIMIT);
  });

  it('honors a custom limit', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeNotification({ id: `n-${i}` }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ items, count: 5 }), { status: 200 }),
    );

    const result = await fetchRuleFires(PAIRING, 'r-1', 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(2);
  });
});

describe('readCachedRules / writeCachedRules', () => {
  it('round-trips cached rules through Preferences', async () => {
    const items = [makeRule({ id: 'r-a' })];
    await writeCachedRules(items, new Date('2026-05-09T12:00:00Z'));
    const cached = await readCachedRules();
    expect(cached).not.toBeNull();
    expect(cached?.items).toEqual(items);
    expect(cached?.fetched_at).toBe('2026-05-09T12:00:00.000Z');
  });

  it('returns null when no cache is present', async () => {
    expect(await readCachedRules()).toBeNull();
  });

  it('returns null when the cache is malformed', async () => {
    prefsStore.set(RULES_CACHE_KEY, 'not-json');
    expect(await readCachedRules()).toBeNull();
  });
});

describe('sortRulesForList', () => {
  it('orders by last_triggered_at desc, with never-fired rules pushed below', () => {
    const a = makeRule({
      id: 'a',
      last_triggered_at: '2026-05-08T00:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
    });
    const b = makeRule({
      id: 'b',
      last_triggered_at: '2026-05-09T00:00:00Z',
      created_at: '2026-04-01T00:00:00Z',
    });
    const c = makeRule({
      id: 'c',
      last_triggered_at: null,
      created_at: '2026-05-01T00:00:00Z',
    });
    const d = makeRule({
      id: 'd',
      last_triggered_at: null,
      created_at: '2026-04-15T00:00:00Z',
    });

    expect(sortRulesForList([a, b, c, d]).map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [
      makeRule({ id: '1', last_triggered_at: null }),
      makeRule({ id: '2', last_triggered_at: '2026-05-09T00:00:00Z' }),
    ];
    const original = [...input];
    sortRulesForList(input);
    expect(input).toEqual(original);
  });
});

describe('formatRelativeFiredAt', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it.each([
    [null, 'never fired'],
    [new Date('2026-05-09T11:59:30Z').toISOString(), 'fired just now'],
    [new Date('2026-05-09T11:55:00Z').toISOString(), 'fired 5m ago'],
    [new Date('2026-05-09T10:00:00Z').toISOString(), 'fired 2h ago'],
    [new Date('2026-05-08T12:00:00Z').toISOString(), 'fired yesterday'],
    [new Date('2026-05-06T12:00:00Z').toISOString(), 'fired 3d ago'],
  ])('formats %s as %s', (iso, expected) => {
    expect(formatRelativeFiredAt(iso, now)).toBe(expected);
  });

  it('returns the raw value on parse failure', () => {
    expect(formatRelativeFiredAt('not-a-date', now)).toBe('not-a-date');
  });
});
