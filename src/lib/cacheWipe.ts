/**
 * [2C-31] Wipe-on-token-change operation.
 *
 * Stricter than [2C-30]'s `clearLocalCache` action: this wipe also drops the
 * write-queue Preferences keys (live entries + failures log + counters)
 * because queue entries enqueued against the previous pairing are unsafe to
 * flush against a new server. Per Pass 5 Summary §3 [2C-31] Scope.
 *
 * Wipe filter prefixes:
 * - `brain.cache.` — all entity caches plus the seed-complete marker.
 * - `brain.writeQueue` — `brain.writeQueue` itself, the
 *   `brain.writeQueue.habitCompletions` / `brain.writeQueue.routineCompletions`
 *   live queues, the `brain.writeQueue.failures.*` log + counters.
 *
 * Pairing identity keys (`brain.serverUrl`, `brain.bearerToken`,
 * `brain.pairing.tokenHash`, `brain.pairing.previousUrl`) and the device
 * registration marker (`brain.deviceRegisteredToken`) are NOT touched —
 * those represent the new pairing's identity, which is being established by
 * the same Connect flow that invoked the wipe.
 */

import { Preferences } from '@capacitor/preferences';
import type { QueryClient } from '@tanstack/react-query';

export const CACHE_KEY_PREFIX = 'brain.cache.';
export const WRITE_QUEUE_KEY_PREFIX = 'brain.writeQueue';

function shouldWipe(key: string): boolean {
  return (
    key.startsWith(CACHE_KEY_PREFIX) || key.startsWith(WRITE_QUEUE_KEY_PREFIX)
  );
}

/**
 * Remove every Preferences key under the `brain.cache.` or `brain.writeQueue`
 * prefix and clear the passed query client. Invoked from `[2C-12]`'s Connect
 * handler after the user confirms the wipe modal that fires when the new
 * pairing's token hash or URL differs from the stored markers. See
 * {@link ./pairing#savePairing} for the markers that drive the diff and
 * {@link ./cacheSeed#runCacheSeed} for the re-seed that follows.
 */
export async function wipeCacheAndQueueForPairingChange(
  queryClient: QueryClient,
): Promise<void> {
  const { keys } = await Preferences.keys();
  const targets = keys.filter(shouldWipe);
  await Promise.all(
    targets.map((key) => Preferences.remove({ key })),
  );
  queryClient.clear();
}
