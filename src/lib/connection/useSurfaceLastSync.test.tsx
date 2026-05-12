/**
 * [2C-28] useSurfaceLastSync — co-located helper test. Exercises the
 * Math.max-over-`dataUpdatedAt` logic by populating a real QueryClient
 * cache (no provider needed; the hook is a synchronous read).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSurfaceLastSync } from './useSurfaceLastSync';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  client = new QueryClient();
});

afterEach(() => {
  client.clear();
});

describe('useSurfaceLastSync', () => {
  it('returns null when no key has been fetched', () => {
    const { result } = renderHook(
      () => useSurfaceLastSync([['habit', 'a'], ['habit-graduation', 'a']]),
      { wrapper },
    );
    expect(result.current).toBeNull();
  });

  it('returns the single dataUpdatedAt when only one key has been fetched', () => {
    const t = 1_700_000_000_000;
    client.setQueryData(['habit', 'a'], { id: 'a' }, { updatedAt: t });
    const { result } = renderHook(
      () => useSurfaceLastSync([['habit', 'a'], ['habit-graduation', 'a']]),
      { wrapper },
    );
    expect(result.current).toBe(t);
  });

  it('returns the max across multiple keys', () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 5_000;
    client.setQueryData(['habit', 'a'], { id: 'a' }, { updatedAt: t1 });
    client.setQueryData(
      ['habit-graduation', 'a'],
      { status: 'accountable' },
      { updatedAt: t2 },
    );
    const { result } = renderHook(
      () => useSurfaceLastSync([['habit', 'a'], ['habit-graduation', 'a']]),
      { wrapper },
    );
    expect(result.current).toBe(t2);
  });

  it('accepts an empty key list', () => {
    const { result } = renderHook(() => useSurfaceLastSync([]), { wrapper });
    expect(result.current).toBeNull();
  });
});
