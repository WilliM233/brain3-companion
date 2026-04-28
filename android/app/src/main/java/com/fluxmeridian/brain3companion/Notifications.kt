package com.fluxmeridian.brain3companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.content.ContextCompat

object Notifications {
    const val CANNED_CHANNEL_ID = "brain_canned"

    fun registerChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java)
            ?: return
        val channel = NotificationChannel(
            CANNED_CHANNEL_ID,
            context.getString(R.string.notification_channel_canned_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_canned_description)
        }
        manager.createNotificationChannel(channel)
    }
}
