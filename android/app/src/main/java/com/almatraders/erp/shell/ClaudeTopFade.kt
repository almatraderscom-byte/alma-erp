//
//  ClaudeTopFade.kt
//  ALMA ERP — reusable "top scroll-edge fade" (Android twin of iOS ClaudeTopFade.swift).
//
//  As content scrolls UP behind the floating native header it (1) FROSTS — a real backdrop
//  blur of the content passing under the header (via the `haze` library, RenderEffect) — and
//  (2) DISSOLVES into the app/aura background colour via a scrim gradient. This matches the
//  Claude app's top-of-scroll look. The blur needs API 31+ (Android 12+); below that haze
//  degrades to no-blur and only the scrim shows.
//
//  Wiring: the scrolling content is the haze SOURCE — `Modifier.haze(hazeState, …)`; this
//  overlay is the haze CHILD that samples + blurs it. Place it as the LAST child of the
//  content Box; it carries no pointer input, so scrolling/taps pass straight through.
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
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.hazeChild

// ── SHARED DESIGN TOKENS — keep IN SYNC with iOS ClaudeTopFadeTheme + web TopScrollFade ──
//   SCRIM_LIGHT #FAF9F6 — the light page base (web --bg-0).
//   SCRIM_DARK  #1C1830 — the TOP of the dark "aura" gradient (indigo). NEVER a near-black
//                         here: a black-ish scrim reads as a shadow band (owner verdict).
private val CLAUDE_FADE_LIGHT_SCRIM = Color(0xFFFAF9F6)
private val CLAUDE_FADE_DARK_SCRIM = Color(0xFF1C1830)

/** Fade depth — the header zone the content frosts + dissolves under. */
val CLAUDE_TOP_FADE_HEIGHT: Dp = 110.dp

/** Backdrop blur radius. Keep moderate — a soft frost, not a heavy smear. */
val CLAUDE_TOP_FADE_BLUR: Dp = 24.dp

/**
 * Claude-style top scroll-edge fade: a frosted backdrop blur of the content scrolling
 * under the header, melted into the page background by a scrim gradient. Pass the same
 * [hazeState] the content area was tagged with via `Modifier.haze(hazeState, …)`.
 */
@Composable
fun BoxScope.ClaudeTopFade(dark: Boolean, hazeState: HazeState, height: Dp = CLAUDE_TOP_FADE_HEIGHT) {
    val scrim = if (dark) CLAUDE_FADE_DARK_SCRIM else CLAUDE_FADE_LIGHT_SCRIM
    // 1) Frosted backdrop blur strip (samples the content behind it).
    Box(
        Modifier
            .align(Alignment.TopCenter)
            .fillMaxWidth()
            .height(height)
            .hazeChild(state = hazeState),
    )
    // 2) Scrim gradient over the frost — dissolves the blurred content into the page
    //    colour (strong at the very top → gone at the bottom, which also softens the
    //    lower edge of the uniform blur strip).
    Box(
        Modifier
            .align(Alignment.TopCenter)
            .fillMaxWidth()
            .height(height)
            .background(
                Brush.verticalGradient(
                    0.0f to scrim.copy(alpha = 0.60f),
                    0.55f to scrim.copy(alpha = 0.22f),
                    1.0f to scrim.copy(alpha = 0.0f),
                ),
            ),
    )
}
