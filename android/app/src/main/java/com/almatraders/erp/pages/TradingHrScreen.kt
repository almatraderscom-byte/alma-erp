//
//  TradingHrScreen.kt
//  ALMA ERP — the Trading HR page (/trading/hr), Kotlin/Compose twin of
//  TradingHrSwiftUI.swift. Same endpoints, same colours, same blocks:
//    GET  /api/trading/hr                          → { employees, alerts, rankings, kpis }
//    GET  /api/trading/staff-summary               → { staff }   (monthly performance)
//    GET  /api/trading/hr/reports?userId=&limit=40 → { reports } (daily reports feed)
//  Money/HR writes (owner 2026-07-11, SENSITIVE — exact camelCase payloads, confirm
//  dialog before each):
//    POST /api/trading/hr           { userId, employeeIdGas, roleTitle, shift, status,
//                                     salary, commissionType, commissionRate,
//                                     fixedCommission, merchantCompletionBonus,
//                                     milestoneBonus, joiningDate, notes }
//    POST /api/trading/hr/reports   { userId, reportDate, accountIds[], totalTrades,
//                                     dailyProfitBdt, dailyLossBdt, issues,
//                                     screenshotProof, operationalNotes }
//  Web-parity: 8 KPI cards recomposed as bento hero + tiles · employee profile rows
//  with a native detail sheet · HR Alert Engine · 5 ranking cards · staff performance
//  summary · recent daily reports feed. Carried lessons: lenient per-field decoding,
//  no global overlays, confirm dialog before every write.
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object HRPalette {
    val coral = AlmaTheme.coral
    val sage = Color(0xFF82B399)
    val goldLt = Color(0xFFF4A28C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue500 = Color(0xFF3B82F6)
    val slate400 = Color(0xFF94A3B8)

    fun accentText(dark: Boolean) = if (dark) goldLt else Color(0xFFC45A3C)
    fun green(dark: Boolean) = if (dark) green400 else emerald600
    fun amber(dark: Boolean) = if (dark) amber500 else amber600
    fun signed(value: Int, dark: Boolean) = when {
        value > 0 -> green(dark)
        value < 0 -> red400
        else -> slate400
    }
    fun severity(s: String?, dark: Boolean) = when (s) {
        "CRITICAL" -> red500
        else -> amber(dark)
    }
}

// ── Formatting helpers ──────────────────────────────────────────────────────────────

private object HRFormat {
    fun initials(name: String): String {
        val parts = name.split(" ").filter { it.isNotBlank() }.take(2)
        val letters = parts.mapNotNull { it.firstOrNull()?.toString() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
    fun day(iso: String?): String {
        if (iso == null || iso.length < 10) return iso ?: "—"
        return iso.take(10)
    }
    fun taka(amount: Int): String = AlmaTheme.taka(amount)
    fun num(s: String): Double = s.replace(",", "").trim().toDoubleOrNull() ?: 0.0

    fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }.format(Date())
    fun fromPickerMillis(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))
}

// ── Models (same field names src/types/trading.ts declares — camelCase wire) ────────

private data class HRUser(
    val id: String, val name: String, val email: String?, val phone: String?,
    val role: String?, val employeeIdGas: String?, val joiningDate: String?,
) {
    companion object {
        fun from(o: JSONObject) = HRUser(
            o.str("id") ?: "", o.str("name") ?: "—", o.str("email"), o.str("phone"),
            o.str("role"), o.str("employeeIdGas"), o.str("joiningDate"),
        )
    }
}

private data class HRProfile(
    val employeeIdGas: String?, val roleTitle: String?, val shift: String?, val status: String?,
    val salary: Int, val commissionType: String?, val commissionRate: Double,
    val fixedCommission: Int, val merchantCompletionBonus: Int, val milestoneBonus: Int,
    val notes: String?, val joiningDate: String?,
) {
    companion object {
        fun from(o: JSONObject) = HRProfile(
            o.str("employeeIdGas"), o.str("roleTitle"), o.str("shift"), o.str("status"),
            o.flexInt("salary") ?: 0, o.str("commissionType"), o.flexDouble("commissionRate") ?: 0.0,
            o.flexInt("fixedCommission") ?: 0, o.flexInt("merchantCompletionBonus") ?: 0,
            o.flexInt("milestoneBonus") ?: 0, o.str("notes"), o.str("joiningDate"),
        )
    }
}

private data class HRAssignedAccount(
    val id: String, val accountTitle: String, val status: String?,
    val currentBalance: Int, val netRoi: Double, val merchantProgress: Double,
) {
    companion object {
        fun from(o: JSONObject) = HRAssignedAccount(
            o.str("id") ?: "", o.str("accountTitle") ?: "—", o.str("status"),
            o.flexInt("currentBalance") ?: 0, o.flexDouble("netRoi") ?: 0.0, o.flexDouble("merchantProgress") ?: 0.0,
        )
    }
}

private data class HRMetrics(
    val totalAccountsManaged: Int, val activeAccounts: Int, val totalTrades: Int,
    val totalProfitGenerated: Int, val totalLosses: Int, val netResult: Int,
    val merchantGrowthSuccess: Double, val activityConsistency: Double, val reportConsistency: Double,
    val inactiveDays: Int, val todayReportSubmitted: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = HRMetrics(
            o.flexInt("totalAccountsManaged") ?: 0, o.flexInt("activeAccounts") ?: 0, o.flexInt("totalTrades") ?: 0,
            o.flexInt("totalProfitGenerated") ?: 0, o.flexInt("totalLosses") ?: 0, o.flexInt("netResult") ?: 0,
            o.flexDouble("merchantGrowthSuccess") ?: 0.0, o.flexDouble("activityConsistency") ?: 0.0, o.flexDouble("reportConsistency") ?: 0.0,
            o.flexInt("inactiveDays") ?: 0, o.flexBool("todayReportSubmitted") ?: false,
        )
    }
}

