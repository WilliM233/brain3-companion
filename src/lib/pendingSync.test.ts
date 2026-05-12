/**
 * [2C-30] pendingSync aggregator tests. Co-located per repo CLAUDE.md v3;
 * spec named `tests/integration/settingsPendingSync.spec.tsx` — see PR body
 * Deviation #1 (precedent: [2C-28] PR #73).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import {
  __resetPendingSyncForTests,
  countFailures,
  countPending,
  getPendingSyncSnapshot,
  refreshPendingSync,
  subscribePendingSync,
} from './pendingSync';
import { __resetFlushStateForTests, emitFlushDetail } from './connection/writeQueueFlushState';
import { WRITE_QUEUE_KEY } from './writeQueue';
import {
  HABIT_COMPLETIONS_KEY,
  ROUTINE_COMPLETIONS_KEY,
} from './completionQueues';

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
  __resetPendingSyncForTests();
  __resetFlushStateForTests();
});

afterEach(() => {
  __resetPendingSyncForTests();
  __resetFlushStateForTests();
});

function seedNotificationEntries(count: number): void {
  const entries = Array.from({ length: count }, (_, i) => ({
    notification_id: `notif-${i}`,
    response: `Already done ${i}`,
    response_note: null,
    enqueued_at: '2026-05-12T10:00:00.000Z',
  }));
  prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify(entries));
}

function seedHabitEntries(count: number): void {
  const entries = Array.from({ length: count }, (_, i) => ({
    habit_id: `habit-${i}`,
    completed_date: '2026-05-12',
    notes: null,
    enqueued_at: '2026-05-12T10:00:00.000Z',
  }));
  prefsStore.set(HABIT_COMPLETIONS_KEY, JSON.stringify(entries));
}

function seedRoutineEntries(count: number): void {
  const entries = Array.from({ length: count }, (_, i) => ({
    routine_id: `routine-${i}`,
    completed_date: '2026-05-12',
    status: 'all_done',
    freeform_note: null,
    child_habit_completions: null,
    enqueued_at: '2026-05-12T10:00:00.000Z',
  }));
  prefsStore.set(ROUTINE_COMPLETIONS_KEY, JSON.stringify(entries));
}

function seedFailures(queueKey: string, count: number): void {
  const entries = Array.from({ length: count }, (_, i) => ({
    original_entry: { id: `entry-${i}` },
    http_status: 422,
    server_message: `Server rejected ${i}`,
    dropped_at: '2026-05-12T09:00:00.000Z',
  }));
  prefsStore.set(`brain.writeQueue.failures.${queueKey}`, JSON.stringify(entries));
}

describe('refreshPendingSync', () => {
  it('reads all three queue keys + all three failure logs', async () => {
    seedNotificationEntries(2);
    seedHabitEntries(1);
    seedRoutineEntries(3);
    seedFailures(WRITE_QUEUE_KEY, 1);
    seedFailures(HABIT_COMPLETIONS_KEY, 2);
    seedFailures(ROUTINE_COMPLETIONS_KEY, 0);

    await refreshPendingSync();
    const snap = getPendingSyncSnapshot();

    expect(snap.notificationEntries).toHaveLength(2);
    expect(snap.habitEntries).toHaveLength(1);
    expect(snap.routineEntries).toHaveLength(3);
    expect(snap.failures.notifications).toHaveLength(1);
    expect(snap.failures.habits).toHaveLength(2);
    expect(snap.failures.routines).toHaveLength(0);
    expect(countPending(snap)).toBe(6);
    expect(countFailures(snap)).toBe(3);
  });

  it('returns empty arrays when all keys are absent', async () => {
    await refreshPendingSync();
    const snap = getPendingSyncSnapshot();
    expect(countPending(snap)).toBe(0);
    expect(countFailures(snap)).toBe(0);
    expect(snap.lastAttemptAt).toBeNull();
  });

  it('tolerates malformed JSON on a queue key', async () => {
    prefsStore.set(WRITE_QUEUE_KEY, '{ not valid json');
    seedHabitEntries(1);
    await refreshPendingSync();
    const snap = getPendingSyncSnapshot();
    expect(snap.notificationEntries).toEqual([]);
    expect(snap.habitEntries).toHaveLength(1);
  });

  it('coalesces concurrent refresh calls', async () => {
    seedNotificationEntries(1);
    const first = refreshPendingSync();
    const second = refreshPendingSync();
    await Promise.all([first, second]);
    expect(getPendingSyncSnapshot().notificationEntries).toHaveLength(1);
    // Preferences.get is called once per key per refresh; 6 keys × 1 refresh = 6.
    expect(vi.mocked(Preferences.get)).toHaveBeenCalledTimes(6);
  });
});

async function settle(): Promise<void> {
  // Drain microtasks enough for Promise.all over 6 mocked Preferences.get calls
  // + the doRefresh .finally + the listener emit to all flush through.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('subscribePendingSync', () => {
  it('fires the listener on initial wire and on each flushDetail emission', async () => {
    seedNotificationEntries(1);
    const listener = vi.fn();
    const unsubscribe = subscribePendingSync(listener);
    await settle();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    emitFlushDetail({
      status: 'flushing',
      queueKey: WRITE_QUEUE_KEY,
      nextRetryAt: null,
    });
    await settle();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('records lastAttemptAt when a flushing transition arrives', async () => {
    seedHabitEntries(1);
    const before = Date.now();
    const unsubscribe = subscribePendingSync(() => undefined);
    await settle();
    expect(getPendingSyncSnapshot().lastAttemptAt).toBeNull();
    emitFlushDetail({
      status: 'flushing',
      queueKey: HABIT_COMPLETIONS_KEY,
      nextRetryAt: null,
    });
    await settle();
    const after = Date.now();
    const recorded = getPendingSyncSnapshot().lastAttemptAt;
    expect(recorded).not.toBeNull();
    expect(recorded!).toBeGreaterThanOrEqual(before);
    expect(recorded!).toBeLessThanOrEqual(after);
    unsubscribe();
  });

  it('does not record lastAttemptAt for non-flushing transitions', async () => {
    seedHabitEntries(1);
    const unsubscribe = subscribePendingSync(() => undefined);
    await settle();
    emitFlushDetail({
      status: 'idle',
      queueKey: HABIT_COMPLETIONS_KEY,
      nextRetryAt: null,
    });
    emitFlushDetail({
      status: 'backoff',
      queueKey: HABIT_COMPLETIONS_KEY,
      nextRetryAt: Date.now() + 30_000,
    });
    await settle();
    expect(getPendingSyncSnapshot().lastAttemptAt).toBeNull();
    unsubscribe();
  });
});
