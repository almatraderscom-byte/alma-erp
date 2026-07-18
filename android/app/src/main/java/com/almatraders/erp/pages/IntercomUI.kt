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
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.CallNotifications
import kotlinx.coroutines.launch

private val icViolet = Color(0xFF8B5CF6)
private val icRed = Color(0xFFEF4444)
private val icGreen = Color(0xFF22A77A)

/** Compact launcher card shown on the Office screen. */
@Composable
fun IntercomLaunchCard(dark: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlassIntercom(dark)
            .semantics { role = Role.Button; contentDescription = "অফিস কল খুলুন" }
            .plainClick(onOpen).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp).background(icViolet.copy(alpha = 0.16f), CircleShape), contentAlignment = Alignment.Center) {
            Text("🎙️", fontSize = 18.sp)
        }
        Column(Modifier.weight(1f)) {
            Text("অফিস কল", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("App call · mobile · PTT · live walkie-talkie", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
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
    val permissionLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions(),
    ) { AgoraIntercom.refreshCapabilities() }

    LaunchedEffect(Unit) {
        AgoraIntercom.attach(context)
        // Mic is needed to speak / PTT — request up front so a press-and-hold works.
        val permissions = buildList {
            if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                add(android.Manifest.permission.RECORD_AUDIO)
            }
            if (android.os.Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                add(android.Manifest.permission.POST_NOTIFICATIONS)
            }
            if (android.os.Build.VERSION.SDK_INT >= 31 && context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                add(android.Manifest.permission.BLUETOOTH_CONNECT)
            }
        }
        if (permissions.isNotEmpty()) permissionLauncher.launch(permissions.toTypedArray())
        AgoraIntercom.loadFeed()
    }

    val ic = AgoraIntercom
    val inCall = ic.mode == AgoraIntercom.Mode.CALLING || ic.mode == AgoraIntercom.Mode.RINGING || ic.mode == AgoraIntercom.Mode.RECONNECTING
    val live = ic.mode == AgoraIntercom.Mode.BROADCASTING || ic.mode == AgoraIntercom.Mode.LISTENING

    ModalBottomSheet(
        // The process coordinator owns an active call. Closing this sheet only
        // minimizes it; the ongoing CallStyle notification is the global return UI.
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AlmaTheme.rootBg(dark),
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                if (inCall) ic.callPeer else "অফিস কল",
                color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Bold,
            )
            CommunicationKinds(dark)
            if (ic.statusText.isNotEmpty()) {
                Text(ic.statusText, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center)
            }
            if (inCall && ic.callSeconds > 0) {
                Text(timeStr(ic.callSeconds), color = AlmaTheme.ink(dark), fontSize = 22.sp, fontWeight = FontWeight.Bold)
            }
            ic.error?.let {
                Text(it, color = icRed, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().background(icRed.copy(alpha = 0.10f), RoundedCornerShape(12.dp)).padding(10.dp))
            }
            ic.capabilityIssue?.let {
                Text(
                    if (it == "full_screen_intent_denied_heads_up_fallback") "ফুল-স্ক্রিন কল বন্ধ — হেডস-আপ নোটিফিকেশন ব্যবহার হবে"
                    else "কল নোটিফিকেশন/ব্যাকগ্রাউন্ড অনুমতি যাচাই করুন",
                    color = Color(0xFFF59E0B), fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier
                        .semantics { role = Role.Button; contentDescription = "কল permission settings খুলুন" }
                        .defaultMinSize(minHeight = 48.dp).plainClick {
                        val settings = if (it == "full_screen_intent_denied_heads_up_fallback") {
                            CallNotifications.fullScreenSettingsIntent(context)
                        } else CallNotifications.notificationSettingsIntent(context)
                        if (settings != null) context.startActivity(settings)
                    },
                )
            }

            // Live speaking orb.
            LiveOrb(active = live || inCall, speaking = ic.remoteSpeaking || ic.localSpeaking, dark = dark)

            when {
                inCall -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        BigBtn(if (ic.micMuted) "🔇 আনমিউট" else "🎙️ মিউট", icViolet, false, Modifier.weight(1f)) { ic.toggleMute() }
                        BigBtn(if (ic.speakerEnabled) "🔈 ইয়ারপিস" else "🔊 স্পিকার", icViolet, false, Modifier.weight(1f)) { ic.toggleSpeaker() }
                    }
                    BigBtn(if (ic.mode == AgoraIntercom.Mode.RINGING) "বাতিল" else "কল কাটুন", icRed, true, Modifier.fillMaxWidth()) {
                        ic.endActiveCallFromUi(); onDismiss()
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
                                        .plainClick { scope.launch { ic.ownerCall(s.id) } }.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Text(s.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                                    Text("📞", fontSize = 18.sp)
                                }
                            }
                        }
                    } else if (!isOwner) {
                        BigBtn("📞 বসকে কল করুন", icGreen, true, Modifier.fillMaxWidth()) {
                            scope.launch { ic.staffCallOwner() }
                        }
                    }
                }
            }
            RecentCalls(ic.recentCalls, dark)
        }
    }
}

