//
//  AgoraIntercom.kt
//  ALMA ERP — Office Live Intercom, native Android port of AgoraIntercom.swift.
//
//  One shared Agora RTC channel per business (itc_live_<businessId>): the owner joins as
//  broadcaster and speaks live; staff phones join as listeners and hear it on the
//  loudspeaker. A 1:1 call reuses the same engine on a per-pair channel. Tokens are minted
//  by the SAME server route the web/iOS use (POST /api/assistant/office/intercom/call-token
//  → { appId, token, uid }), so the app never bakes in the Agora app id. Audio only.
//
//  Press-and-hold PTT records a voice note (MediaRecorder → .m4a) and uploads it as a
//  group voice message (multipart /api/assistant/office/intercom) so offline staff get it
//  too — mirrors the web/iOS behaviour.
//

package com.almatraders.erp.pages

import android.content.Context
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.str
import com.almatraders.erp.CallNotifications
import com.almatraders.erp.IntercomForegroundService
import com.almatraders.erp.OfficeCallTelecom
import com.almatraders.erp.OfficeCallPolicy
import com.almatraders.erp.OfficeCallTime
import com.almatraders.erp.OfficeCallPushRegistration
import io.agora.rtc2.ChannelMediaOptions
import io.agora.rtc2.Constants
import io.agora.rtc2.IRtcEngineEventHandler
import io.agora.rtc2.IRtcEngineEventHandler.RtcStats
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.RtcEngineConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

class IntercomStaff(val id: String, val name: String, val phone: String?)
data class IntercomRecentCall(
    val id: String,
    val callerName: String?,
    val outgoingByMe: Boolean,
    val createdAt: String,
    val endedAt: String?,
    val endedReason: String?,
    val canonicalState: String?,
    val callDurationSec: Int?,
)

object AgoraIntercom {

    enum class Mode { IDLE, LISTENING, BROADCASTING, CALLING, RINGING, RECONNECTING }

    // ── Compose-observable state (all writes marshalled to the main thread) ──
    var mode by mutableStateOf(Mode.IDLE); private set
    var connected by mutableStateOf(false); private set
    var remoteSpeaking by mutableStateOf(false); private set
    var localSpeaking by mutableStateOf(false); private set
    var micMuted by mutableStateOf(false); private set
    var recording by mutableStateOf(false); private set
    var callSeconds by mutableIntStateOf(0); private set
    var statusText by mutableStateOf(""); private set
    var error by mutableStateOf<String?>(null); private set
    var roster by mutableStateOf<List<IntercomStaff>>(emptyList()); private set
    var recentCalls by mutableStateOf<List<IntercomRecentCall>>(emptyList()); private set
    var callPeer by mutableStateOf("স্টাফ"); private set
    var canonicalState by mutableStateOf(""); private set
    var reconnectSeconds by mutableIntStateOf(0); private set
    var speakerEnabled by mutableStateOf(false); private set
    var audioRoute by mutableStateOf("earpiece"); private set
    var capabilityIssue by mutableStateOf<String?>(null); private set
    val activeCallId: String? get() = currentCallId
    val hasActiveCall: Boolean get() = currentCallId != null && mode != Mode.IDLE

    private val main = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var engine: RtcEngine? = null
    private var appId: String? = null
    private var channel: String? = null
    private var currentCallId: String? = null
    private val remoteUids = HashSet<Int>()
    private var callTicker: Runnable? = null
    private var ringTimeout: Runnable? = null
    private var reconcileTask: Runnable? = null
    private var reconnectTask: Runnable? = null
    private var reconnectDeadlineMs: Long? = null
    private var currentCallVersion: Int? = null
    @Volatile private var canonicalStateValue = ""
    private var callOutgoing = false
    private var currentTokenExpiryMs: Long? = null
    private var joinStartedAtMs = 0L
    private var lastQualityTelemetryMs = 0L
    private var reconnectCount = 0
    private var mutedBeforeInactive = false
    private val handledCallIds = HashSet<String>()
    private val telemetryScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val coordinatorScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val transitionMutex = Mutex()

    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recordStart = 0L
    private val ringtone = IntercomRingtone()

    fun attach(context: Context) {
        if (appContext == null) appContext = context.applicationContext
        OfficeCallTelecom.initialize(context.applicationContext)
        val issue = CallNotifications.capability(context.applicationContext).detail
        post { capabilityIssue = issue }
    }

    fun refreshCapabilities() {
        val context = appContext ?: return
        post { capabilityIssue = CallNotifications.capability(context).detail }
    }

    private fun post(block: () -> Unit) = main.post(block)
    private fun updateCanonicalState(value: String) {
        canonicalStateValue = value
        post { canonicalState = value }
    }

