//
//  DashboardScreen.kt
//  ALMA ERP — the Lifestyle home dashboard, ported 1:1 from DashboardSwiftUI.swift
//  ("Command Deck" layout): commanding revenue hero + integrated area chart with a
//  Bangla date axis, 8-KPI hairline spec panel, 2-col compact chart grid (daily line ·
//  status donut · category donut · channel bars), monthly bars, revenue+profit trend,
//  top products, recent orders, SLA banner/detail, owner To-Do chip + glass dropdown.
//  ALL figures pure Bangla digits (owner directive). VIEW-ONLY (owner P&L surface).
//
//  One endpoint, same aggregation the web runs:
//    GET /api/dashboard?business_id=ALMA_LIFESTYLE&startDate=…&endDate=…
//  Owner To-Do: /api/assistant/todos (403 → not the owner → card hidden silently).
//

package com.almatraders.erp.pages

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes) ───────────────────────────────────────────────────────

private object DashPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val tan = Color(0xFFD4956A)
    val sage = AlmaTheme.sage
    val violet = AlmaTheme.violet
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val info = Color(0xFF3B82F6)

    /** The web's donut/pie order — PALETTE = [accent, goldDim, goldLt, tan, sage]. */
    val chart = listOf(coral, goldDim, goldLt, tan, sage)

    fun accentText(dark: Boolean) = if (dark) goldLt else goldDim
    fun positive(dark: Boolean) = if (dark) green400 else emerald600
    fun warning(dark: Boolean) = if (dark) amber500 else amber600
    fun signed(amount: Int, dark: Boolean) = if (amount < 0) red500 else positive(dark)
}

// ── Bangla numerals + money (owner directive: ALL figures in pure Bangla) ───────────

private val BN_DIGITS = mapOf(
    '0' to '০', '1' to '১', '2' to '২', '3' to '৩', '4' to '৪',
    '5' to '৫', '6' to '৬', '7' to '৭', '8' to '৮', '9' to '৯',
)

private fun bnD(s: String) = s.map { BN_DIGITS[it] ?: it }.joinToString("")

/** Indian/Bangla comma grouping: 58500→"58,500", 1250000→"12,50,000". */
private fun dashGrouped(n: Int): String {
    var s = kotlin.math.abs(n).toString()
    if (s.length <= 3) return s
    val last3 = s.takeLast(3); s = s.dropLast(3)
    val groups = ArrayList<String>()
    while (s.length > 2) { groups.add(0, s.takeLast(2)); s = s.dropLast(2) }
    if (s.isNotEmpty()) groups.add(0, s)
    return groups.joinToString(",") + "," + last3
}

private fun bnN(n: Int) = (if (n < 0) "-" else "") + bnD(dashGrouped(n))
private fun bnTk(n: Int) = (if (n < 0) "-৳" else "৳") + bnD(dashGrouped(n))
private fun bnPct(n: Int) = (if (n < 0) "-" else "") + bnD(kotlin.math.abs(n).toString()) + "%"

private val BN_MONTHS = listOf("জানু", "ফেব", "মার্চ", "এপ্রি", "মে", "জুন", "জুলা", "আগ", "সেপ", "অক্টো", "নভে", "ডিসে")

/** "2026-06-08" → "৮ জুন". Empty on a bad string. */
private fun bnDayMonth(iso: String): String {
    val p = iso.split("-")
    if (p.size < 3) return ""
    val m = p[1].toIntOrNull() ?: return ""
    val d = p[2].toIntOrNull() ?: return ""
    if (m !in 1..12) return ""
    return bnD(d.toString()) + " " + BN_MONTHS[m - 1]
}

/** "2026-03" → "Mar". */
private fun monthShort(ym: String): String {
    val short = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    val parts = ym.split("-")
    val m = parts.getOrNull(1)?.toIntOrNull() ?: return ym
    return if (m in 1..12) short[m - 1] else ym
}

// ── Models (field names = the web DashboardData) ────────────────────────────────────

data class DashKpis(
    val totalOrders: Int, val totalRevenue: Int, val totalProfit: Int,
    val netBusinessProfit: Int?, val totalRealizedProfit: Int?,
    val deliveredCount: Int, val deliveryRate: Int, val returnRate: Int,
    val returnRatePaid: Int, val returnRateRefused: Int, val totalReturnsLoss: Int,
    val returnedPaidCount: Int, val returnedUnpaidCount: Int, val pendingCount: Int?,
) {
    val netProfit get() = netBusinessProfit ?: totalProfit
    val realizedProfit get() = totalRealizedProfit ?: totalProfit

    companion object {
        fun from(o: JSONObject) = DashKpis(
            totalOrders = o.flexInt("total_orders") ?: 0,
            totalRevenue = o.flexInt("total_revenue") ?: 0,
            totalProfit = o.flexInt("total_profit") ?: 0,
            netBusinessProfit = o.flexInt("net_business_profit"),
            totalRealizedProfit = o.flexInt("total_realized_profit"),
            deliveredCount = o.flexInt("delivered_count") ?: 0,
            deliveryRate = o.flexInt("delivery_rate") ?: 0,
            returnRate = o.flexInt("return_rate") ?: 0,
            returnRatePaid = o.flexInt("return_rate_paid") ?: 0,
            returnRateRefused = o.flexInt("return_rate_refused") ?: 0,
            totalReturnsLoss = o.flexInt("total_returns_loss") ?: 0,
            returnedPaidCount = o.flexInt("returned_paid_count") ?: 0,
            returnedUnpaidCount = o.flexInt("returned_unpaid_count") ?: 0,
            pendingCount = o.flexInt("pending_count"),
        )
        val EMPTY = from(JSONObject())
    }
}

