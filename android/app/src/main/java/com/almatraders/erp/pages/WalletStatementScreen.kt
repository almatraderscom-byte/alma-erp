//
//  WalletStatementScreen.kt
//  ALMA ERP — native "সম্পূর্ণ হিসাব" staff wallet transparency statement, ported 1:1
//  from WalletStatementSwiftUI.swift (build 66 / web /portal/wallet parity, PR #276).
//
//  API (owner-approved server work already on main):
//    GET  /api/payroll/wallet/{empId}?business_id=…[&from=YYYY-MM-DD&to=YYYY-MM-DD]
//         → entries (labelBn + per-fine `appeal` info) · fineSummaries
//           (last30Days / thisMonth / sinceJoining / customRange) · summary
//    POST /api/attendance/waivers   → staff files a penalty appeal
//         { attendance_record_id, business_id, reason, request_type }
//
//  Owner rules surfaced here:
//   • every fine shows WHY + its appeal state forever (none/pending/approved/
//     rejected+reason/expired), refunds are linked "সমন্বয়" rows;
//   • appeals allowed for 30 days from the fine date (server enforces too);
//   • totals for গত ৩০ দিন / এই মাস / শুরু থেকে / custom date range;
//   • appeals belong to the wallet's OWNER — admin/boss views pass
//     allowAppeal=false and see status chips only (owner rule 2026-07-11).
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Palette (exact hexes from the iOS WSPalette / web tokens) ───────────────────────

private object WsPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue500 = Color(0xFF3B82F6)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Formatting (WSFormat twins — Bangla digits, whole taka, Bangla dates) ───────────

private val WS_BN_DIGITS = mapOf(
    '0' to '০', '1' to '১', '2' to '২', '3' to '৩', '4' to '৪',
    '5' to '৫', '6' to '৬', '7' to '৭', '8' to '৮', '9' to '৯',
)

private val WS_BN_MONTHS = listOf(
    "জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
    "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর",
)

private object WsFormat {
    fun bnDigits(s: String): String = s.map { WS_BN_DIGITS[it] ?: it }.joinToString("")

    /** Whole-taka display — "৳ 1,234" (rounded, never floats shown). */
    fun money(n: Double): String = "৳ " + String.format("%,d", Math.round(n))

    fun moneyBn(n: Double): String = bnDigits(money(n))

    /** "2026-07-09…" → "৯ জুলাই ২০২৬" */
    fun dateBn(iso: String?): String {
        if (iso == null || iso.length < 10) return "—"
        val parts = iso.take(10).split("-").mapNotNull { it.toIntOrNull() }
        if (parts.size != 3 || parts[1] !in 1..12) return iso.take(10)
        return "${bnDigits(parts[2].toString())} ${WS_BN_MONTHS[parts[1] - 1]} ${bnDigits(parts[0].toString())}"
    }

    /** "2026-07" → "জুলাই ২০২৬" */
    fun periodBn(ym: String): String {
        val parts = ym.split("-").mapNotNull { it.toIntOrNull() }
        if (parts.size != 2 || parts[1] !in 1..12) return ym
        return "${WS_BN_MONTHS[parts[1] - 1]} ${bnDigits(parts[0].toString())}"
    }

    /** The web's <input type=date> value — local calendar day, Asia/Dhaka. */
    fun dayString(ms: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date(ms))
    }
}

// ── Models (same field names the web page's local types declare) ────────────────────

private data class WsAppealInfo(
    val status: String,            // NONE|PENDING|APPROVED|PARTIALLY_APPROVED|REJECTED|CANCELLED|EXPIRED
    val appealable: Boolean,
    val daysLeft: Int,
    val attendanceRecordId: String?,
    val refundedAmount: Double?,
    val adminNote: String?,
)

/** ADJUSTMENT sources that are fine refunds — the linked "সমন্বয়" rows. */
private val WS_FINE_REFUND_SOURCES = setOf(
    "attendance_late_penalty_reversal",
    "attendance_exception_refund",
    "attendance_reset_reversal",
)

