//
//  OrdersScreen.kt
//  ALMA ERP — the Orders tab, ported 1:1 from OrdersSwiftUI.swift (iOS build 66):
//  aurora background, frosted glass cards, the web's exact status-pill colours
//  (globals.css tone-*), date chips + native custom range, the bento dark hero
//  anchor (REVENUE count-up + PROFIT/ORDERS split), edge-to-edge status chip row,
//  debounced server search, channel/payment/sort menu, coral FAB, return-row
//  accents + long-press quick actions, and the FULL web-drawer-parity detail
//  sheet: profit/margin stats, restock + SLA banners, courier timeline with
//  tracking copy, invoice generate/copy/open/share, edit order, delete request
//  (Super Admin approval), returns with loss preview — role-gated exactly like
//  src/lib/order-access.ts.
//
//  Endpoints (same as web/iOS):
//    GET  /api/orders/orders?business_id=…&startDate=…&endDate=…  → list + summary
//    POST /api/orders/orders/status  {id, status, reason?}        → status change
//    GET  /api/users/me                                            → role gating
//    POST /api/invoice  {id, allow_regenerate}                     → invoice
//    POST /api/orders/orders/edit  {order_id, business_id, fields} → edit
//    POST /api/orders/orders/delete-request  {order_id, …, reason} → delete request
//

package com.almatraders.erp.pages

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateIntAsState
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Model (snake_case API fields, defensively decoded — iOS AlmaOrder twin) ────────

data class AlmaOrder(
    val id: String,
    val date: String?,
    val customer: String?,
    val phone: String?,
    val address: String?,
    var status: String,
    val product: String?,
    val category: String?,
    val size: String?,
    val qty: Int?,
    val unitPrice: Int?,
    val sellPrice: Int?,
    val shippingFee: Int?,
    val discount: Int?,
    val payment: String?,
    val source: String?,
    val courier: String?,
    val trackingId: String?,
    val notes: String?,
    val profit: Int?,
    // Detail-drawer parity fields (all optional — legacy rows may omit any of them).
    val businessId: String?,
    val handledBy: String?,
    val slaStatus: String?,
    val invoiceNum: String?,
    val courierCharge: Int?,
    val netProfit: Int?,
    val returnNetProfit: Int?,
    val estimatedProfit: Int?,
    val stockRestored: Boolean?,
    val stockRestoredAt: String?,
) {
    companion object {
        fun from(o: JSONObject): AlmaOrder? {
            val id = o.str("id") ?: return null
            return AlmaOrder(
                id = id,
                date = o.str("date"),
                customer = o.str("customer"),
                phone = o.str("phone"),
                address = o.str("address"),
                status = o.str("status") ?: "Pending",
                product = o.str("product"),
                category = o.str("category"),
                size = o.str("size"),
                qty = o.flexInt("qty"),
                unitPrice = o.flexInt("unit_price"),
                sellPrice = o.flexInt("sell_price"),
                shippingFee = o.flexInt("shipping_fee"),
                discount = o.flexInt("discount"),
                payment = o.str("payment"),
                source = o.str("source"),
                courier = o.str("courier"),
                trackingId = o.str("tracking_id"),
                notes = o.str("notes"),
                profit = o.flexInt("profit"),
                businessId = o.str("business_id"),
                handledBy = o.str("handled_by"),
                slaStatus = o.str("sla_status"),
                invoiceNum = o.str("invoice_num"),
                courierCharge = o.flexInt("courier_charge"),
                netProfit = o.flexInt("net_profit"),
                returnNetProfit = o.flexInt("return_net_profit"),
                // These three ride the wire camelCase (iOS CodingKeys parity).
                estimatedProfit = o.flexInt("estimatedProfit"),
                stockRestored = o.flexBool("stockRestored"),
                stockRestoredAt = o.str("stockRestoredAt"),
            )
        }
    }
}

// ── Status presentation (exact wire values + web tone-* hexes, iOS twin) ───────────

object OrderStatusMeta {
    val filterable = listOf(
        "Pending", "Confirmed", "Packed", "Shipped", "Delivered",
        "RETURNED_PAID", "RETURNED_UNPAID", "CANCELLED",
    )

    fun nextSteps(status: String): List<String> = when (status) {
        "Pending" -> listOf("Confirmed", "Packed")
        "Confirmed" -> listOf("Packed", "Shipped")
        "Packed" -> listOf("Shipped", "Delivered")
        "Shipped" -> listOf("Delivered", "RETURNED_UNPAID")
        else -> emptyList()
    }

    fun isTerminal(s: String) = s in setOf(
        "Delivered", "CANCELLED", "RETURNED", "RETURNED_PAID", "RETURNED_UNPAID",
        "Cancelled", "Returned",
    )

    fun label(s: String): String = when (s) {
        "RETURNED_PAID" -> "Returned (paid)"
        "RETURNED_UNPAID" -> "Returned (unpaid)"
        "RETURNED" -> "Returned"
        "CANCELLED", "Cancelled" -> "Cancelled"
        else -> s
    }

    fun tint(s: String): Color = when (s) {
        "Pending" -> Color(0xFFF59E0B)       // amber
        "Confirmed" -> Color(0xFFA855F7)     // purple
        "Packed" -> Color(0xFF06B6D4)        // cyan
        "Shipped" -> Color(0xFF3B82F6)       // blue
        "Delivered" -> Color(0xFF22C55E)     // green
        "CANCELLED", "Cancelled" -> Color(0xFF94A3B8) // slate
        "RETURNED_PAID" -> Color(0xFFF59E0B) // amber (web: paid=amber)
        else -> Color(0xFFEF4444)            // red
    }

    fun paymentTint(p: String): Color = when (p) {
        "bKash" -> Color(0xFFEC4899)
        "Nagad" -> Color(0xFFF97316)
        "COD" -> Color(0xFFF59E0B)
        else -> Color(0xFF3B82F6)
    }

