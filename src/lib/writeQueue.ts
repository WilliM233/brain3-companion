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
 * [2C-29] extends the factory with three additive policies inherited
 * uniformly by all three queues:
 *
 * - **Exponential backoff** between flushes that halt with pending entries.
 *   30s → 60s → 2m → 4m → 8m → 15m, capped at 15 min. Attempt counter
 *   resets on any flush that delivers ≥ 1 entry. Per-queue `setTimeout`
 *   timers are stored in-memory; foreground / network-reachable triggers
 *   preempt the schedule so a natural reconnection flushes immediately.
 *
 * - **Permanent-failure detection.** Adapters classify each HTTP response
 *   via {@link classifyHttpStatus} and signal a terminal-status drop by
 *   returning `{ kind: 'discard', failure: {...} }`. The factory persists
 *   the dropped entry to a per-queue failures log capped at 10 entries
 *   (FIFO eviction) and increments the total-drops counter that drives the
 *   foreground toast.
 *
 * - **Flush-state event.** Each flush emits per-queue {@link FlushDetail}
 *   transitions (`idle → flushing → idle` on success; `idle → flushing →
 *   backoff` on halt with pending entries) through the shared
 *   `./connection/writeQueueFlushState` surface. [2C-27]'s
 *   `ConnectionStateProvider` subscribes to the aggregate; [2C-30]'s
 *   Settings inspection will subscribe to the per-queue detail.
 *
 * The `[2C-07]` notification-response queue is preserved as a concrete
 * instance of the factory: the `brain.writeQueue` Preferences key, the
 * `WriteQueueEntry` shape, the conflict warning emission, and the
 * `initWriteQueue` trigger wiring all behave identically. The notification
 * adapter's `flushOne` is updated to classify HTTP statuses uniformly with
 * the habit and routine adapters via {@link classifyHttpStatus}.
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
  emitFlushDetail,
  __resetFlushStateForTests,
} from './connection/writeQueueFlushState';
import {
  loadRegisteredToken,
  subscribeRegistration,
} from './device-registration';
import { loadPairing, type Pairing } from './pairing';

export const WRITE_QUEUE_KEY = 'brain.writeQueue';
export const BRIDGE_EVENT_NAME = 'brainCannedResponse';
export const QUEUE_SOFT_CAP = 500;

/**
 * Exponential-backoff schedule parameters per Pass 5 Summary Escalation 1.
 * Schedule: 30s → 60s → 2m → 4m → 8m → 15m, then 15m indefinitely at cap.
 */
export const BACKOFF_INITIAL_DELAY_MS = 30_000;
export const BACKOFF_MULTIPLIER = 2;
export const BACKOFF_CAP_MS = 900_000;

/** Maximum entries retained in `brain.writeQueue.failures.{queueKey}`. */
export const FAILURES_LOG_CAP = 10;

const FAILURES_TOTAL_KEY = 'brain.writeQueue.failures.totalDropsCount';
const FAILURES_SEEN_KEY = 'brain.writeQueue.failures.seenCount';

// ---------------------------------------------------------------------------
// HTTP classification + Retry-After parsing
// ---------------------------------------------------------------------------

export type HttpStatusClass =
  | 'success'
  | 'conflict'
  | 'terminal'
  | 'retryable';

/**
 * Classify an HTTP status into the four buckets the write-queue policy
 * cares about. Each adapter calls this on the response status to keep the
 * policy uniform across queues per Pass 5 Summary §3 [2C-29]:
 *
 * - `success` — 200, 201. Entry delivered.
 * - `conflict` — 409. Per-queue UX (notification conflict bus, habit
 *   `paused` toast, routine `not_active` warning) handles surfacing; the
 *   entry is dropped without entering the failures log.
 * - `terminal` — 400, 401, 403, 404, 410, 422. Drop the entry and persist
 *   to the failures log so the user sees a foreground toast.
 * - `retryable` — 408, 429, 5xx. Preserve the entry and halt the flush;
 *   the factory schedules an exponential-backoff retry.
 *
 * Statuses outside these buckets default to `retryable` (halt). 2xx
 * non-200/201 (204, 207, etc.) classify as `success` so an idempotent
 * 200-equivalent return from the server still drains the entry.
 */
export function classifyHttpStatus(status: number): HttpStatusClass {
  if (status === 200 || status === 201) return 'success';
  if (status === 409) return 'conflict';
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 422
  ) {
    return 'terminal';
  }
  if (status === 408 || status === 429) return 'retryable';
  if (status >= 500 && status < 600) return 'retryable';
  if (status >= 200 && status < 300) return 'success';
  return 'retryable';
}

