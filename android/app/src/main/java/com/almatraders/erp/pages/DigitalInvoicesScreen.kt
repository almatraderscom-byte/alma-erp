//
//  DigitalInvoicesScreen.kt
//  ALMA ERP — the CDIT (Creative Digital IT) invoices page, ported 1:1 from
//  DigitalInvoicesSwiftUI.swift (web /digital/invoices parity).
//
//  Blocks: bento hero (invoiced total + Paid/Due split + paid-share bar) · 3 payment
//  stat tiles · "+ New Invoice" native form · date-range preset chips (client-side
//  Asia/Dhaka YMD compare) · status filter chips (server-side param) · invoice rows
//  (mono id · client · type + due · PaymentStatusBadge · amount · Paid/Due sublines)
//  · per-invoice actions sheet with native Record-payment.
//  Money is SENSITIVE — endpoints/bodies verbatim from the iOS/web page:
//    GET  /api/digital/invoices?business_id=CREATIVE_DIGITAL_IT&status=…  → { invoices }
//    POST /api/digital/invoices  {client_name, client_id, project_id, amount,
//         invoice_type, due_date, recurring_interval, notes, status:"Sent",
//         business_id:"CREATIVE_DIGITAL_IT"}                              → { ok, error? }
//    POST /api/digital/payments  {invoice_id, client_id, client_name, amount,
//         payment_method, payment_type:"income", business_id}             → { ok, error? }
//  Premium PDF (iOS: native generate + ShareLink) = WEB ESCAPE on Android — the PDF
//  preview/share flow stays on /digital/invoices (noted in the actions sheet).
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
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
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from the iOS/web tokens) ────────────────────────────────

private object DigitalInvoicesPalette {
    /** CDIT hero accent — the digital wing's blue (owner spec for /digital natives). */
    val cditBlue = Color(0xFF6B8FE0)
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val amber400 = Color(0xFFFBBF24)
    val emerald600 = Color(0xFF059669)
    val emerald400 = Color(0xFF34D399)
    val green400 = Color(0xFF4ADE80)
    val slate400 = Color(0xFF94A3B8)

    /** The web's accent-tinted text: gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web PaymentStatusBadge: Unpaid muted · Partial amber · Paid emerald
     *  (light mode drops to the 600 shades for contrast). */
    fun payment(s: String?, dark: Boolean): Color = when (s) {
        "Paid" -> if (dark) emerald400 else emerald600
        "Partial Paid" -> if (dark) amber400 else amber600
        else -> slate400                       // Unpaid / unknown = muted
    }

    /** Paid/Due sublines: web text-emerald-400 / text-amber-400. */
    fun paidLine(dark: Boolean): Color = if (dark) emerald400 else emerald600
    fun dueLine(dark: Boolean): Color = if (dark) amber400 else amber600
}

/** The web's status Select options, verbatim (server-side `status` param). */
private val INVOICE_STATUS_OPTIONS = listOf(
    "All" to "",
    "Unpaid" to "Unpaid",
    "Partial Paid" to "Partial Paid",
    "Paid" to "Paid",
    "Sent" to "Sent",
    "Draft" to "Draft",
)

/** Web payment-method options, verbatim. */
private val INVOICE_PAY_METHODS = listOf(
    "Bank Transfer", "bKash", "Nagad", "Cash", "PayPal", "Stripe", "Other",
)

// ── Model (same field names the web CditInvoice type declares — snake_case wire) ─────

private data class DigitalInvoiceRow(
    val id: String,
    val clientId: String?,
    val clientName: String,
    val projectId: String?,
    val invoiceType: String?,          // "one-time" | "recurring"
    val amount: Int?,
    val status: String?,               // Draft | Sent | Paid | Overdue | Cancelled | Partial Paid
    val dueDate: String?,
    val issuedDate: String?,
    val recurringInterval: String?,
    val notes: String?,
    val createdAt: String?,
    val totalPaid: Int?,
    val dueAmount: Int?,
    val paymentStatus: String?,        // Unpaid | Partial Paid | Paid
) {
    /** Web invoiceYmd(): (issued_date || created_at).slice(0, 10). */
    val ymd: String
        get() = ((issuedDate?.takeIf { it.isNotEmpty() } ?: createdAt) ?: "").take(10)

    companion object {
        /** Sheet-backfilled rows mix numbers/strings — decode defensively so ONE bad
         *  row can't kill the whole list (iOS flex decoder twin). */
        fun from(o: JSONObject): DigitalInvoiceRow = DigitalInvoiceRow(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            clientId = o.str("client_id"),
            clientName = o.str("client_name") ?: "—",
            projectId = o.str("project_id"),
            invoiceType = o.str("invoice_type"),
            amount = o.flexInt("amount"),
            status = o.str("status"),
            dueDate = o.str("due_date"),
            issuedDate = o.str("issued_date"),
            recurringInterval = o.str("recurring_interval"),
            notes = o.str("notes"),
            createdAt = o.str("created_at"),
            totalPaid = o.flexInt("total_paid"),
            dueAmount = o.flexInt("due_amount"),
            paymentStatus = o.str("payment_status"),
        )
    }
}

