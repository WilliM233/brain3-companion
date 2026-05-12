import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import {
  PAIRING_PREVIOUS_URL_KEY,
  PAIRING_TOKEN_HASH_KEY,
  PAIRING_TOKEN_KEY,
  PAIRING_URL_KEY,
  clearPairing,
  computeTokenHash,
  loadPreviousPairingUrl,
  loadStoredTokenHash,
  loadPairing,
  savePairing,
  subscribePairing,
} from './pairing';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.mocked(Preferences.get).mockReset();
  vi.mocked(Preferences.set).mockReset();
  vi.mocked(Preferences.remove).mockReset();
  vi.mocked(Preferences.get).mockImplementation(async ({ key }) => ({
    value: store.get(key) ?? null,
  }));
  vi.mocked(Preferences.set).mockImplementation(async ({ key, value }) => {
    store.set(key, value);
  });
  vi.mocked(Preferences.remove).mockImplementation(async ({ key }) => {
    store.delete(key);
  });
});

describe('savePairing', () => {
  it('persists URL and token under the brain. namespace', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    expect(store.get(PAIRING_URL_KEY)).toBe('https://brain.local:8000');
    expect(store.get(PAIRING_TOKEN_KEY)).toBe('abcdef1234');
  });

  it('rolls back the URL write if the token write fails (both-or-neither)', async () => {
    vi.mocked(Preferences.set).mockReset();
    vi.mocked(Preferences.set)
      .mockImplementationOnce(async ({ key, value }) => {
        store.set(key, value);
      })
      .mockImplementationOnce(async () => {
        throw new Error('write failure');
      });

    await expect(
      savePairing('https://brain.local:8000', 'abcdef1234'),
    ).rejects.toThrow('write failure');

    expect(store.has(PAIRING_URL_KEY)).toBe(false);
    expect(store.has(PAIRING_TOKEN_KEY)).toBe(false);
  });

  it('[2C-31] writes the token hash and previous-URL markers alongside the pairing', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    const expectedHash = await computeTokenHash('abcdef1234');
    expect(store.get(PAIRING_TOKEN_HASH_KEY)).toBe(expectedHash);
    expect(store.get(PAIRING_PREVIOUS_URL_KEY)).toBe('https://brain.local:8000');
  });
});

describe('loadPairing', () => {
  it('returns the pairing when both keys are present', async () => {
    store.set(PAIRING_URL_KEY, 'https://brain.local:8000');
    store.set(PAIRING_TOKEN_KEY, 'abcdef1234');
    expect(await loadPairing()).toEqual({
      url: 'https://brain.local:8000',
      token: 'abcdef1234',
    });
  });

  it('returns null if only the URL is stored', async () => {
    store.set(PAIRING_URL_KEY, 'https://brain.local:8000');
    expect(await loadPairing()).toBeNull();
  });

  it('returns null if only the token is stored', async () => {
    store.set(PAIRING_TOKEN_KEY, 'abcdef1234');
    expect(await loadPairing()).toBeNull();
  });

  it('returns null if neither key is stored', async () => {
    expect(await loadPairing()).toBeNull();
  });
});

describe('clearPairing', () => {
  it('removes both the URL and the token', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    await clearPairing();
    expect(store.has(PAIRING_URL_KEY)).toBe(false);
    expect(store.has(PAIRING_TOKEN_KEY)).toBe(false);
  });

  it('[2C-31] preserves the token hash + previous-URL markers across re-pair', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    const expectedHash = await computeTokenHash('abcdef1234');
    await clearPairing();
    expect(store.get(PAIRING_TOKEN_HASH_KEY)).toBe(expectedHash);
    expect(store.get(PAIRING_PREVIOUS_URL_KEY)).toBe('https://brain.local:8000');
  });
});

describe('[2C-31] computeTokenHash', () => {
  it('returns a 32-character hex string (16 bytes)', async () => {
    const hash = await computeTokenHash('abcdef1234');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for identical inputs', async () => {
    const a = await computeTokenHash('the-same-token');
    const b = await computeTokenHash('the-same-token');
    expect(a).toBe(b);
  });

  it('differs for different inputs (even by one character)', async () => {
    const a = await computeTokenHash('token-one');
    const b = await computeTokenHash('token-two');
    expect(a).not.toBe(b);
  });
});

describe('[2C-31] marker loaders', () => {
  it('loadStoredTokenHash returns the hash written by savePairing', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    const expectedHash = await computeTokenHash('abcdef1234');
    expect(await loadStoredTokenHash()).toBe(expectedHash);
  });

  it('loadStoredTokenHash returns null when no pairing has ever been saved', async () => {
    expect(await loadStoredTokenHash()).toBeNull();
  });

  it('loadPreviousPairingUrl returns the URL written by savePairing', async () => {
    await savePairing('https://brain.local:8000', 'abcdef1234');
    expect(await loadPreviousPairingUrl()).toBe('https://brain.local:8000');
  });

  it('loadPreviousPairingUrl returns null when no pairing has ever been saved', async () => {
    expect(await loadPreviousPairingUrl()).toBeNull();
  });
});

describe('subscribePairing', () => {
  it('notifies subscribers on save and clear, and stops after unsubscribe', async () => {
    const events: Array<{ url: string; token: string } | null> = [];
    const unsubscribe = subscribePairing((pairing) => events.push(pairing));

    await savePairing('https://brain.local:8000', 'abcdef1234');
    await clearPairing();

    unsubscribe();
    await savePairing('https://brain.local:8000', 'zzzzzzzz');

    expect(events).toEqual([
      { url: 'https://brain.local:8000', token: 'abcdef1234' },
      null,
    ]);
  });
});
