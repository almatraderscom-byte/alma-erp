//
//  ClaudeTopFade.kt
//  ALMA ERP — reusable "top scroll-edge fade" (Android twin of iOS ClaudeTopFade.swift).
//
//  As content scrolls UP behind the floating native header it progressively DISSOLVES into
//  the app/aura background colour at the very top. There is NO solid header bar — the fade
//  itself is the visual separator (same idea as the Claude iOS app + the web TopScrollFade).
//
//  Compose note: SwiftUI's variant also runs a masked variable-radius blur under the scrim.
//  Compose has no maskable backdrop-blur without a heavy 3rd-party dep, so the Android twin
//  ships the SCRIM DISSOLVE — the dominant part of the look (content melts into the page
//  colour). The scrim tokens + opacity ramp are kept IN SYNC with the iOS ClaudeTopFadeTheme
//  and the web TopScrollFade so all three surfaces read the same.
//
//  Wiring (top-aligned overlay on any scrolling content area; never eats touches):
//    Box(Modifier.weight(1f)) {
//        SomeScrollingScreen()
//        ClaudeTopFade(dark)          // drawn AFTER content ⇒ overlays the top edge
//    }
//

package com.almatraders.erp.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// ── SHARED DESIGN TOKENS — keep IN SYNC with iOS ClaudeTopFadeTheme + web TopScrollFade ──
//   SCRIM_LIGHT #FAF9F6 — the light page base (web --bg-0).
//   SCRIM_DARK  #1C1830 — the TOP of the dark "aura" gradient (indigo). NEVER a near-black
//                         here: a black-ish scrim reads as a shadow band on the dark theme
//                         (owner verdict 2026-07-06); the dissolve is the bg-matched tint.
//   RAMP        alpha 0.45 at the top edge → 0.22 at 55% → 0 at the bottom of the fade.
private val CLAUDE_FADE_LIGHT_SCRIM = Color(0xFFFAF9F6)
private val CLAUDE_FADE_DARK_SCRIM = Color(0xFF1C1830)

/** Fade depth — the iOS 88pt header zone (Android content already sits below the 48dp
 *  header, so this spans the top of the content area under it). */
val CLAUDE_TOP_FADE_HEIGHT: Dp = 88.dp

/**
 * Claude-style top scroll-edge fade. Place as the LAST child of a content [Box] so it
 * overlays the top edge; it carries no pointer input, so scrolling/taps pass straight
 * through to the content beneath (iOS `allowsHitTesting(false)` parity).
 */
@Composable
fun BoxScope.ClaudeTopFade(dark: Boolean, height: Dp = CLAUDE_TOP_FADE_HEIGHT) {
    val scrim = if (dark) CLAUDE_FADE_DARK_SCRIM else CLAUDE_FADE_LIGHT_SCRIM
    Box(
        Modifier
            .align(Alignment.TopCenter)
            .fillMaxWidth()
            .height(height)
            .background(
                Brush.verticalGradient(
                    0.0f to scrim.copy(alpha = 0.45f),
                    0.55f to scrim.copy(alpha = 0.22f),
                    1.0f to scrim.copy(alpha = 0.0f),
                ),
            ),
    )
}
