/**
 * [2C-29] Permanent-failure detection + failures log + foreground toast.
 *
 * Covers HTTP-status classification across the three queues' shared
 * factory, persistence of dropped entries to `brain.writeQueue.failures.*`
 * with FIFO eviction at the 10-entry cap, and the toast counter's dedup
 * semantics across foregrounds.
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
  acknowledgePermanentFailureToast,
  checkPermanentFailuresOnForeground,
  classifyHttpStatus,
  createWriteQueue,
  FAILURES_LOG_CAP,
  readFailures,
  subscribePermanentFailureToast,
  type FlushOutcome,
  type PermanentFailureRecord,
} from './writeQueue';
import { __resetFlushStateForTests } from './connection/writeQueueFlushState';

const KEY = 'brain.test.permFailureQueue';

const prefsStore = new Map<string, string>();

interface Entry {
  id: string;
}

beforeEach(() => {
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
  vi.restoreAllMocks();
});

function makeQueue(outcomes: FlushOutcome[]): {
  queue: ReturnType<typeof createWriteQueue<Entry>>;
} {
  let call = 0;
  return {
    queue: createWriteQueue<Entry>(KEY, {
      flushOne: async () => {
        const outcome = outcomes[call] ?? { kind: 'stop' };
        call += 1;
        return outcome;
      },
    }),
  };
}

describe('classifyHttpStatus', () => {
  it('treats 200/201 as success', () => {
    expect(classifyHttpStatus(200)).toBe('success');
    expect(classifyHttpStatus(201)).toBe('success');
  });

  it('treats 409 as conflict (per-queue UX handles)', () => {
    expect(classifyHttpStatus(409)).toBe('conflict');
  });

  it('treats 400/401/403/404/410/422 as terminal', () => {
    expect(classifyHttpStatus(400)).toBe('terminal');
    expect(classifyHttpStatus(401)).toBe('terminal');
    expect(classifyHttpStatus(403)).toBe('terminal');
    expect(classifyHttpStatus(404)).toBe('terminal');
    expect(classifyHttpStatus(410)).toBe('terminal');
    expect(classifyHttpStatus(422)).toBe('terminal');
  });

  it('treats 408, 429, and 5xx as retryable', () => {
    expect(classifyHttpStatus(408)).toBe('retryable');
    expect(classifyHttpStatus(429)).toBe('retryable');
    expect(classifyHttpStatus(500)).toBe('retryable');
    expect(classifyHttpStatus(502)).toBe('retryable');
    expect(classifyHttpStatus(503)).toBe('retryable');
  });

  it('defaults unknown 4xx (e.g., 405, 411) to retryable to preserve unspecified statuses', () => {
    expect(classifyHttpStatus(405)).toBe('retryable');
    expect(classifyHttpStatus(411)).toBe('retryable');
    expect(classifyHttpStatus(418)).toBe('retryable');
  });
});

describe('terminal-status drops record to the failures log', () => {
  const terminalStatuses = [400, 401, 403, 404, 410, 422] as const;
  for (const status of terminalStatuses) {
    it(`drops the entry and writes the failures log for ${status}`, async () => {
      const { queue } = makeQueue([
        {
          kind: 'discard',
          failure: { http_status: status, server_message: `msg-${status}` },
        },
      ]);
      await queue.enqueue({ id: 'a' });

      const summary = await queue.flush();

      expect(summary.delivered).toBe(0);
      expect(summary.remaining).toBe(0);
      const failures = await readFailures<Entry>(KEY);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.http_status).toBe(status);
      expect(failures[0]?.server_message).toBe(`msg-${status}`);
      expect(failures[0]?.original_entry).toEqual({ id: 'a' });
      expect(typeof failures[0]?.dropped_at).toBe('string');
    });
  }
});

describe('retryable-status preserves the entry and halts', () => {
  it('preserves the entry on a 5xx-shaped stop and does not write the failures log', async () => {
    const { queue } = makeQueue([{ kind: 'stop' }]);
    await queue.enqueue({ id: 'a' });
    await queue.enqueue({ id: 'b' });

    const summary = await queue.flush();

    expect(summary.delivered).toBe(0);
    expect(summary.remaining).toBe(2);
    const failures = await readFailures(KEY);
    expect(failures).toEqual([]);
    const preserved = await queue.peek();
    expect(preserved.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('failures-log cap and FIFO eviction', () => {
  it(`evicts the oldest entry once the log exceeds ${FAILURES_LOG_CAP}`, async () => {
    const outcomes: FlushOutcome[] = Array.from(
      { length: FAILURES_LOG_CAP + 3 },
      (_, i) => ({
        kind: 'discard' as const,
        failure: { http_status: 422, server_message: `m-${i}` },
      }),
    );
    const { queue } = makeQueue(outcomes);
    for (let i = 0; i < outcomes.length; i += 1) {
      await queue.enqueue({ id: `e-${i}` });
    }

    await queue.flush();

    const failures = await readFailures<Entry>(KEY);
    expect(failures).toHaveLength(FAILURES_LOG_CAP);
    // First three should be evicted; remaining ten are e-3..e-12.
    expect(failures[0]?.original_entry).toEqual({ id: 'e-3' });
    expect(failures[FAILURES_LOG_CAP - 1]?.original_entry).toEqual({
      id: `e-${FAILURES_LOG_CAP + 2}`,
    });
  });
});

describe('foreground toast dedup', () => {
  it('emits once on first foreground after a new drop, then stays quiet until a new drop arrives', async () => {
    const observed: number[] = [];
    subscribePermanentFailureToast((count) => observed.push(count));

    const { queue } = makeQueue([
      {
        kind: 'discard',
        failure: { http_status: 422, server_message: 'bad' },
      },
    ]);
    await queue.enqueue({ id: 'a' });
    await queue.flush();

    // First foreground after the drop — toast emits with N=1.
    await checkPermanentFailuresOnForeground();
    expect(observed).toEqual([1]);

    // Second foreground with no new drops — no emission.
    await checkPermanentFailuresOnForeground();
    expect(observed).toEqual([1]);

    // Third foreground after another drop — emits with N=1 (the new one only).
    const { queue: queue2 } = makeQueue([
      {
        kind: 'discard',
        failure: { http_status: 422, server_message: 'bad2' },
      },
    ]);
    await queue2.enqueue({ id: 'b' });
    await queue2.flush();
    await checkPermanentFailuresOnForeground();
    expect(observed).toEqual([1, 1]);
  });

  it('counts across queues — three drops across two queues yield a single toast with N=3', async () => {
    const observed: number[] = [];
    subscribePermanentFailureToast((count) => observed.push(count));

    const queueA = createWriteQueue<Entry>('brain.test.qA', {
      flushOne: async () => ({
        kind: 'discard',
        failure: { http_status: 422, server_message: 'a' },
      }),
    });
    const queueB = createWriteQueue<Entry>('brain.test.qB', {
      flushOne: async () => ({
        kind: 'discard',
        failure: { http_status: 401, server_message: 'b' },
      }),
    });
    await queueA.enqueue({ id: 'a1' });
    await queueA.enqueue({ id: 'a2' });
    await queueB.enqueue({ id: 'b1' });

    await queueA.flush();
    await queueB.flush();

    await checkPermanentFailuresOnForeground();

    expect(observed).toEqual([3]);
  });

  it('respects manual acknowledgement — calling acknowledge before foreground suppresses the toast', async () => {
    const observed: number[] = [];
    subscribePermanentFailureToast((count) => observed.push(count));

    const { queue } = makeQueue([
      {
        kind: 'discard',
        failure: { http_status: 422, server_message: 'x' },
      },
    ]);
    await queue.enqueue({ id: 'a' });
    await queue.flush();

    await acknowledgePermanentFailureToast();
    await checkPermanentFailuresOnForeground();

    expect(observed).toEqual([]);
  });
});

describe('failures log shape — for [2C-30] consumption', () => {
  it('stores entries in chronological order, newest last', async () => {
    const { queue } = makeQueue([
      {
        kind: 'discard',
        failure: { http_status: 400, server_message: 'first' },
      },
      {
        kind: 'discard',
        failure: { http_status: 422, server_message: 'second' },
      },
    ]);
    await queue.enqueue({ id: 'a' });
    await queue.enqueue({ id: 'b' });
    await queue.flush();

    const failures = await readFailures<Entry>(KEY);
    expect(failures.map((f: PermanentFailureRecord<Entry>) => f.original_entry.id)).toEqual([
      'a',
      'b',
    ]);
    expect(failures.map((f) => f.http_status)).toEqual([400, 422]);
  });
});
