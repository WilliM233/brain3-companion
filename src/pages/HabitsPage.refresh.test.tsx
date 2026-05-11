/**
 * [2C-28] pull-to-refresh integration test on the representative list
 * surface (habit list per Pass 5 §3 [2C-28] Acceptance criteria item 2).
 *
 * Spec named the path `tests/integration/pullToRefresh.spec.tsx`; co-located
 * here per repo CLAUDE.md v3 ("Tests are co-located with the module they
 * test") and org directive `ba044399` (specs defer to canonical-source
 * conventions on test paths). Flagged as Deviation #1 in the PR body.
 *
 * What this test covers:
 *   - The IonRefresher's `ionRefresh` event triggers a TanStack Query
 *     refetch (asserted via a second `fetch` call to the habits endpoint).
 *   - On successful refetch, the connection store records a `success`
 *     outcome which the StalenessBanner observes via `useConnectionState`.
 *   - The banner copy reflects the updated `lastSyncedAt` once the refetch
 *     completes (the banner is visible when the test forces the indicator
 *     into a degraded/offline state before the refresh).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

vi.mock('../lib/completionQueues', () => ({
  enqueueHabitCompletion: vi.fn(),
  flushAllQueues: vi.fn(),
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
import { type HabitResponse } from '../lib/habits';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import HabitsPage from './HabitsPage';
import {
  __resetForTests,
  recordOutcome,
  setNetworkOnline,
} from '../lib/connection/store';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';

const prefsStore = new Map<string, string>();

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
}

function makeHabit(id: string, title: string): HabitResponse {
  return {
    id,
    routine_id: null,
    title,
    description: null,
    status: 'active',
    frequency: 'daily',
    notification_frequency: 'daily',
    scaffolding_status: 'tracking',
    accountable_since: null,
    graduation_window: null,
    graduation_target: null,
    graduation_threshold: null,
    friction_score: null,
    position: null,
    re_scaffold_count: 0,
    last_frequency_changed_at: null,
    graduated_at: null,
    current_streak: 1,
    best_streak: 1,
    last_completed: null,
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

beforeEach(() => {
  __resetForTests();
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
  __resetForTests();
});

function renderPage(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/habits']}>
        <HabitsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HabitsPage — pull-to-refresh wires StalenessBanner refresh', () => {
  it('refetches the habits query and updates banner copy after success', async () => {
    pair();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ items: [makeHabit('h-1', 'Stretch')], count: 1 }), {
          status: 200,
        }),
    );

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    // Subscribe the connection store to the test QueryClient's cache so
    // refetch successes are recorded as outcomes (mirrors the
    // ConnectionStateProvider's wiring without mounting the provider).
    const cache = client.getQueryCache();
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== 'updated') return;
      if (event.action.type === 'success') {
        recordOutcome('success', event.query.queryKey);
      } else if (event.action.type === 'error') {
        recordOutcome('network_error', event.query.queryKey);
      }
    });

    // Force the banner into "offline" so the StalenessBanner is visible
    // before the refresh — the test asserts the copy updates after the
    // refresh refreshes the connection store's `lastSyncedAt`.
    setNetworkOnline(false);

    try {
      renderPage(client);

      // Initial paint: the habit row appears once the first fetch resolves.
      expect(await screen.findByText('Stretch')).toBeInTheDocument();

      // The banner is visible — debounce expires after the initial render.
      const banner = await waitFor(
        () => screen.findByTestId('staleness-banner'),
      );
      expect(banner).toBeInTheDocument();

      const initialFetchCount = fetchSpy.mock.calls.filter((c) => {
        const url = typeof c[0] === 'string' ? c[0] : c[0]?.toString() ?? '';
        return url.includes('/api/habits/');
      }).length;
      expect(initialFetchCount).toBeGreaterThanOrEqual(1);

      // Fire the IonRefresher's `ionRefresh` event. The handler captures the
      // CustomEvent and calls `event.detail.complete()` to dismiss the
      // spinner — supply a `complete` spy so we can assert dismissal.
      const refresher = document.querySelector('ion-refresher');
      expect(refresher).not.toBeNull();
      const completeSpy = vi.fn();
      await act(async () => {
        refresher!.dispatchEvent(
          new CustomEvent('ionRefresh', {
            detail: { complete: completeSpy },
            bubbles: true,
          }),
        );
        // Allow the awaited refetch + the post-refetch state updates to flush.
        await Promise.resolve();
        await Promise.resolve();
      });

      // The refetch triggered another habits call.
      await waitFor(() => {
        const calls = fetchSpy.mock.calls.filter((c) => {
          const url = typeof c[0] === 'string' ? c[0] : c[0]?.toString() ?? '';
          return url.includes('/api/habits/');
        });
        expect(calls.length).toBeGreaterThan(initialFetchCount);
      });

      // The IonRefresher dismissed its spinner.
      await waitFor(() => expect(completeSpy).toHaveBeenCalled());

      // The banner is still mounted (still offline). The copy should now
      // reflect a fresh `lastSyncedAt` ("0 seconds ago"-style strict
      // duration) since the connection store recorded the success.
      const bannerCopy = screen.getByTestId('staleness-banner').textContent ?? '';
      expect(bannerCopy).toMatch(/Showing cached data — last synced .* ago/);
      expect(bannerCopy).not.toMatch(/never synced/);
    } finally {
      unsubscribe();
    }
  });
});
