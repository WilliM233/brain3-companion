import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useHistory } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchActiveRoutines,
  readCachedRoutines,
  sortRoutinesByTitle,
  writeCachedRoutines,
  type RoutineFrequency,
  type RoutineResponse,
} from '../lib/routines';
import { todayLocalDate } from '../lib/local-date';

const ROUTINES_QUERY_KEY: QueryKey = ['routines', 'active'];
const ROUTINES_STALE_MS = 5 * 60 * 1000;

const FREQUENCY_LABEL: Record<RoutineFrequency, string> = {
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  weekly: 'Weekly',
  custom: 'Custom',
};

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedItems: RoutineResponse[] | null;
      /**
       * Epoch ms of the cache's `fetched_at`, threaded into TanStack Query as
       * `initialDataUpdatedAt`. Without this, initialData is treated as just
       * loaded and the on-mount refetch that hydrates the offline cache hint
       * (and overwrites stale cache) never fires.
       */
      cachedFetchedAtMs: number | null;
    };

const RoutinesPage: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cached] = await Promise.all([
        loadPairing(),
        readCachedRoutines(),
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
          <IonTitle>Routines</IonTitle>
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
            <p>Pair the app from Settings to see routines.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <RoutinesBody
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
  initialCachedItems: RoutineResponse[] | null;
  initialCachedFetchedAtMs: number | null;
}

const RoutinesBody: React.FC<BodyProps> = ({
  pairing,
  initialCachedItems,
  initialCachedFetchedAtMs,
}) => {
  const history = useHistory();

  const routinesQuery = useQuery<RoutineResponse[]>({
    queryKey: ROUTINES_QUERY_KEY,
    queryFn: async () => {
      const result = await fetchActiveRoutines(pairing);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedRoutines(result.items);
      return result.items;
    },
    initialData: initialCachedItems ?? undefined,
    initialDataUpdatedAt:
      initialCachedItems !== null && initialCachedFetchedAtMs !== null
        ? initialCachedFetchedAtMs
        : undefined,
    staleTime: ROUTINES_STALE_MS,
    refetchOnWindowFocus: true,
  });

  const items = routinesQuery.data;
  const showCacheHint =
    routinesQuery.isError && items !== undefined && items.length >= 0;

  const sortedItems = useMemo(
    () => (items ? sortRoutinesByTitle(items) : null),
    [items],
  );

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await routinesQuery.refetch();
      } finally {
        event.detail.complete();
      }
    },
    [routinesQuery],
  );

  const onRowClick = useCallback(
    (routine: RoutineResponse): void => {
      history.push(`/routines/${routine.id}`);
    },
    [history],
  );

  return (
    <>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>

      {showCacheHint ? (
        <div
          className="px-4 pt-3 text-sm text-neutral-300"
          role="status"
          aria-live="polite"
        >
          Showing cached data
        </div>
      ) : null}

      {sortedItems && sortedItems.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
          <p>No routines yet. Create routines via brain3 CLI or API.</p>
        </div>
      ) : null}

      {sortedItems && sortedItems.length > 0 ? (
        <IonList>
          {sortedItems.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              onRowClick={onRowClick}
            />
          ))}
        </IonList>
      ) : null}
    </>
  );
};

interface RowProps {
  routine: RoutineResponse;
  onRowClick: (routine: RoutineResponse) => void;
}

function relativeLastCompleted(lastCompleted: string | null | undefined): string {
  if (lastCompleted === null || lastCompleted === undefined) return 'never';
  try {
    return formatDistanceToNowStrict(parseISO(lastCompleted), {
      addSuffix: true,
    });
  } catch {
    return lastCompleted;
  }
}

interface PillProps {
  done: boolean;
  routineId: string;
}

const TodayPill: React.FC<PillProps> = ({ done, routineId }) => {
  const cls = done
    ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
    : 'bg-neutral-100 text-neutral-700 ring-neutral-300';
  const label = done ? 'Done today' : 'Not yet';
  return (
    <span
      data-testid={`today-pill-${done ? 'done' : 'not-yet'}-${routineId}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {label}
    </span>
  );
};

const RoutineRow: React.FC<RowProps> = ({ routine, onRowClick }) => {
  const today = todayLocalDate();
  const doneToday = routine.last_completed === today;
  const frequencyLabel = routine.frequency
    ? FREQUENCY_LABEL[routine.frequency]
    : null;
  const lastCompletedLabel = relativeLastCompleted(routine.last_completed);

  return (
    <IonItem
      button
      onClick={() => onRowClick(routine)}
      data-testid={`routine-row-${routine.id}`}
    >
      <div slot="start" className="pe-2">
        <TodayPill done={doneToday} routineId={routine.id} />
      </div>
      <IonLabel className="ion-text-wrap">
        <h2>{routine.title}</h2>
        {frequencyLabel ? <p>{frequencyLabel}</p> : null}
        <p data-testid={`routine-streak-${routine.id}`}>
          <IonText color="medium">
            <small>
              Streak: {routine.current_streak ?? 0} · Best:{' '}
              {routine.best_streak ?? 0}
            </small>
          </IonText>
        </p>
      </IonLabel>
      <IonNote slot="end" className="text-xs">
        {lastCompletedLabel}
      </IonNote>
    </IonItem>
  );
};

export default RoutinesPage;
