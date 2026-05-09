/**
 * Note-entry surface for [2C-19] — the freetext path of the check-in
 * canned-response loop.
 *
 * Reached via the "Add note" action button on a `checkin_prompt` notification
 * (Kotlin amendment to [2C-06]). The Kotlin layer dispatches a
 * `brainAddNoteIntent` window event with the notification id and any
 * pre-selected canned response; `App.tsx` translates that into navigation to
 * `/checkins/notes/:notificationId?canned=<response>`.
 *
 * On Save:
 *   1. Compose a CheckinCreate payload from the canned response (parsed via
 *      `checkin-parser`) + freeform note.
 *   2. POST `/api/notifications/{id}/respond` if a canned response was
 *      pre-selected (records the notification response alongside the
 *      check-in, idempotent per [2C-03]).
 *   3. POST `/api/checkins/` with the composed payload.
 *   4. On any network failure or 5xx, enqueue both writes via the offline
 *      [2C-07] queue (extended in [2C-19] to carry `checkin_payload` /
 *      `notification_type`) and surface a "Saved locally" hint before
 *      navigating to `/checkins`.
 *
 * Note-after-the-fact (a notification already canned-responded earlier) is
 * deferred per the spec's own design-smell flag — the simpler POST path
 * always creates a new check-in. See PR body Deviations.
 */

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
  IonText,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useHistory, useLocation, useParams } from 'react-router-dom';

import ConnectionIndicator from '../components/ConnectionIndicator';
import { composeCheckinFromCanned } from '../lib/checkin-parser';
import { loadPairing, type Pairing } from '../lib/pairing';
import {
  fetchNotification,
  type NotificationItem,
} from '../lib/notifications';
import {
  enqueueResponse,
  flushWriteQueue,
  type CheckinPayload,
} from '../lib/writeQueue';

const NOTIFICATION_QUERY_KEY = (id: string): QueryKey => [
  'notification',
  id,
];
const FREEFORM_MAX_CHARS = 5000;
const STALE_MS = 5 * 60 * 1000;

type Bootstrap =
  | { kind: 'loading' }
  | { kind: 'no-pairing' }
  | { kind: 'paired'; pairing: Pairing };

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

const CheckinNoteEntryPage: React.FC = () => {
  const { notificationId } = useParams<{ notificationId: string }>();
  const location = useLocation();
  const cannedFromQuery = useMemo<string | null>(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('canned');
    return raw && raw.length > 0 ? raw : null;
  }, [location.search]);

  const [bootstrap, setBootstrap] = useState<Bootstrap>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pairing = await loadPairing();
      if (cancelled) return;
      setBootstrap(
        pairing === null
          ? { kind: 'no-pairing' }
          : { kind: 'paired', pairing },
      );
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
          <IonTitle>Add note</IonTitle>
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
            <p>Pair the app from Settings to add a note.</p>
          </div>
        ) : null}

        {bootstrap.kind === 'paired' ? (
          <NoteEntryBody
            pairing={bootstrap.pairing}
            notificationId={notificationId}
            preselectedCanned={cannedFromQuery}
          />
        ) : null}
      </IonContent>
    </IonPage>
  );
};

interface BodyProps {
  pairing: Pairing;
  notificationId: string;
  preselectedCanned: string | null;
}

