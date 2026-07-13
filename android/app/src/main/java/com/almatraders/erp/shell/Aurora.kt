//
//  Aurora.kt
//  ALMA ERP — the owner's aurora background + frosted glass surfaces, ported 1:1 from
//  the iOS OrdersAurora / ordersGlass() / OrdersGlassCard (OrdersSwiftUI.swift).
//
//  Android has no cheap live backdrop-blur pre-12 (and none inside a plain Compose
//  layer), so the glass recipe is the iOS fallback look: translucent white wash +
//  hairline ring over the aurora gradient — visually the same frosted read the owner
//  approved, without a GPU blur pass.
//

package com.almatraders.erp.shell

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/**
 * The ALMA aurora: deep indigo → violet → magenta wash (dark) / cream with soft coral,
 * violet and pink washes (light). Exact stops from iOS OrdersAurora.
 */
@Composable
fun AuroraBackground(dark: Boolean, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            if (dark) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Color(0xFF131032),   // deep indigo
                        0.32f to Color(0xFF372070),  // violet
                        0.62f to Color(0xFF7A2D7E),  // purple-magenta
                        1.0f to Color(0xFFB44167),   // pink
                    )
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.35f), Color.Transparent),
                        center = Offset(size.width * 0.15f, size.height * 0.18f),
                        radius = size.maxDimension * 0.55f,
                    )
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(Color(0xFFED6B8C).copy(alpha = 0.30f), Color.Transparent),
                        center = Offset(size.width * 0.9f, size.height * 0.85f),
                        radius = size.maxDimension * 0.60f,
                    )
                )
            } else {
                drawRect(AlmaTheme.rootBg(false))
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Color(0xFFE6E1F8),   // pale violet
                        0.45f to Color(0xFFF2F0F8),  // cream
                        1.0f to Color(0xFFFCEAEC),   // pale pink
                    )
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.12f, size.height * 0.15f),
                        radius = size.maxDimension * 0.50f,
                    )
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.coral.copy(alpha = 0.12f), Color.Transparent),
                        center = Offset(size.width * 0.9f, size.height * 0.9f),
                        radius = size.maxDimension * 0.55f,
                    )
                )
            }
        }
        content()
    }
}

/**
 * Frosted glass surface over the aurora — translucent wash + hairline ring
 * (iOS `.ordersGlass(scheme, corner:)` twin; radius in dp).
 */
fun Modifier.almaGlass(dark: Boolean, corner: Int = 16): Modifier {
    val shape: Shape = RoundedCornerShape(corner.dp)
    return this
        .clip(shape)
        .background(
            if (dark) Color.White.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.62f),
        )
        .border(1.dp, if (dark) Color.White.copy(alpha = 0.10f) else Color.White.copy(alpha = 0.45f), shape)
}

/** Click with no ripple but a soft system haptic tick (the iOS `.buttonStyle(.plain)`
 *  + Taptic feel over glass). CONTEXT_CLICK is the light, system-consistent tap tick and
 *  respects the user's system haptic setting, so every native tap gets premium tactile
 *  feedback without a visual ripple. */
@Composable
fun Modifier.plainClick(onClick: () -> Unit): Modifier {
    val view = androidx.compose.ui.platform.LocalView.current
    return clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClick = {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
            onClick()
        },
    )
}

/** Loading skeleton shimmer (iOS Shimmer twin). */
@Composable
fun Modifier.shimmering(): Modifier {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val phase by transition.animateFloat(
        initialValue = -1f,
        targetValue = 1.5f,
        animationSpec = infiniteRepeatable(tween(1150, easing = LinearEasing), RepeatMode.Restart),
        label = "shimmerPhase",
    )
    return drawWithShimmer(phase)
}

private fun Modifier.drawWithShimmer(phase: Float): Modifier = this.background(
    Brush.horizontalGradient(
        colors = listOf(Color.Transparent, Color.White.copy(alpha = 0.25f), Color.Transparent),
        startX = 320f * phase,
        endX = 320f * phase + 320f,
    )
)

/** Circular status dot used by pills/chips. */
fun Modifier.dot(color: Color) = this
    .clip(CircleShape)
    .background(color)
