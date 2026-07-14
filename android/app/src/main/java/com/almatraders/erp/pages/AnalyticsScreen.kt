//
//  AnalyticsScreen.kt
//  ALMA ERP — the Analytics page, ported 1:1 from AnalyticsSwiftUI.swift (build 66).
//
//  Mirrors the web /analytics page — same endpoints, same numbers, same blocks:
//    GET /api/analytics?business_id=…&startDate=…&endDate=…  → DashboardData
//        (kpis · by_status · by_source · by_payment · by_category ·
//         monthly_trend · expense_by_cat · total_expenses)   [flat or {ok,data} wrapped]
//    GET /api/orders/orders?business_id=…&startDate=…&endDate=…&limit=500
//        → raw rows feeding the two client-computed return charts (best-effort:
//          failure hides those cards silently, web parity).
//  Blocks: date-preset chips · bento KPI board (dark revenue hero + glass tiles) ·
//  return KPI strip · Returns-by-Type donut · Return Loss Trend bars · Revenue vs
//  Profit trend (tap a month → detail sheet) · Orders by Status · Orders by Channel ·
//  Payment Method Mix · Expense Breakdown · Category Performance. READ-ONLY.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens, iOS twin) ──────────

private object AnPalette {
    val coral = AlmaTheme.coral                    // web --c-accent #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    // Web buildReturnsByTypePie slice colours (order-analytics.ts).
    val pieDelivered = Color(0xFF2ECC71)
    val pieReturnPaid = Color(0xFFF5A623)
    val pieReturnRefused = Color(0xFFE74C3C)

    // Web category PALETTE ['#E07A5F','#C45A3C','#F4A28C','#D4956A','#8B5E3C','#A0644A'].
    val series = listOf(
        Color(0xFFE07A5F), Color(0xFFC45A3C), Color(0xFFF4A28C),
        Color(0xFFD4956A), Color(0xFF8B5E3C), Color(0xFFA0644A),
    )

    /** Web paymentPie COLORS — bKash pink, Nagad orange, etc. */
    fun payment(name: String): Color = when (name) {
        "COD" -> Color(0xFFF5A623)
        "bKash" -> Color(0xFFE8357A)
        "Nagad" -> Color(0xFFF46223)
        "Rocket" -> Color(0xFF8B5CF6)
        "Bank Transfer" -> Color(0xFF4A9EFF)
        "Card" -> Color(0xFF2ECC71)
        else -> Color(0xFF9CA3AF)
    }

    /** Order status tones (web badge colours family). */
    fun status(s: String): Color = when (s.uppercase()) {
        "DELIVERED", "PAID", "COMPLETED" -> emerald600
        "RETURNED", "CANCELLED", "FAILED", "FAILED_DELIVERY" -> red500
        "PENDING", "PROCESSING", "IN_TRANSIT", "SHIPPED" -> amber500
        else -> coral
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600
    fun signed(amount: Int, dark: Boolean): Color = if (amount < 0) red500 else positive(dark)
}

// ── Models (same field names the web DashboardData type declares) ───────────────────

private data class AnKpis(
    val totalOrders: Int,
    val totalRevenue: Int,
    val totalProfit: Int,
    val totalCogs: Int,
    val grossMargin: Double,
    val avgOrderValue: Int,
    val deliveredCount: Int,
    val deliveryRate: Double,
    val returnRate: Double,
    val netBusinessProfit: Int?,
    val totalReturnsLoss: Int?,
    val returnedUnpaidCount: Int?,
    val returnRatePaid: Double?,
    val returnRateRefused: Double?,
) {
    companion object {
        fun from(o: JSONObject) = AnKpis(
            totalOrders = o.flexInt("total_orders") ?: 0,
            totalRevenue = o.flexInt("total_revenue") ?: 0,
            totalProfit = o.flexInt("total_profit") ?: 0,
            totalCogs = o.flexInt("total_cogs") ?: 0,
            grossMargin = o.flexDouble("gross_margin") ?: 0.0,
            avgOrderValue = o.flexInt("avg_order_value") ?: 0,
            deliveredCount = o.flexInt("delivered_count") ?: 0,
            deliveryRate = o.flexDouble("delivery_rate") ?: 0.0,
            returnRate = o.flexDouble("return_rate") ?: 0.0,
            netBusinessProfit = o.flexInt("net_business_profit"),
            totalReturnsLoss = o.flexInt("total_returns_loss"),
            returnedUnpaidCount = o.flexInt("returned_unpaid_count"),
            returnRatePaid = o.flexDouble("return_rate_paid"),
            returnRateRefused = o.flexDouble("return_rate_refused"),
        )
    }
}

/** by_source values: { orders, revenue }. */
private data class AnSourceStat(val orders: Int, val revenue: Int)

/** by_category values: { orders, revenue, profit } (margin added client-side, web parity). */
private data class AnCategoryStat(val orders: Int, val revenue: Int, val profit: Int)

/** monthly_trend points: { month, revenue, profit, orders, cogs }. */
private data class AnTrendPoint(
    val month: String,   // "2026-03"
    val revenue: Int,
    val profit: Int,
    val orders: Int,
    val cogs: Int,
)

/** Minimal order row for the return math (the fields the iOS AlmaOrder decodes for it). */
private data class AnOrder(
    val status: String,
    val date: String?,
    val shippingFee: Int?,
    val courierCharge: Int?,
    val returnNetProfit: Int?,
) {
    companion object {
        fun from(o: JSONObject) = AnOrder(
            status = o.str("status") ?: "Pending",
            date = o.str("date"),
            shippingFee = o.flexInt("shipping_fee"),
            courierCharge = o.flexInt("courier_charge"),
            returnNetProfit = o.flexInt("return_net_profit"),
        )
    }
}

/** One day of the web buildReturnLossTrend output ({date, return_loss, returns}). */
private data class AnLossDay(val date: String, val loss: Int, val returns: Int)

// ── Return math (faithful port of src/lib/order-analytics.ts builders) ──────────────

private object AnReturnMath {
    /** Web normalizeOrderStatusKey: trim · uppercase · whitespace→underscore,
     *  legacy FAILED_DELIVERY folds into RETURNED_UNPAID. */
    fun statusKey(status: String): String {
        val key = status.trim().uppercase().replace(Regex("\\s+"), "_")
        return if (key == "FAILED_DELIVERY") "RETURNED_UNPAID" else key
    }

