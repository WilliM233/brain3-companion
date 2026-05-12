/**
 * [2C-31] cacheSeed tests. Co-located per repo CLAUDE.md v3; spec named
 * `tests/integration/cacheSeed.spec.tsx` — see PR body Deviation #1.
 *
 * Covers Acceptance criteria #1: pairing-complete event triggers all 5
 * fetches in parallel, idempotency flag prevents re-seed within session,
 * individual fetch failure does not block others, "Setting up" status flag
 * transitions correctly (the overlay subscribes to the same state surface
 * exercised here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

vi.mock('./notifications', () => ({
  fetchNotifications: vi.fn(),
  writeCachedNotifications: vi.fn(),
}));
vi.mock('./habits', () => ({
  fetchActiveHabits: vi.fn(),
  writeCachedHabits: vi.fn(),
}));
vi.mock('./routines', () => ({
  fetchActiveRoutines: vi.fn(),
  writeCachedRoutines: vi.fn(),
}));
vi.mock('./rules', () => ({
  fetchRules: vi.fn(),
  writeCachedRules: vi.fn(),
}));
vi.mock('./checkins', () => ({
  fetchCheckins: vi.fn(),
  writeCachedCheckins: vi.fn(),
}));

import { Preferences } from '@capacitor/preferences';
import { fetchNotifications, writeCachedNotifications } from './notifications';
import { fetchActiveHabits, writeCachedHabits } from './habits';
import { fetchActiveRoutines, writeCachedRoutines } from './routines';
import { fetchRules, writeCachedRules } from './rules';
import { fetchCheckins, writeCachedCheckins } from './checkins';
import {
  SEED_COMPLETE_KEY,
  __resetCacheSeedForTests,
  getCacheSeedStatus,
  runCacheSeed,
  subscribeCacheSeedState,
} from './cacheSeed';
import { computeTokenHash, type Pairing } from './pairing';

const prefsStore = new Map<string, string>();

const PAIRING: Pairing = {
  url: 'https://brain.local:8000',
  token: 'token-A',
};

beforeEach(() => {
  prefsStore.clear();
  __resetCacheSeedForTests();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefsStore.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });

  vi.mocked(fetchNotifications).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchActiveHabits).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchActiveRoutines).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchRules).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchCheckins).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(writeCachedNotifications).mockResolvedValue();
  vi.mocked(writeCachedHabits).mockResolvedValue();
  vi.mocked(writeCachedRoutines).mockResolvedValue();
  vi.mocked(writeCachedRules).mockResolvedValue();
  vi.mocked(writeCachedCheckins).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCacheSeed', () => {
  it('fires all five fetches when no seed-complete marker is set', async () => {
    await runCacheSeed(PAIRING);
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchActiveHabits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchActiveRoutines)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchRules)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchCheckins)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledWith(PAIRING);
    expect(vi.mocked(fetchActiveHabits)).toHaveBeenCalledWith(PAIRING);
    expect(vi.mocked(fetchActiveRoutines)).toHaveBeenCalledWith(PAIRING);
    expect(vi.mocked(fetchRules)).toHaveBeenCalledWith(PAIRING);
    expect(vi.mocked(fetchCheckins)).toHaveBeenCalledWith(PAIRING);
  });

  it('runs the five fetches in parallel (none waits on another to start)', async () => {
    let startCount = 0;
    let peakInFlight = 0;
    const tracker = async (): Promise<{ ok: true; items: [] }> => {
      startCount += 1;
      peakInFlight = Math.max(peakInFlight, startCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
      startCount -= 1;
      return { ok: true, items: [] };
    };
    vi.mocked(fetchNotifications).mockImplementation(tracker);
    vi.mocked(fetchActiveHabits).mockImplementation(tracker);
    vi.mocked(fetchActiveRoutines).mockImplementation(tracker);
    vi.mocked(fetchRules).mockImplementation(tracker);
    vi.mocked(fetchCheckins).mockImplementation(tracker);

    await runCacheSeed(PAIRING);
    expect(peakInFlight).toBe(5);
  });

  it('marks the seed complete for the current token hash on settle', async () => {
    await runCacheSeed(PAIRING);
    const expectedHash = await computeTokenHash(PAIRING.token);
    expect(prefsStore.get(SEED_COMPLETE_KEY)).toBe(expectedHash);
  });

  it('skips when the seed-complete marker already matches the current token hash', async () => {
    const hash = await computeTokenHash(PAIRING.token);
    prefsStore.set(SEED_COMPLETE_KEY, hash);
    await runCacheSeed(PAIRING);
    expect(vi.mocked(fetchNotifications)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchActiveHabits)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchActiveRoutines)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchRules)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchCheckins)).not.toHaveBeenCalled();
  });

  it('runs again after the marker is cleared (post-wipe re-seed)', async () => {
    await runCacheSeed(PAIRING);
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(1);
    // Simulate the [2C-31] wipe clearing the brain.cache.* key.
    prefsStore.delete(SEED_COMPLETE_KEY);
    await runCacheSeed(PAIRING);
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(2);
  });

  it('runs again when a different token pairs (different hash)', async () => {
    await runCacheSeed(PAIRING);
    await runCacheSeed({ url: PAIRING.url, token: 'token-B' });
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(2);
  });

  it('a rules-endpoint 500 does not block the other four fetches', async () => {
    vi.mocked(fetchRules).mockResolvedValue({
      ok: false,
      reason: 'server',
      statusCode: 500,
    });
    await runCacheSeed(PAIRING);
    expect(vi.mocked(writeCachedNotifications)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedHabits)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedRoutines)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedRules)).not.toHaveBeenCalled();
    expect(vi.mocked(writeCachedCheckins)).toHaveBeenCalledTimes(1);
    // Marker still set so the next foreground does not re-run the seed —
    // per-surface useQuery retries on its own.
    const expectedHash = await computeTokenHash(PAIRING.token);
    expect(prefsStore.get(SEED_COMPLETE_KEY)).toBe(expectedHash);
  });

  it('a thrown exception in one fetch does not block the others', async () => {
    vi.mocked(fetchActiveHabits).mockRejectedValue(new Error('boom'));
    await runCacheSeed(PAIRING);
    expect(vi.mocked(writeCachedNotifications)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedHabits)).not.toHaveBeenCalled();
    expect(vi.mocked(writeCachedRoutines)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedRules)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeCachedCheckins)).toHaveBeenCalledTimes(1);
  });

  it('does not write to a surface cache when the fetch returns ok=false', async () => {
    vi.mocked(fetchActiveHabits).mockResolvedValue({
      ok: false,
      reason: 'unauthorized',
      statusCode: 401,
    });
    await runCacheSeed(PAIRING);
    expect(vi.mocked(writeCachedHabits)).not.toHaveBeenCalled();
  });

  it('emits seeding → idle status transitions across the run', async () => {
    const events: string[] = [];
    const unsubscribe = subscribeCacheSeedState((next) => events.push(next));
    expect(getCacheSeedStatus()).toBe('idle');
    // Hold one fetch open so we can observe the intermediate `seeding`
    // status before the run settles. Array-of-resolvers avoids the
    // `let`/closure narrowing-to-null trap.
    const releasers: Array<() => void> = [];
    vi.mocked(fetchActiveHabits).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasers.push(() => resolve({ ok: true, items: [] }));
        }),
    );
    const work = runCacheSeed(PAIRING);
    await waitFor(() => expect(getCacheSeedStatus()).toBe('seeding'));
    for (const release of releasers) release();
    await work;
    expect(getCacheSeedStatus()).toBe('idle');
    expect(events).toEqual(['seeding', 'idle']);
    unsubscribe();
  });

  it('coalesces concurrent runs for the same token hash', async () => {
    let resolvers: Array<() => void> = [];
    vi.mocked(fetchNotifications).mockImplementation(
      () =>
        new Promise((resolve) =>
          resolvers.push(() => resolve({ ok: true, items: [] })),
        ),
    );
    const first = runCacheSeed(PAIRING);
    const second = runCacheSeed(PAIRING);
    // Wait until the in-flight seed has dispatched its fetches, then assert
    // a second call did not spawn a parallel seed.
    await waitFor(() =>
      expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(1),
    );
    for (const r of resolvers) r();
    resolvers = [];
    await Promise.all([first, second]);
    expect(vi.mocked(fetchNotifications)).toHaveBeenCalledTimes(1);
  });
});
