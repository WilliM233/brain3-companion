/**
 * [2C-30] ClearLocalCacheSection UI tests. Co-located per repo CLAUDE.md v3;
 * spec named `tests/integration/settingsClearCache.spec.tsx` — see PR body
 * Deviation #1 (precedent: [2C-28] PR #73).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

// IonAlert and IonToast use shadow-DOM internals that jsdom does not exercise.
// Replace with thin wrappers exposing the same prop contract via plain DOM —
// same pattern as src/pages/HabitDetailPage.test.tsx.
vi.mock('@ionic/react', async () => {
  const actual = await vi.importActual<typeof import('@ionic/react')>(
    '@ionic/react',
  );
  type AlertButton = {
    text: string;
    role?: string;
    handler?: () => void;
  };
  interface IonAlertProps {
    isOpen: boolean;
    header?: string;
    message?: string;
    buttons?: AlertButton[];
    onDidDismiss?: () => void;
  }
  interface IonToastProps {
    isOpen: boolean;
    message?: string;
  }
  const IonAlert: React.FC<IonAlertProps> = ({
    isOpen,
    header,
    message,
    buttons,
    onDidDismiss,
  }) =>
    isOpen ? (
      <div role="alertdialog" aria-label={header} data-testid="alert">
        {header ? <h2>{header}</h2> : null}
        {message ? <p>{message}</p> : null}
        {(buttons ?? []).map((b, i) => (
          <button
            key={i}
            type="button"
            data-testid={`alert-button-${i}`}
            data-role={b.role ?? 'action'}
            onClick={() => {
              b.handler?.();
              onDidDismiss?.();
            }}
          >
            {b.text}
          </button>
        ))}
      </div>
    ) : null;
  const IonToast: React.FC<IonToastProps> = ({ isOpen, message }) =>
    isOpen ? (
      <div role="status" data-testid="toast">
        {message ?? ''}
      </div>
    ) : null;
  return { ...actual, IonAlert, IonToast };
});

import { Preferences } from '@capacitor/preferences';
import ClearLocalCacheSection from './ClearLocalCacheSection';

const prefsStore = new Map<string, string>();

function withQueryClient(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.keys).mockReset();
  vi.mocked(Preferences.keys).mockImplementation(async () => ({
    keys: Array.from(prefsStore.keys()),
  }));
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ClearLocalCacheSection', () => {
  it('opens the confirm modal when the button is tapped', async () => {
    const qc = new QueryClient();
    render(<ClearLocalCacheSection />, { wrapper: withQueryClient(qc) });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('clear-cache-button'));
    expect(screen.getByTestId('alert')).toBeDefined();
    expect(screen.getByText(/Pending sync items are NOT cleared/)).toBeDefined();
  });

  it('cancel button dismisses the modal without clearing anything', async () => {
    prefsStore.set('brain.cache.habits.active', '[]');
    prefsStore.set('brain.writeQueue', '[{}]');
    const qc = new QueryClient();
    qc.setQueryData(['habits', 'active'], [{ id: 'h1', title: 't' }]);
    render(<ClearLocalCacheSection />, { wrapper: withQueryClient(qc) });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('clear-cache-button'));
    // First button is "Cancel" (role=cancel).
    const cancelButton = screen.getByTestId('alert-button-0');
    expect(cancelButton.getAttribute('data-role')).toBe('cancel');
    await user.click(cancelButton);
    expect(prefsStore.has('brain.cache.habits.active')).toBe(true);
    expect(prefsStore.has('brain.writeQueue')).toBe(true);
    expect(qc.getQueryData(['habits', 'active'])).toBeDefined();
  });

  it('confirm wipes brain.cache.* keys, preserves brain.writeQueue*, clears query cache, shows toast', async () => {
    prefsStore.set('brain.cache.habits.active', '[]');
    prefsStore.set('brain.cache.routines.active', '[]');
    prefsStore.set('brain.writeQueue', '[{}]');
    prefsStore.set('brain.writeQueue.habitCompletions', '[{}]');
    prefsStore.set('brain.writeQueue.failures.brain.writeQueue', '[{}]');
    prefsStore.set('brain.pairing.url', 'https://x');
    const qc = new QueryClient();
    qc.setQueryData(['habits', 'active'], [{ id: 'h1', title: 't' }]);
    qc.setQueryData(['routines', 'active'], [{ id: 'r1' }]);

    render(<ClearLocalCacheSection />, { wrapper: withQueryClient(qc) });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('clear-cache-button'));
    // Second button is "Confirm".
    const confirmButton = screen.getByTestId('alert-button-1');
    expect(confirmButton.getAttribute('data-role')).toBe('destructive');
    await user.click(confirmButton);

    // Allow the async handler to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
    expect(prefsStore.has('brain.cache.routines.active')).toBe(false);
    expect(prefsStore.has('brain.writeQueue')).toBe(true);
    expect(prefsStore.has('brain.writeQueue.habitCompletions')).toBe(true);
    expect(prefsStore.has('brain.writeQueue.failures.brain.writeQueue')).toBe(
      true,
    );
    expect(prefsStore.has('brain.pairing.url')).toBe(true);
    expect(qc.getQueryData(['habits', 'active'])).toBeUndefined();
    expect(qc.getQueryData(['routines', 'active'])).toBeUndefined();
    expect(await screen.findByTestId('toast')).toBeDefined();
    expect(screen.getByTestId('toast').textContent).toBe('Local cache cleared.');
  });
});
