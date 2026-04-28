package com.fluxmeridian.brain3companion.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors the server-side payload contract enforced by
 * `tests/test_delivery_dispatch.py::test_dispatch_payload_contract` in brain3.
 * See [2C-05] PR #213 D-23.
 */
class PushPayloadParserTest {

    @Test
    fun `parses a fully-populated habit nudge payload`() {
        val data = mapOf(
            "notification_id" to "notif-abc",
            "notification_type" to "habit_nudge",
            "message" to "Time to take your meds",
            "canned_responses" to """["Done","Snooze 10m","Skip"]""",
            "scheduled_date" to "2026-04-28",
            "rule_id" to "rule-xyz",
        )

        val payload = PushPayloadParser.parse(data)!!

        assertEquals("notif-abc", payload.notificationId)
        assertEquals("habit_nudge", payload.notificationType)
        assertEquals("Time to take your meds", payload.message)
        assertEquals(listOf("Done", "Snooze 10m", "Skip"), payload.cannedResponses)
        assertEquals("2026-04-28", payload.scheduledDate)
        assertEquals("rule-xyz", payload.ruleId)
    }

    @Test
    fun `treats empty-string rule_id as null per server D-23 contract`() {
        val data = baseData() + ("rule_id" to "")
        val payload = PushPayloadParser.parse(data)!!
        assertNull(payload.ruleId)
    }

    @Test
    fun `treats missing rule_id as null`() {
        val data = baseData()
        val payload = PushPayloadParser.parse(data)!!
        assertNull(payload.ruleId)
    }

    @Test
    fun `parses canned_responses from JSON-encoded string per server D-23 contract`() {
        val data = baseData() + ("canned_responses" to """["Yes","No"]""")
        val payload = PushPayloadParser.parse(data)!!
        assertEquals(listOf("Yes", "No"), payload.cannedResponses)
    }

    @Test
    fun `treats missing canned_responses as empty list`() {
        val data = baseData()
        val payload = PushPayloadParser.parse(data)!!
        assertTrue(payload.cannedResponses.isEmpty())
    }

    @Test
    fun `treats empty-string canned_responses as empty list`() {
        val data = baseData() + ("canned_responses" to "")
        val payload = PushPayloadParser.parse(data)!!
        assertTrue(payload.cannedResponses.isEmpty())
    }

    @Test
    fun `treats malformed canned_responses JSON as empty list rather than crashing`() {
        val data = baseData() + ("canned_responses" to "not-valid-json")
        val payload = PushPayloadParser.parse(data)!!
        assertTrue(payload.cannedResponses.isEmpty())
    }

    @Test
    fun `returns null when notification_id is missing`() {
        val data = baseData() - "notification_id"
        assertNull(PushPayloadParser.parse(data))
    }

    @Test
    fun `returns null when notification_id is empty string`() {
        val data = baseData() + ("notification_id" to "")
        assertNull(PushPayloadParser.parse(data))
    }

    @Test
    fun `returns null when notification_type is missing`() {
        val data = baseData() - "notification_type"
        assertNull(PushPayloadParser.parse(data))
    }

    @Test
    fun `returns null when message is missing`() {
        val data = baseData() - "message"
        assertNull(PushPayloadParser.parse(data))
    }

    @Test
    fun `treats empty-string scheduled_date as null`() {
        val data = baseData() + ("scheduled_date" to "")
        val payload = PushPayloadParser.parse(data)!!
        assertNull(payload.scheduledDate)
    }

    private fun baseData(): Map<String, String> = mapOf(
        "notification_id" to "notif-1",
        "notification_type" to "habit_nudge",
        "message" to "hello",
    )
}