data class DashGroupDetail(val group: String, val pieces: Int, val sizes: List<Pair<String, Int>>) {
    /** Web formatGroupSizeLine parity: "Group N pcs · sz A (x) · B (y)". */
    val line: String
        get() {
            val sz = sizes.take(2).joinToString(" · ") { "${it.first} (${it.second})" }
            val base = "$group $pieces pcs"
            return if (sz.isEmpty()) base else "$base · sz $sz"
        }
}

data class DashTopProduct(
    val product: String, val orders: Int, val revenue: Int, val profit: Int,
    val pieces: Int, val topSize: Pair<String, Int>?, val groupDetails: List<DashGroupDetail>,
)

data class DashDailyPoint(val date: String, val revenue: Int, val profit: Int, val orders: Int)
data class DashMonthlyPoint(val month: String, val revenue: Int, val profit: Int, val orders: Int)
data class DashSlaBreach(val id: String, val customer: String, val slaStatus: String)
data class DashRecentOrder(val id: String, val customer: String, val product: String, val status: String, val sellPrice: Int)

data class DashboardData(
    val kpis: DashKpis,
    val byStatus: List<Pair<String, Int>>,
    val bySource: List<Pair<String, Int>>,          // (channel, orders)
    val byCategory: List<Pair<String, Int>>,        // (category, orders)
    val monthlyTrend: List<DashMonthlyPoint>,
    val dailyTrend: List<DashDailyPoint>,
    val topProducts: List<DashTopProduct>,
    val slaBreaches: List<DashSlaBreach>,
    val recentOrders: List<DashRecentOrder>,
) {
    companion object {
        fun from(root: JSONObject): DashboardData {
            val c = root.optJSONObject("data") ?: root
            fun statPairs(key: String, valueKey: String?): List<Pair<String, Int>> {
                val obj = c.optJSONObject(key) ?: return emptyList()
                val out = ArrayList<Pair<String, Int>>()
                for (k in obj.keys()) {
                    val v = if (valueKey == null) obj.flexInt(k)
                    else obj.optJSONObject(k)?.flexInt(valueKey)
                    if (v != null) out.add(k to v)
                }
                return out
            }
            return DashboardData(
                kpis = c.optJSONObject("kpis")?.let { DashKpis.from(it) } ?: DashKpis.EMPTY,
                byStatus = statPairs("by_status", null),
                bySource = statPairs("by_source", "orders"),
                byCategory = statPairs("by_category", "orders"),
                monthlyTrend = c.optJSONArray("monthly_trend")?.mapObjects {
                    DashMonthlyPoint(
                        it.str("month") ?: "", it.flexInt("revenue") ?: 0,
                        it.flexInt("profit") ?: 0, it.flexInt("orders") ?: 0,
                    )
                } ?: emptyList(),
                dailyTrend = c.optJSONArray("daily_trend")?.mapObjects {
                    DashDailyPoint(
                        it.str("date") ?: "", it.flexInt("revenue") ?: 0,
                        it.flexInt("profit") ?: 0, it.flexInt("orders") ?: 0,
                    )
                } ?: emptyList(),
                topProducts = c.optJSONArray("top_products")?.mapObjects { p ->
                    DashTopProduct(
                        product = p.str("product") ?: "",
                        orders = p.flexInt("orders") ?: 0,
                        revenue = p.flexInt("revenue") ?: 0,
                        profit = p.flexInt("profit") ?: 0,
                        pieces = p.flexInt("pieces") ?: 0,
                        topSize = p.optJSONObject("top_size")?.let { t ->
                            (t.str("label") ?: "") to (t.flexInt("pieces") ?: 0)
                        },
                        groupDetails = p.optJSONArray("group_details")?.mapObjects { g ->
                            DashGroupDetail(
                                g.str("group") ?: "", g.flexInt("pieces") ?: 0,
                                g.optJSONArray("size_breakdown")?.mapObjects { s ->
                                    (s.str("label") ?: "") to (s.flexInt("pieces") ?: 0)
                                } ?: emptyList(),
                            )
                        } ?: emptyList(),
                    )
                } ?: emptyList(),
                slaBreaches = c.optJSONArray("sla_breaches")?.mapObjects {
                    it.str("id")?.let { id ->
                        DashSlaBreach(id, it.str("customer") ?: "", it.str("sla_status") ?: "")
                    }
                } ?: emptyList(),
                recentOrders = c.optJSONArray("recent_orders")?.mapObjects {
                    it.str("id")?.let { id ->
                        DashRecentOrder(
                            id, it.str("customer") ?: "", it.str("product") ?: "",
                            it.str("status") ?: "", it.flexInt("sell_price") ?: 0,
                        )
                    }
                } ?: emptyList(),
            )
        }
    }
}

