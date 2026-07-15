//
//  ActiveCallBar.kt
//  ALMA ERP — the WhatsApp-style "call is still running" bar.
//
//  When the full-screen call screen is minimised the call keeps running in
//  IntercomForegroundService, but the user needs to SEE that and get back to it —
//  otherwise a minimised call is indistinguishable from a dropped one (which is
//  exactly how the old bottom-sheet call felt when a stray tap closed it).
//
//  Mirrors WhatsApp: a slim bar pinned under the status bar showing the peer and
//  the live state, with mute + hang-up, and tap-anywhere to re-open the call.
//  It renders only while a call is live AND the call screen itself isn't showing.
//
package com.almatraders.erp.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.CallNotifications
import com.almatraders.erp.pages.AgoraIntercom

private val BarBg = Color(0xFF11202A)
private val CallGreen = Color(0xFF25D366)
private val EndRed = Color(0xFFEF4444)

private fun clock(s: Int): String = "%02d:%02d".format(s / 60, s % 60)

@Composable
fun ActiveCallBar() {
    val ic = AgoraIntercom
    val live = ic.mode == AgoraIntercom.Mode.CALLING || ic.mode == AgoraIntercom.Mode.RINGING
    if (!live) return
    val context = LocalContext.current

    // A plain (non-clickable, no-background) full-size Box: it lays the bar out at the
    // top without swallowing taps meant for the screen underneath.
    Box(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(BarBg)
                .clickable { CallNotifications.reopenActive(context, outgoing = ic.callOutgoing) }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Mute — stopPropagation-style: handled here, so it never re-opens the call.
            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(if (ic.micMuted) Color(0xFFF59E0B).copy(alpha = 0.25f) else Color.White.copy(alpha = 0.10f))
                    .clickable { ic.toggleMute() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (ic.micMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                    contentDescription = if (ic.micMuted) "আনমিউট" else "মিউট",
                    tint = Color.White,
                    modifier = Modifier.size(17.dp),
                )
            }

            Icon(Icons.Filled.Call, contentDescription = null, tint = CallGreen, modifier = Modifier.size(16.dp))
            Text(
                buildString {
                    append(ic.callPeer)
                    append(" — ")
                    append(if (ic.connected) clock(ic.callSeconds) else "রিং হচ্ছে…")
                },
                color = CallGreen,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )

            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(EndRed)
                    .clickable { ic.leave() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.CallEnd,
                    contentDescription = "কল কাটুন",
                    tint = Color.White,
                    modifier = Modifier.size(17.dp),
                )
            }
        }
    }
}
