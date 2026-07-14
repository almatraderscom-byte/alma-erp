//
//  InvoicesScreen.kt
//  ALMA ERP — the Invoices tab, ported 1:1 from InvoicesSwiftUI.swift (web /invoice parity).
//
//  Same endpoints, same numbers, same blocks as the iOS screen:
//    GET   /api/invoice?business_id=…&search=…&payment_status=…   → registry + totals
//    POST  /api/invoice  {id, allow_regenerate, business_id}      → generate / regenerate
//    PATCH /api/invoice  {id, payment_status}                     → payment status change
//    GET   /api/orders/orders?business_id=…&status=Delivered      → pending-invoice KPI
//  Blocks: KPI bento board (dark hero: invoiced amount + paid/unpaid split + paid-share
//  bar; 3 glass tiles Delivered/Invoiced/Pending) · search · status filter chips
//  (All/Unpaid/Partial/Paid/Void) · "Pending Invoices" amber section (native Generate,
//  confirm + per-row spinner) · "Invoice Registry" cards · detail sheet (payment status
//  change VOID-guarded, Regenerate confirm-guarded, native share on the public link).
//  PDF preview stays on the web. Money whole-taka BDT (AlmaTheme.taka), one spinner per row.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import android.content.Intent
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS InvoicePalette) ──

private object InvoicePalette {
    val coral = AlmaTheme.coral               // web --c-accent  #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** Web row chip: PAID green · PARTIAL amber · VOID red · UNPAID muted. */
    fun payment(s: String?, dark: Boolean): Color = when (s) {
        "PAID" -> emerald600
        "PARTIAL" -> amber600
        "VOID" -> red500
        else -> AlmaTheme.inkSecondary(dark)
    }

