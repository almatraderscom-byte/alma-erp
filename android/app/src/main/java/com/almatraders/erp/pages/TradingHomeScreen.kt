//
//  TradingHomeScreen.kt
//  ALMA ERP — the ALMA Trading dashboard, ported 1:1 from TradingHomeSwiftUI.swift
//  (web /trading parity). Same endpoints, same colours, same blocks:
//    GET  /api/trading/dashboard              → kpis · accountPerformance · alerts ·
//                                               screenshotCompliance · latestTrades/Expenses
//    GET  /api/trading/summary                → business kpis + period ranges
//    GET  /api/trading/accounts?status=ACTIVE → active account list
//  Native money writes (owner 2026-07-11, FINANCIALLY SENSITIVE — exact web payloads):
//    POST /api/trading/trades                              {tradingAccountId, tradeType,
//                                                           usdtAmount, bdtRate, feeUsdt, notes}
//    POST /api/trading/accounts/{id}/bkash-summary         {tradingAccountId, summaryDate,
//                                                           totalOrders, totalProfitBdt,
//                                                           totalLossBdt, notes}
//    POST /api/trading/expenses                            {tradingAccountId, expenseType,
//                                                           amount, paidBy?, notes}
//    POST /api/trading/capital                             {tradingAccountId, entryType,
//                                                           amount, notes}
//  Uploads (expense attachment, compliance screenshot) are multipart on iOS — AlmaApi
//  has no multipart, so on Android they stay on the WEB escape hatch (Screenshot button
//  opens /trading; the expense sheet posts without attachment and says so).
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays,
//  confirm dialog before every money write (iOS confirmationDialog parity).
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddCircle
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.ShowChart
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material.icons.outlined.TrackChanges
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaSession
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.RememberSession
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object THPalette {
    val sage = Color(0xFF82B399)          // trading accent green
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val orange500 = Color(0xFFF97316)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue400 = Color(0xFF60A5FA)
    val blue500 = Color(0xFF3B82F6)
    val slate400 = Color(0xFF94A3B8)

    /** The web's gold-tinted money reads gold-dim on cream, gold-lt over dark aurora. */
    fun gold(dark: Boolean) = if (dark) goldLt else goldDim

    /** Web signedClass: >= 0 green-400 · else red-400 (light gets the darker pair). */
    fun signed(value: Int, dark: Boolean) =
        if (value >= 0) (if (dark) green400 else emerald600) else red400

    /** Web HealthBadge: PROFITABLE green · STABLE blue · RISK amber · LOSS red. */
    fun health(h: String?, dark: Boolean) = when (h) {
        "PROFITABLE" -> if (dark) green400 else emerald600
        "STABLE" -> if (dark) blue400 else blue500
        "RISK" -> if (dark) amber500 else amber600
        "LOSS" -> red500
        else -> slate400
    }

    /** Web alertTone: CRITICAL red · HIGH orange · MEDIUM amber · LOW blue. */
    fun alert(severity: String?, dark: Boolean) = when (severity) {
        "CRITICAL" -> red500
        "HIGH" -> orange500
        "MEDIUM" -> if (dark) amber500 else amber600
        else -> if (dark) blue400 else blue500
    }
}

// ── Models (same field names the web TradingDashboardResponse & co. declare) ────────

private data class THKpis(
    val activeAccounts: Int?,
    val todayProfit: Int?,
    val todayLoss: Int?,
    val netTodayResult: Int?,
    val totalCapital: Int?,
    val currentBalance: Int?,
    val totalExpenses: Int?,
    val totalTradeVolume: Int?,
    val totalUsdtVolume: Double?,
) {
    companion object {
        fun from(o: JSONObject) = THKpis(
            o.flexInt("activeAccounts"), o.flexInt("todayProfit"), o.flexInt("todayLoss"),
            o.flexInt("netTodayResult"), o.flexInt("totalCapital"), o.flexInt("currentBalance"),
            o.flexInt("totalExpenses"), o.flexInt("totalTradeVolume"), o.flexDouble("totalUsdtVolume"),
        )
    }
}

private data class THCompliance(
    val cutoffHourBd: Int?,
    val pastCutoff: Boolean?,
    val completeCount: Int?,
    val dueCount: Int?,
    val overdueCount: Int?,
) {
    companion object {
        fun from(o: JSONObject) = THCompliance(
            o.flexInt("cutoffHourBd"), o.flexBool("pastCutoff"),
            o.flexInt("completeCount"), o.flexInt("dueCount"), o.flexInt("overdueCount"),
        )
    }
}

private data class THPerfRow(
    val id: String,
    val currentBalance: Int?,
    val dailyPl: Int?,
    val health: String?,
    val screenshotToday: Boolean?,
    val screenshotCompliance: String?,
) {
    companion object {
        fun from(o: JSONObject): THPerfRow? {
            val id = o.str("id") ?: return null
            return THPerfRow(
                id, o.flexInt("currentBalance"), o.flexInt("dailyPl"), o.str("health"),
                o.flexBool("screenshotToday"), o.str("screenshotCompliance"),
            )
        }
    }
}

private data class THAlert(
    val key: String,
    val severity: String?,
    val title: String?,
    val message: String?,
    val accountTitle: String?,
    val actionUrl: String?,
) {
    companion object {
        fun from(o: JSONObject): THAlert? {
            val key = o.str("key") ?: return null
            return THAlert(
                key, o.str("severity"), o.str("title"), o.str("message"),
                o.str("accountTitle"), o.str("actionUrl"),
            )
        }
    }
}

private data class THTrade(
    val id: String,
    val tradingAccountId: String?,
    val tradeType: String?,
    val usdtAmount: Double?,
    val netProfit: Int?,
    val accountTitle: String?,
    val userName: String?,
) {
    companion object {
        fun from(o: JSONObject): THTrade? {
            val id = o.str("id") ?: return null
            return THTrade(
                id, o.str("tradingAccountId"), o.str("tradeType"),
                o.flexDouble("usdtAmount"), o.flexInt("netProfit"),
                o.optJSONObject("tradingAccount")?.str("accountTitle"),
                o.optJSONObject("user")?.str("name"),
            )
        }
    }
}

