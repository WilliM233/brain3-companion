import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

const PairedPlaceholderPage: React.FC = () => {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Paired</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen className="ion-padding">
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-neutral-50">
          <p className="text-xl font-medium">Paired</p>
          <p className="text-sm text-neutral-300">Notifications view coming soon.</p>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default PairedPlaceholderPage;
