/**
 * [2C-29] Exponential-backoff scheduling for write-queue flushes.
 *
 * Covers the factory-level retry policy: schedule progression
 * (30s → 60s → 2m → 4m → 8m → 15m), attempt-counter reset on a delivered
 * entry, foreground / reachable preemption of the pending timer, and
 * Retry-After honoring for 429.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => ({ connected: true, connectionType: 'wifi' })),
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
import {
  __resetForTests,
  BACKOFF_CAP_MS,
  BACKOFF_INITIAL_DELAY_MS,
  BACKOFF_MULTIPLIER,
  createWriteQueue,
  parseRetryAfter,
  type FlushOutcome,
} from './writeQueue';
import {
  __resetFlushStateForTests,
  getFlushDetail,
  subscribeFlushDetail,
  type FlushDetail,
} from './connection/writeQueueFlushState';

const KEY = 'brain.test.backoffQueue';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  vi.useFakeTimers();
  __resetForTests();
  __resetFlushStateForTests();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Entry {
  id: string;
}

function makeQueueWithOutcomes(outcomes: FlushOutcome[]): {
  queue: ReturnType<typeof createWriteQueue<Entry>>;
  flushCalls: () => number;
} {
  let call = 0;
  const queue = createWriteQueue<Entry>(KEY, {
    flushOne: async () => {
      const outcome = outcomes[call] ?? { kind: 'stop' };
      call += 1;
      return outcome;
    },
  });
  return { queue, flushCalls: () => call };
}

describe('createWriteQueue — backoff schedule progression', () => {
  it('matches the canonical schedule 30s → 60s → 2m → 4m → 8m → 15m', () => {
    expect(BACKOFF_INITIAL_DELAY_MS).toBe(30_000);
    expect(BACKOFF_MULTIPLIER).toBe(2);
    expect(BACKOFF_CAP_MS).toBe(900_000);

    // The cap is hit at attempt 5 (30s * 2^5 = 960s clamped to 900s).
    const slot = (n: number): number =>
      Math.min(BACKOFF_INITIAL_DELAY_MS * BACKOFF_MULTIPLIER ** n, BACKOFF_CAP_MS);
    expect([0, 1, 2, 3, 4, 5, 6].map(slot)).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      480_000,
      900_000,
      900_000,
    ]);
  });

  it('schedules the first retry at 30s and progresses to 60s on second halt', async () => {
    const { queue, flushCalls } = makeQueueWithOutcomes([
      { kind: 'stop' },
      { kind: 'stop' },
      { kind: 'stop' },
    ]);
    await queue.enqueue({ id: 'a' });

    await queue.flush();
    expect(flushCalls()).toBe(1);
    let detail = getFlushDetail(KEY);
    expect(detail.status).toBe('backoff');
    const firstRetryAt = detail.nextRetryAt!;
    expect(firstRetryAt - Date.now()).toBeGreaterThanOrEqual(29_999);
    expect(firstRetryAt - Date.now()).toBeLessThanOrEqual(30_001);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(flushCalls()).toBe(2);
    detail = getFlushDetail(KEY);
    expect(detail.status).toBe('backoff');
    expect(detail.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(59_999);
    expect(detail.nextRetryAt! - Date.now()).toBeLessThanOrEqual(60_001);
  });

  it('caps the delay at 15 minutes after the schedule reaches the ceiling', async () => {
    const stops: FlushOutcome[] = Array.from({ length: 10 }, () => ({
      kind: 'stop' as const,
    }));
    const { queue, flushCalls } = makeQueueWithOutcomes(stops);
    await queue.enqueue({ id: 'a' });

    await queue.flush();
    // Advance through 30s, 60s, 2m, 4m, 8m to get to the cap.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(240_000);
    await vi.advanceTimersByTimeAsync(480_000);
    expect(flushCalls()).toBe(6);
    // Next schedule slot would be 960s; capped to 900s.
    const detail = getFlushDetail(KEY);
    expect(detail.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(BACKOFF_CAP_MS - 1);
    expect(detail.nextRetryAt! - Date.now()).toBeLessThanOrEqual(BACKOFF_CAP_MS + 1);

    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
    expect(flushCalls()).toBe(7);
    // Still at the cap.
    expect(getFlushDetail(KEY).nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(
      BACKOFF_CAP_MS - 1,
    );
  });
});

describe('createWriteQueue — backoff reset on success', () => {
  it('resets the attempt counter to 0 after a flush delivers an entry', async () => {
    let call = 0;
    const queue = createWriteQueue<Entry>(KEY, {
      flushOne: async () => {
        call += 1;
        // First flush halts, scheduled retry succeeds, then we enqueue and
        // halt again to confirm the next schedule restarts at 30s.
        if (call === 1) return { kind: 'stop' };
        if (call === 2) return { kind: 'remove' };
        return { kind: 'stop' };
      },
    });
    await queue.enqueue({ id: 'a' });
    await queue.flush();
    expect(getFlushDetail(KEY).nextRetryAt! - Date.now()).toBeLessThanOrEqual(30_001);

    // Retry succeeds — queue drains, attempt resets, status returns to idle.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getFlushDetail(KEY).status).toBe('idle');

    // Re-enqueue + halt → next schedule should be 30s, not 60s.
    await queue.enqueue({ id: 'b' });
    await queue.flush();
    const detail = getFlushDetail(KEY);
    expect(detail.status).toBe('backoff');
    expect(detail.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(29_999);
    expect(detail.nextRetryAt! - Date.now()).toBeLessThanOrEqual(30_001);
  });

  it('does not schedule a retry when the queue drains on first flush', async () => {
    const queue = createWriteQueue<Entry>(KEY, {
      flushOne: async () => ({ kind: 'remove' }),
    });
    await queue.enqueue({ id: 'a' });
    await queue.enqueue({ id: 'b' });

    const summary = await queue.flush();

    expect(summary.delivered).toBe(2);
    expect(summary.remaining).toBe(0);
    expect(getFlushDetail(KEY).status).toBe('idle');
    expect(getFlushDetail(KEY).nextRetryAt).toBeNull();
  });
});

describe('createWriteQueue — preemption', () => {
  it('cancels the scheduled timer when flush is called manually mid-backoff', async () => {
    const { queue, flushCalls } = makeQueueWithOutcomes([
      { kind: 'stop' },
      { kind: 'remove' },
    ]);
    await queue.enqueue({ id: 'a' });

    await queue.flush();
    expect(flushCalls()).toBe(1);

    // Manual flush before the timer would fire (e.g., foreground or reachable
    // trigger). The factory cancels its own pending timer at the start of
    // each flush.
    await queue.flush();
    expect(flushCalls()).toBe(2);

    // Advance past the original 30s slot — the canceled timer must NOT fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flushCalls()).toBe(2);
  });

  it('emits backoff → idle transitions through the FlushDetail surface', async () => {
    const received: FlushDetail[] = [];
    subscribeFlushDetail((detail) => received.push(detail));

    const { queue } = makeQueueWithOutcomes([
      { kind: 'stop' },
      { kind: 'remove' },
    ]);
    await queue.enqueue({ id: 'a' });

    await queue.flush();
    await vi.advanceTimersByTimeAsync(30_000);

    const statuses = received.map((d) => d.status);
    expect(statuses).toContain('flushing');
    expect(statuses).toContain('backoff');
    expect(statuses[statuses.length - 1]).toBe('idle');
    for (const detail of received) {
      expect(detail.queueKey).toBe(KEY);
    }
  });
});

describe('createWriteQueue — Retry-After override', () => {
  it('uses retryAfterMs from a stop outcome instead of the natural schedule slot', async () => {
    let call = 0;
    const queue = createWriteQueue<Entry>(KEY, {
      flushOne: async () => {
        call += 1;
        if (call === 1) return { kind: 'stop', retryAfterMs: 5_000 };
        return { kind: 'remove' };
      },
    });
    await queue.enqueue({ id: 'a' });

    await queue.flush();
    const detail = getFlushDetail(KEY);
    expect(detail.status).toBe('backoff');
    expect(detail.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(4_999);
    expect(detail.nextRetryAt! - Date.now()).toBeLessThanOrEqual(5_001);

    // The natural 30s slot would have come next — advancing only 5s must
    // trigger the scheduled retry.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call).toBe(2);
  });

  it('falls back to the natural slot when retryAfterMs is null', async () => {
    const { queue } = makeQueueWithOutcomes([
      { kind: 'stop', retryAfterMs: null },
      { kind: 'stop' },
    ]);
    await queue.enqueue({ id: 'a' });
    await queue.flush();

    const detail = getFlushDetail(KEY);
    expect(detail.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(29_999);
    expect(detail.nextRetryAt! - Date.now()).toBeLessThanOrEqual(30_001);
  });
});

describe('parseRetryAfter', () => {
  it('parses a seconds-int header to milliseconds', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter('  30  ')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('clamps values above the cap to the cap', () => {
    expect(parseRetryAfter('99999')).toBe(BACKOFF_CAP_MS);
  });

  it('returns null for malformed inputs', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('abc')).toBeNull();
    // Date-form Retry-After is intentionally unsupported per Pass 5 §3 [2C-29].
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});
