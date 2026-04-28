/**
 * Device registration flow for [2C-08].
 *
 * Mirrors the server contract from [2C-05] (`brain3` POST /api/app/devices):
 * `{ fcm_token, platform, label }` with bearer auth. The server handles
 * upsert on `fcm_token` uniqueness — first registration returns 201, a
 * matching token returns 200 with `last_seen_at` refreshed. FCM token
 * rotation surfaces as a fresh `registration` event from the plugin and
 * triggers a re-POST; the server treats the new value as a new row.
 */

import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import {
  PushNotifications,
  type Token,
} from '@capacitor/push-notifications';
import type { Pairing } from './pairing';

export const REGISTERED_TOKEN_KEY = 'brain.deviceRegisteredToken';

export type RegistrationStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'registered'; fcmToken: string }
  | { kind: 'permission_denied' }
  | { kind: 'error'; message: string };

type Listener = (status: RegistrationStatus) => void;

const listeners = new Set<Listener>();
let currentStatus: RegistrationStatus = { kind: 'idle' };
let listenersInstalled = false;
let activePairing: Pairing | null = null;

function setStatus(next: RegistrationStatus): void {
  currentStatus = next;
  for (const l of listeners) l(next);
}

export function getRegistrationStatus(): RegistrationStatus {
  return currentStatus;
}

export function subscribeRegistration(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadRegisteredToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REGISTERED_TOKEN_KEY });
  return value ?? null;
}

async function persistRegisteredToken(token: string): Promise<void> {
  await Preferences.set({ key: REGISTERED_TOKEN_KEY, value: token });
}

export async function clearDeviceRegistration(): Promise<void> {
  await Preferences.remove({ key: REGISTERED_TOKEN_KEY });
  setStatus({ kind: 'idle' });
}

export async function postDeviceRegistration(
  pairing: Pairing,
  fcmToken: string,
  label: string | null,
): Promise<Response> {
  const base = pairing.url.replace(/\/$/, '');
  return await fetch(`${base}/api/app/devices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pairing.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fcm_token: fcmToken,
      platform: 'android',
      label,
    }),
  });
}

async function getDeviceLabel(): Promise<string | null> {
  try {
    const info = await Device.getInfo();
    return info.model ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare the current FCM token against the persisted registration marker.
 * Skip the POST when they match (don't re-register every launch). When the
 * value differs — first registration or FCM token rotation — POST and
 * persist on success.
 */
export async function syncFcmToken(fcmToken: string): Promise<void> {
  if (!activePairing) return;
  const stored = await loadRegisteredToken();
  if (stored === fcmToken) {
    setStatus({ kind: 'registered', fcmToken });
    return;
  }
  setStatus({ kind: 'pending' });
  let response: Response;
  try {
    const label = await getDeviceLabel();
    response = await postDeviceRegistration(activePairing, fcmToken, label);
  } catch (err) {
    setStatus({
      kind: 'error',
      message: err instanceof Error ? err.message : 'Network error',
    });
    return;
  }
  if (!response.ok) {
    setStatus({
      kind: 'error',
      message: `Device registration failed (${response.status})`,
    });
    return;
  }
  await persistRegisteredToken(fcmToken);
  setStatus({ kind: 'registered', fcmToken });
}

function installPushListeners(): void {
  if (listenersInstalled) return;
  PushNotifications.addListener('registration', (token: Token) => {
    void syncFcmToken(token.value);
  });
  PushNotifications.addListener('registrationError', (error: unknown) => {
    let message = 'Push registration error';
    if (typeof error === 'string') {
      message = error;
    } else if (
      error &&
      typeof error === 'object' &&
      'error' in error &&
      typeof (error as { error?: unknown }).error === 'string'
    ) {
      message = (error as { error: string }).error;
    }
    setStatus({ kind: 'error', message });
  });
  listenersInstalled = true;
}

export async function runDeviceRegistration(pairing: Pairing): Promise<void> {
  activePairing = pairing;
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  installPushListeners();
  try {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      setStatus({ kind: 'permission_denied' });
      return;
    }
    setStatus({ kind: 'pending' });
    await PushNotifications.register();
  } catch (err) {
    setStatus({
      kind: 'error',
      message: err instanceof Error ? err.message : 'Push registration failed',
    });
  }
}

export async function reRegisterDevice(): Promise<void> {
  if (!activePairing) return;
  await clearDeviceRegistration();
  await runDeviceRegistration(activePairing);
}

export function __resetForTests(): void {
  listeners.clear();
  currentStatus = { kind: 'idle' };
  listenersInstalled = false;
  activePairing = null;
}
