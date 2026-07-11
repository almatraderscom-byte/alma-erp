//
//  Loader.kt
//  ALMA ERP — branded first-paint veil (twin of the iOS AlmaPremiumLoader:
//  breathing violet orb + morphing dots on the theme backdrop, no stock spinner).
//

package com.almatraders.erp.shell

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun AlmaLoadingVeil() {
    val dark = AlmaTheme.isDark
    val transition = rememberInfiniteTransition(label = "loader")
    val breathe by transition.animateFloat(
        initialValue = 0.85f,
        targetValue = 1.12f,
        animationSpec = infiniteRepeatable(
            tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse,
        ),
        label = "breathe",
    )
    Box(
        Modifier
            .fillMaxSize()
            .background(AlmaTheme.rootBg(dark)),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(52.dp)
                    .scale(breathe)
                    .clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            listOf(
                                AlmaTheme.violet.copy(alpha = 0.95f),
                                AlmaTheme.violet.copy(alpha = 0.35f),
                                Color.Transparent,
                            ),
                        ),
                    ),
            )
            Row(
                Modifier.padding(top = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                repeat(3) { i ->
                    val dotScale by transition.animateFloat(
                        initialValue = 0.55f,
                        targetValue = 1f,
                        animationSpec = infiniteRepeatable(
                            tween(650, delayMillis = i * 160, easing = FastOutSlowInEasing),
                            RepeatMode.Reverse,
                        ),
                        label = "dot$i",
                    )
                    Box(
                        Modifier
                            .size(7.dp)
                            .scale(dotScale)
                            .clip(CircleShape)
                            .background(AlmaTheme.violet.copy(alpha = 0.8f)),
                    )
                }
            }
        }
    }
}