    fun isTerminalReturn(key: String): Boolean =
        key == "RETURNED" || key == "RETURNED_PAID" || key == "RETURNED_UNPAID"

    /** Web calculateOrderAccounting fallback when the row carries no return_net_profit:
     *  paid return → shippingFee − 2×courier; refused/legacy → −2×courier. */
    fun fallbackReturnNet(key: String, o: AnOrder): Int {
        val shipping = maxOf(o.shippingFee ?: 0, 0)
        val courier = maxOf(o.courierCharge ?: 0, 0)
        return if (key == "RETURNED_PAID") shipping - 2 * courier else -2 * courier
    }
}

// ── Date presets (web DateRangeFilter parity — default last30) ──────────────────────

private enum class AnPreset(val label: String) {
    TODAY("Today"), YESTERDAY("Yesterday"), LAST7("Last 7 days"),
    LAST30("Last 30 days"), THIS_MONTH("This month"), LAST_MONTH("Last month");

    /** Inclusive yyyy-MM-dd range in Asia/Dhaka — mirrors the web getDatePresetRange. */
    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = tz }
        val cal = Calendar.getInstance(tz)
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val today = cal.time
        fun d(x: Date) = fmt.format(x)
        fun shift(days: Int): Date {
            val c = cal.clone() as Calendar; c.add(Calendar.DAY_OF_YEAR, days); return c.time
        }
        return when (this) {
            TODAY -> d(today) to d(today)
            YESTERDAY -> d(shift(-1)) to d(shift(-1))
            LAST7 -> d(shift(-6)) to d(today)
            LAST30 -> d(shift(-29)) to d(today)
            THIS_MONTH -> {
                val c = cal.clone() as Calendar; c.set(Calendar.DAY_OF_MONTH, 1)
                d(c.time) to d(today)
            }
            LAST_MONTH -> {
                val first = cal.clone() as Calendar; first.set(Calendar.DAY_OF_MONTH, 1)
                val firstLast = first.clone() as Calendar; firstLast.add(Calendar.MONTH, -1)
                val endLast = first.clone() as Calendar; endLast.add(Calendar.DAY_OF_YEAR, -1)
                d(firstLast.time) to d(endLast.time)
            }
        }
    }
}

// ── State holder (iOS AnalyticsVM twin) ─────────────────────────────────────────────

