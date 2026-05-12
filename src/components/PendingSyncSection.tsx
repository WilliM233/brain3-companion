/**
 * [2C-30] Pending sync disclosure under Settings.
 *
 * Read-only collapsed/expanded row that surfaces the three offline write
 * queues + the permanent-failure log. Hidden entirely when there is nothing
 * pending and no recorded failures — a clean state is silent. Live updates
 * via `subscribePendingSync` (subscribes to `[2C-29]`'s
 * `writeQueueFlushState` + `document.visibilitychange`).
 *
 * Titles for habit/routine completions resolve from the TanStack Query
 * caches at `['habits', 'active']` and `['routines', 'active']`. If a habit
 * or routine has dropped out of the active list (e.g., paused after the
 * entry was enqueued), the row falls back to a short ID prefix per Pass 5
 * Summary §3 [2C-30].
 *
 * Read-only by design: no retry, edit, or delete controls in v2.0.0 — the
 * underlying queues drain on app foreground / network reconnect.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonText,
} from '@ionic/react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';

import {
  countFailures,
  countPending,
  getPendingSyncSnapshot,
  getServerSnapshot,
  subscribePendingSync,
  type PendingSyncSnapshot,
} from '../lib/pendingSync';
import type { WriteQueueEntry } from '../lib/writeQueue';
import type {
  HabitCompletionEntry,
  RoutineCompletionEntry,
} from '../lib/completionQueues';
import type { HabitResponse } from '../lib/habits';
import type { RoutineResponse } from '../lib/routines';

function formatRelative(iso: string): string {
  try {
    const date = parseISO(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return `${formatDistanceToNowStrict(date, {
      addSuffix: false,
    })} ago`;
  } catch {
    return iso;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function resolveTitle<T extends { id: string; title?: string }>(
  list: T[] | undefined,
  id: string,
): string {
  if (!list) return shortId(id);
  const found = list.find((item) => item.id === id);
  if (found && typeof found.title === 'string' && found.title.length > 0) {
    return found.title;
  }
  return shortId(id);
}

function truncate(value: string | null, max: number): string {
  if (value === null) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function pluralizeWrites(n: number): string {
  return n === 1 ? '1 write' : `${n} writes`;
}

interface NotificationRowProps {
  entry: WriteQueueEntry;
}

const NotificationRow: React.FC<NotificationRowProps> = ({ entry }) => (
  <IonItem lines="none" data-testid="pending-sync-notification-row">
    <IonLabel className="ion-text-wrap">
      <h3>{entry.response}</h3>
      <IonText color="medium">
        <p>
          {shortId(entry.notification_id)} · {formatRelative(entry.enqueued_at)}
        </p>
      </IonText>
    </IonLabel>
  </IonItem>
);

interface HabitRowProps {
  entry: HabitCompletionEntry;
  habits: HabitResponse[] | undefined;
}

const HabitRow: React.FC<HabitRowProps> = ({ entry, habits }) => (
  <IonItem lines="none" data-testid="pending-sync-habit-row">
    <IonLabel className="ion-text-wrap">
      <h3>{resolveTitle(habits, entry.habit_id)}</h3>
      <IonText color="medium">
        <p>
          {entry.completed_date} · {formatRelative(entry.enqueued_at)}
        </p>
      </IonText>
    </IonLabel>
  </IonItem>
);

interface RoutineRowProps {
  entry: RoutineCompletionEntry;
  routines: RoutineResponse[] | undefined;
}

const RoutineRow: React.FC<RoutineRowProps> = ({ entry, routines }) => (
  <IonItem lines="none" data-testid="pending-sync-routine-row">
    <IonLabel className="ion-text-wrap">
      <h3>{resolveTitle(routines, entry.routine_id)}</h3>
      <IonText color="medium">
        <p>
          {entry.completed_date} · {entry.status} ·{' '}
          {formatRelative(entry.enqueued_at)}
        </p>
      </IonText>
    </IonLabel>
  </IonItem>
);

interface FailureRowProps {
  http_status: number;
  server_message: string | null;
  dropped_at: string;
}

const FailureRow: React.FC<FailureRowProps> = ({
  http_status,
  server_message,
  dropped_at,
}) => (
  <IonItem lines="none" data-testid="pending-sync-failure-row">
    <IonLabel className="ion-text-wrap">
      <div className="flex items-center gap-2">
        <span
          data-testid="pending-sync-failure-pill"
          className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 ring-1 ring-inset ring-red-200"
        >
          {http_status}
        </span>
        <span className="text-sm">{truncate(server_message, 80)}</span>
      </div>
      <IonText color="medium">
        <p>{formatRelative(dropped_at)}</p>
      </IonText>
    </IonLabel>
  </IonItem>
);

const PendingSyncSection: React.FC = () => {
  const snapshot = useSyncExternalStore<PendingSyncSnapshot>(
    subscribePendingSync,
    getPendingSyncSnapshot,
    getServerSnapshot,
  );
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const pending = countPending(snapshot);
  const failures = countFailures(snapshot);

  const habits = queryClient.getQueryData<HabitResponse[]>([
    'habits',
    'active',
  ]);
  const routines = queryClient.getQueryData<RoutineResponse[]>([
    'routines',
    'active',
  ]);

  const lastAttemptText = useMemo(() => {
    if (snapshot.lastAttemptAt === null) return null;
    return `last attempt ${formatDistanceToNowStrict(snapshot.lastAttemptAt)} ago`;
  }, [snapshot.lastAttemptAt]);

  if (pending === 0 && failures === 0) return null;

  const summary = lastAttemptText
    ? `Pending sync: ${pluralizeWrites(pending)}, ${lastAttemptText}`
    : `Pending sync: ${pluralizeWrites(pending)}`;

  return (
    <section
      aria-label="Pending sync"
      data-testid="pending-sync-section"
      className="ion-margin-top"
    >
      <IonItem
        button
        detail
        onClick={() => setExpanded((value) => !value)}
        data-testid="pending-sync-toggle"
        aria-expanded={expanded}
      >
        <IonLabel>
          <h2>{summary}</h2>
        </IonLabel>
      </IonItem>

      {expanded ? (
        <div data-testid="pending-sync-expanded">
          {snapshot.notificationEntries.length > 0 ? (
            <>
              <IonItem lines="none">
                <IonLabel>
                  <h3 className="text-sm font-semibold">
                    Notification responses
                  </h3>
                </IonLabel>
                <IonNote slot="end">
                  {snapshot.notificationEntries.length}
                </IonNote>
              </IonItem>
              <IonList>
                {snapshot.notificationEntries.map((entry, index) => (
                  <NotificationRow
                    key={`${entry.notification_id}-${index}`}
                    entry={entry}
                  />
                ))}
              </IonList>
            </>
          ) : null}

          {snapshot.habitEntries.length > 0 ? (
            <>
              <IonItem lines="none">
                <IonLabel>
                  <h3 className="text-sm font-semibold">Habit completions</h3>
                </IonLabel>
                <IonNote slot="end">{snapshot.habitEntries.length}</IonNote>
              </IonItem>
              <IonList>
                {snapshot.habitEntries.map((entry, index) => (
                  <HabitRow
                    key={`${entry.habit_id}-${entry.completed_date}-${index}`}
                    entry={entry}
                    habits={habits}
                  />
                ))}
              </IonList>
            </>
          ) : null}

          {snapshot.routineEntries.length > 0 ? (
            <>
              <IonItem lines="none">
                <IonLabel>
                  <h3 className="text-sm font-semibold">Routine completions</h3>
                </IonLabel>
                <IonNote slot="end">{snapshot.routineEntries.length}</IonNote>
              </IonItem>
              <IonList>
                {snapshot.routineEntries.map((entry, index) => (
                  <RoutineRow
                    key={`${entry.routine_id}-${entry.completed_date}-${index}`}
                    entry={entry}
                    routines={routines}
                  />
                ))}
              </IonList>
            </>
          ) : null}

          {failures > 0 ? (
            <>
              <IonItem lines="none">
                <IonLabel>
                  <h3 className="text-sm font-semibold">Recent failures</h3>
                </IonLabel>
                <IonNote slot="end">{failures}</IonNote>
              </IonItem>
              <IonList>
                {snapshot.failures.notifications.map((failure, index) => (
                  <FailureRow
                    key={`notif-${index}`}
                    http_status={failure.http_status}
                    server_message={failure.server_message}
                    dropped_at={failure.dropped_at}
                  />
                ))}
                {snapshot.failures.habits.map((failure, index) => (
                  <FailureRow
                    key={`habit-${index}`}
                    http_status={failure.http_status}
                    server_message={failure.server_message}
                    dropped_at={failure.dropped_at}
                  />
                ))}
                {snapshot.failures.routines.map((failure, index) => (
                  <FailureRow
                    key={`routine-${index}`}
                    http_status={failure.http_status}
                    server_message={failure.server_message}
                    dropped_at={failure.dropped_at}
                  />
                ))}
              </IonList>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

export default PendingSyncSection;
