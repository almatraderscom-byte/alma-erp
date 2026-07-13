//
//  TradingAnalyticsScreen.kt
//  ALMA ERP — the ALMA Trading analytics page (/trading/analytics), ported 1:1 from
//  TradingAnalyticsSwiftUI.swift (read-only).
//
//  Endpoints (same as web/iOS):
//    GET /api/trading/analytics?startDate=…&endDate=…&staffId=…&accountId=…
//                              &status=…&profitability=…            → analytics
//    GET /api/trading/accounts?status=ALL   → account picker options
//    GET /api/trading/staff                 → staff picker options
//  Blocks: date preset chips · staff/account/status/profitability menus · managed-
//  capital hero (today/weekly/monthly net split) + USDT/fees/expenses/headcount tiles ·
//  Analytics Alerts · 3 trend line charts (Profit #4ade80 · USDT #d6a94a · Expense
//  #f87171) · 4 ranking-bar cards · staff performance list · merchant account
//  intelligence (client-side search, top 20) · expense intelligence bars (top 8).
//  CSV/Excel/PDF exports + custom date/ROI inputs stay on the web escape hatch.
//  Trading hero accent: sage green (owner spec) instead of the coral hero.
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
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
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
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ────────

private object TAPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val amber300 = Color(0xFFFCD34D)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val green300 = Color(0xFF86EFAC)
    val zinc400 = Color(0xFFA1A1AA)

    /** Trading hero accent green (owner spec — ≈ AlmaTheme.sage #81B29A). */
    val tradingGreen = Color(0xFF82B399)

    /** Web trading gold #d6a94a — the USDT volume trend line. */
    val tradingGold = Color(0xFFD6A94A)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web "txt-pos" family — emerald on cream, bright green over dark aurora. */
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600

    /** Web signedClass: value >= 0 → green, else red. */
    fun signed(value: Double, dark: Boolean): Color =
        if (value >= 0) positive(dark) else (if (dark) red400 else red500)

    /** Web statusClass: ACTIVE green-300 · COMPLETED gold-lt · PAUSED amber-300 · else zinc-400. */
    fun status(s: String, dark: Boolean): Color = when (s.uppercase()) {
        "ACTIVE" -> if (dark) green300 else emerald600
        "COMPLETED" -> accentText(dark)
        "PAUSED" -> if (dark) amber300 else amber600
        else -> zinc400
    }

    /** Web AccountIntelRow health tint: HEALTHY green · HIGH_RISK red · else amber. */
    fun health(h: String, dark: Boolean): Color = when (h.uppercase()) {
        "HEALTHY" -> positive(dark)
        "HIGH_RISK" -> if (dark) red400 else red500
        else -> if (dark) amber500 else amber600
    }
}

// ── Models (same field names the web TradingAnalyticsResponse declares) ────────────

private data class TAKpis(
    val totalManagedCapital: Double,
    val todayNet: Double,
    val weeklyNet: Double,
    val monthlyNet: Double,
    val totalUsdtVolume: Double,
    val totalBuyUsdt: Double,
    val totalSellUsdt: Double,
    val totalBinanceFees: Double,
    val totalOperatingExpenses: Double,
    val activeMerchantAccounts: Int,
    val activeStaffCount: Int,
) {
    companion object {
        fun from(o: JSONObject) = TAKpis(
            totalManagedCapital = o.flexDouble("totalManagedCapital") ?: 0.0,
            todayNet = o.flexDouble("todayNet") ?: 0.0,
            weeklyNet = o.flexDouble("weeklyNet") ?: 0.0,
            monthlyNet = o.flexDouble("monthlyNet") ?: 0.0,
            totalUsdtVolume = o.flexDouble("totalUsdtVolume") ?: 0.0,
            totalBuyUsdt = o.flexDouble("totalBuyUsdt") ?: 0.0,
            totalSellUsdt = o.flexDouble("totalSellUsdt") ?: 0.0,
            totalBinanceFees = o.flexDouble("totalBinanceFees") ?: 0.0,
            totalOperatingExpenses = o.flexDouble("totalOperatingExpenses") ?: 0.0,
            activeMerchantAccounts = o.flexInt("activeMerchantAccounts") ?: 0,
            activeStaffCount = o.flexInt("activeStaffCount") ?: 0,
        )
    }
}