    /** Courier progress timeline — port of the web's COURIER_STEPS (utils.ts).
     *  (label, done, active) per step for the given status. */
    fun courierSteps(status: String): List<Triple<String, Boolean, Boolean>> = when (status) {
        "Pending" -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", false, true),
            Triple("Packed", false, false), Triple("Shipped", false, false), Triple("Delivered", false, false),
        )
        "Confirmed" -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", true, false),
            Triple("Packed", false, true), Triple("Shipped", false, false), Triple("Delivered", false, false),
        )
        "Packed" -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", true, false),
            Triple("Packed", true, false), Triple("Shipped", false, true), Triple("Delivered", false, false),
        )
        "Shipped" -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", true, false),
            Triple("Packed", true, false), Triple("Shipped", true, true), Triple("Delivered", false, false),
        )
        "Delivered" -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", true, false),
            Triple("Packed", true, false), Triple("Shipped", true, false), Triple("Delivered", true, false),
        )
        "Returned", "RETURNED" -> listOf(
            Triple("Placed", true, false), Triple("Shipped", true, false), Triple("Returned", true, false),
        )
        "RETURNED_PAID" -> listOf(
            Triple("Placed", true, false), Triple("Shipped", true, false), Triple("Returned (paid)", true, false),
        )
        "RETURNED_UNPAID" -> listOf(
            Triple("Placed", true, false), Triple("Shipped", true, false), Triple("Returned (refused)", true, false),
        )
        "CANCELLED", "Cancelled" -> listOf(
            Triple("Placed", true, false), Triple("Cancelled", true, false),
        )
        else -> listOf(
            Triple("Placed", true, false), Triple("Confirmed", false, true),
            Triple("Packed", false, false), Triple("Shipped", false, false), Triple("Delivered", false, false),
        )
    }

    /** Destructive-status confirm copy — port of the web's DESTRUCTIVE_STATUS_META. */
    fun destructiveMeta(s: String): Pair<String, String> = when (s) {
        "RETURNED_PAID" -> Pair(
            "Mark returned (paid delivery)?",
            "Customer refused the product but paid delivery. Inventory will be marked for restock.",
        )
        "RETURNED_UNPAID" -> Pair(
            "Mark returned (refused)?",
            "Customer refused everything. Inventory will be marked for restock.",
        )
        else -> Pair(
            "Cancel order?",
            "This excludes the order from revenue and prevents commission generation.",
        )
    }
}

// ── Current user identity (role gating — same rules as the web drawer) ─────────────

/** GET /api/users/me → { user: { id, role } }, cached for the app run. The web drawer
 *  gates Edit / Request-delete / Invoice / status buttons by role (order-access.ts)
 *  — the native sheet applies the SAME rules so both surfaces agree. */
private object OrdIdentity {
    data class Me(val id: String?, val role: String?)

    @Volatile var cached: Me? = null
        private set

    suspend fun load(): Me? {
        cached?.let { return it }
        return try {
            val user = AlmaApi.getObject("/api/users/me").optJSONObject("user")
            val me = Me(user?.str("id"), user?.str("role"))
            if (me.id != null || me.role != null) cached = me
            me
        } catch (_: Exception) {
            null
        }
    }

    // ── Role rules (port of src/lib/roles.ts + order-access.ts) ──
    fun mayAdvance(role: String?) = role == "SUPER_ADMIN" || role == "ADMIN"   // ordersAdvanceStatus
    fun mayInvoice(role: String?) = role == "SUPER_ADMIN" || role == "ADMIN"   // ordersGenerateInvoice
    fun mayRequestDelete(role: String?) = role != null && role != "VIEWER"

    /** Staff may edit their own order while it is still early in fulfillment. */
    fun mayEdit(role: String?, userId: String?, order: AlmaOrder): Boolean {
        role ?: return false
        if (OrderStatusMeta.isTerminal(order.status)) return false
        if (role == "SUPER_ADMIN" || role == "ADMIN") return true              // ordersEditField
        if (role == "VIEWER") return false
        val handledBy = order.handledBy ?: return false
        userId ?: return false
        // handled_by convention: "Name (uuid)" — creator match on the trailing id.
        val open = handledBy.lastIndexOf('(')
        val close = handledBy.lastIndexOf(')')
        if (open < 0 || close < 0 || open >= close) return false
        val creator = handledBy.substring(open + 1, close)
        if (!creator.equals(userId, ignoreCase = true)) return false
        return order.status in listOf("Pending", "Confirmed", "Packed")
    }
}

// ── Date filter (Asia/Dhaka business day, web parity) ──────────────────────────────

sealed class OrdersDateFilter {
    object Today : OrdersDateFilter()
    object Yesterday : OrdersDateFilter()
    object Last7 : OrdersDateFilter()
    object Last30 : OrdersDateFilter()
    object ThisMonth : OrdersDateFilter()
    object LastMonth : OrdersDateFilter()
    data class Custom(val start: Long, val end: Long) : OrdersDateFilter()

    val label: String
        get() = when (this) {
            Today -> "Today"; Yesterday -> "Yesterday"; Last7 -> "Last 7 days"
            Last30 -> "Last 30 days"; ThisMonth -> "This month"; LastMonth -> "Last month"
            is Custom -> "কাস্টম"
        }

    /** (startDate, endDate) as YYYY-MM-DD in Asia/Dhaka. */
    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = tz }
        val cal = Calendar.getInstance(tz)
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val today = cal.time
        fun d(x: Date) = fmt.format(x)
        fun shift(days: Int): Date {
            val c = cal.clone() as Calendar; c.add(Calendar.DAY_OF_YEAR, days); return c.time
        }
        return when (this) {
            Today -> d(today) to d(today)
            Yesterday -> d(shift(-1)) to d(shift(-1))
            Last7 -> d(shift(-6)) to d(today)
            Last30 -> d(shift(-29)) to d(today)
            ThisMonth -> {
                val c = cal.clone() as Calendar; c.set(Calendar.DAY_OF_MONTH, 1)
                d(c.time) to d(today)
            }
            LastMonth -> {
                val first = cal.clone() as Calendar; first.set(Calendar.DAY_OF_MONTH, 1)
                val firstLast = first.clone() as Calendar; firstLast.add(Calendar.MONTH, -1)
                val endLast = first.clone() as Calendar; endLast.add(Calendar.DAY_OF_YEAR, -1)
                d(firstLast.time) to d(endLast.time)
            }
            is Custom -> {
                val s = Date(minOf(start, end)); val e = Date(maxOf(start, end))
                d(s) to d(e)
            }
        }
    }

    companion object {
        // Getter, not a stored val: the companion initializes BEFORE the nested objects
        // during class-load, so a stored list would capture nulls (crash on first render).
        val presets get() = listOf(Today, Yesterday, Last7, Last30, ThisMonth, LastMonth)
    }
}

// ── State holder (iOS OrdersVM twin) ───────────────────────────────────────────────

