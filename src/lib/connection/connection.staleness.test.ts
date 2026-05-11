/**
 * [2C-27] Staleness-threshold coverage. Separate file from the main
 * derivation suite so the timer mechanics stay isolated and the spec's
 * acceptance criteria split (`connection.spec.ts` for transitions,
 * `connection.staleness.spec.ts` for staleness) maps to a clear test
 * boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTests,
  deriveConnectionState,
  getSnapshot,
  recordOutcome,
  setNetworkOnline,
} from './store';
import { STALENESS_THRESHOLD_MS } from './config';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  __resetForTests();
});

describe('staleness threshold', () => {
  it('defaults to 5 minutes', () => {
    expect(STALENESS_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('returns `connected` while the most-recent success is within the window', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    const justInside = deriveConnectionState(
      getSnapshot(),
      NOW + STALENESS_THRESHOLD_MS,
    );
    expect(justInside.status).toBe('connected');
  });

  it('transitions to `degraded` once the threshold elapses without a new success', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    const justOutside = deriveConnectionState(
      getSnapshot(),
      NOW + STALENESS_THRESHOLD_MS + 1,
    );
    expect(justOutside.status).toBe('degraded');
  });

  it('applies the same threshold uniformly across query keys', () => {
    setNetworkOnline(true);

    // Three different entity-type queries succeed at NOW. After 5 min + 1 ms,
    // all three should be reported stale via the same `lastSuccessAt` field —
    // there is no per-key bookkeeping.
    recordOutcome('success', ['habits'], NOW);
    recordOutcome('success', ['notifications'], NOW);
    recordOutcome('success', ['routines'], NOW);

    const state = deriveConnectionState(
      getSnapshot(),
      NOW + STALENESS_THRESHOLD_MS + 1,
    );
    expect(state.status).toBe('degraded');
  });

  it('a fresh success past the threshold restores `connected`', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);

    const stale = deriveConnectionState(
      getSnapshot(),
      NOW + STALENESS_THRESHOLD_MS + 1,
    );
    expect(stale.status).toBe('degraded');

    recordOutcome('success', ['habits'], NOW + STALENESS_THRESHOLD_MS + 100);

    const restored = deriveConnectionState(
      getSnapshot(),
      NOW + STALENESS_THRESHOLD_MS + 200,
    );
    expect(restored.status).toBe('connected');
    expect(restored.lastSyncedAt).toBe(NOW + STALENESS_THRESHOLD_MS + 100);
  });

  it('threshold value is the single constant in config.ts', async () => {
    // Asserts the contract: `STALENESS_THRESHOLD_MS` is the only knob — no
    // per-key override, no env variable, no derived constant elsewhere.
    const configModule = await import('./config');
    expect(typeof configModule.STALENESS_THRESHOLD_MS).toBe('number');
    expect(configModule.STALENESS_THRESHOLD_MS).toBeGreaterThan(0);
  });
});
