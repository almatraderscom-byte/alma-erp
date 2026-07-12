//
//  CatalogImagesScreen.kt
//  ALMA ERP — the agent Product Images screen (/agent/catalog-images), ported from
//  CatalogImagesSwiftUI.swift. Browse coverage + galleries natively (Coil AsyncImage):
//  3 coverage KPI cards (মোট প্রোডাক্ট / ছবি আছে / ছবি নেই) · search (কোড/নাম/ক্যাটাগরি) ·
//  filter chips সব/ছবি নেই/ছবি আছে · Photos-style product grid with count + family-set
//  badges · detail sheet = read-only gallery with প্রধান badge. Upload / add-new /
//  delete need multipart + PhotosPicker → web escape (/agent/catalog-images).
//
//  Endpoints (same as web/iOS):
//    GET /api/assistant/catalog/products       → { ok, groups, totalGroups, withImages, missing }
//    GET /api/assistant/catalog/images/{code}  → { ok, images: [{id, url, storagePath, isPrimary}] }
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
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
import kotlinx.coroutines.launch
import org.json.JSONObject

// ── Palette (exact hexes from the iOS CatalogImagePalette) ─────────────────────────

private object CatPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber500 = Color(0xFFF59E0B)
    val amber600 = Color(0xFFD97706)
    val blue = Color(0xFF3D8BFD)
    val sage = Color(0xFF81B29A)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models ─────────────────────────────────────────────────────────────────────────

private data class CatalogGroup(
    val code: String,
    val name: String,
    val category: String,
    val kind: String,
    val members: List<String>,
    val imageCount: Int,
    val hasImages: Boolean,
    val primaryImageUrl: String?,
) {
    val isCollection: Boolean get() = kind == "collection"

    companion object {
        fun from(o: JSONObject): CatalogGroup? {
            val code = o.str("code")?.takeIf { it.isNotEmpty() } ?: return null
            val members = o.optJSONArray("members")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it, null) }
            } ?: emptyList()
            val count = o.flexInt("imageCount") ?: 0
            return CatalogGroup(
                code = code,
                name = o.str("name") ?: "",
                category = o.str("category") ?: "",
                kind = o.str("kind") ?: "sku",
                members = members,
                imageCount = count,
                hasImages = o.flexBool("hasImages") ?: (count > 0),
                primaryImageUrl = o.str("primaryImageUrl"),
            )
        }
    }
}

private data class CatalogImage(val id: String, val url: String?, val isPrimary: Boolean) {
    companion object {
        fun from(o: JSONObject): CatalogImage? {
            val storage = o.str("storagePath")
            val id = o.str("id") ?: storage ?: return null
            return CatalogImage(id = id, url = o.str("url"), isPrimary = o.flexBool("isPrimary") ?: false)
        }
    }
}

/** Image URLs may be absolute (Supabase) or app-relative — resolve both. */
private fun resolveUrl(raw: String?): String? {
    if (raw.isNullOrEmpty()) return null
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
    return AlmaTheme.BASE_URL + if (raw.startsWith("/")) raw else "/$raw"
}

// ── State holder (iOS CatalogImagesVM twin) ────────────────────────────────────────

