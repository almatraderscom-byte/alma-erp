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

/**
 * Foreground service that keeps the Office Live Intercom (Agora RTC walkie-talkie /
 * 1:1 call) alive and mic-legal while the app is backgrounded.
 *
 * Android 14+ (targetSdk 35) BLOCKS microphone capture from a backgrounded app unless
 * it runs a foreground service of type `microphone`. Without this, a call dropped the
 * moment the owner switched apps (or the OS killed it). Started when Agora joins a
 * channel, stopped when it leaves — shows an ongoing "intercom running" notification
 * the user can tap to return.
 */
class IntercomForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel(this)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("অফিস ইন্টারকম চলছে")
            .setContentText("লাইভ ভয়েস চালু — ফিরতে ট্যাপ করুন")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, n)
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "alma_intercom_live"
        private const val NOTIF_ID = 8801

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "অফিস ইন্টারকম", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "লাইভ কল চলাকালীন দেখানো হয়"
                    setShowBadge(false)
                },
            )
        }

        fun start(ctx: Context) {
            val i = Intent(ctx, IntercomForegroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Exception) { /* e.g. background-start restriction — call still works foreground */ }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, IntercomForegroundService::class.java)) } catch (_: Exception) {}
        }
    }
}
