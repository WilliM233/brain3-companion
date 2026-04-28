package com.fluxmeridian.brain3companion.push

import org.json.JSONArray
import org.json.JSONException

/**
 * Parses the FCM data-only push payload sent by brain3.
 *
 * Carry-forward from [2C-05] PR #213 D-23: FCM v1 `data` is map<string, string>.
 * Server JSON-encodes `canned_responses` as a string and substitutes "" for null
 * `rule_id`. This parser inverts both transforms.
 */
object PushPayloadParser {

    fun parse(data: Map<String, String>): PushPayload? {
        val notificationId = data["notification_id"]?.takeIf { it.isNotEmpty() } ?: return null
        val notificationType = data["notification_type"]?.takeIf { it.isNotEmpty() } ?: return null
        val message = data["message"] ?: return null
        return PushPayload(
            notificationId = notificationId,
            notificationType = notificationType,
            message = message,
            cannedResponses = parseCannedResponses(data["canned_responses"]),
            scheduledDate = data["scheduled_date"]?.takeIf { it.isNotEmpty() },
            ruleId = data["rule_id"]?.takeIf { it.isNotEmpty() },
        )
    }

    private fun parseCannedResponses(raw: String?): List<String> {
        if (raw.isNullOrEmpty()) return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).map { array.getString(it) }
        } catch (_: JSONException) {
            emptyList()
        }
    }
}