private data class WsEntry(
    val id: String,
    val type: String,
    val source: String?,
    val note: String?,
    val date: String?,
    val createdAt: String?,
    val labelBn: String?,
    val signedAmount: Double,
    val runningBalance: Double,
    val appeal: WsAppealInfo?,
) {
    /** Booking date — when it actually happened (salary rows are DATED by period). */
    val bookingDate: String? get() = createdAt ?: date

    val isFineRefund: Boolean get() = type == "ADJUSTMENT" && (source ?: "") in WS_FINE_REFUND_SOURCES

    companion object {
        fun from(o: JSONObject): WsEntry {
            val appeal = o.optJSONObject("appeal")?.let {
                WsAppealInfo(
                    status = it.str("status") ?: "NONE",
                    appealable = it.flexBool("appealable") ?: false,
                    daysLeft = it.flexInt("daysLeft") ?: 0,
                    attendanceRecordId = it.str("attendanceRecordId"),
                    refundedAmount = it.flexDouble("refundedAmount"),
                    adminNote = it.str("adminNote"),
                )
            }
            return WsEntry(
                id = o.str("id") ?: UUID.randomUUID().toString(),
                type = o.str("type") ?: "—",
                source = o.str("source"),
                note = o.str("note"),
                date = o.str("date"),
                createdAt = o.str("createdAt"),
                labelBn = o.str("labelBn"),
                signedAmount = o.flexDouble("signedAmount") ?: 0.0,
                runningBalance = o.flexDouble("runningBalance") ?: 0.0,
                appeal = appeal,
            )
        }
    }
}

private data class WsFineWindow(
    val fineCount: Int,
    val fineTotal: Double,
    val refundCount: Int,
    val refundTotal: Double,
    val pendingAppeals: Int,
) {
    companion object {
        fun from(o: JSONObject?): WsFineWindow? {
            if (o == null) return null
            return WsFineWindow(
                fineCount = o.flexInt("fineCount") ?: 0,
                fineTotal = o.flexDouble("fineTotal") ?: 0.0,
                refundCount = o.flexInt("refundCount") ?: 0,
                refundTotal = o.flexDouble("refundTotal") ?: 0.0,
                pendingAppeals = o.flexInt("pendingAppeals") ?: 0,
            )
        }
    }
}

private data class WsResponse(
    val entries: List<WsEntry>,
    val appealWindowDays: Int?,
    val last30Days: WsFineWindow?,
    val thisMonth: WsFineWindow?,
    val sinceJoining: WsFineWindow?,
    val customRange: WsFineWindow?,
) {
    companion object {
        fun from(root: JSONObject): WsResponse {
            // The route answers flat today; tolerate an {ok,data:{…}} wrapper too.
            val c = root.optJSONObject("data") ?: root
            val fs = c.optJSONObject("fineSummaries")
            return WsResponse(
                entries = c.optJSONArray("entries")?.mapObjects { WsEntry.from(it) } ?: emptyList(),
                appealWindowDays = fs?.flexInt("appealWindowDays"),
                last30Days = WsFineWindow.from(fs?.optJSONObject("last30Days")),
                thisMonth = WsFineWindow.from(fs?.optJSONObject("thisMonth")),
                sinceJoining = WsFineWindow.from(fs?.optJSONObject("sinceJoining")),
                customRange = WsFineWindow.from(fs?.optJSONObject("customRange")),
            )
        }
    }
}

// ── State holder (WalletStatementVM twin) ───────────────────────────────────────────

private class WalletStatementState(val employeeId: String, val businessId: String) {
    var full by mutableStateOf<WsResponse?>(null)
    var custom by mutableStateOf<WsResponse?>(null)
    var preset by mutableStateOf("last30")   // last30 | month | all | custom
    var customFromMs by mutableStateOf(System.currentTimeMillis() - 30L * 24 * 3600 * 1000)
    var customToMs by mutableStateOf(System.currentTimeMillis())
    var loading by mutableStateOf(false)
    var customLoading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var visibleCount by mutableStateOf(40)
    var appealBusy by mutableStateOf(false)
    var authExpired by mutableStateOf(false)

    val activeEntries: List<WsEntry>
        get() = if (preset == "custom") custom?.entries ?: emptyList() else full?.entries ?: emptyList()

    val activeFineWindow: WsFineWindow?
        get() = when (preset) {
            "last30" -> full?.last30Days
            "month" -> full?.thisMonth
            "all" -> full?.sinceJoining
            else -> custom?.customRange
        }

