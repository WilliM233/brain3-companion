import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonHeader,
  IonLabel,
  IonPage,
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
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { useHistory, useParams } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchNotification,
  type NotificationItem,
  type NotificationStatus,
} from '../lib/notifications';
import {
  RULES_QUERY_KEY,
  fetchRule,
  fetchRules,
  readCachedRules,
  writeCachedRules,
  type RuleRead,
} from '../lib/rules';

const NOTIFICATION_QUERY_KEY = (id: string): QueryKey => ['notification', id];
const RULE_QUERY_KEY = (id: string): QueryKey => ['rule', id];
const STALE_MS = 5 * 60 * 1000;

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  habit_nudge: 'Habit nudge',
  routine_checklist: 'Routine checklist',
  checkin_prompt: 'Check-in prompt',
  time_block_reminder: 'Time block reminder',
  deadline_event_alert: 'Deadline / event alert',
  pattern_observation: 'Pattern observation',
  stale_work_nudge: 'Stale work nudge',
};

function friendlyNotificationType(notificationType: string): string {
  return NOTIFICATION_TYPE_LABELS[notificationType] ?? notificationType;
}

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

function statusPillClasses(status: NotificationStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-neutral-100 text-neutral-700 ring-neutral-300';
    case 'delivered':
      return 'bg-blue-100 text-blue-800 ring-blue-200';
    case 'responded':
      return 'bg-emerald-100 text-emerald-800 ring-emerald-200';
    case 'expired':
      return 'bg-amber-100 text-amber-800 ring-amber-200';
  }
}

function formatAbsolute(iso: string): string {
  try {
    return format(parseISO(iso), "EEE, MMM d 'at' h:mm a");
  } catch {
    return iso;
  }
}

function formatScheduledDate(yyyyMmDd: string): string {
  try {
    return format(parseISO(yyyyMmDd), 'EEE, MMM d');
  } catch {
    return yyyyMmDd;
  }
}

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedRules: RuleRead[] | null;
      cachedRulesFetchedAtMs: number | null;
    };

