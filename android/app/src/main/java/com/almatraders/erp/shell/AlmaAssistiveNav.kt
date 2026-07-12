//
//  AlmaAssistiveNav.kt
//  ALMA ERP — Android 1:1 port of iOS AgentAssistiveNav (SpikeNativeShell.swift).
//
//  A draggable, translucent floating button (iOS AssistiveTouch feel) that springs
//  open into a radial fan of shortcut discs over a dimmed backdrop. Used on:
//    • Dashboard tab — role-gated shortcut dock (owner-liked, max 5 + Edit), and
//    • Assistant tab — the agent-section nav (Chat / Studio / WhatsApp / Monitor / Costs).
//
//  Physics mirror the iOS button: flick-momentum snap-to-edge with an under-damped
//  spring overshoot, idle fade after 3s, staggered pop-out of the fan discs. Touches
//  pass through to the content behind it except the FAB (closed) or the backdrop (open).
//

package com.almatraders.erp.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.AttachMoney
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Message
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.AutoAwesome as OutlinedAutoAwesome
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlinx.coroutines.launch

/** One fan item → an icon disc + label that runs [onSelect] when tapped. */
class AssistiveItem(val title: String, val icon: ImageVector, val onSelect: () -> Unit)

private val FAB_VIOLET = Color(0xFF6B5C9E)          // active disc fill (iOS 0.42/0.36/0.62)
private val FAB_BG = Color(0xE31A1725)              // frosted FAB body (dark, ~0.89)
private val DISC_BG = Color(0xCC141021)             // frosted item disc

/**
 * The floating assistive dock. Lay it as the LAST child of a fill-size Box so it floats
 * over the content; its own hit-testing passes touches through except the FAB / backdrop.
 * [activeIndex] highlights the current section (Assistant tab); pass -1 for none.
 */
