//
//  IncomingCallActivity.kt
//  ALMA ERP — Android full-screen incoming call screen (Stage 1).
//
//  Launched by CallNotifications' full-screen intent (native ring, shows over the lock
//  screen). Accept joins the native Agora call channel (AgoraIntercom, the same engine the
//  in-app intercom uses); decline / hang-up tears it down. The screen mirrors WhatsApp:
//  ringing → Accept/Decline; connected → timer + Mute + End.
//
package com.almatraders.erp

import android.app.KeyguardManager
import android.webkit.CookieManager
import android.content.Context
import android.os.Build
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.RepeatMode
import androidx.compose.ui.draw.scale
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.almatraders.erp.pages.AgoraIntercom
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.AlmaApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

class IncomingCallActivity : ComponentActivity() {

    private var broadcastId = ""
    private var channel = ""
    private var caller = "বস — মারুফ"
    /** true → we placed this call (dial out), false → someone is ringing us. */
    private var outgoing = false
    private var staffId = ""
    private var callerImage: String? = null
    /** true → the call is already running; we are just re-showing the screen. */
    private var reopen = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        broadcastId = intent.getStringExtra(CallNotifications.EXTRA_BROADCAST_ID) ?: ""
        channel = intent.getStringExtra(CallNotifications.EXTRA_CHANNEL)
            ?: if (broadcastId.isNotEmpty()) "itc_$broadcastId" else ""
        caller = intent.getStringExtra(CallNotifications.EXTRA_CALLER) ?: "বস — মারুফ"
        outgoing = intent.getBooleanExtra(CallNotifications.EXTRA_OUTGOING, false)
        staffId = intent.getStringExtra(CallNotifications.EXTRA_STAFF_ID) ?: ""
        callerImage = intent.getStringExtra(CallNotifications.EXTRA_CALLER_IMAGE)
        reopen = intent.getBooleanExtra(CallNotifications.EXTRA_REOPEN, false)
        // Re-opened from the minimised bar: the call is live, keep its name/photo.
        if (reopen) {
            caller = AgoraIntercom.callPeer
            callerImage = AgoraIntercom.callPeerImage
        }

