package com.almatraders.erp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.almatraders.erp.pages.AgoraIntercom

/** Keeps Agora mic capture legal and visible while a call is backgrounded. */
class IntercomForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(CallNotifications.EXTRA_BROADCAST_ID).orEmpty()
        val channel = intent?.getStringExtra(CallNotifications.EXTRA_CHANNEL).orEmpty()
        val peer = intent?.getStringExtra(CallNotifications.EXTRA_CALLER).orEmpty().ifBlank { "অফিস কল" }
        val notification = if (callId.isNotBlank()) {
            CallNotifications.buildOngoing(this, callId, channel, peer)
        } else {
            buildLiveNotification()
        }
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (callId.isNotBlank()) {
                    types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                }
                startForeground(if (callId.isBlank()) LIVE_NOTIF_ID else CallNotifications.notificationId(callId), notification, types)
            } else {
                startForeground(if (callId.isBlank()) LIVE_NOTIF_ID else CallNotifications.notificationId(callId), notification)
            }
            START_NOT_STICKY
        } catch (error: Exception) {
            AgoraIntercom.onForegroundServiceFailure(callId, error.message ?: error.javaClass.simpleName)
            stopSelf(startId)
            START_NOT_STICKY
        }
    }

    private fun buildLiveNotification(): Notification {
        ensureLiveChannel(this)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val open = launch?.let {
            PendingIntent.getActivity(this, LIVE_NOTIF_ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        return NotificationCompat.Builder(this, LIVE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("অফিস ইন্টারকম চলছে")
            .setContentText("লাইভ ভয়েস চালু — ফিরতে ট্যাপ করুন")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val LIVE_CHANNEL_ID = "alma_intercom_live_v2"
        private const val LIVE_NOTIF_ID = 8801

        private fun ensureLiveChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            if (mgr.getNotificationChannel(LIVE_CHANNEL_ID) != null) return
            mgr.createNotificationChannel(
                NotificationChannel(LIVE_CHANNEL_ID, "অফিস ইন্টারকম", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "লাইভ ইন্টারকম চলাকালীন দেখানো হয়"
                    setShowBadge(false)
                },
            )
        }

        fun startLive(ctx: Context): Boolean = startIntent(ctx, Intent(ctx, IntercomForegroundService::class.java))

        fun startCall(ctx: Context, callId: String, channel: String, peer: String): Boolean {
            val intent = Intent(ctx, IntercomForegroundService::class.java).apply {
                putExtra(CallNotifications.EXTRA_BROADCAST_ID, callId)
                putExtra(CallNotifications.EXTRA_CHANNEL, channel)
                putExtra(CallNotifications.EXTRA_CALLER, peer)
            }
            return startIntent(ctx, intent)
        }

        private fun startIntent(ctx: Context, intent: Intent): Boolean = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
            true
        } catch (error: Exception) {
            AgoraIntercom.onForegroundServiceFailure(
                intent.getStringExtra(CallNotifications.EXTRA_BROADCAST_ID).orEmpty(),
                error.message ?: error.javaClass.simpleName,
            )
            false
        }

        fun stop(ctx: Context) {
            runCatching { ctx.stopService(Intent(ctx, IntercomForegroundService::class.java)) }
        }
    }
}
