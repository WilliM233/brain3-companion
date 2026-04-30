package com.fluxmeridian.brain3companion;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate so SafePushNotificationsPlugin
        // claims the "PushNotifications" name first; auto-discovery from
        // capacitor.plugins.json then no-ops on duplicate. See [2C-Bug-05].
        registerPlugin(SafePushNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
        BridgeHolder.INSTANCE.attach(getBridge());
    }

    @Override
    public void onDestroy() {
        BridgeHolder.INSTANCE.detach(getBridge());
        super.onDestroy();
    }
}
