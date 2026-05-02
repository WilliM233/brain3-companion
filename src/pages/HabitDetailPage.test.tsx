import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route } from 'react-router-dom';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

// IonAlert and IonToast use shadow-DOM rendering that jsdom does not exercise
// — accessible names for their internal buttons / message text aren't
// queryable through Testing Library. Replace them with thin wrappers that
// expose the same prop contract via plain DOM. Production keeps the real
// Ionic implementations; the mocks only run inside this suite.
vi.mock('@ionic/react', async () => {
  const actual = await vi.importActual<typeof import('@ionic/react')>(
    '@ionic/react',
  );
  type AlertButton = {
    text: string;
    role?: string;
    handler?: () => void;
  };
  interface IonAlertProps {
    isOpen: boolean;
    header?: string;
    message?: string;
    buttons?: AlertButton[];
    onDidDismiss?: () => void;
  }
  interface IonToastProps {
    isOpen: boolean;
    message?: string;
    color?: string;
    onDidDismiss?: () => void;
  }
  const IonAlert: React.FC<IonAlertProps> = ({
    isOpen,
    header,
    message,
    buttons,
    onDidDismiss,
  }) =>
    isOpen ? (
      <div role="alertdialog" aria-label={header} data-testid="alert">
        {header ? <h2>{header}</h2> : null}
        {message ? <p>{message}</p> : null}
        {(buttons ?? []).map((b, i) => (
          <button
            key={i}
            type="button"
            data-testid={`alert-button-${i}`}
            data-role={b.role ?? 'action'}
            onClick={() => {
              b.handler?.();
              onDidDismiss?.();
            }}
          >
            {b.text}
          </button>
        ))}
      </div>
    ) : null;
  const IonToast: React.FC<IonToastProps> = ({
    isOpen,
    message,
    color,
  }) =>
    isOpen ? (
      <div role="status" data-testid="toast" data-color={color ?? ''}>
        {message ?? ''}
      </div>
    ) : null;
  return { ...actual, IonAlert, IonToast };
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

const {
  enqueueSpy,
  flushSpy,
  subscribeHabitWarningSpy,
  latestHabitWarningListener,
} = vi.hoisted(() => {
  const ref: { current: ((w: unknown) => void) | null } = { current: null };
  return {
    enqueueSpy: vi.fn(),
    flushSpy: vi.fn(),
    subscribeHabitWarningSpy: vi.fn((listener: (w: unknown) => void) => {
      ref.current = listener;
      return () => {
        ref.current = null;
      };
    }),
    latestHabitWarningListener: ref,
  };
});

vi.mock('../lib/completionQueues', () => ({
  enqueueHabitCompletion: enqueueSpy,
  flushAllQueues: flushSpy,
  subscribeHabitCompletionWarnings: subscribeHabitWarningSpy,
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
  GraduationStatusResponse,
  HabitCompletionItem,
  HabitDetailResponse,
} from '../lib/habit-detail';
import HabitDetailPage from './HabitDetailPage';

const PAIRED_URL = 'https://brain.local:8000';
const PAIRED_TOKEN = 'tk-1';
const HABIT_ID = 'h-1';

const prefsStore = new Map<string, string>();

const successFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 1,
    delivered: 1,
    remaining: 0,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
};

const stopFlush = {
  notifications: { attempted: 0, delivered: 0, remaining: 0 },
  habitCompletions: {
    attempted: 1,
    delivered: 0,
    remaining: 1,
    coalesced: false,
  },
  routineCompletions: {
    attempted: 0,
    delivered: 0,
    remaining: 0,
    coalesced: false,
  },
};

beforeEach(() => {
  prefsStore.clear();
  pushSpy.mockReset();
  replaceSpy.mockReset();
  enqueueSpy.mockReset().mockResolvedValue(undefined);
  flushSpy.mockReset().mockResolvedValue(successFlush);
  subscribeHabitWarningSpy.mockClear();
  latestHabitWarningListener.current = null;

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

  Object.defineProperty(window.navigator, 'onLine', {
    value: true,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pair(): void {
  prefsStore.set(PAIRING_URL_KEY, PAIRED_URL);
  prefsStore.set(PAIRING_TOKEN_KEY, PAIRED_TOKEN);
}

function makeHabit(
  overrides: Partial<HabitDetailResponse> = {},
): HabitDetailResponse {
  const base: HabitResponse = {
    id: HABIT_ID,
    routine_id: null,
    title: 'Take meds',
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
    current_streak: 3,
    best_streak: 7,
    last_completed: '2026-05-01',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    effective_graduation_params: {
      window_days: 30,
      target_rate: 0.8,
      threshold_days: 5,
      source: 'friction_default',
    },
  };
  return { ...base, ...overrides, routine: overrides.routine ?? null };
}

function makeGraduation(
  overrides: Partial<GraduationStatusResponse> = {},
): GraduationStatusResponse {
  return {
    habit_id: HABIT_ID,
    habit_name: 'Take meds',
    scaffolding_status: 'tracking',
    notification_frequency: 'daily',
    friction_score: 3,
    re_scaffold_count: 0,
    accountable_since: null,
    days_accountable: 0,
    graduation_params: {
      window_days: 30,
      target_rate: 0.8,
      threshold_days: 5,
      source: 'friction_default',
    },
    current_metrics: {
      already_done_rate: 0,
      total_notifications: 0,
      already_done_count: 0,
    },
    progress_summary:
      'Habit is in tracking mode. Not yet in accountability loop.',
    frequency_step_down: {
      eligible: false,
      recommended_frequency: null,
      current_rate_over_recent: 0,
    },
    ...overrides,
  };
}

interface FetchOpts {
  habit?: { status: number; body?: HabitDetailResponse };
  graduation?: { status: number; body?: GraduationStatusResponse };
  completions?: { status: number; body?: HabitCompletionItem[] };
  patch?: { status: number; body?: HabitResponse };
  reScaffold?: { status: number; body?: unknown };
  stepDown?: { status: number; body?: unknown };
}

function stubFetch(opts: FetchOpts = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (
        url.includes(`/api/habits/${HABIT_ID}/graduation-status`) &&
        method === 'GET'
      ) {
        const r = opts.graduation ?? { status: 200, body: makeGraduation() };
        return new Response(
          r.body !== undefined ? JSON.stringify(r.body) : '',
          { status: r.status },
        );
      }
      if (
        url.includes(`/api/habits/${HABIT_ID}/completions`) &&
        method === 'GET'
      ) {
        const r = opts.completions ?? { status: 200, body: [] };
        return new Response(
          r.body !== undefined ? JSON.stringify(r.body) : '',
          { status: r.status },
        );
      }
      if (
        url.includes(`/api/habits/${HABIT_ID}/re-scaffold`) &&
        method === 'POST'
      ) {
        const r = opts.reScaffold ?? {
          status: 200,
          body: {
            success: true,
            habit_id: HABIT_ID,
            previous_scaffolding_status: 'graduated',
            previous_notification_frequency: 'never',
            new_notification_frequency: 'daily',
            re_scaffold_count: 1,
            tightened_params: {},
            message: 'ok',
          },
        };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (
        url.includes(`/api/habits/${HABIT_ID}/step-down-frequency`) &&
        method === 'POST'
      ) {
        const r = opts.stepDown ?? {
          status: 200,
          body: {
            success: true,
            habit_id: HABIT_ID,
            previous_frequency: 'daily',
            new_frequency: '3x_per_week',
            message: 'ok',
          },
        };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url.endsWith(`/api/habits/${HABIT_ID}`) && method === 'PATCH') {
        const r = opts.patch ?? {
          status: 200,
          body: makeHabit({ status: 'paused' }),
        };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url.endsWith(`/api/habits/${HABIT_ID}`) && method === 'GET') {
        const r = opts.habit ?? { status: 200, body: makeHabit() };
        return new Response(
          r.body !== undefined ? JSON.stringify(r.body) : '',
          { status: r.status },
        );
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
      <MemoryRouter initialEntries={[`/habits/${HABIT_ID}`]}>
        <Route path="/habits/:habitId">
          <HabitDetailPage />
        </Route>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function clickAlertButton(name: string): Promise<void> {
  const alert = await screen.findByRole('alertdialog');
  await userEvent.click(within(alert).getByRole('button', { name }));
}

function findPatchCall(
  spy: ReturnType<typeof stubFetch>,
): RequestInit | undefined {
  const call = spy.mock.calls.find(
    ([input, init]) =>
      (init as RequestInit | undefined)?.method === 'PATCH' &&
      (typeof input === 'string'
        ? input
        : (input as URL).toString()
      ).includes(`/api/habits/${HABIT_ID}`),
  );
  return call ? (call[1] as RequestInit) : undefined;
}

function findPostCallByPath(
  spy: ReturnType<typeof stubFetch>,
  pathSubstring: string,
): boolean {
  return spy.mock.calls.some(
    ([input, init]) =>
      (init as RequestInit | undefined)?.method === 'POST' &&
      (typeof input === 'string'
        ? input
        : (input as URL).toString()
      ).includes(pathSubstring),
  );
}

// ---------------------------------------------------------------------------
// Render per scaffolding state
// ---------------------------------------------------------------------------

describe('HabitDetailPage — render per scaffolding state', () => {
  it('renders the tracking state without a progress bar', async () => {
    pair();
    stubFetch({
      graduation: {
        status: 200,
        body: makeGraduation({ scaffolding_status: 'tracking' }),
      },
    });

    renderPage();

    expect(await screen.findByText('Take meds')).toBeInTheDocument();
    expect(
      screen.getByText(/habit is in tracking mode/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('habit-graduation-accountable'),
    ).not.toBeInTheDocument();
  });

  it('renders the accountable state with progress bar + caption + days line', async () => {
    pair();
    stubFetch({
      habit: {
        status: 200,
        body: makeHabit({
          scaffolding_status: 'accountable',
          accountable_since: '2026-04-30',
        }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({
          scaffolding_status: 'accountable',
          days_accountable: 2,
          current_metrics: {
            already_done_rate: 0.5,
            total_notifications: 10,
            already_done_count: 5,
          },
          progress_summary:
            '50% of the way to graduation target (80%). 3 more days until minimum threshold met.',
        }),
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('habit-graduation-accountable'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('habit-graduation-target-marker'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('habit-graduation-caption')).toHaveTextContent(
      '50% of 80% target · 5/10 completions this window',
    );
    expect(screen.getByTestId('habit-graduation-days-line')).toHaveTextContent(
      '3 days until minimum threshold met.',
    );
  });

  it('renders the step-down suggestion when frequency_step_down.eligible is true', async () => {
    pair();
    stubFetch({
      habit: {
        status: 200,
        body: makeHabit({ scaffolding_status: 'accountable' }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({
          scaffolding_status: 'accountable',
          days_accountable: 7,
          frequency_step_down: {
            eligible: true,
            recommended_frequency: '3x_per_week',
            current_rate_over_recent: 0.95,
          },
        }),
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('habit-step-down-button'),
    ).toBeInTheDocument();
    expect(screen.getByText(/stepping down to/i)).toBeInTheDocument();
  });

  it('renders the graduated state with re-scaffold button and hides mark-complete', async () => {
    pair();
    stubFetch({
      habit: {
        status: 200,
        body: makeHabit({
          status: 'graduated',
          scaffolding_status: 'graduated',
          graduated_at: '2026-04-15T00:00:00Z',
        }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({
          scaffolding_status: 'graduated',
          progress_summary: 'Habit has graduated.',
        }),
      },
    });

    renderPage();

    expect(
      await screen.findByTestId('habit-re-scaffold-button'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('habit-mark-complete-button'),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mark-complete flow
// ---------------------------------------------------------------------------

describe('HabitDetailPage — mark complete', () => {
  it('enqueues + flushes when the user taps Mark complete', async () => {
    pair();
    stubFetch();

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-mark-complete-button'),
    );

    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalledWith({
        habit_id: HABIT_ID,
        completed_date: '2026-05-02',
        notes: null,
        enqueued_at: expect.any(String),
      });
    });
    expect(flushSpy).toHaveBeenCalled();
  });

  it('surfaces the queued retry toast when the flush attempts but does not deliver', async () => {
    pair();
    flushSpy.mockResolvedValueOnce(stopFlush);
    stubFetch();

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-mark-complete-button'),
    );

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/queued — will retry/i);
  });
});

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

describe('HabitDetailPage — pause / resume', () => {
  it('PATCHes status=paused after the user confirms the pause alert', async () => {
    pair();
    const fetchSpy = stubFetch({
      patch: { status: 200, body: makeHabit({ status: 'paused' }) },
    });

    renderPage();

    await userEvent.click(await screen.findByTestId('habit-pause-button'));
    await clickAlertButton('Pause');

    await waitFor(() => {
      const init = findPatchCall(fetchSpy);
      expect(init).toBeDefined();
      expect(init!.body).toBe(JSON.stringify({ status: 'paused' }));
    });
  });

  it('PATCHes status=active after the user confirms the resume alert', async () => {
    pair();
    const fetchSpy = stubFetch({
      habit: {
        status: 200,
        body: makeHabit({ status: 'paused' }),
      },
      patch: { status: 200, body: makeHabit({ status: 'active' }) },
    });

    renderPage();

    await userEvent.click(await screen.findByTestId('habit-resume-button'));
    await clickAlertButton('Resume');

    await waitFor(() => {
      const init = findPatchCall(fetchSpy);
      expect(init).toBeDefined();
      expect(init!.body).toBe(JSON.stringify({ status: 'active' }));
    });
  });
});

// ---------------------------------------------------------------------------
// Step-down flow
// ---------------------------------------------------------------------------

describe('HabitDetailPage — step down frequency', () => {
  it('POSTs to step-down-frequency and shows a success toast', async () => {
    pair();
    const fetchSpy = stubFetch({
      habit: {
        status: 200,
        body: makeHabit({ scaffolding_status: 'accountable' }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({
          scaffolding_status: 'accountable',
          frequency_step_down: {
            eligible: true,
            recommended_frequency: '3x_per_week',
            current_rate_over_recent: 0.95,
          },
        }),
      },
    });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-step-down-button'),
    );

    await waitFor(() => {
      expect(findPostCallByPath(fetchSpy, '/step-down-frequency')).toBe(true);
    });
    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/stepped down to 3x_per_week/i);
  });

  it('surfaces the 422 evaluation message when step-down is no longer recommended', async () => {
    pair();
    stubFetch({
      habit: {
        status: 200,
        body: makeHabit({ scaffolding_status: 'accountable' }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({
          scaffolding_status: 'accountable',
          frequency_step_down: {
            eligible: true,
            recommended_frequency: '3x_per_week',
            current_rate_over_recent: 0.95,
          },
        }),
      },
      stepDown: {
        status: 422,
        body: {
          detail: {
            message: 'Step-down no longer recommended',
            evaluation: { recommend_step_down: false },
          },
        },
      },
    });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-step-down-button'),
    );

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/step-down no longer recommended/i);
  });
});

// ---------------------------------------------------------------------------
// Re-scaffold flow
// ---------------------------------------------------------------------------

describe('HabitDetailPage — re-scaffold', () => {
  it('POSTs to re-scaffold after the user confirms and navigates back to /habits', async () => {
    pair();
    const fetchSpy = stubFetch({
      habit: {
        status: 200,
        body: makeHabit({
          status: 'graduated',
          scaffolding_status: 'graduated',
          graduated_at: '2026-04-15T00:00:00Z',
        }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({ scaffolding_status: 'graduated' }),
      },
    });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-re-scaffold-button'),
    );
    await clickAlertButton('Re-scaffold');

    await waitFor(() => {
      expect(findPostCallByPath(fetchSpy, '/re-scaffold')).toBe(true);
    });
    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith('/habits');
    });
  });
});

// ---------------------------------------------------------------------------
// Warning surface (Group 3 close-ledger carry-forward — see [2C-25] PR body)
// ---------------------------------------------------------------------------

describe('HabitDetailPage — warning surface', () => {
  it('subscribes on mount and surfaces a danger toast when paused fires for this habit', async () => {
    pair();
    stubFetch();

    renderPage();

    await screen.findByTestId('habit-mark-complete-button');
    expect(subscribeHabitWarningSpy).toHaveBeenCalled();
    expect(latestHabitWarningListener.current).not.toBeNull();

    await act(async () => {
      latestHabitWarningListener.current?.({
        kind: 'paused',
        habit_id: HABIT_ID,
      });
    });

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/habit is paused/i);
    expect(toast).toHaveAttribute('data-color', 'danger');
  });

  it('surfaces the not_found warning copy', async () => {
    pair();
    stubFetch();

    renderPage();

    await screen.findByTestId('habit-mark-complete-button');
    await act(async () => {
      latestHabitWarningListener.current?.({
        kind: 'not_found',
        habit_id: HABIT_ID,
      });
    });

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/habit no longer exists/i);
  });

  it('ignores warnings for a different habit_id', async () => {
    pair();
    stubFetch();

    renderPage();

    await screen.findByTestId('habit-mark-complete-button');
    await act(async () => {
      latestHabitWarningListener.current?.({
        kind: 'paused',
        habit_id: 'other-habit',
      });
    });

    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Offline graceful degradation
// ---------------------------------------------------------------------------

describe('HabitDetailPage — offline graceful degradation', () => {
  it('renders the not-found inline card with a back action when the habit GET returns 404', async () => {
    pair();
    stubFetch({ habit: { status: 404 } });

    renderPage();

    expect(await screen.findByTestId('habit-not-found')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('habit-not-found-back'));
    expect(replaceSpy).toHaveBeenCalledWith('/habits');
  });

  it('does not POST re-scaffold when offline; surfaces the connection toast', async () => {
    pair();
    Object.defineProperty(window.navigator, 'onLine', {
      value: false,
      configurable: true,
      writable: true,
    });
    const fetchSpy = stubFetch({
      habit: {
        status: 200,
        body: makeHabit({
          status: 'graduated',
          scaffolding_status: 'graduated',
          graduated_at: '2026-04-15T00:00:00Z',
        }),
      },
      graduation: {
        status: 200,
        body: makeGraduation({ scaffolding_status: 'graduated' }),
      },
    });

    renderPage();

    await userEvent.click(
      await screen.findByTestId('habit-re-scaffold-button'),
    );
    await clickAlertButton('Re-scaffold');

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(/action requires connection/i);
    expect(findPostCallByPath(fetchSpy, '/re-scaffold')).toBe(false);
  });
});
