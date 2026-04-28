import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.fluxmeridian.brain3companion',
  appName: 'BRAIN Companion',
  webDir: 'dist',
  plugins: {
    SplashScreen: {
      backgroundColor: '#0B0714',
      showSpinner: false,
      launchAutoHide: true,
      launchShowDuration: 2000,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
