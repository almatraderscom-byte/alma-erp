//
//  SupplierImportScreen.kt
//  ALMA ERP — the Supplier-import page, ported 1:1 from SupplierImportSwiftUI.swift
//  (READ-ONLY).
//
//  Mirrors the readable half of the web /inventory/supplier-import page:
//    GET /api/products → PRODUCT MASTER catalog { products, total }
//                        (flat — {ok,data} unwrapped defensively)
//  The web page's write path (paste scraped JSON → preview → POST
//  /api/supplier-import/commit) needs a file/clipboard workflow that is web-only by
//  design — the native screen shows the catalog state the importer appends into
//  (grouped by update-day as "import batches", status pills, batch detail sheet)
//  and hands off to the web page for the actual import.
//

package com.almatraders.erp.pages

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.SolidColor
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
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SupPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web ProductsResponse declares) ─────────────────────

private data class SupProduct(
    val id: String,
    val sku: String?,
    val name: String,
    val category: String?,
    val defaultPrice: Int?,
    val defaultCogs: Int?,     // server redacts for non-owner roles → null
    val active: Boolean?,
    val notes: String?,
    val updatedAt: String?,
) {
    companion object {
        fun from(o: JSONObject): SupProduct? {
            val id = o.str("id") ?: return null
            return SupProduct(
                id = id,
                sku = o.str("sku"),
                name = o.str("name") ?: "—",
                category = o.str("category"),
                defaultPrice = o.flexInt("default_price"),
                defaultCogs = o.flexInt("default_cogs"),
                active = o.flexBool("active"),
                notes = o.str("notes"),
                updatedAt = o.str("updated_at"),
            )
        }
    }
}

/** One "import batch" — the catalog grouped by the day rows last changed. */
private data class SupBatch(
    val id: String,                    // "yyyy-MM-dd" day key (Asia/Dhaka) or "unknown"
    val label: String,                 // display date
    val products: List<SupProduct>,
    val isRecent: Boolean,             // within the last 7 days
)

// ── State holder (iOS SupplierImportVM twin) ────────────────────────────────────────

private class SupplierImportState {
    var products by mutableStateOf(listOf<SupProduct>())
    var total by mutableStateOf(0)
    var search by mutableStateOf("")
    var categoryFilter by mutableStateOf<String?>(null)   // null = All
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            // /api/products answers flat { products, total } — unwrap {ok,data} too.
            val root = AlmaApi.getObject("/api/products")
            val c = root.optJSONObject("data") ?: root
            products = c.optJSONArray("products")?.mapObjects { SupProduct.from(it) } ?: emptyList()
            total = c.flexInt("total") ?: products.size
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "তালিকা লোড করা যায়নি।"
        } finally {
            loading = false
        }
    }

    // ── Derived state ──

    val filtered: List<SupProduct>
        get() {
            var list = products
            categoryFilter?.let { cat -> list = list.filter { (it.category ?: "") == cat } }
            val q = search.trim().lowercase()
            if (q.isEmpty()) return list
            return list.filter {
                it.name.lowercase().contains(q) ||
                    (it.sku ?: "").lowercase().contains(q) ||
                    (it.category ?: "").lowercase().contains(q)
            }
        }

    /** Top categories by product count (chip row), capped so the row stays sane. */
    val topCategories: List<Pair<String, Int>>
        get() {
            val counts = mutableMapOf<String, Int>()
            for (p in products) {
                val c = (p.category ?: "").trim()
                if (c.isEmpty()) continue
                counts[c] = (counts[c] ?: 0) + 1
            }
            return counts.entries
                .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
                .take(8)
                .map { it.key to it.value }
        }

    val categoryCount: Int
        get() = products.mapNotNull { p ->
            val c = (p.category ?: "").trim()
            c.ifEmpty { null }
        }.distinct().size

    val newInSevenDays: Int
        get() = products.count { SupFormat.isWithinDays(it.updatedAt, 7) }

    val activeCount: Int get() = products.count { it.active != false }

    /** Day-groups, newest first; undated rows sink to a trailing "unknown" batch. */
    val batches: List<SupBatch>
        get() {
            val groups = mutableMapOf<String, MutableList<SupProduct>>()
            for (p in filtered) {
                val key = SupFormat.dayKey(p.updatedAt) ?: "unknown"
                groups.getOrPut(key) { mutableListOf() }.add(p)
            }
            val keys = groups.keys.sortedWith { a, b ->
                when {
                    a == "unknown" -> 1
                    b == "unknown" -> -1
                    else -> b.compareTo(a)
                }
            }
            return keys.take(14).map { key ->
                val rows = (groups[key] ?: emptyList()).sortedBy { it.name }
                SupBatch(
                    id = key,
                    label = if (key == "unknown") "তারিখ নেই" else (SupFormat.dayLabel(key) ?: key),
                    products = rows,
                    isRecent = key != "unknown" && SupFormat.isWithinDays(rows.firstOrNull()?.updatedAt, 7),
                )
            }
        }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupplierImportScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SupplierImportState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<SupBatch?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(top = 6.dp, bottom = 8.dp),
    ) {
        if (vm.authExpired) {
            item { SupAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { err ->
            item {
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(err, color = SupPalette.red500, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text(
                        "আবার চেষ্টা",
                        color = SupPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.plainClick { scope.launch { vm.load() } },
                    )
                }
            }
        }
        item { SupHeroCard(vm.total, vm.categoryCount, vm.newInSevenDays, vm.activeCount) }
        item { SupSearchField(vm, dark) }
        if (vm.topCategories.isNotEmpty()) {
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SupChip("All", vm.categoryFilter == null, dark) { vm.categoryFilter = null }
                    vm.topCategories.forEach { (name, count) ->
                        SupChip("$name · $count", vm.categoryFilter == name, dark) {
                            vm.categoryFilter = if (vm.categoryFilter == name) null else name
                        }
                    }
                }
            }
        }
        if (vm.loading && vm.products.isEmpty()) {
            items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
        }
        val batches = vm.batches
        if (batches.isNotEmpty()) {
            item {
                Text(
                    "PRODUCT MASTER — দিন-ভিত্তিক ব্যাচ",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
            items(batches) { batch ->
                SupBatchCard(batch, dark) { selected = batch }
            }
        } else if (vm.products.isNotEmpty() && !vm.loading) {
            item {
                Text(
                    "এই ফিল্টারে কিছু পাওয়া যায়নি",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                )
            }
        }
        if (!vm.loading && vm.products.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("📦", fontSize = 34.sp)
                    Text("কোনো পণ্য পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    Text(
                        "ইমপোর্ট চালালে PRODUCT MASTER-এর পণ্য এখানে দেখা যাবে।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }
        }
        item { SupImportGuide(dark) { ctx.openWebForced("/inventory/supplier-import", "Supplier import") } }
        item {
            Text(
                "🌐 সব অপশন (ইমপোর্ট সহ) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/inventory/supplier-import", "Supplier import") }
                    .padding(vertical = 6.dp),
            )
        }
    }

    selected?.let { batch ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            SupBatchSheet(batch, dark) {
                selected = null
                ctx.openWebForced("/inventory/supplier-import", "Supplier import")
            }
        }
    }
}