// ── Date-range presets (the web's DateRangeFilter, client-side YMD compare) ──────────

private enum class DigitalInvoicesRange(val label: String) {
    ALL("সব সময়"),
    TODAY("আজ"),
    WEEK("৭ দিন"),
    THIS_MONTH("এই মাস"),
    DAYS30("৩০ দিন");

    /** Start YMD in Asia/Dhaka (null = no lower bound). End is always today — the
     *  same `ymd >= start && ymd <= end` string compare the web's inRangeYmd does. */
    fun startYmd(): String? = when (this) {
        ALL -> null
        TODAY -> DigitalInvoicesFormat.ymd(Date())
        WEEK -> DigitalInvoicesFormat.ymdDaysAgo(6)
        THIS_MONTH -> DigitalInvoicesFormat.monthStartYmd()
        DAYS30 -> DigitalInvoicesFormat.ymdDaysAgo(29)
    }

    /** Web inRangeYmd parity: rows with a broken/missing date always pass. */
    fun contains(ymd: String): Boolean {
        val start = startYmd() ?: return true
        if (ymd.length < 10) return true
        return ymd >= start && ymd <= DigitalInvoicesFormat.ymd(Date())
    }
}

// ── Formatting helpers (web util parity — Asia/Dhaka, whole taka) ────────────────────

private object DigitalInvoicesFormat {
    private fun dhaka(): TimeZone = TimeZone.getTimeZone("Asia/Dhaka")

    /** Today (or any date) as an Asia/Dhaka YMD string — the ERP's timezone. */
    fun ymd(date: Date): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = dhaka()
        return f.format(date)
    }

    fun ymdDaysAgo(days: Int): String {
        val cal = Calendar.getInstance(dhaka())
        cal.add(Calendar.DAY_OF_YEAR, -days)
        return ymd(cal.time)
    }

    fun monthStartYmd(): String {
        val cal = Calendar.getInstance(dhaka())
        cal.set(Calendar.DAY_OF_MONTH, 1)
        return ymd(cal.time)
    }

    /** Material3 DatePicker hands back UTC-midnight millis — format in UTC. */
    fun utcYmd(millis: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(millis))
    }

    fun orDash(s: String?): String = if (s.isNullOrEmpty()) "—" else s

    /** Whole-taka amount from a typed string (iOS Int(Double(...)) twin). */
    fun parseTaka(s: String): Int =
        s.replace(",", "").trim().toDoubleOrNull()?.toInt() ?: 0
}

// ── State holder (iOS DigitalInvoicesVM twin) ────────────────────────────────────────

