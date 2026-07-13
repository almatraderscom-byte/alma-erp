//
//  DigitalHomeScreen.kt
//  ALMA ERP — the CDIT Agency Dashboard, ported 1:1 from DigitalHomeSwiftUI.swift
//  (web /digital parity). Read-only board:
//    GET /api/digital/dashboard?business_id=CREATIVE_DIGITAL_IT → CditDashboardData
//  ({ok,data} wrap tolerated; every number flex-decoded — sheet-backfilled rows mix
//  ints/strings). Blocks: hero (Total receivable warn + Collected-this-month pos +
//  Recurring revenue gold) · 6 KPI tiles · Project Status donut · Services Mix donut
//  (web StatusPieChart STATUS_COLORS + coral/goldDim/goldLt fallback cycle) ·
//  quick-nav chips (openSmart → native targets when migrated) · web escape.
//  Mutations (clients/projects/invoices CRUD) stay on the web escape hatch.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import org.json.JSONObject

private const val CDIT_BIZ = "CREATIVE_DIGITAL_IT"

// ── Web palette (exact hexes from globals.css / charts tokens) ───────────────────────

private object DigitalHomePalette {
    /** CDIT business accent — the blue Creative Digital IT wears in the switcher. */
    val cditBlue = Color(0xFF6B8FE0)   // rgb(0.42, 0.56, 0.88)
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue500 = Color(0xFF3B82F6)
    val blue400 = Color(0xFF60A5FA)
    val slate400 = Color(0xFF94A3B8)

    /** Web txt-accent: gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    /** Web txt-pos. */
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600
    /** Web txt-warn. */
    fun warning(dark: Boolean): Color = if (dark) amber500 else amber600
    /** Web txt-info. */
    fun info(dark: Boolean): Color = if (dark) blue400 else blue500

    /** Web StatusPieChart STATUS_COLORS map — named order statuses first… */
    private val statusColors: Map<String, Color>
        get() = mapOf(
            "Pending" to Color(0xFFF59E0B),
            "Confirmed" to Color(0xFF3B82F6),
            "Packed" to Color(0xFF8B5CF6),
            "Shipped" to Color(0xFF0EA5E9),
            "Delivered" to Color(0xFF22C55E),
            "Returned" to Color(0xFFEF4444),
            "Cancelled" to Color(0xFF94A3B8),
        )

    /** …then the web fallback cycle ['#E07A5F', '#C45A3C', '#F4A28C'][i % 3]
     *  (what CDIT project statuses like Lead/Active/Completed hit). */
    private val fallbackCycle: List<Color>
        get() = listOf(AlmaTheme.coral, goldDim, goldLt)

    fun slice(name: String, index: Int): Color =
        statusColors[name] ?: fallbackCycle[index % fallbackCycle.size]
}

// ── Models (web CditDashboardData — snake_case wire, decoded defensively) ─────────────

private data class DigitalHomeKpis(
    val totalClients: Int = 0,
    val activeProjects: Int = 0,
    val mrr: Int = 0,
    val recurringRevenue: Int = 0,
    val totalRevenue: Int = 0,
    val netProfit: Int = 0,
    val totalReceivable: Int = 0,
    val collectedThisMonth: Int = 0,
    val unpaidInvoices: Int = 0,
    val partiallyPaidProjects: Int = 0,
)

/** One donut slice — Object.entries(by_status / by_service) on the web. */
private data class DigitalHomeSlice(val name: String, val value: Int)

// ── State holder (iOS DigitalHomeVM twin) ────────────────────────────────────────────