private class AnalyticsState {
    var kpis by mutableStateOf<AnKpis?>(null)
    var byStatus by mutableStateOf(mapOf<String, Int>())
    var bySource by mutableStateOf(mapOf<String, AnSourceStat>())
    var byPayment by mutableStateOf(mapOf<String, Int>())
    var byCategory by mutableStateOf(mapOf<String, AnCategoryStat>())
    var monthlyTrend by mutableStateOf(listOf<AnTrendPoint>())
    var expenseByCat by mutableStateOf(mapOf<String, Int>())
    var totalExpenses by mutableStateOf<Int?>(null)

    /** Raw rows for the two client-computed return charts. null = fetch failed →
     *  those cards hide silently (web parity: page renders fine without them). */
    var orders by mutableStateOf<List<AnOrder>?>(null)

    var preset by mutableStateOf(AnPreset.LAST30)   // web default (DateRangeContext 'last30')
    var loading by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    companion object {
        /** The same business the other native tabs scope to. */
        const val BUSINESS_ID = "ALMA_LIFESTYLE"
    }

    /** Flat payload on the web, but tolerate an {ok,data:{…}} wrapper too (iOS parity). */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    private fun JSONObject.intMap(): Map<String, Int> {
        val out = mutableMapOf<String, Int>()
        keys().forEach { k -> flexInt(k)?.let { out[k] = it } }
        return out
    }

