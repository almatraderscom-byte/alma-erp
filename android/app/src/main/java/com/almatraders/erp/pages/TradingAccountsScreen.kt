//
//  TradingAccountsScreen.kt
//  ALMA ERP — Trading Accounts (/trading/accounts + /trading/accounts/[id]) ported 1:1
//  from TradingAccountsSwiftUI.swift (BUILD 66).
//
//  Endpoints (same as web/iOS — FINANCIALLY SENSITIVE, exact bodies):
//    GET   /api/trading/accounts?search=…&status=…      → { accounts, total } (tolerate {ok,data})
//    GET   /api/trading/accounts/{id}/summary           → { account, summary, today, ranges,
//                                                          recentTrades, recentExpenses }
//    GET   /api/trading/staff                           → { staff: [{id,name,role}] }
//    POST  /api/trading/accounts                        → create (web TradingAccountModal payload)
//    PATCH /api/trading/accounts/{id}  {…, action:"update"} → edit
//    PATCH /api/trading/accounts/{id}  {action:"archive"}   → archive
//  Blocks: dark hero (balance roll-up) + capital/expense tiles · create button · search
//  (debounced, server-side) · status chips · account rows (50/50 pill · staff · UID ·
//  balance gold/red · profit signed · merchant progress · status pill · long-press
//  edit/archive) · detail sheet (KPI grid, risk warning, account/partnership/today/
//  ranges/trades/expenses) · native create-edit form sheet with confirm dialogs.
//  Carried lessons: lenient row parsing (Prisma Decimals arrive as strings), ONE
//  spinner, no global overlays.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaSession
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.RememberSession
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object TradingAccPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val slate400 = Color(0xFF94A3B8)

    /** Trading hero accent — sage green (owner spec for the Trading pages). */
    val sage = Color(0xFF82B399)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web statusClass: ACTIVE green · COMPLETED gold · PAUSED amber · CLOSED zinc. */
    fun status(s: String?, dark: Boolean): Color = when (s) {
        "ACTIVE" -> if (dark) green400 else emerald600
        "COMPLETED" -> accentText(dark)
        "PAUSED" -> if (dark) amber500 else amber600
        else -> slate400
    }

    /** Web signedClass: >= 0 green · < 0 red (light theme uses the deeper pair). */
    fun signed(v: Double, dark: Boolean): Color =
        if (v >= 0) (if (dark) green400 else emerald600) else (if (dark) red400 else red500)

    /** Web balance colour: negative red, else gold. */
    fun balance(v: Double, dark: Boolean): Color =
        if (v < 0) (if (dark) red400 else red500) else accentText(dark)

    fun amber(dark: Boolean): Color = if (dark) amber500 else amber600
}

// ── Formatting (iOS TradingAccountsFormat twins) ────────────────────────────────────

private object TradingAccFmt {
    /** Web Money: ৳ + grouping, whole taka. */
    fun taka(v: Double): String = AlmaTheme.taka(Math.round(v).toInt())

    /** USDT volumes — whole numbers stay whole, decimals trim to 2 places, grouped. */
    fun usdt(v: Double): String {
        if (v == Math.floor(v) && Math.abs(v) < 1e15) {
            return String.format(Locale.US, "%,d", Math.round(v))
        }
        return String.format(Locale.US, "%,.2f", v).trimEnd('0').trimEnd('.')
    }

    /** ISO date → yyyy-MM-dd (web startDate.slice(0, 10)). */
    fun day(iso: String?): String =
        if (iso != null && iso.length >= 10) iso.take(10) else "—"

    /** ISO datetime → "yyyy-MM-dd HH:mm". */
    fun dateTime(iso: String?): String =
        if (iso != null && iso.length >= 16) iso.take(16).replace("T", " ") else day(iso)

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}

// ── Models (same field names the web TradingAccountListItem type declares) ──────────

private data class TradingAccRow(
    val id: String,
    val accountTitle: String,
    val binanceUid: String?,
    val accountType: String?,
    val status: String?,
    val startingCapital: Double?,
    val currentBalance: Double?,
    val totalProfit: Double?,
    val totalLoss: Double?,
    val totalExpenses: Double?,
    val totalWithdrawals: Double?,
    val merchantProgress: Double?,
    val partnershipEnabled: Boolean?,
    val partnershipNetStaffOwes: Double?,
    val staffSharePercent: Double?,
    val lastPartnershipSettledAt: String?,
    val commissionType: String?,
    val commissionRate: Double?,
    val fixedCommission: Double?,
    val startDate: String?,
    val assignedUserName: String?,
    val notes: String?,
    // Native edit form prefill (owner 2026-07-11: account create/edit is native).
    val merchantTarget: Double?,
    val completionBonus: Double?,
    val assignedUserId: String?,
) {
    companion object {
        fun from(o: JSONObject): TradingAccRow? {
            val id = o.str("id") ?: return null
            return TradingAccRow(
                id = id,
                accountTitle = o.str("accountTitle") ?: "—",
                binanceUid = o.str("binanceUid"),
                accountType = o.str("accountType"),
                status = o.str("status"),
                startingCapital = o.flexDouble("startingCapital"),
                currentBalance = o.flexDouble("currentBalance"),
                totalProfit = o.flexDouble("totalProfit"),
                totalLoss = o.flexDouble("totalLoss"),
                totalExpenses = o.flexDouble("totalExpenses"),
                totalWithdrawals = o.flexDouble("totalWithdrawals"),
                merchantProgress = o.flexDouble("merchantProgress"),
                partnershipEnabled = o.flexBool("partnershipEnabled"),
                partnershipNetStaffOwes = o.flexDouble("partnershipNetStaffOwes"),
                staffSharePercent = o.flexDouble("staffSharePercent"),
                lastPartnershipSettledAt = o.str("lastPartnershipSettledAt"),
                commissionType = o.str("commissionType"),
                commissionRate = o.flexDouble("commissionRate"),
                fixedCommission = o.flexDouble("fixedCommission"),
                startDate = o.str("startDate"),
                assignedUserName = o.optJSONObject("assignedUser")?.str("name"),
                notes = o.str("notes"),
                merchantTarget = o.flexDouble("merchantTarget"),
                completionBonus = o.flexDouble("completionBonus"),
                assignedUserId = o.str("assignedUserId"),
            )
        }
    }
}

