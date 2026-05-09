import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import type { CheckinResponse } from '../lib/checkins';
import CheckinDetailPage from './CheckinDetailPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';
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

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
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
  response?: { status: number; checkin?: CheckinResponse };
}

function stubFetch(opts: FetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/checkins/')) {
        const r = opts.response ?? { status: 404 };
        if (r.status === 200 && r.checkin) {
          return new Response(JSON.stringify(r.checkin), { status: 200 });
        }
        return new Response('', { status: r.status });
      }
      return new Response('', { status: 404 });
    });
}

function renderDetail(checkinId: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/checkins/${checkinId}`]}>
        <Route path="/checkins/:checkinId">
          <CheckinDetailPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('CheckinDetailPage — render', () => {
  it('renders all populated fields including the full freeform note', async () => {
    pair();
    const longNote =
      'this is the full freeform note text that should not be truncated on the detail surface — '
      + 'it stretches well past sixty characters to confirm full render.';
    stubFetch({
      response: {
        status: 200,
        checkin: makeCheckin({
          id: 'c-9',
          checkin_type: 'evening',
          energy_level: 3,
          focus_level: 2,
          mood: 4,
          freeform_note: longNote,
          context: 'after dinner',
          logged_at: '2026-05-09T20:30:00Z',
        }),
      },
    });

    renderDetail('c-9');

    expect(await screen.findByText('Evening check-in')).toBeInTheDocument();
    expect(screen.getByText('after dinner')).toBeInTheDocument();
    expect(screen.getByTestId('checkin-detail-energy')).toHaveTextContent(
      '3 / 5',
    );
    expect(screen.getByTestId('checkin-detail-focus')).toHaveTextContent(
      '2 / 5',
    );
    expect(screen.getByTestId('checkin-detail-mood')).toHaveTextContent(
      '4 / 5',
    );
    expect(screen.getByTestId('checkin-detail-note')).toHaveTextContent(
      longNote,
    );
  });

  it('omits numeric rows for null fields', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        checkin: makeCheckin({
          id: 'c-1',
          checkin_type: 'micro',
          energy_level: 2,
          focus_level: null,
          mood: null,
        }),
      },
    });

    renderDetail('c-1');

    expect(await screen.findByText('Micro check-in')).toBeInTheDocument();
    expect(screen.getByTestId('checkin-detail-energy')).toBeInTheDocument();
    expect(screen.queryByTestId('checkin-detail-focus')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkin-detail-mood')).not.toBeInTheDocument();
  });

  it('omits the note section when freeform_note is null', async () => {
    pair();
    stubFetch({
      response: {
        status: 200,
        checkin: makeCheckin({
          id: 'c-2',
          checkin_type: 'morning',
          energy_level: 4,
          freeform_note: null,
        }),
      },
    });

    renderDetail('c-2');

    expect(await screen.findByText('Morning check-in')).toBeInTheDocument();
    expect(screen.queryByTestId('checkin-detail-note')).not.toBeInTheDocument();
  });

  it('shows "Check-in not found." when the server returns 404', async () => {
    pair();
    stubFetch({ response: { status: 404 } });

    renderDetail('c-missing');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /check-in not found/i,
      );
    });
  });

  it('shows the unpaired message when the app is not paired', async () => {
    stubFetch();
    renderDetail('c-1');
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });
});
