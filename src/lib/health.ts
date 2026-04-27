/**
 * Validation-ping client for BRAIN's authed `/api/app/health` endpoint.
 *
 * Returns a discriminated union so callers can branch on outcome without
 * unwrapping exceptions. `pingHealth` is intentionally throw-free — every
 * outcome (success, auth failure, server failure, network, timeout) maps to
 * a `HealthResult` value. See [2C-13] / brain3-companion#8.
 */

export type HealthResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unauthorized' | 'network' | 'server' | 'timeout';
      statusCode?: number;
    };

const HEALTH_PATH = '/api/app/health';
const TIMEOUT_MS = 5_000;

export async function pingHealth(url: string, token: string): Promise<HealthResult> {
  const base = url.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${HEALTH_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 200) {
      return { ok: true };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized', statusCode: 401 };
    }
    return { ok: false, reason: 'server', statusCode: response.status };
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
