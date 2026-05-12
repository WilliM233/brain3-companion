/**
 * [2C-30] "Clear local cache" action.
 *
 * Scans `@capacitor/preferences` for keys with the `brain.cache.` prefix and
 * removes them, then invalidates the TanStack Query cache so the app-shell
 * refetches on next interaction. Live write-queue keys (`brain.writeQueue`,
 * `brain.writeQueue.habitCompletions`, `brain.writeQueue.routineCompletions`)
 * and the failures log (`brain.writeQueue.failures.*`) are preserved by the
 * prefix filter — pending writes survive the clear, per Pass 5 Summary §3
 * [2C-30] Scope.
 */

import { Preferences } from '@capacitor/preferences';
import type { QueryClient } from '@tanstack/react-query';

export const CACHE_KEY_PREFIX = 'brain.cache.';

/**
 * Remove every Preferences key starting with `brain.cache.` and clear the
 * passed query client. Does not touch `brain.writeQueue*` keys or the
 * pairing keys.
 */
export async function clearLocalCache(queryClient: QueryClient): Promise<void> {
  const { keys } = await Preferences.keys();
  const cacheKeys = keys.filter((key) => key.startsWith(CACHE_KEY_PREFIX));
  await Promise.all(cacheKeys.map((key) => Preferences.remove({ key })));
  queryClient.clear();
}