private data class THExpense(
    val id: String,
    val tradingAccountId: String?,
    val expenseType: String?,
    val amount: Int?,
    val accountTitle: String?,
) {
    companion object {
        fun from(o: JSONObject): THExpense? {
            val id = o.str("id") ?: return null
            return THExpense(
                id, o.str("tradingAccountId"), o.str("expenseType"), o.flexInt("amount"),
                o.optJSONObject("tradingAccount")?.str("accountTitle"),
            )
        }
    }
}

private data class THSummaryKpis(
    val activeAccounts: Int?,
    val totalCapital: Int?,
    val totalFees: Int?,
    val totalOperatingExpenses: Int?,
    val totalTradedUsdt: Double?,
) {
    companion object {
        fun from(o: JSONObject) = THSummaryKpis(
            o.flexInt("activeAccounts"), o.flexInt("totalCapital"), o.flexInt("totalFees"),
            o.flexInt("totalOperatingExpenses"), o.flexDouble("totalTradedUsdt"),
        )
    }
}

private data class THAccount(
    val id: String,
    val accountTitle: String,
    val binanceUid: String?,
    val startingCapital: Int?,
    val currentBalance: Int?,
    // Native writes: the trade sheet's live P/L preview needs the inventory position,
    // the expense sheet needs the partnership flag — same fields the web reads.
    val usdtBalance: Double?,
    val inventoryCostBdt: Double?,
    val partnershipEnabled: Boolean,
) {
    companion object {
        fun from(o: JSONObject): THAccount? {
            val id = o.str("id") ?: return null
            return THAccount(
                id,
                o.str("accountTitle") ?: "Trading account",
                o.str("binanceUid"),
                o.flexInt("startingCapital"),
                o.flexInt("currentBalance"),
                o.flexDouble("usdtBalance"),
                o.flexDouble("inventoryCostBdt"),
                o.flexBool("partnershipEnabled") ?: false,
            )
        }
    }
}

// ── Formatting helpers ───────────────────────────────────────────────────────────────

private object THFormat {
    fun taka(v: Int): String = AlmaTheme.taka(v)

    /** USDT volumes wear the web money() short scale: 1.2M / 34.5K / 960. */
    fun usdtShort(v: Double): String {
        val a = abs(v)
        val sign = if (v < 0) "-" else ""
        return when {
            a >= 1_000_000 -> "$sign${String.format("%.2f", a / 1_000_000)}M"
            a >= 1_000 -> "$sign${String.format("%.1f", a / 1_000)}K"
            else -> "$sign${String.format("%.0f", a)}"
        }
    }

    /** yyyy-MM-dd today in Asia/Dhaka (the web's date payload semantics). */
    fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }
        .format(Date())

    /** DatePicker millis are UTC-midnight — format them in UTC to avoid day drift. */
    fun fromPickerMillis(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(ms))

    fun num(s: String): Double = s.replace(",", "").trim().toDoubleOrNull() ?: 0.0
}

// Web EXPENSE_TYPES verbatim (trading-utils.ts).
private val TH_EXPENSE_TYPES = listOf(
    "Mobile purchase", "Internet/MB", "SIM", "Travel",
    "Device purchase", "Banking charges", "Misc operational",
)

// ── State holder (iOS TradingHomeVM twin) ────────────────────────────────────────────

