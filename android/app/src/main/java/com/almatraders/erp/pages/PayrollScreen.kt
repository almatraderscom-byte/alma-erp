//
//  PayrollScreen.kt
//  ALMA ERP — the Payroll page, ported 1:1 from PayrollSwiftUI.swift (FULL ACTION PARITY).
//
//  Payroll is financially sensitive (recently-fixed wallet/salary ledger logic), so
//  every mutating call below copies the web page's endpoint + JSON body VERBATIM
//  (field names checked against the route handlers on iOS). Money-moving actions get
//  a native Bangla confirmation (amount + employee name) and a per-row spinner.
//
//  GET endpoints (same ones the web page reads):
//    /api/payroll/wallet/summary?business_id=…             → wallets + totals + pending requests
//    /api/payroll/wallet/summary?…&roster_only=true        → roster for the compensation picker
//    /api/hr/dashboard?business_id=…                       → KPIs + legacy GAS roll + timeline
//    /api/payroll/wallet/accruals/preview?business_id=…    → monthly accrual preview
//    /api/payroll/wallet/accruals/history?business_id=…    → accrual run history
//    /api/payroll/wallet/automation                        → automation setting
//    /api/payroll/meal-allowance/profiles?business_id=…    → meal allowance rows
//    /api/payroll/driving-mode/profiles?business_id=…      → driving mode rows
//
//  Mutations (exact web bodies — src/app/payroll/page.tsx):
//    PATCH /api/payroll/wallet/requests/{id}   {action, approvedAmount?, note:'', transactionId, paid_via?}
//    POST  /api/payroll/wallet/entries         {business_id, employee_id, type, amount, note, date}
//    POST  /api/payroll/wallet/accruals/run    {business_id}
//    PATCH /api/payroll/wallet/automation      {enabled}
//    PATCH /api/payroll/meal-allowance/profiles {business_id, userId, employeeId, enabled, amountBdt}
//    PATCH /api/payroll/driving-mode/profiles  {business_id, userId, employeeId, enabled}
//    POST  /api/payroll/driving-mode/start|end {business_id, userId}
//
//  Web-only remainder: PDF/CSV/Excel exports — the iOS build makes PDF/CSV on-device;
//  Android defers those to the web link (needs FileProvider/share plumbing later).
//

package com.almatraders.erp.pages

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object PayPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val heroBase = Color(0xFF181528)        // dark bento anchor base

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    fun pos(dark: Boolean): Color = if (dark) green400 else emerald600

    /** Accrual run status — web: SUCCESS txt-pos · RUNNING amber-500 · else txt-neg. */
    fun runStatus(s: String, dark: Boolean): Color = when (s) {
        "SUCCESS" -> pos(dark)
        "RUNNING" -> amber500
        else -> red500
    }
}

// ── Formatting helpers (web util parity) ────────────────────────────────────────────

private val PAY_BN_DIGITS = mapOf(
    '0' to '০', '1' to '১', '2' to '২', '3' to '৩', '4' to '৪',
    '5' to '৫', '6' to '৬', '7' to '৭', '8' to '৮', '9' to '৯',
)

private val PAY_BN_MONTHS = listOf(
    "জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
    "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর",
)

private object PayFormat {
    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** "৳ 12,345" (the iOS "৳ \(x.formatted())" strings). */
    fun taka(amount: Int): String = "৳ " + String.format("%,d", amount)

    /** "2026-06" → "জুন ২০২৬" */
    fun periodBn(ym: String): String {
        val parts = ym.split("-").mapNotNull { it.toIntOrNull() }
        if (parts.size != 2 || parts[1] !in 1..12) return ym
        val year = parts[0].toString().map { PAY_BN_DIGITS[it] ?: it }.joinToString("")
        return "${PAY_BN_MONTHS[parts[1] - 1]} $year"
    }

    /** The web's <input type=date> value — local calendar day, Asia/Dhaka. */
    fun dayString(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date(ms))
    }
}

// ── Constants (top-level vals — never companion stored lists) ───────────────────────

/** The web's PAYROLL_COMPENSATION_TYPES — value + label + credit/debit kind. */
private data class PayCompType(val value: String, val label: String, val kind: String)

private val PAY_COMP_TYPES = listOf(
    PayCompType("SALARY_ACCRUAL", "💰 Salary credit (manual)", "credit"),
    PayCompType("COMMISSION", "Commission earned", "credit"),
    PayCompType("EID_BONUS", "Eid bonus", "credit"),
    PayCompType("PERFORMANCE_BONUS", "Performance bonus", "credit"),
    PayCompType("OVERTIME", "Overtime payment", "credit"),
    PayCompType("REIMBURSEMENT", "Reimbursement", "credit"),
    PayCompType("MEAL_DEDUCTION", "Meal deduction (debit)", "debit"),
    PayCompType("PENALTY", "Penalty (debit)", "debit"),
    PayCompType("ADJUSTMENT", "Manual adjustment", "adjust"),
)

/** Payroll is business-scoped — src/lib/businesses.ts. */
private val PAY_BUSINESSES = listOf(
    "ALMA_LIFESTYLE" to "Alma",
    "CREATIVE_DIGITAL_IT" to "CDIT",
    "ALMA_TRADING" to "Trading",
)

/** Review sheet payment channels (web parity, Bangla labels). */
private val PAY_PAID_VIA = listOf(
    "CASH" to "ক্যাশ", "BKASH" to "বিকাশ", "NAGAD" to "নগদ", "BANK" to "ব্যাংক",
)

private val PAY_TYPE_FILTERS = listOf(
    "ALL", "SALARY_ACCRUAL", "COMMISSION", "PENALTY", "ADVANCE", "WITHDRAWAL",
)

// ── Models (same field names the web types declare — src/types/payroll-wallet.ts) ────

/** One employee's lifetime wallet summary (whole-taka BDT). */
private data class PayWalletTotals(
    val lifetimeEarned: Int,
    val lifetimeWithdrawn: Int,
    val totalAccrued: Int,
    val totalBonuses: Int,
    val totalCommissions: Int,
    val totalOvertime: Int,
    val totalReimbursements: Int,
    val totalMealDeductions: Int,
    val totalPenalties: Int,
    val outstandingAdvance: Int,
    val currentBalance: Int,
    val companyLiability: Int,
    val availableWithdrawable: Int,
    val entryCount: Int,
    /** Salary credited for the current cycle (prior calendar month's periodYm). */
    val currentCycleSalaryAdded: Int,
    val cyclePeriodYm: String?,
    /** periodYms with no salary accrual (owner rule: show WHO is due, WHICH month). */
    val salaryDueMonths: List<String>,
) {
    companion object {
        fun from(o: JSONObject?): PayWalletTotals? {
            if (o == null) return null
            val due = o.optJSONArray("salaryDueMonths")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.opt(it) as? String }
            } ?: emptyList()
            return PayWalletTotals(
                lifetimeEarned = o.flexInt("lifetimeEarned") ?: 0,
                lifetimeWithdrawn = o.flexInt("lifetimeWithdrawn") ?: 0,
                totalAccrued = o.flexInt("totalAccrued") ?: 0,
                totalBonuses = o.flexInt("totalBonuses") ?: 0,
                totalCommissions = o.flexInt("totalCommissions") ?: 0,
                totalOvertime = o.flexInt("totalOvertime") ?: 0,
                totalReimbursements = o.flexInt("totalReimbursements") ?: 0,
                totalMealDeductions = o.flexInt("totalMealDeductions") ?: 0,
                totalPenalties = o.flexInt("totalPenalties") ?: 0,
                outstandingAdvance = o.flexInt("outstandingAdvance") ?: 0,
                currentBalance = o.flexInt("currentBalance") ?: 0,
                companyLiability = o.flexInt("companyLiability") ?: 0,
                availableWithdrawable = o.flexInt("availableWithdrawable") ?: 0,
                entryCount = o.flexInt("entryCount") ?: 0,
                currentCycleSalaryAdded = o.flexInt("currentCycleSalaryAdded") ?: 0,
                cyclePeriodYm = o.str("cyclePeriodYm"),
                salaryDueMonths = due,
            )
        }
    }
}

