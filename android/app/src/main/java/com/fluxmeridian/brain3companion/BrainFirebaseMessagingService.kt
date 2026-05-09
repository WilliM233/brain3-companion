package com.fluxmeridian.brain3companion

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.fluxmeridian.brain3companion.push.NotificationTitleMap
import com.fluxmeridian.brain3companion.push.PushPayload
import com.fluxmeridian.brain3companion.push.PushPayloadParser
import com.google.firebase.messaging.RemoteMessage

/**
 * Native FCM handler for BRAIN data-only pushes.
 *
 * Extends the @capacitor/push-notifications plugin's MessagingService so the
 * plugin's `onNewToken` token-refresh path stays intact for [2C-08]. Overrides
 * `onMessageReceived` and intentionally does NOT call super — for canned-response
 * notifications the native layer is authoritative; the JS layer does not see
 * the message. See [2C-06] spec.
 */
class BrainFirebaseMessagingService : MessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val payload = PushPayloadParser.parse(remoteMessage.data) ?: return
        showNotification(payload)
    }

    private fun showNotification(payload: PushPayload) {
        val builder = NotificationCompat.Builder(this, Notifications.CANNED_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(NotificationTitleMap.titleFor(payload.notificationType))
            .setContentText(payload.message)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .extend(NotificationCompat.WearableExtender())

        payload.cannedResponses.forEach { response ->
            builder.addAction(buildCannedAction(payload, response))
        }

        // [2C-19] Amendment to [2C-06]: `checkin_prompt` notifications gain
        // an "Add note" action button alongside the canned responses. Tapping
        // it opens MainActivity with a different action than canned taps —
        // the JS layer routes to `/checkins/notes/:id?canned=…` and the user
        // composes a freeform note. See PR for the spec amendment block.
        if (payload.notificationType == NOTIFICATION_TYPE_CHECKIN_PROMPT) {
            builder.addAction(buildAddNoteAction(payload, cannedContext = null))
        }

        NotificationManagerCompat.from(this)
            .notify(payload.notificationId.hashCode(), builder.build())
    }

    private fun buildCannedAction(
        payload: PushPayload,
        response: String,
    ): NotificationCompat.Action {
        val intent = Intent(this, CannedResponseReceiver::class.java).apply {
            action = CannedResponseReceiver.ACTION_RESPOND
            putExtra(CannedResponseReceiver.EXTRA_NOTIFICATION_ID, payload.notificationId)
            putExtra(CannedResponseReceiver.EXTRA_NOTIFICATION_TYPE, payload.notificationType)
            putExtra(CannedResponseReceiver.EXTRA_RESPONSE, response)
            putExtra(CannedResponseReceiver.EXTRA_SCHEDULED_DATE, payload.scheduledDate)
            putExtra(CannedResponseReceiver.EXTRA_RULE_ID, payload.ruleId)
        }
        val requestCode = (payload.notificationId + "|" + response).hashCode()
        val pendingIntent = PendingIntent.getBroadcast(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(0, response, pendingIntent).build()
    }

    private fun buildAddNoteAction(
        payload: PushPayload,
        cannedContext: String?,
    ): NotificationCompat.Action {
        val intent = Intent(this, MainActivity::class.java).apply {
            action = AddNoteActivityIntents.ACTION_ADD_NOTE
            putExtra(AddNoteActivityIntents.EXTRA_NOTIFICATION_ID, payload.notificationId)
            putExtra(AddNoteActivityIntents.EXTRA_CANNED_RESPONSE, cannedContext)
            // singleTask MainActivity reuses the existing instance; CLEAR_TOP
            // ensures we deliver onNewIntent rather than stacking duplicates.
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val requestCode = (payload.notificationId + "|add_note").hashCode()
        val pendingIntent = PendingIntent.getActivity(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(0, ADD_NOTE_LABEL, pendingIntent).build()
    }

    companion object {
        private const val NOTIFICATION_TYPE_CHECKIN_PROMPT = "checkin_prompt"
        private const val ADD_NOTE_LABEL = "Add note"
    }
}
