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

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.str
import io.agora.rtc2.ChannelMediaOptions
import io.agora.rtc2.Constants
import io.agora.rtc2.IRtcEngineEventHandler
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.RtcEngineConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/** imageUrl = the staff's User.profileImageUrl — the call screen shows a real face. */
class IntercomStaff(val id: String, val name: String, val phone: String?, val imageUrl: String? = null)

object AgoraIntercom {

    enum class Mode { IDLE, LISTENING, BROADCASTING, CALLING, RINGING }

    // ── Compose-observable state (all writes marshalled to the main thread) ──
    var mode by mutableStateOf(Mode.IDLE); private set
    var connected by mutableStateOf(false); private set
    var remoteSpeaking by mutableStateOf(false); private set
    var localSpeaking by mutableStateOf(false); private set
    var micMuted by mutableStateOf(false); private set
    /** Loudspeaker on? join() turns it on, so the UI starts in sync. */
    var speakerOn by mutableStateOf(true); private set
    var recording by mutableStateOf(false); private set
    var callSeconds by mutableIntStateOf(0); private set
    var statusText by mutableStateOf(""); private set
    var error by mutableStateOf<String?>(null); private set
    var roster by mutableStateOf<List<IntercomStaff>>(emptyList()); private set
    var callPeer by mutableStateOf("স্টাফ"); private set
    /** Photo of the person on the other end of the current call (null → initial avatar). */
    var callPeerImage by mutableStateOf<String?>(null); private set
    /** Did WE place the current call? The minimised call bar re-opens the right screen. */
    var callOutgoing by mutableStateOf(false); private set

    private val main = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var engine: RtcEngine? = null
    private var appId: String? = null
    private var channel: String? = null
    private val remoteUids = HashSet<Int>()
    private var callTicker: Runnable? = null
    private var ringTimeout: Runnable? = null
    private val handledCallIds = HashSet<String>()

    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recordStart = 0L
    private val ringtone = IntercomRingtone()

    fun attach(context: Context) { if (appContext == null) appContext = context.applicationContext }

    private fun post(block: () -> Unit) = main.post(block)

