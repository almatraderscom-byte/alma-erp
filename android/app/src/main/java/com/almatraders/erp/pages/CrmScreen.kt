//
//  CrmScreen.kt
//  ALMA ERP — the CRM tab ported 1:1 from CrmSwiftUI.swift (web /crm parity):
//  bento KPI board (lifetime-revenue dark hero + Avg CLV / High Risk tiles) ·
//  segment tabs (All + VIP/REGULAR/NEW/RISKY/BLACKLIST/COLD, tap again clears) ·
//  debounced server-side search + risk filter · contact rows (initials avatar,
//  CLV bar, segment pill) · detail sheet (badges + return-risk escalation, spend
//  2×2 grid, risk intelligence with order-derived insights, recent orders by phone,
//  profile, call/WhatsApp) · native "Sync from orders" (POST /api/customers/backfill,
//  Bangla confirm; server enforces the SUPER_ADMIN gate).
//
//  Endpoints (same as web/iOS):
//    GET  /api/customers?business_id=…&segment=…&risk_level=…&search=…   {customers}
//    GET  /api/orders/orders?business_id=…&search=<phone>&limit=10       {orders}
//    POST /api/customers/backfill {business_id}                          {processed, created, error?}
//  Responses answer flat OR {ok, data:{…}} — unwrap both shapes.
//

package com.almatraders.erp.pages

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
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
import kotlin.math.max
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object CrmPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue400 = Color(0xFF60A5FA)
    val slate400 = Color(0xFF94A3B8)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web SEG_COLORS: VIP gold · REGULAR green · NEW blue · RISKY amber ·
     *  BLACKLIST red · COLD slate. */
    fun segment(s: String?, dark: Boolean): Color = when (s) {
        "VIP" -> accentText(dark)
        "REGULAR" -> if (dark) green400 else emerald600
        "NEW" -> blue400
        "RISKY" -> if (dark) amber500 else amber600
        "BLACKLIST" -> red500
        else -> slate400          // COLD / unknown
    }

    /** Web RISK_COLORS: LOW green · MEDIUM amber · HIGH red. */
    fun risk(level: String?, dark: Boolean): Color = when (level) {
        "HIGH" -> red500
        "MEDIUM" -> if (dark) amber500 else amber600
        else -> if (dark) green400 else emerald600
    }

    /** Web ClvBar: >60 gold · >30 amber · else muted. */
    fun clv(score: Int, dark: Boolean): Color = when {
        score > 60 -> accentText(dark)
        score > 30 -> if (dark) amber500 else amber600
        else -> AlmaTheme.inkSecondary(dark)
    }
}

private const val CRM_BUSINESS_ID = "ALMA_LIFESTYLE"

// ── Models (same field names the web Customer type declares — snake_case wire) ─────

private data class CrmCustomer(
    val id: String,
    val name: String,
    val phone: String?,
    val district: String?,
    val address: String?,
    val whatsapp: String?,
    val totalOrders: Int?,
    val delivered: Int?,
    val totalSpent: Int?,
    val totalProfit: Int?,
    val codFailPct: Double?,
    val returnRate: Double?,
    val lastOrder: String?,
    val daysInactive: Int?,
    val favCategory: String?,
    val clvScore: Int?,
    val riskScore: Int?,
    val riskLevel: String?,
    val segment: String?,
    val loyaltyPts: Int?,
    val source: String?,
    val waOptin: String?,
    val notes: String?,
) {
    /** wa.me deep link — server field when present, else strip the leading 0 and
     *  prefix the 880 country code (same rule as the Orders screen). */
    val whatsappUrl: String?
        get() {
            if (whatsapp != null && whatsapp.startsWith("http")) return whatsapp
            val p = phone ?: return null
            if (!p.startsWith("0")) return null
            return "https://wa.me/880${p.drop(1)}"
        }

    companion object {
        /** Sheet-backfilled rows mix ints/strings — one bad row never kills the list. */
        fun from(o: JSONObject): CrmCustomer {
            val name = o.str("name") ?: "—"
            val phone = o.str("phone")
            return CrmCustomer(
                id = o.str("id") ?: "$name-${phone ?: ""}",
                name = name,
                phone = phone,
                district = o.str("district"),
                address = o.str("address"),
                whatsapp = o.str("whatsapp"),
                totalOrders = o.flexInt("total_orders"),
                delivered = o.flexInt("delivered"),
                totalSpent = o.flexInt("total_spent"),
                totalProfit = o.flexInt("total_profit"),
                codFailPct = o.flexDouble("cod_fail_pct"),
                returnRate = o.flexDouble("return_rate"),
                lastOrder = o.str("last_order"),
                daysInactive = o.flexInt("days_inactive"),
                favCategory = o.str("fav_category"),
                clvScore = o.flexInt("clv_score"),
                riskScore = o.flexInt("risk_score"),
                riskLevel = o.str("risk_level"),
                segment = o.str("segment"),
                loyaltyPts = o.flexInt("loyalty_pts"),
                source = o.str("source"),
                waOptin = o.str("wa_optin"),
                notes = o.str("notes"),
            )
        }
    }
}