        // Own the WHOLE screen. The activity inherits the launch theme, whose window
        // background showed through the status-bar inset as a white strip above the
        // call UI. Paint the window with the call gradient's base colour and let the
        // content draw edge-to-edge underneath the system bars.
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0xFF0C0B12.toInt()))
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT

        // Show over the lock screen and turn the screen on — WhatsApp-style.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
                ?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            )
        }

        AgoraIntercom.attach(applicationContext)
        if (broadcastId.isNotEmpty()) AgoraIntercom.markCallHandled(broadcastId)

        if (outgoing) {
            // We are dialling: no incoming ringtone, no Accept/Decline. ownerCall
            // creates the broadcast (which pushes the callee) and then joins the
            // channel — AgoraIntercom drives RINGING → CALLING → IDLE from there.
            // On a re-open the call is ALREADY live — dialling again would place a
            // second call, so only dial on a fresh launch.
            if (!reopen && staffId.isNotEmpty()) lifecycleScope.launch { AgoraIntercom.ownerCall(staffId) }
        } else if (!reopen) {
            AgoraIntercom.ringIncoming()
        }

        setContent { MaterialTheme { CallScreen() } }
    }

    /**
     * This activity is singleInstance, so a SECOND call push is delivered here as a new
     * intent instead of a fresh activity — and the Compose state (answered/wasLive) from
     * the previous call survived, which showed the old call's UI for the new caller.
     * Rebuild from the new extras. A re-delivery of the SAME call is ignored so an
     * OneSignal retry can't restart the ring.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val newId = intent.getStringExtra(CallNotifications.EXTRA_BROADCAST_ID) ?: ""
        if (newId.isNotEmpty() && newId == broadcastId) return
        setIntent(intent)
        recreate()
    }

    private fun confirmReceipt() {
        val id = broadcastId
        if (id.isEmpty()) return
        lifecycleScope.launch {
            runCatching {
                AlmaApi.send(
                    "POST", "/api/assistant/office/intercom/receipt",
                    JSONObject().put("broadcastId", id).put("action", "confirmed"),
                )
            }
        }
    }

    private fun finishAndCleanup() {
        CallNotifications.cancel(applicationContext)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        CallNotifications.cancel(applicationContext)
        AgoraIntercom.stopRinging()
    }

    @Composable
    private fun CallScreen() {
        // Outgoing calls are "answered" from the start — we dial, there is nothing to accept.
        var answered by remember { mutableStateOf(outgoing) }
        val mode = AgoraIntercom.mode
        // "Connected" = the PEER joined the channel (mode flips to CALLING in
        // onUserJoined, which is also when the call ticker starts). AgoraIntercom.connected
        // only means WE joined — true the instant we dial — so using it here showed a
        // 00:00 timer and a "কল কাটুন" button while the phone was still ringing.
        val connected = mode == AgoraIntercom.Mode.CALLING
        val seconds = AgoraIntercom.callSeconds
        val muted = AgoraIntercom.micMuted

        // The engine reports IDLE for a moment before an outgoing call reaches RINGING.
        // Without this latch the "call ended" effect below would fire on that first
        // frame and close the screen instantly. Only treat IDLE as "ended" once the
        // call has actually been live at least once.
        var wasLive by remember { mutableStateOf(false) }
        LaunchedEffect(mode) {
            if (mode == AgoraIntercom.Mode.RINGING || mode == AgoraIntercom.Mode.CALLING) wasLive = true
        }

        // Answering without RECORD_AUDIO would join the channel and publish SILENCE —
        // the caller would hear nothing while we hear them. Ask at accept time; the
        // launch-time prompt may have been refused long ago and never reappears.
        val micLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) {
                answered = true
                AgoraIntercom.stopRinging()
                confirmReceipt()
                lifecycleScope.launch { AgoraIntercom.startCall(channel, outgoing = false) }
            } else {
                AgoraIntercom.reportMicDenied()
            }
        }
        fun acceptCall() {
            if (AgoraIntercom.hasMicPermission(applicationContext)) {
                answered = true
                AgoraIntercom.stopRinging()
                confirmReceipt()
                lifecycleScope.launch { AgoraIntercom.startCall(channel, outgoing = false) }
            } else {
                micLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
            }
        }

        // The call ended (peer hung up, or we ended it) → close the screen. `wasLive`
        // guards the pre-dial IDLE frame of an outgoing call.
        LaunchedEffect(mode, answered, wasLive) {
            if (answered && wasLive && mode == AgoraIntercom.Mode.IDLE) finishAndCleanup()
        }
        // Caller cancelled before we answered (a cancel push arrived) → close instantly,
        // WhatsApp-style, instead of ringing on to the 60s timeout.
        val cancelledId = AgoraIntercom.cancelledCallId
        LaunchedEffect(cancelledId) {
            if (cancelledId == broadcastId) {
                AgoraIntercom.stopRinging()
                if (!answered) AgoraIntercom.leave()
                finishAndCleanup()
            }
        }
        // Incoming only: nobody picked up within the ring window → auto-dismiss
        // (missed call). An outgoing call is ended by AgoraIntercom's own ring
        // timeout, so this must not fight it.
        if (!outgoing) {
            LaunchedEffect(Unit) {
                delay(60_000)
                if (!answered) {
                    confirmReceipt()
                    AgoraIntercom.stopRinging()
                    finishAndCleanup()
                }
            }
        }

        // Accept/Decline only exists for an incoming ring — never when we dialled.
        val ringing = !outgoing && !answered && mode != AgoraIntercom.Mode.CALLING

        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(listOf(Color(0xFF0C0B12), Color(0xFF1B1030), Color(0xFF0C0B12))),
                ),
            contentAlignment = Alignment.Center,
        ) {
            // Minimise (WhatsApp parity): just close the SCREEN — the call keeps running
            // in the foreground service and the shell's call bar taps back in. Only the
            // red button ends a call. Not shown while an incoming call is still ringing
            // (there is nothing to go back to until it's answered).
            if (!ringing) {
                Box(
                    Modifier
                        .align(Alignment.TopStart)
                        .padding(start = 14.dp, top = 52.dp)
                        .size(44.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.10f))
                        .clickable { finish() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.KeyboardArrowDown,
                        contentDescription = "ছোট করুন",
                        tint = Color.White,
                        modifier = Modifier.size(26.dp),
                    )
                }
            }
            Column(
                Modifier.fillMaxSize().padding(28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Spacer(Modifier.height(48.dp))
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    // WhatsApp-style: the avatar breathes while ringing, and settles the
                    // moment the peer answers.
                    val pulse = rememberInfiniteTransition(label = "ring")
                    val scale by pulse.animateFloat(
                        initialValue = 1f,
                        targetValue = if (connected) 1f else 1.06f,
                        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
                        label = "ringScale",
                    )
                    Box(
                        Modifier
                            .scale(if (connected) 1f else scale)
                            .size(112.dp)
                            .clip(CircleShape)
                            .background(
                                Brush.linearGradient(listOf(Color(0xFFE07A5F), Color(0xFF8B5CF6))),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        // The initial is ALWAYS drawn underneath: if the photo is missing,
                        // still loading, or fails to load, the circle must never come up
                        // empty (an "if photo != null" swap showed a blank circle instead).
                        // A successful photo simply paints over it.
                        Text(
                            caller.trim().take(1).uppercase().ifEmpty { "?" },
                            color = Color.White, fontSize = 44.sp, fontWeight = FontWeight.Bold,
                        )
                        val img = callerImage
                        if (!img.isNullOrBlank()) {
                            // The server sends a RELATIVE path (/api/users/<id>/profile-image)
                            // and that endpoint is session-gated — a bare Coil load would 401
                            // and silently show nothing. Same recipe as EmployeesScreen's
                            // avatar: absolute BASE_URL + the WebView's session cookie.
                            val full = if (img.startsWith("/")) "${AlmaTheme.BASE_URL}$img" else img
                            val cookie = CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)
                            AsyncImage(
                                model = ImageRequest.Builder(LocalContext.current)
                                    .data(full)
                                    .apply { if (!cookie.isNullOrEmpty()) setHeader("Cookie", cookie) }
                                    .crossfade(true)
                                    .build(),
                                contentDescription = caller,
                                modifier = Modifier.fillMaxSize().clip(CircleShape),
                                contentScale = ContentScale.Crop,
                            )
                        }
                    }
                    Spacer(Modifier.height(20.dp))
                    Text(caller, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        when {
                            connected -> statusTime(seconds)
                            // Dialling out: mirror the engine's own status ("রিং হচ্ছে…").
                            outgoing -> AgoraIntercom.statusText.ifEmpty { "রিং হচ্ছে…" }
                            answered -> "সংযোগ হচ্ছে…"
                            else -> "📞 অফিস লাইভ কল…"
                        },
                        color = Color(0xFFB9BCC9),
                        fontSize = 15.sp,
                    )
                    // Never let a mic problem stay invisible — a silent call looks
                    // identical to a working one from this side.
                    AgoraIntercom.error?.let { err ->
                        Spacer(Modifier.height(10.dp))
                        Text(
                            err,
                            color = Color(0xFFFCA5A5),
                            fontSize = 12.sp,
                            modifier = Modifier.padding(horizontal = 8.dp),
                        )
                    }
                }

                if (ringing) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        CallButton(Icons.Filled.CallEnd, "প্রত্যাখ্যান", Color(0xFFEF4444)) {
                            AgoraIntercom.stopRinging()
                            confirmReceipt()
                            AgoraIntercom.leave()
                            finishAndCleanup()
                        }
                        CallButton(Icons.Filled.Call, "গ্রহণ", Color(0xFF10B981)) { acceptCall() }
                    }
                } else {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        CallButton(
                            if (muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                            if (muted) "আনমিউট" else "মিউট",
                            Color(0xFF6B7280),
                        ) { AgoraIntercom.toggleMute() }
                        CallButton(
                            if (AgoraIntercom.speakerOn) Icons.Filled.VolumeUp else Icons.Filled.VolumeOff,
                            if (AgoraIntercom.speakerOn) "স্পিকার" else "ইয়ারপিস",
                            if (AgoraIntercom.speakerOn) Color(0xFF6B7280) else Color(0xFF3F4654),
                        ) { AgoraIntercom.toggleSpeaker() }
                        CallButton(
                            Icons.Filled.CallEnd,
                            if (connected) "কল কাটুন" else "বাতিল",
                            Color(0xFFEF4444),
                        ) {
                            AgoraIntercom.leave()
                            finishAndCleanup()
                        }
                    }
                }
                Spacer(Modifier.height(28.dp))
            }
        }
    }

    @Composable
    private fun CallButton(
        icon: androidx.compose.ui.graphics.vector.ImageVector,
        label: String,
        tint: Color,
        onClick: () -> Unit,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(72.dp)
                    .clip(CircleShape)
                    .background(tint)
                    .clickable(onClick = onClick),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(32.dp))
            }
            Spacer(Modifier.height(8.dp))
            Text(label, color = Color(0xFFCED2DE), fontSize = 13.sp)
        }
    }

    private fun statusTime(s: Int): String = "%02d:%02d".format(s / 60, s % 60)
}
