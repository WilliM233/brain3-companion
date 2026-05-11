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
import { CHECKINS_CACHE_KEY, type CheckinResponse } from '../lib/checkins';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import CheckinsPage from './CheckinsPage';

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

function seedCache(items: CheckinResponse[]): void {
  prefsStore.set(
    CHECKINS_CACHE_KEY,
    JSON.stringify({ fetched_at: '2026-05-09T00:00:00Z', items }),
  );
}

function makeCheckin(overrides: Partial<CheckinResponse> = {}): CheckinResponse {
  return {
    id: overrides.id ?? 'c-1',
    checkin_type: overrides.checkin_type ?? 'morning',
    energy_level: overrides.energy_level ?? null,
    mood: overrides.mood ?? null,
    focus_level: overrides.focus_level ?? null,
    freeform_note: overrides.freeform_note ?? null,
    context: overrides.context ?? null,
    logged_at: overrides.logged_at ?? '2026-05-09T08:00:00Z',
  };
}

interface FetchOptions {
  response?: { status: number; items?: CheckinResponse[] };
  rejection?: Error;
}

function stubFetch(opts: FetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/checkins/')) {
        if (opts.rejection) throw opts.rejection;
        const r = opts.response ?? { status: 200, items: [] };
        if (r.status === 200) {
          return new Response(JSON.stringify(r.items ?? []), { status: 200 });
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
      <MemoryRouter initialEntries={['/checkins']}>
        <CheckinsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('CheckinsPage — bootstrap', () => {
  it('shows the no-pairing message when the app is unpaired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});

describe('CheckinsPage — list render', () => {
  it('renders rows with friendly type, numeric subtitle, note preview, and relative time', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [
          makeCheckin({
            id: 'c-1',
            checkin_type: 'morning',
            energy_level: 4,
            focus_level: 3,
            mood: 5,
            freeform_note: 'Feeling sharp today after a solid night.',
            // Two hours before the test render time — exact relative wording
            // is not asserted here (drift between fixture and `Date.now()`),
            // just that the row mounts.
            logged_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
          }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning check-in')).toBeInTheDocument();
    expect(screen.getByText('Energy 4 · Focus 3 · Mood 5')).toBeInTheDocument();
    expect(
      screen.getByText('Feeling sharp today after a solid night.'),
    ).toBeInTheDocument();
  });

  it('omits the numeric subtitle when no numeric values are populated', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [
          makeCheckin({
            id: 'c-2',
            checkin_type: 'freeform',
            freeform_note: 'just some thoughts',
          }),
        ],
      },
    });

    renderPage();

    expect(await screen.findByText('Freeform check-in')).toBeInTheDocument();
    expect(screen.queryByText(/Energy /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Mood /)).not.toBeInTheDocument();
    expect(screen.getByText('just some thoughts')).toBeInTheDocument();
  });

  it('truncates long freeform notes to 60 chars with ellipsis', async () => {
    pair();
    const longNote =
      'this is a long freeform note that exceeds the sixty character preview window for sure';
    stubFetch({
      response: {
        status: 200,
        items: [
          makeCheckin({
            id: 'c-3',
            checkin_type: 'evening',
            freeform_note: longNote,
          }),
        ],
      },
    });

    renderPage();

    const expected = `${longNote.slice(0, 60)}…`;
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

describe('CheckinsPage — empty state', () => {
  it('shows the "no check-ins yet" empty-state message', async () => {
    pair();
    stubFetch({ response: { status: 200, items: [] } });
    renderPage();
    expect(
      await screen.findByText(
        /no check-ins yet\. they appear here when you respond/i,
      ),
    ).toBeInTheDocument();
  });
});

describe('CheckinsPage — navigation', () => {
  it('pushes /checkins/:id when a row is tapped', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        items: [makeCheckin({ id: 'c-9', checkin_type: 'morning' })],
      },
    });

    renderPage();

    const title = await screen.findByText('Morning check-in');
    await userEvent.click(title);

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith('/checkins/c-9');
    });
  });
});

describe('CheckinsPage — offline cache', () => {
  it('renders cached items from initialData when the network fetch fails', async () => {
    pair();
    seedCache([
      makeCheckin({
        id: 'c-cache',
        checkin_type: 'midday',
        freeform_note: 'cached entry',
      }),
    ]);
    stubFetch({ rejection: new Error('offline') });

    renderPage();

    // Cache-fallback affordance: cached rows render. The "this is cached"
    // affordance moved to the [2C-28] StalenessBanner (connection-state
    // gated; covered in StalenessBanner.test.tsx).
    expect(await screen.findByText('Midday check-in')).toBeInTheDocument();
    expect(screen.getByText('cached entry')).toBeInTheDocument();
  });
});

describe('CheckinsPage — fetch URL', () => {
  it('issues GET against /api/checkins/ with logged_after and bearer token', async () => {
    pair();
    const fetchSpy = stubFetch({ response: { status: 200, items: [] } });

    renderPage();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const checkinsCall = fetchSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('/api/checkins/'),
    );
    expect(checkinsCall).toBeDefined();
    const url = checkinsCall![0] as string;
    expect(url.startsWith(`${PAIRED_URL}/api/checkins/`)).toBe(true);
    expect(url).toContain('logged_after=');
    const init = checkinsCall![1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: `Bearer ${PAIRED_TOKEN}` });
  });
});
