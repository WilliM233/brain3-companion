import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route } from 'react-router-dom';
import { forwardRef, useImperativeHandle, useRef } from 'react';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

// Replace shadow-DOM Ionic components that jsdom cannot exercise. Same
// approach as HabitDetailPage.test.tsx; here we additionally stub IonCheckbox
// + IonTextarea + IonFooter so checkbox state and the textarea value are
// queryable / settable through standard DOM APIs.
vi.mock('@ionic/react', async () => {
  const actual = await vi.importActual<typeof import('@ionic/react')>(
    '@ionic/react',
  );
  interface IonToastProps {
    isOpen: boolean;
    message?: string;
    color?: string;
    onDidDismiss?: () => void;
  }
  interface IonCheckboxProps {
    checked: boolean;
    onIonChange?: () => void;
    'aria-label'?: string;
    'data-testid'?: string;
    slot?: string;
  }
  interface IonTextareaProps {
    value?: string;
    placeholder?: string;
    maxlength?: number;
    rows?: number;
    autoGrow?: boolean;
    'data-testid'?: string;
    onIonInput?: (e: { detail: { value: string | null } }) => void;
  }
  interface IonFooterProps {
    children?: React.ReactNode;
  }
  const IonToast: React.FC<IonToastProps> = ({ isOpen, message, color }) =>
    isOpen ? (
      <div role="status" data-testid="toast" data-color={color ?? ''}>
        {message ?? ''}
      </div>
    ) : null;
  const IonCheckbox: React.FC<IonCheckboxProps> = ({
    checked,
    onIonChange,
    ...rest
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => onIonChange?.()}
      aria-label={rest['aria-label']}
      data-testid={rest['data-testid']}
    />
  );
  const IonTextarea = forwardRef<
    { setFocus: () => Promise<void> },
    IonTextareaProps
  >((props, ref) => {
    const localRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        setFocus: async () => {
          localRef.current?.focus();
        },
      }),
      [],
    );
    return (
      <textarea
        ref={localRef}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        maxLength={props.maxlength}
        rows={props.rows}
        data-testid={props['data-testid']}
        onChange={(e) =>
          props.onIonInput?.({ detail: { value: e.target.value } })
        }
      />
    );
  });
  IonTextarea.displayName = 'IonTextarea';
  const IonFooter: React.FC<IonFooterProps> = ({ children }) => (
    <div data-testid="ion-footer">{children}</div>
  );
  return { ...actual, IonToast, IonCheckbox, IonTextarea, IonFooter };
});

const { replaceSpy, pushSpy } = vi.hoisted(() => ({
  replaceSpy: vi.fn(),
  pushSpy: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useHistory: () => ({
      push: pushSpy,
      replace: replaceSpy,
      goBack: vi.fn(),
    }),
  };
});

const { enqueueSpy, flushSpy, subscribeRoutineWarningSpy, latestRoutineWarningListener } =
  vi.hoisted(() => {
    const ref: { current: ((w: unknown) => void) | null } = { current: null };
    return {
      enqueueSpy: vi.fn(),
      flushSpy: vi.fn(),
      subscribeRoutineWarningSpy: vi.fn((listener: (w: unknown) => void) => {
        ref.current = listener;
        return () => {
          ref.current = null;
        };
      }),
      latestRoutineWarningListener: ref,
    };
  });

vi.mock('../lib/completionQueues', () => ({
  enqueueRoutineCompletion: enqueueSpy,
  flushAllQueues: flushSpy,
  subscribeRoutineCompletionWarnings: subscribeRoutineWarningSpy,
}));

vi.mock('../lib/local-date', async () => {
  const actual = await vi.importActual<typeof import('../lib/local-date')>(
    '../lib/local-date',
  );
  return {
    ...actual,
    todayLocalDate: () => '2026-05-02',
  };
});

import { Preferences } from '@capacitor/preferences';
import { PAIRING_TOKEN_KEY, PAIRING_URL_KEY } from '../lib/pairing';
import type { HabitResponse } from '../lib/habits';
import type {
  RoutineDetailResponse,
  RoutineScheduleResponse,
} from '../lib/routines';
import RoutineDetailPage from './RoutineDetailPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';
const ROUTINE_ID = 'r-1';

