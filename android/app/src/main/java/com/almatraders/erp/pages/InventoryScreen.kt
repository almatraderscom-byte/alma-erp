//
//  InventoryScreen.kt
//  ALMA ERP — the Inventory screen, ported 1:1 from InventorySwiftUI.swift
//  (browse/search/detail + native writes).
//
//  Endpoints (same as web/iOS):
//    GET  /api/stock → { items, summary:{ total_skus, low_stock, out_of_stock,
//                        total_value } }  (flat — {ok,data} unwrapped defensively)
//    POST /api/stock → { action:"adjust", sku, new_stock, buying_price?, reason }
//                      { action:"edit", sku, data:{ buyingPrice?, reorder_level? } }
//                      { action:"archive", sku, reason:"manual archive" }
//                      { action:"restore", sku }
//    POST /api/products → add product (web AddProductModal single mode)
//  Full list loads once, filters client-side (view chips · category · debounced
//  search over sku/product/category/collection/barcode/pool label, 120-row cap).
//  Every write confirms in Bangla first; ONE spinner per SKU, never a global
//  overlay. Photo upload + collection/bulk add stay on the web (uploader) — links.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
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
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object InvPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600
}

/** Web mobile view renders at most the first 120 matches — same cap here. */
private const val INV_MOBILE_CAP = 120

/** Same reason presets the web adjust prompt suggests. */
private val INV_ADJUST_REASONS
    get() = listOf("manual correction", "damaged", "lost", "supplier update", "return restock")

// ── Model (same field names /api/stock emits — GAS-lenient decoding) ───────────────

private data class InvItem(
    val sku: String,
    val product: String,
    val category: String?,
    val color: String?,
    val size: String?,
    val opening: Int,
    val purchased: Int,
    val sold: Int,
    val returned: Int,
    val damaged: Int,
    val reserved: Int,
    val currentStock: Int,
    val available: Int,
    val reorderLevel: Int,
    val stockValue: Int,
    val sellValue: Int,
    val potentialProfit: Int,
    val collectionCode: String?,
    val collectionType: String?,
    val sizeGroup: String?,
    val variantGroup: String?,
    val sizeCategory: String?,
    val sizeValue: String?,
    val buyingPrice: Int?,      // redacted server-side for non-admin roles → null
    val sellingPrice: Int?,
    val barcode: String?,
    val active: Boolean?,
    val archived: Boolean?,
) {
    /** Web inventoryPoolLabel(): MEN → sizeGroup, WOMEN → variantGroup, else sizeValue. */
    val poolLabel: String?
        get() {
            val candidates = when (collectionType) {
                "MEN" -> listOf(sizeGroup, sizeCategory, sizeValue, size)
                "WOMEN" -> listOf(variantGroup, sizeValue, size)
                else -> listOf(sizeValue, variantGroup, size)
            }
            return candidates.firstOrNull { !it.isNullOrEmpty() }
        }

    /** Web status badge: ARCHIVED · OUT (≤0) · LOW (≤ reorder) · IN STOCK. */
    val statusLabel: String
        get() = when {
            archived == true -> "ARCHIVED"
            available <= 0 -> "OUT"
            available <= reorderLevel -> "LOW"
            else -> "IN STOCK"
        }

    fun statusColor(dark: Boolean): Color = when {
        archived == true -> AlmaTheme.inkSecondary(dark)
        available <= 0 -> InvPalette.red500
        available <= reorderLevel -> InvPalette.amber500
        else -> InvPalette.green400
    }

    /** Web: Math.round(sold / (opening + purchased + 0.01) * 100). */
    val utilisationPct: Int
        get() = Math.round(sold.toDouble() / (opening.toDouble() + purchased.toDouble() + 0.01) * 100).toInt()

    companion object {
        fun from(o: JSONObject): InvItem? {
            val sku = o.str("sku") ?: return null
            return InvItem(
                sku = sku,
                product = o.str("product") ?: "—",
                category = o.str("category"),
                color = o.str("color"),
                size = o.str("size"),
                opening = o.flexInt("opening") ?: 0,
                purchased = o.flexInt("purchased") ?: 0,
                sold = o.flexInt("sold") ?: 0,
                returned = o.flexInt("returned") ?: 0,
                damaged = o.flexInt("damaged") ?: 0,
                reserved = o.flexInt("reserved") ?: 0,
                currentStock = o.flexInt("current_stock") ?: 0,
                available = o.flexInt("available") ?: 0,
                reorderLevel = o.flexInt("reorder_level") ?: 0,
                stockValue = o.flexInt("stock_value") ?: 0,
                sellValue = o.flexInt("sell_value") ?: 0,
                potentialProfit = o.flexInt("potential_profit") ?: 0,
                collectionCode = o.str("collectionCode"),
                collectionType = o.str("collectionType"),
                sizeGroup = o.str("sizeGroup"),
                variantGroup = o.str("variantGroup"),
                sizeCategory = o.str("sizeCategory"),
                sizeValue = o.str("sizeValue"),
                buyingPrice = o.flexInt("buyingPrice"),
                sellingPrice = o.flexInt("selling_price"),
                barcode = o.str("barcode"),
                active = o.flexBool("active"),
                archived = o.flexBool("archived"),
            )
        }
    }
}

// ── State holder (iOS InventoryVM twin) ────────────────────────────────────────────

