/**
 * Foreground toast for [2C-29]'s permanent-failure counter.
 *
 * Subscribes to `subscribePermanentFailureToast` and renders a single
 * passive `IonToast` carrying the new-drops count emitted on app
 * foreground. Pre-mounted at the app root so a foreground event during
 * any route can present the toast — the indicator is global, not
 * page-scoped.
 *
 * Per Pass 5 Summary §3 [2C-29] Escalation 3 the surface is intentionally
 * passive (no buttons, no modal). Detail lives in Settings → Pending sync,
 * which [2C-30] adds in Wave 2.
 */

import { useEffect, useState } from 'react';
import { IonToast } from '@ionic/react';
import { subscribePermanentFailureToast } from '../lib/writeQueue';

const TOAST_DURATION_MS = 5_000;

function buildMessage(count: number): string {
  return `${count} pending sync ${count === 1 ? 'item' : 'items'} couldn't be saved. View in Settings → Pending sync.`;
}

const PermanentFailureToast: React.FC = () => {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    return subscribePermanentFailureToast((next) => {
      setCount(next);
    });
  }, []);

  return (
    <IonToast
      isOpen={count !== null}
      message={count !== null ? buildMessage(count) : ''}
      duration={TOAST_DURATION_MS}
      position="bottom"
      onDidDismiss={() => setCount(null)}
    />
  );
};

export default PermanentFailureToast;