class OrdersState {
    var allOrders by mutableStateOf(listOf<AlmaOrder>())
    var orders by mutableStateOf(listOf<AlmaOrder>())
    var byStatus by mutableStateOf(mapOf<String, Int>())
    var windowCount by mutableStateOf(0)
    var total by mutableStateOf(0)
    var revenue by mutableStateOf(0)
    var profit by mutableStateOf(0)
    var statusFilter by mutableStateOf<String?>(null)
    var dateFilter by mutableStateOf<OrdersDateFilter>(OrdersDateFilter.Last30)
    var payment by mutableStateOf<String?>(null)
    var source by mutableStateOf<String?>(null)
    var sort by mutableStateOf("newest")
    var search by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    companion object {
        const val RETURNS_SENTINEL = "__RETURNS__"
        val returnStatuses = setOf("RETURNED", "RETURNED_PAID", "RETURNED_UNPAID")
    }

    suspend fun load() {
        loading = true
        error = null
        try {
            val (start, end) = dateFilter.range()
            // ALWAYS fetch the whole window (no server status filter) so chip counts and
            // the visible list share one source of truth — iOS owner-bug fix 2026-07-06.
            val resp = AlmaApi.getObject(
                "/api/orders/orders",
                mapOf(
                    "business_id" to "ALMA_LIFESTYLE",
                    "payment" to payment,
                    "source" to source,
                    "startDate" to start,
                    "endDate" to end,
                    "search" to search.ifBlank { null },
                    "limit" to "500",
                ),
            )
            var list = resp.optJSONArray("orders")?.mapObjects { AlmaOrder.from(it) } ?: emptyList()
            when (sort) {
                "oldest" -> list = list.reversed()
                "price" -> list = list.sortedByDescending { it.sellPrice ?: 0 }
                "profit" -> list = list.sortedByDescending { it.profit ?: 0 }
            }
            allOrders = list
            applyFilter()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Local re-derive — chip taps are instant and counts always match the rows. */
    fun applyFilter() {
        val counts = HashMap<String, Int>()
        allOrders.forEach { counts[it.status] = (counts[it.status] ?: 0) + 1 }
        byStatus = counts
        windowCount = allOrders.size

        val visible = when {
            statusFilter == RETURNS_SENTINEL -> allOrders.filter { it.status in returnStatuses }
            statusFilter != null -> allOrders.filter { it.status == statusFilter }
            else -> allOrders
        }
        orders = visible
        total = visible.size
        revenue = visible.sumOf { if (it.status == "Delivered") (it.sellPrice ?: 0) else 0 }
        profit = visible.sumOf { if (it.status == "Delivered") (it.profit ?: 0) else 0 }
    }

    /** Optimistic status change with rollback (web drawer behaviour). */
    suspend fun setStatus(order: AlmaOrder, to: String, reason: String? = null): Boolean {
        val old = order.status
        allOrders = allOrders.map { if (it.id == order.id) it.copy(status = to) else it }
        applyFilter()
        return try {
            val body = JSONObject().put("id", order.id).put("status", to)
            if (reason != null) body.put("reason", reason)
            AlmaApi.send("POST", "/api/orders/orders/status", body)
            load() // refresh counts + row (server may cascade fields)
            true
        } catch (e: Exception) {
            allOrders = allOrders.map { if (it.id == order.id) it.copy(status = old) else it }
            applyFilter()
            error = e.message
            false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { OrdersState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<AlmaOrder?>(null) }
    var showCustomDates by remember { mutableStateOf(false) }
    var searchDebounce by remember { mutableStateOf<Job?>(null) }

    // Reload on first show AND whenever the native create form lands a new order.
    LaunchedEffect(OrdersRefreshBus.tick) { vm.load() }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { DateRow(vm, dark, scope) { showCustomDates = true } }
            // Bento dark hero anchor (Dashboard board language, owner spec 2026-07-08).
            item { BentoHeroCard(vm.revenue, vm.profit, vm.total) }
            item { ChipsRow(vm, dark) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SearchField(vm, dark, Modifier.weight(1f)) {
                        searchDebounce?.cancel()
                        searchDebounce = scope.launch {
                            delay(450)
                            vm.load()
                        }
                    }
                    FilterMenuButton(vm, dark, scope)
                }
            }
            if (vm.authExpired) {
                item { AuthExpiredCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { err ->
                item { ErrorCard(err, dark) }
            }
            if (vm.loading && vm.orders.isEmpty()) {
                items(6) {
                    Box(Modifier.fillMaxWidth().height(92.dp).almaGlass(dark, AlmaTheme.R_CARD))
                }
            }
            items(vm.orders, key = { it.id }) { order ->
                OrderCard(order, dark, onClick = { selected = order })
            }
            if (!vm.loading && vm.orders.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Text(
                        "কোনো অর্ডার নেই",
                        color = AlmaTheme.inkSecondary(dark),
                        modifier = Modifier.fillMaxWidth().padding(top = 60.dp),
                        fontSize = 15.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            item { Spacer(Modifier.height(70.dp)) }
        }

        // Coral "নতুন অর্ডার" FAB — opens the NATIVE order form (web form reachable inside it).
        Row(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 12.dp)
                .background(AlmaTheme.coral, CircleShape)
                .plainClick { ctx.openSmart("/orders/new", "নতুন অর্ডার") }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Add, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("নতুন অর্ডার", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    selected?.let { order ->
        ModalBottomSheet(
            onDismissRequest = { selected = null },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            OrderDetailSheet(order, vm, dark, openWeb = { p, t ->
                selected = null
                ctx.openWebForced(p, t)
            })
        }
    }

    if (showCustomDates) {
        val state = rememberDatePickerState()
        var startMs by remember { mutableStateOf<Long?>(null) }
        DatePickerDialog(
            onDismissRequest = { showCustomDates = false },
            confirmButton = {
                TextButton(onClick = {
                    val picked = state.selectedDateMillis ?: return@TextButton
                    if (startMs == null) {
                        startMs = picked // first pick = start; dialog stays for the end date
                    } else {
                        vm.dateFilter = OrdersDateFilter.Custom(startMs!!, picked)
                        showCustomDates = false
                        scope.launch { vm.load() }
                    }
                }) { Text(if (startMs == null) "শুরু ✓" else "দেখাও") }
            },
            dismissButton = {
                TextButton(onClick = { showCustomDates = false }) { Text("বাতিল") }
            },
        ) {
            DatePicker(state = state, title = {
                Text(
                    if (startMs == null) "শুরুর তারিখ" else "শেষ তারিখ",
                    modifier = Modifier.padding(16.dp),
                )
            })
        }
    }
}

// ── Header rows ────────────────────────────────────────────────────────────────────

@Composable
private fun DateRow(
    vm: OrdersState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onCustom: () -> Unit,
) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OrdersDateFilter.presets.forEach { f ->
            ThemeChip(
                label = f.label,
                active = vm.dateFilter == f,
                tint = AlmaTheme.coral,
                dark = dark,
            ) {
                vm.dateFilter = f
                scope.launch { vm.load() }
            }
        }
        val isCustom = vm.dateFilter is OrdersDateFilter.Custom
        val customLabel = if (isCustom) {
            val (s, e) = vm.dateFilter.range(); "$s → $e"
        } else "কাস্টম তারিখ"
        ThemeChip(customLabel, isCustom, AlmaTheme.violet, dark, onClick = onCustom)
    }
}

// ── Bento hero (iOS OrdBentoHeroCard — deliberately dark in BOTH schemes) ──────────

/** Count-up number: 0 → target on first show, old → new on refresh (iOS OrdCountUp). */
@Composable
private fun countUpValue(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    val v by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(durationMillis = 900),
        label = "ordCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    return v
}

@Composable
private fun BentoHeroCard(revenue: Int, profit: Int, orders: Int) {
    val goldLt = Color(0xFFF4A28C)     // #F4A28C
    val green400 = Color(0xFF4ADE80)   // #4ADE80
    val red500 = Color(0xFFEF4444)     // #EF4444
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    val rev = countUpValue(revenue)
    val pf = countUpValue(profit)
    val ords = countUpValue(orders)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            // Dark hero recipe: deep indigo base + violet/coral washes + a sage hint.
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
            "মোট আয় · REVENUE",
            color = goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            AlmaTheme.takaShort(rev),
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.ExtraBold,
            maxLines = 1, modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "ডেলিভারড বিক্রি — এই ফিল্টারে",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.Top) {
            HeroStat(
                "PROFIT", AlmaTheme.takaShort(pf),
                if (profit >= 0) green400 else red500, "ডেলিভারড মুনাফা",
            )
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp).height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            HeroStat("ORDERS", "$ords", Color.White, "এই ফিল্টারে")
        }
    }
}

@Composable
private fun HeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label, color = Color.White.copy(alpha = 0.55f),
            fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun ChipsRow(vm: OrdersState, dark: Boolean) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusChip(vm, dark, null, "All", vm.windowCount)
        StatusChip(
            vm, dark, OrdersState.RETURNS_SENTINEL, "All Returns",
            OrdersState.returnStatuses.sumOf { vm.byStatus[it] ?: 0 },
        )
        OrderStatusMeta.filterable.forEach { s ->
            StatusChip(vm, dark, s, OrderStatusMeta.label(s), vm.byStatus[s] ?: 0)
        }
    }
}

