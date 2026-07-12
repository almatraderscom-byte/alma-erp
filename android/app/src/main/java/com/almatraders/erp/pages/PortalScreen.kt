//
//  PortalScreen.kt
//  ALMA ERP — the staff "My desk" (/portal), ported 1:1 from PortalSwiftUI.swift (build 66).
//
//  Same endpoints, same colours, same blocks as the web /portal page:
//    GET  /api/users/me?business_id=…                     → profile (name/role/shift/HR id)
//    GET  /api/attendance?business_id=…&scope=me          → today + monthly summary
//    GET  /api/payroll/wallet/{empId}?business_id=…       → wallet summary + ledger + requests
//    GET  /api/operational-tasks/my?business_id=…         → my active tasks
//    GET  /api/attendance/leave?business_id=…             → my leave applications
//    GET  /api/attendance/exceptions?business_id=…        → today's exception status
//    POST /api/payroll/wallet/requests                    → withdraw / advance request
//    POST /api/attendance/leave                           → ছুটির আবেদন (kind/dates/times/reason)
//    POST /api/attendance/exceptions                      → checkout-exception (scope + reason)
//    POST /api/payroll/wallet/advance-notice              → advance-notice "বুঝেছি" ack
//    GET  /api/payroll/meal-allowance/eligibility         → meal-allowance status
//    POST /api/payroll/meal-allowance/requests            → meal-allowance self-request
//    GET  /api/payroll/driving-mode/status                → driving-mode session state
//    POST /api/payroll/driving-mode/start | /end          → driving-mode start / end
//    POST /api/attendance/waivers                         → penalty-appeal (review request)
//    DELETE /api/attendance/waivers/{id}                  → cancel pending appeal
//
//  Android deferral vs iOS build 66: native selfie check-in / GPS check-out stays a
//  WEB ESCAPE here (camera + geolocation hardware flows — Android pass rule), with a
//  note under the buttons. Everything else (all request sheets) is native.
//  Carried lessons: lenient per-field decoding, ONE load path, no global overlay.
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.ui.text.style.TextDecoration
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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object PortalPalette {
    val coral = AlmaTheme.coral                 // web --c-accent  #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Task priority ring — CRITICAL red, HIGH amber, LOW muted, else coral. */
    fun priority(p: String?, dark: Boolean): Color = when (p) {
        "CRITICAL" -> red500
        "HIGH" -> amber600
        "LOW" -> AlmaTheme.inkSecondary(dark)
        else -> coral
    }

    /** Wallet-request / leave status colouring (PENDING amber · APPROVED green · else red). */
    fun requestStatus(s: String): Color = when {
        s == "PENDING" -> amber600
        s.contains("APPROVED") -> green400
        else -> red500
    }
}

// ── Models (same field names the web page types declare) ───────────────────────────

private data class PortalProfile(
    val id: String,
    val name: String,
    val email: String?,
    val phone: String?,
    val role: String?,
    val businessAccess: String?,
    val employeeIdGas: String?,
    val salaryHint: Int?,
    val isSystemOwner: Boolean,
    val roleTitle: String?,
    val shift: String?,
) {
    companion object {
        fun from(o: JSONObject): PortalProfile {
            val p = o.optJSONObject("profile")
            return PortalProfile(
                id = o.str("id") ?: "",
                name = o.str("name") ?: "Account",
                email = o.str("email"),
                phone = o.str("phone"),
                role = o.str("role"),
                businessAccess = o.str("businessAccess"),
                employeeIdGas = o.str("employeeIdGas"),
                salaryHint = o.flexInt("salaryHint"),
                isSystemOwner = o.flexBool("isSystemOwner") == true,
                roleTitle = p?.str("roleTitle"),
                shift = p?.str("shift"),
            )
        }
    }
}

/** One penalty-appeal waiver (web AttendanceWaiverDto slice the desk shows). */
private data class PortalWaiver(
    val id: String,
    val status: String,
    val statusLabel: String?,
    val requestType: String?,
    val originalPenaltyAmount: Int?,
    val requestedReductionAmount: Int?,
    val approvedReductionAmount: Int?,
    val finalAppliedPenalty: Int?,
    val adminNote: String?,
) {
    /** Web PenaltyAppealStatus: statusLabel wins over raw status for display. */
    val effectiveStatus: String
        get() = statusLabel ?: status

    /** Web labelStatus() — "fully approved" / "partially approved" / lowercased. */
    val statusText: String
        get() {
            val s = effectiveStatus
            if (s == "FULLY_APPROVED" || s == "APPROVED") return "fully approved"
            if (s == "PARTIALLY_APPROVED") return "partially approved"
            return s.lowercase().replace("_", " ")
        }

    companion object {
        fun from(o: JSONObject): PortalWaiver? {
            val id = o.str("id") ?: return null
            return PortalWaiver(
                id = id,
                status = o.str("status") ?: "PENDING",
                statusLabel = o.str("statusLabel"),
                requestType = o.str("requestType"),
                originalPenaltyAmount = o.flexInt("originalPenaltyAmount"),
                requestedReductionAmount = o.flexInt("requestedReductionAmount"),
                approvedReductionAmount = o.flexInt("approvedReductionAmount"),
                finalAppliedPenalty = o.flexInt("finalAppliedPenalty"),
                adminNote = o.str("adminNote"),
            )
        }
    }
}

private data class PortalAttendanceToday(
    val id: String?,
    val attendanceDate: String?,
    val checkInAt: String?,
    val checkOutAt: String?,
    val totalWorkMinutes: Int?,
    val lateMinutes: Int?,
    val penaltyAmount: Int?,
    val waiverRequests: List<PortalWaiver>,
) {
    companion object {
        fun from(o: JSONObject): PortalAttendanceToday = PortalAttendanceToday(
            id = o.str("id"),
            attendanceDate = o.str("attendanceDate"),
            checkInAt = o.str("checkInAt"),
            checkOutAt = o.str("checkOutAt"),
            totalWorkMinutes = o.flexInt("totalWorkMinutes"),
            lateMinutes = o.flexInt("lateMinutes"),
            penaltyAmount = o.flexInt("penaltyAmount"),
            waiverRequests = o.optJSONArray("waiverRequests")?.mapObjects { PortalWaiver.from(it) } ?: emptyList(),
        )
    }
}

private data class PortalAttendanceSummary(
    val presentDays: Int,
    val lateCount: Int,
    val totalPenalties: Int,
    val waivedPenalties: Int,
) {
    companion object {
        fun from(o: JSONObject): PortalAttendanceSummary = PortalAttendanceSummary(
            presentDays = o.flexInt("presentDays") ?: 0,
            lateCount = o.flexInt("lateCount") ?: 0,
            totalPenalties = o.flexInt("totalPenalties") ?: 0,
            waivedPenalties = o.flexInt("waivedPenalties") ?: 0,
        )
    }
}

/** Wallet summary — the stats the web WalletOverviewCard renders. */
private data class PortalWalletSummary(
    val currentBalance: Int,
    val availableWithdrawable: Int,
    val totalAccrued: Int,
    val totalCommissions: Int,
    val totalEidBonuses: Int,
    val totalOvertime: Int,
    val totalPenalties: Int,
    val totalMealDeductions: Int,
    val totalAdvances: Int,
    val totalWithdrawals: Int,
    val outstandingAdvance: Int,
) {
    companion object {
        fun from(o: JSONObject): PortalWalletSummary = PortalWalletSummary(
            currentBalance = o.flexInt("currentBalance") ?: 0,
            availableWithdrawable = o.flexInt("availableWithdrawable") ?: 0,
            totalAccrued = o.flexInt("totalAccrued") ?: 0,
            totalCommissions = o.flexInt("totalCommissions") ?: 0,
            totalEidBonuses = o.flexInt("totalEidBonuses") ?: 0,
            totalOvertime = o.flexInt("totalOvertime") ?: 0,
            totalPenalties = o.flexInt("totalPenalties") ?: 0,
            totalMealDeductions = o.flexInt("totalMealDeductions") ?: 0,
            totalAdvances = o.flexInt("totalAdvances") ?: 0,
            totalWithdrawals = o.flexInt("totalWithdrawals") ?: 0,
            outstandingAdvance = o.flexInt("outstandingAdvance") ?: 0,
        )
    }
}

private data class PortalWalletEntry(
    val id: String,
    val date: String?,
    val type: String?,
    val source: String?,
    val signedAmount: Int,
    val runningBalance: Int,
) {
    /** Web walletTxLabel: attendance fines all post as PENALTY, so the ledger
     *  `source` tells them apart — exact Bangla strings from the web map. */
    val label: String
        get() = when (source) {
            "attendance_late_penalty" -> "দেরিতে আসার জরিমানা"
            "attendance_early_leave_penalty" -> "আগে বের হওয়ার জরিমানা"
            "attendance_no_checkout_fine" -> "চেক-আউট না করার জরিমানা"
            "attendance_late_penalty_reversal" -> "জরিমানা ফেরত (আপিল)"
            "attendance_exception_refund" -> "জরিমানা ফেরত (অনুমতি)"
            else -> (type ?: "—").replace("_", " ")
        }

    companion object {
        fun from(o: JSONObject): PortalWalletEntry {
            val date = o.str("date")
            val type = o.str("type")
            val signed = o.flexInt("signedAmount") ?: 0
            val running = o.flexInt("runningBalance") ?: 0
            return PortalWalletEntry(
                id = o.str("id") ?: "${date ?: "?"}-${type ?: "?"}-$signed-$running",
                date = date,
                type = type,
                source = o.str("source"),
                signedAmount = signed,
                runningBalance = running,
            )
        }
    }
}

