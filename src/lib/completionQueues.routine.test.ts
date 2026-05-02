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

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from './pairing';
import {
  __resetForTests,
  enqueueRoutineCompletion,
  flushAllQueues,
  HABIT_COMPLETIONS_KEY,
  ROUTINE_COMPLETIONS_KEY,
  subscribeRoutineCompletionWarnings,
  type HabitCompletionEntry,
  type RoutineCompletionEntry,
  type RoutineCompletionWarning,
} from './completionQueues';
import { __resetForTests as __resetWriteQueueForTests } from './writeQueue';

const PAIRING_URL = 'https://brain.local:8000';
const PAIRING_TOKEN = 'bearer-abc-123';

const prefsStore = new Map<string, string>();

function entry(
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

function seedPairing(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRING_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRING_TOKEN);
}

async function readRoutineQueue(): Promise<RoutineCompletionEntry[]> {
  const raw = prefsStore.get(ROUTINE_COMPLETIONS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as RoutineCompletionEntry[];
}

async function readHabitQueue(): Promise<HabitCompletionEntry[]> {
  const raw = prefsStore.get(HABIT_COMPLETIONS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as HabitCompletionEntry[];
}

beforeEach(() => {
  __resetForTests();
  __resetWriteQueueForTests();
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

describe('enqueueRoutineCompletion — non-partial statuses', () => {
  it('all_done: appends only to the routine queue, no habit pre-enqueue', async () => {
    await enqueueRoutineCompletion(
      entry({ routine_id: 'r-1', status: 'all_done' }),
    );
    expect((await readRoutineQueue()).map((e) => e.routine_id)).toEqual([
      'r-1',
    ]);
    expect(await readHabitQueue()).toEqual([]);
  });

  it('skipped: appends only to the routine queue, no habit pre-enqueue', async () => {
    await enqueueRoutineCompletion(
      entry({ routine_id: 'r-2', status: 'skipped' }),
    );
    expect((await readRoutineQueue()).map((e) => e.routine_id)).toEqual([
      'r-2',
    ]);
    expect(await readHabitQueue()).toEqual([]);
  });
});

describe('enqueueRoutineCompletion — partial pre-enqueues child habits before the routine', () => {
  it('appends each child_habit_completions entry to the habit queue first, then the routine entry', async () => {
    await enqueueRoutineCompletion(
      entry({
        routine_id: 'r-partial',
        status: 'partial',
        freeform_note: 'only got two of three',
        child_habit_completions: [
          { habit_id: 'h-A', completed_date: '2026-05-02' },
          { habit_id: 'h-B', completed_date: '2026-05-02' },
        ],
      }),
    );

    const habits = await readHabitQueue();
    const routines = await readRoutineQueue();
    expect(habits.map((e) => e.habit_id)).toEqual(['h-A', 'h-B']);
    expect(routines.map((e) => e.routine_id)).toEqual(['r-partial']);
    // Note semantics for child entries: notes is null per spec.
    expect(habits.every((e) => e.notes === null)).toBe(true);
  });

  it('partial flush order: child habits POST before the routine POST', async () => {
    seedPairing();
    await enqueueRoutineCompletion(
      entry({
        routine_id: 'r-partial',
        status: 'partial',
        freeform_note: 'only got two',
        child_habit_completions: [
          { habit_id: 'h-A', completed_date: '2026-05-02' },
          { habit_id: 'h-B', completed_date: '2026-05-02' },
        ],
      }),
    );

    const order: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/habits/h-A/')) order.push('habit:h-A');
      else if (url.includes('/api/habits/h-B/')) order.push('habit:h-B');
      else if (url.includes('/api/routines/r-partial/')) order.push('routine:r-partial');
      return new Response(null, { status: 200 });
    });

    await flushAllQueues();

    expect(order).toEqual(['habit:h-A', 'habit:h-B', 'routine:r-partial']);
  });
});

describe('routine completion flush — happy path', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('POSTs to /api/routines/{id}/complete with the spec body for all_done', async () => {
    await enqueueRoutineCompletion(
      entry({ routine_id: 'r-1', status: 'all_done', freeform_note: null }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const summary = await flushAllQueues();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://brain.local:8000/api/routines/r-1/complete',
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      completed_date: '2026-05-02',
      status: 'all_done',
      freeform_note: null,
    });
    expect(summary.routineCompletions.delivered).toBe(1);
  });

  it('POSTs status=partial with the freeform_note when partial entry flushes', async () => {
    await enqueueRoutineCompletion(
      entry({
        routine_id: 'r-1',
        status: 'partial',
        freeform_note: 'only got two of three',
        child_habit_completions: [
          { habit_id: 'h-A', completed_date: '2026-05-02' },
        ],
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await flushAllQueues();

    const routinePost = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/api/routines/'),
    );
    expect(routinePost).toBeDefined();
    expect(JSON.parse(routinePost![1]!.body as string)).toEqual({
      completed_date: '2026-05-02',
      status: 'partial',
      freeform_note: 'only got two of three',
    });
  });

  it('POSTs status=skipped with null freeform_note', async () => {
    await enqueueRoutineCompletion(
      entry({ routine_id: 'r-1', status: 'skipped', freeform_note: null }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await flushAllQueues();

    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({
      completed_date: '2026-05-02',
      status: 'skipped',
      freeform_note: null,
    });
  });

  it('treats 200 (idempotent retry) as delivered, mirroring the [2C-26] uq_routine_completions_routine_date_status guarantee', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'r-1' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ routine_id: 'r-1', completed_date: '2026-05-02' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const summary = await flushAllQueues();

    expect(summary.routineCompletions.delivered).toBe(1);
    expect(summary.routineCompletions.remaining).toBe(0);
    expect(await readRoutineQueue()).toEqual([]);
  });
});

describe('routine completion flush — terminal-drop paths', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('drops entry and emits not_active warning on 409 (routine non-active)', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'r-paused' }));
    await enqueueRoutineCompletion(entry({ routine_id: 'r-after' }));
    const warnings: RoutineCompletionWarning[] = [];
    subscribeRoutineCompletionWarnings((w) => warnings.push(w));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Cannot complete a non-active routine' }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const summary = await flushAllQueues();

    expect(summary.routineCompletions.attempted).toBe(2);
    // First entry discarded (409 not-active); second entry delivered.
    expect(summary.routineCompletions.delivered).toBe(1);
    expect(summary.routineCompletions.remaining).toBe(0);
    expect(warnings).toEqual([
      { kind: 'not_active', routine_id: 'r-paused', status: 'all_done' },
    ]);
  });

  it('drops entry and emits not_found warning on 404', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'gone' }));
    const warnings: RoutineCompletionWarning[] = [];
    subscribeRoutineCompletionWarnings((w) => warnings.push(w));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    const summary = await flushAllQueues();

    expect(summary.routineCompletions.attempted).toBe(1);
    // 404 is a discard, not a delivery.
    expect(summary.routineCompletions.delivered).toBe(0);
    expect(summary.routineCompletions.remaining).toBe(0);
    expect(warnings).toEqual([
      { kind: 'not_found', routine_id: 'gone', status: 'all_done' },
    ]);
  });
});

describe('routine completion flush — halt paths', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('halts on network failure and preserves enqueue order', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'first' }));
    await enqueueRoutineCompletion(entry({ routine_id: 'second' }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    const summary = await flushAllQueues();

    expect(summary.routineCompletions.attempted).toBe(1);
    expect(summary.routineCompletions.delivered).toBe(0);
    expect(summary.routineCompletions.remaining).toBe(2);
    const queue = await readRoutineQueue();
    expect(queue.map((e) => e.routine_id)).toEqual(['first', 'second']);
  });

  it('halts on 5xx without dropping the failed entry', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'r-1' }));
    await enqueueRoutineCompletion(entry({ routine_id: 'r-2' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    const summary = await flushAllQueues();

    expect(summary.routineCompletions.attempted).toBe(1);
    expect(summary.routineCompletions.delivered).toBe(0);
    expect(summary.routineCompletions.remaining).toBe(2);
  });
});

describe('routine completion flush — gating', () => {
  it('no-ops when no pairing is stored', async () => {
    await enqueueRoutineCompletion(entry({ routine_id: 'r-1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const summary = await flushAllQueues();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary.routineCompletions).toEqual({
      attempted: 0,
      delivered: 0,
      remaining: 1,
      coalesced: false,
    });
  });
});
