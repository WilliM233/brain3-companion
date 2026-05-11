/**
 * Habit and routine completion write-queues for [2C-23].
 *
 * Two offline-first write queues built on the {@link createWriteQueue}
 * factory from `./writeQueue`, each persisted to its own
 * `@capacitor/preferences` key:
 *
 * - `brain.writeQueue.habitCompletions` — POSTs to
 *   `/api/habits/{habit_id}/complete`. Server idempotency comes from the
 *   `(habit_id, completed_at)` unique constraint on `HabitCompletion`, so
 *   duplicate retries return 200 with the existing row.
 * - `brain.writeQueue.routineCompletions` — POSTs to
 *   `/api/routines/{routine_id}/complete`. Server idempotency comes from
 *   `[2C-26]`'s `uq_routine_completions_routine_date_status` unique constraint
 *   on `(routine_id, completed_at, status)`, so duplicate same-status retries
 *   return the existing row while genuine cross-status entries on the same
 *   day persist as separate rows.
 *
 * Queues are independent — a 4xx that drains one queue's head entry does not
 * halt the other's flush. Each queue's flusher halts on network failures and
 * 5xx, preserving enqueue order until connectivity restores.
 *
 * The `[2C-07]` notification-response queue is owned by `./writeQueue` and is
 * not touched here; {@link flushAllQueues} composes all three so UI surfaces
 * have a single trigger after enqueue.
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import {
  createWriteQueue,
  flushWriteQueue,
  type FlushSummary,
  type QueueFlushSummary,
} from './writeQueue';
import { loadPairing, type Pairing } from './pairing';

export const HABIT_COMPLETIONS_KEY = 'brain.writeQueue.habitCompletions';
export const ROUTINE_COMPLETIONS_KEY = 'brain.writeQueue.routineCompletions';

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

export interface HabitCompletionEntry {
  habit_id: string;
  /** YYYY-MM-DD device-local calendar date. */
  completed_date: string;
  notes: string | null;
  /** ISO timestamp of when the entry was enqueued, used for ordering audits. */
  enqueued_at: string;
}

export type RoutineCompletionStatus = 'all_done' | 'partial' | 'skipped';

export interface RoutineChildHabitCompletion {
  habit_id: string;
  /** YYYY-MM-DD device-local calendar date. */
  completed_date: string;
}

export interface RoutineCompletionEntry {
  routine_id: string;
  completed_date: string;
  status: RoutineCompletionStatus;
  freeform_note: string | null;
  /**
   * Populated only when `status === 'partial'`. The server does not accept a
   * per-partial habit list on the routine-complete endpoint, so the client
   * pre-enqueues each child habit completion separately into the habit queue
   * before appending the routine entry. The list is retained on the routine
   * entry as an audit trail of what was pre-enqueued.
   */
  child_habit_completions: RoutineChildHabitCompletion[] | null;
  enqueued_at: string;
}

// ---------------------------------------------------------------------------
// Warning bus
// ---------------------------------------------------------------------------

export type HabitCompletionWarning =
  | { kind: 'paused'; habit_id: string }
  | { kind: 'not_found'; habit_id: string };

export type RoutineCompletionWarning =
  | { kind: 'not_active'; routine_id: string; status: RoutineCompletionStatus }
  | { kind: 'not_found'; routine_id: string; status: RoutineCompletionStatus };

type HabitWarningListener = (warning: HabitCompletionWarning) => void;
type RoutineWarningListener = (warning: RoutineCompletionWarning) => void;

const habitWarningListeners = new Set<HabitWarningListener>();
const routineWarningListeners = new Set<RoutineWarningListener>();

export function subscribeHabitCompletionWarnings(
  listener: HabitWarningListener,
): () => void {
  habitWarningListeners.add(listener);
  return () => {
    habitWarningListeners.delete(listener);
  };
}

export function subscribeRoutineCompletionWarnings(
  listener: RoutineWarningListener,
): () => void {
  routineWarningListeners.add(listener);
  return () => {
    routineWarningListeners.delete(listener);
  };
}