    /** Web accent-tinted text: gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else Color(0xFFC45A3C)
}

/** The dark hero anchor base — iOS Color(0.094, 0.082, 0.157) = #181528. */
private val INV_HERO_BASE = Color(0xFF181528)

private const val INV_BUSINESS_ID = "ALMA_LIFESTYLE"

// ── Models (same field names the web InvoiceRegistryRecord declares) ─────────────────

private data class InvoiceEvent(
    val id: String,
    val type: String?,
    val actorName: String?,
    val note: String?,
    val createdAt: String?,
)

private data class InvoiceRecord(
    val id: String,
    val invoiceNumber: String,
    val orderId: String,
    val customerName: String?,
    val customerPhone: String?,
    val businessId: String?,
    val amount: Int?,
    val paymentStatus: String,
    val generatedByName: String?,
    val createdAt: String?,
    val events: List<InvoiceEvent>,
) {
    /** internalInvoiceUrl → /invoice/share/alma-<encodeURIComponent(orderId)>. */
    val sharePath: String get() = "/invoice/share/alma-${uriComponent(orderId)}"
    val publicShareUrl: String get() = AlmaTheme.BASE_URL + sharePath
}

private data class InvoiceTotals(
    val count: Int = 0,
    val amount: Int = 0,
    val paid: Int = 0,
    val unpaid: Int = 0,
)

private data class InvoiceOrderLite(
    val id: String,
    val date: String?,
    val customer: String?,
    val product: String?,
    val sellPrice: Int?,
    val invoiceNum: String?,
)

/** encodeURIComponent parity for the share slug (order ids are simple, but stay exact). */
private fun uriComponent(s: String): String =
    URLEncoder.encode(s, "UTF-8").replace("+", "%20")

private fun parseInvoice(o: JSONObject): InvoiceRecord {
    val events = o.optJSONArray("events")?.mapObjects { e ->
        InvoiceEvent(
            id = e.str("id") ?: "",
            type = e.str("type"),
            actorName = e.str("actorName"),
            note = e.str("note"),
            createdAt = e.str("createdAt"),
        )
    } ?: emptyList()
    return InvoiceRecord(
        id = o.str("id") ?: "",
        invoiceNumber = o.str("invoiceNumber") ?: "—",
        orderId = o.str("orderId") ?: "",
        customerName = o.str("customerName"),
        customerPhone = o.str("customerPhone"),
        businessId = o.str("businessId"),
        amount = o.flexInt("amount"),
        paymentStatus = o.str("paymentStatus") ?: "UNPAID",
        generatedByName = o.str("generatedByName"),
        createdAt = o.str("createdAt"),
        events = events,
    )
}

// ── State holder (iOS InvoicesVM twin) ────────────────────────────────────────────────

private class InvoicesState {
    var invoices by mutableStateOf(listOf<InvoiceRecord>())
    var totals by mutableStateOf(InvoiceTotals())
    var deliveredOrders by mutableStateOf(listOf<InvoiceOrderLite>())
    var statusFilter by mutableStateOf("")     // "" (all) | UNPAID | PARTIAL | PAID | VOID
    var search by mutableStateOf("")
    var loading by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    val busyIds = mutableStateListOf<String>()         // per-row payment spinners
    val busyOrderIds = mutableStateListOf<String>()    // generate/regenerate in-flight
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    /** Delivered orders with no registry record and no legacy invoice_num — the amber section. */
    val pendingOrders: List<InvoiceOrderLite>
        get() {
            val invoiced = invoices.map { it.orderId }.toSet()
            val q = search.trim().lowercase()
            return deliveredOrders.filter { o ->
                if (invoiced.contains(o.id) || !o.invoiceNum.isNullOrEmpty()) return@filter false
                if (q.isEmpty()) return@filter true
                listOf(o.id, o.customer ?: "", o.product ?: "").any { it.lowercase().contains(q) }
            }
        }

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val trimmed = search.trim()
            val r = unwrap(
                AlmaApi.getObject(
                    "/api/invoice",
                    mapOf(
                        "business_id" to INV_BUSINESS_ID,
                        "search" to trimmed.ifEmpty { null },
                        "payment_status" to statusFilter.ifEmpty { null },
                    ),
                ),
            )
            invoices = r.optJSONArray("invoices")?.mapObjects { parseInvoice(it) } ?: emptyList()
            totals = r.optJSONObject("totals")?.let {
                InvoiceTotals(
                    count = it.flexInt("count") ?: 0,
                    amount = it.flexInt("amount") ?: 0,
                    paid = it.flexInt("paid") ?: 0,
                    unpaid = it.flexInt("unpaid") ?: 0,
                )
            } ?: InvoiceTotals()
            loaded = true
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            loading = false
            return
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            loading = false
            return
        }
        loadDeliveredOrders()
        loading = false
    }

    /** KPI/pending support only — a failure here must never blank the registry. */
    private suspend fun loadDeliveredOrders() {
        try {
            val r = unwrap(
                AlmaApi.getObject(
                    "/api/orders/orders",
                    mapOf("business_id" to INV_BUSINESS_ID, "status" to "Delivered"),
                ),
            )
            deliveredOrders = r.optJSONArray("orders")?.mapObjects { o ->
                InvoiceOrderLite(
                    id = o.str("id") ?: "",
                    date = o.str("date"),
                    customer = o.str("customer"),
                    product = o.str("product"),
                    sellPrice = o.flexInt("sell_price"),
                    invoiceNum = o.str("invoice_num"),
                )
            } ?: emptyList()
        } catch (_: Exception) {
            // Silent: the registry list is the page's core; KPIs just show 0.
        }
    }

    /** POST /api/invoice { id, allow_regenerate, business_id } — generate / regenerate. */
    suspend fun generate(orderId: String, allowRegenerate: Boolean) {
        if (busyOrderIds.contains(orderId)) return
        busyOrderIds.add(orderId)
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("id", orderId)
                .put("allow_regenerate", allowRegenerate)
                .put("business_id", INV_BUSINESS_ID)
            val resp = AlmaApi.send("POST", "/api/invoice", body)
            val ok = resp.opt("ok") as? Boolean ?: true
            if (!ok) {
                error = resp.str("error") ?: "Invoice generation failed"
                return
            }
            val number = resp.str("invoice_number") ?: ""
            val duplicate = resp.opt("duplicate") as? Boolean ?: false
            val driveSync = resp.str("drive_sync")
            notice = when {
                allowRegenerate -> "Regenerated ${number.ifEmpty { orderId }}"
                duplicate -> "Invoice already exists: $number"
                driveSync == "pending" -> "Invoice $number ready — Google Drive upload finishing in background"
                else -> "Saved invoice: $number"
            }
            load()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            // OkHttp caps at 20s while PDF + Drive can take longer — a timeout usually means
            // the server is still finishing, so refresh instead of scaring the owner.
            val msg = e.message ?: ""
            if (msg.contains("timeout", true) || msg.contains("timed out", true)) {
                notice = "Invoice generation is still running on the server — pull to refresh in a moment."
                load()
            } else {
                error = serverMessage(e)
            }
        } finally {
            busyOrderIds.remove(orderId)
        }
    }

    /** PATCH /api/invoice { id, payment_status } — optimistic, reverts on error. */
    suspend fun setPayment(invoice: InvoiceRecord, status: String) {
        if (invoice.paymentStatus == status || busyIds.contains(invoice.id)) return
        busyIds.add(invoice.id)
        notice = null
        val previous = invoice.paymentStatus
        replaceStatus(invoice.id, status)
        try {
            val body = JSONObject().put("id", invoice.id).put("payment_status", status)
            val resp = AlmaApi.send("PATCH", "/api/invoice", body)
            val updated = (resp.optJSONObject("data") ?: resp).optJSONObject("invoice")?.let { parseInvoice(it) }
            if (updated != null) {
                invoices = invoices.map { if (it.id == updated.id) updated else it }
            }
            notice = "Invoice status updated"
            load()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            replaceStatus(invoice.id, previous)
        } catch (e: Exception) {
            replaceStatus(invoice.id, previous)
            error = serverMessage(e)
        } finally {
            busyIds.remove(invoice.id)
        }
    }

    private fun replaceStatus(id: String, status: String) {
        invoices = invoices.map { if (it.id == id) it.copy(paymentStatus = status) else it }
    }

    private fun serverMessage(e: Exception): String {
        (e as? AlmaApiException.Http)?.let { http ->
            val body = http.message ?: ""
            val start = body.indexOf('{')
            if (start >= 0) {
                runCatching {
                    JSONObject(body.substring(start)).str("error")?.let { if (it.isNotEmpty()) return it }
                }
            }
        }
        return e.message ?: "নেটওয়ার্ক সমস্যা"
    }
}

