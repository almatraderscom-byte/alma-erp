//
//  IntercomUI.kt
//  ALMA ERP — native Office Live Intercom UI (port of IntercomUI.swift). Owner speaks
//  live / rings a staffer; staff listen + press-and-hold to send a voice note. Drives
//  the AgoraIntercom manager. Audio only.
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.plainClick
import kotlinx.coroutines.launch

private val icViolet = Color(0xFF8B5CF6)
private val icRed = Color(0xFFEF4444)
private val icGreen = Color(0xFF22A77A)

/** Compact launcher card shown on the Office screen. */
@Composable
fun IntercomLaunchCard(dark: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlassIntercom(dark).plainClick(onOpen).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp).background(icViolet.copy(alpha = 0.16f), CircleShape), contentAlignment = Alignment.Center) {
            Text("🎙️", fontSize = 18.sp)
        }
        Column(Modifier.weight(1f)) {
            Text("লাইভ ইন্টারকম", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("ওয়াকি-টকি · সরাসরি কথা / ভয়েস নোট", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        Text("▶", color = icViolet, fontSize = 16.sp)
    }
}

private fun Modifier.almaGlassIntercom(dark: Boolean): Modifier =
    this.background(if (dark) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.7f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
        .border(1.dp, if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CARD.dp))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IntercomSheet(isOwner: Boolean, dark: Boolean, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Staff id waiting on a mic grant — the call resumes the moment it's allowed.
    var pendingCallStaffId by remember { mutableStateOf<String?>(null) }
    val micLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val staffId = pendingCallStaffId
        pendingCallStaffId = null
        if (granted) {
            AgoraIntercom.clearError()
            if (staffId != null) {
                val name = AgoraIntercom.roster.firstOrNull { it.id == staffId }?.name ?: "স্টাফ"
                com.almatraders.erp.CallNotifications.startOutgoing(context, staffId, name)
                onDismiss()
            }
        } else {
            // Denied (or permanently denied — Android then shows no dialog at all).
            // Say so instead of placing a call the peer can never hear.
            AgoraIntercom.reportMicDenied()
        }
    }

    LaunchedEffect(Unit) {
        AgoraIntercom.attach(context)
        // Mic is needed to speak / PTT — request up front so a press-and-hold works.
        if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            micLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
        }
        AgoraIntercom.loadFeed()
    }

    val ic = AgoraIntercom
    val inCall = ic.mode == AgoraIntercom.Mode.CALLING || ic.mode == AgoraIntercom.Mode.RINGING
    val live = ic.mode == AgoraIntercom.Mode.BROADCASTING || ic.mode == AgoraIntercom.Mode.LISTENING

    ModalBottomSheet(
        // WhatsApp parity: tapping outside the sheet (or swiping it down) MINIMISES an
        // active call — it must never hang up. Audio keeps running in the foreground
        // service; the ongoing notification (and the intercom bubble) tap back in.
        // Only the explicit "কল কাটুন" button ends a call. The live walkie-talkie
        // keeps its old behaviour (dismiss = leave the live channel).
        onDismissRequest = { if (!inCall) ic.leave(); onDismiss() },
        sheetState = sheetState,
        containerColor = AlmaTheme.rootBg(dark),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                if (inCall) ic.callPeer else "লাইভ ইন্টারকম",
                color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Bold,
            )
            if (ic.statusText.isNotEmpty()) {
                Text(ic.statusText, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center)
            }
            if (inCall && ic.callSeconds > 0) {
                Text(timeStr(ic.callSeconds), color = AlmaTheme.ink(dark), fontSize = 22.sp, fontWeight = FontWeight.Bold)
            }
            ic.error?.let {
                Text(it, color = icRed, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().background(icRed.copy(alpha = 0.10f), RoundedCornerShape(12.dp)).padding(10.dp))
                // A permanently-denied mic can ONLY be re-granted from app settings —
                // Android stops showing the prompt after two refusals, so give a way out.
                if (it == AgoraIntercom.MIC_DENIED_MSG) {
                    BigBtn("⚙️ সেটিংস খুলুন", icViolet, false, Modifier.fillMaxWidth()) {
                        runCatching {
                            context.startActivity(
                                android.content.Intent(
                                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    android.net.Uri.fromParts("package", context.packageName, null),
                                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    }
                }
            }

            // Live speaking orb.
            LiveOrb(active = live || inCall, speaking = ic.remoteSpeaking || ic.localSpeaking, dark = dark)

            when {
                inCall -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        BigBtn(if (ic.micMuted) "🔇 আনমিউট" else "🎙️ মিউট", icViolet, false, Modifier.weight(1f)) { ic.toggleMute() }
                        BigBtn(if (ic.mode == AgoraIntercom.Mode.RINGING) "বাতিল" else "কল কাটুন", icRed, true, Modifier.weight(1f)) { ic.leave(); onDismiss() }
                    }
                }
                else -> {
                    // Press-and-hold PTT (records + sends a voice note to all staff).
                    PttButton(recording = ic.recording, dark = dark,
                        onDown = { scope.launch { ic.pttStart() } },
                        onUp = { scope.launch { ic.pttStop() } })

                    // Live join / speak.
                    if (live) {
                        BigBtn("লাইভ বন্ধ করুন", icRed, true, Modifier.fillMaxWidth()) { ic.leave() }
                    } else {
                        BigBtn(if (isOwner) "🔊 লাইভ বলুন" else "🎧 লাইভ শুনুন", icGreen, true, Modifier.fillMaxWidth()) {
                            scope.launch { ic.joinLive(asBroadcaster = isOwner) }
                        }
                    }

                    // Owner: ring a staffer 1:1.
                    if (isOwner && ic.roster.isNotEmpty()) {
                        Text("স্টাফকে কল করুন", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                        LazyColumn(Modifier.fillMaxWidth().height(180.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(ic.roster, key = { it.id }) { s ->
                                Row(
                                    Modifier.fillMaxWidth().almaGlassIntercom(dark)
                                        .plainClick {
                                            // Ask for the mic AT CALL TIME. Without it Agora would
                                            // join and publish silence — the staffer would never
                                            // hear us while we hear them.
                                            if (ic.hasMicPermission(context)) {
                                                // Dial out on the FULL-SCREEN call screen, not in
                                                // this sheet: the sheet left the page visible behind
                                                // it, so one stray tap on that scrim killed the call
                                                // UI. A full-screen activity has no "outside".
                                                com.almatraders.erp.CallNotifications.startOutgoing(context, s.id, s.name)
                                                onDismiss()
                                            } else {
                                                pendingCallStaffId = s.id
                                                micLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
                                            }
                                        }.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(s.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                                    Text("📞", fontSize = 18.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LiveOrb(active: Boolean, speaking: Boolean, dark: Boolean) {
    val size = if (speaking) 108 else 92
    Box(
        Modifier.size(size.dp)
            .background(
                if (!active) AlmaTheme.inkSecondary(dark).copy(alpha = 0.12f)
                else if (speaking) icGreen.copy(alpha = 0.85f) else icViolet.copy(alpha = 0.7f),
                CircleShape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (speaking) "🔊" else if (active) "🎙️" else "💤", fontSize = 34.sp)
    }
}

@Composable
private fun PttButton(recording: Boolean, dark: Boolean, onDown: () -> Unit, onUp: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(64.dp)
            .background(if (recording) icRed else icViolet, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown()
                    onDown()
                    waitForUpOrCancellation()
                    onUp()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(if (recording) "🔴 ছেড়ে দিলে পাঠাবে" else "🎙️ চেপে ধরে বলুন", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun BigBtn(label: String, tint: Color, filled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = if (filled) Color.White else tint, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = modifier
            .background(if (filled) tint else tint.copy(alpha = 0.14f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(vertical = 14.dp),
    )
}

private fun timeStr(s: Int): String = "%02d:%02d".format(s / 60, s % 60)
