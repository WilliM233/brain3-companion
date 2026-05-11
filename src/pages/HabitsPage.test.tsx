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

const { enqueueSpy, flushSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(),
  flushSpy: vi.fn(),
}));

vi.mock('../lib/completionQueues', () => ({
  enqueueHabitCompletion: enqueueSpy,
  flushAllQueues: flushSpy,
}));

vi.mock('../lib/local-date', async () => {
  const actual = await vi.importActual<typeof import('../lib/local-date')>(
    '../lib/local-date',
  );
  return {
    ...actual,
    todayLocalDate: () => '2026-05-02',
  };
});

import { Preferences } from '@capacitor/preferences';
import { HABITS_CACHE_KEY, type HabitResponse } from '../lib/habits';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import HabitsPage from './HabitsPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';

const prefsStore = new Map<string, string>();

const successFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 1,
    delivered: 1,
    remaining: 0,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
};

const stopFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 1,
    delivered: 0,
    remaining: 1,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
};

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();
  enqueueSpy.mockReset().mockResolvedValue(undefined);
  flushSpy.mockReset().mockResolvedValue(successFlush);

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

function seedCache(items: HabitResponse[]): void {
  prefsStore.set(
    HABITS_CACHE_KEY,
    JSON.stringify({ fetched_at: '2026-05-01T00:00:00Z', items }),
  );
}

function makeHabit(overrides: Partial<HabitResponse> = {}): HabitResponse {
  return {
    id: overrides.id ?? 'h-1',
    routine_id: overrides.routine_id ?? null,
    title: overrides.title ?? 'Take meds',
    description: null,
    status: 'active',
    frequency: overrides.frequency ?? 'daily',
    notification_frequency: 'daily',
    scaffolding_status: overrides.scaffolding_status ?? 'tracking',
    accountable_since: null,
    graduation_window: null,
    graduation_target: null,
    graduation_threshold: null,
    friction_score: null,
    position: null,
    re_scaffold_count: 0,
    last_frequency_changed_at: null,
    graduated_at: overrides.graduated_at ?? null,
    current_streak: overrides.current_streak ?? 3,
    best_streak: overrides.best_streak ?? 7,
    last_completed: overrides.last_completed ?? '2026-05-01',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    effective_graduation_params: {
      window_days: 30,
      target_rate: 0.8,
      threshold_days: 5,
      source: 'friction_default',
    },
  };
}

interface FetchOptions {
  habitsResponse?: { status: number; items?: HabitResponse[] };
  habitsRejection?: Error;
  routineByName?: Record<string, { id: string; title: string }>;
}

function stubFetch(opts: FetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/habits/')) {
        if (opts.habitsRejection) throw opts.habitsRejection;
        const r = opts.habitsResponse ?? { status: 200, items: [] };
        if (r.status === 200) {
          return new Response(
            JSON.stringify({ items: r.items ?? [], count: (r.items ?? []).length }),
            { status: 200 },
          );
        }
        return new Response('', { status: r.status });
      }
      if (url.includes('/api/routines/')) {
        const id = url.split('/api/routines/')[1] ?? '';
        const map = opts.routineByName ?? {};
        const found = map[id];
        if (found) {
          return new Response(JSON.stringify(found), { status: 200 });
        }
        return new Response('', { status: 404 });
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
      <MemoryRouter initialEntries={['/habits']}>
        <HabitsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('HabitsPage — bootstrap states', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});

describe('HabitsPage — list render with mixed statuses', () => {
  it('renders tracking, accountable, and graduated habits with status pills', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [
          makeHabit({ id: 'h-track', title: 'Tracking habit', scaffolding_status: 'tracking', current_streak: 5 }),
          makeHabit({ id: 'h-acct', title: 'Accountable habit', scaffolding_status: 'accountable', current_streak: 3 }),
          makeHabit({
            id: 'h-grad',
            title: 'Graduated habit',
            scaffolding_status: 'graduated',
            graduated_at: '2026-04-15T00:00:00Z',
          }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Tracking habit')).toBeInTheDocument();
    expect(screen.getByText('Accountable habit')).toBeInTheDocument();
    expect(screen.getByText('Graduated habit')).toBeInTheDocument();

    expect(screen.getByTestId('status-pill-tracking')).toBeInTheDocument();
    expect(screen.getByTestId('status-pill-accountable')).toBeInTheDocument();
    expect(screen.getByTestId('status-pill-graduated')).toBeInTheDocument();
  });

  it('renders the routine name when a habit is part of a routine', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [
          makeHabit({
            id: 'h-1',
            title: 'Stretch',
            routine_id: 'r-morning',
          }),
        ],
      },
      routineByName: { 'r-morning': { id: 'r-morning', title: 'Morning kit' } },
    });

    renderPage();

    expect(await screen.findByText('Stretch')).toBeInTheDocument();
    expect(
      await screen.findByText(/Part of: Morning kit/),
    ).toBeInTheDocument();
  });
});