private data class PortalWalletRequest(
    val id: String,
    val type: String,
    val status: String,
    val requestedAmount: Int,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject): PortalWalletRequest? {
            val id = o.str("id") ?: return null
            return PortalWalletRequest(
                id = id,
                type = o.str("type") ?: "—",
                status = o.str("status") ?: "PENDING",
                requestedAmount = o.flexInt("requestedAmount") ?: 0,
                createdAt = o.str("createdAt"),
            )
        }
    }
}

/** GET /api/operational-tasks/my → { tasks } (OperationalTaskAssignmentDto slice). */
private data class PortalTaskAssignment(
    val id: String,
    val status: String?,
    val title: String,
    val details: String?,
    val priority: String?,
    val deadline: String?,
    val assignedByName: String?,
) {
    companion object {
        fun from(o: JSONObject): PortalTaskAssignment? {
            val id = o.str("id") ?: return null
            val t = o.optJSONObject("task")
            return PortalTaskAssignment(
                id = id,
                status = o.str("status"),
                title = t?.str("title") ?: "—",
                details = t?.str("description"),
                priority = t?.str("priority"),
                deadline = t?.str("deadline"),
                assignedByName = t?.optJSONObject("assignedBy")?.str("name"),
            )
        }
    }
}

private data class PortalLeave(
    val id: String,
    val kind: String?,
    val status: String,
    val startDate: String?,
    val endDate: String?,
    val startMinutes: Int?,
    val endMinutes: Int?,
) {
    /** Web LEAVE_KIND_LABEL — exact strings. */
    val kindLabel: String
        get() = when (kind) {
            "FULL_DAY" -> "একদিন"
            "DATE_RANGE" -> "কয়েকদিন"
            "HOURS" -> "কয়েক ঘণ্টা"
            "SHIFTED_START" -> "দেরিতে শুরু"
            else -> kind ?: "—"
        }

    /** Web LEAVE_STATUS_LABEL — exact strings. */
    val statusLabelText: String
        get() = when (status) {
            "PENDING" -> "⏳ অপেক্ষমাণ"
            "APPROVED" -> "✅ অনুমোদিত"
            "REJECTED" -> "❌ প্রত্যাখ্যাত"
            "CANCELLED" -> "বাতিল"
            else -> status
        }

    companion object {
        fun from(o: JSONObject): PortalLeave? {
            val id = o.str("id") ?: return null
            return PortalLeave(
                id = id,
                kind = o.str("kind"),
                status = o.str("status") ?: "PENDING",
                startDate = o.str("startDate"),
                endDate = o.str("endDate"),
                startMinutes = o.flexInt("startMinutes"),
                endMinutes = o.flexInt("endMinutes"),
            )
        }
    }
}

/** GET /api/payroll/meal-allowance/eligibility → web MealEligibility. */
private data class PortalMealEligibility(
    val enabled: Boolean,
    val amountBdt: Int,
    val canRequestToday: Boolean,
    val pendingStatus: String?,
    val pendingAmount: Int?,
    val reason: String?,
) {
    companion object {
        fun from(o: JSONObject): PortalMealEligibility {
            val pending = o.optJSONObject("pendingRequest")
            return PortalMealEligibility(
                enabled = o.flexBool("enabled") == true,
                amountBdt = o.flexInt("amountBdt") ?: 0,
                canRequestToday = o.flexBool("canRequestToday") == true,
                pendingStatus = pending?.str("status"),
                pendingAmount = pending?.flexInt("amountBdt"),
                reason = o.str("reason"),
            )
        }
    }
}

/** GET /api/payroll/driving-mode/status → web DrivingStatus (session presence = state). */
private data class PortalDrivingStatus(
    val enabled: Boolean,
    val hasActiveSession: Boolean,
    val hasPendingSession: Boolean,
    val canStart: Boolean,
    val reason: String?,
) {
    companion object {
        fun from(o: JSONObject): PortalDrivingStatus = PortalDrivingStatus(
            enabled = o.flexBool("enabled") == true,
            hasActiveSession = o.optJSONObject("activeSession") != null,
            hasPendingSession = o.optJSONObject("pendingSession") != null,
            canStart = o.flexBool("canStart") == true,
            reason = o.str("reason"),
        )
    }
}

// ── State holder (iOS PortalVM twin) ───────────────────────────────────────────────

private const val PORTAL_BUSINESS_ID = "ALMA_LIFESTYLE"