/** One wallet ledger entry (the web's latestEntries slice — display only). */
private data class PayLedgerEntry(
    val id: String,
    val date: String?,
    val periodYm: String?,
    val type: String?,
    val note: String?,
    val signedAmount: Int,
    val runningBalance: Int,
) {
    companion object {
        fun from(o: JSONObject): PayLedgerEntry = PayLedgerEntry(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            date = o.str("date"),
            periodYm = o.str("periodYm"),
            type = o.str("type"),
            note = o.str("note"),
            signedAmount = o.flexInt("signedAmount") ?: 0,
            runningBalance = o.flexInt("runningBalance") ?: 0,
        )
    }
}

/** One employee wallet row (web "Employee profitability and liabilities" table). */
private data class PayEmployeeWallet(
    val employeeId: String,
    val businessId: String,
    val name: String,
    val monthlySalary: Int?,
    val summary: PayWalletTotals?,
    val latestEntries: List<PayLedgerEntry>,
) {
    val id: String get() = "$businessId:$employeeId"

    companion object {
        fun from(o: JSONObject): PayEmployeeWallet = PayEmployeeWallet(
            employeeId = o.str("employeeId") ?: "—",
            businessId = o.str("businessId") ?: "",
            name = o.str("name") ?: "—",
            monthlySalary = o.flexInt("monthlySalary"),
            summary = PayWalletTotals.from(o.optJSONObject("summary")),
            latestEntries = o.optJSONArray("latestEntries")?.mapObjects { PayLedgerEntry.from(it) } ?: emptyList(),
        )
    }
}

/** One pending ADVANCE / WITHDRAWAL request — decided natively (web submitReview parity). */
private data class PayPendingRequest(
    val id: String,
    val employeeId: String,
    val businessId: String?,
    val type: String,
    val requestedAmount: Int,
    val reason: String?,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject): PayPendingRequest? {
            val id = o.str("id") ?: return null
            return PayPendingRequest(
                id = id,
                employeeId = o.str("employeeId") ?: "—",
                businessId = o.str("businessId"),
                type = o.str("type") ?: "—",
                requestedAmount = o.flexInt("requestedAmount") ?: 0,
                reason = o.str("reason"),
                createdAt = o.str("createdAt"),
            )
        }
    }
}

/** Business-level totals for the KPI strip. */
private data class PayBusinessTotals(
    val companyLiability: Int,
    val totalCommissions: Int,
    val totalBonuses: Int,
    val totalMealDeductions: Int,
    val totalPenalties: Int,
    val currentBalance: Int,
) {
    companion object {
        fun from(o: JSONObject?): PayBusinessTotals? {
            if (o == null) return null
            return PayBusinessTotals(
                companyLiability = o.flexInt("companyLiability") ?: 0,
                totalCommissions = o.flexInt("totalCommissions") ?: 0,
                totalBonuses = o.flexInt("totalBonuses") ?: 0,
                totalMealDeductions = o.flexInt("totalMealDeductions") ?: 0,
                totalPenalties = o.flexInt("totalPenalties") ?: 0,
                currentBalance = o.flexInt("currentBalance") ?: 0,
            )
        }
    }
}

/** Legacy GAS roll row (/api/hr/dashboard employees_roll — snake_case keys). */
private data class PayRollRow(
    val empId: String,
    val name: String,
    val monthlySalary: Int,
    val salaryPaid: Int,
    val advanceBalance: Int,
    val currentDue: Int,
) {
    companion object {
        fun from(o: JSONObject): PayRollRow = PayRollRow(
            empId = o.str("emp_id") ?: UUID.randomUUID().toString(),
            name = o.str("name") ?: "—",
            monthlySalary = o.flexInt("monthly_salary") ?: 0,
            salaryPaid = o.flexInt("salary_paid") ?: 0,
            advanceBalance = o.flexInt("advance_balance") ?: 0,
            currentDue = o.flexInt("current_due") ?: 0,
        )
    }
}

/** Timeline transaction (/api/hr/dashboard payroll_timeline — snake_case keys). */
private data class PayTimelineTx(
    val txId: String,
    val date: String,
    val empName: String,
    val txType: String,
    val amount: Int,
) {
    companion object {
        fun from(o: JSONObject): PayTimelineTx = PayTimelineTx(
            txId = o.str("tx_id") ?: UUID.randomUUID().toString(),
            date = o.str("date") ?: "",
            empName = o.str("emp_name") ?: "—",
            txType = o.str("tx_type") ?: "—",
            amount = o.flexInt("amount") ?: 0,
        )
    }
}

private data class PayAccrualPreview(
    val periodYm: String?,
    val totalPreviewSalary: Int,
    val alreadyAccruedCount: Int,
    val employeeCount: Int,
)

private data class PayAccrualRun(
    val id: String,
    val periodYm: String?,
    val status: String,
    val trigger: String?,
    val createdCount: Int,
    val skippedCount: Int,
) {
    companion object {
        fun from(o: JSONObject): PayAccrualRun = PayAccrualRun(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            periodYm = o.str("periodYm"),
            status = o.str("status") ?: "—",
            trigger = o.str("trigger"),
            createdCount = o.flexInt("createdCount") ?: 0,
            skippedCount = o.flexInt("skippedCount") ?: 0,
        )
    }
}

/** Editable meal-allowance row (web MealProfileRowState). */
private data class PayMealRow(
    val userId: String,
    val name: String,
    val employeeId: String,
    val enabled: Boolean,
    val amountText: String,
    val saving: Boolean = false,
)

/** Editable driving-mode row (web DrivingProfileRowState). */
private data class PayDrivingRow(
    val userId: String,
    val name: String,
    val employeeId: String,
    val enabled: Boolean,
    val drivingStatus: String?,    // "ACTIVE" | "PENDING" | null
    val saving: Boolean = false,
    val toggling: Boolean = false,
)

// ── State holder (iOS PayrollVM twin — GETs + the web page's exact mutations) ────────

private class PayrollState {
    var businessId by mutableStateOf("ALMA_LIFESTYLE")

    // Wallet summary
    var wallets by mutableStateOf(listOf<PayEmployeeWallet>())
    var totals by mutableStateOf<PayBusinessTotals?>(null)
    var pendingRequests by mutableStateOf(listOf<PayPendingRequest>())
    var pendingAdvanceCount by mutableStateOf(0)
    var pendingWithdrawalCount by mutableStateOf(0)
    var orphanLedgerCount by mutableStateOf(0)

    // Roster (roster_only=true — includes employees with no ledger yet, exactly what
    // the web feeds its compensation employee <select>)
    var compWallets by mutableStateOf(listOf<PayEmployeeWallet>())

    // Meal allowance + driving mode admin tables
    var mealRows by mutableStateOf(listOf<PayMealRow>())
    var drivingRows by mutableStateOf(listOf<PayDrivingRow>())

    // HR dashboard slice
    var monthlySalaryBudget by mutableStateOf(0)
    var roll by mutableStateOf(listOf<PayRollRow>())
    var timeline by mutableStateOf(listOf<PayTimelineTx>())

    // Automation (display + toggle)
    var preview by mutableStateOf<PayAccrualPreview?>(null)
    var runs by mutableStateOf(listOf<PayAccrualRun>())
    var automationEnabled by mutableStateOf<Boolean?>(null)
    var automationDay by mutableStateOf<Int?>(null)
    var automationTimezone by mutableStateOf<String?>(null)

    // UI state
    var typeFilter by mutableStateOf("ALL")
    var monthFilter by mutableStateOf<String?>(null)   // null = all months (timeline)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)        // success line (the web's toast)
    var authExpired by mutableStateOf(false)

