package com.almatraders.erp

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Per-call CallStyle notifications and capability diagnostics. */
object CallNotifications {
    const val CHANNEL_ID = "alma_calls_v2"
    const val EXTRA_BROADCAST_ID = "broadcastId"
    const val EXTRA_CHANNEL = "channel"
    const val EXTRA_CALLER = "caller"
    const val EXTRA_ONGOING = "ongoing"

    data class Capability(
        val notificationAllowed: Boolean,
        val fullScreenAllowed: Boolean,
        val detail: String?,
    )

    fun capability(context: Context): Capability {
        val runtimeAllowed = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val notificationAllowed = runtimeAllowed && NotificationManagerCompat.from(context).areNotificationsEnabled()
        val manager = context.getSystemService(NotificationManager::class.java)
        val fullScreenAllowed = Build.VERSION.SDK_INT < 34 || manager?.canUseFullScreenIntent() == true
        val detail = when {
            !notificationAllowed -> "notification_permission_denied"
            !fullScreenAllowed -> "full_screen_intent_denied_heads_up_fallback"
            else -> null
        }
        return Capability(notificationAllowed, fullScreenAllowed, detail)
    }

    fun fullScreenSettingsIntent(context: Context): Intent? = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } else null

    fun notificationSettingsIntent(context: Context): Intent = if (Build.VERSION.SDK_INT >= 26) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "অফিস কল", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "ইনকামিং ও চলমান অফিস কল"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            },
        )
    }

    fun showIncomingCall(context: Context, broadcastId: String, channel: String, caller: String): Capability {
        ensureChannel(context)
        val capability = capability(context)
        if (!capability.notificationAllowed) return capability
        val manager = context.getSystemService(NotificationManager::class.java) ?: return capability
        val open = activityIntent(context, broadcastId, channel, caller, ongoing = false)
        val decline = actionIntent(context, broadcastId, OfficeCallActionReceiver.ACTION_DECLINE)
        val answer = actionIntent(context, broadcastId, OfficeCallActionReceiver.ACTION_ANSWER)
        val person = Person.Builder().setName(caller).setImportant(true).build()
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(caller)
            .setContentText("অফিস ভয়েস কল")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
        if (capability.fullScreenAllowed) builder.setFullScreenIntent(open, true)
        manager.notify(notificationId(broadcastId), builder.build())
        return capability
    }

    fun buildOngoing(context: Context, broadcastId: String, channel: String, caller: String): Notification {
        ensureChannel(context)
        val open = activityIntent(context, broadcastId, channel, caller, ongoing = true)
        val hangUp = actionIntent(context, broadcastId, OfficeCallActionReceiver.ACTION_HANG_UP)
        val person = Person.Builder().setName(caller).setImportant(true).build()
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_outgoing)
            .setContentTitle(caller)
            .setContentText("অফিস কল চলছে — ফিরতে ট্যাপ করুন")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp))
            .build()
    }

    fun cancel(context: Context, callId: String) {
        context.getSystemService(NotificationManager::class.java)?.cancel(notificationId(callId))
    }

    fun notificationId(callId: String): Int = 0x4A000000 or (callId.hashCode() and 0x00FFFFFF)

    private fun activityIntent(
        context: Context,
        callId: String,
        channel: String,
        caller: String,
        ongoing: Boolean,
    ): PendingIntent {
        val intent = Intent(context, IncomingCallActivity::class.java).apply {
            action = "com.almatraders.erp.officecall.OPEN.$callId"
            data = Uri.parse("almaerp://office/calls/$callId")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_BROADCAST_ID, callId)
            putExtra(EXTRA_CHANNEL, channel)
            putExtra(EXTRA_CALLER, caller)
            putExtra(EXTRA_ONGOING, ongoing)
        }
        return PendingIntent.getActivity(
            context,
            requestCode(callId, if (ongoing) 4 else 3),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(context: Context, callId: String, action: String): PendingIntent {
        val intent = Intent(context, OfficeCallActionReceiver::class.java).apply {
            this.action = action
            data = Uri.parse("almaerp://office/calls/$callId/${action.substringAfterLast('.')}")
            putExtra(EXTRA_BROADCAST_ID, callId)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode(callId, action.hashCode()),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun requestCode(callId: String, salt: Int): Int = 31 * callId.hashCode() + salt
}
