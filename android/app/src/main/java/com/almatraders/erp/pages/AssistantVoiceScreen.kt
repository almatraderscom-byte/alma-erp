//
//  AssistantVoiceScreen.kt
//  ALMA ERP — native voice-to-voice console (orb page), the Android twin of iOS
//  AssistantVoiceSwiftUI.  A native audio loop replaces the web VoiceConsole so the
//  mic is hot on tap (no getUserMedia/session-mint latency) and a calibrated VAD
//  stops room noise from arming before the owner speaks.
//
//  Turn: record (m4a) → /api/assistant/transcribe (Whisper) → /api/assistant/chat
//  {voice:true} SSE → sentence-chunked /api/assistant/tts playback → auto-relisten in
//  কথোপকথন mode.  Half-duplex: the mic is open ONLY in `listening`; while the agent
//  speaks a ttsActive gate keeps it shut so it can't hear its own TTS.  VAD constants
//  mirror the web/iOS engine: 400ms noise-floor calibration, 250ms sustained speech to
//  arm, adaptive silence window (1400ms for <3s utterances else 2600ms), 8s no-speech
//  abort, 180s hard cap.
//
//  Real mic feel / TTS on a physical device is the owner's final check (emulator audio
//  is unrepresentative) — the pipeline + state machine are verifiable without it.
//

package com.almatraders.erp.pages

import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.cos
import kotlin.math.sin

// ── State (web STATUS dict parity) ─────────────────────────────────────────────────

enum class VoiceState(val label: String, val hue: Float) {
    IDLE("ট্যাপ করে বলুন", 168f),
    LISTENING("শুনছি…", 145f),
    TRANSCRIBING("বুঝে নিচ্ছি…", 265f),
    THINKING("ভাবছি…", 265f),
    SPEAKING("বলছি", 210f),
    ERROR("আবার চেষ্টা করুন", 8f),
}

/** HSL(hue,70%,60%) → Compose Color (orb hue per state). */
private fun hueColor(hue: Float, light: Float = 0.60f): Color {
    val s = 0.70f; val l = light
    val c = (1 - kotlin.math.abs(2 * l - 1)) * s
    val hp = hue / 60f
    val x = c * (1 - kotlin.math.abs(hp % 2 - 1))
    val (r, g, b) = when {
        hp < 1 -> Triple(c, x, 0f); hp < 2 -> Triple(x, c, 0f); hp < 3 -> Triple(0f, c, x)
        hp < 4 -> Triple(0f, x, c); hp < 5 -> Triple(x, 0f, c); else -> Triple(c, 0f, x)
    }
    val m = l - c / 2
    return Color(r + m, g + m, b + m)
}

// ── Voice engine (recorder + calibrated VAD + chat SSE + chunked TTS) ───────────────

private class VoiceEngine(private val context: Context, private val scope: CoroutineScope) {
    var state by mutableStateOf(VoiceState.IDLE)
    var transcript by mutableStateOf("")
    var reply by mutableStateOf("")
    var nowSpeaking by mutableStateOf("")
    var conversationMode by mutableStateOf(true)   // কথোপকথন auto-relisten
    var micLevel by mutableFloatStateOf(0f)
    var conversationId: String? = null

    // On-device STT (Android SpeechRecognizer, offline+free — iOS NativeSpeechBridge
    // parity). Owner opt-in, persisted; falls back to the Whisper server path whenever
    // it's unavailable or returns nothing (e.g. no Bangla offline pack installed).
    private val prefs = context.getSharedPreferences("alma_voice", Context.MODE_PRIVATE)
    var onDeviceStt by mutableStateOf(prefs.getBoolean("alma_native_stt", true))
    fun updateOnDeviceStt(on: Boolean) { onDeviceStt = on; prefs.edit().putBoolean("alma_native_stt", on).apply() }

    private var recorder: MediaRecorder? = null
    private var audioFile: File? = null
    private var vadJob: Job? = null
    private var turnJob: Job? = null
    private var ttsActive = false
    private val ttsQueue = ArrayDeque<String>()
    private var player: MediaPlayer? = null
    private var speaking = false
    private var recognizer: SpeechRecognizer? = null
    private var usingOnDevice = false
    private var triedWhisperFallback = false