@Composable
private fun StatusChip(vm: OrdersState, dark: Boolean, status: String?, label: String, count: Int) {
    val active = vm.statusFilter == status
    val tint = status?.let { if (it == OrdersState.RETURNS_SENTINEL) Color(0xFFEF4444) else OrderStatusMeta.tint(it) }
        ?: AlmaTheme.coral
    Row(
        Modifier
            .background(
                if (active) tint.copy(alpha = if (dark) 0.28f else 0.16f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .plainClick {
                vm.statusFilter = status
                vm.applyFilter()
            }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (status != null && status != OrdersState.RETURNS_SENTINEL) {
            Box(Modifier.size(7.dp).background(OrderStatusMeta.tint(status), CircleShape))
        }
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

@Composable
private fun ThemeChip(label: String, active: Boolean, tint: Color, dark: Boolean, onClick: () -> Unit) {
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
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun SearchField(vm: OrdersState, dark: Boolean, modifier: Modifier, onChanged: () -> Unit) {
    Row(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        BasicTextField(
            value = vm.search,
            onValueChange = {
                vm.search = it
                onChanged()
            },
            singleLine = true,
            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            decorationBox = { inner ->
                Box {
                    if (vm.search.isEmpty()) {
                        Text("Search orders, customers…", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                    }
                    inner()
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun FilterMenuButton(vm: OrdersState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .size(42.dp)
                .almaGlass(dark, AlmaTheme.R_CONTROL)
                .plainClick { open = true },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.FilterList, contentDescription = "Filter", tint = AlmaTheme.violet)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Text("Channel", fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
            (listOf(null to "All channels") + listOf("Facebook", "WhatsApp", "Instagram", "Website").map { it to it!! })
                .forEach { (v, label) ->
                    DropdownMenuItem(
                        text = { Text((if (vm.source == v) "✓ " else "") + label) },
                        onClick = {
                            vm.source = v
                            scope.launch { vm.load() }
                        },
                    )
                }
            Text("Payment", fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
            (listOf(null to "All payments") + listOf("COD", "bKash", "Nagad").map { it to it!! })
                .forEach { (v, label) ->
                    DropdownMenuItem(
                        text = { Text((if (vm.payment == v) "✓ " else "") + label) },
                        onClick = {
                            vm.payment = v
                            scope.launch { vm.load() }
                        },
                    )
                }
            Text("Sort", fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
            listOf("newest" to "Newest", "oldest" to "Oldest", "price" to "Price", "profit" to "Profit")
                .forEach { (v, label) ->
                    DropdownMenuItem(
                        text = { Text((if (vm.sort == v) "✓ " else "") + label) },
                        onClick = {
                            vm.sort = v
                            open = false
                            scope.launch { vm.load() }
                        },
                    )
                }
        }
    }
}

// ── Cards ──────────────────────────────────────────────────────────────────────────

/** Same phone normalization as the detail sheet's WhatsApp button:
 *  local 0XXXXXXXXXX → wa.me/880XXXXXXXXXX. */
private fun whatsAppUrl(phone: String): String? {
    val trimmed = phone.trim()
    if (trimmed.isEmpty()) return null
    val msisdn = if (trimmed.startsWith("0")) "880${trimmed.drop(1)}" else trimmed
    return "https://wa.me/$msisdn"
}

/** Port of the web's orderRowAccentClass: amber for RETURNED_PAID,
 *  red for RETURNED_UNPAID / RETURNED, nothing otherwise. (bar, wash) */
private fun returnAccent(status: String): Pair<Color, Color>? {
    val key = status.trim().uppercase().replace(" ", "_")
    val amber = Color(0xFFF59E0B) // palette tone-amber
    val red = Color(0xFFEF4444)   // palette tone-red
    if (key == "RETURNED_PAID") return amber to amber.copy(alpha = 0.04f)
    if (key == "RETURNED_UNPAID" || key == "RETURNED") return red to red.copy(alpha = 0.05f)
    return null
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun OrderCard(order: AlmaOrder, dark: Boolean, onClick: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var menuOpen by remember { mutableStateOf(false) }
    val accent = returnAccent(order.status)
    Box(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CARD)
                .let { m -> if (accent != null) m.background(accent.second) else m }
                .combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onClick,
                    onLongClick = { menuOpen = true },
                )
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.id, color = AlmaTheme.coral, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                if (!order.date.isNullOrEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text(order.date, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
                Spacer(Modifier.weight(1f))
                StatusPill(order.status, dark)
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text(order.customer ?: "—", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                order.sellPrice?.let {
                    Text(AlmaTheme.taka(it), color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    productLine(order),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                order.payment?.takeIf { it.isNotEmpty() }?.let { p ->
                    Text(
                        p,
                        color = OrderStatusMeta.paymentTint(p),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .background(OrderStatusMeta.paymentTint(p).copy(alpha = 0.13f), CircleShape)
                            .padding(horizontal = 7.dp, vertical = 3.dp),
                    )
                }
                order.courier?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            }
        }
        // Web parity: orderRowAccentClass — returned rows carry a coloured left border.
        if (accent != null) {
            Box(
                Modifier.matchParentSize().padding(vertical = 6.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(
                    Modifier
                        .fillMaxHeight()
                        .width(3.dp)
                        .background(accent.first.copy(alpha = 0.8f), CircleShape),
                )
            }
        }
        // Web parity: long-press quick actions (mobile context menu on orders/page.tsx) —
        // view / copy order-# / WhatsApp the customer.
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text("বিস্তারিত") },
                onClick = { menuOpen = false; onClick() },
            )
            DropdownMenuItem(
                text = { Text("অর্ডার নম্বর কপি") },
                onClick = {
                    clipboard.setText(AnnotatedString(order.id))
                    menuOpen = false
                },
            )
            order.phone?.let { whatsAppUrl(it) }?.let { wa ->
                DropdownMenuItem(
                    text = { Text("WhatsApp") },
                    onClick = {
                        menuOpen = false
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(wa)))
                        } catch (_: Exception) { }
                    },
                )
            }
        }
    }
}

private fun productLine(order: AlmaOrder): String {
    val bits = mutableListOf<String>()
    order.product?.takeIf { it.isNotEmpty() }?.let(bits::add)
    order.size?.takeIf { it.isNotEmpty() }?.let { bits.add("Size $it") }
    order.qty?.takeIf { it > 1 }?.let { bits.add("×$it") }
    return if (bits.isEmpty()) "—" else bits.joinToString(" · ")
}

@Composable
private fun StatusPill(status: String, dark: Boolean) {
    val tint = OrderStatusMeta.tint(status)
    Row(
        Modifier
            .background(tint.copy(alpha = 0.14f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(Modifier.size(6.dp).background(tint, CircleShape))
        Text(OrderStatusMeta.label(status), color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun AuthExpiredCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন",
            color = AlmaTheme.ink(dark), fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )
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

@Composable
private fun ErrorCard(message: String, dark: Boolean) {
    Text(
        "⚠ $message",
        color = AlmaTheme.red(dark), fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, 12).padding(12.dp),
    )
}

// ── Detail sheet (v2 — FULL web-drawer parity, iOS OrderDetailSheet twin) ──────────

/** Total / Profit / Margin presentation — port of the web drawer's profitDisplay. */
private class OrdProfitDisplay(
    val label: String,
    val amount: Int,
    val detail: String,
    val tone: Color,
    val marginLabel: String,
    val marginValue: String,
)

private fun profitDisplay(live: AlmaOrder, dark: Boolean): OrdProfitDisplay {
    val sell = live.sellPrice ?: 0
    val shipping = live.shippingFee ?: 0
    val roundTrip = 2 * (live.courierCharge ?: 0)
    val green = Color(0xFF22C55E)
    val amber = Color(0xFFF59E0B)
    val red = Color(0xFFEF4444)
    return when (live.status) {
        "Delivered" -> {
            val amount = live.netProfit ?: live.profit ?: 0
            val margin = if (sell > 0) Math.round(amount.toDouble() / sell * 100).toInt() else 0
            OrdProfitDisplay("Profit", amount, "Margin $margin% (incl. shipping)", green, "Margin", "$margin%")
        }
        "RETURNED_PAID" -> {
            val net = live.returnNetProfit ?: (shipping - roundTrip)
            val loss = if (net < 0) -net else 0
            OrdProfitDisplay(
                "Return loss", -loss,
                "Customer paid ${AlmaTheme.taka(shipping)}, courier round-trip ${AlmaTheme.taka(roundTrip)}",
                amber, "Net", AlmaTheme.taka(net),
            )
        }
        "RETURNED_UNPAID", "RETURNED", "Returned" -> {
            val net = live.returnNetProfit ?: -roundTrip
            OrdProfitDisplay("Return loss", net, "Refused: full courier loss", red, "Net", AlmaTheme.taka(net))
        }
        "CANCELLED", "Cancelled" ->
            OrdProfitDisplay("Profit", 0, "No financial impact", AlmaTheme.inkSecondary(dark), "Margin", "—")
        else -> {
            val est = live.estimatedProfit ?: live.profit ?: 0
            val margin = if (sell > 0) "${Math.round(est.toDouble() / sell * 100).toInt()}%" else "—"
            OrdProfitDisplay("Est. profit", est, "Estimated", amber, "Margin", margin)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrderDetailSheet(
    order: AlmaOrder,
    vm: OrdersState,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()

    // Live copy — vm.orders is refreshed after actions; fall back to the passed order.
    val live = vm.orders.firstOrNull { it.id == order.id }
        ?: vm.allOrders.firstOrNull { it.id == order.id }
        ?: order

    var busy by remember { mutableStateOf(false) }

    // Role gating (same rules as the web drawer — src/lib/order-access.ts).
    var role by remember { mutableStateOf(OrdIdentity.cached?.role) }
    var userId by remember { mutableStateOf(OrdIdentity.cached?.id) }

    // Destructive-status confirm (CANCELLED / RETURNED_PAID / RETURNED_UNPAID) + reason.
    var confirmStatus by remember { mutableStateOf<String?>(null) }
    var returnReason by remember { mutableStateOf("") }

    // Edit / delete-request sub-sheets.
    var showEdit by remember { mutableStateOf(false) }
    var showDeleteRequest by remember { mutableStateOf(false) }

    // Invoice generation state.
    var invBusy by remember { mutableStateOf(false) }
    var invoiceReady by remember { mutableStateOf(order.invoiceNum?.isNotEmpty() == true) }
    var invoiceToast by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (role == null) {
            OrdIdentity.load()?.let { role = it.role; userId = it.id }
        }
    }
    LaunchedEffect(live.invoiceNum) {
        if (live.invoiceNum?.isNotEmpty() == true) invoiceReady = true
    }

    val isReturnTerminal = live.status in setOf("RETURNED", "RETURNED_PAID", "RETURNED_UNPAID", "Returned")
    val isCancelled = live.status in setOf("CANCELLED", "Cancelled")
    val mayAdvance = OrdIdentity.mayAdvance(role)
    val mayEdit = OrdIdentity.mayEdit(role, userId, live)
    val mayRequestDelete = OrdIdentity.mayRequestDelete(role)
    val mayInvoice = OrdIdentity.mayInvoice(role)
    val canCancel = mayAdvance && !OrderStatusMeta.isTerminal(live.status)
    val canReturn = mayAdvance && !isReturnTerminal && !isCancelled &&
        live.status in setOf("Delivered", "Shipped")
    val invoiceShareURL = "/invoice/share/alma-${live.id}"
    val hasInvoice = live.invoiceNum?.isNotEmpty() == true

    fun generateInvoice() {
        scope.launch {
            invBusy = true
            try {
                val r = AlmaApi.send(
                    "POST", "/api/invoice",
                    JSONObject().put("id", live.id).put("allow_regenerate", false),
                )
                if (r.flexBool("ok") != false) {
                    invoiceReady = true
                    val num = r.str("invoice_number") ?: ""
                    invoiceToast = if (r.flexBool("duplicate") == true) {
                        "Invoice $num already on file — link ready"
                    } else {
                        "Invoice $num saved — link ready"
                    }
                    vm.load() // picks up invoice_num on the row
                } else {
                    invoiceToast = "Invoice was not created"
                }
            } catch (e: Exception) {
                invoiceToast = e.message
            } finally {
                invBusy = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // ── Header ──
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text(live.id, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                live.date?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp) }
            }
            Spacer(Modifier.weight(1f))
            StatusPill(live.status, dark)
        }

        // ── Total / Profit / Margin (web drawer's profitDisplay) ──
        val p = profitDisplay(live, dark)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatTile("Total", AlmaTheme.taka(live.sellPrice ?: 0), AlmaTheme.ink(dark), dark, Modifier.weight(1f))
            StatTile(p.label, AlmaTheme.taka(p.amount), p.tone, dark, Modifier.weight(1f), caption = p.detail)
            StatTile(p.marginLabel, p.marginValue, p.tone, dark, Modifier.weight(1f))
        }

        // ── Restock banner (returned rows) ──
        if (isReturnTerminal) {
            val restored = live.stockRestored == true
            val whenDate = live.stockRestoredAt?.take(10) ?: ""
            val text = if (restored) {
                if (whenDate.isEmpty()) "✓ Inventory restored" else "✓ Inventory restored on $whenDate"
            } else "⚠ Inventory not restored"
            TintBanner(text, if (restored) Color(0xFF22C55E) else Color(0xFFF59E0B))
        }

        // ── Info grid ──
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow("👤", live.customer, dark)
            InfoRow("📞", live.phone, dark)
            InfoRow("📍", live.address, dark)
            InfoRow("📦", productLine(live), dark)
            live.category?.takeIf { it.isNotEmpty() }?.let { InfoRow("🏷", it, dark) }
            if (live.qty != null && live.unitPrice != null) {
                InfoRow("✖", "${live.qty} × ${AlmaTheme.taka(live.unitPrice)}", dark)
            }
            live.sellPrice?.let { InfoRow("💳", "${AlmaTheme.taka(it)}  (${live.payment ?: "—"})", dark) }
            live.source?.takeIf { it.isNotEmpty() }?.let { InfoRow("📡", it, dark) }
            live.handledBy?.takeIf { it.isNotEmpty() }?.let { InfoRow("🛡", it, dark) }
            // Multi-item orders carry machine JSON in notes (ORDER_ITEMS_JSON…) — that's
            // internal bookkeeping, never show it. Only human-written notes render.
            live.notes?.takeIf {
                it.isNotEmpty() && !it.startsWith("ORDER_ITEMS_JSON") && !it.startsWith("{")
            }?.let { InfoRow("📝", it, dark) }
        }

        // ── SLA banner ──
        live.slaStatus?.takeIf { it.isNotEmpty() }?.let { sla ->
            TintBanner("⚡ $sla", Color(0xFFF59E0B))
        }

        // ── Courier timeline (web drawer's COURIER_STEPS list) ──
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "COURIER — ${(live.courier?.takeIf { it.isNotEmpty() } ?: "Not assigned").uppercase()}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
            )
            live.trackingId?.takeIf { it.isNotEmpty() }?.let { t ->
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Tracking ID", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        Text(t, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Icon(
                        Icons.Outlined.ContentCopy, contentDescription = "Copy tracking",
                        tint = AlmaTheme.violet,
                        modifier = Modifier
                            .size(28.dp)
                            .plainClick { clipboard.setText(AnnotatedString(t)) }
                            .padding(4.dp),
                    )
                }
            }
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OrderStatusMeta.courierSteps(live.status).forEach { (label, done, active) ->
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(
                            when {
                                done -> Icons.Filled.CheckCircle
                                active -> Icons.Filled.RadioButtonChecked
                                else -> Icons.Filled.RadioButtonUnchecked
                            },
                            contentDescription = null,
                            tint = when {
                                done -> Color(0xFF22C55E)
                                active -> Color(0xFF3B82F6)
                                else -> AlmaTheme.inkSecondary(dark)
                            },
                            modifier = Modifier.size(16.dp),
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                label,
                                color = if (done || active) AlmaTheme.ink(dark) else AlmaTheme.inkSecondary(dark),
                                fontSize = 12.sp,
                                fontWeight = if (done || active) FontWeight.SemiBold else FontWeight.Normal,
                            )
                            if (active) {
                                Text("In progress", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
                            }
                        }
                    }
                }
            }
        }

        // ── Invoice (generate + copy/open/share — web drawer parity) ──
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (hasInvoice) {
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Invoice", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        Text(live.invoiceNum ?: "", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Text("✓ Generated", color = Color(0xFF22C55E), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            } else if (mayInvoice) {
                GhostButton(
                    if (invBusy) "Generating…" else "📄 Generate Invoice",
                    AlmaTheme.ink(dark), dark, enabled = !invBusy && !busy,
                    Modifier.fillMaxWidth(),
                ) { generateInvoice() }
            }
            if (invoiceReady || hasInvoice) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton(
                        if (copied) "Copied ✓" else "🔗 Copy link",
                        AlmaTheme.ink(dark), dark, enabled = true, Modifier.weight(1f),
                    ) {
                        clipboard.setText(AnnotatedString(AlmaTheme.BASE_URL + invoiceShareURL))
                        copied = true
                    }
                    GhostButton("📄 Open PDF", AlmaTheme.ink(dark), dark, enabled = true, Modifier.weight(1f)) {
                        openWeb(invoiceShareURL, "Invoice")
                    }
                    GhostButton("↗ Share", AlmaTheme.ink(dark), dark, enabled = true, Modifier.weight(1f)) {
                        val full = AlmaTheme.BASE_URL + invoiceShareURL
                        val text = "Invoice PDF (${live.id}): $full"
                        try {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/?text=${Uri.encode(text)}")),
                            )
                        } catch (_: Exception) { }
                    }
                }
            }
        }

        invoiceToast?.let { t ->
            Text(
                t, color = AlmaTheme.ink(dark), fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            )
        }

        // ── Actions (edit / delete-request / advance / cancel / returns) ──
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (mayEdit || mayRequestDelete) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (mayEdit) {
                        GhostButton("✏️ Edit order", AlmaTheme.ink(dark), dark, enabled = !busy, Modifier.weight(1f)) {
                            showEdit = true
                        }
                    }
                    if (mayRequestDelete) {
                        GhostButton("🗑 Request delete", AlmaTheme.red(dark), dark, enabled = !busy, Modifier.weight(1f)) {
                            showDeleteRequest = true
                        }
                    }
                }
            }
            if (mayEdit && role == "STAFF") {
                Text(
                    "You can edit your own orders while Pending, Confirmed, or Packed. Wrong totals need Super Admin delete approval.",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (mayAdvance) {
                OrderStatusMeta.nextSteps(live.status).forEach { next ->
                    val tint = OrderStatusMeta.tint(next)
                    Text(
                        "→ ${OrderStatusMeta.label(next)}",
                        color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(tint, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .plainClick {
                                if (busy) return@plainClick
                                if (next == "RETURNED_UNPAID") {
                                    returnReason = ""; confirmStatus = next
                                } else {
                                    scope.launch {
                                        busy = true
                                        vm.setStatus(live, next)
                                        busy = false
                                    }
                                }
                            }
                            .padding(vertical = 11.dp),
                    )
                }
            }
            if (canCancel) {
                GhostButton("✕ Cancel order", AlmaTheme.red(dark), dark, enabled = !busy, Modifier.fillMaxWidth()) {
                    returnReason = ""; confirmStatus = "CANCELLED"
                }
            }
            if (canReturn) {
                GhostButton("↩ Returned (paid delivery)", AlmaTheme.red(dark), dark, enabled = !busy, Modifier.fillMaxWidth()) {
                    returnReason = ""; confirmStatus = "RETURNED_PAID"
                }
                GhostButton("↩ Returned (refused)", AlmaTheme.red(dark), dark, enabled = !busy, Modifier.fillMaxWidth()) {
                    returnReason = ""; confirmStatus = "RETURNED_UNPAID"
                }
            }
        }

        // ── Contact ──
        live.phone?.takeIf { it.isNotEmpty() }?.let { phone ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ContactButton("Call", Icons.Outlined.Call, dark, Modifier.weight(1f)) {
                    try {
                        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")))
                    } catch (_: Exception) { }
                }
                // WhatsApp: strip the leading 0, prefix country code — with the web
                // drawer's prefilled order-update text.
                if (phone.startsWith("0")) {
                    ContactButton("WhatsApp", Icons.Outlined.Sms, dark, Modifier.weight(1f)) {
                        val msg = "Hi ${live.customer ?: ""}, your order ${live.id} update: "
                        val url = "https://wa.me/880${phone.drop(1)}?text=${Uri.encode(msg)}"
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        } catch (_: Exception) { }
                    }
                }
            }
        }

        // ── Web escape (full drawer lives on the web list) ──
        Row(
            Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/orders", "Orders") }
                .padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Language, contentDescription = null, tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text("ওয়েবে খুলুন", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
        }
    }

    // ── Destructive-status confirm + reason + projected-loss preview ──
    confirmStatus?.let { target ->
        val meta = OrderStatusMeta.destructiveMeta(target)
        AlertDialog(
            onDismissRequest = { confirmStatus = null },
            title = { Text(meta.first) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(confirmMessage(live, target))
                    if (target != "CANCELLED") {
                        BasicTextField(
                            value = returnReason,
                            onValueChange = { returnReason = it },
                            singleLine = true,
                            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                            decorationBox = { inner ->
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .background(AlmaTheme.fill(dark), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                ) {
                                    if (returnReason.isEmpty()) {
                                        Text("কারণ (ঐচ্ছিক)", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                                    }
                                    inner()
                                }
                            },
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val reason = returnReason.trim()
                    confirmStatus = null
                    scope.launch {
                        busy = true
                        vm.setStatus(live, target, reason.ifEmpty { null })
                        busy = false
                    }
                }) { Text("নিশ্চিত", color = AlmaTheme.red(dark)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmStatus = null }) { Text("না") }
            },
        )
    }

    if (showEdit) {
        OrdEditSheet(live, vm, dark) { showEdit = false }
    }
    if (showDeleteRequest) {
        OrdDeleteRequestSheet(live, dark) { showDeleteRequest = false }
    }
}

