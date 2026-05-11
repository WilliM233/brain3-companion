import { useEffect } from 'react';
import { Route, useHistory } from 'react-router-dom';
import { IonApp, IonRouterOutlet, setupIonicReact } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from './pages/SettingsPage';
import NotificationsPage from './pages/NotificationsPage';
import NotificationDetailPage from './pages/NotificationDetailPage';
import HabitsPage from './pages/HabitsPage';
import HabitDetailPage from './pages/HabitDetailPage';
import RoutinesPage from './pages/RoutinesPage';
import RoutineDetailPage from './pages/RoutineDetailPage';
import CheckinsPage from './pages/CheckinsPage';
import CheckinDetailPage from './pages/CheckinDetailPage';
import CheckinNoteEntryPage from './pages/CheckinNoteEntryPage';
import RulesPage from './pages/RulesPage';
import RuleDetailPage from './pages/RuleDetailPage';
import { loadPairing, subscribePairing } from './lib/pairing';
import {
  clearDeviceRegistration,
  runDeviceRegistration,
} from './lib/device-registration';
import { initWriteQueue } from './lib/writeQueue';
import { initCompletionQueues } from './lib/completionQueues';
import { ConnectionStateProvider } from './lib/connection/ConnectionStateProvider';
import PermanentFailureToast from './components/PermanentFailureToast';
import {
  clearPendingIntent,
  pendingIntentRoute,
  readPendingIntent,
} from './lib/pendingIntent';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';

import '@ionic/react/css/palettes/dark.system.css';

/* Theme variables */
import './theme/variables.css';
/* Tailwind utility layer */
import './theme/tailwind.css';

setupIonicReact();

const queryClient = new QueryClient();

const RootRedirect: React.FC = () => {
  const history = useHistory();
  useEffect(() => {
    let cancelled = false;
    loadPairing().then((pairing) => {
      if (cancelled) return;
      history.replace(pairing ? '/notifications' : '/settings');
    });
    return () => {
      cancelled = true;
    };
  }, [history]);
  return null;
};

const DeviceRegistrar: React.FC = () => {
  useEffect(() => {
    let cancelled = false;
    loadPairing().then((pairing) => {
      if (cancelled || !pairing) return;
      void runDeviceRegistration(pairing);
    });
    const unsubscribe = subscribePairing((pairing) => {
      if (pairing) {
        void runDeviceRegistration(pairing);
      } else {
        void clearDeviceRegistration();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return null;
};

const WriteQueueRunner: React.FC = () => {
  useEffect(() => {
    const teardownNotifications = initWriteQueue();
    const teardownCompletions = initCompletionQueues();
    return () => {
      teardownNotifications();
      teardownCompletions();
    };
  }, []);
  return null;
};

/**
 * [2C-19] Bridge for native-side pending intents — the FCM "Add note" tap
 * on a `checkin_prompt` notification writes a slot via Kotlin
 * `PendingIntentStore`; this hook drains it on mount and on
 * `appStateChange.active`, navigates, and clears.
 */
const PendingIntentRunner: React.FC = () => {
  const history = useHistory();
  useEffect(() => {
    let cancelled = false;
    const drain = async (): Promise<void> => {
      const intent = await readPendingIntent();
      if (cancelled || intent === null) return;
      const route = pendingIntentRoute(intent);
      await clearPendingIntent();
      history.push(route);
    };
    void drain();

    if (!Capacitor.isNativePlatform()) {
      return () => {
        cancelled = true;
      };
    }
    const handlePromise = CapacitorApp.addListener(
      'appStateChange',
      ({ isActive }) => {
        if (isActive) void drain();
      },
    );
    return () => {
      cancelled = true;
      void handlePromise.then((handle) => handle.remove());
    };
  }, [history]);
  return null;
};

const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <ConnectionStateProvider>
      <IonApp>
        <DeviceRegistrar />
        <WriteQueueRunner />
        <PermanentFailureToast />
        <IonReactRouter>
          <PendingIntentRunner />
          <IonRouterOutlet>
            <Route exact path="/settings">
              <SettingsPage />
            </Route>
            <Route exact path="/notifications">
              <NotificationsPage />
            </Route>
            <Route exact path="/notifications/:notificationId">
              <NotificationDetailPage />
            </Route>
            <Route exact path="/habits">
              <HabitsPage />
            </Route>
            <Route exact path="/habits/:habitId">
              <HabitDetailPage />
            </Route>
            <Route exact path="/routines">
              <RoutinesPage />
            </Route>
            <Route exact path="/routines/:routineId">
              <RoutineDetailPage />
            </Route>
            <Route exact path="/checkins">
              <CheckinsPage />
            </Route>
            {/* [2C-19] Note-entry route — declared before /checkins/:checkinId
                so the literal "notes" segment matches first under react-router 5
                non-exact resolution. The `exact` flag also keeps both routes
                isolated. */}
            <Route exact path="/checkins/notes/:notificationId">
              <CheckinNoteEntryPage />
            </Route>
            <Route exact path="/checkins/:checkinId">
              <CheckinDetailPage />
            </Route>
            <Route exact path="/rules">
              <RulesPage />
            </Route>
            <Route exact path="/rules/:ruleId">
              <RuleDetailPage />
            </Route>
            <Route exact path="/">
              <RootRedirect />
            </Route>
          </IonRouterOutlet>
        </IonReactRouter>
      </IonApp>
    </ConnectionStateProvider>
  </QueryClientProvider>
);

export default App;