/** Account analytics row (topProfitable/topLoss/bestSpread/highestExpense/reportRows). */
private data class TAAccountRow(
    val id: String,
    val accountTitle: String,
    val assignedUserName: String,
    val status: String,
    val netProfit: Double,
    val roi: Double,
    val averageSpread: Double,
    val feeRatio: Double,
    val totalExpenses: Double,
    val totalUsdt: Double,
    val health: String,
) {
    companion object {
        fun from(o: JSONObject): TAAccountRow {
            val title = o.str("accountTitle") ?: "—"
            return TAAccountRow(
                id = o.str("id") ?: title,
                accountTitle = title,
                assignedUserName = o.str("assignedUserName") ?: "Unassigned",
                status = o.str("status") ?: "ACTIVE",
                netProfit = o.flexDouble("netProfit") ?: 0.0,
                roi = o.flexDouble("roi") ?: 0.0,
                averageSpread = o.flexDouble("averageSpread") ?: 0.0,
                feeRatio = o.flexDouble("feeRatio") ?: 0.0,
                totalExpenses = o.flexDouble("totalExpenses") ?: 0.0,
                totalUsdt = o.flexDouble("totalUsdt") ?: 0.0,
                health = o.str("health") ?: "HEALTHY",
            )
        }
    }
}

private data class TAStaffRow(
    val userId: String,
    val name: String,
    val assignedAccounts: Int,
    val activeAccounts: Int,
    val totalTradedUsdt: Double,
    val totalProfitGenerated: Double,
    val totalLossGenerated: Double,
    val feeEfficiency: Double,
    val roiContribution: Double,
) {
    companion object {
        fun from(o: JSONObject): TAStaffRow {
            val n = o.str("name") ?: "—"
            return TAStaffRow(
                userId = o.str("userId") ?: n,
                name = n,
                assignedAccounts = o.flexInt("assignedAccounts") ?: 0,
                activeAccounts = o.flexInt("activeAccounts") ?: 0,
                totalTradedUsdt = o.flexDouble("totalTradedUsdt") ?: 0.0,
                totalProfitGenerated = o.flexDouble("totalProfitGenerated") ?: 0.0,
                totalLossGenerated = o.flexDouble("totalLossGenerated") ?: 0.0,
                feeEfficiency = o.flexDouble("feeEfficiency") ?: 0.0,
                roiContribution = o.flexDouble("roiContribution") ?: 0.0,
            )
        }
    }
}

/** Trend point — the web charts read netBdt / usdtVolume / expenseBdt per day. */
private data class TATrendPoint(
    val date: String,
    val netBdt: Double,
    val usdtVolume: Double,
    val expenseBdt: Double,
) {
    companion object {
        fun from(o: JSONObject) = TATrendPoint(
            date = o.str("date") ?: "",
            netBdt = o.flexDouble("netBdt") ?: 0.0,
            usdtVolume = o.flexDouble("usdtVolume") ?: 0.0,
            expenseBdt = o.flexDouble("expenseBdt") ?: 0.0,
        )
    }
}

private data class TAAlert(
    val severity: String,
    val type: String,
    val accountId: String,
    val accountTitle: String,
    val message: String,
) {
    companion object {
        fun from(o: JSONObject) = TAAlert(
            severity = o.str("severity") ?: "NORMAL",
            type = o.str("type") ?: "ALERT",
            accountId = o.str("accountId") ?: "",
            accountTitle = o.str("accountTitle") ?: "—",
            message = o.str("message") ?: "",
        )
    }
}

private data class TAExpenseCat(val type: String, val amount: Double) {
    companion object {
        fun from(o: JSONObject) = TAExpenseCat(
            type = o.str("type") ?: "—",
            amount = o.flexDouble("amount") ?: 0.0,
        )
    }
}

/** GET /api/trading/analytics — flat payload; the {ok,data:{…}} wrap is unwrapped by the caller. */
private data class TAPayload(
    val kpis: TAKpis?,
    val topProfitableAccounts: List<TAAccountRow>,
    val topLossAccounts: List<TAAccountRow>,
    val bestSpreadAccounts: List<TAAccountRow>,
    val highestExpenseAccounts: List<TAAccountRow>,
    val staff: List<TAStaffRow>,
    val expenseCategories: List<TAExpenseCat>,
    val trend: List<TATrendPoint>,
    val alerts: List<TAAlert>,
    val reportRows: List<TAAccountRow>,
) {
    companion object {
        fun from(c: JSONObject) = TAPayload(
            kpis = c.optJSONObject("kpis")?.let { TAKpis.from(it) },
            topProfitableAccounts = c.optJSONArray("topProfitableAccounts")?.mapObjects { TAAccountRow.from(it) } ?: emptyList(),
            topLossAccounts = c.optJSONArray("topLossAccounts")?.mapObjects { TAAccountRow.from(it) } ?: emptyList(),
            bestSpreadAccounts = c.optJSONArray("bestSpreadAccounts")?.mapObjects { TAAccountRow.from(it) } ?: emptyList(),
            highestExpenseAccounts = c.optJSONArray("highestExpenseAccounts")?.mapObjects { TAAccountRow.from(it) } ?: emptyList(),
            staff = c.optJSONArray("staff")?.mapObjects { TAStaffRow.from(it) } ?: emptyList(),
            expenseCategories = c.optJSONArray("expenseCategories")?.mapObjects { TAExpenseCat.from(it) } ?: emptyList(),
            trend = c.optJSONArray("trend")?.mapObjects { TATrendPoint.from(it) } ?: emptyList(),
            alerts = c.optJSONArray("alerts")?.mapObjects { TAAlert.from(it) } ?: emptyList(),
            reportRows = c.optJSONArray("reportRows")?.mapObjects { TAAccountRow.from(it) } ?: emptyList(),
        )
    }
}