// ── Date presets (web DateRangeFilter parity — default last30, Asia/Dhaka) ──────────

enum class DashDatePreset(val label: String) {
    TODAY("Today"), YESTERDAY("Yesterday"), LAST7("Last 7 days"),
    LAST30("Last 30 days"), THIS_MONTH("This month"), LAST_MONTH("Last month");

    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = tz }
        val cal = Calendar.getInstance(tz).apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        fun d(x: Date) = fmt.format(x)
        fun shifted(days: Int): Date {
            val c = cal.clone() as Calendar; c.add(Calendar.DAY_OF_YEAR, days); return c.time
        }
        val today = cal.time
        return when (this) {
            TODAY -> d(today) to d(today)
            YESTERDAY -> d(shifted(-1)) to d(shifted(-1))
            LAST7 -> d(shifted(-6)) to d(today)
            LAST30 -> d(shifted(-29)) to d(today)
            THIS_MONTH -> {
                val c = cal.clone() as Calendar; c.set(Calendar.DAY_OF_MONTH, 1)
                d(c.time) to d(today)
            }
            LAST_MONTH -> {
                val first = cal.clone() as Calendar; first.set(Calendar.DAY_OF_MONTH, 1)
                val prevEnd = first.clone() as Calendar; prevEnd.add(Calendar.DAY_OF_YEAR, -1)
                val prevStart = prevEnd.clone() as Calendar; prevStart.set(Calendar.DAY_OF_MONTH, 1)
                d(prevStart.time) to d(prevEnd.time)
            }
        }
    }
}

// ── State holders ───────────────────────────────────────────────────────────────────

class DashboardState {
    var data by mutableStateOf<DashboardData?>(null)
    var preset by mutableStateOf(DashDatePreset.LAST30)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            val (start, end) = preset.range()
            val root = AlmaApi.getObject(
                "/api/dashboard",
                mapOf("business_id" to "ALMA_LIFESTYLE", "startDate" to start, "endDate" to end),
            )
            data = DashboardData.from(root)
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Period-over-period % from the last two REAL points; absurd swings dropped (iOS parity). */
    companion object {
        fun trend(series: List<Int>): Double? {
            if (series.size < 2) return null
            val prev = series[series.size - 2]
            val last = series.last()
            if (prev <= 0 || last <= 0) return null
            val pct = (last - prev).toDouble() / prev * 100
            return if (kotlin.math.abs(pct) <= 300) pct else null
        }
    }
}

data class OwnerTodo(
    val id: String, val title: String, val priority: String,
    val status: String, val dueDate: String?, val createdAt: String?,
) {
    val isHigh get() = priority == "high"
    val priorityRank get() = if (priority == "high") 2 else if (priority == "low") 0 else 1
}

/** Owner To-Do (403 = not the owner → hidden silently; web OwnerTodoBar parity). */
class OwnerTodoState {
    var items by mutableStateOf(listOf<OwnerTodo>())
    var visible by mutableStateOf(false)
    var newTitle by mutableStateOf("")
    var busy by mutableStateOf(false)
    var done by mutableStateOf(setOf<String>())

    val openCount get() = items.count { it.id !in done }

    private val openStatuses = setOf("pending", "in_progress", "running")

    suspend fun load() {
        try {
            val root = AlmaApi.getObject("/api/assistant/todos")
            items = (root.optJSONArray("todos")?.mapObjects {
                it.str("id")?.let { id ->
                    OwnerTodo(
                        id, it.str("title") ?: "", it.str("priority") ?: "normal",
                        it.str("status") ?: "pending", it.str("dueDate"), it.str("createdAt"),
                    )
                }
            } ?: emptyList())
                .filter { it.status in openStatuses }
                .sortedWith(compareByDescending<OwnerTodo> { it.priorityRank }.thenBy { it.createdAt ?: "" })
            visible = true
        } catch (e: AlmaApiException.NotAuthenticated) {
            visible = false
        } catch (_: Exception) { /* transient — keep the current list */ }
    }

    suspend fun add() {
        val title = newTitle.trim()
        if (title.isEmpty() || busy) return
        busy = true
        try {
            AlmaApi.send("POST", "/api/assistant/todos", JSONObject().put("title", title).put("source", "owner"))
            newTitle = ""
            load()
        } catch (_: Exception) { /* leave the text so the owner can retry */ } finally {
            busy = false
        }
    }

    /** Toggle done — the row STAYS (checked); deleting is separate (owner directive). */
    suspend fun toggle(id: String) {
        val marking = id !in done
        done = if (marking) done + id else done - id
        try {
            AlmaApi.send(
                "PATCH", "/api/assistant/todos",
                JSONObject().put("id", id).put("status", if (marking) "completed" else "pending"),
            )
        } catch (_: Exception) {
            done = if (marking) done - id else done + id
        }
    }