/** Light slice of an order row for the "Recent Orders" block + return insights. */
private data class CrmOrder(
    val id: String,
    val date: String?,
    val status: String,
    val sellPrice: Int?,
    val returnNetProfitWire: Int?,
    val shippingFee: Int?,
    val courierCharge: Int?,
) {
    /** Web normalizeOrderStatusKey: trim → UPPER_SNAKE; FAILED_DELIVERY folds
     *  into RETURNED_UNPAID. */
    val statusKey: String
        get() {
            val key = status.trim().uppercase().split(Regex("\\s+")).joinToString("_")
            return if (key == "FAILED_DELIVERY") "RETURNED_UNPAID" else key
        }

    /** Web isTerminalReturnOrderStatus. */
    val isReturn: Boolean
        get() = statusKey == "RETURNED" || statusKey == "RETURNED_PAID" || statusKey == "RETURNED_UNPAID"

    /** Web return-scenario math (order-return-profit.ts): RETURNED_PAID nets
     *  shipping fee minus the round-trip courier; RETURNED / RETURNED_UNPAID eat
     *  the round-trip courier outright. Wire value wins when the sheet has it. */
    val returnNetProfit: Int
        get() {
            returnNetProfitWire?.let { return it }
            if (!isReturn) return 0
            val courier = max(0, courierCharge ?: 0)
            val ship = max(0, shippingFee ?: 0)
            return if (statusKey == "RETURNED_PAID") ship - 2 * courier else -(2 * courier)
        }

    /** Web `returnLoss`: only a negative return net counts as loss. */
    val returnLoss: Int
        get() = if (returnNetProfit < 0) -returnNetProfit else 0

    /** Web tone-* pill colours (same table the Orders screen carries). */
    val tint: Color
        get() = when (status) {
            "Pending" -> Color(0xFFF59E0B)                    // amber
            "Confirmed" -> Color(0xFFA855F7)                  // purple
            "Packed" -> Color(0xFF06B6D4)                     // cyan
            "Shipped" -> Color(0xFF3B82F6)                    // blue
            "Delivered" -> Color(0xFF22C55E)                  // green
            "CANCELLED", "Cancelled" -> CrmPalette.slate400
            "RETURNED_PAID" -> Color(0xFFF59E0B)
            else -> CrmPalette.red500                          // returns
        }

    val label: String
        get() = when (status) {
            "RETURNED_PAID" -> "Returned (paid)"
            "RETURNED_UNPAID" -> "Returned (unpaid)"
            "RETURNED" -> "Returned"
            "CANCELLED", "Cancelled" -> "Cancelled"
            else -> status
        }

    companion object {
        fun from(o: JSONObject): CrmOrder? {
            val id = o.str("id") ?: return null
            return CrmOrder(
                id = id,
                date = o.str("date"),
                status = o.str("status") ?: "Pending",
                sellPrice = o.flexInt("sell_price"),
                returnNetProfitWire = o.flexInt("return_net_profit"),
                shippingFee = o.flexInt("shipping_fee"),
                courierCharge = o.flexInt("courier_charge"),
            )
        }
    }
}

/** Order-derived return insights — the native mirror of the web's
 *  buildCustomerReturnInsights (customer-order-insights.ts). */
private class CrmReturnInsights(orders: List<CrmOrder>) {
    val totalOrders: Int = orders.size
    val returnCount: Int
    val returnRatePct: Int
    val returnsLast30Days: Int
    val computedRisk: String      // LOW | MEDIUM | HIGH (web thresholds)
    val totalReturnLoss: Int

