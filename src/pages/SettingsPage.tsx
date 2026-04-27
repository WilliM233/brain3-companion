import { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import {
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
import {
  clearPairing,
  loadPairing,
  savePairing,
  type Pairing,
} from '../lib/pairing';
import { pingHealth } from '../lib/health';
import ConnectionIndicator from '../components/ConnectionIndicator';

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

const SettingsPage: React.FC = () => {
  const history = useHistory();
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

  const handleConnect = async () => {
    if (!canConnect) return;
    setSubmitting(true);
    setUrlError(null);
    setTokenError(null);
    setFormError(null);
    try {
      const result = await pingHealth(trimmedUrl, trimmedToken);
      if (result.ok) {
        await savePairing(trimmedUrl, trimmedToken);
        setToastMessage('Connected to BRAIN');
        history.replace('/paired-placeholder');
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

        {/* Device section — [2C-08] anchor: render FCM token preview + Re-register button here. */}
        <IonItem className="ion-margin-top" aria-label="Device section placeholder" />

        <IonToast
          isOpen={toastMessage !== null}
          message={toastMessage ?? ''}
          duration={4000}
          onDidDismiss={() => setToastMessage(null)}
        />
      </IonContent>
    </IonPage>
  );
};

export default SettingsPage;
