/**
 * [2C-28] "Last synced" banner. Slim secondary line rendered under the page
 * header on list and detail surfaces. Visible only when the [2C-27]
 * `useConnectionState` reports `degraded` or `offline`; hidden during
 * `connected` and `syncing`.
 *
 * Banner copy follows the Pass 5 spec:
 *   - offline + lastSyncedAt:    "Showing cached data — last synced Xm ago"
 *   - offline + null:            "Showing cached data — never synced. Pull down to refresh."
 *   - degraded + lastSyncedAt:   "Connection issues — last synced Xm ago"
 *   - degraded + null:           Falls through to the "never synced" copy.
 *     (Spec is explicit on the offline/null fallback only; degraded with no
 *     prior success is an edge case that arises if the first 2 API attempts
 *     return 5xx — using the same copy avoids printing "— ago" with a missing
 *     timestamp.)
 *
 * Visibility transitions are debounced by 250 ms so the banner does not
 * flash in or out during rapid status flips (e.g., a write-queue flush that
 * briefly carries the indicator through `syncing` → `connected`).
 *
 * Per-surface `lastSyncedAt`: surfaces that compose multiple TanStack queries
 * (e.g. habit detail = habit + graduation) pass the max of their
 * `dataUpdatedAt` via the optional `lastSyncedAt` prop. Surfaces that read a
 * single query (or no TanStack query) can omit the prop and fall back to the
 * connection hook's global value.
 */

import { useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useConnectionState } from '../lib/connection/useConnectionState';

export interface StalenessBannerProps {
  /**
   * Per-surface lastSyncedAt timestamp (epoch ms). When provided, takes
   * precedence over the connection hook's global `lastSyncedAt`. Pass `null`
   * to explicitly force the "never synced" copy; omit to fall back to the
   * global value.
   */
  lastSyncedAt?: number | null;
}

const DEBOUNCE_MS = 250;

const StalenessBanner: React.FC<StalenessBannerProps> = ({ lastSyncedAt }) => {
  const state = useConnectionState();
  const wantVisible = state.status === 'degraded' || state.status === 'offline';
  const [visible, setVisible] = useState(wantVisible);

  useEffect(() => {
    if (wantVisible === visible) return;
    const id = window.setTimeout(() => setVisible(wantVisible), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [wantVisible, visible]);

  if (!visible) return null;

  const status: 'degraded' | 'offline' =
    state.status === 'offline' ? 'offline' : 'degraded';
  const effective =
    lastSyncedAt !== undefined ? lastSyncedAt : state.lastSyncedAt;

  return (
    <div
      className="px-4 pt-3 pb-2 text-sm text-neutral-300"
      role="status"
      aria-live="polite"
      data-testid="staleness-banner"
      data-connection-status={status}
    >
      {bannerCopy(status, effective)}
    </div>
  );
};

function bannerCopy(
  status: 'degraded' | 'offline',
  lastSyncedAt: number | null,
): string {
  if (lastSyncedAt === null) {
    return 'Showing cached data — never synced. Pull down to refresh.';
  }
  const ago = formatDistanceToNowStrict(lastSyncedAt);
  if (status === 'offline') {
    return `Showing cached data — last synced ${ago} ago`;
  }
  return `Connection issues — last synced ${ago} ago`;
}

export default StalenessBanner;
