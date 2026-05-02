import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonFooter,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonText,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToolbar,
  type RefresherEventDetail,
} from '@ionic/react';
import {
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useHistory, useParams } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchRoutineDetail,
  readCachedRoutineDetail,
  writeCachedRoutineDetail,
  type RoutineDetailResponse,
  type RoutineFrequency,
  type RoutineScheduleResponse,
} from '../lib/routines';
import {
  fetchActiveHabitsByRoutine,
  readCachedHabitsByRoutine,
  writeCachedHabitsByRoutine,
  type HabitResponse,
} from '../lib/habits';
import {
  enqueueRoutineCompletion,
  flushAllQueues,
  subscribeRoutineCompletionWarnings,
  type RoutineChildHabitCompletion,
  type RoutineCompletionStatus,
  type RoutineCompletionWarning,
} from '../lib/completionQueues';
import { todayLocalDate } from '../lib/local-date';

const ROUTINE_QUERY_KEY = (id: string): QueryKey => ['routine', id];
const HABITS_BY_ROUTINE_QUERY_KEY = (id: string): QueryKey => [
  'habits',
  'by-routine',
  id,
];
const ROUTINES_LIST_QUERY_KEY: QueryKey = ['routines', 'active'];
const STALE_MS = 5 * 60 * 1000;
const ACTION_DISABLE_MS = 2000;
const FREEFORM_NOTE_MAX = 5000;

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
      cachedRoutine: RoutineDetailResponse | null;
      cachedRoutineFetchedAtMs: number | null;
      cachedHabits: HabitResponse[] | null;
      cachedHabitsFetchedAtMs: number | null;
    };

const RoutineDetailPage: React.FC = () => {
  const { routineId } = useParams<{ routineId: string }>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cachedRoutine, cachedHabits] = await Promise.all([
        loadPairing(),
        readCachedRoutineDetail(routineId),
        readCachedHabitsByRoutine(routineId),
      ]);
      if (cancelled) return;
      if (!pairing) {
        setBootstrap({ kind: 'no-pairing' });
        return;
      }
      const routineMs = cachedRoutine?.fetched_at
        ? Date.parse(cachedRoutine.fetched_at)
        : NaN;
      const habitsMs = cachedHabits?.fetched_at
        ? Date.parse(cachedHabits.fetched_at)
        : NaN;
      setBootstrap({
        kind: 'paired',
        pairing,
        cachedRoutine: cachedRoutine?.routine ?? null,
        cachedRoutineFetchedAtMs: Number.isFinite(routineMs) ? routineMs : null,
        cachedHabits: cachedHabits?.items ?? null,
        cachedHabitsFetchedAtMs: Number.isFinite(habitsMs) ? habitsMs : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [routineId]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/routines" />
          </IonButtons>
          <IonTitle>Routine</IonTitle>
          <ConnectionIndicator slot="end" />
        </IonToolbar>
      </IonHeader>

      {bootstrap.kind === 'loading' ? (
        <IonContent fullscreen>
          <div className="flex h-full w-full items-center justify-center text-neutral-300">
            <p>Loading…</p>
          </div>
        </IonContent>
      ) : null}

      {bootstrap.kind === 'no-pairing' ? (
        <IonContent fullscreen>
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
            <p>Pair the app from Settings to see this routine.</p>
          </div>
        </IonContent>
      ) : null}

      {bootstrap.kind === 'paired' ? (
        <DetailBody
          routineId={routineId}
          pairing={bootstrap.pairing}
          initialRoutine={bootstrap.cachedRoutine}
          initialRoutineFetchedAtMs={bootstrap.cachedRoutineFetchedAtMs}
          initialHabits={bootstrap.cachedHabits}
          initialHabitsFetchedAtMs={bootstrap.cachedHabitsFetchedAtMs}
        />
      ) : null}
    </IonPage>
  );
};

interface BodyProps {
  routineId: string;
  pairing: Pairing;
  initialRoutine: RoutineDetailResponse | null;
  initialRoutineFetchedAtMs: number | null;
  initialHabits: HabitResponse[] | null;
  initialHabitsFetchedAtMs: number | null;
}

interface ToastState {
  open: boolean;
  message: string;
  color?: 'success' | 'danger' | 'medium';
  duration?: number;
}