/**
 * Parse the seconds-int form of `Retry-After` per RFC 7231 §7.1.3 and
 * convert to milliseconds, clamped to the backoff cap. Returns `null` when
 * the header is absent or unparseable.
 *
 * Date-form `Retry-After` is not supported in v2.0.0 — the BRAIN server
 * doesn't emit it per Pass 5 Summary §3 [2C-29].
 *
 * The lower bound is intentionally `0` (not `BACKOFF_INITIAL_DELAY_MS`) so
 * a server-honored short retry-after (5s in MV step 4) schedules at the
 * server's chosen interval rather than the natural 30s slot. See PR body
 * Deviation #2 for the spec-vs-MV reconciliation.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = seconds * 1000;
  return Math.min(ms, BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// Generic factory
// ---------------------------------------------------------------------------

/**
 * Metadata captured alongside a permanent-failure drop. The adapter
 * populates this when it returns `{ kind: 'discard', failure }`; the
 * factory persists it to the failures log and the foreground toast.
 */
export interface PermanentFailureMeta {
  http_status: number;
  server_message: string | null;
}

/**
 * Per-entry flush outcome returned by an adapter's {@link WriteQueueAdapter.flushOne}.
 *
 * - `remove` — server delivered the entry (200/201, idempotent re-confirm).
 *   The entry is dropped from the queue and counted as delivered.
 * - `discard` (without `failure`) — entry dropped because a queue-specific
 *   UX already surfaced the outcome (notification 409 conflict, habit 400
 *   paused, routine 409 not_active). Not added to the failures log; the
 *   per-queue warning bus is the visibility channel.
 * - `discard` (with `failure`) — terminal HTTP status (400/401/403/404/
 *   410/422). The factory persists the entry + status + message to
 *   `brain.writeQueue.failures.{queueKey}` and the next foreground toast
 *   includes it in the count.
 * - `stop` — transient failure (network, 5xx, 408, 429, timeout). The
 *   entry stays at the head of the queue and the flush halts to preserve
 *   enqueue order. When `retryAfterMs` is set (parsed from a 429
 *   `Retry-After` header), the factory schedules the next retry at that
 *   exact interval instead of the natural exponential slot.
 */
export type FlushOutcome =
  | { kind: 'remove' }
  | { kind: 'discard'; failure?: PermanentFailureMeta }
  | { kind: 'stop'; retryAfterMs?: number | null };

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
 * Persistent record of a dropped queue entry, surfaced via Settings →
 * Pending sync once [2C-30] ships. Generic over the entry type so the
 * Settings UI can render the original payload alongside the failure cause.
 */
export interface PermanentFailureRecord<T = unknown> {
  original_entry: T;
  http_status: number;
  server_message: string | null;
  dropped_at: string;
}

interface BackoffState {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
}

const backoffStates = new Map<string, BackoffState>();
const scheduledFlushers = new Map<string, () => Promise<unknown>>();

function backoffStateFor(key: string): BackoffState {
  let state = backoffStates.get(key);
  if (!state) {
    state = { attempt: 0, timer: null, nextRetryAt: null };
    backoffStates.set(key, state);
  }
  return state;
}

function cancelBackoffTimer(key: string): void {
  const state = backoffStateFor(key);
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextRetryAt = null;
}

/**
 * Cancel all pending backoff timers and trigger an immediate flush for any
 * queue currently waiting. Wired to app-foreground and
 * network-status-connected events so a natural reconnection preempts the
 * exponential schedule per Pass 5 Summary §3 [2C-29].
 */
function preemptBackoffSchedules(): void {
  for (const [key, state] of backoffStates.entries()) {
    if (state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
    state.nextRetryAt = null;
    const flusher = scheduledFlushers.get(key);
    if (flusher) void flusher();
  }
}

function delayForAttempt(attempt: number): number {
  const raw = BACKOFF_INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
  return Math.min(raw, BACKOFF_CAP_MS);
}

function scheduleBackoff(
  key: string,
  flush: () => Promise<unknown>,
  retryAfterMs: number | null,
): void {
  const state = backoffStateFor(key);
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const delay = retryAfterMs ?? delayForAttempt(state.attempt);
  state.attempt += 1;
  state.nextRetryAt = Date.now() + delay;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.nextRetryAt = null;
    void flush();
  }, delay);
  emitFlushDetail({
    status: 'backoff',
    queueKey: key,
    nextRetryAt: state.nextRetryAt,
  });
}

// ---------------------------------------------------------------------------
// Failures log + foreground toast counter
// ---------------------------------------------------------------------------

function failuresKeyFor(queueKey: string): string {
  return `brain.writeQueue.failures.${queueKey}`;
}

