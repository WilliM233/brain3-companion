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
  createWriteQueue,
  enqueueResponse,
  flushWriteQueue,
  QUEUE_SOFT_CAP,
  subscribeConflicts,
  WRITE_QUEUE_KEY,
  type ConflictWarning,
  type WriteQueueEntry,
} from './writeQueue';
import {
  __resetForTests as __resetCompletionForTests,
  flushAllQueues,
  HABIT_COMPLETIONS_KEY,
  ROUTINE_COMPLETIONS_KEY,
  type HabitCompletionEntry,
  type RoutineCompletionEntry,
} from './completionQueues';

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
  __resetCompletionForTests();
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

describe('flushWriteQueue — [2C-19] checkin_prompt extension', () => {
  beforeEach(() => {
    seedPairing();
    seedRegistered();
  });

  it('posts /api/checkins/ after /respond for checkin_prompt with a pre-composed payload', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'add-note',
          response: 'Energy 4',
          response_note: 'Focused but tired.',
          notification_type: 'checkin_prompt',
          checkin_payload: {
            checkin_type: 'freeform',
            energy_level: 4,
            mood: null,
            focus_level: null,
            freeform_note: 'Focused but tired.',
          },
        }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      '/api/notifications/add-note/respond',
    );
    expect(String(fetchSpy.mock.calls[1]![0])).toBe(
      `${PAIRING_URL}/api/checkins/`,
    );
    const checkinInit = fetchSpy.mock.calls[1]![1]!;
    expect(checkinInit.method).toBe('POST');
    expect(JSON.parse(checkinInit.body as string)).toEqual({
      checkin_type: 'freeform',
      energy_level: 4,
      mood: null,
      focus_level: null,
      freeform_note: 'Focused but tired.',
    });
    expect(summary).toEqual({
      attempted: 1,
      delivered: 1,
      conflicts: 0,
      remaining: 0,
    });
  });

  it('derives a numeric-only check-in payload on flush for canned-only checkin_prompt entries', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'canned-only',
          response: 'Energy 5',
          response_note: null,
          notification_type: 'checkin_prompt',
        }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const checkinInit = fetchSpy.mock.calls[1]![1]!;
    expect(JSON.parse(checkinInit.body as string)).toEqual({
      checkin_type: 'freeform',
      energy_level: 5,
      mood: null,
      focus_level: null,
      freeform_note: null,
    });
  });

  it('posts a note-only check-in when the canned response is the server default plain "3"', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'plain-three',
          response: '3',
          response_note: null,
          notification_type: 'checkin_prompt',
        }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await flushWriteQueue();

    const checkinInit = fetchSpy.mock.calls[1]![1]!;
    expect(JSON.parse(checkinInit.body as string)).toEqual({
      checkin_type: 'freeform',
      energy_level: null,
      mood: null,
      focus_level: null,
      freeform_note: null,
    });
  });

  it('does not post /api/checkins/ for non-checkin_prompt entries', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'habit-1',
          response: 'Already done',
          notification_type: 'habit_nudge',
        }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      '/api/notifications/habit-1/respond',
    );
  });

  it('preserves backward compatibility for entries without a notification_type', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'legacy', response: 'Already done' }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.delivered).toBe(1);
  });

  it('halts on a check-in POST network error so the entry retries on next flush', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'retry-me',
          response: 'Energy 4',
          notification_type: 'checkin_prompt',
        }),
      ]),
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // /respond
      .mockRejectedValueOnce(new Error('checkins network down')); // /api/checkins/

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(summary.delivered).toBe(0);
    expect(summary.remaining).toBe(1);
    const queue = await readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.notification_id).toBe('retry-me');
  });

  it('discards the entry when /api/checkins/ returns a terminal 4xx', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({
          notification_id: 'bad-payload',
          response: 'Energy 4',
          notification_type: 'checkin_prompt',
        }),
      ]),
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    const summary = await flushWriteQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(summary.delivered).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
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

  it('coalesced concurrent flushes return zero conflicts even mid-flight', async () => {
    prefsStore.set(
      WRITE_QUEUE_KEY,
      JSON.stringify([
        entry({ notification_id: 'a' }),
        entry({ notification_id: 'b' }),
      ]),
    );
    let resolveFirst: (value: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => firstResponse)
      .mockResolvedValue(new Response(null, { status: 200 }));

    const flushA = flushWriteQueue();
    // While A is awaiting the first POST, kick off B; B should see flushing=true
    // and short-circuit with all-zero counters (including conflicts).
    const flushB = flushWriteQueue();

    resolveFirst(new Response(null, { status: 200 }));
    const [summaryA, summaryB] = await Promise.all([flushA, flushB]);

    expect(summaryB).toEqual({
      attempted: 0,
      delivered: 0,
      conflicts: 0,
      remaining: expect.any(Number),
    });
    expect(summaryA.delivered).toBe(2);
    expect(summaryA.conflicts).toBe(0);
  });
});

