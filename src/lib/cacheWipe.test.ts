/**
 * [2C-31] cacheWipe tests. Co-located per repo CLAUDE.md v3; spec named
 * `tests/integration/cacheWipeOnTokenChange.spec.tsx` — see PR body
 * Deviation #1.
 *
 * Covers the wipe filter shape (Acceptance criteria #2 sub-item "queue keys
 * included in wipe set"). The full token-change flow (gating on
 * pingHealth, modal flow, post-wipe re-seed) is exercised end-to-end in
 * `src/pages/SettingsPage.cacheLifecycle.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import { QueryClient } from '@tanstack/react-query';
import { wipeCacheAndQueueForPairingChange } from './cacheWipe';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.keys).mockReset();
  vi.mocked(Preferences.keys).mockImplementation(async () => ({
    keys: Array.from(prefsStore.keys()),
  }));
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wipeCacheAndQueueForPairingChange', () => {
  it('removes every brain.cache.* key', async () => {
    prefsStore.set('brain.cache.habits.active', '[]');
    prefsStore.set('brain.cache.routines.active', '[]');
    prefsStore.set('brain.cache.notifications', '[]');
    prefsStore.set('brain.cache.rules', '[]');
    prefsStore.set('brain.cache.checkins', '[]');
    prefsStore.set('brain.cache.seedCompleteFor', 'abc');
    await wipeCacheAndQueueForPairingChange(new QueryClient());
    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
    expect(prefsStore.has('brain.cache.routines.active')).toBe(false);
    expect(prefsStore.has('brain.cache.notifications')).toBe(false);
    expect(prefsStore.has('brain.cache.rules')).toBe(false);
    expect(prefsStore.has('brain.cache.checkins')).toBe(false);
    expect(prefsStore.has('brain.cache.seedCompleteFor')).toBe(false);
  });

  it('removes every brain.writeQueue* key (live queues + failures + counters)', async () => {
    prefsStore.set('brain.writeQueue', '[{}]');
    prefsStore.set('brain.writeQueue.habitCompletions', '[{}]');
    prefsStore.set('brain.writeQueue.routineCompletions', '[]');
    prefsStore.set('brain.writeQueue.failures.brain.writeQueue', '[{}]');
    prefsStore.set(
      'brain.writeQueue.failures.brain.writeQueue.habitCompletions',
      '[]',
    );
    prefsStore.set('brain.writeQueue.failures.totalDropsCount', '3');
    prefsStore.set('brain.writeQueue.failures.seenCount', '0');
    await wipeCacheAndQueueForPairingChange(new QueryClient());
    expect(prefsStore.has('brain.writeQueue')).toBe(false);
    expect(prefsStore.has('brain.writeQueue.habitCompletions')).toBe(false);
    expect(prefsStore.has('brain.writeQueue.routineCompletions')).toBe(false);
    expect(
      prefsStore.has('brain.writeQueue.failures.brain.writeQueue'),
    ).toBe(false);
    expect(
      prefsStore.has('brain.writeQueue.failures.brain.writeQueue.habitCompletions'),
    ).toBe(false);
    expect(prefsStore.has('brain.writeQueue.failures.totalDropsCount')).toBe(
      false,
    );
    expect(prefsStore.has('brain.writeQueue.failures.seenCount')).toBe(false);
  });

  it('preserves pairing identity keys and device registration marker', async () => {
    prefsStore.set('brain.serverUrl', 'https://brain.local:8000');
    prefsStore.set('brain.bearerToken', 'tk');
    prefsStore.set('brain.pairing.tokenHash', 'cafef00d');
    prefsStore.set('brain.pairing.previousUrl', 'https://brain.local:8000');
    prefsStore.set('brain.deviceRegisteredToken', 'fcm-xyz');
    prefsStore.set('brain.cache.habits.active', '[]');
    await wipeCacheAndQueueForPairingChange(new QueryClient());
    expect(prefsStore.has('brain.serverUrl')).toBe(true);
    expect(prefsStore.has('brain.bearerToken')).toBe(true);
    expect(prefsStore.has('brain.pairing.tokenHash')).toBe(true);
    expect(prefsStore.has('brain.pairing.previousUrl')).toBe(true);
    expect(prefsStore.has('brain.deviceRegisteredToken')).toBe(true);
    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
  });

  it('calls queryClient.clear()', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['habits', 'active'], [{ id: 'h1', title: 't' }]);
    queryClient.setQueryData(['routines', 'active'], [{ id: 'r1' }]);
    await wipeCacheAndQueueForPairingChange(queryClient);
    expect(queryClient.getQueryData(['habits', 'active'])).toBeUndefined();
    expect(queryClient.getQueryData(['routines', 'active'])).toBeUndefined();
  });

  it('no-ops cleanly when nothing matches the wipe prefixes', async () => {
    prefsStore.set('brain.serverUrl', 'https://x');
    prefsStore.set('brain.pairing.tokenHash', 'cafef00d');
    await wipeCacheAndQueueForPairingChange(new QueryClient());
    expect(prefsStore.has('brain.serverUrl')).toBe(true);
    expect(prefsStore.has('brain.pairing.tokenHash')).toBe(true);
    expect(vi.mocked(Preferences.remove)).not.toHaveBeenCalled();
  });
});
