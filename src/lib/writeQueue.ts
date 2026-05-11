/**
 * Generic offline write-queue factory and the [2C-07] canned-response queue
 * built on top of it.
 *
 * The factory ({@link createWriteQueue}) extracts the queue primitive that
 * [2C-07] introduced — `@capacitor/preferences`-backed JSON array, in-order
 * flush, halt-on-failure, soft cap warning — into a generic helper reusable
 * for habit and routine completion writes ([2C-23]) and any future write
 * pipeline that needs the same offline-first shape.
 *
 * The `[2C-07]` notification-response queue is preserved as a concrete
 * instance of the factory: the `brain.writeQueue` Preferences key, the
 * `WriteQueueEntry` shape, the 200/201/409/error flush semantics, conflict
 * warning emission, and the `initWriteQueue` trigger wiring all behave
 * identically to the pre-refactor module. Callers of `enqueueResponse`,
 * `flushWriteQueue`, `subscribeConflicts`, and `initWriteQueue` see no
 * observable change.
 *
 * See {@link createWriteQueue} for the factory shape and
 * {@link ./completionQueues} for habit/routine consumers.
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { composeCheckinFromCanned } from './checkin-parser';
import type { CheckinType } from './checkins';
import {
  loadRegisteredToken,
  subscribeRegistration,
} from './device-registration';
import { loadPairing, type Pairing } from './pairing';

export const WRITE_QUEUE_KEY = 'brain.writeQueue';
export const BRIDGE_EVENT_NAME = 'brainCannedResponse';
export const QUEUE_SOFT_CAP = 500;

// ---------------------------------------------------------------------------
// Generic factory
// ---------------------------------------------------------------------------

/**
 * Per-entry flush outcome returned by an adapter's {@link WriteQueueAdapter.flushOne}.
 *
 * - `remove` — server delivered the entry (200/201, idempotent re-confirm).
 *   The entry is dropped from the queue and counted as delivered.
 * - `discard` — entry is unrecoverable (404 not-found, 4xx terminal-rejection)
 *   and must be dropped to keep the queue moving. Flush continues, but the
 *   entry is *not* counted as delivered. Adapters typically surface a warning
 *   alongside a discard so the UI can flag what happened.
 * - `stop` — transient failure (network, 5xx, timeout). The entry stays at
 *   the head of the queue and the flush halts to preserve enqueue order.
 */
export type FlushOutcome =
  | { kind: 'remove' }
  | { kind: 'discard' }
  | { kind: 'stop' };

export interface WriteQueueAdapter<T> {
  /**
   * Process a single entry. Should be throw-free — wrap the network call so
   * exceptions become `{ kind: 'stop' }`.
   */
  flushOne(entry: T): Promise<FlushOutcome>;
  /**
   * Optional pre-flush gate. Return `false` to no-op the flush (pairing
   * missing, device not registered, etc.). Defaults to always-flush.
   */
  shouldFlush?(): Promise<boolean>;
  /**
   * Optional sync hook fired once per non-coalesced flush, after `shouldFlush`
   * passes and before the first `flushOne`. Adapters use this to reset
   * per-flush state (e.g., conflict counters). Coalesced flushes skip it.
   */
  beforeFlush?(): void;
}

export interface QueueFlushSummary {
  attempted: number;
  delivered: number;
  remaining: number;
  /**
   * `true` when this call returned without doing work because another flush
   * for the same queue was already in flight. Wrappers that aggregate
   * adapter-side state (e.g., conflict counters) should ignore that state on
   * coalesced calls — the in-flight flush owns the counter.
   */
  coalesced: boolean;
}

export interface WriteQueueInstance<T> {
  enqueue(entry: T): Promise<void>;
  peek(): Promise<T[]>;
  flush(): Promise<QueueFlushSummary>;
  clear(): Promise<void>;
}

