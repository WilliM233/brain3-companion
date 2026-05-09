import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useHistory: () => ({
      push: pushSpy,
      replace: vi.fn(),
      goBack: vi.fn(),
    }),
  };
});

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import type { NotificationItem } from '../lib/notifications';
import NotificationsPage from './NotificationsPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();

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
  const todayLocal = new Date();
  const yyyyMmDd = `${todayLocal.getFullYear()}-${String(
    todayLocal.getMonth() + 1,
  ).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;
  return {
    id: overrides.id ?? 'n-1',
    notification_type: overrides.notification_type ?? 'habit_nudge',
    delivery_type: overrides.delivery_type ?? 'notification',
    message: overrides.message ?? 'Test message',
    scheduled_at:
      overrides.scheduled_at ?? new Date(Date.now() - 60_000).toISOString(),
    scheduled_date: overrides.scheduled_date ?? yyyyMmDd,
    status: overrides.status ?? 'delivered',
    expires_at:
      overrides.expires_at !== undefined
        ? overrides.expires_at
        : new Date(Date.now() + 3_600_000).toISOString(),
    response: overrides.response ?? null,
    response_note: overrides.response_note ?? null,
    responded_at: overrides.responded_at ?? null,
    canned_responses: overrides.canned_responses ?? null,
    target_entity_type: overrides.target_entity_type ?? 'habit',
    target_entity_id:
      overrides.target_entity_id ?? '11111111-1111-1111-1111-111111111111',
    scheduled_by: overrides.scheduled_by ?? 'system',
    rule_id: overrides.rule_id ?? null,
    created_at: overrides.created_at ?? '2026-05-09T12:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-09T12:00:00Z',
  };
}

function stubNotifications(items: NotificationItem[]) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ items, count: items.length }), {
        status: 200,
      }),
    );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/notifications']}>
        <Route path="/notifications">
          <NotificationsPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

describe('NotificationsPage — tap-through to detail', () => {
  it('pushes /notifications/{id} when a row is tapped', async () => {
    pair();
    stubNotifications([
      makeNotification({ id: 'n-tap', message: 'Tappable item' }),
    ]);

    renderPage();

    const row = await screen.findByTestId('notification-row-n-tap');
    await userEvent.click(row);
    expect(pushSpy).toHaveBeenCalledWith('/notifications/n-tap');
  });
});
