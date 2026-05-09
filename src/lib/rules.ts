/**
 * Rules data layer for [2C-16] read-only rules list + detail surfaces.
 *
 * Fetches `/api/rules/` (list) and `/api/rules/{id}` (detail) with bearer
 * auth, plus `/api/notifications/?rule_id={id}` (recent fires). Mirrors the
 * envelope-aware parsing pattern used in `lib/habits.ts` — the rules and
 * notifications list endpoints both return `{items, count}` envelopes per
 * `brain3/app/schemas/rule.py:178` (RuleListResponse) and
 * `brain3/app/schemas/notifications.py:125` (NotificationListResponse).
 *
 * Type shape mirrors `app/schemas/rule.py:155-175` (RuleRead) on the brain3
 * server, verified per the spec's Pass 3 Summary §B.2.
 */

import { Preferences } from '@capacitor/preferences';
import type { QueryKey } from '@tanstack/react-query';
import type { Pairing } from './pairing';
import type { NotificationItem } from './notifications';

export const RULES_PATH = '/api/rules/';
export const NOTIFICATIONS_PATH = '/api/notifications/';
export const RULES_CACHE_KEY = 'brain.cache.rules';

/**
 * Shared query key for the rules list. Exported so [2C-18]'s notification
 * detail view can read the same TanStack cache entry for client-side
 * rule-name resolution per its issue body.
 */
export const RULES_QUERY_KEY: QueryKey = ['rules'];

const FETCH_TIMEOUT_MS = 10_000;

export const RECENT_FIRES_LIMIT = 20;

export type RuleEntityType = 'habit' | 'task' | 'routine' | 'checkin';

export type RuleMetric =
  | 'consecutive_skips'
  | 'days_untouched'
  | 'non_responses'
  | 'streak_length';

/** Operator values are the symbols the server stores, not the enum names. */
export type RuleOperator = '>=' | '<=' | '==';

export type RuleAction = 'create_notification';

export interface RuleRead {
  id: string;
  name: string;
  entity_type: RuleEntityType;
  entity_id: string | null;
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  action: RuleAction;
  notification_type: string;
  message_template: string;
  enabled: boolean;
  cooldown_hours: number;
  is_default: boolean;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RuleListResponseBody {
  items: RuleRead[];
  count: number;
}

interface NotificationListResponseBody {
  items: NotificationItem[];
  count: number;
}

export type FetchRulesResult =
  | { ok: true; items: RuleRead[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export type FetchRuleResult =
  | { ok: true; rule: RuleRead }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout' | 'not_found';
      statusCode?: number;
    };

export type FetchRuleFiresResult =
  | { ok: true; items: NotificationItem[] }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

export async function fetchRules(pairing: Pairing): Promise<FetchRulesResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${RULES_PATH}`;

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
        Array.isArray((body as RuleListResponseBody).items)
          ? (body as RuleListResponseBody).items
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

export async function fetchRule(
  pairing: Pairing,
  ruleId: string,
): Promise<FetchRuleResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${RULES_PATH}${ruleId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${pairing.token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      const body = (await response.json()) as RuleRead;
      return { ok: true, rule: body };
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

/**
 * Fetch notifications fired by a specific rule. Spec asks for the last 20;
 * the server returns the full list ordered by `scheduled_at desc` so the
 * client trims to `RECENT_FIRES_LIMIT` after parsing.
 */
export async function fetchRuleFires(
  pairing: Pairing,
  ruleId: string,
  limit: number = RECENT_FIRES_LIMIT,
): Promise<FetchRuleFiresResult> {
  const base = pairing.url.replace(/\/$/, '');
  const url = `${base}${NOTIFICATIONS_PATH}?rule_id=${encodeURIComponent(ruleId)}`;

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
        Array.isArray((body as NotificationListResponseBody).items)
          ? (body as NotificationListResponseBody).items
          : [];
      return { ok: true, items: items.slice(0, limit) };
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

export interface CachedRules {
  fetched_at: string;
  items: RuleRead[];
}

export async function readCachedRules(): Promise<CachedRules | null> {
  const { value } = await Preferences.get({ key: RULES_CACHE_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'items' in parsed &&
      'fetched_at' in parsed &&
      Array.isArray((parsed as CachedRules).items) &&
      typeof (parsed as CachedRules).fetched_at === 'string'
    ) {
      return parsed as CachedRules;
    }
  } catch {
    // Treat malformed cache as empty.
  }
  return null;
}

export async function writeCachedRules(
  items: RuleRead[],
  now: Date = new Date(),
): Promise<void> {
  const payload: CachedRules = {
    fetched_at: now.toISOString(),
    items,
  };
  await Preferences.set({
    key: RULES_CACHE_KEY,
    value: JSON.stringify(payload),
  });
}

/**
 * Sort rules most-recently-triggered first, then most-recently-created.
 * Rules that have never fired (`last_triggered_at === null`) sort below all
 * triggered rules, then among themselves by `created_at` descending.
 */
export function sortRulesForList(rules: RuleRead[]): RuleRead[] {
  return [...rules].sort((a, b) => {
    if (a.last_triggered_at !== null && b.last_triggered_at !== null) {
      return b.last_triggered_at.localeCompare(a.last_triggered_at);
    }
    if (a.last_triggered_at !== null) return -1;
    if (b.last_triggered_at !== null) return 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

/**
 * Short relative-time label for the list trailing slot — "fired 2h ago",
 * "fired yesterday", "fired 3d ago", or "never fired" when `null`. Falls
 * back to the raw ISO string on parse failure to preserve information.
 */
export function formatRelativeFiredAt(
  iso: string | null,
  now: Date = new Date(),
): string {
  if (iso === null) return 'never fired';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = now.getTime() - then;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'fired just now';
  if (minutes < 60) return `fired ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `fired ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'fired yesterday';
  return `fired ${days}d ago`;
}
