/**
 * [2C-30] read-side aggregator backing the Settings → Pending sync surface.
 *
 * Reads three live queues + their three failures logs from
 * `@capacitor/preferences` and exposes a single snapshot covering all of
 * them. Subscribes to `[2C-29]`'s `subscribeFlushDetail` so a flush
 * transition (`flushing → idle/backoff`) refreshes the snapshot and a
 * `flushing` transition records the `lastAttemptAt` timestamp that drives
 * the row's "last attempt Xm ago" copy.
 *
 * Refresh triggers:
 * - Initial read on first subscribe (lazy).
 * - Every `subscribeFlushDetail` emission (covers permanent-failure drops
 *   too, since those are recorded inside the flush loop before the
 *   `idle`/`backoff` transition fires).
 * - `document.visibilitychange` foreground per Pass 5 Summary §3 [2C-30].
 *
 * `lastAttemptAt` is tracked in-memory only; on cold start the value is
 * `null` until the first flush fires. In practice `initWriteQueue` /
 * `initCompletionQueues` trigger a flush near-instantly on mount, so the
 * gap before the row shows the suffix is brief. Persisting across launches
 * would require a fourth Preferences key for marginal benefit.
 */

import { Preferences } from '@capacitor/preferences';
import {
  WRITE_QUEUE_KEY,
  readFailures,
  type PermanentFailureRecord,
  type WriteQueueEntry,
} from './writeQueue';
import {
  HABIT_COMPLETIONS_KEY,
  ROUTINE_COMPLETIONS_KEY,
  type HabitCompletionEntry,
  type RoutineCompletionEntry,
} from './completionQueues';
import { subscribeFlushDetail } from './connection/writeQueueFlushState';

export interface PendingSyncFailures {
  notifications: PermanentFailureRecord<WriteQueueEntry>[];
  habits: PermanentFailureRecord<HabitCompletionEntry>[];
  routines: PermanentFailureRecord<RoutineCompletionEntry>[];
}

export interface PendingSyncSnapshot {
  notificationEntries: WriteQueueEntry[];
  habitEntries: HabitCompletionEntry[];
  routineEntries: RoutineCompletionEntry[];
  failures: PendingSyncFailures;
  /** Epoch-millis of the last observed `flushing` transition, or null. */
  lastAttemptAt: number | null;
}

type Listener = () => void;

const EMPTY_SNAPSHOT: PendingSyncSnapshot = {
  notificationEntries: [],
  habitEntries: [],
  routineEntries: [],
  failures: { notifications: [], habits: [], routines: [] },
  lastAttemptAt: null,
};

let snapshot: PendingSyncSnapshot = EMPTY_SNAPSHOT;
let lastAttemptAt: number | null = null;
const listeners = new Set<Listener>();
let wired = false;
let pendingRefresh: Promise<void> | null = null;
let flushDetailUnsubscribe: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

async function readQueue<T>(key: string): Promise<T[]> {
  const { value } = await Preferences.get({ key });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

async function doRefresh(): Promise<void> {
  const [
    notificationEntries,
    habitEntries,
    routineEntries,
    notificationFailures,
    habitFailures,
    routineFailures,
  ] = await Promise.all([
    readQueue<WriteQueueEntry>(WRITE_QUEUE_KEY),
    readQueue<HabitCompletionEntry>(HABIT_COMPLETIONS_KEY),
    readQueue<RoutineCompletionEntry>(ROUTINE_COMPLETIONS_KEY),
    readFailures<WriteQueueEntry>(WRITE_QUEUE_KEY),
    readFailures<HabitCompletionEntry>(HABIT_COMPLETIONS_KEY),
    readFailures<RoutineCompletionEntry>(ROUTINE_COMPLETIONS_KEY),
  ]);
  snapshot = {
    notificationEntries,
    habitEntries,
    routineEntries,
    failures: {
      notifications: notificationFailures,
      habits: habitFailures,
      routines: routineFailures,
    },
    lastAttemptAt,
  };
  emit();
}

/**
 * Read all six Preferences keys and replace the in-memory snapshot.
 * Concurrent calls coalesce — a second call while one is in flight awaits
 * the in-flight refresh rather than racing it.
 */
export function refreshPendingSync(): Promise<void> {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = doRefresh().finally(() => {
    pendingRefresh = null;
  });
  return pendingRefresh;
}

function wireListeners(): void {
  if (wired) return;
  wired = true;
  flushDetailUnsubscribe = subscribeFlushDetail((detail) => {
    if (detail.status === 'flushing') {
      lastAttemptAt = Date.now();
    }
    void refreshPendingSync();
  });
  if (typeof document !== 'undefined') {
    visibilityHandler = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshPendingSync();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

function unwireListeners(): void {
  if (!wired) return;
  wired = false;
  flushDetailUnsubscribe?.();
  flushDetailUnsubscribe = null;
  if (visibilityHandler !== null && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}

/**
 * Subscribe to snapshot changes. The first subscribe wires the flush-detail
 * + visibility listeners and kicks off an initial read; the last
 * unsubscribe tears them down so tests can reset cleanly.
 */
export function subscribePendingSync(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    wireListeners();
    void refreshPendingSync();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unwireListeners();
    }
  };
}

/**
 * Synchronous read of the current snapshot. Returns a stable reference
 * between updates so `useSyncExternalStore` does not re-render unnecessarily.
 */
export function getPendingSyncSnapshot(): PendingSyncSnapshot {
  return snapshot;
}

export function getServerSnapshot(): PendingSyncSnapshot {
  return EMPTY_SNAPSHOT;
}

/** Total pending writes across all three queues. */
export function countPending(snap: PendingSyncSnapshot): number {
  return (
    snap.notificationEntries.length +
    snap.habitEntries.length +
    snap.routineEntries.length
  );
}

/** Total recorded failures across all three queues. */
export function countFailures(snap: PendingSyncSnapshot): number {
  return (
    snap.failures.notifications.length +
    snap.failures.habits.length +
    snap.failures.routines.length
  );
}

export function __resetPendingSyncForTests(): void {
  unwireListeners();
  listeners.clear();
  snapshot = EMPTY_SNAPSHOT;
  lastAttemptAt = null;
  pendingRefresh = null;
}
