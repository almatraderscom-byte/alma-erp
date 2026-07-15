//
//  OrderCreateScreen.kt
//  ALMA ERP — native "নতুন অর্ডার" form, ported 1:1 from OrderCreateSwiftUI.swift:
//  গ্রাহক → পণ্য (collection code/SKU/নাম → SIZE/VARIANT chips with live stock →
//  multi-item cart, per-item size switch + qty + price) → টাকার হিসাব → ডেলিভারি → submit.
//  POST /api/orders/orders with the exact web payload (+ aliases + items[]).
//  Catalog preloaded once (GET /api/products + /api/stock), grouped by collection code.
//  Money = whole-taka Ints, calculate-totals.ts parity. Loss guard: an order may NOT
//  be created at a loss (owner rule).
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Orders list re-load signal — the create screen bumps it on success. */
object OrdersRefreshBus {
    var tick by mutableStateOf(0)
}

// ── Catalog models ──────────────────────────────────────────────────────────────────

data class AlmaStockItem(
    val sku: String?,
    val product: String?,
    val category: String?,
    val size: String?,
    val available: Int?,
    val buyingPrice: Int?,
    val collectionCode: String?,
    val collectionType: String?,   // MEN | WOMEN | SINGLE | CUSTOM
    val sizeGroup: String?,        // KIDS | ADULT | ""
    val variantGroup: String?,     // ORNA | TWO PIECE | THREE PIECE | ""
    val active: Boolean?,
    val archived: Boolean?,
) {
    val isSellable get() = (active ?: true) && !(archived ?: false)

    companion object {
        fun from(o: JSONObject) = AlmaStockItem(
            sku = o.str("sku"),
            product = o.str("product"),
            category = o.str("category"),
            size = o.str("size"),
            available = o.flexInt("available"),
            buyingPrice = o.flexInt("buyingPrice"),
            collectionCode = o.str("collectionCode"),
            collectionType = o.str("collectionType"),
            sizeGroup = o.str("sizeGroup"),
            variantGroup = o.str("variantGroup"),
            active = o.flexBool("active"),
            archived = o.flexBool("archived"),
        )
    }
}

// ── Size engine (faithful port of collection-engine.ts, via the iOS SizeEngine) ─────

object SizeEngine {
    val menSizes: List<String> = (0 until 20).map { (16 + it * 2).toString() }   // 16,18,…,54
    val womenVariants = listOf(
        "ORNA", "TWO PIECE (1-5)", "TWO PIECE (6Y-9Y)", "TWO PIECE (10Y-14Y)", "THREE PIECE",
    )

    fun sizeGroup(size: String): String? {
        val n = size.toIntOrNull() ?: return null
        return when {
            n in 16..36 -> "KIDS"
            n in 38..54 -> "ADULT"
            else -> null
        }
    }

    fun normalizeWomenVariant(value: String?): String? {
        val v = (value ?: "").uppercase()
        if (v.isEmpty()) return null
        if (v.contains("ORNA")) return "ORNA"
        if (v.contains("THREE") || v.contains("3 PIECE") || v.contains("3PC")) return "THREE PIECE"
        val two = listOf("TWO", "2 PIECE", "2PC", "10Y", "14Y", "10-14", "6Y", "9Y", "6-9", "1Y", "5Y", "1-5", "2Y", "2-5")
        if (two.any { v.contains(it) }) return "TWO PIECE"
        return null
    }
}

