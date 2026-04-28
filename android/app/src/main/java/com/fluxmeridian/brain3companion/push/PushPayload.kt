package com.fluxmeridian.brain3companion.push

data class PushPayload(
    val notificationId: String,
    val notificationType: String,
    val message: String,
    val cannedResponses: List<String>,
    val scheduledDate: String?,
    val ruleId: String?,
)
