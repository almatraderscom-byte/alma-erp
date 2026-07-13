//
//  AttendanceScreen.kt
//  ALMA ERP — the Attendance dashboard, ported 1:1 from AttendanceSwiftUI.swift.
//
//  Mirrors the web /attendance page — same endpoints, same colours, FULL action parity:
//    GET    /api/attendance?business_id=ALL&date=YYYY-MM-DD    → dashboard bundle
//           (kpis · records · absentEmployees · pendingWaivers · selfieLogs · ranking ·
//            integrity)  — apiDataSuccess wrapper {ok, data:{…}}, unwrap both shapes
//    GET    /api/attendance/waivers/analytics                  → {ok, month, analytics:{…}} flat
//    PATCH  /api/attendance/waivers/{id}                       → appeal APPROVE/REJECT
//           {business_id, action, approved_reduction_amount?, admin_note}
//    POST   /api/attendance/{recordId}/verification-request    {business_id}
//    DELETE /api/attendance/{recordId}                         → attendance reset (SA)
//    PATCH  /api/attendance/selfies/{id}                       → selfie verdict
//           {business_id, action, attendance_record_id}
//  Native extras (iOS parity): chevron prev/next day + DatePicker dialog (the API's
//  `date` param drives the whole dashboard), status-dot initials rows, per-employee
//  detail sheet with the day's timeline. Selfie IMAGES render natively (signed URL via
//  Coil AsyncImage, data: URLs base64-decoded); TAKING selfies stays on the web.
//  Carried lessons: ONE per-section skeleton, never a global overlay; lenient parsing;
//  per-row spinners (busyIds), never a global one; Bangla confirm dialogs with the
//  staff name before every mutating call; reload after every action.
//

package com.almatraders.erp.pages

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Store
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Work
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object AttPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** Web trust pills: TRUSTED tone-green · WARNING tone-amber · else tone-red. */
    fun trust(s: String?): Color = when (s) {
        "TRUSTED" -> emerald600
        "WARNING" -> amber600
        else -> red500
    }

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web AttendanceDashboard type declares) ────────────

private data class AttKpis(
    val employeeCount: Int,
    val todayAttendance: Int,
    val absentEmployees: Int,
    val lateEmployees: Int,
    val todayPenaltyTotal: Int,
    val monthPenaltyTotal: Int,
    val attendanceRate: Int,
    val pendingWaivers: Int,
    val suspiciousAttendance: Int,
    val pendingVerifications: Int,
) {
    companion object {
        fun from(o: JSONObject) = AttKpis(
            employeeCount = o.flexInt("employeeCount") ?: 0,
            todayAttendance = o.flexInt("todayAttendance") ?: 0,
            absentEmployees = o.flexInt("absentEmployees") ?: 0,
            lateEmployees = o.flexInt("lateEmployees") ?: 0,
            todayPenaltyTotal = o.flexInt("todayPenaltyTotal") ?: 0,
            monthPenaltyTotal = o.flexInt("monthPenaltyTotal") ?: 0,
            attendanceRate = o.flexInt("attendanceRate") ?: 0,
            pendingWaivers = o.flexInt("pendingWaivers") ?: 0,
            suspiciousAttendance = o.flexInt("suspiciousAttendance") ?: 0,
            pendingVerifications = o.flexInt("pendingVerifications") ?: 0,
        )
    }
}

private data class AttRecord(
    val id: String,
    val businessId: String?,
    val employeeId: String?,
    val employeeName: String?,
    val checkInAt: String?,
    val checkOutAt: String?,
    val totalWorkMinutes: Int?,
    val lateMinutes: Int?,
    val penaltyAmount: Int?,
    val trustStatus: String?,
    val suspiciousReasons: List<String>,
    val verificationRequired: Boolean?,
    val selfieCount: Int?,
) {
    val isLate get() = (lateMinutes ?: 0) > 0
    val isCheckedOut get() = !checkOutAt.isNullOrEmpty()

    companion object {
        fun from(o: JSONObject): AttRecord? {
            val id = o.str("id") ?: return null
            val reasons = o.optJSONArray("suspiciousReasons")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            } ?: emptyList()
            return AttRecord(
                id = id,
                businessId = o.str("businessId"),
                employeeId = o.str("employeeId"),
                employeeName = o.str("employeeName"),
                checkInAt = o.str("checkInAt"),
                checkOutAt = o.str("checkOutAt"),
                totalWorkMinutes = o.flexInt("totalWorkMinutes"),
                lateMinutes = o.flexInt("lateMinutes"),
                penaltyAmount = o.flexInt("penaltyAmount"),
                trustStatus = o.str("trustStatus"),
                suspiciousReasons = reasons,
                verificationRequired = o.flexBool("verificationRequired"),
                selfieCount = o.flexInt("selfieCount"),
            )
        }
    }
}

private data class AttAbsentee(
    val id: String,
    val employeeId: String?,
    val name: String?,
) {
    companion object {
        fun from(o: JSONObject): AttAbsentee? {
            val id = o.str("id") ?: return null
            return AttAbsentee(id, o.str("employeeId"), o.str("name"))
        }
    }
}

private data class AttWaiver(
    val id: String,
    val businessId: String?,
    val employeeId: String?,
    val requesterName: String?,
    val requestType: String?,
    val originalPenaltyAmount: Int?,
    val requestedReductionAmount: Int?,
    val reason: String?,
    val hasAttachment: Boolean?,
    val createdAt: String?,
    val lateMinutes: Int?,
) {
    companion object {
        fun from(o: JSONObject): AttWaiver? {
            val id = o.str("id") ?: return null
            return AttWaiver(
                id = id,
                businessId = o.str("businessId"),
                employeeId = o.str("employeeId"),
                requesterName = o.str("requesterName"),
                requestType = o.str("requestType"),
                originalPenaltyAmount = o.flexInt("originalPenaltyAmount"),
                requestedReductionAmount = o.flexInt("requestedReductionAmount"),
                reason = o.str("reason"),
                hasAttachment = o.flexBool("hasAttachment"),
                createdAt = o.str("createdAt"),
                lateMinutes = o.flexInt("lateMinutes"),
            )
        }
    }
}

/** One selfie verification photo — `imageUrl` is a 1h-signed storage URL resolved
 *  server-side; legacy rows may inline a `data:image/…` payload instead. */
