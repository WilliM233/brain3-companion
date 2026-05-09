import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonText,
  IonTitle,
  IonToolbar,
  type RefresherEventDetail,
  type SegmentChangeEventDetail,
} from '@ionic/react';
import { format, parseISO } from 'date-fns';
import { useHistory } from 'react-router-dom';
import ConnectionIndicator from '../components/ConnectionIndicator';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchNotifications,
  partitionNotifications,
  readCachedNotifications,
  writeCachedNotifications,
  type EarlierGroup,
  type FetchResult,
  type NotificationItem,
  type NotificationStatus,
} from '../lib/notifications';
import {
  applyNotificationFilter,
  readNotificationFilter,
  writeNotificationFilter,
  type NotificationFilter,
} from '../lib/notification-filter';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'empty-no-pairing' }
  | { kind: 'ready'; items: NotificationItem[]; fromCache: boolean }
  | { kind: 'error'; message: string };

function statusLabel(status: NotificationStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'delivered':
      return 'Delivered';
    case 'responded':
      return 'Responded';
    case 'expired':
      return 'Expired';
  }
}

function statusColor(
  status: NotificationStatus,
): 'medium' | 'primary' | 'success' | 'warning' {
  switch (status) {
    case 'pending':
      return 'medium';
    case 'delivered':
      return 'primary';
    case 'responded':
      return 'success';
    case 'expired':
      return 'warning';
  }
}

function formatLocalTime(iso: string): string {
  try {
    return format(parseISO(iso), 'h:mm a');
  } catch {
    return iso;
  }
}

function formatGroupHeading(yyyyMmDd: string): string {
  try {
    return format(parseISO(yyyyMmDd), 'EEE, MMM d');
  } catch {
    return yyyyMmDd;
  }
}

function fetchErrorMessage(result: Extract<FetchResult, { ok: false }>): string {
  switch (result.reason) {
    case 'unauthorized':
      return 'Session expired. Re-pair from Settings.';
    case 'network':
    case 'timeout':
      return "Couldn't reach server.";
    case 'server':
      return `Server error (${result.statusCode ?? 'unknown'}).`;
  }
}

