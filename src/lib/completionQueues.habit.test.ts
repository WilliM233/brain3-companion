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

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from './pairing';
import {
  __resetForTests,
  enqueueHabitCompletion,
  flushAllQueues,
  HABIT_COMPLETIONS_KEY,
  subscribeHabitCompletionWarnings,
  type HabitCompletionEntry,
  type HabitCompletionWarning,
} from './completionQueues';
import { __resetForTests as __resetWriteQueueForTests } from './writeQueue';

const PAIRING_URL = 'https://brain.local:8000';
const PAIRING_TOKEN = 'bearer-abc-123';

const prefsStore = new Map<string, string>();

function entry(
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

function seedPairing(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRING_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRING_TOKEN);
}

async function readQueue(): Promise<HabitCompletionEntry[]> {
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

describe('enqueueHabitCompletion', () => {
  it('persists entries to brain.writeQueue.habitCompletions in order', async () => {
    await enqueueHabitCompletion(entry({ habit_id: 'a' }));
    await enqueueHabitCompletion(entry({ habit_id: 'b' }));
    const queue = await readQueue();
    expect(queue.map((e) => e.habit_id)).toEqual(['a', 'b']);
  });
});

describe('habit completion flush — happy path', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('POSTs each entry to /api/habits/{id}/complete with bearer auth and the spec body', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'h-1', completed_date: '2026-05-02', notes: 'first' }),
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const summary = await flushAllQueues();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://brain.local:8000/api/habits/h-1/complete');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PAIRING_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({
      completed_date: '2026-05-02',
      notes: 'first',
    });
    expect(summary.habitCompletions.delivered).toBe(1);
    expect(summary.habitCompletions.remaining).toBe(0);
    expect(await readQueue()).toEqual([]);
  });

  it('treats 200 (idempotent retry) and 201 identically as delivered', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'h-1' }),
        entry({ habit_id: 'h-2' }),
      ]),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const summary = await flushAllQueues();

    expect(summary.habitCompletions.delivered).toBe(2);
    expect(summary.habitCompletions.remaining).toBe(0);
  });
});

describe('habit completion flush — terminal-drop paths', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('drops entry and emits paused warning on 400 with the paused-status detail', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'paused-id' }),
        entry({ habit_id: 'after' }),
      ]),
    );
    const warnings: HabitCompletionWarning[] = [];
    subscribeHabitCompletionWarnings((w) => warnings.push(w));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail:
              "Cannot complete a habit with status 'paused'. Only active habits can be completed.",
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const summary = await flushAllQueues();

    // Paused entry is discarded (removed but not counted as delivered);
    // the second entry is genuinely delivered.
    expect(summary.habitCompletions.attempted).toBe(2);
    expect(summary.habitCompletions.delivered).toBe(1);
    expect(summary.habitCompletions.remaining).toBe(0);
    expect(warnings).toEqual([{ kind: 'paused', habit_id: 'paused-id' }]);
  });

  it('drops entry and emits not_found warning on 404, continuing the flush', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'gone' }),
        entry({ habit_id: 'after' }),
      ]),
    );
    const warnings: HabitCompletionWarning[] = [];
    subscribeHabitCompletionWarnings((w) => warnings.push(w));
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const summary = await flushAllQueues();

    expect(summary.habitCompletions.attempted).toBe(2);
    expect(summary.habitCompletions.delivered).toBe(1);
    expect(summary.habitCompletions.remaining).toBe(0);
    expect(warnings).toEqual([{ kind: 'not_found', habit_id: 'gone' }]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('habit completion flush — halt paths', () => {
  beforeEach(() => {
    seedPairing();
  });

  it('halts on network failure and preserves enqueue order', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'first' }),
        entry({ habit_id: 'second' }),
      ]),
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    const summary = await flushAllQueues();

    expect(summary.habitCompletions.attempted).toBe(1);
    expect(summary.habitCompletions.delivered).toBe(0);
    expect(summary.habitCompletions.remaining).toBe(2);
    const queue = await readQueue();
    expect(queue.map((e) => e.habit_id)).toEqual(['first', 'second']);
  });

  it('halts on 5xx without dropping the failed entry', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([
        entry({ habit_id: 'first' }),
        entry({ habit_id: 'second' }),
      ]),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const summary = await flushAllQueues();

    expect(summary.habitCompletions.attempted).toBe(1);
    expect(summary.habitCompletions.delivered).toBe(0);
    expect(summary.habitCompletions.remaining).toBe(2);
  });
});

describe('habit completion flush — gating', () => {
  it('no-ops when no pairing is stored', async () => {
    prefsStore.set(
      HABIT_COMPLETIONS_KEY,
      JSON.stringify([entry({ habit_id: 'h-1' })]),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const summary = await flushAllQueues();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary.habitCompletions).toEqual({
      attempted: 0,
      delivered: 0,
      remaining: 1,
      coalesced: false,
    });
  });
});
