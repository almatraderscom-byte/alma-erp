//
//  OrdersScreen.kt
//  ALMA ERP — the Orders tab, ported 1:1 from OrdersSwiftUI.swift (iOS build 37 look):
//  aurora background, frosted glass cards, the web's exact status-pill colours
//  (globals.css tone-*), date chips + native custom range, ORDERS/REVENUE/PROFIT
//  stat cards, edge-to-edge status chip row, debounced server search, channel/
//  payment/sort menu, detail sheet with status actions + Call/WhatsApp, coral FAB.
//
//  Same endpoints as web/iOS:
//    GET  /api/orders/orders?business_id=…&startDate=…&endDate=…  → list + summary
//    POST /api/orders/orders/status  {id, status, reason?}        → status change
//

package com.almatraders.erp.pages

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Sms
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.DatePicker
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.text.input.ImeAction
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
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
    val size: String?,
    val qty: Int?,
    val sellPrice: Int?,
    val payment: String?,
    val source: String?,
    val courier: String?,
    val trackingId: String?,
    val notes: String?,
    val profit: Int?,
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
                size = o.str("size"),
                qty = o.flexInt("qty"),
                sellPrice = o.flexInt("sell_price"),
                payment = o.str("payment"),
                source = o.str("source"),
                courier = o.str("courier"),
                trackingId = o.str("tracking_id"),
                notes = o.str("notes"),
                profit = o.flexInt("profit"),
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
        val presets = listOf(Today, Yesterday, Last7, Last30, ThisMonth, LastMonth)
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
            load()
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
            item { StatsRow(vm, dark) }
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
                item { AuthExpiredCard(dark) { ctx.openWebForced("/login", "Login") } }
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
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
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
            OrderDetailSheet(order, vm, dark, scope, openWeb = { p, t ->
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

@Composable
private fun StatsRow(vm: OrdersState, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCard("ORDERS", "${vm.total}", AlmaTheme.ink(dark), dark, Modifier.weight(1f))
        StatCard("REVENUE", AlmaTheme.takaShort(vm.revenue), AlmaTheme.coral, dark, Modifier.weight(1f))
        StatCard(
            "PROFIT", AlmaTheme.takaShort(vm.profit),
            if (vm.profit >= 0) AlmaTheme.green(dark) else AlmaTheme.red(dark),
            dark, Modifier.weight(1f),
        )
    }
}

@Composable
private fun StatCard(title: String, value: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp)) {
        Text(title, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(value, color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1)
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

@Composable
private fun OrderCard(order: AlmaOrder, dark: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onClick)
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
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
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

// ── Detail sheet ───────────────────────────────────────────────────────────────────

@Composable
private fun OrderDetailSheet(
    order: AlmaOrder,
    vm: OrdersState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    openWeb: (String, String) -> Unit,
) {
    val context = LocalContext.current
    // Live copy — vm.orders is refreshed after actions; fall back to the passed order.
    val live = vm.orders.firstOrNull { it.id == order.id } ?: order
    var confirmCancel by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text(live.id, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                live.date?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp) }
            }
            Spacer(Modifier.weight(1f))
            StatusPill(live.status, dark)
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow("👤", live.customer, dark)
            InfoRow("📞", live.phone, dark)
            InfoRow("📍", live.address, dark)
            InfoRow("📦", productLine(live), dark)
            live.sellPrice?.let { InfoRow("💳", "${AlmaTheme.taka(it)}  (${live.payment ?: "—"})", dark) }
            live.courier?.takeIf { it.isNotEmpty() }?.let { InfoRow("🚚", "$it  ${live.trackingId ?: ""}", dark) }
            // Multi-item orders carry machine JSON in notes — never show it (iOS parity).
            live.notes?.takeIf {
                it.isNotEmpty() && !it.startsWith("ORDER_ITEMS_JSON") && !it.startsWith("{")
            }?.let { InfoRow("📝", it, dark) }
        }

        if (!OrderStatusMeta.isTerminal(live.status)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OrderStatusMeta.nextSteps(live.status).forEach { next ->
                    val tint = OrderStatusMeta.tint(next)
                    Text(
                        "→ ${OrderStatusMeta.label(next)}",
                        color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(tint, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                            .plainClick {
                                if (!busy) scope.launch {
                                    busy = true
                                    vm.setStatus(live, next)
                                    busy = false
                                }
                            }
                            .padding(vertical = 11.dp),
                    )
                }
                Text(
                    "✕ Cancel order",
                    color = AlmaTheme.red(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { confirmCancel = true }
                        .padding(vertical = 11.dp),
                )
            }
        }

        live.phone?.takeIf { it.isNotEmpty() }?.let { phone ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ContactButton("Call", Icons.Outlined.Call, dark, Modifier.weight(1f)) {
                    context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone")))
                }
                if (phone.startsWith("0")) {
                    ContactButton("WhatsApp", Icons.Outlined.Sms, dark, Modifier.weight(1f)) {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/880${phone.drop(1)}")),
                        )
                    }
                }
            }
        }

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
            Text("সব অপশন — ওয়েবে খুলুন", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
        }
    }

    if (confirmCancel) {
        AlertDialog(
            onDismissRequest = { confirmCancel = false },
            title = { Text("অর্ডারটি ক্যানসেল করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmCancel = false
                    scope.launch {
                        busy = true
                        vm.setStatus(live, "CANCELLED")
                        busy = false
                    }
                }) { Text("হ্যাঁ, ক্যানসেল", color = AlmaTheme.red(dark)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmCancel = false }) { Text("না") }
            },
        )
    }
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