// ── Formatting helpers (web util parity) ──────────────────────────────────────────────

/** Whole-taka BDT — web: `৳ Number(amount).toLocaleString('en-BD')`. */
private fun invTaka(amount: Int?): String = AlmaTheme.taka(amount ?: 0)

/** Web: String(createdAt).slice(0,16).replace('T',' ') → "2026-07-01 10:22". */
private fun invDateTime16(iso: String?): String =
    if (iso.isNullOrEmpty()) "—" else iso.take(16).replace("T", " ")

/** Web: String(createdAt).slice(0,10) → "2026-07-01". */
private fun invDay10(iso: String?): String = if (iso.isNullOrEmpty()) "—" else iso.take(10)

// ── Screen ────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvoicesScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { InvoicesState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<InvoiceRecord?>(null) }
    var pdfInvoice by remember { mutableStateOf<InvoiceRecord?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { InvAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { InvNoticeCard("⚠️ $it", InvoicePalette.red500, dark) } }
        vm.notice?.let { item { InvNoticeCard("✓ $it", InvoicePalette.emerald600, dark) } }

        item { InvKpiBoard(vm, dark) }
        item { InvSearchField(vm, dark) { scope.launch { vm.load() } } }
        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("All" to "", "Unpaid" to "UNPAID", "Partial" to "PARTIAL", "Paid" to "PAID", "Void" to "VOID")
                    .forEach { (label, value) ->
                        InvChip(label, vm.statusFilter == value, dark) {
                            vm.statusFilter = value
                            scope.launch { vm.load() }
                        }
                    }
            }
        }

        if (vm.loading && !vm.loaded) {
            items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        // Pending Invoices (amber section — native Generate).
        if (vm.pendingOrders.isNotEmpty() && vm.statusFilter.isEmpty()) {
            item { InvSectionHeader("Pending Invoices", InvoicePalette.amber600) }
            items(vm.pendingOrders, key = { "pending-${it.id}" }) { order ->
                InvPendingCard(
                    order = order,
                    busy = vm.busyOrderIds.contains(order.id),
                    dark = dark,
                    onGenerate = { scope.launch { vm.generate(order.id, false) } },
                    onWebPreview = { ctx.openWebForced("/invoice", "Invoices") },
                )
            }
        }

        // Invoice Registry.
        item { InvSectionHeader("Invoice Registry", InvoicePalette.emerald600) }
        items(vm.invoices, key = { "reg-${it.id}" }) { inv ->
            InvCard(
                invoice = inv,
                busy = vm.busyIds.contains(inv.id) || vm.busyOrderIds.contains(inv.orderId),
                dark = dark,
                onOpenPdf = { pdfInvoice = inv },
                onTap = { selected = inv },
            )
        }
        if (!vm.loading && vm.invoices.isEmpty() && vm.error == null && !vm.authExpired) {
            item { InvEmptyState(dark) }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { inv ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            InvDetailSheet(inv, vm, dark, openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) })
        }
    }

    pdfInvoice?.let { inv ->
        AlmaPdfViewerSheet(
            title = inv.invoiceNumber,
            dark = dark,
            onDismiss = { pdfInvoice = null },
            generateBase64 = {
                val resp = AlmaApi.send(
                    "POST", "/api/invoice",
                    JSONObject().put("id", inv.orderId).put("business_id", "ALMA_LIFESTYLE"),
                )
                val data = resp.optJSONObject("data") ?: resp
                data.str("pdfBase64") ?: resp.str("pdfBase64")
            },
        )
    }
}