private data class AttSelfieLog(
    val id: String,
    val businessId: String?,
    val attendanceRecordId: String?,
    val employeeId: String?,
    val capturedAt: String?,
    val imageDataUrl: String?,
    val imageUrl: String?,
    val imageMissing: Boolean?,
    val reviewedAt: String?,
) {
    val isPending get() = reviewedAt.isNullOrEmpty()

    /** Same precedence the web uses: signed URL first, else inline data URL. */
    val displaySrc: String?
        get() {
            if (!imageUrl.isNullOrEmpty()) return imageUrl
            if (imageDataUrl != null && imageDataUrl.startsWith("data:image/")) return imageDataUrl
            return null
        }

    companion object {
        fun from(o: JSONObject): AttSelfieLog? {
            val id = o.str("id") ?: return null
            return AttSelfieLog(
                id = id,
                businessId = o.str("businessId"),
                attendanceRecordId = o.str("attendanceRecordId"),
                employeeId = o.str("employeeId"),
                capturedAt = o.str("capturedAt"),
                imageDataUrl = o.str("imageDataUrl"),
                imageUrl = o.str("imageUrl"),
                imageMissing = o.flexBool("imageMissing"),
                reviewedAt = o.str("reviewedAt"),
            )
        }
    }
}

/** One row of the web's "Repeat late penalties" analytics footer. */
private data class AttRepeatOffender(val employeeId: String, val penaltyTotal: Int)

/** Web "Penalty appeal analytics (this month)". */
private data class AttAnalytics(
    val totalPenalties: Int,
    val waivedAmount: Int,
    val netPenaltiesAfterWaivers: Int,
    val approvalRate: Int,
    val repeatOffenders: List<AttRepeatOffender>,
) {
    companion object {
        fun from(o: JSONObject) = AttAnalytics(
            totalPenalties = o.flexInt("totalPenalties") ?: 0,
            waivedAmount = o.flexInt("waivedAmount") ?: 0,
            netPenaltiesAfterWaivers = o.flexInt("netPenaltiesAfterWaivers") ?: 0,
            approvalRate = o.flexInt("approvalRate") ?: 0,
            repeatOffenders = o.optJSONArray("repeatOffenders")?.mapObjects { r ->
                r.str("employeeId")?.let { AttRepeatOffender(it, r.flexInt("penaltyTotal") ?: 0) }
            } ?: emptyList(),
        )
    }
}

// Integrity monitor (web AttendanceDashboard.integrity — SUPER_ADMIN audit block)

private data class AttIntegrityIssue(
    val kind: String,
    val businessId: String?,
    val employeeId: String?,
    val name: String?,
)

private data class AttCrossBizHint(val businessId: String, val todayCount: Int)

private data class AttIntegrity(
    val issueCount: Int,
    val issues: List<AttIntegrityIssue>,
    val crossBusinessHint: List<AttCrossBizHint>,
) {
    companion object {
        fun from(o: JSONObject) = AttIntegrity(
            issueCount = o.flexInt("issueCount") ?: 0,
            issues = o.optJSONArray("issues")?.mapObjects {
                AttIntegrityIssue(it.str("kind") ?: "issue", it.str("businessId"), it.str("employeeId"), it.str("name"))
            } ?: emptyList(),
            crossBusinessHint = o.optJSONArray("crossBusinessHint")?.mapObjects { h ->
                h.str("businessId")?.let { AttCrossBizHint(it, h.flexInt("todayCount") ?: 0) }
            } ?: emptyList(),
        )
    }
}

private data class AttRankRow(
    val employeeId: String?,
    val name: String?,
    val presentDays: Int?,
    val lateCount: Int?,
    val penaltyTotal: Int?,
    val averageWorkLabel: String?,
    val punctualityScore: Int?,
) {
    val key get() = "${employeeId ?: "?"}-${name ?: "?"}"

    companion object {
        fun from(o: JSONObject) = AttRankRow(
            employeeId = o.str("employeeId"),
            name = o.str("name"),
            presentDays = o.flexInt("presentDays"),
            lateCount = o.flexInt("lateCount"),
            penaltyTotal = o.flexInt("penaltyTotal"),
            averageWorkLabel = o.str("averageWorkLabel"),
            punctualityScore = o.flexInt("punctualityScore"),
        )
    }
}

// ── State holder (iOS AttendanceVM twin) ───────────────────────────────────────────

private class AttendanceState {
    var kpis by mutableStateOf<AttKpis?>(null)
    var records by mutableStateOf(listOf<AttRecord>())
    var absentees by mutableStateOf(listOf<AttAbsentee>())
    var waivers by mutableStateOf(listOf<AttWaiver>())
    var selfieLogs by mutableStateOf(listOf<AttSelfieLog>())
    var ranking by mutableStateOf(listOf<AttRankRow>())
    var analytics by mutableStateOf<AttAnalytics?>(null)
    var scopeAllBusinesses by mutableStateOf(false)
    var integrity by mutableStateOf<AttIntegrity?>(null)

