//
//  CallNotificationExtension.kt
//  ALMA ERP — OneSignal notification service extension (Stage 1).
//
//  Compatibility path for legacy OneSignal call pushes. Direct data FCM is canonical;
//  both paths feed the same server-reconciling process coordinator, and neither trusts
//  push payload state as call truth.
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
        if (type == "office_call_cancel" || (type == "office_call" && data.optString("event") == "cancel")) {
            event.preventDefault()
            val broadcastId = data.optString("callId").ifEmpty { data.optString("broadcastId") }
            if (broadcastId.isNotEmpty()) com.almatraders.erp.pages.AgoraIntercom.markCallCancelled(broadcastId)
            return
        }

        if (type != "office_call") return

        // Don't let OneSignal post its default banner — we render a call instead.
        event.preventDefault()

        val broadcastId = data.optString("callId").ifEmpty { data.optString("broadcastId") }
        if (broadcastId.isEmpty()) return
        val channel = data.optString("channel").ifEmpty { "itc_$broadcastId" }
        val caller = data.optString("caller").ifEmpty { "বস — মারুফ" }

        // OneSignal is a compatibility wake path only; canonical server state is
        // fetched before any OS call or notification is surfaced.
        com.almatraders.erp.pages.AgoraIntercom.reconcileIncoming(
            event.context,
            broadcastId,
            channel,
            caller,
        )
    }
}
