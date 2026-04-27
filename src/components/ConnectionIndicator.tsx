import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadPairing, subscribePairing, type Pairing } from '../lib/pairing';
import { pingHealth, type HealthResult } from '../lib/health';

interface ConnectionIndicatorProps {
  slot?: string;
}

/**
 * Passive connection-status chrome element. Renders an 8px dot + label and
 * refreshes via TanStack Query's own interval (5 min) + window-focus +
 * online-event hooks. Intentionally hides when the app is unpaired — a
 * standalone gray dot on Settings would be misleading. Per [2C-13].
 */
const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({ slot }) => {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  const { data } = useQuery<HealthResult>({
    queryKey: ['health', pairing?.url ?? null],
    queryFn: () => {
      // queryFn only runs when enabled, so pairing is non-null here.
      const current = pairing as Pairing;
      return pingHealth(current.url, current.token);
    },
    enabled: pairing !== null,
    staleTime: 4.5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  if (!loaded || pairing === null) {
    return null;
  }

  const connected = data?.ok === true;
  const label = connected ? 'Connected' : 'Disconnected';
  const dotColor = connected ? '#22C55E' : '#9CA3AF';

  return (
    <div
      slot={slot}
      role="status"
      aria-label={`Connection status: ${label}`}
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
        }}
      />
      <span className="text-xs">{label}</span>
    </div>
  );
};

export default ConnectionIndicator;