    init {
        val cutoff = Date(System.currentTimeMillis() - 30L * 86_400_000L)
        val df = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        var returns = 0
        var recent30 = 0
        var loss = 0
        for (o in orders) {
            if (!o.isReturn) continue
            returns += 1
            loss += o.returnLoss
            val raw = o.date
            if (raw != null && raw.length >= 10) {
                val d = try { df.parse(raw.take(10)) } catch (_: Exception) { null }
                if (d != null && !d.before(cutoff)) recent30 += 1
            }
        }
        returnCount = returns
        returnsLast30Days = recent30
        totalReturnLoss = loss
        returnRatePct = if (totalOrders > 0) {
            (returns.toDouble() / totalOrders * 100).roundToInt()
        } else 0
        // Web: >2 returns in 30d = HIGH; any in 30d or 2+ lifetime = MEDIUM.
        computedRisk = when {
            recent30 > 2 -> "HIGH"
            recent30 >= 1 || returns >= 2 -> "MEDIUM"
            else -> "LOW"
        }
    }
}

private val CRM_SEGMENTS = listOf("VIP", "REGULAR", "NEW", "RISKY", "BLACKLIST", "COLD")

private fun crmUnwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

// ── State holder (iOS CrmVM twin) ──────────────────────────────────────────────────

private class CrmState {
    var customers by mutableStateOf(listOf<CrmCustomer>())
    var search by mutableStateOf("")
    var segment by mutableStateOf<String?>(null)   // VIP | REGULAR | NEW | RISKY | BLACKLIST | COLD
    var risk by mutableStateOf<String?>(null)      // LOW | MEDIUM | HIGH
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    // ── KPI summary — computed from the loaded list, same as the web page ──
    val totalRevenue: Int get() = customers.sumOf { it.totalSpent ?: 0 }
    val vipCount: Int get() = customers.count { it.segment == "VIP" }
    val highRiskCount: Int get() = customers.count { it.riskLevel == "HIGH" }
    val avgClv: Int
        get() {
            if (customers.isEmpty()) return 0
            return (customers.sumOf { (it.clvScore ?: 0).toDouble() } / customers.size).roundToInt()
        }