private class CatalogImagesState {
    var groups by mutableStateOf(listOf<CatalogGroup>())
    var totalGroups by mutableStateOf(0)
    var withImages by mutableStateOf(0)
    var missing by mutableStateOf(0)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var filter by mutableStateOf("all")   // all | missing | with
    var query by mutableStateOf("")

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    val filtered: List<CatalogGroup>
        get() {
            val q = query.trim().lowercase()
            return groups.filter { g ->
                when {
                    filter == "missing" && g.hasImages -> false
                    filter == "with" && !g.hasImages -> false
                    q.isEmpty() -> true
                    else -> g.code.lowercase().contains(q) ||
                        g.name.lowercase().contains(q) ||
                        g.category.lowercase().contains(q) ||
                        g.members.any { it.lowercase().contains(q) }
                }
            }
        }

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/assistant/catalog/products"))
            groups = c.optJSONArray("groups")?.mapObjects { CatalogGroup.from(it) } ?: emptyList()
            totalGroups = c.flexInt("totalGroups") ?: groups.size
            withImages = c.flexInt("withImages") ?: groups.count { it.hasImages }
            missing = c.flexInt("missing") ?: groups.count { !it.hasImages }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "লোড করা গেল না"
        } finally {
            loading = false
        }
    }

    suspend fun loadImages(code: String): List<CatalogImage> {
        val enc = java.net.URLEncoder.encode(code, "UTF-8")
        val c = unwrap(AlmaApi.getObject("/api/assistant/catalog/images/$enc"))
        return c.optJSONArray("images")?.mapObjects { CatalogImage.from(it) } ?: emptyList()
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogImagesScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { CatalogImagesState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<CatalogGroup?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(2.dp)) }
        if (vm.authExpired) item { AuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        vm.error?.let { item { ErrorCard(it, dark) { scope.launch { vm.load() } } } }
        item { KpiStrip(vm, dark) }
        item { SearchField(vm, dark) }
        item { FilterChips(vm, dark) }
        item { NewProductButton(dark) { ctx.openWebForced("/agent/catalog-images", "Product images") } }
        item {
            ProductGrid(vm, dark, loading = vm.loading && vm.groups.isEmpty()) { selected = it }
        }
        if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
            item { EmptyState(dark) }
        }
        item {
            Text(
                "🌐 আপলোড/এডিট — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().plainClick { ctx.openWebForced("/agent/catalog-images", "Product images") }.padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    selected?.let { g ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            DetailSheet(g, vm, dark) { path, title -> selected = null; ctx.openWebForced(path, title) }
        }
    }
}

// ── KPI strip + controls ───────────────────────────────────────────────────────────

@Composable
private fun KpiStrip(vm: CatalogImagesState, dark: Boolean) {
    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        KpiCard("মোট প্রোডাক্ট", vm.totalGroups, AlmaTheme.ink(dark), dark, Modifier.weight(1f))
        KpiCard("ছবি আছে", vm.withImages, CatPalette.sage, dark, Modifier.weight(1f))
        KpiCard("ছবি নেই", vm.missing, CatPalette.amber500, dark, Modifier.weight(1f))
    }
}

@Composable
private fun KpiCard(label: String, value: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text("$value", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
    }
}

@Composable
private fun SearchField(vm: CatalogImagesState, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("🔍", fontSize = 13.sp)
        androidx.compose.foundation.text.BasicTextField(
            value = vm.query,
            onValueChange = { vm.query = it },
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(CatPalette.coral),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (vm.query.isEmpty()) Text("কোড / নাম / ক্যাটাগরি খুঁজুন…", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
                    inner()
                }
            },
        )
        if (vm.query.isNotEmpty()) {
            Text("✕", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, modifier = Modifier.plainClick { vm.query = "" })
        }
    }
}

@Composable
private fun FilterChips(vm: CatalogImagesState, dark: Boolean) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        listOf("সব" to "all", "ছবি নেই" to "missing", "ছবি আছে" to "with").forEach { (label, key) ->
            CatChip(label, vm.filter == key, dark) { vm.filter = key }
        }
    }
}

