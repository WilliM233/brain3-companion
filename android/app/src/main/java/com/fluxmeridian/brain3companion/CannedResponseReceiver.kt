package com.fluxmeridian.brain3companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * Receives canned-response action taps from the notification surface (phone or
 * watch). [2C-06] dismisses the notification and logs the chosen response —
 * the HTTP POST to BRAIN and offline-queue handling land in [2C-07].
 */
class CannedResponseReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESPOND) return
        val notificationId = intent.getStringExtra(EXTRA_NOTIFICATION_ID) ?: return
        val response = intent.getStringExtra(EXTRA_RESPONSE) ?: return
        val notificationType = intent.getStringExtra(EXTRA_NOTIFICATION_TYPE)

        Log.i(
            TAG,
            "Canned response tapped: notification_id=$notificationId " +
                "type=$notificationType response=$response",
        )

        NotificationManagerCompat.from(context).cancel(notificationId.hashCode())
    }

    companion object {
        private const val TAG = "CannedResponseReceiver"
        const val ACTION_RESPOND = "com.fluxmeridian.brain3companion.action.CANNED_RESPONSE"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
        const val EXTRA_NOTIFICATION_TYPE = "notification_type"
        const val EXTRA_RESPONSE = "response"
        const val EXTRA_SCHEDULED_DATE = "scheduled_date"
        const val EXTRA_RULE_ID = "rule_id"
    }
}