async function readPreferencesNumber(key: string): Promise<number> {
  const { value } = await Preferences.get({ key });
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function writePreferencesNumber(
  key: string,
  value: number,
): Promise<void> {
  await Preferences.set({ key, value: String(value) });
}

async function loadFailuresList(
  queueKey: string,
): Promise<PermanentFailureRecord[]> {
  const { value } = await Preferences.get({ key: failuresKeyFor(queueKey) });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as PermanentFailureRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveFailuresList(
  queueKey: string,
  list: PermanentFailureRecord[],
): Promise<void> {
  await Preferences.set({
    key: failuresKeyFor(queueKey),
    value: JSON.stringify(list),
  });
}

/**
 * Read the persisted recent-failures log for a queue. Returned newest-last;
 * older entries are evicted at {@link FAILURES_LOG_CAP}.
 */
export async function readFailures<T = unknown>(
  queueKey: string,
): Promise<PermanentFailureRecord<T>[]> {
  return (await loadFailuresList(queueKey)) as PermanentFailureRecord<T>[];
}

async function recordPermanentFailure<T>(
  queueKey: string,
  entry: T,
  failure: PermanentFailureMeta,
): Promise<void> {
  const list = await loadFailuresList(queueKey);
  list.push({
    original_entry: entry,
    http_status: failure.http_status,
    server_message: failure.server_message,
    dropped_at: new Date().toISOString(),
  });
  while (list.length > FAILURES_LOG_CAP) list.shift();
  await saveFailuresList(queueKey, list);
  const total = await readPreferencesNumber(FAILURES_TOTAL_KEY);
  await writePreferencesNumber(FAILURES_TOTAL_KEY, total + 1);
}

type PermanentFailureToastListener = (count: number) => void;

const toastListeners = new Set<PermanentFailureToastListener>();

/**
 * Subscribe to the foreground toast event. The listener fires at most once
 * per foreground, with `count` = drops since the user last saw the toast.
 * Cleared by acknowledging via {@link acknowledgePermanentFailureToast}.
 */
export function subscribePermanentFailureToast(
  listener: PermanentFailureToastListener,
): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

/**
 * Mark all currently-recorded permanent failures as "seen" so a subsequent
 * foreground does not re-fire the toast. Called by the toast surface after
 * presentation; also called implicitly when a fresh foreground emits its
 * count, so explicit acknowledgement is only required if the surface needs
 * to dismiss without an emit (e.g., user dismissed during dwell).
 */
export async function acknowledgePermanentFailureToast(): Promise<void> {
  const total = await readPreferencesNumber(FAILURES_TOTAL_KEY);
  await writePreferencesNumber(FAILURES_SEEN_KEY, total);
}

/**
 * Compute the count of new permanent-failure drops since the user last saw
 * a toast and, if non-zero, advance the seen pointer and emit the toast
 * event to {@link subscribePermanentFailureToast} listeners. Wired to the
 * `appStateChange` foreground event by {@link initWriteQueue}; tests and
 * programmatic callers can invoke directly.
 */
export async function checkPermanentFailuresOnForeground(): Promise<void> {
  const total = await readPreferencesNumber(FAILURES_TOTAL_KEY);
  const seen = await readPreferencesNumber(FAILURES_SEEN_KEY);
  if (total <= seen) return;
  const count = total - seen;
  await writePreferencesNumber(FAILURES_SEEN_KEY, total);
  for (const listener of toastListeners) listener(count);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a write queue persisted to `@capacitor/preferences` under `key` and
 * flushed via `adapter`. Each instance owns its own concurrency guard — a
 * second call to `flush()` while one is in flight returns immediately with a
 * zero-attempt summary rather than racing the queue.
 *
 * [2C-29] additions, applied uniformly to every instance:
 * - Per-queue backoff state tracked in the module-level
 *   {@link backoffStates} map keyed by `key`.
 * - Permanent-failure drops (`{ kind: 'discard', failure }`) persist to
 *   `brain.writeQueue.failures.{key}` and increment the global toast
 *   counter.
 * - Each non-coalesced flush emits `'flushing'` at start and either
 *   `'idle'` (queue drained) or `'backoff'` (queue halted with pending
 *   entries) at end, via `emitFlushDetail`.
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
    // Foreground/reachable triggers already cancel pending timers via
    // preemptBackoffSchedules; cancel defensively here too in case flush is
    // invoked from an unscheduled path while a timer is pending.
    cancelBackoffTimer(key);
    emitFlushDetail({ status: 'flushing', queueKey: key, nextRetryAt: null });
    try {
      if (adapter.shouldFlush) {
        const ok = await adapter.shouldFlush();
        if (!ok) {
          const remaining = (await load()).length;
          emitFlushDetail({
            status: 'idle',
            queueKey: key,
            nextRetryAt: null,
          });
          return { attempted: 0, delivered: 0, remaining, coalesced: false };
        }
      }
      adapter.beforeFlush?.();
      let queue = await load();
      let attempted = 0;
      let delivered = 0;
      let halted = false;
      let retryAfterOverride: number | null = null;
      while (queue.length > 0) {
        const entry = queue[0]!;
        attempted += 1;
        const outcome = await adapter.flushOne(entry);
        if (outcome.kind === 'stop') {
          halted = true;
          retryAfterOverride = outcome.retryAfterMs ?? null;
          break;
        }
        if (outcome.kind === 'discard' && outcome.failure) {
          await recordPermanentFailure(key, entry, outcome.failure);
        }
        queue = queue.slice(1);
        await save(queue);
        if (outcome.kind === 'remove') delivered += 1;
      }
      const state = backoffStateFor(key);
      if (delivered > 0) state.attempt = 0;
      if (halted && queue.length > 0) {
        scheduleBackoff(key, flush, retryAfterOverride);
      } else {
        emitFlushDetail({
          status: 'idle',
          queueKey: key,
          nextRetryAt: null,
        });
      }
      return { attempted, delivered, remaining: queue.length, coalesced: false };
    } finally {
      flushing = false;
    }
  }

  scheduledFlushers.set(key, flush);

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

/**
 * Read a server-supplied error message from a response body. Tries common
 * shapes (`{detail: "..."}`, `{message: "..."}`, plain text) and falls back
 * to `null` if nothing useful is available. Used to populate the
 * `server_message` field of the failures log.
 */
export async function readServerMessage(
  response: Response,
): Promise<string | null> {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    if (!text) return null;
    try {
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === 'object') {
        if (
          'detail' in data &&
          typeof (data as { detail: unknown }).detail === 'string'
        ) {
          return (data as { detail: string }).detail;
        }
        if (
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
        ) {
          return (data as { message: string }).message;
        }
      }
    } catch {
      // Not JSON — return raw text (capped).
    }
    return text.slice(0, 500);
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
    const cls = classifyHttpStatus(response.status);
    if (cls === 'success') {
      // [2C-19] Escalation 2 Option A: `checkin_prompt` entries fire a
      // companion `/api/checkins/` POST after `/respond` succeeds. Treat any
      // network or 5xx failure on the check-in POST as a halt — the entry
      // stays at the head so the next flush retries. Server-side `/respond`
      // is idempotent per [2C-03], so the retry re-sends `/respond` safely.
      // Terminal 4xx on the check-in POST drops to a discard so the queue
      // doesn't stall on a permanently-bad payload. The check-in POST
      // failure is wrapped by the parent entry's drop, so it does not log
      // to the permanent-failures surface independently.
      const checkinPayload = resolveCheckinPayload(entry);
      if (checkinPayload !== null) {
        let checkinResponse: Response;
        try {
          checkinResponse = await postCheckin(pairing, checkinPayload);
        } catch {
          return { kind: 'stop' };
        }
        const checkinCls = classifyHttpStatus(checkinResponse.status);
        if (checkinCls !== 'success') {
          if (checkinCls === 'terminal') {
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
    if (cls === 'conflict') {
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
    if (cls === 'terminal') {
      const serverMessage = await readServerMessage(response);
      return {
        kind: 'discard',
        failure: { http_status: response.status, server_message: serverMessage },
      };
    }
    // retryable — 408, 429, 5xx. Honor Retry-After for 429.
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      return { kind: 'stop', retryAfterMs };
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
 *
 * [2C-29] additions: app-foreground and `networkStatusChange.connected`
 * preempt any pending backoff timer across ALL queues (the spec requires
 * "natural reconnection should flush immediately, not wait for the timer")
 * and the foreground event additionally checks for new permanent-failure
 * drops and emits the toast event when at least one new drop has landed
 * since the user last saw the toast.
 */
export function initWriteQueue(): () => void {
  if (initialised) return () => undefined;
  initialised = true;

  const cleanups: Array<() => void> = [];
  const safeFlush = (): void => {
    void flushWriteQueue();
  };
  const safeOnForeground = (): void => {
    preemptBackoffSchedules();
    safeFlush();
    void checkPermanentFailuresOnForeground();
  };

  // Initial drain — picks up entries persisted by the native receiver while
  // the app process was dead.
  safeFlush();

  if (Capacitor.isNativePlatform()) {
    const handlePromise = App.addListener(
      'appStateChange',
      ({ isActive }) => {
        if (isActive) safeOnForeground();
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
  //
  // [2C-29] extension: a connect event preempts every queue's pending
  // backoff timer so the queues drain at the moment the user observes a
  // reconnection rather than waiting on the exponential schedule.
  let networkHandle: { remove: () => void } | null = null;
  void Network.addListener('networkStatusChange', (status) => {
    if (status.connected) {
      preemptBackoffSchedules();
      safeFlush();
    }
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
  toastListeners.clear();
  pendingConflicts = 0;
  initialised = false;
  for (const state of backoffStates.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
  }
  backoffStates.clear();
  scheduledFlushers.clear();
  __resetFlushStateForTests();
}