@Composable
private fun InvSearchField(vm: InvoicesState, dark: Boolean, onSubmit: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Search, contentDescription = null, tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.height(16.dp))
        OutlinedTextField(
            value = vm.search,
            onValueChange = { vm.search = it },
            placeholder = { Text("Search invoices, orders, customers…", color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp) },
            singleLine = true,
            modifier = Modifier.weight(1f),
            textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 13.sp),
        )
        Text(
            "খুঁজুন",
            color = InvoicePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.plainClick(onSubmit).padding(6.dp),
        )
    }
}

@Composable
private fun InvSectionHeader(title: String, tint: Color) {
    Text(
        title.uppercase(),
        color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp,
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    )
}

// ── KPI bento board (dark hero anchor + 3 glass tiles — same numbers/tints as web) ────

@Composable
private fun InvKpiBoard(vm: InvoicesState, dark: Boolean) {
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InvHeroCard(vm.totals)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            InvStatTile(
                "Delivered", vm.deliveredOrders.size, "ডেলিভারড অর্ডার",
                AlmaTheme.ink(dark), AlmaTheme.sage, dark, Modifier.weight(1f),
            )
            InvStatTile(
                "Invoiced", vm.totals.count, "রেজিস্ট্রিতে আছে",
                InvoicePalette.emerald600, InvoicePalette.green400, dark, Modifier.weight(1f),
            )
            InvStatTile(
                "Pending", vm.pendingOrders.size, "ইনভয়েস বাকি",
                InvoicePalette.amber600, InvoicePalette.amber500, dark, Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun InvHeroCard(totals: InvoiceTotals) {
    val paidShare = if (totals.count > 0) totals.paid.toFloat() / totals.count else 0f
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(INV_HERO_BASE)
            .drawBehind {
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                        start = Offset.Zero, end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(Color.Transparent, InvoicePalette.coral.copy(alpha = 0.30f)),
                        start = Offset(size.width * 0.5f, size.height * 0.5f),
                        end = Offset(size.width, size.height),
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.05f), radius = 220.dp.toPx(),
                    ),
                )
            }
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape).padding(16.dp),
    ) {
        Text(
            "মোট ইনভয়েস · INVOICED",
            color = InvoicePalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            invTaka(totals.amount),
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "${totals.count}টি ইনভয়েস রেজিস্ট্রিতে",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp, modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            InvHeroStat("Paid", "${totals.paid}টি", InvoicePalette.green400, "পরিশোধিত")
            Box(Modifier.padding(horizontal = 14.dp, vertical = 2.dp).width(1.dp).height(42.dp).background(Color.White.copy(alpha = 0.14f)))
            InvHeroStat(
                "Unpaid", "${totals.unpaid}টি",
                if (totals.unpaid > 0) InvoicePalette.amber500 else Color.White, "বাকি",
            )
            Spacer(Modifier.weight(1f))
        }
        Box(
            Modifier.fillMaxWidth().height(7.dp).padding(top = 0.dp)
                .background(Color.White.copy(alpha = 0.12f), CircleShape),
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(
                Modifier.fillMaxWidth(paidShare.coerceIn(0f, 1f)).height(7.dp)
                    .background(
                        Brush.horizontalGradient(listOf(InvoicePalette.green400.copy(alpha = 0.55f), InvoicePalette.green400)),
                        CircleShape,
                    ),
            )
        }
        Text(
            "পেইড শেয়ার ${Math.round(paidShare * 100)}%",
            color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp, modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun InvHeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun InvStatTile(
    label: String,
    value: Int,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                shape,
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text("$value", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Registry row card (mirrors one web registry Card) ─────────────────────────────────

@Composable
private fun InvCard(
    invoice: InvoiceRecord,
    busy: Boolean,
    dark: Boolean,
    onOpenPdf: () -> Unit,
    onTap: () -> Unit,
) {
    val context = LocalContext.current
    val tint = InvoicePalette.payment(invoice.paymentStatus, dark)
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).almaGlass(dark, AlmaTheme.R_CARD)
            .background(Brush.linearGradient(listOf(tint.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)), shape)
            .plainClick(onTap).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                invoice.invoiceNumber,
                color = InvoicePalette.emerald600, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
            Text(
                "Order ${invoice.orderId}",
                color = InvoicePalette.accentText(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            InvPaymentChip(invoice.paymentStatus, dark)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(invoice.customerName ?: "—", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    "${invoice.generatedByName ?: "System"} · ${invDateTime16(invoice.createdAt)}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
            Text(invTaka(invoice.amount), color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
        invoice.events.firstOrNull()?.let { last ->
            Text(
                "Last: ${(last.type ?: "—").replace("_", " ")} · ${invDay10(last.createdAt)}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.height(14.dp).width(14.dp), strokeWidth = 2.dp, color = InvoicePalette.coral)
                Text("Updating…", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.weight(1f))
            Text(
                "PDF",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onOpenPdf).padding(horizontal = 8.dp, vertical = 5.dp),
            )
            Text(
                "Share",
                color = InvoicePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(InvoicePalette.coral.copy(alpha = 0.13f), CircleShape)
                    .border(1.dp, InvoicePalette.coral.copy(alpha = 0.35f), CircleShape)
                    .plainClick { invShare(context, invoice.publicShareUrl) }
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
    }
}

@Composable
private fun InvPaymentChip(status: String, dark: Boolean) {
    val tint = InvoicePalette.payment(status, dark)
    Text(
        status,
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.5.dp),
    )
}

// ── Pending order card (web amber "Pending Invoices" row — native Generate) ───────────

@Composable
private fun InvPendingCard(
    order: InvoiceOrderLite,
    busy: Boolean,
    dark: Boolean,
    onGenerate: () -> Unit,
    onWebPreview: () -> Unit,
) {
    var confirm by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, InvoicePalette.amber500.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(order.id, color = InvoicePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(order.customer ?: "—", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(order.product ?: "—", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(invTaka(order.sellPrice), color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(order.date ?: "", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier
                    .background(InvoicePalette.amber500.copy(alpha = 0.14f), CircleShape)
                    .border(1.dp, InvoicePalette.amber500.copy(alpha = 0.4f), CircleShape)
                    .plainClick { if (!busy) confirm = true }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (busy) CircularProgressIndicator(modifier = Modifier.height(12.dp).width(12.dp), strokeWidth = 2.dp, color = InvoicePalette.amber600)
                Text(if (busy) "Generating…" else "ইনভয়েস তৈরি করুন", color = InvoicePalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.weight(1f))
            Text(
                "PDF প্রিভিউ — ওয়েব ভার্সন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                modifier = Modifier.plainClick(onWebPreview).padding(4.dp),
            )
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            containerColor = AlmaTheme.cardBg(dark),
            title = { Text("Order ${order.id}", color = AlmaTheme.ink(dark)) },
            text = { Text("ইনভয়েস তৈরি করবেন?", color = AlmaTheme.inkSecondary(dark)) },
            confirmButton = {
                TextButton(onClick = { confirm = false; onGenerate() }) {
                    Text("ইনভয়েস তৈরি করুন", color = InvoicePalette.amber600)
                }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("বাতিল", color = AlmaTheme.inkSecondary(dark)) } },
        )
    }
}

@Composable
private fun InvEmptyState(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("◈", color = AlmaTheme.inkSecondary(dark), fontSize = 28.sp)
        Text("No invoice records", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Text("ইনভয়েস তৈরি করলে এখানে স্থায়ী রেকর্ড দেখা যাবে।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

// ── Shared bits ───────────────────────────────────────────────────────────────────────

private fun invShare(context: android.content.Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    context.startActivity(Intent.createChooser(send, "Share invoice"))
}

@Composable
private fun InvChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) InvoicePalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) InvoicePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) InvoicePalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun InvNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun InvAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(InvoicePalette.coral, CircleShape).plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Detail sheet ──────────────────────────────────────────────────────────────────────

@Composable
private fun InvDetailSheet(invoice: InvoiceRecord, vm: InvoicesState, dark: Boolean, openWeb: (String, String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Live copy — payment changes made in the sheet reflect immediately.
    val current = vm.invoices.firstOrNull { it.id == invoice.id } ?: invoice
    val busy = vm.busyIds.contains(invoice.id)
    val busyGen = vm.busyOrderIds.contains(invoice.orderId)
    val hasOrder = vm.deliveredOrders.any { it.id == invoice.orderId }
    var confirmVoid by remember { mutableStateOf(false) }
    var confirmRegen by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header.
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(current.invoiceNumber, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                InvPaymentChip(current.paymentStatus, dark)
            }
            Text("Order ${current.orderId} · ${invDateTime16(current.createdAt)}", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }

        // Info rows.
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            InvInfoRow("Customer", current.customerName ?: "—", dark)
            if (!current.customerPhone.isNullOrEmpty()) InvInfoRow("Phone", current.customerPhone, dark)
            InvInfoRow("Amount", invTaka(current.amount), dark)
            InvInfoRow("Business", current.businessId ?: "—", dark)
            InvInfoRow("Generated by", current.generatedByName ?: "System", dark)
        }

        // Payment status picker.
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("PAYMENT STATUS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("UNPAID", "PARTIAL", "PAID", "VOID").forEach { s ->
                    val active = current.paymentStatus == s
                    val tint = InvoicePalette.payment(s, dark)
                    Text(
                        s.lowercase().replaceFirstChar { it.uppercase() },
                        color = if (active) tint else AlmaTheme.inkSecondary(dark),
                        fontSize = 11.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f)
                            .background(if (active) tint.copy(alpha = 0.16f) else Color.Transparent, CircleShape)
                            .border(
                                1.dp,
                                if (active) tint.copy(alpha = 0.5f) else Color.White.copy(alpha = if (dark) 0.12f else 0.4f),
                                CircleShape,
                            )
                            .plainClick {
                                if (busy) return@plainClick
                                if (s == "VOID" && current.paymentStatus != "VOID") confirmVoid = true
                                else scope.launch { vm.setPayment(current, s) }
                            }
                            .padding(vertical = 7.dp),
                    )
                }
            }
            if (busy) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(modifier = Modifier.height(14.dp).width(14.dp), strokeWidth = 2.dp, color = InvoicePalette.coral)
                    Text("Updating…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        // History.
        if (current.events.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("HISTORY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                current.events.forEach { e ->
                    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text((e.type ?: "—").replace("_", " "), color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.weight(1f))
                            Text(invDay10(e.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                        }
                        if (!e.actorName.isNullOrEmpty()) Text(e.actorName, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                        if (!e.note.isNullOrEmpty()) Text(e.note, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 2)
                    }
                }
            }
        }

        // Share + copy.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "Share", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).background(InvoicePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { invShare(context, current.publicShareUrl) }.padding(vertical = 11.dp),
            )
            Text(
                "লিংক কপি", color = InvoicePalette.coral, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { invCopy(context, current.publicShareUrl); vm.notice = "Invoice link copied" }.padding(vertical = 11.dp),
            )
        }

        // Regenerate (only while the delivered order still exists).
        if (hasOrder) {
            Row(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                    .border(1.dp, InvoicePalette.red500.copy(alpha = 0.4f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { if (!busyGen) confirmRegen = true }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                if (busyGen) {
                    CircularProgressIndicator(modifier = Modifier.height(14.dp).width(14.dp), strokeWidth = 2.dp, color = InvoicePalette.red500)
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (busyGen) "Regenerating…" else "Regenerate", color = InvoicePalette.red500, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        // Web links.
        Text(
            "ইনভয়েস দেখুন (PDF)",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { openWeb(current.sharePath, current.invoiceNumber) }.padding(vertical = 2.dp),
        )
        Text(
            "🌐 ওয়েব ভার্সন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { openWeb("/invoice", "Invoices") }.padding(vertical = 4.dp),
        )
    }

    if (confirmVoid) {
        AlertDialog(
            onDismissRequest = { confirmVoid = false },
            containerColor = AlmaTheme.cardBg(dark),
            title = { Text("${current.invoiceNumber}", color = AlmaTheme.ink(dark)) },
            text = { Text("ইনভয়েসটি VOID করবেন?", color = AlmaTheme.inkSecondary(dark)) },
            confirmButton = {
                TextButton(onClick = { confirmVoid = false; scope.launch { vm.setPayment(current, "VOID") } }) {
                    Text("VOID করুন", color = InvoicePalette.red500)
                }
            },
            dismissButton = { TextButton(onClick = { confirmVoid = false }) { Text("বাতিল", color = AlmaTheme.inkSecondary(dark)) } },
        )
    }
    if (confirmRegen) {
        AlertDialog(
            onDismissRequest = { confirmRegen = false },
            containerColor = AlmaTheme.cardBg(dark),
            title = { Text("Regenerate", color = AlmaTheme.ink(dark)) },
            text = {
                Text(
                    "Regenerate invoice for order ${current.orderId}? The existing registry record will be updated and the event will be audited.",
                    color = AlmaTheme.inkSecondary(dark),
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmRegen = false; scope.launch { vm.generate(current.orderId, true) } }) {
                    Text("Regenerate", color = InvoicePalette.red500)
                }
            },
            dismissButton = { TextButton(onClick = { confirmRegen = false }) { Text("বাতিল", color = AlmaTheme.inkSecondary(dark)) } },
        )
    }
}

@Composable
private fun InvInfoRow(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

private fun invCopy(context: android.content.Context, text: String) {
    val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager
    cm?.setPrimaryClip(android.content.ClipData.newPlainText("Invoice link", text))
}