/** One collection (e.g. code "133") = one product with many size/variant stock rows. */
data class StockGroup(
    val key: String,
    val product: String,
    val category: String,
    val collectionType: String,
    val options: MutableList<AlmaStockItem>,
) {
    val totalAvailable get() = options.sumOf { it.available ?: 0 }
    val sellableOptions get() = options.filter { it.isSellable }
    val isMen get() = collectionType.uppercase() == "MEN"
    val isWomen get() = collectionType.uppercase() == "WOMEN"

    fun menPool(group: String): AlmaStockItem? =
        sellableOptions.firstOrNull { (it.sizeGroup ?: it.size ?: "").uppercase() == group.uppercase() }

    fun womenPool(variant: String): AlmaStockItem? =
        sellableOptions.firstOrNull { (SizeEngine.normalizeWomenVariant(it.variantGroup ?: it.size) ?: "") == variant }

    val sortedOptions: List<AlmaStockItem>
        get() = sellableOptions.sortedWith(
            compareBy({ it.size?.toIntOrNull() ?: Int.MAX_VALUE }, { it.size ?: "" }),
        )

    val subtitle: String
        get() = when {
            isMen -> "মেন্স · KIDS + ADULT · মোট স্টক $totalAvailable"
            isWomen -> "উইমেন্স · ${sellableOptions.size} ভ্যারিয়েন্ট · মোট স্টক $totalAvailable"
            else -> "$category · ${sellableOptions.size} অপশন · মোট স্টক $totalAvailable"
        }
}

