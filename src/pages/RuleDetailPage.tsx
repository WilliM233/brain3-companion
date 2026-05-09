import { useCallback, useEffect, useState } from 'react';
import {
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
  IonRefresher,
  IonRefresherContent,
  IonText,
  IonTitle,
  IonToast,
  IonToolbar,
  type RefresherEventDetail,
} from '@ionic/react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { useHistory, useParams } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import RuleEnabledPill from '../components/RuleEnabledPill';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchRule,
  fetchRuleFires,
  type RuleRead,
} from '../lib/rules';
import type { NotificationItem } from '../lib/notifications';

const RULE_QUERY_KEY = (id: string): QueryKey => ['rule', id];
const RULE_FIRES_QUERY_KEY = (id: string): QueryKey => ['rule-fires', id];
const STALE_MS = 5 * 60 * 1000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | { kind: 'paired'; pairing: Pairing };

function formatAbsolute(iso: string): string {
  try {
    return format(parseISO(iso), "EEE, MMM d 'at' h:mm a");
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return format(parseISO(iso), 'h:mm a');
  } catch {
    return iso;
  }
}

const RuleDetailPage: React.FC = () => {
  const { ruleId } = useParams<{ ruleId: string }>();
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
            <IonBackButton defaultHref="/rules" />
          </IonButtons>
          <IonTitle>Rule</IonTitle>
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
            <p>Pair the app from Settings to see this rule.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <DetailBody ruleId={ruleId} pairing={bootstrap.pairing} />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  ruleId: string;
  pairing: Pairing;
}