// ── Count-up (iOS SupCountUp twin) ──────────────────────────────────────────────────

@Composable
private fun supCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val v by animateIntAsState(if (started) target else 0, tween(900), label = "supCountUp")
    return v
}

// ── Bento hero (dark anchor in BOTH themes — Dashboard hero recipe) ─────────────────

@Composable
private fun SupHeroCard(products: Int, categories: Int, newInWeek: Int, active: Int) {
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
            "ক্যাটালগ · PRODUCTS",
            color = SupPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            "${supCountUp(products)}",
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "সাপ্লায়ার ক্যাটালগে লোড করা",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.Top) {
            SupHeroStat("Categories", categories, Color.White, "ক্যাটাগরি")
            SupHeroDivider()
            SupHeroStat("New · ৭ দিন", newInWeek, SupPalette.green400, "নতুন")
            SupHeroDivider()
            SupHeroStat("Active", active, SupPalette.green400, "চালু")
        }
    }
}

@Composable
private fun SupHeroDivider() {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(40.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun SupHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text("${supCountUp(value)}", color = tint, fontSize = 18.sp, fontWeight = FontWeight.Black)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Search / chips ──────────────────────────────────────────────────────────────────

@Composable
private fun SupSearchField(vm: SupplierImportState, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Filled.Search, contentDescription = null,
            tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(16.dp),
        )
        BasicTextField(
            value = vm.search,
            onValueChange = { vm.search = it },
            singleLine = true,
            textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 13.sp),
            cursorBrush = SolidColor(SupPalette.coral),
            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
            decorationBox = { inner ->
                if (vm.search.isEmpty()) {
                    Text("পণ্য খুঁজুন (নাম / SKU / ক্যাটাগরি)", color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp)
                }
                inner()
            },
        )
        if (vm.search.isNotEmpty()) {
            Icon(
                Icons.Filled.Close, contentDescription = "Clear",
                tint = AlmaTheme.inkSecondary(dark),
                modifier = Modifier.size(16.dp).plainClick { vm.search = "" },
            )
        }
    }
}

@Composable
private fun SupChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SupPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SupPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SupPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun SupAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SupPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Batch card (one day-group of PRODUCT MASTER rows) ───────────────────────────────

