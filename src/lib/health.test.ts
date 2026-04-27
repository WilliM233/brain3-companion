import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pingHealth } from './health';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pingHealth', () => {
  it('returns { ok: true } on 200', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const result = await pingHealth('https://brain.local:8000', 'tok-abcdef');
    expect(result).toEqual({ ok: true });
  });

  it('targets `${url}/api/app/health` and trims trailing slashes', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await pingHealth('https://brain.local:8000/', 'tok-abcdef');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = fetchMock.mock.calls[0]?.[0];
    expect(requestUrl).toBe('https://brain.local:8000/api/app/health');
  });

  it('sends Authorization: Bearer <token>', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await pingHealth('https://brain.local:8000', 'tok-abcdef');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({ Authorization: 'Bearer tok-abcdef' });
    expect(init?.method).toBe('GET');
  });

  it('returns unauthorized on 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const result = await pingHealth('https://brain.local:8000', 'wrong-token');
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      statusCode: 401,
    });
  });

  it('returns server on 5xx with statusCode', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const result = await pingHealth('https://brain.local:8000', 'tok-abcdef');
    expect(result).toEqual({
      ok: false,
      reason: 'server',
      statusCode: 503,
    });
  });

  it('returns network when fetch throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await pingHealth('https://brain.local:8000', 'tok-abcdef');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('returns timeout when the request hangs past the 5-second budget', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const promise = pingHealth('https://brain.local:8000', 'tok-abcdef');
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});