const DetailBody: React.FC<BodyProps> = ({ ruleId, pairing }) => {
  const history = useHistory();
  const [toastOpen, setToastOpen] = useState(false);

  const ruleQuery = useQuery<RuleRead>({
    queryKey: RULE_QUERY_KEY(ruleId),
    queryFn: async () => {
      const result = await fetchRule(pairing, ruleId);
      if (!result.ok) {
        throw Object.assign(new Error(result.reason), {
          notFound: result.reason === 'not_found',
        });
      }
      return result.rule;
    },
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const firesQuery = useQuery<NotificationItem[]>({
    queryKey: RULE_FIRES_QUERY_KEY(ruleId),
    queryFn: async () => {
      const result = await fetchRuleFires(pairing, ruleId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      return result.items;
    },
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    enabled: !isNotFoundError(ruleQuery.error),
    retry: false,
  });

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await Promise.all([ruleQuery.refetch(), firesQuery.refetch()]);
      } finally {
        event.detail.complete();
      }
    },
    [ruleQuery, firesQuery],
  );

  const onCopyEntityId = useCallback(
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

  const onFireTap = useCallback(
    (notification: NotificationItem): void => {
      history.push(`/notifications/${notification.id}`);
    },
    [history],
  );

  if (isNotFoundError(ruleQuery.error) && !ruleQuery.data) {
    return (
      <NotFoundCard onBack={() => history.replace('/rules')} />
    );
  }

  const rule = ruleQuery.data;
  if (!rule) {
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

      <DefinitionPane rule={rule} onCopyEntityId={onCopyEntityId} />

      <RecentFiresPane
        fires={firesQuery.data}
        loading={firesQuery.isLoading}
        onFireTap={onFireTap}
      />

      <p
        className="mt-6 px-4 pb-8 text-xs text-neutral-400"
        data-testid="rule-phase3-footer"
      >
        Editing rules will arrive in Phase 3.
      </p>

      <IonToast
        isOpen={toastOpen}
        message="Copied to clipboard"
        duration={1500}
        onDidDismiss={() => setToastOpen(false)}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Definition pane
// ---------------------------------------------------------------------------

interface DefinitionProps {
  rule: RuleRead;
  onCopyEntityId: (entityId: string) => void;
}

const DefinitionPane: React.FC<DefinitionProps> = ({ rule, onCopyEntityId }) => {
  const lastTriggered =
    rule.last_triggered_at !== null
      ? formatAbsolute(rule.last_triggered_at)
      : 'Never';

  return (
    <section className="px-4 pt-4" data-testid="rule-definition-pane">
      <div className="flex items-center gap-2">
        <RuleEnabledPill enabled={rule.enabled} />
        <h1 className="text-xl font-semibold">{rule.name}</h1>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-2 text-sm">
        <Row label="Entity type">{rule.entity_type}</Row>
        <Row label="Entity">
          {rule.entity_id !== null ? (
            <span className="flex items-center gap-2">
              <code
                className="font-mono text-xs"
                data-testid="rule-entity-id"
              >
                {rule.entity_id}
              </code>
              <IonButton
                size="small"
                fill="clear"
                onClick={() => onCopyEntityId(rule.entity_id!)}
                data-testid="rule-entity-copy"
              >
                Copy
              </IonButton>
            </span>
          ) : (
            <span data-testid="rule-entity-default">
              Default rule (matches all {rule.entity_type}s)
            </span>
          )}
        </Row>
        <Row label="Condition">
          {rule.metric} {rule.operator} {rule.threshold}
        </Row>
        <Row label="Action">{rule.action}</Row>
        <Row label="Notification type">{rule.notification_type}</Row>
        <Row label="Cooldown">{rule.cooldown_hours} hours</Row>
        <Row label="Default rule">{rule.is_default ? 'Yes' : 'No'}</Row>
        <Row label="Last triggered">{lastTriggered}</Row>
        <Row label="Created">{formatAbsolute(rule.created_at)}</Row>
        <Row label="Updated">{formatAbsolute(rule.updated_at)}</Row>
      </dl>

      <div className="mt-4">
        <h2 className="text-sm font-medium text-neutral-300">
          Message template
        </h2>
        <pre
          className="mt-1 whitespace-pre-wrap rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs"
          data-testid="rule-message-template"
        >
          {rule.message_template}
        </pre>
      </div>
    </section>
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

// ---------------------------------------------------------------------------
// Recent fires
// ---------------------------------------------------------------------------

interface RecentFiresProps {
  fires: NotificationItem[] | undefined;
  loading: boolean;
  onFireTap: (notification: NotificationItem) => void;
}

const RecentFiresPane: React.FC<RecentFiresProps> = ({
  fires,
  loading,
  onFireTap,
}) => {
  if (loading || fires === undefined) {
    return (
      <section
        className="mt-6 px-4 text-sm text-neutral-400"
        data-testid="rule-fires-loading"
      >
        <h2 className="text-base font-medium">Recent fires</h2>
        <p className="mt-1">Loading…</p>
      </section>
    );
  }
  if (fires.length === 0) {
    return (
      <section
        className="mt-6 px-4 text-sm text-neutral-400"
        data-testid="rule-fires-empty"
      >
        <h2 className="text-base font-medium">Recent fires</h2>
        <p className="mt-1">This rule has not fired yet.</p>
      </section>
    );
  }
  return (
    <section className="mt-6" data-testid="rule-fires-list">
      <h2 className="px-4 text-base font-medium">Recent fires</h2>
      <IonList>
        {fires.map((fire) => (
          <IonItem
            key={fire.id}
            button
            onClick={() => onFireTap(fire)}
            data-testid={`rule-fire-${fire.id}`}
          >
            <IonLabel className="ion-text-wrap">
              <h3>{formatAbsolute(fire.scheduled_at)}</h3>
              <p>
                <IonText color="medium">
                  <small>{fire.status}</small>
                </IonText>
              </p>
              <p>{fire.message}</p>
            </IonLabel>
            <IonNote slot="end" className="text-xs">
              {formatTime(fire.scheduled_at)}
            </IonNote>
          </IonItem>
        ))}
      </IonList>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Not-found card
// ---------------------------------------------------------------------------

const NotFoundCard: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div
    className="flex h-full w-full flex-col items-center justify-center px-4 text-center text-neutral-300"
    data-testid="rule-not-found"
  >
    <p>Rule not found.</p>
    <IonButton fill="outline" className="mt-3" onClick={onBack}>
      Back to rules
    </IonButton>
  </div>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'notFound' in error &&
      (error as { notFound: unknown }).notFound === true,
  );
}

export default RuleDetailPage;
