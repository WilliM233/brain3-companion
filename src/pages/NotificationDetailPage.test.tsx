import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const { pushSpy, replaceSpy } = vi.hoisted(() => ({
  pushSpy: vi.fn(),
  replaceSpy: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useHistory: () => ({
      push: pushSpy,
      replace: replaceSpy,
      goBack: vi.fn(),
    }),
  };
});

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import {
  RULES_CACHE_KEY,
  type RuleRead,
} from '../lib/rules';
import type { NotificationItem } from '../lib/notifications';
import NotificationDetailPage from './NotificationDetailPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();
  replaceSpy.mockReset();

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

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
}

function seedRulesCache(rules: RuleRead[]): void {
  prefsStore.set(
    RULES_CACHE_KEY,
    JSON.stringify({ fetched_at: '2026-05-09T13:00:00Z', items: rules }),
  );
}

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
    message: overrides.message ?? 'Time to take meds',
    scheduled_at: overrides.scheduled_at ?? '2026-05-09T13:00:00Z',
    scheduled_date: overrides.scheduled_date ?? '2026-05-09',
    status: overrides.status ?? 'delivered',
    expires_at:
      overrides.expires_at !== undefined
        ? overrides.expires_at
        : '2026-05-09T15:00:00Z',
    response: overrides.response ?? null,
    response_note: overrides.response_note ?? null,
    responded_at: overrides.responded_at ?? null,
    canned_responses: overrides.canned_responses ?? null,
    target_entity_type: overrides.target_entity_type ?? 'habit',
    target_entity_id:
      overrides.target_entity_id ?? '11111111-1111-1111-1111-111111111111',
    scheduled_by: overrides.scheduled_by ?? 'system',
    rule_id: overrides.rule_id ?? null,
    created_at: overrides.created_at ?? '2026-05-09T12:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-09T12:00:00Z',
  };
}

interface FetchStub {
  notification?: { status: number; body?: NotificationItem };
  rulesList?: { status: number; items?: RuleRead[] };
  ruleDetail?: { status: number; rule?: RuleRead };
}

function stubFetch(stub: FetchStub = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      // /api/rules/{id} (single) — must check before list because both
      // share the same /api/rules/ prefix.
      const ruleDetailMatch = url.match(/\/api\/rules\/([^/?]+)$/);
      if (ruleDetailMatch) {
        const r = stub.ruleDetail ?? { status: 200, rule: makeRule() };
        if (r.status === 200 && r.rule) {
          return new Response(JSON.stringify(r.rule), { status: 200 });
        }
        return new Response('', { status: r.status });
      }
      if (url.includes('/api/rules')) {
        const r = stub.rulesList ?? { status: 200, items: [] };
        if (r.status === 200) {
          return new Response(
            JSON.stringify({
              items: r.items ?? [],
              count: (r.items ?? []).length,
            }),
            { status: 200 },
          );
        }
        return new Response('', { status: r.status });
      }
      if (url.includes('/api/notifications/')) {
        const r = stub.notification ?? {
          status: 200,
          body: makeNotification(),
        };
        if (r.status === 200 && r.body) {
          return new Response(JSON.stringify(r.body), { status: 200 });
        }
        return new Response('', { status: r.status });
      }
      return new Response('', { status: 404 });
    });
}

function renderPage(notificationId: string = 'n-1') {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/notifications/${notificationId}`]}>
        <Route path="/notifications/:notificationId">
          <NotificationDetailPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('NotificationDetailPage — bootstrap', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });

  it('renders the notification body when fetched successfully', async () => {
    pair();
    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({
          id: 'n-1',
          message: 'Hello world',
          status: 'delivered',
          target_entity_type: 'habit',
          target_entity_id: '22222222-2222-2222-2222-222222222222',
        }),
      },
    });

    renderPage('n-1');

    expect(
      await screen.findByTestId('notification-detail-message'),
    ).toHaveTextContent('Hello world');
    expect(screen.getByText('Habit nudge')).toBeInTheDocument();
    expect(
      screen.getByTestId('notification-status-pill-delivered'),
    ).toHaveTextContent('Delivered');
    expect(screen.getByTestId('notification-detail-target-id')).toHaveTextContent(
      '22222222-2222-2222-2222-222222222222',
    );
  });

  it('shows a not-found card on 404', async () => {
    pair();
    stubFetch({ notification: { status: 404 } });

    renderPage('missing');

    expect(await screen.findByTestId('notification-not-found')).toHaveTextContent(
      /not found/i,
    );
  });

  it('copies the target entity id when the copy button is tapped', async () => {
    pair();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({
          target_entity_id: '33333333-3333-3333-3333-333333333333',
        }),
      },
    });

    renderPage();

    await screen.findByTestId('notification-detail-message');
    await userEvent.click(screen.getByTestId('notification-detail-target-copy'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '33333333-3333-3333-3333-333333333333',
      );
    });
  });
});

describe('NotificationDetailPage — rule_id resolution', () => {
  it('renders "Triggered manually" when rule_id is null', async () => {
    pair();
    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({ rule_id: null }),
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('notification-rule-manual'),
    ).toHaveTextContent(/triggered manually/i);
  });

  it('resolves rule name from the cached ["rules"] list and navigates on tap', async () => {
    pair();
    seedRulesCache([
      makeRule({ id: 'rule-aaa', name: 'Daily standup nudge' }),
      makeRule({ id: 'rule-bbb', name: 'Other rule' }),
    ]);
    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({ rule_id: 'rule-aaa' }),
      },
      // Stale-time on the rules query plus initialData from the cached
      // payload should mean no /api/rules/ refetch fires; if the page
      // does refetch, fall back to the cached rule list shape.
      rulesList: {
        status: 200,
        items: [
          makeRule({ id: 'rule-aaa', name: 'Daily standup nudge' }),
          makeRule({ id: 'rule-bbb', name: 'Other rule' }),
        ],
      },
    });

    renderPage();

    const chip = await screen.findByTestId('notification-rule-chip-rule-aaa');
    expect(chip).toHaveTextContent(/triggered by rule: daily standup nudge/i);

    await userEvent.click(chip);
    expect(pushSpy).toHaveBeenCalledWith('/rules/rule-aaa');
  });

  it('resolves rule name via warm fetch when on-disk cache is empty', async () => {
    pair();
    // No cached rules on disk — rules query will fetch /api/rules/ from
    // network and resolve from the response.
    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({ rule_id: 'rule-ccc' }),
      },
      rulesList: {
        status: 200,
        items: [makeRule({ id: 'rule-ccc', name: 'Cold-start rule' })],
      },
    });

    renderPage();

    const chip = await screen.findByTestId('notification-rule-chip-rule-ccc');
    expect(chip).toHaveTextContent(/triggered by rule: cold-start rule/i);
  });

  it('shows "Triggered by deleted rule" when rule_id is set but the single-rule fetch returns 404', async () => {
    pair();
    // Cached rules list does NOT contain rule-ddd. On-demand single-rule
    // fetch returns 404 (rule was deleted between firing and viewing).
    seedRulesCache([makeRule({ id: 'rule-other', name: 'Some other rule' })]);
    stubFetch({
      notification: {
        status: 200,
        body: makeNotification({ rule_id: 'rule-ddd' }),
      },
      rulesList: {
        status: 200,
        items: [makeRule({ id: 'rule-other', name: 'Some other rule' })],
      },
      ruleDetail: { status: 404 },
    });

    renderPage();

    const deleted = await screen.findByTestId('notification-rule-deleted');
    expect(deleted).toHaveTextContent(
      /triggered by deleted rule \(id: rule-ddd\)/i,
    );
  });
});