@Composable
fun AssistiveDock(
    dark: Boolean,
    items: List<AssistiveItem>,
    activeIndex: Int = -1,
) {
    if (items.isEmpty()) return
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()

    val fabSizePx = with(density) { 56.dp.toPx() }
    val edgePx = with(density) { 12.dp.toPx() }
    val discPx = with(density) { 54.dp.toPx() }
    val arcRadiusPx = with(density) { 132.dp.toPx() }
    val topInsetPx = with(density) {
        WindowInsets.statusBars.asPaddingValues().calculateTopPadding().toPx()
    } + edgePx

    var size by remember { mutableStateOf(IntSize.Zero) }
    var placed by remember { mutableStateOf(false) }
    var isOpen by remember { mutableStateOf(false) }
    var active by remember { mutableIntStateOf(activeIndex) }
    var wakeTick by remember { mutableIntStateOf(0) }        // bump to re-arm idle fade

    val cx = remember { Animatable(0f) }
    val cy = remember { Animatable(0f) }
    val fabAlpha = remember { Animatable(1f) }
    val fabScale = remember { Animatable(1f) }
    val iconRot = remember { Animatable(0f) }                // + → × on open

    // Latch the rest position bottom-right once we know the container size.
    LaunchedEffect(size) {
        if (size != IntSize.Zero && !placed) {
            cx.snapTo(size.width - fabSizePx / 2f - edgePx)
            cy.snapTo(size.height - fabSizePx / 2f - edgePx)
            placed = true
        }
    }

    // Idle fade: 3s after the last interaction, dim to 0.42 (unless open).
    LaunchedEffect(wakeTick, isOpen) {
        fabAlpha.animateTo(1f, tween(150))
        if (!isOpen) {
            kotlinx.coroutines.delay(3000)
            fabAlpha.animateTo(0.42f, tween(400))
        }
    }
    LaunchedEffect(isOpen) {
        iconRot.animateTo(if (isOpen) 45f else 0f,
            spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessLow))
    }

    fun wake() { wakeTick++ }

    // Snap the FAB to the nearest edge, biased by flick velocity, with spring overshoot.
    fun snapToEdge(vx: Float, vy: Float) {
        val half = fabSizePx / 2f
        val minY = half + topInsetPx
        val maxY = size.height - half - edgePx
        val projectedY = (cy.value + vy * 0.14f).coerceIn(minY, maxY)
        val goRight = if (vx > 250f) true else if (vx < -250f) false else cx.value > size.width / 2f
        val targetX = if (goRight) size.width - half - edgePx else half + edgePx
        val speed = hypot(vx, vy)
        scope.launch {
            cx.animateTo(targetX, spring(dampingRatio = 0.66f, stiffness = Spring.StiffnessMediumLow,
                visibilityThreshold = 0.5f))
        }
        scope.launch {
            cy.animateTo(projectedY, spring(dampingRatio = 0.66f, stiffness = Spring.StiffnessMediumLow,
                visibilityThreshold = 0.5f))
        }
        scope.launch { fabScale.animateTo(1f, spring(dampingRatio = 0.66f)) }
        val _speed = speed // (silence unused; velocity already folded into projection/bias)
    }

    // Where item i sits on the fan arc — the screen quadrant opening toward centre.
    fun arcCenter(i: Int): Offset {
        val onRight = cx.value > size.width / 2f
        val topHalf = cy.value < size.height / 2f
        val (startDeg, endDeg) = when {
            onRight && !topHalf -> 184f to 274f     // bottom-right → up-left
            !onRight && !topHalf -> 266f to 356f    // bottom-left  → up-right
            onRight && topHalf -> 86f to 176f       // top-right    → down-left
            else -> 4f to 94f                       // top-left     → down-right
        }
        val n = items.size
        val t = if (n <= 1) 0.5f else i.toFloat() / (n - 1)
        val deg = startDeg + t * (endDeg - startDeg)
        val rad = (deg * Math.PI / 180.0)
        var x = cx.value + arcRadiusPx * cos(rad).toFloat()
        var y = cy.value + arcRadiusPx * sin(rad).toFloat()
        val h = discPx / 2f
        x = x.coerceIn(h + edgePx, size.width - h - edgePx)
        y = y.coerceIn(h + topInsetPx, size.height - h - edgePx)
        return Offset(x, y)
    }

    Box(Modifier.fillMaxSize().onSizeChanged { size = it }) {
        if (!placed) return@Box

        // Dimmed backdrop (open only) — tap anywhere to close.
        if (isOpen) {
            Box(
                Modifier
                    .fillMaxSize()
                    .zIndex(1f)
                    .background(Color.Black.copy(alpha = 0.28f))
                    .pointerInput(Unit) { detectTapGestures { isOpen = false; wake() } },
            )
            // Fan discs.
            items.forEachIndexed { i, item ->
                val seat = arcCenter(i)
                val on = i == active
                val labelWpx = with(density) { 84.dp.toPx() }
                Box(
                    Modifier
                        .zIndex(2f)
                        .graphicsLayer {
                            translationX = seat.x - labelWpx / 2f   // centre the 84dp column on the seat
                            translationY = seat.y - discPx / 2f     // disc top = seat.y − r
                        }
                        .width(84.dp),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier
                                .size(54.dp)
                                .background(if (on) FAB_VIOLET else DISC_BG, CircleShape)
                                .border(1.dp, Color.White.copy(alpha = 0.16f), CircleShape)
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                ) {
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    active = i
                                    isOpen = false
                                    item.onSelect()
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(item.icon, item.title,
                                tint = if (on) Color.White else Color.White.copy(alpha = 0.9f),
                                modifier = Modifier.size(22.dp))
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            item.title,
                            color = Color.White,
                            fontSize = 10.5.sp,
                            fontWeight = if (on) FontWeight.Bold else FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        // The FAB itself.
        Box(
            Modifier
                .zIndex(3f)
                .graphicsLayer {
                    translationX = cx.value - fabSizePx / 2f
                    translationY = cy.value - fabSizePx / 2f
                    alpha = fabAlpha.value
                    scaleX = fabScale.value
                    scaleY = fabScale.value
                }
                .size(56.dp)
                .background(FAB_BG, RoundedCornerShape(17.dp))
                .border(1.dp, Color.White.copy(alpha = 0.22f), RoundedCornerShape(17.dp))
                .pointerInput(items.size) {
                    detectTapGestures {
                        wake(); isOpen = !isOpen
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                }
                .pointerInput(items.size, size) {
                    detectDragGestures(
                        onDragStart = {
                            wake()
                            if (isOpen) isOpen = false
                            scope.launch { fabScale.animateTo(0.94f, tween(120)) }
                        },
                        onDragEnd = { snapToEdge(0f, 0f) },
                        onDragCancel = { snapToEdge(0f, 0f) },
                    ) { change, drag ->
                        change.consume()
                        wake()
                        val half = fabSizePx / 2f
                        scope.launch {
                            cx.snapTo((cx.value + drag.x).coerceIn(half + edgePx, size.width - half - edgePx))
                            cy.snapTo((cy.value + drag.y).coerceIn(half + topInsetPx, size.height - half - edgePx))
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.AutoAwesome, "Shortcuts",
                tint = Color.White,
                modifier = Modifier.size(24.dp).graphicsLayer { rotationZ = iconRot.value },
            )
        }
    }
}

// ── Dashboard shortcut dock (role-gated catalog, max 5 + Edit) ──────────────────────

/** One dock shortcut → an ERP route opened via the shell. */
data class DashShortcut(val path: String, val title: String, val icon: ImageVector)

object DashShortcutCatalog {
    val all = listOf(
        DashShortcut("/orders", "অর্ডার", Icons.Outlined.ShoppingCart),
        DashShortcut("/invoice", "ইনভয়েস", Icons.Outlined.Receipt),
        DashShortcut("/payroll", "পেরোল", Icons.Outlined.Payments),
        DashShortcut("/analytics", "অ্যানালিটিক্স", Icons.Outlined.BarChart),
        DashShortcut("/inventory", "ইনভেন্টরি", Icons.Outlined.Inventory2),
        DashShortcut("/expenses", "খরচ", Icons.Outlined.CreditCard),
        DashShortcut("/finance", "ফাইন্যান্স", Icons.Outlined.AttachMoney),
        DashShortcut("/attendance", "হাজিরা", Icons.Outlined.Schedule),
        DashShortcut("/employees", "কর্মী", Icons.Outlined.People),
        DashShortcut("/crm", "সিআরএম", Icons.Outlined.Person),
        DashShortcut("/briefing", "ব্রিফিং", Icons.Outlined.Newspaper),
        DashShortcut("/portal", "আমার ডেস্ক", Icons.Outlined.Person),
    )
    private val staffPaths = setOf("/orders", "/invoice", "/attendance", "/portal")
    val defaultPaths = listOf("/orders", "/invoice", "/payroll", "/analytics")

    fun available(owner: Boolean): List<DashShortcut> =
        if (owner) all else all.filter { staffPaths.contains(it.path) }
}

object DashShortcutStore {
    private const val PREFS = "alma-native-shell"
    private const val KEY = "alma.dashboard.assistive.shortcuts.v1"

    fun load(ctx: android.content.Context): List<String> {
        val raw = ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .getString(KEY, null) ?: return DashShortcutCatalog.defaultPaths
        return raw.split("|").filter { it.isNotBlank() }.ifEmpty { DashShortcutCatalog.defaultPaths }
    }

    fun save(ctx: android.content.Context, paths: List<String>) {
        ctx.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .edit().putString(KEY, paths.take(5).joinToString("|")).apply()
    }
}

// ── Tab wrappers ────────────────────────────────────────────────────────────────────

/**
 * Dashboard floating dock — role-gated shortcuts (owner=full catalog, staff=subset),
 * persisted selection (max 5) + an Edit item that opens the picker. Overlay this as the
 * last child of the Dashboard tab area.
 */
@Composable
fun DashboardAssistiveDock(dark: Boolean, openSmart: (String, String) -> Unit) {
    val ctx = LocalContext.current
    RememberSession()
    val owner = AlmaSession.isOwner
    var chosen by remember(owner) { mutableStateOf(DashShortcutStore.load(ctx)) }
    var editing by remember { mutableStateOf(false) }

    val available = remember(owner) { DashShortcutCatalog.available(owner) }
    val byPath = remember(available) { available.associateBy { it.path } }

    val items = remember(chosen, owner) {
        val list = chosen.mapNotNull { byPath[it] }.take(5).map { sc ->
            AssistiveItem(sc.title, sc.icon) { openSmart(sc.path, sc.title) }
        }.toMutableList()
        list.add(AssistiveItem("এডিট", Icons.Outlined.Tune) { editing = true })
        list
    }

    AssistiveDock(dark = dark, items = items, activeIndex = -1)

    if (editing) {
        ShortcutEditorSheet(
            dark = dark,
            available = available,
            initial = chosen,
            onSave = { picked ->
                DashShortcutStore.save(ctx, picked)
                chosen = picked
                editing = false
            },
            onCancel = { editing = false },
        )
    }
}

/** Assistant tab floating dock — the agent-section nav (Chat / Studio / WhatsApp / …). */
@Composable
fun AgentAssistiveDock(dark: Boolean, activeIndex: Int, onOpen: (String) -> Unit) {
    val items = remember {
        listOf(
            AssistiveItem("Chat", Icons.Outlined.Chat) { onOpen("/agent") },
            AssistiveItem("Studio", Icons.Filled.AutoAwesome) { onOpen("/agent/creative-studio") },
            AssistiveItem("WhatsApp", Icons.Outlined.Message) { onOpen("/agent/whatsapp") },
            AssistiveItem("Monitor", Icons.Outlined.BarChart) { onOpen("/agent/staff-monitor") },
            AssistiveItem("Costs", Icons.Outlined.AttachMoney) { onOpen("/agent/costs") },
        )
    }
    AssistiveDock(dark = dark, items = items, activeIndex = activeIndex)
}

/** Full-screen shortcut picker (up to 5 from the role catalog). iOS ShortcutEditorView twin. */
@Composable
private fun ShortcutEditorSheet(
    dark: Boolean,
    available: List<DashShortcut>,
    initial: List<String>,
    onSave: (List<String>) -> Unit,
    onCancel: () -> Unit,
) {
    val valid = remember(available) { available.map { it.path }.toSet() }
    var picked by remember { mutableStateOf(initial.filter { valid.contains(it) }) }

    Box(
        Modifier
            .fillMaxSize()
            .zIndex(20f)
            .background(AlmaTheme.rootBg(dark))
            .pointerInput(Unit) { detectTapGestures { } }, // eat taps behind the sheet
    ) {
        AuroraBackground(dark) {
            Column(Modifier.fillMaxSize()) {
                // Header row: cancel · title · save
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 0.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {}
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("বাতিল", color = AlmaTheme.violet, fontSize = 16.sp,
                        modifier = Modifier.clickable { onCancel() })
                    Text("ডক এডিট", color = AlmaTheme.ink(dark), fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold)
                    Text("সেভ", color = AlmaTheme.violet, fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.clickable { onSave(picked.take(5)) })
                }
                Text(
                    "সর্বোচ্চ ৫টি · এখন ${picked.size}টি বেছে নেওয়া হয়েছে",
                    color = AlmaTheme.inkSecondary(dark),
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    items(available, key = { it.path }) { sc ->
                        val on = picked.contains(sc.path)
                        val disabled = !on && picked.size >= 5
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .background(
                                    if (on) AlmaTheme.violet.copy(alpha = 0.14f) else Color.Transparent,
                                    RoundedCornerShape(12.dp),
                                )
                                .clickable(enabled = !disabled) {
                                    picked = if (on) picked - sc.path else picked + sc.path
                                }
                                .alpha(if (disabled) 0.4f else 1f)
                                .padding(horizontal = 14.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(sc.icon, sc.title, tint = AlmaTheme.coral,
                                modifier = Modifier.size(24.dp))
                            Spacer(Modifier.width(14.dp))
                            Text(sc.title, color = AlmaTheme.ink(dark), fontSize = 15.sp,
                                modifier = Modifier.weight(1f))
                            if (on) Icon(Icons.Filled.Check, "selected", tint = AlmaTheme.coral,
                                modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
        }
    }
}
