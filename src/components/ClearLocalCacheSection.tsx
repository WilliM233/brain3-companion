/**
 * [2C-30] Clear-local-cache action at the bottom of Settings.
 *
 * Destructive-actions section: red button + confirm modal + toast. Wipes
 * every `brain.cache.*` Preferences key and clears the TanStack Query
 * cache. Live write-queue keys (`brain.writeQueue*`) survive — pending
 * writes are not touched.
 */

import { useState } from 'react';
import { IonAlert, IonButton, IonText, IonToast } from '@ionic/react';
import { useQueryClient } from '@tanstack/react-query';

import { clearLocalCache } from '../lib/clearLocalCache';

const CONFIRM_MESSAGE =
  'Clear all cached data? Pending sync items are NOT cleared. The app will refetch when online.';
const TOAST_MESSAGE = 'Local cache cleared.';

const ClearLocalCacheSection: React.FC = () => {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    await clearLocalCache(queryClient);
    setToastOpen(true);
  };

  return (
    <section
      aria-label="Destructive actions"
      data-testid="clear-cache-section"
      className="ion-margin-top"
      style={{ marginTop: '2rem' }}
    >
      <IonButton
        expand="block"
        fill="outline"
        color="danger"
        onClick={() => setConfirmOpen(true)}
        data-testid="clear-cache-button"
      >
        <IonText>Clear local cache</IonText>
      </IonButton>

      <IonAlert
        isOpen={confirmOpen}
        header="Clear local cache"
        message={CONFIRM_MESSAGE}
        buttons={[
          {
            text: 'Cancel',
            role: 'cancel',
          },
          {
            text: 'Confirm',
            role: 'destructive',
            handler: () => {
              void handleConfirm();
            },
          },
        ]}
        onDidDismiss={() => setConfirmOpen(false)}
      />

      <IonToast
        isOpen={toastOpen}
        message={TOAST_MESSAGE}
        duration={3000}
        onDidDismiss={() => setToastOpen(false)}
      />
    </section>
  );
};

export default ClearLocalCacheSection;
