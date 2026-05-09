import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { useEffect, useState } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { useParams } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchCheckin,
  friendlyCheckinTypeLabel,
  type CheckinResponse,
} from '../lib/checkins';

const CHECKIN_QUERY_KEY = (id: string): QueryKey => ['checkin', id];
const STALE_MS = 5 * 60 * 1000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | { kind: 'paired'; pairing: Pairing };

function formatLoggedAt(iso: string): string {
  try {
    return format(parseISO(iso), "EEE, MMM d 'at' h:mm a");
  } catch {
    return iso;
  }
}

const CheckinDetailPage: React.FC = () => {
  const { checkinId } = useParams<{ checkinId: string }>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pairing = await loadPairing();
      if (cancelled) return;
      if (!pairing) {
        setBootstrap({ kind: 'no-pairing' });
        return;
      }
      setBootstrap({ kind: 'paired', pairing });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/checkins" />
          </IonButtons>
          <IonTitle>Check-in</IonTitle>
          <ConnectionIndicator slot="end" />
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        {bootstrap.kind === 'loading' ? (
          <div className="flex h-full w-full items-center justify-center text-neutral-300">
            <p>Loading…</p>
          </div>
        ) : null}

        {bootstrap.kind === 'no-pairing' ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
            <p>Pair the app from Settings to view this check-in.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <CheckinDetailBody pairing={bootstrap.pairing} checkinId={checkinId} />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  pairing: Pairing;
  checkinId: string;
}

const CheckinDetailBody: React.FC<BodyProps> = ({ pairing, checkinId }) => {
  const checkinQuery = useQuery<CheckinResponse>({
    queryKey: CHECKIN_QUERY_KEY(checkinId),
    queryFn: async () => {
      const result = await fetchCheckin(pairing, checkinId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      return result.checkin;
    },
    staleTime: STALE_MS,
  });

  if (checkinQuery.isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center text-neutral-300">
        <p>Loading…</p>
      </div>
    );
  }

  if (checkinQuery.isError) {
    const message =
      (checkinQuery.error as Error | undefined)?.message === 'not_found'
        ? "Check-in not found."
        : "Couldn't load check-in.";
    return (
      <div
        className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-200"
        role="alert"
      >
        <p>{message}</p>
      </div>
    );
  }

  const checkin = checkinQuery.data;

  return (
    <div className="px-4 pt-4">
      <h1 className="text-2xl text-neutral-100">
        {friendlyCheckinTypeLabel(checkin.checkin_type)}
      </h1>
      <p className="pt-1">
        <IonText color="medium">
          <small>{formatLoggedAt(checkin.logged_at)}</small>
        </IonText>
      </p>

      <IonList className="ion-margin-top">
        {checkin.context !== null ? (
          <IonItem lines="full">
            <IonLabel>
              <IonNote>Context</IonNote>
              <p>{checkin.context}</p>
            </IonLabel>
          </IonItem>
        ) : null}

        {checkin.energy_level !== null ? (
          <IonItem lines="full">
            <IonLabel>
              <IonNote>Energy</IonNote>
              <p data-testid="checkin-detail-energy">
                {checkin.energy_level} / 5
              </p>
            </IonLabel>
          </IonItem>
        ) : null}

        {checkin.focus_level !== null ? (
          <IonItem lines="full">
            <IonLabel>
              <IonNote>Focus</IonNote>
              <p data-testid="checkin-detail-focus">
                {checkin.focus_level} / 5
              </p>
            </IonLabel>
          </IonItem>
        ) : null}

        {checkin.mood !== null ? (
          <IonItem lines="full">
            <IonLabel>
              <IonNote>Mood</IonNote>
              <p data-testid="checkin-detail-mood">{checkin.mood} / 5</p>
            </IonLabel>
          </IonItem>
        ) : null}
      </IonList>

      {checkin.freeform_note ? (
        <div className="ion-margin-top px-1">
          <IonText color="medium">
            <small>Note</small>
          </IonText>
          <p
            className="whitespace-pre-wrap pt-1 text-neutral-100"
            data-testid="checkin-detail-note"
          >
            {checkin.freeform_note}
          </p>
        </div>
      ) : null}
    </div>
  );
};

export default CheckinDetailPage;