    // Per-action busy state — per-row spinners, never a global one
    var busyRequestIds by mutableStateOf(setOf<String>())
    var accrualBusy by mutableStateOf(false)
    var automationBusy by mutableStateOf(false)
    var compBusy by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load(fresh: Boolean = false) {
        loading = true
        error = null
        // After a mutation the web reloads with &refresh=Date.now() to bust caches.
        val summaryQuery = mutableMapOf<String, String?>("business_id" to businessId)
        if (fresh) summaryQuery["refresh"] = System.currentTimeMillis().toString()
        try {
            // The wallet summary is the page's primary dataset — it also decides auth.
            val c = unwrap(AlmaApi.getObject("/api/payroll/wallet/summary", summaryQuery))
            wallets = c.optJSONArray("wallets")?.mapObjects { PayEmployeeWallet.from(it) } ?: emptyList()
            totals = PayBusinessTotals.from(c.optJSONObject("totals"))
            pendingRequests = c.optJSONArray("pendingRequests")?.mapObjects { PayPendingRequest.from(it) } ?: emptyList()
            pendingAdvanceCount = c.flexInt("pendingAdvanceCount") ?: 0
            pendingWithdrawalCount = c.flexInt("pendingWithdrawalCount") ?: 0
            orphanLedgerCount = c.flexInt("orphanLedgerEntryCount") ?: 0
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            loading = false
            return
        } catch (e: Exception) {
            error = e.message
            loading = false
            return
        }

        // Secondary blocks — best-effort; a failure never blanks the page.
        try {
            val rosterQuery = HashMap(summaryQuery)
            rosterQuery["roster_only"] = "true"
            val r = unwrap(AlmaApi.getObject("/api/payroll/wallet/summary", rosterQuery))
            compWallets = r.optJSONArray("wallets")?.mapObjects { PayEmployeeWallet.from(it) } ?: emptyList()
            // The web reads the orphan count off the roster call (it spans non-roster entries).
            orphanLedgerCount = r.flexInt("orphanLedgerEntryCount") ?: orphanLedgerCount
        } catch (_: Exception) {
            compWallets = wallets
        }
        try {
            val c = unwrap(AlmaApi.getObject("/api/hr/dashboard", mapOf("business_id" to businessId)))
            monthlySalaryBudget = c.optJSONObject("kpis")?.flexInt("total_monthly_salary") ?: 0
            roll = c.optJSONArray("employees_roll")?.mapObjects { PayRollRow.from(it) } ?: emptyList()
            timeline = c.optJSONArray("payroll_timeline")?.mapObjects { PayTimelineTx.from(it) } ?: emptyList()
        } catch (_: Exception) { }
        try {
            val c = unwrap(AlmaApi.getObject("/api/payroll/wallet/accruals/preview", mapOf("business_id" to businessId)))
            preview = PayAccrualPreview(
                periodYm = c.str("periodYm"),
                totalPreviewSalary = c.flexInt("totalPreviewSalary") ?: 0,
                alreadyAccruedCount = c.flexInt("alreadyAccruedCount") ?: 0,
                employeeCount = c.optJSONArray("employees")?.length() ?: 0,
            )
        } catch (_: Exception) { }
        try {
            val c = unwrap(AlmaApi.getObject("/api/payroll/wallet/accruals/history", mapOf("business_id" to businessId)))
            runs = c.optJSONArray("runs")?.mapObjects { PayAccrualRun.from(it) } ?: emptyList()
        } catch (_: Exception) { }
        try {
            applyAutomation(AlmaApi.getObject("/api/payroll/wallet/automation"))
        } catch (_: Exception) { }
        try {
            val c = unwrap(AlmaApi.getObject("/api/payroll/meal-allowance/profiles", mapOf("business_id" to businessId)))
            mealRows = c.optJSONArray("rows")?.mapObjects { r ->
                val u = r.optJSONObject("user") ?: return@mapObjects null
                val uid = u.str("id") ?: return@mapObjects null
                val p = r.optJSONObject("profile")
                val amount = p?.flexInt("amountBdt") ?: 0
                PayMealRow(
                    userId = uid,
                    name = u.str("name") ?: "—",
                    employeeId = u.str("employeeIdGas") ?: "",
                    enabled = p?.flexBool("enabled") ?: false,
                    // Same mapping the web does: amount 0 → empty field.
                    amountText = if (amount > 0) amount.toString() else "",
                )
            } ?: emptyList()
        } catch (_: Exception) { }
        try {
            val c = unwrap(AlmaApi.getObject("/api/payroll/driving-mode/profiles", mapOf("business_id" to businessId)))
            drivingRows = c.optJSONArray("rows")?.mapObjects { r ->
                val u = r.optJSONObject("user") ?: return@mapObjects null
                val uid = u.str("id") ?: return@mapObjects null
                PayDrivingRow(
                    userId = uid,
                    name = u.str("name") ?: "—",
                    employeeId = u.str("employeeIdGas") ?: "",
                    enabled = r.optJSONObject("profile")?.flexBool("enabled") ?: false,
                    drivingStatus = r.str("drivingStatus"),
                )
            } ?: emptyList()
        } catch (_: Exception) { }
        loading = false
    }

    /** {ok, data:{setting:{…}}} / flat — same lenient unwrap the iOS decoder does. */
    private fun applyAutomation(root: JSONObject) {
        val mid = unwrap(root)
        val c = mid.optJSONObject("setting") ?: mid
        c.flexBool("enabled")?.let { automationEnabled = it }
        c.flexInt("dayOfMonth")?.let { automationDay = it }
        c.str("timezone")?.let { automationTimezone = it }
    }

    suspend fun setBusiness(id: String) {
        if (id == businessId) return
        businessId = id
        monthFilter = null
        load()
    }

    // ── Mutations (exact endpoints + JSON bodies the web page sends) ──

    /** Display name for an employee id — pending requests carry the id only. */
    fun employeeName(employeeId: String): String =
        wallets.firstOrNull { it.employeeId == employeeId }?.name
            ?: compWallets.firstOrNull { it.employeeId == employeeId }?.name
            ?: employeeId