/** Picker option — /api/trading/accounts rows carry accountTitle, /api/trading/staff rows carry name. */
private data class TAOption(val id: String, val label: String) {
    companion object {
        fun from(o: JSONObject): TAOption? {
            val id = o.str("id") ?: return null
            return TAOption(id, o.str("accountTitle") ?: o.str("name") ?: "—")
        }
    }
}

// ── Date presets (web default: startDate = today−29d, endDate = today; custom
//    date inputs stay on the web escape hatch). All maths in Asia/Dhaka. ────────────

private enum class TAPreset(val label: String) {
    LAST7("Last 7 days"),
    LAST30("Last 30 days"),
    THIS_MONTH("This month"),
    LAST_MONTH("Last month"),
    LAST90("Last 90 days");

    /** Inclusive yyyy-MM-dd range. LAST30 reproduces the web default exactly. */
    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val today = Calendar.getInstance(tz)
        fun ymd(c: Calendar): String = String.format(
            Locale.US, "%04d-%02d-%02d",
            c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH),
        )
        fun shifted(days: Int): Calendar =
            (today.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, days) }
        return when (this) {
            LAST7 -> ymd(shifted(-6)) to ymd(today)
            LAST30 -> ymd(shifted(-29)) to ymd(today)
            THIS_MONTH -> {
                val s = (today.clone() as Calendar).apply { set(Calendar.DAY_OF_MONTH, 1) }
                ymd(s) to ymd(today)
            }
            LAST_MONTH -> {
                val prevEnd = (today.clone() as Calendar).apply {
                    set(Calendar.DAY_OF_MONTH, 1)
                    add(Calendar.DAY_OF_MONTH, -1)
                }
                val prevStart = (prevEnd.clone() as Calendar).apply { set(Calendar.DAY_OF_MONTH, 1) }
                ymd(prevStart) to ymd(prevEnd)
            }
            LAST90 -> ymd(shifted(-89)) to ymd(today)
        }
    }
}

/** Web status Select options (minus the picker-only "All"). */
private val TA_STATUSES = listOf("ACTIVE", "PAUSED", "COMPLETED", "CLOSED")

// ── Formatting helpers (iOS TradingAnalyticsFormat twins) ──────────────────────────

private object TAFormat {
    /** Whole-taka short money (৳1.2L style via the shared theme helper). */
    fun taka(v: Double): String = AlmaTheme.takaShort(v.roundToLong())

    /** USDT amounts — whole numbers with a suffix (web toLocaleString + USDT). */
    fun usdt(v: Double): String = String.format(Locale.US, "%,d USDT", v.roundToLong())

    /** Full signed number, no decimals (web toLocaleString('en-BD')). */
    fun num(v: Double): String = String.format(Locale.US, "%,d", v.roundToLong())

    /** Web RankingBars value: up to 2 fraction digits. */
    fun num2(v: Double): String =
        String.format(Locale.US, "%,.2f", v).trimEnd('0').trimEnd('.')

    /** Signed percent with 2 decimals (web roiContribution.toFixed(2) + '%'). */
    fun pct(v: Double): String = String.format(Locale.US, "%.2f%%", v)

    /** "2026-07-03" → "3 Jul". */
    fun dayShort(ymd: String): String {
        val parts = ymd.take(10).split("-")
        if (parts.size < 3) return ymd
        val m = parts[1].toIntOrNull() ?: return ymd
        val d = parts[2].toIntOrNull() ?: return ymd
        if (m !in 1..12) return ymd
        val names = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
        return "$d ${names[m - 1]}"
    }
}

// ── State holder (iOS TradingAnalyticsVM twin) ─────────────────────────────────────

