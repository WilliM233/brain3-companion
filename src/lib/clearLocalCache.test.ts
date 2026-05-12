/**
 * [2C-30] clearLocalCache tests. Co-located per repo CLAUDE.md v3; spec
 * named `tests/integration/settingsClearCache.spec.tsx` — see PR body
 * Deviation #1.
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
import { clearLocalCache } from './clearLocalCache';

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

describe('clearLocalCache', () => {
  it('removes every brain.cache.* key', async () => {
    prefsStore.set('brain.cache.habits.active', '[]');
    prefsStore.set('brain.cache.routines.active', '[]');
    prefsStore.set('brain.cache.notifications', '[]');
    prefsStore.set('brain.cache.habit.abc', '{}');
    const queryClient = new QueryClient();
    await clearLocalCache(queryClient);
    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
    expect(prefsStore.has('brain.cache.routines.active')).toBe(false);
    expect(prefsStore.has('brain.cache.notifications')).toBe(false);
    expect(prefsStore.has('brain.cache.habit.abc')).toBe(false);
  });

  it('preserves brain.writeQueue and brain.writeQueue.* keys', async () => {
    prefsStore.set('brain.cache.habits.active', '[]');
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
    const queryClient = new QueryClient();
    await clearLocalCache(queryClient);
    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
    expect(prefsStore.has('brain.writeQueue')).toBe(true);
    expect(prefsStore.has('brain.writeQueue.habitCompletions')).toBe(true);
    expect(prefsStore.has('brain.writeQueue.routineCompletions')).toBe(true);
    expect(prefsStore.has('brain.writeQueue.failures.brain.writeQueue')).toBe(
      true,
    );
    expect(
      prefsStore.has('brain.writeQueue.failures.brain.writeQueue.habitCompletions'),
    ).toBe(true);
    expect(prefsStore.has('brain.writeQueue.failures.totalDropsCount')).toBe(
      true,
    );
    expect(prefsStore.has('brain.writeQueue.failures.seenCount')).toBe(true);
  });

  it('preserves non-brain.cache keys (e.g., pairing, registration)', async () => {
    prefsStore.set('brain.pairing.url', 'https://x');
    prefsStore.set('brain.pairing.token', 'secret');
    prefsStore.set('brain.deviceRegistration.fcmToken', 'fcm');
    prefsStore.set('brain.cache.notifications', '[]');
    const queryClient = new QueryClient();
    await clearLocalCache(queryClient);
    expect(prefsStore.has('brain.pairing.url')).toBe(true);
    expect(prefsStore.has('brain.pairing.token')).toBe(true);
    expect(prefsStore.has('brain.deviceRegistration.fcmToken')).toBe(true);
    expect(prefsStore.has('brain.cache.notifications')).toBe(false);
  });

  it('calls queryClient.clear()', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['habits', 'active'], [{ id: 'h1', title: 't' }]);
    queryClient.setQueryData(['routines', 'active'], [{ id: 'r1' }]);
    expect(queryClient.getQueryData(['habits', 'active'])).toBeDefined();
    await clearLocalCache(queryClient);
    expect(queryClient.getQueryData(['habits', 'active'])).toBeUndefined();
    expect(queryClient.getQueryData(['routines', 'active'])).toBeUndefined();
  });

  it('no-ops cleanly when nothing matches the prefix', async () => {
    prefsStore.set('brain.pairing.url', 'https://x');
    const queryClient = new QueryClient();
    await clearLocalCache(queryClient);
    expect(prefsStore.has('brain.pairing.url')).toBe(true);
    expect(vi.mocked(Preferences.remove)).not.toHaveBeenCalled();
  });
});
