package com.fluxmeridian.brain3companion

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Durable handoff for native-side intents that need to drive a JS-side
 * navigation — currently only the [2C-19] "Add note" tap on a `checkin_prompt`
 * notification.
 *
 * Writes to the same `CapacitorStorage` SharedPreferences file used by
 * `@capacitor/preferences`, so the JS layer reads the key via the Preferences
 * plugin on mount + on `appStateChange.active`. Avoids the bridge-readiness
 * race that a `triggerWindowJSEvent` dispatch would have at cold-start.
 *
 * Single-slot semantics: a second tap before JS drains the previous one
 * overwrites; the latest user intent wins. The JS layer clears the slot
 * after navigating.
 */
object PendingIntentStore {
    private const val TAG = "PendingIntentStore"
    private const val PREFS_NAME = "CapacitorStorage"
    private const val PENDING_KEY = "brain.pendingIntent"

    const val KIND_ADD_NOTE = "add_note"

    fun writeAddNote(
        context: Context,
        notificationId: String,
        cannedResponse: String?,
        enqueuedAt: String,
    ) {
        val payload = JSONObject().apply {
            put("kind", KIND_ADD_NOTE)
            put("notification_id", notificationId)
            put("canned_response", cannedResponse ?: JSONObject.NULL)
            put("enqueued_at", enqueuedAt)
        }
        val prefs = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(PENDING_KEY, payload.toString()).apply()
        Log.i(TAG, "Wrote pending intent: $KIND_ADD_NOTE notification_id=$notificationId")
    }
}
