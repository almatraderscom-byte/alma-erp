//
//  CallNotificationExtension.kt
//  ALMA ERP — OneSignal notification service extension (Stage 1).
//
//  OneSignal owns the app's FCM messaging service, so we hook its extension point instead
//  of declaring a second (conflicting) FirebaseMessagingService. When a call push arrives
//  (data.type == "office_call", sent by office-intercom.ts), we suppress the default
//  notification and raise our own full-screen incoming-call UI instead. Runs even when the
//  app is backgrounded or killed — that is the whole point.
//
//  Registered via <meta-data android:name="com.onesignal.NotificationServiceExtension"> in
//  AndroidManifest.
//
package com.almatraders.erp

import com.onesignal.notifications.INotificationReceivedEvent
import com.onesignal.notifications.INotificationServiceExtension

class CallNotificationExtension : INotificationServiceExtension {
    override fun onNotificationReceived(event: INotificationReceivedEvent) {
        val data = event.notification.additionalData ?: return
        val type = data.optString("type")

        // A cancel push (caller hung up / answered elsewhere) — stop the ring instantly:
        // dismiss the full-screen notification and close a live IncomingCallActivity.
        if (type == "office_call_cancel") {
            event.preventDefault()
            val broadcastId = data.optString("broadcastId")
            if (broadcastId.isNotEmpty()) com.almatraders.erp.pages.AgoraIntercom.markCallCancelled(broadcastId)
            CallNotifications.cancel(event.context)
            return
        }

        if (type != "office_call") return

        // Don't let OneSignal post its default banner — we render a call instead.
        event.preventDefault()

        val broadcastId = data.optString("broadcastId")
        if (broadcastId.isEmpty()) return
        val channel = data.optString("channel").ifEmpty { "itc_$broadcastId" }
        val caller = data.optString("caller").ifEmpty { "বস — মারুফ" }

        CallNotifications.showIncomingCall(event.context, broadcastId, channel, caller)
    }
}
