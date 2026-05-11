/**
 * Write-queue flush-state event surface shared by [2C-27] (consumer) and
 * [2C-29] (producer).
 *
 * Two layered surfaces:
 *
 * - **Aggregate `FlushState`** — `'idle' | 'flushing' | 'backoff'`, single
 *   value derived across all queues. [2C-27]'s connection store subscribes
 *   via {@link subscribeFlushState} to drive the indicator's `syncing` pulse.
 *   Backoff is reported as a distinct state from `idle` so future surfaces
 *   can distinguish "queue settled" from "queue waiting for retry," but
 *   [2C-27] treats it as not-flushing today (the pulse only fires while a
 *   flush is actively in progress).
 *
 * - **Per-queue `FlushDetail`** — `{ status, queueKey, nextRetryAt }`,
 *   carries the queue identifier and the timestamp of the next scheduled
 *   retry. [2C-30] (Settings → Pending sync) will subscribe to surface the
 *   retry countdown per queue. [2C-29] is the sole producer.
 *
 * Follows the `Set<Listener>` pub-sub convention used throughout this repo
 * (`pairing.ts`, `writeQueue.ts:subscribeConflicts`,
 * `completionQueues.ts:subscribe*Warnings`). The Pass 5 brief's `mitt`
 * suggestion was a recommendation, not a mandate — staying consistent with
 * the existing pattern avoids introducing a dep with no functional gain.
 */

export type FlushState = 'idle' | 'flushing' | 'backoff';

export interface FlushDetail {
  status: FlushState;
  queueKey: string;
  /**
   * Epoch-milliseconds timestamp of the next scheduled retry when the queue
   * is in `backoff`, or `null` for `idle` / `flushing`. Settings consumers
   * can derive a countdown from `nextRetryAt - Date.now()`.
   */
  nextRetryAt: number | null;
}

type AggregateListener = (state: FlushState) => void;
type DetailListener = (detail: FlushDetail) => void;

const aggregateListeners = new Set<AggregateListener>();
const detailListeners = new Set<DetailListener>();

const details = new Map<string, FlushDetail>();
let aggregate: FlushState = 'idle';

function deriveAggregate(): FlushState {
  let sawBackoff = false;
  for (const detail of details.values()) {
    if (detail.status === 'flushing') return 'flushing';
    if (detail.status === 'backoff') sawBackoff = true;
  }
  return sawBackoff ? 'backoff' : 'idle';
}

export function getFlushState(): FlushState {
  return aggregate;
}

export function subscribeFlushState(listener: AggregateListener): () => void {
  aggregateListeners.add(listener);
  return () => {
    aggregateListeners.delete(listener);
  };
}

export function getFlushDetail(queueKey: string): FlushDetail {
  return (
    details.get(queueKey) ?? {
      status: 'idle',
      queueKey,
      nextRetryAt: null,
    }
  );
}

export function getAllFlushDetail(): FlushDetail[] {
  return Array.from(details.values());
}

export function subscribeFlushDetail(listener: DetailListener): () => void {
  detailListeners.add(listener);
  return () => {
    detailListeners.delete(listener);
  };
}

/**
 * Publish a per-queue transition. Computes the aggregate `FlushState` and
 * emits to {@link subscribeFlushState} listeners only when it changes,
 * keeping the existing single-flag consumer (`ConnectionStateProvider`)
 * untouched on no-op transitions.
 */
export function emitFlushDetail(detail: FlushDetail): void {
  details.set(detail.queueKey, detail);
  for (const listener of detailListeners) listener(detail);
  const next = deriveAggregate();
  if (next !== aggregate) {
    aggregate = next;
    for (const listener of aggregateListeners) listener(aggregate);
  }
}

export function __resetFlushStateForTests(): void {
  aggregateListeners.clear();
  detailListeners.clear();
  details.clear();
  aggregate = 'idle';
}
