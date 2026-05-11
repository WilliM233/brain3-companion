/**
 * Mounts the [2C-27] connection-state listener stack once at the app root and
 * exposes the derived `ConnectionState` to descendants via Context.
 *
 * Listener wiring (all owned by this provider):
 *
 * 1. **Capacitor Network plugin.** Seeded with `Network.getStatus()` on mount;
 *    `networkStatusChange` events thereafter. Single subscription regardless
 *    of how many components read the hook — the store is a module-level
 *    singleton.
 * 2. **TanStack Query cache.** `queryClient.getQueryCache().subscribe()` —
 *    the `'updated'` notify events with `action.type === 'success' | 'error'`
 *    feed the rolling outcome window and update `lastSuccessAt`.
 * 3. **Write-queue flush state.** Subscribes to the `writeQueueFlushState`
 *    emitter so the indicator pulses `syncing` while [2C-29] is draining the
 *    queue.
 *
 * The provider re-derives the state via `useSyncExternalStore` on every
 * snapshot transition and provides it to descendants. Consumers can use
 * `useConnectionState` to read.
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Network } from '@capacitor/network';
import { useQueryClient } from '@tanstack/react-query';
import { classifyError } from './classifyError';
import {
  deriveConnectionState,
  getSnapshot,
  recordOutcome,
  setFlushing,
  setNetworkOnline,
  subscribe,
  type ConnectionSnapshot,
} from './store';
import {
  getFlushState,
  subscribeFlushState,
} from './writeQueueFlushState';
import { ConnectionStateContext } from './useConnectionState';

export const ConnectionStateProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore<ConnectionSnapshot>(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  useEffect(() => {
    let cancelled = false;
    let handle: { remove: () => void } | null = null;

    void Network.getStatus()
      .then((status) => {
        if (cancelled) return;
        setNetworkOnline(status.connected);
      })
      .catch(() => {
        // Plugin unavailable (web preview without the polyfill, etc.) —
        // leave `networkOnline` at its optimistic default so the indicator
        // does not paint offline on startup.
      });

    void Network.addListener('networkStatusChange', (status) => {
      setNetworkOnline(status.connected);
    }).then((listenerHandle) => {
      if (cancelled) {
        listenerHandle.remove();
        return;
      }
      handle = listenerHandle;
    });

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== 'updated') return;
      const action = event.action;
      if (action.type === 'success') {
        recordOutcome('success', event.query.queryKey);
      } else if (action.type === 'error') {
        recordOutcome(classifyError(action.error), event.query.queryKey);
      }
    });
    return unsubscribe;
  }, [queryClient]);

  useEffect(() => {
    // Sync to the current flush state on mount in case [2C-29] emitted before
    // the provider mounted (unlikely under normal startup ordering, but safe).
    setFlushing(getFlushState() === 'flushing');
    const unsubscribe = subscribeFlushState((state) => {
      setFlushing(state === 'flushing');
    });
    return unsubscribe;
  }, []);

  const value = deriveConnectionState(snapshot, Date.now());

  return (
    <ConnectionStateContext.Provider value={value}>
      {children}
    </ConnectionStateContext.Provider>
  );
};
