/**
 * [2C-31] Cache seed on pairing-complete.
 *
 * Performs the five parallel fetches that the v2.0.0 app caches so a
 * freshly-paired device renders every list surface immediately on first
 * navigation. Idempotent per token hash via `brain.cache.seedCompleteFor`:
 * once a seed completes for a token, the marker prevents re-runs until a
 * different token pairs (which wipes the marker via {@link ./cacheWipe}).
 *
 * Failure handling: each fetch is independent (`Promise.allSettled`). One
 * failure does NOT block the others — per Pass 5 Summary §3 [2C-31] Scope.
 * Failed fetches retry on next foreground via the surfaces' own `useQuery`
 * calls. The seed-complete marker is written on settle regardless of
 * per-fetch outcomes, so a transient seed-time outage does not pin the
 * "Setting up…" overlay on subsequent launches.
 *
 * The hook ({@link useCacheSeed}) is called from `App.tsx`. State transitions
 * (`idle` → `seeding` → `idle`) are exposed via {@link subscribeCacheSeedState}
 * so the {@link ../components/CacheSeedOverlay} can render the spinner
 * during the work without coupling to the runner.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { Preferences } from '@capacitor/preferences';
import { fetchCheckins, writeCachedCheckins } from './checkins';
import { fetchActiveHabits, writeCachedHabits } from './habits';
import { fetchNotifications, writeCachedNotifications } from './notifications';
import { fetchActiveRoutines, writeCachedRoutines } from './routines';
import { fetchRules, writeCachedRules } from './rules';
import {
  computeTokenHash,
  loadPairing,
  subscribePairing,
  type Pairing,
} from './pairing';

export const SEED_COMPLETE_KEY = 'brain.cache.seedCompleteFor';

export type CacheSeedStatus = 'idle' | 'seeding';

type Listener = (status: CacheSeedStatus) => void;

const listeners = new Set<Listener>();
let currentStatus: CacheSeedStatus = 'idle';
const inFlight = new Map<string, Promise<void>>();

function setStatus(next: CacheSeedStatus): void {
  if (currentStatus === next) return;
  currentStatus = next;
  for (const l of listeners) l(next);
}

export function getCacheSeedStatus(): CacheSeedStatus {
  return currentStatus;
}

export function subscribeCacheSeedState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function loadSeedCompleteFor(): Promise<string | null> {
  const { value } = await Preferences.get({ key: SEED_COMPLETE_KEY });
  return value ?? null;
}

async function markSeedComplete(tokenHash: string): Promise<void> {
  await Preferences.set({ key: SEED_COMPLETE_KEY, value: tokenHash });
}

/**
 * Run the five seed fetches in parallel and persist each surface's
 * `brain.cache.*` blob. The Promise resolves once every fetch settles.
 * Per-surface failures are swallowed — the writer is only invoked when the
 * fetcher returns `{ ok: true, items }`, so a 5xx or network error leaves
 * the existing cache (if any) untouched.
 */
async function seedSurfaces(pairing: Pairing): Promise<void> {
  await Promise.allSettled([
    fetchNotifications(pairing).then(async (result) => {
      if (result.ok) await writeCachedNotifications(result.items);
    }),
    fetchActiveHabits(pairing).then(async (result) => {
      if (result.ok) await writeCachedHabits(result.items);
    }),
    fetchActiveRoutines(pairing).then(async (result) => {
      if (result.ok) await writeCachedRoutines(result.items);
    }),
    fetchRules(pairing).then(async (result) => {
      if (result.ok) await writeCachedRules(result.items);
    }),
    fetchCheckins(pairing).then(async (result) => {
      if (result.ok) await writeCachedCheckins(result.items);
    }),
  ]);
}

/**
 * Seed the cache for `pairing` if the per-token idempotency flag does not
 * already record a completed seed for the same token hash. Concurrent calls
 * for the same token hash coalesce — the first call owns the work, the
 * second awaits the same promise.
 */
export async function runCacheSeed(pairing: Pairing): Promise<void> {
  const tokenHash = await computeTokenHash(pairing.token);
  const seedFor = await loadSeedCompleteFor();
  if (seedFor === tokenHash) return;

  const existing = inFlight.get(tokenHash);
  if (existing) {
    await existing;
    return;
  }

  const work = (async (): Promise<void> => {
    setStatus('seeding');
    try {
      await seedSurfaces(pairing);
      await markSeedComplete(tokenHash);
    } finally {
      inFlight.delete(tokenHash);
      if (inFlight.size === 0) setStatus('idle');
    }
  })();
  inFlight.set(tokenHash, work);
  await work;
}

/**
 * Subscribe to pairing-complete events and run the cache seed when a pairing
 * is present. Idempotent on remount; the per-token flag short-circuits any
 * redundant work.
 *
 * Returns the current seeding status (`'idle'` or `'seeding'`) so consumers
 * can render UI off the same state surface the overlay reads.
 */
export function useCacheSeed(): CacheSeedStatus {
  const status = useSyncExternalStore<CacheSeedStatus>(
    subscribeCacheSeedState,
    getCacheSeedStatus,
    getCacheSeedStatus,
  );

  useEffect(() => {
    let cancelled = false;

    void loadPairing().then((pairing) => {
      if (cancelled || !pairing) return;
      void runCacheSeed(pairing);
    });
    const unsubscribe = subscribePairing((pairing) => {
      if (pairing) void runCacheSeed(pairing);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}

export function __resetCacheSeedForTests(): void {
  listeners.clear();
  currentStatus = 'idle';
  inFlight.clear();
}