    /** APPROVE / REJECT one wallet request — web submitReview():
     *  PATCH /api/payroll/wallet/requests/{id}
     *  { action, approvedAmount (APPROVE only), note:'', transactionId, paid_via? }. */
    suspend fun reviewRequest(
        request: PayPendingRequest,
        action: String,
        approvedAmount: Int?,
        transactionId: String,
        paidVia: String? = null,
    ) {
        if (request.id in busyRequestIds) return
        busyRequestIds = busyRequestIds + request.id
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("action", action)
                .put("note", "")
                .put("transactionId", transactionId.trim())
            if (action == "APPROVE" && approvedAmount != null) body.put("approvedAmount", approvedAmount)
            if (!paidVia.isNullOrEmpty()) body.put("paid_via", paidVia)
            AlmaApi.send("PATCH", "/api/payroll/wallet/requests/${request.id}", body)
            notice = if (action == "APPROVE") "অনুমোদিত — ওয়ালেট লেজার আপডেট হয়েছে"
            else "রিকোয়েস্ট বাতিল করা হয়েছে"
            pendingRequests = pendingRequests.filter { it.id != request.id }
            load(fresh = true)
        } catch (e: Exception) {
            error = e.message
        } finally {
            busyRequestIds = busyRequestIds - request.id
        }
    }

    /** Run the monthly salary accrual now — POST /api/payroll/wallet/accruals/run {business_id}. */
    suspend fun runAccrual() {
        if (accrualBusy) return
        accrualBusy = true
        notice = null
        error = null
        try {
            AlmaApi.send("POST", "/api/payroll/wallet/accruals/run", JSONObject().put("business_id", businessId))
            notice = "মাসিক স্যালারি অ্যাক্রুয়াল চেক সম্পন্ন হয়েছে"
            load(fresh = true)
        } catch (e: Exception) {
            error = e.message
        } finally {
            accrualBusy = false
        }
    }

    /** Enable/disable the monthly automation — PATCH /api/payroll/wallet/automation {enabled}. */
    suspend fun setAutomation(enabled: Boolean) {
        if (automationBusy) return
        automationBusy = true
        notice = null
        error = null
        try {
            val resp = AlmaApi.send("PATCH", "/api/payroll/wallet/automation", JSONObject().put("enabled", enabled))
            automationEnabled = enabled
            applyAutomation(resp)
            notice = if (enabled) "পেরোল অটোমেশন চালু হয়েছে" else "পেরোল অটোমেশন বন্ধ হয়েছে"
        } catch (e: Exception) {
            error = e.message
        } finally {
            automationBusy = false
        }
    }

    /** Post one compensation ledger entry — POST /api/payroll/wallet/entries
     *  { business_id, employee_id, type, amount, note, date }. Returns success. */
    suspend fun postCompensation(employeeId: String, type: String, amount: Int, note: String, dateMs: Long): Boolean {
        if (compBusy) return false
        compBusy = true
        notice = null
        error = null
        return try {
            val body = JSONObject()
                .put("business_id", businessId)
                .put("employee_id", employeeId)
                .put("type", type)
                .put("amount", amount)
                .put("note", note)
                .put("date", PayFormat.dayString(dateMs))
            AlmaApi.send("POST", "/api/payroll/wallet/entries", body)
            notice = "কমপেনসেশন লেজার এন্ট্রি পোস্ট হয়েছে"
            load(fresh = true)
            true
        } catch (e: Exception) {
            error = e.message
            false
        } finally {
            compBusy = false
        }
    }

    private fun updateMeal(userId: String, f: (PayMealRow) -> PayMealRow) {
        mealRows = mealRows.map { if (it.userId == userId) f(it) else it }
    }

    private fun updateDriving(userId: String, f: (PayDrivingRow) -> PayDrivingRow) {
        drivingRows = drivingRows.map { if (it.userId == userId) f(it) else it }
    }

    fun setMealEnabled(userId: String, on: Boolean) = updateMeal(userId) { it.copy(enabled = on) }
    fun setMealAmount(userId: String, text: String) = updateMeal(userId) { it.copy(amountText = text) }
    fun setDrivingEnabled(userId: String, on: Boolean) = updateDriving(userId) { it.copy(enabled = on) }

    /** PATCH /api/payroll/meal-allowance/profiles
     *  { business_id, userId, employeeId, enabled, amountBdt (0 when disabled) }. */
    suspend fun saveMealProfile(row: PayMealRow) {
        val current = mealRows.firstOrNull { it.userId == row.userId } ?: return
        if (current.saving) return
        val amount = current.amountText.trim().toIntOrNull() ?: 0
        if (current.enabled && amount <= 0) {
            error = "চালু করার আগে সঠিক পরিমাণ (BDT) দিন"
            return
        }
        updateMeal(row.userId) { it.copy(saving = true) }
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("business_id", businessId)
                .put("userId", current.userId)
                .put("employeeId", current.employeeId)
                .put("enabled", current.enabled)
                .put("amountBdt", if (current.enabled) amount else 0)
            AlmaApi.send("PATCH", "/api/payroll/meal-allowance/profiles", body)
            notice = "${current.name} — খাবার ভাতা সেভ হয়েছে"
        } catch (e: Exception) {
            error = e.message
        }
        updateMeal(row.userId) { it.copy(saving = false) }
    }

    /** PATCH /api/payroll/driving-mode/profiles { business_id, userId, employeeId, enabled }. */
    suspend fun saveDrivingProfile(row: PayDrivingRow) {
        val current = drivingRows.firstOrNull { it.userId == row.userId } ?: return
        if (current.saving) return
        updateDriving(row.userId) { it.copy(saving = true) }
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("business_id", businessId)
                .put("userId", current.userId)
                .put("employeeId", current.employeeId)
                .put("enabled", current.enabled)
            AlmaApi.send("PATCH", "/api/payroll/driving-mode/profiles", body)
            notice = if (current.enabled)
                "${current.name} — ড্রাইভিং মোড চালু (সেটিং) সেভ হয়েছে"
            else
                "${current.name} — ড্রাইভিং মোড বন্ধ (সেটিং) সেভ হয়েছে"
        } catch (e: Exception) {
            error = e.message
        }
        updateDriving(row.userId) { it.copy(saving = false) }
    }

    /** Start/end driving mode for a staff member NOW —
     *  POST /api/payroll/driving-mode/start | /end  { business_id, userId }. */
    suspend fun toggleDrivingNow(row: PayDrivingRow) {
        val current = drivingRows.firstOrNull { it.userId == row.userId } ?: return
        if (current.toggling) return
        val turningOn = current.drivingStatus != "ACTIVE"
        updateDriving(row.userId) { it.copy(toggling = true) }
        notice = null
        error = null
        try {
            val endpoint = if (turningOn) "/api/payroll/driving-mode/start" else "/api/payroll/driving-mode/end"
            val body = JSONObject().put("business_id", businessId).put("userId", current.userId)
            AlmaApi.send("POST", endpoint, body)
            notice = if (turningOn) "${current.name} এখন ড্রাইভিং মোডে"
            else "${current.name}-এর ড্রাইভিং মোড বন্ধ করা হলো"
            updateDriving(row.userId) { it.copy(drivingStatus = if (turningOn) "ACTIVE" else null) }
        } catch (e: Exception) {
            error = e.message
        }
        updateDriving(row.userId) { it.copy(toggling = false) }
    }

    // ── Derived (pure display filters, same logic as the web page) ──

    val filteredWallets: List<PayEmployeeWallet>
        get() = wallets.filter { w ->
            typeFilter == "ALL" || w.latestEntries.any { it.type == typeFilter }
        }

    val timelineMonths: List<String>
        get() = timeline.mapNotNull { if (it.date.length >= 7) it.date.take(7) else null }
            .distinct().sortedDescending()

    val filteredTimeline: List<PayTimelineTx>
        get() = monthFilter?.let { m -> timeline.filter { it.date.startsWith(m) }.take(60) }
            ?: timeline.take(60)
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PayrollScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val context = androidx.compose.ui.platform.LocalContext.current
    val vm = remember { PayrollState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<PayEmployeeWallet?>(null) }
    var statementFor by remember { mutableStateOf<PayEmployeeWallet?>(null) }
    var approveTarget by remember { mutableStateOf<PayPendingRequest?>(null) }
    var rejectTarget by remember { mutableStateOf<PayPendingRequest?>(null) }
    var automationTarget by remember { mutableStateOf<Boolean?>(null) }
    var showAccrualConfirm by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { PayBusinessChips(vm, dark, scope) }
        if (vm.authExpired) {
            item { PayAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { PayNoticeCard("⚠ $it", PayPalette.red500, dark) } }
        vm.notice?.let { item { PayNoticeCard("✓ $it", PayPalette.pos(dark), dark) } }

        item { PayHeroCard(vm) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PayStatTile("COMMISSION TOTALS", vm.totals?.totalCommissions ?: 0, PayPalette.pos(dark), dark, Modifier.weight(1f))
                PayStatTile("BONUS TOTALS", vm.totals?.totalBonuses ?: 0, PayPalette.accentText(dark), dark, Modifier.weight(1f))
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PayStatTile("MEAL DEDUCTIONS", vm.totals?.totalMealDeductions ?: 0, PayPalette.red400, dark, Modifier.weight(1f))
                Spacer(Modifier.weight(1f))
            }
        }

        if (vm.loading && vm.wallets.isEmpty() && !vm.authExpired) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            item { PayCompensationCard(vm, dark, scope) }
            item {
                PayAutomationCard(
                    vm, dark,
                    onToggle = { automationTarget = !(vm.automationEnabled ?: false) },
                    onRunNow = { showAccrualConfirm = true },
                )
            }
            if (vm.pendingRequests.isNotEmpty()) {
                item {
                    PayPendingRequestsCard(
                        vm, dark,
                        onApprove = { approveTarget = it },
                        onReject = { rejectTarget = it },
                    )
                }
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PaySectionHeader("Employee wallets", dark)
                    if (vm.orphanLedgerCount > 0) {
                        Text(
                            "${vm.orphanLedgerCount} orphan ledger ${if (vm.orphanLedgerCount == 1) "entry" else "entries"} — ওয়েবে রিভিউ করুন",
                            color = PayPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        PAY_TYPE_FILTERS.forEach { t ->
                            PayChip(t.replace("_", " "), vm.typeFilter == t, dark) { vm.typeFilter = t }
                        }
                    }
                }
            }
            if (vm.filteredWallets.isEmpty() && !vm.loading) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(vertical = 40.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("👛", fontSize = 30.sp)
                        Text("এখনো ওয়ালেট লেজার নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
                    }
                }
            }
            items(vm.filteredWallets, key = { it.id }) { wallet ->
                PayWalletCard(wallet, dark) { selected = wallet }
            }
            item { PayMealAllowanceCard(vm, dark, scope) }
            item { PayDrivingModeCard(vm, dark, scope) }
            if (vm.roll.isNotEmpty()) {
                item { PayLegacyRollCard(vm, dark) }
            }
            if (vm.timeline.isNotEmpty()) {
                item { PayTimelineCard(vm, dark) }
            }
            item {
                // Native CSV export → Android share sheet (opens in Excel/Sheets/email).
                val roster = if (vm.compWallets.isEmpty()) vm.wallets else vm.compWallets
                if (roster.isNotEmpty()) {
                    Text(
                        "⬇ CSV এক্সপোর্ট / শেয়ার",
                        color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(AlmaTheme.violet, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .plainClick {
                                shareCsv(
                                    context,
                                    "payroll-wallets",
                                    headers = listOf("Employee ID", "Name", "Monthly Salary", "Current Balance", "Due Months", "Outstanding Advance"),
                                    rows = roster.map { w ->
                                        listOf(
                                            w.employeeId,
                                            w.name,
                                            (w.monthlySalary ?: 0).toString(),
                                            (w.summary?.currentBalance ?: 0).toString(),
                                            (w.summary?.salaryDueMonths?.size ?: 0).toString(),
                                            (w.summary?.outstandingAdvance ?: 0).toString(),
                                        )
                                    },
                                )
                            }
                            .padding(vertical = 11.dp),
                    )
                }
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    // ── Sheets + confirmations ──

    selected?.let { wallet ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            PayEmployeeDetailSheet(
                wallet, dark,
                onStatement = { statementFor = wallet },
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
            )
        }
    }

    statementFor?.let { wallet ->
        // Boss opens the employee's FULL transparency statement (fines + appeal
        // history + period totals) — owner spec 2026-07-11. Appeals stay staff-only.
        ModalBottomSheet(onDismissRequest = { statementFor = null }, containerColor = AlmaTheme.rootBg(dark)) {
            WalletStatementScreen(
                ctx,
                employeeId = wallet.employeeId,
                businessId = wallet.businessId,
                allowAppeal = false,
                onClose = { statementFor = null },
            )
        }
    }

    approveTarget?.let { req ->
        ModalBottomSheet(onDismissRequest = { approveTarget = null }, containerColor = AlmaTheme.rootBg(dark)) {
            PayReviewSheet(req, vm.employeeName(req.employeeId), dark) { amount, txn, paidVia ->
                approveTarget = null
                scope.launch { vm.reviewRequest(req, "APPROVE", amount, txn, paidVia) }
            }
        }
    }

    rejectTarget?.let { req ->
        AlertDialog(
            onDismissRequest = { rejectTarget = null },
            title = { Text("রিকোয়েস্ট বাতিল করবেন?") },
            text = {
                Text("${vm.employeeName(req.employeeId)} — ${req.type.replace("_", " ")} ৳ ${String.format("%,d", req.requestedAmount)} বাতিল হবে।")
            },
            confirmButton = {
                TextButton(onClick = {
                    rejectTarget = null
                    scope.launch { vm.reviewRequest(req, "REJECT", null, "") }
                }) { Text("হ্যাঁ, বাতিল করুন", color = PayPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { rejectTarget = null }) { Text("থাক") } },
        )
    }

    automationTarget?.let { enabled ->
        AlertDialog(
            onDismissRequest = { automationTarget = null },
            title = { Text("পেরোল অটোমেশন") },
            text = {
                Text(
                    if (enabled)
                        "প্রতি মাসের ${vm.automationDay ?: 10} তারিখে সব কর্মচারীর স্যালারি স্বয়ংক্রিয়ভাবে ওয়ালেটে জমা হবে।"
                    else
                        "স্বয়ংক্রিয় মাসিক স্যালারি জমা বন্ধ হয়ে যাবে।",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    automationTarget = null
                    scope.launch { vm.setAutomation(enabled) }
                }) {
                    Text(
                        if (enabled) "চালু করুন" else "বন্ধ করুন",
                        color = if (enabled) PayPalette.coral else PayPalette.red500,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { automationTarget = null }) { Text("থাক") } },
        )
    }

    if (showAccrualConfirm) {
        AlertDialog(
            onDismissRequest = { showAccrualConfirm = false },
            title = { Text("এখনই স্যালারি অ্যাক্রুয়াল চালাবেন?") },
            text = {
                Text(
                    "প্রিভিউ ৳ ${String.format("%,d", vm.preview?.totalPreviewSalary ?: 0)} — " +
                        "${vm.preview?.employeeCount ?: 0} জন কর্মচারীর স্যালারি ওয়ালেটে জমা হবে (আগে জমা হয়ে থাকলে স্কিপ হবে)।",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showAccrualConfirm = false
                    scope.launch { vm.runAccrual() }
                }) { Text("হ্যাঁ, চালান") }
            },
            dismissButton = { TextButton(onClick = { showAccrualConfirm = false }) { Text("থাক") } },
        )
    }
}

