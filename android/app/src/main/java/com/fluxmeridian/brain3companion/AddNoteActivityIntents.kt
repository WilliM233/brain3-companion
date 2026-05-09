package com.fluxmeridian.brain3companion

/**
 * Intent action + extras shared between [BrainFirebaseMessagingService] (the
 * notification builder) and [MainActivity] (the receiver of the "Add note"
 * tap). Keeping the constants here avoids a circular dependency between the
 * two and makes the Add-note contract grep-able.
 *
 * Per [2C-19] spec, the "Add note" action button on a `checkin_prompt`
 * notification fires `Intent.ACTION_VIEW`-equivalent semantics — open the
 * app to a specific route — using a custom action against MainActivity so we
 * inherit the `singleTask` launch mode without adding a custom URL scheme
 * intent-filter to the manifest.
 */
object AddNoteActivityIntents {
    const val ACTION_ADD_NOTE = "com.fluxmeridian.brain3companion.action.ADD_NOTE"
    const val EXTRA_NOTIFICATION_ID = "notification_id"
    const val EXTRA_CANNED_RESPONSE = "canned_response"
}
