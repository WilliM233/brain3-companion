import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonText,
  IonTitle,
  IonToast,
  IonToolbar,
  type RefresherEventDetail,
} from '@ionic/react';
import { checkmarkCircle, checkmarkOutline } from 'ionicons/icons';
import {
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useHistory } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import StatusPill from '../components/StatusPill';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchActiveHabits,
  partitionAndSortHabits,
  readCachedHabits,
  writeCachedHabits,
  type HabitResponse,
} from '../lib/habits';
import { fetchRoutine, type RoutineResponse } from '../lib/routines';
import {
  enqueueHabitCompletion,
  flushAllQueues,
} from '../lib/completionQueues';
import { todayLocalDate } from '../lib/local-date';

const HABITS_QUERY_KEY: QueryKey = ['habits', 'active'];
const ROUTINE_QUERY_KEY = (id: string): QueryKey => ['routine', id];
const HABITS_STALE_MS = 5 * 60 * 1000;
const ROUTINES_STALE_MS = 15 * 60 * 1000;
const PULSE_MS = 2000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedItems: HabitResponse[] | null;
      /**
       * Epoch ms of the cache's `fetched_at`, threaded into TanStack Query as
       * `initialDataUpdatedAt`. Without this, initialData is treated as just
       * loaded and the on-mount refetch that hydrates the offline cache hint
       * (and overwrites stale cache) never fires.
       */
      cachedFetchedAtMs: number | null;
    };

const HabitsPage: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cached] = await Promise.all([
        loadPairing(),
        readCachedHabits(),
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
          <IonTitle>Habits</IonTitle>
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
            <p>Pair the app from Settings to see habits.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <HabitsBody
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
  initialCachedItems: HabitResponse[] | null;
  initialCachedFetchedAtMs: number | null;
}

const HabitsBody: React.FC<BodyProps> = ({
  pairing,
  initialCachedItems,
  initialCachedFetchedAtMs,
}) => {
  const history = useHistory();
  const queryClient = useQueryClient();
  const [streakBoost, setStreakBoost] = useState<Record<string, number>>({});
  const [pulsingIds, setPulsingIds] = useState<Set<string>>(() => new Set());
  const [toastOpen, setToastOpen] = useState(false);

  const habitsQuery = useQuery<HabitResponse[]>({
    queryKey: HABITS_QUERY_KEY,
    queryFn: async () => {
      const result = await fetchActiveHabits(pairing);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedHabits(result.items);
      return result.items;
    },
    initialData: initialCachedItems ?? undefined,
    initialDataUpdatedAt:
      initialCachedItems !== null && initialCachedFetchedAtMs !== null
        ? initialCachedFetchedAtMs
        : undefined,
    staleTime: HABITS_STALE_MS,
    refetchOnWindowFocus: true,
  });

  const items = habitsQuery.data;
  const showCacheHint =
    habitsQuery.isError && items !== undefined && items.length >= 0;

  const partitioned = useMemo(
    () => (items ? partitionAndSortHabits(items) : null),
    [items],
  );

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await habitsQuery.refetch();
      } finally {
        event.detail.complete();
      }
    },
    [habitsQuery],
  );

  const onRowClick = useCallback(
    (habit: HabitResponse): void => {
      history.push(`/habits/${habit.id}`);
    },
    [history],
  );

  const onQuickComplete = useCallback(
    async (habit: HabitResponse): Promise<void> => {
      const today = todayLocalDate();
      const willIncrement = habit.last_completed !== today;

      // Optimistic flip: pulsing check icon for PULSE_MS, streak +1 if applicable.
      setPulsingIds((prev) => {
        const next = new Set(prev);
        next.add(habit.id);
        return next;
      });
      if (willIncrement) {
        setStreakBoost((prev) => ({ ...prev, [habit.id]: 1 }));
      }
      window.setTimeout(() => {
        setPulsingIds((prev) => {
          if (!prev.has(habit.id)) return prev;
          const next = new Set(prev);
          next.delete(habit.id);
          return next;
        });
      }, PULSE_MS);

      await enqueueHabitCompletion({
        habit_id: habit.id,
        completed_date: today,
        notes: null,
        enqueued_at: new Date().toISOString(),
      });

      const summary = await flushAllQueues();
      const habitFlush = summary.habitCompletions;

      if (habitFlush.delivered > 0) {
        await queryClient.invalidateQueries({ queryKey: HABITS_QUERY_KEY });
        setStreakBoost((prev) => {
          if (!(habit.id in prev)) return prev;
          const next = { ...prev };
          delete next[habit.id];
          return next;
        });
      } else if (
        !habitFlush.coalesced &&
        habitFlush.attempted > 0 &&
        habitFlush.delivered === 0
      ) {
        // Attempted but didn't deliver — transient stop. Surface retry toast;
        // the queue retains the entry and will retry on next foreground/online.
        setToastOpen(true);
      }
    },
    [queryClient],
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

      {partitioned &&
      partitioned.primary.length === 0 &&
      partitioned.graduated.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
          <p>No habits yet. Create habits via brain3 CLI or API.</p>
        </div>
      ) : null}

      {partitioned && partitioned.primary.length > 0 ? (
        <IonList>
          {partitioned.primary.map((habit) => (
            <HabitRow
              key={habit.id}
              habit={habit}
              pairing={pairing}
              optimisticBoost={streakBoost[habit.id] ?? 0}
              pulsing={pulsingIds.has(habit.id)}
              onRowClick={onRowClick}
              onQuickComplete={onQuickComplete}
            />
          ))}
        </IonList>
      ) : null}

      {partitioned && partitioned.graduated.length > 0 ? (
        <IonList className="opacity-70">
          <IonListHeader>
            <IonLabel>Graduated</IonLabel>
          </IonListHeader>
          {partitioned.graduated.map((habit) => (
            <HabitRow
              key={habit.id}
              habit={habit}
              pairing={pairing}
              optimisticBoost={0}
              pulsing={pulsingIds.has(habit.id)}
              quiet
              onRowClick={onRowClick}
              onQuickComplete={onQuickComplete}
            />
          ))}
        </IonList>
      ) : null}

      <IonToast
        isOpen={toastOpen}
        message="Queued — will retry"
        duration={3000}
        onDidDismiss={() => setToastOpen(false)}
      />
    </>
  );
};

