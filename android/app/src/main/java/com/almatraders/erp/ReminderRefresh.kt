package com.almatraders.erp

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Background reminder refresh — the Android twin of iOS BackgroundRefresh.swift.
 *
 * A WorkManager periodic job (min OS interval, floored ~1h) reuses the WebView
 * session cookie to GET /api/assistant/device-reminders (owner-only) and schedules
 * an exact AlarmManager alarm per upcoming reminder. ReminderAlarmReceiver posts the
 * notification on the shared `alma_alerts_v2` channel when it fires — so reminders
 * stay fresh even if the app isn't opened for days.
 *
 * Notification / request ids match the web scheme (reminderNotificationId — a 31-hash
 * of the reminder uuid, src/lib/local-reminders.ts) so a reminder scheduled by the web
 * path and by this native path DEDUPES (same PendingIntent requestCode replaces)
 * instead of double-firing. Fully fail-open: no cookie / offline / 401 → no-op.
 */
object ReminderRefresh {
    private const val WORK_NAME = "alma-reminder-refresh"
    private const val ORIGIN = "https://alma-erp-six.vercel.app"

    /** Stable positive int32 from a reminder uuid — mirror of web reminderNotificationId. */
    fun notificationId(uuid: String): Int {
        var hash = 0
        for (c in uuid) hash = (hash * 31 + c.code)
        val abs = kotlin.math.abs(hash)
        return if (abs == 0) 1 else abs
    }

    /** Enqueue the hourly periodic refresh (idempotent — KEEP existing). Call on launch. */
    fun enqueue(context: Context) {
        val req = PeriodicWorkRequestBuilder<ReminderRefreshWorker>(1, TimeUnit.HOURS).build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    private val http = OkHttpClient.Builder()
        .followRedirects(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()

    /** Fetch upcoming reminders (7-day window) and schedule an exact alarm for each. */
    suspend fun refresh(context: Context) {
        val cookie = CookieManager.getInstance().getCookie(ORIGIN) ?: return  // not logged in → no-op
        val json = try {
            val req = Request.Builder().url("$ORIGIN/api/assistant/device-reminders")
                .header("Cookie", cookie).header("Accept", "application/json").get().build()
            http.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.string() else null }
        } catch (_: Exception) { null } ?: return

        val reminders = try { JSONObject(json).optJSONArray("reminders") } catch (_: Exception) { null } ?: return
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val now = System.currentTimeMillis()

        for (i in 0 until reminders.length()) {
            val o = reminders.optJSONObject(i) ?: continue
            val id = o.optString("id").ifBlank { continue }
            val dueRaw = o.optString("dueAt").ifBlank { continue }
            val dueMs = try { iso.parse(dueRaw.substringBefore('.').removeSuffix("Z"))?.time ?: continue } catch (_: Exception) { continue }
            if (dueMs <= now) continue
            val nid = notificationId(id)
            val fire = Intent(context, ReminderAlarmReceiver::class.java).apply {
                putExtra("nid", nid)
                putExtra("title", o.optString("title", "রিমাইন্ডার"))
                putExtra("body", o.optString("body", ""))
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pi = PendingIntent.getBroadcast(context, nid, fire, flags)
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueMs, pi)
            } catch (_: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueMs, pi)  // exact-alarm not granted → inexact
            }
        }
    }
}

class ReminderRefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        return try {
            ReminderRefresh.refresh(applicationContext)
            Result.success()
        } catch (_: Exception) {
            Result.success()  // fail-open — never retry-storm
        }
    }
}

/** Posts the reminder notification when its exact alarm fires (channel alma_alerts_v2). */
class ReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AlmaPushChannels.ensureCreated(context)
        val nid = intent.getIntExtra("nid", 1)
        val title = intent.getStringExtra("title") ?: "রিমাইন্ডার"
        val body = intent.getStringExtra("body") ?: ""
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val pi = launch?.let {
            PendingIntent.getActivity(context, nid, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val n = NotificationCompat.Builder(context, AlmaPushChannels.ALMA_ALERTS_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        n.flags = n.flags or Notification.FLAG_AUTO_CANCEL
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        nm.notify(nid, n)
    }
}
