/**
 * [2C-28] per-surface `lastSyncedAt` helper. Returns `Math.max(...)` across
 * the `dataUpdatedAt` of the passed TanStack Query keys, or `null` when none
 * has been fetched.
 *
 * Surfaces composing multiple queries (e.g., habit detail = habit +
 * graduation) call this and pass the result to the StalenessBanner's
 * `lastSyncedAt` prop. Surfaces with a single query — or none — can omit the
 * banner prop and fall back to the connection hook's global
 * `lastSyncedAt`.
 *
 * No subscription: this returns a synchronous read from the QueryClient on
 * each render. Callers must already re-render when the relevant queries
 * update (which they do automatically when they consume `useQuery` for the
 * same keys). The connection hook + provider drive the broader connection
 * state; this helper is just a per-surface granularity hook on top of the
 * existing TanStack cache.
 */

import { useQueryClient, type QueryKey } from '@tanstack/react-query';

export function useSurfaceLastSync(keys: readonly QueryKey[]): number | null {
  const client = useQueryClient();
  let max = -1;
  for (const key of keys) {
    const state = client.getQueryState(key);
    if (state && state.dataUpdatedAt > max) {
      max = state.dataUpdatedAt;
    }
  }
  return max > 0 ? max : null;
}