private class TradingHomeState {
    var kpis by mutableStateOf<THKpis?>(null)
    var compliance by mutableStateOf<THCompliance?>(null)
    var perf by mutableStateOf(listOf<THPerfRow>())
    var alerts by mutableStateOf(listOf<THAlert>())
    var trades by mutableStateOf(listOf<THTrade>())
    var expenses by mutableStateOf(listOf<THExpense>())
    var summaryKpis by mutableStateOf<THSummaryKpis?>(null)
    var todayNet by mutableStateOf<Int?>(null)
    var yesterdayNet by mutableStateOf<Int?>(null)
    var last7Net by mutableStateOf<Int?>(null)
    var accounts by mutableStateOf(listOf<THAccount>())
    var loading by mutableStateOf(false)
    var loadedOnce by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)

    val perfById: Map<String, THPerfRow> get() = perf.associateBy { it.id }

    val complianceNeedsAttention: Boolean
        get() = ((compliance?.overdueCount ?: 0) + (compliance?.dueCount ?: 0)) > 0

    /** Flat payloads; tolerate an `{ ok, data: {…} }` wrap too, like the iOS decoder. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            // Same three calls the web page fires (useTradingDashboard / useTradingSummary /
            // useTradingAccounts({status:'ACTIVE'})) — empty search is dropped, only status travels.
            coroutineScope {
                val d = async { AlmaApi.getObject("/api/trading/dashboard") }
                val s = async { AlmaApi.getObject("/api/trading/summary") }
                val a = async { AlmaApi.getObject("/api/trading/accounts", mapOf("status" to "ACTIVE")) }

                val dash = unwrap(d.await())
                kpis = dash.optJSONObject("kpis")?.let { THKpis.from(it) }
                compliance = dash.optJSONObject("screenshotCompliance")?.let { THCompliance.from(it) }
                perf = dash.optJSONArray("accountPerformance")?.mapObjects { THPerfRow.from(it) } ?: emptyList()
                alerts = dash.optJSONArray("alerts")?.mapObjects { THAlert.from(it) } ?: emptyList()
                trades = dash.optJSONArray("latestTrades")?.mapObjects { THTrade.from(it) } ?: emptyList()
                expenses = dash.optJSONArray("latestExpenses")?.mapObjects { THExpense.from(it) } ?: emptyList()

                val sum = unwrap(s.await())
                summaryKpis = sum.optJSONObject("kpis")?.let { THSummaryKpis.from(it) }
                val ranges = sum.optJSONObject("ranges")
                fun net(key: String): Int? = ranges?.optJSONObject(key)?.let {
                    it.flexInt("netResultBdt") ?: it.flexInt("netResult")
                }
                todayNet = net("today")
                yesterdayNet = net("yesterday")
                last7Net = net("last7")

                accounts = unwrap(a.await()).optJSONArray("accounts")
                    ?.mapObjects { THAccount.from(it) } ?: emptyList()
            }
            authExpired = false
            loadedOnce = true
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

    // ── Native money writes (FINANCIALLY SENSITIVE — exact web payloads, ok-check,
    //    reload after success; same runner shape as the iOS vm.post). ──

    private suspend fun post(path: String, body: JSONObject, success: String): Boolean {
        return try {
            val resp = AlmaApi.send("POST", path, body)
            if (resp.flexBool("ok") != true) {
                toast = resp.str("error") ?: "সেভ হয়নি — আবার চেষ্টা করুন"
                false
            } else {
                toast = success
                load()
                true
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: AlmaApiException.Http) {
            toast = e.message
            false
        } catch (e: Exception) {
            toast = e.message ?: "নেটওয়ার্ক সমস্যা"
            false
        }
    }

    suspend fun submitTrade(
        accountId: String, tradeType: String,
        usdtAmount: Double, bdtRate: Double, feeUsdt: Double, notes: String,
    ): Boolean = post(
        "/api/trading/trades",
        JSONObject()
            .put("tradingAccountId", accountId)
            .put("tradeType", tradeType)
            .put("usdtAmount", usdtAmount)
            .put("bdtRate", bdtRate)
            .put("feeUsdt", feeUsdt)
            .put("notes", notes),
        success = "ট্রেড সেভ হয়েছে",
    )

    suspend fun submitBkash(
        accountId: String, summaryDate: String,
        totalProfitBdt: Double, totalLossBdt: Double, notes: String,
    ): Boolean = post(
        "/api/trading/accounts/$accountId/bkash-summary",
        JSONObject()
            .put("tradingAccountId", accountId)
            .put("summaryDate", summaryDate)
            .put("totalOrders", 0)
            .put("totalProfitBdt", totalProfitBdt)
            .put("totalLossBdt", totalLossBdt)
            .put("notes", notes),
        success = "Bkash summary সেভ হয়েছে",
    )

    suspend fun addExpense(
        accountId: String, expenseType: String, amount: Double,
        paidBy: String?, notes: String,
    ): Boolean {
        val body = JSONObject()
            .put("tradingAccountId", accountId)
            .put("expenseType", expenseType)
            .put("amount", amount)
            .put("notes", notes)
        // iOS omits nil optionals — paidBy travels only for partnership accounts,
        // attachmentUrl never travels on Android (uploads stay on the web).
        if (paidBy != null) body.put("paidBy", paidBy)
        return post("/api/trading/expenses", body, success = "খরচ যোগ হয়েছে")
    }

    suspend fun addCapital(
        accountId: String, entryType: String, amount: Double, notes: String,
    ): Boolean = post(
        "/api/trading/capital",
        JSONObject()
            .put("tradingAccountId", accountId)
            .put("entryType", entryType)
            .put("amount", amount)
            .put("notes", notes),
        success = "Capital entry পোস্ট হয়েছে",
    )
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradingHomeScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    // Role gating (defense-in-depth) — hide business-wide financials + admin writes from
    // non-admins, matching the web /trading page's `isAdmin` gates. Server stays authority.
    RememberSession()
    val canManage = AlmaSession.isAdmin
    val vm = remember { TradingHomeState() }
    val scope = rememberCoroutineScope()
    var showTrade by remember { mutableStateOf(false) }
    var showExpense by remember { mutableStateOf(false) }
    var showCapital by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }
    // Bottom toast — auto-dismiss like the iOS overlay.
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            delay(2600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                // Refresh affordance (Android has no pull-to-refresh in this shell yet).
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Spacer(Modifier.weight(1f))
                    Box(
                        Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { scope.launch { vm.load() } },
                        contentAlignment = Alignment.Center,
                    ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
                }
            }
            if (vm.authExpired) {
                item { THAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { THErrorCard(it, dark) } }

            if (vm.loading && !vm.loadedOnce) {
                item { Box(Modifier.fillMaxWidth().height(168.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
                items(4) { Box(Modifier.fillMaxWidth().height(72.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            } else {
                item { THHeroCard(vm.kpis, dark) }
                // Business-wide KPI tiles (total capital, trade/USDT volume, fees, expenses)
                // are admin-only on web — hide the whole bento for non-admins.
                if (canManage) {
                    item { THBentoGrid(vm.kpis, vm.summaryKpis, dark) }
                }
                item {
                    THWorkflowRow(
                        enabled = vm.accounts.isNotEmpty(),
                        canManage = canManage,
                        dark = dark,
                        onTrade = { showTrade = true },
                        onExpense = { showExpense = true },
                        onCapital = { showCapital = true },
                        // Compliance screenshot upload is multipart → stays on the web.
                        onScreenshot = { ctx.openWebForced("/trading", "Screenshot") },
                    )
                }
                item { THQuickNav(dark) { p, t -> ctx.openSmart(p, t) } }
                if (vm.complianceNeedsAttention) {
                    item { THComplianceStrip(vm.compliance, dark) }
                }
                item {
                    THSectionCard(
                        title = "My accounts",
                        sub = "ডেইলি অপস · অ্যাকাউন্ট-প্রতি স্ক্রিনশট স্ট্যাটাস",
                        trailing = "View all", trailingIsButton = true, dark = dark,
                        onTrailing = { ctx.openSmart("/trading/accounts", "Accounts") },
                    ) {
                        if (vm.accounts.isEmpty()) {
                            THEmptyLine("কোনো অ্যাকটিভ অ্যাকাউন্ট নেই", dark)
                        } else {
                            vm.accounts.take(12).forEachIndexed { idx, account ->
                                if (idx > 0) THRowDivider(dark)
                                THAccountRow(account, vm.perfById[account.id], dark) {
                                    ctx.openSmart("/trading/accounts/${account.id}", account.accountTitle)
                                }
                            }
                        }
                    }
                }
                if (vm.alerts.isNotEmpty()) {
                    item {
                        THSectionCard(
                            title = "Action required", sub = "ফিক্স করতে ওয়েবে খুলুন",
                            trailing = "${vm.alerts.size}", trailingIsButton = false, dark = dark,
                            onTrailing = null,
                        ) {
                            vm.alerts.take(8).forEachIndexed { idx, alert ->
                                if (idx > 0) THRowDivider(dark)
                                THAlertRow(alert, dark) {
                                    ctx.openSmart(alert.actionUrl ?: "/trading", alert.accountTitle ?: "Trading")
                                }
                            }
                        }
                    }
                }
                // Period snapshots are business-wide net results → admin-only on web.
                if (canManage) {
                    item {
                        THSectionCard(
                            title = "Period snapshots", sub = "নেট রেজাল্ট",
                            trailing = null, trailingIsButton = false, dark = dark, onTrailing = null,
                        ) {
                            THSnapshotRow("Today", vm.todayNet, dark)
                            THRowDivider(dark)
                            THSnapshotRow("Yesterday", vm.yesterdayNet, dark)
                            THRowDivider(dark)
                            THSnapshotRow("Last 7 days", vm.last7Net, dark)
                        }
                    }
                }
                item {
                    THSectionCard(
                        title = "Latest trades", sub = "সাম্প্রতিক এন্ট্রি",
                        trailing = null, trailingIsButton = false, dark = dark, onTrailing = null,
                    ) {
                        if (vm.trades.isEmpty()) {
                            THEmptyLine("No trades today", dark)
                        } else {
                            vm.trades.forEachIndexed { idx, trade ->
                                if (idx > 0) THRowDivider(dark)
                                THTradeRow(trade, dark) {
                                    ctx.openSmart(
                                        "/trading/accounts/${trade.tradingAccountId ?: ""}",
                                        trade.accountTitle ?: "Trading",
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    THSectionCard(
                        title = "Latest expenses", sub = "সাম্প্রতিক খরচ",
                        trailing = null, trailingIsButton = false, dark = dark, onTrailing = null,
                    ) {
                        if (vm.expenses.isEmpty()) {
                            THEmptyLine("No expenses", dark)
                        } else {
                            vm.expenses.forEachIndexed { idx, expense ->
                                if (idx > 0) THRowDivider(dark)
                                THExpenseRow(expense, dark)
                            }
                        }
                    }
                }
            }
            item {
                Text(
                    "🌐 ট্রেড / স্ক্রিনশট / সামারি — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/trading", "Trading") }
                        .padding(vertical = 4.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }
        }

        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 22)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    if (showTrade) {
        ModalBottomSheet(onDismissRequest = { showTrade = false }, containerColor = AlmaTheme.rootBg(dark)) {
            THTradeSheet(vm, dark, scope) { showTrade = false }
        }
    }
    if (showExpense) {
        ModalBottomSheet(onDismissRequest = { showExpense = false }, containerColor = AlmaTheme.rootBg(dark)) {
            THExpenseSheet(vm, dark, scope) { showExpense = false }
        }
    }
    if (showCapital) {
        ModalBottomSheet(onDismissRequest = { showCapital = false }, containerColor = AlmaTheme.rootBg(dark)) {
            THCapitalSheet(vm, dark, scope) { showCapital = false }
        }
    }
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun THAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AlmaTheme.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun THErrorCard(message: String, dark: Boolean) {
    Text(
        "⚠ $message", color = THPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun THEmptyLine(text: String, dark: Boolean) {
    Text(
        text, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
    )
}

@Composable
private fun THRowDivider(dark: Boolean) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = 14.dp)
            .height(1.dp)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f)),
    )
}

@Composable
private fun THPill(label: String, tint: Color) {
    Text(
        label,
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        modifier = Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

/** Count-up number (0 → target on appear, old → new on refresh) — iOS CountUp twin. */
@Composable
private fun THCountUpText(
    target: Int,
    format: (Int) -> String,
    color: Color,
    fontSize: androidx.compose.ui.unit.TextUnit,
    fontWeight: FontWeight,
) {
    var started by remember { mutableStateOf(false) }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "thCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    Text(
        format(shown), color = color, fontSize = fontSize, fontWeight = fontWeight,
        fontFamily = FontFamily.Monospace, maxLines = 1,
    )
}