/** Web TradingSummary — the detail page's KPI numbers. */
private data class TradingAccSummary(
    val startingCapital: Double, val currentBalance: Double, val totalProfit: Double,
    val totalLoss: Double, val totalFees: Double, val totalExpenses: Double,
    val totalWithdrawals: Double, val totalTrades: Int, val totalTradedUsdt: Double,
    val totalBuyUsdt: Double, val totalSellUsdt: Double, val usdtBalance: Double,
    val netOperationalProfit: Double, val roiPct: Double, val deposits: Double,
    val adjustments: Double, val merchantProgress: Double,
) {
    companion object {
        fun from(o: JSONObject) = TradingAccSummary(
            startingCapital = o.flexDouble("startingCapital") ?: 0.0,
            currentBalance = o.flexDouble("currentBalance") ?: 0.0,
            totalProfit = o.flexDouble("totalProfit") ?: 0.0,
            totalLoss = o.flexDouble("totalLoss") ?: 0.0,
            totalFees = o.flexDouble("totalFees") ?: 0.0,
            totalExpenses = o.flexDouble("totalExpenses") ?: 0.0,
            totalWithdrawals = o.flexDouble("totalWithdrawals") ?: 0.0,
            totalTrades = o.flexDouble("totalTrades")?.let { Math.round(it).toInt() } ?: 0,
            totalTradedUsdt = o.flexDouble("totalTradedUsdt") ?: 0.0,
            totalBuyUsdt = o.flexDouble("totalBuyUsdt") ?: 0.0,
            totalSellUsdt = o.flexDouble("totalSellUsdt") ?: 0.0,
            usdtBalance = o.flexDouble("usdtBalance") ?: 0.0,
            netOperationalProfit = o.flexDouble("netOperationalProfit") ?: 0.0,
            roiPct = o.flexDouble("roiPct") ?: 0.0,
            deposits = o.flexDouble("deposits") ?: 0.0,
            adjustments = o.flexDouble("adjustments") ?: 0.0,
            merchantProgress = o.flexDouble("merchantProgress") ?: 0.0,
        )
    }
}

/** Web TradingDailySummary — Today Summary cells + ranges strip rows. */
private data class TradingAccDay(
    val tradesCount: Int, val buyUsdtVolume: Double, val sellUsdtVolume: Double,
    val usdtVolume: Double, val profit: Double, val loss: Double, val fees: Double,
    val expenses: Double, val netResult: Double,
) {
    companion object {
        fun from(o: JSONObject) = TradingAccDay(
            tradesCount = o.flexDouble("tradesCount")?.let { Math.round(it).toInt() } ?: 0,
            buyUsdtVolume = o.flexDouble("buyUsdtVolume") ?: 0.0,
            sellUsdtVolume = o.flexDouble("sellUsdtVolume") ?: 0.0,
            usdtVolume = o.flexDouble("usdtVolume") ?: 0.0,
            profit = o.flexDouble("profit") ?: 0.0,
            loss = o.flexDouble("loss") ?: 0.0,
            fees = o.flexDouble("fees") ?: 0.0,
            expenses = o.flexDouble("expenses") ?: 0.0,
            netResult = o.flexDouble("netResult") ?: 0.0,
        )
    }
}

private data class TradingAccTrade(
    val id: String, val tradeType: String, val usdtAmount: Double, val netProfit: Double,
    val tradeDate: String?, val deletedAt: String?,
) {
    companion object {
        fun from(o: JSONObject): TradingAccTrade? {
            val id = o.str("id") ?: return null
            return TradingAccTrade(
                id = id,
                tradeType = o.str("tradeType") ?: "BUY",
                usdtAmount = o.flexDouble("usdtAmount") ?: 0.0,
                netProfit = o.flexDouble("netProfit") ?: 0.0,
                tradeDate = o.str("tradeDate"),
                deletedAt = o.str("deletedAt"),
            )
        }
    }
}

private data class TradingAccExpense(
    val id: String, val expenseType: String, val amount: Double, val paidBy: String?,
    val expenseDate: String?,
) {
    companion object {
        fun from(o: JSONObject): TradingAccExpense? {
            val id = o.str("id") ?: return null
            return TradingAccExpense(
                id = id,
                expenseType = o.str("expenseType") ?: "—",
                amount = o.flexDouble("amount") ?: 0.0,
                paidBy = o.str("paidBy"),
                expenseDate = o.str("expenseDate"),
            )
        }
    }
}

/** GET /api/trading/accounts/{id}/summary — flat payload; tolerate {ok,data}. */
private class TradingAccDetail(
    val account: TradingAccRow?,
    val summary: TradingAccSummary?,
    val today: TradingAccDay?,
    val ranges: List<Pair<String, TradingAccDay>>,
    val recentTrades: List<TradingAccTrade>,
    val recentExpenses: List<TradingAccExpense>,
) {
    companion object {
        fun from(root: JSONObject): TradingAccDetail {
            val c = root.optJSONObject("data") ?: root
            val ranges = mutableListOf<Pair<String, TradingAccDay>>()
            c.optJSONObject("ranges")?.let { r ->
                listOf(
                    "Today" to "today", "Yesterday" to "yesterday",
                    "Last 7 days" to "last7", "This month" to "currentMonth",
                ).forEach { (label, key) ->
                    r.optJSONObject(key)?.let { ranges.add(label to TradingAccDay.from(it)) }
                }
            }
            return TradingAccDetail(
                account = c.optJSONObject("account")?.let { TradingAccRow.from(it) },
                summary = c.optJSONObject("summary")?.let { TradingAccSummary.from(it) },
                today = c.optJSONObject("today")?.let { TradingAccDay.from(it) },
                ranges = ranges,
                recentTrades = c.optJSONArray("recentTrades")?.mapObjects { TradingAccTrade.from(it) } ?: emptyList(),
                recentExpenses = c.optJSONArray("recentExpenses")?.mapObjects { TradingAccExpense.from(it) } ?: emptyList(),
            )
        }
    }
}

