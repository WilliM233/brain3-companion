package com.fluxmeridian.brain3companion

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.firebase.FirebaseApp

// Defense-in-depth wrapper around the upstream Capacitor PushNotifications
// plugin. The default register() calls FirebaseMessaging.getInstance() with
// no FirebaseApp init guard, so a missing google-services.json kills the
// process via FATAL EXCEPTION on the CapacitorPlugins thread (see [2C-Bug-05]).
// This subclass converts that into a recoverable JS-layer rejection so the
// existing try/catch at device-registration.ts:168 can surface it.
@CapacitorPlugin(name = "PushNotifications")
class SafePushNotificationsPlugin : PushNotificationsPlugin() {

    @PluginMethod
    override fun register(call: PluginCall) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            call.reject("FIREBASE_NOT_CONFIGURED")
            return
        }
        super.register(call)
    }
}