    /** Web viewAllBusinesses (SUPER_ADMIN defaults to ALL) — drives `business_id`. */
    var viewAll by mutableStateOf(true)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)     // success line (the web's toast)
    var busyIds by mutableStateOf(setOf<String>())  // per-row spinners, never a global one
    var authExpired by mutableStateOf(false)

    /** Selected day (Dhaka business day) — drives the `date` query param. */
    var day by mutableStateOf(Date())

    val isToday get() = AttFormat.dayParam(day) == AttFormat.dayParam(Date())
    val pendingSelfies get() = selfieLogs.filter { it.isPending }

    suspend fun load() {
        loading = true
        error = null
        try {
            val root = AlmaApi.getObject(
                "/api/attendance",
                mapOf(
                    "business_id" to if (viewAll) "ALL" else "ALMA_LIFESTYLE",
                    "date" to AttFormat.dayParam(day),
                ),
            )
            // apiDataSuccess wrapper {ok, data:{…}} — unwrap both shapes.
            val c = root.optJSONObject("data") ?: root
            kpis = c.optJSONObject("kpis")?.let { AttKpis.from(it) }
            records = c.optJSONArray("records")?.mapObjects { AttRecord.from(it) } ?: emptyList()
            absentees = c.optJSONArray("absentEmployees")?.mapObjects { AttAbsentee.from(it) } ?: emptyList()
            waivers = c.optJSONArray("pendingWaivers")?.mapObjects { AttWaiver.from(it) } ?: emptyList()
            selfieLogs = c.optJSONArray("selfieLogs")?.mapObjects { AttSelfieLog.from(it) } ?: emptyList()
            ranking = c.optJSONArray("ranking")?.mapObjects { AttRankRow.from(it) } ?: emptyList()
            scopeAllBusinesses = c.flexBool("scopeAllBusinesses") ?: false
            integrity = c.optJSONObject("integrity")?.let { AttIntegrity.from(it) }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Web loadAnalytics() parity — best-effort, silent on failure.
     *  Route answers {ok, month, analytics:{…}} flat (no data wrapper). */
    suspend fun loadAnalytics() {
        analytics = try {
            val root = AlmaApi.getObject("/api/attendance/waivers/analytics")
            val c = root.optJSONObject("analytics")
                ?: root.optJSONObject("data")?.optJSONObject("analytics")
                ?: root
            AttAnalytics.from(c)
        } catch (e: Exception) {
            null
        }
    }

    // ── Admin actions (exact web endpoints/bodies; per-row spinner via busyIds) ──

    /** Web submitReview(): PATCH /api/attendance/waivers/{id}
     *  {business_id, action, approved_reduction_amount (APPROVE only), admin_note}. */
    suspend fun reviewWaiver(waiver: AttWaiver, approve: Boolean, amount: Int, note: String) {
        if (waiver.id in busyIds) return
        busyIds = busyIds + waiver.id
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("action", if (approve) "APPROVE" else "REJECT")
                .put("admin_note", note)
            waiver.businessId?.let { body.put("business_id", it) }
            if (approve) body.put("approved_reduction_amount", amount)
            AlmaApi.send("PATCH", "/api/attendance/waivers/${waiver.id}", body)
            notice = if (approve) "আপিল অনুমোদিত — ওয়ালেটে ক্রেডিট হয়েছে ✓"
            else "আপিল প্রত্যাখ্যান করা হয়েছে"
            waivers = waivers.filter { it.id != waiver.id }
            load()
            loadAnalytics()
        } catch (e: Exception) {
            error = attActionMessage(e)
        } finally {
            busyIds = busyIds - waiver.id
        }
    }

    /** Web requestVerification(): POST /api/attendance/{recordId}/verification-request
     *  {business_id} — flags the record; staff sees "Verify Face Now" on My Desk. */
    suspend fun requestVerification(record: AttRecord) {
        if (record.id in busyIds) return
        busyIds = busyIds + record.id
        notice = null
        error = null
        try {
            val body = JSONObject()
            record.businessId?.let { body.put("business_id", it) }
            AlmaApi.send("POST", "/api/attendance/${record.id}/verification-request", body)
            notice = "ভেরিফিকেশন চাওয়া হয়েছে — কর্মী My Desk-এ 'Verify Face Now' দেখবে"
            load()
        } catch (e: Exception) {
            error = attActionMessage(e)
        } finally {
            busyIds = busyIds - record.id
        }
    }

    /** Web resetAttendance(): DELETE /api/attendance/{recordId} (no body) — removes
     *  the day's record + reverses any late penalty; Super Admin only (server-gated). */
    suspend fun resetAttendance(record: AttRecord) {
        if (record.id in busyIds) return
        busyIds = busyIds + record.id
        notice = null
        error = null
        try {
            AlmaApi.send("DELETE", "/api/attendance/${record.id}")
            notice = "হাজিরা রিসেট হয়েছে — কর্মী আবার চেক-ইন করতে পারবে"
            records = records.filter { it.id != record.id }
            load()
            loadAnalytics()
        } catch (e: Exception) {
            error = attActionMessage(e)
        } finally {
            busyIds = busyIds - record.id
        }
    }

    /** Web reviewSelfie(): PATCH /api/attendance/selfies/{id}
     *  {business_id, action, attendance_record_id} — APPROVE → TRUSTED, REJECT → WARNING. */
    suspend fun reviewSelfie(log: AttSelfieLog, approve: Boolean) {
        if (log.id in busyIds) return
        busyIds = busyIds + log.id
        notice = null
        error = null
        try {
            val body = JSONObject().put("action", if (approve) "APPROVE" else "REJECT")
            log.businessId?.let { body.put("business_id", it) }
            log.attendanceRecordId?.let { body.put("attendance_record_id", it) }
            AlmaApi.send("PATCH", "/api/attendance/selfies/${log.id}", body)
            notice = if (approve) "ভেরিফিকেশন অনুমোদিত ✓" else "ভেরিফিকেশন প্রত্যাখ্যান করা হয়েছে"
            load()
        } catch (e: Exception) {
            error = attActionMessage(e)
        } finally {
            busyIds = busyIds - log.id
        }
    }

    /** Move the selected day by ±1 (Dhaka calendar); never past today. */
    fun shiftDay(delta: Int) {
        val cal = Calendar.getInstance(AttFormat.dhaka)
        cal.time = day
        cal.add(Calendar.DAY_OF_YEAR, delta)
        val next = cal.time
        if (AttFormat.dayParam(next) > AttFormat.dayParam(Date())) return
        day = next
    }
}

/** Prefer the server's own message (the web toasts it verbatim); fall back to a
 *  Bangla line for bare 403s and generic failures. */