/** GET /api/trading/staff rows (web TradingUser: id/name/role). */
private data class TradingAccStaff(val id: String, val name: String, val role: String?)

// ── State holder (iOS TradingAccountsVM twin) ───────────────────────────────────────

private class TradingAccountsState {
    var accounts by mutableStateOf(listOf<TradingAccRow>())
    var search by mutableStateOf("")
    var status by mutableStateOf("ALL")     // ALL | ACTIVE | PAUSED | COMPLETED | CLOSED
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var staff by mutableStateOf(listOf<TradingAccStaff>())

    // Hero summary — computed from the loaded list, same columns the web table sums.
    val totalBalance: Long get() = Math.round(accounts.sumOf { it.currentBalance ?: 0.0 })
    val totalCapital: Long get() = Math.round(accounts.sumOf { it.startingCapital ?: 0.0 })
    val totalProfit: Long get() = Math.round(accounts.sumOf { it.totalProfit ?: 0.0 })
    val totalExpenses: Long get() = Math.round(accounts.sumOf { it.totalExpenses ?: 0.0 })
    val activeCount: Int get() = accounts.count { it.status == "ACTIVE" }

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** Replicates the web api.trading.accounts params exactly (search + status). */
    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject("/api/trading/accounts", mapOf("search" to search, "status" to status)),
            )
            accounts = c.optJSONArray("accounts")?.mapObjects { TradingAccRow.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** GET /api/trading/staff — assignment picker (web loads it for the modal). */
    suspend fun loadStaff() {
        try {
            val c = unwrap(AlmaApi.getObject("/api/trading/staff"))
            staff = c.optJSONArray("staff")?.mapObjects { s ->
                s.str("id")?.let { TradingAccStaff(it, s.str("name") ?: "—", s.str("role")) }
            } ?: emptyList()
        } catch (_: Exception) { /* picker stays empty — non-fatal */ }
    }

    /** Detail payload for the sheet — same endpoint the web detail page hits. */
    suspend fun loadDetail(id: String): TradingAccDetail =
        TradingAccDetail.from(AlmaApi.getObject("/api/trading/accounts/$id/summary"))

    /** Create (POST) or update (PATCH) — web TradingAccountModal payload verbatim. */
    suspend fun saveAccount(body: JSONObject, editingId: String?): Boolean {
        return try {
            val resp = if (editingId != null) {
                AlmaApi.send("PATCH", "/api/trading/accounts/$editingId", body)
            } else {
                AlmaApi.send("POST", "/api/trading/accounts", body)
            }
            if (resp.flexBool("ok") != true) {
                toast = resp.str("error") ?: "Could not save account"
                false
            } else {
                toast = if (editingId == null) "Trading account created" else "Trading account updated"
                load()
                true
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: Exception) {
            toast = e.message
            false
        }
    }

    /** Archive — the web sends PATCH {action:'archive'}. */
    suspend fun archiveAccount(row: TradingAccRow): Boolean {
        return try {
            val resp = AlmaApi.send(
                "PATCH", "/api/trading/accounts/${row.id}",
                JSONObject().put("action", "archive"),
            )
            if (resp.flexBool("ok") != true) {
                toast = resp.str("error") ?: "Archive হয়নি"
                false
            } else {
                toast = "অ্যাকাউন্ট archive হয়েছে"
                load()
                true
            }
        } catch (e: Exception) {
            toast = e.message
            false
        }
    }
}

/** Web TRADING_STATUS_OPTIONS — All / Active / Paused / Completed / Closed. */
private val tradingAccStatusOptions = listOf(
    "All" to "ALL", "Active" to "ACTIVE", "Paused" to "PAUSED",
    "Completed" to "COMPLETED", "Closed" to "CLOSED",
)

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradingAccountsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    // Role gating (defense-in-depth) — create/edit/archive are admin-only writes. Server
    // still 403s non-admins; this just stops the app from offering the controls.
    RememberSession()
    val canManage = AlmaSession.isAdmin
    val vm = remember { TradingAccountsState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<TradingAccRow?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TradingAccRow?>(null) }
    var archiving by remember { mutableStateOf<TradingAccRow?>(null) }
    var searchJob by remember { mutableStateOf<Job?>(null) }

    LaunchedEffect(Unit) { vm.load(); vm.loadStaff() }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Spacer(Modifier.height(0.dp)) }
            item { TradingAccHeroCard(vm.totalBalance, vm.accounts.size, vm.activeCount, vm.totalProfit) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TradingAccStatTile(
                        "Initial capital", AlmaTheme.takaShort(vm.totalCapital), "সব অ্যাকাউন্টের মূলধন",
                        tint = TradingAccPalette.accentText(dark), accent = TradingAccPalette.coral,
                        dark = dark, modifier = Modifier.weight(1f),
                    )
                    TradingAccStatTile(
                        "Expenses", AlmaTheme.takaShort(vm.totalExpenses), "মোট অপারেটিং খরচ",
                        tint = TradingAccPalette.amber(dark), accent = TradingAccPalette.amber500,
                        dark = dark, modifier = Modifier.weight(1f),
                    )
                }
            }
            // Web header "Create trading account" button — admin-only write.
            if (canManage) {
                item {
                    Text(
                        "＋ নতুন trading account",
                        color = TradingAccPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(TradingAccPalette.coral.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .border(1.dp, TradingAccPalette.coral.copy(alpha = 0.3f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .plainClick { showCreate = true }
                            .padding(vertical = 11.dp),
                    )
                }
            }
            item {
                // Search (web SearchInput: title / UID / staff, server-side, debounced).
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("🔍", fontSize = 13.sp)
                    BasicTextField(
                        value = vm.search,
                        onValueChange = { newValue ->
                            vm.search = newValue
                            searchJob?.cancel()
                            searchJob = scope.launch {
                                delay(450)   // server-side search, debounced
                                vm.load()
                            }
                        },
                        singleLine = true,
                        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                        decorationBox = { inner ->
                            Box {
                                if (vm.search.isEmpty()) {
                                    Text("Search title, UID, staff…", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                                }
                                inner()
                            }
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            item {
                // Status chips (web Select → chips: All/Active/Paused/Completed/Closed).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    tradingAccStatusOptions.forEach { (label, value) ->
                        val tint = if (value == "ALL") TradingAccPalette.sage
                        else TradingAccPalette.status(value, dark)
                        TradingAccChip(label, tint, vm.status == value, dark) {
                            vm.status = value
                            scope.launch { vm.load() }
                        }
                    }
                }
            }
            if (vm.authExpired) {
                item { TradingAccAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
            }
            vm.error?.let { err ->
                item {
                    Text(
                        "⚠️ $err", color = TradingAccPalette.red500, fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                    )
                }
            }
            if (vm.loading && vm.accounts.isEmpty()) {
                items(5) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            }
            items(vm.accounts, key = { it.id }) { a ->
                TradingAccRowCard(
                    a, dark,
                    canManage = canManage,
                    onTap = { selected = a },
                    onEdit = { editing = a },
                    onArchive = { archiving = a },
                )
            }
            if (!vm.loading && vm.accounts.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("💳", fontSize = 34.sp)
                        Text("কোনো ট্রেডিং অ্যাকাউন্ট নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                        Text("অ্যাকাউন্ট তৈরি / এডিট ওয়েবে হয়", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    }
                }
            }
            item {
                Text(
                    "🌐 সব অপশন — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/trading/accounts", "Trading accounts") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        // Toast (iOS bottom capsule twin).
        vm.toast?.let { t ->
            LaunchedEffect(t) { delay(2600); vm.toast = null }
            Text(
                t, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    selected?.let { row ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            TradingAccDetailSheet(row, vm, dark) { p, t ->
                selected = null
                ctx.openWebForced(p, t)
            }
        }
    }

    if (showCreate) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            TradingAccFormSheet(vm, editing = null, dark = dark) { showCreate = false }
        }
    }

    editing?.let { row ->
        ModalBottomSheet(onDismissRequest = { editing = null }, containerColor = AlmaTheme.rootBg(dark)) {
            TradingAccFormSheet(vm, editing = row, dark = dark) { editing = null }
        }
    }

    archiving?.let { row ->
        AlertDialog(
            onDismissRequest = { archiving = null },
            title = { Text("\"${row.accountTitle}\" archive করবেন? Active list থেকে সরে যাবে।", fontSize = 15.sp) },
            confirmButton = {
                TextButton(onClick = {
                    archiving = null
                    scope.launch { vm.archiveAccount(row) }
                }) { Text("হ্যাঁ, archive করুন", color = TradingAccPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { archiving = null }) { Text("বাতিল") } },
        )
    }
}

// ── Count-up (0 → target on appear; snaps to exact target at rest) ──────────────────

@Composable
private fun tradingAccCountUp(target: Long): Long {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val frac by animateFloatAsState(
        targetValue = if (started) 1f else 0f,
        animationSpec = tween(900),
        label = "tradingAccCountUp",
    )
    return Math.round(target * frac.toDouble())
}

// ── Hero board (dark anchor in BOTH themes — Dashboard hero recipe) ──────────────────

@Composable
private fun TradingAccHeroCard(balance: Long, accounts: Int, active: Int, profit: Long) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(Color(0xFF181528), shape)   // iOS Color(0.094, 0.082, 0.157)
            .background(
                Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)),
                shape,
            )
            .background(
                Brush.linearGradient(
                    listOf(Color.Transparent, AlmaTheme.sage.copy(alpha = 0.30f)),
                ),
                shape,
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "মোট ব্যালেন্স · TRADING",
            color = TradingAccPalette.sage, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        Text(
            AlmaTheme.takaShort(tradingAccCountUp(balance)),
            color = if (balance < 0) TradingAccPalette.red400 else Color.White,
            fontSize = 40.sp, fontWeight = FontWeight.Black, maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "সব ট্রেডিং অ্যাকাউন্টের কারেন্ট ব্যালেন্স",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            TradingAccHeroStat("Accounts", "$accounts", Color.White, "মোট অ্যাকাউন্ট")
            Box(
                Modifier.padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp).height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            TradingAccHeroStat("Active", "$active", TradingAccPalette.sage, "চালু আছে")
            Box(
                Modifier.padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp).height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            TradingAccHeroStat("Profit", AlmaTheme.takaShort(profit), TradingAccPalette.green400, "মোট প্রফিট")
        }
    }
}

@Composable
private fun TradingAccHeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(), color = Color.White.copy(alpha = 0.55f),
            fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Small glass stat tile — value + sub line over a soft accent wash. */
@Composable
private fun TradingAccStatTile(
    label: String, value: String, sub: String,
    tint: Color, accent: Color, dark: Boolean, modifier: Modifier = Modifier,
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
            label.uppercase(), color = AlmaTheme.inkSecondary(dark),
            fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun TradingAccChip(label: String, tint: Color, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) tint else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) tint.copy(alpha = if (dark) 0.28f else 0.16f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) tint.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun TradingAccAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(TradingAccPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

/** Web goal-progress bar (Capsule fill). */
@Composable
private fun TradingAccProgressBar(pct: Double, tint: Color, dark: Boolean, height: Int = 5) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(height.dp)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.08f), CircleShape),
    ) {
        Box(
            Modifier
                .fillMaxWidth((pct / 100.0).toFloat().coerceIn(0f, 1f))
                .fillMaxHeight()
                .background(tint, CircleShape),
        )
    }
}

