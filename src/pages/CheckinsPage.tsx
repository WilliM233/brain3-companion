import { useCallback, useEffect, useState } from 'react';
import {
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonText,
  IonTitle,
  IonToolbar,
  type RefresherEventDetail,
} from '@ionic/react';
import {
  useQuery,
  type QueryKey,
} from '@tanstack/react-query';
import { useHistory } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import StalenessBanner from '../components/StalenessBanner';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  composeNumericSubtitle,
  fetchCheckins,
  formatRelativeLoggedAt,
  friendlyCheckinTypeLabel,
  readCachedCheckins,
  truncateFreeformPreview,
  writeCachedCheckins,
  type CheckinResponse,
} from '../lib/checkins';

const CHECKINS_QUERY_KEY: QueryKey = ['checkins'];
const CHECKINS_STALE_MS = 5 * 60 * 1000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedItems: CheckinResponse[] | null;
      cachedFetchedAtMs: number | null;
    };

const CheckinsPage: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cached] = await Promise.all([
        loadPairing(),
        readCachedCheckins(),
      ]);
      if (cancelled) return;
      if (!pairing) {
        setBootstrap({ kind: 'no-pairing' });
        return;
      }
      const cachedFetchedAtMs = cached?.fetched_at
        ? Date.parse(cached.fetched_at)
        : null;
      setBootstrap({
        kind: 'paired',
        pairing,
        cachedItems: cached?.items ?? null,
        cachedFetchedAtMs: Number.isFinite(cachedFetchedAtMs)
          ? cachedFetchedAtMs
          : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Check-ins</IonTitle>
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
            <p>Pair the app from Settings to see check-ins.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <CheckinsBody
            pairing={bootstrap.pairing}
            initialCachedItems={bootstrap.cachedItems}
            initialCachedFetchedAtMs={bootstrap.cachedFetchedAtMs}
          />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  pairing: Pairing;
  initialCachedItems: CheckinResponse[] | null;
  initialCachedFetchedAtMs: number | null;
}

const CheckinsBody: React.FC<BodyProps> = ({
  pairing,
  initialCachedItems,
  initialCachedFetchedAtMs,
}) => {
  const history = useHistory();

  const checkinsQuery = useQuery<CheckinResponse[]>({
    queryKey: CHECKINS_QUERY_KEY,
    queryFn: async () => {
      const result = await fetchCheckins(pairing);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedCheckins(result.items);
      return result.items;
    },
    initialData: initialCachedItems ?? undefined,
    initialDataUpdatedAt:
      initialCachedItems !== null && initialCachedFetchedAtMs !== null
        ? initialCachedFetchedAtMs
        : undefined,
    staleTime: CHECKINS_STALE_MS,
    refetchOnWindowFocus: true,
  });

  const items = checkinsQuery.data;

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await checkinsQuery.refetch();
      } finally {
        event.detail.complete();
      }
    },
    [checkinsQuery],
  );

  const onRowClick = useCallback(
    (checkin: CheckinResponse): void => {
      history.push(`/checkins/${checkin.id}`);
    },
    [history],
  );

  return (
    <>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>

      <StalenessBanner />

      {items !== undefined && items.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
          <p>
            No check-ins yet. They appear here when you respond to check-in
            prompts.
          </p>
        </div>
      ) : null}

      {items !== undefined && items.length > 0 ? (
        <IonList>
          {items.map((checkin) => (
            <CheckinRow
              key={checkin.id}
              checkin={checkin}
              onRowClick={onRowClick}
            />
          ))}
        </IonList>
      ) : null}
    </>
  );
};

interface RowProps {
  checkin: CheckinResponse;
  onRowClick: (checkin: CheckinResponse) => void;
}

const CheckinRow: React.FC<RowProps> = ({ checkin, onRowClick }) => {
  const numericSubtitle = composeNumericSubtitle(checkin);
  const notePreview = checkin.freeform_note
    ? truncateFreeformPreview(checkin.freeform_note)
    : null;
  return (
    <IonItem
      button
      onClick={() => onRowClick(checkin)}
      data-testid={`checkin-row-${checkin.id}`}
    >
      <IonLabel className="ion-text-wrap">
        <h2>{friendlyCheckinTypeLabel(checkin.checkin_type)}</h2>
        {numericSubtitle ? (
          <p>
            <IonText color="medium">
              <small>{numericSubtitle}</small>
            </IonText>
          </p>
        ) : null}
        {notePreview ? (
          <p>
            <IonText color="medium">
              <em>{notePreview}</em>
            </IonText>
          </p>
        ) : null}
      </IonLabel>
      <div slot="end" className="flex flex-col items-end">
        <IonNote className="text-xs">
          {formatRelativeLoggedAt(checkin.logged_at)}
        </IonNote>
      </div>
    </IonItem>
  );
};

export default CheckinsPage;
