import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import {
  PENDING_INTENT_KEY,
  clearPendingIntent,
  pendingIntentRoute,
  readPendingIntent,
} from './pendingIntent';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefsStore.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readPendingIntent', () => {
  it('returns null when the slot is empty', async () => {
    expect(await readPendingIntent()).toBeNull();
  });

  it('parses an add_note intent with a pre-selected canned response', async () => {
    prefsStore.set(
      PENDING_INTENT_KEY,
      JSON.stringify({
        kind: 'add_note',
        notification_id: 'aaaa',
        canned_response: 'Energy 4',
        enqueued_at: '2026-05-09T10:00:00.000Z',
      }),
    );
    expect(await readPendingIntent()).toEqual({
      kind: 'add_note',
      notification_id: 'aaaa',
      canned_response: 'Energy 4',
      enqueued_at: '2026-05-09T10:00:00.000Z',
    });
  });

  it('treats null canned_response as null (not the string "null")', async () => {
    prefsStore.set(
      PENDING_INTENT_KEY,
      JSON.stringify({
        kind: 'add_note',
        notification_id: 'bbbb',
        canned_response: null,
        enqueued_at: '2026-05-09T10:00:00.000Z',
      }),
    );
    const intent = await readPendingIntent();
    expect(intent?.kind).toBe('add_note');
    expect((intent as { canned_response: string | null } | null)?.canned_response).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    prefsStore.set(PENDING_INTENT_KEY, 'not-json');
    expect(await readPendingIntent()).toBeNull();
  });

  it('returns null when notification_id is missing', async () => {
    prefsStore.set(
      PENDING_INTENT_KEY,
      JSON.stringify({ kind: 'add_note', canned_response: null }),
    );
    expect(await readPendingIntent()).toBeNull();
  });

  it('returns null on an unknown kind so the slot is safely ignored by older clients', async () => {
    prefsStore.set(
      PENDING_INTENT_KEY,
      JSON.stringify({ kind: 'future_kind', notification_id: 'x' }),
    );
    expect(await readPendingIntent()).toBeNull();
  });
});

describe('clearPendingIntent', () => {
  it('removes the slot', async () => {
    prefsStore.set(PENDING_INTENT_KEY, JSON.stringify({ kind: 'add_note', notification_id: 'a' }));
    await clearPendingIntent();
    expect(prefsStore.has(PENDING_INTENT_KEY)).toBe(false);
  });
});

describe('pendingIntentRoute', () => {
  it('builds /checkins/notes/:id?canned=… for a pre-selected canned', () => {
    expect(
      pendingIntentRoute({
        kind: 'add_note',
        notification_id: 'note-1',
        canned_response: 'Energy 5',
        enqueued_at: '',
      }),
    ).toBe('/checkins/notes/note-1?canned=Energy+5');
  });

  it('omits the canned query param when null', () => {
    expect(
      pendingIntentRoute({
        kind: 'add_note',
        notification_id: 'note-1',
        canned_response: null,
        enqueued_at: '',
      }),
    ).toBe('/checkins/notes/note-1');
  });
});
