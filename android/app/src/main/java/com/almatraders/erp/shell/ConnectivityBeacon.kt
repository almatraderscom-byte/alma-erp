//
//  ConnectivityBeacon.kt
//  ALMA ERP — app-wide offline experience, the Android twin of the iOS
//  ConnectivityBeacon (owner-approved WOW design, 2026-07).
//
//  When the network drops, a full-screen takeover darkens the app and a terracotta
//  lighthouse beacon sweeps for signal — pulsing rings, an orbiting comet, an
//  ৮-second auto-retry countdown and a manual retry. When connectivity returns
//  (verified with a real /api/health request), the takeover dissolves and a small
//  chip confirms "সংযোগ ফিরে এসেছে".
//
//  Mounted once at the shell root (NativeShell.ShellRoot), floating over every tab
//  and pushed screen — nothing existing is touched. A ConnectivityManager default-
//  network callback drives it; a 1.5s offline debounce stops Wi-Fi↔cellular
//  hand-offs from flashing the takeover. Same probe/countdown constants as iOS.
//

package com.almatraders.erp.shell

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

private val TERRACOTTA = Color(0xFFE07A5F)
private val TERRACOTTA_LIGHT = Color(0xFFF5A38C)
private val TERRACOTTA_DEEP = Color(0xFFC5593D)

private val bnDigits = "০১২৩৪৫৬৭৮৯".toCharArray()
private fun bnNum(n: Int): String =
    n.toString().map { c -> if (c.isDigit()) bnDigits[c - '0'] else c }.joinToString("")

/** Real probe — path status alone lies behind captive portals. Success dissolves the takeover. */
private suspend fun probe(): Boolean = withContext(Dispatchers.IO) {
    try {
        val url = URL(AlmaTheme.BASE_URL.trimEnd('/') + "/api/health")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = 5000
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
        }
        try {
            conn.responseCode in 200..499
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        false
    }
}

/**
 * App-wide offline overlay. Renders nothing while online. Place LAST in the shell so
 * it floats over the tab bar, pushed screens, and the chat head.
 */
@Composable
fun ConnectivityBeacon(dark: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showOverlay by remember { mutableStateOf(false) }
    var showChip by remember { mutableStateOf(false) }
    // Debounce token: a Wi-Fi→cellular hop reports a brief lost network.
    var offlineSince by remember { mutableStateOf(0L) }

    DisposableEffect(Unit) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        // Authoritative online = at least one usable network is present. Counting the
        // live network set avoids the onLost race where activeNetwork still reports the
        // dying network for a beat (which had left the takeover from ever arming).
        val live = java.util.Collections.synchronizedSet(HashSet<Network>())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                live.add(network)
                offlineSince = 0L
                if (showOverlay) {
                    showOverlay = false
                    showChip = true
                }
            }

            override fun onLost(network: Network) {
                live.remove(network)
                if (live.isEmpty()) offlineSince = System.currentTimeMillis()
            }
        }
        try {
            cm?.registerDefaultNetworkCallback(callback)
            // Seed current state so a launch that is ALREADY offline arms the takeover.
            if (cm?.activeNetwork == null) offlineSince = System.currentTimeMillis()
        } catch (_: Exception) { }
        onDispose {
            try {
                cm?.unregisterNetworkCallback(callback)
            } catch (_: Exception) { }
        }
    }

    // Offline debounce → 1.5s of sustained no-network before the takeover.
    LaunchedEffect(offlineSince) {
        if (offlineSince == 0L) return@LaunchedEffect
        delay(1500)
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (offlineSince != 0L && cm?.activeNetwork == null) showOverlay = true
    }

    // Chip auto-dismiss.
    LaunchedEffect(showChip) {
        if (showChip) {
            delay(3400)
            showChip = false
        }
    }

    AnimatedVisibility(visible = showOverlay, enter = fadeIn(tween(400)), exit = fadeOut(tween(450))) {
        OfflineTakeover(
            onRecovered = {
                showOverlay = false
                showChip = true
            },
            probeNow = { probe() },
            scopeLaunch = { block -> scope.launch { block() } },
        )
    }

    AnimatedVisibility(
        visible = showChip,
        enter = slideInVertically(tween(500)) { -it } + fadeIn(),
        exit = fadeOut(tween(300)),
    ) {
        ReconnectChip()
    }
}

