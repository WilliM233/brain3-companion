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
import { useQuery } from '@tanstack/react-query';
import { useHistory } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import RuleEnabledPill from '../components/RuleEnabledPill';
import StalenessBanner from '../components/StalenessBanner';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  RULES_QUERY_KEY,
  fetchRules,
  formatRelativeFiredAt,
  readCachedRules,
  sortRulesForList,
  writeCachedRules,
  type RuleRead,
} from '../lib/rules';

const RULES_STALE_MS = 5 * 60 * 1000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | {
      kind: 'paired';
      pairing: Pairing;
      cachedItems: RuleRead[] | null;
      cachedFetchedAtMs: number | null;
    };

const RulesPage: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pairing, cached] = await Promise.all([
        loadPairing(),
        readCachedRules(),
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
          <IonTitle>Rules</IonTitle>
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
            <p>Pair the app from Settings to see rules.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <RulesBody
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
  initialCachedItems: RuleRead[] | null;
  initialCachedFetchedAtMs: number | null;
}

const RulesBody: React.FC<BodyProps> = ({
  pairing,
  initialCachedItems,
  initialCachedFetchedAtMs,
}) => {
  const history = useHistory();

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
    initialData: initialCachedItems ?? undefined,
    initialDataUpdatedAt:
      initialCachedItems !== null && initialCachedFetchedAtMs !== null
        ? initialCachedFetchedAtMs
        : undefined,
    staleTime: RULES_STALE_MS,
    refetchOnWindowFocus: true,
  });

  const items = rulesQuery.data;

  const sorted = useMemo(
    () => (items ? sortRulesForList(items) : null),
    [items],
  );

  const handleRefresh = useCallback(
    async (event: CustomEvent<RefresherEventDetail>): Promise<void> => {
      try {
        await rulesQuery.refetch();
      } finally {
        event.detail.complete();
      }
    },
    [rulesQuery],
  );

  const onRowClick = useCallback(
    (rule: RuleRead): void => {
      history.push(`/rules/${rule.id}`);
    },
    [history],
  );

  return (
    <>
      <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
        <IonRefresherContent />
      </IonRefresher>

      <StalenessBanner />

      {sorted !== null && sorted.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-300">
          <p>No rules yet. Create rules via brain3 CLI or API.</p>
        </div>
      ) : null}

      {sorted !== null && sorted.length > 0 ? (
        <IonList>
          {sorted.map((rule) => (
            <RuleRow key={rule.id} rule={rule} onRowClick={onRowClick} />
          ))}
        </IonList>
      ) : null}
    </>
  );
};

interface RowProps {
  rule: RuleRead;
  onRowClick: (rule: RuleRead) => void;
}

const RuleRow: React.FC<RowProps> = ({ rule, onRowClick }) => {
  const conditionLine = `${rule.entity_type} — ${rule.metric} ${rule.operator} ${rule.threshold}`;
  const notificationLine = `→ ${rule.notification_type}`;
  return (
    <IonItem
      button
      onClick={() => onRowClick(rule)}
      data-testid={`rule-row-${rule.id}`}
    >
      <IonLabel className="ion-text-wrap">
        <h2>{rule.name}</h2>
        <p>
          <IonText color="medium">
            <small>{conditionLine}</small>
          </IonText>
        </p>
        <p>
          <IonText color="medium">
            <small>{notificationLine}</small>
          </IonText>
        </p>
      </IonLabel>
      <div slot="end" className="flex flex-col items-end gap-1">
        <RuleEnabledPill enabled={rule.enabled} />
        <IonNote className="text-xs">
          {formatRelativeFiredAt(rule.last_triggered_at)}
        </IonNote>
      </div>
    </IonItem>
  );
};

export default RulesPage;
