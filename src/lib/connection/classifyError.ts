/**
 * Heuristic classification of TanStack Query error rejections into the
 * `ApiOutcome` taxonomy used by the connection store.
 *
 * The codebase's queries currently throw `new Error('Failed to fetch X')`
 * style rejections without attached status info, so most paths land in
 * `network_error` by default. The classification fans out:
 *
 * - `error` is a `TypeError` → `network_error` (fetch-level failure).
 * - `error.name === 'AbortError'` → `timeout` (best-effort — most aborts in
 *   this codebase are timer-driven; user-cancelled aborts are rare).
 * - `error.status` is 500-599 (custom HTTPError shape) → `server_error`.
 * - Anything else → `network_error` (safe default; degrades toward offline
 *   rather than masking a connectivity gap as a transient server hiccup).
 *
 * Future query refactors can throw structured errors with `.status` to
 * sharpen `server_error` classification without changing this contract.
 */

import type { ApiOutcome } from './types';

export function classifyError(error: unknown): ApiOutcome {
  if (error instanceof TypeError) return 'network_error';
  if (error !== null && typeof error === 'object') {
    const e = error as { name?: unknown; status?: unknown };
    if (e.name === 'AbortError') return 'timeout';
    if (typeof e.status === 'number' && e.status >= 500 && e.status < 600) {
      return 'server_error';
    }
  }
  return 'network_error';
}