interface RowProps {
  habit: HabitResponse;
  pairing: Pairing;
  optimisticBoost: number;
  pulsing: boolean;
  quiet?: boolean;
  onRowClick: (habit: HabitResponse) => void;
  onQuickComplete: (habit: HabitResponse) => void;
}

function relativeLastCompleted(lastCompleted: string | null): string {
  if (lastCompleted === null) return 'never';
  try {
    return formatDistanceToNowStrict(parseISO(lastCompleted), {
      addSuffix: true,
    });
  } catch {
    return lastCompleted;
  }
}

const HabitRow: React.FC<RowProps> = ({
  habit,
  pairing,
  optimisticBoost,
  pulsing,
  quiet,
  onRowClick,
  onQuickComplete,
}) => {
  const routineQuery = useQuery<RoutineResponse | null>({
    queryKey: ROUTINE_QUERY_KEY(habit.routine_id ?? '__none__'),
    queryFn: async () => {
      if (!habit.routine_id) return null;
      const result = await fetchRoutine(pairing, habit.routine_id);
      return result.ok ? result.routine : null;
    },
    enabled: habit.routine_id !== null,
    staleTime: ROUTINES_STALE_MS,
  });

  const displayedStreak = habit.current_streak + optimisticBoost;
  const lastCompletedLabel =
    habit.last_completed === null
      ? 'never'
      : `last completed: ${relativeLastCompleted(habit.last_completed)}`;

  const subtitleParts: string[] = [];
  if (habit.frequency) subtitleParts.push(habit.frequency);
  if (habit.routine_id && routineQuery.data?.title) {
    subtitleParts.push(`Part of: ${routineQuery.data.title}`);
  }

  return (
    <IonItem
      button
      onClick={() => onRowClick(habit)}
      data-testid={`habit-row-${habit.id}`}
    >
      <div slot="start" className="pe-2">
        <StatusPill status={habit.scaffolding_status} />
      </div>
      <IonLabel className={`ion-text-wrap ${quiet ? 'text-sm' : ''}`}>
        <h2>{habit.title}</h2>
        {subtitleParts.length > 0 ? <p>{subtitleParts.join(' · ')}</p> : null}
        {!quiet ? (
          <p data-testid={`habit-streak-${habit.id}`}>
            <IonText color="medium">
              <small>
                Streak: {displayedStreak} · Best: {habit.best_streak}
              </small>
            </IonText>
          </p>
        ) : null}
      </IonLabel>
      <div slot="end" className="flex flex-col items-end gap-1">
        <IonButton
          fill="clear"
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            void onQuickComplete(habit);
          }}
          aria-label={`Mark ${habit.title} complete`}
          data-testid={`habit-quick-complete-${habit.id}`}
        >
          <IonIcon
            slot="icon-only"
            icon={pulsing ? checkmarkCircle : checkmarkOutline}
            color={pulsing ? 'success' : 'medium'}
          />
        </IonButton>
        <IonNote className="text-xs">{lastCompletedLabel}</IonNote>
      </div>
    </IonItem>
  );
};

export default HabitsPage;
