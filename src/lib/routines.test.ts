import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTINES_PATH, fetchRoutine } from './routines';

const PAIRING = {
  url: 'https://brain.local:8000',
  token: 'bearer-routine',
} as const;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchRoutine', () => {
  it('GETs /api/routines/{id} with bearer auth and returns the routine', async () => {
    const routine = { id: 'r-1', title: 'Morning kit' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(routine), { status: 200 }),
    );

    const result = await fetchRoutine(PAIRING, 'r-1');

    expect(result).toEqual({ ok: true, routine });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url as string).toBe(`${PAIRING.url}${ROUTINES_PATH}r-1`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(init?.method).toBe('GET');
  });

  it('returns not_found on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404 }),
    );
    const result = await fetchRoutine(PAIRING, 'missing');
    expect(result).toEqual({ ok: false, reason: 'not_found', statusCode: 404 });
  });

  it('returns unauthorized on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const result = await fetchRoutine(PAIRING, 'r-1');
    expect(result).toEqual({ ok: false, reason: 'unauthorized', statusCode: 401 });
  });

  it('returns network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('disconnected'));
    const result = await fetchRoutine(PAIRING, 'r-1');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});