// ── Business selector (web: business context switcher) ─────────────────────────────

@Composable
private fun PayBusinessChips(vm: PayrollState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Row(
        Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PAY_BUSINESSES.forEach { (id, label) ->
            PayChip(label, vm.businessId == id, dark) {
                scope.launch { vm.setBusiness(id) }
            }
        }
        Spacer(Modifier.weight(1f))
        val pending = vm.pendingAdvanceCount + vm.pendingWithdrawalCount
        if (pending > 0) {
            Text(
                "$pending",
                color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(PayPalette.coral.copy(alpha = 0.18f), CircleShape)
                    .border(1.dp, PayPalette.coral.copy(alpha = 0.4f), CircleShape)
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }
    }
}

// ── KPI strip (the iOS bento board: dark hero anchor + glass stat tiles) ────────────

@Composable
private fun PayHeroCard(vm: PayrollState) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(PayPalette.heroBase)
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, PayPalette.coral.copy(alpha = 0.30f))))
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "বেতন বাজেট · MONTHLY SALARY BUDGET",
            color = PayPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        Text(
            AlmaTheme.takaShort(vm.monthlySalaryBudget),
            color = Color.White, fontSize = 38.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            PayHeroStat("COMPANY LIABILITY", vm.totals?.companyLiability ?: 0, PayPalette.green400)
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp).height(34.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            PayHeroStat("UNPAID BALANCE", vm.totals?.currentBalance ?: 0, Color.White)
        }
    }
}

@Composable
private fun PayHeroStat(label: String, value: Int, tint: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label, color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
        )
        Text(
            AlmaTheme.takaShort(value),
            color = tint, fontSize = 19.sp, fontWeight = FontWeight.Black, maxLines = 1,
        )
    }
}

@Composable
private fun PayStatTile(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            AlmaTheme.takaShort(value),
            color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1,
        )
    }
}

// ── Compensation tools (web card — POST wallet entries) ─────────────────────────────

@Composable
private fun PayCompensationCard(vm: PayrollState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    var employeeId by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("EID_BONUS") }      // web default
    var amountText by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var dateMs by remember { mutableStateOf(System.currentTimeMillis()) }
    var showConfirm by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }
    var employeeOpen by remember { mutableStateOf(false) }
    var typeOpen by remember { mutableStateOf(false) }

    val roster = if (vm.compWallets.isEmpty()) vm.wallets else vm.compWallets
    val selectedName = roster.firstOrNull { it.employeeId == employeeId }?.name
    val compType = PAY_COMP_TYPES.firstOrNull { it.value == type } ?: PAY_COMP_TYPES[0]
    val amount = amountText.trim().toIntOrNull()
    val valid = employeeId.isNotEmpty() && amount != null && amount != 0 &&
        (type == "ADJUSTMENT" || amount > 0)

    fun typeMenuTitle(t: PayCompType): String = when (t.kind) {
        "credit" -> "${t.label} · credit"
        "debit" -> "${t.label} · debit"
        else -> t.label
    }

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PaySectionHeader("Compensation tools", dark)
        Text(
            "স্যালারি ক্রেডিট, বোনাস, কমিশন, ওভারটাইম, রিইমবার্সমেন্ট, কর্তন, জরিমানা বা অ্যাডজাস্টমেন্ট — সরাসরি ওয়ালেট লেজারে পোস্ট করুন।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )

        // Employee picker
        Box {
            PayMenuLabel(selectedName?.let { "$it · $employeeId" } ?: "কর্মচারী বাছাই করুন", dark) { employeeOpen = true }
            DropdownMenu(expanded = employeeOpen, onDismissRequest = { employeeOpen = false }) {
                roster.forEach { w ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                (if (employeeId == w.employeeId) "✓ " else "") + "${w.name} · ${w.employeeId}",
                            )
                        },
                        onClick = { employeeId = w.employeeId; employeeOpen = false },
                    )
                }
            }
        }
        // Type picker
        Box {
            PayMenuLabel(typeMenuTitle(compType), dark) { typeOpen = true }
            DropdownMenu(expanded = typeOpen, onDismissRequest = { typeOpen = false }) {
                PAY_COMP_TYPES.forEach { t ->
                    DropdownMenuItem(
                        text = { Text((if (type == t.value) "✓ " else "") + typeMenuTitle(t)) },
                        onClick = { type = t.value; typeOpen = false },
                    )
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = amountText,
                onValueChange = { amountText = it },
                placeholder = { Text(if (type == "ADJUSTMENT") "Amount (+/-)" else "Amount") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
            Text(
                PayFormat.dayString(dateMs),
                color = PayPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { showDatePicker = true }
                    .padding(horizontal = 10.dp, vertical = 12.dp),
            )
        }
        OutlinedTextField(
            value = note, onValueChange = { note = it },
            placeholder = { Text("Note") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (vm.compBusy) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(16.dp), color = PayPalette.coral, strokeWidth = 2.dp)
            }
        } else {
            Text(
                "পোস্ট করুন",
                color = PayPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(PayPalette.coral.copy(alpha = if (valid) 0.16f else 0.07f), CircleShape)
                    .border(1.dp, PayPalette.coral.copy(alpha = if (valid) 0.4f else 0.18f), CircleShape)
                    .plainClick { if (valid) showConfirm = true }
                    .padding(vertical = 9.dp),
            )
        }
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("লেজারে পোস্ট করবেন?") },
            text = {
                Text(
                    "${selectedName ?: employeeId} — ${compType.label} ৳ ${String.format("%,d", amount ?: 0)} " +
                        when (compType.kind) {
                            "debit" -> "(ডেবিট — ব্যালেন্স থেকে কাটা যাবে)"
                            "credit" -> "(ক্রেডিট — ওয়ালেটে যোগ হবে)"
                            else -> "(অ্যাডজাস্টমেন্ট)"
                        } + " লেজারে পোস্ট হবে।",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showConfirm = false
                    val a = amount ?: return@TextButton
                    scope.launch {
                        if (vm.postCompensation(employeeId, type, a, note, dateMs)) {
                            amountText = ""
                            note = ""
                        }
                    }
                }) { Text("হ্যাঁ, পোস্ট করুন") }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("থাক") } },
        )
    }

    if (showDatePicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = dateMs)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { dateMs = it }
                    showDatePicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("বাতিল") } },
        ) {
            DatePicker(state = state)
        }
    }
}