const NotificationDetailPage: React.FC = () => {
  const { notificationId } = useParams<{ notificationId: string }>();
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cachedRules] = await Promise.all([
        loadPairing(),
        readCachedRules(),
      ]);
      if (cancelled) return;
      if (!pairing) {
        setBootstrap({ kind: 'no-pairing' });
        return;
      }
      const cachedRulesFetchedAtMs = cachedRules?.fetched_at
        ? Date.parse(cachedRules.fetched_at)
        : null;
      setBootstrap({
        kind: 'paired',
        pairing,
        cachedRules: cachedRules?.items ?? null,
        cachedRulesFetchedAtMs: Number.isFinite(cachedRulesFetchedAtMs)
          ? cachedRulesFetchedAtMs
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
          <IonButtons slot="start">
            <IonBackButton defaultHref="/notifications" />
          </IonButtons>
          <IonTitle>Notification</IonTitle>
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
            <p>Pair the app from Settings to see this notification.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <DetailBody
            notificationId={notificationId}
            pairing={bootstrap.pairing}
            initialCachedRules={bootstrap.cachedRules}
            initialCachedRulesFetchedAtMs={bootstrap.cachedRulesFetchedAtMs}
          />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  notificationId: string;
  pairing: Pairing;
  initialCachedRules: RuleRead[] | null;
  initialCachedRulesFetchedAtMs: number | null;
}

const DetailBody: React.FC<BodyProps> = ({
  notificationId,
  pairing,
  initialCachedRules,
  initialCachedRulesFetchedAtMs,
}) => {
  const history = useHistory();
  const [toastOpen, setToastOpen] = useState(false);

  const notificationQuery = useQuery<NotificationItem>({
    queryKey: NOTIFICATION_QUERY_KEY(notificationId),
    queryFn: async () => {
      const result = await fetchNotification(pairing, notificationId);
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
          notFound: result.reason === 'not_found',
        });
      }
      return result.notification;
    },
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  // Reuse [2C-16]'s ['rules'] cache for the common rule-name resolution path.
  // Cold-start hydrates from the on-disk Capacitor Preferences cache so deep
  // links into a notification don't trigger a new /api/rules/ fetch when
  // there's a recent local copy.
  const rulesQuery = useQuery<RuleRead[]>({
    queryKey: RULES_QUERY_KEY,
    queryFn: async () => {
      const result = await fetchRules(pairing);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      await writeCachedRules(result.items);
      return result.items;
    },
    initialData: initialCachedRules ?? undefined,
    initialDataUpdatedAt:
      initialCachedRules !== null && initialCachedRulesFetchedAtMs !== null
        ? initialCachedRulesFetchedAtMs
        : undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const notification = notificationQuery.data;
  const ruleId = notification?.rule_id ?? null;

  const cachedRule = useMemo<RuleRead | null>(() => {
    if (ruleId === null) return null;
    const rules = rulesQuery.data;
    if (!rules) return null;
    return rules.find((r) => r.id === ruleId) ?? null;
  }, [ruleId, rulesQuery.data]);

  // Spec: if rule_id is set but the rule isn't in the (already-resolved)
  // rules cache, re-fetch /api/rules/{id} on demand. 404 → deleted-rule
  // label. The single-rule fetch is gated on the rules query having
  // resolved (success or error) so we don't double-request the rule
  // before the list has had its turn.
  const shouldFetchSingleRule =
    ruleId !== null &&
    cachedRule === null &&
    !rulesQuery.isPending &&
    !rulesQuery.isFetching;

  const singleRuleQuery = useQuery<RuleRead>({
    queryKey: RULE_QUERY_KEY(ruleId ?? '_'),
    queryFn: async () => {
      const result = await fetchRule(pairing, ruleId!);
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
          notFound: result.reason === 'not_found',
        });
      }
      return result.rule;
    },
    enabled: shouldFetchSingleRule,
    staleTime: STALE_MS,
    retry: false,
  });

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await Promise.all([
          notificationQuery.refetch(),
          rulesQuery.refetch(),
        ]);
      } finally {
        event.detail.complete();
      }
    },
    [notificationQuery, rulesQuery],
  );

  const onCopyTargetEntityId = useCallback(
    async (entityId: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(entityId);
        setToastOpen(true);
      } catch {
        // Clipboard unavailable — surface nothing rather than a hard error.
      }
    },
    [],
  );

  const onRuleChipTap = useCallback(
    (id: string): void => {
      history.push(`/rules/${id}`);
    },
    [history],
  );

  if (
    isNotFoundError(notificationQuery.error) &&
    notificationQuery.data === undefined
  ) {
    return (
      <NotFoundCard onBack={() => history.replace('/notifications')} />
    );
  }

  if (notificationQuery.isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center text-neutral-300">
        <p>Loading…</p>
      </div>
    );
  }

  if (notificationQuery.isError || notification === undefined) {
    return (
      <div
        className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-200"
        role="alert"
      >
        <p>Couldn&apos;t load notification.</p>
      </div>
    );
  }

  return (
    <>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>

      <section className="px-4 pt-4" data-testid="notification-detail-pane">
        <div className="flex items-center gap-2">
          <span
            data-testid={`notification-status-pill-${notification.status}`}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusPillClasses(notification.status)}`}
          >
            {statusLabel(notification.status)}
          </span>
          <h1 className="text-xl font-semibold">
            {friendlyNotificationType(notification.notification_type)}
          </h1>
        </div>

        <p
          className="mt-3 whitespace-pre-wrap text-base text-neutral-100"
          data-testid="notification-detail-message"
        >
          {notification.message}
        </p>

        <RuleSection
          ruleId={ruleId}
          cachedRule={cachedRule}
          singleRuleQuery={singleRuleQuery}
          shouldFetchSingleRule={shouldFetchSingleRule}
          onTap={onRuleChipTap}
        />

        <dl className="mt-6 grid grid-cols-1 gap-2 text-sm">
          <Row label="Scheduled">
            {formatAbsolute(notification.scheduled_at)}
          </Row>
          <Row label="Scheduled date">
            {formatScheduledDate(notification.scheduled_date)}
          </Row>
          {notification.expires_at !== null ? (
            <Row label="Expires">{formatAbsolute(notification.expires_at)}</Row>
          ) : null}
          <Row label="Target">
            <span
              className="flex items-center gap-2"
              data-testid="notification-detail-target"
            >
              <span>{notification.target_entity_type} —</span>
              <code
                className="font-mono text-xs"
                data-testid="notification-detail-target-id"
              >
                {notification.target_entity_id}
              </code>
              <IonButton
                size="small"
                fill="clear"
                onClick={() =>
                  onCopyTargetEntityId(notification.target_entity_id)
                }
                data-testid="notification-detail-target-copy"
              >
                Copy
              </IonButton>
            </span>
          </Row>
        </dl>

        {notification.canned_responses !== null &&
        notification.canned_responses.length > 0 ? (
          <div className="mt-4">
            <h2 className="text-sm font-medium text-neutral-300">
              Canned responses
            </h2>
            <div
              className="mt-1 flex flex-wrap gap-1"
              data-testid="notification-detail-canned-responses"
            >
              {notification.canned_responses.map((response) => (
                <IonChip key={response} disabled>
                  {response}
                </IonChip>
              ))}
            </div>
          </div>
        ) : null}

        {notification.response !== null ? (
          <div className="mt-4">
            <h2 className="text-sm font-medium text-neutral-300">Response</h2>
            <p
              className="mt-1 text-neutral-100"
              data-testid="notification-detail-response"
            >
              {notification.response}
            </p>
            {notification.responded_at !== null ? (
              <p className="mt-1">
                <IonText color="medium">
                  <small>{formatAbsolute(notification.responded_at)}</small>
                </IonText>
              </p>
            ) : null}
            {notification.response_note !== null ? (
              <p
                className="mt-2 whitespace-pre-wrap text-neutral-100"
                data-testid="notification-detail-response-note"
              >
                {notification.response_note}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <IonToast
        isOpen={toastOpen}
        message="Copied to clipboard"
        duration={1500}
        onDidDismiss={() => setToastOpen(false)}
      />
    </>
  );
};

interface RuleSectionProps {
  ruleId: string | null;
  cachedRule: RuleRead | null;
  singleRuleQuery: UseQueryResult<RuleRead, Error>;
  shouldFetchSingleRule: boolean;
  onTap: (ruleId: string) => void;
}

const RuleSection: React.FC<RuleSectionProps> = ({
  ruleId,
  cachedRule,
  singleRuleQuery,
  shouldFetchSingleRule,
  onTap,
}) => {
  if (ruleId === null) {
    return (
      <p
        className="mt-4 text-sm"
        data-testid="notification-rule-manual"
      >
        <IonText color="medium">Triggered manually</IonText>
      </p>
    );
  }

  if (cachedRule !== null) {
    return (
      <div className="mt-4" data-testid="notification-rule-resolved">
        <IonChip
          color="primary"
          onClick={() => onTap(cachedRule.id)}
          data-testid={`notification-rule-chip-${cachedRule.id}`}
        >
          <IonLabel>Triggered by rule: {cachedRule.name}</IonLabel>
        </IonChip>
      </div>
    );
  }

  if (shouldFetchSingleRule && singleRuleQuery.isPending) {
    return (
      <p
        className="mt-4 text-sm"
        data-testid="notification-rule-resolving"
      >
        <IonText color="medium">Resolving rule…</IonText>
      </p>
    );
  }

  if (isNotFoundError(singleRuleQuery.error)) {
    return (
      <p
        className="mt-4 text-sm"
        data-testid="notification-rule-deleted"
      >
        <IonText color="medium">
          Triggered by deleted rule (id: {ruleId})
        </IonText>
      </p>
    );
  }

  if (singleRuleQuery.data) {
    return (
      <div className="mt-4" data-testid="notification-rule-resolved">
        <IonChip
          color="primary"
          onClick={() => onTap(singleRuleQuery.data!.id)}
          data-testid={`notification-rule-chip-${singleRuleQuery.data.id}`}
        >
          <IonLabel>
            Triggered by rule: {singleRuleQuery.data.name}
          </IonLabel>
        </IonChip>
      </div>
    );
  }

  // Rule lookup failed for a non-404 reason (network/server/timeout, or the
  // rules-list query itself failed and we never got a single-rule fetch
  // off the ground). Fall back to the rule_id so the audit trail isn't
  // silently lost.
  return (
    <p
      className="mt-4 text-sm"
      data-testid="notification-rule-unresolved"
    >
      <IonText color="medium">Triggered by rule (id: {ruleId})</IonText>
    </p>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex justify-between gap-3">
    <dt className="text-neutral-400">{label}</dt>
    <dd className="text-right">{children}</dd>
  </div>
);

const NotFoundCard: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div
    className="flex h-full w-full flex-col items-center justify-center px-4 text-center text-neutral-300"
    data-testid="notification-not-found"
  >
    <p>Notification not found.</p>
    <IonButton fill="outline" className="mt-3" onClick={onBack}>
      Back to notifications
    </IonButton>
  </div>
);

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'notFound' in error &&
      (error as { notFound: unknown }).notFound === true,
  );
}

export default NotificationDetailPage;