    // ── Feed / roster ────────────────────────────────────────────────────────
    suspend fun loadFeed() {
        try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            val staff = root.optJSONArray("staff")?.mapObjects {
                IntercomStaff(it.str("id") ?: return@mapObjects null, it.str("name") ?: "স্টাফ", it.str("phone"), it.str("imageUrl"))
            } ?: emptyList()
            post { roster = staff }
        } catch (_: Exception) { }
    }

    private suspend fun resolveLiveChannel(): String {
        return try {
            val root = AlmaApi.getObject("/api/assistant/office/intercom")
            root.optJSONArray("staff")?.mapObjects {
                IntercomStaff(it.str("id") ?: return@mapObjects null, it.str("name") ?: "স্টাফ", it.str("phone"), it.str("imageUrl"))
            }?.let { s -> post { roster = s } }
            root.str("liveChannel")?.takeIf { it.isNotEmpty() } ?: "itc_live_ALMA_LIFESTYLE"
        } catch (_: Exception) {
            "itc_live_ALMA_LIFESTYLE"
        }
    }

    private suspend fun token(channel: String): Triple<String, String, Int> {
        val resp = AlmaApi.send("POST", "/api/assistant/office/intercom/call-token", JSONObject().put("channel", channel))
        val data = resp.optJSONObject("data") ?: resp
        val appId = data.str("appId") ?: throw IllegalStateException("agora_unconfigured")
        val tok = data.str("token") ?: throw IllegalStateException("agora_unconfigured")
        val uid = data.flexInt("uid") ?: 0
        return Triple(appId, tok, uid)
    }

    // ── Live walkie-talkie ─────────────────────────────────────────────────────
    suspend fun joinLive(asBroadcaster: Boolean) {
        // Broadcasting publishes the mic — same silent-failure trap as a call.
        if (asBroadcaster && !hasMicPermission()) {
            post { error = MIC_DENIED_MSG; statusText = "" }
            return
        }
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
        val target = roster.firstOrNull { it.id == staffId }
        post {
            error = null; statusText = "কল দিচ্ছি…"
            callPeer = target?.name ?: "স্টাফ"
            callPeerImage = target?.imageUrl
        }
        try {
            val resp = AlmaApi.send(
                "POST", "/api/assistant/office/intercom",
                JSONObject().put("kind", "call").put("targetStaffId", staffId),
            )
            val data = resp.optJSONObject("data") ?: resp
            val id = data.str("id") ?: resp.str("id") ?: throw IllegalStateException("call_failed")
            startCall("itc_$id", outgoing = true)
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
        }
    }

    /**
     * Is RECORD_AUDIO granted RIGHT NOW?
     *
     * This gate is not optional. Without the permission Agora still joins the channel
     * and reports success — it just publishes SILENCE, with no exception and no
     * callback. The result is a call where we hear the peer but the peer hears
     * nothing. Android 14+ additionally kills a `microphone` foreground service
     * started without it (SecurityException inside startForeground), which is what
     * dropped calls the moment the app was backgrounded. Both symptoms, one cause.
     */
    fun hasMicPermission(ctx: Context? = appContext): Boolean {
        val c = ctx ?: return false
        return ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** Bangla error surfaced when the mic is missing — never fail silently again. */
    const val MIC_DENIED_MSG = "মাইক্রোফোনের অনুমতি নেই — সেটিংসে গিয়ে ALMA-কে মাইক অনুমতি দিন, নইলে ওপাশে আপনার কথা যাবে না।"

    /** Surface the mic problem in the call UI (with a Settings shortcut next to it). */
    fun reportMicDenied() = post { error = MIC_DENIED_MSG }

    fun clearError() = post { error = null }

    suspend fun startCall(ch: String, outgoing: Boolean) {
        // Refuse to place/answer a muted-forever call: tell the user instead.
        if (!hasMicPermission()) {
            post { error = MIC_DENIED_MSG; mode = Mode.IDLE; statusText = "" }
            return
        }
        post { error = null; mode = Mode.RINGING; callSeconds = 0; callOutgoing = outgoing; statusText = if (outgoing) "রিং হচ্ছে…" else "কল ধরছেন…" }
        remoteUids.clear()
        ringtone.stop()
        try {
            join(ch, publishMic = true)
            post { micMuted = false }
            if (outgoing) {
                startRingTimeout()
                appContext?.let { ringtone.play(it, IntercomRingtone.Kind.RINGBACK) }
            }
        } catch (e: Exception) {
            post { error = messageFor(e); statusText = "" }
            leave()
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

    fun markCallHandled(id: String) { handledCallIds.add(id) }

    /** A call was cancelled remotely (caller hung up before answer). Observed by a
     *  live IncomingCallActivity so it closes instantly instead of ringing to timeout. */
    var cancelledCallId by mutableStateOf<String?>(null); private set
    fun markCallCancelled(id: String) {
        handledCallIds.add(id)
        post { cancelledCallId = id }
    }

    fun toggleMute() {
        val next = !micMuted
        engine?.muteLocalAudioStream(next)
        post { micMuted = next }
    }

    /** Earpiece ⇄ loudspeaker, like WhatsApp's speaker button. */
    fun toggleSpeaker() {
        val next = !speakerOn
        engine?.setEnableSpeakerphone(next)
        post { speakerOn = next }
    }

    fun leave() {
        engine?.leaveChannel()
        appContext?.let { com.almatraders.erp.IntercomForegroundService.stop(it) }
        stopCallTicker()
        stopRingTimeout()
        ringtone.stop()
        remoteUids.clear()
        channel = null
        post {
            mode = Mode.IDLE; connected = false; remoteSpeaking = false; localSpeaking = false; statusText = ""
        }
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

    // ── Engine internals ─────────────────────────────────────────────────────────
    private suspend fun join(ch: String, publishMic: Boolean) = withContext(Dispatchers.IO) {
        val (tokAppId, tok, uid) = token(ch)
        val e = engineFor(tokAppId)
        if (channel != null && channel != ch) e.leaveChannel()
        channel = ch
        val opts = ChannelMediaOptions().apply {
            channelProfile = Constants.CHANNEL_PROFILE_COMMUNICATION
            clientRoleType = Constants.CLIENT_ROLE_BROADCASTER
            autoSubscribeAudio = true
            publishMicrophoneTrack = publishMic
        }
        e.setEnableSpeakerphone(true)
        post { speakerOn = true }
        e.muteLocalAudioStream(!publishMic)
        e.joinChannel(tok, ch, uid, opts)
        // Android 14+ blocks mic capture from a backgrounded app without a foreground
        // service of type microphone — keep the call alive when the owner switches apps.
        appContext?.let { com.almatraders.erp.IntercomForegroundService.start(it) }
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
            post { connected = true }
        }
        override fun onUserJoined(uid: Int, elapsed: Int) {
            remoteUids.add(uid)
            post {
                if (mode == Mode.RINGING) {
                    mode = Mode.CALLING; statusText = "কল চলছে"
                    stopRingTimeout(); ringtone.stop(); startCallTicker()
                }
            }
        }
        override fun onUserOffline(uid: Int, reason: Int) {
            remoteUids.remove(uid)
            post {
                remoteSpeaking = false
                if ((mode == Mode.CALLING || mode == Mode.RINGING) && remoteUids.isEmpty()) {
                    statusText = "কল শেষ"; leave()
                }
            }
        }
        override fun onAudioVolumeIndication(speakers: Array<out AudioVolumeInfo>?, totalVolume: Int) {
            val list = speakers ?: return
            val remote = list.any { it.uid != 0 && (it.vad == 1 || it.volume > 8) }
            val local = list.any { it.uid == 0 && it.volume > 12 }
            post { if (remoteSpeaking != remote) remoteSpeaking = remote; if (localSpeaking != local) localSpeaking = local }
        }
        override fun onError(err: Int) {
            post { error = "Agora ত্রুটি ($err)" }
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
                post { error = "কেউ কল ধরেনি" }
                leave()
                main.postDelayed({ if (error == "কেউ কল ধরেনি") post { error = null } }, 4000)
            }
        }
        ringTimeout = r
        main.postDelayed(r, 45_000)
    }
    private fun stopRingTimeout() { ringTimeout?.let { main.removeCallbacks(it) }; ringTimeout = null }

    private fun messageFor(e: Exception): String {
        val raw = e.message ?: "সংযোগ ব্যর্থ"
        return if (raw.contains("agora_unconfigured")) "Agora কনফিগার করা নেই (সার্ভার কী দরকার)।" else raw
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