@Composable
private fun CommunicationKinds(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlassIntercom(dark).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("যোগাযোগের ধরন", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Kind("📞", "App voice", "private live", dark, Modifier.weight(1f))
            Kind("☎️", "Mobile", "SIM network", dark, Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Kind("🎙️", "Recorded PTT", "voice message", dark, Modifier.weight(1f))
            Kind("📢", "Live walkie", "office live", dark, Modifier.weight(1f))
        }
    }
}

@Composable
private fun Kind(icon: String, title: String, detail: String, dark: Boolean, modifier: Modifier) {
    Row(
        modifier.background(AlmaTheme.ink(dark).copy(alpha = 0.045f), RoundedCornerShape(12.dp)).padding(9.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$title, $detail" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(icon, fontSize = 17.sp)
        Column { Text(title, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold); Text(detail, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp) }
    }
}

@Composable
private fun RecentCalls(calls: List<IntercomRecentCall>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlassIntercom(dark).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("সাম্প্রতিক কল", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        if (calls.isEmpty()) Text("এখনো কোনো call history নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        calls.take(8).forEach { call ->
            val outcome = callOutcome(call)
            val tone = when (outcome) {
                "সম্পন্ন", "কল চলছে" -> icGreen
                "ব্যস্ত", "ব্যর্থ", "পুনঃসংযোগ" -> Color(0xFFF59E0B)
                else -> icRed
            }
            val duration = call.callDurationSec?.let { if (it < 60) "$it সেকেন্ড" else "${it / 60} মিনিট ${it % 60} সেকেন্ড" }
            Row(
                Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp)
                    .semantics(mergeDescendants = true) { contentDescription = "${if (call.outgoingByMe) "আউটগোয়িং" else "ইনকামিং"} কল, $outcome${duration?.let { ", $it" } ?: ""}" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Text(if (call.outgoingByMe) "↗" else "↘", color = tone, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Column(Modifier.weight(1f)) {
                    Text(call.callerName ?: if (call.outgoingByMe) "স্টাফ" else "বস — মারুফ", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(if (call.outgoingByMe) "আউটগোয়িং" else "ইনকামিং", duration).joinToString(" · "), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
                }
                Text(outcome, color = tone, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

private fun callOutcome(call: IntercomRecentCall): String {
    if (call.endedAt == null) return when (call.canonicalState) {
        "CONNECTED" -> "কল চলছে"
        "RECONNECTING" -> "পুনঃসংযোগ"
        else -> if (call.outgoingByMe) "আউটগোয়িং" else "ইনকামিং"
    }
    return when (call.endedReason) {
        "completed" -> "সম্পন্ন"
        "declined" -> "প্রত্যাখ্যাত"
        "busy" -> "ব্যস্ত"
        "failed", "push_unreachable" -> "ব্যর্থ"
        else -> if (call.outgoingByMe) "ধরা হয়নি" else "মিসড"
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
            )
            .semantics { contentDescription = if (speaking) "কথা হচ্ছে" else if (active) "লাইভ অডিও সক্রিয়" else "অডিও বন্ধ" },
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
            .semantics { role = Role.Button; contentDescription = if (recording) "রেকর্ডিং চলছে, ছেড়ে দিলে পাঠাবে" else "চেপে ধরে voice message রেকর্ড করুন" }
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
            .defaultMinSize(minHeight = 48.dp)
            .semantics { role = Role.Button; contentDescription = label }
            .background(if (filled) tint else tint.copy(alpha = 0.14f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(vertical = 14.dp),
    )
}

private fun timeStr(s: Int): String = "%02d:%02d".format(s / 60, s % 60)
