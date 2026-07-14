//
//  FinanceScreen.kt
//  ALMA ERP — the Finance hub, ported 1:1 from FinanceSwiftUI.swift (web /finance parity).
//
//  Same endpoints, same numbers, same blocks as the iOS screen:
//    GET /api/finance/report?business_id=…&startDate=…&endDate=…  → FinancialReport
//        (profit_loss · monthly_revenue · cashflow · period_label)
//    GET /api/hr/dashboard?business_id=…&startDate=…&endDate=…    → { kpis: … }
//  Blocks: date-range preset chips (default last30) · KPI bento board (dark hero:
//  Revenue/Net profit/Expenses/Margin + 2×2 glass tiles: Payroll budget/Unpaid/
//  Advances/Order GP) · Revenue & margin trend (native bars, tap a month → detail
//  sheet) · Cashflow (report) · Payroll snapshot · quick links (Expenses / Office
//  Fund / Payroll → web). VIEW-ONLY by design: every mutating flow stays on the web
//  escape hatch. Money is whole-taka BDT (AlmaTheme.taka/takaShort), dates Asia/Dhaka.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Handshake
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS FinancePalette) ──

private object FinancePalette {
    val coral = AlmaTheme.coral                    // web --c-accent  #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web "txt-pos" (positive money) — emerald on cream, bright green over dark aurora. */
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600

    /** Signed money tone: positive green, negative red. */
    fun signed(amount: Int, dark: Boolean): Color = if (amount < 0) red500 else positive(dark)
}

/** The dark hero anchor base — iOS Color(0.094, 0.082, 0.157) = #181528. */
private val FIN_HERO_BASE = Color(0xFF181528)

// ── Models (same field names the web FinancialReport / HRDashboardApi declare) ────────

private data class FinMonthlyPoint(
    val month: String,       // "2026-03"
    val revenue: Int,
    val profit: Int,
    val expenses: Int,
)

private data class FinProfitLoss(
    val revenue: Int,
    val cogs: Int,
    val expenses: Int,
    val netProfit: Int,
    val marginPct: Double,
)

private data class FinCashflow(val inflow: Int, val outflow: Int, val net: Int)

private data class FinHRKpis(
    val totalMonthlySalary: Int,
    val unpaidSalaryHint: Int,
    val advanceOutstanding: Int,
    val orderGrossProfit: Int?,
    val netBusinessProfitHint: Int?,
    val periodSalaryPaid: Int?,
    val periodAdvances: Int?,
    val totalExpenses: Int,
)

// ── Date presets (web DateRangeFilter parity — default last30; "Custom" stays web) ────

private enum class FinPreset(val label: String) {
    TODAY("Today"),
    YESTERDAY("Yesterday"),
    LAST7("Last 7 days"),
    LAST30("Last 30 days"),
    THIS_MONTH("This month"),
    LAST_MONTH("Last month");

    /** Inclusive yyyy-MM-dd range in Asia/Dhaka — mirrors the web getDatePresetRange. */
    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = tz }
        val cal = Calendar.getInstance(tz)
        val today = fmt.format(cal.time)
        fun d() = fmt.format(cal.time)
        return when (this) {
            TODAY -> today to today
            YESTERDAY -> {
                cal.add(Calendar.DAY_OF_YEAR, -1)
                d() to d()
            }
            LAST7 -> {
                cal.add(Calendar.DAY_OF_YEAR, -6)
                d() to today
            }
            LAST30 -> {
                cal.add(Calendar.DAY_OF_YEAR, -29)
                d() to today
            }
            THIS_MONTH -> {
                cal.set(Calendar.DAY_OF_MONTH, 1)
                d() to today
            }
            LAST_MONTH -> {
                cal.set(Calendar.DAY_OF_MONTH, 1)
                cal.add(Calendar.DAY_OF_YEAR, -1)          // prev month's last day
                val end = d()
                cal.set(Calendar.DAY_OF_MONTH, 1)          // prev month's first day
                d() to end
            }
        }
    }
}

// ── State holder (iOS FinanceVM twin) ─────────────────────────────────────────────────