/**
 * Build a write queue persisted to `@capacitor/preferences` under `key` and
 * flushed via `adapter`. Each instance owns its own concurrency guard — a
 * second call to `flush()` while one is in flight returns immediately with a
 * zero-attempt summary rather than racing the queue.
 */
export function createWriteQueue<T>(
  key: string,
  adapter: WriteQueueAdapter<T>,
): WriteQueueInstance<T> {
  let flushing = false;

  async function load(): Promise<T[]> {
    const { value } = await Preferences.get({ key });
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  async function save(queue: T[]): Promise<void> {
    await Preferences.set({ key, value: JSON.stringify(queue) });
  }

  async function enqueue(entry: T): Promise<void> {
    const queue = await load();
    queue.push(entry);
    if (queue.length > QUEUE_SOFT_CAP) {
      console.warn(
        `[writeQueue:${key}] size ${queue.length} exceeds soft cap ${QUEUE_SOFT_CAP}`,
      );
    }
    await save(queue);
  }

  async function flush(): Promise<QueueFlushSummary> {
    if (flushing) {
      const remaining = (await load()).length;
      return { attempted: 0, delivered: 0, remaining, coalesced: true };
    }
    flushing = true;
    try {
      if (adapter.shouldFlush) {
        const ok = await adapter.shouldFlush();
        if (!ok) {
          const remaining = (await load()).length;
          return { attempted: 0, delivered: 0, remaining, coalesced: false };
        }
      }
      adapter.beforeFlush?.();
      let queue = await load();
      let attempted = 0;
      let delivered = 0;
      while (queue.length > 0) {
        const entry = queue[0]!;
        attempted += 1;
        const outcome = await adapter.flushOne(entry);
        if (outcome.kind === 'stop') break;
        queue = queue.slice(1);
        await save(queue);
        if (outcome.kind === 'remove') delivered += 1;
      }
      return { attempted, delivered, remaining: queue.length, coalesced: false };
    } finally {
      flushing = false;
    }
  }

  async function clear(): Promise<void> {
    await save([]);
  }

  async function peek(): Promise<T[]> {
    return load();
  }

  return { enqueue, peek, flush, clear };
}

// ---------------------------------------------------------------------------
// [2C-07] canned-response queue — concrete instance of the factory
// ---------------------------------------------------------------------------

/**
 * CheckinCreate-shaped payload [2C-19] enqueues alongside a `/respond` write
 * for `checkin_prompt` notifications. Mirrors `app/schemas/checkins.py`
 * `CheckinCreate` on the brain3 server (`checkin_type` mandatory; numeric
 * fields 1–5 or null; `freeform_note` ≤ 5000 chars).
 */
export interface CheckinPayload {
  checkin_type: CheckinType;
  energy_level: number | null;
  mood: number | null;
  focus_level: number | null;
  freeform_note: string | null;
}

export interface WriteQueueEntry {
  notification_id: string;
  response: string;
  response_note: string | null;
  enqueued_at: string;
  /**
   * Notification type from the FCM payload. Populated by the native
   * `CannedResponseReceiver` (and JS [2C-19] enqueues) so the flush handler
   * can detect `checkin_prompt` and post the additional `/api/checkins/`.
   * Optional for backward compatibility with pre-[2C-19] entries.
   */
  notification_type?: string | null;
  /**
   * Pre-composed CheckinCreate payload for the [2C-19] freetext "Add note"
   * path. When present, the flush handler posts it to `/api/checkins/` after
   * `/respond` returns 2xx. When absent on a `checkin_prompt` entry, the
   * flush handler derives a numeric-only payload from `response` via
   * `parseCannedResponse`.
   */
  checkin_payload?: CheckinPayload | null;
}

export interface ConflictWarning {
  notification_id: string;
  attempted_response: string;
  server_response: string;
}

/**
 * Public summary returned by {@link flushWriteQueue}. Preserves [2C-07]'s
 * pre-refactor shape — `coalesced` is stripped by the wrapper since callers
 * historically didn't see it. The `conflicts` count is tracked by the
 * notification adapter via a closure-scoped counter.
 */
export interface FlushSummary {
  attempted: number;
  delivered: number;
  remaining: number;
  conflicts: number;
}

type ConflictListener = (warning: ConflictWarning) => void;

const conflictListeners = new Set<ConflictListener>();

export function subscribeConflicts(listener: ConflictListener): () => void {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

function emitConflict(warning: ConflictWarning): void {
  for (const listener of conflictListeners) listener(warning);
}

let pendingConflicts = 0;

async function postResponse(
  pairing: Pairing,
  entry: WriteQueueEntry,
): Promise<Response> {
  const base = pairing.url.replace(/\/$/, '');
  return await fetch(
    `${base}/api/notifications/${entry.notification_id}/respond`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pairing.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        response: entry.response,
        response_note: entry.response_note,
      }),
    },
  );
}

