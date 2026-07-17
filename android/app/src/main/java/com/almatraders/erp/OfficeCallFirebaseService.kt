package com.almatraders.erp

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.almatraders.erp.pages.AgoraIntercom
import com.almatraders.erp.shell.AlmaApi
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Canonical direct-FCM receiver. Payloads are never trusted as call truth: a
 * participant-authenticated canonical fetch must still say incoming + RINGING. */
class OfficeCallFirebaseService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        OfficeCallPushRegistration.enqueue(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != "office_call" || data["schemaVersion"] != "1") return
        val callId = (data["callId"] ?: data["broadcastId"] ?: "").trim()
        if (runCatching { UUID.fromString(callId) }.isFailure) return
        if (data["event"] == "cancel") {
            AgoraIntercom.markCallCancelled(callId)
            return
        }
        val expiresAt = OfficeCallTime.parseMillis(data["expiresAt"].orEmpty()) ?: return
        if (System.currentTimeMillis() >= expiresAt) return
        // A ring older than the provider TTL is never surfaced after a delay.
        if (message.sentTime > 0L && (System.currentTimeMillis() - message.sentTime) > 60_000L) return

        val canonical = runBlocking(Dispatchers.IO) {
            withTimeoutOrNull(8_000L) {
                runCatching { AlmaApi.getObject("/api/assistant/office/calls/$callId").optJSONObject("call") }.getOrNull()
            }
        } ?: return
        if (canonical.optString("state") != "RINGING" || canonical.optString("direction") != "incoming") return
        val canonicalChannel = canonical.optString("channel")
        if (canonicalChannel.isBlank() || canonicalChannel != data["channel"]) return

        AgoraIntercom.reconcileIncoming(
            this,
            callId,
            canonicalChannel,
            data["caller"].orEmpty().ifBlank { "অফিস কল" },
        )
    }
}

object OfficeCallPushRegistration {
    private const val WORK_NAME = "office-call-fcm-registration"
    private const val TOKEN_KEY = "fcmToken"
    private const val PREFS = "office-call-device"
    private const val INSTALLATION = "installation-id"

    fun enqueue(context: Context, token: String) {
        if (token.isBlank()) return
        val request = OneTimeWorkRequestBuilder<OfficeCallPushRegistrationWorker>()
            .setInputData(workDataOf(TOKEN_KEY to token))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    fun installationId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getString(INSTALLATION, null)
            ?: UUID.randomUUID().toString().also { prefs.edit().putString(INSTALLATION, it).apply() }
    }
}

class OfficeCallPushRegistrationWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val token = inputData.getString("fcmToken")?.trim().orEmpty()
        if (token.isEmpty()) return@withContext Result.failure()
        val body = JSONObject()
            .put("platform", "android")
            .put("environment", "production")
            .put("installationId", OfficeCallPushRegistration.installationId(applicationContext))
            .put("fcmToken", token)
            .put("appBuild", BuildConfig.VERSION_NAME)
            .put("buildSha", BuildConfig.ALMA_BUILD_SHA)
        runCatching {
            AlmaApi.send("POST", "/api/assistant/internal/call-push/register", body)
        }.fold(
            onSuccess = { Result.success() },
            onFailure = { if (runAttemptCount >= 5) Result.failure() else Result.retry() },
        )
    }
}