/** One cart line — the matched inventory POOL row + the chosen display size/variant. */
class FormItem(
    val id: String = UUID.randomUUID().toString(),
    val groupKey: String,
    val collectionType: String,
    stock: AlmaStockItem,
    displaySize: String,
    sizeGroup: String,
    variantGroup: String,
    sellPrice: Int,
) {
    var stock by mutableStateOf(stock)
    var displaySize by mutableStateOf(displaySize)
    var sizeGroup by mutableStateOf(sizeGroup)
    var variantGroup by mutableStateOf(variantGroup)
    var qty by mutableStateOf(1)
    var sellPrice by mutableStateOf(sellPrice)

    val subtotal get() = qty * sellPrice
    val cogsTotal get() = qty * (stock.buyingPrice ?: 0)
    val isWomen get() = collectionType.uppercase() == "WOMEN"
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

private val SOURCES = listOf("Facebook", "WhatsApp", "Instagram", "Website", "Walk-in", "Referral")
private val PAYMENTS = listOf("COD", "bKash", "Nagad", "Rocket", "Bank Transfer", "Card")
private val COURIERS = listOf("Pathao", "Redx", "Steadfast", "Paperfly", "E-courier", "Sundarban", "SA Paribahan")
private val STATUSES = listOf("Pending", "Confirmed", "Packed", "Shipped", "Delivered")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OrderCreateScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val scope = rememberCoroutineScope()

    // Customer
    var customer by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("Facebook") }
    // Catalog / cart
    var groups by remember { mutableStateOf(mapOf<String, StockGroup>()) }
    var priceBySku by remember { mutableStateOf(mapOf<String, Int>()) }
    var catalogLoading by remember { mutableStateOf(true) }
    var query by remember { mutableStateOf("") }
    var pickingGroup by remember { mutableStateOf<StockGroup?>(null) }
    val items = remember { mutableStateListOf<FormItem>() }
    var isAdding by remember { mutableStateOf(false) }
    // Totals
    var shipping by remember { mutableStateOf(0) }
    var discount by remember { mutableStateOf(0) }
    var paidNow by remember { mutableStateOf(0) }
    var courierCost by remember { mutableStateOf(80) }   // web default (internal)
    // Delivery
    var payment by remember { mutableStateOf("COD") }
    var courier by remember { mutableStateOf("Pathao") }
    var status by remember { mutableStateOf("Pending") }
    var notes by remember { mutableStateOf("") }
    // Submission
    var submitting by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    var successId by remember { mutableStateOf<String?>(null) }

    // ── Money math (calculate-totals.ts parity) ──
    val subtotal = items.sumOf { it.subtotal }
    val payable = maxOf(0, subtotal - discount + shipping)
    val due = payable - minOf(paidNow, payable)
    val orderSellPrice = maxOf(0, subtotal - discount)   // shipping excluded
    val inventoryCost = items.sumOf { it.cogsTotal }
    val estimatedProfit = (orderSellPrice - inventoryCost) + shipping - courierCost
    val totalQty = items.sumOf { it.qty }

    val phoneDigits = phone.filter { it.isDigit() }
    val phoneValid = Regex("^01[3-9][0-9]{8}$").matches(phoneDigits)

    // ── Loss guard (owner rule): an order may NOT be created at a loss ──
    val belowCostItems = items.filter { (it.stock.buyingPrice ?: 0) > 0 && it.sellPrice < (it.stock.buyingPrice ?: 0) }
    val isLossOrder = belowCostItems.isNotEmpty() || estimatedProfit < 0
    val lossReason: String? = when {
        !isLossOrder -> null
        belowCostItems.isNotEmpty() -> {
            val first = belowCostItems.first()
            "${first.groupKey} — বিক্রয়মূল্য কেনা দামের (৳${first.stock.buyingPrice ?: 0}) নিচে। ক্ষতিতে অর্ডার তৈরি করা যাবে না।"
        }
        else -> "এই অর্ডারে ৳${kotlin.math.abs(estimatedProfit)} ক্ষতি হচ্ছে। বিক্রয়মূল্য বাড়ান বা খরচ কমান — ক্ষতিতে অর্ডার তৈরি করা যাবে না।"
    }

    val canSubmit = customer.trim().isNotEmpty() && phoneValid && items.isNotEmpty() &&
        items.all { it.qty >= 1 && it.sellPrice > 0 } && !isLossOrder && !submitting

    LaunchedEffect(Unit) {
        catalogLoading = true
        try {
            val productsRoot = try { AlmaApi.getObject("/api/products") } catch (_: Exception) { JSONObject() }
            val stockRoot = try { AlmaApi.getObject("/api/stock") } catch (_: Exception) { JSONObject() }
            val stockItems = ((stockRoot.optJSONObject("data") ?: stockRoot).optJSONArray("items") ?: JSONArray())
                .mapObjects { AlmaStockItem.from(it) }
            val g = LinkedHashMap<String, StockGroup>()
            stockItems.forEach { row ->
                val key = row.collectionCode?.takeIf { it.isNotEmpty() } ?: (row.sku ?: "?")
                val existing = g[key]
                if (existing == null) {
                    g[key] = StockGroup(key, baseProductName(row, key), row.category ?: "", row.collectionType ?: "", mutableListOf(row))
                } else {
                    existing.options.add(row)
                }
            }
            groups = g
            // Default SELL price map by SKU and NAME (web productByCode parity — never the buying price).
            val map = HashMap<String, Int>()
            ((productsRoot.optJSONObject("data") ?: productsRoot).optJSONArray("products") ?: JSONArray())
                .mapObjects { p ->
                    val price = p.flexInt("default_price") ?: 0
                    if (price > 0) {
                        listOf(p.str("sku"), p.str("name")).forEach { k ->
                            val key = (k ?: "").trim().lowercase()
                            if (key.isNotEmpty() && map[key] == null) map[key] = price
                        }
                    }
                    null
                }
            priceBySku = map
        } finally {
            catalogLoading = false
        }
    }

    fun defaultSellPrice(stock: AlmaStockItem, group: StockGroup): Int {
        for (key in listOf(stock.sku, group.key, group.product, stock.product)) {
            val k = (key ?: "").trim().lowercase()
            val p = priceBySku[k]
            if (k.isNotEmpty() && p != null && p > 0) return p
        }
        return 0
    }

    fun appendItem(group: StockGroup, stock: AlmaStockItem, display: String, sizeGroup: String, variantGroup: String) {
        items.add(
            FormItem(
                groupKey = group.key, collectionType = group.collectionType,
                stock = stock, displaySize = display,
                sizeGroup = sizeGroup, variantGroup = variantGroup,
                sellPrice = defaultSellPrice(stock, group),
            ),
        )
        query = ""
        pickingGroup = null
        isAdding = false
    }

    suspend fun submit() {
        if (!canSubmit) return
        submitting = true
        errorMsg = null
        try {
            val first = items[0]
            val firstProduct = groups[first.groupKey]?.product ?: first.stock.product ?: ""
            val title = if (items.size > 1) "$firstProduct + ${items.size - 1} more" else firstProduct
            val payload = JSONObject().apply {
                put("business_id", "ALMA_LIFESTYLE")
                put("customer", customer); put("customer_name", customer)
                put("phone", phoneDigits); put("customer_phone", phoneDigits)
                put("address", address); put("customer_address", address)
                put("product", title); put("product_name", title)
                put("category", first.stock.category ?: "")
                put("size", first.displaySize)
                put("qty", totalQty)
                put("unit_price", if (totalQty > 0) Math.round(subtotal.toDouble() / totalQty).toInt() else 0)
                put("sell_price", orderSellPrice)
                put("payment_method", payment); put("payment", payment)
                put("source", source)
                put("status", status)
                put("courier", courier)
                put("notes", notes)
                put("sku", first.stock.sku ?: "")
                put("cogs", inventoryCost)
                put("courier_charge", courierCost)
                put("shipping_fee", shipping)
                put("discount", discount)
                put("paid_amount", paidNow)
                put("due_amount", due)
                put("estimated_profit", estimatedProfit)
                put("inventory_cost", inventoryCost)
                put("courier_cost", courierCost)
                put("items", JSONArray().apply {
                    items.forEachIndexed { i, it ->
                        val women = it.isWomen
                        put(JSONObject().apply {
                            put("line_no", i + 1)
                            put("product_code", it.groupKey)
                            put("product", groups[it.groupKey]?.product ?: it.stock.product ?: "")
                            put("category", it.stock.category ?: "")
                            put("size", if (women) "" else it.displaySize)
                            put("variant", if (women) it.displaySize else (if (it.sizeGroup.isEmpty()) it.displaySize else ""))
                            put("size_group", it.sizeGroup)
                            put("variant_group", it.variantGroup)
                            put("qty", it.qty)
                            put("unit_price", it.sellPrice)
                            put("sell_price", it.sellPrice)
                            put("subtotal", it.subtotal)
                            put("sku", it.stock.sku ?: "")
                            put("stock_sku", it.stock.sku ?: "")
                            put("cogs", it.stock.buyingPrice ?: 0)
                        })
                    }
                })
            }
            val resp = AlmaApi.send("POST", "/api/orders/orders", payload)
            val err = resp.str("error")
            if (err != null) errorMsg = err
            else successId = resp.str("order_id") ?: "সফল"
        } catch (e: Exception) {
            errorMsg = e.message
        } finally {
            submitting = false
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(top = com.almatraders.erp.shell.LocalHeaderInset.current, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // ── গ্রাহক ──
        FormCard("গ্রাহক", "👤", dark) {
            GlassField("নাম *", customer, dark) { customer = it }
            FormDivider(dark)
            GlassField("ফোন (01XXXXXXXXX) *", phone, dark, KeyboardType.Phone, invalid = phone.isNotEmpty() && !phoneValid) { phone = it }
            FormDivider(dark)
            GlassField("ঠিকানা (জেলা + এলাকা)", address, dark) { address = it }
            FormDivider(dark)
            PickerRow("সোর্স", source, SOURCES, dark) { source = it }
        }

        // ── পণ্য ──
        FormCard("পণ্য", "📦", dark) {
            if (catalogLoading) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), color = AlmaTheme.coral, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("স্টক লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
                }
            } else {
                items.forEach { item ->
                    CartLine(item, groups, dark, onRemove = { items.removeAll { it.id == item.id } })
                }
                if (items.isEmpty() || isAdding) {
                    if (items.isNotEmpty()) FormDivider(dark)
                    GlassField("কালেকশন কোড / SKU / নাম", query, dark) {
                        query = it
                        pickingGroup = null
                    }
                    val picking = pickingGroup
                    if (query.isNotEmpty() && picking == null) {
                        GroupResults(groups, query, dark) { pickingGroup = it }
                    }
                    if (picking != null) {
                        SizePicker(picking, dark, onClose = { pickingGroup = null; query = "" }) { stock, display, sg, vg ->
                            appendItem(picking, stock, display, sg, vg)
                        }
                    }
                    if (items.isNotEmpty()) {
                        Text(
                            "বাতিল", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                            modifier = Modifier.plainClick {
                                isAdding = false; query = ""; pickingGroup = null
                            }.padding(top = 4.dp),
                        )
                    }
                } else {
                    FormDivider(dark)
                    Text(
                        "＋ আরেকটা পণ্য যোগ করুন",
                        color = AlmaTheme.coral, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.plainClick {
                            isAdding = true; query = ""; pickingGroup = null
                        }.padding(top = 2.dp),
                    )
                }
                if (items.isEmpty() && query.isEmpty()) {
                    Text(
                        "কোড লিখে খুঁজুন → সাইজ বাছুন → কার্টে যোগ হবে। একাধিক পণ্য যোগ করা যায়।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }

        // ── টাকার হিসাব ──
        FormCard("টাকার হিসাব", "💵", dark) {
            MoneyRow("শিপিং ৳", shipping, dark) { shipping = it }
            FormDivider(dark)
            MoneyRow("ডিসকাউন্ট ৳", discount, dark) { discount = it }
            FormDivider(dark)
            MoneyRow("অগ্রিম পরিশোধ ৳", paidNow, dark) { paidNow = it }
            FormDivider(dark)
            MoneyRow("কুরিয়ার খরচ ৳ (ইন্টারনাল)", courierCost, dark) { courierCost = it }
            FormDivider(dark)
            SummaryRow("সাবটোটাল", subtotal, dark)
            SummaryRow("মোট পরিশোধ্য", payable, dark, bold = true)
            SummaryRow("বাকি", due, dark)
            Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                // Label flips to "ক্ষতি" when profit is negative — never call a loss "লাভ".
                Text(
                    if (estimatedProfit >= 0) "আনুমানিক লাভ" else "আনুমানিক ক্ষতি",
                    color = if (estimatedProfit >= 0) AlmaTheme.ink(dark) else AlmaTheme.red(dark),
                    fontSize = 14.sp,
                    fontWeight = if (estimatedProfit >= 0) FontWeight.Normal else FontWeight.SemiBold,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    AlmaTheme.taka(kotlin.math.abs(estimatedProfit)),
                    color = if (estimatedProfit >= 0) AlmaTheme.green(dark) else AlmaTheme.red(dark),
                    fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
        }

        // ── ডেলিভারি ──
        FormCard("ডেলিভারি ও পেমেন্ট", "🚚", dark) {
            PickerRow("পেমেন্ট", payment, PAYMENTS, dark) { payment = it }
            FormDivider(dark)
            PickerRow("কুরিয়ার", courier, COURIERS, dark) { courier = it }
            FormDivider(dark)
            PickerRow("স্ট্যাটাস", status, STATUSES, dark) { status = it }
            FormDivider(dark)
            GlassField("নোট", notes, dark) { notes = it }
        }

        // ── Submit ──
        errorMsg?.let {
            Text(it, color = AlmaTheme.red(dark), fontSize = 13.sp)
        }
        lossReason?.let { loss ->
            Text(
                "⚠ $loss",
                color = AlmaTheme.red(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.red(dark).copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(10.dp),
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .background(if (canSubmit) AlmaTheme.coral else Color.Gray.copy(alpha = 0.4f), CircleShape)
                .plainClick { if (canSubmit) scope.launch { submit() } }
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (submitting) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
            } else {
                Text("✓ অর্ডার তৈরি করুন", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            }
        }
        Text(
            "ওয়েব ফর্মে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { ctx.openWebForced("/orders/new", "নতুন অর্ডার") },
        )
    }

    successId?.let { id ->
        AlertDialog(
            onDismissRequest = { },
            title = { Text("অর্ডার তৈরি হয়েছে ✅") },
            text = { Text(id) },
            confirmButton = {
                TextButton(onClick = {
                    successId = null
                    OrdersRefreshBus.tick++
                    ctx.pop()
                }) { Text("ঠিক আছে") }
            },
        )
    }
}

// ── Sub-pieces ──────────────────────────────────────────────────────────────────────

@Composable
private fun FormCard(title: String, icon: String, dark: Boolean, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 2.dp)) {
            Text(icon, fontSize = 12.sp)
            Spacer(Modifier.width(7.dp))
            Text(
                title.uppercase(),
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
        content()
    }
}

@Composable
private fun FormDivider(dark: Boolean) {
    HorizontalDivider(color = AlmaTheme.separator(dark), thickness = 0.7.dp)
}

@Composable
private fun GlassField(
    placeholder: String,
    value: String,
    dark: Boolean,
    keyboardType: KeyboardType = KeyboardType.Text,
    invalid: Boolean = false,
    onChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        textStyle = TextStyle(
            color = if (invalid) AlmaTheme.red(dark) else AlmaTheme.ink(dark),
            fontSize = 14.sp,
        ),
        decorationBox = { inner ->
            Box(Modifier.padding(vertical = 9.dp)) {
                if (value.isEmpty()) {
                    Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                }
                inner()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun PickerRow(label: String, selection: String, options: List<String>, dark: Boolean, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        Box {
            Text(
                "$selection ▾",
                color = AlmaTheme.violet, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick { open = true }.padding(vertical = 4.dp),
            )
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { opt ->
                    DropdownMenuItem(
                        text = { Text((if (opt == selection) "✓ " else "") + opt) },
                        onClick = { onSelect(opt); open = false },
                    )
                }
            }
        }
    }
}

@Composable
private fun MoneyRow(label: String, value: Int, dark: Boolean, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        BasicTextField(
            value = if (value == 0) "" else value.toString(),
            onValueChange = { s -> onChange(s.filter { it.isDigit() }.take(9).toIntOrNull() ?: 0) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp, textAlign = TextAlign.End),
            decorationBox = { inner ->
                Box(
                    Modifier
                        .width(100.dp)
                        .background(
                            Color.White.copy(alpha = if (dark) 0.08f else 0.55f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .padding(vertical = 5.dp, horizontal = 8.dp),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    if (value == 0) Text("0", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                    inner()
                }
            },
        )
    }
}

@Composable
private fun SummaryRow(label: String, value: Int, dark: Boolean, bold: Boolean = false) {
    Row(Modifier.padding(vertical = 3.dp)) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        Text(
            AlmaTheme.taka(value),
            color = AlmaTheme.ink(dark), fontSize = if (bold) 15.sp else 14.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
        )
    }
}

@Composable
private fun GroupResults(groups: Map<String, StockGroup>, query: String, dark: Boolean, onPick: (StockGroup) -> Unit) {
    val q = query.lowercase()
    val hits = groups.values
        .filter { it.key.lowercase().contains(q) || it.product.lowercase().contains(q) }
        .sortedBy { it.key }
        .take(6)
    Column {
        hits.forEach { g ->
            Row(
                Modifier.fillMaxWidth().plainClick { onPick(g) }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text("${g.key} — ${g.product}", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text(g.subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
                Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
            }
        }
        if (hits.isEmpty()) {
            Text("মিল পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, modifier = Modifier.padding(vertical = 6.dp))
        }
    }
}

/** Web-parity size/variant selector — branches on collection TYPE exactly like /orders/new. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SizePicker(
    g: StockGroup,
    dark: Boolean,
    onClose: () -> Unit,
    onAdd: (stock: AlmaStockItem, display: String, sizeGroup: String, variantGroup: String) -> Unit,
) {
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${g.key} — ${g.product}", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("✕", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp, modifier = Modifier.plainClick(onClose))
        }
        Text(
            when {
                g.isMen -> "সাইজ বাছুন — ১৬–৩৬ শিশু (KIDS), ৩৮–৫৪ বড় (ADULT) স্টক থেকে কাটবে।"
                g.isWomen -> "ভ্যারিয়েন্ট বাছুন — বয়স ব্যান্ড অর্ডারে থাকবে, স্টক ORNA / TWO PIECE / THREE PIECE থেকে কাটবে।"
                else -> "সাইজ / ভ্যারিয়েন্ট বাছুন।"
            },
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        when {
            g.isMen -> {
                listOf("KIDS", "ADULT").forEach { pool ->
                    val row = g.menPool(pool) ?: return@forEach
                    val avail = row.available ?: 0
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                if (pool == "KIDS") "শিশু · KIDS" else "বড় · ADULT",
                                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            )
                            Text(
                                "স্টক $avail",
                                color = if (avail > 0) AlmaTheme.violet else AlmaTheme.red(dark),
                                fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier
                                    .background(
                                        (if (avail > 0) AlmaTheme.violet else AlmaTheme.red(dark)).copy(alpha = 0.14f),
                                        CircleShape,
                                    )
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                        SizeChipFlow(
                            SizeEngine.menSizes.filter { SizeEngine.sizeGroup(it) == pool }
                                .map { size -> Triple(size, avail < 1) { onAdd(row, size, pool, "") } },
                            dark,
                        )
                    }
                }
            }
            g.isWomen -> {
                SizeChipFlow(
                    SizeEngine.womenVariants.mapNotNull { label ->
                        val norm = SizeEngine.normalizeWomenVariant(label) ?: label
                        val row = g.womenPool(norm) ?: return@mapNotNull null
                        val avail = row.available ?: 0
                        Triple("$label · $avail", avail < 1) { onAdd(row, label, "", norm) }
                    },
                    dark,
                )
            }
            else -> {
                SizeChipFlow(
                    g.sortedOptions.map { opt ->
                        Triple(
                            "${opt.size ?: opt.variantGroup ?: "?"} · ${opt.available ?: 0}",
                            (opt.available ?: 0) < 1,
                        ) {
                            onAdd(
                                opt, opt.size ?: opt.variantGroup ?: "",
                                opt.sizeGroup ?: "",
                                SizeEngine.normalizeWomenVariant(opt.variantGroup) ?: "",
                            )
                        }
                    },
                    dark,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SizeChipFlow(chips: List<Triple<String, Boolean, () -> Unit>>, dark: Boolean) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        chips.forEach { (label, disabled, action) ->
            Text(
                label,
                color = if (disabled) AlmaTheme.inkSecondary(dark) else AlmaTheme.coral,
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(
                        (if (disabled) Color.Gray else AlmaTheme.coral).copy(alpha = if (disabled) 0.10f else 0.16f),
                        CircleShape,
                    )
                    .border(
                        1.dp,
                        if (disabled) Color.Transparent else AlmaTheme.coral.copy(alpha = 0.45f),
                        CircleShape,
                    )
                    .plainClick { if (!disabled) action() }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
            )
        }
    }
}

@Composable
private fun CartLine(item: FormItem, groups: Map<String, StockGroup>, dark: Boolean, onRemove: () -> Unit) {
    val group = groups[item.groupKey]
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .background(Color.White.copy(alpha = if (dark) 0.05f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.55f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(group?.product ?: item.stock.product ?: "—", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    "${item.groupKey} · ${item.stock.sku ?: ""} · স্টক ${item.stock.available ?: 0}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                )
            }
            Text("🗑", fontSize = 13.sp, modifier = Modifier.plainClick(onRemove))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (group != null) SizeSwitchMenu(item, group, dark)
            Spacer(Modifier.weight(1f))
            Text("পরিমাণ", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            Text("${item.qty}", color = AlmaTheme.coral, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Stepper(dark, minus = {
                if (item.qty > 1) item.qty--
            }, plus = {
                if (item.qty < maxOf(1, item.stock.available ?: 1)) item.qty++
            })
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("দাম ৳", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            BasicTextField(
                value = if (item.sellPrice == 0) "" else item.sellPrice.toString(),
                onValueChange = { s -> item.sellPrice = s.filter { it.isDigit() }.take(9).toIntOrNull() ?: 0 },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                decorationBox = { inner ->
                    Box(
                        Modifier
                            .width(86.dp)
                            .background(
                                Color.White.copy(alpha = if (dark) 0.08f else 0.6f),
                                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                            )
                            .padding(vertical = 6.dp, horizontal = 10.dp),
                    ) {
                        if (item.sellPrice == 0) Text("0", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                        inner()
                    }
                },
            )
            Spacer(Modifier.weight(1f))
            Text(AlmaTheme.taka(item.subtotal), color = AlmaTheme.coral, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
        // Below-cost warning on the offending line.
        val buying = item.stock.buyingPrice ?: 0
        if (buying > 0 && item.sellPrice < buying) {
            Text(
                "⚠ বিক্রয়মূল্য কেনা দামের (৳$buying) নিচে",
                color = AlmaTheme.red(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun Stepper(dark: Boolean, minus: () -> Unit, plus: () -> Unit) {
    Row(
        Modifier
            .background(AlmaTheme.fill(dark), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "−", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.plainClick(minus).padding(horizontal = 14.dp, vertical = 4.dp),
        )
        Box(Modifier.width(1.dp).height(18.dp).background(AlmaTheme.separator(dark)))
        Text(
            "＋", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.plainClick(plus).padding(horizontal = 14.dp, vertical = 4.dp),
        )
    }
}

/** Switch an added line to another size/variant of the SAME collection — type-aware. */
@Composable
private fun SizeSwitchMenu(item: FormItem, group: StockGroup, dark: Boolean) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            (if (item.isWomen) item.displaySize else "সাইজ ${item.displaySize}") + " ⇅",
            color = AlmaTheme.violet, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            modifier = Modifier
                .background(AlmaTheme.violet.copy(alpha = 0.15f), CircleShape)
                .plainClick { open = true }
                .padding(horizontal = 10.dp, vertical = 6.dp),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            fun apply(pool: AlmaStockItem, display: String, sg: String, vg: String) {
                item.stock = pool
                item.displaySize = display
                item.sizeGroup = sg
                item.variantGroup = vg
                item.qty = minOf(item.qty, maxOf(1, pool.available ?: 1))
                open = false
            }
            when {
                group.isMen -> SizeEngine.menSizes.forEach { size ->
                    val pool = group.menPool(SizeEngine.sizeGroup(size) ?: "") ?: return@forEach
                    DropdownMenuItem(
                        text = { Text("$size  (স্টক ${pool.available ?: 0})") },
                        enabled = (pool.available ?: 0) > 0,
                        onClick = { apply(pool, size, SizeEngine.sizeGroup(size) ?: "", "") },
                    )
                }
                group.isWomen -> SizeEngine.womenVariants.forEach { label ->
                    val norm = SizeEngine.normalizeWomenVariant(label) ?: label
                    val pool = group.womenPool(norm) ?: return@forEach
                    DropdownMenuItem(
                        text = { Text("$label  (স্টক ${pool.available ?: 0})") },
                        enabled = (pool.available ?: 0) > 0,
                        onClick = { apply(pool, label, "", norm) },
                    )
                }
                else -> group.sortedOptions.forEach { opt ->
                    DropdownMenuItem(
                        text = { Text("${opt.size ?: opt.variantGroup ?: "?"}  (স্টক ${opt.available ?: 0})") },
                        enabled = (opt.available ?: 0) > 0,
                        onClick = {
                            apply(
                                opt, opt.size ?: opt.variantGroup ?: "",
                                opt.sizeGroup ?: "",
                                SizeEngine.normalizeWomenVariant(opt.variantGroup) ?: "",
                            )
                        },
                    )
                }
            }
        }
    }
}

/** Strip the pool word ("133 ADULT" → "133 …") so the group title reads as the collection. */
private fun baseProductName(row: AlmaStockItem, key: String): String {
    var n = row.product ?: key
    for (suffix in listOf(" ADULT", " KIDS", " ORNA", " THREE PIECE", " TWO PIECE")) {
        if (n.uppercase().endsWith(suffix)) {
            n = n.dropLast(suffix.length)
            break
        }
    }
    return n.trim().ifEmpty { key }
}