private class DigitalInvoicesState {
    var invoices by mutableStateOf(listOf<DigitalInvoiceRow>())
    var status by mutableStateOf("")   // "" (all) | Unpaid | Partial Paid | Paid | Sent | Draft
    var range by mutableStateOf(DigitalInvoicesRange.ALL)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)

    /** Client-side date-range cut, same as the web's filteredInvoices useMemo. */
    val filtered: List<DigitalInvoiceRow>
        get() = invoices.filter { range.contains(it.ymd) }

    // Hero summary — computed from the filtered list (bento presentation of the
    // same numbers every web row shows).
    val totalAmount: Int get() = filtered.sumOf { it.amount ?: 0 }
    val totalPaid: Int get() = filtered.sumOf { it.totalPaid ?: 0 }
    val totalDue: Int get() = filtered.sumOf { it.dueAmount ?: 0 }
    fun paymentCount(s: String): Int = filtered.count { it.paymentStatus == s }

    /** Flat `{ invoices }` — tolerate an apiDataSuccess `{ ok, data:{…} }` wrap too. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/digital/invoices",
                    mapOf(
                        "business_id" to "CREATIVE_DIGITAL_IT",
                        "status" to status.ifEmpty { null },
                    ),
                )
            )
            invoices = c.optJSONArray("invoices")?.mapObjects { DigitalInvoiceRow.from(it) } ?: emptyList()
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

    // ── Native writes (owner 2026-07-11) — web page payloads verbatim. ──

    suspend fun createInvoice(
        clientName: String,
        clientId: String,
        projectId: String,
        amount: Int,
        invoiceType: String,
        dueDate: String,
        recurringInterval: String,
        notes: String,
    ): Boolean {
        val body = JSONObject()
            .put("client_name", clientName)
            .put("client_id", clientId)
            .put("project_id", projectId)
            .put("amount", amount)
            .put("invoice_type", invoiceType)
            .put("due_date", dueDate)
            .put("recurring_interval", recurringInterval)
            .put("notes", notes)
            .put("status", "Sent")
            .put("business_id", "CREATIVE_DIGITAL_IT")
        return write("/api/digital/invoices", body, "Invoice created")
    }

    suspend fun recordPayment(inv: DigitalInvoiceRow, amount: Int, method: String): Boolean {
        val body = JSONObject()
            .put("invoice_id", inv.id)
            .put("client_id", inv.clientId ?: "")
            .put("client_name", inv.clientName)
            .put("amount", amount)
            .put("payment_method", method)
            .put("payment_type", "income")
            .put("business_id", "CREATIVE_DIGITAL_IT")
        return write("/api/digital/payments", body, "Payment recorded")
    }

    private suspend fun write(path: String, body: JSONObject, success: String): Boolean {
        return try {
            val res = AlmaApi.send("POST", path, body)
            if (res.flexBool("ok") == true) {
                toast = success
                load()
                true
            } else {
                toast = res.str("error") ?: "সেভ হয়নি — আবার চেষ্টা করুন"
                false
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: Exception) {
            toast = e.message ?: "সেভ হয়নি — আবার চেষ্টা করুন"
            false
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DigitalInvoicesScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    RememberSession()
    val canManage = AlmaSession.canManageBusiness   // client-side role gate (fail-closed)
    val vm = remember { DigitalInvoicesState() }
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<DigitalInvoiceRow?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Toast auto-dismiss (iOS 2.6s parity).
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            delay(2_600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.authExpired) {
                item { InvoicesAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { InvoicesNoticeCard("⚠ $it", DigitalInvoicesPalette.red500, dark) } }

            item { InvoicesHeroBoard(vm, dark) }

            if (canManage) {
                item {
                    // Web header "+ New Invoice" — native form sheet (owner 2026-07-11).
                    // Admin-only write: hidden for non-admins (defense-in-depth).
                    Text(
                        "+ New Invoice",
                        color = DigitalInvoicesPalette.accentText(dark),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                DigitalInvoicesPalette.cditBlue.copy(alpha = 0.10f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .border(
                                1.dp,
                                DigitalInvoicesPalette.cditBlue.copy(alpha = 0.3f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .plainClick { showCreate = true }
                            .padding(vertical = 11.dp),
                    )
                }
            }

            item {
                // Date-range filter (web DateRangeFilter — native preset chips, client-side).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    DigitalInvoicesRange.entries.forEach { r ->
                        InvoicesChip(r.label, DigitalInvoicesPalette.cditBlue, vm.range == r, dark) {
                            vm.range = r          // client-side cut — no reload needed
                        }
                    }
                }
            }

            item {
                // Status filter (the web's Select — server-side `status` param) + refresh.
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    INVOICE_STATUS_OPTIONS.forEach { (label, value) ->
                        val tint = when {
                            value.isEmpty() || value == "Sent" || value == "Draft" ->
                                if (value.isEmpty()) DigitalInvoicesPalette.cditBlue
                                else DigitalInvoicesPalette.slate400
                            else -> DigitalInvoicesPalette.payment(value, dark)
                        }
                        InvoicesChip(label, tint, vm.status == value, dark) {
                            vm.status = value
                            scope.launch { vm.load() }
                        }
                    }
                    Box(
                        Modifier.size(30.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { scope.launch { vm.load() } },
                        contentAlignment = Alignment.Center,
                    ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp) }
                }
            }

            if (vm.loading && vm.invoices.isEmpty()) {
                items(5) {
                    Box(Modifier.fillMaxWidth().height(84.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
                }
            }

            items(vm.filtered, key = { it.id }) { inv ->
                DigitalInvoiceCard(inv, dark) { selected = inv }
            }

            if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    // Web Empty parity: ◈ · "No invoices in range".
                    Column(
                        Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("◈", color = AlmaTheme.inkSecondary(dark), fontSize = 34.sp)
                        Text(
                            "No invoices in range",
                            color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "তারিখ বদলান, অথবা ওয়েবে নতুন ইনভয়েস তৈরি করুন",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        )
                    }
                }
            }

            item {
                // Mutations + premium PDF stay on the web — the page's escape hatch.
                Text(
                    "🌐 নতুন ইনভয়েস / পেমেন্ট / PDF — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/digital/invoices", "CDIT Invoices") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }
        }

        // Bottom toast (iOS capsule overlay parity).
        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 20)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    if (showCreate && canManage) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalInvoiceCreateSheet(vm, dark) { showCreate = false }
        }
    }

    selected?.let { inv ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalInvoiceActionsSheet(
                inv, vm, dark,
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
                onDone = { selected = null },
            )
        }
    }
}

// ── Hero board — bento language (dark anchor + paid-share bar + stat tiles) ──────────

@Composable
private fun InvoicesHeroBoard(vm: DigitalInvoicesState, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 4.dp)) {
        InvoicesHeroCard(
            amount = vm.totalAmount,
            count = vm.filtered.size,
            paid = vm.totalPaid,
            due = vm.totalDue,
            rangeLabel = vm.range.label,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            InvoicesStatTile(
                "Paid", vm.paymentCount("Paid"), "পরিশোধিত",
                tint = DigitalInvoicesPalette.paidLine(dark),
                accent = DigitalInvoicesPalette.green400,
                dark = dark, modifier = Modifier.weight(1f),
            )
            InvoicesStatTile(
                "Partial", vm.paymentCount("Partial Paid"), "আংশিক পেমেন্ট",
                tint = DigitalInvoicesPalette.dueLine(dark),
                accent = DigitalInvoicesPalette.amber500,
                dark = dark, modifier = Modifier.weight(1f),
            )
            InvoicesStatTile(
                "Unpaid", vm.paymentCount("Unpaid"), "বাকি আছে",
                tint = DigitalInvoicesPalette.slate400,
                accent = DigitalInvoicesPalette.cditBlue,
                dark = dark, modifier = Modifier.weight(1f),
            )
        }
    }
}

/** The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
 *  deep indigo base + CDIT-blue/violet washes). */