@Composable
private fun CatChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) CatPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) CatPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f) else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) CatPalette.coral.copy(alpha = 0.55f) else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun NewProductButton(dark: Boolean, onClick: () -> Unit) {
    Text(
        "+ নতুন প্রোডাক্ট যোগ করুন",
        color = CatPalette.blue, fontSize = 13.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .background(CatPalette.blue.copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, CatPalette.blue.copy(alpha = 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onClick)
            .padding(vertical = 11.dp),
    )
}

// ── Product grid ───────────────────────────────────────────────────────────────────

@Composable
private fun ProductGrid(vm: CatalogImagesState, dark: Boolean, loading: Boolean, onTap: (CatalogGroup) -> Unit) {
    if (loading) {
        // Simple 2-row skeleton — the LazyColumn already scrolls, so a fixed-height grid is fine.
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            repeat(2) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(3) { Box(Modifier.weight(1f).aspectRatio(0.8f).almaGlass(dark, AlmaTheme.R_CONTROL)) }
                }
            }
        }
        return
    }
    val rows = vm.filtered.chunked(3)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { g -> ProductCard(g, dark, Modifier.weight(1f)) { onTap(g) } }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun ProductCard(g: CatalogGroup, dark: Boolean, modifier: Modifier, onTap: () -> Unit) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onTap),
    ) {
        Box {
            ImageSquare(resolveUrl(g.primaryImageUrl), dark, RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp))
            // Count badge (top-right): green "N ছবি" or amber "ছবি নেই".
            Text(
                if (g.hasImages) "${g.imageCount} ছবি" else "ছবি নেই",
                color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .align(Alignment.TopEnd).padding(5.dp)
                    .background((if (g.hasImages) CatPalette.sage else CatPalette.amber500).copy(alpha = 0.92f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 2.5.dp),
            )
            if (g.isCollection) {
                Text(
                    "সেট ×${g.members.size}",
                    color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .align(Alignment.TopStart).padding(5.dp)
                        .background(CatPalette.blue.copy(alpha = 0.92f), CircleShape)
                        .padding(horizontal = 7.dp, vertical = 2.5.dp),
                )
            }
        }
        Column(Modifier.padding(8.dp)) {
            Text(g.code, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            Text(
                g.name.ifEmpty { g.category.ifEmpty { "—" } },
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ImageSquare(url: String?, dark: Boolean, shape: androidx.compose.ui.graphics.Shape) {
    Box(
        Modifier.fillMaxWidth().aspectRatio(1f).clip(shape).background(Color.Black.copy(alpha = 0.12f)),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text("🖼️", fontSize = 22.sp, modifier = Modifier.alpha(0.4f))
        }
    }
}

// ── Detail sheet (read-only gallery; upload/delete stay on the web) ─────────────────

@Composable
private fun DetailSheet(g: CatalogGroup, vm: CatalogImagesState, dark: Boolean, openWeb: (String, String) -> Unit) {
    var images by remember { mutableStateOf<List<CatalogImage>?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(g.code) {
        failed = false
        try { images = vm.loadImages(g.code) } catch (_: Exception) { failed = true }
    }

    Column(
        Modifier.fillMaxWidth().padding(18.dp).padding(bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(g.code, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                if (g.isCollection) {
                    Text(
                        "ফ্যামিলি সেট ×${g.members.size}", color = CatPalette.blue, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(CatPalette.blue.copy(alpha = 0.14f), CircleShape).padding(horizontal = 8.dp, vertical = 2.5.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                val count = maxOf(g.imageCount, images?.size ?: 0)
                Text(
                    if (g.hasImages || (images?.isNotEmpty() == true)) "$count ছবি" else "ছবি নেই",
                    color = if (g.hasImages || (images?.isNotEmpty() == true)) CatPalette.sage else CatPalette.amber600,
                    fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
            }
            Text(g.name.ifEmpty { g.category.ifEmpty { "—" } }, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            if (g.isCollection) {
                Text("মেম্বার: ${g.members.joinToString(", ")}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }

        // Upload note → web escape (multipart + picker not native).
        Text(
            "📤 ছবি আপলোড / মুছে ফেলা — ওয়েবে খুলুন",
            color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(CatPalette.blue, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick { openWeb("/agent/catalog-images", "Product images") }
                .padding(vertical = 12.dp),
        )

        Text("বর্তমান ছবি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Medium)

        when {
            images == null -> Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CONTROL))
            failed -> Text("লোড করা গেল না", color = CatPalette.red500, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), textAlign = TextAlign.Center)
            images!!.isEmpty() -> Text("এখনো কোনো ছবি নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), textAlign = TextAlign.Center)
            else -> {
                images!!.chunked(3).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { img ->
                            Box(Modifier.weight(1f)) {
                                ImageSquare(resolveUrl(img.url), dark, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                                if (img.isPrimary) {
                                    Text(
                                        "প্রধান", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                        modifier = Modifier
                                            .align(Alignment.TopStart).padding(4.dp)
                                            .background(CatPalette.coral.copy(alpha = 0.92f), CircleShape)
                                            .padding(horizontal = 6.dp, vertical = 2.dp),
                                    )
                                }
                            }
                        }
                        repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun AuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(CatPalette.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun ErrorCard(msg: String, dark: Boolean, onRetry: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("⚠️ $msg", color = CatPalette.red500, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(
            "আবার চেষ্টা", color = CatPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.plainClick(onRetry),
        )
    }
}

@Composable
private fun EmptyState(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("🖼️", fontSize = 34.sp)
        Text("কোনো প্রোডাক্ট মিলল না।", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
    }
}
