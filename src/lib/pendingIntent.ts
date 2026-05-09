/**
 * Drains the native-side pending-intent slot ([2C-19]).
 *
 * The Kotlin `PendingIntentStore` writes a single JSON entry to the
 * Capacitor Preferences key `brain.pendingIntent` when the user taps an
 * action that needs to drive a JS-side navigation — currently only the
 * `add_note` action on a `checkin_prompt` notification. The JS side reads
 * the slot on app mount and on `appStateChange.active`, navigates, and
 * clears the slot.
 *
 * Single-slot semantics: a second native write before JS drains overwrites
 * the previous one. Designed for low-frequency intents — at most one in
 * flight at any time. If a second intent shape gets added to the slot in
 * the future, extend the `PendingIntent` discriminated union below.
 */

import { Preferences } from '@capacitor/preferences';

export const PENDING_INTENT_KEY = 'brain.pendingIntent';

export interface AddNotePendingIntent {
  kind: 'add_note';
  notification_id: string;
  /** Pre-selected canned response from the source notification, or null. */
  canned_response: string | null;
  enqueued_at: string;
}

export type PendingIntent = AddNotePendingIntent;

/**
 * Read the pending-intent slot. Returns `null` when empty or malformed.
 * Does not clear the slot — call {@link clearPendingIntent} after acting
 * so a re-read (e.g., next `appStateChange.active`) doesn't fire twice.
 */
export async function readPendingIntent(): Promise<PendingIntent | null> {
  const { value } = await Preferences.get({ key: PENDING_INTENT_KEY });
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('kind' in parsed)
    ) {
      return null;
    }
    const kind = (parsed as { kind: unknown }).kind;
    if (kind === 'add_note') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.notification_id !== 'string' || obj.notification_id === '') {
        return null;
      }
      const cannedRaw = obj.canned_response;
      const canned =
        typeof cannedRaw === 'string' && cannedRaw.length > 0 ? cannedRaw : null;
      const enqueuedAt =
        typeof obj.enqueued_at === 'string' ? obj.enqueued_at : '';
      return {
        kind: 'add_note',
        notification_id: obj.notification_id,
        canned_response: canned,
        enqueued_at: enqueuedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearPendingIntent(): Promise<void> {
  await Preferences.remove({ key: PENDING_INTENT_KEY });
}

/**
 * Build the route to navigate to for a given pending intent.
 */
export function pendingIntentRoute(intent: PendingIntent): string {
  switch (intent.kind) {
    case 'add_note': {
      const params = new URLSearchParams();
      if (intent.canned_response !== null) {
        params.set('canned', intent.canned_response);
      }
      const query = params.toString();
      return query.length > 0
        ? `/checkins/notes/${intent.notification_id}?${query}`
        : `/checkins/notes/${intent.notification_id}`;
    }
  }
}