private data class HRWallet(
    val totalCommissions: Int, val totalAdvances: Int, val totalWithdrawals: Int,
    val currentBalance: Int, val availableWithdrawable: Int,
) {
    companion object {
        fun from(o: JSONObject) = HRWallet(
            o.flexInt("totalCommissions") ?: 0, o.flexInt("totalAdvances") ?: 0, o.flexInt("totalWithdrawals") ?: 0,
            o.flexInt("currentBalance") ?: 0, o.flexInt("availableWithdrawable") ?: 0,
        )
    }
}

private data class HREmployeeItem(
    val user: HRUser, val profile: HRProfile?, val assignedAccounts: List<HRAssignedAccount>,
    val metrics: HRMetrics?, val wallet: HRWallet?,
) {
    val id: String get() = user.id
    companion object {
        fun from(o: JSONObject): HREmployeeItem? {
            val u = o.optJSONObject("user") ?: return null
            return HREmployeeItem(
                HRUser.from(u),
                o.optJSONObject("profile")?.let { HRProfile.from(it) },
                o.optJSONArray("assignedAccounts")?.mapObjects { HRAssignedAccount.from(it) } ?: emptyList(),
                o.optJSONObject("metrics")?.let { HRMetrics.from(it) },
                o.optJSONObject("wallet")?.let { HRWallet.from(it) },
            )
        }
    }
}

private data class HRAlert(val severity: String, val type: String, val userId: String, val title: String, val message: String) {
    companion object {
        fun from(o: JSONObject) = HRAlert(
            o.str("severity") ?: "NORMAL", o.str("type") ?: "", o.str("userId") ?: "",
            o.str("title") ?: "—", o.str("message") ?: "",
        )
    }
}

private data class HRKpis(
    val totalEmployees: Int, val activeEmployees: Int, val totalManagedAccounts: Int,
    val totalProfitGenerated: Int, val totalLosses: Int, val totalCommissions: Int,
    val totalWalletBalance: Int, val missingReports: Int,
) {
    companion object {
        fun from(o: JSONObject) = HRKpis(
            o.flexInt("totalEmployees") ?: 0, o.flexInt("activeEmployees") ?: 0, o.flexInt("totalManagedAccounts") ?: 0,
            o.flexInt("totalProfitGenerated") ?: 0, o.flexInt("totalLosses") ?: 0, o.flexInt("totalCommissions") ?: 0,
            o.flexInt("totalWalletBalance") ?: 0, o.flexInt("missingReports") ?: 0,
        )
    }
}

private data class HRRankings(
    val topTrader: List<HREmployeeItem>, val mostProfitable: List<HREmployeeItem>,
    val lowestLossRatio: List<HREmployeeItem>, val bestMerchantGrowth: List<HREmployeeItem>,
    val mostActive: List<HREmployeeItem>,
) {
    companion object {
        private fun list(o: JSONObject, key: String) = o.optJSONArray(key)?.mapObjects { HREmployeeItem.from(it) } ?: emptyList()
        fun from(o: JSONObject) = HRRankings(
            list(o, "topTrader"), list(o, "mostProfitable"), list(o, "lowestLossRatio"),
            list(o, "bestMerchantGrowth"), list(o, "mostActive"),
        )
    }
}

private data class HRStaffSummaryRow(
    val userId: String, val name: String, val assignedAccounts: Int, val activeAccounts: Int,
    val totalManagedCapital: Int, val commissionEarned: Int, val withdrawableBalance: Int, val monthlyNetResult: Int,
) {
    companion object {
        fun from(o: JSONObject) = HRStaffSummaryRow(
            o.str("userId") ?: "", o.str("name") ?: "—", o.flexInt("assignedAccounts") ?: 0, o.flexInt("activeAccounts") ?: 0,
            o.flexInt("totalManagedCapital") ?: 0, o.flexInt("commissionEarned") ?: 0,
            o.flexInt("withdrawableBalance") ?: 0, o.flexInt("monthlyNetResult") ?: 0,
        )
    }
}

private data class HRDailyReport(
    val id: String, val reportDate: String?, val accountIds: List<String>, val totalTrades: Int,
    val dailyProfitBdt: Int, val dailyLossBdt: Int, val issues: String?, val userName: String?,
) {
    companion object {
        fun from(o: JSONObject): HRDailyReport {
            val accArr = o.optJSONArray("accountIds") ?: JSONArray()
            val ids = (0 until accArr.length()).mapNotNull { accArr.optString(it).ifBlank { null } }
            return HRDailyReport(
                o.str("id") ?: (o.str("reportDate") ?: "") + "-" + (o.str("userId") ?: ""),
                o.str("reportDate"), ids, o.flexInt("totalTrades") ?: 0,
                o.flexInt("dailyProfitBdt") ?: 0, o.flexInt("dailyLossBdt") ?: 0,
                o.str("issues"), o.optJSONObject("user")?.str("name"),
            )
        }
    }
}

// ── State holder (iOS TradingHrVM twin) ─────────────────────────────────────────────