const DetailBody: React.FC<BodyProps> = ({
  routineId,
  pairing,
  initialRoutine,
  initialRoutineFetchedAtMs,
  initialHabits,
  initialHabitsFetchedAtMs,
}) => {
  const history = useHistory();
  const queryClient = useQueryClient();
  const today = todayLocalDate();

  const [toast, setToast] = useState<ToastState>({ open: false, message: '' });
  const [actionPending, setActionPending] = useState(false);
  const [freeformNote, setFreeformNote] = useState('');
  const [skippedError, setSkippedError] = useState(false);
  const [checkedHabitIds, setCheckedHabitIds] = useState<
    Record<string, boolean>
  >({});
  const checkedInitialised = useRef(false);
  const noteRef = useRef<HTMLIonTextareaElement | null>(null);

  const routineQuery = useQuery<RoutineDetailResponse>({
    queryKey: ROUTINE_QUERY_KEY(routineId),
    queryFn: async () => {
      const result = await fetchRoutineDetail(pairing, routineId);
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
          notFound: result.reason === 'not_found',
        });
      }
      await writeCachedRoutineDetail(routineId, result.routine);
      return result.routine;
    },
    initialData: initialRoutine ?? undefined,
    initialDataUpdatedAt:
      initialRoutine !== null && initialRoutineFetchedAtMs !== null
        ? initialRoutineFetchedAtMs
        : undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const habitsQuery = useQuery<HabitResponse[]>({
    queryKey: HABITS_BY_ROUTINE_QUERY_KEY(routineId),
    queryFn: async () => {
      const result = await fetchActiveHabitsByRoutine(pairing, routineId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedHabitsByRoutine(routineId, result.items);
      return result.items;
    },
    initialData: initialHabits ?? undefined,
    initialDataUpdatedAt:
      initialHabits !== null && initialHabitsFetchedAtMs !== null
        ? initialHabitsFetchedAtMs
        : undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    enabled: !isNotFoundError(routineQuery.error),
    retry: false,
  });

  const routine = routineQuery.data;
  const habits = habitsQuery.data;

  // Partition habits per spec: active checklist (active + non-graduated) and
  // an informational trailing section (status !== 'active' or
  // scaffolding_status === 'graduated'). The query filters by status=active so
  // the trailing section in practice contains graduated-scaffolding habits.
  const partitioned = useMemo(() => {
    if (!habits) return { active: [] as HabitResponse[], trailing: [] as HabitResponse[] };
    const active: HabitResponse[] = [];
    const trailing: HabitResponse[] = [];
    for (const h of habits) {
      if (h.status === 'active' && h.scaffolding_status !== 'graduated') {
        active.push(h);
      } else {
        trailing.push(h);
      }
    }
    return { active, trailing };
  }, [habits]);

  const isFreeform = (habits?.length ?? 0) === 0;
  const hasUncheckedActive =
    partitioned.active.length > 0 &&
    partitioned.active.some((h) => !checkedHabitIds[h.id]);

  // Initialise checkbox state from each habit's last_completed === today
  // exactly once per habits-load. The user's subsequent toggles are preserved
  // until the page unmounts or habits refetch with new IDs.
  useEffect(() => {
    if (!habits || checkedInitialised.current) return;
    const next: Record<string, boolean> = {};
    for (const h of partitioned.active) {
      next[h.id] = h.last_completed === today;
    }
    setCheckedHabitIds(next);
    checkedInitialised.current = true;
  }, [habits, partitioned.active, today]);

  // Wire the [2C-23] routine-completion warning subscription. Per the close
  // ledger this surface lands in [2C-25] — see PR body Deviation §1.
  useEffect(() => {
    const unsubscribe = subscribeRoutineCompletionWarnings(
      (warning: RoutineCompletionWarning) => {
        if (warning.routine_id !== routineId) return;
        const message =
          warning.kind === 'not_active'
            ? 'Routine is paused — completion was discarded'
            : 'Routine no longer exists — completion was discarded';
        setToast({ open: true, message, color: 'danger', duration: 5000 });
      },
    );
    return () => unsubscribe();
  }, [routineId]);

  const showCacheHint =
    routineQuery.isError &&
    !isNotFoundError(routineQuery.error) &&
    routine !== undefined;

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await Promise.all([routineQuery.refetch(), habitsQuery.refetch()]);
      } finally {
        event.detail.complete();
      }
    },
    [routineQuery, habitsQuery],
  );

  const invalidateAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ROUTINE_QUERY_KEY(routineId),
      }),
      queryClient.invalidateQueries({
        queryKey: HABITS_BY_ROUTINE_QUERY_KEY(routineId),
      }),
      queryClient.invalidateQueries({ queryKey: ROUTINES_LIST_QUERY_KEY }),
    ]);
  }, [queryClient, routineId]);

  // Optimistic streak/last_completed bump per spec. Refetched server values
  // overwrite this once the flush + invalidation completes; if the entry
  // was queued offline, the optimistic update remains visible until the
  // next online refetch.
  const applyOptimisticStreak = useCallback((): void => {
    queryClient.setQueryData<RoutineDetailResponse | undefined>(
      ROUTINE_QUERY_KEY(routineId),
      (prev) => {
        if (!prev) return prev;
        if (prev.last_completed === today) return prev;
        const nextStreak = (prev.current_streak ?? 0) + 1;
        const nextBest = Math.max(prev.best_streak ?? 0, nextStreak);
        return {
          ...prev,
          last_completed: today,
          current_streak: nextStreak,
          best_streak: nextBest,
        };
      },
    );
  }, [queryClient, routineId, today]);

  const beginAction = useCallback((): void => {
    setActionPending(true);
    setTimeout(() => setActionPending(false), ACTION_DISABLE_MS);
  }, []);

  const handleEnqueueResult = useCallback(
    async (delivered: boolean): Promise<void> => {
      await invalidateAll();
      if (delivered) {
        setToast({ open: true, message: 'Routine recorded', color: 'success' });
      } else {
        setToast({
          open: true,
          message: 'Queued — will retry',
          color: 'medium',
        });
      }
    },
    [invalidateAll],
  );

  const onAllDone = useCallback(async (): Promise<void> => {
    if (!routine) return;
    beginAction();
    applyOptimisticStreak();
    await enqueueRoutineCompletion({
      routine_id: routine.id,
      completed_date: today,
      status: 'all_done',
      freeform_note: freeformNote.trim() || null,
      child_habit_completions: null,
      enqueued_at: new Date().toISOString(),
    });
    const summary = await flushAllQueues();
    await handleEnqueueResult(summary.routineCompletions.delivered > 0);
  }, [
    routine,
    today,
    freeformNote,
    beginAction,
    applyOptimisticStreak,
    handleEnqueueResult,
  ]);

  const onPartial = useCallback(async (): Promise<void> => {
    if (!routine) return;
    beginAction();
    applyOptimisticStreak();
    const childCompletions: RoutineChildHabitCompletion[] = partitioned.active
      .filter((h) => checkedHabitIds[h.id])
      .map((h) => ({ habit_id: h.id, completed_date: today }));
    await enqueueRoutineCompletion({
      routine_id: routine.id,
      completed_date: today,
      status: 'partial',
      freeform_note: freeformNote.trim() || null,
      child_habit_completions: childCompletions,
      enqueued_at: new Date().toISOString(),
    });
    const summary = await flushAllQueues();
    await handleEnqueueResult(summary.routineCompletions.delivered > 0);
  }, [
    routine,
    today,
    freeformNote,
    partitioned.active,
    checkedHabitIds,
    beginAction,
    applyOptimisticStreak,
    handleEnqueueResult,
  ]);

  const onSkipped = useCallback(async (): Promise<void> => {
    if (!routine) return;
    if (!freeformNote.trim()) {
      setSkippedError(true);
      const el = noteRef.current as unknown as
        | { setFocus?: () => Promise<void> }
        | null;
      if (el && typeof el.setFocus === 'function') {
        el.setFocus().catch(() => undefined);
      }
      return;
    }
    setSkippedError(false);
    beginAction();
    // Skipped freezes the streak server-side — no optimistic streak bump.
    await enqueueRoutineCompletion({
      routine_id: routine.id,
      completed_date: today,
      status: 'skipped',
      freeform_note: freeformNote.trim(),
      child_habit_completions: null,
      enqueued_at: new Date().toISOString(),
    });
    const summary = await flushAllQueues();
    await handleEnqueueResult(summary.routineCompletions.delivered > 0);
  }, [routine, today, freeformNote, beginAction, handleEnqueueResult]);

  const toggleHabit = useCallback((habitId: string): void => {
    setCheckedHabitIds((prev) => ({ ...prev, [habitId]: !prev[habitId] }));
  }, []);

  if (isNotFoundError(routineQuery.error) && !routine) {
    return (
      <IonContent fullscreen>
        <NotFoundCard onBack={() => history.replace('/routines')} />
      </IonContent>
    );
  }

  if (!routine) {
    return (
      <IonContent fullscreen>
        <div className="flex h-full w-full items-center justify-center text-neutral-300">
          <p>Loading…</p>
        </div>
      </IonContent>
    );
  }

  return (
    <>
      <IonContent fullscreen>
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

        <HeaderPane routine={routine} />

        {isFreeform ? (
          <FreeformChecklistMessage />
        ) : (
          <ChecklistPane
            active={partitioned.active}
            trailing={partitioned.trailing}
            checkedHabitIds={checkedHabitIds}
            onToggleHabit={toggleHabit}
          />
        )}

        <FreeformNotePane
          value={freeformNote}
          onChange={(v) => {
            setFreeformNote(v);
            if (v.trim()) setSkippedError(false);
          }}
          showRequiredError={skippedError}
          textareaRef={noteRef}
        />

        {!isFreeform && hasUncheckedActive ? (
          <div
            className="mx-4 mb-2 mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
            data-testid="routine-all-done-warning"
          >
            All Done marks every habit in the routine complete, even unchecked
            ones. Consider Partial.
          </div>
        ) : null}
      </IonContent>

      <IonFooter>
        <IonToolbar>
          <div
            className="flex flex-col gap-2 px-3 py-2"
            data-testid="routine-action-footer"
          >
            <IonButton
              color="success"
              onClick={onAllDone}
              disabled={actionPending}
              data-testid="routine-all-done-button"
            >
              All done
            </IonButton>
            {!isFreeform ? (
              <IonButton
                color="warning"
                onClick={onPartial}
                disabled={actionPending}
                data-testid="routine-partial-button"
              >
                Partial
              </IonButton>
            ) : null}
            <IonButton
              color="medium"
              onClick={onSkipped}
              disabled={actionPending}
              data-testid="routine-skipped-button"
            >
              Skipped
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>

      <IonToast
        isOpen={toast.open}
        message={toast.message}
        color={toast.color}
        duration={toast.duration ?? 3000}
        onDidDismiss={() => setToast({ open: false, message: '' })}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Header pane
// ---------------------------------------------------------------------------

const HeaderPane: React.FC<{ routine: RoutineDetailResponse }> = ({ routine }) => {
  const lastCompletedLine = useMemo(() => {
    if (routine.last_completed === null || routine.last_completed === undefined) {
      return 'Never completed';
    }
    return `${formatAbsoluteDate(routine.last_completed)} (${formatDistanceToNowStrict(parseISO(routine.last_completed), { addSuffix: true })})`;
  }, [routine.last_completed]);

  const frequencyLabel = routine.frequency
    ? FREQUENCY_LABEL[routine.frequency]
    : null;
  const scheduleSummary = formatScheduleSummary(routine.schedules);

  return (
    <section className="px-4 pt-4" data-testid="routine-header-pane">
      <h1 className="text-xl font-semibold">{routine.title}</h1>
      {routine.description ? (
        <p
          className="mt-2 whitespace-pre-wrap text-sm text-neutral-200"
          data-testid="routine-description"
        >
          {routine.description}
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-1 gap-2 text-sm">
        {frequencyLabel ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Frequency</dt>
            <dd>{frequencyLabel}</dd>
          </div>
        ) : null}
        {scheduleSummary ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Schedule</dt>
            <dd data-testid="routine-schedule-summary">{scheduleSummary}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-neutral-400">Streak</dt>
          <dd data-testid="routine-streak">
            Streak {routine.current_streak ?? 0} · Best{' '}
            {routine.best_streak ?? 0}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-400">Last completed</dt>
          <dd data-testid="routine-last-completed">{lastCompletedLine}</dd>
        </div>
      </dl>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Checklist pane
// ---------------------------------------------------------------------------

interface ChecklistProps {
  active: HabitResponse[];
  trailing: HabitResponse[];
  checkedHabitIds: Record<string, boolean>;
  onToggleHabit: (habitId: string) => void;
}

const ChecklistPane: React.FC<ChecklistProps> = ({
  active,
  trailing,
  checkedHabitIds,
  onToggleHabit,
}) => (
  <section className="mt-6" data-testid="routine-checklist-pane">
    <h2 className="px-4 text-base font-medium">Today&apos;s checklist</h2>
    {active.length === 0 ? (
      <p className="px-4 pt-2 text-sm text-neutral-400">
        No active habits left to check off.
      </p>
    ) : (
      <IonList>
        {active.map((habit) => (
          <ChecklistRow
            key={habit.id}
            habit={habit}
            checked={Boolean(checkedHabitIds[habit.id])}
            onToggle={() => onToggleHabit(habit.id)}
          />
        ))}
      </IonList>
    )}

    {trailing.length > 0 ? (
      <div className="mt-4" data-testid="routine-trailing-section">
        <h3 className="px-4 text-sm font-medium text-neutral-400">
          Not in today&apos;s checklist
        </h3>
        <IonList>
          {trailing.map((habit) => (
            <IonItem key={habit.id} data-testid={`routine-trailing-${habit.id}`}>
              <IonLabel className="ion-text-wrap">
                <h3>{habit.title}</h3>
                {habit.description ? (
                  <IonNote className="text-xs">
                    {snippet(habit.description)}
                  </IonNote>
                ) : null}
              </IonLabel>
            </IonItem>
          ))}
        </IonList>
      </div>
    ) : null}
  </section>
);

interface RowProps {
  habit: HabitResponse;
  checked: boolean;
  onToggle: () => void;
}

const ChecklistRow: React.FC<RowProps> = ({ habit, checked, onToggle }) => (
  <IonItem
    button
    onClick={onToggle}
    data-testid={`routine-checklist-row-${habit.id}`}
  >
    <IonCheckbox
      slot="start"
      checked={checked}
      onIonChange={onToggle}
      aria-label={`Mark ${habit.title} done`}
      data-testid={`routine-checkbox-${habit.id}`}
    />
    <IonLabel className="ion-text-wrap">
      <h3>{habit.title}</h3>
      {habit.description ? (
        <p className="text-xs text-neutral-400">{snippet(habit.description)}</p>
      ) : null}
      <p className="text-xs text-neutral-500">
        Streak {habit.current_streak ?? 0}
      </p>
    </IonLabel>
  </IonItem>
);

const FreeformChecklistMessage: React.FC = () => (
  <section
    className="mt-6 px-4 text-sm text-neutral-300"
    data-testid="routine-checklist-freeform"
  >
    This routine is freeform — tap an action below to record completion.
  </section>
);

// ---------------------------------------------------------------------------
// Freeform note pane
// ---------------------------------------------------------------------------

interface NoteProps {
  value: string;
  onChange: (value: string) => void;
  showRequiredError: boolean;
  textareaRef: React.MutableRefObject<HTMLIonTextareaElement | null>;
}

const FreeformNotePane: React.FC<NoteProps> = ({
  value,
  onChange,
  showRequiredError,
  textareaRef,
}) => (
  <section className="mt-6 px-4" data-testid="routine-note-pane">
    <IonTextarea
      ref={textareaRef}
      value={value}
      onIonInput={(e) => onChange(((e.detail.value ?? '') as string))}
      placeholder="Anything worth noting? (Optional for All Done and Partial. Required for Skipped.)"
      maxlength={FREEFORM_NOTE_MAX}
      autoGrow
      rows={3}
      data-testid="routine-freeform-note"
    />
    {showRequiredError ? (
      <IonText
        color="danger"
        className="text-xs"
        data-testid="routine-skipped-error"
      >
        A note is required when marking the routine skipped.
      </IonText>
    ) : null}
  </section>
);

// ---------------------------------------------------------------------------
// Not-found card
// ---------------------------------------------------------------------------

const NotFoundCard: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div
    className="flex h-full w-full flex-col items-center justify-center px-4 text-center text-neutral-300"
    data-testid="routine-not-found"
  >
    <p>Routine not found.</p>
    <IonButton
      fill="outline"
      className="mt-3"
      onClick={onBack}
      data-testid="routine-not-found-back"
    >
      Back to routines
    </IonButton>
  </div>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAbsoluteDate(value: string): string {
  try {
    return format(parseISO(value), 'EEEE, MMMM d');
  } catch {
    return value;
  }
}

function snippet(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

function formatScheduleSummary(
  schedules: RoutineScheduleResponse[],
): string | null {
  if (!schedules || schedules.length === 0) return null;
  const parts = schedules
    .slice(0, 2)
    .map((s) => {
      const day = s.day_of_week
        ? s.day_of_week.charAt(0).toUpperCase() + s.day_of_week.slice(1)
        : null;
      const time = s.time_of_day ?? null;
      if (day && time) return `${day} ${time}`;
      return day ?? time ?? null;
    })
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'notFound' in error &&
      (error as { notFound: unknown }).notFound === true,
  );
}

// `RoutineCompletionStatus` is consumed indirectly via enqueueRoutineCompletion
// but referenced here as a named import to keep the spec contract visible at
// the consumer site. Re-export is intentional for downstream test imports.
export type { RoutineCompletionStatus };

export default RoutineDetailPage;