    fun segmentCount(s: String): Int = customers.count { it.segment == s }

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = crmUnwrap(
                AlmaApi.getObject(
                    "/api/customers",
                    mapOf(
                        "business_id" to CRM_BUSINESS_ID,
                        "segment" to segment,
                        "risk_level" to risk,
                        "search" to search.ifEmpty { null },
                    ),
                ),
            )
            customers = c.optJSONArray("customers")?.mapObjects { CrmCustomer.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Recent orders for the detail sheet — server-side search by phone digits
     *  (the orders search matches the phone column). */
    suspend fun recentOrders(phone: String?): List<CrmOrder> {
        if (phone.isNullOrEmpty()) return emptyList()
        return try {
            val c = crmUnwrap(
                AlmaApi.getObject(
                    "/api/orders/orders",
                    mapOf("business_id" to CRM_BUSINESS_ID, "search" to phone, "limit" to "10"),
                ),
            )
            c.optJSONArray("orders")?.mapObjects { CrmOrder.from(it) } ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrmScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { CrmState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<CrmCustomer?>(null) }
    var searchDebounce by remember { mutableStateOf<Job?>(null) }
    var syncing by remember { mutableStateOf(false) }
    var confirmingSync by remember { mutableStateOf(false) }
    var syncNote by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    /** Native "Sync from orders" — web syncFromOrders parity, POST /api/customers/backfill. */
    fun runSync() {
        if (syncing) return
        syncing = true
        scope.launch {
            try {
                val resp = AlmaApi.send(
                    "POST", "/api/customers/backfill",
                    JSONObject().put("business_id", CRM_BUSINESS_ID),
                )
                val data = resp.optJSONObject("data") ?: resp
                val err = data.str("error") ?: resp.str("error")
                if (err != null) {
                    syncNote = err
                } else {
                    syncNote = "Synced: ${data.flexInt("processed") ?: 0} processed, ${data.flexInt("created") ?: 0} new"
                    vm.load()
                }
            } catch (_: Exception) {
                syncNote = "Sync failed — আবার চেষ্টা করুন"
            } finally {
                syncing = false
            }
            delay(2600)
            syncNote = null
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // KPI bento board: lifetime-revenue dark hero + 2 accent tiles.
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 4.dp)) {
                CrmBentoHero(revenue = vm.totalRevenue, customers = vm.customers.size, vips = vm.vipCount)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CrmBentoStatTile(
                        label = "Avg CLV score", value = vm.avgClv, suffix = "/100",
                        sub = "কাস্টমার ভ্যালু", tint = CrmPalette.blue400, dark = dark,
                        modifier = Modifier.weight(1f),
                    )
                    CrmBentoStatTile(
                        label = "High risk", value = vm.highRiskCount, suffix = "",
                        sub = "ঝুঁকিপূর্ণ কাস্টমার", tint = CrmPalette.red400, dark = dark,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        item {
            // Segment tabs (web: All + the 6 segments, tap again to clear).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CrmChip("All", vm.customers.size, CrmPalette.coral, vm.segment == null, dark) {
                    vm.segment = null
                    scope.launch { vm.load() }
                }
                CRM_SEGMENTS.forEach { s ->
                    CrmChip(
                        if (s == "VIP") "✦ VIP" else s,
                        vm.segmentCount(s),
                        CrmPalette.segment(s, dark),
                        vm.segment == s,
                        dark,
                    ) {
                        vm.segment = if (vm.segment == s) null else s
                        scope.launch { vm.load() }
                    }
                }
            }
        }

        item {
            // Search (server-side, 450ms debounce) + risk filter menu.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("🔍", fontSize = 13.sp)
                    Box(Modifier.weight(1f)) {
                        if (vm.search.isEmpty()) {
                            Text(
                                "Search by name, phone, district…",
                                color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp,
                            )
                        }
                        BasicTextField(
                            value = vm.search,
                            onValueChange = { newValue ->
                                vm.search = newValue
                                searchDebounce?.cancel()
                                searchDebounce = scope.launch {
                                    delay(450)
                                    vm.load()
                                }
                            },
                            singleLine = true,
                            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Box {
                    var open by remember { mutableStateOf(false) }
                    Text(
                        vm.risk?.let { "⏳ ${it.lowercase().replaceFirstChar { c -> c.uppercase() }}" } ?: "⏳",
                        color = if (vm.risk == null) AlmaTheme.inkSecondary(dark)
                        else CrmPalette.risk(vm.risk, dark),
                        fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { open = true }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    )
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        DropdownMenuItem(text = { Text("All risk levels") }, onClick = {
                            open = false; vm.risk = null; scope.launch { vm.load() }
                        })
                        DropdownMenuItem(text = { Text("Low") }, onClick = {
                            open = false; vm.risk = "LOW"; scope.launch { vm.load() }
                        })
                        DropdownMenuItem(text = { Text("Medium") }, onClick = {
                            open = false; vm.risk = "MEDIUM"; scope.launch { vm.load() }
                        })
                        DropdownMenuItem(text = { Text("High") }, onClick = {
                            open = false; vm.risk = "HIGH"; scope.launch { vm.load() }
                        })
                    }
                }
            }
        }

        if (vm.authExpired) {
            item { CrmAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { item { CrmNotice("⚠️ $it", CrmPalette.red500, dark) } }
        syncNote?.let { item { CrmNotice(it, AlmaTheme.inkSecondary(dark), dark) } }

        if (vm.loading && vm.customers.isEmpty()) {
            items(6) { Box(Modifier.fillMaxWidth().height(72.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        items(vm.customers, key = { it.id }) { c ->
            CrmCustomerRow(c, dark) { selected = c }
        }

        if (!vm.loading && vm.customers.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("👥", fontSize = 34.sp)
                    Text("কোনো কাস্টমার পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    Text("অন্য ফিল্টার চেষ্টা করুন", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
            }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 6.dp)) {
                // Native "Sync from orders" — server enforces the SUPER_ADMIN gate.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { if (!syncing) confirmingSync = true }
                        .padding(vertical = 9.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (syncing) {
                        CircularProgressIndicator(Modifier.size(13.dp), color = CrmPalette.coral, strokeWidth = 2.dp)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        if (syncing) "Syncing…" else "⟳ Sync from orders",
                        color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                }
                Text(
                    "🌐 ওয়েব ভার্সন",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/crm", "CRM") }
                        .padding(vertical = 4.dp),
                )
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    selected?.let { c ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            CrmDetailSheet(c, vm, dark) { p, t -> selected = null; ctx.openWebForced(p, t) }
        }
    }

    if (confirmingSync) {
        AlertDialog(
            onDismissRequest = { confirmingSync = false },
            title = { Text("Orders থেকে customer profiles sync করবেন?") },
            confirmButton = {
                TextButton(onClick = { confirmingSync = false; runSync() }) { Text("হ্যাঁ, sync করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmingSync = false }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun CrmAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন",
            color = AlmaTheme.ink(dark), fontSize = 14.sp, textAlign = TextAlign.Center,
        )
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(CrmPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun CrmNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun CrmChip(
    label: String, count: Int, tint: Color, active: Boolean, dark: Boolean, onClick: () -> Unit,
) {
    Row(
        Modifier
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
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = if (active) tint else AlmaTheme.inkSecondary(dark),
            fontSize = 13.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        )
        if (count > 0) {
            Text("$count", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Count-up number (0 → target on appear) — iOS CrmCountUp twin. */
@Composable
private fun crmCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val v by animateFloatAsState(
        targetValue = if (started) target.toFloat() else 0f,
        animationSpec = tween(900),
        label = "crmCountUp",
    )
    return v.roundToInt()
}

/** The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe). */
@Composable
private fun CrmBentoHero(revenue: Int, customers: Int, vips: Int) {
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
            "লাইফটাইম রেভিনিউ · CRM",
            color = CrmPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            AlmaTheme.takaShort(crmCountUp(revenue)),
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace, maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "সব কাস্টমারের মোট কেনাকাটা",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            CrmHeroStat("CUSTOMERS", customers, Color.White, "মোট কাস্টমার")
            Box(
                Modifier.padding(horizontal = 14.dp, vertical = 2.dp).width(1.dp).height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            CrmHeroStat("VIP", vips, CrmPalette.goldLt, "টপ টিয়ার")
        }
    }
}

@Composable
private fun CrmHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        Text(
            "${crmCountUp(value)}",
            color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace,
        )
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Small glass stat tile — count-up value + sub line over a soft accent wash. */
@Composable
private fun CrmBentoStatTile(
    label: String, value: Int, suffix: String, sub: String, tint: Color, dark: Boolean, modifier: Modifier,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(
                    listOf(tint.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
                shape,
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text(
            "${crmCountUp(value)}$suffix",
            color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace, maxLines = 1,
        )
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Row (contacts-style: avatar · name · district/phone · orders + spent + CLV bar) ──

@Composable
private fun CrmCustomerRow(customer: CrmCustomer, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            // Web Avatar: initials circle — VIP wears the gold tint, others muted glass.
            val vip = customer.segment == "VIP"
            Text(
                CrmFormat.initials(customer.name),
                color = if (vip) CrmPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .size(36.dp)
                    .background(
                        if (vip) CrmPalette.coral.copy(alpha = 0.16f)
                        else AlmaTheme.ink(dark).copy(alpha = 0.06f),
                        CircleShape,
                    )
                    .border(
                        1.dp,
                        if (vip) CrmPalette.coral.copy(alpha = 0.35f)
                        else AlmaTheme.ink(dark).copy(alpha = 0.10f),
                        CircleShape,
                    )
                    .padding(top = 9.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    customer.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val bits = mutableListOf<String>()
                customer.district?.takeIf { it.isNotEmpty() }?.let(bits::add)
                customer.phone?.takeIf { it.isNotEmpty() }?.let(bits::add)
                customer.lastOrder?.takeIf { it.isNotEmpty() }?.let(bits::add)
                Text(
                    if (bits.isEmpty()) "—" else bits.joinToString(" · "),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    AlmaTheme.taka(customer.totalSpent ?: 0),
                    color = AlmaTheme.ink(dark), fontSize = 12.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(
                        "${customer.totalOrders ?: 0} orders",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                    CrmPill(customer.segment ?: "—", CrmPalette.segment(customer.segment, dark), small = true)
                }
            }
        }
        // Web ClvBar (row-level): thin track filled to the score, number at right.
        val score = (customer.clvScore ?: 0).coerceIn(0, 100)
        val tint = CrmPalette.clv(score, dark)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                Modifier.weight(1f).height(3.dp).clip(CircleShape)
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.08f)),
            ) {
                Box(
                    Modifier.fillMaxWidth(score / 100f).height(3.dp).clip(CircleShape).background(tint),
                )
            }
            Text(
                "$score",
                color = if (score > 60) CrmPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
                fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun CrmPill(label: String, tint: Color, small: Boolean = false) {
    Text(
        label,
        color = tint, fontSize = if (small) 9.sp else 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = if (small) 0.13f else 0.12f), CircleShape)
            .border(if (small) 0.8.dp else 1.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = if (small) 6.dp else 9.dp, vertical = if (small) 2.dp else 4.dp),
    )
}

// ── Detail sheet (web detail drawer parity) ────────────────────────────────────────

@Composable
private fun CrmDetailSheet(
    customer: CrmCustomer,
    vm: CrmState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    val context = LocalContext.current
    var recentOrders by remember(customer.id) { mutableStateOf(listOf<CrmOrder>()) }
    var ordersLoading by remember(customer.id) { mutableStateOf(true) }

    LaunchedEffect(customer.id) {
        recentOrders = vm.recentOrders(customer.phone)
        ordersLoading = false
    }

    /** Order-derived return insights — recomputed over the fetched rows (≤10). */
    val insights = remember(recentOrders) { CrmReturnInsights(recentOrders) }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // ── Header ──
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier
                    .size(44.dp)
                    .background(CrmPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, CrmPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    CrmFormat.initials(customer.name),
                    color = CrmPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(customer.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(
                    "${customer.id} · ${customer.district ?: "—"}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                )
            }
        }

        // ── Badges (segment · risk · return-risk escalation · WA opt-in) ──
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CrmPill(customer.segment ?: "—", CrmPalette.segment(customer.segment, dark))
            CrmPill(customer.riskLevel ?: "LOW", CrmPalette.risk(customer.riskLevel, dark))
            // Web escalation badge: order-derived HIGH, or MEDIUM while sheet says LOW,
            // or any returns exist at all.
            if (!ordersLoading && recentOrders.isNotEmpty()) {
                val escalated = insights.computedRisk == "HIGH" ||
                    (insights.computedRisk == "MEDIUM" && (customer.riskLevel ?: "LOW") == "LOW")
                if (escalated || insights.returnCount > 0) {
                    CrmPill(
                        "Return risk: ${insights.computedRisk}" +
                            (if (insights.returnsLast30Days > 0) " · ${insights.returnsLast30Days} in 30d" else ""),
                        if (insights.computedRisk == "HIGH") CrmPalette.red400 else CrmPalette.amber500,
                    )
                }
            }
            if (customer.waOptin == "Yes") CrmPill("WA Opt-in", CrmPalette.green400)
        }

        // ── Spend summary (web 2×2 grid: Spend / Profit / Delivered / Loyalty) ──
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CrmStatCell(
                    "Lifetime Spend", AlmaTheme.taka(customer.totalSpent ?: 0),
                    CrmPalette.accentText(dark), dark, Modifier.weight(1f),
                )
                CrmStatCell(
                    "Lifetime Profit", AlmaTheme.taka(customer.totalProfit ?: 0),
                    if ((customer.totalProfit ?: 0) >= 0) CrmPalette.green400 else CrmPalette.red400,
                    dark, Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CrmStatCell(
                    "Delivered", "${customer.delivered ?: 0}/${customer.totalOrders ?: 0}",
                    AlmaTheme.ink(dark), dark, Modifier.weight(1f),
                )
                CrmStatCell(
                    "Loyalty", "${customer.loyaltyPts ?: 0} pts",
                    CrmPalette.accentText(dark), dark, Modifier.weight(1f),
                )
            }
        }

        // ── Risk intelligence (web card: score bar + stat rows) ──
        val score = customer.riskScore ?: 0
        val scoreTint = when {
            score > 60 -> CrmPalette.red400
            score > 30 -> CrmPalette.amber500
            else -> CrmPalette.green400
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("RISK INTELLIGENCE", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row {
                Text("Risk Score", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                Spacer(Modifier.weight(1f))
                Text("$score/100", color = scoreTint, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            Box(
                Modifier.fillMaxWidth().height(5.dp).clip(CircleShape)
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.08f)),
            ) {
                Box(
                    Modifier.fillMaxWidth(score.coerceIn(0, 100) / 100f).height(5.dp)
                        .clip(CircleShape).background(scoreTint),
                )
            }
            CrmStatRow(
                "COD Fail Rate", CrmFormat.pct(customer.codFailPct),
                if ((customer.codFailPct ?: 0.0) > 0.5) CrmPalette.red400 else CrmPalette.green400, dark,
            )
            CrmStatRow(
                "Return Rate (sheet)", CrmFormat.pct(customer.returnRate),
                if ((customer.returnRate ?: 0.0) > 0.3) CrmPalette.red400 else CrmPalette.green400, dark,
            )
            if (!ordersLoading && recentOrders.isNotEmpty()) {
                CrmStatRow(
                    "Return Rate (orders)", "${insights.returnRatePct}%",
                    if (insights.returnRatePct > 30) CrmPalette.red400 else AlmaTheme.ink(dark), dark,
                )
                CrmStatRow(
                    "Return Loss (orders)", AlmaTheme.taka(insights.totalReturnLoss),
                    if (insights.totalReturnLoss > 0) CrmPalette.red400 else CrmPalette.green400, dark,
                )
            }
            CrmStatRow(
                "CLV Score", "${customer.clvScore ?: 0}/100",
                CrmPalette.clv(customer.clvScore ?: 0, dark), dark,
            )
            CrmStatRow(
                "Days Inactive", "${customer.daysInactive ?: 0}",
                if ((customer.daysInactive ?: 0) > 90) CrmPalette.amber500 else AlmaTheme.ink(dark), dark,
            )
        }

        // ── Recent orders (web block — loaded here by phone lookup) ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("RECENT ORDERS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            if (ordersLoading) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = CrmPalette.coral, strokeWidth = 2.dp)
                    Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            } else if (recentOrders.isEmpty()) {
                Text("কোনো অর্ডার পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            } else {
                recentOrders.forEach { o ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                o.id,
                                color = CrmPalette.accentText(dark), fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                            )
                            if (!o.date.isNullOrEmpty()) {
                                Text(o.date, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                            }
                        }
                        o.sellPrice?.let { amt ->
                            Text(
                                AlmaTheme.taka(amt),
                                color = AlmaTheme.ink(dark), fontSize = 11.sp,
                                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                            )
                        }
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                modifier = Modifier
                                    .background(o.tint.copy(alpha = 0.13f), CircleShape)
                                    .padding(horizontal = 7.dp, vertical = 3.dp),
                            ) {
                                Box(Modifier.size(6.dp).clip(CircleShape).background(o.tint))
                                Text(o.label, color = o.tint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                            }
                            // Web: returned rows carry their loss under the badge.
                            if (o.isReturn && o.returnLoss > 0) {
                                Text(
                                    "−${AlmaTheme.taka(o.returnLoss)}",
                                    color = CrmPalette.red400, fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Profile (web block) ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("PROFILE", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            CrmStatRow("Phone", customer.phone ?: "—", AlmaTheme.ink(dark), dark)
            CrmStatRow("Address", customer.address?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            CrmStatRow("Source", customer.source?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            CrmStatRow("Fav Cat.", customer.favCategory?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            CrmStatRow("Last Order", customer.lastOrder?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            if (!customer.notes.isNullOrEmpty()) {
                CrmStatRow("Notes", customer.notes, CrmPalette.amber500, dark)
            }
        }

        // ── Contact (call + WhatsApp, same 880 rule as the Orders screen) ──
        if (!customer.phone.isNullOrEmpty()) {
            val phone = customer.phone
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CrmContactButton("📞 Call", AlmaTheme.ink(dark), dark, Modifier.weight(1f)) {
                    try {
                        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")))
                    } catch (_: Exception) { }
                }
                customer.whatsappUrl?.let { wa ->
                    CrmContactButton("💬 WhatsApp", CrmPalette.emerald600, dark, Modifier.weight(1f)) {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(wa)))
                        } catch (_: Exception) { }
                    }
                }
            }
        }

        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/crm", "CRM") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun CrmStatCell(label: String, value: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(value, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1)
    }
}

@Composable
private fun CrmStatRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold,
            textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 20.dp),
        )
    }
}

@Composable
private fun CrmContactButton(label: String, tint: Color, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(Color.White.copy(alpha = if (dark) 0.08f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tint.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(vertical = 10.dp),
    )
}

// ── Formatting helpers ─────────────────────────────────────────────────────────────

private object CrmFormat {
    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** 0..1 ratio → "42%" (web pct()). */
    fun pct(ratio: Double?): String = "${((ratio ?: 0.0) * 100).roundToInt()}%"
}
