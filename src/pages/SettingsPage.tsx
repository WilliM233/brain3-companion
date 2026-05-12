import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import {
  IonAlert,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonNote,
  IonPage,
  IonText,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/react';
import { eye, eyeOff } from 'ionicons/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  clearPairing,
  computeTokenHash,
  loadPairing,
  loadPreviousPairingUrl,
  loadStoredTokenHash,
  savePairing,
  type Pairing,
} from '../lib/pairing';
import { pingHealth } from '../lib/health';
import {
  getRegistrationStatus,
  reRegisterDevice,
  subscribeRegistration,
  type RegistrationStatus,
} from '../lib/device-registration';
import { wipeCacheAndQueueForPairingChange } from '../lib/cacheWipe';
import ConnectionIndicator from '../components/ConnectionIndicator';
import PendingSyncSection from '../components/PendingSyncSection';
import ClearLocalCacheSection from '../components/ClearLocalCacheSection';

const WIPE_CONFIRM_MESSAGE =
  'This will clear all cached data and any pending sync items from the previous pairing. Continue?';

const MIN_TOKEN_LENGTH = 8;

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function maskToken(token: string): string {
  return `****${token.slice(-4)}`;
}

function fcmTokenPreview(status: RegistrationStatus): string {
  if (status.kind === 'registered') {
    return `…${status.fcmToken.slice(-8)}`;
  }
  if (status.kind === 'pending') return 'Registering…';
  if (status.kind === 'permission_denied') return 'Push permission denied';
  return 'Not registered';
}

