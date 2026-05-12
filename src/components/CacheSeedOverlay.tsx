/**
 * [2C-31] One-time "Setting up…" overlay shown while the cache seed runs
 * after a fresh pair (or re-pair to a different token). Dismisses on settle
 * regardless of per-fetch success — partial failure is not a blocking state
 * per Pass 5 Summary §3 [2C-31] Scope.
 *
 * Reads the seed status from {@link ../lib/cacheSeed#subscribeCacheSeedState}
 * via `useSyncExternalStore` so the overlay reflects the module-level
 * singleton state without coupling to the runner instance.
 */

import { useSyncExternalStore } from 'react';
import { IonLoading } from '@ionic/react';
import {
  getCacheSeedStatus,
  subscribeCacheSeedState,
  type CacheSeedStatus,
} from '../lib/cacheSeed';

const CacheSeedOverlay: React.FC = () => {
  const status = useSyncExternalStore<CacheSeedStatus>(
    subscribeCacheSeedState,
    getCacheSeedStatus,
    getCacheSeedStatus,
  );

  return (
    <IonLoading
      isOpen={status === 'seeding'}
      message="Setting up…"
      duration={0}
      data-testid="cache-seed-overlay"
    />
  );
};

export default CacheSeedOverlay;
