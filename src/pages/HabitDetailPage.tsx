import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonAlert,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonProgressBar,
  IonRefresher,
  IonRefresherContent,
  IonText,
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
import StalenessBanner from '../components/StalenessBanner';
import StatusPill from '../components/StatusPill';
import { useSurfaceLastSync } from '../lib/connection/useSurfaceLastSync';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchHabitCompletions,
  fetchHabitDetail,
  fetchHabitGraduationStatus,
  patchHabitStatus,
  postReScaffold,
  postStepDownFrequency,
  readCachedGraduationStatus,
  readCachedHabitDetail,
  writeCachedGraduationStatus,
  writeCachedHabitDetail,
  type GraduationStatusResponse,
  type HabitCompletionItem,
  type HabitDetailResponse,
} from '../lib/habit-detail';
import {
  enqueueHabitCompletion,
  flushAllQueues,
  subscribeHabitCompletionWarnings,
  type HabitCompletionWarning,
} from '../lib/completionQueues';
import { todayLocalDate } from '../lib/local-date';

const HABIT_QUERY_KEY = (id: string): QueryKey => ['habit', id];
const HABIT_GRADUATION_QUERY_KEY = (id: string): QueryKey => [
  'habit-graduation',
  id,
];
const HABIT_COMPLETIONS_QUERY_KEY = (id: string): QueryKey => [
  'habit-completions',
  id,
];
const HABITS_LIST_QUERY_KEY: QueryKey = ['habits', 'active'];
const STALE_MS = 5 * 60 * 1000;
const COMPLETIONS_LIMIT = 20;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedHabit: HabitDetailResponse | null;
      cachedHabitFetchedAtMs: number | null;
      cachedGraduation: GraduationStatusResponse | null;
      cachedGraduationFetchedAtMs: number | null;
    };

