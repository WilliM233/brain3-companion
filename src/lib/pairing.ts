import { Preferences } from '@capacitor/preferences';

export interface Pairing {
  url: string;
  token: string;
}

export const PAIRING_URL_KEY = 'brain.serverUrl';
export const PAIRING_TOKEN_KEY = 'brain.bearerToken';

/**
 * Markers persisted alongside the pairing to drive [2C-31] cache-wipe
 * detection. Both survive {@link clearPairing} so the next Connect can
 * compare against the previous pairing's identity. Comparing the SHA-256
 * hash (first 16 bytes hex) rather than the raw token keeps the token from
 * leaking through Preferences inspection per Pass 5 Summary §3 [2C-31].
 */
export const PAIRING_TOKEN_HASH_KEY = 'brain.pairing.tokenHash';
export const PAIRING_PREVIOUS_URL_KEY = 'brain.pairing.previousUrl';

type Listener = (pairing: Pairing | null) => void;

const listeners = new Set<Listener>();

function notify(pairing: Pairing | null): void {
  for (const listener of listeners) {
    listener(pairing);
  }
}

/**
 * SHA-256 hash of the bearer token, truncated to the first 16 bytes and
 * hex-encoded. Used as the wipe-comparison anchor in [2C-31] and as the
 * per-token idempotency key for the cache seed (`brain.cache.seedCompleteFor`).
 */
export async function computeTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadStoredTokenHash(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PAIRING_TOKEN_HASH_KEY });
  return value ?? null;
}

export async function loadPreviousPairingUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PAIRING_PREVIOUS_URL_KEY });
  return value ?? null;
}

/**
 * Persist URL + token together. Pseudo-atomic: on token-write failure,
 * the URL is removed so the keys remain in a both-or-neither state.
 *
 * Also updates the [2C-31] wipe-comparison markers
 * ({@link PAIRING_TOKEN_HASH_KEY}, {@link PAIRING_PREVIOUS_URL_KEY}). The
 * markers are written after the pseudo-atomic block — a marker-write
 * failure surfaces as a rejected promise but does not roll back the live
 * URL+token, since the pairing IS functional even without the markers.
 */
export async function savePairing(url: string, token: string): Promise<void> {
  const tokenHash = await computeTokenHash(token);
  await Preferences.set({ key: PAIRING_URL_KEY, value: url });
  try {
    await Preferences.set({ key: PAIRING_TOKEN_KEY, value: token });
  } catch (error) {
    await Preferences.remove({ key: PAIRING_URL_KEY });
    throw error;
  }
  await Preferences.set({ key: PAIRING_TOKEN_HASH_KEY, value: tokenHash });
  await Preferences.set({ key: PAIRING_PREVIOUS_URL_KEY, value: url });
  notify({ url, token });
}

export async function loadPairing(): Promise<Pairing | null> {
  const [urlResult, tokenResult] = await Promise.all([
    Preferences.get({ key: PAIRING_URL_KEY }),
    Preferences.get({ key: PAIRING_TOKEN_KEY }),
  ]);
  const url = urlResult.value;
  const token = tokenResult.value;
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

export async function clearPairing(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: PAIRING_URL_KEY }),
    Preferences.remove({ key: PAIRING_TOKEN_KEY }),
  ]);
  notify(null);
}

export function subscribePairing(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