const prefsStore = new Map<string, string>();

const successFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 1,
    delivered: 1,
    remaining: 0,
    coalesced: false,
  },
};

const stopFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 1,
    delivered: 0,
    remaining: 1,
    coalesced: false,
  },
};

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();
  replaceSpy.mockReset();
  enqueueSpy.mockReset().mockResolvedValue(undefined);
  flushSpy.mockReset().mockResolvedValue(successFlush);
  subscribeRoutineWarningSpy.mockClear();
  latestRoutineWarningListener.current = null;

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

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
}

function makeRoutine(
  overrides: Partial<RoutineDetailResponse> = {},
): RoutineDetailResponse {
  return {
    id: ROUTINE_ID,
    title: 'Morning kit',
    description: 'Three things before coffee',
    frequency: 'weekdays',
    status: 'active',
    current_streak: 3,
    best_streak: 7,
    last_completed: '2026-05-01',
    schedules: [],
    ...overrides,
  };
}

function makeSchedule(
  overrides: Partial<RoutineScheduleResponse> = {},
): RoutineScheduleResponse {
  return {
    id: 's-1',
    routine_id: ROUTINE_ID,
    day_of_week: 'weekdays',
    time_of_day: '07:00',
    preferred_window: null,
    ...overrides,
  };
}

function makeHabit(
  id: string,
  overrides: Partial<HabitResponse> = {},
): HabitResponse {
  return {
    id,
    routine_id: ROUTINE_ID,
    title: `Habit ${id}`,
    description: null,
    status: 'active',
    frequency: 'daily',
    notification_frequency: 'daily',
    scaffolding_status: 'tracking',
    accountable_since: null,
    graduation_window: null,
    graduation_target: null,
    graduation_threshold: null,
    friction_score: null,
    position: null,
    re_scaffold_count: 0,
    last_frequency_changed_at: null,
    graduated_at: null,
    current_streak: 0,
    best_streak: 0,
    last_completed: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    effective_graduation_params: {
      window_days: 30,
      target_rate: 0.8,
      threshold_days: 5,
      source: 'friction_default',
    },
    ...overrides,
  };
}

interface FetchOpts {
  routine?: { status: number; body?: RoutineDetailResponse };
  habits?: { status: number; body?: HabitResponse[] };
}

