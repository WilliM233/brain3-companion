/**
 * Module-level singleton store backing [2C-27]'s `useConnectionState` hook.
 *
 * One instance is created at module load. The provider feeds it events from
 * the Capacitor Network plugin, the TanStack Query cache, and the
 * write-queue flush emitter; the hook reads via `useSyncExternalStore`. The
 * indirection lets consumers re-render on state change without each instance
 * mounting its own Network listener.
 *
 * The rolling window of outcomes (cap N) is intentionally tiny — it backs
 * the offline/degraded derivation only and discards older entries.
 *
 * **Test escape hatch:** `__resetForTests` resets all state including the
 * staleness timer. Tests can manipulate state by calling the mutators
 * directly without going through the provider.
 */

import type { QueryKey } from '@tanstack/react-query';
import {
  OUTCOME_WINDOW_SIZE,
  STALENESS_THRESHOLD_MS,
  SYNCING_PULSE_FLOOR_MS,
} from './config';
import type { ApiOutcome, ConnectionState, ConnectionStatus } from './types';

export interface ConnectionSnapshot {
  networkOnline: boolean;
  outcomes: readonly ApiOutcome[];
  lastSuccessAt: number | null;
  lastSuccessQueryKey: QueryKey | null;
  flushing: boolean;
  /**
   * Timestamp (ms) before which the indicator must remain in `syncing` even
   * if `flushing` has dropped to false. Enforces the 800 ms pulse floor.
   */
  pulseUntil: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: ConnectionSnapshot = freshSnapshot();

let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let stalenessTimer: ReturnType<typeof setTimeout> | null = null;

function freshSnapshot(): ConnectionSnapshot {
  return {
    networkOnline: true,
    outcomes: [],
    lastSuccessAt: null,
    lastSuccessQueryKey: null,
    flushing: false,
    pulseUntil: 0,
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function update(patch: Partial<ConnectionSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ConnectionSnapshot {
  return snapshot;
}

export function setNetworkOnline(networkOnline: boolean): void {
  if (snapshot.networkOnline === networkOnline) return;
  update({ networkOnline });
}

export function recordOutcome(
  outcome: ApiOutcome,
  queryKey: QueryKey | null = null,
  now: number = Date.now(),
): void {
  const next = snapshot.outcomes
    .concat(outcome)
    .slice(-OUTCOME_WINDOW_SIZE);
  const patch: Partial<ConnectionSnapshot> = { outcomes: next };
  if (outcome === 'success') {
    patch.lastSuccessAt = now;
    patch.lastSuccessQueryKey = queryKey;
    scheduleStalenessExpiry(now);
  }
  update(patch);
}

function scheduleStalenessExpiry(lastSuccessAt: number): void {
  if (stalenessTimer !== null) {
    clearTimeout(stalenessTimer);
    stalenessTimer = null;
  }
  const fireAt = lastSuccessAt + STALENESS_THRESHOLD_MS;
  const delay = Math.max(0, fireAt - Date.now());
  stalenessTimer = setTimeout(() => {
    stalenessTimer = null;
    // Re-emit the snapshot so consumers re-derive at the moment of expiry.
    // The data hasn't changed, but the derivation now flips to `degraded`
    // because `now > lastSuccessAt + STALENESS_THRESHOLD_MS`.
    snapshot = { ...snapshot };
    notify();
  }, delay);
}

export function setFlushing(flushing: boolean, now: number = Date.now()): void {
  if (flushing) {
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    const pulseUntil = Math.max(snapshot.pulseUntil, now + SYNCING_PULSE_FLOOR_MS);
    update({ flushing: true, pulseUntil });
    return;
  }
  // Flush ended: keep the indicator in `syncing` until pulseUntil expires.
  const remaining = Math.max(0, snapshot.pulseUntil - now);
  update({ flushing: false });
  if (remaining > 0) {
    if (pulseTimer !== null) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      // Refresh snapshot reference so React re-derives; pulseUntil is already
      // in the past at this point and `flushing` is already false.
      snapshot = { ...snapshot };
      notify();
    }, remaining);
  }
}

/**
 * Pure derivation of the indicator's observable state from a snapshot. The
 * `now` parameter is injected so tests can pin a deterministic clock and so
 * staleness comparisons use the same instant as the React render that
 * consumes the result.
 *
 * Priority: `syncing` > `offline` > `degraded` > `connected`. `syncing` wins
 * when a flush is active or the 800 ms pulse floor hasn't elapsed, even if
 * other rules would also fire — the pulse is the most actionable feedback.
 */
export function deriveConnectionState(
  snap: ConnectionSnapshot,
  now: number,
): ConnectionState {
  const status = deriveStatus(snap, now);
  return {
    status,
    lastSyncedAt: snap.lastSuccessAt,
    lastSyncedQueryKey: snap.lastSuccessQueryKey,
  };
}

function deriveStatus(snap: ConnectionSnapshot, now: number): ConnectionStatus {
  if (snap.flushing || now < snap.pulseUntil) return 'syncing';

  const last3 = snap.outcomes.slice(-3);
  const allErrored =
    last3.length === OUTCOME_WINDOW_SIZE &&
    last3.every((o) => o === 'network_error' || o === 'timeout');
  if (!snap.networkOnline || allErrored) return 'offline';

  const last2 = snap.outcomes.slice(-2);
  const twoServerErrors =
    last2.length === 2 && last2.every((o) => o === 'server_error');
  // Staleness applies only after a first success has been recorded. Pre-first-
  // success the indicator is optimistically `connected`; the first resolved
  // query updates `lastSuccessAt` and the timer-driven re-emit covers the
  // expiry boundary thereafter.
  const stale =
    snap.lastSuccessAt !== null &&
    now - snap.lastSuccessAt > STALENESS_THRESHOLD_MS;
  if (twoServerErrors || stale) return 'degraded';

  return 'connected';
}

export function __resetForTests(): void {
  if (pulseTimer !== null) {
    clearTimeout(pulseTimer);
    pulseTimer = null;
  }
  if (stalenessTimer !== null) {
    clearTimeout(stalenessTimer);
    stalenessTimer = null;
  }
  listeners.clear();
  snapshot = freshSnapshot();
}