private class FinanceState {
    var periodLabel by mutableStateOf<String?>(null)
    var monthly by mutableStateOf(listOf<FinMonthlyPoint>())
    var profitLoss by mutableStateOf<FinProfitLoss?>(null)
    var cashflow by mutableStateOf<FinCashflow?>(null)
    var kpis by mutableStateOf<FinHRKpis?>(null)
    var preset by mutableStateOf(FinPreset.LAST30)   // web default (DateRangeContext 'last30')
    var loading by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    /** Flat payload on the web, but tolerate an {ok,data:{…}} wrap too (iOS decoder parity). */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val (start, end) = preset.range()
            val q = mapOf(
                "business_id" to BUSINESS_ID,
                "startDate" to start,
                "endDate" to end,
            )
            val r = unwrap(AlmaApi.getObject("/api/finance/report", q))
            periodLabel = r.str("period_label")
            monthly = r.optJSONArray("monthly_revenue")?.mapObjects { m ->
                FinMonthlyPoint(
                    month = m.str("month") ?: "",
                    revenue = m.flexInt("revenue") ?: 0,
                    profit = m.flexInt("profit") ?: 0,
                    expenses = m.flexInt("expenses") ?: 0,
                )
            } ?: emptyList()
            profitLoss = r.optJSONObject("profit_loss")?.let {
                FinProfitLoss(
                    revenue = it.flexInt("revenue") ?: 0,
                    cogs = it.flexInt("cogs") ?: 0,
                    expenses = it.flexInt("expenses") ?: 0,
                    netProfit = it.flexInt("net_profit") ?: 0,
                    marginPct = it.flexDouble("margin_pct") ?: 0.0,
                )
            }
            cashflow = r.optJSONObject("cashflow")?.let {
                FinCashflow(
                    inflow = it.flexInt("inflow") ?: 0,
                    outflow = it.flexInt("outflow") ?: 0,
                    net = it.flexInt("net") ?: 0,
                )
            }
            val h = unwrap(AlmaApi.getObject("/api/hr/dashboard", q))
            kpis = h.optJSONObject("kpis")?.let {
                FinHRKpis(
                    totalMonthlySalary = it.flexInt("total_monthly_salary") ?: 0,
                    unpaidSalaryHint = it.flexInt("unpaid_salary_hint") ?: 0,
                    advanceOutstanding = it.flexInt("advance_outstanding") ?: 0,
                    orderGrossProfit = it.flexInt("order_gross_profit"),
                    netBusinessProfitHint = it.flexInt("net_business_profit_hint"),
                    periodSalaryPaid = it.flexInt("period_salary_paid"),
                    periodAdvances = it.flexInt("period_advances"),
                    totalExpenses = it.flexInt("total_expenses") ?: 0,
                )
            }
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
    }

    companion object {
        /** The same business the other native tabs scope to (web _businessId default). */
        const val BUSINESS_ID = "ALMA_LIFESTYLE"
    }
}

