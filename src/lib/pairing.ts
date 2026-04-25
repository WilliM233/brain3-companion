import { Preferences } from '@capacitor/preferences';

export interface Pairing {
  url: string;
  token: string;
}

export const PAIRING_URL_KEY = 'brain.serverUrl';
export const PAIRING_TOKEN_KEY = 'brain.bearerToken';

type Listener = (pairing: Pairing | null) => void;

const listeners = new Set<Listener>();

function notify(pairing: Pairing | null): void {
  for (const listener of listeners) {
    listener(pairing);
  }
}

/**
 * Persist URL + token together. Pseudo-atomic: on token-write failure,
 * the URL is removed so the keys remain in a both-or-neither state.
 */
export async function savePairing(url: string, token: string): Promise<void> {
  await Preferences.set({ key: PAIRING_URL_KEY, value: url });
  try {
    await Preferences.set({ key: PAIRING_TOKEN_KEY, value: token });
  } catch (error) {
    await Preferences.remove({ key: PAIRING_URL_KEY });
    throw error;
  }
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
