package com.fluxmeridian.brain3companion.push

object NotificationTitleMap {
    private val TITLES = mapOf(
        "habit_nudge" to "Habit Nudge",
        "routine_check" to "Routine Check",
        "rule_trigger" to "Rule Trigger",
    )

    fun titleFor(notificationType: String): String =
        TITLES[notificationType] ?: "BRAIN"
}
