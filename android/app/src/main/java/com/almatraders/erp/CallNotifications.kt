//
//  CallNotifications.kt
//  ALMA ERP — Android WhatsApp-style incoming call notification (Stage 1).
//
//  Builds the high-importance, full-screen-intent notification that turns an office-call
//  push into a native ringing call: on a locked / screen-off phone the full-screen intent
//  launches IncomingCallActivity directly; on an unlocked phone it shows as a heads-up call
//  banner with Accept/Decline. Delivery comes through OneSignal (the app's existing push
//  pipeline) — see CallNotificationExtension.
//
package com.almatraders.erp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat

object CallNotifications {
    const val CHANNEL_ID = "alma_calls_v1"
    private const val NOTIF_ID = 4711
    const val EXTRA_BROADCAST_ID = "broadcastId"
    const val EXTRA_CHANNEL = "channel"
    const val EXTRA_CALLER = "caller"

    /** true → we are PLACING the call (no ring/accept UI; the screen dials out). */
    const val EXTRA_OUTGOING = "outgoing"

    /** Outgoing only: the AgentStaff.id to ring (the screen creates the broadcast). */
    const val EXTRA_STAFF_ID = "staffId"

    /**
     * Open the full-screen call screen for an OUTGOING call. The owner's call used to
     * live in a bottom sheet, which left the page visible behind it — one stray tap on
     * that scrim closed the call UI. A full-screen activity has no "outside" to tap.
     */
    fun startOutgoing(context: Context, staffId: String, peerName: String) {
        val i = Intent(context, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(EXTRA_OUTGOING, true)
            putExtra(EXTRA_STAFF_ID, staffId)
            putExtra(EXTRA_CALLER, peerName)
        }
        context.startActivity(i)
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "অফিস কল", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "লাইভ অফিস কল"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
        }
        mgr.createNotificationChannel(channel)
    }

    fun showIncomingCall(context: Context, broadcastId: String, channel: String, caller: String) {
        ensureChannel(context)
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return

        val fullScreen = Intent(context, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_BROADCAST_ID, broadcastId)
            putExtra(EXTRA_CHANNEL, channel)
            putExtra(EXTRA_CALLER, caller)
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(context, broadcastId.hashCode(), fullScreen, piFlags)

        val notif = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(caller)
            .setContentText("📞 অফিস লাইভ কল")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(pi, true)
            .setContentIntent(pi)
            .build()
        mgr.notify(NOTIF_ID, notif)
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIF_ID)
    }
}