private class DigitalHomeState {
    var kpis by mutableStateOf(DigitalHomeKpis())
    var byStatus by mutableStateOf(listOf<DigitalHomeSlice>())
    var byService by mutableStateOf(listOf<DigitalHomeSlice>())
    var hasData by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    /** Flat CditDashboardData — tolerate an apiDataSuccess `{ ok, data:{…} }` wrap too. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/digital/dashboard",
                    mapOf("business_id" to CDIT_BIZ),
                )
            )
            val k = c.optJSONObject("kpis") ?: JSONObject()
            kpis = DigitalHomeKpis(
                totalClients = k.flexInt("total_clients") ?: 0,
                activeProjects = k.flexInt("active_projects") ?: 0,
                mrr = k.flexInt("mrr") ?: 0,
                recurringRevenue = k.flexInt("recurring_revenue") ?: 0,
                totalRevenue = k.flexInt("total_revenue") ?: 0,
                netProfit = k.flexInt("net_profit") ?: 0,
                totalReceivable = k.flexInt("total_receivable") ?: 0,
                collectedThisMonth = k.flexInt("collected_this_month") ?: 0,
                unpaidInvoices = k.flexInt("unpaid_invoices") ?: 0,
                partiallyPaidProjects = k.flexInt("partially_paid_projects") ?: 0,
            )
            byStatus = slices(c, "by_status")
            byService = slices(c, "by_service")
            hasData = true
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Record<string, number> → slices, biggest first then name (stable across refresh). */
    private fun slices(c: JSONObject, key: String): List<DigitalHomeSlice> {
        val obj = c.optJSONObject(key) ?: return emptyList()
        val out = ArrayList<DigitalHomeSlice>()
        val it = obj.keys()
        while (it.hasNext()) {
            val name = it.next()
            val v = obj.flexInt(name) ?: 0
            if (v > 0) out.add(DigitalHomeSlice(name, v))
        }
        return out.sortedWith(compareByDescending<DigitalHomeSlice> { it.value }.thenBy { it.name })
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@Composable
fun DigitalHomeScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { DigitalHomeState() }

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(6.dp)) }

        if (vm.authExpired) {
            item { HomeAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { HomeNoticeCard("⚠ $it", DigitalHomePalette.red500, dark) } }

        if (vm.loading && !vm.hasData) {
            item { HomeLoadingBoard(dark) }
        } else if (vm.hasData) {
            val k = vm.kpis
            item {
                HomeHeroCard(
                    receivable = k.totalReceivable,
                    collected = k.collectedThisMonth,
                    recurring = if (k.recurringRevenue == 0) k.mrr else k.recurringRevenue,
                )
            }
            item { HomeKpiGrid(k, dark) }
            item {
                HomeDonutCard(
                    title = "Project Status", slices = vm.byStatus, dark = dark,
                    emptyTitle = "No projects yet",
                    emptyDesc = "Create a project to see status breakdown",
                )
            }
            item {
                HomeDonutCard(
                    title = "Services Mix", slices = vm.byService, dark = dark,
                    emptyTitle = "No service data",
                    emptyDesc = "Projects will populate this chart",
                )
            }
            item { HomeQuickNav(dark, openWeb = { p, t -> ctx.openWebForced(p, t) }) }
        }

        item {
            // Mutations (clients/projects/invoices CRUD) stay on the web escape hatch.
            Text(
                "🌐 সব অপশন — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/digital", "CDIT") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

// ── Hero anchor (dark in BOTH schemes — Dashboard hero recipe, CDIT-blue wash) ────────

@Composable
private fun HomeHeroCard(receivable: Int, collected: Int, recurring: Int) {
    Column(Modifier.fillMaxWidth().homeHeroBg().padding(16.dp)) {
        Text(
            "মোট বকেয়া · CDIT AGENCY",
            color = DigitalHomePalette.amber500, fontSize = 10.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        HomeCountUp(receivable, 40.sp, Color.White, format = { AlmaTheme.takaShort(it) })
        Spacer(Modifier.height(5.dp))
        Text("ক্লায়েন্টদের কাছে পাওনা টাকা", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp)

        Spacer(Modifier.height(14.dp))
        Row {
            HomeHeroStat("Collected (month)", collected, DigitalHomePalette.green400, "এই মাসে আদায়")
            Box(
                Modifier.width(1.dp).height(48.dp).padding(vertical = 2.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            Spacer(Modifier.width(14.dp))
            HomeHeroStat("Recurring revenue", recurring, DigitalHomePalette.goldLt, "মাসিক রিকারিং")
        }
    }
}

@Composable
private fun HomeHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(Modifier.padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        HomeCountUp(value, 20.sp, tint, format = { AlmaTheme.takaShort(it) })
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** The dark hero backdrop — deep indigo base + CDIT-blue/violet washes. */
private fun Modifier.homeHeroBg(): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(Color(0xFF141828))   // rgb(0.078, 0.094, 0.157)
        .background(
            Brush.linearGradient(
                0f to DigitalHomePalette.cditBlue.copy(alpha = 0.38f),
                0.5f to Color.Transparent,
            )
        )
        .background(
            Brush.linearGradient(
                0.5f to Color.Transparent,
                1f to AlmaTheme.violet.copy(alpha = 0.26f),
            )
        )
        .background(
            Brush.radialGradient(
                listOf(DigitalHomePalette.goldLt.copy(alpha = 0.12f), Color.Transparent),
                center = Offset(760f, 40f),
                radius = 440f,
            )
        )
        .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
}

// ── KPI tiles (web KpiCard rows minus the three the hero carries) ─────────────────────

@Composable
private fun HomeKpiGrid(k: DigitalHomeKpis, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HomeStatTile(
                "Unpaid invoices", k.unpaidInvoices, "বাকি ইনভয়েস",
                tint = AlmaTheme.ink(dark), accent = DigitalHomePalette.cditBlue,
                dark = dark, format = { "$it" }, modifier = Modifier.weight(1f),
            )
            HomeStatTile(
                "Partial projects", k.partiallyPaidProjects, "আংশিক পেমেন্ট",
                tint = DigitalHomePalette.warning(dark), accent = DigitalHomePalette.amber500,
                dark = dark, format = { "$it" }, modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HomeStatTile(
                "Clients", k.totalClients, "মোট ক্লায়েন্ট",
                tint = AlmaTheme.ink(dark), accent = DigitalHomePalette.cditBlue,
                dark = dark, format = { "$it" }, modifier = Modifier.weight(1f),
            )
            HomeStatTile(
                "Active Projects", k.activeProjects, "চলমান প্রজেক্ট",
                tint = DigitalHomePalette.info(dark), accent = DigitalHomePalette.blue500,
                dark = dark, format = { "$it" }, modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HomeStatTile(
                "Revenue", k.totalRevenue, "মোট আয়",
                tint = AlmaTheme.ink(dark), accent = DigitalHomePalette.cditBlue,
                dark = dark, format = { AlmaTheme.takaShort(it) }, modifier = Modifier.weight(1f),
            )
            HomeStatTile(
                "Net Profit", k.netProfit, "নিট লাভ",
                tint = if (k.netProfit < 0) DigitalHomePalette.red500 else DigitalHomePalette.positive(dark),
                accent = DigitalHomePalette.green400,
                dark = dark, format = { AlmaTheme.takaShort(it) }, modifier = Modifier.weight(1f),
            )
        }
    }
}

/** Small glass stat tile — count-up value + sub line over a soft accent wash. */
@Composable
private fun HomeStatTile(
    label: String,
    value: Int,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    format: (Int) -> String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .homeBentoWash(accent, dark)
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        HomeCountUp(value, 17.sp, tint, format = format)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

/** Count-up number (0 → target on appear) — iOS Animatable count-up twin. */
@Composable
private fun HomeCountUp(target: Int, fontSize: TextUnit, color: Color, format: (Int) -> String) {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "homeCountUp",
    )
    Text(format(shown), color = color, fontSize = fontSize, fontWeight = FontWeight.ExtraBold, maxLines = 1)
}

/** Frosted glass + soft diagonal accent wash (iOS bento wash twin). */
private fun Modifier.homeBentoWash(accent: Color, dark: Boolean): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(if (dark) Color.White.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.62f))
        .background(
            Brush.linearGradient(
                0f to accent.copy(alpha = if (dark) 0.14f else 0.10f),
                1f to Color.Transparent,
            )
        )
        .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.45f), shape)
}

// ── Donut cards (web Card + StatusPieChart / Empty) ──────────────────────────────────

@Composable
private fun HomeDonutCard(
    title: String,
    slices: List<DigitalHomeSlice>,
    dark: Boolean,
    emptyTitle: String,
    emptyDesc: String,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            title.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            fontWeight = FontWeight.Black, letterSpacing = 0.5.sp,
        )
        if (slices.isEmpty()) {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 26.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("◫", color = AlmaTheme.inkSecondary(dark), fontSize = 26.sp)
                Text(emptyTitle, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(emptyDesc, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center)
            }
        } else {
            val coloured = slices.mapIndexed { i, s ->
                Triple(s.name, s.value, DigitalHomePalette.slice(s.name, i))
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                HomeDonut(coloured, size = 108.dp, lineWidth = 15.dp, dark = dark)
                HomeDonutLegend(coloured, dark, Modifier.weight(1f))
            }
        }
    }
}