function emitHabitWarning(warning: HabitCompletionWarning): void {
  for (const l of habitWarningListeners) l(warning);
}

function emitRoutineWarning(warning: RoutineCompletionWarning): void {
  for (const l of routineWarningListeners) l(warning);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function postHabitCompletion(
  pairing: Pairing,
  entry: HabitCompletionEntry,
): Promise<Response> {
  const base = pairing.url.replace(/\/$/, '');
  return await fetch(`${base}/api/habits/${entry.habit_id}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pairing.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      completed_date: entry.completed_date,
      notes: entry.notes,
    }),
  });
}

async function postRoutineCompletion(
  pairing: Pairing,
  entry: RoutineCompletionEntry,
): Promise<Response> {
  const base = pairing.url.replace(/\/$/, '');
  return await fetch(`${base}/api/routines/${entry.routine_id}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pairing.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      completed_date: entry.completed_date,
      status: entry.status,
      freeform_note: entry.freeform_note,
    }),
  });
}

async function bodyContainsPaused(response: Response): Promise<boolean> {
  try {
    const cloned = response.clone();
    const data = (await cloned.json()) as unknown;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail;
      return typeof detail === 'string' && detail.includes("paused");
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Habit queue
// ---------------------------------------------------------------------------

const habitQueue = createWriteQueue<HabitCompletionEntry>(
  HABIT_COMPLETIONS_KEY,
  {
    shouldFlush: async () => (await loadPairing()) !== null,
    flushOne: async (entry) => {
      const pairing = await loadPairing();
      if (!pairing) return { kind: 'stop' };

      let response: Response;
      try {
        response = await postHabitCompletion(pairing, entry);
      } catch {
        return { kind: 'stop' };
      }

      if (response.status === 200 || response.status === 201) {
        return { kind: 'remove' };
      }
      if (response.status === 400) {
        const paused = await bodyContainsPaused(response);
        if (paused) {
          emitHabitWarning({ kind: 'paused', habit_id: entry.habit_id });
          return { kind: 'discard' };
        }
        // Other 400s: malformed payload, etc. Drop to avoid a poison-pill loop
        // and log; the entry is otherwise unrecoverable on retry.
        console.warn(
          `[habitCompletions] dropping ${entry.habit_id}: 400 with non-paused detail`,
        );
        return { kind: 'discard' };
      }
      if (response.status === 404) {
        console.warn(
          `[habitCompletions] dropping ${entry.habit_id}: habit not found (404)`,
        );
        emitHabitWarning({ kind: 'not_found', habit_id: entry.habit_id });
        return { kind: 'discard' };
      }
      return { kind: 'stop' };
    },
  },
);

export async function enqueueHabitCompletion(
  entry: HabitCompletionEntry,
): Promise<void> {
  await habitQueue.enqueue(entry);
}

// ---------------------------------------------------------------------------
// Routine queue
// ---------------------------------------------------------------------------

const routineQueue = createWriteQueue<RoutineCompletionEntry>(
  ROUTINE_COMPLETIONS_KEY,
  {
    shouldFlush: async () => (await loadPairing()) !== null,
    flushOne: async (entry) => {
      const pairing = await loadPairing();
      if (!pairing) return { kind: 'stop' };

      let response: Response;
      try {
        response = await postRoutineCompletion(pairing, entry);
      } catch {
        return { kind: 'stop' };
      }

      if (response.status === 200 || response.status === 201) {
        return { kind: 'remove' };
      }
      if (response.status === 404) {
        console.warn(
          `[routineCompletions] dropping ${entry.routine_id}: routine not found (404)`,
        );
        emitRoutineWarning({
          kind: 'not_found',
          routine_id: entry.routine_id,
          status: entry.status,
        });
        return { kind: 'discard' };
      }
      if (response.status === 409) {
        // Server returns 409 for non-active routines. Mirror habit's 400-paused
        // pattern: log + warn + drop so the queue does not stall on a routine
        // that was paused or archived after the entry was enqueued.
        console.warn(
          `[routineCompletions] dropping ${entry.routine_id}: routine not active (409)`,
        );
        emitRoutineWarning({
          kind: 'not_active',
          routine_id: entry.routine_id,
          status: entry.status,
        });
        return { kind: 'discard' };
      }
      return { kind: 'stop' };
    },
  },
);

/**
 * Append a routine completion entry. When `status === 'partial'`, each
 * `child_habit_completions[i]` is pre-enqueued into the habit queue first so
 * that flush order delivers child habits before the parent routine's
 * streak-event POST. Cross-queue ordering matters for the user-visible state:
 * a partial routine surfacing before its child habits would briefly show the
 * routine as completed-with-no-children-completed.
 */
export async function enqueueRoutineCompletion(
  entry: RoutineCompletionEntry,
): Promise<void> {
  if (entry.status === 'partial' && entry.child_habit_completions) {
    for (const child of entry.child_habit_completions) {
      await habitQueue.enqueue({
        habit_id: child.habit_id,
        completed_date: child.completed_date,
        notes: null,
        enqueued_at: entry.enqueued_at,
      });
    }
  }
  await routineQueue.enqueue(entry);
}

// ---------------------------------------------------------------------------
// Cross-queue flush
// ---------------------------------------------------------------------------

export interface AllQueuesFlushSummary {
  notifications: FlushSummary;
  habitCompletions: QueueFlushSummary;
  routineCompletions: QueueFlushSummary;
}

/**
 * Flush all three queues in fixed order: notifications → habits → routines.
 * Order is observable when the network is partially up: a 5xx halts the
 * notification queue but the habit and routine queues run independently and
 * may still drain. Use this for UI-triggered flushes (after a manual
 * enqueue); per-queue background triggers (`initCompletionQueues`,
 * `initWriteQueue`) call their own queue's flush directly.
 */
export async function flushAllQueues(): Promise<AllQueuesFlushSummary> {
  const notifications = await flushWriteQueue();
  const habitCompletions = await habitQueue.flush();
  const routineCompletions = await routineQueue.flush();
  return { notifications, habitCompletions, routineCompletions };
}

// ---------------------------------------------------------------------------
// Trigger wiring
// ---------------------------------------------------------------------------

let initialised = false;

/**
 * Wire flush triggers for the habit and routine completion queues. Mounts in
 * parallel with `initWriteQueue` (which owns the [2C-07] notification queue's
 * triggers). Both react to app foreground and the `online` event, but they
 * stay in separate inits because the FCM-token gate and the native bridge
 * event are notification-specific concerns. Manual flushes from UI surfaces
 * call {@link flushAllQueues} directly.
 *
 * Returns a teardown for tests and lifecycle cleanup. Idempotent — repeat
 * calls no-op until the returned cleanup runs.
 */
export function initCompletionQueues(): () => void {
  if (initialised) return () => undefined;
  initialised = true;

  const cleanups: Array<() => void> = [];
  const safeFlushHabit = (): void => {
    void habitQueue.flush();
  };
  const safeFlushRoutine = (): void => {
    void routineQueue.flush();
  };
  const safeFlushBoth = (): void => {
    safeFlushHabit();
    safeFlushRoutine();
  };

  // Initial drain on mount.
  safeFlushBoth();

  if (Capacitor.isNativePlatform()) {
    const handlePromise = App.addListener(
      'appStateChange',
      ({ isActive }) => {
        if (isActive) safeFlushBoth();
      },
    );
    cleanups.push(() => {
      void handlePromise.then((handle) => handle.remove());
    });
  }

  // [2C-27] Reachability detection moved from `window.online` to the
  // Capacitor Network plugin to mirror the notification queue.
  let networkHandle: { remove: () => void } | null = null;
  void Network.addListener('networkStatusChange', (status) => {
    if (status.connected) safeFlushBoth();
  }).then((handle) => {
    networkHandle = handle;
  });
  cleanups.push(() => {
    networkHandle?.remove();
  });

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort cleanup.
      }
    }
    initialised = false;
  };
}

export function __resetForTests(): void {
  habitWarningListeners.clear();
  routineWarningListeners.clear();
  initialised = false;
}