private class TradingAnalyticsState {
    var data by mutableStateOf<TAPayload?>(null)
    var preset by mutableStateOf(TAPreset.LAST30)   // web default (today−29d … today)
    var staffId by mutableStateOf<String?>(null)    // web default '' (all staff)
    var accountId by mutableStateOf<String?>(null)  // web default '' (all accounts)
    var status by mutableStateOf("ALL")             // web default 'ALL'
    var profitability by mutableStateOf("ALL")      // web default 'ALL'
    var search by mutableStateOf("")                // client-side, like the web
    var accountOptions by mutableStateOf(listOf<TAOption>())
    var staffOptions by mutableStateOf(listOf<TAOption>())
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            val (start, end) = preset.range()
            val root = AlmaApi.getObject(
                "/api/trading/analytics",
                mapOf(
                    "startDate" to start,
                    "endDate" to end,
                    "staffId" to staffId,
                    "accountId" to accountId,
                    "status" to status,
                    "profitability" to profitability,
                ),
            )
            data = TAPayload.from(root.optJSONObject("data") ?: root)
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Picker options — same lookups the web page mounts (accounts?status=ALL + staff). */
    suspend fun loadOptions() {
        accountOptions = try {
            val r = AlmaApi.getObject("/api/trading/accounts", mapOf("status" to "ALL"))
            (r.optJSONObject("data") ?: r).optJSONArray("accounts")
                ?.mapObjects { TAOption.from(it) } ?: emptyList()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
        staffOptions = try {
            val r = AlmaApi.getObject("/api/trading/staff")
            (r.optJSONObject("data") ?: r).optJSONArray("staff")
                ?.mapObjects { TAOption.from(it) } ?: emptyList()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Web searchedRows: needle over accountTitle / assignedUserName / health / status. */
    val searchedRows: List<TAAccountRow>
        get() {
            val rows = data?.reportRows ?: emptyList()
            val needle = search.trim().lowercase()
            if (needle.isEmpty()) return rows
            return rows.filter { r ->
                listOf(r.accountTitle, r.assignedUserName, r.health, r.status)
                    .any { it.lowercase().contains(needle) }
            }
        }

    val maxExpenseCategory: Double
        get() = maxOf(data?.expenseCategories?.maxOfOrNull { it.amount } ?: 1.0, 1.0)
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradingAnalyticsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { TradingAnalyticsState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        launch { vm.loadOptions() }
        vm.load()
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Date preset chips (web date inputs, re-set as native presets).
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TAPreset.entries.forEach { p ->
                    TAChip(p.label, vm.preset == p, dark) {
                        vm.preset = p
                        scope.launch { vm.load() }
                    }
                }
            }
        }
        item {
            // Filter menus (web Selects: staff · account · status · profitability).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TAMenuChip(
                    label = vm.staffId?.let { id -> vm.staffOptions.firstOrNull { it.id == id }?.label } ?: "All staff",
                    active = vm.staffId != null, dark = dark,
                    options = listOf<Pair<String, () -> Unit>>(
                        "All staff" to { vm.staffId = null; scope.launch { vm.load() } },
                    ) + vm.staffOptions.map { s ->
                        s.label to { vm.staffId = s.id; scope.launch { vm.load() }; Unit }
                    },
                )
                TAMenuChip(
                    label = vm.accountId?.let { id -> vm.accountOptions.firstOrNull { it.id == id }?.label } ?: "All accounts",
                    active = vm.accountId != null, dark = dark,
                    options = listOf<Pair<String, () -> Unit>>(
                        "All accounts" to { vm.accountId = null; scope.launch { vm.load() } },
                    ) + vm.accountOptions.map { a ->
                        a.label to { vm.accountId = a.id; scope.launch { vm.load() }; Unit }
                    },
                )
                TAMenuChip(
                    label = if (vm.status == "ALL") "All status"
                    else vm.status.lowercase().replaceFirstChar { it.uppercase() },
                    active = vm.status != "ALL", dark = dark,
                    options = listOf<Pair<String, () -> Unit>>(
                        "All status" to { vm.status = "ALL"; scope.launch { vm.load() } },
                    ) + TA_STATUSES.map { s ->
                        s.lowercase().replaceFirstChar { it.uppercase() } to {
                            vm.status = s; scope.launch { vm.load() }; Unit
                        }
                    },
                )
                TAMenuChip(
                    label = when (vm.profitability) {
                        "PROFIT" -> "Profitable"
                        "LOSS" -> "Loss"
                        else -> "All P/L"
                    },
                    active = vm.profitability != "ALL", dark = dark,
                    options = listOf<Pair<String, () -> Unit>>(
                        "All P/L" to { vm.profitability = "ALL"; scope.launch { vm.load() } },
                        "Profitable" to { vm.profitability = "PROFIT"; scope.launch { vm.load() } },
                        "Loss" to { vm.profitability = "LOSS"; scope.launch { vm.load() } },
                    ),
                )
            }
        }
        if (vm.authExpired) {
            item { TAAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { err ->
            item {
                Text(
                    "⚠ $err", color = TAPalette.red500, fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                )
            }
        }
        if (vm.loading && vm.data == null) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            // ── KPI board (web's 11 KpiCards in the bento language) ──
            item { TAHeroCard(vm.data?.kpis) }
            item {
                val k = vm.data?.kpis
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TAStatTile(
                        "USDT Volume", k?.let { TAFormat.usdt(it.totalUsdtVolume) }, "মোট ভলিউম",
                        AlmaTheme.ink(dark), TAPalette.tradingGold, dark, Modifier.weight(1f),
                    )
                    TAStatTile(
                        "Binance Fees", k?.let { TAFormat.taka(it.totalBinanceFees) }, "ফি খরচ",
                        if (dark) TAPalette.amber500 else TAPalette.amber600,
                        TAPalette.amber500, dark, Modifier.weight(1f),
                    )
                }
            }
            item {
                val k = vm.data?.kpis
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TAStatTile(
                        "Buy USDT", k?.let { TAFormat.usdt(it.totalBuyUsdt) }, "কেনা",
                        AlmaTheme.ink(dark), TAPalette.tradingGreen, dark, Modifier.weight(1f),
                    )
                    TAStatTile(
                        "Sell USDT", k?.let { TAFormat.usdt(it.totalSellUsdt) }, "বেচা",
                        AlmaTheme.ink(dark), AlmaTheme.violet, dark, Modifier.weight(1f),
                    )
                }
            }
            item {
                val k = vm.data?.kpis
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TAStatTile(
                        "Op Expenses", k?.let { TAFormat.taka(it.totalOperatingExpenses) }, "অপারেটিং খরচ",
                        if (dark) TAPalette.red400 else TAPalette.red500,
                        TAPalette.red500, dark, Modifier.weight(1f),
                    )
                    TAStatTile(
                        "Merchants", k?.activeMerchantAccounts?.toString(), "অ্যাক্টিভ অ্যাকাউন্ট",
                        AlmaTheme.ink(dark), TAPalette.tradingGold, dark, Modifier.weight(1f),
                    )
                    TAStatTile(
                        "Staff", k?.activeStaffCount?.toString(), "অ্যাক্টিভ স্টাফ",
                        AlmaTheme.ink(dark), TAPalette.tradingGreen, dark, Modifier.weight(1f),
                    )
                }
            }

            // ── Analytics Alerts (web tone-red card) ──
            val alerts = vm.data?.alerts ?: emptyList()
            if (alerts.isNotEmpty()) {
                item { TAAlertsCard(alerts, dark) }
            }

            // ── Trend charts (web MiniTrendChart ×3 — same series, same hexes) ──
            val trend = vm.data?.trend ?: emptyList()
            item {
                TATrendCard(
                    "Profit Trend", trend.map { it.netBdt }, trend.map { it.date },
                    TAPalette.green400, isUsdt = false, dark = dark,
                )
            }
            item {
                TATrendCard(
                    "USDT Volume Trend", trend.map { it.usdtVolume }, trend.map { it.date },
                    TAPalette.tradingGold, isUsdt = true, dark = dark,
                )
            }
            item {
                TATrendCard(
                    "Expense Trend", trend.map { it.expenseBdt }, trend.map { it.date },
                    TAPalette.red400, isUsdt = false, dark = dark,
                )
            }

            // ── Ranking cards (web RankingBars ×4 — signed green/red bars, top 8) ──
            item {
                TARankingCard(
                    "Top Profitable Accounts",
                    (vm.data?.topProfitableAccounts ?: emptyList()).map { it.accountTitle to it.netProfit },
                    prefix = "৳", suffix = "", dark = dark,
                )
            }
            item {
                TARankingCard(
                    "Top Loss Accounts",
                    (vm.data?.topLossAccounts ?: emptyList()).map { it.accountTitle to it.netProfit },
                    prefix = "৳", suffix = "", dark = dark,
                )
            }
            item {
                TARankingCard(
                    "Best Spread Performance",
                    (vm.data?.bestSpreadAccounts ?: emptyList()).map { it.accountTitle to it.averageSpread },
                    prefix = "", suffix = " BDT", dark = dark,
                )
            }
            item {
                TARankingCard(
                    "Highest Expense Accounts",
                    (vm.data?.highestExpenseAccounts ?: emptyList()).map { it.accountTitle to it.totalExpenses },
                    prefix = "৳", suffix = "", dark = dark,
                )
            }

            // ── Staff Performance Analytics (web ranked list) ──
            item { TAStaffCard(vm.data?.staff ?: emptyList(), dark) }

            // ── Merchant Account Intelligence (client-side search, top 20) ──
            item { TAAccountIntelCard(vm, dark) }

            // ── Expense Intelligence (web red bar list, top 8) ──
            item { TAExpenseIntelCard(vm.data?.expenseCategories ?: emptyList(), vm.maxExpenseCategory, dark) }
        }
        item {
            Text(
                "🌐 সব অপশন — ওয়েবে খুলুন (CSV/Excel/PDF এক্সপোর্ট)",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/trading/analytics", "Trading analytics") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

// ── Chips (trading-green accent — iOS chip/menuChip twins) ─────────────────────────

@Composable
private fun TAChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) TAPalette.tradingGreen else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        maxLines = 1,
        modifier = Modifier
            .background(
                if (active) TAPalette.tradingGreen.copy(alpha = if (dark) 0.25f else 0.15f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) TAPalette.tradingGreen.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun TAMenuChip(
    label: String,
    active: Boolean,
    dark: Boolean,
    options: List<Pair<String, () -> Unit>>,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            modifier = Modifier
                .background(
                    if (active) TAPalette.tradingGreen.copy(alpha = if (dark) 0.22f else 0.14f)
                    else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                    CircleShape,
                )
                .border(
                    1.dp,
                    if (active) TAPalette.tradingGreen.copy(alpha = 0.55f)
                    else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                    CircleShape,
                )
                .plainClick { expanded = true }
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                label,
                color = if (active) TAPalette.tradingGreen else AlmaTheme.inkSecondary(dark),
                fontSize = 13.sp,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                "▾",
                color = if (active) TAPalette.tradingGreen else AlmaTheme.inkSecondary(dark),
                fontSize = 9.sp, fontWeight = FontWeight.Bold,
            )
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (l, act) ->
                DropdownMenuItem(
                    text = { Text(l, fontSize = 13.sp) },
                    onClick = { expanded = false; act() },
                )
            }
        }
    }
}