private class TradingHrState {
    var employees by mutableStateOf(listOf<HREmployeeItem>())
    var alerts by mutableStateOf(listOf<HRAlert>())
    var rankings by mutableStateOf<HRRankings?>(null)
    var kpis by mutableStateOf<HRKpis?>(null)
    var staffSummary by mutableStateOf(listOf<HRStaffSummaryRow>())
    var reports by mutableStateOf(listOf<HRDailyReport>())
    var loading by mutableStateOf(false)
    var loadedOnce by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            coroutineScope {
                // Summary + reports degrade to empty on their own failure; HR drives auth/error.
                val summaryTask = async { runCatching { AlmaApi.getObject("/api/trading/staff-summary") }.getOrNull() }
                val reportsTask = async { runCatching { AlmaApi.getObject("/api/trading/hr/reports", mapOf("limit" to "40")) }.getOrNull() }

                val hr = unwrap(AlmaApi.getObject("/api/trading/hr"))
                employees = hr.optJSONArray("employees")?.mapObjects { HREmployeeItem.from(it) } ?: emptyList()
                alerts = hr.optJSONArray("alerts")?.mapObjects { HRAlert.from(it) } ?: emptyList()
                rankings = hr.optJSONObject("rankings")?.let { HRRankings.from(it) }
                kpis = hr.optJSONObject("kpis")?.let { HRKpis.from(it) }
                authExpired = false

                staffSummary = summaryTask.await()?.let { unwrap(it).optJSONArray("staff")?.mapObjects { r -> HRStaffSummaryRow.from(r) } } ?: emptyList()
                reports = reportsTask.await()?.let { unwrap(it).optJSONArray("reports")?.mapObjects { r -> HRDailyReport.from(r) } } ?: emptyList()
            }
            loadedOnce = true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    suspend fun reports(userId: String): List<HRDailyReport> = try {
        unwrap(AlmaApi.getObject("/api/trading/hr/reports", mapOf("userId" to userId, "limit" to "40")))
            .optJSONArray("reports")?.mapObjects { HRDailyReport.from(it) } ?: emptyList()
    } catch (e: Exception) { emptyList() }

    // ── Native writes (HR/money SENSITIVE — web saveHrProfile / submitEmployeeReport) ──

    private suspend fun write(path: String, body: JSONObject, success: String): Boolean {
        return try {
            val resp = AlmaApi.send("POST", path, body)
            val err = resp.str("error")
            if (err != null) { toast = err; false } else { toast = success; load(); true }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true; false
        } catch (e: AlmaApiException.Http) {
            toast = e.message; false
        } catch (e: Exception) {
            toast = e.message ?: "নেটওয়ার্ক সমস্যা"; false
        }
    }

    suspend fun saveProfile(
        userId: String, employeeIdGas: String, roleTitle: String, shift: String, status: String,
        salary: Int, commissionType: String, commissionRate: Double, fixedCommission: Int,
        merchantCompletionBonus: Int, milestoneBonus: Int, joiningDate: String, notes: String,
    ): Boolean = write(
        "/api/trading/hr",
        JSONObject()
            .put("userId", userId).put("employeeIdGas", employeeIdGas).put("roleTitle", roleTitle)
            .put("shift", shift).put("status", status).put("salary", salary)
            .put("commissionType", commissionType).put("commissionRate", commissionRate)
            .put("fixedCommission", fixedCommission).put("merchantCompletionBonus", merchantCompletionBonus)
            .put("milestoneBonus", milestoneBonus).put("joiningDate", joiningDate).put("notes", notes),
        "Trading employee profile saved",
    )