@Composable
private fun SupBatchCard(batch: SupBatch, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                batch.label,
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            if (batch.isRecent) {
                SupStatusPill("সাম্প্রতিক", SupPalette.emerald600, SupPalette.emerald600)
            }
            SupStatusPill("${batch.products.size} পণ্য", SupPalette.coral, SupPalette.accentText(dark))
        }
        Text(
            supCategoriesLine(batch),
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            supPriceRange(batch)?.let {
                Text(
                    it,
                    color = SupPalette.accentText(dark), fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(Modifier.weight(1f))
            Text("বিস্তারিত ›", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private fun supCategoriesLine(batch: SupBatch): String {
    val counts = mutableMapOf<String, Int>()
    for (p in batch.products) {
        val c = (p.category ?: "").trim().ifEmpty { "Uncategorized" }
        counts[c] = (counts[c] ?: 0) + 1
    }
    val top = counts.entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
    val shown = top.take(3).joinToString(" · ") { "${it.key} (${it.value})" }
    return if (top.size > 3) "$shown +${top.size - 3}" else shown
}

private fun supPriceRange(batch: SupBatch): String? {
    val prices = batch.products.mapNotNull { it.defaultPrice }
    val lo = prices.minOrNull() ?: return null
    val hi = prices.maxOrNull() ?: return null
    return if (lo == hi) AlmaTheme.taka(lo) else "${AlmaTheme.taka(lo)} – ${AlmaTheme.taka(hi)}"
}

@Composable
private fun SupStatusPill(label: String, tint: Color, text: Color) {
    Text(
        label,
        color = text, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

// ── Batch detail sheet (product rows: name · SKU · category · price · pill) ─────────

@Composable
private fun SupBatchSheet(batch: SupBatch, dark: Boolean, openWeb: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(bottom = 26.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.padding(bottom = 4.dp)) {
                Text(batch.label, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "${batch.products.size} পণ্য · PRODUCT MASTER",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
        }
        items(batch.products) { p ->
            SupProductRow(p, dark)
        }
        item {
            Text(
                "🌐 সব অপশন — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick(openWeb)
                    .padding(vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun SupProductRow(p: SupProduct, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Text(
                p.name,
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            p.defaultPrice?.let {
                Spacer(Modifier.width(6.dp))
                Text(
                    AlmaTheme.taka(it),
                    color = SupPalette.accentText(dark), fontSize = 13.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                p.sku ?: "— auto —",
                color = SupPalette.accentText(dark), fontSize = 11.sp, fontFamily = FontFamily.Monospace,
            )
            p.category?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1)
            }
            Spacer(Modifier.weight(1f))
            val inactive = p.active == false
            val pillTint = if (inactive) SupPalette.red500 else SupPalette.green400
            Text(
                if (inactive) "Inactive" else "Active",
                color = pillTint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(pillTint.copy(alpha = 0.12f), CircleShape)
                    .padding(horizontal = 5.dp, vertical = 1.5.dp),
            )
        }
        p.notes?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ── Import guide (the web page's 5 steps, read-only digest) ─────────────────────────

@Composable
private fun SupImportGuide(dark: Boolean, openWeb: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "ইমপোর্ট কীভাবে চলে".uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
        )
        SupGuideRow("1", "One-time scrape (CDP) — Chrome থেকে Smart China Hub স্ক্র্যাপ", dark)
        SupGuideRow("2", "Paste scraped JSON — tmp/supplier-products.json ওয়েব পেজে পেস্ট", dark)
        SupGuideRow("3", "Category mapping — সাপ্লায়ার ক্যাটাগরি → আপনার ক্যাটাগরি", dark)
        SupGuideRow("4", "Preview & duplicates — Ready / Dup SKU / Dup ID / Dup name / Invalid", dark)
        SupGuideRow("5", "Commit import — PRODUCT MASTER-এ append (পুরনো SKU কখনো overwrite হয় না)", dark)
        Text(
            "ফাইল/JSON পেস্ট করে ইমপোর্ট চালানো শুধু ওয়েবে হয় — নিচের বাটনে খুলুন।",
            color = SupPalette.amber600, fontSize = 11.sp,
        )
        Text(
            "⬇️ ওয়েবে ইমপোর্ট চালান",
            color = SupPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(SupPalette.coral.copy(alpha = 0.13f), CircleShape)
                .border(1.dp, SupPalette.coral.copy(alpha = 0.35f), CircleShape)
                .plainClick(openWeb)
                .padding(vertical = 9.dp),
        )
    }
}

@Composable
private fun SupGuideRow(n: String, text: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier.size(18.dp).background(SupPalette.coral.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(n, color = SupPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        Text(text, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, modifier = Modifier.weight(1f))
    }
}

// ── Formatting helpers (Asia/Dhaka business days) ───────────────────────────────────

private object SupFormat {
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

    /** updated_at → "yyyy-MM-dd" in Asia/Dhaka (import batches are Dhaka days). */
    fun dayKey(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** "2026-07-05" → "5 Jul 2026" style medium date. */
    fun dayLabel(key: String): String? {
        return try {
            val inF = SimpleDateFormat("yyyy-MM-dd", Locale.US)
            inF.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
            val d = inF.parse(key) ?: return null
            val outF = SimpleDateFormat("d MMM yyyy", Locale.US)
            outF.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
            outF.format(d)
        } catch (_: Exception) {
            null
        }
    }

    fun isWithinDays(iso: String?, days: Int): Boolean {
        val date = parse(iso) ?: return false
        return date.time > System.currentTimeMillis() - days.toLong() * 86_400_000L
    }
}