/** Swatch legend beside the donut (dashboard's two-column legend language). */
@Composable
private fun HomeDonutLegend(items: List<Triple<String, Int, Color>>, dark: Boolean, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        items.forEach { (name, value, color) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(Modifier.size(9.dp).clip(RoundedCornerShape(2.5.dp)).background(color))
                Text(
                    name, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text("$value", color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** Web StatusPieChart parity — trimmed ring sweeping in clockwise from 12 o'clock. */
@Composable
private fun HomeDonut(slices: List<Triple<String, Int, Color>>, size: Dp, lineWidth: Dp, dark: Boolean) {
    val total = slices.sumOf { it.second }.coerceAtLeast(1)
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val sweep by animateFloatAsState(
        targetValue = if (started) 1f else 0f,
        animationSpec = tween(800),
        label = "donutSweep",
    )
    val stroke = with(androidx.compose.ui.platform.LocalDensity.current) { lineWidth.toPx() }
    Box(
        Modifier.size(size + lineWidth),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize().padding(lineWidth / 2)) {
            var acc = 0f
            slices.forEach { (_, value, color) ->
                val frac = value.toFloat() / total.toFloat()
                drawArc(
                    color = color,
                    startAngle = -90f + acc * 360f * sweep,
                    sweepAngle = frac * 360f * sweep,
                    useCenter = false,
                    topLeft = Offset(stroke / 2f, stroke / 2f),
                    size = Size(this.size.width - stroke, this.size.height - stroke),
                    style = Stroke(width = stroke),
                )
                acc += frac
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$total", color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text("total", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

// ── Quick nav — CDIT sub-pages as native chips (openWeb → native when migrated) ───────

@Composable
private fun HomeQuickNav(dark: Boolean, openWeb: (String, String) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HomeQuickChip("Clients", "/digital/clients", "CDIT clients", dark, openWeb)
        HomeQuickChip("Projects", "/digital/projects", "CDIT projects", dark, openWeb)
        HomeQuickChip("Invoices", "/digital/invoices", "CDIT invoices", dark, openWeb)
        HomeQuickChip("Finance", "/digital/finance", "Finance", dark, openWeb)
    }
}

@Composable
private fun HomeQuickChip(title: String, path: String, navTitle: String, dark: Boolean, openWeb: (String, String) -> Unit) {
    Text(
        title,
        color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick { openWeb(path, navTitle) }
            .padding(horizontal = 14.dp, vertical = 9.dp),
    )
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun HomeLoadingBoard(dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.fillMaxWidth().height(150.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
        repeat(3) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(2) {
                    Box(Modifier.weight(1f).height(74.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
                }
            }
        }
        repeat(2) {
            Box(Modifier.fillMaxWidth().height(150.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
        }
    }
}

@Composable
private fun HomeNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun HomeAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(AlmaTheme.coral, RoundedCornerShape(50))
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}
