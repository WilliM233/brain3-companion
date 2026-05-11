/**
 * Connection-state configuration constants for [2C-27].
 *
 * Single source of truth for tuning the indicator's derivation rules.
 * Adjust here rather than at call sites.
 */

/**
 * Staleness threshold applied uniformly across all entity-type queries.
 * If no successful TanStack Query has resolved within this window and the
 * network reports connected, the indicator transitions to `degraded`.
 *
 * Default 5 minutes per Pass 5 Summary §3 [2C-27] and Escalation 2.
 */
export const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Rolling-window size for API-attempt outcomes used in the offline/degraded
 * derivation rules.
 *
 * - `offline` requires the last 3 attempts to have been network-errored or
 *   timed out.
 * - `degraded` 5xx-rule requires the last 2 attempts to have returned 5xx.
 */
export const OUTCOME_WINDOW_SIZE = 3;

/**
 * Minimum visual dwell time on `syncing` after a flush event fires. Prevents
 * sub-perceptible flicker when a flush completes in <100 ms on fast networks.
 *
 * Per Pass 5 Summary §3 [2C-27] "Pulse cap: indicator stays in `syncing` for
 * at least 800 ms even if flush completes faster".
 */
export const SYNCING_PULSE_FLOOR_MS = 800;