private class PortalState {
    var profile by mutableStateOf<PortalProfile?>(null)
    var attendanceToday by mutableStateOf<PortalAttendanceToday?>(null)
    var attendanceSummary by mutableStateOf<PortalAttendanceSummary?>(null)
    var needsEmployeeLink by mutableStateOf(false)
    var walletSummary by mutableStateOf<PortalWalletSummary?>(null)
    var walletEntries by mutableStateOf(listOf<PortalWalletEntry>())
    var walletRequests by mutableStateOf(listOf<PortalWalletRequest>())
    var advanceNoticeAckedToday by mutableStateOf(false)
    var tasks by mutableStateOf(listOf<PortalTaskAssignment>())
    var leaves by mutableStateOf(listOf<PortalLeave>())
    var exceptionStatus by mutableStateOf<String?>(null)
    var mealEligibility by mutableStateOf<PortalMealEligibility?>(null)
    var drivingStatus by mutableStateOf<PortalDrivingStatus?>(null)
    var loading by mutableStateOf(false)
    var busyActions by mutableStateOf(setOf<String>())
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)     // success line (the web's toast)
    var authExpired by mutableStateOf(false)

    val employeeId: String?
        get() = profile?.employeeIdGas?.trim()?.takeIf { it.isNotEmpty() }
    val isSystemOwner: Boolean
        get() = profile?.isSystemOwner == true

    /** apiDataSuccess wraps payloads → {ok, data:{…}} — unwrap both shapes. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        // Profile first — the wallet call needs the HR employee id it resolves.
        try {
            val c = unwrap(AlmaApi.getObject("/api/users/me", mapOf("business_id" to PORTAL_BUSINESS_ID)))
            profile = c.optJSONObject("user")?.let { PortalProfile.from(it) }
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

        // The owner account intentionally has no personal desk data (web parity).
        if (isSystemOwner) {
            loading = false
            return
        }

        // The staff blocks load concurrently; each is tolerant of its own failure.
        coroutineScope {
            val att = async { fetch("/api/attendance", mapOf("business_id" to PORTAL_BUSINESS_ID, "scope" to "me")) }
            val wal = async {
                employeeId?.let { fetch("/api/payroll/wallet/${encPath(it)}", mapOf("business_id" to PORTAL_BUSINESS_ID)) }
            }
            val tsk = async { fetch("/api/operational-tasks/my", mapOf("business_id" to PORTAL_BUSINESS_ID)) }
            val lev = async { fetch("/api/attendance/leave", mapOf("business_id" to PORTAL_BUSINESS_ID)) }
            val exc = async { fetch("/api/attendance/exceptions", mapOf("business_id" to PORTAL_BUSINESS_ID)) }
            val meal = async { fetch("/api/payroll/meal-allowance/eligibility", mapOf("business_id" to PORTAL_BUSINESS_ID)) }
            val drv = async { fetch("/api/payroll/driving-mode/status", mapOf("business_id" to PORTAL_BUSINESS_ID)) }

            att.await().let { c ->
                attendanceToday = c?.optJSONObject("today")?.let { PortalAttendanceToday.from(it) }
                attendanceSummary = c?.optJSONObject("summary")?.let { PortalAttendanceSummary.from(it) }
                needsEmployeeLink = c?.flexBool("needsEmployeeLink") == true
            }
            wal.await()?.let { c ->
                walletSummary = c.optJSONObject("summary")?.let { PortalWalletSummary.from(it) }
                walletEntries = c.optJSONArray("entries")?.mapObjects { PortalWalletEntry.from(it) } ?: emptyList()
                walletRequests = c.optJSONArray("requests")?.mapObjects { PortalWalletRequest.from(it) } ?: emptyList()
                advanceNoticeAckedToday = c.flexBool("advanceNoticeAckedToday") == true
            }
            tasks = tsk.await()?.optJSONArray("tasks")?.mapObjects { PortalTaskAssignment.from(it) } ?: emptyList()
            leaves = lev.await()?.optJSONArray("leaves")?.mapObjects { PortalLeave.from(it) } ?: emptyList()
            exceptionStatus = exc.await()?.optJSONObject("exception")?.str("status")
            mealEligibility = meal.await()?.let { PortalMealEligibility.from(it) }
            drivingStatus = drv.await()?.let { PortalDrivingStatus.from(it) }
        }
        loading = false
    }

    /** Tolerant sub-fetch: {ok,data} unwrap, any failure → null (iOS `try?` twin). */
    private suspend fun fetch(path: String, query: Map<String, String?>): JSONObject? =
        try {
            unwrap(AlmaApi.getObject(path, query))
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            null
        } catch (e: Exception) {
            null
        }

    // ── Native staff actions (web form parity — same endpoints, same bodies) ──

    /** One POST + success notice + full reload — the web's submit→toast→refetch loop. */
    private suspend fun act(key: String, path: String, body: JSONObject, success: String?): Boolean {
        if (key in busyActions) return false
        busyActions = busyActions + key
        notice = null
        error = null
        try {
            val resp = AlmaApi.send("POST", path, body)
            val data = resp.optJSONObject("data") ?: resp
            val ok = resp.flexBool("ok") ?: data.flexBool("ok") ?: true
            if (!ok) {
                error = bodyError(resp) ?: bodyError(data) ?: "Request failed"
                return false
            }
            notice = success
            load()
            return true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            return false
        } catch (e: AlmaApiException.Http) {
            error = httpErrorMessage(e)
            return false
        } catch (e: Exception) {
            error = e.message ?: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
            return false
        } finally {
            busyActions = busyActions - key
        }
    }

    /** Web WalletRequestCard submit — type WITHDRAWAL | ADVANCE. */
    suspend fun submitWalletRequest(type: String, amount: Int, reason: String) {
        act(
            "wallet", "/api/payroll/wallet/requests",
            JSONObject()
                .put("type", type)
                .put("amount", amount)
                .put("reason", reason)
                .put("business_id", PORTAL_BUSINESS_ID),
            if (type == "WITHDRAWAL") "Withdrawal requested — awaiting approval"
            else "Advance requested — awaiting approval",
        )
    }

    /** Web requestLeave — kind/dates/minutes/reason. */
    suspend fun submitLeave(
        kind: String, startDate: String, endDate: String,
        startMinutes: Int?, endMinutes: Int?, reason: String,
    ) {
        val body = JSONObject()
            .put("business_id", PORTAL_BUSINESS_ID)
            .put("kind", kind)
            .put("start_date", startDate)
            .put("end_date", endDate)
            .put("reason", reason)
        if (startMinutes != null) body.put("start_minutes", startMinutes)
        if (endMinutes != null) body.put("end_minutes", endMinutes)
        act("leave", "/api/attendance/leave", body, "ছুটির আবেদন মালিকের কাছে পাঠানো হয়েছে।")
    }

    /** Web requestException — scope EARLY_CHECKOUT | LATE_ARRIVAL | FULL_DAY. */
    suspend fun submitException(scope: String, reason: String) {
        val ok = act(
            "exception", "/api/attendance/exceptions",
            JSONObject()
                .put("business_id", PORTAL_BUSINESS_ID)
                .put("reason", reason)
                .put("scope", scope),
            "অনুমতির অনুরোধ মালিকের কাছে পাঠানো হয়েছে।",
        )
        if (ok && exceptionStatus == null) exceptionStatus = "PENDING"
    }

    /** Web AdvanceRecoveryNotice "বুঝেছি" ack. */
    suspend fun ackAdvanceNotice() {
        act("ack", "/api/payroll/wallet/advance-notice", JSONObject().put("business_id", PORTAL_BUSINESS_ID), null)
    }

    /** Web MealAllowanceCard submit. */
    suspend fun submitMealRequest(reason: String) {
        act(
            "meal", "/api/payroll/meal-allowance/requests",
            JSONObject().put("business_id", PORTAL_BUSINESS_ID).put("reason", reason),
            "Meal allowance request submitted",
        )
    }

    /** Web DrivingModeCard start — reason optional (trimmed string sent as-is). */
    suspend fun startDrivingMode(reason: String) {
        act(
            "driving", "/api/payroll/driving-mode/start",
            JSONObject().put("business_id", PORTAL_BUSINESS_ID).put("reason", reason),
            "Driving mode request sent for approval",
        )
    }

    /** Web DrivingModeCard end. */
    suspend fun endDrivingMode() {
        act(
            "driving", "/api/payroll/driving-mode/end",
            JSONObject().put("business_id", PORTAL_BUSINESS_ID),
            "Driving mode ended — welcome back",
        )
    }

    /** Web PenaltyAppealModal submit — attachment stays a web-only extra. */
    suspend fun submitPenaltyAppeal(recordId: String, requestType: String, reason: String, partialAmount: Int?) {
        val body = JSONObject()
            .put("business_id", PORTAL_BUSINESS_ID)
            .put("attendance_record_id", recordId)
            .put("reason", reason)
            .put("request_type", requestType)
        if (requestType == "PARTIAL_REDUCE") body.put("requested_reduction_amount", partialAmount ?: 0)
        act("appeal", "/api/attendance/waivers", body, "Penalty review request submitted")
    }

    /** Web cancelAppeal: DELETE /api/attendance/waivers/{id}. */
    suspend fun cancelPenaltyAppeal(waiverId: String) {
        if ("cancelWaiver" in busyActions) return
        busyActions = busyActions + "cancelWaiver"
        notice = null
        error = null
        try {
            val resp = AlmaApi.send("DELETE", "/api/attendance/waivers/${encPath(waiverId)}")
            val ok = resp.flexBool("ok") ?: true
            if (!ok) {
                error = bodyError(resp) ?: "Request failed"
                return
            }
            notice = "Review request cancelled"
            load()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: AlmaApiException.Http) {
            error = httpErrorMessage(e)
        } catch (e: Exception) {
            error = e.message ?: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
        } finally {
            busyActions = busyActions - "cancelWaiver"
        }
    }

    /** Prefer the API's own error text: {error:"…"} or {error:{message:"…"}} or {message}. */
    private fun bodyError(o: JSONObject): String? =
        o.optJSONObject("error")?.str("message")?.takeIf { it.isNotEmpty() }
            ?: o.str("error")?.takeIf { it.isNotEmpty() }
            ?: o.str("message")?.takeIf { it.isNotEmpty() }

    /** Pull the server's Bangla message out of an HTTP error body (iOS serverMessage twin). */
    private fun httpErrorMessage(e: AlmaApiException.Http): String {
        val raw = e.message ?: return "Request failed"
        val idx = raw.indexOf(": ")
        if (idx >= 0) {
            try {
                bodyError(JSONObject(raw.substring(idx + 2)))?.let { return it }
            } catch (_: Exception) { }
        }
        return raw
    }

    private fun encPath(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortalScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { PortalState() }
    val scope = rememberCoroutineScope()

    var walletSheet by remember { mutableStateOf(false) }
    var leaveSheet by remember { mutableStateOf(false) }
    var exceptionSheet by remember { mutableStateOf(false) }
    var appealSheet by remember { mutableStateOf(false) }
    var mealReason by remember { mutableStateOf("") }
    var confirmMeal by remember { mutableStateOf(false) }
    var drivingReason by remember { mutableStateOf("") }
    var confirmDrivingStart by remember { mutableStateOf(false) }
    var confirmDrivingEnd by remember { mutableStateOf(false) }
    var cancelWaiverId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    /** Web gate for OfficeAdvanceDeskCard: ADMIN / SUPER_ADMIN only. */
    val isAdminRole = vm.profile?.role == "ADMIN" || vm.profile?.role == "SUPER_ADMIN"

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { PortalAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { item { PortalNoticeCard("⚠️ $it", PortalPalette.red500, dark) } }
        vm.notice?.let { item { PortalNoticeCard("✓ $it", PortalPalette.emerald600, dark) } }

        if (vm.loading && vm.profile == null && !vm.authExpired) {
            items(count = 4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        vm.profile?.let { profile ->
            item { GreetingCard(profile, vm, dark) { scope.launch { vm.load() } } }

            if (vm.isSystemOwner) {
                item { OwnerCard(dark) }
                // The owner is an employee here too (web parity 2026-07-11):
                // linked employee id → own full statement (web /portal/wallet).
                if (vm.employeeId != null) {
                    item {
                        Row(
                            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                                .plainClick { ctx.openWebForced("/portal/wallet", "Wallet statement") }
                                .padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "আমার বেতন-খাতা — সম্পূর্ণ হিসাব",
                                color = PortalPalette.coral, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier.weight(1f),
                            )
                            Text("›", color = PortalPalette.coral, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            } else {
                val s = vm.walletSummary
                if (s != null && s.outstandingAdvance > 0 && !vm.advanceNoticeAckedToday) {
                    item { AdvanceNoticeCard(s.outstandingAdvance, vm, dark) { scope.launch { vm.ackAdvanceNotice() } } }
                }
                item {
                    AttendanceCard(
                        vm, dark,
                        onOpenWeb = { p, t -> ctx.openWebForced(p, t) },
                        onAskException = { exceptionSheet = true },
                        onAppeal = { appealSheet = true },
                        onCancelWaiver = { id -> cancelWaiverId = id },
                    )
                }
                // Web page order: payout identity + expense-refund entry cards,
                // then the admin office-fund desk card.
                item {
                    EntryLinkCard(
                        "PAYOUT IDENTITY",
                        "bKash, Nagad, Rocket, or bank — used when wallet requests are approved.",
                        "Payment accounts", dark,
                    ) { ctx.openSmart("/portal/payment-accounts", "Payment accounts") }
                }
                item {
                    EntryLinkCard(
                        "নিজ খরচ ফেরত",
                        "নিজের পকেট থেকে অফিসের খরচ করেছেন? ফেরতের আবেদন করুন — মালিক অনুমোদন করলে ওয়ালেটে যোগ হবে।",
                        "খরচ ফেরত চান", dark,
                    ) { ctx.openSmart("/portal/expense", "Portal expense") }
                }
                if (isAdminRole) {
                    item {
                        EntryLinkCard(
                            "অফিস অ্যাডভান্স — হিসাব বাকি",
                            "অফিসের কাজে নেওয়া টাকার হিসাব দিন — কত খরচ হয়েছে আর কত ফেরত, তা জানান।",
                            "হিসাব দিন", dark,
                        ) { ctx.openSmart("/finance/office-fund", "Office fund") }
                    }
                }
                item { WalletCard(vm, dark) { walletSheet = true } }
                // Web MySalarySlipCard builds the PDF client-side — that stays a web escape.
                item {
                    EntryLinkCard(
                        "MY SALARY SLIP",
                        "মাসিক বেতন স্লিপ — হিসাবসহ PDF ডাউনলোড।",
                        "স্যালারি স্লিপ (PDF) — ওয়েবে খুলুন", dark,
                    ) { ctx.openWebForced("/portal", "My Desk") }
                }
                if (vm.mealEligibility?.enabled == true) {
                    item {
                        MealAllowanceCard(vm, dark, mealReason, onReason = { mealReason = it }) { confirmMeal = true }
                    }
                }
                if (vm.drivingStatus?.enabled == true) {
                    item {
                        DrivingModeCard(
                            vm, dark, drivingReason, onReason = { drivingReason = it },
                            onStart = { confirmDrivingStart = true },
                            onEnd = { confirmDrivingEnd = true },
                        )
                    }
                }
                if (vm.tasks.isNotEmpty()) {
                    item { TasksCard(vm, dark) { ctx.openWebForced("/portal", "My Desk") } }
                }
                item { LeaveCard(vm, dark) { leaveSheet = true } }
                item { WalletHistoryCard(vm, dark) { ctx.openWebForced("/portal/wallet", "Wallet statement") } }
                item { PendingRequestsCard(vm, dark) }
            }
        }

        item {
            Text(
                "ওয়েব ভার্সন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                textDecoration = TextDecoration.Underline, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/portal", "My Desk") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    // ── Sheets (native request forms — web modal parity) ──

    if (walletSheet) {
        ModalBottomSheet(onDismissRequest = { walletSheet = false }, containerColor = AlmaTheme.rootBg(dark)) {
            PortalWalletRequestSheet(
                availableWithdrawable = vm.walletSummary?.availableWithdrawable ?: 0,
                dark = dark,
            ) { type, amount, reason ->
                walletSheet = false
                scope.launch { vm.submitWalletRequest(type, amount, reason) }
            }
        }
    }
    if (leaveSheet) {
        ModalBottomSheet(onDismissRequest = { leaveSheet = false }, containerColor = AlmaTheme.rootBg(dark)) {
            PortalLeaveSheet(dark) { kind, start, end, sMin, eMin, reason ->
                leaveSheet = false
                scope.launch { vm.submitLeave(kind, start, end, sMin, eMin, reason) }
            }
        }
    }
    if (exceptionSheet) {
        ModalBottomSheet(onDismissRequest = { exceptionSheet = false }, containerColor = AlmaTheme.rootBg(dark)) {
            PortalExceptionSheet(dark) { exScope, reason ->
                exceptionSheet = false
                scope.launch { vm.submitException(exScope, reason) }
            }
        }
    }
    if (appealSheet) {
        ModalBottomSheet(onDismissRequest = { appealSheet = false }, containerColor = AlmaTheme.rootBg(dark)) {
            PortalAppealSheet(
                penaltyAmount = vm.attendanceToday?.penaltyAmount ?: 0,
                lateMinutes = vm.attendanceToday?.lateMinutes ?: 0,
                attendanceDate = vm.attendanceToday?.attendanceDate,
                dark = dark,
            ) { requestType, reason, partialAmount ->
                appealSheet = false
                vm.attendanceToday?.id?.let { recordId ->
                    scope.launch { vm.submitPenaltyAppeal(recordId, requestType, reason, partialAmount) }
                }
            }
        }
    }

    // ── Confirm dialogs (iOS confirmationDialog twins) ──

    if (confirmMeal) {
        val amount = vm.mealEligibility?.amountBdt ?: 0
        AlertDialog(
            onDismissRequest = { confirmMeal = false },
            title = { Text("খাবার ভাতা ${PortalFormat.money(amount)} রিকোয়েস্ট পাঠাবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmMeal = false
                    val r = mealReason.trim()
                    mealReason = ""
                    scope.launch { vm.submitMealRequest(r) }
                }) { Text("রিকোয়েস্ট পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirmMeal = false }) { Text("বাতিল") } },
        )
    }
    if (confirmDrivingStart) {
        AlertDialog(
            onDismissRequest = { confirmDrivingStart = false },
            title = { Text("ড্রাইভিং মোড শুরুর অনুরোধ মালিকের কাছে পাঠাবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDrivingStart = false
                    val r = drivingReason.trim()
                    drivingReason = ""
                    scope.launch { vm.startDrivingMode(r) }
                }) { Text("অনুরোধ পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirmDrivingStart = false }) { Text("বাতিল") } },
        )
    }
    if (confirmDrivingEnd) {
        AlertDialog(
            onDismissRequest = { confirmDrivingEnd = false },
            title = { Text("ড্রাইভিং মোড শেষ করবেন? অফিস ফলো-আপ আবার চালু হবে।") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDrivingEnd = false
                    scope.launch { vm.endDrivingMode() }
                }) { Text("হ্যাঁ, শেষ করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmDrivingEnd = false }) { Text("বাতিল") } },
        )
    }
    cancelWaiverId?.let { waiverId ->
        AlertDialog(
            onDismissRequest = { cancelWaiverId = null },
            title = { Text("রিভিউ অনুরোধ বাতিল করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    cancelWaiverId = null
                    scope.launch { vm.cancelPenaltyAppeal(waiverId) }
                }) { Text("হ্যাঁ, বাতিল করুন") }
            },
            dismissButton = { TextButton(onClick = { cancelWaiverId = null }) { Text("না") } },
        )
    }
}

// ── Greeting + account details (web ProfilePhotoSection + "Account details") ────────

@Composable
private fun GreetingCard(profile: PortalProfile, vm: PortalState, dark: Boolean, onRefresh: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier
                    .size(52.dp)
                    .background(PortalPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, PortalPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    PortalFormat.initials(profile.name),
                    color = PortalPalette.accentText(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("আসসালামু আলাইকুম 👋", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                Text(profile.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                val sub = listOfNotNull(
                    profile.roleTitle ?: profile.role?.replace("_", " "),
                    profile.shift?.let { "Shift: $it" },
                ).filter { it.isNotEmpty() }.joinToString(" · ")
                if (sub.isNotEmpty()) {
                    Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
            }
            if (vm.loading) {
                CircularProgressIndicator(Modifier.size(16.dp), color = PortalPalette.coral, strokeWidth = 2.dp)
            } else {
                Box(
                    Modifier.size(30.dp).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onRefresh),
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp) }
            }
        }
        HorizontalDivider(color = AlmaTheme.separator(dark))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            DetailLine("Email", profile.email ?: "—", dark, mono = true)
            DetailLine(
                "HR employee ID",
                if (vm.isSystemOwner) "System owner - not required"
                else (profile.employeeIdGas ?: "— link in Users"),
                dark, mono = true,
            )
            profile.businessAccess?.takeIf { it.isNotEmpty() }?.let {
                DetailLine("Business scope", it.replace(",", ", "), dark)
            }
            profile.salaryHint?.let {
                DetailLine("Salary hint", PortalFormat.money(it), dark, mono = true, tone = PortalPalette.accentText(dark))
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String, dark: Boolean, mono: Boolean = false, tone: Color? = null) {
    Row(verticalAlignment = Alignment.Top) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value,
            color = tone ?: AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            textAlign = TextAlign.End,
        )
    }
}

/** Web SystemOwnerCard parity — owner accounts skip the staff desk blocks. */
@Composable
private fun OwnerCard(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("SYSTEM OWNER MODE", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text("Owner control active", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(
            "Employee attendance, personal wallet requests, payroll linkage, and staff profile requirements are intentionally skipped for this account.",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
    }
}

// ── Advance-recovery notice (web AdvanceRecoveryNotice — exact Bangla) ──────────────

@Composable
private fun AdvanceNoticeCard(outstanding: Int, vm: PortalState, dark: Boolean, onAck: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .background(PortalPalette.amber500.copy(alpha = 0.10f), shape)
            .border(1.dp, PortalPalette.amber500.copy(alpha = 0.40f), shape)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("📩", fontSize = 17.sp)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("অগ্রিম বেতন নোটিশ", color = PortalPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Black)
            Text(
                "আপনি অগ্রিম (advance) বেতন নিয়েছেন — বাকি ${PortalFormat.money(outstanding)}।",
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
            )
            Text(
                "এই টাকা আপনার পরের মাসের বেতন থেকে অটোমেটিক কেটে নেওয়া হবে। পুরোটা শোধ না হওয়া পর্যন্ত এই নোটিশ প্রতিদিন একবার দেখাবে।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            val busy = "ack" in vm.busyActions
            Row(
                Modifier
                    .background(PortalPalette.amber500.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, PortalPalette.amber500.copy(alpha = 0.45f), CircleShape)
                    .plainClick { if (!busy) onAck() }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(11.dp), color = PortalPalette.amber600, strokeWidth = 1.5.dp)
                }
                Text(
                    if (busy) "অপেক্ষা করুন…" else "বুঝেছি",
                    color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Today attendance + monthly summary (web AttendanceCard read slice) ──────────────

@Composable
private fun AttendanceCard(
    vm: PortalState,
    dark: Boolean,
    onOpenWeb: (String, String) -> Unit,
    onAskException: () -> Unit,
    onAppeal: () -> Unit,
    onCancelWaiver: (String) -> Unit,
) {
    val today = vm.attendanceToday
    val summary = vm.attendanceSummary
    val linked = vm.employeeId != null && !vm.needsEmployeeLink

    // Native check-in (front-camera selfie) + check-out (GPS) — replaces the old web
    // escape (owner directive 2026-07-12: attendance must be fully native).
    val context = LocalContext.current
    val cardScope = rememberCoroutineScope()
    var showCheckIn by remember { mutableStateOf(false) }
    var checkingOut by remember { mutableStateOf(false) }
    var attendanceError by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("TODAY ATTENDANCE", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            when {
                today == null -> "Ready to start work"
                today.checkOutAt != null -> "Workday completed"
                else -> "Work is running"
            },
            color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
        )
        Text(
            "Office time: 9:00 AM - 9:00 PM. Late penalties sync to your wallet automatically.",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )

        if (!linked) {
            Text(
                "Ask an admin to link your HR employee ID before using attendance.",
                color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
        } else {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                StatTile("Check in", PortalFormat.time(today?.checkInAt) ?: "—", dark)
                StatTile("Check out", PortalFormat.time(today?.checkOutAt) ?: "—", dark)
                StatTile("Worked", PortalFormat.minutes(today?.totalWorkMinutes ?: 0), dark)
                StatTile(
                    "Late", PortalFormat.minutes(today?.lateMinutes ?: 0), dark,
                    tone = if ((today?.lateMinutes ?: 0) > 0) PortalPalette.red500 else PortalPalette.green400,
                )
                StatTile(
                    "Penalty", PortalFormat.money(today?.penaltyAmount ?: 0), dark,
                    tone = if ((today?.penaltyAmount ?: 0) > 0) PortalPalette.red500 else PortalPalette.green400,
                )
            }
            summary?.let { s ->
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatTile("Month present", "${s.presentDays} days", dark)
                    StatTile("Month late", "${s.lateCount} days", dark, tone = PortalPalette.amber600)
                    StatTile("Total penalties", PortalFormat.money(s.totalPenalties), dark, tone = PortalPalette.red500)
                    StatTile("Waived", PortalFormat.money(s.waivedPenalties), dark, tone = PortalPalette.green400)
                }
            }
            // Web PenaltyAppealStatus — shown when today carries a penalty.
            if (today != null && (today.penaltyAmount ?: 0) > 0) {
                PenaltyAppealBlock(today, vm, dark, onAppeal, onCancelWaiver)
            }
        }

        // Native selfie check-in / GPS check-out (camera + LocationManager).
        if (linked) {
            attendanceError?.let {
                Text(it, color = PortalPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            if (today == null) {
                Text(
                    "📸 চেক-ইন করুন (সেলফি + GPS)",
                    color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(PortalPalette.emerald600, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .plainClick { attendanceError = null; showCheckIn = true }
                        .padding(vertical = 13.dp),
                )
            } else if (today.checkOutAt == null) {
                Text(
                    if (checkingOut) "চেক-আউট হচ্ছে…" else "চেক-আউট করুন (GPS)",
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick {
                            if (checkingOut) return@plainClick
                            attendanceError = null
                            checkingOut = true
                            cardScope.launch {
                                val err = runAttendanceCheckOut(context, PORTAL_BUSINESS_ID)
                                checkingOut = false
                                if (err == null) vm.load() else attendanceError = err
                            }
                        }
                        .padding(vertical = 13.dp),
                )
            }
        }
        PortalLinkButton("ওয়েব ভার্সন", dark) { onOpenWeb("/portal", "My Desk") }

        // Web "Attendance exception" block — native form (plain text, no camera).
        if (linked && today != null && today.checkOutAt == null) {
            ExceptionBlock(vm, dark, onAskException)
        }
    }

    if (showCheckIn) {
        AttendanceCheckInSheet(
            businessId = PORTAL_BUSINESS_ID,
            dark = dark,
            onDismiss = { showCheckIn = false },
            onSuccess = { cardScope.launch { vm.load() } },
        )
    }
}

/** Web exception banner verbatim: APPROVED / PENDING states, else the ask-button. */
@Composable
private fun ExceptionBlock(vm: PortalState, dark: Boolean, onAsk: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(PortalPalette.amber500.copy(alpha = 0.10f), shape)
            .border(1.dp, PortalPalette.amber500.copy(alpha = 0.40f), shape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when (vm.exceptionStatus) {
            "APPROVED" -> Text(
                "✅ আজকের জন্য মালিক অনুমতি দিয়েছেন — নিয়ম মওকুফ, এখন স্বাভাবিকভাবে চেক-আউট করতে পারবেন।",
                color = PortalPalette.emerald600, fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
            "PENDING" -> Text(
                "⏳ আপনার অনুমতির অনুরোধ মালিকের অনুমোদনের অপেক্ষায় আছে।",
                color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
            else -> {
                Text(
                    "আগে বের হতে / মাঠের কাজ / দেরিতে আসা?",
                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
                Text(
                    "নিয়ম (সময়, লোকেশন, কাজ, জরিমানা) মওকুফ চাইলে মালিকের কাছে অনুমতি চান। অনুমোদন পেলে আজকের জন্য নিয়ম প্রযোজ্য হবে না।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
                val busy = "exception" in vm.busyActions
                Row(
                    Modifier
                        .background(PortalPalette.amber500.copy(alpha = 0.16f), CircleShape)
                        .border(1.dp, PortalPalette.amber500.copy(alpha = 0.45f), CircleShape)
                        .plainClick { if (!busy) onAsk() }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(11.dp), color = PortalPalette.amber600, strokeWidth = 1.5.dp)
                    }
                    Text(
                        if (busy) "পাঠানো হচ্ছে..." else "🙏 অনুমতি চাও",
                        color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

// ── Penalty appeal (web PenaltyAppealStatus — status + request/cancel) ──────────────

@Composable
private fun PenaltyAppealBlock(
    today: PortalAttendanceToday,
    vm: PortalState,
    dark: Boolean,
    onAppeal: () -> Unit,
    onCancelWaiver: (String) -> Unit,
) {
    val waivers = today.waiverRequests
    val active = waivers.firstOrNull { it.status == "PENDING" } ?: waivers.firstOrNull()
    val canRequest = waivers.none { it.status == "PENDING" }
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)

    Column(
        Modifier
            .fillMaxWidth()
            .background(PortalPalette.red500.copy(alpha = 0.06f), shape)
            .border(1.dp, PortalPalette.red500.copy(alpha = 0.25f), shape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("LATE PENALTY", color = PortalPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            PortalFormat.money(today.penaltyAmount ?: 0),
            color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            "Late by ${today.lateMinutes ?: 0} minutes · deducted from wallet",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )

        active?.let { w ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f), shape)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                val statusTone = PortalPalette.requestStatus(
                    if (w.effectiveStatus == "FULLY_APPROVED" || w.effectiveStatus == "PARTIALLY_APPROVED") "APPROVED"
                    else w.effectiveStatus,
                )
                Text(
                    "Review ${w.statusText}" +
                        (w.requestType?.let { " · ${it.replace("_", " ").lowercase()}" } ?: ""),
                    color = statusTone, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
                when (w.status) {
                    "PENDING" -> Text(
                        "Waiting for admin review. You asked to reduce ${PortalFormat.money(w.requestedReductionAmount ?: w.originalPenaltyAmount ?: 0)}.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                    "APPROVED", "PARTIALLY_APPROVED" -> Text(
                        "Approved reduction ${PortalFormat.money(w.approvedReductionAmount ?: 0)} · final penalty ${PortalFormat.money(w.finalAppliedPenalty ?: 0)}",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                    "REJECTED" -> Text(
                        "Request rejected — full penalty remains.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                }
                w.adminNote?.takeIf { it.isNotEmpty() }?.let {
                    Text("Admin: $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
                if (w.status == "PENDING") {
                    val busy = "cancelWaiver" in vm.busyActions
                    Row(
                        Modifier
                            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                            .border(1.dp, AlmaTheme.ink(dark).copy(alpha = 0.15f), CircleShape)
                            .plainClick { if (!busy) onCancelWaiver(w.id) }
                            .padding(horizontal = 12.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(10.dp), color = AlmaTheme.inkSecondary(dark), strokeWidth = 1.5.dp)
                        }
                        Text(
                            if (busy) "Cancelling…" else "রিকোয়েস্ট বাতিল করুন",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }

        if (canRequest && today.id != null) {
            val busy = "appeal" in vm.busyActions
            Row(
                Modifier
                    .background(PortalPalette.coral.copy(alpha = 0.13f), CircleShape)
                    .border(1.dp, PortalPalette.coral.copy(alpha = 0.35f), CircleShape)
                    .plainClick { if (!busy) onAppeal() }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(11.dp), color = PortalPalette.coral, strokeWidth = 1.5.dp)
                }
                Text(
                    if (busy) "পাঠানো হচ্ছে..." else "রিভিউ চান",
                    color = PortalPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Entry link cards (web "Payout identity" / "নিজ খরচ ফেরত" / office fund / slip) ──

@Composable
private fun EntryLinkCard(heading: String, desc: String, buttonLabel: String, dark: Boolean, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(heading, color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        PortalLinkButton(buttonLabel, dark, onOpen)
    }
}

// ── Meal allowance (web MealAllowanceCard — status + self-request) ──────────────────

@Composable
private fun MealAllowanceCard(
    vm: PortalState,
    dark: Boolean,
    reason: String,
    onReason: (String) -> Unit,
    onRequest: () -> Unit,
) {
    val e = vm.mealEligibility
    val amount = e?.amountBdt ?: 0
    val pendingStatus = e?.pendingStatus
    val displayAmount = e?.pendingAmount ?: amount
    val canRequest = e?.canRequestToday == true
    val reasonTrimmed = reason.trim()
    val busy = "meal" in vm.busyActions

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("MEAL ALLOWANCE", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                Text(
                    when {
                        canRequest -> "No kitchen today? Request your meal allowance."
                        pendingStatus == "APPROVED" -> "Meal allowance approved for today"
                        else -> "Request pending approval"
                    },
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            Text(
                when (pendingStatus) {
                    "PENDING" -> "PENDING ${PortalFormat.money(displayAmount)}"
                    "APPROVED" -> "APPROVED ${PortalFormat.money(displayAmount)}"
                    else -> PortalFormat.money(amount)
                },
                color = PortalPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(PortalPalette.coral.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, PortalPalette.goldDim.copy(alpha = 0.4f), CircleShape)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        if (canRequest) {
            if (vm.employeeId == null) {
                Text(
                    "Ask an admin to link your HR employee ID before requesting meal allowance.",
                    color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                )
            } else {
                OutlinedTextField(
                    value = reason,
                    onValueChange = onReason,
                    placeholder = { Text("e.g. No food arranged today") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                PortalActionCapsule(
                    if (busy) "Submitting…" else "Request ${PortalFormat.money(amount)} allowance",
                    dark, busy = busy, enabled = reasonTrimmed.isNotEmpty(), onClick = onRequest,
                )
                if (reasonTrimmed.isEmpty()) {
                    Text("Please add a short reason", color = PortalPalette.amber600, fontSize = 10.sp)
                }
            }
        } else {
            e?.reason?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
    }
}

// ── Driving mode (web DrivingModeCard — start/end with session state) ───────────────

@Composable
private fun DrivingModeCard(
    vm: PortalState,
    dark: Boolean,
    reason: String,
    onReason: (String) -> Unit,
    onStart: () -> Unit,
    onEnd: () -> Unit,
) {
    val st = vm.drivingStatus
    val active = st?.hasActiveSession == true
    val pending = st?.hasPendingSession == true
    val busy = "driving" in vm.busyActions

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("🚗 DRIVING MODE", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                Text(
                    when {
                        active -> "You are on the road — office follow-ups are paused."
                        pending -> "Driving mode request pending approval."
                        else -> "Going on the road? Start driving mode so the office pauses your follow-ups."
                    },
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            Text(
                if (active) "DRIVING" else if (pending) "PENDING" else "OFF",
                color = when {
                    active -> PortalPalette.green400
                    pending -> PortalPalette.amber600
                    else -> AlmaTheme.inkSecondary(dark)
                },
                fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(PortalPalette.coral.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, PortalPalette.goldDim.copy(alpha = 0.4f), CircleShape)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        when {
            active -> PortalActionCapsule(
                if (busy) "Ending…" else "End driving — back to work",
                dark, busy = busy, enabled = true, onClick = onEnd,
            )
            pending -> Text(
                st?.reason?.takeIf { it.isNotEmpty() } ?: "Waiting for the owner to approve.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
            st?.canStart == true -> {
                if (vm.employeeId == null) {
                    Text(
                        "Ask an admin to link your HR employee ID first.",
                        color = PortalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                } else {
                    OutlinedTextField(
                        value = reason,
                        onValueChange = onReason,
                        placeholder = { Text("e.g. Going for delivery / pickup (optional)") },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    PortalActionCapsule(
                        if (busy) "Submitting…" else "Start driving mode",
                        dark, busy = busy, enabled = true, onClick = onStart,
                    )
                }
            }
            else -> st?.reason?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
    }
}

// ── Employee wallet (web WalletOverviewCard — same stats, same tones) ───────────────

@Composable
private fun WalletCard(vm: PortalState, dark: Boolean, onRequest: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("EMPLOYEE WALLET", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        val s = vm.walletSummary
        when {
            s != null -> {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Current balance", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    Text(
                        PortalFormat.money(s.currentBalance),
                        color = PortalPalette.green400, fontSize = 22.sp, fontWeight = FontWeight.Black,
                        fontFamily = FontFamily.Monospace,
                    )
                    Text(
                        "তুলতে পারবেন সর্বোচ্চ ${PortalFormat.money(s.availableWithdrawable)}",
                        color = PortalPalette.goldLt, fontSize = 10.sp,
                    )
                }
                if (s.outstandingAdvance > 0) {
                    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(PortalPalette.amber500.copy(alpha = 0.10f), shape)
                            .border(1.dp, PortalPalette.amber500.copy(alpha = 0.40f), shape)
                            .padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            "বকেয়া অগ্রিম · পরের বেতন থেকে কাটা হবে",
                            color = PortalPalette.amber600, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                        )
                        Text(
                            PortalFormat.money(s.outstandingAdvance),
                            color = PortalPalette.amber600, fontSize = 14.sp, fontWeight = FontWeight.Black,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                // Web 2-col grid of the 8 stat tiles (light bento wash — owner spec 2026-07-08).
                val stats = listOf(
                    Triple("Salary earned", s.totalAccrued, null as Color?),
                    Triple("Commission", s.totalCommissions, PortalPalette.green400),
                    Triple("Eid bonus", s.totalEidBonuses, null),
                    Triple("Overtime", s.totalOvertime, null),
                    Triple("Penalties", s.totalPenalties, PortalPalette.red500),
                    Triple("Meal deductions", s.totalMealDeductions, PortalPalette.red500),
                    Triple("Advances", s.totalAdvances, PortalPalette.amber600),
                    Triple("Withdrawals", s.totalWithdrawals, AlmaTheme.inkSecondary(dark)),
                )
                stats.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { (label, value, tone) ->
                            WalletStat(label, value, dark, tone, Modifier.weight(1f))
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
            vm.employeeId == null -> Text(
                "Link your HR employee ID to view salary balance.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            else -> Text("Wallet not active", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        // Native wallet request form (the web WalletRequestCard, as a sheet).
        if (vm.employeeId != null) {
            val busy = "wallet" in vm.busyActions
            PortalActionCapsule(
                if (busy) "Sending…" else "টাকা তোলা / অগ্রিম রিকোয়েস্ট",
                dark, busy = busy, enabled = true, onClick = onRequest,
            )
        }
    }
}

/** Light bento pass: each wallet stat carries a soft diagonal wash of its own tone. */
@Composable
private fun WalletStat(label: String, value: Int, dark: Boolean, tone: Color?, modifier: Modifier) {
    val t = tone ?: AlmaTheme.ink(dark)
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        modifier
            .clip(shape)
            .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f))
            .background(
                Brush.linearGradient(listOf(t.copy(alpha = if (dark) 0.12f else 0.08f), Color.Transparent)),
            )
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.4f), shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
        Text(
            PortalFormat.money(value),
            color = t, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
        )
    }
}

// ── My tasks (operational-task assignments, priority status circles) ────────────────

@Composable
private fun TasksCard(vm: PortalState, dark: Boolean, onOpenWeb: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("আমার কাজ", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Spacer(Modifier.weight(1f))
            Text(
                "${vm.tasks.size}",
                color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(PortalPalette.coral.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
        vm.tasks.forEach { t ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier
                        .padding(top = 2.dp)
                        .size(14.dp)
                        .background(PortalPalette.priority(t.priority, dark).copy(alpha = 0.18f), CircleShape)
                        .border(2.dp, PortalPalette.priority(t.priority, dark), CircleShape),
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(t.title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    t.details?.takeIf { it.isNotEmpty() }?.let {
                        Text(
                            it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        t.assignedByName?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                        }
                        PortalFormat.dateTime(t.deadline)?.let {
                            Text("⏰ $it", color = PortalPalette.amber600, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                        }
                        t.status?.takeIf { it.isNotEmpty() }?.let {
                            Text(
                                it.replace("_", " "),
                                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier
                                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                                    .padding(horizontal = 5.dp, vertical = 1.5.dp),
                            )
                        }
                    }
                }
            }
        }
        // Acknowledge / complete flows run through the web task hero.
        PortalLinkButton("কাজ আপডেট করুন — ওয়েবে", dark, onOpenWeb)
    }
}

// ── Leave applications (web "ছুটির আবেদন" block — read list + native sheet) ──────────

@Composable
private fun LeaveCard(vm: PortalState, dark: Boolean, onApply: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("ছুটির আবেদন", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            "পুরো দিন, কয়েকদিন, কয়েক ঘণ্টা, বা দেরিতে শুরু — মালিক অনুমোদন করলে ঐ সময়ে কোনো জরিমানা হবে না।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )
        if (vm.leaves.isEmpty()) {
            Text("কোনো ছুটির আবেদন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        } else {
            vm.leaves.take(5).forEach { lv ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(
                            Color.White.copy(alpha = if (dark) 0.05f else 0.35f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(leaveLine(lv), color = AlmaTheme.ink(dark), fontSize = 10.sp, modifier = Modifier.weight(1f))
                    Text(
                        lv.statusLabelText,
                        color = PortalPalette.requestStatus(lv.status), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        // Native leave-apply form (the web requestLeave, as a sheet).
        if (vm.employeeId != null) {
            val busy = "leave" in vm.busyActions
            PortalActionCapsule(
                if (busy) "পাঠানো হচ্ছে..." else "🏖️ ছুটি চাও",
                dark, busy = busy, enabled = true, onClick = onApply,
            )
        }
    }
}

/** Web leave row: dates · kind label · clock suffix for HOURS / SHIFTED_START. */
private fun leaveLine(lv: PortalLeave): String {
    val start = (lv.startDate ?: "—").take(10)
    val end = (lv.endDate ?: lv.startDate ?: "—").take(10)
    var line = start
    if (end != start) line += " – $end"
    line += " · ${lv.kindLabel}"
    if (lv.kind == "HOURS" && lv.startMinutes != null && lv.endMinutes != null) {
        line += " (${PortalFormat.clock(lv.startMinutes)}–${PortalFormat.clock(lv.endMinutes)})"
    } else if (lv.kind == "SHIFTED_START" && lv.startMinutes != null) {
        line += " (${PortalFormat.clock(lv.startMinutes)} থেকে)"
    }
    return line
}

// ── Wallet transaction history (web card — same Bangla source labels) ───────────────

@Composable
private fun WalletHistoryCard(vm: PortalState, dark: Boolean, onStatement: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "WALLET TRANSACTION HISTORY",
                color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            )
            Spacer(Modifier.weight(1f))
            if (vm.employeeId != null) {
                Text(
                    "সম্পূর্ণ হিসাব →",
                    color = PortalPalette.coral, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.plainClick(onStatement),
                )
            }
        }
        when {
            vm.employeeId == null -> Text(
                "Link your HR employee ID (Users settings) to activate the payroll wallet.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            vm.walletEntries.isEmpty() -> Text(
                "No wallet entries yet. HR can run monthly salary accruals from Payroll.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            else -> {
                // Web shows newest first: entries.slice().reverse().
                vm.walletEntries.reversed().take(15).forEach { tx ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            (tx.date ?: "—").take(10),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        )
                        Text(
                            tx.label, color = AlmaTheme.ink(dark), fontSize = 10.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        )
                        Text(
                            (if (tx.signedAmount >= 0) "+" else "-") + PortalFormat.money(kotlin.math.abs(tx.signedAmount)),
                            color = if (tx.signedAmount >= 0) PortalPalette.green400 else PortalPalette.red500,
                            fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        )
                        Text(
                            PortalFormat.money(tx.runningBalance),
                            color = PortalPalette.goldLt, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}

// ── Pending wallet requests (web RequestList parity) ────────────────────────────────

@Composable
private fun PendingRequestsCard(vm: PortalState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("PENDING REQUESTS", color = PortalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        if (vm.walletRequests.isEmpty()) {
            Text("No wallet requests yet.", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        } else {
            vm.walletRequests.take(20).forEach { r ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        (r.createdAt ?: "—").take(10),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                    Text(
                        "${r.type.replace("_", " ")} · ${PortalFormat.money(r.requestedAmount)}",
                        color = AlmaTheme.ink(dark), fontSize = 10.sp, modifier = Modifier.weight(1f),
                    )
                    Text(
                        r.status.replace("_", " "),
                        color = PortalPalette.requestStatus(r.status), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun StatTile(label: String, value: String, dark: Boolean, tone: Color? = null) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        Modifier
            .widthIn(min = 64.dp)
            .clip(shape)
            .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f))
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.4f), shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
        Text(
            value,
            color = tone ?: AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

/** Coral capsule link (iOS portalLinkButton twin — trailing ↗). */
@Composable
private fun PortalLinkButton(label: String, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(PortalPalette.coral.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, PortalPalette.coral.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "$label ↗",
            color = PortalPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Coral capsule action button with an inline per-action spinner (no global overlay). */
@Composable
private fun PortalActionCapsule(label: String, dark: Boolean, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(PortalPalette.coral.copy(alpha = if (enabled) 0.13f else 0.07f), CircleShape)
            .border(1.dp, PortalPalette.coral.copy(alpha = if (enabled) 0.35f else 0.18f), CircleShape)
            .plainClick { if (enabled && !busy) onClick() }
            .padding(vertical = 9.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(12.dp), color = PortalPalette.coral, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(6.dp))
        }
        Text(
            label,
            color = if (enabled) PortalPalette.accentText(dark) else AlmaTheme.inkTertiary(dark),
            fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun PortalNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun PortalAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(PortalPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

/** One-tap radio row (the iOS largecircle.fill.circle rows). */
@Composable
private fun PortalRadioRow(label: String, hint: String?, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(15.dp)
                .border(
                    if (active) 4.5.dp else 1.5.dp,
                    if (active) PortalPalette.coral else AlmaTheme.inkSecondary(dark),
                    CircleShape,
                ),
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                label,
                color = AlmaTheme.ink(dark), fontSize = 13.sp,
                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
            )
            hint?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp) }
        }
    }
}

/** Solid coral submit bar shared by the sheets. */
@Composable
private fun PortalSubmitBar(label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (enabled) PortalPalette.coral else PortalPalette.coral.copy(alpha = 0.4f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .plainClick { if (enabled) onClick() }
            .padding(vertical = 11.dp),
    )
}

// ── Wallet request sheet (web WalletRequestCard parity) ─────────────────────────────

@Composable
private fun PortalWalletRequestSheet(
    availableWithdrawable: Int,
    dark: Boolean,
    onSubmit: (type: String, amount: Int, reason: String) -> Unit,
) {
    var type by remember { mutableStateOf("WITHDRAWAL") }
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }

    val amountValue = amount.trim().toIntOrNull() ?: 0
    val reasonTrimmed = reason.trim()
    val overCap = type == "WITHDRAWAL" && amountValue > availableWithdrawable
    val valid = amountValue > 0 && reasonTrimmed.isNotEmpty() && !overCap

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Wallet requests", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SheetTypeChip("Request withdrawal", type == "WITHDRAWAL", dark, Modifier.weight(1f)) { type = "WITHDRAWAL" }
            SheetTypeChip("Request advance", type == "ADVANCE", dark, Modifier.weight(1f)) { type = "ADVANCE" }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("AMOUNT (৳)", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it.filter { ch -> ch.isDigit() } },
                placeholder = { Text("0") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
            if (type == "WITHDRAWAL") {
                // Web cap hint / over-cap error — Bangla verbatim.
                Text(
                    if (overCap)
                        "আপনার ওয়ালেটে আছে ${PortalFormat.money(availableWithdrawable)} — এর বেশি টাকা তোলা যাবে না। বেশি দরকার হলে আগে অগ্রিম (advance) রিকোয়েস্ট পাঠান।"
                    else "তুলতে পারবেন সর্বোচ্চ ${PortalFormat.money(availableWithdrawable)}",
                    color = if (overCap) PortalPalette.red500 else AlmaTheme.inkSecondary(dark),
                    fontSize = 10.sp,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("REASON", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                placeholder = { Text("কারণ লিখুন") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            if (amountValue <= 0 || reasonTrimmed.isEmpty()) {
                Text("Amount and reason required", color = PortalPalette.amber600, fontSize = 10.sp)
            }
        }
        PortalSubmitBar("Submit request", valid) { confirm = true }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = {
                Text(
                    if (type == "WITHDRAWAL") "${PortalFormat.money(amountValue)} তোলার রিকোয়েস্ট পাঠাবেন?"
                    else "${PortalFormat.money(amountValue)} অগ্রিমের রিকোয়েস্ট পাঠাবেন?",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onSubmit(type, amountValue, reasonTrimmed)
                }) { Text("রিকোয়েস্ট পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun SheetTypeChip(label: String, active: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) PortalPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 12.sp,
        fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(
                if (active) PortalPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) PortalPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(vertical = 9.dp),
    )
}

// ── Leave application sheet (web requestLeave form parity) ──────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PortalLeaveSheet(
    dark: Boolean,
    onSubmit: (kind: String, start: String, end: String, startMin: Int?, endMin: Int?, reason: String) -> Unit,
) {
    // Web <select> options verbatim.
    val kinds = listOf(
        "FULL_DAY" to "একদিনের ছুটি",
        "DATE_RANGE" to "কয়েকদিনের ছুটি",
        "HOURS" to "কয়েক ঘণ্টার ছুটি",
        "SHIFTED_START" to "দেরিতে শুরু",
    )
    var kind by remember { mutableStateOf("FULL_DAY") }
    var startMs by remember { mutableStateOf(PortalFormat.todayUtcMidnight()) }
    var endMs by remember { mutableStateOf(PortalFormat.todayUtcMidnight()) }
    var startMinutes by remember { mutableStateOf(9 * 60) }
    var endMinutes by remember { mutableStateOf(12 * 60) }
    var reason by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }
    var pickStart by remember { mutableStateOf(false) }
    var pickEnd by remember { mutableStateOf(false) }
    var pickStartTime by remember { mutableStateOf(false) }
    var pickEndTime by remember { mutableStateOf(false) }

    val reasonTrimmed = reason.trim()
    val needsTimes = kind == "HOURS" || kind == "SHIFTED_START"
    val timesInvalid = kind == "HOURS" && endMinutes <= startMinutes
    val valid = reasonTrimmed.length >= 3 && !timesInvalid

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("ছুটির আবেদন", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "পুরো দিন, কয়েকদিন, কয়েক ঘণ্টা, বা দেরিতে শুরু — মালিক অনুমোদন করলে ঐ সময়ে কোনো জরিমানা হবে না।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            kinds.forEach { (value, label) ->
                PortalRadioRow(label, null, kind == value, dark) { kind = value }
            }
        }
        SheetPickRow("শুরুর তারিখ", PortalFormat.ymdUtc(startMs), dark) { pickStart = true }
        if (kind == "DATE_RANGE") {
            SheetPickRow("শেষ তারিখ", PortalFormat.ymdUtc(maxOf(endMs, startMs)), dark) { pickEnd = true }
        }
        if (needsTimes) {
            SheetPickRow(
                if (kind == "SHIFTED_START") "কখন শুরু করবেন" else "ছুটি শুরু",
                PortalFormat.clock(startMinutes), dark,
            ) { pickStartTime = true }
            if (kind == "HOURS") {
                SheetPickRow("ছুটি শেষ", PortalFormat.clock(endMinutes), dark) { pickEndTime = true }
                if (timesInvalid) {
                    Text("ছুটির শুরু ও শেষ সময় ঠিকভাবে দিন।", color = PortalPalette.red500, fontSize = 10.sp)
                }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                placeholder = { Text("ছুটির কারণ লিখুন") },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            if (reasonTrimmed.length < 3) {
                Text("ছুটির কারণ লিখুন (অন্তত ৩ অক্ষর)।", color = PortalPalette.amber600, fontSize = 10.sp)
            }
        }
        PortalSubmitBar("আবেদন পাঠান", valid) { confirm = true }
    }

    if (pickStart || pickEnd) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = if (pickStart) startMs else maxOf(endMs, startMs),
        )
        DatePickerDialog(
            onDismissRequest = { pickStart = false; pickEnd = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { picked ->
                        if (pickStart) startMs = picked else endMs = picked
                    }
                    pickStart = false
                    pickEnd = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = {
                TextButton(onClick = { pickStart = false; pickEnd = false }) { Text("বাতিল") }
            },
        ) {
            DatePicker(state = state, title = {
                Text(if (pickStart) "শুরুর তারিখ" else "শেষ তারিখ", modifier = Modifier.padding(16.dp))
            })
        }
    }
    if (pickStartTime || pickEndTime) {
        val initial = if (pickStartTime) startMinutes else endMinutes
        val state = rememberTimePickerState(
            initialHour = initial / 60, initialMinute = initial % 60, is24Hour = false,
        )
        AlertDialog(
            onDismissRequest = { pickStartTime = false; pickEndTime = false },
            confirmButton = {
                TextButton(onClick = {
                    val minutes = state.hour * 60 + state.minute
                    if (pickStartTime) startMinutes = minutes else endMinutes = minutes
                    pickStartTime = false
                    pickEndTime = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = {
                TextButton(onClick = { pickStartTime = false; pickEndTime = false }) { Text("বাতিল") }
            },
            text = { TimePicker(state = state) },
        )
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("ছুটির আবেদন মালিকের কাছে পাঠাবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    val start = PortalFormat.ymdUtc(startMs)
                    // Web: end_date = DATE_RANGE ? (end || start) : start.
                    val end = if (kind == "DATE_RANGE") PortalFormat.ymdUtc(maxOf(endMs, startMs)) else start
                    onSubmit(
                        kind, start, end,
                        if (needsTimes) startMinutes else null,
                        if (kind == "HOURS") endMinutes else null,
                        reasonTrimmed,
                    )
                }) { Text("আবেদন পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("বাতিল") } },
        )
    }
}

/** Label + value row that opens a picker (the iOS DatePicker rows). */
@Composable
private fun SheetPickRow(label: String, value: String, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value,
            color = PortalPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Checkout-exception sheet (web requestException form parity) ─────────────────────

@Composable
private fun PortalExceptionSheet(dark: Boolean, onSubmit: (scope: String, reason: String) -> Unit) {
    // Web radio options verbatim.
    val scopes = listOf(
        "EARLY_CHECKOUT" to "🚶 আগে বের হবো / মাঠের কাজ",
        "LATE_ARRIVAL" to "⏰ দেরিতে এসেছি / আসবো",
        "FULL_DAY" to "📅 সারাদিন সব নিয়ম মওকুফ",
    )
    var scope by remember { mutableStateOf("EARLY_CHECKOUT") }
    var reason by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }

    val reasonTrimmed = reason.trim()
    val valid = reasonTrimmed.length >= 3

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "আগে বের হতে / মাঠের কাজ / দেরিতে আসা?",
            color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
        )
        Text(
            "নিয়ম (সময়, লোকেশন, কাজ, জরিমানা) মওকুফ চাইলে মালিকের কাছে অনুমতি চান। অনুমোদন পেলে আজকের জন্য নিয়ম প্রযোজ্য হবে না।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("উদ্দেশ্য বেছে নিন:", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            scopes.forEach { (value, label) ->
                PortalRadioRow(label, null, scope == value, dark) { scope = value }
            }
            if (scope == "LATE_ARRIVAL") {
                Text(
                    "নোট: দেরিতে আসার অনুমতি দিয়ে আগে বের হওয়া যাবে না — সেজন্য আলাদা অনুমতি লাগবে।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                placeholder = { Text("কারণ লিখুন (যেমন: মাঠে ডেলিভারিতে যাচ্ছি / জরুরি কাজ)") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            if (!valid) {
                Text("সংক্ষেপে কারণ লিখুন (অন্তত ৩ অক্ষর)।", color = PortalPalette.amber600, fontSize = 10.sp)
            }
        }
        PortalSubmitBar("অনুমতি পাঠান", valid) { confirm = true }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("অনুমতির অনুরোধ মালিকের কাছে পাঠাবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onSubmit(scope, reasonTrimmed)
                }) { Text("অনুমতি পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("বাতিল") } },
        )
    }
}

// ── Penalty appeal sheet (web PenaltyAppealModal parity — attachment stays web) ─────

@Composable
private fun PortalAppealSheet(
    penaltyAmount: Int,
    lateMinutes: Int,
    attendanceDate: String?,
    dark: Boolean,
    onSubmit: (requestType: String, reason: String, partialAmount: Int?) -> Unit,
) {
    // Web REQUEST_TYPES verbatim (label + hint).
    val types = listOf(
        Triple("FULL_WAIVE", "Full waive", "Remove the entire penalty"),
        Triple("PARTIAL_REDUCE", "Partial reduction", "Ask to reduce part of the amount"),
        Triple("RECONSIDERATION", "Reconsideration", "Explain circumstances for review"),
    )
    var requestType by remember { mutableStateOf("FULL_WAIVE") }
    var reason by remember { mutableStateOf("") }
    var partialAmount by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }

    val reasonTrimmed = reason.trim()
    val partialValue = partialAmount.trim().toIntOrNull() ?: 0
    val partialInvalid = requestType == "PARTIAL_REDUCE" && (partialValue <= 0 || partialValue > penaltyAmount)
    val valid = reasonTrimmed.length >= 3 && !partialInvalid

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Penalty appeal", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Late ${lateMinutes}m · penalty ${PortalFormat.money(penaltyAmount)}" +
                (attendanceDate?.let { " · ${it.take(10)}" } ?: ""),
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            types.forEach { (value, label, hint) ->
                PortalRadioRow(label, hint, requestType == value, dark) { requestType = value }
            }
        }
        if (requestType == "PARTIAL_REDUCE") {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "AMOUNT TO REDUCE (MAX ${PortalFormat.money(penaltyAmount)})",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                OutlinedTextField(
                    value = partialAmount,
                    onValueChange = { partialAmount = it.filter { ch -> ch.isDigit() } },
                    placeholder = { Text("${penaltyAmount / 2}") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (partialInvalid) {
                    Text(
                        "১ থেকে ${PortalFormat.money(penaltyAmount)} এর মধ্যে দিন।",
                        color = PortalPalette.red500, fontSize = 10.sp,
                    )
                }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                placeholder = { Text("কেন রিভিউ চান, সংক্ষেপে লিখুন") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            if (reasonTrimmed.length < 3) {
                Text("কারণ লিখুন (অন্তত ৩ অক্ষর)।", color = PortalPalette.amber600, fontSize = 10.sp)
            }
        }
        // Proof-photo attach is a web-only extra (file picker + data URL).
        Text(
            "ছবি/প্রমাণ যোগ করতে চাইলে ওয়েব ভার্সনে আবেদন করুন।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
        )
        PortalSubmitBar("রিভিউ আবেদন পাঠান", valid) { confirm = true }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("জরিমানা রিভিউয়ের আবেদন মালিকের কাছে পাঠাবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onSubmit(requestType, reasonTrimmed, if (requestType == "PARTIAL_REDUCE") partialValue else null)
                }) { Text("আবেদন পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("বাতিল") } },
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object PortalFormat {
    /** Web money(): "৳ 12,345". */
    fun money(n: Int): String = "৳ " + String.format(Locale.US, "%,d", n)

    /** ISO timestamp → "9:05 AM" in Asia/Dhaka (web formatAttendanceTime). */
    fun time(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** ISO timestamp → short date+time in Asia/Dhaka (task deadlines). */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** Web minutesText: 125 → "2h 5m", 40 → "40m". */
    fun minutes(total: Int): String {
        val h = total / 60
        val m = total % 60
        return if (h == 0) "${m}m" else "${h}h ${m}m"
    }

    /** Minutes-since-midnight → "2:00 PM" (web minutesToClock). */
    fun clock(minutes: Int): String {
        val h = minutes / 60
        val mm = minutes % 60
        val ap = if (h >= 12) "PM" else "AM"
        val h12 = ((h + 11) % 12) + 1
        return "$h12:${String.format(Locale.US, "%02d", mm)} $ap"
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** UTC midnight for today's Dhaka date — DatePickerState millis live in UTC. */
    fun todayUtcMidnight(): Long {
        val d = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        d.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        val today = d.format(Date())
        val p = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        p.timeZone = TimeZone.getTimeZone("UTC")
        return try { p.parse(today)?.time ?: System.currentTimeMillis() } catch (e: Exception) {
            System.currentTimeMillis()
        }
    }

    /** DatePickerState millis (UTC midnight) → web <input type="date"> "yyyy-MM-dd". */
    fun ymdUtc(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(ms))
    }

    private fun parse(iso: String?): Date? {
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
