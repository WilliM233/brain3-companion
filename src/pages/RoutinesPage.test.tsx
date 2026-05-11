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
import {
  ROUTINES_CACHE_KEY,
  type RoutineResponse,
} from '../lib/routines';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import RoutinesPage from './RoutinesPage';

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

function seedCache(items: RoutineResponse[]): void {
  prefsStore.set(
    ROUTINES_CACHE_KEY,
    JSON.stringify({ fetched_at: '2026-05-01T00:00:00Z', items }),
  );
}

function makeRoutine(overrides: Partial<RoutineResponse> = {}): RoutineResponse {
  return {
    id: overrides.id ?? 'r-1',
    title: overrides.title ?? 'Morning kit',
    frequency: overrides.frequency ?? 'daily',
    status: overrides.status ?? 'active',
    current_streak: overrides.current_streak ?? 3,
    best_streak: overrides.best_streak ?? 7,
    last_completed: overrides.last_completed ?? '2026-05-01',
  };
}

interface FetchOptions {
  routinesResponse?: { status: number; items?: RoutineResponse[] };
  routinesRejection?: Error;
}

function stubFetch(opts: FetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/routines/')) {
        if (opts.routinesRejection) throw opts.routinesRejection;
        const r = opts.routinesResponse ?? { status: 200, items: [] };
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
      // ConnectionIndicator pings /api/health — return 200 to keep it quiet.
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
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
      <MemoryRouter initialEntries={['/routines']}>
        <RoutinesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('RoutinesPage — bootstrap states', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});

describe('RoutinesPage — list render', () => {
  it('queries /api/routines/?status=active and renders each routine row', async () => {
    pair();
    const fetchSpy = stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: 'r-1', title: 'Morning kit', frequency: 'daily' }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning kit')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByTestId('routine-streak-r-1')).toHaveTextContent(
      'Streak: 3 · Best: 7',
    );

    const routineFetch = fetchSpy.mock.calls
      .map(([url]) => (typeof url === 'string' ? url : url.toString()))
      .find((url) => url.includes('/api/routines/'));
    expect(routineFetch).toBe(`${PAIRED_URL}/api/routines/?status=active`);
  });

  it('renders routines alphabetically by title', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: 'c', title: 'Wind-down' }),
          makeRoutine({ id: 'a', title: 'Evening reset' }),
          makeRoutine({ id: 'b', title: 'Morning kit' }),
        ],
      },
    });

    renderPage();

    await screen.findByText('Wind-down');

    const titles = screen
      .getAllByRole('heading', { level: 2 })
      .map((el) => el.textContent);
    expect(titles).toEqual(['Evening reset', 'Morning kit', 'Wind-down']);
  });

  it('renders each frequency value with the spec-mandated label', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: '1', title: 'A daily', frequency: 'daily' }),
          makeRoutine({ id: '2', title: 'B weekdays', frequency: 'weekdays' }),
          makeRoutine({ id: '3', title: 'C weekends', frequency: 'weekends' }),
          makeRoutine({ id: '4', title: 'D weekly', frequency: 'weekly' }),
          makeRoutine({ id: '5', title: 'E custom', frequency: 'custom' }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('A daily')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Weekdays')).toBeInTheDocument();
    expect(screen.getByText('Weekends')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });
});

describe('RoutinesPage — today completion pill', () => {
  it('shows "Done today" (green) when last_completed equals today', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: 'r-1', title: 'Morning kit', last_completed: '2026-05-02' }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning kit')).toBeInTheDocument();
    expect(screen.getByTestId('today-pill-done-r-1')).toHaveTextContent(
      'Done today',
    );
    expect(screen.queryByTestId('today-pill-not-yet-r-1')).toBeNull();
  });

  it('shows "Not yet" (gray) when last_completed is before today', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: 'r-1', title: 'Morning kit', last_completed: '2026-05-01' }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning kit')).toBeInTheDocument();
    expect(screen.getByTestId('today-pill-not-yet-r-1')).toHaveTextContent(
      'Not yet',
    );
    expect(screen.queryByTestId('today-pill-done-r-1')).toBeNull();
  });

  it('shows "Not yet" when last_completed is null', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [
          makeRoutine({ id: 'r-1', title: 'Morning kit', last_completed: null }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning kit')).toBeInTheDocument();
    expect(screen.getByTestId('today-pill-not-yet-r-1')).toHaveTextContent(
      'Not yet',
    );
  });
});

describe('RoutinesPage — empty state', () => {
  it('shows the create-via-CLI message when there are no routines', async () => {
    pair();
    stubFetch({ routinesResponse: { status: 200, items: [] } });

    renderPage();

    expect(
      await screen.findByText(/no routines yet\. create routines via brain3/i),
    ).toBeInTheDocument();
  });
});

describe('RoutinesPage — navigation', () => {
  it('navigates to /routines/{id} when a row is tapped', async () => {
    pair();
    stubFetch({
      routinesResponse: {
        status: 200,
        items: [makeRoutine({ id: 'r-9', title: 'Evening reset' })],
      },
    });

    renderPage();

    const titleEl = await screen.findByText('Evening reset');
    await userEvent.click(titleEl);

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('/routines/r-9');
    });
  });
});

describe('RoutinesPage — offline cache render', () => {
  it('renders cached items from initialData when the network fetch fails', async () => {
    pair();
    seedCache([
      makeRoutine({
        id: 'r-cache',
        title: 'Cached routine',
        current_streak: 2,
        best_streak: 6,
      }),
    ]);
    stubFetch({ routinesRejection: new Error('offline') });

    renderPage();

    // Cached item paints immediately from initialData. The "this is cached"
    // affordance moved to the [2C-28] StalenessBanner (connection-state
    // gated; covered in StalenessBanner.test.tsx).
    expect(await screen.findByText('Cached routine')).toBeInTheDocument();
  });
});