// ── Row (web mobile card: title + 50/50 pill · staff · UID · balance · progress) ────

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TradingAccRowCard(
    a: TradingAccRow,
    dark: Boolean,
    canManage: Boolean,
    onTap: () -> Unit,
    onEdit: () -> Unit,
    onArchive: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Column(
            Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CARD)
                .combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onTap,
                    // Edit/Archive are admin-only — only arm the long-press for admins.
                    onLongClick = if (canManage) ({ menuOpen = true }) else null,   // iOS contextMenu twin
                )
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            a.accountTitle,
                            color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        if (a.partnershipEnabled == true) TradingAccPartnershipPill(a, dark)
                    }
                    val bits = mutableListOf(a.assignedUserName ?: "Unassigned")
                    bits.add(if (a.binanceUid.isNullOrEmpty()) "No UID" else a.binanceUid)
                    a.accountType?.takeIf { it.isNotEmpty() }?.let { bits.add(it.replace("_", " ")) }
                    Text(
                        bits.joinToString(" · "),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.width(6.dp))
                TradingAccStatusPill(a.status, dark)
            }
            Row {
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        "BALANCE", color = AlmaTheme.inkSecondary(dark),
                        fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
                    )
                    Text(
                        TradingAccFmt.taka(a.currentBalance ?: 0.0),
                        color = TradingAccPalette.balance(a.currentBalance ?: 0.0, dark),
                        fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    )
                }
                Spacer(Modifier.weight(1f))
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        "PROFIT", color = AlmaTheme.inkSecondary(dark),
                        fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
                    )
                    Text(
                        TradingAccFmt.taka(a.totalProfit ?: 0.0),
                        color = TradingAccPalette.signed(a.totalProfit ?: 0.0, dark),
                        fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    )
                }
            }
            // Web goal-progress cell (Progress + N%).
            val pct = (a.merchantProgress ?: 0.0).coerceIn(0.0, 100.0)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) {
                    TradingAccProgressBar(pct, TradingAccPalette.accentText(dark), dark)
                }
                Text(
                    "${Math.round(pct)}%",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (canManage) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { Text("✏️ সম্পাদনা") }, onClick = { menuOpen = false; onEdit() })
                DropdownMenuItem(
                    text = { Text("🗄 Archive", color = TradingAccPalette.red500) },
                    onClick = { menuOpen = false; onArchive() },
                )
            }
        }
    }
}