async function postCheckin(
  pairing: Pairing,
  payload: CheckinPayload,
): Promise<Response> {
  const base = pairing.url.replace(/\/$/, '');
  return await fetch(`${base}/api/checkins/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pairing.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Per [2C-19] Escalation 2 Option A, `checkin_prompt` notifications create a
 * check-in alongside the `/respond` write. The payload is either pre-composed
 * by the JS Add-note path (`entry.checkin_payload`) or derived from the
 * canned response on flush (canned-only path). Returns `null` when no
 * check-in should fire — non-`checkin_prompt` entries, or pre-[2C-19] entries
 * that lack the type hint.
 */
function resolveCheckinPayload(entry: WriteQueueEntry): CheckinPayload | null {
  if (entry.checkin_payload) return entry.checkin_payload;
  if (entry.notification_type !== 'checkin_prompt') return null;
  return composeCheckinFromCanned({
    cannedResponse: entry.response,
    freeformNote: entry.response_note,
  });
}

async function readConflictResponse(
  response: Response,
): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as unknown;
    if (
      body &&
      typeof body === 'object' &&
      'response' in body &&
      typeof (body as { response: unknown }).response === 'string'
    ) {
      return (body as { response: string }).response;
    }
    return null;
  } catch {
    return null;
  }
}

const notificationQueue = createWriteQueue<WriteQueueEntry>(WRITE_QUEUE_KEY, {
  shouldFlush: async () => {
    const [pairing, registered] = await Promise.all([
      loadPairing(),
      loadRegisteredToken(),
    ]);
    return pairing !== null && registered !== null;
  },
  beforeFlush: () => {
    pendingConflicts = 0;
  },
  flushOne: async (entry) => {
    // shouldFlush already gated on pairing presence; reload here to re-resolve
    // on the off-chance it cleared mid-flush.
    const pairing = await loadPairing();
    if (!pairing) return { kind: 'stop' };
    let response: Response;
    try {
      response = await postResponse(pairing, entry);
    } catch {
      return { kind: 'stop' };
    }
    const respondDelivered =
      response.status === 200 || response.status === 201;
    if (respondDelivered) {
      // [2C-19] Escalation 2 Option A: `checkin_prompt` entries fire a
      // companion `/api/checkins/` POST after `/respond` succeeds. Treat any
      // network or 5xx failure on the check-in POST as a halt — the entry
      // stays at the head so the next flush retries. Server-side `/respond`
      // is idempotent per [2C-03], so the retry re-sends `/respond` safely.
      // Terminal 4xx on the check-in POST drops to a discard so the queue
      // doesn't stall on a permanently-bad payload.
      const checkinPayload = resolveCheckinPayload(entry);
      if (checkinPayload !== null) {
        let checkinResponse: Response;
        try {
          checkinResponse = await postCheckin(pairing, checkinPayload);
        } catch {
          return { kind: 'stop' };
        }
        if (
          checkinResponse.status !== 200 &&
          checkinResponse.status !== 201
        ) {
          if (checkinResponse.status >= 400 && checkinResponse.status < 500) {
            console.warn(
              `[writeQueue] check-in POST rejected (${checkinResponse.status}) for notification ${entry.notification_id}; dropping entry`,
            );
            return { kind: 'discard' };
          }
          return { kind: 'stop' };
        }
      }
      return { kind: 'remove' };
    }
    if (response.status === 409) {
      const serverResponse = await readConflictResponse(response);
      if (serverResponse !== null && serverResponse !== entry.response) {
        emitConflict({
          notification_id: entry.notification_id,
          attempted_response: entry.response,
          server_response: serverResponse,
        });
      }
      pendingConflicts += 1;
      return { kind: 'discard' };
    }
    return { kind: 'stop' };
  },
});

export async function enqueueResponse(entry: WriteQueueEntry): Promise<void> {
  await notificationQueue.enqueue(entry);
}

/**
 * Drain the [2C-07] notification-response queue. Concurrent calls coalesce.
 */
export async function flushWriteQueue(): Promise<FlushSummary> {
  const { coalesced, ...rest } = await notificationQueue.flush();
  // Coalesced calls did no work — pendingConflicts belongs to the in-flight
  // flush, not this caller. Report 0 to keep the summary self-consistent
  // (`attempted === 0`, `delivered === 0`, `conflicts === 0`).
  const conflicts = coalesced ? 0 : pendingConflicts;
  return { ...rest, conflicts };
}

// ---------------------------------------------------------------------------
// Trigger wiring
// ---------------------------------------------------------------------------

let initialised = false;

/**
 * Wire flush triggers for the [2C-07] notification-response queue: app
 * foreground, browser `online`, native bridge event, and device-registration
 * completion. Idempotent — repeat calls no-op until the returned cleanup
 * runs. Production code mounts this once for the lifetime of the app.
 *
 * Habit and routine completion queues mount their own listeners via
 * `initCompletionQueues` in `./completionQueues` — the two are independent
 * because the FCM-token gate and the bridge event are notification-specific
 * concerns that should not extend their reach into completion writes.
 */
export function initWriteQueue(): () => void {
  if (initialised) return () => undefined;
  initialised = true;

  const cleanups: Array<() => void> = [];
  const safeFlush = (): void => {
    void flushWriteQueue();
  };

  // Initial drain — picks up entries persisted by the native receiver while
  // the app process was dead.
  safeFlush();

  if (Capacitor.isNativePlatform()) {
    const handlePromise = App.addListener(
      'appStateChange',
      ({ isActive }) => {
        if (isActive) safeFlush();
      },
    );
    cleanups.push(() => {
      void handlePromise.then((handle) => handle.remove());
    });
  }

  // [2C-27] Reachability detection moved from `window.online` to the
  // Capacitor Network plugin. On native Android the browser-level `online`
  // event is unreliable — Capacitor's `networkStatusChange` is the
  // authoritative source. The flush-on-reachable contract from [2C-07] is
  // preserved; only the detector changed.
  let networkHandle: { remove: () => void } | null = null;
  void Network.addListener('networkStatusChange', (status) => {
    if (status.connected) safeFlush();
  }).then((handle) => {
    networkHandle = handle;
  });
  cleanups.push(() => {
    networkHandle?.remove();
  });

  if (typeof window !== 'undefined') {
    const bridgeHandler = (): void => safeFlush();
    window.addEventListener(BRIDGE_EVENT_NAME, bridgeHandler);
    cleanups.push(() =>
      window.removeEventListener(BRIDGE_EVENT_NAME, bridgeHandler),
    );
  }

  const unsubscribeRegistration = subscribeRegistration((status) => {
    if (status.kind === 'registered') safeFlush();
  });
  cleanups.push(unsubscribeRegistration);

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
  conflictListeners.clear();
  pendingConflicts = 0;
  initialised = false;
}