private class InventoryState {
    var items by mutableStateOf(listOf<InvItem>())
    var totalSkus by mutableStateOf(0)
    var lowStockCount by mutableStateOf(0)
    var outOfStockCount by mutableStateOf(0)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)     // the web's toast.success line
    var authExpired by mutableStateOf(false)

    // Writes — per-SKU busy set (per-row spinners, never a global overlay).
    var busySkus by mutableStateOf(setOf<String>())
    var creating by mutableStateOf(false)

    // Filters — same client-side semantics as the web page.
    var view by mutableStateOf("active")            // active | archived | low | out
    var category by mutableStateOf<String?>(null)
    var search by mutableStateOf("")                // live text
    var appliedSearch by mutableStateOf("")         // debounced needle

    suspend fun load() {
        loading = true
        error = null
        try {
            // /api/stock answers flat { items, summary } — unwrap {ok,data} too.
            val root = AlmaApi.getObject("/api/stock")
            val c = root.optJSONObject("data") ?: root
            items = c.optJSONArray("items")?.mapObjects { InvItem.from(it) } ?: emptyList()
            val s = c.optJSONObject("summary")
            totalSkus = s?.flexInt("total_skus") ?: items.size
            lowStockCount = s?.flexInt("low_stock") ?: 0
            outOfStockCount = s?.flexInt("out_of_stock") ?: 0
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

    /** One inventory mutation: per-SKU busy → POST → Bangla notice → full reload. */
    private suspend fun mutate(sku: String, body: JSONObject, successNotice: String): String? {
        if (sku.isEmpty() || sku in busySkus) return "এই SKU-তে আরেকটি কাজ চলছে"
        busySkus = busySkus + sku
        notice = null
        error = null
        try {
            val resp = AlmaApi.send("POST", "/api/stock", body)
            val data = resp.optJSONObject("data") ?: resp
            val err = data.str("error")
            if (!err.isNullOrEmpty()) throw AlmaApiException.Http(200, err)
            if (data.flexBool("ok") == false) throw AlmaApiException.Http(200, "Inventory action failed")
            notice = successNotice
            load()
            return null
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            return "সেশন নেই — ওয়েব ট্যাবে লগইন করুন।"
        } catch (e: Exception) {
            val msg = e.message ?: "ব্যর্থ হয়েছে"
            error = msg
            return msg
        } finally {
            busySkus = busySkus - sku
        }
    }

    /** Web adjustStock: absolute new level (the web prompts with `available`). */
    suspend fun adjustStock(sku: String, newStock: Int, buyingPrice: Int?, reason: String): String? {
        val body = JSONObject()
            .put("action", "adjust")
            .put("sku", sku)
            .put("new_stock", newStock)
            .put("reason", reason.ifEmpty { "manual correction" })
        if (buyingPrice != null) body.put("buying_price", buyingPrice)
        return mutate(sku, body, "স্টক আপডেট হয়েছে — $sku → $newStock")
    }

    /** Web updateBuyingPrice + reorder edit: { action:"edit", sku, data:{…} }. */
    suspend fun editItem(sku: String, buyingPrice: Int?, reorderLevel: Int?): String? {
        val data = JSONObject()
        if (buyingPrice != null) data.put("buyingPrice", buyingPrice)
        if (reorderLevel != null) data.put("reorder_level", reorderLevel)
        if (data.length() == 0) return null
        val body = JSONObject().put("action", "edit").put("sku", sku).put("data", data)
        return mutate(sku, body, "আপডেট হয়েছে — $sku")
    }

    suspend fun archive(sku: String): String? = mutate(
        sku,
        JSONObject().put("action", "archive").put("sku", sku).put("reason", "manual archive"),
        "আর্কাইভ হয়েছে — $sku",
    )

    suspend fun restore(sku: String): String? = mutate(
        sku,
        JSONObject().put("action", "restore").put("sku", sku),
        "রিস্টোর হয়েছে — $sku",
    )

    /** Web AddProductModal single mode: POST /api/products. Returns error or null. */
    suspend fun createProduct(body: JSONObject): String? {
        if (creating) return "আগের সেভ এখনো চলছে"
        creating = true
        notice = null
        error = null
        try {
            val resp = AlmaApi.send("POST", "/api/products", body)
            val data = resp.optJSONObject("data") ?: resp
            val pid = data.str("product_id")
            if (data.flexBool("ok") != true || pid.isNullOrEmpty()) {
                val msg = data.str("error") ?: "সার্ভার থেকে অপ্রত্যাশিত উত্তর।"
                error = msg
                return msg
            }
            var msg = "নতুন আইটেম সেভ হয়েছে — $pid"
            val stock = data.optJSONObject("stock")
            if (stock?.flexBool("ok") == false && stock.str("reason") == "stock_sku_exists") {
                msg += " (স্টকে এই SKU আগেই ছিল — ডুপ্লিকেট হয়নি)"
            }
            notice = msg
            load()
            return null
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            return "সেশন নেই — ওয়েব ট্যাবে লগইন করুন।"
        } catch (e: Exception) {
            val msg = e.message ?: "ব্যর্থ হয়েছে"
            error = msg
            return msg
        } finally {
            creating = false
        }
    }

    /** Web `items` useMemo — view chip → category → text needle, same fields. */
    val filtered: List<InvItem>
        get() {
            val needle = appliedSearch.trim().lowercase()
            return items.filter { i ->
                val archived = i.archived == true
                val viewOK = when (view) {
                    "archived" -> archived
                    "low" -> !archived && i.active != false && i.available > 0 && i.available <= i.reorderLevel
                    "out" -> !archived && i.active != false && i.available <= 0
                    else -> !archived && i.active != false
                }
                if (!viewOK) return@filter false
                val cat = category
                if (cat != null && i.category != cat && i.collectionCode != cat) return@filter false
                if (needle.isEmpty()) return@filter true
                listOf(i.sku, i.product, i.category, i.collectionCode, i.barcode, i.poolLabel)
                    .any { (it ?: "").lowercase().contains(needle) }
            }
        }

    private val activeItems: List<InvItem>
        get() = items.filter { it.archived != true && it.active != false }

    /** Web KPI "Stock Value" — sum over active items (not summary.total_value). */
    val stockValue: Int get() = activeItems.sumOf { it.stockValue }

    /** Web KPI "Potential Profit" — row value, JS `||` fallback when 0/absent. */
    val potentialProfit: Int
        get() = activeItems.sumOf { i ->
            val fallback = (i.sellingPrice ?: 0) * maxOf(i.available, 0) - i.stockValue
            if (i.potentialProfit != 0) i.potentialProfit else fallback
        }

    val categories: List<String>
        get() = items.mapNotNull { it.category }.filter { it.isNotEmpty() }.distinct().sorted()
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InventoryScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val context = androidx.compose.ui.platform.LocalContext.current
    val vm = remember { InventoryState() }
    val scope = rememberCoroutineScope()
    var selectedSku by remember { mutableStateOf<String?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }
    // Client-side filter, debounced (the list can run to thousands of rows).
    LaunchedEffect(vm.search) {
        delay(300)
        vm.appliedSearch = vm.search
    }

    val rows = vm.filtered
    val visible = rows.take(INV_MOBILE_CAP)

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(top = 6.dp),
        ) {
            item { InvHeroCard(vm.stockValue, vm.potentialProfit, vm.totalSkus) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    InvStatTile(
                        "Low stock", vm.lowStockCount, "রিঅর্ডার লেভেলে",
                        tint = if (vm.lowStockCount > 0) InvPalette.amber600 else AlmaTheme.ink(dark),
                        accent = InvPalette.amber500, dark = dark, modifier = Modifier.weight(1f),
                    )
                    InvStatTile(
                        "Out of stock", vm.outOfStockCount, "স্টক শেষ",
                        tint = if (vm.outOfStockCount > 0) InvPalette.red500 else AlmaTheme.ink(dark),
                        accent = InvPalette.red500, dark = dark, modifier = Modifier.weight(1f),
                    )
                }
            }
            item {
                // View chips (web: Active / Low stock / Out of stock / Archived).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    InvChip("Active", vm.view == "active", dark) { vm.view = "active" }
                    InvChip("Low stock", vm.view == "low", dark) { vm.view = "low" }
                    InvChip("Out of stock", vm.view == "out", dark) { vm.view = "out" }
                    InvChip("Archived", vm.view == "archived", dark) { vm.view = "archived" }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    InvSearchRow(vm, dark, Modifier.weight(1f))
                    InvCategoryMenu(vm, dark)
                }
            }
            if (vm.authExpired) {
                item { InvAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { InvNoticeLine(it, InvPalette.red500, dark) } }
            vm.notice?.let { item { InvNoticeLine(it, InvPalette.positive(dark), dark) } }
            if (vm.loading && vm.items.isEmpty()) {
                items(5) { Box(Modifier.fillMaxWidth().height(112.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            }
            items(visible) { item ->
                InvItemCard(item, vm, dark) { selectedSku = item.sku }
            }
            if (!vm.loading && rows.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("📦", fontSize = 34.sp)
                        Text("No items found", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                        Text("Try another filter or add a product", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                        Text(
                            "+ Add item",
                            color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .background(InvPalette.coral, CircleShape)
                                .plainClick { showAdd = true }
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                }
            }
            if (!vm.loading && rows.size > visible.size) {
                item {
                    Text(
                        "Showing first ${visible.size} matches. Use filters/search for the rest.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    )
                }
            }
            item {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // Cross-page push — the router resolves it to the native screen.
                    Text(
                        "⬇️ সাপ্লায়ার ইমপোর্ট",
                        color = InvPalette.coral, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.plainClick { ctx.openSmart("/inventory/supplier-import", "Supplier import") },
                    )
                    if (vm.items.isNotEmpty()) {
                        Text(
                            "⬇ CSV এক্সপোর্ট / শেয়ার",
                            color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(AlmaTheme.violet, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                                .plainClick {
                                    shareCsv(
                                        context,
                                        "inventory",
                                        headers = listOf("SKU", "Product", "Category", "Color", "Size", "Current Stock", "Available", "Reorder Level", "Stock Value"),
                                        rows = vm.items.map { it2 ->
                                            listOf(
                                                it2.sku, it2.product, it2.category ?: "", it2.color ?: "", it2.size ?: "",
                                                it2.currentStock.toString(), it2.available.toString(),
                                                it2.reorderLevel.toString(), it2.stockValue.toString(),
                                            )
                                        },
                                    )
                                }
                                .padding(vertical = 10.dp),
                        )
                    }
                }
            }
            item { Spacer(Modifier.height(64.dp)) }   // keep the FAB off the last card
        }
        }

        // Add-item FAB (the web's fixed "+ Add item" button).
        Row(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 14.dp)
                .shadow(8.dp, CircleShape, spotColor = InvPalette.coral)
                .background(InvPalette.coral, CircleShape)
                .border(1.dp, Color.White.copy(alpha = 0.25f), CircleShape)
                .plainClick { showAdd = true }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Filled.Add, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
            Text("Add item", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }

    // Detail sheet — live row lookup, so post-write reloads show fresh numbers.
    selectedSku?.let { sku ->
        val live = vm.items.firstOrNull { it.sku == sku }
        if (live != null) {
            ModalBottomSheet(onDismissRequest = { selectedSku = null }, containerColor = AlmaTheme.rootBg(dark)) {
                InvDetailSheet(live, vm, dark) { p, t -> selectedSku = null; ctx.openWebForced(p, t) }
            }
        } else {
            selectedSku = null
        }
    }

    if (showAdd) {
        ModalBottomSheet(onDismissRequest = { showAdd = false }, containerColor = AlmaTheme.rootBg(dark)) {
            InvAddSheet(vm, dark, onDone = { showAdd = false }) { p, t ->
                showAdd = false; ctx.openWebForced(p, t)
            }
        }
    }
}

// ── Count-up (iOS InvenCountUp twin — 0 → target on first appearance) ──────────────

@Composable
private fun invCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val v by animateIntAsState(if (started) target else 0, tween(900), label = "invCountUp")
    return v
}

// ── Bento hero + stat tiles (owner spec 2026-07-08 — dark anchor in BOTH themes) ────

@Composable
private fun InvHeroCard(stockValue: Int, potentialProfit: Int, totalSkus: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF181528))
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, AlmaTheme.coral.copy(alpha = 0.30f))))
            .background(
                Brush.radialGradient(
                    listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                    center = Offset(760f, 40f), radius = 520f,
                ),
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "স্টক ভ্যালু · STOCK VALUE",
            color = InvPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            AlmaTheme.takaShort(invCountUp(stockValue)),
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "অ্যাক্টিভ আইটেমের কেনা দামে মজুদ",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            InvHeroStat(
                "Potential profit", AlmaTheme.takaShort(invCountUp(potentialProfit)),
                tint = if (potentialProfit < 0) InvPalette.red500 else InvPalette.green400,
                sub = "বিক্রি হলে মুনাফা",
            )
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp)
                    .height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            InvHeroStat("Total SKUs", "${invCountUp(totalSkus)}", tint = Color.White, sub = "মোট প্রোডাক্ট")
        }
    }
}

