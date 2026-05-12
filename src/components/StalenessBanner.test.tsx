/**
 * [2C-28] StalenessBanner unit tests. Drives the [2C-27] connection store
 * directly via the test escape hatch so the banner's visibility and copy can
 * be exercised across all four `ConnectionStatus` values without mounting
 * the provider or any real plugin listeners.
 *
 * Test paths: co-located per repo CLAUDE.md v3 ("Tests are co-located with
 * the module they test"). Spec named `tests/unit/stalenessBanner.spec.tsx`;
 * deferring to canonical-source pattern per org-level directive `ba044399`
 * — flagged as Deviation #1 in the PR body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import StalenessBanner from './StalenessBanner';
import {
  __resetForTests,
  recordOutcome,
  setFlushing,
  setNetworkOnline,
} from '../lib/connection/store';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  __resetForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  __resetForTests();
});

function settle(): void {
  // Banner debounce + any re-renders.
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('StalenessBanner — visibility', () => {
  it('is hidden when status is connected', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);
    render(<StalenessBanner />);
    settle();
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });

  it('is hidden when status is syncing', () => {
    setNetworkOnline(true);
    setFlushing(true, NOW);
    render(<StalenessBanner />);
    settle();
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });

  it('renders when status is offline (network down)', () => {
    setNetworkOnline(false);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveAttribute(
      'data-connection-status',
      'offline',
    );
  });

  it('renders when status is degraded (two 5xx in a row)', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW - 1_000);
    recordOutcome('server_error', ['habits'], NOW);
    recordOutcome('server_error', ['habits'], NOW + 100);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveAttribute(
      'data-connection-status',
      'degraded',
    );
  });

  it('debounces visibility transitions by 250 ms', () => {
    // Start connected.
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW);
    const { rerender } = render(<StalenessBanner />);
    settle();
    expect(screen.queryByTestId('staleness-banner')).toBeNull();

    // Flip to offline; banner does NOT appear immediately.
    setNetworkOnline(false);
    rerender(<StalenessBanner />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByTestId('staleness-banner')).toBeNull();

    // After 250 ms total, banner appears.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('staleness-banner')).toBeInTheDocument();
  });
});

describe('StalenessBanner — copy', () => {
  it('offline + lastSyncedAt → "Showing cached data — last synced X ago"', () => {
    // 5 minutes ago.
    setNetworkOnline(false);
    recordOutcome('success', ['habits'], NOW - 5 * 60 * 1000);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'Showing cached data — last synced 5 minutes ago',
    );
  });

  it('offline + null lastSyncedAt → "never synced" copy', () => {
    setNetworkOnline(false);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'Showing cached data — never synced. Pull down to refresh.',
    );
  });

  it('degraded + lastSyncedAt → "Connection issues — last synced X ago"', () => {
    setNetworkOnline(true);
    recordOutcome('success', ['habits'], NOW - 2 * 60 * 1000);
    recordOutcome('server_error', ['habits'], NOW - 1_000);
    recordOutcome('server_error', ['habits'], NOW);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'Connection issues — last synced 2 minutes ago',
    );
  });

  it('per-surface lastSyncedAt prop overrides the hook value', () => {
    setNetworkOnline(false);
    // Hook would report NOW - 1 min; surface override is NOW - 15 min.
    recordOutcome('success', ['habits'], NOW - 60 * 1000);
    render(<StalenessBanner lastSyncedAt={NOW - 15 * 60 * 1000} />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'last synced 15 minutes ago',
    );
  });

  it('per-surface null prop forces "never synced" copy', () => {
    setNetworkOnline(false);
    // Hook reports a recent success but the surface explicitly passes null
    // because its own queries have not loaded yet.
    recordOutcome('success', ['habits'], NOW - 60 * 1000);
    render(<StalenessBanner lastSyncedAt={null} />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'never synced',
    );
  });
});

describe('StalenessBanner — degraded + null lastSyncedAt edge case', () => {
  it('falls through to the "never synced" copy when degraded with no prior success', () => {
    // Two 5xx in a row with no prior success → degraded + null lastSyncedAt.
    setNetworkOnline(true);
    recordOutcome('server_error', ['habits'], NOW);
    recordOutcome('server_error', ['habits'], NOW + 100);
    render(<StalenessBanner />);
    settle();
    expect(screen.getByTestId('staleness-banner')).toHaveTextContent(
      'Showing cached data — never synced. Pull down to refresh.',
    );
  });
});
