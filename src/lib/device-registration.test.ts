import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@capacitor/device', () => ({
  Device: {
    getInfo: vi.fn(async () => ({ model: 'Pixel 8' })),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'android'),
  },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn(),
    register: vi.fn(),
    addListener: vi.fn(),
  },
}));

import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import {
  REGISTERED_TOKEN_KEY,
  __resetForTests,
  clearDeviceRegistration,
  getRegistrationStatus,
  postDeviceRegistration,
  reRegisterDevice,
  runDeviceRegistration,
  subscribeRegistration,
  syncFcmToken,
} from './device-registration';

const PAIRING = {
  url: 'https://brain.local:8000',
  token: 'bearer-abc-123',
} as const;

const FCM_TOKEN_A = 'fcm-token-aaaaaaaa-1111';
const FCM_TOKEN_B = 'fcm-token-bbbbbbbb-2222';

const prefsStore = new Map<string, string>();

beforeEach(() => {
  __resetForTests();
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

describe('postDeviceRegistration — server contract', () => {
  // Mirrors brain3 [2C-05] DeviceRegisterRequest schema:
  //   { fcm_token: str, platform: "android"|"ios", label: str | None }
  // and the bearer-auth requirement on /api/app/devices.

  it('POSTs the contract body to /api/app/devices with bearer auth', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await postDeviceRegistration(PAIRING, FCM_TOKEN_A, 'Pixel 8');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0]!;
    const [url, init] = firstCall;
    expect(url).toBe('https://brain.local:8000/api/app/devices');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bearer-abc-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({
      fcm_token: FCM_TOKEN_A,
      platform: 'android',
      label: 'Pixel 8',
    });
  });

  it('serialises a missing label as JSON null', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await postDeviceRegistration(PAIRING, FCM_TOKEN_A, null);

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);
    expect(body).toEqual({
      fcm_token: FCM_TOKEN_A,
      platform: 'android',
      label: null,
    });
  });

  it('strips a trailing slash from pairing.url before joining', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await postDeviceRegistration(
      { url: 'https://brain.local:8000/', token: 'tok' },
      FCM_TOKEN_A,
      null,
    );

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://brain.local:8000/api/app/devices',
    );
  });
});

describe('syncFcmToken — registered-flag and token-refresh logic', () => {
  it('POSTs and persists the token on first registration', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_A);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(prefsStore.get(REGISTERED_TOKEN_KEY)).toBe(FCM_TOKEN_A);
    expect(getRegistrationStatus()).toEqual({
      kind: 'registered',
      fcmToken: FCM_TOKEN_A,
    });
  });

  it('skips POST when the stored token matches (registered flag honored)', async () => {
    prefsStore.set(REGISTERED_TOKEN_KEY, FCM_TOKEN_A);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_A);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getRegistrationStatus()).toEqual({
      kind: 'registered',
      fcmToken: FCM_TOKEN_A,
    });
  });

  it('re-POSTs when the FCM token rotates (token-refresh case)', async () => {
    prefsStore.set(REGISTERED_TOKEN_KEY, FCM_TOKEN_A);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_B);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string),
    ).toMatchObject({ fcm_token: FCM_TOKEN_B });
    expect(prefsStore.get(REGISTERED_TOKEN_KEY)).toBe(FCM_TOKEN_B);
  });

  it('surfaces server errors and does NOT persist on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_A);

    expect(prefsStore.has(REGISTERED_TOKEN_KEY)).toBe(false);
    const status = getRegistrationStatus();
    expect(status.kind).toBe('error');
  });

  it('surfaces network failures and does NOT persist (retry-next-launch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_A);

    expect(prefsStore.has(REGISTERED_TOKEN_KEY)).toBe(false);
    const status = getRegistrationStatus();
    expect(status.kind).toBe('error');
  });
});

describe('runDeviceRegistration — permission and listener wiring', () => {
  it('marks status permission_denied and skips register() when not granted', async () => {
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'denied',
    });

    await runDeviceRegistration(PAIRING);

    expect(PushNotifications.register).not.toHaveBeenCalled();
    expect(getRegistrationStatus()).toEqual({ kind: 'permission_denied' });
  });

  it('installs the registration listener exactly once across re-runs', async () => {
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    await runDeviceRegistration(PAIRING);

    const registrationCalls = (
      vi.mocked(PushNotifications.addListener).mock.calls as Array<[string, unknown]>
    ).filter(([event]) => event === 'registration');
    expect(registrationCalls).toHaveLength(1);
  });
});

describe('clearDeviceRegistration', () => {
  it('removes the persisted token and emits idle', async () => {
    prefsStore.set(REGISTERED_TOKEN_KEY, FCM_TOKEN_A);
    const events: string[] = [];
    subscribeRegistration((s) => events.push(s.kind));

    await clearDeviceRegistration();

    expect(prefsStore.has(REGISTERED_TOKEN_KEY)).toBe(false);
    expect(events).toContain('idle');
  });
});

describe('reRegisterDevice', () => {
  it('clears stored token and re-runs registration against the active pairing', async () => {
    prefsStore.set(REGISTERED_TOKEN_KEY, FCM_TOKEN_A);
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });

    await runDeviceRegistration(PAIRING);
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);

    await reRegisterDevice();

    expect(prefsStore.has(REGISTERED_TOKEN_KEY)).toBe(false);
    expect(PushNotifications.register).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeRegistration', () => {
  it('notifies listeners on status changes and stops after unsubscribe', async () => {
    const events: string[] = [];
    const unsubscribe = subscribeRegistration((s) => events.push(s.kind));

    await clearDeviceRegistration(); // idle
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'granted',
    });
    await runDeviceRegistration(PAIRING);
    await syncFcmToken(FCM_TOKEN_A); // pending → registered

    unsubscribe();
    await clearDeviceRegistration(); // listener should not see this

    // runDeviceRegistration emits pending before register(); syncFcmToken
    // emits pending again before the POST. Two pendings is the truth.
    expect(events).toEqual(['idle', 'pending', 'pending', 'registered']);
  });
});