    suspend fun submitReport(
        userId: String, reportDate: String, accountIds: List<String>, totalTrades: Int,
        dailyProfitBdt: Double, dailyLossBdt: Double, issues: String, operationalNotes: String,
    ): Boolean = write(
        "/api/trading/hr/reports",
        JSONObject()
            .put("userId", userId).put("reportDate", reportDate)
            .put("accountIds", JSONArray(accountIds)).put("totalTrades", totalTrades)
            .put("dailyProfitBdt", dailyProfitBdt).put("dailyLossBdt", dailyLossBdt)
            .put("issues", issues).put("screenshotProof", "").put("operationalNotes", operationalNotes),
        "Daily employee report submitted",
    )
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradingHrScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    // Role gating (defense-in-depth) — HR profile-edit + daily-report are admin-only writes
    // (web /trading/hr is an admin route). Read content stays; only the write buttons hide.
    RememberSession()
    val canManage = AlmaSession.isAdmin
    val vm = remember { TradingHrState() }
    val scope = rememberCoroutineScope()
    var selectedId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.toast) { if (vm.toast != null) { delay(2600); vm.toast = null } }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Spacer(Modifier.height(2.dp)) }
            item { HRKpiBoard(vm.kpis, vm.employees.size, dark) }

            if (vm.authExpired) item { HRAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            vm.error?.let { item { HRErrorCard(it, dark) } }

            if (vm.loading && !vm.loadedOnce) {
                items(5) { Box(Modifier.fillMaxWidth().height(72.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            }

            // Employee profiles.
            if (vm.employees.isNotEmpty()) {
                item { HRSectionHeader("Trading Employee Profiles", "Business scoped", dark) }
                items(vm.employees.size) { i ->
                    val em = vm.employees[i]
                    HREmployeeRow(em, dark) { selectedId = em.id }
                }
            } else if (!vm.loading && vm.error == null && !vm.authExpired) {
                item { HREmptyState("No trading employees yet", dark) }
            }

            // HR Alert Engine.
            if (vm.alerts.isNotEmpty()) {
                item { HRSectionHeader("HR Alert Engine", null, dark) }
                item { HRAlertsCard(vm.alerts, dark) }
            }

            // Rankings.
            vm.rankings?.let { r ->
                item { HRSectionHeader("Performance Rankings", null, dark) }
                item { HRRankingCard("Top Trader", r.topTrader, dark) { "${it.metrics?.totalTrades ?: 0} trades" } }
                item { HRRankingCard("Most Profitable", r.mostProfitable, dark) { HRFormat.taka(it.metrics?.netResult ?: 0) } }
                item { HRRankingCard("Lowest Loss Ratio", r.lowestLossRatio, dark) { "Loss ${AlmaTheme.taka(it.metrics?.totalLosses ?: 0)}" } }
                item { HRRankingCard("Merchant Growth", r.bestMerchantGrowth, dark) { "${(it.metrics?.merchantGrowthSuccess ?: 0.0).roundToInt()}%" } }
                item { HRRankingCard("Most Active", r.mostActive, dark) { "${(it.metrics?.activityConsistency ?: 0.0).roundToInt()}%" } }
            }

            // Staff performance summary.
            if (vm.staffSummary.isNotEmpty()) {
                item { HRSectionHeader("Staff Performance · This Month", null, dark) }
                item { HRStaffSummaryCard(vm.staffSummary, dark) }
            }

            // Recent daily reports feed.
            if (vm.reports.isNotEmpty()) {
                item { HRSectionHeader("Recent Daily Reports", null, dark) }
                item { HRReportsFeedCard(vm.reports, dark) }
            }

            item {
                Text(
                    "🌐 প্রোফাইল/রিপোর্ট এডিট — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().plainClick { ctx.openWebForced("/trading/hr", "Trading HR") }.padding(vertical = 4.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        vm.toast?.let { t ->
            Text(
                t, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp).almaGlass(dark, 22).padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    val selected = vm.employees.firstOrNull { it.id == selectedId }
    if (selected != null) {
        ModalBottomSheet(onDismissRequest = { selectedId = null }, containerColor = AlmaTheme.rootBg(dark)) {
            HRDetailSheet(selected, vm, scope, dark, canManage = canManage, onWeb = { ctx.openWebForced("/trading/hr", "Trading HR") })
        }
    }
}

// ── KPI board (web 8 KpiCards → bento hero + 4 accent tiles) ────────────────────────

@Composable
private fun HRKpiBoard(k: HRKpis?, employeeCount: Int, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HRBentoHero(
            profit = k?.totalProfitGenerated ?: 0,
            employees = k?.totalEmployees ?: employeeCount,
            active = k?.activeEmployees ?: 0,
            accounts = k?.totalManagedAccounts ?: 0,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HRBentoTile("Losses", AlmaTheme.takaShort((k?.totalLosses ?: 0).toLong()), "মোট লস", HRPalette.red400, HRPalette.red500, dark, Modifier.weight(1f))
            HRBentoTile("Commissions", AlmaTheme.takaShort((k?.totalCommissions ?: 0).toLong()), "স্টাফ কমিশন", HRPalette.accentText(dark), HRPalette.coral, dark, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HRBentoTile("Wallet balance", AlmaTheme.takaShort((k?.totalWalletBalance ?: 0).toLong()), "স্টাফ ওয়ালেট", HRPalette.blue500, HRPalette.blue500, dark, Modifier.weight(1f))
            HRBentoTile("Missing reports", "${k?.missingReports ?: 0}", "আজকের বাকি রিপোর্ট", HRPalette.amber(dark), HRPalette.amber500, dark, Modifier.weight(1f))
        }
    }
}

@Composable
private fun HRBentoHero(profit: Int, employees: Int, active: Int, accounts: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(Color(0xFF181528))
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(
                Brush.linearGradient(
                    0f to Color.Transparent, 0.55f to Color.Transparent, 1f to AlmaTheme.sage.copy(alpha = 0.30f),
                ),
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text("প্রফিট জেনারেটেড · TRADING HR", color = HRPalette.sage, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
        Spacer(Modifier.height(8.dp))
        Text(AlmaTheme.takaShort(profit.toLong()), color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text("সব স্টাফের মোট জেনারেট করা প্রফিট", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp, modifier = Modifier.padding(top = 5.dp))
        Row(Modifier.padding(top = 14.dp)) {
            HRHeroStat("Employees", "$employees", Color.White, "মোট স্টাফ")
            HRHeroDivider()
            HRHeroStat("Active", "$active", HRPalette.sage, "সক্রিয়")
            HRHeroDivider()
            HRHeroStat("Accounts", "$accounts", HRPalette.goldLt, "ম্যানেজড")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun HRHeroDivider() {
    Box(Modifier.padding(horizontal = 12.dp, vertical = 2.dp).width(1.dp).height(40.dp).background(Color.White.copy(alpha = 0.14f)))
}

@Composable
private fun HRHeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label.uppercase(), color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun HRBentoTile(label: String, value: String, sub: String, tint: Color, accent: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD)
            .background(Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun HRSectionHeader(title: String, trailing: String?, dark: Boolean) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        trailing?.let { Text(it.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp) }
    }
}

@Composable
private fun HRAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text("লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(AlmaTheme.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp))
    }
}

@Composable
private fun HRErrorCard(message: String, dark: Boolean) {
    Text("⚠ $message", color = HRPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp))
}

@Composable
private fun HREmptyState(title: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("👥", fontSize = 30.sp)
        Text(title, color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
    }
}

// ── Employee row (web table row → avatar · role/link · P/L + wallet) ────────────────

@Composable
private fun HRAvatar(name: String, size: Int) {
    Box(
        Modifier.size(size.dp).clip(CircleShape).background(HRPalette.sage.copy(alpha = 0.14f)).border(1.dp, HRPalette.sage.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) { Text(HRFormat.initials(name), color = HRPalette.sage, fontSize = (size / 3).sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun HREmployeeRow(em: HREmployeeItem, dark: Boolean, onTap: () -> Unit) {
    val role = em.profile?.roleTitle?.takeIf { it.isNotEmpty() } ?: (em.user.role ?: "STAFF")
    val link = em.user.employeeIdGas?.takeIf { it.isNotEmpty() } ?: "No employee link"
    val shift = em.profile?.shift ?: "DAY"
    val night = shift == "NIGHT"
    val net = em.metrics?.netResult ?: 0
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onTap).padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HRAvatar(em.user.name, 38)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(em.user.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$role · $link", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(shift, color = if (night) AlmaTheme.violet else HRPalette.amber(dark), fontSize = 8.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(CircleShape).background((if (night) AlmaTheme.violet else HRPalette.amber500).copy(alpha = 0.12f)).padding(horizontal = 5.dp, vertical = 1.5.dp))
                Text("${em.metrics?.totalAccountsManaged ?: 0} acct · ${em.metrics?.totalTrades ?: 0} trades", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(HRFormat.taka(net), color = HRPalette.signed(net, dark), fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            Text("ওয়ালেট ${AlmaTheme.taka(em.wallet?.currentBalance ?: 0)}", color = HRPalette.blue500, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
            Text("consistency ${(em.metrics?.activityConsistency ?: 0.0).roundToInt()}%", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        }
        Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = AlmaTheme.inkTertiary(dark), modifier = Modifier.size(16.dp))
    }
}

// ── HR Alert Engine ─────────────────────────────────────────────────────────────────

@Composable
private fun HRAlertsCard(alerts: List<HRAlert>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 4.dp)) {
        alerts.take(10).forEachIndexed { idx, alert ->
            if (idx > 0) HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.06f))
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(alert.title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Text(alert.message, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
                val tint = HRPalette.severity(alert.severity, dark)
                Text(alert.severity, color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(CircleShape).background(tint.copy(alpha = 0.12f)).border(0.8.dp, tint.copy(alpha = 0.35f), CircleShape).padding(horizontal = 7.dp, vertical = 3.dp))
            }
        }
    }
}

// ── Ranking card ────────────────────────────────────────────────────────────────────

@Composable
private fun HRRankingCard(title: String, rows: List<HREmployeeItem>, dark: Boolean, metric: (HREmployeeItem) -> String) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        if (rows.isEmpty()) {
            Text("No data yet", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        } else {
            rows.take(5).forEachIndexed { idx, row ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${idx + 1}. ${row.user.name}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(metric(row), color = HRPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                }
            }
        }
    }
}

// ── Staff performance summary ───────────────────────────────────────────────────────

@Composable
private fun HRStaffSummaryCard(rows: List<HRStaffSummaryRow>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 4.dp)) {
        rows.forEachIndexed { idx, row ->
            if (idx > 0) HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.06f))
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(row.name, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                    Text("${row.assignedAccounts} accounts · ${row.activeAccounts} active · capital ${AlmaTheme.takaShort(row.totalManagedCapital.toLong())}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(HRFormat.taka(row.monthlyNetResult), color = HRPalette.signed(row.monthlyNetResult, dark), fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text("কমিশন ${AlmaTheme.taka(row.commissionEarned)} · তোলা যাবে ${AlmaTheme.taka(row.withdrawableBalance)}", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
                }
            }
        }
    }
}

// ── Recent daily reports feed ───────────────────────────────────────────────────────

@Composable
private fun HRReportsFeedCard(reports: List<HRDailyReport>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 4.dp)) {
        reports.take(15).forEachIndexed { idx, report ->
            if (idx > 0) HorizontalDivider(color = AlmaTheme.ink(dark).copy(alpha = 0.06f))
            HRReportRow(report, showName = true, dark = dark)
        }
    }
}

@Composable
private fun HRReportRow(report: HRDailyReport, showName: Boolean, dark: Boolean) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(HRFormat.day(report.reportDate), color = HRPalette.sage, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
                if (showName && !report.userName.isNullOrEmpty()) {
                    Text(report.userName, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
            Text("${report.totalTrades} trades · ${report.accountIds.size} accounts", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            report.issues?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = HRPalette.amber(dark), fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("+${AlmaTheme.taka(report.dailyProfitBdt)}", color = HRPalette.green(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            if (report.dailyLossBdt != 0) {
                Text("-${AlmaTheme.taka(report.dailyLossBdt)}", color = HRPalette.red400, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

// ── Detail sheet (HR profile + metrics + wallet + accounts + that staffer's reports) ─

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HRDetailSheet(em: HREmployeeItem, vm: TradingHrState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean, canManage: Boolean, onWeb: () -> Unit) {
    var reports by remember { mutableStateOf<List<HRDailyReport>?>(null) }
    var editingProfile by remember { mutableStateOf(false) }
    var addingReport by remember { mutableStateOf(false) }
    LaunchedEffect(em.id) { reports = vm.reports(em.user.id) }

    Column(
        Modifier.fillMaxWidth().heightIn(max = 640.dp).verticalScroll(rememberScrollState()).padding(18.dp).padding(bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header.
        val status = em.profile?.status ?: "ACTIVE"
        val statusTint = when (status) {
            "ACTIVE" -> HRPalette.green(dark)
            "INACTIVE" -> HRPalette.red500
            else -> HRPalette.amber(dark)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            HRAvatar(em.user.name, 44)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(em.user.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                val role = em.profile?.roleTitle?.takeIf { it.isNotEmpty() } ?: (em.user.role ?: "STAFF")
                Text("$role · ${em.user.employeeIdGas ?: "No employee link"}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(status, color = statusTint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.clip(CircleShape).background(statusTint.copy(alpha = 0.12f)).border(0.8.dp, statusTint.copy(alpha = 0.35f), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp))
        }

        // Native write buttons — admin-only (profile-edit + daily-report). Read content below
        // stays visible for everyone; only these writes are hidden from non-admins.
        if (canManage) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HROutlineButton("Profile সম্পাদনা", HRPalette.sage, dark, Modifier.weight(1f)) { editingProfile = true }
                HROutlineButton("Daily report", HRPalette.blue500, dark, Modifier.weight(1f)) { addingReport = true }
            }
        }

        // HR profile.
        HRDetailCard("HR PROFILE", dark) {
            HRStatRow("Salary", AlmaTheme.taka(em.profile?.salary ?: 0), HRPalette.accentText(dark), dark)
            HRStatRow("Shift", em.profile?.shift ?: "DAY", AlmaTheme.ink(dark), dark)
            HRStatRow("Commission", hrCommissionLine(em.profile), AlmaTheme.ink(dark), dark)
            if ((em.profile?.merchantCompletionBonus ?: 0) > 0) HRStatRow("Completion bonus", AlmaTheme.taka(em.profile!!.merchantCompletionBonus), AlmaTheme.ink(dark), dark)
            if ((em.profile?.milestoneBonus ?: 0) > 0) HRStatRow("Milestone bonus", AlmaTheme.taka(em.profile!!.milestoneBonus), AlmaTheme.ink(dark), dark)
            em.user.joiningDate?.takeIf { it.isNotEmpty() }?.let { HRStatRow("Joining date", HRFormat.day(it), AlmaTheme.ink(dark), dark) }
            em.user.phone?.takeIf { it.isNotEmpty() }?.let { HRStatRow("Phone", it, AlmaTheme.ink(dark), dark) }
            em.profile?.notes?.takeIf { it.isNotEmpty() }?.let { HRStatRow("Notes", it, HRPalette.amber(dark), dark) }
        }

        // Performance metrics.
        val m = em.metrics
        HRDetailCard("PERFORMANCE", dark) {
            HRStatRow("Accounts", "${m?.totalAccountsManaged ?: 0} total · ${m?.activeAccounts ?: 0} active", AlmaTheme.ink(dark), dark)
            HRStatRow("Trades", "${m?.totalTrades ?: 0}", HRPalette.accentText(dark), dark)
            HRStatRow("Profit generated", HRFormat.taka(m?.totalProfitGenerated ?: 0), HRPalette.green(dark), dark)
            HRStatRow("Losses", HRFormat.taka(m?.totalLosses ?: 0), HRPalette.red400, dark)
            HRStatRow("Net P/L", HRFormat.taka(m?.netResult ?: 0), HRPalette.signed(m?.netResult ?: 0, dark), dark)
            HRStatRow("Merchant growth", "${(m?.merchantGrowthSuccess ?: 0.0).roundToInt()}%", AlmaTheme.ink(dark), dark)
            HRStatRow("Activity consistency", "${(m?.activityConsistency ?: 0.0).roundToInt()}%", AlmaTheme.ink(dark), dark)
            HRStatRow("Report consistency", "${(m?.reportConsistency ?: 0.0).roundToInt()}%", AlmaTheme.ink(dark), dark)
            HRStatRow("Today's report", if (m?.todayReportSubmitted == true) "Submitted" else "Missing", if (m?.todayReportSubmitted == true) HRPalette.green(dark) else HRPalette.amber(dark), dark)
        }

        // Wallet.
        em.wallet?.let { w ->
            HRDetailCard("WALLET", dark) {
                HRStatRow("Current balance", AlmaTheme.taka(w.currentBalance), HRPalette.blue500, dark)
                HRStatRow("Withdrawable", AlmaTheme.taka(w.availableWithdrawable), HRPalette.green(dark), dark)
                HRStatRow("Commissions", AlmaTheme.taka(w.totalCommissions), AlmaTheme.ink(dark), dark)
                HRStatRow("Advances", AlmaTheme.taka(w.totalAdvances), AlmaTheme.ink(dark), dark)
                HRStatRow("Withdrawals", AlmaTheme.taka(w.totalWithdrawals), AlmaTheme.ink(dark), dark)
            }
        }

        // Assigned accounts.
        if (em.assignedAccounts.isNotEmpty()) {
            HRDetailCard("ASSIGNED ACCOUNTS", dark) {
                em.assignedAccounts.forEach { a ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(if (a.status == "ACTIVE") HRPalette.green(dark) else HRPalette.slate400))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(a.accountTitle, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text("ROI ${a.netRoi}% · merchant ${a.merchantProgress.roundToInt()}%", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                        }
                        Text(AlmaTheme.taka(a.currentBalance), color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }

        // That staffer's recent reports.
        HRDetailCard("RECENT REPORTS", dark) {
            when {
                reports == null -> Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                reports!!.isEmpty() -> Text("কোনো রিপোর্ট পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                else -> reports!!.take(10).forEach { HRReportRow(it, showName = false, dark = dark) }
            }
        }

        Text(
            "🌐 প্রোফাইল/রিপোর্ট এডিট — ওয়েবে খুলুন", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick(onWeb).padding(vertical = 4.dp),
        )
    }

    if (editingProfile) {
        ModalBottomSheet(onDismissRequest = { editingProfile = false }, containerColor = AlmaTheme.rootBg(dark)) {
            HRProfileSheet(em, vm, scope, dark) { editingProfile = false }
        }
    }
    if (addingReport) {
        ModalBottomSheet(onDismissRequest = { addingReport = false }, containerColor = AlmaTheme.rootBg(dark)) {
            HRReportSheet(em, vm, scope, dark, onDone = { scope.launch { reports = vm.reports(em.user.id) } }) { addingReport = false }
        }
    }
}

private fun hrCommissionLine(p: HRProfile?): String = when (p?.commissionType) {
    "PERCENTAGE" -> "Profit ${p.commissionRate}%"
    "FIXED" -> "Fixed ${AlmaTheme.taka(p.fixedCommission)}"
    else -> "None"
}

@Composable
private fun HRDetailCard(title: String, dark: Boolean, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
        content()
    }
}

@Composable
private fun HRStatRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.weight(1f))
        Text(value, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
    }
}

@Composable
private fun HROutlineButton(label: String, tint: Color, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Text(
        label, color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = modifier.background(tint.copy(alpha = 0.10f), shape).border(1.dp, tint.copy(alpha = 0.30f), shape).plainClick(onClick).padding(vertical = 9.dp),
    )
}

// ── Shared sheet inputs ─────────────────────────────────────────────────────────────

@Composable
private fun HRSheetField(placeholder: String, value: String, dark: Boolean, keyboardType: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    BasicTextField(
        value = value, onValueChange = onChange, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(HRPalette.sage),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).padding(horizontal = 12.dp, vertical = 11.dp)) {
                if (value.isEmpty()) Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                inner()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun HRSeg(options: List<Pair<String, String>>, selected: String, dark: Boolean, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            val active = value == selected
            Text(
                label, color = if (active) HRPalette.sage else AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
                    .background(if (active) HRPalette.sage.copy(alpha = if (dark) 0.28f else 0.14f) else AlmaTheme.ink(dark).copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, if (active) HRPalette.sage.copy(alpha = 0.55f) else Color.Transparent, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { onSelect(value) }.padding(vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun HRSheetHeader(title: String, desc: String, dark: Boolean, onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(top = 4.dp, bottom = 12.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        Text("Close", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.plainClick(onClose).padding(4.dp))
    }
}

@Composable
private fun HRSubmitBar(label: String, submitting: Boolean, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp)
            .background(if (!submitting) tint else tint.copy(alpha = 0.4f), RoundedCornerShape(14.dp))
            .plainClick { if (!submitting) onClick() }.padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        if (submitting) { CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
        Text(label, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Profile edit sheet (web HR profile form, POST /api/trading/hr) ──────────────────

@Composable
private fun HRProfileSheet(em: HREmployeeItem, vm: TradingHrState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean, onClose: () -> Unit) {
    val p = em.profile
    var employeeIdGas by remember { mutableStateOf(p?.employeeIdGas ?: em.user.employeeIdGas ?: "") }
    var roleTitle by remember { mutableStateOf(p?.roleTitle ?: "") }
    var shift by remember { mutableStateOf(p?.shift ?: "DAY") }
    var status by remember { mutableStateOf(p?.status ?: "ACTIVE") }
    var salary by remember { mutableStateOf(p?.let { "${it.salary}" } ?: "") }
    var commissionType by remember { mutableStateOf(p?.commissionType ?: "NONE") }
    var commissionRate by remember { mutableStateOf(p?.let { "${it.commissionRate}" } ?: "") }
    var fixedCommission by remember { mutableStateOf(p?.let { "${it.fixedCommission}" } ?: "") }
    var completionBonus by remember { mutableStateOf(p?.let { "${it.merchantCompletionBonus}" } ?: "") }
    var milestoneBonus by remember { mutableStateOf(p?.let { "${it.milestoneBonus}" } ?: "") }
    var joiningDate by remember { mutableStateOf((p?.joiningDate ?: em.user.joiningDate ?: "").take(10)) }
    var notes by remember { mutableStateOf(p?.notes ?: "") }
    var typeOpen by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        HRSheetHeader("HR profile — ${em.user.name}", "Salary পরিবর্তন wallet accrual-এ প্রভাব ফেলে।", dark, onClose)
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
        Column(
            Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState()).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            HRSheetField("Employee ID (GAS)", employeeIdGas, dark) { employeeIdGas = it }
            HRSheetField("Role title", roleTitle, dark) { roleTitle = it }
            HRSeg(listOf("DAY" to "Day", "NIGHT" to "Night", "ROTATING" to "Rotating"), shift, dark) { shift = it }
            HRSeg(listOf("ACTIVE" to "Active", "INACTIVE" to "Inactive", "ON_LEAVE" to "On leave"), status, dark) { status = it }
            HRSheetField("Salary (BDT)", salary, dark, KeyboardType.Number) { salary = it }
            Box(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).plainClick { typeOpen = true }.padding(horizontal = 12.dp, vertical = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        when (commissionType) { "PERCENTAGE" -> "Percentage of profit"; "FIXED" -> "Fixed per profitable sell"; else -> "No commission" },
                        color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
                    )
                    Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
                DropdownMenu(expanded = typeOpen, onDismissRequest = { typeOpen = false }) {
                    listOf("NONE" to "No commission", "PERCENTAGE" to "Percentage of profit", "FIXED" to "Fixed per profitable sell").forEach { (v, l) ->
                        DropdownMenuItem(text = { Text((if (v == commissionType) "✓ " else "") + l) }, onClick = { commissionType = v; typeOpen = false })
                    }
                }
            }
            HRSheetField("Commission % of profit", commissionRate, dark, KeyboardType.Decimal) { commissionRate = it }
            HRSheetField("Fixed commission BDT", fixedCommission, dark, KeyboardType.Number) { fixedCommission = it }
            HRSheetField("Merchant completion bonus BDT", completionBonus, dark, KeyboardType.Number) { completionBonus = it }
            HRSheetField("Milestone bonus BDT", milestoneBonus, dark, KeyboardType.Number) { milestoneBonus = it }
            HRSheetField("Joining date (YYYY-MM-DD)", joiningDate, dark) { joiningDate = it }
            HRSheetField("Notes", notes, dark) { notes = it }
        }
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
        HRSubmitBar(if (submitting) "Saving…" else "Save profile", submitting, AlmaTheme.coral) { confirming = true }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("${em.user.name}-এর HR profile সেভ করবেন? Salary ${AlmaTheme.taka(HRFormat.num(salary).roundToInt())}") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false; submitting = true
                    scope.launch {
                        val ok = vm.saveProfile(
                            em.user.id, employeeIdGas, roleTitle, shift, status, HRFormat.num(salary).roundToInt(),
                            commissionType, HRFormat.num(commissionRate), HRFormat.num(fixedCommission).roundToInt(),
                            HRFormat.num(completionBonus).roundToInt(), HRFormat.num(milestoneBonus).roundToInt(), joiningDate, notes,
                        )
                        submitting = false
                        if (ok) onClose()
                    }
                }) { Text("হ্যাঁ, সেভ করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

// ── Daily report sheet (web report form, POST /api/trading/hr/reports) ──────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HRReportSheet(em: HREmployeeItem, vm: TradingHrState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean, onDone: () -> Unit, onClose: () -> Unit) {
    var reportDate by remember { mutableStateOf(HRFormat.today()) }
    val selectedAccounts = remember { mutableStateOf(setOf<String>()) }
    var totalTrades by remember { mutableStateOf("") }
    var profit by remember { mutableStateOf("") }
    var loss by remember { mutableStateOf("") }
    var issues by remember { mutableStateOf("") }
    var opNotes by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var showPicker by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        HRSheetHeader("Daily report — ${em.user.name}", "দিনের ট্রেড সংখ্যা ও P/L।", dark, onClose)
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
        Column(
            Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState()).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Report date", color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                Text("$reportDate ▾", color = HRPalette.sage, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.plainClick { showPicker = true }.padding(4.dp))
            }
            if (em.assignedAccounts.isNotEmpty()) {
                Text("ACCOUNTS", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                em.assignedAccounts.forEach { a ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(a.accountTitle, color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Switch(
                            checked = selectedAccounts.value.contains(a.id),
                            onCheckedChange = { on -> selectedAccounts.value = if (on) selectedAccounts.value + a.id else selectedAccounts.value - a.id },
                            colors = SwitchDefaults.colors(checkedTrackColor = HRPalette.sage),
                        )
                    }
                }
            }
            HRSheetField("Total trades", totalTrades, dark, KeyboardType.Number) { totalTrades = it }
            HRSheetField("Daily profit (BDT)", profit, dark, KeyboardType.Decimal) { profit = it }
            HRSheetField("Daily loss (BDT)", loss, dark, KeyboardType.Decimal) { loss = it }
            HRSheetField("Issues", issues, dark) { issues = it }
            HRSheetField("Operational notes", opNotes, dark) { opNotes = it }
        }
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
        HRSubmitBar(if (submitting) "Submitting…" else "Submit report", submitting, HRPalette.sage) { confirming = true }
    }
    if (showPicker) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = { TextButton(onClick = { state.selectedDateMillis?.let { reportDate = HRFormat.fromPickerMillis(it) }; showPicker = false }) { Text("ঠিক আছে") } },
            dismissButton = { TextButton(onClick = { showPicker = false }) { Text("বাতিল") } },
        ) { DatePicker(state = state) }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Report সাবমিট করবেন? Net ${AlmaTheme.taka((HRFormat.num(profit) - HRFormat.num(loss)).roundToInt())}") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false; submitting = true
                    scope.launch {
                        val ok = vm.submitReport(
                            em.user.id, reportDate, selectedAccounts.value.toList(), HRFormat.num(totalTrades).roundToInt(),
                            HRFormat.num(profit), HRFormat.num(loss), issues, opNotes,
                        )
                        submitting = false
                        if (ok) { onDone(); onClose() }
                    }
                }) { Text("হ্যাঁ, সাবমিট করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}