/** Web 50/50 partnership pill — gold, with the net-staff-owes hint when non-zero. */
@Composable
private fun TradingAccPartnershipPill(a: TradingAccRow, dark: Boolean) {
    val tint = TradingAccPalette.accentText(dark)
    val owed = a.partnershipNetStaffOwes ?: 0.0
    val label = if (owed != 0.0) {
        "50/50 · ৳${String.format(Locale.US, "%,d", Math.round(Math.abs(owed)))}"
    } else "50/50"
    Text(
        label,
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.10f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun TradingAccStatusPill(status: String?, dark: Boolean) {
    val tint = TradingAccPalette.status(status, dark)
    Text(
        status ?: "—",
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

// ── Detail sheet (web /trading/accounts/[id] parity, read-only) ─────────────────────

@Composable
private fun TradingAccDetailSheet(
    row: TradingAccRow,
    vm: TradingAccountsState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    var detail by remember { mutableStateOf<TradingAccDetail?>(null) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    val account = detail?.account ?: row

    LaunchedEffect(row.id) {
        try {
            val d = vm.loadDetail(row.id)
            detail = d
            if (d.summary == null) loadError = "অ্যাকাউন্ট ডেটা পাওয়া যায়নি"
        } catch (e: Exception) {
            loadError = e.message
        }
        loading = false
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header: initials avatar (sage) + title + uid·staff + status pill.
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier
                    .size(44.dp)
                    .background(TradingAccPalette.sage.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, TradingAccPalette.sage.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    TradingAccFmt.initials(account.accountTitle),
                    color = TradingAccPalette.sage, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(account.accountTitle, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "${if (account.binanceUid.isNullOrEmpty()) "No UID" else account.binanceUid} · ${account.assignedUserName ?: "Unassigned"}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
            TradingAccStatusPill(account.status, dark)
        }

        if (loading) {
            // The ONE spinner while the summary loads.
            Row(
                Modifier.fillMaxWidth().padding(vertical = 40.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.size(20.dp), color = TradingAccPalette.coral, strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
            }
        } else if (loadError != null) {
            Text(
                "⚠️ $loadError", color = TradingAccPalette.red500, fontSize = 13.sp,
                modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            )
        } else {
            detail?.summary?.let { s ->
                // Web tone-red risk card when the balance dips below zero.
                if (s.currentBalance < 0) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(TradingAccPalette.red500.copy(alpha = if (dark) 0.14f else 0.08f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .border(1.dp, TradingAccPalette.red500.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            "Risk warning: account balance is negative.",
                            color = if (dark) TradingAccPalette.red400 else TradingAccPalette.red500,
                            fontSize = 13.sp, fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "ব্যালেন্স শূন্যের নিচে নামলে Super Admin নোটিফিকেশন তৈরি হয়",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        )
                    }
                }

                // KPI grid (web 2-col KpiCards).
                val cells: List<Triple<String, String, Color>> = listOf(
                    Triple("Current balance", TradingAccFmt.taka(s.currentBalance), TradingAccPalette.balance(s.currentBalance, dark)),
                    Triple("Initial capital", TradingAccFmt.taka(s.startingCapital), TradingAccPalette.accentText(dark)),
                    Triple("Total trades", "${s.totalTrades}", AlmaTheme.ink(dark)),
                    Triple("USDT balance", TradingAccFmt.usdt(s.usdtBalance), AlmaTheme.ink(dark)),
                    Triple("Total profit", TradingAccFmt.taka(s.totalProfit), TradingAccPalette.signed(1.0, dark)),
                    Triple("Total loss", TradingAccFmt.taka(s.totalLoss), TradingAccPalette.signed(-1.0, dark)),
                    Triple("Expenses", TradingAccFmt.taka(s.totalExpenses), TradingAccPalette.amber(dark)),
                    Triple("Withdrawals", TradingAccFmt.taka(s.totalWithdrawals), AlmaTheme.inkSecondary(dark)),
                    Triple("ROI", String.format(Locale.US, "%.2f%%", s.roiPct), TradingAccPalette.signed(s.roiPct, dark)),
                    Triple("Net P/L", TradingAccFmt.taka(s.netOperationalProfit), TradingAccPalette.signed(s.netOperationalProfit, dark)),
                )
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    cells.chunked(2).forEach { pair ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            pair.forEach { (label, value, tint) ->
                                Column(
                                    Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL).padding(vertical = 12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(3.dp),
                                ) {
                                    Text(
                                        value, color = tint, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                                        fontFamily = FontFamily.Monospace, maxLines = 1,
                                    )
                                    Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                                }
                            }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }

                // Account card (web left card).
                Column(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("ACCOUNT", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                    TradingAccStatRow("Type", (account.accountType ?: "—").replace("_", " "), AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Started", TradingAccFmt.day(account.startDate), AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Assigned staff", account.assignedUserName ?: "Unassigned", AlmaTheme.ink(dark), dark)
                    val commission = when (account.commissionType) {
                        "PERCENTAGE" -> String.format(Locale.US, "%.2f%% of profit", account.commissionRate ?: 0.0)
                        "FIXED" -> TradingAccFmt.taka(account.fixedCommission ?: 0.0)
                        else -> "None"
                    }
                    TradingAccStatRow("Commission", commission, AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Deposits", TradingAccFmt.taka(s.deposits), AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Withdrawals", TradingAccFmt.taka(s.totalWithdrawals), AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Adjustments", TradingAccFmt.taka(s.adjustments), AlmaTheme.ink(dark), dark)
                    TradingAccStatRow("Net ROI", String.format(Locale.US, "%.2f%%", s.roiPct), TradingAccPalette.signed(s.roiPct, dark), dark)
                    val progress = s.merchantProgress.coerceIn(0.0, 100.0)
                    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Row {
                            Text("Merchant goal progress", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                            Spacer(Modifier.weight(1f))
                            Text(
                                "${Math.round(progress)}%",
                                color = TradingAccPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                        TradingAccProgressBar(progress, TradingAccPalette.accentText(dark), dark)
                    }
                }

                // Partnership (web 50/50 blocks — settle stays on the web).
                if (account.partnershipEnabled == true) {
                    val tint = TradingAccPalette.accentText(dark)
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("PARTNERSHIP", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                            Text(
                                "50/50", color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier
                                    .background(tint.copy(alpha = 0.10f), CircleShape)
                                    .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                        TradingAccStatRow(
                            "Staff share",
                            String.format(Locale.US, "%.0f%%", account.staffSharePercent ?: 50.0),
                            AlmaTheme.ink(dark), dark,
                        )
                        account.partnershipNetStaffOwes?.let { owed ->
                            TradingAccStatRow(
                                "Net staff owes", TradingAccFmt.taka(owed),
                                if (owed > 0) TradingAccPalette.amber(dark) else TradingAccPalette.signed(1.0, dark),
                                dark,
                            )
                        }
                        TradingAccStatRow("Last settled", TradingAccFmt.day(account.lastPartnershipSettledAt), AlmaTheme.ink(dark), dark)
                        Text("সেটেলমেন্ট ওয়েবে হয়", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    }
                }

                // Today Summary (web right card).
                detail?.today?.let { t ->
                    val todayCells: List<Triple<String, String, Color>> = listOf(
                        Triple("Trades", "${t.tradesCount}", AlmaTheme.ink(dark)),
                        Triple("Buy USDT", TradingAccFmt.usdt(t.buyUsdtVolume), AlmaTheme.ink(dark)),
                        Triple("Sell USDT", TradingAccFmt.usdt(t.sellUsdtVolume), AlmaTheme.ink(dark)),
                        Triple("Profit", TradingAccFmt.taka(t.profit), TradingAccPalette.signed(1.0, dark)),
                        Triple("Loss", TradingAccFmt.taka(t.loss), TradingAccPalette.signed(-1.0, dark)),
                        Triple("Fees", TradingAccFmt.taka(t.fees), TradingAccPalette.amber(dark)),
                        Triple("Expenses", TradingAccFmt.taka(t.expenses), TradingAccPalette.signed(-1.0, dark)),
                        Triple("Net result", TradingAccFmt.taka(t.netResult), TradingAccPalette.signed(t.netResult, dark)),
                    )
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("TODAY SUMMARY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                        todayCells.chunked(3).forEach { rowCells ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                rowCells.forEach { (label, value, tint) ->
                                    Column(
                                        Modifier
                                            .weight(1f)
                                            .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(10.dp))
                                            .padding(8.dp),
                                        verticalArrangement = Arrangement.spacedBy(2.dp),
                                    ) {
                                        Text(
                                            label.uppercase(), color = AlmaTheme.inkSecondary(dark),
                                            fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1,
                                        )
                                        Text(
                                            value, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                                            fontFamily = FontFamily.Monospace, maxLines = 1,
                                        )
                                    }
                                }
                                repeat(3 - rowCells.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                }

                // Ranges strip (web: Today / Yesterday / Last 7 days / This month).
                detail?.ranges?.takeIf { it.isNotEmpty() }?.let { ranges ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        ranges.chunked(2).forEach { pair ->
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                pair.forEach { (label, day) ->
                                    Column(
                                        Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                                        verticalArrangement = Arrangement.spacedBy(3.dp),
                                    ) {
                                        Text(
                                            label.uppercase(), color = AlmaTheme.inkSecondary(dark),
                                            fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
                                        )
                                        Text(
                                            TradingAccFmt.taka(day.netResult),
                                            color = TradingAccPalette.signed(day.netResult, dark),
                                            fontSize = 14.sp, fontWeight = FontWeight.Bold,
                                            fontFamily = FontFamily.Monospace, maxLines = 1,
                                        )
                                        Text(
                                            "${day.tradesCount} trades · ${TradingAccFmt.usdt(day.usdtVolume)} USDT",
                                            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1,
                                        )
                                    }
                                }
                                if (pair.size == 1) Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }

                // Recent trades (web TRADES tab, read-only slice).
                Column(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("RECENT TRADES", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                    val trades = detail?.recentTrades ?: emptyList()
                    if (trades.isEmpty()) {
                        Text("কোনো ট্রেড নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    } else {
                        trades.take(10).forEach { t ->
                            val deleted = t.deletedAt != null
                            Row(
                                Modifier.fillMaxWidth().alpha(if (deleted) 0.55f else 1f),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                val buy = t.tradeType == "BUY"
                                Text(
                                    t.tradeType,
                                    color = if (buy) TradingAccPalette.accentText(dark) else TradingAccPalette.signed(1.0, dark),
                                    fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                    modifier = Modifier
                                        .background(
                                            (if (buy) TradingAccPalette.coral else TradingAccPalette.green400).copy(alpha = 0.13f),
                                            CircleShape,
                                        )
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                    Text(
                                        "${TradingAccFmt.usdt(t.usdtAmount)} USDT",
                                        color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                        fontFamily = FontFamily.Monospace,
                                        textDecoration = if (deleted) TextDecoration.LineThrough else null,
                                    )
                                    Text(TradingAccFmt.dateTime(t.tradeDate), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                                }
                                // Web: BUY rows show muted P/L, SELL rows signed green/red.
                                Text(
                                    TradingAccFmt.taka(t.netProfit),
                                    color = if (buy) AlmaTheme.inkSecondary(dark) else TradingAccPalette.signed(t.netProfit, dark),
                                    fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                                )
                            }
                        }
                    }
                }

                // Recent expenses (web EXPENSES tab, read-only slice).
                val expenses = detail?.recentExpenses ?: emptyList()
                if (expenses.isNotEmpty()) {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text("RECENT EXPENSES", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                        expenses.take(8).forEach { e ->
                            Row(
                                Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                    Text(
                                        e.expenseType, color = AlmaTheme.ink(dark), fontSize = 12.sp,
                                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(TradingAccFmt.day(e.expenseDate), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                                }
                                if (account.partnershipEnabled == true && e.paidBy != null) {
                                    Text(
                                        if (e.paidBy == "OWNER") "Owner" else "Staff",
                                        color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                        modifier = Modifier
                                            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                                            .padding(horizontal = 6.dp, vertical = 2.dp),
                                    )
                                }
                                Text(
                                    TradingAccFmt.taka(e.amount),
                                    color = TradingAccPalette.signed(-1.0, dark),
                                    fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                                )
                            }
                        }
                    }
                }
            }
        }

        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/trading/accounts/${row.id}", row.accountTitle) }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun TradingAccStatRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(value, color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
    }
}

// ── Create / edit form sheet (owner 2026-07-11: native writes — web
// TradingAccountModal parity: same fields, same payload, partnership + commission). ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TradingAccFormSheet(
    vm: TradingAccountsState,
    editing: TradingAccRow?,
    dark: Boolean,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var accountTitle by remember { mutableStateOf(editing?.accountTitle ?: "") }
    var startingCapital by remember {
        mutableStateOf(editing?.startingCapital?.let { String.format(Locale.US, "%.0f", it) } ?: "")
    }
    var accountType by remember { mutableStateOf(editing?.accountType ?: "BINANCE_P2P") }
    var binanceUid by remember { mutableStateOf(editing?.binanceUid ?: "") }
    var merchantTarget by remember {
        mutableStateOf(editing?.merchantTarget?.let { String.format(Locale.US, "%.0f", it) } ?: "")
    }
    var status by remember { mutableStateOf(editing?.status ?: "ACTIVE") }
    var assignedUserId by remember { mutableStateOf(editing?.assignedUserId ?: "") }
    var partnershipEnabled by remember { mutableStateOf(editing?.partnershipEnabled ?: false) }
    var staffSharePercent by remember {
        mutableStateOf(editing?.staffSharePercent?.let { String.format(Locale.US, "%.0f", it) } ?: "50")
    }
    var commissionType by remember { mutableStateOf(editing?.commissionType ?: "NONE") }
    var commissionRate by remember {
        mutableStateOf(editing?.commissionRate?.let { String.format(Locale.US, "%.2f", it) } ?: "")
    }
    var fixedCommission by remember {
        mutableStateOf(editing?.fixedCommission?.let { String.format(Locale.US, "%.0f", it) } ?: "")
    }
    var completionBonus by remember {
        mutableStateOf(editing?.completionBonus?.let { String.format(Locale.US, "%.0f", it) } ?: "")
    }
    var notes by remember { mutableStateOf(editing?.notes ?: "") }
    var startDate by remember {
        mutableStateOf(editing?.startDate?.take(10) ?: tradingAccTodayDhaka())
    }
    var submitting by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }

    fun num(s: String): Double = s.replace(",", "").toDoubleOrNull() ?: 0.0
    val canSubmit = accountTitle.trim().isNotEmpty() && num(startingCapital) > 0

    fun submit() {
        if (!canSubmit || submitting) return
        submitting = true
        errorText = null
        // Web TradingAccountModal payload verbatim — omit optional keys like Swift's nil.
        val body = JSONObject()
            .put("accountTitle", accountTitle.trim())
            .put("binanceUid", binanceUid)
            .put("accountType", accountType)
            .put("status", status)
            .put("startingCapital", num(startingCapital))
            .put("commissionType", commissionType)
            .put("commissionRate", num(commissionRate))
            .put("fixedCommission", num(fixedCommission))
            .put("completionBonus", num(completionBonus))
            .put("startDate", startDate)
            .put("notes", notes)
            .put("partnershipEnabled", partnershipEnabled)
            .put("staffSharePercent", if (num(staffSharePercent) > 0) num(staffSharePercent) else 50.0)
        if (merchantTarget.isNotEmpty()) body.put("merchantTarget", num(merchantTarget))
        if (assignedUserId.isNotEmpty()) body.put("assignedUserId", assignedUserId)
        if (editing != null) body.put("action", "update")
        scope.launch {
            val ok = vm.saveAccount(body, editing?.id)
            submitting = false
            if (ok) onDone() else errorText = vm.toast
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                if (editing == null) "Create trading account" else "Edit trading account",
                color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold,
            )
            Text(
                "নিজস্ব capital, staff, খরচ ও ROI-সহ স্বাধীন merchant wallet।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }

        TradingAccField("Account Name *", accountTitle, dark, KeyboardType.Text) { accountTitle = it }
        TradingAccField("Initial Capital (BDT) *", startingCapital, dark) { startingCapital = it }
        TradingAccPicker(
            "Account type", accountType, dark,
            listOf(
                "Binance P2P" to "BINANCE_P2P", "Merchant" to "MERCHANT",
                "Staff operated" to "STAFF_OPERATED", "Other" to "OTHER",
            ),
        ) { accountType = it }
        TradingAccField("Binance UID", binanceUid, dark, KeyboardType.Text) { binanceUid = it }
        TradingAccField("Merchant Goal / Monthly Target", merchantTarget, dark) { merchantTarget = it }
        TradingAccPicker(
            "Status", status, dark,
            listOf("Active" to "ACTIVE", "Paused" to "PAUSED", "Completed" to "COMPLETED", "Closed" to "CLOSED"),
        ) { status = it }
        // Staff picker (GET /api/trading/staff).
        TradingAccPicker(
            "Unassigned", assignedUserId, dark,
            listOf("Unassigned" to "") + vm.staff.map { s ->
                (s.name + (s.role?.let { " · $it" } ?: "")) to s.id
            },
        ) { assignedUserId = it }
        // Start date.
        Row(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick { showDatePicker = true }
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Start date", color = AlmaTheme.ink(dark), fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            Text(startDate, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }

        // Partnership block (web: 50-50 loss share).
        Column(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "PARTNERSHIP / 50-50 LOSS SHARE",
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Enable partnership settlement", color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                Switch(
                    checked = partnershipEnabled,
                    onCheckedChange = { partnershipEnabled = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = TradingAccPalette.coral),
                )
            }
            if (partnershipEnabled) {
                TradingAccField("Staff share % (default 50)", staffSharePercent, dark) { staffSharePercent = it }
                Text(
                    "Partnership ON হলে trade commission auto-disable হবে — loss/expense settlement আলাদা হিসাবে হবে।",
                    color = TradingAccPalette.amber(dark), fontSize = 10.sp,
                )
            }
        }

        // Commission block (disabled while partnership on — web parity).
        Column(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "OPTIONAL STAFF COMMISSION",
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
            )
            if (partnershipEnabled) {
                Text("Commission disabled while partnership is active.", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Column(
                Modifier.alpha(if (partnershipEnabled) 0.5f else 1f),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TradingAccPicker(
                    "Commission type", commissionType, dark,
                    listOf(
                        "No commission" to "NONE", "Percentage of profit" to "PERCENTAGE",
                        "Fixed per profitable sell" to "FIXED",
                    ),
                    enabled = !partnershipEnabled,
                ) { commissionType = it }
                TradingAccField("Commission % of profit", commissionRate, dark, enabled = !partnershipEnabled) { commissionRate = it }
                TradingAccField("Fixed commission BDT", fixedCommission, dark, enabled = !partnershipEnabled) { fixedCommission = it }
                TradingAccField("Merchant completion bonus BDT", completionBonus, dark, enabled = !partnershipEnabled) { completionBonus = it }
            }
        }

        TradingAccField("Notes", notes, dark, KeyboardType.Text) { notes = it }
        Text(
            "Wallet formula: Initial Capital + Net Profit - Expenses - Withdrawals. " +
                "Account expenses also feed global finance and management reports.",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )
        errorText?.let {
            Text(it, color = TradingAccPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(
                    if (canSubmit && !submitting) TradingAccPalette.coral else TradingAccPalette.coral.copy(alpha = 0.4f),
                    RoundedCornerShape(14.dp),
                )
                .plainClick { if (canSubmit && !submitting) confirming = true }
                .padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (submitting) {
                CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(
                if (submitting) "Saving…" else "Save account",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
            )
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = {
                Text(
                    if (editing == null) {
                        "\"$accountTitle\" তৈরি করবেন? Capital ${AlmaTheme.takaShort(Math.round(num(startingCapital)))}"
                    } else {
                        "\"$accountTitle\" আপডেট করবেন?"
                    },
                    fontSize = 15.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = { confirming = false; submit() }) { Text("হ্যাঁ, সেভ করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }

    if (showDatePicker) {
        val pickerState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    pickerState.selectedDateMillis?.let { ms ->
                        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                        f.timeZone = TimeZone.getTimeZone("UTC")   // picker millis are UTC-midnight
                        startDate = f.format(Date(ms))
                    }
                    showDatePicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("বাতিল") } },
        ) {
            DatePicker(state = pickerState)
        }
    }
}

private fun tradingAccTodayDhaka(): String {
    val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
    return f.format(Date())
}

// ── Small form atoms ─────────────────────────────────────────────────────────────────

@Composable
private fun TradingAccField(
    placeholder: String,
    value: String,
    dark: Boolean,
    keyboard: KeyboardType = KeyboardType.Decimal,
    enabled: Boolean = true,
    onChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = { if (enabled) onChange(it) },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
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

@Composable
private fun TradingAccPicker(
    label: String,
    selection: String,
    dark: Boolean,
    options: List<Pair<String, String>>,
    enabled: Boolean = true,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick { if (enabled) open = true }
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                options.firstOrNull { it.second == selection }?.first ?: label,
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text("⌄", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (optLabel, optValue) ->
                DropdownMenuItem(text = { Text(optLabel) }, onClick = { open = false; onSelect(optValue) })
            }
        }
    }
}
