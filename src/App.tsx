import { useEffect } from 'react';
import { Route, useHistory } from 'react-router-dom';
import { IonApp, IonRouterOutlet, setupIonicReact } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from './pages/SettingsPage';
import PairedPlaceholderPage from './pages/PairedPlaceholderPage';
import { loadPairing } from './lib/pairing';

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
      history.replace(pairing ? '/paired-placeholder' : '/settings');
    });
    return () => {
      cancelled = true;
    };
  }, [history]);
  return null;
};

const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <IonApp>
      <IonReactRouter>
        <IonRouterOutlet>
          <Route exact path="/settings">
            <SettingsPage />
          </Route>
          <Route exact path="/paired-placeholder">
            <PairedPlaceholderPage />
          </Route>
          <Route exact path="/">
            <RootRedirect />
          </Route>
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  </QueryClientProvider>
);

export default App;
