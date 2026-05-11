/**
 * [2C-27] State-transition test bed for the connection store + derivation.
 *
 * The store is exercised at the mutator layer rather than through the
 * `ConnectionStateProvider`, so listener wiring (Capacitor Network plugin,
 * TanStack Query cache, write-queue flush emitter) is not under test here.
 * That coverage lives in `connection.staleness.test.ts` (timer behavior)
 * and the manual verification procedure in the Pass 5 spec.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTests,
  deriveConnectionState,
  getSnapshot,
  recordOutcome,
  setFlushing,
  setNetworkOnline,
} from './store';
import { SYNCING_PULSE_FLOOR_MS } from './config';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  __resetForTests();
});

describe('connection state derivation', () => {
  it('reports `connected` for net-up + recent success', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    const state = deriveConnectionState(getSnapshot(), NOW + 1_000);
    expect(state.status).toBe('connected');
    expect(state.lastSyncedAt).toBe(NOW);
    expect(state.lastSyncedQueryKey).toEqual(['habits']);
  });

  it('is optimistically `connected` on first render before any API attempt', () => {
    setNetworkOnline(true);

    const state = deriveConnectionState(getSnapshot(), NOW);
    expect(state.status).toBe('connected');
    expect(state.lastSyncedAt).toBeNull();
  });

  it('reports `degraded` when the last 2 attempts returned 5xx', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);
    recordOutcome('server_error', ['habits'], NOW + 1_000);
    recordOutcome('server_error', ['habits'], NOW + 2_000);

    const state = deriveConnectionState(getSnapshot(), NOW + 3_000);
    expect(state.status).toBe('degraded');
  });

  it('reports `offline` when the network plugin reports down', () => {
    setNetworkOnline(false);
    recordOutcome('success', ['habits'], NOW);

    const state = deriveConnectionState(getSnapshot(), NOW + 1_000);
    expect(state.status).toBe('offline');
  });

  it('reports `offline` when the last 3 attempts all network-errored', () => {
    setNetworkOnline(true);
    recordOutcome('network_error', ['habits'], NOW);
    recordOutcome('network_error', ['notifications'], NOW + 1_000);
    recordOutcome('network_error', ['routines'], NOW + 2_000);

    const state = deriveConnectionState(getSnapshot(), NOW + 3_000);
    expect(state.status).toBe('offline');
  });

  it('reports `offline` when the last 3 attempts mix network-errors and timeouts', () => {
    setNetworkOnline(true);
    recordOutcome('timeout', ['habits'], NOW);
    recordOutcome('network_error', ['notifications'], NOW + 1_000);
    recordOutcome('timeout', ['routines'], NOW + 2_000);

    const state = deriveConnectionState(getSnapshot(), NOW + 3_000);
    expect(state.status).toBe('offline');
  });

  it('reports `syncing` while the write-queue flush is active', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    setFlushing(true, NOW + 1_000);

    const state = deriveConnectionState(getSnapshot(), NOW + 1_200);
    expect(state.status).toBe('syncing');
  });

  it('keeps `syncing` for the pulse floor after a fast flush', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    setFlushing(true, NOW + 1_000);
    setFlushing(false, NOW + 1_050); // 50 ms flush — pulseUntil floor is 800 ms.

    // Mid-pulse: still syncing.
    const midPulse = deriveConnectionState(getSnapshot(), NOW + 1_400);
    expect(midPulse.status).toBe('syncing');

    // Past pulseUntil: back to connected.
    const past = deriveConnectionState(
      getSnapshot(),
      NOW + 1_000 + SYNCING_PULSE_FLOOR_MS + 1,
    );
    expect(past.status).toBe('connected');
  });

  it('syncing wins over offline/degraded — the pulse is the most actionable signal', () => {
    setNetworkOnline(false);
    setFlushing(true, NOW);

    const state = deriveConnectionState(getSnapshot(), NOW + 100);
    expect(state.status).toBe('syncing');
  });

  it('rolling window discards entries older than N=3', () => {
    setNetworkOnline(true);
    // Four errors — the oldest falls out of the window so all-3-errored holds.
    recordOutcome('network_error', null, NOW);
    recordOutcome('network_error', null, NOW + 1);
    recordOutcome('success', ['habits'], NOW + 2);
    recordOutcome('network_error', null, NOW + 3);
    recordOutcome('network_error', null, NOW + 4);
    recordOutcome('network_error', null, NOW + 5);

    const state = deriveConnectionState(getSnapshot(), NOW + 6);
    expect(state.status).toBe('offline');
  });

  it('a single 5xx is not enough — degraded requires two consecutive', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);
    recordOutcome('server_error', ['habits'], NOW + 1_000);

    const state = deriveConnectionState(getSnapshot(), NOW + 2_000);
    expect(state.status).toBe('connected');
  });
});