// ── Auth card ──────────────────────────────────────────────────────────────────────

@Composable
private fun TAAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(TAPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Hero card (dark in BOTH themes — trading-green tint, managed-capital anchor) ───

@Composable
private fun TAHeroCard(k: TAKpis?) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape),
    ) {
        Canvas(Modifier.matchParentSize()) {
            // Deep trading-green base + green/violet washes + gold radial (iOS recipe).
            drawRect(Color(0xFF13201C))
            drawRect(
                Brush.linearGradient(
                    listOf(TAPalette.tradingGreen.copy(alpha = 0.34f), Color.Transparent),
                    start = Offset.Zero, end = Offset(size.width * 0.5f, size.height * 0.5f),
                ),
            )
            drawRect(
                Brush.linearGradient(
                    listOf(AlmaTheme.violet.copy(alpha = 0.22f), Color.Transparent),
                    start = Offset(size.width, size.height),
                    end = Offset(size.width * 0.5f, size.height * 0.5f),
                ),
            )
            drawRect(
                Brush.radialGradient(
                    listOf(TAPalette.tradingGold.copy(alpha = 0.16f), Color.Transparent),
                    center = Offset(size.width * 0.85f, size.height * 0.05f),
                    radius = 220.dp.toPx(),
                ),
            )
        }
        Column(Modifier.padding(16.dp)) {
            Text(
                "ম্যানেজড ক্যাপিটাল · ALMA TRADING",
                color = TAPalette.tradingGreen, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp,
            )
            Text(
                k?.let { AlmaTheme.takaShort(it.totalManagedCapital.roundToLong()) } ?: "—",
                color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
                maxLines = 1,
                modifier = Modifier.padding(top = 8.dp),
            )
            Text(
                "সব মার্চেন্ট অ্যাকাউন্টের মোট মূলধন",
                color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
                modifier = Modifier.padding(top = 5.dp),
            )
            Row(Modifier.padding(top = 14.dp)) {
                TAHeroStat("Today net", k?.todayNet, "আজ")
                TAHeroDivider()
                TAHeroStat("Weekly net", k?.weeklyNet, "৭ দিন")
                TAHeroDivider()
                TAHeroStat("Monthly net", k?.monthlyNet, "৩০ দিন")
                Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun TAHeroDivider() {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(38.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun TAHeroStat(label: String, value: Double?, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(
            value?.let { TAFormat.taka(it) } ?: "—",
            // Web signedClass on the dark hero: green-400 / red-400.
            color = if ((value ?: 0.0) >= 0) TAPalette.green400 else TAPalette.red400,
            fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1,
            fontFamily = FontFamily.Monospace,
        )
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Stat tile (glass + soft diagonal accent wash — iOS bento tile twin) ────────────

@Composable
private fun TAStatTile(
    label: String,
    value: String?,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(
                    listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text(
            value ?: "—",
            color = tint, fontSize = 16.sp, fontWeight = FontWeight.Black,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Analytics Alerts (web tone-red card) ───────────────────────────────────────────

@Composable
private fun TAAlertsCard(alerts: List<TAAlert>, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, TAPalette.red500.copy(alpha = 0.35f), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "Analytics Alerts",
            color = if (dark) TAPalette.red400 else TAPalette.red500,
            fontSize = 13.sp, fontWeight = FontWeight.Bold,
        )
        alerts.forEach { alert ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(
                        Color.White.copy(alpha = if (dark) 0.04f else 0.35f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .border(1.dp, TAPalette.red500.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    "${alert.type} · ${alert.accountTitle}",
                    color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
                Text(alert.message, color = TAPalette.red500, fontSize = 10.sp)
            }
        }
    }
}

// ── Trend line card (native re-set of the web MiniTrendChart SVG polyline) ─────────

@Composable
private fun TATrendCard(
    title: String,
    values: List<Double>,
    labels: List<String>,
    color: Color,
    isUsdt: Boolean,
    dark: Boolean,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            values.lastOrNull()?.let { last ->
                Text(
                    if (isUsdt) TAFormat.usdt(last) else TAFormat.taka(last),
                    color = color, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (values.isEmpty()) {
            Text(
                "No trend data",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 34.dp),
            )
        } else {
            // Same maths as the web SVG: min = min(0, …values), max = max(1, …values),
            // y = 90% − ((v − min) / span) × 80%, baseline at 90%.
            Canvas(Modifier.fillMaxWidth().height(120.dp).padding(top = 8.dp)) {
                val w = size.width
                val h = size.height
                val minV = minOf(0.0, values.min())
                val maxV = maxOf(1.0, values.max())
                val span = if (maxV - minV == 0.0) 1.0 else maxV - minV
                val pts = values.mapIndexed { i, v ->
                    val x = if (values.size <= 1) 0f else w * i / (values.size - 1)
                    val y = h * 0.9f - ((v - minV) / span).toFloat() * h * 0.8f
                    Offset(x, y)
                }
                // Baseline (web: line at y=90, rgba(0,0,0,.06)).
                drawLine(
                    AlmaTheme.ink(dark).copy(alpha = 0.08f),
                    Offset(0f, h * 0.9f), Offset(w, h * 0.9f),
                    strokeWidth = 1.dp.toPx(),
                )
                // Soft area fill under the line — same series colour.
                if (pts.size > 1) {
                    val area = Path().apply {
                        moveTo(pts.first().x, h * 0.9f)
                        lineTo(pts.first().x, pts.first().y)
                        pts.drop(1).forEach { lineTo(it.x, it.y) }
                        lineTo(pts.last().x, h * 0.9f)
                        close()
                    }
                    drawPath(
                        area,
                        Brush.verticalGradient(listOf(color.copy(alpha = 0.22f), color.copy(alpha = 0.02f))),
                    )
                }
                // The polyline (web strokeWidth 2.5, round caps/joins).
                val line = Path().apply {
                    moveTo(pts.first().x, pts.first().y)
                    pts.drop(1).forEach { lineTo(it.x, it.y) }
                }
                drawPath(
                    line, color,
                    style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
                // Point dots (web r=1.8 circles) — thin out on long ranges.
                val step = maxOf(1, pts.size / 30)
                pts.forEachIndexed { i, pt ->
                    if (i % step == 0 || i == pts.lastIndex) {
                        drawCircle(color, radius = 2.dp.toPx(), center = pt)
                    }
                }
            }
            if (labels.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                    Text(
                        TAFormat.dayShort(labels.first()),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        TAFormat.dayShort(labels.last()),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

// ── Ranking bars card (web RankingBars — top 8, signed green/red fills) ────────────

@Composable
private fun TARankingCard(
    title: String,
    rows: List<Pair<String, Double>>,
    prefix: String,
    suffix: String,
    dark: Boolean,
) {
    val shown = rows.take(8)                                            // web .slice(0, 8)
    val maxAbs = maxOf(1.0, shown.maxOfOrNull { abs(it.second) } ?: 1.0) // web Math.max(1, …)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        if (shown.isEmpty()) {
            Text(
                "No data",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 22.dp),
            )
        } else {
            shown.forEach { (label, value) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            label, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text(
                            prefix + TAFormat.num2(value) + suffix,
                            color = TAPalette.signed(value, dark),
                            fontSize = 11.sp, fontWeight = FontWeight.Black,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    TABar(
                        fraction = maxOf(0.04, abs(value) / maxAbs),   // web max(4, …)%
                        color = if (value >= 0) TAPalette.green400 else TAPalette.red400,
                        height = 8, dark = dark,
                    )
                }
            }
        }
    }
}

/** Signed/plain horizontal bar over the muted track (iOS hBar/bar twin). */
@Composable
private fun TABar(fraction: Double, color: Color, height: Int, dark: Boolean) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(height.dp)
            .clip(CircleShape)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.07f)),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0.0, 1.0).toFloat())
                .fillMaxHeight()
                .clip(CircleShape)
                .background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.85f), color))),
        )
    }
}

// ── Empty state block (iOS emptyBlock twin) ────────────────────────────────────────

@Composable
private fun TAEmptyBlock(glyph: String, title: String, desc: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(glyph, color = AlmaTheme.inkSecondary(dark), fontSize = 22.sp)
        Text(title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
    }
}

// ── Staff Performance Analytics (web ranked list — iOS staffCard twin) ─────────────

@Composable
private fun TAStaffCard(staff: List<TAStaffRow>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Staff Performance Analytics", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        if (staff.isEmpty()) {
            TAEmptyBlock("◇", "No staff analytics", "স্টাফ পারফরম্যান্স ডেটা নেই", dark)
        } else {
            staff.forEachIndexed { i, s ->
                TAStaffRowView(rank = i + 1, s = s, dark = dark)
                if (i < staff.lastIndex) {
                    HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.12f))
                }
            }
        }
    }
}