    suspend fun load() {
        loading = true
        error = null
        val (start, end) = preset.range()
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/analytics",
                    mapOf("business_id" to BUSINESS_ID, "startDate" to start, "endDate" to end),
                ),
            )
            kpis = c.optJSONObject("kpis")?.let { AnKpis.from(it) }
            byStatus = c.optJSONObject("by_status")?.intMap() ?: emptyMap()
            bySource = c.optJSONObject("by_source")?.let { src ->
                val out = mutableMapOf<String, AnSourceStat>()
                src.keys().forEach { k ->
                    src.optJSONObject(k)?.let {
                        out[k] = AnSourceStat(it.flexInt("orders") ?: 0, it.flexInt("revenue") ?: 0)
                    }
                }
                out
            } ?: emptyMap()
            byPayment = c.optJSONObject("by_payment")?.intMap() ?: emptyMap()
            byCategory = c.optJSONObject("by_category")?.let { cat ->
                val out = mutableMapOf<String, AnCategoryStat>()
                cat.keys().forEach { k ->
                    cat.optJSONObject(k)?.let {
                        out[k] = AnCategoryStat(
                            it.flexInt("orders") ?: 0, it.flexInt("revenue") ?: 0, it.flexInt("profit") ?: 0,
                        )
                    }
                }
                out
            } ?: emptyMap()
            monthlyTrend = c.optJSONArray("monthly_trend")?.mapObjects {
                AnTrendPoint(
                    month = it.str("month") ?: "",
                    revenue = it.flexInt("revenue") ?: 0,
                    profit = it.flexInt("profit") ?: 0,
                    orders = it.flexInt("orders") ?: 0,
                    cogs = it.flexInt("cogs") ?: 0,
                )
            } ?: emptyList()
            expenseByCat = c.optJSONObject("expense_by_cat")?.intMap() ?: emptyMap()
            totalExpenses = c.flexInt("total_expenses")
            loaded = true
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
        if (authExpired) return
        loadOrders(start, end)
    }

    /** Second fetch: raw rows (exact call the native Orders tab makes — no status filter,
     *  whole window, limit 500). Best-effort: any failure nils the rows. */
    private suspend fun loadOrders(start: String, end: String) {
        orders = try {
            val root = AlmaApi.getObject(
                "/api/orders/orders",
                mapOf(
                    "business_id" to BUSINESS_ID,
                    "startDate" to start, "endDate" to end, "limit" to "500",
                ),
            )
            val c = root.optJSONObject("data") ?: root
            c.optJSONArray("orders")?.mapObjects { AnOrder.from(it) }
        } catch (e: Exception) {
            null   // silent — cards hide, no error banner
        }
    }

    // Sorted derivations the sections render (iOS computed vars).

    val statusRows get() = byStatus.entries.map { it.key to it.value }.sortedByDescending { it.second }
    val sourceRows get() = bySource.entries.map { it.key to it.value }.sortedByDescending { it.second.revenue }
    val expenseRows get() = expenseByCat.entries.map { it.key to it.value }.sortedByDescending { it.second }

    /** Web paymentPie: each method as a rounded % of all payments. */
    val paymentRows: List<Pair<String, Int>>
        get() {
            val total = byPayment.values.sum()
            if (total <= 0) return emptyList()
            return byPayment.entries
                .map { it.key to (it.value.toDouble() / total * 100).roundToInt() }
                .sortedByDescending { it.second }
        }

    /** Web catArr: by_category + client-side margin, sorted by revenue. */
    val categoryRows: List<Triple<String, AnCategoryStat, Int>>
        get() = byCategory.entries.map { e ->
            val margin = if (e.value.revenue > 0)
                (e.value.profit.toDouble() / e.value.revenue * 100).roundToInt() else 0
            Triple(e.key, e.value, margin)
        }.sortedByDescending { it.second.revenue }

    /** Web buildReturnsByTypePie: delivered vs paid vs refused counts, zero slices dropped. */
    val returnsPie: List<Triple<String, Int, Color>>
        get() {
            val rows = orders ?: return emptyList()
            var delivered = 0; var paid = 0; var refused = 0
            rows.forEach { o ->
                when (AnReturnMath.statusKey(o.status)) {
                    "DELIVERED" -> delivered++
                    "RETURNED_PAID" -> paid++
                    "RETURNED_UNPAID", "RETURNED" -> refused++
                }
            }
            return listOf(
                Triple("Delivered", delivered, AnPalette.pieDelivered),
                Triple("Returned (paid)", paid, AnPalette.pieReturnPaid),
                Triple("Returned (refused)", refused, AnPalette.pieReturnRefused),
            ).filter { it.second > 0 }
        }

    /** Web buildReturnLossTrend: per-day courier loss + return count, sorted by day. */
    val returnLossTrend: List<AnLossDay>
        get() {
            val rows = orders ?: return emptyList()
            val daily = mutableMapOf<String, Pair<Int, Int>>()   // date → (loss, returns)
            rows.forEach { o ->
                val key = AnReturnMath.statusKey(o.status)
                if (!AnReturnMath.isTerminalReturn(key)) return@forEach
                val raw = o.date?.takeIf { it.isNotEmpty() } ?: return@forEach
                val d = raw.take(10)
                val net = o.returnNetProfit ?: AnReturnMath.fallbackReturnNet(key, o)
                val loss = if (net < 0) abs(net) else 0
                val prev = daily[d] ?: (0 to 0)
                daily[d] = (prev.first + loss) to (prev.second + 1)
            }
            return daily.entries.sortedBy { it.key }
                .map { AnLossDay(it.key, it.value.first, it.value.second) }
        }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnalyticsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AnalyticsState() }
    val scope = rememberCoroutineScope()
    var selectedMonth by remember { mutableStateOf<AnTrendPoint?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Date preset chips (web DateRangeFilter; "Custom" stays on the web) + ↻.
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AnPreset.entries.forEach { p ->
                    AnChip(p.label, vm.preset == p, dark) {
                        vm.preset = p
                        scope.launch { vm.load() }
                    }
                }
                Box(
                    Modifier.size(30.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp) }
            }
        }
        if (vm.authExpired) {
            item { AnAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { AnNoticeCard(it, dark) } }

        if (vm.loading && !vm.loaded) {
            items(4) {
                Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
            }
        } else {
            item { AnHeroCard(vm.kpis, dark) }
            item {
                // 2-col glass tiles (Avg Order Value / Delivery Rate).
                val k = vm.kpis
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AnStatTile(
                        "Avg Order Value", k?.avgOrderValue, { AlmaTheme.takaShort(it) },
                        sub = "গড় অর্ডার", tint = AlmaTheme.ink(dark),
                        accent = AlmaTheme.violet, dark = dark, modifier = Modifier.weight(1f),
                    )
                    AnStatTile(
                        "Delivery Rate", k?.deliveryRate?.roundToInt(), { "$it%" },
                        sub = "ডেলিভারি সফল", tint = AlmaTheme.ink(dark),
                        accent = AlmaTheme.sage, dark = dark, modifier = Modifier.weight(1f),
                    )
                }
            }
            vm.kpis?.let { k ->
                item {
                    // Web's second KPI row (Return Loss / Return Rate / Refused).
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AnStatTile(
                            "Return Loss", k.totalReturnsLoss ?: 0, { AlmaTheme.takaShort(it) },
                            sub = "রিটার্নে ক্ষতি",
                            tint = if ((k.totalReturnsLoss ?: 0) > 0) AnPalette.red500 else AlmaTheme.ink(dark),
                            accent = AnPalette.red500, dark = dark, modifier = Modifier.weight(1f),
                        )
                        AnStatTile(
                            "Return Rate", k.returnRate.roundToInt(), { "$it%" },
                            sub = "${(k.returnRatePaid ?: 0.0).roundToInt()}% paid · ${(k.returnRateRefused ?: 0.0).roundToInt()}% refused",
                            tint = AlmaTheme.ink(dark),
                            accent = AnPalette.amber500, dark = dark, modifier = Modifier.weight(1f),
                        )
                        AnStatTile(
                            "Refused", k.returnedUnpaidCount ?: 0, { "$it" },
                            sub = "ফেরত + আনপেইড",
                            tint = if ((k.returnedUnpaidCount ?: 0) > 0) AnPalette.red500 else AlmaTheme.ink(dark),
                            accent = AnPalette.red500, dark = dark, modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
            // Both return cards hide silently when the orders fetch is unavailable.
            if (vm.orders != null) {
                item { AnReturnsByTypeCard(vm.returnsPie, dark) }
                item { AnReturnLossCard(vm.returnLossTrend, dark) }
            }
            item { AnTrendCard(vm.monthlyTrend, dark) { selectedMonth = it } }
            item { AnStatusCard(vm.statusRows, dark) }
            item { AnChannelCard(vm.sourceRows, maxOf(vm.kpis?.totalRevenue ?: 1, 1), dark) }
            item { AnPaymentCard(vm.paymentRows, dark) }
            item { AnExpenseCard(vm.expenseRows, vm.totalExpenses ?: 0, dark) }
            item { AnCategoryCard(vm.categoryRows, dark) }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    // Month detail sheet (tap a trend bar — view-only breakdown).
    selectedMonth?.let { p ->
        ModalBottomSheet(onDismissRequest = { selectedMonth = null }, containerColor = AlmaTheme.rootBg(dark)) {
            AnMonthDetailSheet(p, dark) { selectedMonth = null }
        }
    }
}

// ── Bento KPI board (dark revenue hero + accent-washed glass tiles) ─────────────────

/** Count-up value (0 → target on appear, old → new on refresh) — iOS AnCountUp twin. */
@Composable
private fun anCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    val v by animateFloatAsState(
        targetValue = if (started) target.toFloat() else 0f,
        animationSpec = tween(900, easing = FastOutSlowInEasing),
        label = "anCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    return v.roundToInt()
}

/** The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe). */
@Composable
private fun AnHeroCard(k: AnKpis?, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    val netProfit = k?.netBusinessProfit ?: k?.totalProfit
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF181528))
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape),
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawRect(
                Brush.linearGradient(
                    listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                    start = Offset.Zero, end = Offset(size.width * 0.5f, size.height * 0.5f),
                ),
            )
            drawRect(
                Brush.linearGradient(
                    listOf(Color.Transparent, AlmaTheme.coral.copy(alpha = 0.30f)),
                    start = Offset(size.width * 0.5f, size.height * 0.5f),
                    end = Offset(size.width, size.height),
                ),
            )
            drawRect(
                Brush.radialGradient(
                    listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                    center = Offset(size.width * 0.85f, size.height * 0.05f),
                    radius = 220.dp.toPx(),
                ),
            )
        }
        Column(Modifier.padding(16.dp)) {
            Text(
                "মোট আয় · TOTAL REVENUE",
                color = AnPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp,
            )
            Text(
                if (k != null) AlmaTheme.takaShort(anCountUp(k.totalRevenue)) else "—",
                color = Color.White, fontSize = 36.sp, fontWeight = FontWeight.Black,
                fontFamily = FontFamily.Monospace, maxLines = 1,
                modifier = Modifier.padding(top = 8.dp),
            )
            Text(
                "এই রেঞ্জের বিক্রি",
                color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
                modifier = Modifier.padding(top = 5.dp),
            )
            Row(Modifier.padding(top = 14.dp)) {
                AnHeroStat(
                    "Net profit", netProfit, { AlmaTheme.takaShort(it) },
                    tint = if ((netProfit ?: 0) < 0) AnPalette.red500 else AnPalette.green400,
                    sub = "MTD",
                )
                AnHeroDivider()
                AnHeroStat("Margin", k?.grossMargin?.roundToInt(), { "$it%" }, Color.White, "গ্রস মার্জিন")
                AnHeroDivider()
                AnHeroStat("Orders", k?.totalOrders, { "$it" }, Color.White, "এই রেঞ্জে")
                Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun AnHeroDivider() {
    Box(
        Modifier.padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp).height(44.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun AnHeroStat(label: String, target: Int?, format: (Int) -> String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(
            if (target != null) format(anCountUp(target)) else "—",
            color = tint, fontSize = 16.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace, maxLines = 1,
        )
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Small glass stat tile — count-up value + sub line over a soft accent wash. */
@Composable
private fun AnStatTile(
    label: String,
    target: Int?,
    format: (Int) -> String,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        modifier
            .clip(shape)
            .background(if (dark) Color.White.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.62f))
            .background(
                Brush.linearGradient(
                    listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
            )
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.45f), shape)
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            if (target != null) format(anCountUp(target)) else "—",
            color = tint, fontSize = 16.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace, maxLines = 1,
        )
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Returns by Type (web DonutChart card — client-computed from order rows) ─────────

@Composable
private fun AnReturnsByTypeCard(slices: List<Triple<String, Int, Color>>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Returns by Type", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text("Delivered vs paid vs refused", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        if (slices.isEmpty()) {
            AnEmptyBlock("◫", "No returns in period", "Pie chart appears when return orders exist", dark)
        } else {
            Box(Modifier.fillMaxWidth().padding(top = 12.dp), contentAlignment = Alignment.Center) {
                AnDonut(slices, dark)
            }
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                slices.forEach { (name, value, color) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(8.dp).background(color, RoundedCornerShape(2.dp)))
                        Text(name, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        Spacer(Modifier.weight(1f))
                        Text(
                            "$value",
                            color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}

/** Trimmed stroke ring donut — DashDonut recipe, iOS AnalyticsDonut twin. */
@Composable
private fun AnDonut(slices: List<Triple<String, Int, Color>>, dark: Boolean) {
    val total = maxOf(slices.sumOf { it.second }, 1)
    Box(Modifier.size(150.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 18.dp.toPx()
            var startAngle = -90f
            slices.forEach { s ->
                val sweep = s.second / total.toFloat() * 360f
                drawArc(
                    color = s.third,
                    startAngle = startAngle,
                    sweepAngle = sweep,
                    useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = Size(size.width - stroke, size.height - stroke),
                    style = Stroke(width = stroke),
                )
                startAngle += sweep
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "$total",
                color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text("মোট", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}

// ── Return Loss Trend (web ReturnLossTrendChart — daily courier loss, red) ──────────

@Composable
private fun AnReturnLossCard(days: List<AnLossDay>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Return Loss Trend", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text("Daily courier loss from returns", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        if (days.isEmpty()) {
            AnEmptyBlock("◈", "No return loss yet", "Trend builds as returns are recorded", dark)
        } else {
            val maxLoss = maxOf(days.maxOfOrNull { it.loss } ?: 1, 1).toFloat()
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                days.forEach { d ->
                    val h = maxOf(d.loss / maxLoss * 96f, 3f)
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            AlmaTheme.takaShort(d.loss),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 8.sp,
                            fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, maxLines = 1,
                        )
                        Box(Modifier.height(100.dp).width(26.dp), contentAlignment = Alignment.BottomCenter) {
                            Box(
                                Modifier.width(26.dp).height(h.dp).background(
                                    Brush.verticalGradient(
                                        listOf(AnPalette.red500.copy(alpha = 0.55f), AnPalette.red500),
                                    ),
                                    RoundedCornerShape(5.dp),
                                ),
                            )
                        }
                        // Web x-axis tickFormatter: yyyy-MM-dd → "MM-dd".
                        Text(
                            d.date.takeLast(5),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                AnLegendDot(AnPalette.red500, "Return loss", dark)
                Spacer(Modifier.weight(1f))
                Text(
                    "${days.sumOf { it.returns }} returns",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                )
            }
        }
    }
}

// ── Revenue vs Profit trend (gradient bars; tap a month → detail sheet) ─────────────

@Composable
private fun AnTrendCard(points: List<AnTrendPoint>, dark: Boolean, onSelect: (AnTrendPoint) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Revenue vs Profit Trend", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text("Monthly · live data", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        if (points.isEmpty()) {
            AnEmptyBlock("◈", "No trend data yet", "Revenue chart appears after orders are placed", dark)
        } else {
            val maxRev = maxOf(points.maxOfOrNull { it.revenue } ?: 1, 1).toFloat()
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                points.forEach { p ->
                    val h = maxOf(p.revenue / maxRev * 120f, 3f)
                    val ph = if (p.revenue > 0 && p.profit > 0) maxOf(p.profit / maxRev * 120f, 3f) else 0f
                    Column(
                        Modifier.plainClick { onSelect(p) },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            AlmaTheme.takaShort(p.revenue),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 8.sp,
                            fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, maxLines = 1,
                        )
                        Box(Modifier.height(124.dp).width(26.dp), contentAlignment = Alignment.BottomCenter) {
                            Box(
                                Modifier.width(26.dp).height(h.dp).background(
                                    Brush.verticalGradient(listOf(AnPalette.goldLt, AnPalette.coral)),
                                    RoundedCornerShape(5.dp),
                                ),
                            )
                            if (ph > 0f) {
                                Box(
                                    Modifier.width(10.dp).height(ph.dp).background(
                                        AnPalette.positive(dark).copy(alpha = 0.9f),
                                        RoundedCornerShape(3.dp),
                                    ),
                                )
                            }
                        }
                        Text(
                            AnFormat.monthShort(p.month),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
            Row(
                Modifier.padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                AnLegendDot(AnPalette.coral, "Revenue", dark)
                AnLegendDot(AnPalette.positive(dark), "Profit", dark)
                Spacer(Modifier.weight(1f))
                Text("মাস চাপলে বিস্তারিত", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun AnLegendDot(color: Color, label: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

// ── Orders by Status / Channel / Payment / Expense (horizontal tinted bars) ─────────

@Composable
private fun AnStatusCard(rows: List<Pair<String, Int>>, dark: Boolean) {
    val maxCount = maxOf(rows.maxOfOrNull { it.second } ?: 1, 1)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Orders by Status", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        if (rows.isEmpty()) {
            AnEmptyBlock("◩", "No status data", "Appears once orders are placed", dark)
        } else {
            rows.forEach { (name, count) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row {
                        Text(
                            name.replace("_", " "),
                            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        )
                        Spacer(Modifier.weight(1f))
                        Text(
                            "$count",
                            color = AnPalette.status(name), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    AnHBar(count / maxCount.toFloat(), AnPalette.status(name), dark)
                }
            }
        }
    }
}

@Composable
private fun AnChannelCard(rows: List<Pair<String, AnSourceStat>>, totalRevenue: Int, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Orders by Channel", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        if (rows.isEmpty()) {
            AnEmptyBlock("◩", "No channel data", "Appears once orders are placed", dark)
        } else {
            rows.forEach { (name, stat) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(name, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.weight(1f))
                        Text("${stat.orders} orders", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        Text(
                            AlmaTheme.takaShort(stat.revenue),
                            color = AnPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    AnHBar(stat.revenue / totalRevenue.toFloat(), AnPalette.coral, dark)
                }
            }
        }
    }
}

@Composable
private fun AnPaymentCard(rows: List<Pair<String, Int>>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Payment Method Mix", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        if (rows.isEmpty()) {
            AnEmptyBlock("◈", "No payment data", "Appears once orders are placed", dark)
        } else {
            rows.forEach { (name, pct) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(8.dp).background(AnPalette.payment(name), RoundedCornerShape(2.dp)))
                        Text(name, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.weight(1f))
                        Text(
                            "$pct%",
                            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    AnHBar(pct / 100f, AnPalette.payment(name), dark)
                }
            }
        }
    }
}

@Composable
private fun AnExpenseCard(rows: List<Pair<String, Int>>, total: Int, dark: Boolean) {
    val maxAmount = maxOf(rows.maxOfOrNull { it.second } ?: 1, 1)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Expense Breakdown", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(
                if (total > 0) "${AlmaTheme.taka(total)} total · live data" else "No expense data yet",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }
        if (rows.isEmpty()) {
            AnEmptyBlock("◫", "No expenses recorded", "Appears after expenses are logged", dark)
        } else {
            rows.forEachIndexed { i, (name, amount) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row {
                        Text(name, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.weight(1f))
                        Text(
                            AlmaTheme.taka(amount),
                            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    AnHBar(amount / maxAmount.toFloat(), AnPalette.series[i % AnPalette.series.size], dark)
                }
            }
        }
    }
}

// ── Category Performance (ranked list, rank badges) ─────────────────────────────────

@Composable
private fun AnCategoryCard(rows: List<Triple<String, AnCategoryStat, Int>>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Category Performance", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        if (rows.isEmpty()) {
            AnEmptyBlock("◧", "No category data", "Appears once orders are placed", dark)
        } else {
            rows.forEachIndexed { i, (name, stat, margin) ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    // Rank badge — top-3 wear the coral→violet gradient like the app's icons.
                    Box(
                        Modifier
                            .size(26.dp)
                            .background(
                                if (i < 3) Brush.linearGradient(listOf(AnPalette.coral, AlmaTheme.violet))
                                else Brush.linearGradient(
                                    listOf(
                                        AlmaTheme.ink(dark).copy(alpha = 0.06f),
                                        AlmaTheme.ink(dark).copy(alpha = 0.06f),
                                    ),
                                ),
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "${i + 1}",
                            color = if (i < 3) Color.White else AlmaTheme.inkSecondary(dark),
                            fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        )
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row {
                            Text(
                                name, color = AlmaTheme.ink(dark), fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                AlmaTheme.takaShort(stat.revenue),
                                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("${stat.orders} orders", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                            Text(
                                AlmaTheme.taka(stat.profit),
                                color = AnPalette.signed(stat.profit, dark), fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                            )
                            Spacer(Modifier.weight(1f))
                            AnHBar(
                                margin.coerceIn(0, 100) / 100f, AnPalette.goldLt, dark,
                                height = 4, modifier = Modifier.width(56.dp),
                            )
                            Text(
                                "$margin%",
                                color = AnPalette.accentText(dark), fontSize = 11.sp,
                                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
                if (i < rows.size - 1) {
                    HorizontalDivider(thickness = 0.7.dp, color = AlmaTheme.separator(dark).copy(alpha = 0.06f))
                }
            }
        }
    }
}

// ── Month detail sheet (view-only breakdown) ────────────────────────────────────────

@Composable
private fun AnMonthDetailSheet(p: AnTrendPoint, dark: Boolean, onDone: () -> Unit) {
    val margin = if (p.revenue > 0) (p.profit.toDouble() / p.revenue * 100).roundToInt() else 0
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(AnFormat.monthLong(p.month), color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Text("মাসিক আয়-ব্যয়ের বিবরণ", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AnDetailRow("Revenue", AlmaTheme.taka(p.revenue), AlmaTheme.ink(dark), dark)
            AnDetailRow("COGS", AlmaTheme.taka(p.cogs), AlmaTheme.ink(dark), dark)
            AnDetailRow("Profit", AlmaTheme.taka(p.profit), AnPalette.signed(p.profit, dark), dark)
            AnDetailRow("Orders", "${p.orders}", AlmaTheme.ink(dark), dark)
            HorizontalDivider(thickness = 0.7.dp, color = AlmaTheme.separator(dark).copy(alpha = 0.08f))
            AnDetailRow("Margin", "$margin%", AnPalette.accentText(dark), dark)
        }
        Text(
            "ঠিক আছে",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(AnPalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick(onDone)
                .padding(vertical = 11.dp),
        )
    }
}

@Composable
private fun AnDetailRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
        )
        Spacer(Modifier.weight(1f))
        Text(
            value,
            color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

/** Track-and-fill horizontal bar (the web's rounded progress bars). */
@Composable
private fun AnHBar(fraction: Float, color: Color, dark: Boolean, height: Int = 6, modifier: Modifier = Modifier) {
    val f = fraction.coerceIn(0f, 1f)
    Box(
        modifier.fillMaxWidth().height(height.dp)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.07f), CircleShape),
    ) {
        if (f > 0f) {
            Box(
                Modifier.fillMaxHeight().fillMaxWidth(maxOf(f, 0.02f)).background(
                    Brush.horizontalGradient(listOf(color.copy(alpha = 0.85f), color)),
                    CircleShape,
                ),
            )
        }
    }
}

@Composable
private fun AnEmptyBlock(glyph: String, title: String, desc: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(glyph, color = AlmaTheme.inkSecondary(dark), fontSize = 20.sp)
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

@Composable
private fun AnChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) AnPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) AnPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) AnPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun AnNoticeCard(message: String, dark: Boolean) {
    Text(
        "⚠️ $message", color = AnPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun AnAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AnPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers ──────────────────────────────────────────────────────────────

private object AnFormat {
    private val shortNames = listOf(
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    )
    private val longNames = listOf(
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )

    /** "2026-03" → "Mar". */
    fun monthShort(ym: String): String {
        val parts = ym.split("-")
        val m = parts.getOrNull(1)?.toIntOrNull() ?: return ym
        if (m !in 1..12) return ym
        return shortNames[m - 1]
    }

    /** "2026-03" → "March 2026". */
    fun monthLong(ym: String): String {
        val parts = ym.split("-")
        val m = parts.getOrNull(1)?.toIntOrNull() ?: return ym
        if (m !in 1..12) return ym
        return "${longNames[m - 1]} ${parts[0]}"
    }
}
