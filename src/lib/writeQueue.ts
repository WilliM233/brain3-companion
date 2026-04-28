/**
 * Canned-response offline queue for [2C-07].
 *
 * The native [CannedResponseReceiver] persists each tapped response to
 * `brain.writeQueue` in `@capacitor/preferences` storage and (when the
 * WebView is alive) fires a `brainCannedResponse` window event. This module
 * owns the HTTP POST to BRAIN, the in-order flush, and the failure-handling
 * contract:
 *
 * - 200 / 201 → entry removed.
 * - 409 → drop entry. If the server returned a different existing response
 *   ([2C-03]'s "legitimate conflict" branch), surface a {@link ConflictWarning}
 *   to subscribers. Same-response idempotency is a server-side 200 per
 *   [2C-03], so a 409 here always indicates a different existing response.
 * - Any other failure (5xx, network, timeout) → entry stays at the head of
 *   the queue, flush stops to preserve enqueue order.
 *
 * Flush is gated on both an active pairing (URL + bearer token from
 * `pairing.ts`) and a registered FCM token (`brain.deviceRegisteredToken`
 * from [2C-08]). When either is missing, queued entries wait until both are
 * present — registration completion triggers a flush automatically.
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  loadRegisteredToken,
  subscribeRegistration,
} from './device-registration';
import { loadPairing, type Pairing } from './pairing';

export const WRITE_QUEUE_KEY = 'brain.writeQueue';
export const BRIDGE_EVENT_NAME = 'brainCannedResponse';
export const QUEUE_SOFT_CAP = 500;

export interface WriteQueueEntry {
  notification_id: string;
  response: string;
  response_note: string | null;
  enqueued_at: string;
}

export interface ConflictWarning {
  notification_id: string;
  attempted_response: string;
  server_response: string;
}

export interface FlushSummary {
  attempted: number;
  delivered: number;
  conflicts: number;
  remaining: number;
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

async function loadQueue(): Promise<WriteQueueEntry[]> {
  const { value } = await Preferences.get({ key: WRITE_QUEUE_KEY });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as WriteQueueEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: WriteQueueEntry[]): Promise<void> {
  await Preferences.set({
    key: WRITE_QUEUE_KEY,
    value: JSON.stringify(queue),
  });
}

export async function enqueueResponse(entry: WriteQueueEntry): Promise<void> {
  const queue = await loadQueue();
  queue.push(entry);
  if (queue.length > QUEUE_SOFT_CAP) {
    // Soft cap — log only. Spec says "do not drop" beyond cap.
    console.warn(
      `[writeQueue] size ${queue.length} exceeds soft cap ${QUEUE_SOFT_CAP}`,
    );
  }
  await saveQueue(queue);
}

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

let flushing = false;

/**
 * Drain the queue in enqueue order. Concurrent calls coalesce: a second call
 * while a flush is in flight returns immediately rather than racing the queue.
 */
export async function flushWriteQueue(): Promise<FlushSummary> {
  if (flushing) {
    const remaining = (await loadQueue()).length;
    return { attempted: 0, delivered: 0, conflicts: 0, remaining };
  }
  flushing = true;
  try {
    const pairing = await loadPairing();
    const registered = await loadRegisteredToken();
    if (!pairing || !registered) {
      const remaining = (await loadQueue()).length;
      return { attempted: 0, delivered: 0, conflicts: 0, remaining };
    }

    let queue = await loadQueue();
    let attempted = 0;
    let delivered = 0;
    let conflicts = 0;
    while (queue.length > 0) {
      const entry = queue[0]!;
      attempted += 1;
      let response: Response;
      try {
        response = await postResponse(pairing, entry);
      } catch {
        // Network failure — leave entry at the head, stop flushing.
        break;
      }
      if (response.status === 200 || response.status === 201) {
        queue = queue.slice(1);
        await saveQueue(queue);
        delivered += 1;
        continue;
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
        queue = queue.slice(1);
        await saveQueue(queue);
        conflicts += 1;
        continue;
      }
      // Any other failure (5xx, etc.) — leave entry, stop.
      break;
    }
    return { attempted, delivered, conflicts, remaining: queue.length };
  } finally {
    flushing = false;
  }
}

async function readConflictResponse(response: Response): Promise<string | null> {
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

let initialised = false;

/**
 * Wire flush triggers: app foreground, browser `online`, native bridge event,
 * and device-registration completion. Idempotent — repeat calls no-op until
 * the returned cleanup runs. Returns a tear-down used by tests; production
 * code mounts this once for the lifetime of the app.
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

  if (typeof window !== 'undefined') {
    const onlineHandler = (): void => safeFlush();
    window.addEventListener('online', onlineHandler);
    cleanups.push(() => window.removeEventListener('online', onlineHandler));

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
  flushing = false;
  initialised = false;
}
