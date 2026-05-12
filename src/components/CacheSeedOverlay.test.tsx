/**
 * [2C-31] CacheSeedOverlay tests. Co-located per repo CLAUDE.md v3; spec
 * named `tests/integration/cacheSeed.spec.tsx` — see PR body Deviation #1.
 *
 * Covers the "Setting up overlay appears and dismisses correctly" sub-item
 * of Acceptance criteria #1: the overlay reads the module-level seed
 * status and renders the loading message during a run, then hides on
 * settle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

vi.mock('../lib/notifications', () => ({
  fetchNotifications: vi.fn(),
  writeCachedNotifications: vi.fn(),
}));
vi.mock('../lib/habits', () => ({
  fetchActiveHabits: vi.fn(),
  writeCachedHabits: vi.fn(),
}));
vi.mock('../lib/routines', () => ({
  fetchActiveRoutines: vi.fn(),
  writeCachedRoutines: vi.fn(),
}));
vi.mock('../lib/rules', () => ({
  fetchRules: vi.fn(),
  writeCachedRules: vi.fn(),
}));
vi.mock('../lib/checkins', () => ({
  fetchCheckins: vi.fn(),
  writeCachedCheckins: vi.fn(),
}));

// IonLoading uses shadow-DOM internals that jsdom does not exercise; thin
// wrapper exposing `isOpen` + `message` via a testable element.
vi.mock('@ionic/react', async () => {
  const actual = await vi.importActual<typeof import('@ionic/react')>(
    '@ionic/react',
  );
  interface IonLoadingProps {
    isOpen: boolean;
    message?: string;
    'data-testid'?: string;
  }
  const IonLoading: React.FC<IonLoadingProps> = ({
    isOpen,
    message,
    ...rest
  }) =>
    isOpen ? (
      <div role="status" data-testid={rest['data-testid'] ?? 'loading'}>
        {message ?? ''}
      </div>
    ) : null;
  return { ...actual, IonLoading };
});

import { Preferences } from '@capacitor/preferences';
import { fetchNotifications, writeCachedNotifications } from '../lib/notifications';
import { fetchActiveHabits, writeCachedHabits } from '../lib/habits';
import { fetchActiveRoutines, writeCachedRoutines } from '../lib/routines';
import { fetchRules, writeCachedRules } from '../lib/rules';
import { fetchCheckins, writeCachedCheckins } from '../lib/checkins';
import CacheSeedOverlay from './CacheSeedOverlay';
import { __resetCacheSeedForTests, runCacheSeed } from '../lib/cacheSeed';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  prefsStore.clear();
  __resetCacheSeedForTests();
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

  vi.mocked(fetchNotifications).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchActiveHabits).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchActiveRoutines).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchRules).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(fetchCheckins).mockResolvedValue({ ok: true, items: [] });
  vi.mocked(writeCachedNotifications).mockResolvedValue();
  vi.mocked(writeCachedHabits).mockResolvedValue();
  vi.mocked(writeCachedRoutines).mockResolvedValue();
  vi.mocked(writeCachedRules).mockResolvedValue();
  vi.mocked(writeCachedCheckins).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CacheSeedOverlay', () => {
  it('is hidden when the seed status is idle', () => {
    render(<CacheSeedOverlay />);
    expect(screen.queryByTestId('cache-seed-overlay')).toBeNull();
  });

  it('renders the "Setting up…" message while a seed runs, then hides on settle', async () => {
    // Hold one fetch open so we can observe the overlay during the run.
    const releasers: Array<() => void> = [];
    vi.mocked(fetchActiveHabits).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasers.push(() => resolve({ ok: true, items: [] }));
        }),
    );

    render(<CacheSeedOverlay />);
    expect(screen.queryByTestId('cache-seed-overlay')).toBeNull();

    const work = runCacheSeed({
      url: 'https://brain.local:8000',
      token: 'token-AAA',
    });

    const overlay = await screen.findByTestId('cache-seed-overlay');
    expect(overlay.textContent).toBe('Setting up…');

    for (const release of releasers) release();
    await work;
    await waitFor(() =>
      expect(screen.queryByTestId('cache-seed-overlay')).toBeNull(),
    );
  });
});
