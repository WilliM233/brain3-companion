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
import type { RuleRead } from '../lib/rules';
import type { NotificationItem } from '../lib/notifications';
import RuleDetailPage from './RuleDetailPage';

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

function makeFire(overrides: Partial<NotificationItem> = {}): NotificationItem {
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

interface RuleStub {
  detail?: { status: number; rule?: RuleRead };
  fires?: { status: number; items?: NotificationItem[] };
}

function stubFetch(stub: RuleStub = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/notifications/')) {
        const r = stub.fires ?? { status: 200, items: [] };
        if (r.status === 200) {
          return new Response(
            JSON.stringify({ items: r.items ?? [], count: (r.items ?? []).length }),
            { status: 200 },
          );
        }
        return new Response('', { status: r.status });
      }
      if (url.includes('/api/rules/')) {
        const r = stub.detail ?? { status: 200, rule: makeRule() };
        if (r.status === 200 && r.rule) {
          return new Response(JSON.stringify(r.rule), { status: 200 });
        }
        return new Response('', { status: r.status });
      }
      return new Response('', { status: 404 });
    });
}

function renderPage(ruleId: string = 'r-1') {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/rules/${ruleId}`]}>
        <Route path="/rules/:ruleId">
          <RuleDetailPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('RuleDetailPage — bootstrap', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});

describe('RuleDetailPage — definition render', () => {
  it('renders the full rule definition with name, condition, template, and timestamps', async () => {
    pair();
    stubFetch({
      detail: {
        status: 200,
        rule: makeRule({
          id: 'r-1',
          name: 'Habit nudge — 3 skips',
          metric: 'consecutive_skips',
          operator: '>=',
          threshold: 3,
          notification_type: 'habit_nudge',
          message_template: '{entity_name} skipped {metric_value} times',
          cooldown_hours: 12,
          is_default: true,
          last_triggered_at: '2026-05-09T08:00:00Z',
        }),
      },
    });

    renderPage();

    expect(
      await screen.findByText('Habit nudge — 3 skips'),
    ).toBeInTheDocument();
    expect(screen.getByText('consecutive_skips >= 3')).toBeInTheDocument();
    expect(screen.getByText('habit_nudge')).toBeInTheDocument();
    expect(screen.getByText('12 hours')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByTestId('rule-message-template')).toHaveTextContent(
      '{entity_name} skipped {metric_value} times',
    );
    expect(screen.getByTestId('rule-phase3-footer')).toHaveTextContent(
      /editing rules will arrive in phase 3/i,
    );
  });

  it('shows entity_id with copy button when entity_id is set', async () => {
    pair();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    stubFetch({
      detail: {
        status: 200,
        rule: makeRule({ entity_id: 'abc-123-def' }),
      },
    });

    renderPage();

    expect(await screen.findByTestId('rule-entity-id')).toHaveTextContent(
      'abc-123-def',
    );
    await userEvent.click(screen.getByTestId('rule-entity-copy'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('abc-123-def');
    });
  });

  it('shows "Default rule" labelling when entity_id is null', async () => {
    pair();
    stubFetch({
      detail: {
        status: 200,
        rule: makeRule({ entity_id: null, entity_type: 'habit' }),
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('rule-entity-default'),
    ).toHaveTextContent(/default rule \(matches all habits\)/i);
  });

  it('shows "Never" when last_triggered_at is null', async () => {
    pair();
    stubFetch({
      detail: { status: 200, rule: makeRule({ last_triggered_at: null }) },
    });

    renderPage();

    await screen.findByText('Habit nudge — 3 skips');
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});

describe('RuleDetailPage — recent fires', () => {
  it('renders the recent fires list when notifications exist', async () => {
    pair();
    stubFetch({
      detail: { status: 200, rule: makeRule() },
      fires: {
        status: 200,
        items: [
          makeFire({ id: 'n-a', message: 'First fire', status: 'delivered' }),
          makeFire({ id: 'n-b', message: 'Second fire', status: 'responded' }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('First fire')).toBeInTheDocument();
    expect(screen.getByText('Second fire')).toBeInTheDocument();
  });

  it('shows the empty fires message when the rule has not fired', async () => {
    pair();
    stubFetch({
      detail: { status: 200, rule: makeRule() },
      fires: { status: 200, items: [] },
    });

    renderPage();

    expect(
      await screen.findByText(/this rule has not fired yet/i),
    ).toBeInTheDocument();
  });

  it('navigates to /notifications/:id when a fire is tapped', async () => {
    pair();
    stubFetch({
      detail: { status: 200, rule: makeRule() },
      fires: {
        status: 200,
        items: [makeFire({ id: 'n-x', message: 'Tap me' })],
      },
    });

    renderPage();

    const fire = await screen.findByText('Tap me');
    await userEvent.click(fire);

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('/notifications/n-x');
    });
  });
});

describe('RuleDetailPage — not found', () => {
  it('shows the not-found card when the rule 404s', async () => {
    pair();
    stubFetch({ detail: { status: 404 } });
    renderPage('r-missing');

    expect(await screen.findByTestId('rule-not-found')).toBeInTheDocument();
    expect(screen.getByText(/rule not found/i)).toBeInTheDocument();
  });
});

describe('RuleDetailPage — fetch URLs', () => {
  it('issues GET against /api/rules/{id} and /api/notifications/?rule_id with bearer token', async () => {
    pair();
    const fetchSpy = stubFetch({
      detail: { status: 200, rule: makeRule({ id: 'r-1' }) },
      fires: { status: 200, items: [] },
    });

    renderPage('r-1');

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    const detailCall = fetchSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].endsWith('/api/rules/r-1'),
    );
    expect(detailCall).toBeDefined();

    const firesCall = fetchSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/api/notifications/?rule_id=r-1'),
    );
    expect(firesCall).toBeDefined();

    const init = detailCall![1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: `Bearer ${PAIRED_TOKEN}` });
  });
});
