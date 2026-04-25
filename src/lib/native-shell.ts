import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

export async function configureNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
  await StatusBar.setStyle({ style: Style.Dark });
  if (Capacitor.getPlatform() === 'android') {
    await StatusBar.setBackgroundColor({ color: '#0B0714' });
  }
}