@Composable
private fun TAStaffRowView(rank: Int, s: TAStaffRow, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        // Rank badge — top three wear the trading green→violet gradient.
        Box(
            Modifier
                .size(26.dp)
                .clip(CircleShape)
                .then(
                    if (rank <= 3) Modifier.background(
                        Brush.linearGradient(listOf(TAPalette.tradingGreen, AlmaTheme.violet)),
                    ) else Modifier.background(AlmaTheme.ink(dark).copy(alpha = 0.06f)),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "$rank",
                color = if (rank <= 3) Color.White else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    s.name, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text(
                    TAFormat.pct(s.roiContribution) + " ROI",
                    color = TAPalette.signed(s.roiContribution, dark),
                    fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "${s.activeAccounts}/${s.assignedAccounts} accounts",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
                Text(
                    TAFormat.usdt(s.totalTradedUsdt),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "৳" + TAFormat.num(s.totalProfitGenerated),
                    color = TAPalette.positive(dark),
                    fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                )
                Text(
                    "৳" + TAFormat.num(s.totalLossGenerated),
                    color = if (dark) TAPalette.red400 else TAPalette.red500,
                    fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                )
            }
            Text(
                String.format(Locale.US, "%.1f%% fee efficiency", s.feeEfficiency),
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }
    }
}

// ── Merchant Account Intelligence (client-side search, top 20 — iOS accountIntelCard twin) ──

@Composable
private fun TAAccountIntelCard(vm: TradingAnalyticsState, dark: Boolean) {
    val rows = vm.searchedRows.take(20)   // web .slice(0, 20)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Merchant Account Intelligence", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = vm.search,
            onValueChange = { vm.search = it },
            singleLine = true,
            placeholder = { Text("Search report rows...", fontSize = 13.sp, color = AlmaTheme.inkSecondary(dark)) },
            leadingIcon = { Text("🔍", fontSize = 13.sp) },
            textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 13.sp),
            modifier = Modifier.fillMaxWidth(),
        )
        if (rows.isEmpty()) {
            TAEmptyBlock("◇", "No account rows", "অ্যাকাউন্ট ডেটা নেই", dark)
        } else {
            rows.forEachIndexed { i, row ->
                TAAccountIntelRow(row, dark)
                if (i < rows.lastIndex) {
                    HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.12f))
                }
            }
        }
    }
}