    suspend fun remove(id: String) {
        items = items.filter { it.id != id }
        done = done - id
        try {
            AlmaApi.send("PATCH", "/api/assistant/todos", JSONObject().put("id", id).put("status", "cancelled"))
        } catch (_: Exception) {
            load()
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@Composable
fun DashboardScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { DashboardState() }
    val todo = remember { OwnerTodoState() }
    val scope = rememberCoroutineScope()
    var todoOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        vm.load()
        todo.load()
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(if (todo.visible) 30.dp else 0.dp)) }
            if (vm.authExpired) {
                item { DashAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
            }
            vm.error?.let { err -> item { DashNotice(err, dark) } }
            vm.data?.slaBreaches?.takeIf { it.isNotEmpty() }?.let { breaches ->
                item { SlaBanner(breaches, dark) { ctx.openWebForced("/orders?status=sla", "Orders") } }
            }
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    DashDatePreset.values().forEach { p ->
                        DashChip(p.label, vm.preset == p, dark) {
                            vm.preset = p
                            scope.launch { vm.load() }
                        }
                    }
                }
            }
            val d = vm.data
            if (vm.loading && d == null) {
                items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            } else if (d != null) {
                item { CommandHero(d.kpis, d.dailyTrend, d.monthlyTrend, dark) }
                item { StatBlock(d.kpis, d.byStatus, dark) }
                item { SectionLabel("বিশ্লেষণ", dark) }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            DailySalesCompact(d.dailyTrend, dark)
                            CategoryMixCompact(d.byCategory, dark)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            OrderStatusCompact(d.byStatus, dark)
                            ChannelCompact(d.bySource, dark)
                        }
                    }
                }
                item { MonthlyRevenueCard(d.monthlyTrend, dark) }
                item { RevenueTrendCard(d.monthlyTrend, dark) }
                item { TopProductsCard(d.topProducts, dark) }
                item { RecentOrdersCard(d.recentOrders, dark) { path, title -> ctx.openWebForced(path, title) } }
                if (d.slaBreaches.isNotEmpty()) {
                    item { SlaDetailCard(d.slaBreaches, dark) }
                }
            }
            item {
                Text(
                    "🌐 সম্পূর্ণ ড্যাশবোর্ড — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/", "Dashboard") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        // Owner To-Do — a small chip pinned top-right expanding to a glass dropdown.
        if (todo.visible) {
            Column(
                Modifier.align(Alignment.TopEnd).padding(end = 14.dp, top = 6.dp),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OwnerTodoChip(todo, dark) { todoOpen = !todoOpen }
                if (todoOpen) OwnerTodoPanel(todo, dark, scope)
            }
        }
    }
}

// ── Owner To-Do chip + panel ─────────────────────────────────────────────────────────