@Composable
private fun InvoicesHeroCard(amount: Int, count: Int, paid: Int, due: Int, rangeLabel: String) {
    val paidShare = if (amount > 0) paid.toFloat() / amount.toFloat() else 0f
    Column(
        Modifier.fillMaxWidth().invoicesHeroBg().padding(16.dp),
    ) {
        Text(
            "CDIT ইনভয়েস · $rangeLabel",
            color = DigitalInvoicesPalette.cditBlue.copy(alpha = 0.95f),
            fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        InvoicesCountUp(amount, 38.sp, Color.White, format = { AlmaTheme.takaShort(it) })
        Spacer(Modifier.height(5.dp))
        Text("${count}টি ইনভয়েস · Creative Digital IT", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp)

        Spacer(Modifier.height(14.dp))
        Row {
            InvoicesHeroStat("Paid", paid, DigitalInvoicesPalette.green400, "পরিশোধিত")
            Box(
                Modifier.width(1.dp).height(48.dp).padding(vertical = 2.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            Spacer(Modifier.width(14.dp))
            InvoicesHeroStat(
                "Due", due,
                if (due > 0) DigitalInvoicesPalette.amber500 else Color.White,
                "বাকি",
            )
        }

        Spacer(Modifier.height(12.dp))
        InvoicesMiniBar(fraction = paidShare, color = DigitalInvoicesPalette.green400)
        Spacer(Modifier.height(4.dp))
        Text(
            "পেইড শেয়ার ${(paidShare * 100).toInt()}%",
            color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp,
        )
    }
}

@Composable
private fun InvoicesHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(Modifier.padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        InvoicesCountUp(value, 19.sp, tint, format = { AlmaTheme.takaShort(it) })
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Small glass stat tile — count-up value + sub line over a soft accent wash. */
@Composable
private fun InvoicesStatTile(
    label: String,
    value: Int,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .invoicesBentoWash(accent, dark)
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1,
        )
        InvoicesCountUp(value, 17.sp, tint, format = { "$it" })
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

/** Paid-share mini bar — sweeps to its fraction on appear (iOS MiniBar twin). */
@Composable
private fun InvoicesMiniBar(fraction: Float, color: Color) {
    var grow by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { grow = true }
    val w by animateFloatAsState(
        targetValue = if (grow) fraction.coerceIn(0f, 1f) else 0f,
        animationSpec = tween(600),
        label = "miniBar",
    )
    Box(
        Modifier.fillMaxWidth().height(7.dp).clip(CircleShape)
            .background(Color.White.copy(alpha = 0.12f)),
    ) {
        if (w > 0f) {
            Box(
                Modifier.fillMaxWidth(w).fillMaxHeight().clip(CircleShape)
                    .background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.55f), color))),
            )
        }
    }
}