const NotificationsPage: React.FC = () => {
  const history = useHistory();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [filter, setFilter] = useState<NotificationFilter>('all');

  const onRowTap = useCallback(
    (item: NotificationItem): void => {
      history.push(`/notifications/${item.id}`);
    },
    [history],
  );

  const refresh = useCallback(
    async (pairing: Pairing): Promise<void> => {
      const result = await fetchNotifications(pairing);
      if (result.ok) {
        await writeCachedNotifications(result.items);
        setState({ kind: 'ready', items: result.items, fromCache: false });
        return;
      }
      // Fetch failed — fall back to cache if available, otherwise surface error.
      const cached = await readCachedNotifications();
      if (cached) {
        setState({ kind: 'ready', items: cached.items, fromCache: true });
        return;
      }
      setState({ kind: 'error', message: fetchErrorMessage(result) });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, persistedFilter] = await Promise.all([
        loadPairing(),
        readNotificationFilter(),
      ]);
      if (cancelled) return;
      setFilter(persistedFilter);
      if (!pairing) {
        setState({ kind: 'empty-no-pairing' });
        return;
      }
      // Cache-first paint so offline launch shows something immediately.
      const cached = await readCachedNotifications();
      if (!cancelled && cached) {
        setState({ kind: 'ready', items: cached.items, fromCache: true });
      }
      await refresh(pairing);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      const pairing = await loadPairing();
      if (pairing) {
        await refresh(pairing);
      }
      event.detail.complete();
    },
    [refresh],
  );

  const handleFilterChange = useCallback(
    (event: CustomEvent<SegmentChangeEventDetail>): void => {
      const next = event.detail.value;
      if (next !== 'all' && next !== 'patterns') return;
      setFilter(next);
      void writeNotificationFilter(next);
    },
    [],
  );

  const partition = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return partitionNotifications(applyNotificationFilter(state.items, filter));
  }, [state, filter]);

  const filterAnnotation = filter === 'patterns' ? '(filtered: patterns)' : null;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Notifications</IonTitle>
          <ConnectionIndicator slot="end" />
        </IonToolbar>
        <IonToolbar>
          <IonSegment
            value={filter}
            onIonChange={handleFilterChange}
            aria-label="Notification type filter"
          >
            <IonSegmentButton value="all">
              <IonLabel>All</IonLabel>
            </IonSegmentButton>
            <IonSegmentButton value="patterns">
              <IonLabel>Patterns</IonLabel>
            </IonSegmentButton>
          </IonSegment>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        {state.kind === 'loading' ? (
          <div className="flex h-full w-full items-center justify-center text-neutral-300">
            <p>Loading…</p>
          </div>
        ) : null}

        {state.kind === 'empty-no-pairing' ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
            <p>Pair the app from Settings to see notifications.</p>
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div
            className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-200"
            role="alert"
          >
            <p>{state.message}</p>
          </div>
        ) : null}

        {state.kind === 'ready' && partition ? (
          <>
            {state.fromCache ? (
              <div
                className="px-4 pt-3 text-sm text-neutral-300"
                role="status"
                aria-live="polite"
              >
                Showing cached data
              </div>
            ) : null}

            <IonList>
              <IonListHeader>
                <IonLabel>
                  Today
                  {filterAnnotation ? (
                    <IonText color="medium">
                      <small className="ml-2">{filterAnnotation}</small>
                    </IonText>
                  ) : null}
                </IonLabel>
              </IonListHeader>
              {partition.today.length === 0 ? (
                <IonItem lines="none">
                  <IonLabel>
                    <IonText color="medium">
                      <p>No notifications today.</p>
                    </IonText>
                  </IonLabel>
                </IonItem>
              ) : (
                partition.today.map((item) => (
                  <NotificationRow key={item.id} item={item} onTap={onRowTap} />
                ))
              )}
            </IonList>

            <IonList>
              <IonListHeader>
                <IonLabel>
                  Earlier
                  {filterAnnotation ? (
                    <IonText color="medium">
                      <small className="ml-2">{filterAnnotation}</small>
                    </IonText>
                  ) : null}
                </IonLabel>
              </IonListHeader>
              {partition.earlier.length === 0 ? (
                <IonItem lines="none">
                  <IonLabel>
                    <IonText color="medium">
                      <p>No earlier notifications.</p>
                    </IonText>
                  </IonLabel>
                </IonItem>
              ) : (
                partition.earlier.map((group) => (
                  <EarlierDayGroup
                    key={group.date}
                    group={group}
                    onRowTap={onRowTap}
                  />
                ))
              )}
            </IonList>
          </>
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface EarlierDayGroupProps {
  group: EarlierGroup;
  onRowTap: (item: NotificationItem) => void;
}

const EarlierDayGroup: React.FC<EarlierDayGroupProps> = ({
  group,
  onRowTap,
}) => (
  <>
    <IonItem lines="none" className="ion-margin-top">
      <IonLabel>
        <IonText color="medium">
          <h3>{formatGroupHeading(group.date)}</h3>
        </IonText>
      </IonLabel>
    </IonItem>
    {group.items.map((item) => (
      <NotificationRow key={item.id} item={item} onTap={onRowTap} />
    ))}
  </>
);

interface NotificationRowProps {
  item: NotificationItem;
  onTap: (item: NotificationItem) => void;
}

const NotificationRow: React.FC<NotificationRowProps> = ({ item, onTap }) => (
  <IonItem
    button
    onClick={() => onTap(item)}
    data-testid={`notification-row-${item.id}`}
  >
    <IonLabel className="ion-text-wrap">
      <h2>{item.notification_type}</h2>
      <p>{item.message}</p>
      {item.response ? (
        <IonText color="success">
          <p>Replied: {item.response}</p>
        </IonText>
      ) : null}
    </IonLabel>
    <div slot="end" className="flex flex-col items-end gap-1">
      <IonNote>{formatLocalTime(item.scheduled_at)}</IonNote>
      <IonText color={statusColor(item.status)}>
        <small>{statusLabel(item.status)}</small>
      </IonText>
    </div>
  </IonItem>
);

export default NotificationsPage;
