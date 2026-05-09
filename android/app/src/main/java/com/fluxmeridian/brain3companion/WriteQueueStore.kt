package com.fluxmeridian.brain3companion

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable enqueue for canned-response actions that survive app death.
 *
 * Writes to the same SharedPreferences file (`CapacitorStorage`, key
 * `brain.writeQueue`) used by the JS `@capacitor/preferences` plugin so the
 * JS layer drains the queue on its next launch, foreground, or `online`
 * event. Storage shape mirrors the JS [WriteQueueEntry] contract — a JSON
 * array of `{ notification_id, response, response_note, enqueued_at }`.
 *
 * The 500-entry cap is advisory: when reached we log a warning but never
 * drop entries, per [2C-07] spec.
 */
object WriteQueueStore {
    private const val TAG = "WriteQueueStore"
    private const val PREFS_NAME = "CapacitorStorage"
    private const val QUEUE_KEY = "brain.writeQueue"
    private const val SOFT_CAP = 500

    fun enqueue(
        context: Context,
        notificationId: String,
        response: String,
        responseNote: String?,
        enqueuedAt: String,
        notificationType: String? = null,
    ) {
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(QUEUE_KEY, null)
        val array = if (raw.isNullOrEmpty()) {
            JSONArray()
        } else {
            try {
                JSONArray(raw)
            } catch (err: Throwable) {
                Log.w(TAG, "Corrupt $QUEUE_KEY contents — resetting", err)
                JSONArray()
            }
        }
        // [2C-19] adds optional `notification_type` so the JS flush handler
        // can detect `checkin_prompt` and post the additional /api/checkins/.
        // Older entries without the field continue to flow through /respond
        // only — backward-compatible.
        val entry = JSONObject().apply {
            put("notification_id", notificationId)
            put("response", response)
            put("response_note", responseNote ?: JSONObject.NULL)
            put("enqueued_at", enqueuedAt)
            if (notificationType != null) {
                put("notification_type", notificationType)
            }
        }
        array.put(entry)
        if (array.length() > SOFT_CAP) {
            Log.w(TAG, "writeQueue size ${array.length()} exceeds soft cap $SOFT_CAP")
        }
        prefs.edit().putString(QUEUE_KEY, array.toString()).apply()
    }
}
