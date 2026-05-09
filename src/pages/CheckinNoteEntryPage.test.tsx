import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Switch } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn(),
    register: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock('@capacitor/device', () => ({
  Device: {
    getInfo: vi.fn(async () => ({ model: 'Pixel 8' })),
  },
}));

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import {
  WRITE_QUEUE_KEY,
  __resetForTests as __resetWriteQueue,
  type WriteQueueEntry,
} from '../lib/writeQueue';
import type { NotificationItem } from '../lib/notifications';
import CheckinNoteEntryPage from './CheckinNoteEntryPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';
const NOTIFICATION_ID = 'note-aaa';
const prefsStore = new Map<string, string>();

beforeEach(() => {
  __resetWriteQueue();
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
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

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
}

function makeNotification(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: NOTIFICATION_ID,
    notification_type: 'checkin_prompt',
    delivery_type: 'push',
    message: 'How are your energy levels right now?',
    scheduled_at: '2026-05-09T10:00:00Z',
    scheduled_date: '2026-05-09',
    status: 'delivered',
    expires_at: null,
    response: null,
    response_note: null,
    responded_at: null,
    canned_responses: ['Energy 3', 'Energy 4', 'Energy 5'],
    target_entity_type: 'goal',
    target_entity_id: 'g-1',
    scheduled_by: 'rule',
    rule_id: null,
    created_at: '2026-05-09T09:00:00Z',
    updated_at: '2026-05-09T10:00:00Z',
    ...overrides,
  };
}

interface StubOptions {
  notification?: { status: number; body?: NotificationItem };
  respond?: { status: number };
  checkin?: { status: number };
}

function stubFetch(opts: StubOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? undefined });
    if (url.endsWith(`/api/notifications/${NOTIFICATION_ID}`)) {
      const n = opts.notification ?? { status: 200, body: makeNotification() };
      if (n.status === 200 && n.body) {
        return new Response(JSON.stringify(n.body), { status: 200 });
      }
      return new Response('', { status: n.status });
    }
    if (url.endsWith(`/api/notifications/${NOTIFICATION_ID}/respond`)) {
      return new Response('', { status: opts.respond?.status ?? 201 });
    }
    if (url.endsWith('/api/checkins/')) {
      return new Response('', { status: opts.checkin?.status ?? 201 });
    }
    return new Response('', { status: 404 });
  });
  return { spy, calls };
}

interface RenderOpts {
  canned?: string;
}