    val currentBalance: Double get() = full?.entries?.lastOrNull()?.runningBalance ?: 0.0
    val appealWindowDays: Int get() = full?.appealWindowDays ?: 30

    suspend fun load() {
        loading = true
        error = null
        try {
            full = WsResponse.from(
                AlmaApi.getObject("/api/payroll/wallet/$employeeId", mapOf("business_id" to businessId)),
            )
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

    suspend fun loadCustom() {
        customLoading = true
        try {
            custom = WsResponse.from(
                AlmaApi.getObject(
                    "/api/payroll/wallet/$employeeId",
                    mapOf(
                        "business_id" to businessId,
                        "from" to WsFormat.dayString(customFromMs),
                        "to" to WsFormat.dayString(customToMs),
                    ),
                ),
            )
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        } finally {
            customLoading = false
        }
    }

    /** POST /api/attendance/waivers — exact web body. Returns true on success. */
    suspend fun submitAppeal(recordId: String, reason: String): Boolean {
        appealBusy = true
        return try {
            AlmaApi.send(
                "POST", "/api/attendance/waivers",
                JSONObject()
                    .put("attendance_record_id", recordId)
                    .put("business_id", businessId)
                    .put("reason", reason)
                    .put("request_type", "FULL_WAIVE"),
            )
            notice = "আপিল জমা হয়েছে — Boss দেখে সিদ্ধান্ত দেবেন।"
            load()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            false
        } finally {
            appealBusy = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

/**
 * Native wallet statement. Router use: `WalletStatementScreen(ctx)` needs the ids —
 * when opened without them (no route params yet) it falls back to the web page.
 * The Payroll boss view embeds it with `allowAppeal = false`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletStatementScreen(
    ctx: PushCtx,
    employeeId: String = "",
    businessId: String = "ALMA_LIFESTYLE",
    allowAppeal: Boolean = true,
    onClose: (() -> Unit)? = null,
) {
    val dark = AlmaTheme.isDark

    if (employeeId.isEmpty()) {
        // No employee context (route opened bare) — web escape, never a broken call.
        Column(
            Modifier.fillMaxSize().padding(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("সম্পূর্ণ হিসাব", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(
                    "কর্মচারী নির্ধারণ করা যায়নি — ওয়েব ভার্সন খুলুন।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                )
                Text(
                    "🌐 ওয়েবে খুলুন",
                    color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(WsPalette.coral, CircleShape)
                        .plainClick { ctx.openWebForced("/portal/wallet", "Wallet") }
                        .padding(horizontal = 18.dp, vertical = 9.dp),
                )
            }
        }
        return
    }

    val vm = remember(employeeId, businessId) { WalletStatementState(employeeId, businessId) }
    val scope = rememberCoroutineScope()
    var appealTarget by remember { mutableStateOf<WsEntry?>(null) }
    var pickingFrom by remember { mutableStateOf(false) }
    var pickingTo by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    // Newest-first, paginated FIRST (visibleCount rows), then month-bucketed —
    // so "আরো দেখুন" extends the list (iOS monthGroups twin).
    val monthGroups = run {
        val limited = vm.activeEntries.reversed().take(vm.visibleCount)
        val order = ArrayList<String>()
        val map = HashMap<String, ArrayList<WsEntry>>()
        for (e in limited) {
            val ym = (e.bookingDate ?: "").take(7)
            if (map[ym] == null) { order.add(ym); map[ym] = ArrayList() }
            map[ym]?.add(e)
        }
        order.map { it to (map[it] ?: emptyList<WsEntry>()) }
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { WsHeader(dark, onClose) }
        if (vm.authExpired) {
            item { WsAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { WsNoticeRow(it, WsPalette.red500, dark) } }
        vm.notice?.let { item { WsNoticeRow(it, WsPalette.emerald600, dark) } }

        if (vm.loading && vm.full == null) {
            item {
                Box(
                    Modifier.fillMaxWidth().padding(vertical = 60.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(Modifier.size(22.dp), color = WsPalette.coral, strokeWidth = 2.dp) }
            }
        } else if (!vm.authExpired) {
            item { WsBalanceCard(vm, dark) }
            item {
                WsFineSummaryCard(
                    vm, dark,
                    onPreset = { p ->
                        vm.preset = p
                        if (p == "custom" && vm.custom == null) scope.launch { vm.loadCustom() }
                    },
                    onPickFrom = { pickingFrom = true },
                    onPickTo = { pickingTo = true },
                    onApply = { scope.launch { vm.loadCustom() } },
                )
            }
            item {
                WsStatementCard(vm, dark, monthGroups, allowAppeal,
                    onAppeal = { appealTarget = it },
                    onMore = { vm.visibleCount += 40 })
            }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
    }

    appealTarget?.let { entry ->
        ModalBottomSheet(onDismissRequest = { appealTarget = null }, containerColor = AlmaTheme.rootBg(dark)) {
            WsAppealSheet(entry, dark, busy = vm.appealBusy) { reason ->
                val rid = entry.appeal?.attendanceRecordId ?: return@WsAppealSheet
                scope.launch {
                    if (vm.submitAppeal(rid, reason)) appealTarget = null
                }
            }
        }
    }

    if (pickingFrom || pickingTo) {
        val initial = if (pickingFrom) vm.customFromMs else vm.customToMs
        val state = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { pickingFrom = false; pickingTo = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let {
                        if (pickingFrom) vm.customFromMs = it else vm.customToMs = it
                    }
                    pickingFrom = false; pickingTo = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = {
                TextButton(onClick = { pickingFrom = false; pickingTo = false }) { Text("বাতিল") }
            },
        ) {
            DatePicker(state = state, title = {
                Text(if (pickingFrom) "শুরু" else "শেষ", modifier = Modifier.padding(16.dp))
            })
        }
    }
}

// ── Header / hero ──────────────────────────────────────────────────────────────────

@Composable
private fun WsHeader(dark: Boolean, onClose: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("সম্পূর্ণ হিসাব", color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(
                "সব লেনদেন · জরিমানা ও আপিলের অবস্থা",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }
        Spacer(Modifier.weight(1f))
        if (onClose != null) {
            Box(
                Modifier.size(34.dp).almaGlass(dark, 17).plainClick(onClose),
                contentAlignment = Alignment.Center,
            ) { Text("✕", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun WsBalanceCard(vm: WalletStatementState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            "বর্তমান ব্যালেন্স",
            color = WsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
        )
        Text(
            WsFormat.moneyBn(vm.currentBalance),
            color = AlmaTheme.ink(dark), fontSize = 34.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Default,
        )
        Text(
            "মোট ${WsFormat.bnDigits((vm.full?.entries?.size ?: 0).toString())}টি লেনদেন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
    }
}

// ── Fine summary ───────────────────────────────────────────────────────────────────

@Composable
private fun WsFineSummaryCard(
    vm: WalletStatementState,
    dark: Boolean,
    onPreset: (String) -> Unit,
    onPickFrom: () -> Unit,
    onPickTo: () -> Unit,
    onApply: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "জরিমানা ও আপিল",
            color = WsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
        )

        // Preset picker (iOS segmented control → capsule chips).
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("last30" to "গত ৩০ দিন", "month" to "এই মাস", "all" to "শুরু থেকে", "custom" to "কাস্টম")
                .forEach { (key, label) ->
                    WsChip(label, vm.preset == key, dark) { onPreset(key) }
                }
        }

        if (vm.preset == "custom") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    WsDateButton("শুরু", WsFormat.dayString(vm.customFromMs), dark, Modifier.weight(1f), onPickFrom)
                    WsDateButton("শেষ", WsFormat.dayString(vm.customToMs), dark, Modifier.weight(1f), onPickTo)
                }
                if (vm.customLoading) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = WsPalette.coral, strokeWidth = 2.dp)
                    }
                } else {
                    Text(
                        "প্রয়োগ করুন",
                        color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(WsPalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .plainClick(onApply)
                            .padding(vertical = 9.dp),
                    )
                }
            }
        }

        val w = vm.activeFineWindow
        if (w != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WsFineStat(
                    "মোট জরিমানা", "${WsFormat.bnDigits(w.fineCount.toString())}টি",
                    WsFormat.moneyBn(w.fineTotal), WsPalette.red500, dark, Modifier.weight(1f),
                )
                WsStatDivider(dark)
                WsFineStat(
                    "আপিলে ফেরত", "${WsFormat.bnDigits(w.refundCount.toString())}টি",
                    WsFormat.moneyBn(w.refundTotal), WsPalette.emerald600, dark, Modifier.weight(1f),
                )
                WsStatDivider(dark)
                WsFineStat(
                    "আপিল অপেক্ষায়", "${WsFormat.bnDigits(w.pendingAppeals.toString())}টি",
                    null, WsPalette.amber600, dark, Modifier.weight(1f),
                )
                WsStatDivider(dark)
                WsFineStat(
                    "নিট খরচ", null,
                    WsFormat.moneyBn(w.fineTotal - w.refundTotal),
                    AlmaTheme.ink(dark), dark, Modifier.weight(1f),
                )
            }
        } else if (vm.preset == "custom") {
            Text(
                "তারিখ বেছে নিয়ে ‘প্রয়োগ করুন’ চাপুন।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }

        Text(
            "আপিলের সময়সীমা: জরিমানার দিন থেকে ${WsFormat.bnDigits(vm.appealWindowDays.toString())} দিন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
    }
}

@Composable
private fun WsStatDivider(dark: Boolean) {
    Box(Modifier.width(1.dp).height(34.dp).background(AlmaTheme.separator(dark)))
}

@Composable
private fun WsFineStat(
    label: String,
    count: String?,
    amount: String?,
    tone: Color,
    dark: Boolean,
    modifier: Modifier,
) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (count != null) {
            Text(count, color = tone, fontSize = 12.sp, fontWeight = FontWeight.Black)
        }
        if (amount != null) {
            Text(
                amount,
                color = if (count == null) tone else AlmaTheme.inkSecondary(dark),
                fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun WsDateButton(label: String, value: String, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onClick).padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
    }
}

// ── Statement ──────────────────────────────────────────────────────────────────────

@Composable
private fun WsStatementCard(
    vm: WalletStatementState,
    dark: Boolean,
    monthGroups: List<Pair<String, List<WsEntry>>>,
    allowAppeal: Boolean,
    onAppeal: (WsEntry) -> Unit,
    onMore: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        Text(
            "লেনদেনের বিস্তারিত বিবরণী",
            color = WsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            modifier = Modifier.padding(14.dp),
        )
        if (vm.activeEntries.isEmpty()) {
            Text(
                if (vm.preset == "custom") "এই রেঞ্জে কোনো লেনদেন নেই।" else "এখনো কোনো লেনদেন নেই।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 14.dp).padding(bottom = 14.dp),
            )
        } else {
            monthGroups.forEach { (ym, rows) ->
                Text(
                    WsFormat.periodBn(ym),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(AlmaTheme.fill(dark).copy(alpha = if (dark) 0.16f else 0.08f))
                        .padding(horizontal = 14.dp, vertical = 4.dp),
                )
                rows.forEach { e ->
                    WsEntryRow(e, vm, dark, allowAppeal, onAppeal)
                }
            }
            if (vm.activeEntries.size > vm.visibleCount) {
                Text(
                    "আরো দেখুন",
                    color = WsPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().plainClick(onMore).padding(vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun WsEntryRow(
    e: WsEntry,
    vm: WalletStatementState,
    dark: Boolean,
    allowAppeal: Boolean,
    onAppeal: (WsEntry) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = if (e.isFineRefund) 18.dp else 0.dp)   // refund rows indent under their fine
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WsEntryIcon(e)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    e.labelBn ?: e.type.replace("_", " "),
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                )
                e.note?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    WsFormat.dateBn(e.bookingDate),
                    color = AlmaTheme.inkTertiary(dark), fontSize = 10.sp,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "${if (e.signedAmount >= 0) "+" else "−"}${WsFormat.moneyBn(kotlin.math.abs(e.signedAmount))}",
                    color = if (e.signedAmount >= 0) WsPalette.green400 else WsPalette.red500,
                    fontSize = 13.sp, fontWeight = FontWeight.Bold,
                )
                Text(
                    "ব্যালেন্স ${WsFormat.moneyBn(e.runningBalance)}",
                    color = WsPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                )
            }
        }
        if (e.type == "PENALTY") {
            WsAppealChip(e, vm, dark, allowAppeal, onAppeal)
        }
    }
    Box(
        Modifier.fillMaxWidth().padding(start = 14.dp).height(0.5.dp)
            .background(AlmaTheme.separator(dark)),
    )
}

@Composable
private fun WsEntryIcon(e: WsEntry) {
    val (glyph, tone) = when {
        e.type == "PENALTY" -> "⚑" to WsPalette.red500
        e.isFineRefund -> "↩" to WsPalette.blue500
        e.signedAmount >= 0 -> "↓" to WsPalette.emerald600
        else -> "↑" to WsPalette.amber600
    }
    Box(
        Modifier
            .size(30.dp)
            .background(tone.copy(alpha = 0.12f), RoundedCornerShape(9.dp)),
        contentAlignment = Alignment.Center,
    ) { Text(glyph, color = tone, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun WsAppealChip(
    e: WsEntry,
    vm: WalletStatementState,
    dark: Boolean,
    allowAppeal: Boolean,
    onAppeal: (WsEntry) -> Unit,
) {
    val a = e.appeal ?: return
    when (a.status) {
        "PENDING" -> WsChipStatic("আপিল অপেক্ষায় — Boss দেখছেন", WsPalette.blue500)
        "APPROVED", "PARTIALLY_APPROVED" ->
            WsChipStatic("আপিল মঞ্জুর — ${WsFormat.moneyBn(a.refundedAmount ?: 0.0)} ফেরত", WsPalette.emerald600)
        "REJECTED" -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            WsChipStatic("আপিল নাকচ", WsPalette.red500)
            a.adminNote?.takeIf { it.isNotEmpty() }?.let {
                Text("কারণ: $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
        "EXPIRED" -> WsChipStatic(
            "আপিলের সময় শেষ — ${WsFormat.bnDigits(vm.appealWindowDays.toString())} দিন পেরিয়েছে",
            AlmaTheme.inkSecondary(dark),
        )
        else -> {
            if (a.appealable && a.attendanceRecordId != null) {
                if (allowAppeal) {
                    Text(
                        "আপিল করুন — আর ${WsFormat.bnDigits(a.daysLeft.toString())} দিন",
                        color = WsPalette.coral, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(WsPalette.coral.copy(alpha = 0.12f), CircleShape)
                            .border(1.dp, WsPalette.coral.copy(alpha = 0.5f), CircleShape)
                            .plainClick { onAppeal(e) }
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                } else {
                    WsChipStatic(
                        "আপিল হয়নি — স্টাফ চাইলে আর ${WsFormat.bnDigits(a.daysLeft.toString())} দিন করতে পারবে",
                        AlmaTheme.inkSecondary(dark),
                    )
                }
            }
        }
    }
}

@Composable
private fun WsChipStatic(text: String, tone: Color) {
    Text(
        text,
        color = tone, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tone.copy(alpha = 0.12f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun WsChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) WsPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) WsPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) WsPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun WsNoticeRow(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
            .padding(12.dp),
    )
}

@Composable
private fun WsAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(WsPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Appeal sheet ───────────────────────────────────────────────────────────────────

@Composable
private fun WsAppealSheet(entry: WsEntry, dark: Boolean, busy: Boolean, onSubmit: (String) -> Unit) {
    var reason by remember { mutableStateOf("") }
    val trimmed = reason.trim()

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("জরিমানার আপিল", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                entry.labelBn ?: "জরিমানা",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(
                "${WsFormat.dateBn(entry.date)} · ${WsFormat.moneyBn(kotlin.math.abs(entry.signedAmount))}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }
        Text(
            "কেন জরিমানাটা ভুল বা মাফযোগ্য — লিখুন:",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        OutlinedTextField(
            value = reason,
            onValueChange = { reason = it },
            placeholder = { Text("যেমন: অফিসের কাজে বাইরে ছিলাম…") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        if (busy) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = WsPalette.coral, strokeWidth = 2.dp)
            }
        } else {
            Text(
                "আপিল পাঠান",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (trimmed.length >= 3) WsPalette.coral else WsPalette.coral.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { if (trimmed.length >= 3) onSubmit(trimmed) }
                    .padding(vertical = 11.dp),
            )
        }
    }
}