// ── Screen ────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FinanceScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { FinanceState() }
    val scope = rememberCoroutineScope()
    var selectedMonth by remember { mutableStateOf<FinMonthlyPoint?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Date preset chips (web DateRangeFilter).
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FinPreset.entries.forEach { p ->
                    FinanceChip(p.label, vm.preset == p, dark) {
                        vm.preset = p
                        scope.launch { vm.load() }
                    }
                }
            }
        }
        if (vm.authExpired) {
            item { FinAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { FinNoticeCard("⚠️ $it", FinancePalette.red500, dark) } }

        if (vm.loading && !vm.loaded) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            item { FinHeroCard(vm) }
            item { FinStatGrid(vm, dark) }
            item { FinTrendCard(vm, dark) { selectedMonth = it } }
            item { FinCashflowCard(vm.cashflow, dark) }
            item { FinPayrollSnapshotCard(vm.kpis, dark) }
            item {
                // Quick links — every target has a full native screen, so route native
                // (openSmart falls back to web only if a native screen is missing).
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    FinQuickLink("Expenses", "খরচ যোগ ও তালিকা — নেটিভ", Icons.Filled.Payments, dark) {
                        ctx.openSmart("/expenses", "Expenses")
                    }
                    FinQuickLink("Office Fund", "অফিস ফান্ড — নেটিভ", Icons.Filled.AccountBalance, dark) {
                        ctx.openSmart("/finance/office-fund", "Office Fund")
                    }
                    FinQuickLink("পাওনা-দেনা", "ব্যক্তিগত লেনদেনের খাতা — নেটিভ", Icons.Filled.Handshake, dark) {
                        ctx.openSmart("/finance/personal-ledger", "পাওনা-দেনা")
                    }
                    FinQuickLink("Payroll", "বেতন ও অ্যাডভান্স — নেটিভ", Icons.Filled.Group, dark) {
                        ctx.openSmart("/payroll", "Payroll")
                    }
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selectedMonth?.let { p ->
        ModalBottomSheet(onDismissRequest = { selectedMonth = null }, containerColor = AlmaTheme.rootBg(dark)) {
            FinMonthDetailSheet(p, dark) { selectedMonth = null }
        }
    }
}

// ── KPI bento board (dark hero anchor + 2×2 glass tiles — same numbers/tints as web) ──

@Composable
private fun FinHeroCard(vm: FinanceState) {
    val pl = vm.profitLoss
    val k = vm.kpis
    val revenue = pl?.revenue
    val expenses = pl?.expenses ?: k?.totalExpenses
    val netProfit = pl?.netProfit ?: k?.netBusinessProfitHint
    val marginPct = pl?.let { Math.round(it.marginPct).toInt() }
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)

    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(FIN_HERO_BASE)
            .drawBehind {
                // Violet wash from the top-left, coral from the bottom-right, sage hint
                // top-right — the Dashboard hero recipe (ALMA palette only).
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                        start = Offset.Zero,
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    )
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(Color.Transparent, FinancePalette.coral.copy(alpha = 0.30f)),
                        start = Offset(size.width * 0.5f, size.height * 0.5f),
                        end = Offset(size.width, size.height),
                    )
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.05f),
                        radius = 220.dp.toPx(),
                    )
                )
            }
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "মোট আয় · REVENUE (RANGE)",
            color = FinancePalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        Text(
            revenue?.let { AlmaTheme.takaShort(it) } ?: "—",
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "এই রেঞ্জের বিক্রি",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            FinHeroStat(
                "Net profit", netProfit?.let { AlmaTheme.takaShort(it) },
                if ((netProfit ?: 0) < 0) FinancePalette.red500 else FinancePalette.green400,
                "খরচ বাদে",
            )
            FinHeroDivider()
            FinHeroStat("Expenses", expenses?.let { AlmaTheme.takaShort(it) }, Color.White, "এই রেঞ্জে")
            FinHeroDivider()
            FinHeroStat("Margin", marginPct?.let { "$it%" }, Color.White, "মুনাফার হার")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun FinHeroDivider() {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(42.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun FinHeroStat(label: String, value: String?, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(value ?: "—", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun FinStatGrid(vm: FinanceState, dark: Boolean) {
    val k = vm.kpis
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FinStatTile(
                "Payroll budget", k?.totalMonthlySalary?.let { AlmaTheme.takaShort(it) },
                "মাসিক বেতন বাজেট", AlmaTheme.ink(dark), AlmaTheme.violet, dark, Modifier.weight(1f),
            )
            FinStatTile(
                "Unpaid / due (roll)", k?.unpaidSalaryHint?.let { AlmaTheme.takaShort(it) },
                "বকেয়া / ডিউ",
                if ((k?.unpaidSalaryHint ?: 0) > 0) FinancePalette.amber600 else AlmaTheme.ink(dark),
                FinancePalette.amber500, dark, Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FinStatTile(
                "Advances out", k?.advanceOutstanding?.let { AlmaTheme.takaShort(it) },
                "অ্যাডভান্স বাকি", AlmaTheme.ink(dark), FinancePalette.coral, dark, Modifier.weight(1f),
            )
            FinStatTile(
                "Order gross profit", k?.orderGrossProfit?.let { AlmaTheme.takaShort(it) },
                "অর্ডার গ্রস প্রফিট",
                FinancePalette.signed(k?.orderGrossProfit ?: 0, dark),
                AlmaTheme.sage, dark, Modifier.weight(1f),
            )
        }
    }
}

/** Small glass stat tile — value + sub line over a soft diagonal accent wash. */
@Composable
private fun FinStatTile(
    label: String,
    value: String?,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(
                    listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
                shape,
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text(value ?: "—", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Revenue & margin trend (native bars; tap a month → detail sheet) ─────────────────

@Composable
private fun FinTrendCard(vm: FinanceState, dark: Boolean, onSelect: (FinMonthlyPoint) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Revenue & margin trend", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(
            vm.periodLabel ?: vm.preset.label,
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )
        if (vm.monthly.isNotEmpty()) {
            FinTrendBars(vm.monthly, dark, onSelect)
            Row(
                Modifier.padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                FinLegendDot(FinancePalette.coral, "Revenue", dark)
                FinLegendDot(FinancePalette.positive(dark), "Profit", dark)
                Spacer(Modifier.weight(1f))
                Text("মাস চাপলে বিস্তারিত", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        } else {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 26.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("◩", color = AlmaTheme.inkSecondary(dark), fontSize = 20.sp)
                Text("No range data", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Adjust the date filter or add orders / invoices",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }
    }
}

@Composable
private fun FinLegendDot(color: Color, label: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
    }
}

/** Native re-set of the web MonthlyRevenueChart — gradient revenue bar + profit inner bar. */
@Composable
private fun FinTrendBars(points: List<FinMonthlyPoint>, dark: Boolean, onSelect: (FinMonthlyPoint) -> Unit) {
    val maxRevenue = maxOf(points.maxOfOrNull { it.revenue } ?: 1, 1)
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(top = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        points.forEach { p ->
            val h = maxOf(p.revenue.toFloat() / maxRevenue * 120f, 3f)
            val ph = if (p.revenue > 0 && p.profit > 0) {
                maxOf(p.profit.toFloat() / maxRevenue * 120f, 3f)
            } else 0f
            Column(
                Modifier.plainClick { onSelect(p) },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    AlmaTheme.takaShort(p.revenue),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 8.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                Box(Modifier.height(124.dp), contentAlignment = Alignment.BottomCenter) {
                    Box(
                        Modifier
                            .width(26.dp)
                            .height(h.dp)
                            .background(
                                Brush.verticalGradient(listOf(FinancePalette.goldLt, FinancePalette.coral)),
                                RoundedCornerShape(5.dp),
                            ),
                    )
                    if (ph > 0f) {
                        Box(
                            Modifier
                                .width(10.dp)
                                .height(ph.dp)
                                .background(
                                    FinancePalette.positive(dark).copy(alpha = 0.9f),
                                    RoundedCornerShape(3.dp),
                                ),
                        )
                    }
                }
                Text(
                    FinanceFormat.monthShort(p.month),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// ── Cashflow (report) + Payroll snapshot — web card parity ───────────────────────────

@Composable
private fun FinCashflowCard(cf: FinCashflow?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Cashflow (report)", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        FinMoneyRow("Inflow", cf?.inflow, dark)
        FinMoneyRow("Outflow", cf?.outflow, dark)
        HorizontalDivider(color = AlmaTheme.separator(dark), thickness = 1.dp)
        Row {
            Text(
                "Net",
                color = FinancePalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
            Text(
                fullTaka(cf?.net),
                color = FinancePalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun FinPayrollSnapshotCard(k: FinHRKpis?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Payroll snapshot", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        FinMoneyRow("Period salary paid", k?.periodSalaryPaid, dark)
        FinMoneyRow("Period advances", k?.periodAdvances, dark)
        HorizontalDivider(color = AlmaTheme.separator(dark), thickness = 1.dp)
        Row {
            Text("Ledger expenses", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
            Spacer(Modifier.weight(1f))
            Text(
                fullTaka(k?.totalExpenses),
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun FinMoneyRow(label: String, amount: Int?, dark: Boolean) {
    Row {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Text(
            fullTaka(amount),
            color = AlmaTheme.ink(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        )
    }
}

private fun fullTaka(amount: Int?): String = amount?.let { AlmaTheme.taka(it) } ?: "—"

// ── Quick links ───────────────────────────────────────────────────────────────────────

@Composable
private fun FinQuickLink(
    title: String,
    subtitle: String,
    icon: ImageVector,
    dark: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick(onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(34.dp)
                .background(
                    Brush.linearGradient(listOf(FinancePalette.coral, AlmaTheme.violet)),
                    RoundedCornerShape(10.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Icon(
            Icons.Filled.ChevronRight, contentDescription = null,
            tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(18.dp),
        )
    }
}

// ── Month detail sheet (tap a trend bar — view-only breakdown) ───────────────────────

@Composable
private fun FinMonthDetailSheet(p: FinMonthlyPoint, dark: Boolean, onDone: () -> Unit) {
    val margin = if (p.revenue > 0) Math.round(p.profit.toDouble() / p.revenue * 100).toInt() else 0
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                FinanceFormat.monthLong(p.month),
                color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
            )
            Text("মাসিক আয়-ব্যয়ের বিবরণ", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FinDetailRow("Revenue", p.revenue, AlmaTheme.ink(dark), dark)
            FinDetailRow("Expenses", p.expenses, AlmaTheme.ink(dark), dark)
            FinDetailRow("Profit", p.profit, FinancePalette.signed(p.profit, dark), dark)
            HorizontalDivider(color = AlmaTheme.separator(dark), thickness = 1.dp)
            Row {
                Text(
                    "MARGIN",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "$margin%",
                    color = FinancePalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        Text(
            "ঠিক আছে",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(FinancePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick(onDone)
                .padding(vertical = 11.dp),
        )
    }
}

@Composable
private fun FinDetailRow(label: String, amount: Int, tint: Color, dark: Boolean) {
    Row {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
        )
        Spacer(Modifier.weight(1f))
        Text(
            AlmaTheme.taka(amount),
            color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Shared bits ───────────────────────────────────────────────────────────────────────

@Composable
private fun FinanceChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) FinancePalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) FinancePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) FinancePalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun FinNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun FinAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(FinancePalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers (iOS FinanceFormat twin) ───────────────────────────────────────

private object FinanceFormat {
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