// ── Section card (web Card + bordered header parity) ────────────────────────────────

@Composable
private fun THSectionCard(
    title: String,
    sub: String,
    trailing: String?,
    trailingIsButton: Boolean,
    dark: Boolean,
    onTrailing: (() -> Unit)?,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
            trailing?.let {
                if (trailingIsButton && onTrailing != null) {
                    Text(
                        it, color = THPalette.gold(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.plainClick(onTrailing).padding(4.dp),
                    )
                } else {
                    Text(
                        it, color = THPalette.red400, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(THPalette.red500.copy(alpha = 0.12f), CircleShape)
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
        HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.06f), thickness = 1.dp)
        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) { content() }
    }
}

// ── Hero + bento board (Dashboard board language re-tinted for trading) ─────────────

@Composable
private fun THHeroCard(k: THKpis?, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF181528))   // deliberately dark in BOTH themes (iOS parity)
            .background(Brush.linearGradient(listOf(THPalette.sage.copy(alpha = 0.34f), Color.Transparent)))
            .background(
                Brush.linearGradient(
                    0f to Color.Transparent, 0.55f to Color.Transparent,
                    1f to AlmaTheme.violet.copy(alpha = 0.24f),
                ),
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "কারেন্ট ব্যালেন্স · TRADING",
            color = THPalette.sage, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        if (k?.currentBalance != null) {
            THCountUpText(k.currentBalance, { AlmaTheme.takaShort(it) }, Color.White, 40.sp, FontWeight.Black)
        } else {
            Text("—", color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black)
        }
        Text(
            "সব ট্রেডিং অ্যাকাউন্ট মিলিয়ে",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            THHeroStat(
                "Today net", k?.netTodayResult,
                if ((k?.netTodayResult ?: 0) < 0) THPalette.red400 else THPalette.green400,
                "আজকের নেট",
            )
            THHeroDivider()
            THHeroStat("Today profit", k?.todayProfit, THPalette.green400, "আজকের লাভ")
            THHeroDivider()
            THHeroStat("Today loss", k?.todayLoss, THPalette.red400, "আজকের লস")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun THHeroDivider() {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(44.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun THHeroStat(label: String, target: Int?, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        if (target != null) {
            THCountUpText(target, { AlmaTheme.takaShort(it) }, tint, 17.sp, FontWeight.Black)
        } else {
            Text("—", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black)
        }
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun THBentoGrid(k: THKpis?, bk: THSummaryKpis?, dark: Boolean) {
    // The web's 6 business KPI tiles — same order/labels/tints as the iOS grid.
    data class Tile(val label: String, val value: Int?, val format: (Int) -> String, val sub: String, val tint: Color, val accent: Color)
    val tiles = listOf(
        Tile("Active accounts", k?.activeAccounts ?: bk?.activeAccounts, { "$it" }, "চালু অ্যাকাউন্ট", THPalette.sage, THPalette.sage),
        Tile("Total capital", k?.totalCapital ?: bk?.totalCapital, { AlmaTheme.takaShort(it) }, "মোট মূলধন", THPalette.gold(dark), AlmaTheme.coral),
        Tile("Trade volume", k?.totalTradeVolume, { AlmaTheme.takaShort(it) }, "মোট ট্রেড ভলিউম", THPalette.blue400, THPalette.blue400),
        Tile(
            "USDT volume",
            (k?.totalUsdtVolume ?: bk?.totalTradedUsdt)?.let { it.roundToInt() },
            { "${THFormat.usdtShort(it.toDouble())} USDT" }, "মোট USDT", AlmaTheme.violet, AlmaTheme.violet,
        ),
        Tile("Total fees", bk?.totalFees, { AlmaTheme.takaShort(it) }, "বাইন্যান্স ফি", THPalette.amber500, THPalette.amber500),
        Tile("Total expenses", k?.totalExpenses ?: bk?.totalOperatingExpenses, { AlmaTheme.takaShort(it) }, "অপারেটিং খরচ", THPalette.red400, THPalette.red500),
    )
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        tiles.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                pair.forEach { t ->
                    THBentoTile(t.label, t.value, t.format, t.sub, t.tint, t.accent, dark, Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun THBentoTile(
    label: String,
    target: Int?,
    format: (Int) -> String,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier,
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
            letterSpacing = 0.4.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (target != null) {
            THCountUpText(target, format, tint, 17.sp, FontWeight.Black)
        } else {
            Text("—", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black)
        }
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Workflow actions + quick nav ────────────────────────────────────────────────────

@Composable
private fun THWorkflowRow(
    enabled: Boolean,
    canManage: Boolean,
    dark: Boolean,
    onTrade: () -> Unit,
    onExpense: () -> Unit,
    onCapital: () -> Unit,
    onScreenshot: () -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        // Trade + Screenshot are staff workflow (web quick actions). Expense + Capital are
        // admin-only money writes on web — hide them from non-admins.
        THWorkflowButton(Icons.Outlined.AddCircle, "Add Trade", THPalette.gold(dark), enabled, Modifier.weight(1f), onTrade)
        if (canManage) {
            THWorkflowButton(Icons.Outlined.Payments, "Expense", THPalette.signed(-1, dark), enabled, Modifier.weight(1f), onExpense)
            THWorkflowButton(Icons.Outlined.SwapVert, "Capital", AlmaTheme.sage, enabled, Modifier.weight(1f), onCapital)
        }
        THWorkflowButton(Icons.Outlined.PhotoCamera, "Screenshot", AlmaTheme.violet, enabled, Modifier.weight(1f), onScreenshot)
    }
}

@Composable
private fun THWorkflowButton(
    icon: ImageVector,
    label: String,
    tint: Color,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.5f
    Column(
        modifier
            .background(tint.copy(alpha = 0.10f * alpha), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tint.copy(alpha = 0.25f * alpha), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick { if (enabled) onClick() }
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = label, tint = tint.copy(alpha = alpha), modifier = Modifier.size(19.dp))
        Text(
            label,
            color = tint.copy(alpha = alpha), fontSize = 10.sp, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun THQuickNav(dark: Boolean, open: (String, String) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        THQuickNavChip("Accounts", Icons.Outlined.Group, dark) { open("/trading/accounts", "Trading accounts") }
        THQuickNavChip("Analytics", Icons.Outlined.ShowChart, dark) { open("/trading/analytics", "Trading analytics") }
        THQuickNavChip("HR", Icons.Outlined.Badge, dark) { open("/trading/hr", "Trading HR") }
        THQuickNavChip("Targets", Icons.Outlined.TrackChanges, dark) { open("/trading/target-control", "Target control") }
        THQuickNavChip("Telegram", Icons.Outlined.Send, dark) { open("/trading/telegram", "Telegram Quick Entry") }
    }
}

@Composable
private fun THQuickNavChip(title: String, icon: ImageVector, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = null, tint = AlmaTheme.ink(dark), modifier = Modifier.size(14.dp))
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

// ── Compliance strip (web amber tone card) ──────────────────────────────────────────

@Composable
private fun THComplianceStrip(c: THCompliance?, dark: Boolean) {
    val cutoff = if (c?.pastCutoff == true) "cutoff passed" else "cutoff ${c?.cutoffHourBd ?: 0}:00 BD"
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .background(THPalette.amber500.copy(alpha = if (dark) 0.14f else 0.10f), shape)
            .border(1.dp, THPalette.amber500.copy(alpha = 0.35f), shape)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            Icons.Outlined.PhotoCamera, contentDescription = null,
            tint = THPalette.amber500, modifier = Modifier.size(18.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Screenshot compliance", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(
                "${c?.completeCount ?: 0} complete · ${c?.dueCount ?: 0} due · ${c?.overdueCount ?: 0} overdue · $cutoff",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }
    }
}

// ── Rows (accounts / alerts / snapshots / trades / expenses) ────────────────────────

@Composable
private fun THAccountRow(account: THAccount, perf: THPerfRow?, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                account.accountTitle,
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    account.binanceUid?.takeIf { it.isNotEmpty() } ?: "No UID",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1,
                )
                // Web complianceBadge: today/COMPLETE green "Today ✓" · OVERDUE red · DUE amber.
                when {
                    perf?.screenshotToday == true || perf?.screenshotCompliance == "COMPLETE" ->
                        THPill("Today ✓", if (dark) THPalette.green400 else THPalette.emerald600)
                    perf?.screenshotCompliance == "OVERDUE" ->
                        THPill("Screenshot overdue", THPalette.red500)
                    perf?.screenshotCompliance == "DUE" ->
                        THPill("Screenshot due", if (dark) THPalette.amber500 else THPalette.amber600)
                }
                perf?.health?.let { THPill(it, THPalette.health(it, dark)) }
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                THFormat.taka(perf?.currentBalance ?: account.currentBalance ?: account.startingCapital ?: 0),
                color = THPalette.gold(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            perf?.dailyPl?.let { pl ->
                Text(
                    "Today ${THFormat.taka(pl)}",
                    color = THPalette.signed(pl, dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

@Composable
private fun THAlertRow(alert: THAlert, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(alert.title ?: "Alert", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            alert.message?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }
        THPill(alert.severity ?: "LOW", THPalette.alert(alert.severity, dark))
    }
}

@Composable
private fun THSnapshotRow(label: String, value: Int?, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value?.let { THFormat.taka(it) } ?: "—",
            color = value?.let { THPalette.signed(it, dark) } ?: AlmaTheme.inkSecondary(dark),
            fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun THTradeRow(trade: THTrade, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                trade.accountTitle ?: trade.tradingAccountId ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${trade.userName ?: "Staff"} · ${trade.tradeType ?: "—"} · ${THFormat.usdtShort(trade.usdtAmount ?: 0.0)} USDT",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            trade.netProfit?.let { THFormat.taka(it) } ?: "—",
            color = THPalette.signed(trade.netProfit ?: 0, dark),
            fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun THExpenseRow(expense: THExpense, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                expense.expenseType ?: "Expense",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                expense.accountTitle ?: expense.tradingAccountId ?: "—",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            expense.amount?.let { THFormat.taka(it) } ?: "—",
            color = THPalette.red400,
            fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Sheet chrome (web ModalFrame parity: title + close · content · submit footer) ───

@Composable
private fun THSheetFrame(
    title: String,
    desc: String,
    submitLabel: String,
    submitting: Boolean,
    canSubmit: Boolean,
    dark: Boolean,
    onClose: () -> Unit,
    onSubmit: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
            Text(
                "Close", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onClose).padding(4.dp),
            )
        }
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f), thickness = 1.dp)
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 480.dp)
                .verticalScroll(rememberScrollState())
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content() }
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f), thickness = 1.dp)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 14.dp)
                .background(
                    if (canSubmit && !submitting) AlmaTheme.coral else AlmaTheme.coral.copy(alpha = 0.4f),
                    RoundedCornerShape(14.dp),
                )
                .plainClick { if (canSubmit && !submitting) onSubmit() }
                .padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (submitting) {
                CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(submitLabel, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** Small labelled numeric/text field, web Input parity (iOS TradingHomeField twin). */
@Composable
private fun THField(
    placeholder: String,
    value: String,
    dark: Boolean,
    keyboardType: KeyboardType = KeyboardType.Decimal,
    onChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        textStyle = TextStyle(
            color = AlmaTheme.ink(dark), fontSize = 14.sp,
            fontWeight = if (keyboardType == KeyboardType.Decimal) FontWeight.Bold else FontWeight.Normal,
        ),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(horizontal = 12.dp, vertical = 11.dp),
            ) {
                if (value.isEmpty()) {
                    Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                }
                inner()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Account picker used by every write sheet (iOS Menu twin). */
@Composable
private fun THAccountPicker(accounts: List<THAccount>, selectedId: String, dark: Boolean, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick { open = true }
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                accounts.firstOrNull { it.id == selectedId }?.accountTitle ?: "অ্যাকাউন্ট বাছুন",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            accounts.forEach { a ->
                DropdownMenuItem(
                    text = { Text((if (a.id == selectedId) "✓ " else "") + a.accountTitle) },
                    onClick = { onSelect(a.id); open = false },
                )
            }
        }
    }
}

/** Segmented chips (iOS segmented Picker twin). */
@Composable
private fun THSegChips(options: List<Pair<String, String>>, selected: String, dark: Boolean, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            val active = value == selected
            Text(
                label,
                color = if (active) THPalette.gold(dark) else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp,
                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .background(
                        if (active) AlmaTheme.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                        else AlmaTheme.ink(dark).copy(alpha = 0.05f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .border(
                        1.dp,
                        if (active) AlmaTheme.coral.copy(alpha = 0.55f) else Color.Transparent,
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { onSelect(value) }
                    .padding(vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun THCalcTile(label: String, value: Double, dark: Boolean, modifier: Modifier) {
    Column(
        modifier
            .background(AlmaTheme.ink(dark).copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
        Text(
            THFormat.taka(value.roundToInt()),
            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace, maxLines = 1,
        )
    }
}

@Composable
private fun THResultPanel(label: String, value: Double, dark: Boolean) {
    val tint = THPalette.signed(if (value >= 0) 1 else -1, dark)
    Column(
        Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp,
        )
        Text(
            "${if (value >= 0) "+" else "-"}${THFormat.taka(abs(value).roundToInt())}",
            color = tint, fontSize = 26.sp, fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

/** yyyy-MM-dd date row with a Material date picker (iOS DatePicker twin). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun THDateRow(label: String, date: String, dark: Boolean, onChange: (String) -> Unit) {
    var showPicker by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        Text(
            "$date ▾",
            color = AlmaTheme.violet, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.plainClick { showPicker = true }.padding(vertical = 4.dp),
        )
    }
    if (showPicker) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onChange(THFormat.fromPickerMillis(it)) }
                    showPicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = {
                TextButton(onClick = { showPicker = false }) { Text("বাতিল") }
            },
        ) { DatePicker(state = state) }
    }
}

// ── Add Trade (web TradeEntryModal: BKASH daily summary / BANK P2P engine) ──────────

@Composable
private fun THTradeSheet(
    vm: TradingHomeState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onClose: () -> Unit,
) {
    var accountId by remember { mutableStateOf(vm.accounts.firstOrNull()?.id ?: "") }
    var mode by remember { mutableStateOf("BANK") }        // BANK | BKASH — web defaults BANK
    var tradeType by remember { mutableStateOf("BUY") }
    var usdtAmount by remember { mutableStateOf("") }
    var bdtRate by remember { mutableStateOf("") }
    var feeUsdt by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var bkashDate by remember { mutableStateOf(THFormat.today()) }
    var bkashProfit by remember { mutableStateOf("") }
    var bkashLoss by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }

    val account = vm.accounts.firstOrNull { it.id == accountId }

    // Web calc block parity (TradingModals.tsx calc useMemo).
    val totalBdt = THFormat.num(usdtAmount) * THFormat.num(bdtRate)
    val feeBdt = THFormat.num(feeUsdt) * THFormat.num(bdtRate)
    val netBdt = if (tradeType == "BUY") totalBdt + feeBdt else totalBdt - feeBdt
    val avgCostRate = run {
        val bal = account?.usdtBalance ?: 0.0
        if (bal > 0) (account?.inventoryCostBdt ?: 0.0) / bal else 0.0
    }
    val sellNet = netBdt - THFormat.num(usdtAmount) * avgCostRate
    val bkashNet = THFormat.num(bkashProfit) - THFormat.num(bkashLoss)

    val canSubmit = account != null && (
        if (mode == "BKASH") THFormat.num(bkashProfit) > 0 || THFormat.num(bkashLoss) > 0
        else THFormat.num(usdtAmount) > 0 && THFormat.num(bdtRate) > 0 && THFormat.num(feeUsdt) >= 0
        )

    fun submit() {
        val acc = account ?: return
        if (submitting) return
        if (mode == "BANK" && tradeType == "SELL" && THFormat.num(usdtAmount) > (acc.usdtBalance ?: 0.0)) {
            errorText = "Sell USDT exceeds account USDT balance."
            return
        }
        submitting = true
        errorText = null
        scope.launch {
            val ok = if (mode == "BKASH") {
                vm.submitBkash(acc.id, bkashDate, THFormat.num(bkashProfit), THFormat.num(bkashLoss), notes)
            } else {
                vm.submitTrade(acc.id, tradeType, THFormat.num(usdtAmount), THFormat.num(bdtRate), THFormat.num(feeUsdt), notes.trim())
            }
            submitting = false
            if (ok) onClose() else errorText = vm.toast
        }
    }

    THSheetFrame(
        title = "Add Trade Entry",
        desc = account?.accountTitle ?: "Choose account · Bkash summary or Bank/P2P",
        submitLabel = if (mode == "BKASH") "Save Bkash summary" else "Submit trade",
        submitting = submitting, canSubmit = canSubmit, dark = dark,
        onClose = onClose,
        onSubmit = { confirming = true },
    ) {
        if (vm.accounts.size > 1) {
            THAccountPicker(vm.accounts, accountId, dark) { accountId = it }
        }
        THSegChips(listOf("BKASH" to "BKASH", "BANK" to "BANK / P2P"), mode, dark) { mode = it }

        if (mode == "BKASH") {
            Text(
                "২০০-৩০০+ ছোট merchant action-এর দিনের ফল — USDT/rate/fee লাগে না।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
            THDateRow("তারিখ", bkashDate, dark) { bkashDate = it }
            THField("Total daily profit (BDT)", bkashProfit, dark) { bkashProfit = it }
            THField("Total daily loss (BDT)", bkashLoss, dark) { bkashLoss = it }
            THResultPanel("Net result = profit - loss", bkashNet, dark)
        } else {
            THSegChips(listOf("BUY" to "BUY", "SELL" to "SELL"), tradeType, dark) { tradeType = it }
            THField("USDT amount", usdtAmount, dark) { usdtAmount = it }
            THField("BDT Rate", bdtRate, dark) { bdtRate = it }
            THField("Binance Fee (USDT)", feeUsdt, dark) { feeUsdt = it }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                THCalcTile(if (tradeType == "BUY") "Total BDT" else "Sell BDT", totalBdt, dark, Modifier.weight(1f))
                THCalcTile("Fee BDT", feeBdt, dark, Modifier.weight(1f))
                THCalcTile(if (tradeType == "BUY") "Net Buy Cost" else "Net Receive", netBdt, dark, Modifier.weight(1f))
            }
            if (tradeType == "SELL") {
                THResultPanel("Live profit / loss (avg cost ৳${String.format("%.2f", avgCostRate)})", sellNet, dark)
                if (THFormat.num(usdtAmount) > (account?.usdtBalance ?: 0.0)) {
                    Text(
                        "⚠ Sell USDT অ্যাকাউন্টের USDT ব্যালান্সের বেশি",
                        color = THPalette.signed(-1, dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        THField("Notes", notes, dark, KeyboardType.Text) { notes = it }
        errorText?.let {
            Text(it, color = THPalette.signed(-1, dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = {
                Text(
                    if (mode == "BKASH") "Bkash summary সেভ করবেন? Net ${THFormat.taka(bkashNet.roundToInt())}"
                    else "$tradeType ট্রেড সাবমিট করবেন? Net ${THFormat.taka(netBdt.roundToInt())}",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirming = false; submit() }) { Text("হ্যাঁ, সেভ করুন") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("বাতিল") }
            },
        )
    }
}

// ── Expense entry (web ExpenseEntryModal — attachment stays on the web) ─────────────

@Composable
private fun THExpenseSheet(
    vm: TradingHomeState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onClose: () -> Unit,
) {
    var accountId by remember { mutableStateOf(vm.accounts.firstOrNull()?.id ?: "") }
    var expenseType by remember { mutableStateOf(TH_EXPENSE_TYPES.first()) }
    var amount by remember { mutableStateOf("") }
    var paidBy by remember { mutableStateOf("OWNER") }
    var notes by remember { mutableStateOf("") }
    var typeOpen by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    val account = vm.accounts.firstOrNull { it.id == accountId }
    val canSubmit = account != null && THFormat.num(amount) > 0

    fun submit() {
        val acc = account ?: return
        if (submitting) return
        submitting = true
        scope.launch {
            val ok = vm.addExpense(
                acc.id, expenseType, THFormat.num(amount),
                paidBy = if (acc.partnershipEnabled) paidBy else null,
                notes = notes,
            )
            submitting = false
            if (ok) onClose()
        }
    }

    THSheetFrame(
        title = "Add account expense",
        desc = "Account ledger খরচ — global finance/analytics-এও যাবে।",
        submitLabel = "Add expense",
        submitting = submitting, canSubmit = canSubmit, dark = dark,
        onClose = onClose,
        onSubmit = { confirming = true },
    ) {
        THAccountPicker(vm.accounts, accountId, dark) { accountId = it }
        Box(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { typeOpen = true }
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    expenseType, color = AlmaTheme.ink(dark), fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
                )
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            DropdownMenu(expanded = typeOpen, onDismissRequest = { typeOpen = false }) {
                TH_EXPENSE_TYPES.forEach { t ->
                    DropdownMenuItem(
                        text = { Text((if (t == expenseType) "✓ " else "") + t) },
                        onClick = { expenseType = t; typeOpen = false },
                    )
                }
            }
        }
        THField("Expense Amount (BDT)", amount, dark) { amount = it }
        if (account?.partnershipEnabled == true) {
            THSegChips(listOf("OWNER" to "আমি (Owner)", "STAFF" to "Staff"), paidBy, dark) { paidBy = it }
        }
        // iOS attaches receipts via PhotosPicker + multipart — no multipart on Android
        // AlmaApi, so receipts go on the web for now.
        Text(
            "রিসিট/স্ক্রিনশট অ্যাটাচ করতে হলে ওয়েব ভার্সনে খরচটি দিন।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        THField("Notes", notes, dark, KeyboardType.Text) { notes = it }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("${THFormat.taka(THFormat.num(amount).roundToInt())} খরচ যোগ করবেন ($expenseType)?") },
            confirmButton = {
                TextButton(onClick = { confirming = false; submit() }) { Text("হ্যাঁ, যোগ করুন") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("বাতিল") }
            },
        )
    }
}

// ── Capital entry (web CapitalEntryModal: deposit / withdraw / adjustment) ──────────

@Composable
private fun THCapitalSheet(
    vm: TradingHomeState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onClose: () -> Unit,
) {
    var accountId by remember { mutableStateOf(vm.accounts.firstOrNull()?.id ?: "") }
    var entryType by remember { mutableStateOf("DEPOSIT") }
    var amount by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    val account = vm.accounts.firstOrNull { it.id == accountId }
    val canSubmit = account != null && THFormat.num(amount) != 0.0
    val typeLabel = when (entryType) {
        "DEPOSIT" -> "Deposit"
        "WITHDRAW" -> "Withdraw"
        else -> "Adjustment"
    }

    fun submit() {
        val acc = account ?: return
        if (submitting) return
        submitting = true
        scope.launch {
            val ok = vm.addCapital(acc.id, entryType, THFormat.num(amount), notes)
            submitting = false
            if (ok) onClose()
        }
    }

    THSheetFrame(
        title = "Capital entry",
        desc = account?.accountTitle ?: "Deposit, withdraw, or adjustment",
        submitLabel = "Post capital entry",
        submitting = submitting, canSubmit = canSubmit, dark = dark,
        onClose = onClose,
        onSubmit = { confirming = true },
    ) {
        THAccountPicker(vm.accounts, accountId, dark) { accountId = it }
        THSegChips(
            listOf("DEPOSIT" to "Deposit", "WITHDRAW" to "Withdraw", "ADJUSTMENT" to "Adjustment"),
            entryType, dark,
        ) { entryType = it }
        THField("Amount", amount, dark) { amount = it }
        THField("Notes", notes, dark, KeyboardType.Text) { notes = it }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("$typeLabel ${THFormat.taka(THFormat.num(amount).roundToInt())} পোস্ট করবেন?") },
            confirmButton = {
                TextButton(onClick = { confirming = false; submit() }) { Text("হ্যাঁ, পোস্ট করুন") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("বাতিল") }
            },
        )
    }
}