@Composable
private fun TAAccountIntelRow(row: TAAccountRow, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    row.accountTitle, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(row.assignedUserName, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Text(
                "৳" + TAFormat.num(row.netProfit),
                color = TAPalette.signed(row.netProfit, dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TAStatusPill(row.status, dark)
            Text(
                String.format(Locale.US, "%.2f%% ROI", row.roi),
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            )
            Text(
                String.format(Locale.US, "%.4f spread", row.averageSpread),
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            )
            Text(
                String.format(Locale.US, "%.1f%% fees", row.feeRatio),
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            Text(
                row.health.replace("_", " "),
                color = TAPalette.health(row.health, dark),
                fontSize = 10.sp, fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun TAStatusPill(status: String, dark: Boolean) {
    val tint = TAPalette.status(status, dark)
    Text(
        status,
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

// ── Expense Intelligence (web red bar list, top 8 — iOS expenseIntelCard twin) ─────

@Composable
private fun TAExpenseIntelCard(cats: List<TAExpenseCat>, maxAmount: Double, dark: Boolean) {
    val shown = cats.take(8)   // web .slice(0, 8)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Expense Intelligence", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        if (shown.isEmpty()) {
            TAEmptyBlock("◇", "No expenses", "এই রেঞ্জে খরচ নেই", dark)
        } else {
            shown.forEach { cat ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            cat.type, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text(
                            "৳" + TAFormat.num(cat.amount),
                            color = TAPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    // Web: width = max(4%, amount/max ×100), red-400 fill.
                    TABar(
                        fraction = maxOf(0.04, cat.amount / maxAmount),
                        color = TAPalette.red400, height = 6, dark = dark,
                    )
                }
            }
        }
    }
}
