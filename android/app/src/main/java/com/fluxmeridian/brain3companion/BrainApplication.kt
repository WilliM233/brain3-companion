package com.fluxmeridian.brain3companion

import android.app.Application

class BrainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.registerChannels(this)
    }
}