@Composable
private fun InvHeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun InvStatTile(label: String, value: Int, sub: String, tint: Color, accent: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)))
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text("${invCountUp(value)}", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Chips / search / category ───────────────────────────────────────────────────────

@Composable
private fun InvChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) InvPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) InvPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) InvPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun InvSearchRow(vm: InventoryState, dark: Boolean, modifier: Modifier) {
    Row(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Filled.Search, contentDescription = null,
            tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(16.dp),
        )
        androidx.compose.foundation.text.BasicTextField(
            value = vm.search,
            onValueChange = { vm.search = it },
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 13.sp),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(InvPalette.coral),
            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
            decorationBox = { inner ->
                if (vm.search.isEmpty()) {
                    Text("Search SKU, product name…", color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp)
                }
                inner()
            },
        )
        if (vm.search.isNotEmpty()) {
            Icon(
                Icons.Filled.Close, contentDescription = "Clear",
                tint = AlmaTheme.inkSecondary(dark),
                modifier = Modifier.size(16.dp).plainClick { vm.search = ""; vm.appliedSearch = "" },
            )
        }
    }
}

/** The web's category <Select>, as one native dropdown menu. */
@Composable
private fun InvCategoryMenu(vm: InventoryState, dark: Boolean) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier.size(42.dp).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick { expanded = true },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.FilterList, contentDescription = "Category",
                tint = if (vm.category != null) InvPalette.coral else AlmaTheme.violet,
                modifier = Modifier.size(20.dp),
            )
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text("All categories", fontWeight = if (vm.category == null) FontWeight.SemiBold else FontWeight.Normal) },
                onClick = { vm.category = null; expanded = false },
            )
            vm.categories.forEach { c ->
                DropdownMenuItem(
                    text = { Text(c, fontWeight = if (vm.category == c) FontWeight.SemiBold else FontWeight.Normal) },
                    onClick = { vm.category = c; expanded = false },
                )
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun InvNoticeLine(message: String, tint: Color, dark: Boolean) {
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
        Text(
            "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন",
            color = AlmaTheme.ink(dark), fontSize = 14.sp, textAlign = TextAlign.Center,
        )
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(InvPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Row card (mirrors one web mobile card, action buttons included) ─────────────────

@Composable
private fun InvItemCard(item: InvItem, vm: InventoryState, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    item.sku,
                    color = InvPalette.accentText(dark), fontSize = 11.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
                Text(
                    item.product,
                    color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                val meta = listOf(
                    item.collectionCode ?: item.category,
                    item.collectionType ?: item.color,
                    item.poolLabel,
                ).filter { !it.isNullOrEmpty() }.joinToString(" · ")
                if (meta.isNotEmpty()) {
                    Text(meta, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    AlmaTheme.taka(item.stockValue),
                    color = InvPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                )
                InvStatusPill(item, dark)
            }
        }

        Row {
            InvStatCell(
                "${item.available}", "Available",
                tint = when {
                    item.available <= 0 -> InvPalette.red500
                    item.available <= item.reorderLevel -> InvPalette.amber600
                    else -> AlmaTheme.ink(dark)
                },
                dark = dark, modifier = Modifier.weight(1f),
            )
            InvStatCell("${item.currentStock}", "Stock", AlmaTheme.ink(dark), dark, Modifier.weight(1f))
            InvStatCell("${item.sold}", "Sold", AlmaTheme.ink(dark), dark, Modifier.weight(1f))
            InvStatCell("${item.returned}", "Returns", AlmaTheme.ink(dark), dark, Modifier.weight(1f))
        }

        InvUtilisationRow(item.utilisationPct, dark)

        InvActionPills(item, vm, dark)
    }
}

@Composable
private fun InvStatusPill(item: InvItem, dark: Boolean) {
    val c = item.statusColor(dark)
    Text(
        item.statusLabel,
        color = c, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(c.copy(alpha = 0.10f), CircleShape)
            .border(1.dp, c.copy(alpha = 0.25f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.5.dp),
    )
}

@Composable
private fun InvStatCell(value: String, label: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(value, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

/** Thin gold utilisation bar — the web's <Progress color="bg-gold">. */
@Composable
private fun InvUtilisationRow(pct: Int, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Utilisation $pct%", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Box(
            Modifier
                .weight(1f)
                .height(5.dp)
                .clip(CircleShape)
                .background(AlmaTheme.ink(dark).copy(alpha = 0.08f)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(pct.coerceIn(0, 100) / 100f)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(InvPalette.coral),
            )
        }
    }
}

// ── Action pills (web Adjust / Price / Archive-or-Restore) — own sheets + confirms ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InvActionPills(item: InvItem, vm: InventoryState, dark: Boolean) {
    val scope = rememberCoroutineScope()
    var showAdjust by remember { mutableStateOf(false) }
    var showEdit by remember { mutableStateOf(false) }
    var confirmArchive by remember { mutableStateOf(false) }
    var confirmRestore by remember { mutableStateOf(false) }
    val busy = item.sku in vm.busySkus

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        InvPill("Adjust", InvPalette.accentText(dark), dark, busy) { showAdjust = true }
        InvPill("Price", AlmaTheme.inkSecondary(dark), dark, busy) { showEdit = true }
        if (item.archived == true) {
            InvPill("Restore", InvPalette.positive(dark), dark, busy) { confirmRestore = true }
        } else {
            InvPill("Archive", InvPalette.red500, dark, busy) { confirmArchive = true }
        }
        if (busy) {
            CircularProgressIndicator(Modifier.size(14.dp), color = InvPalette.coral, strokeWidth = 2.dp)
        }
    }

    if (showAdjust) {
        ModalBottomSheet(onDismissRequest = { showAdjust = false }, containerColor = AlmaTheme.rootBg(dark)) {
            InvAdjustSheet(item, vm, dark) { showAdjust = false }
        }
    }
    if (showEdit) {
        ModalBottomSheet(onDismissRequest = { showEdit = false }, containerColor = AlmaTheme.rootBg(dark)) {
            InvEditSheet(item, vm, dark) { showEdit = false }
        }
    }
    if (confirmArchive) {
        AlertDialog(
            onDismissRequest = { confirmArchive = false },
            title = { Text("${item.sku} আর্কাইভ করবেন?") },
            text = { Text("SKU ${item.sku} · স্টক ${item.currentStock} পিস — আর্কাইভ করলে Active তালিকা থেকে সরে যাবে (পরে Restore করা যাবে)।") },
            confirmButton = {
                TextButton(onClick = {
                    confirmArchive = false
                    scope.launch { vm.archive(item.sku) }
                }) { Text("হ্যাঁ, আর্কাইভ করুন", color = InvPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { confirmArchive = false }) { Text("বাতিল") } },
        )
    }
    if (confirmRestore) {
        AlertDialog(
            onDismissRequest = { confirmRestore = false },
            title = { Text("${item.sku} রিস্টোর করবেন?") },
            text = { Text("SKU ${item.sku} · স্টক ${item.currentStock} পিস — আবার Active তালিকায় ফিরবে।") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRestore = false
                    scope.launch { vm.restore(item.sku) }
                }) { Text("হ্যাঁ, রিস্টোর করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmRestore = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvPill(label: String, tint: Color, dark: Boolean, busy: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = tint.copy(alpha = if (busy) 0.45f else 1f),
        fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .background(Color.White.copy(alpha = if (dark) 0.07f else 0.4f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick { if (!busy) onClick() }
            .padding(horizontal = 11.dp, vertical = 6.dp),
    )
}

// ── Adjust-stock sheet (web adjustStock prompt → native stepper + reason) ───────────

@Composable
private fun InvAdjustSheet(item: InvItem, vm: InventoryState, dark: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    // Web parity: promptDialog defaults to the current *available* quantity.
    var qtyText by remember { mutableStateOf(item.available.toString()) }
    var reason by remember { mutableStateOf("manual correction") }
    var confirming by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val qty = qtyText.trim().toIntOrNull()?.takeIf { it >= 0 }
    val delta = (qty ?: item.available) - item.available
    val deltaLabel = if (delta >= 0) "+$delta" else "$delta"

    fun save() {
        val q = qty ?: return
        if (saving) return
        saving = true
        errorText = null
        scope.launch {
            // Web parity: adjust carries the row's current buying price along.
            val err = vm.adjustStock(item.sku, q, item.buyingPrice, reason)
            saving = false
            if (err == null) onDone() else errorText = err
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("স্টক অ্যাডজাস্ট", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Text("${item.sku} · ${item.product}", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, maxLines = 2)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            InvMetric("Available", "${item.available}", dark)
            InvMetric("Stock", "${item.currentStock}", dark)
            InvMetric("Reserved", "${item.reserved}", dark)
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("নতুন পরিমাণ", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                InvStepButton("−", dark) { qtyText = maxOf(0, (qty ?: item.available) - 1).toString() }
                OutlinedTextField(
                    value = qtyText,
                    onValueChange = { qtyText = it },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
                    ),
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                        fontFamily = FontFamily.Monospace,
                    ),
                    modifier = Modifier.weight(1f),
                )
                InvStepButton("+", dark) { qtyText = ((qty ?: item.available) + 1).toString() }
            }
            if (qty == null) {
                Text("০ বা তার বেশি একটি সংখ্যা দিন", color = InvPalette.red500, fontSize = 11.sp)
            } else if (delta != 0) {
                Text(
                    "পরিবর্তন: ${item.available} → $qty ($deltaLabel)",
                    color = InvPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("কারণ", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                INV_ADJUST_REASONS.forEach { r ->
                    InvChip(r, reason == r, dark) { reason = r }
                }
            }
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                singleLine = true,
                placeholder = { Text("কারণ লিখুন…") },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        errorText?.let { Text(it, color = InvPalette.red500, fontSize = 12.sp) }

        InvBigButton(
            if (saving) "সেভ হচ্ছে…" else "সেভ করুন",
            enabled = qty != null && !saving, saving = saving,
        ) { if (qty != null) confirming = true }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("স্টক পরিবর্তন নিশ্চিত করুন") },
            text = { Text("SKU ${item.sku}: স্টক ${item.available} → ${qty ?: 0} ($deltaLabel) · কারণ: ${reason.ifEmpty { "manual correction" }}") },
            confirmButton = {
                TextButton(onClick = { confirming = false; save() }) { Text("হ্যাঁ, আপডেট করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvMetric(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun InvStepButton(symbol: String, dark: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(width = 48.dp, height = 44.dp).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(symbol, color = InvPalette.accentText(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun InvBigButton(label: String, enabled: Boolean, saving: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                if (enabled || saving) InvPalette.coral else InvPalette.coral.copy(alpha = 0.4f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .plainClick { if (enabled) onClick() }
            .padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (saving) {
            CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(label, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Price / reorder-level sheet (web updateBuyingPrice + edit reorder_level) ────────

@Composable
private fun InvEditSheet(item: InvItem, vm: InventoryState, dark: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var priceText by remember { mutableStateOf((item.buyingPrice ?: 0).toString()) }
    var reorderText by remember { mutableStateOf(item.reorderLevel.toString()) }
    var confirming by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val price = priceText.trim().toIntOrNull()?.takeIf { it >= 0 }
    val reorder = reorderText.trim().toIntOrNull()?.takeIf { it >= 0 }
    val priceChanged = price != null && price != (item.buyingPrice ?: 0)
    val reorderChanged = reorder != null && reorder != item.reorderLevel
    val valid = price != null && reorder != null && (priceChanged || reorderChanged)

    val changeSummary = buildList {
        if (priceChanged) add("দাম ৳${item.buyingPrice ?: 0} → ৳${price ?: 0}")
        if (reorderChanged) add("রিঅর্ডার লেভেল ${item.reorderLevel} → ${reorder ?: 0}")
    }.joinToString(" · ")

    fun save() {
        if (!valid || saving) return
        saving = true
        errorText = null
        scope.launch {
            val err = vm.editItem(
                item.sku,
                buyingPrice = if (priceChanged) price else null,
                reorderLevel = if (reorderChanged) reorder else null,
            )
            saving = false
            if (err == null) onDone() else errorText = err
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("দাম / রিঅর্ডার লেভেল", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Text("${item.sku} · ${item.product}", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, maxLines = 2)
        }

        InvNumberField(
            "বায়িং প্রাইস (৳)", priceText, { priceText = it },
            invalid = price == null, hint = "বর্তমান: ${AlmaTheme.taka(item.buyingPrice ?: 0)}", dark = dark,
        )
        InvNumberField(
            "রিঅর্ডার লেভেল", reorderText, { reorderText = it },
            invalid = reorder == null, hint = "বর্তমান: ${item.reorderLevel}", dark = dark,
        )

        errorText?.let { Text(it, color = InvPalette.red500, fontSize = 12.sp) }

        InvBigButton(if (saving) "সেভ হচ্ছে…" else "সেভ করুন", enabled = valid && !saving, saving = saving) {
            if (valid) confirming = true
        }
        if (!valid && price != null && reorder != null) {
            Text("কিছু পরিবর্তন করা হয়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("পরিবর্তন নিশ্চিত করুন") },
            text = { Text("SKU ${item.sku}: $changeSummary") },
            confirmButton = {
                TextButton(onClick = { confirming = false; save() }) { Text("হ্যাঁ, সেভ করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvNumberField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    invalid: Boolean,
    hint: String,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            isError = invalid,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
            ),
            textStyle = androidx.compose.ui.text.TextStyle(
                fontSize = 15.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            if (invalid) "০ বা তার বেশি একটি সংখ্যা দিন" else hint,
            color = if (invalid) InvPalette.red500 else AlmaTheme.inkSecondary(dark),
            fontSize = 11.sp,
        )
    }
}

// ── Add-product sheet (web AddProductModal, single mode) ────────────────────────────

@Composable
private fun InvAddSheet(vm: InventoryState, dark: Boolean, onDone: () -> Unit, openWeb: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var sku by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("") }
    var priceText by remember { mutableStateOf("0") }    // sell price → default_price
    var cogsText by remember { mutableStateOf("0") }     // buying price → default_cogs
    var color by remember { mutableStateOf("") }
    var size by remember { mutableStateOf("") }
    var stockText by remember { mutableStateOf("0") }    // initial_stock
    var reorderText by remember { mutableStateOf("0") }  // reorder_level
    var notes by remember { mutableStateOf("") }
    var syncToStock by remember { mutableStateOf(true) }
    var confirming by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var catMenu by remember { mutableStateOf(false) }

    fun nonNeg(s: String) = s.trim().toIntOrNull()?.takeIf { it >= 0 }
    val price = nonNeg(priceText)
    val cogs = nonNeg(cogsText)
    val stock = nonNeg(stockText)
    val reorder = nonNeg(reorderText)
    val valid = name.trim().isNotEmpty() && price != null && cogs != null && stock != null && reorder != null

    fun save() {
        if (!valid || vm.creating) return
        errorText = null
        // Same payload the web AddProductModal (single mode) posts to /api/products.
        val body = JSONObject()
            .put("name", name.trim())
            .put("default_price", price ?: 0)
            .put("default_cogs", cogs ?: 0)
            .put("initial_stock", stock ?: 0)
            .put("reorder_level", reorder ?: 0)
            .put("supplier", "manual")
            .put("sync_to_stock", syncToStock)
            .put("skip_duplicate_name_check", false)
        if (sku.trim().isNotEmpty()) body.put("sku", sku.trim())
        if (category.trim().isNotEmpty()) body.put("category", category.trim())
        if (color.trim().isNotEmpty()) body.put("color", color.trim())
        if (size.trim().isNotEmpty()) body.put("size", size.trim())
        if (notes.trim().isNotEmpty()) body.put("notes", notes.trim())
        scope.launch {
            val err = vm.createProduct(body)
            if (err == null) onDone() else errorText = err
        }
    }

    LazyColumn(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 26.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("নতুন আইটেম যোগ করুন", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "সিঙ্গেল প্রোডাক্ট — কালেকশন/বাল্ক ও ছবি আপলোড ওয়েবে",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
        }
        item { InvTextField("প্রোডাক্টের নাম *", name, { name = it }, "যেমন: Premium Panjabi", dark) }
        item { InvTextField("SKU (খালি রাখলে অটো)", sku, { sku = it }, "AUTO", dark, mono = true) }
        item {
            // Category — free text with a menu of existing categories (web select + Other).
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("ক্যাটাগরি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = category,
                        onValueChange = { category = it },
                        singleLine = true,
                        placeholder = { Text("যেমন: Panjabi") },
                        modifier = Modifier.weight(1f),
                    )
                    Box {
                        Box(
                            Modifier.size(42.dp).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick { catMenu = true },
                            contentAlignment = Alignment.Center,
                        ) { Text("▾", color = AlmaTheme.violet, fontSize = 15.sp) }
                        DropdownMenu(expanded = catMenu, onDismissRequest = { catMenu = false }) {
                            vm.categories.forEach { c ->
                                DropdownMenuItem(text = { Text(c) }, onClick = { category = c; catMenu = false })
                            }
                        }
                    }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                InvNumberField("সেল প্রাইস (৳)", priceText, { priceText = it }, price == null, "", dark, Modifier.weight(1f))
                InvNumberField("বায়িং প্রাইস (৳)", cogsText, { cogsText = it }, cogs == null, "", dark, Modifier.weight(1f))
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) { InvTextField("কালার", color, { color = it }, "—", dark) }
                Box(Modifier.weight(1f)) { InvTextField("সাইজ", size, { size = it }, "—", dark) }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                InvNumberField("শুরুর স্টক", stockText, { stockText = it }, stock == null, "", dark, Modifier.weight(1f))
                InvNumberField("রিঅর্ডার লেভেল", reorderText, { reorderText = it }, reorder == null, "", dark, Modifier.weight(1f))
            }
        }
        item { InvTextField("নোট", notes, { notes = it }, "ঐচ্ছিক", dark) }
        item {
            Row(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text("ইনভেন্টরিতে স্টক রো যোগ করুন", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("বন্ধ করলে শুধু ক্যাটালগে সেভ হবে", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
                Switch(
                    checked = syncToStock,
                    onCheckedChange = { syncToStock = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = InvPalette.coral),
                )
            }
        }
        errorText?.let { e -> item { Text(e, color = InvPalette.red500, fontSize = 12.sp) } }
        item {
            InvBigButton(
                if (vm.creating) "সেভ হচ্ছে…" else "+ Add item",
                enabled = valid && !vm.creating, saving = vm.creating,
            ) { if (valid) confirming = true }
        }
        item {
            // Photo upload + collection/bulk mode stay on the proven web modal.
            Text(
                "🌐 ছবি / কালেকশন-বাল্ক মোড — ওয়েব ভার্সন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { openWeb("/inventory", "Inventory") }
                    .padding(vertical = 4.dp),
            )
        }
    }

    if (confirming) {
        val skuBit = if (sku.trim().isEmpty()) "" else " · SKU ${sku.trim()}"
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("নতুন আইটেম তৈরি করবেন?") },
            text = { Text("${name.trim()}$skuBit · শুরুর স্টক ${stock ?: 0} পিস · সেল ৳${price ?: 0} · বায়িং ৳${cogs ?: 0}") },
            confirmButton = {
                TextButton(onClick = { confirming = false; save() }) { Text("হ্যাঁ, তৈরি করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun InvTextField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    dark: Boolean,
    mono: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            placeholder = { Text(placeholder) },
            textStyle = androidx.compose.ui.text.TextStyle(
                fontSize = 13.sp,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ── Detail sheet (full data + the same native actions) ──────────────────────────────

@Composable
private fun InvDetailSheet(item: InvItem, vm: InventoryState, dark: Boolean, openWeb: (String, String) -> Unit) {
    LazyColumn(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = PaddingValues(bottom = 26.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        item.sku,
                        color = InvPalette.accentText(dark), fontSize = 12.sp,
                        fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    )
                    Spacer(Modifier.weight(1f))
                    InvStatusPill(item, dark)
                }
                Text(item.product, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                item.barcode?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            }
        }
        item {
            // Quantities — the web table's columns plus reserve/damage, with warnings.
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                InvSectionLabel("Stock", dark)
                InvGrid(
                    listOf(
                        Triple(
                            "Available", "${item.available}",
                            when {
                                item.available <= 0 -> InvPalette.red500
                                item.available <= item.reorderLevel -> InvPalette.amber600
                                else -> AlmaTheme.ink(dark)
                            },
                        ),
                        Triple("Current stock", "${item.currentStock}", AlmaTheme.ink(dark)),
                        Triple("Reserved", "${item.reserved}", AlmaTheme.ink(dark)),
                        Triple("Sold", "${item.sold}", AlmaTheme.ink(dark)),
                        Triple("Returned", "${item.returned}", AlmaTheme.ink(dark)),
                        Triple("Damaged", "${item.damaged}", AlmaTheme.ink(dark)),
                        Triple("Opening", "${item.opening}", AlmaTheme.ink(dark)),
                        Triple("Purchased", "${item.purchased}", AlmaTheme.ink(dark)),
                        Triple("Reorder level", "${item.reorderLevel}", AlmaTheme.ink(dark)),
                    ),
                    dark,
                )
                if (item.archived != true && item.available > 0 && item.available <= item.reorderLevel) {
                    InvWarnStrip("Low stock — reorder level ${item.reorderLevel}", InvPalette.amber500, InvPalette.amber600)
                }
                if (item.archived != true && item.available <= 0) {
                    InvWarnStrip("Out of stock", InvPalette.red500, InvPalette.red500)
                }
                InvUtilisationRow(item.utilisationPct, dark)
            }
        }
        item {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                InvSectionLabel("Value", dark)
                InvGrid(
                    listOf(
                        Triple("Stock value", AlmaTheme.taka(item.stockValue), InvPalette.accentText(dark)),
                        Triple("Sell value", AlmaTheme.taka(item.sellValue), AlmaTheme.ink(dark)),
                        Triple(
                            "Potential profit", AlmaTheme.taka(item.potentialProfit),
                            if (item.potentialProfit >= 0) InvPalette.positive(dark) else InvPalette.red500,
                        ),
                        Triple("Buying price", item.buyingPrice?.let { AlmaTheme.taka(it) } ?: "—", AlmaTheme.ink(dark)),
                        Triple("Selling price", item.sellingPrice?.let { AlmaTheme.taka(it) } ?: "—", AlmaTheme.ink(dark)),
                    ),
                    dark,
                )
            }
        }
        item {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                InvSectionLabel("Product", dark)
                InvGrid(
                    listOf(
                        Triple("Collection", item.collectionCode ?: "—", AlmaTheme.ink(dark)),
                        Triple("Type", item.collectionType ?: item.category ?: "—", AlmaTheme.ink(dark)),
                        Triple("Category", item.category ?: "—", AlmaTheme.ink(dark)),
                        Triple("Size / Variant", item.poolLabel ?: "—", AlmaTheme.ink(dark)),
                        Triple("Color", item.color ?: "—", AlmaTheme.ink(dark)),
                    ),
                    dark,
                )
            }
        }
        item {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                InvSectionLabel("Actions", dark)
                InvActionPills(item, vm, dark)
                vm.notice?.let { Text(it, color = InvPalette.positive(dark), fontSize = 12.sp) }
                vm.error?.let { Text(it, color = InvPalette.red500, fontSize = 12.sp) }
                Text(
                    "🌐 ছবি আপলোড / ওয়েব ভার্সন",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    modifier = Modifier.plainClick {
                        // Uploads stay on the web — escape with the SKU prefilled.
                        val q = URLEncoder.encode(item.sku, "UTF-8")
                        openWeb("/inventory?q=$q", "Inventory")
                    },
                )
            }
        }
    }
}

@Composable
private fun InvSectionLabel(label: String, dark: Boolean) {
    Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun InvGrid(rows: List<Triple<String, String, Color>>, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        rows.chunked(3).forEach { chunk ->
            Row {
                chunk.forEach { (label, value, tint) ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Black)
                        Text(
                            value, color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                repeat(3 - chunk.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun InvWarnStrip(message: String, tint: Color, text: Color) {
    Text(
        message,
        color = text, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tint.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp),
    )
}