/** Count-up number (0 → target on appear) — iOS Animatable count-up twin. */
@Composable
private fun InvoicesCountUp(target: Int, fontSize: TextUnit, color: Color, format: (Int) -> String) {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "countUp",
    )
    Text(format(shown), color = color, fontSize = fontSize, fontWeight = FontWeight.ExtraBold, maxLines = 1)
}

// ── Invoice row card (mirrors one web list row) ──────────────────────────────────────

@Composable
private fun DigitalInvoiceCard(inv: DigitalInvoiceRow, dark: Boolean, onTap: () -> Unit) {
    val payTint = DigitalInvoicesPalette.payment(inv.paymentStatus, dark)
    Column(
        Modifier
            .fillMaxWidth()
            .invoicesBentoWash(payTint, dark)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Web: font-mono text-gold invoice id.
            Text(
                inv.id,
                color = DigitalInvoicesPalette.accentText(dark),
                fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            InvoicesPaymentBadge(inv.paymentStatus ?: "Unpaid", dark)
        }

        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    inv.clientName,
                    color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                // Web: "{invoice_type} · Due {due_date || —}".
                Text(
                    "${inv.invoiceType?.takeIf { it.isNotEmpty() } ?: "one-time"} · Due ${DigitalInvoicesFormat.orDash(inv.dueDate)}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    AlmaTheme.taka(inv.amount ?: 0),
                    color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Paid ${AlmaTheme.taka(inv.totalPaid ?: 0)}",
                        color = DigitalInvoicesPalette.paidLine(dark),
                        fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "Due ${AlmaTheme.taka(inv.dueAmount ?: 0)}",
                        color = DigitalInvoicesPalette.dueLine(dark),
                        fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            if (inv.invoiceType == "recurring" && !inv.recurringInterval.isNullOrEmpty()) {
                Text("↻ ${inv.recurringInterval}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
            Spacer(Modifier.weight(1f))
            // Web "Preview PDF" — the premium PDF flow is web-only on Android; the
            // actions sheet carries the escape.
            Text(
                "📄 PDF · অ্যাকশন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onTap).padding(horizontal = 8.dp, vertical = 5.dp),
            )
        }
    }
}

/** Web PaymentStatusBadge: uppercase tracking pill, tinted per status. */
@Composable
private fun InvoicesPaymentBadge(status: String, dark: Boolean) {
    val tint = DigitalInvoicesPalette.payment(status, dark)
    Text(
        status.uppercase(),
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        maxLines = 1,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.5.dp),
    )
}

// ── Actions sheet (record payment native · PDF = web escape · open web) ─────────────

@Composable
private fun DigitalInvoiceActionsSheet(
    inv: DigitalInvoiceRow,
    vm: DigitalInvoicesState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val canManage = AlmaSession.canManageBusiness   // client-side role gate (fail-closed)
    var payAmount by remember { mutableStateOf("") }
    var payMethod by remember { mutableStateOf("Bank Transfer") }
    var methodMenu by remember { mutableStateOf(false) }
    var paying by remember { mutableStateOf(false) }
    var confirmingPay by remember { mutableStateOf(false) }
    var showPdf by remember { mutableStateOf(false) }
    val taka = DigitalInvoicesFormat.parseTaka(payAmount)

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header — invoice identity + money split.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(inv.clientName, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text(
                "${inv.id} · ${inv.invoiceType?.takeIf { it.isNotEmpty() } ?: "one-time"}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 6.dp)) {
                InvoicesSheetStat("Amount", inv.amount ?: 0, dark)
                InvoicesSheetStat("Paid", inv.totalPaid ?: 0, dark)
                InvoicesSheetStat("Due", inv.dueAmount ?: 0, dark)
            }
        }

        // Record payment (web handlePartialPay parity — POST /api/digital/payments).
        // Admin-only money write: hidden for non-admins (defense-in-depth).
        if (canManage) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "RECORD PAYMENT",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
                )
                OutlinedTextField(
                    value = payAmount,
                    onValueChange = { payAmount = it },
                    placeholder = { Text("Amount (BDT)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                Box {
                    Row(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { methodMenu = true }
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(payMethod, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.weight(1f))
                        Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    }
                    DropdownMenu(expanded = methodMenu, onDismissRequest = { methodMenu = false }) {
                        INVOICE_PAY_METHODS.forEach { m ->
                            DropdownMenuItem(text = { Text(m) }, onClick = { payMethod = m; methodMenu = false })
                        }
                    }
                }
                if (paying) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(
                            Modifier.size(18.dp),
                            color = DigitalInvoicesPalette.emerald600, strokeWidth = 2.dp,
                        )
                    }
                } else {
                    Text(
                        "Record payment",
                        color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                if (taka > 0) DigitalInvoicesPalette.emerald600
                                else DigitalInvoicesPalette.emerald600.copy(alpha = 0.4f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .plainClick { if (taka > 0) confirmingPay = true }
                            .padding(vertical = 12.dp),
                    )
                }
            }
        }

        // Premium PDF — NATIVE now: server generates → downloaded → rendered in-app
        // (PdfRenderer) with a native share sheet. No web page.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "📄 Premium PDF দেখুন / শেয়ার",
                color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.violet, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { showPdf = true }
                    .padding(vertical = 11.dp),
            )
            Text(
                "PDF অ্যাপেই তৈরি হয়, দেখা ও শেয়ার হয়।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Text(
            "🌐 ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/digital/invoices", "CDIT Invoices") }
                .padding(vertical = 4.dp),
        )
    }

    if (showPdf) {
        AlmaPdfViewerSheet(
            title = "Invoice ${inv.id}",
            dark = dark,
            onDismiss = { showPdf = false },
            generate = {
                val resp = AlmaApi.send("POST", "/api/digital/invoices/pdf", JSONObject().put("invoice_id", inv.id))
                val data = resp.optJSONObject("data") ?: resp
                data.str("pdf_url") ?: resp.str("pdf_url")
            },
        )
    }

    if (confirmingPay) {
        AlertDialog(
            onDismissRequest = { confirmingPay = false },
            title = { Text("${AlmaTheme.taka(taka)} payment ($payMethod) রেকর্ড করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingPay = false
                    scope.launch {
                        paying = true
                        val ok = vm.recordPayment(inv, taka, payMethod)
                        paying = false
                        if (ok) onDone()
                    }
                }) { Text("হ্যাঁ, রেকর্ড করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmingPay = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvoicesSheetStat(label: String, value: Int, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        Text(
            AlmaTheme.taka(value),
            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
        )
    }
}

// ── Create sheet (web "+ New Invoice" form — POST /api/digital/invoices verbatim) ────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DigitalInvoiceCreateSheet(vm: DigitalInvoicesState, dark: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var clientName by remember { mutableStateOf("") }
    var clientId by remember { mutableStateOf("") }
    var projectId by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var invoiceType by remember { mutableStateOf("one-time") }
    var recurringInterval by remember { mutableStateOf("") }
    var dueDate by remember { mutableStateOf<String?>(null) }
    var notes by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }

    val taka = DigitalInvoicesFormat.parseTaka(amount)
    val canSubmit = clientName.trim().isNotEmpty() && taka > 0

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("New Invoice", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("তৈরি হলে status = Sent।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }

        OutlinedTextField(
            value = clientName, onValueChange = { clientName = it },
            placeholder = { Text("Client name *") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = clientId, onValueChange = { clientId = it },
            placeholder = { Text("Client ID") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = projectId, onValueChange = { projectId = it },
            placeholder = { Text("Project ID") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = amount, onValueChange = { amount = it },
            placeholder = { Text("Amount (BDT) *") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        // Type — segmented One-time | Recurring (iOS Picker.segmented twin).
        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            InvoicesSegButton("One-time", invoiceType == "one-time", dark, Modifier.weight(1f)) {
                invoiceType = "one-time"
            }
            InvoicesSegButton("Recurring", invoiceType == "recurring", dark, Modifier.weight(1f)) {
                invoiceType = "recurring"
            }
        }
        if (invoiceType == "recurring") {
            OutlinedTextField(
                value = recurringInterval, onValueChange = { recurringInterval = it },
                placeholder = { Text("Recurring interval (e.g. monthly)") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Due date — optional (web's empty-string-when-unset input).
        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Due date", color = AlmaTheme.ink(dark), fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            if (dueDate != null) {
                Text(
                    dueDate ?: "",
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick { showDatePicker = true },
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    "✕",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                    modifier = Modifier.plainClick { dueDate = null },
                )
            } else {
                Text(
                    "সেট করুন",
                    color = DigitalInvoicesPalette.accentText(dark), fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick { showDatePicker = true },
                )
            }
        }

        OutlinedTextField(
            value = notes, onValueChange = { notes = it },
            placeholder = { Text("Notes") },
            modifier = Modifier.fillMaxWidth(),
        )

        errorText?.let {
            Text(it, color = DigitalInvoicesPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }

        if (submitting) {
            Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    Modifier.size(18.dp),
                    color = DigitalInvoicesPalette.cditBlue, strokeWidth = 2.dp,
                )
            }
        } else {
            Text(
                "Create Invoice",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (canSubmit) DigitalInvoicesPalette.cditBlue
                        else DigitalInvoicesPalette.cditBlue.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { if (canSubmit) confirming = true }
                    .padding(vertical = 14.dp),
            )
        }
    }

    if (showDatePicker) {
        val dpState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    dpState.selectedDateMillis?.let { dueDate = DigitalInvoicesFormat.utcYmd(it) }
                    showDatePicker = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("বাতিল") } },
        ) { DatePicker(dpState) }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("${clientName.trim()}-এর জন্য ${AlmaTheme.taka(taka)} invoice তৈরি করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        submitting = true
                        errorText = null
                        val ok = vm.createInvoice(
                            clientName = clientName.trim(),
                            clientId = clientId,
                            projectId = projectId,
                            amount = taka,
                            invoiceType = invoiceType,
                            dueDate = dueDate ?: "",
                            recurringInterval = recurringInterval,
                            notes = notes,
                        )
                        submitting = false
                        if (ok) onDone() else errorText = vm.toast
                    }
                }) { Text("হ্যাঁ, তৈরি করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvoicesSegButton(label: String, active: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) DigitalInvoicesPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(
                if (active) DigitalInvoicesPalette.cditBlue.copy(alpha = if (dark) 0.28f else 0.16f)
                else Color.Transparent,
                RoundedCornerShape((AlmaTheme.R_CONTROL - 4).dp),
            )
            .plainClick(onClick)
            .padding(vertical = 8.dp),
    )
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun InvoicesChip(label: String, tint: Color, active: Boolean, dark: Boolean, onClick: () -> Unit) {
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
private fun InvoicesNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun InvoicesAuthCard(dark: Boolean, onLogin: () -> Unit) {
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

// ── Surface recipes (page-owned copies — parallel-session convention) ────────────────

/** Frosted glass + soft diagonal payment-tone wash (iOS bento wash twin). */
private fun Modifier.invoicesBentoWash(accent: Color, dark: Boolean): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(if (dark) Color.White.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.62f))
        .background(
            Brush.linearGradient(
                0f to accent.copy(alpha = if (dark) 0.14f else 0.10f),
                1f to Color.Transparent,
            )
        )
        .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.45f), shape)
}

/** The dark hero anchor backdrop — deep indigo base + CDIT-blue/violet washes. */
private fun Modifier.invoicesHeroBg(): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(Color(0xFF151828))
        .background(
            Brush.linearGradient(
                0f to DigitalInvoicesPalette.cditBlue.copy(alpha = 0.36f),
                0.55f to Color.Transparent,
            )
        )
        .background(
            Brush.linearGradient(
                0.45f to Color.Transparent,
                1f to AlmaTheme.violet.copy(alpha = 0.26f),
            )
        )
        .background(
            Brush.radialGradient(
                listOf(AlmaTheme.sage.copy(alpha = 0.12f), Color.Transparent),
                center = Offset(750f, 40f),
                radius = 450f,
            )
        )
        .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
}
