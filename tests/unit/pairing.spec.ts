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
  PAIRING_TOKEN_KEY,
  PAIRING_URL_KEY,
  clearPairing,
  loadPairing,
  savePairing,
  subscribePairing,
} from '../../src/lib/pairing';

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
