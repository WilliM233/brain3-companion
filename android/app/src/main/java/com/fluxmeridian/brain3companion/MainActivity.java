package com.fluxmeridian.brain3companion;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate so SafePushNotificationsPlugin
        // claims the "PushNotifications" name first; auto-discovery from
        // capacitor.plugins.json then no-ops on duplicate. See [2C-Bug-05].
        registerPlugin(SafePushNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
        BridgeHolder.INSTANCE.attach(getBridge());
        handleAddNoteIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask + CLEAR_TOP routes the FCM "Add note" tap here when the
        // app is already running. Cold-start is handled in onCreate.
        setIntent(intent);
        handleAddNoteIntent(intent);
    }

    private void handleAddNoteIntent(Intent intent) {
        if (intent == null) return;
        if (!AddNoteActivityIntents.ACTION_ADD_NOTE.equals(intent.getAction())) return;
        String notificationId = intent.getStringExtra(
            AddNoteActivityIntents.EXTRA_NOTIFICATION_ID
        );
        if (notificationId == null || notificationId.isEmpty()) return;
        String cannedResponse = intent.getStringExtra(
            AddNoteActivityIntents.EXTRA_CANNED_RESPONSE
        );
        PendingIntentStore.INSTANCE.writeAddNote(
            getApplicationContext(),
            notificationId,
            cannedResponse,
            isoTimestamp()
        );
    }

    private static String isoTimestamp() {
        SimpleDateFormat format = new SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US
        );
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    @Override
    public void onDestroy() {
        BridgeHolder.INSTANCE.detach(getBridge());
        super.onDestroy();
    }
}