private fun attActionMessage(e: Exception): String = when (e) {
    is AlmaApiException.Http -> {
        val serverMsg = runCatching {
            val raw = (e.message ?: "").substringAfter(": ", "")
            val o = JSONObject(raw)
            o.str("error") ?: o.optJSONObject("error")?.str("message") ?: o.str("message")
        }.getOrNull()
        when {
            !serverMsg.isNullOrEmpty() -> serverMsg
            e.status == 403 -> "অনুমতি নেই — শুধু Admin/Super Admin এই কাজ করতে পারে।"
            else -> "সার্ভার সমস্যা (${e.status}) — আবার চেষ্টা করুন।"
        }
    }
    else -> e.message ?: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

/** Which waiver the review sheet is editing, with the verdict pre-selected —
 *  mirrors the web's ReviewState (one modal, action baked in by the button pressed). */
private data class AttWaiverReviewTarget(val waiver: AttWaiver, val approve: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendanceScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AttendanceState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<AttRecord?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showIntegrity by remember { mutableStateOf(false) }   // web showIntegrity toggle
    // Action targets — each mutating call passes a Bangla confirm dialog first.
    var reviewing by remember { mutableStateOf<AttWaiverReviewTarget?>(null) }
    var resetTarget by remember { mutableStateOf<AttRecord?>(null) }
    var verifyTarget by remember { mutableStateOf<AttRecord?>(null) }
    var selfieTarget by remember { mutableStateOf<AttSelfieLog?>(null) }
    var selfieApprove by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        vm.load()
        vm.loadAnalytics()
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // ── Native date navigation (chevrons + tappable date → picker dialog) ──
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                AttChevron(Icons.Outlined.ChevronLeft, dark, disabled = false) {
                    vm.shiftDay(-1)
                    scope.launch { vm.load() }
                }
                Row(
                    Modifier
                        .weight(1f)
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { showDatePicker = true }
                        .padding(vertical = 9.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Outlined.CalendarMonth, contentDescription = null,
                        tint = AttPalette.accentText(dark), modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (vm.isToday) "আজ · ${AttFormat.dayLabel(vm.day)}" else AttFormat.dayLabel(vm.day),
                        color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                AttChevron(Icons.Outlined.ChevronRight, dark, disabled = vm.isToday) {
                    vm.shiftDay(1)
                    scope.launch { vm.load() }
                }
            }
        }

        // ── Header controls (web actions row: business scope · Integrity · My desk) ──
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AttControlChip(
                    if (vm.viewAll) "সব বিজনেস" else "Alma Lifestyle",
                    Icons.Outlined.Store, vm.viewAll, dark, Modifier.weight(1f),
                ) {
                    vm.viewAll = !vm.viewAll
                    scope.launch { vm.load() }
                }
                AttControlChip("Integrity", Icons.Outlined.VerifiedUser, showIntegrity, dark, Modifier.weight(1f)) {
                    showIntegrity = !showIntegrity
                }
                AttControlChip("My Desk", Icons.Outlined.Work, false, dark, Modifier.weight(1f)) {
                    ctx.openWebForced("/portal", "My Desk")
                }
            }
        }

        if (vm.authExpired) {
            item { AttAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { AttNoticeCard("⚠ $it", AttPalette.red500, dark) } }
        vm.notice?.let { item { AttNoticeCard("✓ $it", AttPalette.emerald600, dark) } }

        // ── Attendance Integrity Monitor (web amber card) ──
        if (showIntegrity) {
            vm.integrity?.let { integ ->
                item { AttIntegrityCard(integ, vm.scopeAllBusinesses, vm.viewAll, dark) }
            }
        }

        // ── Summary hero (web Present / Absent / Late — bento dark hero) ──
        item { AttBentoHero(vm.kpis) }

        // ── Secondary KPI strip (web KpiCard row, same labels/value colours) ──
        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AttKpiCard("TODAY PENALTIES", AttFormat.money(vm.kpis?.todayPenaltyTotal), AttPalette.red500, dark)
                AttKpiCard("MONTHLY ATTENDANCE", vm.kpis?.let { "${it.attendanceRate}%" } ?: "—", AlmaTheme.ink(dark), dark)
                AttKpiCard("MONTHLY PENALTIES", AttFormat.money(vm.kpis?.monthPenaltyTotal), AttPalette.red500, dark)
                AttKpiCard("PENDING REVIEWS", vm.kpis?.let { "${it.pendingWaivers}" } ?: "—", AttPalette.goldLt, dark)
                AttKpiCard("SECURITY FLAGS", vm.kpis?.let { "${it.suspiciousAttendance}" } ?: "—", AttPalette.amber500, dark)
                AttKpiCard("VERIFICATION DUE", vm.kpis?.let { "${it.pendingVerifications}" } ?: "—", AttPalette.amber500, dark)
                AttKpiCard("EMPLOYEE SCOPE", vm.kpis?.let { "${it.employeeCount}" } ?: "—", AlmaTheme.ink(dark), dark)
            }
        }

        // ── Penalty appeal analytics (web admin card, this month) ──
        vm.analytics?.let { a ->
            item { AttAnalyticsCard(a, dark) }
        }

        // ── Penalty review queue (native Approve/Reject — web submitReview parity) ──
        if (vm.waivers.isNotEmpty()) {
            item { AttSectionHeader("Penalty review queue", vm.waivers.size, dark) }
            items(vm.waivers, key = { "waiver-${it.id}" }) { w ->
                AttWaiverCard(
                    w, dark,
                    busy = w.id in vm.busyIds,
                    onApprove = { reviewing = AttWaiverReviewTarget(w, true) },
                    onReject = { reviewing = AttWaiverReviewTarget(w, false) },
                )
            }
        }

        // ── Attendance log (per-employee status-dot rows + Reset/Selfie admin actions) ──
        item { AttSectionHeader("Attendance log", vm.records.size, dark) }
        if (vm.loading && vm.records.isEmpty()) {
            items(4) { Box(Modifier.fillMaxWidth().height(84.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else if (vm.records.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                AttEmptyCard("কোনো চেক-ইন নেই", "কর্মীরা Start Work চাপলে এখানে দেখা যাবে।", dark)
            }
        } else {
            items(vm.records.take(60), key = { "rec-${it.id}" }) { rec ->
                AttRecordCard(
                    rec, dark,
                    showBusiness = vm.scopeAllBusinesses,
                    busy = rec.id in vm.busyIds,
                    onTap = { selected = rec },
                    onReset = { resetTarget = rec },
                    onVerify = { verifyTarget = rec },
                )
            }
        }

        // ── Face verification reviews (web "Pending face verification reviews") ──
        if (vm.pendingSelfies.isNotEmpty()) {
            item { AttSectionHeader("Face verification — pending", vm.pendingSelfies.size, dark) }
            items(vm.pendingSelfies, key = { "selfie-${it.id}" }) { log ->
                AttSelfieCard(
                    log, dark,
                    showBusiness = vm.scopeAllBusinesses,
                    busy = log.id in vm.busyIds,
                    onApprove = { selfieTarget = log; selfieApprove = true },
                    onReject = { selfieTarget = log; selfieApprove = false },
                )
            }
        }

        // ── Absent employees ──
        if (!vm.loading || vm.absentees.isNotEmpty()) {
            item { AttSectionHeader("Absent today", vm.absentees.size, dark) }
            if (vm.absentees.isEmpty()) {
                if (vm.error == null && !vm.authExpired && !vm.loading) {
                    item {
                        Text(
                            "আজ কেউ অনুপস্থিত নেই ✅",
                            color = AttPalette.emerald600, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                        )
                    }
                }
            } else {
                item { AttAbsentListCard(vm.absentees, dark) }
            }
        }

        // ── Selfie verification logs (reviewed) ──
        run {
            val reviewed = vm.selfieLogs.filter { !it.isPending }
            if (reviewed.isNotEmpty()) {
                item { AttSectionHeader("Selfie verification logs", reviewed.size, dark) }
                items(reviewed.take(12), key = { "log-${it.id}" }) { log ->
                    AttSelfieCard(log, dark, showBusiness = vm.scopeAllBusinesses, busy = false, onApprove = null, onReject = null)
                }
            }
        }

        // ── Punctuality ranking ──
        if (vm.ranking.isNotEmpty()) {
            item { AttSectionHeader("Punctuality ranking", null, dark) }
            item { AttRankingCard(vm.ranking, dark) }
        }

        // ── Web escape (every admin action is native now; this is just the exit) ──
        item {
            Row(
                Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/attendance", "Attendance") }
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Outlined.Language, contentDescription = null,
                    tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(5.dp))
                Text("ওয়েব ভার্সন", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    // ── Detail sheet (one employee's day timeline) ──
    selected?.let { rec ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            AttDetailSheet(rec, vm.day, dark) { p, t ->
                selected = null
                ctx.openWebForced(p, t)
            }
        }
    }

    // ── Waiver review sheet (web review modal parity — amount + admin note) ──
    reviewing?.let { target ->
        ModalBottomSheet(onDismissRequest = { reviewing = null }, containerColor = AlmaTheme.rootBg(dark)) {
            AttWaiverReviewSheet(target.waiver, target.approve, dark) { amount, note ->
                reviewing = null
                scope.launch { vm.reviewWaiver(target.waiver, target.approve, amount, note) }
            }
        }
    }

    // ── Date picker (Dhaka business days, no future) ──
    if (showDatePicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = vm.day.time)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    val ms = state.selectedDateMillis
                    showDatePicker = false
                    if (ms != null) {
                        val picked = Date(ms)
                        if (AttFormat.dayParam(picked) <= AttFormat.dayParam(Date())) {
                            vm.day = picked
                            scope.launch { vm.load() }
                        }
                    }
                }) { Text("এই দিনের হাজিরা দেখুন") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("বাতিল") } },
        ) {
            DatePicker(state = state, title = { Text("তারিখ বাছাই করুন", modifier = Modifier.padding(16.dp)) })
        }
    }

    // ── Bangla confirm dialogs before every mutating call (iOS confirmationDialog parity) ──
    resetTarget?.let { rec ->
        AlertDialog(
            onDismissRequest = { resetTarget = null },
            title = { Text("হাজিরা রিসেট") },
            text = { Text("${rec.employeeName ?: "কর্মী"}-এর এই দিনের হাজিরা মুছে যাবে — আবার চেক-ইন করতে পারবে, লেট পেনাল্টি (থাকলে) ফেরত যাবে।") },
            confirmButton = {
                TextButton(onClick = {
                    resetTarget = null
                    scope.launch { vm.resetAttendance(rec) }
                }) { Text("হ্যাঁ, রিসেট করুন", color = AttPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { resetTarget = null }) { Text("বাতিল") } },
        )
    }

    verifyTarget?.let { rec ->
        AlertDialog(
            onDismissRequest = { verifyTarget = null },
            title = { Text("সেলফি ভেরিফিকেশন") },
            text = { Text("${rec.employeeName ?: "কর্মী"}-কে সেলফি ভেরিফিকেশন করতে বলা হবে — সে My Desk-এ 'Verify Face Now' দেখবে।") },
            confirmButton = {
                TextButton(onClick = {
                    verifyTarget = null
                    scope.launch { vm.requestVerification(rec) }
                }) { Text("হ্যাঁ, ভেরিফিকেশন চান") }
            },
            dismissButton = { TextButton(onClick = { verifyTarget = null }) { Text("বাতিল") } },
        )
    }

    selfieTarget?.let { log ->
        AlertDialog(
            onDismissRequest = { selfieTarget = null },
            title = { Text("ভেরিফিকেশন রিভিউ") },
            text = {
                Text(
                    if (selfieApprove) "${log.employeeId ?: "কর্মী"}-এর সেলফি অনুমোদন হলে রেকর্ডটি TRUSTED হবে।"
                    else "${log.employeeId ?: "কর্মী"}-এর সেলফি প্রত্যাখ্যান হলে রেকর্ডটি WARNING হবে।",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    selfieTarget = null
                    scope.launch { vm.reviewSelfie(log, selfieApprove) }
                }) {
                    Text(
                        if (selfieApprove) "হ্যাঁ, অনুমোদন করুন" else "হ্যাঁ, প্রত্যাখ্যান করুন",
                        color = if (selfieApprove) AttPalette.emerald600 else AttPalette.red500,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { selfieTarget = null }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun AttChevron(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    dark: Boolean,
    disabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(width = 38.dp, height = 36.dp)
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick { if (!disabled) onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon, contentDescription = null,
            tint = if (disabled) AlmaTheme.inkSecondary(dark).copy(alpha = 0.4f) else AttPalette.accentText(dark),
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun AttControlChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    active: Boolean,
    dark: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val tint = if (active) AttPalette.coral else AlmaTheme.ink(dark)
    Row(
        modifier
            .background(tint.copy(alpha = if (active) 0.14f else 0.05f), CircleShape)
            .border(1.dp, tint.copy(alpha = if (active) 0.35f else 0.12f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon, contentDescription = null,
            tint = if (active) AttPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
            modifier = Modifier.size(13.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            label,
            color = if (active) AttPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
            fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun AttSectionHeader(title: String, count: Int?, dark: Boolean) {
    Row(
        Modifier.padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            title.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
        )
        if (count != null && count > 0) {
            Text(
                "$count",
                color = AttPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(AttPalette.coral.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 1.5.dp),
            )
        }
    }
}

@Composable
private fun AttNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun AttAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AttPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun AttEmptyCard(title: String, subtitle: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("👤", fontSize = 30.sp)
        Text(title, color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
        Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
    }
}

/** KPI tile — frosted glass + soft accent wash (iOS attBentoWash twin). */
@Composable
private fun AttKpiCard(label: String, value: String, tint: Color, dark: Boolean) {
    Column(
        Modifier
            .widthIn(min = 96.dp)
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(listOf(tint.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        Text(
            label,
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp,
        )
        Spacer(Modifier.height(3.dp))
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black)
    }
}

// ── Bento hero (present / absent / late — dark anchor in BOTH schemes) ─────────────

/** Count-up number: 0 → target on first frame (iOS AttCountUp twin, tween not spring). */
@Composable
private fun attCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    val v by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "attCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    return v
}

@Composable
private fun AttBentoHero(kpis: AttKpis?) {
    val heroShape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(heroShape)
            .background(Color(0xFF181528))   // deep indigo (Dashboard hero recipe)
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, AlmaTheme.coral.copy(alpha = 0.30f))))
            .border(1.dp, Color.White.copy(alpha = 0.16f), heroShape)
            .padding(16.dp),
    ) {
        Text(
            "আজ উপস্থিত · PRESENT",
            color = AttPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            kpis?.let { "${attCountUp(it.todayAttendance)}" } ?: "—",
            color = AttPalette.green400, fontSize = 40.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            if ((kpis?.absentEmployees ?: 0) == 0) "আজ কেউ অনুপস্থিত নেই" else "${kpis?.absentEmployees ?: 0} জন অনুপস্থিত",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            AttHeroStat(
                "ABSENT", kpis?.absentEmployees,
                tint = if ((kpis?.absentEmployees ?: 0) > 0) AttPalette.red500 else Color.White,
                sub = "অনুপস্থিত",
            )
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp)
                    .height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            AttHeroStat(
                "LATE", kpis?.lateEmployees,
                tint = if ((kpis?.lateEmployees ?: 0) > 0) AttPalette.amber500 else Color.White,
                sub = "দেরি",
            )
        }
    }
}

@Composable
private fun AttHeroStat(label: String, value: Int?, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label,
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(
            value?.let { "${attCountUp(it)}" } ?: "—",
            color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black,
        )
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Integrity monitor card (web amber card — issue count hero + rows + hint) ───────

@Composable
private fun AttIntegrityCard(integ: AttIntegrity, scopeAll: Boolean, viewAll: Boolean, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(AttPalette.amber500.copy(alpha = 0.10f), shape)
            .border(1.dp, AttPalette.amber500.copy(alpha = 0.35f), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "${integ.issueCount}",
                color = if (integ.issueCount > 0) AttPalette.amber600 else AttPalette.emerald600,
                fontSize = 26.sp, fontWeight = FontWeight.Black,
            )
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("Attendance Integrity Monitor", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Text(
                    "${if (scopeAll) "Viewing all businesses" else "Scoped to Alma Lifestyle"} · ${integ.issueCount} issue(s)",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }
        if (integ.crossBusinessHint.isNotEmpty() && !viewAll) {
            Text(
                "Activity today in other businesses: " +
                    integ.crossBusinessHint.joinToString(", ") { "${it.businessId} (${it.todayCount})" } +
                    " — সব বিজনেস চালু করে দেখুন।",
                color = AttPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            )
        }
        if (integ.issueCount > 0) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                integ.issues.take(12).forEach { row ->
                    val bits = mutableListOf(row.kind.replace("_", " "))
                    row.businessId?.takeIf { it.isNotEmpty() }?.let(bits::add)
                    row.employeeId?.takeIf { it.isNotEmpty() }?.let(bits::add)
                    row.name?.takeIf { it.isNotEmpty() }?.let(bits::add)
                    Text(
                        bits.joinToString(" · "),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        } else {
            Text(
                "কোনো সমস্যা পাওয়া যায়নি ✅",
                color = AttPalette.emerald600, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

// ── Penalty appeal analytics card ──────────────────────────────────────────────────

@Composable
private fun AttAnalyticsCard(a: AttAnalytics, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "PENALTY APPEAL ANALYTICS (THIS MONTH)",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AttAnalyticsStat("Total", AttFormat.money(a.totalPenalties), AttPalette.red500, dark, Modifier.weight(1f))
            AttAnalyticsStat("Waived", AttFormat.money(a.waivedAmount), AttPalette.emerald600, dark, Modifier.weight(1f))
            AttAnalyticsStat("Net", AttFormat.money(a.netPenaltiesAfterWaivers), AlmaTheme.ink(dark), dark, Modifier.weight(1f))
            AttAnalyticsStat("Approval", "${a.approvalRate}%", AttPalette.goldLt, dark, Modifier.weight(1f))
        }
        if (a.repeatOffenders.isNotEmpty()) {
            Text(
                "Repeat late penalties: " + a.repeatOffenders.take(4)
                    .joinToString(" · ") { "${it.employeeId} (${AttFormat.money(it.penaltyTotal)})" },
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun AttAnalyticsStat(label: String, value: String, tint: Color, dark: Boolean, modifier: Modifier = Modifier) {
    Column(
        modifier
            .background(AlmaTheme.ink(dark).copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 8.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Initials avatar with a status dot (present-green · late-amber · absent-red) ────

@Composable
private fun AttAvatar(name: String, dot: Color?, size: Int = 34, dark: Boolean) {
    Box {
        Box(
            Modifier
                .size(size.dp)
                .background(AttPalette.coral.copy(alpha = 0.16f), CircleShape)
                .border(1.dp, AttPalette.coral.copy(alpha = 0.35f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                AttFormat.initials(name),
                color = AttPalette.accentText(dark),
                fontSize = (size * 0.36).sp, fontWeight = FontWeight.Bold,
            )
        }
        if (dot != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size((size * 0.32).dp)
                    .background(dot, CircleShape)
                    .border(1.5.dp, AlmaTheme.rootBg(dark), CircleShape),
            )
        }
    }
}

// ── Record row card (one employee's day, web mobile-card parity) ───────────────────

@Composable
private fun AttRecordCard(
    record: AttRecord,
    dark: Boolean,
    showBusiness: Boolean,
    busy: Boolean,
    onTap: () -> Unit,
    onReset: () -> Unit,
    onVerify: () -> Unit,
) {
    val dotColor = if (record.isLate) AttPalette.amber500 else AttPalette.green400
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AttAvatar(record.employeeName ?: "?", dotColor, dark = dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    record.employeeName ?: "—",
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(
                        record.employeeId ?: "—",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                    if (showBusiness && record.businessId != null) {
                        Text(record.businessId.replace("_", " "), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    }
                }
            }
            // Trust pill (web parity)
            val trustTint = AttPalette.trust(record.trustStatus)
            Text(
                (record.trustStatus ?: "—").replace("_", " "),
                color = trustTint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(trustTint.copy(alpha = 0.12f), CircleShape)
                    .border(0.8.dp, trustTint.copy(alpha = 0.3f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 2.5.dp),
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AttTimeCell("In", AttFormat.time(record.checkInAt), AlmaTheme.ink(dark), null, dark, Modifier.weight(1f))
            AttTimeCell("Out", if (record.isCheckedOut) AttFormat.time(record.checkOutAt) else "--", AlmaTheme.ink(dark), null, dark, Modifier.weight(1f))
            val lateTint = if (record.isLate) AttPalette.red500 else AttPalette.emerald600
            AttTimeCell("Late", AttFormat.duration(record.lateMinutes ?: 0), lateTint, lateTint, dark, Modifier.weight(1f))
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Worked ${AttFormat.duration(record.totalWorkMinutes ?: 0)}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
            Spacer(Modifier.weight(1f))
            Text(
                AttFormat.money(record.penaltyAmount),
                color = if ((record.penaltyAmount ?: 0) > 0) AttPalette.red500 else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
        }

        // Web row actions: Reset (SA) + Selfie/Requested/Verified. ONE spinner per row.
        if (busy) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.size(15.dp), color = AttPalette.coral, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Processing…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AttActionChip("↺ রিসেট", AttPalette.red500, AttPalette.red500, Modifier.weight(1f), onReset)
                when {
                    (record.selfieCount ?: 0) > 0 ->
                        AttStatusChip("Verified ✓", AttPalette.emerald600, Modifier.weight(1f))
                    record.verificationRequired == true ->
                        AttStatusChip("Requested…", AttPalette.amber600, Modifier.weight(1f))
                    else ->
                        AttActionChip("সেলফি চান", AttPalette.coral, AttPalette.accentText(dark), Modifier.weight(1f), onVerify)
                }
            }
        }
    }
}

@Composable
private fun AttTimeCell(label: String, value: String, tint: Color, bg: Color?, dark: Boolean, modifier: Modifier = Modifier) {
    Column(
        modifier
            .background(
                (bg ?: AlmaTheme.ink(dark)).copy(alpha = if (bg == null) 0.05f else 0.10f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .padding(vertical = 7.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(value, color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

@Composable
private fun AttActionChip(label: String, tint: Color, text: Color, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 7.dp),
    )
}

@Composable
private fun AttStatusChip(label: String, tint: Color, modifier: Modifier) {
    Text(
        label,
        color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(tint.copy(alpha = 0.10f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.25f), CircleShape)
            .padding(vertical = 7.dp),
    )
}

// ── Waiver card (native Approve/Reject → review sheet, web queue-row parity) ───────

@Composable
private fun AttWaiverCard(
    waiver: AttWaiver,
    dark: Boolean,
    busy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AttAvatar(waiver.requesterName ?: "?", AttPalette.amber500, size = 30, dark = dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    "${waiver.requesterName ?: "—"} · ${waiver.employeeId ?: "—"}",
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    attWaiverMeta(waiver),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        waiver.reason?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (busy) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.size(15.dp), color = AttPalette.coral, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Processing…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AttActionChip("✕ Reject", AttPalette.red500, AttPalette.red500, Modifier.weight(1f), onReject)
                AttActionChip("✓ Approve", AttPalette.coral, AttPalette.accentText(dark), Modifier.weight(1f), onApprove)
            }
        }
    }
}

private fun attWaiverMeta(waiver: AttWaiver): String {
    val bits = mutableListOf<String>()
    waiver.lateMinutes?.let { bits.add("Late ${it}m") }
    waiver.requestType?.let { bits.add(it.replace("_", " ").lowercase()) }
    val asked = waiver.requestedReductionAmount ?: waiver.originalPenaltyAmount
    bits.add("asked ${AttFormat.money(asked)} of ${AttFormat.money(waiver.originalPenaltyAmount)}")
    if (waiver.hasAttachment == true) bits.add("📎")
    waiver.createdAt?.takeIf { it.length >= 10 }?.let { bits.add(it.take(10)) }
    return bits.joinToString(" · ")
}

// ── Waiver review sheet (web review modal parity — amount + admin note) ────────────

@Composable
private fun AttWaiverReviewSheet(
    waiver: AttWaiver,
    approve: Boolean,
    dark: Boolean,
    onConfirm: (amount: Int, note: String) -> Unit,
) {
    val original = waiver.originalPenaltyAmount ?: 0
    var amount by remember { mutableStateOf("${waiver.requestedReductionAmount ?: original}") }
    var note by remember { mutableStateOf("") }
    val amountValue = amount.trim().toIntOrNull() ?: 0
    // Web input constraints: min 1, max the original penalty.
    val amountValid = !approve || (amountValue in 1..original)

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            if (approve) "পেনাল্টি মওকুফ অনুমোদন" else "আপিল প্রত্যাখ্যান",
            color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
        )
        Text(
            "${waiver.requesterName ?: "—"} · ${waiver.employeeId ?: "—"} · আসল পেনাল্টি ${AttFormat.money(original)} · চেয়েছে ${AttFormat.money(waiver.requestedReductionAmount ?: original)}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        if (approve) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "অনুমোদিত মওকুফ (ওয়ালেট ক্রেডিট)",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                OutlinedTextField(
                    value = amount,
                    onValueChange = { amount = it.filter { ch -> ch.isDigit() } },
                    placeholder = { Text("৳") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    if (amountValid) "অনুমোদনের পর ফাইনাল পেনাল্টি: ${AttFormat.money(maxOf(0, original - amountValue))}"
                    else "১ থেকে ${AttFormat.money(original)}-এর মধ্যে দিন",
                    color = if (amountValid) AlmaTheme.inkSecondary(dark) else AttPalette.amber600,
                    fontSize = 10.sp,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("অ্যাডমিন নোট", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                placeholder = { Text("নোট (ঐচ্ছিক)") },
                minLines = 2, maxLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        val confirmTint = if (approve) AttPalette.coral else AttPalette.red500
        Text(
            if (approve) "অনুমোদন করুন" else "প্রত্যাখ্যান করুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    if (amountValid) confirmTint else confirmTint.copy(alpha = 0.4f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (amountValid) onConfirm(amountValue, note.trim()) }
                .padding(vertical = 11.dp),
        )
    }
}

// ── Selfie verification card (photo + verdict buttons / review status) ─────────────

@Composable
private fun AttSelfieCard(
    log: AttSelfieLog,
    dark: Boolean,
    showBusiness: Boolean,
    busy: Boolean,
    onApprove: (() -> Unit)?,      // null = read-only log row (already reviewed)
    onReject: (() -> Unit)?,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .then(if (log.isPending) Modifier.border(1.dp, AttPalette.amber500.copy(alpha = 0.35f), shape) else Modifier)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AttSelfiePhoto(log, dark)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                log.employeeId ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            Text(AttFormat.dateTime(log.capturedAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        if (showBusiness && log.businessId != null) {
            Text(log.businessId.replace("_", " "), color = AttPalette.amber600, fontSize = 10.sp)
        }
        if (log.isPending) {
            when {
                busy -> Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(15.dp), color = AttPalette.coral, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Processing…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
                onApprove != null && onReject != null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AttActionChip("✕ Reject", AttPalette.red500, AttPalette.red500, Modifier.weight(1f), onReject)
                    AttActionChip("✓ Approve", AttPalette.coral, AttPalette.accentText(dark), Modifier.weight(1f), onApprove)
                }
                else -> Text("Awaiting review", color = AttPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        } else {
            Text(
                "Reviewed ${AttFormat.dateTime(log.reviewedAt)}",
                color = AttPalette.emerald600, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/** The photo itself — signed https URL via Coil; legacy inline data: URLs are
 *  base64-decoded off the render path; missing storage refs show the web's fallback. */
@Composable
private fun AttSelfiePhoto(log: AttSelfieLog, dark: Boolean) {
    val src = log.displaySrc
    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .background(AlmaTheme.ink(dark).copy(alpha = 0.05f)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            log.imageMissing == true || src == null -> AttSelfieFallback(dark)
            src.startsWith("data:image/") -> {
                val bitmap by produceState<Bitmap?>(initialValue = null, src) {
                    value = withContext(Dispatchers.Default) { attDecodeDataUrl(src) }
                }
                val bmp = bitmap
                if (bmp != null) {
                    Image(
                        bmp.asImageBitmap(), contentDescription = null,
                        modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
                    )
                } else {
                    CircularProgressIndicator(Modifier.size(18.dp), color = AttPalette.coral, strokeWidth = 2.dp)
                }
            }
            else -> AsyncImage(
                model = src, contentDescription = null,
                modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
            )
        }
    }
}

/** Web VerificationPhoto fallback: "Photo unavailable" + re-verify hint. */
@Composable
private fun AttSelfieFallback(dark: Boolean) {
    Column(
        Modifier.padding(horizontal = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("🖼", fontSize = 20.sp)
        Text("ছবি পাওয়া যায়নি", color = AttPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        Text(
            "স্টোরেজ রেফারেন্স নেই/মেয়াদোত্তীর্ণ — দরকারে আবার ভেরিফাই করতে বলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, textAlign = TextAlign.Center,
        )
    }
}

private fun attDecodeDataUrl(src: String): Bitmap? {
    val comma = src.indexOf("base64,")
    if (comma < 0) return null
    return try {
        val bytes = Base64.decode(src.substring(comma + 7), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Exception) {
        null
    }
}

// ── Absent list + ranking (web list-card parity) ───────────────────────────────────

@Composable
private fun AttAbsentListCard(absentees: List<AttAbsentee>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        absentees.forEachIndexed { index, emp ->
            Row(
                Modifier.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AttAvatar(emp.name ?: "?", AttPalette.red500, size = 30, dark = dark)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(emp.name ?: "—", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        emp.employeeId ?: "unlinked",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                }
                Text(
                    "ABSENT",
                    color = AttPalette.red500, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(AttPalette.red500.copy(alpha = 0.12f), CircleShape)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
            if (index < absentees.size - 1) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.4f)))
            }
        }
    }
}

@Composable
private fun AttRankingCard(ranking: List<AttRankRow>, dark: Boolean) {
    val rows = ranking.take(20)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        rows.forEachIndexed { index, row ->
            Row(
                Modifier.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "${index + 1}",
                    color = if (index < 3) AttPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
                    fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.width(22.dp),
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        row.name ?: "—",
                        color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        attRankMeta(row),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "${row.punctualityScore ?: 0}%",
                    color = AttPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                )
            }
            if (index < rows.size - 1) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.4f)))
            }
        }
    }
}

private fun attRankMeta(row: AttRankRow): String {
    val bits = mutableListOf<String>()
    bits.add("${row.presentDays ?: 0} days")
    bits.add("${row.lateCount ?: 0} late")
    row.averageWorkLabel?.takeIf { it.isNotEmpty() }?.let { bits.add("avg $it") }
    row.penaltyTotal?.takeIf { it > 0 }?.let { bits.add("penalty ${AttFormat.money(it)}") }
    return bits.joinToString(" · ")
}

// ── Detail sheet (one employee's day timeline) ─────────────────────────────────────

@Composable
private fun AttDetailSheet(
    record: AttRecord,
    day: Date,
    dark: Boolean,
    openWeb: (path: String, title: String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AttAvatar(
                record.employeeName ?: "?",
                if (record.isLate) AttPalette.amber500 else AttPalette.green400,
                size = 44, dark = dark,
            )
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(record.employeeName ?: "—", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "${record.employeeId ?: "—"} · ${AttFormat.dayLabel(day)}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
        }

        // Timeline: check-in → (late) → check-out / still working.
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        ) {
            AttTimelineRow(
                emoji = "⬇️",
                tint = if (record.isLate) AttPalette.amber500 else AttPalette.emerald600,
                title = "চেক-ইন ${AttFormat.time(record.checkInAt)}",
                subtitle = if (record.isLate) "⏰ ${AttFormat.duration(record.lateMinutes ?: 0)} দেরি" else "সময়মতো",
                last = false, dark = dark,
            )
            AttTimelineRow(
                emoji = if (record.isCheckedOut) "⬆️" else "🕒",
                tint = if (record.isCheckedOut) AttPalette.emerald600 else AttPalette.goldLt,
                title = if (record.isCheckedOut) "চেক-আউট ${AttFormat.time(record.checkOutAt)}" else "এখনও কাজ চলছে",
                subtitle = "মোট কাজ ${AttFormat.duration(record.totalWorkMinutes ?: 0)}",
                last = true, dark = dark,
            )
        }

        // Info rows
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AttInfoRow(
                "Penalty", AttFormat.money(record.penaltyAmount),
                if ((record.penaltyAmount ?: 0) > 0) AttPalette.red500 else AlmaTheme.ink(dark), dark,
            )
            AttInfoRow(
                "Trust", (record.trustStatus ?: "—").replace("_", " "),
                AttPalette.trust(record.trustStatus), dark,
            )
            AttInfoRow(
                "Verification",
                when {
                    (record.selfieCount ?: 0) > 0 -> "Verified (${record.selfieCount} selfie)"
                    record.verificationRequired == true -> "Requested — awaiting selfie"
                    else -> "Not requested"
                },
                when {
                    (record.selfieCount ?: 0) > 0 -> AttPalette.emerald600
                    record.verificationRequired == true -> AttPalette.amber600
                    else -> AlmaTheme.inkSecondary(dark)
                },
                dark,
            )
            record.businessId?.let { AttInfoRow("Business", it.replace("_", " "), AlmaTheme.ink(dark), dark) }
        }

        // Security flags
        if (record.suspiciousReasons.isNotEmpty()) {
            val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(AttPalette.amber500.copy(alpha = 0.10f), shape)
                    .border(1.dp, AttPalette.amber500.copy(alpha = 0.30f), shape)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("SECURITY FLAGS", color = AttPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Black)
                record.suspiciousReasons.forEach { reason ->
                    Text("• ${reason.replace("_", " ")}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
            }
        }

        Text(
            "🌐 ওয়েব ভার্সন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/attendance", "Attendance") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun AttTimelineRow(emoji: String, tint: Color, title: String, subtitle: String, last: Boolean, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(24.dp)
                    .background(tint.copy(alpha = 0.15f), CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text(emoji, fontSize = 11.sp) }
            if (!last) {
                Box(
                    Modifier
                        .width(1.5.dp)
                        .height(26.dp)
                        .background(AlmaTheme.inkSecondary(dark).copy(alpha = 0.25f)),
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}

@Composable
private fun AttInfoRow(label: String, value: String, color: Color, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Formatting helpers (web util parity, Asia/Dhaka) ───────────────────────────────

private object AttFormat {
    val dhaka: TimeZone = TimeZone.getTimeZone("Asia/Dhaka")

    /** API `date` param — yyyy-MM-dd in the Dhaka business day. */
    fun dayParam(date: Date): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = dhaka
        return f.format(date)
    }

    /** Header label — "Sun, 6 Jul 2026". */
    fun dayLabel(date: Date): String {
        val f = SimpleDateFormat("EEE, d MMM yyyy", Locale.US)
        f.timeZone = dhaka
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

    /** ISO timestamp → "9:05 AM" (web toLocaleTimeString), Dhaka clock. */
    fun time(iso: String?): String {
        val date = parse(iso) ?: return "--"
        val f = SimpleDateFormat("h:mm a", Locale.US)
        f.timeZone = dhaka
        return f.format(date)
    }

    /** ISO timestamp → "5/7/26, 8:50 PM" (web toLocaleString), Dhaka. */
    fun dateTime(iso: String?): String {
        val date = parse(iso) ?: return "—"
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
        f.timeZone = dhaka
        return f.format(date)
    }

    /** Web duration(): "1h 5m" / "45m". */
    fun duration(minutes: Int): String {
        val h = minutes / 60
        val m = minutes % 60
        return if (h == 0) "${m}m" else "${h}h ${m}m"
    }

    /** Web money(): "৳ 1,200". */
    fun money(value: Int?): String = "৳ " + String.format(Locale.US, "%,d", value ?: 0)

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}
