package com.fluxmeridian.brain3companion

import com.getcapacitor.Bridge

/**
 * Process-singleton holder for the Capacitor [Bridge]. MainActivity attaches in
 * onCreate and detaches in onDestroy so non-plugin contexts — specifically
 * [CannedResponseReceiver] — can dispatch JS events when the WebView is alive.
 *
 * When null (app process not running, or activity torn down), callers fall
 * back to durable storage in [WriteQueueStore]; the JS layer drains the queue
 * on its next launch, foreground, or `online` event. See [2C-07] spec.
 */
object BridgeHolder {
    @Volatile
    private var bridge: Bridge? = null

    fun attach(bridge: Bridge?) {
        this.bridge = bridge
    }

    fun detach(expected: Bridge?) {
        if (this.bridge === expected) {
            this.bridge = null
        }
    }

    /** Best-effort JS event dispatch; no-ops when the bridge is not attached. */
    fun triggerJSEvent(eventName: String): Boolean {
        val active = bridge ?: return false
        active.triggerWindowJSEvent(eventName)
        return true
    }
}