const NoteEntryBody: React.FC<BodyProps> = ({
  pairing,
  notificationId,
  preselectedCanned,
}) => {
  const history = useHistory();
  const [note, setNote] = useState<string>('');
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [savedLocallyToast, setSavedLocallyToast] = useState(false);

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
    retry: false,
  });

  const onSave = useCallback(async (): Promise<void> => {
    setSaveState({ kind: 'saving' });
    const trimmedNote = note.trim();
    const checkinPayload: CheckinPayload = composeCheckinFromCanned({
      cannedResponse: preselectedCanned,
      freeformNote: trimmedNote.length > 0 ? trimmedNote : null,
    });

    // [2C-19] Save flow: /respond (if canned) → /api/checkins/. On any
    // network or 5xx, fall back to the offline queue (extended in [2C-19]
    // to carry the check-in payload) and notify the user.
    const base = pairing.url.replace(/\/$/, '');
    let respondTransientFailure = false;
    if (preselectedCanned !== null) {
      try {
        const respondResp = await fetch(
          `${base}/api/notifications/${notificationId}/respond`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${pairing.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              response: preselectedCanned,
              response_note: trimmedNote.length > 0 ? trimmedNote : null,
            }),
          },
        );
        // 200/201 = delivered. 409 = already responded; existing write
        // stands and we proceed to /api/checkins/. 4xx terminal we still
        // proceed to the check-in POST — the note is the user's primary
        // intent. 5xx / network → enqueue.
        if (respondResp.status >= 500) respondTransientFailure = true;
      } catch {
        respondTransientFailure = true;
      }
    }

    if (!respondTransientFailure) {
      try {
        const checkinResp = await fetch(`${base}/api/checkins/`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pairing.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkinPayload),
        });
        if (checkinResp.status === 200 || checkinResp.status === 201) {
          history.replace('/checkins');
          return;
        }
        if (checkinResp.status >= 400 && checkinResp.status < 500) {
          const message =
            checkinResp.status === 422
              ? "Couldn't save — invalid payload."
              : `Couldn't save (${checkinResp.status}).`;
          setSaveState({ kind: 'error', message });
          return;
        }
        // 5xx — fall through to enqueue.
      } catch {
        // Network — fall through to enqueue.
      }
    }

    // Offline fallback: enqueue a single entry that carries both the
    // /respond write and the pre-composed check-in payload. The [2C-07]
    // flush handler delivers them in order per entry.
    await enqueueResponse({
      notification_id: notificationId,
      response: preselectedCanned ?? '',
      response_note: trimmedNote.length > 0 ? trimmedNote : null,
      enqueued_at: new Date().toISOString(),
      notification_type: 'checkin_prompt',
      checkin_payload: checkinPayload,
    });
    // Best-effort flush in case connectivity blipped between attempts.
    void flushWriteQueue();
    setSavedLocallyToast(true);
    // Defer navigation so the toast has time to surface.
    setTimeout(() => {
      history.replace('/checkins');
    }, 800);
  }, [history, note, notificationId, pairing, preselectedCanned]);

  if (notificationQuery.isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center text-neutral-300">
        <p>Loading…</p>
      </div>
    );
  }

  if (notificationQuery.isError && notificationQuery.data === undefined) {
    return (
      <div
        className="flex h-full w-full items-center justify-center px-4 text-center text-neutral-200"
        role="alert"
      >
        <p>Couldn&apos;t load notification.</p>
      </div>
    );
  }

  const notification = notificationQuery.data;
  const overLimit = note.length > FREEFORM_MAX_CHARS;
  const saving = saveState.kind === 'saving';

  return (
    <section
      className="flex h-full flex-col px-4 pt-4"
      data-testid="checkin-note-entry-pane"
    >
      {notification ? (
        <p
          className="whitespace-pre-wrap text-base text-neutral-100"
          data-testid="checkin-note-prompt"
        >
          {notification.message}
        </p>
      ) : null}

      {preselectedCanned !== null ? (
        <div className="mt-3" data-testid="checkin-note-canned">
          <IonChip color="primary" disabled>
            <IonLabel>You chose: {preselectedCanned}</IonLabel>
          </IonChip>
        </div>
      ) : null}

      <div className="mt-4 flex-1">
        <IonTextarea
          aria-label="Note"
          autoGrow
          rows={6}
          maxlength={FREEFORM_MAX_CHARS}
          counter
          placeholder="Add a note (optional)…"
          value={note}
          onIonInput={(e) => setNote(e.detail.value ?? '')}
          data-testid="checkin-note-textarea"
        />
        {overLimit ? (
          <p className="mt-1 text-sm text-rose-400" role="alert">
            Note exceeds the {FREEFORM_MAX_CHARS}-character limit.
          </p>
        ) : null}
      </div>

      {saveState.kind === 'error' ? (
        <p
          className="mt-2 text-sm text-rose-400"
          role="alert"
          data-testid="checkin-note-error"
        >
          {saveState.message}
        </p>
      ) : null}

      <div className="py-4">
        <IonButton
          expand="block"
          disabled={saving || overLimit}
          onClick={() => void onSave()}
          data-testid="checkin-note-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </IonButton>
        <p className="pt-2">
          <IonText color="medium">
            <small>
              Tap Save to log a check-in
              {preselectedCanned !== null
                ? ` with "${preselectedCanned}"`
                : ''}
              {note.trim().length > 0 ? ' and your note' : ''}.
            </small>
          </IonText>
        </p>
      </div>

      <IonToast
        isOpen={savedLocallyToast}
        message="Saved locally — will sync when you're online."
        duration={2500}
        onDidDismiss={() => setSavedLocallyToast(false)}
      />
    </section>
  );
};

export default CheckinNoteEntryPage;