@Composable
private fun OwnerTodoChip(todo: OwnerTodoState, dark: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier
            .background(DashPalette.coral.copy(alpha = if (dark) 0.18f else 0.10f), CircleShape)
            .border(1.dp, DashPalette.coral.copy(alpha = 0.45f), CircleShape)
            .plainClick(onToggle)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("☑ টুডু", color = DashPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        if (todo.openCount > 0) {
            Text(
                bnD(todo.openCount.toString()),
                color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Black,
                modifier = Modifier.background(DashPalette.coral, CircleShape).padding(horizontal = 5.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun OwnerTodoPanel(todo: OwnerTodoState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Column(
        Modifier
            .width(300.dp)
            .background(
                if (dark) Color(0xFF1C172B) else Color(0xFFFCFAFF),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .border(
                1.dp,
                Color.White.copy(alpha = if (dark) 0.12f else 0.6f),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("আমার টুডু", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(
                "${bnD(todo.openCount.toString())}টি বাকি",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BasicTextField(
                value = todo.newTitle,
                onValueChange = { todo.newTitle = it },
                singleLine = true,
                textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 13.sp),
                decorationBox = { inner ->
                    Box(
                        Modifier
                            .background(AlmaTheme.ink(dark).copy(alpha = if (dark) 0.08f else 0.05f), CircleShape)
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        if (todo.newTitle.isEmpty()) {
                            Text("নতুন টুডু লিখুন…", color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp)
                        }
                        inner()
                    }
                },
                modifier = Modifier.weight(1f),
            )
            Text(
                if (todo.busy) "…" else "যোগ",
                color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(
                        Brush.linearGradient(listOf(DashPalette.coral, DashPalette.goldDim)),
                        CircleShape,
                    )
                    .plainClick { scope.launch { todo.add() } }
                    .padding(horizontal = 13.dp, vertical = 9.dp),
            )
        }
        if (todo.items.isEmpty()) {
            Text(
                "কোনো টুডু বাকি নেই — এজেন্টকে বললে বা এখানে লিখলে যুক্ত হবে।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        } else {
            Column(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState())) {
                todo.items.forEachIndexed { i, t ->
                    if (i > 0) HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.25f))
                    TodoRow(t, todo, dark, scope)
                }
            }
        }
    }
}

@Composable
private fun TodoRow(t: OwnerTodo, todo: OwnerTodoState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    val isDone = t.id in todo.done
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Box(
            Modifier
                .size(23.dp)
                .background(if (isDone) DashPalette.positive(dark) else Color.Transparent, CircleShape)
                .border(
                    2.dp,
                    if (isDone) DashPalette.positive(dark) else AlmaTheme.inkSecondary(dark).copy(alpha = 0.5f),
                    CircleShape,
                )
                .plainClick { scope.launch { todo.toggle(t.id) } },
            contentAlignment = Alignment.Center,
        ) {
            if (isDone) Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Black)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                t.title,
                color = if (isDone) AlmaTheme.inkSecondary(dark) else AlmaTheme.ink(dark),
                fontSize = 14.sp, fontWeight = FontWeight.Medium,
                textDecoration = if (isDone) TextDecoration.LineThrough else null,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            if (t.isHigh) {
                Text("জরুরি", color = DashPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        Box(
            Modifier
                .size(30.dp)
                .background(DashPalette.red500.copy(alpha = if (dark) 0.14f else 0.09f), CircleShape)
                .plainClick { scope.launch { todo.remove(t.id) } },
            contentAlignment = Alignment.Center,
        ) {
            Text("🗑", fontSize = 11.sp)
        }
    }
}

// ── Command hero + stat block ───────────────────────────────────────────────────────

@Composable
private fun TrendChip(pct: Double, dark: Boolean) {
    val up = pct >= 0
    val color = if (up) DashPalette.positive(dark) else DashPalette.red500
    Text(
        "${if (up) "↗" else "↘"} ${kotlin.math.abs(pct).toInt()}%",
        color = color, fontSize = 10.5.sp, fontWeight = FontWeight.Black,
        modifier = Modifier
            .background(color.copy(alpha = if (dark) 0.20f else 0.14f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun CommandHero(k: DashKpis, daily: List<DashDailyPoint>, monthly: List<DashMonthlyPoint>, dark: Boolean) {
    val avg = if (k.totalOrders > 0) k.totalRevenue / k.totalOrders else 0
    val trend = DashboardState.trend(monthly.map { it.revenue })
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(
                    listOf(DashPalette.coral.copy(alpha = if (dark) 0.16f else 0.12f), Color.Transparent),
                ),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "মোট আয় · REVENUE",
                color = DashPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp,
            )
            Spacer(Modifier.weight(1f))
            trend?.let { TrendChip(it, dark) }
        }
        Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(top = 8.dp)) {
            Text("৳", color = AlmaTheme.inkSecondary(dark), fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(
                bnTk(k.totalRevenue).removePrefix("৳").removePrefix("-৳"),
                color = AlmaTheme.ink(dark), fontSize = 40.sp, fontWeight = FontWeight.Black,
                maxLines = 1,
            )
        }
        Text(
            "গড় অর্ডার ${bnTk(avg)}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        if (daily.isNotEmpty()) {
            DashLineChart(daily.map { it.revenue }, DashPalette.coral, 112, modifier = Modifier.padding(top = 10.dp))
            AxisLabels(daily.map { it.date }, dark)
        }
    }
}

@Composable
private fun AxisLabels(dates: List<String>, dark: Boolean) {
    val valid = dates.filter { it.isNotEmpty() }
    if (valid.size < 4) return
    val n = valid.size - 1
    val labels = listOf(0, n / 3, 2 * n / 3, n).map { bnDayMonth(valid[it]) }.toMutableList()
    if (labels.any { it.isEmpty() }) return
    labels[labels.size - 1] = "আজ"
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        labels.forEach { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp) }
    }
}

@Composable
private fun StatBlock(k: DashKpis, byStatus: List<Pair<String, Int>>, dark: Boolean) {
    val avg = if (k.totalOrders > 0) k.totalRevenue / k.totalOrders else 0
    val pending = k.pendingCount ?: byStatus.firstOrNull { it.first.lowercase() == "pending" }?.second
    val items = listOf(
        Triple("নিট মুনাফা", bnTk(k.netProfit), DashPalette.signed(k.netProfit, dark)) to "রিটার্ন লস বাদে",
        Triple("মোট অর্ডার", bnN(k.totalOrders), DashPalette.info) to "এই রেঞ্জে",
        Triple("ডেলিভারড", bnN(k.deliveredCount), DashPalette.violet) to "${bnPct(k.deliveryRate)} রেট",
        Triple("রিটার্ন লস", bnTk(k.totalReturnsLoss), DashPalette.red500) to "${bnN(k.returnedUnpaidCount)} রিফিউজড",
        Triple(
            "রিটার্ন রেট", bnPct(k.returnRate),
            if (k.returnRate > 20) DashPalette.red500
            else if (k.returnRate > 10) DashPalette.warning(dark) else AlmaTheme.ink(dark),
        ) to "রিফিউজড ${bnPct(k.returnRateRefused)}",
        Triple("পেন্ডিং", pending?.let { bnN(it) } ?: "—", DashPalette.warning(dark)) to "অ্যাকশন বাকি",
        Triple("রিয়েলাইজড", bnTk(k.realizedProfit), DashPalette.positive(dark)) to "ডেলিভারড",
        Triple("গড় অর্ডার", bnTk(avg), AlmaTheme.ink(dark)) to "প্রতি অর্ডার",
    )
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        listOf(0, 4).forEachIndexed { rowIdx, start ->
            if (rowIdx > 0) HorizontalDivider(color = AlmaTheme.separator(dark), thickness = 1.dp)
            Row {
                for (i in 0 until 4) {
                    if (i > 0) {
                        Box(Modifier.width(1.dp).heightIn(min = 58.dp).background(AlmaTheme.separator(dark)))
                    }
                    val (head, sub) = items[start + i]
                    Column(
                        Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 11.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Text(
                            head.first.uppercase(),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 8.5.sp,
                            fontWeight = FontWeight.Bold, maxLines = 1,
                        )
                        Text(head.second, color = head.third, fontSize = 15.sp, fontWeight = FontWeight.Black, maxLines = 1)
                        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 8.5.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String, dark: Boolean) {
    Text(
        text.uppercase(),
        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
        letterSpacing = 0.9.sp,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    )
}

// ── Chart cards ─────────────────────────────────────────────────────────────────────

@Composable
private fun ChartCard(
    title: String,
    dark: Boolean,
    legend: List<Pair<String, Color>> = emptyList(),
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            legend.forEach { (label, color) ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 10.dp)) {
                    Box(Modifier.size(7.dp).background(color, CircleShape))
                    Spacer(Modifier.width(4.dp))
                    Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            }
        }
        content()
    }
}

@Composable
private fun EmptyChart(icon: String, title: String, desc: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(icon, color = AlmaTheme.inkSecondary(dark), fontSize = 20.sp)
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun DailySalesCompact(points: List<DashDailyPoint>, dark: Boolean) {
    ChartCard("দৈনিক বিক্রি", dark) {
        if (points.isEmpty()) EmptyChart("◈", "নেই", "অন্য রেঞ্জ দিন", dark)
        else DashLineChart(points.map { it.revenue }, DashPalette.coral, 74, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun OrderStatusCompact(byStatus: List<Pair<String, Int>>, dark: Boolean) {
    val slices = byStatus
        .filter { it.first !in setOf("Cancelled", "CANCELLED") }
        .sortedByDescending { it.second }
    val total = slices.sumOf { it.second }
    val coloured = slices.mapIndexed { i, s -> Triple(s.first, s.second, DashPalette.chart[i % DashPalette.chart.size]) }
    ChartCard("অর্ডার স্ট্যাটাস", dark) {
        if (coloured.isEmpty()) EmptyChart("◫", "নেই", "ফিল্টার বদলান", dark)
        else {
            Column(
                Modifier.fillMaxWidth().padding(top = 2.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                DashDonut(coloured, 104, 15, bnN(total), "মোট", dark)
                DonutLegend(coloured, dark)
            }
        }
    }
}

@Composable
private fun CategoryMixCompact(byCategory: List<Pair<String, Int>>, dark: Boolean) {
    val top = byCategory.sortedByDescending { it.second }.take(5)
    val coloured = top.mapIndexed { i, s -> Triple(s.first, s.second, DashPalette.chart[i % DashPalette.chart.size]) }
    ChartCard("ক্যাটাগরি", dark) {
        if (coloured.isEmpty()) EmptyChart("◧", "নেই", "অর্ডার এলে দেখাবে", dark)
        else {
            Column(
                Modifier.fillMaxWidth().padding(top = 2.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                DashDonut(coloured, 104, 15, bnN(coloured.size), "টাইপ", dark)
                DonutLegend(coloured, dark)
            }
        }
    }
}

@Composable
private fun ChannelCompact(bySource: List<Pair<String, Int>>, dark: Boolean) {
    val rows = bySource.sortedByDescending { it.second }
    val maxV = maxOf(rows.maxOfOrNull { it.second } ?: 1, 1)
    ChartCard("চ্যানেল", dark) {
        if (rows.isEmpty()) EmptyChart("◩", "নেই", "ফিল্টার বদলান", dark)
        else {
            Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                rows.forEachIndexed { i, r ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                r.first, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                                maxLines = 1, modifier = Modifier.weight(1f),
                            )
                            Text(bnN(r.second), color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        }
                        Box(
                            Modifier
                                .fillMaxWidth(fraction = maxOf(r.second.toFloat() / maxV, 0.04f))
                                .height(6.dp)
                                .background(DashPalette.chart[i % DashPalette.chart.size], CircleShape),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DonutLegend(items: List<Triple<String, Int, Color>>, dark: Boolean) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        items.chunked(2).forEach { rowItems ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowItems.forEach { it ->
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).background(it.third, RoundedCornerShape(2.dp)))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            it.first, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text(bnN(it.second), color = AlmaTheme.ink(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (rowItems.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun MonthlyRevenueCard(points: List<DashMonthlyPoint>, dark: Boolean) {
    ChartCard(
        "মাসিক আয়", dark,
        legend = listOf("আয়" to DashPalette.coral, "মুনাফা" to DashPalette.positive(dark)),
    ) {
        if (points.isEmpty()) EmptyChart("◈", "নেই", "অর্ডার এলে মাসিক হিসাব দেখাবে", dark)
        else {
            val maxRevenue = maxOf(points.maxOfOrNull { it.revenue } ?: 1, 1)
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                points.forEach { p ->
                    val h = maxOf(p.revenue.toFloat() / maxRevenue * 120, 3f)
                    val ph = if (p.revenue > 0 && p.profit > 0) {
                        maxOf(p.profit.toFloat() / maxRevenue * 120, 3f)
                    } else 0f
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(bnTk(p.revenue), color = AlmaTheme.inkSecondary(dark), fontSize = 8.sp, fontWeight = FontWeight.SemiBold)
                        Box(Modifier.height(124.dp), contentAlignment = Alignment.BottomCenter) {
                            Box(
                                Modifier
                                    .width(26.dp)
                                    .height(h.dp)
                                    .background(
                                        Brush.verticalGradient(listOf(DashPalette.goldLt, DashPalette.coral)),
                                        RoundedCornerShape(5.dp),
                                    ),
                            )
                            if (ph > 0) {
                                Box(
                                    Modifier
                                        .width(10.dp)
                                        .height(ph.dp)
                                        .background(DashPalette.emerald600.copy(alpha = 0.9f), RoundedCornerShape(3.dp)),
                                )
                            }
                        }
                        Text(monthShort(p.month), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun RevenueTrendCard(points: List<DashMonthlyPoint>, dark: Boolean) {
    ChartCard(
        "আয় ও মুনাফা ট্রেন্ড", dark,
        legend = listOf("আয়" to DashPalette.coral, "মুনাফা" to DashPalette.positive(dark)),
    ) {
        if (points.isEmpty()) EmptyChart("◈", "নেই", "অর্ডার এলে ট্রেন্ড দেখাবে", dark)
        else {
            Box(Modifier.padding(top = 8.dp)) {
                val maxRev = points.maxOfOrNull { it.revenue }
                DashLineChart(points.map { it.revenue }, DashPalette.coral, 160, fill = false)
                DashLineChart(points.map { it.profit }, DashPalette.positive(dark), 160, fill = false, maxOverride = maxRev)
            }
        }
    }
}

// ── Top products / recent orders / SLA ──────────────────────────────────────────────

@Composable
private fun TopProductsCard(products: List<DashTopProduct>, dark: Boolean) {
    val top = products.take(5)
    ChartCard("টপ প্রোডাক্ট", dark) {
        if (top.isEmpty()) EmptyChart("◧", "নেই", "অর্ডার এলে টপ প্রোডাক্ট দেখাবে", dark)
        else {
            Column {
                top.forEachIndexed { i, p ->
                    if (i > 0) HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.3f))
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 9.dp, horizontal = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            Modifier
                                .size(26.dp)
                                .background(
                                    DashPalette.coral.copy(alpha = if (dark) 0.18f else 0.12f),
                                    RoundedCornerShape(8.dp),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(bnN(i + 1), color = DashPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(p.product, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(
                                "${bnN(p.orders)} অর্ডার" + if (p.pieces > 0) " · ${bnN(p.pieces)} পিস" else "",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                            )
                            if (p.groupDetails.isNotEmpty()) {
                                Text(
                                    p.groupDetails.take(2).joinToString(" | ") { it.line },
                                    color = DashPalette.positive(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            } else if (p.topSize != null) {
                                Text(
                                    "টপ: ${p.topSize.first} · ${bnN(p.topSize.second)} পিস",
                                    color = DashPalette.positive(dark), fontSize = 11.sp, maxLines = 1,
                                )
                            }
                        }
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(bnTk(p.revenue), color = DashPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Text(bnTk(p.profit), color = DashPalette.positive(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RecentOrdersCard(orders: List<DashRecentOrder>, dark: Boolean, openWeb: (String, String) -> Unit) {
    val recent = orders.take(6)
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 2.dp)) {
            Text("সাম্প্রতিক অর্ডার", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(
                "সব দেখুন →",
                color = DashPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick { openWeb("/orders", "Orders") },
            )
        }
        if (recent.isEmpty()) EmptyChart("◫", "নেই", "এই রেঞ্জে কোনো অর্ডার নেই", dark)
        else {
            recent.forEachIndexed { i, o ->
                if (i > 0) HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.3f))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .plainClick { openWeb("/orders?focus=${o.id}", "Order ${o.id}") }
                        .padding(vertical = 9.dp, horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        o.id, color = DashPalette.accentText(dark), fontSize = 11.sp,
                        fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        maxLines = 1, modifier = Modifier.width(58.dp),
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(o.customer, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                        Text(o.product, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1)
                    }
                    DashStatusBadge(o.status, dark)
                    Text(bnTk(o.sellPrice), color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun DashStatusBadge(status: String, dark: Boolean) {
    val s = status.lowercase()
    val tint = when {
        s.contains("deliver") -> DashPalette.positive(dark)
        s.contains("cancel") || s.contains("return") || s.contains("refus") || s.contains("fail") -> DashPalette.red500
        s.contains("pending") || s.contains("hold") || s.contains("process") -> DashPalette.warning(dark)
        s.contains("transit") || s.contains("ship") || s.contains("dispatch") -> DashPalette.info
        else -> DashPalette.accentText(dark)
    }
    Text(
        status, color = tint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
        modifier = Modifier
            .background(tint.copy(alpha = 0.14f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun SlaBanner(breaches: List<DashSlaBreach>, dark: Boolean, onClick: () -> Unit) {
    val ids = breaches.take(3).joinToString(", ") { "#${it.id}" }
    val extra = if (breaches.size > 3) " +${bnN(breaches.size - 3)} আরও" else ""
    Row(
        Modifier
            .fillMaxWidth()
            .background(DashPalette.amber500.copy(alpha = if (dark) 0.16f else 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, DashPalette.amber500.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("⚡", fontSize = 15.sp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                "${bnN(breaches.size)}টি অর্ডারে মনোযোগ দরকার",
                color = DashPalette.warning(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
            )
            Text(ids + extra, color = DashPalette.warning(dark).copy(alpha = 0.85f), fontSize = 11.sp, maxLines = 1)
        }
        Text("সব দেখুন →", color = DashPalette.warning(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun SlaDetailCard(breaches: List<DashSlaBreach>, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, DashPalette.amber500.copy(alpha = 0.3f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(14.dp),
    ) {
        Text(
            "⚡ SLA অ্যালার্ট — ${bnN(breaches.size)}টি অর্ডার",
            color = DashPalette.warning(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        breaches.forEachIndexed { i, b ->
            if (i > 0) HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.25f))
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    b.id, color = DashPalette.accentText(dark), fontSize = 11.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.width(58.dp),
                )
                Text(b.customer, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, modifier = Modifier.weight(1f))
                Text(
                    b.slaStatus, color = DashPalette.warning(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(DashPalette.amber500.copy(alpha = 0.18f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
        }
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun DashChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) DashPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) DashPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) DashPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun DashNotice(message: String, dark: Boolean) {
    Text(
        "⚠ $message",
        color = DashPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, 12).padding(12.dp),
    )
}

@Composable
private fun DashAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন",
            color = AlmaTheme.ink(dark), fontSize = 14.sp, textAlign = TextAlign.Center,
        )
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(DashPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Charts (Canvas re-sets of the web recharts) ─────────────────────────────────────

@Composable
private fun DashLineChart(
    values: List<Int>,
    color: Color,
    height: Int,
    fill: Boolean = true,
    maxOverride: Int? = null,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier.fillMaxWidth().height(height.dp)) {
        if (values.isEmpty()) return@Canvas
        val w = size.width
        val h = size.height
        val maxV = maxOf((maxOverride ?: values.max()), 1).toFloat()
        val n = maxOf(values.size - 1, 1)
        val pts = values.mapIndexed { i, v ->
            Offset(w * i / n, h - (h - 6f) * maxOf(v, 0) / maxV - 3f)
        }
        if (fill && pts.size > 1) {
            val area = Path().apply {
                moveTo(pts.first().x, pts.first().y)
                pts.drop(1).forEach { lineTo(it.x, it.y) }
                lineTo(pts.last().x, h)
                lineTo(pts.first().x, h)
                close()
            }
            drawPath(
                area,
                Brush.verticalGradient(listOf(color.copy(alpha = 0.28f), color.copy(alpha = 0.02f))),
            )
        }
        val line = Path().apply {
            moveTo(pts.first().x, pts.first().y)
            pts.drop(1).forEach { lineTo(it.x, it.y) }
        }
        drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
        drawCircle(color, radius = 3.dp.toPx(), center = pts.last())
    }
}

@Composable
private fun DashDonut(
    slices: List<Triple<String, Int, Color>>,
    sizeDp: Int,
    lineWidthDp: Int,
    centerTop: String,
    centerBottom: String,
    dark: Boolean,
) {
    Box(Modifier.size(sizeDp.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val total = maxOf(slices.sumOf { it.second }, 1).toFloat()
            val stroke = lineWidthDp.dp.toPx()
            var startAngle = -90f
            slices.forEach { s ->
                val sweep = s.second / total * 360f
                drawArc(
                    color = s.third,
                    startAngle = startAngle,
                    sweepAngle = sweep,
                    useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                    style = Stroke(width = stroke),
                )
                startAngle += sweep
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(centerTop, color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text(centerBottom, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}