@Composable
private fun PayMenuLabel(text: String, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(PayPalette.coral.copy(alpha = 0.08f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, PayPalette.coral.copy(alpha = 0.28f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text, color = PayPalette.accentText(dark), fontSize = 13.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        Text("⌵", color = PayPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Monthly payroll automation (native toggle + run-now — web parity) ───────────────

@Composable
private fun PayAutomationCard(vm: PayrollState, dark: Boolean, onToggle: () -> Unit, onRunNow: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PaySectionHeader("Monthly payroll automation", dark)
            Spacer(Modifier.weight(1f))
            vm.automationEnabled?.let { enabled ->
                Text(
                    if (enabled) "চালু" else "বন্ধ",
                    color = if (enabled) PayPalette.pos(dark) else AlmaTheme.inkSecondary(dark),
                    fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(
                            (if (enabled) PayPalette.emerald600 else AlmaTheme.inkSecondary(dark)).copy(alpha = 0.12f),
                            CircleShape,
                        )
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
        }
        Text(
            "Runs on day ${vm.automationDay ?: 10} · credits previous month salary · ${vm.automationTimezone ?: "Asia/Dhaka"}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Enable/disable + run-now, each behind a Bangla confirmation.
            if (vm.automationBusy) {
                Box(Modifier.weight(1f).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = PayPalette.coral, strokeWidth = 2.dp)
                }
            } else {
                Text(
                    if (vm.automationEnabled == true) "অটোমেশন বন্ধ করুন" else "অটোমেশন চালু করুন",
                    color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .background(PayPalette.coral.copy(alpha = 0.12f), CircleShape)
                        .border(1.dp, PayPalette.coral.copy(alpha = 0.32f), CircleShape)
                        .plainClick(onToggle)
                        .padding(vertical = 8.dp),
                )
            }
            if (vm.accrualBusy) {
                Box(Modifier.weight(1f).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = PayPalette.coral, strokeWidth = 2.dp)
                }
            } else {
                Text(
                    "এখনই চালান",
                    color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .background(PayPalette.coral.copy(alpha = 0.18f), CircleShape)
                        .border(1.dp, PayPalette.coral.copy(alpha = 0.45f), CircleShape)
                        .plainClick(onRunNow)
                        .padding(vertical = 8.dp),
                )
            }
        }
        vm.preview?.let { p ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(PayPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, PayPalette.coral.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    "MONTHLY PREVIEW" + (p.periodYm?.let { " · $it" } ?: ""),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                Text(
                    PayFormat.taka(p.totalPreviewSalary),
                    color = PayPalette.pos(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold,
                )
                Text(
                    "${p.employeeCount} linked employees · ${p.alreadyAccruedCount} already accrued",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }
        if (vm.runs.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    "ACCRUAL HISTORY",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                vm.runs.take(6).forEach { run ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            run.periodYm ?: "—",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                        )
                        Text(
                            run.status,
                            color = PayPalette.runStatus(run.status, dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.weight(1f))
                        Text(run.trigger ?: "—", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                        Text(
                            "+${run.createdCount} / skip ${run.skippedCount}",
                            color = PayPalette.accentText(dark), fontSize = 10.sp,
                        )
                    }
                }
            }
        }
    }
}

// ── Pending wallet requests (native approve/reject — web submitReview parity) ────────

@Composable
private fun PayPendingRequestsCard(
    vm: PayrollState,
    dark: Boolean,
    onApprove: (PayPendingRequest) -> Unit,
    onReject: (PayPendingRequest) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PaySectionHeader("Pending wallet requests", dark)
        vm.pendingRequests.forEach { req ->
            PayPendingRequestRow(
                req, vm.employeeName(req.employeeId),
                busy = req.id in vm.busyRequestIds, dark = dark,
                onApprove = { onApprove(req) },
                onReject = { onReject(req) },
            )
        }
    }
}

@Composable
private fun PayPendingRequestRow(
    request: PayPendingRequest,
    employeeName: String,
    busy: Boolean,
    dark: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(PayPalette.amber500.copy(alpha = 0.07f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, PayPalette.amber500.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row {
            Text(
                "${request.type.replace("_", " ")} · $employeeName",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text(
                PayFormat.taka(request.requestedAmount),
                color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
        request.reason?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                request.employeeId,
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
            )
            request.businessId?.let {
                Text("· ${it.replace("_", " ")}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Spacer(Modifier.weight(1f))
            request.createdAt?.let {
                Text(
                    it.take(10),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Spacer(Modifier.weight(1f))
            if (busy) {
                CircularProgressIndicator(Modifier.size(13.dp), color = PayPalette.coral, strokeWidth = 2.dp)
                Text("প্রসেস হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            } else {
                Text(
                    "বাতিল",
                    color = PayPalette.red500, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(PayPalette.red500.copy(alpha = 0.10f), CircleShape)
                        .border(1.dp, PayPalette.red500.copy(alpha = 0.35f), CircleShape)
                        .plainClick(onReject)
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
                Text(
                    "অনুমোদন",
                    color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(PayPalette.coral.copy(alpha = 0.18f), CircleShape)
                        .border(1.dp, PayPalette.coral.copy(alpha = 0.45f), CircleShape)
                        .plainClick(onApprove)
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }
        }
    }
}

// ── Approve sheet (web review modal parity — amount + channel + txn id) ─────────────

@Composable
private fun PayReviewSheet(
    request: PayPendingRequest,
    employeeName: String,
    dark: Boolean,
    onConfirm: (approvedAmount: Int, transactionId: String, paidVia: String) -> Unit,
) {
    var amountText by remember { mutableStateOf(request.requestedAmount.toString()) }
    var txn by remember { mutableStateOf("") }
    var paidVia by remember { mutableStateOf("") }

    val amount = amountText.trim().toIntOrNull()
    // Cash handovers have no transaction reference; every other channel keeps one.
    val needsTxn = request.type == "WITHDRAWAL" && paidVia != "CASH"
    val txnTrimmed = txn.trim()
    val valid = amount != null && amount > 0 && amount <= request.requestedAmount &&
        paidVia.isNotEmpty() && (!needsTxn || txnTrimmed.isNotEmpty())

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Approve wallet request", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "$employeeName · ${request.type.replace("_", " ")} · চাওয়া হয়েছে ${PayFormat.taka(request.requestedAmount)}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("APPROVED AMOUNT", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = amountText, onValueChange = { amountText = it },
                placeholder = { Text("Amount") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (amount != null && amount > request.requestedAmount) {
            Text(
                "চাওয়া পরিমাণের (${PayFormat.taka(request.requestedAmount)}) বেশি অনুমোদন করা যাবে না",
                color = PayPalette.amber600, fontSize = 11.sp,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("কীভাবে টাকা দিলেন", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PAY_PAID_VIA.forEach { (value, label) ->
                    Text(
                        label,
                        color = if (paidVia == value) Color.White else AlmaTheme.inkSecondary(dark),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(if (paidVia == value) PayPalette.coral else Color.Transparent, CircleShape)
                            .border(
                                1.dp,
                                if (paidVia == value) PayPalette.coral
                                else AlmaTheme.inkSecondary(dark).copy(alpha = 0.35f),
                                CircleShape,
                            )
                            .plainClick { paidVia = value }
                            .padding(horizontal = 13.dp, vertical = 7.dp),
                    )
                }
            }
            if (paidVia.isEmpty()) {
                Text(
                    "ক্যাশ/বিকাশ/নগদ/ব্যাংক — একটা বাছাই আবশ্যক; লেনদেনের খাতায় লেখা থাকবে।",
                    color = PayPalette.amber600, fontSize = 11.sp,
                )
            }
        }
        if (needsTxn) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("TRANSACTION ID", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                OutlinedTextField(
                    value = txn, onValueChange = { txn = it },
                    placeholder = { Text("যে নম্বর/ID থেকে টাকা পাঠালেন") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    if (txnTrimmed.isEmpty()) "Transaction ID আবশ্যক" else "এই ID সহ staff-কে SMS পাঠানো হবে।",
                    color = if (txnTrimmed.isEmpty()) PayPalette.amber600 else AlmaTheme.inkSecondary(dark),
                    fontSize = 11.sp,
                )
            }
        }
        Text(
            "অনুমোদন করুন — ${PayFormat.taka(amount ?: 0)}",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    if (valid) PayPalette.coral else PayPalette.coral.copy(alpha = 0.4f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (valid) onConfirm(amount!!, txnTrimmed, paidVia) }
                .padding(vertical = 11.dp),
        )
    }
}

// ── Wallet row card (avatar + salary-due chip + 2×2 stats) ──────────────────────────

@Composable
private fun PayWalletCard(wallet: PayEmployeeWallet, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PayAvatar(wallet.name, 34, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(wallet.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    wallet.employeeId,
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
            }
            Text("›", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
        wallet.summary?.let { s ->
            // Owner rule 2026-07-11: super admin must see WHO is unpaid and WHICH month.
            if (s.salaryDueMonths.isNotEmpty() && (wallet.monthlySalary ?: 0) > 0) {
                Text(
                    "বেতন বাকি — " + s.salaryDueMonths.joinToString(", ") { PayFormat.periodBn(it) },
                    color = PayPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(PayPalette.amber600.copy(alpha = 0.14f), CircleShape)
                        .padding(horizontal = 9.dp, vertical = 3.dp),
                )
            }
            Row {
                PayWalletStat("Earned", s.lifetimeEarned, AlmaTheme.ink(dark), dark, Modifier.weight(1f))
                PayWalletStat("Held", s.companyLiability, PayPalette.pos(dark), dark, Modifier.weight(1f))
                PayWalletStat("Commission", s.totalCommissions, PayPalette.pos(dark), dark, Modifier.weight(1f))
                PayWalletStat("Deductions", s.totalMealDeductions + s.totalPenalties, PayPalette.red400, dark, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun PayWalletStat(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Text(
            AlmaTheme.takaShort(value),
            color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        )
    }
}

@Composable
private fun PayAvatar(name: String, sizeDp: Int, dark: Boolean) {
    Box(
        Modifier
            .size(sizeDp.dp)
            .background(PayPalette.coral.copy(alpha = 0.16f), CircleShape)
            .border(1.dp, PayPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            PayFormat.initials(name),
            color = PayPalette.accentText(dark),
            fontSize = (sizeDp / 3).sp, fontWeight = FontWeight.Bold,
        )
    }
}

// ── Meal allowance settings (web card — PATCH meal-allowance profiles) ──────────────

@Composable
private fun PayMealAllowanceCard(vm: PayrollState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PaySectionHeader("Meal Allowance Settings", dark)
        Text(
            "যেদিন রান্না হয় না, চালু-করা কর্মচারীরা খাবার ভাতা রিকোয়েস্ট করতে পারবে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        if (vm.mealRows.isEmpty()) {
            Text("এই ব্যবসায় লিঙ্ক করা কর্মচারী নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        vm.mealRows.forEachIndexed { i, row ->
            Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(row.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            row.employeeId.ifEmpty { "—" },
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        )
                    }
                    Switch(
                        checked = row.enabled,
                        onCheckedChange = { vm.setMealEnabled(row.userId, it) },
                        colors = SwitchDefaults.colors(checkedTrackColor = PayPalette.coral),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = row.amountText,
                        onValueChange = { vm.setMealAmount(row.userId, it) },
                        placeholder = { Text("Amount (BDT)") },
                        singleLine = true,
                        enabled = row.enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.weight(1f),
                    )
                    PaySaveChip(
                        saving = row.saving,
                        disabled = row.saving || (row.enabled && (row.amountText.trim().toIntOrNull() ?: 0) <= 0),
                        dark = dark,
                    ) { scope.launch { vm.saveMealProfile(row) } }
                }
            }
            if (i != vm.mealRows.lastIndex) {
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
            }
        }
    }
}

// ── Driving mode settings (web card — profiles PATCH + start/end POST) ──────────────

@Composable
private fun PayDrivingModeCard(vm: PayrollState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PaySectionHeader("Driving Mode Settings", dark)
        Text(
            "রাস্তায় যাওয়া স্টাফদের জন্য ড্রাইভিং মোড চালু করুন — চালু থাকলে এজেন্ট অফিস ফলো-আপ বন্ধ রাখে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        if (vm.drivingRows.isEmpty()) {
            Text("এই ব্যবসায় লিঙ্ক করা কর্মচারী নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        vm.drivingRows.forEachIndexed { i, row ->
            Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(row.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            row.employeeId.ifEmpty { "—" },
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        )
                    }
                    when (row.drivingStatus) {
                        "ACTIVE" -> Text(
                            "Driving",
                            color = PayPalette.pos(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(PayPalette.emerald600.copy(alpha = 0.15f), CircleShape)
                                .padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                        "PENDING" -> Text(
                            "Pending",
                            color = PayPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(PayPalette.amber500.copy(alpha = 0.15f), CircleShape)
                                .padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                    Switch(
                        checked = row.enabled,
                        onCheckedChange = { vm.setDrivingEnabled(row.userId, it) },
                        colors = SwitchDefaults.colors(checkedTrackColor = PayPalette.coral),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (row.enabled && row.drivingStatus != "PENDING") {
                        val active = row.drivingStatus == "ACTIVE"
                        val tone = if (active) PayPalette.red500 else PayPalette.coral
                        if (row.toggling) {
                            CircularProgressIndicator(Modifier.size(14.dp), color = tone, strokeWidth = 2.dp)
                        } else {
                            Text(
                                if (active) "শেষ করুন" else "এখনই ড্রাইভিং",
                                color = if (active) PayPalette.red500 else PayPalette.accentText(dark),
                                fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier
                                    .background(tone.copy(alpha = 0.12f), CircleShape)
                                    .border(1.dp, tone.copy(alpha = 0.35f), CircleShape)
                                    .plainClick { scope.launch { vm.toggleDrivingNow(row) } }
                                    .padding(horizontal = 14.dp, vertical = 6.dp),
                            )
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    PaySaveChip(saving = row.saving, disabled = row.saving, dark = dark) {
                        scope.launch { vm.saveDrivingProfile(row) }
                    }
                }
            }
            if (i != vm.drivingRows.lastIndex) {
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
            }
        }
    }
}

@Composable
private fun PaySaveChip(saving: Boolean, disabled: Boolean, dark: Boolean, onClick: () -> Unit) {
    if (saving) {
        Box(Modifier.width(54.dp).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(13.dp), color = PayPalette.coral, strokeWidth = 2.dp)
        }
    } else {
        Text(
            "সেভ",
            color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .width(54.dp)
                .background(PayPalette.coral.copy(alpha = if (disabled) 0.06f else 0.13f), CircleShape)
                .border(1.dp, PayPalette.coral.copy(alpha = if (disabled) 0.15f else 0.35f), CircleShape)
                .plainClick { if (!disabled) onClick() }
                .padding(vertical = 8.dp),
        )
    }
}

// ── Legacy GAS rolling balances ─────────────────────────────────────────────────────

@Composable
private fun PayLegacyRollCard(vm: PayrollState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PaySectionHeader("Legacy GAS rolling balances", dark)
        vm.roll.forEachIndexed { i, row ->
            Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(row.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Row {
                    PayRollStat("Salary", row.monthlySalary, AlmaTheme.ink(dark), dark, Modifier.weight(1f))
                    PayRollStat("Paid", row.salaryPaid, AlmaTheme.inkSecondary(dark), dark, Modifier.weight(1f))
                    PayRollStat("Advance", maxOf(0, row.advanceBalance), PayPalette.amber600, dark, Modifier.weight(1f))
                    PayRollStat("Due", maxOf(0, row.currentDue), PayPalette.accentText(dark), dark, Modifier.weight(1f))
                }
                // Paid-of-salary mini bar — pure visual of the two numbers already shown
                // above (amber while due remains, green when cleared).
                if (row.monthlySalary > 0) {
                    val fraction = (row.salaryPaid.toFloat() / row.monthlySalary.toFloat()).coerceIn(0f, 1f)
                    val tone = if (row.currentDue > 0) PayPalette.amber500 else PayPalette.emerald600
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(6.dp)
                            .clip(CircleShape)
                            .background(AlmaTheme.ink(dark).copy(alpha = if (dark) 0.10f else 0.06f)),
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(fraction)
                                .height(6.dp)
                                .clip(CircleShape)
                                .background(Brush.horizontalGradient(listOf(tone.copy(alpha = 0.55f), tone))),
                        )
                    }
                }
            }
            if (i != vm.roll.lastIndex) {
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
            }
        }
    }
}

@Composable
private fun PayRollStat(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Text(
            AlmaTheme.takaShort(value),
            color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
        )
    }
}

// ── Timeline (recent payroll transactions, native month menu) ───────────────────────

@Composable
private fun PayTimelineCard(vm: PayrollState, dark: Boolean) {
    var monthOpen by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PaySectionHeader("Timeline (recent)", dark)
            Spacer(Modifier.weight(1f))
            Box {
                Text(
                    "📅 ${vm.monthFilter ?: "সব মাস"} ⌵",
                    color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(PayPalette.coral.copy(alpha = 0.12f), CircleShape)
                        .border(1.dp, PayPalette.coral.copy(alpha = 0.30f), CircleShape)
                        .plainClick { monthOpen = true }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                )
                DropdownMenu(expanded = monthOpen, onDismissRequest = { monthOpen = false }) {
                    DropdownMenuItem(
                        text = { Text((if (vm.monthFilter == null) "✓ " else "") + "সব মাস") },
                        onClick = { vm.monthFilter = null; monthOpen = false },
                    )
                    vm.timelineMonths.forEach { m ->
                        DropdownMenuItem(
                            text = { Text((if (vm.monthFilter == m) "✓ " else "") + m) },
                            onClick = { vm.monthFilter = m; monthOpen = false },
                        )
                    }
                }
            }
        }
        vm.filteredTimeline.forEach { tx ->
            Row(
                Modifier.padding(vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    tx.date.take(10),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
                Text(
                    "${tx.empName} · ${tx.txType.replace("_", " ")}",
                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text(
                    PayFormat.taka(tx.amount),
                    color = PayPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
        if (vm.filteredTimeline.isEmpty()) {
            Text("এই মাসে কোনো লেনদেন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
    }
}

// ── Employee detail sheet (read-only wallet breakdown + latest ledger entries) ───────

@Composable
private fun PayEmployeeDetailSheet(
    wallet: PayEmployeeWallet,
    dark: Boolean,
    onStatement: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PayAvatar(wallet.name, 42, dark)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(wallet.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        wallet.employeeId,
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                    )
                    wallet.monthlySalary?.takeIf { it > 0 }?.let {
                        Text(
                            "· ${AlmaTheme.takaShort(it)}/মাস",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        )
                    }
                }
            }
        }

        wallet.summary?.let { s ->
            if (s.salaryDueMonths.isNotEmpty() && (wallet.monthlySalary ?: 0) > 0) {
                Text(
                    "বেতন বাকি — " + s.salaryDueMonths.joinToString(", ") { PayFormat.periodBn(it) } +
                        " · ${PayFormat.taka(s.salaryDueMonths.size * (wallet.monthlySalary ?: 0))}",
                    color = PayPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(PayPalette.amber600.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
                        .padding(12.dp),
                )
            }
        }

        // Boss opens the employee's FULL transparency statement — owner spec 2026-07-11.
        Row(
            Modifier
                .fillMaxWidth()
                .almaGlass(dark, 13)
                .plainClick(onStatement)
                .padding(13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "সম্পূর্ণ হিসাব — জরিমানা ও আপিলসহ",
                color = PayPalette.coral, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text("›", color = PayPalette.coral, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }

        wallet.summary?.let { s ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("WALLET SUMMARY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                PayMoneyRow("Lifetime earned", s.lifetimeEarned, AlmaTheme.ink(dark), dark)
                PayMoneyRow("Lifetime withdrawn", s.lifetimeWithdrawn, AlmaTheme.inkSecondary(dark), dark)
                PayMoneyRow("Salary accrued", s.totalAccrued, AlmaTheme.ink(dark), dark)
                PayMoneyRow("Commission", s.totalCommissions, PayPalette.pos(dark), dark)
                PayMoneyRow("Bonuses", s.totalBonuses, PayPalette.accentText(dark), dark)
                PayMoneyRow("Overtime", s.totalOvertime, AlmaTheme.ink(dark), dark)
                PayMoneyRow("Reimbursements", s.totalReimbursements, AlmaTheme.ink(dark), dark)
                PayMoneyRow("Meal deductions", s.totalMealDeductions, PayPalette.red400, dark)
                PayMoneyRow("Penalties", s.totalPenalties, PayPalette.red400, dark)
                PayMoneyRow("Outstanding advance", s.outstandingAdvance, PayPalette.amber600, dark)
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
                PayMoneyRow("Held balance (liability)", s.companyLiability, PayPalette.pos(dark), dark, bold = true)
                PayMoneyRow("Withdrawable now", s.availableWithdrawable, PayPalette.pos(dark), dark)
                PayMoneyRow(
                    "এই চক্রের বেতন" + (s.cyclePeriodYm?.let { " (${PayFormat.periodBn(it)})" } ?: ""),
                    s.currentCycleSalaryAdded,
                    if (s.currentCycleSalaryAdded > 0) PayPalette.pos(dark) else AlmaTheme.ink(dark),
                    dark,
                )
                Text(
                    "${s.entryCount} ledger ${if (s.entryCount == 1) "entry" else "entries"}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }

        if (wallet.latestEntries.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("LATEST LEDGER ENTRIES", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                wallet.latestEntries.forEachIndexed { i, entry ->
                    Column(Modifier.padding(vertical = 3.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                (entry.type ?: "—").replace("_", " "),
                                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                "${if (entry.signedAmount >= 0) "+" else "−"}৳${String.format("%,d", kotlin.math.abs(entry.signedAmount))}",
                                color = if (entry.signedAmount >= 0) PayPalette.pos(dark) else PayPalette.red400,
                                fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            entry.date?.let {
                                Text(
                                    it.take(10),
                                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                                )
                            }
                            entry.periodYm?.let {
                                Text("· $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                            }
                            Spacer(Modifier.weight(1f))
                            Text(
                                "ব্যালেন্স ৳${String.format("%,d", entry.runningBalance)}",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                            )
                        }
                        entry.note?.takeIf { it.isNotEmpty() }?.let {
                            Text(
                                it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (i != wallet.latestEntries.lastIndex) {
                        Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
                    }
                }
            }
        }

        Text(
            "🌐 পুরো লেজার + অ্যাকশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick {
                    val encoded = try {
                        URLEncoder.encode(wallet.employeeId, "UTF-8").replace("+", "%20")
                    } catch (_: Exception) {
                        wallet.employeeId
                    }
                    openWeb("/employees/$encoded", wallet.name)
                }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun PayMoneyRow(label: String, value: Int, tint: Color, dark: Boolean, bold: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            modifier = Modifier.weight(1f),
        )
        Text(
            PayFormat.taka(value),
            color = tint, fontSize = 13.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold,
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun PaySectionHeader(title: String, dark: Boolean) {
    Text(
        title.uppercase(),
        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun PayChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) PayPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) PayPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) PayPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun PayNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun PayAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(PayPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}