describe('HabitsPage — graduated section separation', () => {
  it('shows a Graduated header with the graduated habits below', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [
          makeHabit({ id: 'a', title: 'Active habit', scaffolding_status: 'tracking' }),
          makeHabit({
            id: 'g',
            title: 'Old habit',
            scaffolding_status: 'graduated',
            graduated_at: '2026-04-01T00:00:00Z',
          }),
        ],
      },
    });

    renderPage();

    const graduatedHeader = await screen.findByText('Graduated');
    expect(graduatedHeader).toBeInTheDocument();

    // Active habit row is in the primary list (no streak indicator hidden);
    // graduated habit row carries the graduated pill.
    expect(screen.getByTestId('habit-streak-a')).toBeInTheDocument();
    expect(screen.queryByTestId('habit-streak-g')).not.toBeInTheDocument();
  });
});

describe('HabitsPage — empty state', () => {
  it('shows the create-via-CLI message when there are no habits', async () => {
    pair();
    stubFetch({ habitsResponse: { status: 200, items: [] } });

    renderPage();

    expect(
      await screen.findByText(/no habits yet\. create habits via brain3/i),
    ).toBeInTheDocument();
  });
});

describe('HabitsPage — quick-complete optimistic flip', () => {
  it('increments the displayed streak when last_completed is not today', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [
          makeHabit({
            id: 'h-1',
            title: 'Stretch',
            current_streak: 4,
            best_streak: 9,
            last_completed: '2026-05-01', // yesterday relative to mocked today
          }),
        ],
      },
    });

    renderPage();

    const streakLine = await screen.findByTestId('habit-streak-h-1');
    expect(streakLine).toHaveTextContent('Streak: 4 · Best: 9');

    // Stop flush so the optimistic boost survives the await — exercises the
    // "row holds the +1 while queued" branch of the spec.
    flushSpy.mockResolvedValueOnce(stopFlush);

    const button = screen.getByTestId('habit-quick-complete-h-1');
    await userEvent.click(button);

    await waitFor(() => {
      expect(streakLine).toHaveTextContent('Streak: 5 · Best: 9');
    });
    expect(enqueueSpy).toHaveBeenCalledWith({
      habit_id: 'h-1',
      completed_date: '2026-05-02',
      notes: null,
      enqueued_at: expect.any(String),
    });
  });

  it('does not increment the displayed streak when last_completed is today', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [
          makeHabit({
            id: 'h-1',
            title: 'Stretch',
            current_streak: 4,
            best_streak: 9,
            last_completed: '2026-05-02', // today
          }),
        ],
      },
    });

    renderPage();

    const streakLine = await screen.findByTestId('habit-streak-h-1');
    expect(streakLine).toHaveTextContent('Streak: 4 · Best: 9');

    flushSpy.mockResolvedValueOnce(stopFlush);
    await userEvent.click(screen.getByTestId('habit-quick-complete-h-1'));

    // Wait long enough for any state update to flush, then assert unchanged.
    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
    expect(streakLine).toHaveTextContent('Streak: 4 · Best: 9');
  });

  it('navigates to the detail route when the row body is tapped (not the button)', async () => {
    pair();
    stubFetch({
      habitsResponse: {
        status: 200,
        items: [makeHabit({ id: 'h-9', title: 'Walk' })],
      },
    });

    renderPage();

    const titleEl = await screen.findByText('Walk');
    await userEvent.click(titleEl);

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('/habits/h-9');
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe('HabitsPage — offline cache render', () => {
  it('renders cached items from initialData when the network fetch fails', async () => {
    pair();
    seedCache([
      makeHabit({
        id: 'h-cache',
        title: 'Cached habit',
        scaffolding_status: 'tracking',
        current_streak: 2,
        best_streak: 6,
      }),
    ]);
    stubFetch({ habitsRejection: new Error('offline') });

    renderPage();

    // Cached item paints immediately from initialData. The user-facing
    // "this is cached" affordance is the [2C-28] StalenessBanner, which is
    // connection-state gated (covered in StalenessBanner.test.tsx) rather
    // than gated on a single failed fetch as the prior inline hint was.
    expect(await screen.findByText('Cached habit')).toBeInTheDocument();
  });
});