/** Confirm body + projected-loss preview (port of the web's returnLossPreview). */
private fun confirmMessage(live: AlmaOrder, s: String): String {
    var text = OrderStatusMeta.destructiveMeta(s).second
    val shipping = live.shippingFee ?: 0
    val roundTrip = 2 * (live.courierCharge ?: 0)
    if (s == "RETURNED_UNPAID") {
        text += "\n\nThis will record a loss of ${AlmaTheme.taka(roundTrip)} (round-trip courier)."
    } else if (s == "RETURNED_PAID") {
        val net = shipping - roundTrip
        text += if (net >= 0) {
            "\n\nShipping collected covers courier round-trip — minimal or no loss."
        } else {
            "\n\nThis will record a loss of ${AlmaTheme.taka(-net)} (customer paid ${AlmaTheme.taka(shipping)} shipping; courier round-trip ${AlmaTheme.taka(roundTrip)})."
        }
    }
    return text
}

@Composable
private fun StatTile(
    label: String,
    value: String,
    tone: Color,
    dark: Boolean,
    modifier: Modifier,
    caption: String? = null,
) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(vertical = 10.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Text(value, color = tone, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        caption?.let {
            Text(
                it, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                maxLines = 2, textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun TintBanner(text: String, tone: Color) {
    Text(
        text,
        color = tone, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .fillMaxWidth()
            .background(tone.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tone.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

/** Glass bordered action button (iOS .bordered twin on the app's own surface). */
@Composable
private fun GhostButton(
    label: String,
    tint: Color,
    dark: Boolean,
    enabled: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Text(
        label,
        color = if (enabled) tint else tint.copy(alpha = 0.4f),
        fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center, maxLines = 1,
        modifier = modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick { if (enabled) onClick() }
            .padding(vertical = 10.dp, horizontal = 6.dp),
    )
}

@Composable
private fun InfoRow(icon: String, text: String?, dark: Boolean) {
    Row(verticalAlignment = Alignment.Top) {
        Text(icon, fontSize = 13.sp, modifier = Modifier.width(26.dp))
        Text(
            text?.takeIf { it.isNotEmpty() } ?: "—",
            color = AlmaTheme.ink(dark), fontSize = 14.sp,
        )
    }
}

@Composable
private fun ContactButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    dark: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Row(
        modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .plainClick(onClick)
            .padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = AlmaTheme.ink(dark), modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Edit-order sheet (POST /api/orders/orders/edit — web drawer parity) ────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrdEditSheet(order: AlmaOrder, vm: OrdersState, dark: Boolean, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var customer by remember { mutableStateOf(order.customer ?: "") }
    var phone by remember { mutableStateOf(order.phone ?: "") }
    var address by remember { mutableStateOf(order.address ?: "") }
    var product by remember { mutableStateOf(order.product ?: "") }
    var qty by remember { mutableStateOf((order.qty ?: 1).toString()) }
    var unitPrice by remember { mutableStateOf((order.unitPrice ?: 0).toString()) }
    var payment by remember { mutableStateOf(order.payment ?: "") }
    var notes by remember { mutableStateOf(order.notes ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun save() {
        val qtyNum = qty.trim().toIntOrNull()
        if (qtyNum == null || qtyNum <= 0) {
            error = "Quantity must be a positive number"; return
        }
        val priceNum = unitPrice.trim().toIntOrNull()
        if (priceNum == null || priceNum < 0) {
            error = "Unit price must be a valid number"; return
        }
        scope.launch {
            busy = true
            try {
                val body = JSONObject()
                    .put("order_id", order.id)
                    .put("business_id", order.businessId ?: "ALMA_LIFESTYLE")
                    .put(
                        "fields",
                        JSONObject()
                            .put("customer", customer)
                            .put("phone", phone)
                            .put("address", address)
                            .put("product", product)
                            .put("payment", payment)
                            .put("notes", notes)
                            .put("qty", qtyNum)
                            .put("unit_price", priceNum),
                    )
                val r = AlmaApi.send("POST", "/api/orders/orders/edit", body)
                val failed = r.optJSONArray("failed")
                if (failed != null && failed.length() > 0) {
                    error = failed.mapObjects { it.str("error") ?: it.str("field") }
                        .joinToString("; ")
                } else {
                    vm.load()
                    onClose()
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onClose, containerColor = AlmaTheme.rootBg(dark)) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Edit ${order.id}", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onClose, enabled = !busy) { Text("বাতিল") }
                TextButton(onClick = { save() }, enabled = !busy) {
                    Text(if (busy) "Saving…" else "Save", color = AlmaTheme.coral, fontWeight = FontWeight.SemiBold)
                }
            }
            Text(
                "Updates sync to the orders sheet. Sell price and profit recalculate automatically.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SheetField("Customer", customer, dark) { customer = it }
                SheetField("Phone", phone, dark, KeyboardType.Phone) { phone = it }
                SheetField("Address", address, dark) { address = it }
            }
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SheetField("Product", product, dark) { product = it }
                SheetField("Qty", qty, dark, KeyboardType.Number) { qty = it }
                SheetField("Unit price", unitPrice, dark, KeyboardType.Number) { unitPrice = it }
                SheetField("Payment", payment, dark) { payment = it }
                SheetField("Notes", notes, dark) { notes = it }
            }
            error?.let { Text(it, color = AlmaTheme.red(dark), fontSize = 12.sp) }
        }
    }
}

// ── Delete-request sheet (POST /api/orders/orders/delete-request) ──────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrdDeleteRequestSheet(order: AlmaOrder, dark: Boolean, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reason by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }

    fun submit() {
        val trimmed = reason.trim()
        if (trimmed.length < 5) {
            error = "Enter a delete reason (at least 5 characters)"; return
        }
        scope.launch {
            busy = true
            try {
                val r = AlmaApi.send(
                    "POST", "/api/orders/orders/delete-request",
                    JSONObject()
                        .put("order_id", order.id)
                        .put("business_id", order.businessId ?: "ALMA_LIFESTYLE")
                        .put("reason", trimmed),
                )
                error = null
                done = r.str("message") ?: "Delete request sent for Super Admin approval"
                delay(1200)
                onClose()
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onClose, containerColor = AlmaTheme.rootBg(dark)) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp)
                .padding(bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Request delete — ${order.id}",
                    color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onClose, enabled = !busy) { Text("বাতিল") }
                TextButton(onClick = { submit() }, enabled = !busy && done == null) {
                    Text(
                        if (busy) "Submitting…" else "Submit",
                        color = AlmaTheme.red(dark), fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            Text(
                "Super Admin must approve in Approvals. The order is hidden from lists after approval (sheet row kept for audit).",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            ) {
                SheetField("Why should this order be removed? (min 5 characters)", reason, dark) { reason = it }
            }
            error?.let { Text(it, color = AlmaTheme.red(dark), fontSize = 12.sp) }
            done?.let { Text(it, color = AlmaTheme.green(dark), fontSize = 12.sp) }
        }
    }
}

/** Labelled glass field for the edit / delete-request sheets. */
@Composable
private fun SheetField(
    label: String,
    value: String,
    dark: Boolean,
    keyboardType: KeyboardType = KeyboardType.Text,
    onChange: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = keyboardType != KeyboardType.Text,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
            decorationBox = { inner ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(AlmaTheme.fill(dark), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    inner()
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
