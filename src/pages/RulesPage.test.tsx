import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useHistory: () => ({
      push: pushSpy,
      replace: vi.fn(),
      goBack: vi.fn(),
    }),
  };
});

import { Preferences } from '@capacitor/preferences';
import { RULES_CACHE_KEY, type RuleRead } from '../lib/rules';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import RulesPage from './RulesPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();

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

function seedCache(items: RuleRead[]): void {
  prefsStore.set(
    RULES_CACHE_KEY,
    JSON.stringify({ fetched_at: '2026-05-09T00:00:00Z', items }),
  );
}

interface RulesFetchOptions {
  response?: { status: number; items?: RuleRead[]; raw?: unknown };
  rejection?: Error;
}

function stubFetch(opts: RulesFetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/rules/')) {
        if (opts.rejection) throw opts.rejection;
        const r = opts.response ?? { status: 200, items: [] };
        if (r.status === 200) {
          const body =
            r.raw !== undefined
              ? JSON.stringify(r.raw)
              : JSON.stringify({ items: r.items ?? [], count: (r.items ?? []).length });
          return new Response(body, { status: 200 });
        }
        return new Response('', { status: r.status });
      }
      return new Response('', { status: 404 });
    });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/rules']}>
        <RulesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('RulesPage — bootstrap', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});

describe('RulesPage — list render', () => {
  it('renders rows with name, condition, notification type, and pill', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [
          makeRule({
            id: 'r-1',
            name: 'Habit nudge — 3 skips',
            entity_type: 'habit',
            metric: 'consecutive_skips',
            operator: '>=',
            threshold: 3,
            notification_type: 'habit_nudge',
            enabled: true,
          }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Habit nudge — 3 skips')).toBeInTheDocument();
    expect(
      screen.getByText('habit — consecutive_skips >= 3'),
    ).toBeInTheDocument();
    expect(screen.getByText('→ habit_nudge')).toBeInTheDocument();
    expect(screen.getByTestId('rule-enabled-pill-enabled')).toHaveTextContent(
      'Enabled',
    );
  });

  it('renders disabled rules with a Disabled pill', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [makeRule({ id: 'r-2', enabled: false })],
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('rule-enabled-pill-disabled'),
    ).toHaveTextContent('Disabled');
  });

  it('sorts most-recently-triggered first, never-fired below', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [
          makeRule({
            id: 'r-old',
            name: 'Old rule',
            last_triggered_at: '2026-05-01T00:00:00Z',
          }),
          makeRule({
            id: 'r-recent',
            name: 'Recent rule',
            last_triggered_at: '2026-05-09T00:00:00Z',
          }),
          makeRule({
            id: 'r-never',
            name: 'Unfired rule',
            last_triggered_at: null,
          }),
        ],
      },
    });

    renderPage();

    await screen.findByText('Recent rule');
    const rows = screen.getAllByText(/rule$/);
    expect(rows.map((el) => el.textContent)).toEqual([
      'Recent rule',
      'Old rule',
      'Unfired rule',
    ]);
  });
});

describe('RulesPage — empty state', () => {
  it('shows the "No rules yet" empty-state message', async () => {
    pair();
    stubFetch({ response: { status: 200, items: [] } });
    renderPage();
    expect(
      await screen.findByText(
        /no rules yet\. create rules via brain3 cli or api\./i,
      ),
    ).toBeInTheDocument();
  });
});

describe('RulesPage — navigation', () => {
  it('pushes /rules/:id when a row is tapped', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [makeRule({ id: 'r-9', name: 'Tap me' })],
      },
    });

    renderPage();

    const title = await screen.findByText('Tap me');
    await userEvent.click(title);

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('/rules/r-9');
    });
  });
});

describe('RulesPage — offline cache', () => {
  it('renders cached items + cache hint when the network fetch fails', async () => {
    pair();
    seedCache([
      makeRule({ id: 'r-cached', name: 'Cached rule', enabled: true }),
    ]);
    stubFetch({ rejection: new Error('offline') });

    renderPage();

    expect(await screen.findByText('Cached rule')).toBeInTheDocument();
    expect(
      await screen.findByText(/showing cached data/i),
    ).toBeInTheDocument();
  });
});

describe('RulesPage — fetch URL', () => {
  it('issues GET against /api/rules/ with bearer token', async () => {
    pair();
    const fetchSpy = stubFetch({ response: { status: 200, items: [] } });

    renderPage();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const rulesCall = fetchSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('/api/rules/'),
    );
    expect(rulesCall).toBeDefined();
    const url = rulesCall![0] as string;
    expect(url.startsWith(`${PAIRED_URL}/api/rules/`)).toBe(true);
    const init = rulesCall![1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: `Bearer ${PAIRED_TOKEN}` });
  });
});
