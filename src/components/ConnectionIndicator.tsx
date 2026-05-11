import { useEffect, useState } from 'react';
import { loadPairing, subscribePairing, type Pairing } from '../lib/pairing';
import { useConnectionState } from '../lib/connection/useConnectionState';
import type { ConnectionStatus } from '../lib/connection/types';

interface ConnectionIndicatorProps {
  slot?: string;
}

interface Visual {
  label: string;
  dotColor: string;
  pulse: boolean;
}

/**
 * Visual map for the [2C-27] tri-state extension (technically four states —
 * `syncing` shares the green hue of `connected` and adds a pulse per Pass 5
 * Summary Escalation 5). Colors follow the v2.0.0 palette: green for healthy,
 * amber for degraded, gray for offline.
 */
const VISUAL: Record<ConnectionStatus, Visual> = {
  connected: { label: 'Connected', dotColor: '#22C55E', pulse: false },
  syncing: { label: 'Syncing', dotColor: '#22C55E', pulse: true },
  degraded: { label: 'Degraded', dotColor: '#F59E0B', pulse: false },
  offline: { label: 'Offline', dotColor: '#9CA3AF', pulse: false },
};

/**
 * Passive connection-status chrome element. Reads the derived state from
 * [2C-27]'s `useConnectionState` and renders an 8 px dot + label. Intentionally
 * hides when the app is unpaired — a standalone gray dot on Settings would be
 * misleading. Per [2C-13] and extended in [2C-27].
 */
const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({ slot }) => {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { status } = useConnectionState();

  useEffect(() => {
    let cancelled = false;
    loadPairing().then((value) => {
      if (cancelled) return;
      setPairing(value);
      setLoaded(true);
    });
    const unsubscribe = subscribePairing((value) => {
      setPairing(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!loaded || pairing === null) {
    return null;
  }

  const { label, dotColor, pulse } = VISUAL[status];

  return (
    <div
      slot={slot}
      role="status"
      aria-label={`Connection status: ${label}`}
      data-connection-status={status}
      className="flex items-center gap-2 px-2"
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '9999px',
          backgroundColor: dotColor,
          animation: pulse ? 'connection-pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      <span className="text-xs">{label}</span>
    </div>
  );
};

export default ConnectionIndicator;
