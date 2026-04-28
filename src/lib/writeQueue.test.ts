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
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from './pairing';
import { REGISTERED_TOKEN_KEY } from './device-registration';
import {
  __resetForTests,
  enqueueResponse,
  flushWriteQueue,
  QUEUE_SOFT_CAP,
  subscribeConflicts,
  WRITE_QUEUE_KEY,
  type ConflictWarning,
  type WriteQueueEntry,
} from './writeQueue';

const PAIRING_URL = 'https://brain.local:8000';
const PAIRING_TOKEN = 'bearer-abc-123';
const FCM_TOKEN = 'fcm-token-aaaaaaaa-1111';

const prefsStore = new Map<string, string>();

function entry(overrides: Partial<WriteQueueEntry> = {}): WriteQueueEntry {
  return {
    notification_id: '11111111-1111-1111-1111-111111111111',
    response: 'Already done',
    response_note: null,
    enqueued_at: '2026-04-28T10:00:00.000Z',
    ...overrides,
  };
}

function seedPairing(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRING_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRING_TOKEN);
}

function seedRegistered(): void {
  prefsStore.set(REGISTERED_TOKEN_KEY, FCM_TOKEN);
}

async function readQueue(): Promise<WriteQueueEntry[]> {
  const raw = prefsStore.get(WRITE_QUEUE_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as WriteQueueEntry[];
}

beforeEach(() => {
  __resetForTests();
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

describe('enqueueResponse', () => {
  it('persists entries to brain.writeQueue as a JSON array', async () => {
    await enqueueResponse(entry());
    await enqueueResponse(entry({ response: 'Skip today' }));
    const queue = await readQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0]?.response).toBe('Already done');
    expect(queue[1]?.response).toBe('Skip today');
  });

  it('logs a warning above the soft cap but does not drop entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seeded = Array.from({ length: QUEUE_SOFT_CAP }, (_, i) =>
      entry({ notification_id: `seed-${i}` }),
    );
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify(seeded));

    await enqueueResponse(entry({ notification_id: 'overflow' }));

    const queue = await readQueue();
    expect(queue).toHaveLength(QUEUE_SOFT_CAP + 1);
    expect(queue[queue.length - 1]?.notification_id).toBe('overflow');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('exceeds soft cap');
  });
});

describe('flushWriteQueue — gating', () => {
  it('no-ops when no pairing is stored', async () => {
    seedRegistered();
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify([entry()]));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const summary = await flushWriteQueue();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary).toEqual({
      attempted: 0,
      delivered: 0,
      conflicts: 0,
      remaining: 1,
    });
  });

  it('no-ops when the device is not registered', async () => {
    seedPairing();
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify([entry()]));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const summary = await flushWriteQueue();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
    expect(summary.remaining).toBe(1);
  });
});

describe('flushWriteQueue — happy path', () => {
  beforeEach(() => {
    seedPairing();
    seedRegistered();
  });

  it('POSTs each entry with bearer auth, in enqueue order, and clears the queue', async () => {
    const entries = [
      entry({ notification_id: 'aaaa', response: 'Already done' }),
      entry({ notification_id: 'bbbb', response: 'Skip today' }),
      entry({ notification_id: 'cccc', response: 'Snooze' }),
    ];
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify(entries));

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const seenIds = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(seenIds[0]).toContain('/api/notifications/aaaa/respond');
    expect(seenIds[1]).toContain('/api/notifications/bbbb/respond');
    expect(seenIds[2]).toContain('/api/notifications/cccc/respond');

    const firstInit = fetchSpy.mock.calls[0]![1]!;
    const firstHeaders = firstInit.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe(`Bearer ${PAIRING_TOKEN}`);
    expect(firstHeaders['Content-Type']).toBe('application/json');
    expect(JSON.parse(firstInit.body as string)).toEqual({
      response: 'Already done',
      response_note: null,
    });

    expect(summary).toEqual({
      attempted: 3,
      delivered: 3,
      conflicts: 0,
      remaining: 0,
    });
    expect(await readQueue()).toEqual([]);
  });

  it('treats 200 and 201 identically as delivered', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'first' }),
        entry({ notification_id: 'second' }),
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(summary.delivered).toBe(2);
    expect(summary.remaining).toBe(0);
  });

  it('strips trailing slashes from pairing.url before joining the path', async () => {
    prefsStore.set(PAIRING_URL_KEY, 'https://brain.local:8000/');
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify([entry({ notification_id: 'xx' })]));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await flushWriteQueue();

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://brain.local:8000/api/notifications/xx/respond',
    );
  });
});

describe('flushWriteQueue — failure handling', () => {
  beforeEach(() => {
    seedPairing();
    seedRegistered();
  });

  it('stops on a network error and preserves enqueue order', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'first' }),
        entry({ notification_id: 'second' }),
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('offline'));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.attempted).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(summary.remaining).toBe(2);
    const queue = await readQueue();
    expect(queue.map((e) => e.notification_id)).toEqual(['first', 'second']);
  });

  it('stops on a 5xx response without dropping the failed entry', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'first' }),
        entry({ notification_id: 'second' }),
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.delivered).toBe(0);
    expect(summary.remaining).toBe(2);
  });

  it('flushes again successfully once connectivity restores (retry safety)', async () => {
    // First flush fails on network; second flush after restore delivers all.
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'first' }),
        entry({ notification_id: 'second' }),
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(null, { status: 200 }));

    const offline = await flushWriteQueue();
    expect(offline.delivered).toBe(0);
    expect(offline.remaining).toBe(2);

    const restored = await flushWriteQueue();
    expect(restored.delivered).toBe(2);
    expect(restored.remaining).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 failed + 2 succeeded
  });
});

describe('flushWriteQueue — 409 conflict', () => {
  beforeEach(() => {
    seedPairing();
    seedRegistered();
  });

  it('drops the entry and emits a ConflictWarning when the server response differs', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'conflict-id', response: 'Already done' }),
        entry({ notification_id: 'after', response: 'Skip today' }),
      ]),
    );
    const warnings: ConflictWarning[] = [];
    subscribeConflicts((w) => warnings.push(w));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ response: 'Skip today' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const summary = await flushWriteQueue();

    expect(summary.conflicts).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(warnings).toEqual([
      {
        notification_id: 'conflict-id',
        attempted_response: 'Already done',
        server_response: 'Skip today',
      },
    ]);
  });

  it('drops 409 entries even if the body is not parseable, without emitting a warning', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([entry({ notification_id: 'opaque' })]),
    );
    const warnings: ConflictWarning[] = [];
    subscribeConflicts((w) => warnings.push(w));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 409 }),
    );

    const summary = await flushWriteQueue();

    expect(summary.conflicts).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(warnings).toEqual([]);
  });
});