const HabitDetailPage: React.FC = () => {
  const { habitId } = useParams<{ habitId: string }>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cachedDetail, cachedGraduation] = await Promise.all([
        loadPairing(),
        readCachedHabitDetail(habitId),
        readCachedGraduationStatus(habitId),
      ]);
      if (cancelled) return;
      if (!pairing) {
        setBootstrap({ kind: 'no-pairing' });
        return;
      }
      const detailMs = cachedDetail?.fetched_at
        ? Date.parse(cachedDetail.fetched_at)
        : NaN;
      const gradMs = cachedGraduation?.fetched_at
        ? Date.parse(cachedGraduation.fetched_at)
        : NaN;
      setBootstrap({
        kind: 'paired',
        pairing,
        cachedHabit: cachedDetail?.habit ?? null,
        cachedHabitFetchedAtMs: Number.isFinite(detailMs) ? detailMs : null,
        cachedGraduation: cachedGraduation?.status ?? null,
        cachedGraduationFetchedAtMs: Number.isFinite(gradMs) ? gradMs : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [habitId]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/habits" />
          </IonButtons>
          <IonTitle>Habit</IonTitle>
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
            <p>Pair the app from Settings to see this habit.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <DetailBody
            habitId={habitId}
            pairing={bootstrap.pairing}
            initialHabit={bootstrap.cachedHabit}
            initialHabitFetchedAtMs={bootstrap.cachedHabitFetchedAtMs}
            initialGraduation={bootstrap.cachedGraduation}
            initialGraduationFetchedAtMs={
              bootstrap.cachedGraduationFetchedAtMs
            }
          />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  habitId: string;
  pairing: Pairing;
  initialHabit: HabitDetailResponse | null;
  initialHabitFetchedAtMs: number | null;
  initialGraduation: GraduationStatusResponse | null;
  initialGraduationFetchedAtMs: number | null;
}

interface ToastState {
  open: boolean;
  message: string;
  color?: 'success' | 'danger' | 'medium';
}

const DetailBody: React.FC<BodyProps> = ({
  habitId,
  pairing,
  initialHabit,
  initialHabitFetchedAtMs,
  initialGraduation,
  initialGraduationFetchedAtMs,
}) => {
  const history = useHistory();
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<ToastState>({ open: false, message: '' });
  const [reScaffoldAlertOpen, setReScaffoldAlertOpen] = useState(false);
  const [pauseAlertOpen, setPauseAlertOpen] = useState(false);
  const [resumeAlertOpen, setResumeAlertOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  const habitQuery = useQuery<HabitDetailResponse>({
    queryKey: HABIT_QUERY_KEY(habitId),
    queryFn: async () => {
      const result = await fetchHabitDetail(pairing, habitId);
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
          notFound: result.reason === 'not_found',
        });
      }
      await writeCachedHabitDetail(habitId, result.habit);
      return result.habit;
    },
    initialData: initialHabit ?? undefined,
    initialDataUpdatedAt:
      initialHabit !== null && initialHabitFetchedAtMs !== null
        ? initialHabitFetchedAtMs
        : undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const graduationQuery = useQuery<GraduationStatusResponse>({
    queryKey: HABIT_GRADUATION_QUERY_KEY(habitId),
    queryFn: async () => {
      const result = await fetchHabitGraduationStatus(pairing, habitId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedGraduationStatus(habitId, result.status);
      return result.status;
    },
    initialData: initialGraduation ?? undefined,
    initialDataUpdatedAt:
      initialGraduation !== null && initialGraduationFetchedAtMs !== null
        ? initialGraduationFetchedAtMs
        : undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    enabled: !isNotFoundError(habitQuery.error),
    retry: false,
  });

  const completionsQuery = useQuery<HabitCompletionItem[]>({
    queryKey: HABIT_COMPLETIONS_QUERY_KEY(habitId),
    queryFn: async () => {
      const result = await fetchHabitCompletions(
        pairing,
        habitId,
        COMPLETIONS_LIMIT,
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
      return result.completions;
    },
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    enabled: !isNotFoundError(habitQuery.error),
    retry: false,
  });

  const habit = habitQuery.data;
  const graduation = graduationQuery.data;
  const completions = completionsQuery.data;
  // Per Pass 5 §3 [2C-28]: habit detail composes two cached queries; the
  // banner reads the max `dataUpdatedAt` across both so the displayed
  // "last synced X ago" matches the most recent of habit + graduation.
  const surfaceLastSync = useSurfaceLastSync([
    HABIT_QUERY_KEY(habitId),
    HABIT_GRADUATION_QUERY_KEY(habitId),
  ]);

  // Wire the [2C-23] habit-completion warning subscription. Per the Group 3
  // close ledger this surface lands in [2C-25] alongside the routine warning
  // surface in RoutineDetailPage — see PR body Deviation §1 + §2.
  useEffect(() => {
    const unsubscribe = subscribeHabitCompletionWarnings(
      (warning: HabitCompletionWarning) => {
        if (warning.habit_id !== habitId) return;
        const message =
          warning.kind === 'paused'
            ? 'Habit is paused — completion was discarded'
            : 'Habit no longer exists — completion was discarded';
        setToast({ open: true, message, color: 'danger' });
      },
    );
    return () => unsubscribe();
  }, [habitId]);

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await Promise.all([
          habitQuery.refetch(),
          graduationQuery.refetch(),
          completionsQuery.refetch(),
        ]);
      } finally {
        event.detail.complete();
      }
    },
    [habitQuery, graduationQuery, completionsQuery],
  );

  const invalidateAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: HABIT_QUERY_KEY(habitId) }),
      queryClient.invalidateQueries({
        queryKey: HABIT_GRADUATION_QUERY_KEY(habitId),
      }),
      queryClient.invalidateQueries({
        queryKey: HABIT_COMPLETIONS_QUERY_KEY(habitId),
      }),
      queryClient.invalidateQueries({ queryKey: HABITS_LIST_QUERY_KEY }),
    ]);
  }, [habitId, queryClient]);

  const onMarkComplete = useCallback(async (): Promise<void> => {
    if (!habit) return;
    const today = todayLocalDate();
    await enqueueHabitCompletion({
      habit_id: habit.id,
      completed_date: today,
      notes: null,
      enqueued_at: new Date().toISOString(),
    });
    const summary = await flushAllQueues();
    const habitFlush = summary.habitCompletions;
    if (habitFlush.delivered > 0) {
      await invalidateAll();
      setToast({ open: true, message: 'Marked complete', color: 'success' });
    } else if (
      !habitFlush.coalesced &&
      habitFlush.attempted > 0 &&
      habitFlush.delivered === 0
    ) {
      setToast({
        open: true,
        message: 'Queued — will retry',
        color: 'medium',
      });
    } else {
      setToast({ open: true, message: 'Queued', color: 'medium' });
    }
  }, [habit, invalidateAll]);

  const onPause = useCallback(async (): Promise<void> => {
    setPauseAlertOpen(false);
    setActionPending(true);
    try {
      const result = await patchHabitStatus(pairing, habitId, 'paused');
      if (result.ok) {
        await invalidateAll();
        setToast({ open: true, message: 'Habit paused', color: 'success' });
      } else if (result.reason === 'network' || result.reason === 'timeout') {
        setToast({
          open: true,
          message: 'Action requires connection',
          color: 'medium',
        });
      } else if (result.reason === 'not_found') {
        setToast({
          open: true,
          message: 'Habit no longer exists',
          color: 'danger',
        });
      } else {
        setToast({
          open: true,
          message: 'Could not pause habit',
          color: 'danger',
        });
      }
    } finally {
      setActionPending(false);
    }
  }, [habitId, invalidateAll, pairing]);

  const onResume = useCallback(async (): Promise<void> => {
    setResumeAlertOpen(false);
    setActionPending(true);
    try {
      const result = await patchHabitStatus(pairing, habitId, 'active');
      if (result.ok) {
        await invalidateAll();
        setToast({ open: true, message: 'Habit resumed', color: 'success' });
      } else if (result.reason === 'network' || result.reason === 'timeout') {
        setToast({
          open: true,
          message: 'Action requires connection',
          color: 'medium',
        });
      } else if (result.reason === 'not_found') {
        setToast({
          open: true,
          message: 'Habit no longer exists',
          color: 'danger',
        });
      } else {
        setToast({
          open: true,
          message: 'Could not resume habit',
          color: 'danger',
        });
      }
    } finally {
      setActionPending(false);
    }
  }, [habitId, invalidateAll, pairing]);

  const onStepDown = useCallback(async (): Promise<void> => {
    if (!isOnline()) {
      setToast({
        open: true,
        message: 'Action requires connection',
        color: 'medium',
      });
      return;
    }
    setActionPending(true);
    try {
      const result = await postStepDownFrequency(pairing, habitId);
      if (result.ok) {
        await invalidateAll();
        setToast({
          open: true,
          message: `Stepped down to ${result.result.new_frequency}`,
          color: 'success',
        });
      } else if (result.reason === 'network' || result.reason === 'timeout') {
        setToast({
          open: true,
          message: 'Action requires connection',
          color: 'medium',
        });
      } else if (result.reason === 'not_recommended') {
        setToast({
          open: true,
          message: result.detail ?? 'Step-down no longer recommended',
          color: 'medium',
        });
      } else {
        setToast({
          open: true,
          message: 'Could not step down frequency',
          color: 'danger',
        });
      }
    } finally {
      setActionPending(false);
    }
  }, [habitId, invalidateAll, pairing]);

  const onReScaffoldConfirm = useCallback(async (): Promise<void> => {
    setReScaffoldAlertOpen(false);
    if (!isOnline()) {
      setToast({
        open: true,
        message: 'Action requires connection',
        color: 'medium',
      });
      return;
    }
    setActionPending(true);
    try {
      const result = await postReScaffold(pairing, habitId);
      if (result.ok) {
        await invalidateAll();
        setToast({
          open: true,
          message: 'Habit re-scaffolded',
          color: 'success',
        });
        history.replace('/habits');
      } else if (result.reason === 'network' || result.reason === 'timeout') {
        setToast({
          open: true,
          message: 'Action requires connection',
          color: 'medium',
        });
      } else if (result.reason === 'invalid_state') {
        setToast({
          open: true,
          message: result.detail ?? 'Habit is not in a graduated state',
          color: 'medium',
        });
      } else {
        setToast({
          open: true,
          message: 'Could not re-scaffold habit',
          color: 'danger',
        });
      }
    } finally {
      setActionPending(false);
    }
  }, [habitId, history, invalidateAll, pairing]);

  if (isNotFoundError(habitQuery.error) && !habit) {
    return (
      <NotFoundCard
        onBack={() => history.replace('/habits')}
      />
    );
  }

  if (!habit) {
    return (
      <div className="flex h-full w-full items-center justify-center text-neutral-300">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>

      <StalenessBanner lastSyncedAt={surfaceLastSync} />

      <DefinitionPane
        habit={habit}
        onRoutineTap={(routineId) => history.push(`/routines/${routineId}`)}
      />

      <GraduationDashboard
        graduation={graduation}
        habit={habit}
        onStepDown={onStepDown}
        actionPending={actionPending}
        onReScaffold={() => setReScaffoldAlertOpen(true)}
      />

      <RecentCompletions completions={completions} />

      <ActionFooter
        habit={habit}
        actionPending={actionPending}
        onMarkComplete={onMarkComplete}
        onPause={() => setPauseAlertOpen(true)}
        onResume={() => setResumeAlertOpen(true)}
      />

      <IonAlert
        isOpen={reScaffoldAlertOpen}
        header="Re-scaffold habit?"
        message="This will return the habit to daily accountability and reset the graduation progress. Continue?"
        buttons={[
          { text: 'Cancel', role: 'cancel' },
          { text: 'Re-scaffold', role: 'destructive', handler: () => void onReScaffoldConfirm() },
        ]}
        onDidDismiss={() => setReScaffoldAlertOpen(false)}
      />
      <IonAlert
        isOpen={pauseAlertOpen}
        header="Pause this habit?"
        message="It won't accept completions until resumed."
        buttons={[
          { text: 'Cancel', role: 'cancel' },
          { text: 'Pause', handler: () => void onPause() },
        ]}
        onDidDismiss={() => setPauseAlertOpen(false)}
      />
      <IonAlert
        isOpen={resumeAlertOpen}
        header="Resume this habit?"
        buttons={[
          { text: 'Cancel', role: 'cancel' },
          { text: 'Resume', handler: () => void onResume() },
        ]}
        onDidDismiss={() => setResumeAlertOpen(false)}
      />

      <IonToast
        isOpen={toast.open}
        message={toast.message}
        color={toast.color}
        duration={toast.color === 'danger' ? 5000 : 3000}
        onDidDismiss={() => setToast({ open: false, message: '' })}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Definition pane
// ---------------------------------------------------------------------------

interface DefinitionProps {
  habit: HabitDetailResponse;
  onRoutineTap: (routineId: string) => void;
}

const DefinitionPane: React.FC<DefinitionProps> = ({ habit, onRoutineTap }) => {
  const lastCompletedLine = useMemo(() => {
    if (habit.last_completed === null) return 'Never completed';
    return `${formatAbsoluteDate(habit.last_completed)} (${formatDistanceToNowStrict(parseISO(habit.last_completed), { addSuffix: true })})`;
  }, [habit.last_completed]);

  return (
    <section className="px-4 pt-4" data-testid="habit-definition-pane">
      <div className="flex items-center gap-2">
        <StatusPill status={habit.scaffolding_status} />
        <h1 className="text-xl font-semibold">{habit.title}</h1>
      </div>

      {habit.description !== null ? (
        <p
          className="mt-2 whitespace-pre-wrap text-sm text-neutral-200"
          data-testid="habit-description"
        >
          {habit.description}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-1 gap-2 text-sm">
        {habit.frequency !== null ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Frequency</dt>
            <dd>{habit.frequency}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-neutral-400">Notification frequency</dt>
          <dd>{habit.notification_frequency}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-400">Streak</dt>
          <dd data-testid="habit-streak">
            Streak {habit.current_streak} · Best {habit.best_streak}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-400">Last completed</dt>
          <dd>{lastCompletedLine}</dd>
        </div>
        {habit.accountable_since !== null ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Accountable since</dt>
            <dd>{formatAbsoluteDate(habit.accountable_since)}</dd>
          </div>
        ) : null}
        {habit.re_scaffold_count > 0 ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Re-scaffolded</dt>
            <dd>{habit.re_scaffold_count} times</dd>
          </div>
        ) : null}
        {habit.graduated_at !== null ? (
          <div className="flex justify-between">
            <dt className="text-neutral-400">Graduated</dt>
            <dd>{formatAbsoluteDate(habit.graduated_at)}</dd>
          </div>
        ) : null}
      </dl>

      {habit.routine !== null ? (
        <button
          type="button"
          className="mt-3 block w-full rounded border border-neutral-700 px-3 py-2 text-left text-sm text-neutral-100"
          onClick={() => onRoutineTap(habit.routine!.id)}
          data-testid="habit-routine-link"
        >
          Part of: {habit.routine.title}
        </button>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Graduation dashboard
// ---------------------------------------------------------------------------

interface GraduationProps {
  graduation: GraduationStatusResponse | undefined;
  habit: HabitDetailResponse;
  actionPending: boolean;
  onStepDown: () => void;
  onReScaffold: () => void;
}

const GraduationDashboard: React.FC<GraduationProps> = ({
  graduation,
  habit,
  actionPending,
  onStepDown,
  onReScaffold,
}) => {
  if (!graduation) {
    return (
      <section
        className="mt-6 px-4 text-sm text-neutral-400"
        data-testid="habit-graduation-pane"
      >
        Loading graduation status…
      </section>
    );
  }

  const status = graduation.scaffolding_status;

  return (
    <section
      className="mt-6 px-4"
      data-testid="habit-graduation-pane"
      data-graduation-status={status}
    >
      <h2 className="text-base font-medium">Graduation</h2>
      <p className="mt-1 text-sm text-neutral-300">
        {graduation.progress_summary}
      </p>

      {status === 'accountable' ? (
        <AccountableDashboard
          graduation={graduation}
          actionPending={actionPending}
          onStepDown={onStepDown}
        />
      ) : null}

      {status === 'graduated' ? (
        <GraduatedDashboard
          habit={habit}
          actionPending={actionPending}
          onReScaffold={onReScaffold}
        />
      ) : null}
    </section>
  );
};

interface AccountableProps {
  graduation: GraduationStatusResponse;
  actionPending: boolean;
  onStepDown: () => void;
}

const AccountableDashboard: React.FC<AccountableProps> = ({
  graduation,
  actionPending,
  onStepDown,
}) => {
  const { current_metrics, graduation_params, days_accountable } = graduation;
  const ratePct = Math.round(current_metrics.already_done_rate * 100);
  const targetPct = Math.round(graduation_params.target_rate * 100);
  const remainingDays = Math.max(
    0,
    graduation_params.threshold_days - days_accountable,
  );

  return (
    <div className="mt-3" data-testid="habit-graduation-accountable">
      <div
        className="relative"
        aria-label={`Graduation progress: ${ratePct}% of ${targetPct}% target`}
      >
        <IonProgressBar
          value={Math.min(1, current_metrics.already_done_rate)}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 h-full w-px bg-amber-300"
          style={{
            left: `${Math.min(100, Math.max(0, graduation_params.target_rate * 100))}%`,
          }}
          data-testid="habit-graduation-target-marker"
        />
      </div>
      <p
        className="mt-2 text-xs text-neutral-400"
        data-testid="habit-graduation-caption"
      >
        {ratePct}% of {targetPct}% target ·{' '}
        {current_metrics.already_done_count}/
        {current_metrics.total_notifications} completions this window
      </p>
      {remainingDays > 0 ? (
        <p
          className="mt-1 text-xs text-neutral-400"
          data-testid="habit-graduation-days-line"
        >
          {remainingDays} days until minimum threshold met.
        </p>
      ) : null}
      {graduation.frequency_step_down.eligible &&
      graduation.frequency_step_down.recommended_frequency !== null ? (
        <div className="mt-3 flex items-center justify-between rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <span className="text-sm">
            Stepping down to{' '}
            <strong>
              {graduation.frequency_step_down.recommended_frequency}
            </strong>{' '}
            is recommended
          </span>
          <IonButton
            size="small"
            color="warning"
            onClick={onStepDown}
            disabled={actionPending}
            data-testid="habit-step-down-button"
          >
            Step down
          </IonButton>
        </div>
      ) : null}
    </div>
  );
};

interface GraduatedProps {
  habit: HabitDetailResponse;
  actionPending: boolean;
  onReScaffold: () => void;
}

const GraduatedDashboard: React.FC<GraduatedProps> = ({
  habit,
  actionPending,
  onReScaffold,
}) => (
  <div className="mt-3" data-testid="habit-graduation-graduated">
    {habit.graduated_at !== null ? (
      <p className="text-sm text-neutral-300">
        Graduated on {formatAbsoluteDate(habit.graduated_at)}.
      </p>
    ) : null}
    <IonButton
      color="medium"
      size="small"
      className="mt-2"
      onClick={onReScaffold}
      disabled={actionPending}
      data-testid="habit-re-scaffold-button"
    >
      Re-scaffold
    </IonButton>
  </div>
);

// ---------------------------------------------------------------------------
// Recent completions
// ---------------------------------------------------------------------------

interface CompletionsProps {
  completions: HabitCompletionItem[] | undefined;
}

const RecentCompletions: React.FC<CompletionsProps> = ({ completions }) => {
  if (completions === undefined) {
    return (
      <section className="mt-6 px-4 text-sm text-neutral-400">
        <h2 className="text-base font-medium">Recent completions</h2>
        <p className="mt-1">Loading…</p>
      </section>
    );
  }
  if (completions.length === 0) {
    return (
      <section
        className="mt-6 px-4 text-sm text-neutral-400"
        data-testid="habit-completions-empty"
      >
        <h2 className="text-base font-medium">Recent completions</h2>
        <p className="mt-1">No completions yet.</p>
      </section>
    );
  }
  return (
    <section className="mt-6" data-testid="habit-completions-list">
      <h2 className="px-4 text-base font-medium">Recent completions</h2>
      <IonList>
        {completions.map((entry) => (
          <CompletionRow key={entry.id} entry={entry} />
        ))}
      </IonList>
    </section>
  );
};

const CompletionRow: React.FC<{ entry: HabitCompletionItem }> = ({ entry }) => {
  const dateLine = formatAbsoluteDate(entry.completed_at);
  const relative = (() => {
    try {
      return formatDistanceToNowStrict(parseISO(entry.completed_at), {
        addSuffix: true,
      });
    } catch {
      return entry.completed_at;
    }
  })();
  const subtitle =
    entry.source === 'routine_cascade'
      ? `${relative} · via routine`
      : relative;
  return (
    <IonItem data-testid={`habit-completion-${entry.id}`}>
      <IonLabel className="ion-text-wrap">
        <h3>{dateLine}</h3>
        <p>{subtitle}</p>
        {entry.notes !== null ? (
          <IonNote className="text-xs">{entry.notes}</IonNote>
        ) : null}
      </IonLabel>
    </IonItem>
  );
};

// ---------------------------------------------------------------------------
// Action footer
// ---------------------------------------------------------------------------

interface ActionFooterProps {
  habit: HabitDetailResponse;
  actionPending: boolean;
  onMarkComplete: () => void;
  onPause: () => void;
  onResume: () => void;
}

const ActionFooter: React.FC<ActionFooterProps> = ({
  habit,
  actionPending,
  onMarkComplete,
  onPause,
  onResume,
}) => {
  const showMarkComplete: boolean = habit.status === 'active';
  const showPause: boolean = habit.status === 'active';
  const showResume: boolean = habit.status === 'paused';

  return (
    <section
      className="mt-6 flex flex-col gap-2 px-4 pb-8"
      data-testid="habit-action-footer"
    >
      {showMarkComplete ? (
        <IonButton
          color="primary"
          onClick={onMarkComplete}
          disabled={actionPending}
          data-testid="habit-mark-complete-button"
        >
          Mark complete
        </IonButton>
      ) : null}
      {showPause ? (
        <IonButton
          color="medium"
          onClick={onPause}
          disabled={actionPending}
          data-testid="habit-pause-button"
        >
          Pause
        </IonButton>
      ) : null}
      {showResume ? (
        <IonButton
          color="primary"
          onClick={onResume}
          disabled={actionPending}
          data-testid="habit-resume-button"
        >
          Resume
        </IonButton>
      ) : null}
      {habit.status === 'paused' ? (
        <IonText color="medium" className="text-xs">
          Paused — completions are not accepted.
        </IonText>
      ) : null}
      {habit.status === 'graduated' ? (
        <IonText color="medium" className="text-xs">
          Graduated — completions are tracked but no longer affect streaks.
        </IonText>
      ) : null}
      {habit.status === 'abandoned' ? (
        <IonText color="medium" className="text-xs">
          Abandoned.
        </IonText>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Not-found card
// ---------------------------------------------------------------------------

const NotFoundCard: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div
    className="flex h-full w-full flex-col items-center justify-center px-4 text-center text-neutral-300"
    data-testid="habit-not-found"
  >
    <p>Habit not found.</p>
    <IonButton
      fill="outline"
      className="mt-3"
      onClick={onBack}
      data-testid="habit-not-found-back"
    >
      Back to habits
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

function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'notFound' in error &&
      (error as { notFound: unknown }).notFound === true,
  );
}

export default HabitDetailPage;