    private val http = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).build()

    // ── Orb tap / lifecycle ──
    fun tapOrb() {
        when (state) {
            VoiceState.LISTENING -> finishListening()
            VoiceState.SPEAKING -> { stopTts(); startListening() }
            VoiceState.IDLE, VoiceState.ERROR -> startListening()
            VoiceState.TRANSCRIBING, VoiceState.THINKING -> { /* busy */ }
        }
    }

    fun shutdown() {
        vadJob?.cancel(); turnJob?.cancel()
        stopRecorder(); stopTts()
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
    }

    // ── Listening (on-device SpeechRecognizer preferred, Whisper fallback) ──
    fun startListening() {
        if (ttsActive) return
        transcript = ""
        triedWhisperFallback = false
        if (onDeviceStt && SpeechRecognizer.isRecognitionAvailable(context)) startListeningOnDevice()
        else startListeningWhisper()
    }

    /** Android SpeechRecognizer: mic capture + endpointing + transcription in one, on
     *  device / offline when the language pack is present. Drives the orb from onRmsChanged. */
    private fun startListeningOnDevice() {
        usingOnDevice = true
        try { recognizer?.destroy() } catch (_: Exception) {}
        val rec = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = rec
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: android.os.Bundle?) { state = VoiceState.LISTENING }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rms: Float) { micLevel = ((rms + 2f) / 12f).coerceIn(0f, 1f) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { micLevel = 0f }
            override fun onPartialResults(partial: android.os.Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                    ?.takeIf { it.isNotBlank() }?.let { if (state == VoiceState.LISTENING) transcript = it }
            }
            override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
            override fun onResults(results: android.os.Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
                micLevel = 0f
                if (text.isNullOrBlank()) { onNoSpeech(); return }
                transcript = text
                runTurn(text)
            }
            override fun onError(error: Int) {
                micLevel = 0f
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> onNoSpeech()
                    else -> {
                        // Recognizer unusable (no offline pack / busy) → fall back to Whisper once.
                        if (!triedWhisperFallback) { triedWhisperFallback = true; usingOnDevice = false; startListeningWhisper() }
                        else onNoSpeech()
                    }
                }
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "bn-BD")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            if (Build.VERSION.SDK_INT >= 23) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
        state = VoiceState.LISTENING
        try { rec.startListening(intent) } catch (_: Exception) {
            usingOnDevice = false; startListeningWhisper()
        }
    }

    /** No usable speech — in কথোপকথন mode gently re-arm once, else go idle. */
    private fun onNoSpeech() {
        usingOnDevice = false
        micLevel = 0f
        state = VoiceState.IDLE
        if (conversationMode) scope.launch { delay(400); if (state == VoiceState.IDLE && !ttsActive) startListening() }
    }

    // ── Whisper fallback: record + calibrated VAD → /transcribe ──
    private fun startListeningWhisper() {
        usingOnDevice = false
        if (ttsActive) return
        try {
            val f = File.createTempFile("alma-voice", ".m4a", context.cacheDir)
            audioFile = f
            val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
            rec.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioEncodingBitRate(64000)
            rec.setAudioSamplingRate(16000)
            rec.setOutputFile(f.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            state = VoiceState.LISTENING
            runVad()
        } catch (_: Exception) {
            state = VoiceState.ERROR
        }
    }

    private fun runVad() {
        vadJob?.cancel()
        vadJob = scope.launch {
            val tickMs = 33L
            var elapsed = 0.0
            var floorSum = 0.0; var floorN = 0.0
            var speechThresh = 0.10
            var silenceThresh = 0.05
            var sustainedMs = 0.0
            var spoke = false
            var speechStartAt = 0.0
            var silenceMs = 0.0
            while (isActive && recorder != null && state == VoiceState.LISTENING) {
                val amp = try { recorder?.maxAmplitude ?: 0 } catch (_: Exception) { 0 }
                val level = (amp / 32767.0).coerceIn(0.0, 1.0)
                micLevel = (level * 3).coerceIn(0.0, 1.0).toFloat()
                when {
                    elapsed < 400 -> {
                        floorSum += level; floorN += 1
                        if (elapsed + tickMs >= 400 && floorN > 0) {
                            val floor = floorSum / floorN
                            speechThresh = (floor * 2.5).coerceIn(0.06, 0.30)
                            silenceThresh = (floor * 1.5).coerceIn(0.03, 0.15)
                        }
                    }
                    !spoke -> {
                        if (level > speechThresh) {
                            sustainedMs += tickMs
                            if (sustainedMs >= 250) { spoke = true; speechStartAt = elapsed }
                        } else sustainedMs = 0.0
                        if (elapsed > 8_000) { cancelListening(); return@launch }
                    }
                    else -> {
                        if (level < silenceThresh) {
                            silenceMs += tickMs
                            val span = elapsed - speechStartAt
                            val window = if (span < 3_000) 1_400.0 else 2_600.0
                            if (silenceMs >= window) { finishListening(); return@launch }
                        } else if (level > speechThresh) silenceMs = 0.0
                    }
                }
                if (elapsed > 180_000) { finishListening(); return@launch }
                elapsed += tickMs
                delay(tickMs)
            }
        }
    }

    private fun cancelListening() {
        vadJob?.cancel()
        stopRecorder()
        micLevel = 0f
        // No speech — in conversation mode gently re-arm once, else go idle.
        state = VoiceState.IDLE
        if (conversationMode) scope.launch { delay(400); if (state == VoiceState.IDLE && !ttsActive) startListening() }
    }

    fun finishListening() {
        if (usingOnDevice) {
            // Recognizer endpoints itself; a manual stop flushes onResults with the partial.
            try { recognizer?.stopListening() } catch (_: Exception) {}
            return
        }
        vadJob?.cancel()
        stopRecorder()
        micLevel = 0f
        val f = audioFile
        if (f == null || !f.exists() || f.length() < 800) { cancelListening(); return }
        state = VoiceState.TRANSCRIBING
        scope.launch {
            val text = transcribe(f)
            if (text.isNullOrBlank()) { state = VoiceState.IDLE; if (conversationMode) startListening(); return@launch }
            transcript = text
            runTurn(text)
        }
    }

    private fun stopRecorder() {
        try { recorder?.stop() } catch (_: Exception) {}
        try { recorder?.release() } catch (_: Exception) {}
        recorder = null
    }

    // ── Transcribe ──
    private suspend fun transcribe(f: File): String? = withContext(Dispatchers.IO) {
        try {
            val resp = AlmaApi.uploadMultipart(
                "/api/assistant/transcribe",
                listOf(AlmaApi.FilePart("file", "voice.m4a", "audio/mp4", f.readBytes())),
            )
            (resp.optJSONObject("data") ?: resp).optString("text").takeIf { it.isNotBlank() }
        } catch (_: Exception) { null }
    }

    // ── Turn: chat SSE → chunked TTS ──
    private fun runTurn(text: String) {
        state = VoiceState.THINKING
        reply = ""; nowSpeaking = ""
        ttsQueue.clear()
        turnJob?.cancel()
        turnJob = scope.launch(Dispatchers.IO) {
            try {
                val body = JSONObject()
                    .put("conversationId", conversationId)
                    .put("message", text)
                    .put("modelId", "auto")
                    .put("voice", true)
                    .toString()
                val req = Request.Builder()
                    .url(AlmaTheme.BASE_URL.trimEnd('/') + "/api/assistant/chat")
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream")
                    .apply { android.webkit.CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let { header("Cookie", it) } }
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val src = resp.body?.source() ?: return@use
                    var pending = StringBuilder()
                    var dataBuf = StringBuilder()
                    while (isActive && !src.exhausted()) {
                        val line = src.readUtf8Line() ?: break
                        if (line.startsWith("data:")) {
                            dataBuf.append(line.removePrefix("data:").trim())
                        } else if (line.isEmpty() && dataBuf.isNotEmpty()) {
                            handleSse(dataBuf.toString()) { chunk -> pending = feedTts(pending, chunk) }
                            dataBuf = StringBuilder()
                        }
                    }
                    // flush any trailing sentence
                    if (pending.isNotBlank()) enqueueTts(pending.toString())
                    finishFeed()
                }
            } catch (_: Exception) {
                withContext(Dispatchers.Main) { enqueueTts("দুঃখিত বস, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।") ; finishFeed() }
            }
        }
    }

    private suspend fun handleSse(json: String, onDelta: (String) -> Unit) {
        val ev = try { JSONObject(json) } catch (_: Exception) { return }
        when (ev.optString("type")) {
            "conversation_id" -> ev.optString("id").takeIf { it.isNotBlank() }?.let { conversationId = it }
            "text_delta" -> {
                val d = ev.optString("delta")
                if (d.isNotEmpty()) { withContext(Dispatchers.Main) { reply += d }; onDelta(d) }
            }
            "error" -> withContext(Dispatchers.Main) { enqueueTts("দুঃখিত বস, একটা সমস্যা হয়েছে।") }
            else -> { /* tool_start / tool_end / cards — spoken feed kept minimal on v1 */ }
        }
    }

    // Sentence chunker: accumulate deltas, flush on Bangla danda / . ? ! once long enough.
    private fun feedTts(acc: StringBuilder, delta: String): StringBuilder {
        acc.append(delta)
        var s = acc.toString()
        val enders = charArrayOf('।', '?', '!', '\n')
        while (true) {
            var idx = -1
            for (i in s.indices) if (s[i] in enders || (s[i] == '.' && i > 0 && !s[i - 1].isDigit())) { idx = i; break }
            if (idx < 0) break
            val sentence = s.substring(0, idx + 1).trim()
            s = s.substring(idx + 1)
            if (sentence.length >= 2) enqueueTts(sentence)
        }
        return StringBuilder(s)
    }

    private fun finishFeed() {
        // If nothing queued and we produced a reply, speak the whole reply.
        scope.launch(Dispatchers.Main) {
            if (ttsQueue.isEmpty() && !speaking && reply.isNotBlank() && nowSpeaking.isBlank()) {
                enqueueTts(reply.trim())
            }
            if (ttsQueue.isEmpty() && !speaking) onSpeechDone()
        }
    }

    // ── TTS queue ──
    private fun enqueueTts(sentence: String) {
        val s = sentence.trim().take(600)
        if (s.isEmpty()) return
        ttsQueue.addLast(s)
        if (!speaking) pumpTts()
    }

    private fun pumpTts() {
        val next = ttsQueue.removeFirstOrNull()
        if (next == null) { onSpeechDone(); return }
        speaking = true
        ttsActive = true
        state = VoiceState.SPEAKING
        nowSpeaking = next
        scope.launch(Dispatchers.IO) {
            val bytes = synthesize(next)
            if (bytes == null) { withContext(Dispatchers.Main) { pumpTts() }; return@launch }
            val tmp = File.createTempFile("alma-tts", ".mp3", context.cacheDir).apply { writeBytes(bytes) }
            withContext(Dispatchers.Main) {
                try {
                    val mp = MediaPlayer()
                    mp.setDataSource(tmp.absolutePath)
                    mp.setOnCompletionListener { it.release(); tmp.delete(); pumpTts() }
                    mp.setOnErrorListener { p, _, _ -> p.release(); tmp.delete(); pumpTts(); true }
                    mp.prepare(); mp.start()
                    player = mp
                } catch (_: Exception) { tmp.delete(); pumpTts() }
            }
        }
    }

    private suspend fun synthesize(text: String): ByteArray? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url(AlmaTheme.BASE_URL.trimEnd('/') + "/api/assistant/tts")
                .header("Content-Type", "application/json")
                .apply { android.webkit.CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)?.let { header("Cookie", it) } }
                .post(JSONObject().put("text", text).toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.bytes() else null }
        } catch (_: Exception) { null }
    }

    private fun stopTts() {
        try { player?.stop(); player?.release() } catch (_: Exception) {}
        player = null
        ttsQueue.clear()
        speaking = false
        ttsActive = false
        nowSpeaking = ""
    }

    private fun onSpeechDone() {
        speaking = false
        ttsActive = false
        nowSpeaking = ""
        if (state == VoiceState.SPEAKING || state == VoiceState.THINKING) state = VoiceState.IDLE
        if (conversationMode) scope.launch { delay(300); if (state == VoiceState.IDLE && !ttsActive) startListening() }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun AssistantVoiceScreen(ctx: PushCtx) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val engine = remember { VoiceEngine(context, scope) }
    DisposableEffect(Unit) { onDispose { engine.shutdown() } }

    val state = engine.state
    val orbColor = hueColor(state.hue)

    Box(
        Modifier.fillMaxSize().background(
            Brush.radialGradient(
                listOf(orbColor.copy(alpha = 0.18f), Color(0xFF07070B)),
                radius = 1400f,
            ),
        ),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxSize().padding(24.dp)) {
            Spacer(Modifier.height(40.dp))
            Text(state.label, color = orbColor, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))

            VoiceOrb(state = state, color = orbColor, level = engine.micLevel, onTap = { engine.tapOrb() })

            Spacer(Modifier.height(28.dp))
            // Transcript / spoken caption
            val caption = when {
                engine.nowSpeaking.isNotBlank() -> engine.nowSpeaking
                engine.transcript.isNotBlank() && state != VoiceState.SPEAKING -> engine.transcript
                else -> ""
            }
            if (caption.isNotBlank()) {
                Text(
                    caption, color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                        .background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(16.dp))
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
            Spacer(Modifier.weight(1f))

            // কথোপকথন (auto-relisten) + on-device STT toggles
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.background(Color.White.copy(alpha = 0.06f), CircleShape).padding(horizontal = 16.dp, vertical = 6.dp),
            ) {
                Text("কথোপকথন মোড", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
                Switch(checked = engine.conversationMode, onCheckedChange = { engine.conversationMode = it })
            }
            Spacer(Modifier.height(8.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.background(Color.White.copy(alpha = 0.06f), CircleShape).padding(horizontal = 16.dp, vertical = 6.dp),
            ) {
                Text("অন-ডিভাইস STT (ফ্রি)", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
                Switch(checked = engine.onDeviceStt, onCheckedChange = { engine.updateOnDeviceStt(it) })
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun VoiceOrb(state: VoiceState, color: Color, level: Float, onTap: () -> Unit) {
    val t = rememberInfiniteTransition(label = "orb")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(9000, easing = LinearEasing), RepeatMode.Restart), label = "spin")
    val breathe by t.animateFloat(0.92f, 1.06f, infiniteRepeatable(tween(2200), RepeatMode.Reverse), label = "breathe")
    val speaking = state == VoiceState.SPEAKING
    val thinking = state == VoiceState.THINKING || state == VoiceState.TRANSCRIBING
    val react = if (speaking) 0.5f + 0.5f * breathe else level.coerceIn(0f, 1f)

    Box(
        Modifier.size(220.dp).pointerInput(Unit) { detectTapGestures(onTap = { onTap() }) },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val c = Offset(size.width / 2, size.height / 2)
            val baseR = size.minDimension * 0.28f
            // 72-bar reactive ring
            val bars = 72
            for (i in 0 until bars) {
                val ang = (i.toFloat() / bars) * 360f + spin * if (thinking) 1f else 0.15f
                val rad = Math.toRadians(ang.toDouble())
                val wobble = (sin((i * 0.7f) + spin / 12f) + 1f) / 2f
                val len = baseR * (0.35f + 0.5f * react * (0.4f + 0.6f * wobble))
                val inner = baseR * 1.18f
                val start = Offset(c.x + inner * cos(rad).toFloat(), c.y + inner * sin(rad).toFloat())
                val end = Offset(c.x + (inner + len) * cos(rad).toFloat(), c.y + (inner + len) * sin(rad).toFloat())
                drawLine(color.copy(alpha = 0.35f + 0.5f * react), start, end, strokeWidth = 4f)
            }
            // orb core
            val coreR = baseR * (if (speaking) breathe else (0.96f + 0.1f * react))
            drawCircle(
                brush = Brush.radialGradient(
                    listOf(color.copy(alpha = 0.95f), color.copy(alpha = 0.35f)),
                    center = Offset(c.x - coreR * 0.3f, c.y - coreR * 0.3f), radius = coreR * 1.5f,
                ),
                radius = coreR, center = c,
            )
            drawCircle(color.copy(alpha = 0.25f), radius = coreR * 1.35f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f))
        }
    }
}
