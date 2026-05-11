/**
 * Read-side surface of the [2C-27] connection state — the `useConnectionState`
 * hook plus a `ConnectionStateContext` for components that prefer
 * `useContext` over `useSyncExternalStore`. Both read from the same
 * module-level store, so multiple consumers stay coherent.
 *
 * `ConnectionStateProvider` (`./ConnectionStateProvider.tsx`) is mounted once
 * at the app root and wires the Capacitor Network plugin, the TanStack Query
 * cache, and the write-queue flush emitter into the store. Components inside
 * the provider receive the derived state via Context; the hook also works
 * outside the provider (it falls through to `useSyncExternalStore` on the
 * singleton store) so test renderers can omit the wrapper when the listener
 * wiring isn't under test.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  deriveConnectionState,
  getSnapshot,
  subscribe,
  type ConnectionSnapshot,
} from './store';
import type { ConnectionState } from './types';

export const ConnectionStateContext = createContext<ConnectionState | null>(
  null,
);

/**
 * React hook returning the current `ConnectionState`. Re-renders on every
 * underlying store transition (network change, query success/error, flush
 * start/end, pulse expiry, staleness expiry). Inside `ConnectionStateProvider`
 * the value is read from Context; outside, it falls back to a direct
 * subscription to the store so the hook works in isolated component tests.
 */
export function useConnectionState(): ConnectionState {
  const fromContext = useContext(ConnectionStateContext);
  const snapshot = useSyncExternalStore<ConnectionSnapshot>(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  if (fromContext !== null) return fromContext;
  return deriveConnectionState(snapshot, Date.now());
}
