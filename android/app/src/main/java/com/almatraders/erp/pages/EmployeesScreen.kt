//
//  EmployeesScreen.kt
//  ALMA ERP — Employees tab (/employees + /employees/[id]) ported 1:1 from
//  EmployeesSwiftUI.swift (design source of truth):
//  bento dark hero (Total/Active/Roles) · add-employee (manual + create-from-user +
//  orphan clear/re-link) · local search (name/ID/phone) · role chips · contact rows
//  (photo avatar via /api/users/{id}/profile-image with Coil + session cookie,
//  status capsule, Linked marker) · detail sheet with profile header, tel/WhatsApp,
//  wallet strip (Bangla balance note verbatim), attendance summary + reset,
//  wallet ledger + accrual reverse, legacy GAS history, pending corrections,
//  payroll entry / salary edit / salary correction / link account — every money or
//  destructive write behind a Bangla confirm with name + amount.
//
//  Endpoints (same as web/iOS):
//    GET    /api/hr/employees?business_id=…&include_users=1      {employees, users}
//    GET    /api/payroll/wallet/{emp_id}?business_id=…           {user, summary, entries}
//    GET    /api/attendance?business_id=…&employee_id=…          {ok,data:{records,summary}}
//    GET    /api/hr/payroll?business_id=…&emp_id=…               {transactions}
//    GET    /api/approvals?status=PENDING&module=PAYROLL&limit=80
//    POST   /api/hr/employees · PATCH /api/hr/employees/link
//    POST   /api/hr/payroll · PATCH /api/hr/employees/{emp_id}/salary
//    POST   /api/payroll/salary-corrections
//    POST   /api/payroll/wallet/entries/reverse-accrual
//    DELETE /api/attendance/{recordId}
//  Deferred to web (escape link): salary slip PDF (needs FileProvider in the shell
//  manifest — untouchable this session) + profile photo upload.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object EmpPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** Web getStatusColor: Active tone-green · Inactive tone-red · else tone-amber. */
    fun status(s: String?): Color = when (s) {
        "Active" -> emerald600
        "Inactive" -> red500
        else -> amber600
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

/** The web BusinessContext default — HR roster lives in the primary business. */
private const val EMP_BUSINESS_ID = "ALMA_LIFESTYLE"

private fun empPathEnc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

// ── Models (same field names the web page types declare — src/types/hr.ts) ─────────

private data class EmpRoster(
    val empId: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val address: String?,
    val role: String?,
    val joiningDate: String?,
    val monthlySalary: Int,
    val status: String?,
    val notes: String?,
) {
    companion object {
        fun from(o: JSONObject): EmpRoster? {
            val id = o.str("emp_id") ?: return null
            return EmpRoster(
                empId = id,
                name = o.str("name") ?: "—",
                phone = o.str("phone"),
                email = o.str("email"),
                address = o.str("address"),
                role = o.str("role"),
                joiningDate = o.str("joining_date"),
                monthlySalary = o.flexInt("monthly_salary") ?: 0,
                status = o.str("status"),
                notes = o.str("notes"),
            )
        }
    }
}

/** The `users` array from include_users=1 — web LinkableUser shape. */
private data class EmpUser(
    val id: String,
    val name: String?,
    val email: String?,
    val phone: String?,
    val role: String?,
    val employeeIdGas: String?,
    val salaryHint: String?,
    val joiningDate: String?,
    val linked: Boolean?,
    val linkState: String?,          // linked | orphan | unlinked
    val linkedEmployeeId: String?,
    val orphanEmployeeId: String?,
    val matchedEmployeeId: String?,
    val matchedEmployeeName: String?,
    val selectable: Boolean?,
) {
    companion object {
        fun from(o: JSONObject): EmpUser? {
            val id = o.str("id") ?: return null
            // salaryHint arrives as string OR number on the web type — normalize.
            val hint = o.str("salaryHint") ?: o.flexInt("salaryHint")?.toString()
            return EmpUser(
                id = id,
                name = o.str("name"),
                email = o.str("email"),
                phone = o.str("phone"),
                role = o.str("role"),
                employeeIdGas = o.str("employeeIdGas"),
                salaryHint = hint,
                joiningDate = o.str("joiningDate"),
                linked = o.flexBool("linked"),
                linkState = o.str("linkState"),
                linkedEmployeeId = o.str("linkedEmployeeId"),
                orphanEmployeeId = o.str("orphanEmployeeId"),
                matchedEmployeeId = o.str("matchedEmployeeId"),
                matchedEmployeeName = o.str("matchedEmployeeName"),
                selectable = o.flexBool("selectable"),
            )
        }
    }
}

private data class EmpWalletTotals(
    val lifetimeEarned: Int,
    val lifetimeWithdrawn: Int,
    val currentBalance: Int,
)

private data class EmpWalletEntry(
    val entryId: String?,
    val date: String?,
    val periodYm: String?,
    val type: String?,
    val note: String?,
    val source: String?,
    val amount: Int,          // unsigned — the correction flow keys off it
    val signedAmount: Int,
    val runningBalance: Int,
    val key: String,          // stable list identity even when the row has no id
) {
    companion object {
        fun from(o: JSONObject): EmpWalletEntry {
            val id = o.str("id")
            val date = o.str("date")
            val type = o.str("type")
            val signed = o.flexInt("signedAmount") ?: 0
            val running = o.flexInt("runningBalance") ?: 0
            return EmpWalletEntry(
                entryId = id,
                date = date,
                periodYm = o.str("periodYm"),
                type = type,
                note = o.str("note"),
                source = o.str("source"),
                amount = o.flexInt("amount") ?: 0,
                signedAmount = signed,
                runningBalance = running,
                key = id ?: "${date ?: "?"}·${type ?: "?"}·$signed·$running",
            )
        }
    }
}

private data class EmpWalletDetail(
    val userId: String?,
    val summary: EmpWalletTotals?,
    val entries: List<EmpWalletEntry>,
)

private data class EmpAttSummary(
    val presentDays: Int,
    val lateCount: Int,
    val totalPenalties: Int,
    val waivedPenalties: Int,
    val averageWorkMinutes: Int,
)

private data class EmpAttRecord(
    val id: String,
    val attendanceDate: String?,
    val checkInAt: String?,
    val checkOutAt: String?,
    val totalWorkMinutes: Int,
    val lateMinutes: Int,
    val penaltyAmount: Int,
)

private data class EmpAttDetail(
    val records: List<EmpAttRecord>,
    val summary: EmpAttSummary?,
)

private data class EmpPayrollTx(
    val txId: String,
    val date: String?,
    val txType: String?,
    val amount: Int,
    val periodYm: String?,
    val note: String?,
)

private data class EmpCorrectionPayload(
    val employeeId: String?,
    val periodYm: String?,
    val currentAmount: Int,
    val proposedAmount: Int,
    val requestedReason: String?,
    val reversalCount: Int,
)

private data class EmpCorrection(
    val id: String,
    val createdAt: String?,
    val reason: String?,
    val requesterName: String?,
    val payload: EmpCorrectionPayload?,
)

/** GET wrappers answer flat OR {ok, data:{…}} — unwrap both shapes. */
private fun empUnwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

// ── State holders (iOS EmployeesVM / EmployeeDetailVM twins) ───────────────────────

private class EmployeesState {
    var employees by mutableStateOf(listOf<EmpRoster>())
    var users by mutableStateOf(listOf<EmpUser>())
    /** emp_id → linked userId (photo avatars, "Linked" marker). */
    var linkedUserIdByEmpId by mutableStateOf(mapOf<String, String>())
    var loading by mutableStateOf(false)
    var saving by mutableStateOf(false)
    var linkBusyUserId by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    /** Users with no link and no stale ID — "Link roster row to user" choices. */
    val unlinkableUsers: List<EmpUser>
        get() = users.filter { it.linked != true && (it.orphanEmployeeId ?: "").isEmpty() }

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = empUnwrap(
                AlmaApi.getObject(
                    "/api/hr/employees",
                    mapOf("business_id" to EMP_BUSINESS_ID, "include_users" to "1"),
                ),
            )
            employees = c.optJSONArray("employees")?.mapObjects { EmpRoster.from(it) } ?: emptyList()
            users = c.optJSONArray("users")?.mapObjects { EmpUser.from(it) } ?: emptyList()
            val map = HashMap<String, String>()
            for (u in users) if (u.linked == true && !u.linkedEmployeeId.isNullOrEmpty()) {
                map[u.linkedEmployeeId] = u.id
            }
            linkedUserIdByEmpId = map
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

    /** POST /api/hr/employees — same payload keys the web form submits. Null = success. */
    suspend fun saveEmployee(payload: JSONObject): String? {
        saving = true
        try {
            val resp = AlmaApi.send("POST", "/api/hr/employees", payload)
            if (resp.flexBool("ok") != true) return resp.str("error") ?: "Employee save failed"
            notice = "Employee saved"
            load()
            return null
        } catch (e: Exception) {
            return e.message ?: "Employee save failed"
        } finally {
            saving = false
        }
    }

    /** PATCH /api/hr/employees/link — web patchUserLink verbatim. Null = success. */
    suspend fun patchLink(
        action: String,
        userId: String,
        employeeId: String? = null,
        successNotice: String,
    ): String? {
        linkBusyUserId = userId
        try {
            val body = JSONObject()
                .put("business_id", EMP_BUSINESS_ID)
                .put("action", action)
                .put("user_id", userId)
            if (!employeeId.isNullOrEmpty()) body.put("employee_id", employeeId)
            val resp = AlmaApi.send("PATCH", "/api/hr/employees/link", body)
            if (resp.flexBool("ok") == false) return resp.str("error") ?: "Link update failed"
            notice = successNotice
            load()
            return null
        } catch (e: Exception) {
            return e.message ?: "Link update failed"
        } finally {
            linkBusyUserId = null
        }
    }
}

private class EmpDetailState {
    var wallet by mutableStateOf<EmpWalletDetail?>(null)
    var attendance by mutableStateOf<EmpAttDetail?>(null)
    var legacy by mutableStateOf(listOf<EmpPayrollTx>())
    var pendingCorrections by mutableStateOf(listOf<EmpCorrection>())
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var actionError by mutableStateOf<String?>(null)

    // Per-action busy state — never one global spinner.
    var paying by mutableStateOf(false)
    var savingSalary by mutableStateOf(false)
    var correctionSubmitting by mutableStateOf(false)
    var reversingEntryId by mutableStateOf<String?>(null)
    var resettingAttendanceId by mutableStateOf<String?>(null)

    /** Ran anything that changed the roster (salary edit)? The list refreshes. */
    var rosterDirty = false

    /** Accrual rows the correction flow can target (web salaryAccrualEntries). */
    val salaryAccrualEntries: List<EmpWalletEntry>
        get() = (wallet?.entries ?: emptyList()).filter { it.type == "SALARY_ACCRUAL" && it.entryId != null }

    /** Entries a correction may reverse (web reversalCandidateEntries). */
    val reversalCandidateEntries: List<EmpWalletEntry>
        get() = (wallet?.entries ?: emptyList()).filter {
            it.entryId != null && (it.type == "WITHDRAWAL" || it.type == "ADJUSTMENT")
        }

    suspend fun load(empId: String) = coroutineScope {
        loading = true
        error = null
        val enc = empPathEnc(empId)
        // The four fetches are independent — a failure in one must not blank the rest.
        val walletTask = async {
            runCatching {
                val c = empUnwrap(
                    AlmaApi.getObject("/api/payroll/wallet/$enc", mapOf("business_id" to EMP_BUSINESS_ID)),
                )
                EmpWalletDetail(
                    userId = c.optJSONObject("user")?.str("id"),
                    summary = c.optJSONObject("summary")?.let {
                        EmpWalletTotals(
                            it.flexInt("lifetimeEarned") ?: 0,
                            it.flexInt("lifetimeWithdrawn") ?: 0,
                            it.flexInt("currentBalance") ?: 0,
                        )
                    },
                    entries = c.optJSONArray("entries")?.mapObjects { EmpWalletEntry.from(it) } ?: emptyList(),
                )
            }.getOrNull()
        }
        val attTask = async {
            runCatching {
                val c = empUnwrap(
                    AlmaApi.getObject(
                        "/api/attendance",
                        mapOf("business_id" to EMP_BUSINESS_ID, "employee_id" to empId),
                    ),
                )
                EmpAttDetail(
                    records = c.optJSONArray("records")?.mapObjects { o ->
                        EmpAttRecord(
                            id = o.str("id") ?: UUID.randomUUID().toString(),
                            attendanceDate = o.str("attendanceDate"),
                            checkInAt = o.str("checkInAt"),
                            checkOutAt = o.str("checkOutAt"),
                            totalWorkMinutes = o.flexInt("totalWorkMinutes") ?: 0,
                            lateMinutes = o.flexInt("lateMinutes") ?: 0,
                            penaltyAmount = o.flexInt("penaltyAmount") ?: 0,
                        )
                    } ?: emptyList(),
                    summary = c.optJSONObject("summary")?.let {
                        EmpAttSummary(
                            it.flexInt("presentDays") ?: 0,
                            it.flexInt("lateCount") ?: 0,
                            it.flexInt("totalPenalties") ?: 0,
                            it.flexInt("waivedPenalties") ?: 0,
                            it.flexInt("averageWorkMinutes") ?: 0,
                        )
                    },
                )
            }.getOrNull()
        }
        val legacyTask = async {
            runCatching {
                val c = empUnwrap(
                    AlmaApi.getObject(
                        "/api/hr/payroll",
                        mapOf("business_id" to EMP_BUSINESS_ID, "emp_id" to empId),
                    ),
                )
                c.optJSONArray("transactions")?.mapObjects { o ->
                    EmpPayrollTx(
                        txId = o.str("tx_id") ?: UUID.randomUUID().toString(),
                        date = o.str("date"),
                        txType = o.str("tx_type"),
                        amount = o.flexInt("amount") ?: 0,
                        periodYm = o.str("period_ym"),
                        note = o.str("note"),
                    )
                } ?: emptyList()
            }.getOrNull()
        }
        val correctionsTask = async {
            runCatching {
                val c = empUnwrap(
                    AlmaApi.getObject(
                        "/api/approvals",
                        mapOf("status" to "PENDING", "module" to "PAYROLL", "limit" to "80"),
                    ),
                )
                c.optJSONArray("approvals")?.mapObjects { o ->
                    if (o.str("type") != "SALARY_CORRECTION") return@mapObjects null
                    val p = o.optJSONObject("payloadSnapshot")?.let {
                        EmpCorrectionPayload(
                            employeeId = it.str("employeeId"),
                            periodYm = it.str("periodYm"),
                            currentAmount = it.flexInt("currentAmount") ?: 0,
                            proposedAmount = it.flexInt("proposedAmount") ?: 0,
                            requestedReason = it.str("requestedReason"),
                            reversalCount = it.optJSONArray("reversals")?.length() ?: 0,
                        )
                    }
                    EmpCorrection(
                        id = o.str("id") ?: UUID.randomUUID().toString(),
                        createdAt = o.str("createdAt"),
                        reason = o.str("reason"),
                        requesterName = o.optJSONObject("requester")?.str("name"),
                        payload = p,
                    )
                } ?: emptyList()
            }.getOrNull()
        }
        val w = walletTask.await()
        val a = attTask.await()
        wallet = w
        attendance = a
        legacy = legacyTask.await() ?: emptyList()
        // Web filter parity: SALARY_CORRECTION rows whose payload targets this employee.
        pendingCorrections = (correctionsTask.await() ?: emptyList())
            .filter { it.payload?.employeeId == empId }
        if (w == null && a == null) {
            error = "বিস্তারিত লোড করা যায়নি — আবার চেষ্টা করুন।"
        }
        loading = false
    }

    /** Web payrollWalletSkipMessage verbatim. */
    private fun walletSkipMessage(wallet: JSONObject?): String {
        val hint = wallet?.str("hint")
        if (!hint.isNullOrEmpty()) return hint
        return when (wallet?.str("skipped")) {
            "period_type_already_exists" ->
                "${wallet.str("existingType") ?: "Entry"} for ${wallet.str("existingPeriodYm") ?: "this period"} already exists. Use Adjustment to modify, or update the existing row."
            "wallet_entry_already_mirrored" -> "This entry was already mirrored (retry detected)."
            "not_wallet_admin" -> "You do not have permission to update the wallet ledger."
            "wallet_context_denied" -> "Wallet access denied for this business."
            "missing_employee_or_amount" -> "Invalid employee ID or amount."
            "legacy_write_failed" -> "Legacy roll save failed before wallet mirror."
            "legacy_type_not_wallet_mirrored" -> "This tx_type is not mirrored to wallet."
            "p2002_unknown_constraint" -> "Wallet mirror blocked by a unique constraint."
            else -> "Wallet not updated: ${wallet?.str("skipped") ?: "unknown"}"
        }
    }

    /** POST /api/hr/payroll — web submitPay/executePay verbatim. */
    suspend fun addPayroll(
        empId: String, txType: String, amount: Double,
        date: String, periodYm: String, note: String,
    ): Boolean {
        paying = true
        actionError = null
        notice = null
        try {
            val body = JSONObject()
                .put("emp_id", empId)
                .put("tx_type", txType)
                .put("amount", amount)
                .put("date", date)
                .put("period_ym", periodYm)
                .put("note", note)
                .put("business_id", EMP_BUSINESS_ID)
            val resp = AlmaApi.send("POST", "/api/hr/payroll", body)
            if (resp.flexBool("ok") != true) {
                actionError = "Failed: ${resp.str("error") ?: "unknown error"}"
                return false
            }
            val mirror = resp.optJSONObject("wallet")
            notice = if (mirror != null && (mirror.flexBool("ok") == false || mirror.str("skipped") != null)) {
                "Legacy roll saved but ${walletSkipMessage(mirror)}"
            } else {
                "Payroll logged + wallet updated"
            }
            load(empId)
            return true
        } catch (e: Exception) {
            actionError = e.message ?: "Payroll entry failed"
            return false
        } finally {
            paying = false
        }
    }

    /** PATCH /api/hr/employees/{emp_id}/salary — web submitSalary verbatim (camelCase keys). */
    suspend fun patchSalary(empId: String, amount: Int, effectiveDate: String, reason: String): Boolean {
        savingSalary = true
        actionError = null
        notice = null
        try {
            val body = JSONObject()
                .put("amount", amount)
                .put("businessId", EMP_BUSINESS_ID)
                .put("effectiveDate", effectiveDate)
            val trimmed = reason.trim()
            if (trimmed.isNotEmpty()) body.put("reason", trimmed)
            val resp = AlmaApi.send("PATCH", "/api/hr/employees/${empPathEnc(empId)}/salary", body)
            if (resp.flexBool("ok") != true) {
                actionError = resp.str("error") ?: "Failed to update salary"
                return false
            }
            notice = "Salary updated to ${AlmaTheme.taka(resp.flexInt("new_salary") ?: amount)}"
            rosterDirty = true
            load(empId)
            return true
        } catch (e: Exception) {
            actionError = e.message ?: "Failed to update salary"
            return false
        } finally {
            savingSalary = false
        }
    }

    /** POST /api/payroll/salary-corrections — approvals-gated, same as the web. */
    suspend fun requestCorrection(
        empId: String, accrualEntryId: String, periodYm: String,
        proposedAmount: Int, reason: String,
        reversals: List<Triple<String, Int, String>>, // (ledgerEntryId, amount, reason)
    ): Boolean {
        correctionSubmitting = true
        actionError = null
        notice = null
        try {
            val body = JSONObject()
                .put("accrual_entry_id", accrualEntryId)
                .put("employee_id", empId)
                .put("business_id", EMP_BUSINESS_ID)
                .put("period_ym", periodYm)
                .put("proposed_amount", proposedAmount)
                .put("reason", reason)
            if (reversals.isNotEmpty()) {
                val arr = JSONArray()
                reversals.forEach { (id, amount, why) ->
                    arr.put(
                        JSONObject()
                            .put("ledger_entry_id", id)
                            .put("amount", amount)
                            .put("reason", why),
                    )
                }
                body.put("reversals", arr)
            }
            val resp = AlmaApi.send("POST", "/api/payroll/salary-corrections", body)
            if (resp.flexBool("ok") == false) {
                actionError = resp.str("error") ?: "Failed to request salary correction"
                return false
            }
            notice = "Salary correction requested. Awaiting super admin approval."
            load(empId)
            return true
        } catch (e: Exception) {
            actionError = e.message ?: "Failed to request salary correction"
            return false
        } finally {
            correctionSubmitting = false
        }
    }

    /** POST /api/payroll/wallet/entries/reverse-accrual — web reverseSalaryAccrual verbatim. */
    suspend fun reverseAccrual(empId: String, entryId: String) {
        if (reversingEntryId != null) return
        reversingEntryId = entryId
        actionError = null
        notice = null
        try {
            val body = JSONObject()
                .put("business_id", EMP_BUSINESS_ID)
                .put("accrual_entry_id", entryId)
            val resp = AlmaApi.send("POST", "/api/payroll/wallet/entries/reverse-accrual", body)
            if (resp.flexBool("ok") == false) {
                actionError = resp.str("error") ?: "Could not reverse accrual"
                return
            }
            notice = "Salary accrual reversed"
            load(empId)
        } catch (e: Exception) {
            actionError = e.message ?: "Could not reverse accrual"
        } finally {
            reversingEntryId = null
        }
    }

    /** DELETE /api/attendance/{recordId} — web resetAttendanceRecord verbatim (no body). */
    suspend fun resetAttendance(empId: String, recordId: String) {
        if (resettingAttendanceId != null) return
        resettingAttendanceId = recordId
        actionError = null
        notice = null
        try {
            val resp = AlmaApi.send("DELETE", "/api/attendance/${empPathEnc(recordId)}")
            if (resp.flexBool("ok") == false) {
                actionError = resp.str("error") ?: "Could not reset attendance"
                return
            }
            notice = "Attendance reset — employee can check in again"
            load(empId)
        } catch (e: Exception) {
            actionError = e.message ?: "Could not reset attendance"
        } finally {
            resettingAttendanceId = null
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployeesScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { EmployeesState() }
    val scope = rememberCoroutineScope()
    var searchQuery by remember { mutableStateOf("") }
    var roleFilter by remember { mutableStateOf("ALL") }
    var selected by remember { mutableStateOf<EmpRoster?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    // Web useMemo parity: name / emp_id / phone + role, filtered locally → instant.
    val needle = searchQuery.trim().lowercase()
    val filtered = vm.employees.filter { em ->
        val matchesSearch = needle.isEmpty() ||
            em.name.lowercase().contains(needle) ||
            em.empId.lowercase().contains(needle) ||
            (em.phone?.contains(needle) == true)
        val matchesRole = roleFilter == "ALL" || em.role == roleFilter
        matchesSearch && matchesRole
    }
    val uniqueRoles = vm.employees.mapNotNull { it.role }.filter { it.isNotEmpty() }.distinct().sorted()

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { EmpAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { EmpNotice("⚠️ $it", EmpPalette.red500, dark) } }
        vm.notice?.let { item { EmpNotice("✓ $it", EmpPalette.emerald600, dark) } }

        item {
            // Bento dark hero (owner spec 2026-07-08): Total / Active / Roles.
            EmpBentoHero(
                total = vm.employees.size,
                active = vm.employees.count { it.status == "Active" },
                roles = uniqueRoles.size,
            )
        }

        item {
            // Web header "+ Add employee" (gold) — opens the create/link modal.
            Text(
                "＋ Add employee",
                color = EmpPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        EmpPalette.coral.copy(alpha = if (dark) 0.24f else 0.12f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .border(1.dp, EmpPalette.coral.copy(alpha = 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { vm.notice = null; showAdd = true }
                    .padding(vertical = 10.dp),
            )
        }

        item {
            EmpSearchBar(searchQuery, dark, onChange = { searchQuery = it })
        }

        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                EmpChip("All roles", roleFilter == "ALL", dark) { roleFilter = "ALL" }
                uniqueRoles.forEach { role ->
                    EmpChip(role, roleFilter == role, dark) {
                        roleFilter = if (roleFilter == role) "ALL" else role
                    }
                }
            }
        }

        if (!vm.loading || vm.employees.isNotEmpty()) {
            item {
                // Web: "{shown} of {total} employees shown".
                Text(
                    "${filtered.size} of ${vm.employees.size} employees shown",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 2.dp),
                )
            }
        }

        if (vm.loading && vm.employees.isEmpty()) {
            items(6) { Box(Modifier.fillMaxWidth().height(72.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        items(filtered, key = { it.empId }) { em ->
            EmpRowCard(em, vm.linkedUserIdByEmpId[em.empId], dark) { selected = em }
        }

        if (!vm.loading && vm.employees.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("👥", fontSize = 34.sp)
                    Text("No employees yet", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    Text(
                        "Create your roster to unlock payroll tooling",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { em ->
        ModalBottomSheet(onDismissRequest = {
            selected = null
            scope.launch { vm.load() }   // salary edits change the roster row behind us
        }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpDetailSheet(
                employee = em,
                linkedUserId = vm.linkedUserIdByEmpId[em.empId],
                listVM = vm,
                dark = dark,
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
            )
        }
    }

    if (showAdd) {
        ModalBottomSheet(onDismissRequest = { showAdd = false }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpAddSheet(vm, dark) { showAdd = false }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun EmpAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(EmpPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun EmpNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun EmpChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) EmpPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) EmpPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) EmpPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun EmpSearchBar(value: String, dark: Boolean, onChange: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("🔍", fontSize = 13.sp)
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(
                    "Search by name, ID, or phone...",
                    color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp,
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (value.isNotEmpty()) {
            Text(
                "✕", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                modifier = Modifier.plainClick { onChange("") }.padding(2.dp),
            )
        }
    }
}

/** Count-up number (0 → target on appear) — iOS EmpCountUp twin. */
@Composable
private fun empCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val v by animateFloatAsState(
        targetValue = if (started) target.toFloat() else 0f,
        animationSpec = tween(900),
        label = "empCountUp",
    )
    return v.roundToInt()
}

/** The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe). */
@Composable
private fun EmpBentoHero(total: Int, active: Int, roles: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF181528))
            .drawBehind {
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                        start = Offset.Zero,
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.coral.copy(alpha = 0.30f), Color.Transparent),
                        start = Offset(size.width, size.height),
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
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
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "টিম · TOTAL EMPLOYEES",
            color = EmpPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            "${empCountUp(total)}",
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "সব বিজনেস মিলিয়ে টিম",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            EmpHeroStat("ACTIVE", active, EmpPalette.green400, "কর্মরত")
            Box(
                Modifier.padding(horizontal = 14.dp, vertical = 2.dp).width(1.dp).height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            EmpHeroStat("ROLES", roles, EmpPalette.goldLt, "পদ")
        }
    }
}

@Composable
private fun EmpHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        Text(
            "${empCountUp(value)}",
            color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace,
        )
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Avatar (web EmployeeAvatar parity: photo with initials fallback — Coil request
// carries the WebView session cookie so /api/users/{id}/profile-image authorizes) ──

@Composable
private fun EmpAvatar(name: String, userId: String?, size: Int, dark: Boolean) {
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(EmpPalette.coral.copy(alpha = 0.16f))
            .border(1.dp, EmpPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            EmpFormat.initials(name),
            color = EmpPalette.accentText(dark),
            fontSize = (size * 0.30f).sp, fontWeight = FontWeight.Bold,
        )
        if (!userId.isNullOrEmpty()) {
            val cookie = CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL)
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current)
                    .data("${AlmaTheme.BASE_URL}/api/users/${empPathEnc(userId)}/profile-image")
                    .apply { if (!cookie.isNullOrEmpty()) setHeader("Cookie", cookie) }
                    .crossfade(true)
                    .build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size.dp).clip(CircleShape),
            )
        }
    }
}

// ── Row card (contact-list style — web mobile card grid, reset as rows) ────────────

@Composable
private fun EmpRowCard(em: EmpRoster, linkedUserId: String?, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        EmpAvatar(em.name, linkedUserId, 44, dark)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    em.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (linkedUserId != null) {
                    // Web: "Linked" marker on rows with a user account.
                    Text("🔗", color = EmpPalette.emerald600, fontSize = 9.sp)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    if (em.role.isNullOrEmpty()) "Staff" else em.role,
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                )
                if (!em.phone.isNullOrEmpty()) {
                    Text(
                        EmpFormat.bdPhone(em.phone),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace, maxLines = 1,
                    )
                }
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val st = EmpPalette.status(em.status)
            Text(
                em.status ?: "—",
                color = st, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(st.copy(alpha = 0.12f), CircleShape)
                    .border(0.8.dp, st.copy(alpha = 0.35f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 2.5.dp),
            )
            Text(
                AlmaTheme.taka(em.monthlySalary),
                color = EmpPalette.accentText(dark), fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
            )
        }
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 16.sp)
    }
}

// ── Detail sheet (web /employees/[id] parity) ──────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmpDetailSheet(
    employee: EmpRoster,
    linkedUserId: String?,
    listVM: EmployeesState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    val vm = remember(employee.empId) { EmpDetailState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var showBalanceNote by remember { mutableStateOf(false) }
    var showPay by remember { mutableStateOf(false) }
    var showSalary by remember { mutableStateOf(false) }
    var showCorrection by remember { mutableStateOf(false) }
    var showLink by remember { mutableStateOf(false) }
    // Destructive row actions collect their target first, then confirm in Bangla.
    var reverseTarget by remember { mutableStateOf<EmpWalletEntry?>(null) }
    var resetTarget by remember { mutableStateOf<EmpAttRecord?>(null) }

    LaunchedEffect(employee.empId) { vm.load(employee.empId) }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // ── Profile header (big avatar + name + role · emp_id + salary) ──
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            EmpAvatar(employee.name, vm.wallet?.userId ?: linkedUserId, 64, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(employee.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(
                    "${if (employee.role.isNullOrEmpty()) "Staff" else employee.role} · ${employee.empId}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(
                        AlmaTheme.taka(employee.monthlySalary),
                        color = EmpPalette.accentText(dark), fontSize = 14.sp,
                        fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    )
                    Text("Monthly Salary", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
            }
            val st = EmpPalette.status(employee.status)
            Text(
                employee.status ?: "—",
                color = st, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(st.copy(alpha = 0.12f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }

        // ── Contact (call + WhatsApp — 880 rule, same as the Orders screen) ──
        if (!employee.phone.isNullOrEmpty()) {
            val phone = employee.phone
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                EmpActionButton("📞 Call", dark, prominent = false, Modifier.weight(1f)) {
                    try {
                        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")))
                    } catch (_: Exception) { }
                }
                if (phone.startsWith("0")) {
                    EmpActionButton("💬 WhatsApp", dark, prominent = false, Modifier.weight(1f)) {
                        try {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/880${phone.drop(1)}")),
                            )
                        } catch (_: Exception) { }
                    }
                }
            }
        }

        // ── Action buttons (web toolbar) ──
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                EmpActionButton("＋ Payroll entry", dark, prominent = true, Modifier.weight(1f)) {
                    vm.actionError = null; vm.notice = null; showPay = true
                }
                EmpActionButton("✎ Edit salary", dark, prominent = false, Modifier.weight(1f)) {
                    vm.actionError = null; vm.notice = null; showSalary = true
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                EmpActionButton("＋ Request correction", dark, prominent = false, Modifier.weight(1f)) {
                    vm.actionError = null; vm.notice = null; showCorrection = true
                }
                if (linkedUserId == null) {
                    EmpActionButton("🔗 Link account", dark, prominent = false, Modifier.weight(1f)) {
                        listVM.notice = null; showLink = true
                    }
                }
            }
        }

        vm.actionError?.let { EmpNotice("⚠️ $it", EmpPalette.red500, dark) }
        vm.notice?.let { EmpNotice("✓ $it", EmpPalette.emerald600, dark) }

        // ── Info rows (web profile header details) ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!employee.phone.isNullOrEmpty()) EmpInfoRow("📞", EmpFormat.bdPhone(employee.phone), dark)
            if (!employee.email.isNullOrEmpty()) EmpInfoRow("✉️", employee.email, dark)
            if (!employee.address.isNullOrEmpty()) EmpInfoRow("📍", employee.address, dark)
            if (!employee.joiningDate.isNullOrEmpty()) {
                EmpInfoRow("🗓️", "Joined ${employee.joiningDate.take(10)}", dark)
            }
            if (!employee.notes.isNullOrEmpty()) EmpInfoRow("📝", employee.notes, dark)
        }

        // ── Wallet summary strip (Earned / Withdrawn / Current Balance + Bangla note) ──
        if (vm.loading && vm.wallet == null) {
            Box(Modifier.fillMaxWidth().height(84.dp).almaGlass(dark, AlmaTheme.R_CONTROL))
        } else {
            vm.wallet?.summary?.let { s ->
                Column(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        EmpWalletStat("Earned", s.lifetimeEarned, AlmaTheme.ink(dark), dark, Modifier.weight(1f))
                        EmpWalletStat("Withdrawn", s.lifetimeWithdrawn, AlmaTheme.ink(dark), dark, Modifier.weight(1f))
                        EmpWalletStat(
                            "Current Balance", s.currentBalance,
                            if (s.currentBalance < 0) EmpPalette.red500 else EmpPalette.emerald600,
                            dark,
                            Modifier.weight(1f).plainClick { showBalanceNote = !showBalanceNote },
                        )
                    }
                    if (showBalanceNote) {
                        // Web balance tooltip — exact strings.
                        Text(
                            if (s.currentBalance < 0) "এটা company আপনার থেকে পায়"
                            else "এটা আপনি company থেকে পাবেন",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        )
                    }
                }
            }
            if (vm.wallet?.summary == null) {
                vm.error?.let { EmpNotice("⚠️ $it", EmpPalette.red500, dark) }
            }
        }

        // ── Pending salary corrections (amber rows awaiting super admin) ──
        if (vm.pendingCorrections.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "SALARY CORRECTIONS (PENDING)",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
                vm.pendingCorrections.forEach { row ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(EmpPalette.amber500.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .border(0.8.dp, EmpPalette.amber500.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        row.payload?.let { p ->
                            Text(
                                "Pending: ${AlmaTheme.taka(p.currentAmount)} → ${AlmaTheme.taka(p.proposedAmount)} (${p.periodYm ?: "—"})",
                                color = EmpPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            )
                            if (p.reversalCount > 0) {
                                Text(
                                    "Reversals: ${p.reversalCount} entries",
                                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                                )
                            }
                        }
                        Text(
                            "Requested by ${row.requesterName ?: "Admin"} on ${(row.createdAt ?: "—").take(10)}",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                        )
                        val reason = row.reason ?: row.payload?.requestedReason
                        if (!reason.isNullOrEmpty()) {
                            Text(
                                "Reason: $reason",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }

        // ── Attendance summary (mini stats + recent rows + per-row reset) ──
        vm.attendance?.let { att ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "ATTENDANCE SUMMARY",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
                att.summary?.let { s ->
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        EmpMiniStat("Present days", "${s.presentDays} days", AlmaTheme.ink(dark), dark)
                        EmpMiniStat("Late days", "${s.lateCount} days", EmpPalette.amber600, dark)
                        EmpMiniStat("Penalties", AlmaTheme.taka(s.totalPenalties), EmpPalette.red500, dark)
                        EmpMiniStat("Waived", AlmaTheme.taka(s.waivedPenalties), EmpPalette.emerald600, dark)
                        EmpMiniStat("Avg duration", EmpFormat.duration(s.averageWorkMinutes), AlmaTheme.ink(dark), dark)
                    }
                }
                if (att.records.isEmpty()) {
                    Text(
                        "No attendance records this month.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    )
                } else {
                    att.records.take(7).forEach { row ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                (row.attendanceDate ?: "—").take(10),
                                color = AlmaTheme.ink(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                            )
                            Text(
                                "${EmpFormat.time(row.checkInAt)} – ${if (row.checkOutAt != null) EmpFormat.time(row.checkOutAt) else "—"}",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                            )
                            Spacer(Modifier.weight(1f))
                            if (row.lateMinutes > 0) {
                                Text(
                                    "late ${EmpFormat.duration(row.lateMinutes)}",
                                    color = EmpPalette.red500, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                )
                            }
                            if (row.penaltyAmount > 0) {
                                Text(
                                    "−${AlmaTheme.taka(row.penaltyAmount)}",
                                    color = EmpPalette.red500, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                                )
                            }
                            Text(
                                EmpFormat.duration(row.totalWorkMinutes),
                                color = AlmaTheme.ink(dark), fontSize = 10.sp,
                                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                            )
                            // Web "Reset" (attendance delete) — per-row spinner.
                            if (vm.resettingAttendanceId == row.id) {
                                CircularProgressIndicator(Modifier.size(12.dp), color = EmpPalette.amber600, strokeWidth = 2.dp)
                            } else {
                                Text(
                                    "↺", color = EmpPalette.amber600, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.plainClick {
                                        if (vm.resettingAttendanceId == null) resetTarget = row
                                    }.padding(4.dp),
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Recent wallet ledger (newest first, top 8, reverse on SALARY_ACCRUAL) ──
        val entries = vm.wallet?.entries ?: emptyList()
        if (entries.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "WALLET LEDGER (RECENT)",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
                entries.reversed().take(8).forEach { tx ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                (tx.type ?: "—").replace("_", " "),
                                color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                (tx.date ?: "—").take(10),
                                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                            )
                        }
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                "${if (tx.signedAmount >= 0) "+" else "−"}${AlmaTheme.taka(abs(tx.signedAmount))}",
                                color = if (tx.signedAmount >= 0) EmpPalette.emerald600 else EmpPalette.red500,
                                fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                            )
                            Text(
                                AlmaTheme.taka(tx.runningBalance),
                                color = EmpPalette.accentText(dark), fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                            )
                        }
                        // Web "Reverse" on positive SALARY_ACCRUAL rows — per-row spinner.
                        if (tx.type == "SALARY_ACCRUAL" && tx.entryId != null && tx.signedAmount > 0) {
                            if (vm.reversingEntryId == tx.entryId) {
                                CircularProgressIndicator(Modifier.size(12.dp), color = EmpPalette.red500, strokeWidth = 2.dp)
                            } else {
                                Text(
                                    "⤺", color = EmpPalette.red500, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.plainClick {
                                        if (vm.reversingEntryId == null) reverseTarget = tx
                                    }.padding(4.dp),
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Legacy GAS payroll history (bottom table, newest rows) ──
        if (vm.legacy.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "LEGACY GAS PAYROLL HISTORY",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
                vm.legacy.take(10).forEach { tx ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                tx.txType ?: "—",
                                color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                "${(tx.date ?: "—").take(10)} · ${tx.periodYm ?: "—"}",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                            )
                        }
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                AlmaTheme.taka(tx.amount),
                                color = EmpPalette.accentText(dark), fontSize = 10.sp,
                                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                            )
                            if (!tx.note.isNullOrEmpty()) {
                                Text(
                                    tx.note, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }

        // Salary slip PDF + profile photo upload stay on the web (Android: PDF share
        // needs a FileProvider in the shell manifest — untouchable this session).
        Text(
            "স্যালারি স্লিপ (PDF) + ছবি আপলোড — ওয়েব ভার্সন",
            color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/employees/${empPathEnc(employee.empId)}", employee.name) }
                .padding(vertical = 4.dp),
        )
    }

    // ── Sub-sheets ──
    if (showPay) {
        ModalBottomSheet(onDismissRequest = { showPay = false }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpPaySheet(employee, vm, dark, scope) { showPay = false }
        }
    }
    if (showSalary) {
        ModalBottomSheet(onDismissRequest = { showSalary = false }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpSalarySheet(employee, vm, dark, scope) { showSalary = false }
        }
    }
    if (showCorrection) {
        ModalBottomSheet(onDismissRequest = { showCorrection = false }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpCorrectionSheet(employee, vm, dark, scope) { showCorrection = false }
        }
    }
    if (showLink) {
        ModalBottomSheet(onDismissRequest = { showLink = false }, containerColor = AlmaTheme.rootBg(dark)) {
            EmpLinkSheet(employee, listVM, dark, scope) { showLink = false }
        }
    }

    // ── Bangla confirms (web confirmDialog parity: name + amount/date) ──
    reverseTarget?.let { entry ->
        AlertDialog(
            onDismissRequest = { reverseTarget = null },
            title = { Text("স্যালারি অ্যাক্রুয়াল রিভার্স") },
            text = {
                Text("${employee.name}-এর ${AlmaTheme.taka(entry.signedAmount)} স্যালারি অ্যাক্রুয়াল পুরোটা রিভার্স হবে — সমান ADJUSTMENT ডেবিট পোস্ট হবে।")
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = entry.entryId
                    reverseTarget = null
                    if (id != null) scope.launch { vm.reverseAccrual(employee.empId, id) }
                }) { Text("রিভার্স করুন", color = EmpPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { reverseTarget = null }) { Text("বাতিল") } },
        )
    }
    resetTarget?.let { row ->
        AlertDialog(
            onDismissRequest = { resetTarget = null },
            title = { Text("অ্যাটেনডেন্স রিসেট") },
            text = {
                Text("${employee.name}-এর ${(row.attendanceDate ?: "—").take(10)} তারিখের অ্যাটেনডেন্স মুছে যাবে — আবার চেক-ইন করা যাবে, লেট পেনাল্টি থাকলে ফেরত হবে।")
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = row.id
                    resetTarget = null
                    scope.launch { vm.resetAttendance(employee.empId, id) }
                }) { Text("মুছে ফেলুন", color = EmpPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { resetTarget = null }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun EmpActionButton(label: String, dark: Boolean, prominent: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = if (prominent) EmpPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .background(
                if (prominent) EmpPalette.coral.copy(alpha = if (dark) 0.24f else 0.12f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .border(
                1.dp,
                if (prominent) EmpPalette.coral.copy(alpha = 0.45f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .plainClick(onClick)
            .padding(vertical = 9.dp, horizontal = 4.dp),
    )
}

@Composable
private fun EmpInfoRow(icon: String, text: String, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(icon, fontSize = 12.sp, modifier = Modifier.width(18.dp))
        Text(text, color = AlmaTheme.ink(dark), fontSize = 13.sp)
    }
}

@Composable
private fun EmpWalletStat(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            AlmaTheme.taka(value),
            color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace, maxLines = 1,
        )
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

@Composable
private fun EmpMiniStat(label: String, value: String, tint: Color, dark: Boolean) {
    Column(
        Modifier
            .widthIn(min = 76.dp)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
        Text(value, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

// ── Shared form chrome ─────────────────────────────────────────────────────────────

@Composable
private fun EmpField(label: String, dark: Boolean, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        content()
    }
}

/** Today in Asia/Dhaka as yyyy-MM-dd (employeeIsoDate twin). */
private fun empTodayIso(): String {
    val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
    return f.format(Date())
}

/** DatePicker millis (UTC midnight) → yyyy-MM-dd. */
private fun empMillisToIso(millis: Long): String {
    val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    f.timeZone = TimeZone.getTimeZone("UTC")
    return f.format(Date(millis))
}

/** Tappable date value that opens a Material3 DatePickerDialog. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmpDateField(value: String, dark: Boolean, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Text(
        value,
        color = AlmaTheme.ink(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.12f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick { open = true }
            .padding(horizontal = 12.dp, vertical = 9.dp),
    )
    if (open) {
        val state = rememberDatePickerState(initialSelectedDateMillis = System.currentTimeMillis())
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onPick(empMillisToIso(it)) }
                    open = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("বাতিল") } },
        ) { DatePicker(state = state) }
    }
}

@Composable
private fun EmpSubmitRow(
    label: String,
    busy: Boolean,
    dark: Boolean,
    enabled: Boolean = true,
    onCancel: () -> Unit,
    onSubmit: () -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .weight(1f)
                .background(
                    EmpPalette.coral.copy(alpha = if (enabled) 1f else 0.4f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (enabled && !busy) onSubmit() }
                .padding(vertical = 11.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
            } else {
                Text(label, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Text(
            "Cancel",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .weight(0.6f)
                .background(Color.White.copy(alpha = if (dark) 0.08f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.4f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick(onCancel)
                .padding(vertical = 11.dp),
        )
    }
}

// ── Add employee sheet (web "Employee profile" modal — manual create OR
// create-from-user, plus the orphan clear/re-link flows) ───────────────────────────

@Composable
private fun EmpAddSheet(vm: EmployeesState, dark: Boolean, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var selectedUserId by remember { mutableStateOf("") }
    var empId by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var hasJoining by remember { mutableStateOf(false) }
    var joiningDate by remember { mutableStateOf(empTodayIso()) }
    var salaryText by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Active") }
    var notes by remember { mutableStateOf("") }
    var orphanLinkEmpId by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }

    val selectedUser = vm.users.firstOrNull { it.id == selectedUserId }

    /** Web fillFromUser parity — prefill the form from the tapped user. */
    fun fillFromUser(user: EmpUser) {
        selectedUserId = user.id
        name = user.name ?: ""
        phone = user.phone ?: ""
        email = user.email ?: ""
        role = (user.role ?: "").replace("_", " ")
        val jd = user.joiningDate
        if (jd != null && jd.length >= 10) {
            joiningDate = jd.take(10); hasJoining = true
        } else {
            hasJoining = false
        }
        salaryText = user.salaryHint ?: ""
        empId = if ((user.orphanEmployeeId ?: "").isEmpty()) {
            user.employeeIdGas ?: user.matchedEmployeeId ?: ""
        } else ""
    }

    /** Web submit() parity — same payload keys, same guards. */
    fun submit() {
        formError = null
        val trimmedName = name.trim()
        if (trimmedName.isEmpty()) { formError = "Name is required"; return }
        val trimmedEmpId = empId.trim()
        val u = selectedUser
        if (u != null && u.linked == true && !u.employeeIdGas.isNullOrEmpty() && u.employeeIdGas != trimmedEmpId) {
            formError = "${u.name ?: "User"} is already linked to ${u.employeeIdGas}"
            return
        }
        val payload = JSONObject()
            .put("name", trimmedName)
            .put("phone", phone)
            .put("email", email)
            .put("address", address)
            .put("role", role)
            .put("joining_date", if (hasJoining) joiningDate else "")
            .put("monthly_salary", salaryText.trim().toDoubleOrNull() ?: 0.0)
            .put("status", status)
            .put("notes", notes)
            .put("business_id", EMP_BUSINESS_ID)
        if (trimmedEmpId.isNotEmpty()) payload.put("emp_id", trimmedEmpId)
        if (selectedUserId.isNotEmpty()) payload.put("user_id", selectedUserId)
        scope.launch {
            val err = vm.saveEmployee(payload)
            if (err != null) formError = err else dismiss()
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("Employee profile", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Text(
                "Create a roster profile manually or directly from an unlinked system user.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }
        formError?.let { Text("⚠️ $it", color = EmpPalette.red500, fontSize = 13.sp) }

        // ── Create Employee From User (web left column) ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "CREATE EMPLOYEE FROM USER",
                color = EmpPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
            if (vm.users.isEmpty()) {
                Text(
                    "No users available in this business scope.",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            vm.users.forEach { user ->
                EmpUserRow(
                    user = user,
                    vm = vm,
                    dark = dark,
                    isSelected = selectedUserId == user.id,
                    orphanLinkEmpId = if (selectedUserId == user.id) orphanLinkEmpId else "",
                    onSelect = { fillFromUser(user) },
                    onOrphanPick = { selectedUserId = user.id; orphanLinkEmpId = it },
                    onClear = {
                        scope.launch {
                            formError = vm.patchLink(
                                action = "clear_user_link", userId = user.id,
                                successNotice = "Stale employee ID cleared — you can create a new roster row from this user",
                            )
                        }
                    },
                    onLink = {
                        scope.launch {
                            if (selectedUserId != user.id || orphanLinkEmpId.isEmpty()) {
                                formError = "Select a roster employee to link"
                            } else {
                                formError = vm.patchLink(
                                    action = "link_user_to_employee", userId = user.id,
                                    employeeId = orphanLinkEmpId,
                                    successNotice = "Linked ${user.name ?: "user"} to $orphanLinkEmpId",
                                )
                                if (formError == null) orphanLinkEmpId = ""
                            }
                        }
                    },
                )
            }
        }

        // ── Selected user notice ──
        selectedUser?.let { user ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text("SELECTED USER", color = EmpPalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
                Text(user.name ?: "—", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                if (user.linked == true) {
                    Text(
                        "Already linked to ${user.linkedEmployeeId ?: "—"}. Duplicate links are blocked.",
                        color = EmpPalette.emerald600, fontSize = 9.sp,
                    )
                }
                if (user.linkState == "orphan") {
                    Text(
                        "Stale ID on file — clear or re-link before creating a duplicate roster row.",
                        color = EmpPalette.red500, fontSize = 9.sp,
                    )
                }
            }
        }

        // ── Manual fields (web right column, same names) ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            EmpField("Existing ID (optional)", dark) {
                OutlinedTextField(
                    value = empId, onValueChange = { empId = it },
                    placeholder = { Text("AUTO if empty", fontSize = 12.sp) },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
            }
            EmpField("Full name (required)", dark) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) {
                    EmpField("Phone", dark) {
                        OutlinedTextField(
                            value = phone, onValueChange = { phone = it },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Box(Modifier.weight(1f)) {
                    EmpField("Email", dark) {
                        OutlinedTextField(
                            value = email, onValueChange = { email = it },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                            singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            EmpField("Address", dark) {
                OutlinedTextField(
                    value = address, onValueChange = { address = it },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) {
                    EmpField("Role", dark) {
                        OutlinedTextField(
                            value = role, onValueChange = { role = it },
                            singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Box(Modifier.weight(1f)) {
                    EmpField("Monthly salary", dark) {
                        OutlinedTextField(
                            value = salaryText, onValueChange = { salaryText = it },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            EmpField("Joining date", dark) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Switch(checked = hasJoining, onCheckedChange = { hasJoining = it })
                    if (hasJoining) {
                        EmpDateField(joiningDate, dark) { joiningDate = it }
                    } else {
                        Text("Not set", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                    }
                }
            }
            EmpField("Status", dark) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Active", "Inactive", "Probation").forEach { s ->
                        EmpChip(s, status == s, dark) { status = s }
                    }
                }
            }
            EmpField("Notes", dark) {
                OutlinedTextField(
                    value = notes, onValueChange = { notes = it },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        EmpSubmitRow(
            label = if (selectedUser != null) "Create Employee From User" else "Save",
            busy = vm.saving,
            dark = dark,
            enabled = !(vm.saving || selectedUser?.linked == true),
            onCancel = dismiss,
            onSubmit = { submit() },
        )
    }
}

@Composable
private fun EmpUserRow(
    user: EmpUser,
    vm: EmployeesState,
    dark: Boolean,
    isSelected: Boolean,
    orphanLinkEmpId: String,
    onSelect: () -> Unit,
    onOrphanPick: (String) -> Unit,
    onClear: () -> Unit,
    onLink: () -> Unit,
) {
    val selectable = user.selectable ?: false
    val state = user.linkState ?: if (user.linked == true) "linked" else "unlinked"
    val stateColor = when (state) {
        "linked" -> EmpPalette.emerald600
        "orphan" -> EmpPalette.red500
        else -> EmpPalette.amber600
    }
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (isSelected) EmpPalette.coral.copy(alpha = if (dark) 0.20f else 0.10f)
                else Color.White.copy(alpha = if (dark) 0.05f else 0.35f),
                shape,
            )
            .border(
                1.dp,
                if (isSelected) EmpPalette.coral.copy(alpha = 0.5f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                shape,
            )
            .plainClick { if (selectable) onSelect() }
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(user.name ?: "—", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    user.email ?: user.phone ?: "No contact",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontFamily = FontFamily.Monospace,
                )
            }
            Text(
                when (state) {
                    "linked" -> "Linked ${user.linkedEmployeeId ?: ""}"
                    "orphan" -> "Stale ID"
                    else -> "Unlinked"
                },
                color = stateColor, fontSize = 8.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(stateColor.copy(alpha = 0.12f), CircleShape)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        Text(
            "${(user.role ?: "—").replace("_", " ")} · ${user.phone?.let(EmpFormat::bdPhone) ?: "No phone"}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
        )
        if (user.matchedEmployeeId != null && state == "unlinked") {
            Text(
                "Possible existing employee: ${user.matchedEmployeeName ?: "—"} · ${user.matchedEmployeeId}",
                color = EmpPalette.amber600, fontSize = 9.sp,
            )
        }
        // Web orphan controls: clear the stale ID, or re-link to a roster row.
        val orphanId = user.orphanEmployeeId
        if (state == "orphan" && !orphanId.isNullOrEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "User has stale employee ID: $orphanId. Re-link or clear?",
                    color = EmpPalette.red500, fontSize = 9.sp,
                )
                if (vm.linkBusyUserId == user.id) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = EmpPalette.coral, strokeWidth = 2.dp)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "Clear and create new",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .background(Color.White.copy(alpha = if (dark) 0.08f else 0.45f), CircleShape)
                                .border(1.dp, Color.White.copy(alpha = 0.2f), CircleShape)
                                .plainClick(onClear)
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.weight(1f)) {
                            var open by remember { mutableStateOf(false) }
                            Text(
                                if (orphanLinkEmpId.isEmpty()) "Link to roster row…" else orphanLinkEmpId,
                                color = AlmaTheme.ink(dark), fontSize = 10.sp,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), shape)
                                    .plainClick { open = true }
                                    .padding(horizontal = 10.dp, vertical = 7.dp),
                            )
                            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                                vm.employees.forEach { em ->
                                    DropdownMenuItem(
                                        text = { Text("${em.name} · ${em.empId}", fontSize = 12.sp) },
                                        onClick = { onOrphanPick(em.empId); open = false },
                                    )
                                }
                            }
                        }
                        Text(
                            "Link",
                            color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .background(
                                    EmpPalette.coral.copy(alpha = if (orphanLinkEmpId.isEmpty()) 0.4f else 1f),
                                    CircleShape,
                                )
                                .plainClick { if (orphanLinkEmpId.isNotEmpty() && vm.linkBusyUserId == null) onLink() }
                                .padding(horizontal = 12.dp, vertical = 5.dp),
                        )
                    }
                }
            }
        }
    }
}

// ── Link account sheet (PATCH /api/hr/employees/link {action: link_user_to_employee}) ──

@Composable
private fun EmpLinkSheet(
    employee: EmpRoster,
    listVM: EmployeesState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    dismiss: () -> Unit,
) {
    var linkUserId by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("Link roster row to user", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Text(employee.empId, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
        formError?.let { Text("⚠️ $it", color = EmpPalette.red500, fontSize = 13.sp) }
        EmpField("User without employee link", dark) {
            Box {
                var open by remember { mutableStateOf(false) }
                val label = listVM.unlinkableUsers.firstOrNull { it.id == linkUserId }
                    ?.let { "${it.name ?: "—"} · ${(it.role ?: "—").replace("_", " ")}" }
                    ?: "Select user"
                Text(
                    label,
                    color = AlmaTheme.ink(dark), fontSize = 13.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .border(1.dp, Color.White.copy(alpha = if (dark) 0.12f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .plainClick { open = true }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    listVM.unlinkableUsers.forEach { u ->
                        DropdownMenuItem(
                            text = { Text("${u.name ?: "—"} · ${(u.role ?: "—").replace("_", " ")}", fontSize = 13.sp) },
                            onClick = { linkUserId = u.id; open = false },
                        )
                    }
                }
            }
        }
        EmpSubmitRow(
            label = "Link",
            busy = listVM.linkBusyUserId != null,
            dark = dark,
            onCancel = dismiss,
            onSubmit = {
                if (linkUserId.isEmpty()) {
                    formError = "Select a user account"
                } else {
                    scope.launch {
                        formError = listVM.patchLink(
                            action = "link_user_to_employee", userId = linkUserId,
                            employeeId = employee.empId,
                            successNotice = "Roster row linked to user",
                        )
                        if (formError == null) dismiss()
                    }
                }
            },
        )
    }
}

// ── Payroll entry sheet (web "Log payroll movement" modal — POST /api/hr/payroll;
// debit types re-confirm with balance before/after) ────────────────────────────────

/** Web LEGACY_PAY_TX_OPTIONS verbatim. */
private val EMP_TX_OPTIONS = listOf(
    "deposit" to "💰 Credit salary (add to wallet)",
    "advance" to "💸 Advance to employee (debit)",
    "salary_payment" to "⚠️ Mark salary as paid out (debit - usually via approval)",
    "adjustment" to "⚙️ Adjustment (correction)",
)

@Composable
private fun EmpPaySheet(
    employee: EmpRoster,
    vm: EmpDetailState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    dismiss: () -> Unit,
) {
    var txType by remember { mutableStateOf("deposit") }
    var amountText by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(empTodayIso()) }
    var periodYm by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }
    var showConfirm by remember { mutableStateOf(false) }

    val isDebit = txType == "advance" || txType == "salary_payment"
    val amount = amountText.trim().toDoubleOrNull() ?: 0.0

    // Web payrollTxHelper verbatim.
    val helper: Pair<String, Color> = when (txType) {
        "deposit" -> "✓ This will INCREASE the employee's wallet balance." to EmpPalette.emerald600
        "advance" -> "⚠ This will DECREASE balance (employee received cash early)." to EmpPalette.amber600
        "salary_payment" -> "⚠ Caution: Use only if you paid salary outside the wallet. Normal flow is employee withdrawal request → approval." to EmpPalette.amber600
        else -> "Manual correction — can be positive or negative depending on amount sign in ledger mirror." to AlmaTheme.inkSecondary(dark)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Log payroll movement", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text("${employee.name} · ${employee.empId}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        formError?.let { Text("⚠️ $it", color = EmpPalette.red500, fontSize = 13.sp) }
        EmpField("Type", dark) {
            Box {
                var open by remember { mutableStateOf(false) }
                Text(
                    EMP_TX_OPTIONS.first { it.first == txType }.second,
                    color = AlmaTheme.ink(dark), fontSize = 12.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .border(1.dp, Color.White.copy(alpha = if (dark) 0.12f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .plainClick { open = true }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    EMP_TX_OPTIONS.forEach { (v, label) ->
                        DropdownMenuItem(
                            text = { Text(label, fontSize = 12.sp) },
                            onClick = { txType = v; open = false },
                        )
                    }
                }
            }
        }
        Text(helper.first, color = helper.second, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        EmpField("Amount (৳)", dark) {
            OutlinedTextField(
                value = amountText, onValueChange = { amountText = it },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.weight(1f)) {
                EmpField("Effective date", dark) { EmpDateField(date, dark) { date = it } }
            }
            Box(Modifier.weight(1f)) {
                EmpField("Period (YYYY-MM)", dark) {
                    OutlinedTextField(
                        value = periodYm, onValueChange = { periodYm = it },
                        placeholder = { Text("2026-05", fontSize = 12.sp) },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        EmpField("Note", dark) {
            OutlinedTextField(
                value = note, onValueChange = { note = it },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        EmpSubmitRow(
            label = "Save entry",
            busy = vm.paying,
            dark = dark,
            enabled = !vm.paying,
            onCancel = dismiss,
            onSubmit = {
                formError = null
                if (amount <= 0.0) formError = "Transaction type & amount required"
                else showConfirm = true
            },
        )
    }

    if (showConfirm) {
        // Money write → Bangla confirm with name + amount; debits add the web
        // "Confirm wallet debit" balance math.
        val whole = amount.roundToInt()
        val balance = vm.wallet?.summary?.currentBalance ?: 0
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text(if (isDebit) "ওয়ালেট ডেবিট নিশ্চিত করুন" else "পে-রোল এন্ট্রি নিশ্চিত করুন") },
            text = {
                Text(
                    if (isDebit) {
                        "${employee.name}-এর ওয়ালেট ব্যালেন্স ${AlmaTheme.taka(whole)} কমবে। এখনকার ব্যালেন্স ${AlmaTheme.taka(balance)} → এন্ট্রির পরে ${AlmaTheme.taka(balance - whole)}। স্যালারি দিতে সাধারণত \"Credit salary\" ব্যবহার করুন।"
                    } else {
                        "${employee.name}-এর ওয়ালেটে ${if (txType == "deposit") "${AlmaTheme.taka(whole)} যোগ হবে" else "${AlmaTheme.taka(whole)} অ্যাডজাস্টমেন্ট হবে"}।"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showConfirm = false
                    scope.launch {
                        if (vm.addPayroll(employee.empId, txType, amount, date, periodYm, note)) {
                            dismiss()
                        } else {
                            formError = vm.actionError
                        }
                    }
                }) {
                    Text(
                        if (isDebit) "হ্যাঁ, ওয়ালেট থেকে কাটুন" else "নিশ্চিত করুন",
                        color = if (isDebit) EmpPalette.red500 else EmpPalette.coral,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("বাতিল") } },
        )
    }
}

// ── Salary edit sheet (web "Update salary" modal — PATCH …/{emp_id}/salary) ────────

@Composable
private fun EmpSalarySheet(
    employee: EmpRoster,
    vm: EmpDetailState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    dismiss: () -> Unit,
) {
    var newSalaryText by remember { mutableStateOf("") }
    var effectiveDate by remember { mutableStateOf(empTodayIso()) }
    var reason by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }
    var showConfirm by remember { mutableStateOf(false) }

    val newSalary = (newSalaryText.trim().toDoubleOrNull() ?: 0.0).roundToInt()

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Update salary for ${employee.name}", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        formError?.let { Text("⚠️ $it", color = EmpPalette.red500, fontSize = 13.sp) }
        EmpField("Current salary", dark) {
            Text(
                AlmaTheme.taka(employee.monthlySalary),
                color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
        EmpField("New monthly salary (৳)", dark) {
            OutlinedTextField(
                value = newSalaryText, onValueChange = { newSalaryText = it },
                placeholder = { Text("${employee.monthlySalary}", fontSize = 12.sp) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
        }
        EmpField("Effective from", dark) { EmpDateField(effectiveDate, dark) { effectiveDate = it } }
        Text(
            "New monthly accrual will start from the effective date you choose (stored in audit for now). Past accruals are not recalculated.",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
        )
        EmpField("Reason (optional)", dark) {
            OutlinedTextField(
                value = reason, onValueChange = { reason = it },
                placeholder = { Text("e.g. annual increment, role change", fontSize = 12.sp) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        EmpSubmitRow(
            label = "Save",
            busy = vm.savingSalary,
            dark = dark,
            enabled = !vm.savingSalary,
            onCancel = dismiss,
            onSubmit = {
                formError = null
                // Web submitSalary guards verbatim.
                when {
                    newSalary <= 0 -> formError = "Enter a valid salary amount"
                    newSalary > 1_000_000 -> formError = "Salary cannot exceed ৳1,000,000"
                    newSalary == employee.monthlySalary -> formError = "New salary must differ from current salary"
                    else -> showConfirm = true
                }
            },
        )
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("স্যালারি পরিবর্তন নিশ্চিত করুন") },
            text = {
                Text("${employee.name}-এর মাসিক বেতন ${AlmaTheme.taka(employee.monthlySalary)} থেকে ${AlmaTheme.taka(newSalary)} হবে।")
            },
            confirmButton = {
                TextButton(onClick = {
                    showConfirm = false
                    scope.launch {
                        if (vm.patchSalary(employee.empId, newSalary, effectiveDate, reason)) {
                            dismiss()
                        } else {
                            formError = vm.actionError
                        }
                    }
                }) { Text("স্যালারি আপডেট করুন", color = EmpPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("বাতিল") } },
        )
    }
}

// ── Salary correction sheet (web "Request salary correction" modal —
// POST /api/payroll/salary-corrections; lands in the approvals system) ─────────────

private class EmpRevDraft {
    val id: String = UUID.randomUUID().toString()
    var ledgerEntryId by mutableStateOf("")
    var amountText by mutableStateOf("")
    var reason by mutableStateOf("")
}

@Composable
private fun EmpCorrectionSheet(
    employee: EmpRoster,
    vm: EmpDetailState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    dismiss: () -> Unit,
) {
    var accrualId by remember { mutableStateOf("") }
    var proposedText by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    val reversals = remember { mutableStateListOf<EmpRevDraft>() }
    var formError by remember { mutableStateOf<String?>(null) }
    var showConfirm by remember { mutableStateOf(false) }

    val selectedAccrual = vm.salaryAccrualEntries.firstOrNull { it.entryId == accrualId }
    val proposedAmount = (proposedText.trim().toDoubleOrNull() ?: 0.0).roundToInt()
    val delta: Int? = if (selectedAccrual != null && proposedAmount != 0) proposedAmount - selectedAccrual.amount else null

    // Web submitSalaryCorrection guards verbatim.
    fun validate(): Boolean {
        val acc = selectedAccrual
        if (acc?.entryId == null) { formError = "Select a salary accrual to correct"; return false }
        val period = acc.periodYm?.trim()
        if (period.isNullOrEmpty()) { formError = "Selected accrual is missing a period"; return false }
        if (proposedAmount <= 0) { formError = "Proposed amount must be greater than zero"; return false }
        if (proposedAmount == acc.amount) { formError = "Proposed amount must differ from the current accrual"; return false }
        if (reason.trim().length < 5) { formError = "Reason must be at least 5 characters"; return false }
        for (row in reversals) {
            if (row.ledgerEntryId.trim().isEmpty()) continue
            val amount = (row.amountText.trim().toDoubleOrNull() ?: 0.0).roundToInt()
            if (amount == 0) { formError = "Each reversal needs a non-zero amount"; return false }
            if (row.reason.trim().isEmpty()) { formError = "Each reversal needs a reason"; return false }
        }
        return true
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "Request salary correction for ${employee.name}",
            color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold,
        )
        formError?.let { Text("⚠️ $it", color = EmpPalette.red500, fontSize = 13.sp) }

        // Step 1 · Target accrual
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("STEP 1 · TARGET ACCRUAL", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black)
            if (vm.salaryAccrualEntries.isEmpty()) {
                Text(
                    "No SALARY_ACCRUAL entries in this wallet yet.",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            vm.salaryAccrualEntries.forEach { entry ->
                val isSel = accrualId == entry.entryId
                val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(
                            if (isSel) EmpPalette.coral.copy(alpha = if (dark) 0.20f else 0.10f)
                            else Color.White.copy(alpha = if (dark) 0.05f else 0.35f),
                            shape,
                        )
                        .border(
                            1.dp,
                            if (isSel) EmpPalette.coral.copy(alpha = 0.5f)
                            else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                            shape,
                        )
                        .plainClick { accrualId = entry.entryId ?: "" }
                        .padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        if (isSel) "◉" else "○",
                        color = if (isSel) EmpPalette.coral else AlmaTheme.inkSecondary(dark), fontSize = 14.sp,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            entry.periodYm ?: (entry.date ?: "—").take(10),
                            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        )
                        Text(
                            AlmaTheme.taka(entry.amount),
                            color = EmpPalette.accentText(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        )
                        if (!entry.note.isNullOrEmpty()) {
                            Text(
                                entry.note, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }

        // Step 2 · New amount
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("STEP 2 · NEW AMOUNT", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = proposedText, onValueChange = { proposedText = it },
                placeholder = {
                    Text(
                        selectedAccrual?.let { "Current ${AlmaTheme.taka(it.amount)}" } ?: "Select accrual first",
                        fontSize = 12.sp,
                    )
                },
                enabled = selectedAccrual != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            delta?.let { d ->
                Text(
                    "Change: ${if (d >= 0) "+" else "−"}${AlmaTheme.taka(abs(d))}",
                    color = if (d >= 0) EmpPalette.emerald600 else EmpPalette.red500,
                    fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
            }
        }

        // Step 3 · Reverse other entries (optional)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "STEP 3 · REVERSE OTHER ENTRIES (OPTIONAL)",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "+ Add reversal",
                    color = if (selectedAccrual == null) AlmaTheme.inkTertiary(dark) else EmpPalette.accentText(dark),
                    fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick { if (selectedAccrual != null) reversals.add(EmpRevDraft()) },
                )
            }
            if (reversals.isEmpty()) {
                Text(
                    "Use this to cancel a wrong withdrawal or adjustment when approving.",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            reversals.forEach { row ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Reversal", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                        Spacer(Modifier.weight(1f))
                        Text(
                            "Remove",
                            color = EmpPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.plainClick { reversals.removeAll { it.id == row.id } },
                        )
                    }
                    Box {
                        var open by remember { mutableStateOf(false) }
                        val sel = vm.reversalCandidateEntries.firstOrNull { it.entryId == row.ledgerEntryId }
                        Text(
                            sel?.let {
                                "${(it.type ?: "—").replace("_", " ")} · ${AlmaTheme.taka(abs(it.amount))} · ${(it.note ?: it.entryId ?: "").take(40)}"
                            } ?: "Select ledger entry…",
                            color = AlmaTheme.ink(dark), fontSize = 11.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color.White.copy(alpha = if (dark) 0.07f else 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                                .plainClick { open = true }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                        )
                        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                            vm.reversalCandidateEntries.forEach { entry ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            "${(entry.type ?: "—").replace("_", " ")} · ${AlmaTheme.taka(abs(entry.amount))} · ${(entry.note ?: entry.entryId ?: "").take(40)}",
                                            fontSize = 11.sp,
                                        )
                                    },
                                    onClick = { row.ledgerEntryId = entry.entryId ?: ""; open = false },
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = row.amountText, onValueChange = { row.amountText = it },
                        placeholder = { Text("Amount (+ credit back, − debit)", fontSize = 11.sp) },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = row.reason, onValueChange = { row.reason = it },
                        placeholder = { Text("Why reverse this entry", fontSize = 11.sp) },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        // Step 4 · Reason (required)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("STEP 4 · REASON (REQUIRED)", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = reason, onValueChange = { reason = it },
                placeholder = { Text("Explain why this accrual amount should change", fontSize = 12.sp) },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        EmpSubmitRow(
            label = "Submit for approval",
            busy = vm.correctionSubmitting,
            dark = dark,
            enabled = !(vm.correctionSubmitting || vm.salaryAccrualEntries.isEmpty()),
            onCancel = dismiss,
            onSubmit = {
                formError = null
                if (validate()) showConfirm = true
            },
        )
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("সংশোধনের অনুরোধ নিশ্চিত করুন") },
            text = {
                Text(
                    "${employee.name}-এর ${selectedAccrual?.periodYm ?: "—"} অ্যাক্রুয়াল ${AlmaTheme.taka(selectedAccrual?.amount ?: 0)} → ${AlmaTheme.taka(proposedAmount)} করার অনুরোধ সুপার অ্যাডমিন অনুমোদনে যাবে।",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showConfirm = false
                    val acc = selectedAccrual
                    val accId = acc?.entryId
                    val period = acc?.periodYm?.trim()
                    if (acc != null && accId != null && !period.isNullOrEmpty()) {
                        val revs = reversals.mapNotNull { row ->
                            val entryId = row.ledgerEntryId.trim()
                            if (entryId.isEmpty()) null
                            else Triple(
                                entryId,
                                (row.amountText.trim().toDoubleOrNull() ?: 0.0).roundToInt(),
                                row.reason.trim(),
                            )
                        }
                        scope.launch {
                            if (vm.requestCorrection(
                                    employee.empId, accId, period, proposedAmount, reason.trim(), revs,
                                )
                            ) {
                                dismiss()
                            } else {
                                formError = vm.actionError
                            }
                        }
                    }
                }) { Text("অনুমোদনের জন্য পাঠান", color = EmpPalette.coral) }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("বাতিল") } },
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object EmpFormat {
    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** Web displayBdPhone: normalize to +8801XXXXXXXXX then "+880 1XX XXX XXXX". */
    fun bdPhone(raw: String): String {
        var digits = raw.trim().filter { it.isDigit() || it == '+' }
        if (digits.startsWith("+")) digits = "+" + digits.drop(1).filter { it.isDigit() }
        var normalized = digits
        if (digits.startsWith("880")) normalized = "+$digits"
        else if (digits.startsWith("01") && digits.length == 11) normalized = "+88$digits"
        if (normalized.startsWith("+880") && normalized.length == 14) {
            return normalized.substring(0, 4) + " " + normalized.substring(4, 7) + " " +
                normalized.substring(7, 10) + " " + normalized.substring(10)
        }
        return normalized
    }

    /** Minutes → "7h 45m" (web durationLabel). */
    fun duration(minutes: Int): String {
        val h = minutes / 60
        val m = minutes % 60
        return if (h == 0) "${m}m" else "${h}h ${m}m"
    }

    /** ISO timestamp → "10:05 AM" in Asia/Dhaka (web timeLabel). */
    fun time(iso: String?): String {
        val date = parse(iso) ?: return "—"
        val f = SimpleDateFormat("h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    fun parse(iso: String?): Date? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.timeZone = TimeZone.getTimeZone("UTC")
                return f.parse(iso)
            } catch (_: Exception) { }
        }
        return null
    }
}