function renderPage(opts: RenderOpts = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const search = opts.canned ? `?canned=${encodeURIComponent(opts.canned)}` : '';
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/checkins/notes/${NOTIFICATION_ID}${search}`]}>
        <Switch>
          <Route exact path="/checkins/notes/:notificationId">
            <CheckinNoteEntryPage />
          </Route>
          <Route exact path="/checkins">
            <div data-testid="checkins-landing">checkins-landing</div>
          </Route>
        </Switch>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function readQueue(): Promise<WriteQueueEntry[]> {
  const raw = prefsStore.get(WRITE_QUEUE_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as WriteQueueEntry[];
}

function setNoteValue(text: string): void {
  // ion-textarea exposes a native textarea via shadow root; in jsdom we
  // fire input on the visible textarea fallback. Capacitor's IonTextarea
  // forwards `onIonInput` from the underlying element's `input` event.
  const textarea = screen.getByLabelText('Note');
  fireEvent.input(textarea, { target: { value: text } });
}

// ---------------------------------------------------------------------------

describe('CheckinNoteEntryPage — render', () => {
  it('shows the unpaired message when the app is not paired', async () => {
    stubFetch();
    renderPage();
    expect(
      await screen.findByText(/pair the app from settings/i),
    ).toBeInTheDocument();
  });

  it('renders the notification message + selected canned chip when ?canned= is present', async () => {
    pair();
    stubFetch();

    renderPage({ canned: 'Energy 4' });

    expect(
      await screen.findByTestId('checkin-note-prompt'),
    ).toHaveTextContent('How are your energy levels');
    expect(screen.getByTestId('checkin-note-canned')).toHaveTextContent(
      'You chose: Energy 4',
    );
  });

  it('omits the canned chip when no ?canned= is present', async () => {
    pair();
    stubFetch();

    renderPage();

    await screen.findByTestId('checkin-note-prompt');
    expect(screen.queryByTestId('checkin-note-canned')).not.toBeInTheDocument();
  });
});

describe('CheckinNoteEntryPage — save flow', () => {
  it('POSTs /respond then /api/checkins/ with parsed canned + note, then navigates to /checkins', async () => {
    pair();
    const { calls } = stubFetch();

    renderPage({ canned: 'Energy 4' });
    await screen.findByTestId('checkin-note-prompt');
    setNoteValue('Pushed hard, dragging now.');

    fireEvent.click(screen.getByTestId('checkin-note-save'));

    await waitFor(() => {
      expect(screen.getByTestId('checkins-landing')).toBeInTheDocument();
    });

    const respondCall = calls.find((c) =>
      c.url.endsWith(`/api/notifications/${NOTIFICATION_ID}/respond`),
    );
    expect(respondCall).toBeDefined();
    expect(JSON.parse(respondCall!.init!.body as string)).toEqual({
      response: 'Energy 4',
      response_note: 'Pushed hard, dragging now.',
    });

    const checkinCall = calls.find((c) => c.url.endsWith('/api/checkins/'));
    expect(checkinCall).toBeDefined();
    expect(JSON.parse(checkinCall!.init!.body as string)).toEqual({
      checkin_type: 'freeform',
      energy_level: 4,
      mood: null,
      focus_level: null,
      freeform_note: 'Pushed hard, dragging now.',
    });
  });

  it('skips /respond when no canned was preselected and POSTs only /api/checkins/', async () => {
    pair();
    const { calls } = stubFetch();

    renderPage();
    await screen.findByTestId('checkin-note-prompt');
    setNoteValue('Just a note.');

    fireEvent.click(screen.getByTestId('checkin-note-save'));

    await waitFor(() => {
      expect(screen.getByTestId('checkins-landing')).toBeInTheDocument();
    });

    expect(
      calls.find((c) =>
        c.url.endsWith(`/api/notifications/${NOTIFICATION_ID}/respond`),
      ),
    ).toBeUndefined();
    expect(
      calls.find((c) => c.url.endsWith('/api/checkins/')),
    ).toBeDefined();
  });

  it('falls back to the offline writeQueue with checkin_payload when /api/checkins/ network-fails', async () => {
    pair();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith(`/api/notifications/${NOTIFICATION_ID}`)) {
        return new Response(JSON.stringify(makeNotification()), { status: 200 });
      }
      if (url.endsWith(`/api/notifications/${NOTIFICATION_ID}/respond`)) {
        return new Response('', { status: 201 });
      }
      if (url.endsWith('/api/checkins/')) {
        throw new Error('network down');
      }
      return new Response('', { status: 404 });
    });

    renderPage({ canned: 'Mood 2' });
    await screen.findByTestId('checkin-note-prompt');
    setNoteValue('Recovered version.');

    fireEvent.click(screen.getByTestId('checkin-note-save'));

    await waitFor(async () => {
      const queue = await readQueue();
      expect(queue).toHaveLength(1);
    });

    const queue = await readQueue();
    expect(queue[0]).toMatchObject({
      notification_id: NOTIFICATION_ID,
      response: 'Mood 2',
      response_note: 'Recovered version.',
      notification_type: 'checkin_prompt',
      checkin_payload: {
        checkin_type: 'freeform',
        energy_level: null,
        mood: 2,
        focus_level: null,
        freeform_note: 'Recovered version.',
      },
    });
  });

  it('shows an inline error and does not navigate when /api/checkins/ returns 422', async () => {
    pair();
    stubFetch({ checkin: { status: 422 } });

    renderPage({ canned: 'Energy 4' });
    await screen.findByTestId('checkin-note-prompt');
    setNoteValue('any note');

    fireEvent.click(screen.getByTestId('checkin-note-save'));

    expect(
      await screen.findByTestId('checkin-note-error'),
    ).toHaveTextContent(/invalid payload/i);
    expect(screen.queryByTestId('checkins-landing')).not.toBeInTheDocument();
  });
});