function stubFetch(opts: FetchOpts = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (
        url.includes(`/api/routines/${ROUTINE_ID}`) &&
        !url.includes('/complete') &&
        !url.includes('/completions') &&
        !url.includes('/schedules') &&
        method === 'GET'
      ) {
        const r = opts.routine ?? { status: 200, body: makeRoutine() };
        return new Response(
          r.body !== undefined ? JSON.stringify(r.body) : '',
          { status: r.status },
        );
      }
      if (url.includes(`routine_id=${ROUTINE_ID}`) && method === 'GET') {
        const items = opts.habits?.body ?? [];
        const status = opts.habits?.status ?? 200;
        return new Response(JSON.stringify({ items, count: items.length }), {
          status,
        });
      }
      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/routines/${ROUTINE_ID}`]}>
        <Route path="/routines/:routineId">
          <RoutineDetailPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Render — scripted vs freeform
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — scripted render', () => {
  it('renders header pane, checklist, freeform note, and three actions', async () => {
    pair();
    stubFetch({
      routine: {
        status: 200,
        body: makeRoutine({
          schedules: [
            makeSchedule({ day_of_week: 'weekdays', time_of_day: '7:00' }),
            makeSchedule({
              id: 's-2',
              day_of_week: 'weekends',
              time_of_day: '9:00',
            }),
            makeSchedule({
              id: 's-3',
              day_of_week: 'sunday',
              time_of_day: '10:00',
            }),
          ],
        }),
      },
      habits: {
        status: 200,
        body: [makeHabit('h-1'), makeHabit('h-2')],
      },
    });

    renderPage();

    expect(await screen.findByText('Morning kit')).toBeInTheDocument();
    expect(screen.getByTestId('routine-description')).toHaveTextContent(
      /three things before coffee/i,
    );
    // Schedule summary uses only the first two entries with " · " separator.
    expect(screen.getByTestId('routine-schedule-summary')).toHaveTextContent(
      'Weekdays 7:00 · Weekends 9:00',
    );
    expect(screen.getByTestId('routine-streak')).toHaveTextContent(
      'Streak 3 · Best 7',
    );

    expect(screen.getByTestId('routine-checklist-pane')).toBeInTheDocument();
    expect(screen.getByTestId('routine-checkbox-h-1')).toBeInTheDocument();
    expect(screen.getByTestId('routine-checkbox-h-2')).toBeInTheDocument();
    expect(screen.getByTestId('routine-freeform-note')).toBeInTheDocument();
    expect(screen.getByTestId('routine-all-done-button')).toBeInTheDocument();
    expect(screen.getByTestId('routine-partial-button')).toBeInTheDocument();
    expect(screen.getByTestId('routine-skipped-button')).toBeInTheDocument();
  });

  it('renders the trailing "Not in today\'s checklist" section for graduated habits', async () => {
    pair();
    stubFetch({
      habits: {
        status: 200,
        body: [
          makeHabit('h-active'),
          makeHabit('h-grad', { scaffolding_status: 'graduated' }),
        ],
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('routine-checklist-row-h-active'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('routine-trailing-section'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('routine-trailing-h-grad'),
    ).toBeInTheDocument();
    // Graduated habit does NOT get a checkbox.
    expect(
      screen.queryByTestId('routine-checkbox-h-grad'),
    ).not.toBeInTheDocument();
  });
});

describe('RoutineDetailPage — freeform render', () => {
  it('shows the freeform message and hides the Partial button when no habits exist', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [] } });

    renderPage();

    expect(
      await screen.findByTestId('routine-checklist-freeform'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('routine-partial-button'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('routine-all-done-button')).toBeInTheDocument();
    expect(screen.getByTestId('routine-skipped-button')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Checkbox initial state
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — checkbox initialisation', () => {
  it('checks habits whose last_completed equals today and leaves others unchecked', async () => {
    pair();
    stubFetch({
      habits: {
        status: 200,
        body: [
          makeHabit('h-done', { last_completed: '2026-05-02' }),
          makeHabit('h-pending', { last_completed: '2026-05-01' }),
          makeHabit('h-never', { last_completed: null }),
        ],
      },
    });

    renderPage();

    const done = (await screen.findByTestId(
      'routine-checkbox-h-done',
    )) as HTMLInputElement;
    const pending = screen.getByTestId(
      'routine-checkbox-h-pending',
    ) as HTMLInputElement;
    const never = screen.getByTestId(
      'routine-checkbox-h-never',
    ) as HTMLInputElement;

    await waitFor(() => {
      expect(done.checked).toBe(true);
      expect(pending.checked).toBe(false);
      expect(never.checked).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// All Done path
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — All Done path', () => {
  it('enqueues with status=all_done and child_habit_completions=null', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [makeHabit('h-1')] } });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('routine-all-done-button'),
    );

    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          routine_id: ROUTINE_ID,
          completed_date: '2026-05-02',
          status: 'all_done',
          child_habit_completions: null,
        }),
      );
    });
    expect(flushSpy).toHaveBeenCalled();
  });

  it('shows the unchecked-habits warning when at least one row is not checked', async () => {
    pair();
    stubFetch({
      habits: {
        status: 200,
        body: [
          makeHabit('h-1', { last_completed: '2026-05-02' }),
          makeHabit('h-2', { last_completed: null }),
        ],
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('routine-all-done-warning'),
    ).toHaveTextContent(/all done marks every habit/i);
  });

  it('hides the warning when every habit is checked', async () => {
    pair();
    stubFetch({
      habits: {
        status: 200,
        body: [
          makeHabit('h-1', { last_completed: '2026-05-02' }),
          makeHabit('h-2', { last_completed: '2026-05-02' }),
        ],
      },
    });

    renderPage();

    // Wait for first checkbox to render so initialisation has run.
    await screen.findByTestId('routine-checkbox-h-1');
    expect(
      screen.queryByTestId('routine-all-done-warning'),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Partial path
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — Partial path', () => {
  it('enqueues only CHECKED habits as child_habit_completions', async () => {
    pair();
    stubFetch({
      habits: {
        status: 200,
        body: [
          makeHabit('h-1', { last_completed: '2026-05-02' }), // checked init
          makeHabit('h-2', { last_completed: null }), // unchecked init
        ],
      },
    });

    renderPage();

    await screen.findByTestId('routine-checkbox-h-1');
    // Toggle h-1 OFF — it was checked from last_completed init.
    await userEvent.click(screen.getByTestId('routine-checklist-row-h-1'));
    // Toggle h-2 ON.
    await userEvent.click(screen.getByTestId('routine-checklist-row-h-2'));

    await userEvent.click(screen.getByTestId('routine-partial-button'));

    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          routine_id: ROUTINE_ID,
          status: 'partial',
          child_habit_completions: [
            { habit_id: 'h-2', completed_date: '2026-05-02' },
          ],
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Skipped path
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — Skipped path', () => {
  it('refuses to enqueue and surfaces the inline error when the note is empty', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [makeHabit('h-1')] } });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('routine-skipped-button'),
    );

    expect(
      await screen.findByTestId('routine-skipped-error'),
    ).toHaveTextContent(/note is required/i);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('enqueues with status=skipped + freeform_note when the note is non-empty', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [makeHabit('h-1')] } });

    renderPage();

    const note = (await screen.findByTestId(
      'routine-freeform-note',
    )) as HTMLTextAreaElement;
    await userEvent.type(note, 'busy day');
    await userEvent.click(screen.getByTestId('routine-skipped-button'));

    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'skipped',
          freeform_note: 'busy day',
          child_habit_completions: null,
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Flush feedback toasts
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — flush feedback', () => {
  it('shows the queued retry toast when the flush halts before delivering', async () => {
    pair();
    flushSpy.mockResolvedValueOnce(stopFlush);
    stubFetch({ habits: { status: 200, body: [] } });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('routine-all-done-button'),
    );

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/queued — will retry/i);
  });
});

// ---------------------------------------------------------------------------
// Warning surface (Group 3 close-ledger carry-forward)
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — warning surface', () => {
  it('subscribes on mount and surfaces a danger toast when a not_active warning fires for this routine', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [] } });

    renderPage();

    await screen.findByTestId('routine-all-done-button');
    expect(subscribeRoutineWarningSpy).toHaveBeenCalled();
    expect(latestRoutineWarningListener.current).not.toBeNull();

    await act(async () => {
      latestRoutineWarningListener.current?.({
        kind: 'not_active',
        routine_id: ROUTINE_ID,
        status: 'all_done',
      });
    });

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/routine is paused/i);
    expect(toast).toHaveAttribute('data-color', 'danger');
  });

  it('surfaces a not_found warning with the corresponding message', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [] } });

    renderPage();

    await screen.findByTestId('routine-all-done-button');

    await act(async () => {
      latestRoutineWarningListener.current?.({
        kind: 'not_found',
        routine_id: ROUTINE_ID,
        status: 'skipped',
      });
    });

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/routine no longer exists/i);
  });

  it('ignores warnings for a different routine_id', async () => {
    pair();
    stubFetch({ habits: { status: 200, body: [] } });

    renderPage();

    await screen.findByTestId('routine-all-done-button');

    await act(async () => {
      latestRoutineWarningListener.current?.({
        kind: 'not_active',
        routine_id: 'other-routine',
        status: 'all_done',
      });
    });

    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Not-found
// ---------------------------------------------------------------------------

describe('RoutineDetailPage — not-found card', () => {
  it('renders the not-found card and routes back to /routines on tap', async () => {
    pair();
    stubFetch({
      routine: { status: 404 },
      habits: { status: 200, body: [] },
    });

    renderPage();

    expect(await screen.findByTestId('routine-not-found')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('routine-not-found-back'));
    expect(replaceSpy).toHaveBeenCalledWith('/routines');
  });
});