    // ── Feed / roster ────────────────────────────────────────────────────────
    suspend fun loadFeed() {
        try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            val staff = root.optJSONArray("staff")?.mapObjects {
                IntercomStaff(it.str("id") ?: return@mapObjects null, it.str("name") ?: "স্টাফ", it.str("phone"))
            } ?: emptyList()
            val calls = root.optJSONArray("broadcasts")?.mapObjects {
                if (it.str("kind") != "call") return@mapObjects null
                IntercomRecentCall(
                    id = it.str("id") ?: return@mapObjects null,
                    callerName = it.str("callerName"),
                    outgoingByMe = it.optBoolean("outgoingByMe", false),
                    createdAt = it.str("createdAt") ?: "",
                    endedAt = it.str("endedAt"),
                    endedReason = it.str("endedReason"),
                    canonicalState = it.str("canonicalState"),
                    callDurationSec = if (it.has("callDurationSec") && !it.isNull("callDurationSec")) it.optInt("callDurationSec") else null,
                )
            }?.takeLast(12)?.reversed() ?: emptyList()
            post { roster = staff; recentCalls = calls }
        } catch (_: Exception) { }
    }

    private suspend fun resolveLiveChannel(): String {
        return try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            root.optJSONArray("staff")?.mapObjects {
                IntercomStaff(it.str("id") ?: return@mapObjects null, it.str("name") ?: "স্টাফ", it.str("phone"))
            }?.let { s -> post { roster = s } }
            root.str("liveChannel")?.takeIf { it.isNotEmpty() } ?: "itc_live_ALMA_LIFESTYLE"
        } catch (_: Exception) {
            "itc_live_ALMA_LIFESTYLE"
        }
    }

    private data class CallToken(val appId: String, val token: String, val uid: Int, val expiresAtMs: Long?)

    private suspend fun token(channel: String, renewal: Boolean = false): CallToken {
        val body = JSONObject().put("channel", channel)
        if (renewal) body.put("renewal", true)
        val resp = AlmaApi.send("POST", "/api/assistant/office/intercom/call-token", body)
        val data = resp.optJSONObject("data") ?: resp
        val appId = data.str("appId") ?: throw IllegalStateException("agora_unconfigured")
        val tok = data.str("token") ?: throw IllegalStateException("agora_unconfigured")
        val uid = data.flexInt("uid") ?: 0
        val expiresAt = data.str("expiresAt")?.let(OfficeCallTime::parseMillis)
        return CallToken(appId, tok, uid, expiresAt)
    }

    // ── Live walkie-talkie ─────────────────────────────────────────────────────
    suspend fun joinLive(asBroadcaster: Boolean) {
        post { error = null; statusText = "সংযোগ হচ্ছে…" }
        try {
            val ch = resolveLiveChannel()
            join(ch, publishMic = asBroadcaster)
            post {
                mode = if (asBroadcaster) Mode.BROADCASTING else Mode.LISTENING
                micMuted = false
                statusText = if (asBroadcaster) "লাইভ — আপনি বলছেন" else "লাইভ — শুনছেন"
            }
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
            leave()
        }
    }

    // ── 1:1 call ────────────────────────────────────────────────────────────────
    suspend fun ownerCall(staffId: String) {
        post { error = null; statusText = "কল দিচ্ছি…"; callPeer = roster.firstOrNull { it.id == staffId }?.name ?: "স্টাফ" }
        try {
            val resp = AlmaApi.send(
                "POST", "/api/assistant/office/intercom",
                JSONObject().put("kind", "call").put("targetStaffId", staffId).put("idempotencyKey", UUID.randomUUID().toString()),
            )
            val data = resp.optJSONObject("data") ?: resp
            val id = data.str("id") ?: resp.str("id") ?: throw IllegalStateException("call_failed")
            currentCallId = id.lowercase()
            callOutgoing = true
            updateCanonicalState("RINGING")
            if (!refreshCanonical(id)) throw IllegalStateException("canonical_rejected")
            appContext?.let { OfficeCallTelecom.reportCall(it, id, callPeer, incoming = false) }
            startCall("itc_$id", outgoing = true)
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
            if (currentCallId != null) endActiveCall("FAILED", reportToTelecom = false)
        }
    }

    /** Native staff → owner. WebView never owns calls inside the Android shell. */
    suspend fun staffCallOwner() {
        post { error = null; statusText = "কল দিচ্ছি…"; callPeer = "বস — মারুফ" }
        try {
            val resp = AlmaApi.send(
                "POST", "/api/assistant/office/intercom",
                JSONObject().put("kind", "call").put("idempotencyKey", UUID.randomUUID().toString()),
            )
            val data = resp.optJSONObject("data") ?: resp
            val id = data.str("id") ?: resp.str("id") ?: throw IllegalStateException("call_failed")
            currentCallId = id.lowercase()
            callOutgoing = true
            updateCanonicalState("RINGING")
            if (!refreshCanonical(id)) throw IllegalStateException("canonical_rejected")
            appContext?.let { OfficeCallTelecom.reportCall(it, id, callPeer, incoming = false) }
            startCall("itc_$id", outgoing = true)
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
            if (currentCallId != null) endActiveCall("FAILED", reportToTelecom = false)
        }
    }

    suspend fun startCall(ch: String, outgoing: Boolean) {
        currentCallId = callIdFromChannel(ch)
        callOutgoing = outgoing
        joinStartedAtMs = System.currentTimeMillis()
        emitTelemetry(if (outgoing) "client.join_started" else "client.answer_pressed", "connecting")
        if (!outgoing) emitTelemetry("client.join_started", "connecting")
        post { error = null; mode = Mode.RINGING; callSeconds = 0; statusText = if (outgoing) "রিং হচ্ছে…" else "কল ধরছেন…" }
        remoteUids.clear()
        ringtone.stop()
        try {
            if (!outgoing) {
                if (!transitionCanonical("ANSWERED") || !transitionCanonical("CONNECTING")) {
                    throw IllegalStateException("canonical_rejected")
                }
            }
            join(ch, publishMic = true)
            post { micMuted = false }
            startCanonicalReconciliation()
            if (outgoing) {
                startRingTimeout()
                appContext?.let { ringtone.play(it, IntercomRingtone.Kind.RINGBACK) }
            }
        } catch (e: Exception) {
            emitTelemetry("client.media_error", "error", messageFor(e))
            post { error = messageFor(e); statusText = "" }
            endActiveCall("FAILED")
        }
    }

    /** Freshest still-ringing call addressed to me (owner OR staff), else null. */
    suspend fun pendingIncomingCall(): Pair<String, String>? {  // (broadcastId, channel)
        if (mode != Mode.IDLE && mode != Mode.LISTENING) return null
        return try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            val arr = root.optJSONArray("broadcasts") ?: return null
            for (i in arr.length() - 1 downTo 0) {
                val b = arr.optJSONObject(i) ?: continue
                if (b.str("kind") != "call") continue
                // Bidirectional: incomingForMe is server-computed (the owner rings for a
                // staff→owner call too, and never for a call he placed). Fall back to the
                // staff `mine` receipt for older server builds.
                val mine = b.optJSONObject("mine")
                val forMe = if (b.has("incomingForMe")) b.optBoolean("incomingForMe") else (mine != null)
                if (!forMe) continue
                // Ended (caller cancelled / answered elsewhere) or already handled → skip.
                if (b.str("endedAt") != null) continue
                if (mine?.str("confirmedAt") != null) continue
                val id = b.str("id") ?: continue
                if (handledCallIds.contains(id)) continue
                b.str("callerName")?.let { post { callPeer = it } }
                return Pair(id, "itc_$id")
            }
            null
        } catch (_: Exception) { null }
    }

    fun markCallHandled(id: String) {
        handledCallIds.add(id)
        currentCallId = id
        emitTelemetry("client.ring_received", "ringing")
    }

    /**
     * Surface a provider-authenticated, schema/TTL/channel-validated wake hint without
     * waiting for a network round-trip. Canonical state is still the source of truth:
     * reconciliation starts immediately and closes the provisional system call if the
     * server says it is no longer an incoming RINGING call.
     */
    fun surfaceIncomingWakeHint(context: Context, id: String, ch: String, caller: String) {
        attach(context)
        coordinatorScope.launch {
            val normalizedId = id.lowercase()
            val existingId = currentCallId
            if (existingId != null && !existingId.equals(normalizedId, ignoreCase = true)) {
                emitTelemetry("client.ring_suppressed_busy", "busy", "another_call_active")
                return@launch
            }
            if (handledCallIds.contains(normalizedId) && existingId == normalizedId) {
                refreshCanonical(normalizedId)
                return@launch
            }

            currentCallId = normalizedId
            currentCallVersion = null
            callOutgoing = false
            channel = ch
            updateCanonicalState("RINGING")
            surfaceIncomingCall(context, normalizedId, ch, caller)

            // A transport failure leaves the short-lived provisional ring visible and
            // the 2.5s reconciler retrying. A successful non-ringing response closes it.
            val canonicalAvailable = refreshCanonical(normalizedId)
            if (canonicalAvailable && (
                    currentCallId != normalizedId ||
                        canonicalStateValue != "RINGING" ||
                        callOutgoing || channel != ch
                )
            ) {
                OfficeCallTelecom.disconnect(normalizedId, "CANCELLED")
                CallNotifications.cancel(context, normalizedId)
                leaveLocal()
            }
        }
    }

    /** Foreground/activity/legacy-OneSignal path: verify server truth first. */
    fun reconcileIncoming(context: Context, id: String, ch: String, caller: String) {
        attach(context)
        coordinatorScope.launch {
            val normalizedId = id.lowercase()
            val existingId = currentCallId
            if (existingId != null && !existingId.equals(normalizedId, ignoreCase = true)) return@launch
            if (handledCallIds.contains(normalizedId) && existingId == normalizedId) {
                refreshCanonical(normalizedId)
                return@launch
            }
            if (!refreshCanonical(normalizedId)) return@launch
            if (currentCallId != normalizedId || canonicalStateValue != "RINGING" || callOutgoing || channel != ch) {
                if (currentCallId == normalizedId) leaveLocal()
                return@launch
            }
            surfaceIncomingCall(context, normalizedId, ch, caller)
        }
    }

    private fun surfaceIncomingCall(context: Context, id: String, ch: String, caller: String) {
        handledCallIds.add(id)
        post {
            callPeer = caller
            mode = Mode.RINGING
            statusText = "ইনকামিং কল…"
        }
        OfficeCallTelecom.reportCall(context, id, caller, incoming = true)
        val capability = CallNotifications.showIncomingCall(context, id, ch, caller)
        post { capabilityIssue = capability.detail }
        startCanonicalReconciliation()
        startRingTimeout()
        emitTelemetry("client.ring_received", "ringing", capability.detail)
    }

    /** A call was cancelled remotely (caller hung up before answer). Observed by a
     *  live IncomingCallActivity so it closes instantly instead of ringing to timeout. */
    var cancelledCallId by mutableStateOf<String?>(null); private set
    fun markCallCancelled(id: String) {
        handledCallIds.add(id)
        // Cancel pushes are untrusted wake hints too. Canonical ENDED is the only
        // condition allowed to dismiss Telecom/the ring.
        coordinatorScope.launch { refreshCanonical(id) }
    }

    fun toggleMute() {
        val next = !micMuted
        engine?.muteLocalAudioStream(next)
        post { micMuted = next }
    }

    fun setMutedFromSystem(muted: Boolean) {
        engine?.muteLocalAudioStream(muted)
        post { micMuted = muted }
    }

    fun toggleSpeaker() {
        val enabled = !speakerEnabled
        if (Build.VERSION.SDK_INT >= 26) OfficeCallTelecom.requestSpeaker(enabled)
        engine?.setEnableSpeakerphone(enabled)
        post { speakerEnabled = enabled }
    }

    @androidx.annotation.RequiresApi(26)
    fun onAudioEndpointChanged(type: Int, name: String) {
        val route = when (type) {
            androidx.core.telecom.CallEndpointCompat.TYPE_BLUETOOTH -> "bluetooth"
            androidx.core.telecom.CallEndpointCompat.TYPE_WIRED_HEADSET -> "wired"
            androidx.core.telecom.CallEndpointCompat.TYPE_SPEAKER -> "speaker"
            androidx.core.telecom.CallEndpointCompat.TYPE_EARPIECE -> "earpiece"
            else -> name.ifBlank { "unknown" }
        }
        post { audioRoute = route; speakerEnabled = route == "speaker" }
    }

    fun answerFromNotification(callId: String) = answer(callId, fromTelecom = false)
    fun answerFromSystem(callId: String) = answer(callId, fromTelecom = true)

    private fun answer(callId: String, fromTelecom: Boolean) {
        coordinatorScope.launch { answerNow(callId, fromTelecom) }
    }

    private suspend fun answerNow(callId: String, fromTelecom: Boolean) {
        if (currentCallId?.equals(callId, ignoreCase = true) != true && !refreshCanonical(callId)) return
        if (canonicalStateValue != "RINGING" || callOutgoing) return
        if (!fromTelecom) OfficeCallTelecom.answer(callId)
        startCall(channel ?: "itc_$callId", outgoing = false)
    }

    fun endFromNotification(callId: String, reason: String) = endRequested(callId, reason, reportToTelecom = true)
    fun endFromSystem(callId: String, reason: String) = endRequested(callId, reason, reportToTelecom = false)

    private fun endRequested(callId: String, reason: String, reportToTelecom: Boolean) {
        coordinatorScope.launch { endNow(callId, reason, reportToTelecom) }
    }

    private suspend fun endNow(callId: String, reason: String, reportToTelecom: Boolean) {
        if (currentCallId?.equals(callId, ignoreCase = true) != true && !refreshCanonical(callId)) return
        endActiveCall(reason, reportToTelecom)
    }

    /** Keeps a BroadcastReceiver process alive until its canonical action is issued. */
    fun handleNotificationAction(callId: String, action: String, completion: () -> Unit) {
        coordinatorScope.launch {
            try {
                when (action) {
                    "answer" -> answerNow(callId, fromTelecom = false)
                    "decline" -> endNow(callId, "DECLINED", reportToTelecom = true)
                    "hangup" -> endNow(callId, "COMPLETED", reportToTelecom = true)
                }
            } finally {
                completion()
            }
        }
    }

    fun endActiveCallFromUi() {
        coordinatorScope.launch { endActiveCall(localEndReason()) }
    }

    private fun localEndReason(): String = OfficeCallPolicy.localEndReason(canonicalStateValue, callOutgoing)

    suspend fun endActiveCall(reason: String, reportToTelecom: Boolean = true) {
        val id = currentCallId ?: run { leaveLocal(); return }
        transitionCanonical("ENDED", reason)
        if (reportToTelecom) OfficeCallTelecom.disconnect(id, reason)
        else OfficeCallTelecom.finish(id)
        appContext?.let { CallNotifications.cancel(it, id) }
        leaveLocal()
    }

    fun onTelecomActive() {
        setMutedFromSystem(mutedBeforeInactive)
        post { statusText = if (mode == Mode.CALLING) "কল চলছে" else statusText }
    }

    fun onTelecomInactive() {
        mutedBeforeInactive = micMuted
        setMutedFromSystem(true)
        post { statusText = "কল হোল্ডে আছে" }
    }

    fun onTelecomFailure(callId: String, detail: String) {
        emitTelemetry("client.telecom_error", canonicalStateValue.lowercase(), detail)
        post { error = "সিস্টেম কল চালু করা যায়নি" }
        coordinatorScope.launch {
            if (currentCallId?.equals(callId, ignoreCase = true) == true) endActiveCall("FAILED", reportToTelecom = false)
        }
    }

    fun onForegroundServiceFailure(callId: String, detail: String) {
        emitTelemetry("client.fgs_error", canonicalStateValue.lowercase(), detail)
        post { error = "ব্যাকগ্রাউন্ড কল চালু রাখা যায়নি — অ্যাপ খোলা রাখুন"; capabilityIssue = "foreground_service_start_failed" }
        if (callId.isNotBlank() && currentCallId?.equals(callId, ignoreCase = true) == true) {
            coordinatorScope.launch { refreshCanonical(callId) }
        }
    }

    /** Live-intercom stop only. Active 1:1 calls must use endActiveCallFromUi. */
    fun leave() {
        if (currentCallId != null) {
            endActiveCallFromUi()
            return
        }
        leaveLocal()
    }

    private fun leaveLocal() {
        emitTelemetry("client.leave_started", "leaving")
        engine?.leaveChannel()
        appContext?.let { IntercomForegroundService.stop(it) }
        stopCallTicker()
        stopRingTimeout()
        stopCanonicalReconciliation()
        stopReconnectGrace()
        ringtone.stop()
        remoteUids.clear()
        channel = null
        post {
            mode = Mode.IDLE; connected = false; remoteSpeaking = false; localSpeaking = false; statusText = ""
            canonicalState = ""; reconnectSeconds = 0; speakerEnabled = false; audioRoute = "earpiece"
        }
        emitTelemetry("client.local_left", "ended")
        currentCallId = null
        currentCallVersion = null
        canonicalStateValue = ""
        callOutgoing = false
        currentTokenExpiryMs = null
        joinStartedAtMs = 0L
        lastQualityTelemetryMs = 0L
        reconnectCount = 0
        mutedBeforeInactive = false
    }

    // ── PTT voice note ──────────────────────────────────────────────────────────
    suspend fun pttStart() {
        val ctx = appContext ?: return
        post { error = null }
        try {
            val f = File(ctx.cacheDir, "itc-${System.nanoTime()}.m4a")
            val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(44_100)
            rec.setAudioChannels(1)
            rec.setOutputFile(f.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            recordFile = f
            recordStart = System.currentTimeMillis()
            post { recording = true; localSpeaking = true; statusText = "🔴 রেকর্ড হচ্ছে — বলুন" }
        } catch (e: Exception) {
            post { error = messageFor(e); recording = false }
        }
    }

    suspend fun pttStop() {
        val rec = recorder; val f = recordFile
        recorder = null; recordFile = null
        post { recording = false; localSpeaking = false }
        if (rec == null || f == null) return
        val durSec = maxOf(1, ((System.currentTimeMillis() - recordStart) / 1000L).toInt())
        try { rec.stop() } catch (_: Exception) { }
        try { rec.release() } catch (_: Exception) { }
        val bytes = runCatching { f.readBytes() }.getOrNull()
        runCatching { f.delete() }
        if (bytes == null || bytes.isEmpty()) { post { statusText = "" }; return }
        post { statusText = "পাঠানো হচ্ছে…" }
        try {
            AlmaApi.uploadMultipart(
                "/api/assistant/office/intercom",
                listOf(AlmaApi.FilePart("audio", "voice.m4a", "audio/mp4", bytes)),
                mapOf("durationSec" to durSec.toString(), "targetStaffId" to ""),
            )
            post { statusText = "✅ স্টাফদের কাছে পাঠানো হয়েছে" }
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
        }
    }

    /** Staff poll: voice notes addressed to me not yet played → (id, url). */
    suspend fun pendingVoiceNotes(): List<Pair<String, String>> {
        return try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            val arr = root.optJSONArray("broadcasts") ?: return emptyList()
            (0 until arr.length()).mapNotNull { i ->
                val b = arr.optJSONObject(i) ?: return@mapNotNull null
                if (b.str("kind") != "voice") return@mapNotNull null
                if (b.optJSONObject("mine")?.str("playedAt") != null) return@mapNotNull null
                val url = b.str("audioUrl")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                Pair(b.str("id") ?: return@mapNotNull null, url)
            }
        } catch (_: Exception) { emptyList() }
    }

    suspend fun markVoicePlayed(broadcastId: String) {
        runCatching {
            AlmaApi.send(
                "POST", "/api/assistant/office/intercom/receipt",
                JSONObject().put("broadcastId", broadcastId).put("action", "played"),
            )
        }
    }

    fun ringIncoming() { appContext?.let { ringtone.play(it, IntercomRingtone.Kind.INCOMING) } }
    fun stopRinging() { ringtone.stop() }

    // ── Canonical control plane ─────────────────────────────────────────────
    private suspend fun refreshCanonical(callId: String? = null): Boolean {
        val id = (callId ?: currentCallId)?.lowercase() ?: return false
        return try {
            val root = AlmaApi.getObject("/api/assistant/office/calls/$id")
            val call = root.optJSONObject("call") ?: return false
            val state = call.optString("state")
            currentCallId = call.optString("id", id).lowercase()
            currentCallVersion = if (call.has("version")) call.optInt("version") else currentCallVersion
            callOutgoing = call.optString("direction") != "incoming"
            channel = call.optString("channel").takeIf { it.isNotBlank() } ?: channel
            updateCanonicalState(state)
            if (state == "ENDED") {
                val endedId = currentCallId
                val terminalReason = call.optString("terminalReason").ifBlank { "COMPLETED" }
                if (endedId != null) {
                    post { cancelledCallId = endedId }
                    OfficeCallTelecom.disconnect(endedId, terminalReason)
                    appContext?.let { CallNotifications.cancel(it, endedId) }
                }
                leaveLocal()
                false
            } else true
        } catch (e: Exception) {
            emitTelemetry("client.reconcile_failed", canonicalStateValue.lowercase(), messageFor(e))
            false
        }
    }

    private suspend fun transitionCanonical(target: String, reason: String? = null): Boolean = transitionMutex.withLock {
        val id = currentCallId ?: return@withLock false
        suspend fun attempt(): Boolean {
            val body = JSONObject().put("state", target)
            if (reason != null) body.put("reason", reason) else body.put("reason", JSONObject.NULL)
            currentCallVersion?.let { body.put("expectedVersion", it) }
            val response = AlmaApi.send("POST", "/api/assistant/office/calls/$id/transition", body)
            val ok = !response.has("ok") || response.optBoolean("ok")
            val state = response.optString("state", target)
            if (response.has("version")) currentCallVersion = response.optInt("version")
            updateCanonicalState(state)
            return ok
        }
        try {
            attempt()
        } catch (first: Exception) {
            if (!refreshCanonical(id)) return@withLock target == "ENDED" && currentCallId == null
            if (canonicalStateValue == target || (target == "ENDED" && canonicalStateValue == "ENDED")) return@withLock true
            try {
                attempt()
            } catch (second: Exception) {
                emitTelemetry("client.transition_failed", target.lowercase(), messageFor(second))
                false
            }
        }
    }

    private suspend fun promoteCanonicalToConnected(): Boolean {
        repeat(8) { attempt ->
            if (!refreshCanonical()) return false
            when (val next = OfficeCallPolicy.nextPeerPromotion(canonicalStateValue)) {
                "CONNECTED" -> if (canonicalStateValue == "CONNECTED") return true else return transitionCanonical(next)
                "CONNECTING" -> if (!transitionCanonical(next)) return false
                null -> if (canonicalStateValue == "RINGING" && attempt < 7) kotlinx.coroutines.delay(300) else return false
                else -> return false
            }
        }
        return false
    }

    private fun startCanonicalReconciliation() {
        if (reconcileTask != null) return
        val task = object : Runnable {
            override fun run() {
                if (currentCallId == null) { reconcileTask = null; return }
                coordinatorScope.launch { refreshCanonical() }
                main.postDelayed(this, 2_500)
            }
        }
        reconcileTask = task
        main.postDelayed(task, 2_500)
    }

    private fun stopCanonicalReconciliation() {
        reconcileTask?.let { main.removeCallbacks(it) }
        reconcileTask = null
    }

    private fun beginReconnectGrace() {
        if (currentCallId == null || reconnectDeadlineMs != null) return
        reconnectCount += 1
        reconnectDeadlineMs = System.currentTimeMillis() + 15_000
        emitTelemetry("client.reconnect_started", "reconnecting", metrics = mapOf("reconnectCount" to reconnectCount))
        post { mode = Mode.RECONNECTING; connected = false; statusText = "পুনঃসংযোগ হচ্ছে…"; reconnectSeconds = 15 }
        coordinatorScope.launch { transitionCanonical("RECONNECTING") }
        val task = object : Runnable {
            override fun run() {
                val deadline = reconnectDeadlineMs ?: return
                val remaining = ((deadline - System.currentTimeMillis() + 999) / 1000).coerceAtLeast(0).toInt()
                post { reconnectSeconds = remaining }
                if (remaining <= 0) {
                    reconnectTask = null
                    reconnectDeadlineMs = null
                    coordinatorScope.launch { endActiveCall("FAILED") }
                } else main.postDelayed(this, 1_000)
            }
        }
        reconnectTask = task
        main.postDelayed(task, 1_000)
    }

    private fun stopReconnectGrace() {
        reconnectTask?.let { main.removeCallbacks(it) }
        reconnectTask = null
        reconnectDeadlineMs = null
        post { reconnectSeconds = 0 }
    }

    private fun renewAgoraToken() {
        val ch = channel ?: return
        coordinatorScope.launch {
            try {
                val renewed = token(ch, renewal = true)
                engine?.renewToken(renewed.token)
                currentTokenExpiryMs = renewed.expiresAtMs
                emitTelemetry("client.token_renewed", canonicalStateValue.lowercase())
            } catch (e: Exception) {
                emitTelemetry("client.token_renew_failed", canonicalStateValue.lowercase(), messageFor(e))
            }
        }
    }

    // ── Engine internals ─────────────────────────────────────────────────────────
    private suspend fun join(ch: String, publishMic: Boolean) = withContext(Dispatchers.IO) {
        val issued = token(ch)
        currentTokenExpiryMs = issued.expiresAtMs
        val e = engineFor(issued.appId)
        if (channel != null && channel != ch) e.leaveChannel()
        channel = ch
        val opts = ChannelMediaOptions().apply {
            channelProfile = Constants.CHANNEL_PROFILE_COMMUNICATION
            clientRoleType = Constants.CLIENT_ROLE_BROADCASTER
            autoSubscribeAudio = true
            publishMicrophoneTrack = publishMic
        }
        val isPrivateCall = callIdFromChannel(ch) != null
        e.setEnableSpeakerphone(!isPrivateCall)
        post { speakerEnabled = !isPrivateCall; audioRoute = if (isPrivateCall) "earpiece" else "speaker" }
        e.muteLocalAudioStream(!publishMic)
        if (isPrivateCall) {
            val id = currentCallId ?: throw IllegalStateException("call_missing")
            val started = appContext?.let { IntercomForegroundService.startCall(it, id, ch, callPeer) } == true
            if (!started) throw IllegalStateException("foreground_service_start_failed")
        } else {
            val started = appContext?.let { IntercomForegroundService.startLive(it) } == true
            if (!started) throw IllegalStateException("foreground_service_start_failed")
        }
        e.joinChannel(issued.token, ch, issued.uid, opts)
    }

    private fun engineFor(newAppId: String): RtcEngine {
        engine?.let { if (appId == newAppId) return it }
        try { engine?.leaveChannel(); RtcEngine.destroy() } catch (_: Exception) { }
        val cfg = RtcEngineConfig().apply {
            mContext = appContext
            mAppId = newAppId
            mEventHandler = handler
        }
        val e = RtcEngine.create(cfg)
        e.setChannelProfile(Constants.CHANNEL_PROFILE_COMMUNICATION)
        e.enableAudio()
        e.setDefaultAudioRoutetoSpeakerphone(true)
        e.enableAudioVolumeIndication(350, 3, true)
        engine = e
        appId = newAppId
        return e
    }

    private val handler = object : IRtcEngineEventHandler() {
        override fun onJoinChannelSuccess(channel: String?, uid: Int, elapsed: Int) {
            post { connected = false }
            val latency = if (joinStartedAtMs > 0) (System.currentTimeMillis() - joinStartedAtMs).coerceAtLeast(0) else null
            emitTelemetry("client.local_joined", "connecting", latencyMs = latency)
        }
        override fun onUserJoined(uid: Int, elapsed: Int) {
            remoteUids.add(uid)
            coordinatorScope.launch {
                if (currentCallId == null || !promoteCanonicalToConnected()) {
                    emitTelemetry("client.transition_failed", "connected", "peer_join_before_answer")
                    return@launch
                }
                stopReconnectGrace()
                post {
                    mode = Mode.CALLING; connected = true; statusText = "কল চলছে"
                    stopRingTimeout(); ringtone.stop(); startCallTicker()
                }
                currentCallId?.let { OfficeCallTelecom.setActive(it) }
                if (reconnectCount > 0) emitTelemetry(
                    "client.reconnect_recovered", "in-call", metrics = mapOf("reconnectCount" to reconnectCount),
                )
                emitTelemetry("client.peer_joined", "in-call")
            }
        }
        override fun onUserOffline(uid: Int, reason: Int) {
            remoteUids.remove(uid)
            post {
                remoteSpeaking = false
                if (OfficeCallPolicy.shouldBeginReconnect(mode.name, remoteUids.size)) {
                    emitTelemetry("client.peer_left", "reconnecting")
                    beginReconnectGrace()
                }
            }
        }
        override fun onConnectionStateChanged(state: Int, reason: Int) {
            when (state) {
                Constants.CONNECTION_STATE_RECONNECTING -> beginReconnectGrace()
                Constants.CONNECTION_STATE_CONNECTED -> if (mode == Mode.RECONNECTING) {
                    coordinatorScope.launch {
                        if (transitionCanonical("CONNECTED")) {
                            stopReconnectGrace()
                            post { mode = Mode.CALLING; connected = true; statusText = "কল চলছে" }
                            emitTelemetry(
                                "client.reconnect_recovered", "in-call", metrics = mapOf("reconnectCount" to reconnectCount),
                            )
                        }
                    }
                }
                Constants.CONNECTION_STATE_FAILED -> beginReconnectGrace()
            }
        }
        override fun onTokenPrivilegeWillExpire(token: String?) { renewAgoraToken() }
        override fun onRequestToken() { renewAgoraToken() }
        override fun onAudioRouteChanged(routing: Int) {
            val route = when (routing) {
                Constants.AUDIO_ROUTE_HEADSET -> "wired"
                Constants.AUDIO_ROUTE_EARPIECE -> "earpiece"
                Constants.AUDIO_ROUTE_BLUETOOTH_DEVICE_HFP,
                Constants.AUDIO_ROUTE_BLUETOOTH_DEVICE_A2DP -> "bluetooth"
                Constants.AUDIO_ROUTE_SPEAKERPHONE -> "speaker"
                else -> "unknown"
            }
            post { audioRoute = route; speakerEnabled = route == "speaker" }
            if (currentCallId != null) emitTelemetry("client.audio_route_changed", canonicalStateValue.lowercase(), route)
        }
        override fun onRtcStats(stats: RtcStats?) {
            val sample = stats ?: return
            val now = System.currentTimeMillis()
            if (currentCallId == null || now - lastQualityTelemetryMs < 10_000) return
            lastQualityTelemetryMs = now
            emitTelemetry(
                "client.quality_sample",
                canonicalStateValue.lowercase(),
                metrics = mapOf(
                    "rttMs" to sample.lastmileDelay,
                    "packetLossPct" to maxOf(sample.txPacketLossRate, sample.rxPacketLossRate),
                    "txAudioKbps" to sample.txAudioKBitRate,
                    "rxAudioKbps" to sample.rxAudioKBitRate,
                    "reconnectCount" to reconnectCount,
                ),
            )
        }
        override fun onAudioVolumeIndication(speakers: Array<out AudioVolumeInfo>?, totalVolume: Int) {
            val list = speakers ?: return
            val remote = list.any { it.uid != 0 && (it.vad == 1 || it.volume > 8) }
            val local = list.any { it.uid == 0 && it.volume > 12 }
            post { if (remoteSpeaking != remote) remoteSpeaking = remote; if (localSpeaking != local) localSpeaking = local }
        }
        override fun onError(err: Int) {
            post { error = "Agora ত্রুটি ($err)" }
            emitTelemetry("client.media_error", "error", "agora_$err")
        }
    }

    private fun startCallTicker() {
        stopCallTicker()
        post { callSeconds = 0 }
        val r = object : Runnable {
            override fun run() { post { callSeconds += 1 }; main.postDelayed(this, 1000) }
        }
        callTicker = r
        main.postDelayed(r, 1000)
    }
    private fun stopCallTicker() { callTicker?.let { main.removeCallbacks(it) }; callTicker = null; post { callSeconds = 0 } }

    private fun startRingTimeout() {
        stopRingTimeout()
        val r = Runnable {
            if (mode == Mode.RINGING) {
                // The server owns ring expiry. A local timer only triggers canonical
                // reconciliation; it never invents a terminal state.
                coordinatorScope.launch {
                    val stillLive = refreshCanonical()
                    if (stillLive && canonicalStateValue == "RINGING") {
                        kotlinx.coroutines.delay(1_500)
                        refreshCanonical()
                    }
                    if (currentCallId == null) {
                        post { error = "কেউ কল ধরেনি" }
                        main.postDelayed({ if (error == "কেউ কল ধরেনি") post { error = null } }, 4_000)
                    }
                }
            }
        }
        ringTimeout = r
        main.postDelayed(r, 60_000)
    }
    private fun stopRingTimeout() { ringTimeout?.let { main.removeCallbacks(it) }; ringTimeout = null }

    private fun messageFor(e: Exception): String {
        val raw = e.message ?: "সংযোগ ব্যর্থ"
        return if (raw.contains("agora_unconfigured")) "Agora কনফিগার করা নেই (সার্ভার কী দরকার)।" else raw
    }

    private fun callIdFromChannel(value: String): String? {
        if (!value.startsWith("itc_") || value.startsWith("itc_live_")) return null
        val candidate = value.removePrefix("itc_")
        return runCatching { UUID.fromString(candidate).toString() }.getOrNull()
    }

    private fun emitTelemetry(
        event: String,
        state: String,
        detail: String? = null,
        latencyMs: Long? = null,
        metrics: Map<String, Number> = emptyMap(),
    ) {
        val callId = currentCallId ?: return
        val context = appContext ?: return
        val installationId = OfficeCallPushRegistration.installationId(context)
        val packageInfo = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
        @Suppress("DEPRECATION")
        val versionCode = packageInfo?.let {
            if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else it.versionCode.toLong()
        }
        val body = JSONObject()
            .put("callId", callId)
            .put("event", event)
            .put("platform", "android")
            .put("deviceId", installationId)
            .put("appBuild", "${packageInfo?.versionName ?: "unknown"} (${versionCode ?: 0})")
            .put("state", state)
            .put("occurredAt", OfficeCallTime.nowIso())
        if (latencyMs != null) body.put("latencyMs", latencyMs)
        if (detail != null || metrics.isNotEmpty()) {
            val metadata = JSONObject()
            if (detail != null) metadata.put("code", detail.take(160))
            metrics.forEach { (key, value) -> metadata.put(key, value) }
            body.put("metadata", metadata)
        }
        telemetryScope.launch { runCatching { AlmaApi.send("POST", "/api/assistant/office/calls/events", body) } }
    }
}