@Composable
private fun OfflineTakeover(
    onRecovered: () -> Unit,
    probeNow: suspend () -> Boolean,
    scopeLaunch: (suspend () -> Unit) -> Unit,
) {
    var countdown by remember { mutableStateOf(8) }
    var checking by remember { mutableStateOf(false) }

    fun retryNow() {
        if (checking) return
        checking = true
        scopeLaunch {
            val ok = probeNow()
            checking = false
            countdown = 8
            if (ok) onRecovered()
        }
    }

    // 1-second ticker: auto-retry at zero.
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            countdown -= 1
            if (countdown <= 0) {
                countdown = 8
                retryNow()
            }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Color.Black.copy(alpha = 0.90f), Color.Black.copy(alpha = 0.96f)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(26.dp),
        ) {
            LighthouseBeacon()
            Text(
                "সংযোগ হারিয়ে গেছে",
                color = Color.White,
                fontSize = 22.sp,
                fontWeight = FontWeight.Black,
                modifier = Modifier.padding(top = 18.dp),
            )
            Text(
                "চিন্তা নেই — সব কাজ সেভ আছে।\nসিগন্যাল খোঁজা চলছে…",
                color = Color.White.copy(alpha = 0.66f),
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 7.dp),
            )
            Box(
                Modifier
                    .padding(top = 20.dp)
                    .clickable(enabled = !checking) { retryNow() }
                    .background(
                        Brush.linearGradient(listOf(TERRACOTTA_LIGHT, TERRACOTTA_DEEP)),
                        CircleShape,
                    )
                    .padding(horizontal = 30.dp, vertical = 14.dp),
            ) {
                Text(
                    if (checking) "চেষ্টা হচ্ছে…" else "এখনই আবার চেষ্টা করুন",
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Black,
                )
            }
            Text(
                "নিজে-নিজে চেষ্টা হবে ${bnNum(countdown)} সেকেন্ডে",
                color = Color.White.copy(alpha = 0.6f),
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 20.dp),
            )
            Text(
                "🔒 অফলাইনেও ডেটা নিরাপদে সেভ থাকে",
                color = Color.White.copy(alpha = 0.75f),
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .padding(top = 20.dp)
                    .background(Color.White.copy(alpha = 0.08f), CircleShape)
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

/** Rotating lighthouse sweep + pulsing rings + orbiting comet + breathing terracotta core. */
@Composable
private fun LighthouseBeacon() {
    val t = rememberInfiniteTransition(label = "beacon")
    val sweep by t.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(3200, easing = LinearEasing), RepeatMode.Restart), label = "sweep",
    )
    val comet by t.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(8000, easing = LinearEasing), RepeatMode.Restart), label = "comet",
    )
    val breathe by t.animateFloat(
        0.96f, 1.05f,
        infiniteRepeatable(tween(2600), RepeatMode.Reverse), label = "breathe",
    )
    val pulse1 by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(2600, easing = LinearEasing), RepeatMode.Restart), label = "pulse1",
    )
    val pulse2 by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(2600, easing = LinearEasing, delayMillis = 1300), RepeatMode.Restart),
        label = "pulse2",
    )

    Box(Modifier.size(150.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val c = Offset(size.width / 2, size.height / 2)
            val maxR = size.minDimension / 2

            // Rotating lighthouse sweep — an angular wedge of terracotta light.
            rotate(sweep, pivot = c) {
                drawArc(
                    brush = Brush.sweepGradient(
                        0f to TERRACOTTA_LIGHT.copy(alpha = 0.55f),
                        0.13f to TERRACOTTA_LIGHT.copy(alpha = 0.12f),
                        0.22f to Color.Transparent,
                        1f to Color.Transparent,
                        center = c,
                    ),
                    startAngle = 0f, sweepAngle = 360f, useCenter = true,
                    topLeft = Offset(c.x - maxR, c.y - maxR),
                    size = androidx.compose.ui.geometry.Size(maxR * 2, maxR * 2),
                )
            }

            // Pulsing rings (expand + fade).
            for (p in listOf(pulse1, pulse2)) {
                val r = maxR * (0.42f + 0.42f * p)
                drawCircle(
                    color = TERRACOTTA_LIGHT.copy(alpha = 0.5f * (1f - p)),
                    radius = r, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f),
                )
            }

            // Breathing terracotta core.
            val coreR = maxR * 0.42f * breathe
            drawCircle(
                brush = Brush.radialGradient(
                    listOf(TERRACOTTA_LIGHT, TERRACOTTA_DEEP),
                    center = Offset(c.x - coreR * 0.3f, c.y - coreR * 0.3f),
                    radius = coreR * 1.6f,
                ),
                radius = coreR, center = c,
            )

            // Orbiting comet.
            val rad = Math.toRadians(comet.toDouble())
            val orbitR = maxR * 0.86f
            val cometPos = Offset(
                (c.x + orbitR * Math.sin(rad)).toFloat(),
                (c.y - orbitR * Math.cos(rad)).toFloat(),
            )
            drawCircle(TERRACOTTA_LIGHT.copy(alpha = 0.35f), radius = 11f, center = cometPos)
            drawCircle(Color.White, radius = 4.5f, center = cometPos)
        }
        Text("⚠", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ReconnectChip() {
    Box(Modifier.fillMaxSize().padding(top = 46.dp), contentAlignment = Alignment.TopCenter) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            modifier = Modifier
                .background(Color(0xFF0D0D12).copy(alpha = 0.92f), RoundedCornerShape(50))
                .padding(horizontal = 17.dp, vertical = 9.dp),
        ) {
            Box(Modifier.size(8.dp).background(Color(0xFF21C55D), CircleShape))
            Text("সংযোগ ফিরে এসেছে", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text("সব সিংক হয়ে গেছে", color = Color.White.copy(alpha = 0.6f), fontSize = 10.5.sp)
        }
    }
}
