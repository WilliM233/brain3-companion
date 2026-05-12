/**
 * [2C-31] Wipe-on-token-change integration tests on SettingsPage. Co-located
 * per repo CLAUDE.md v3; spec named
 * `tests/integration/cacheWipeOnTokenChange.spec.tsx` — see PR body
 * Deviation #1 (precedent: [2C-28] PR #73, [2C-30] PR #74).
 *
 * Covers Acceptance criteria #2:
 *   - wipe gated on successful validation (typo case does NOT wipe)
 *   - wipe on token diff
 *   - wipe on URL diff
 *   - confirmation modal flow (Continue + Cancel)
 *   - queue keys included in wipe set (live + failures + counters)
 *
 * Per-token idempotency + the "Setting up…" overlay state transitions are
 * covered in `cacheSeed.test.ts`. The wipe filter contract is covered in
 * `cacheWipe.test.ts`. This file proves the wiring through the Connect
 * handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    keys: vi.fn(),
  },
}));

vi.mock('../lib/health', () => ({
  pingHealth: vi.fn(),
}));

vi.mock('../lib/device-registration', () => ({
  getRegistrationStatus: () => ({ kind: 'idle' }),
  subscribeRegistration: () => () => undefined,
  reRegisterDevice: vi.fn(),
}));

// Avoid the connection store side-effects (Network listener, etc.) — the
// indicator is a header chip and not exercised by these tests.
vi.mock('../components/ConnectionIndicator', () => ({
  default: () => null,
}));

vi.mock('../components/PendingSyncSection', () => ({
  default: () => null,
}));

vi.mock('../components/ClearLocalCacheSection', () => ({
  default: () => null,
}));

// IonAlert + IonToast use shadow-DOM internals that jsdom does not
// exercise. IonInput is a custom element whose `value` and `onIonInput`
// don't round-trip through jsdom's native `input` event the way a plain
// `<input>` does. Replace all three with thin wrappers exposing the same
// prop contract via plain DOM — same pattern as
// `ClearLocalCacheSection.test.tsx`.
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
  interface IonInputProps {
    type?: string;
    inputMode?: string;
    placeholder?: string;
    value?: string | number | null;
    onIonInput?: (event: { detail: { value: string | null } }) => void;
    onIonBlur?: () => void;
  }
  interface IonButtonProps {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
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
  const IonInput: React.FC<IonInputProps> = ({
    type,
    placeholder,
    value,
    onIonInput,
    onIonBlur,
  }) => (
    <input
      type={type === 'password' ? 'password' : type ?? 'text'}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(event) =>
        onIonInput?.({ detail: { value: event.target.value } })
      }
      onBlur={() => onIonBlur?.()}
    />
  );
  const IonButton: React.FC<IonButtonProps> = ({
    children,
    disabled,
    onClick,
  }) => (
    <button type="button" disabled={!!disabled} onClick={() => onClick?.()}>
      {children}
    </button>
  );
  return { ...actual, IonAlert, IonToast, IonInput, IonButton };
});

import { Preferences } from '@capacitor/preferences';
import { pingHealth } from '../lib/health';
import {
  PAIRING_PREVIOUS_URL_KEY,
  PAIRING_TOKEN_HASH_KEY,
  PAIRING_TOKEN_KEY,
  PAIRING_URL_KEY,
  computeTokenHash,
} from '../lib/pairing';
import SettingsPage from './SettingsPage';

const prefsStore = new Map<string, string>();

const PAIRED_URL = 'https://brain.local:8000';
const OTHER_URL = 'https://brain.other:8000';

function withProviders(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

async function seedMarkers(url: string, token: string): Promise<void> {
  const hash = await computeTokenHash(token);
  prefsStore.set(PAIRING_TOKEN_HASH_KEY, hash);
  prefsStore.set(PAIRING_PREVIOUS_URL_KEY, url);
}

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.keys).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: prefsStore.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    prefsStore.set(key, value);
  });
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    prefsStore.delete(key);
  });
  vi.mocked(Preferences.keys).mockImplementation(async () => ({
    keys: Array.from(prefsStore.keys()),
  }));
  vi.mocked(pingHealth).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function fillFormAndSubmit(
  url: string,
  token: string,
): Promise<void> {
  const user = userEvent.setup();
  // Form-only mode requires loadPairing → null (no pairing keys set in
  // prefsStore).
  const urlInput = await screen.findByPlaceholderText('https://brain.local:8000');
  const tokenInput = await screen.findByPlaceholderText(
    'Paste token from brain3 token generate',
  );
  // The mocked IonInput is a plain `<input>` — `fireEvent.change` updates
  // its value and fires the React `onChange` handler, which the mock
  // forwards to `onIonInput` so the page-level state updates.
  fireEvent.change(urlInput, { target: { value: url } });
  fireEvent.change(tokenInput, { target: { value: token } });
  const connectButton = screen.getByRole('button', { name: 'Connect' });
  await user.click(connectButton);
}

describe('SettingsPage [2C-31] wipe-on-token-change', () => {
  it('fresh pair (no markers): pingHealth.ok → no wipe modal → savePairing fires', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    const qc = new QueryClient();
    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'token-AAA');

    await waitFor(() => {
      expect(prefsStore.get(PAIRING_URL_KEY)).toBe(PAIRED_URL);
    });
    expect(prefsStore.get(PAIRING_TOKEN_KEY)).toBe('token-AAA');
    expect(screen.queryByTestId('alert')).toBeNull();
  });

  it('re-pair with same token + URL: pingHealth.ok → markers match → no wipe modal', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    const qc = new QueryClient();
    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'token-AAA');

    await waitFor(() => {
      expect(prefsStore.get(PAIRING_TOKEN_KEY)).toBe('token-AAA');
    });
    expect(screen.queryByTestId('alert')).toBeNull();
  });

  it('token typo (MV step 3): pingHealth.unauthorized → no wipe modal, markers intact, cache intact', async () => {
    vi.mocked(pingHealth).mockResolvedValue({
      ok: false,
      reason: 'unauthorized',
      statusCode: 401,
    });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    prefsStore.set('brain.cache.habits.active', '[{"id":"h1"}]');
    prefsStore.set('brain.writeQueue', '[{}]');
    const qc = new QueryClient();
    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'wrongtoken');

    // Wait for the error message to surface so we know the handler ran.
    await screen.findByText('Token invalid. Check and try again.');
    // No wipe modal.
    expect(screen.queryByTestId('alert')).toBeNull();
    // Markers, cache, and queue from previous pairing all intact.
    expect(prefsStore.get(PAIRING_TOKEN_HASH_KEY)).toBe(
      await computeTokenHash('token-AAA'),
    );
    expect(prefsStore.get(PAIRING_PREVIOUS_URL_KEY)).toBe(PAIRED_URL);
    expect(prefsStore.get('brain.cache.habits.active')).toBe('[{"id":"h1"}]');
    expect(prefsStore.get('brain.writeQueue')).toBe('[{}]');
    // No new pairing was committed.
    expect(prefsStore.has(PAIRING_URL_KEY)).toBe(false);
    expect(prefsStore.has(PAIRING_TOKEN_KEY)).toBe(false);
  });

  it('token change: pingHealth.ok with different token hash → wipe modal opens', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    const qc = new QueryClient();
    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'token-BBB');

    expect(await screen.findByTestId('alert')).toBeDefined();
    expect(
      screen.getByText(/clear all cached data and any pending sync items/i),
    ).toBeDefined();
    // Modal is pre-commit — no pairing keys have been written yet.
    expect(prefsStore.has(PAIRING_URL_KEY)).toBe(false);
    expect(prefsStore.has(PAIRING_TOKEN_KEY)).toBe(false);
  });

  it('URL change with same token: pingHealth.ok with different URL → wipe modal opens', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    const qc = new QueryClient();
    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(OTHER_URL, 'token-AAA');

    expect(await screen.findByTestId('alert')).toBeDefined();
  });

  it('modal Confirm: wipes cache + queue keys, saves new pairing, updates markers', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    prefsStore.set('brain.cache.habits.active', '[{"id":"h1"}]');
    prefsStore.set('brain.cache.notifications', '[]');
    prefsStore.set('brain.cache.seedCompleteFor', 'old-hash');
    prefsStore.set('brain.writeQueue', '[{}]');
    prefsStore.set('brain.writeQueue.habitCompletions', '[{}]');
    prefsStore.set('brain.writeQueue.failures.totalDropsCount', '2');
    prefsStore.set('brain.writeQueue.failures.seenCount', '0');
    const qc = new QueryClient();
    qc.setQueryData(['habits', 'active'], [{ id: 'h1' }]);

    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'token-BBB');
    const modal = await screen.findByTestId('alert');
    expect(modal).toBeDefined();

    const continueButton = screen.getByTestId('alert-button-1');
    expect(continueButton.getAttribute('data-role')).toBe('destructive');
    const user = userEvent.setup();
    await user.click(continueButton);

    await waitFor(() => {
      expect(prefsStore.get(PAIRING_TOKEN_KEY)).toBe('token-BBB');
    });
    // Cache + queue keys wiped.
    expect(prefsStore.has('brain.cache.habits.active')).toBe(false);
    expect(prefsStore.has('brain.cache.notifications')).toBe(false);
    expect(prefsStore.has('brain.cache.seedCompleteFor')).toBe(false);
    expect(prefsStore.has('brain.writeQueue')).toBe(false);
    expect(prefsStore.has('brain.writeQueue.habitCompletions')).toBe(false);
    expect(prefsStore.has('brain.writeQueue.failures.totalDropsCount')).toBe(
      false,
    );
    expect(prefsStore.has('brain.writeQueue.failures.seenCount')).toBe(false);
    // TanStack cache cleared.
    expect(qc.getQueryData(['habits', 'active'])).toBeUndefined();
    // New pairing committed.
    expect(prefsStore.get(PAIRING_URL_KEY)).toBe(PAIRED_URL);
    // Markers updated to the new token.
    const newHash = await computeTokenHash('token-BBB');
    expect(prefsStore.get(PAIRING_TOKEN_HASH_KEY)).toBe(newHash);
    expect(prefsStore.get(PAIRING_PREVIOUS_URL_KEY)).toBe(PAIRED_URL);
  });

  it('modal Cancel: no wipe, no save, previous pairing data intact', async () => {
    vi.mocked(pingHealth).mockResolvedValue({ ok: true });
    await seedMarkers(PAIRED_URL, 'token-AAA');
    prefsStore.set('brain.cache.habits.active', '[{"id":"h1"}]');
    prefsStore.set('brain.writeQueue', '[{}]');
    const qc = new QueryClient();
    qc.setQueryData(['habits', 'active'], [{ id: 'h1' }]);

    render(<SettingsPage />, { wrapper: withProviders(qc) });

    await fillFormAndSubmit(PAIRED_URL, 'token-BBB');
    await screen.findByTestId('alert');

    const cancelButton = screen.getByTestId('alert-button-0');
    expect(cancelButton.getAttribute('data-role')).toBe('cancel');
    const user = userEvent.setup();
    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId('alert')).toBeNull();
    });
    // No wipe, no save.
    expect(prefsStore.get('brain.cache.habits.active')).toBe('[{"id":"h1"}]');
    expect(prefsStore.get('brain.writeQueue')).toBe('[{}]');
    expect(prefsStore.has(PAIRING_URL_KEY)).toBe(false);
    expect(prefsStore.has(PAIRING_TOKEN_KEY)).toBe(false);
    expect(prefsStore.get(PAIRING_TOKEN_HASH_KEY)).toBe(
      await computeTokenHash('token-AAA'),
    );
    expect(qc.getQueryData(['habits', 'active'])).toBeDefined();
  });
});