// ── Ringtone: synthesised PCM WAV (no bundled audio), looped via MediaPlayer ──────────
class IntercomRingtone {
    enum class Kind { RINGBACK, INCOMING }
    private var player: MediaPlayer? = null

    fun play(context: Context, kind: Kind) {
        stop()
        try {
            val f = File(context.cacheDir, "itc-ring-${kind.name}.wav")
            if (!f.exists()) f.writeBytes(wav(kind))
            player = MediaPlayer().apply {
                setDataSource(f.absolutePath)
                isLooping = true
                setVolume(if (kind == Kind.INCOMING) 1f else 0.55f, if (kind == Kind.INCOMING) 1f else 0.55f)
                if (kind == Kind.INCOMING) setAudioStreamType(AudioManager.STREAM_MUSIC)
                prepare()
                start()
            }
        } catch (_: Exception) { player = null }
    }

    fun stop() { runCatching { player?.stop(); player?.release() }; player = null }

    private fun wav(kind: Kind): ByteArray {
        val sr = 16_000
        val f1: Double; val f2: Double; val segments: List<Pair<Boolean, Double>>
        when (kind) {
            Kind.RINGBACK -> { f1 = 440.0; f2 = 480.0; segments = listOf(true to 1.0, false to 2.0) }
            Kind.INCOMING -> { f1 = 480.0; f2 = 620.0; segments = listOf(true to 0.4, false to 0.2, true to 0.4, false to 1.4) }
        }
        val samples = ArrayList<Short>()
        for ((on, dur) in segments) {
            val n = (dur * sr).toInt()
            for (i in 0 until n) {
                if (!on) { samples.add(0); continue }
                val t = i.toDouble() / sr
                val env = minOf(1.0, minOf(i.toDouble(), (n - i).toDouble()) / (sr * 0.02))
                val v = (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t)) * 0.25 * env
                samples.add((Math.max(-1.0, Math.min(1.0, v)) * 32_767).toInt().toShort())
            }
        }
        return pcm16Wav(samples, sr)
    }

    private fun pcm16Wav(samples: List<Short>, sampleRate: Int): ByteArray {
        val dataBytes = samples.size * 2
        val out = ByteArrayOutputStream()
        fun u32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun u16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        out.write("RIFF".toByteArray()); u32(36 + dataBytes); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); u32(16); u16(1); u16(1)
        u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        out.write("data".toByteArray()); u32(dataBytes)
        for (s in samples) { val u = s.toInt() and 0xffff; out.write(u and 0xff); out.write((u shr 8) and 0xff) }
        return out.toByteArray()
    }
}
