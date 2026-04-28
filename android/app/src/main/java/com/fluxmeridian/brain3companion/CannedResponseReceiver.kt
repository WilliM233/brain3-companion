package com.fluxmeridian.brain3companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Receives canned-response action taps from the notification surface (phone
 * or watch). Persists the response to the durable write queue, dismisses the
 * notification from the tray, and best-effort signals the JS layer to flush
 * immediately. The JS layer owns the HTTP POST and offline-retry behavior —
 * see [WriteQueueStore] and `src/lib/writeQueue.ts`. Per [2C-07] spec.
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

        WriteQueueStore.enqueue(
            context = context,
            notificationId = notificationId,
            response = response,
            responseNote = null,
            enqueuedAt = isoTimestamp(),
        )

        NotificationManagerCompat.from(context).cancel(notificationId.hashCode())

        BridgeHolder.triggerJSEvent(JS_EVENT)
    }

    private fun isoTimestamp(): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date())
    }

    companion object {
        private const val TAG = "CannedResponseReceiver"
        private const val JS_EVENT = "brainCannedResponse"
        const val ACTION_RESPOND = "com.fluxmeridian.brain3companion.action.CANNED_RESPONSE"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
        const val EXTRA_NOTIFICATION_TYPE = "notification_type"
        const val EXTRA_RESPONSE = "response"
        const val EXTRA_SCHEDULED_DATE = "scheduled_date"
        const val EXTRA_RULE_ID = "rule_id"
    }
}
