/**
 * Public types for the [2C-27] connection state surface.
 *
 * The hook output is a discriminated union over four observable states. The
 * surrounding fields (`lastSyncedAt`, `lastSyncedQueryKey`) are populated on
 * the same shape regardless of `status` so consumers can render staleness
 * affordances ([2C-28] banner) alongside the indicator without a second hook.
 */

import type { QueryKey } from '@tanstack/react-query';

export type ConnectionStatus = 'connected' | 'syncing' | 'degraded' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  lastSyncedAt: number | null;
  lastSyncedQueryKey: QueryKey | null;
}

/**
 * Classification of a single TanStack Query attempt outcome as observed by
 * the connection store. Used to populate the rolling window the derivation
 * rules consult.
 *
 * - `success` — query resolved with a value.
 * - `server_error` — query rejected with an HTTP status in 500-599.
 * - `network_error` — query rejected with a fetch-level failure
 *   (`TypeError`, name `AbortError` when not initiated by us, etc.).
 * - `timeout` — query rejected after a timer-driven `AbortController.abort()`.
 */
export type ApiOutcome =
  | 'success'
  | 'server_error'
  | 'network_error'
  | 'timeout';