describe('createWriteQueue — generic factory', () => {
  const KEY = 'brain.test.factoryQueue';
  type FactoryEntry = { id: string; payload: number };

  function makeEntry(overrides: Partial<FactoryEntry> = {}): FactoryEntry {
    return { id: 'e-1', payload: 1, ...overrides };
  }

  it('persists enqueued entries to the configured key in JSON-array form', async () => {
    const adapter = {
      flushOne: vi.fn(async () => ({ kind: 'remove' as const })),
    };
    const queue = createWriteQueue<FactoryEntry>(KEY, adapter);

    await queue.enqueue(makeEntry({ id: 'a' }));
    await queue.enqueue(makeEntry({ id: 'b' }));

    expect(prefsStore.get(KEY)).toBe(
      JSON.stringify([
        { id: 'a', payload: 1 },
        { id: 'b', payload: 1 },
      ]),
    );
    const peeked = await queue.peek();
    expect(peeked.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('drains entries in enqueue order on flush, removing each on remove outcome', async () => {
    const seen: string[] = [];
    const adapter = {
      flushOne: vi.fn(async (entry: FactoryEntry) => {
        seen.push(entry.id);
        return { kind: 'remove' as const };
      }),
    };
    const queue = createWriteQueue<FactoryEntry>(KEY, adapter);
    await queue.enqueue(makeEntry({ id: 'a' }));
    await queue.enqueue(makeEntry({ id: 'b' }));
    await queue.enqueue(makeEntry({ id: 'c' }));

    const summary = await queue.flush();

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(summary).toEqual({
      attempted: 3,
      delivered: 3,
      remaining: 0,
      coalesced: false,
    });
    expect(await queue.peek()).toEqual([]);
  });

  it('halts on stop outcome and preserves enqueue order at the head', async () => {
    let calls = 0;
    const adapter = {
      flushOne: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { kind: 'remove' as const };
        return { kind: 'stop' as const };
      }),
    };
    const queue = createWriteQueue<FactoryEntry>(KEY, adapter);
    await queue.enqueue(makeEntry({ id: 'a' }));
    await queue.enqueue(makeEntry({ id: 'b' }));
    await queue.enqueue(makeEntry({ id: 'c' }));

    const summary = await queue.flush();

    expect(summary.attempted).toBe(2);
    expect(summary.delivered).toBe(1);
    expect(summary.remaining).toBe(2);
    const remaining = await queue.peek();
    expect(remaining.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('no-ops when shouldFlush returns false', async () => {
    const adapter = {
      shouldFlush: vi.fn(async () => false),
      flushOne: vi.fn(async () => ({ kind: 'remove' as const })),
    };
    const queue = createWriteQueue<FactoryEntry>(KEY, adapter);
    await queue.enqueue(makeEntry({ id: 'a' }));

    const summary = await queue.flush();

    expect(adapter.flushOne).not.toHaveBeenCalled();
    expect(summary).toEqual({
      attempted: 0,
      delivered: 0,
      remaining: 1,
      coalesced: false,
    });
  });

  it('clear empties the persisted queue', async () => {
    const queue = createWriteQueue<FactoryEntry>(KEY, {
      flushOne: vi.fn(async () => ({ kind: 'remove' as const })),
    });
    await queue.enqueue(makeEntry({ id: 'a' }));
    await queue.enqueue(makeEntry({ id: 'b' }));

    await queue.clear();

    expect(await queue.peek()).toEqual([]);
  });

  it('logs a soft-cap warning above QUEUE_SOFT_CAP without dropping entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queue = createWriteQueue<FactoryEntry>(KEY, {
      flushOne: vi.fn(async () => ({ kind: 'remove' as const })),
    });
    const seeded = Array.from({ length: QUEUE_SOFT_CAP }, (_, i) =>
      makeEntry({ id: `seed-${i}` }),
    );
    prefsStore.set(KEY, JSON.stringify(seeded));

    await queue.enqueue(makeEntry({ id: 'overflow' }));

    expect((await queue.peek()).length).toBe(QUEUE_SOFT_CAP + 1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('exceeds soft cap');
  });

  it('beforeFlush fires once per non-coalesced flush, after shouldFlush passes', async () => {
    const order: string[] = [];
    const adapter = {
      shouldFlush: vi.fn(async () => {
        order.push('shouldFlush');
        return true;
      }),
      beforeFlush: vi.fn(() => {
        order.push('beforeFlush');
      }),
      flushOne: vi.fn(async () => {
        order.push('flushOne');
        return { kind: 'remove' as const };
      }),
    };
    const queue = createWriteQueue<FactoryEntry>(KEY, adapter);
    await queue.enqueue(makeEntry({ id: 'a' }));
    await queue.enqueue(makeEntry({ id: 'b' }));

    await queue.flush();

    expect(order).toEqual([
      'shouldFlush',
      'beforeFlush',
      'flushOne',
      'flushOne',
    ]);
  });
});

describe('flushAllQueues — cross-queue order', () => {
  beforeEach(() => {
    seedPairing();
    seedRegistered();
  });

  function habitEntry(
    overrides: Partial<HabitCompletionEntry> = {},
  ): HabitCompletionEntry {
    return {
      habit_id: '11111111-1111-1111-1111-111111111111',
      completed_date: '2026-05-02',
      notes: null,
      enqueued_at: '2026-05-02T10:00:00.000Z',
      ...overrides,
    };
  }

  function routineEntry(
    overrides: Partial<RoutineCompletionEntry> = {},
  ): RoutineCompletionEntry {
    return {
      routine_id: '22222222-2222-2222-2222-222222222222',
      completed_date: '2026-05-02',
      status: 'all_done',
      freeform_note: null,
      child_habit_completions: null,
      enqueued_at: '2026-05-02T10:00:00.000Z',
      ...overrides,
    };
  }

  it('flushes notifications first, then habit completions, then routine completions', async () => {
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify([entry({ notification_id: 'n-1' })]));
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([habitEntry({ habit_id: 'h-1' })]),
    );
    prefsStore.set(
      ROUTINE_COMPLETIONS_KEY,
      JSON.stringify([routineEntry({ routine_id: 'r-1' })]),
    );

    const order: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/notifications/')) order.push('notification');
      else if (url.includes('/api/habits/')) order.push('habit');
      else if (url.includes('/api/routines/')) order.push('routine');
      return new Response(null, { status: 200 });
    });

    const summary = await flushAllQueues();

    expect(order).toEqual(['notification', 'habit', 'routine']);
    expect(summary.notifications.delivered).toBe(1);
    expect(summary.habitCompletions.delivered).toBe(1);
    expect(summary.routineCompletions.delivered).toBe(1);
  });

  it('a halt in the habit queue does not prevent the routine queue from flushing', async () => {
    prefsStore.set(WRITE_QUEUE_KEY, JSON.stringify([]));
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([habitEntry({ habit_id: 'h-1' })]),
    );
    prefsStore.set(
      ROUTINE_COMPLETIONS_KEY,
      JSON.stringify([routineEntry({ routine_id: 'r-1' })]),
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/habits/')) {
        throw new Error('habit network down');
      }
      if (url.includes('/api/routines/')) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 200 });
    });

    const summary = await flushAllQueues();

    expect(summary.habitCompletions.delivered).toBe(0);
    expect(summary.habitCompletions.remaining).toBe(1);
    expect(summary.routineCompletions.delivered).toBe(1);
    expect(summary.routineCompletions.remaining).toBe(0);
  });
});
