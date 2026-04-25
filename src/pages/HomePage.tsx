import { IonContent, IonPage } from '@ionic/react';

const HomePage: React.FC = () => {
  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="flex h-full w-full items-center justify-center bg-primary-900 text-neutral-50">
          <p className="text-lg">BRAIN Companion · Phase 2 scaffold</p>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default HomePage;
