/**
 * [2C-30] PendingSyncSection UI tests. Co-located per repo CLAUDE.md v3;
 * spec named `tests/integration/settingsPendingSync.spec.tsx` — see PR body
 * Deviation #1 (precedent: [2C-28] PR #73).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import PendingSyncSection from './PendingSyncSection';
import { __resetPendingSyncForTests } from '../lib/pendingSync';
import {
  __resetFlushStateForTests,
  emitFlushDetail,
} from '../lib/connection/writeQueueFlushState';
import { WRITE_QUEUE_KEY } from '../lib/writeQueue';
import {
  HABIT_COMPLETIONS_KEY,
  ROUTINE_COMPLETIONS_KEY,
} from '../lib/completionQueues';

const prefsStore = new Map<string, string>();

function withQueryClient(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefsStore.get(key) ?? null,
  }));
  __resetPendingSyncForTests();
  __resetFlushStateForTests();
});

afterEach(() => {
  __resetPendingSyncForTests();
  __resetFlushStateForTests();
});

describe('PendingSyncSection — hidden state', () => {
  it('renders nothing when all queues + failures are empty', async () => {
    const qc = new QueryClient();
    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    expect(screen.queryByTestId('pending-sync-section')).toBeNull();
  });

  it('renders when only the failures log has entries (live queue empty)', async () => {
    prefsStore.set(
      `brain.writeQueue.failures.${WRITE_QUEUE_KEY}`,
      JSON.stringify([
        {
          original_entry: { notification_id: 'n1' },
          http_status: 422,
          server_message: 'rejected',
          dropped_at: '2026-05-12T08:00:00.000Z',
        },
      ]),
    );
    const qc = new QueryClient();
    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    expect(screen.getByTestId('pending-sync-section')).toBeDefined();
  });
});

describe('PendingSyncSection — collapsed copy', () => {
  it('renders "Pending sync: N writes" summing all three queues', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        {
          notification_id: 'n1',
          response: 'Already done',
          response_note: null,
          enqueued_at: '2026-05-12T10:00:00.000Z',
        },
        {
          notification_id: 'n2',
          response: 'Snooze',
          response_note: null,
          enqueued_at: '2026-05-12T10:01:00.000Z',
        },
      ]),
    );
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        {
          habit_id: 'h1',
          completed_date: '2026-05-12',
          notes: null,
          enqueued_at: '2026-05-12T10:02:00.000Z',
        },
      ]),
    );
    prefsStore.set(
      ROUTINE_COMPLETIONS_KEY,
      JSON.stringify([
        {
          routine_id: 'r1',
          completed_date: '2026-05-12',
          status: 'all_done',
          freeform_note: null,
          child_habit_completions: null,
          enqueued_at: '2026-05-12T10:03:00.000Z',
        },
      ]),
    );
    const qc = new QueryClient();
    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    const toggle = screen.getByTestId('pending-sync-toggle');
    expect(toggle.textContent).toMatch(/Pending sync: 4 writes/);
  });

  it('omits "last attempt" suffix when no flush has been observed', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        {
          notification_id: 'n1',
          response: 'Already done',
          response_note: null,
          enqueued_at: '2026-05-12T10:00:00.000Z',
        },
      ]),
    );
    const qc = new QueryClient();
    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    const toggle = screen.getByTestId('pending-sync-toggle');
    expect(toggle.textContent).not.toMatch(/last attempt/);
  });

  it('includes "last attempt" suffix once a flushing transition fires', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        {
          habit_id: 'h1',
          completed_date: '2026-05-12',
          notes: null,
          enqueued_at: '2026-05-12T10:00:00.000Z',
        },
      ]),
    );
    const qc = new QueryClient();
    const { rerender } = render(<PendingSyncSection />, {
      wrapper: withQueryClient(qc),
    });
    await flushPromises();
    act(() => {
      emitFlushDetail({
        status: 'flushing',
        queueKey: HABIT_COMPLETIONS_KEY,
        nextRetryAt: null,
      });
    });
    await flushPromises();
    rerender(<PendingSyncSection />);
    const toggle = screen.getByTestId('pending-sync-toggle');
    expect(toggle.textContent).toMatch(/last attempt/);
  });
});

describe('PendingSyncSection — expanded sections', () => {
  it('renders all four sections on toggle, with title resolution from query cache', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        {
          notification_id: '12345678-aaaa-bbbb-cccc-dddddddddddd',
          response: 'Already done',
          response_note: null,
          enqueued_at: '2026-05-12T10:00:00.000Z',
        },
      ]),
    );
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        {
          habit_id: 'habit-abc-1',
          completed_date: '2026-05-12',
          notes: null,
          enqueued_at: '2026-05-12T10:00:00.000Z',
        },
        {
          habit_id: 'habit-unknown',
          completed_date: '2026-05-12',
          notes: null,
          enqueued_at: '2026-05-12T10:01:00.000Z',
        },
      ]),
    );
    prefsStore.set(
      ROUTINE_COMPLETIONS_KEY,
      JSON.stringify([
        {
          routine_id: 'routine-xyz-1',
          completed_date: '2026-05-12',
          status: 'partial',
          freeform_note: null,
          child_habit_completions: null,
          enqueued_at: '2026-05-12T10:02:00.000Z',
        },
      ]),
    );
    prefsStore.set(
      `brain.writeQueue.failures.${WRITE_QUEUE_KEY}`,
      JSON.stringify([
        {
          original_entry: { notification_id: 'old-n1' },
          http_status: 422,
          server_message: 'Validation failed: response not in allowed set',
          dropped_at: '2026-05-12T09:00:00.000Z',
        },
      ]),
    );

    const qc = new QueryClient();
    qc.setQueryData(
      ['habits', 'active'],
      [{ id: 'habit-abc-1', title: 'Morning meds' }],
    );
    qc.setQueryData(
      ['routines', 'active'],
      [{ id: 'routine-xyz-1', title: 'Wind-down' }],
    );

    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('pending-sync-toggle'));

    const expanded = screen.getByTestId('pending-sync-expanded');
    expect(within(expanded).getByText('Notification responses')).toBeDefined();
    expect(within(expanded).getByText('Habit completions')).toBeDefined();
    expect(within(expanded).getByText('Routine completions')).toBeDefined();
    expect(within(expanded).getByText('Recent failures')).toBeDefined();

    // Habit title resolved from cache.
    expect(within(expanded).getByText('Morning meds')).toBeDefined();
    // Unknown habit falls back to short ID prefix (first 8 chars).
    expect(within(expanded).getByText('habit-un')).toBeDefined();
    // Routine title resolved from cache.
    expect(within(expanded).getByText('Wind-down')).toBeDefined();
  });

  it('renders failure rows with a red pill containing the HTTP status', async () => {
    prefsStore.set(
      `brain.writeQueue.failures.${WRITE_QUEUE_KEY}`,
      JSON.stringify([
        {
          original_entry: { notification_id: 'old-n1' },
          http_status: 422,
          server_message: 'rejected',
          dropped_at: '2026-05-12T09:00:00.000Z',
        },
      ]),
    );
    const qc = new QueryClient();
    render(<PendingSyncSection />, { wrapper: withQueryClient(qc) });
    await flushPromises();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('pending-sync-toggle'));
    const pill = screen.getByTestId('pending-sync-failure-pill');
    expect(pill.textContent).toBe('422');
    expect(pill.className).toMatch(/red/);
  });
});