const SettingsPage: React.FC = () => {
  const history = useHistory();
  const queryClient = useQueryClient();
  const [storedPairing, setStoredPairing] = useState<Pairing | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registration, setRegistration] = useState<RegistrationStatus>(
    getRegistrationStatus(),
  );
  /**
   * [2C-31] Set when pingHealth succeeds for a token+URL combination that
   * differs from the markers persisted by the previous pairing. The
   * confirmation modal renders off this state; commit (savePairing + wipe)
   * runs from the `Continue` handler so cancel leaves the previous pairing
   * intact.
   */
  const [pendingWipe, setPendingWipe] = useState<Pairing | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPairing().then((pairing) => {
      if (cancelled) return;
      setStoredPairing(pairing);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeRegistration((status) => setRegistration(status));
  }, []);

  const handleReRegister = () => {
    void reRegisterDevice();
  };

  const trimmedUrl = url.trim();
  const trimmedToken = token.trim();
  const urlValid = trimmedUrl.length > 0 && isValidUrl(trimmedUrl);
  const tokenValid = trimmedToken.length >= MIN_TOKEN_LENGTH;
  const canConnect = urlValid && tokenValid && !submitting;

  const handleUrlBlur = () => {
    if (trimmedUrl.length === 0) {
      setUrlError(null);
      return;
    }
    setUrlError(isValidUrl(trimmedUrl) ? null : 'Enter a valid http:// or https:// URL');
  };

  const handleTokenBlur = () => {
    if (trimmedToken.length === 0) {
      setTokenError(null);
      return;
    }
    setTokenError(
      trimmedToken.length < MIN_TOKEN_LENGTH
        ? `Token must be at least ${MIN_TOKEN_LENGTH} characters`
        : null,
    );
  };

  const commitPairing = async (
    nextUrl: string,
    nextToken: string,
  ): Promise<void> => {
    await savePairing(nextUrl, nextToken);
    setToastMessage('Connected to BRAIN');
    history.replace('/notifications');
  };

  const handleConnect = async () => {
    if (!canConnect) return;
    setSubmitting(true);
    setUrlError(null);
    setTokenError(null);
    setFormError(null);
    try {
      const result = await pingHealth(trimmedUrl, trimmedToken);
      if (result.ok) {
        // [2C-31] Wipe-on-token-change: gate on successful validation. An
        // invalid-token typo never reaches this branch, so the previous
        // pairing's cache + queue survive a failed pingHealth (MV step 3).
        const [storedHash, previousUrl] = await Promise.all([
          loadStoredTokenHash(),
          loadPreviousPairingUrl(),
        ]);
        const newHash = await computeTokenHash(trimmedToken);
        const isPairingChange =
          storedHash !== null &&
          (newHash !== storedHash || trimmedUrl !== previousUrl);
        if (isPairingChange) {
          setPendingWipe({ url: trimmedUrl, token: trimmedToken });
          return;
        }
        await commitPairing(trimmedUrl, trimmedToken);
        return;
      }
      switch (result.reason) {
        case 'unauthorized':
          setTokenError('Token invalid. Check and try again.');
          break;
        case 'network':
        case 'timeout':
          setFormError("Couldn't reach server. Check URL and network.");
          break;
        case 'server':
          setFormError(
            `Server returned an error (${result.statusCode ?? 'unknown'}). Try again in a moment.`,
          );
          break;
      }
    } catch {
      setToastMessage('Could not save pairing. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWipeConfirm = async (): Promise<void> => {
    if (!pendingWipe) return;
    const target = pendingWipe;
    setPendingWipe(null);
    try {
      await wipeCacheAndQueueForPairingChange(queryClient);
      await commitPairing(target.url, target.token);
    } catch {
      setToastMessage('Could not save pairing. Try again.');
    }
  };

  const handleWipeCancel = (): void => {
    setPendingWipe(null);
  };

  const handleRepair = async () => {
    await clearPairing();
    setStoredPairing(null);
    setUrl('');
    setToken('');
    setShowToken(false);
    setUrlError(null);
    setTokenError(null);
    setFormError(null);
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Settings</IonTitle>
          <ConnectionIndicator slot="end" />
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen className="ion-padding">
        {!loaded ? null : storedPairing ? (
          <section aria-label="Pairing">
            <IonItem>
              <IonLabel>
                <h2>Server URL</h2>
                <IonText color="medium">
                  <p>{storedPairing.url}</p>
                </IonText>
              </IonLabel>
            </IonItem>
            <IonItem>
              <IonLabel>
                <h2>Bearer Token</h2>
                <IonText color="medium">
                  <p>{maskToken(storedPairing.token)}</p>
                </IonText>
              </IonLabel>
            </IonItem>
            <IonButton
              expand="block"
              color="medium"
              className="ion-margin-top"
              onClick={handleRepair}
            >
              Re-pair
            </IonButton>

            <section
              aria-label="Device"
              className="ion-margin-top"
            >
              <IonItem>
                <IonLabel>
                  <h2>Device</h2>
                  <IonText color="medium">
                    <p>{fcmTokenPreview(registration)}</p>
                  </IonText>
                  {registration.kind === 'error' ? (
                    <IonText color="danger" role="alert">
                      <p>Device registration failed — pull to retry</p>
                    </IonText>
                  ) : null}
                  {registration.kind === 'permission_denied' ? (
                    <IonText color="warning">
                      <p>
                        Push permission denied. Enable notifications in system
                        settings, then tap Re-register.
                      </p>
                    </IonText>
                  ) : null}
                </IonLabel>
              </IonItem>
              <IonButton
                expand="block"
                fill="outline"
                color="medium"
                className="ion-margin-top"
                onClick={handleReRegister}
              >
                Re-register
              </IonButton>
            </section>

            <PendingSyncSection />

            <ClearLocalCacheSection />
          </section>
        ) : (
          <section aria-label="Pairing form">
            <IonItem>
              <IonLabel position="stacked">Server URL</IonLabel>
              <IonInput
                type="url"
                inputMode="url"
                autocapitalize="off"
                spellcheck={false}
                placeholder="https://brain.local:8000"
                value={url}
                onIonInput={(event) => setUrl(event.detail.value ?? '')}
                onIonBlur={handleUrlBlur}
              />
            </IonItem>
            {urlError ? (
              <IonNote color="danger" className="ion-padding-start">
                {urlError}
              </IonNote>
            ) : null}

            <IonItem>
              <IonLabel position="stacked">Bearer Token</IonLabel>
              <IonInput
                type={showToken ? 'text' : 'password'}
                placeholder="Paste token from brain3 token generate"
                value={token}
                onIonInput={(event) => setToken(event.detail.value ?? '')}
                onIonBlur={handleTokenBlur}
              />
              <IonButton
                slot="end"
                fill="clear"
                size="small"
                onClick={() => setShowToken((value) => !value)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                <IonIcon icon={showToken ? eyeOff : eye} />
              </IonButton>
            </IonItem>
            {tokenError ? (
              <IonNote color="danger" className="ion-padding-start">
                {tokenError}
              </IonNote>
            ) : null}

            {formError ? (
              <IonNote
                color="danger"
                className="ion-padding-start"
                role="alert"
              >
                {formError}
              </IonNote>
            ) : null}

            <IonButton
              expand="block"
              className="ion-margin-top"
              disabled={!canConnect}
              onClick={handleConnect}
            >
              Connect
            </IonButton>
          </section>
        )}

        <IonToast
          isOpen={toastMessage !== null}
          message={toastMessage ?? ''}
          duration={4000}
          onDidDismiss={() => setToastMessage(null)}
        />

        <IonAlert
          isOpen={pendingWipe !== null}
          header="Clear data from previous pairing?"
          message={WIPE_CONFIRM_MESSAGE}
          buttons={[
            {
              text: 'Cancel',
              role: 'cancel',
              handler: handleWipeCancel,
            },
            {
              text: 'Continue',
              role: 'destructive',
              handler: () => {
                void handleWipeConfirm();
              },
            },
          ]}
          onDidDismiss={() => {
            if (pendingWipe !== null) setPendingWipe(null);
            setSubmitting(false);
          }}
          data-testid="wipe-confirm-modal"
        />
      </IonContent>
    </IonPage>
  );
};

export default SettingsPage;
