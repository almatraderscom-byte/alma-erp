//
//  CreativeStudioScreen.kt
//  ALMA ERP — native Creative Studio, ported from CreativeStudioSwiftUI.swift (build 66).
//  Image-forward "professional AI studio" over the shared aurora: 6-tab floating bar
//  (হোম / তৈরি / গ্যালারি / ভিডিও / অডিও / লাইব্রেরি). Home + gallery + Create (native
//  product-photo → Auto generate) + item actions are native (Coil AsyncImage + the
//  system Photo Picker). Only the long video/audio labs stay web-escape buttons.
//
//  Endpoints (same JSON APIs the web/iOS page calls, via AlmaApi cookie bridge):
//    GET  /api/assistant/creative-studio/config          → { organization, *Configured }
//    GET  /api/assistant/creative-studio/gallery?page=&limit=  → { items, hasMore, total }
//    GET  /api/assistant/brand-models                    → { models: [...] }
//    POST /api/assistant/creative-studio/run             → { message, provider }  (text/tap flows)
//    POST /api/assistant/creative-studio/jobs/{id}/retry
//    POST /api/assistant/creative-studio/finish          → { framedPath, framedUrl }
//    POST /api/assistant/creative-studio/feedback        (good|bad scene weighting)
//    POST /api/assistant/creative-studio/model-creator   (role-based brand model)
//    POST /api/assistant/brand-models                    (add | set_default | remove)
//  Deferred to web (/agent/creative-studio): photo uploads, Advanced create slots,
//  video upload+recipes, audio lab, logo, drag/resize finishing editor.
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import androidx.compose.ui.platform.LocalContext
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

// ── Web target for every escape button ──────────────────────────────────────────────
private const val CS_WEB_PATH = "/agent/creative-studio"

// ── Bengali digits (almaBn twin) ─────────────────────────────────────────────────────
private fun bn(n: Int): String {
    val d = charArrayOf('০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯')
    return n.toString().map { if (it.isDigit()) d[it - '0'] else it }.joinToString("")
}

// ── Palette (unique name — a top-level object is a package JVM class; must not clash) ──
private object CsPalette {
    val coral = AlmaTheme.coral                 // #E07A5F
    val coralLt = Color(0xFFF4A28C)
    val teal = Color(0xFF3FB6A8)
    val gold = Color(0xFFE8B845)
    val ctaA = Color(0xFFF5A15E)
    val ctaB = Color(0xFFD95E87)
    val cta get() = Brush.linearGradient(listOf(ctaA, ctaB))
    fun ink(dark: Boolean) = AlmaTheme.ink(dark)
    fun muted(dark: Boolean) = AlmaTheme.inkSecondary(dark)
}

// ── Wire models (mirror studio-api.ts; every field optional so drift never fails a read) ─

private data class CsGalleryItem(
    val id: String,
    val type: String?,
    val status: String?,
    val summary: String?,
    val createdAt: String?,
    val mode: String?,
    val provider: String?,
    val familyPreset: String?,
    val previewUrl: String?,
    val thumbUrl: String?,
    val brandedUrl: String?,
    val storagePath: String?,
    val modelCreator: String?,
    val coverOptions: List<Pair<String, String?>>,   // path, url
    val error: String?,
) {
    val imageUrl: String? get() = CsData.url(thumbUrl ?: previewUrl ?: brandedUrl)
    val brandedFull: String? get() = CsData.url(brandedUrl)
    val previewFull: String? get() = CsData.url(previewUrl)
    val isVideo: Boolean get() = type == "video_gen" || type == "video_edit" || (storagePath?.endsWith(".mp4") == true)
    val isAudio: Boolean get() = type == "audio_gen"
    val isExecuted: Boolean get() = status == "executed"
    val isPending: Boolean get() = status == "approved" || status == "pending" || status == "processing"
    val isFailed: Boolean get() = status == "failed" || status == "error" || status == "rejected"
    val title: String get() = summary?.takeIf { it.isNotEmpty() } ?: CsData.modeLabel(mode)
    val modeLabel: String get() = CsData.modeLabel(mode)

    companion object {
        fun from(o: JSONObject): CsGalleryItem? {
            val id = o.str("id") ?: return null
            val covers = o.optJSONArray("coverOptions")?.mapObjects { c ->
                c.str("path")?.let { it to c.str("url") }
            } ?: emptyList()
            return CsGalleryItem(
                id = id,
                type = o.str("type"), status = o.str("status"), summary = o.str("summary"),
                createdAt = o.str("createdAt"), mode = o.str("mode"), provider = o.str("provider"),
                familyPreset = o.str("familyPreset"), previewUrl = o.str("previewUrl"),
                thumbUrl = o.str("thumbUrl"), brandedUrl = o.str("brandedUrl"),
                storagePath = o.str("storagePath"), modelCreator = o.str("modelCreator"),
                coverOptions = covers, error = o.str("error"),
            )
        }
    }
}

private data class CsModel(
    val id: String,
    val name: String?,
    val role: String?,
    val isDefault: Boolean?,
    val imageUrl: String?,
) {
    val imageFull: String? get() = CsData.url(imageUrl)

    companion object {
        fun from(o: JSONObject): CsModel? {
            val id = o.str("id") ?: return null
            return CsModel(id, o.str("name"), o.str("role"), o.flexBool("isDefault"), o.str("imageUrl"))
        }
    }
}

// ── Static content (mirror constants.ts) ─────────────────────────────────────────────

private object CsData {
    /** Resolve a possibly-relative asset path against the ERP base URL. */
    fun url(raw: String?): String? {
        if (raw.isNullOrEmpty()) return null
        if (raw.startsWith("http")) return raw
        return AlmaTheme.BASE_URL.trimEnd('/') + "/" + raw.trimStart('/')
    }

    data class Mode(val id: String, val label: String)
    val modes = listOf(
        Mode("product_to_model", "Product→Model"),
        Mode("try_on", "Try-On"),
        Mode("model_swap", "Model Swap"),
        Mode("face_to_model", "Face→Model"),
        Mode("edit", "Edit"),
        Mode("image_to_video", "Image→Video"),
    )
    fun modeLabel(id: String?): String = modes.firstOrNull { it.id == id }?.label ?: (id ?: "ক্রিয়েটিভ")

    // Role labels for saved brand models (mirror modelRoles).
    private val roleBn = mapOf(
        "single" to "একক / নিজে", "father" to "বাবা", "mother" to "মা",
        "son" to "ছেলে (৫–১২)", "daughter" to "মেয়ে (৫–১০)",
    )
    fun roleBn(role: String?): String = roleBn[role] ?: (role ?: "")

    // Brand-model creator roles offered in Library (no real children's photos — fictional models).
    val creatorRoles = listOf(
        "father" to "বাবা", "mother" to "মা", "son" to "ছেলে", "daughter" to "মেয়ে",
    )

    val finishThemes = listOf(
        "default" to "সাধারণ", "eid" to "ঈদ", "puja" to "পূজা", "boishakh" to "বৈশাখ", "winter" to "শীত",
    )
    val finishModes = listOf(
        "lifestyle" to "পূর্ণ ছবি পোস্টার", "model_overlay" to "ছবির উপর (overlay)", "product_card" to "প্রোডাক্ট কার্ড",
    )

    /** Client-safe mirror of reelCostBdt (Veo ≈ $0.15/s × 125 BDT/USD). */
    private fun reelCostBdt(seconds: Int): Int = Math.round(seconds * 0.15 * 125).toInt()
    fun longReelCostBdt(seconds: Int): Int =
        if (seconds >= 16) reelCostBdt(8) * Math.round(seconds / 8.0).toInt() else reelCostBdt(seconds)

    /** Server 4xx bodies carry the owner-facing Bangla reason as {error} or {message}. */
    fun serverMessage(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return try {
            val o = JSONObject(body)
            o.str("error") ?: o.str("message")
        } catch (_: Exception) { null }
    }
}

// ── State holder (CreativeStudioVM twin) ─────────────────────────────────────────────

private class CreativeStudioState {
    var organization by mutableStateOf<String?>(null)
    var fashnConfigured by mutableStateOf(false)
    var gallery by mutableStateOf(listOf<CsGalleryItem>())
    var models by mutableStateOf(listOf<CsModel>())
    var loading by mutableStateOf(false)
    var authExpired by mutableStateOf(false)
    var generating by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var galleryFilter by mutableStateOf("all")   // all | image | video | executed | pending

    val filteredGallery: List<CsGalleryItem>
        get() = when (galleryFilter) {
            "image" -> gallery.filter { !it.isVideo }
            "video" -> gallery.filter { it.isVideo }
            "executed" -> gallery.filter { it.isExecuted }
            "pending" -> gallery.filter { !it.isExecuted }
            else -> gallery
        }

    /** How many renders are still cooking — drives the banner + polling. */
    val pendingCount: Int get() = gallery.count { it.isPending }

    fun flash(msg: String) { toast = msg }

    suspend fun loadAll() {
        loading = true
        try {
            val cfg = runCatching { AlmaApi.getObject("/api/assistant/creative-studio/config") }.getOrNull()
            cfg?.let {
                organization = it.str("organization")
                fashnConfigured = it.flexBool("fashnConfigured") == true
            }
            val gal = runCatching {
                AlmaApi.getObject("/api/assistant/creative-studio/gallery", mapOf("page" to "1", "limit" to "24"))
            }.getOrNull()
            gal?.optJSONArray("items")?.let { arr -> gallery = arr.mapObjects { CsGalleryItem.from(it) } }
            val mods = runCatching { AlmaApi.getObject("/api/assistant/brand-models") }.getOrNull()
            mods?.optJSONArray("models")?.let { arr -> models = arr.mapObjects { CsModel.from(it) } }
            authExpired = cfg == null && gal == null
        } finally {
            loading = false
        }
    }

    suspend fun refreshGallery() {
        val g = runCatching {
            AlmaApi.getObject("/api/assistant/creative-studio/gallery", mapOf("page" to "1", "limit" to "24"))
        }.getOrNull()
        g?.optJSONArray("items")?.let { arr -> gallery = arr.mapObjects { CsGalleryItem.from(it) } }
    }

    /** Native Auto create (web/iOS parity): upload the product photo, then run auto:true
     *  so the server dresses the default saved model in it (+ optional family + reel). */
    var creating by mutableStateOf(false)
    suspend fun createAuto(product: PickedImage, includeFamily: Boolean, includeReel: Boolean): Boolean {
        creating = true
        return try {
            val up = AlmaApi.uploadMultipart("/api/assistant/upload", listOf(product.toFilePart("file")))
            val path = up.str("path") ?: up.optJSONObject("data")?.str("path")
            if (path.isNullOrEmpty()) { toast = "ছবি আপলোড ব্যর্থ"; return false }
            AlmaApi.send(
                "POST", "/api/assistant/creative-studio/run",
                JSONObject().put("auto", true).put("productImagePath", path)
                    .put("includeFamily", includeFamily).put("includeReel", includeReel),
            )
            toast = "তৈরি হচ্ছে — Gallery-তে দেখুন, Boss"
            refreshGallery()
            true
        } catch (e: AlmaApiException.Http) {
            toast = CsData.serverMessage(e.message) ?: "তৈরি করা গেল না"; false
        } catch (_: Exception) {
            toast = "তৈরি করা গেল না"; false
        } finally {
            creating = false
        }
    }

    private suspend fun reloadModels() {
        val m = runCatching { AlmaApi.getObject("/api/assistant/brand-models") }.getOrNull()
        m?.optJSONArray("models")?.let { arr -> models = arr.mapObjects { CsModel.from(it) } }
    }

    /** One-tap reel from any finished studio image (V4; 16/24s = multi-clip chain). */
    suspend fun reelFromImage(item: CsGalleryItem, seconds: Int) {
        val path = item.storagePath ?: return
        try {
            AlmaApi.send(
                "POST", "/api/assistant/creative-studio/run",
                JSONObject().put("mode", "image_to_video").put("sourceImagePath", path).put("durationSec", seconds),
            )
            toast = "${bn(seconds)}s রিল তৈরি হচ্ছে (~৳${bn(CsData.longReelCostBdt(seconds))}) — Gallery-তে আসবে"
            refreshGallery()
        } catch (_: Exception) { toast = "রিল শুরু করা যায়নি" }
    }

    suspend fun retry(item: CsGalleryItem) {
        try {
            AlmaApi.send("POST", "/api/assistant/creative-studio/jobs/${item.id}/retry")
            toast = "আবার চালানো হচ্ছে, Boss"
            refreshGallery()
        } catch (_: Exception) { toast = "আবার চালানো গেল না" }
    }

    /** Scene feedback on an executed creative (CS4 weighting). */
    suspend fun rate(item: CsGalleryItem, verdict: String) {
        try {
            AlmaApi.send(
                "POST", "/api/assistant/creative-studio/feedback",
                JSONObject().put("pendingActionId", item.id).put("verdict", verdict),
            )
            toast = if (verdict == "good") "এই ধরনের সিন বেশি আসবে" else "এই সিন কম আসবে"
        } catch (_: Exception) { toast = "নোট করা গেল না" }
    }

    /** Per-image finishing: server stamps logo + code + hook (web FinishPanel parity). */
    suspend fun finishImage(item: CsGalleryItem, hook: String, code: String, eyebrow: String,
                            offer: String, mode: String, theme: String, footer: Boolean, fitContain: Boolean,
                            layout: JSONObject? = null): Boolean {
        val path = item.storagePath ?: return false
        return try {
            val body = JSONObject()
                .put("storagePath", path).put("hook", hook).put("mode", mode).put("theme", theme)
                .put("footer", footer).put("fit", if (fitContain) "contain" else "cover")
            if (code.isNotEmpty()) body.put("productCode", code)
            if (eyebrow.isNotEmpty()) body.put("eyebrow", eyebrow)
            if (offer.isNotEmpty()) body.put("offer", offer)
            // Lifestyle drag-editor geometry overrides (native CSLifestyleEditor parity).
            if (layout != null && mode == "lifestyle") body.put("layout", layout)
            AlmaApi.send("POST", "/api/assistant/creative-studio/finish", body)
            toast = "ফিনিশিং হয়ে গেছে ✅"
            refreshGallery()
            true
        } catch (e: AlmaApiException.Http) {
            toast = CsData.serverMessage(e.message) ?: "ব্যর্থ হলো"; false
        } catch (_: Exception) { toast = "ফিনিশিং ব্যর্থ"; false }
    }

    /** CS4: save an AI-generated brand model portrait into the model library. */
    suspend fun saveGeneratedModel(item: CsGalleryItem) {
        val role = item.modelCreator ?: return
        val path = item.storagePath ?: return
        try {
            AlmaApi.send(
                "POST", "/api/assistant/brand-models",
                JSONObject().put("action", "add").put("id", "brand-$role")
                    .put("name", "ALMA $role").put("imagePath", path).put("role", role),
            )
            toast = "মডেল লাইব্রেরিতে সেভ হয়েছে, Boss"
            reloadModels()
        } catch (_: Exception) { toast = "সেভ হয়নি" }
    }

    /** CS4: generate the brand's FICTIONAL model for a role. */
    suspend fun generateBrandModel(role: String, label: String) {
        try {
            AlmaApi.send(
                "POST", "/api/assistant/creative-studio/model-creator",
                JSONObject().put("role", role),
            )
            toast = "$label মডেল তৈরি হচ্ছে — Gallery-তে আসবে"
            refreshGallery()
        } catch (e: AlmaApiException.Http) {
            toast = CsData.serverMessage(e.message) ?: "ব্যর্থ হলো"
        } catch (_: Exception) { toast = "হয়নি" }
    }

    suspend fun setDefaultModel(id: String) {
        try {
            AlmaApi.send("POST", "/api/assistant/brand-models", JSONObject().put("action", "set_default").put("id", id))
            reloadModels()
            toast = "ডিফল্ট মডেল সেট হলো"
        } catch (_: Exception) { toast = "সেট করা গেল না" }
    }

    suspend fun removeModel(id: String) {
        try {
            AlmaApi.send("POST", "/api/assistant/brand-models", JSONObject().put("action", "remove").put("id", id))
            models = models.filter { it.id != id }
            toast = "মডেল মুছে ফেলা হলো"
        } catch (_: Exception) { toast = "মুছতে পারলাম না" }
    }
}

private enum class CsTab(val bn: String) {
    HOME("হোম"), CREATE("তৈরি"), GALLERY("গ্যালারি"), VIDEO("ভিডিও"), AUDIO("অডিও"), LIBRARY("লাইব্রেরি")
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreativeStudioScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { CreativeStudioState() }
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(CsTab.HOME) }
    var detail by remember { mutableStateOf<CsGalleryItem?>(null) }

    LaunchedEffect(Unit) { vm.loadAll() }

    // Auto-clear the transient toast after 3.5s (a stuck pill covered the header on iOS).
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) { delay(3500); vm.toast = null }
    }

    // Poll ONLY while something is rendering (web parity: 4s rhythm, stop when idle).
    LaunchedEffect(vm.pendingCount > 0) {
        while (vm.pendingCount > 0) { delay(4000); vm.refreshGallery() }
    }

    Box(Modifier.fillMaxSize()) {
        when (tab) {
            CsTab.HOME -> CsHomeTab(vm, dark, go = { tab = it }, onExit = { ctx.pop() })
            CsTab.GALLERY -> CsGalleryTab(vm, dark, scope, onOpen = { detail = it })
            CsTab.CREATE -> CsCreateTab(vm, dark, scope, onDone = { tab = CsTab.GALLERY })
            CsTab.VIDEO -> CsEscapeTab(
                "ভিডিও স্টুডিও", "রিল ও ভিডিও",
                "ফোনের শুট আপলোড → রেসিপি → রিল + মিউজিক লাইব্রেরি। বড় ভিডিও আপলোড ওয়েবে খুলবে।",
                "🎬 ভিডিও ল্যাব ওয়েবে খুলুন", dark,
            ) { ctx.openWebForced(CS_WEB_PATH, "ভিডিও স্টুডিও") }
            CsTab.AUDIO -> CsEscapeTab(
                "অডিও ল্যাব", "ভয়েসওভার ও মিউজিক",
                "ভয়েস ক্লোন, স্টাইল প্রিসেট আর মিউজিক — অডিও ল্যাব ওয়েবে খুলবে।",
                "🎙 অডিও ল্যাব ওয়েবে খুলুন", dark,
            ) { ctx.openWebForced(CS_WEB_PATH, "অডিও ল্যাব") }
            CsTab.LIBRARY -> CsGalleryTab(vm, dark, scope) { detail = it }
        }

        CsTabBar(tab, dark, Modifier.align(Alignment.BottomCenter)) { tab = it }

        vm.toast?.let { msg ->
            Text(
                msg, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 14.dp, start = 16.dp, end = 16.dp)
                    .fillMaxWidth()
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }

        if (vm.authExpired) {
            Row(
                Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 54.dp, start = 16.dp, end = 16.dp)
                    .fillMaxWidth()
                    .background(CsPalette.gold.copy(alpha = 0.10f), RoundedCornerShape(14.dp))
                    .border(1.dp, CsPalette.gold.copy(alpha = 0.45f), RoundedCornerShape(14.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("সেশন পাওয়া যায়নি", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(
                    "লগইন খুলুন",
                    color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(CsPalette.cta, CircleShape)
                        .plainClick { ctx.openSmart("/login", "Login") }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }
        }
    }

    detail?.let { item ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { detail = null },
            sheetState = sheetState,
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            CsDetailSheet(item, vm, dark, scope, onDismiss = { detail = null }, openWeb = { p, t -> ctx.openWebForced(p, t) })
        }
    }
}

// ── Floating glass tab bar (active = coral pill with label, others icon-only) ─────────

@Composable
private fun CsTabBar(tab: CsTab, dark: Boolean, modifier: Modifier, onSelect: (CsTab) -> Unit) {
    Row(
        modifier
            .padding(horizontal = 14.dp, vertical = 8.dp)
            .fillMaxWidth()
            .almaGlass(dark, 999)
            .padding(6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CsTab.entries.forEach { t ->
            val active = t == tab
            Text(
                if (active) "${icon(t)} ${t.bn}" else icon(t),
                color = if (active) Color.White else CsPalette.muted(dark),
                fontSize = if (active) 13.sp else 17.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .then(if (active) Modifier.background(CsPalette.cta, CircleShape) else Modifier)
                    .plainClick { onSelect(t) }
                    .padding(horizontal = if (active) 14.dp else 9.dp, vertical = 9.dp),
            )
        }
    }
}

private fun icon(t: CsTab): String = when (t) {
    CsTab.HOME -> "🏠"; CsTab.CREATE -> "✨"; CsTab.GALLERY -> "🖼"
    CsTab.VIDEO -> "🎬"; CsTab.AUDIO -> "🎵"; CsTab.LIBRARY -> "👤"
}

// ── Shared photo (Coil AsyncImage over a dark placeholder) ────────────────────────────

@Composable
private fun CsPhoto(url: String?, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    Box(
        modifier.background(
            Brush.linearGradient(listOf(Color(0xFF29262E), Color(0xFF3D2A3D))),
        ),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(ctx).data(url).crossfade(true).build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text("🖼", fontSize = 26.sp, color = Color.White.copy(alpha = 0.28f))
        }
    }
}

@Composable
private fun CsHeader(dark: Boolean, eyebrow: String, title: String, onBack: (() -> Unit)?, trailing: @Composable (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        onBack?.let {
            Box(
                Modifier.size(38.dp).almaGlass(dark, 999).plainClick(it),
                contentAlignment = Alignment.Center,
            ) { Text("‹", color = AlmaTheme.ink(dark), fontSize = 22.sp, fontWeight = FontWeight.Bold) }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(eyebrow.uppercase(), color = CsPalette.coralLt, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Text(title, color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Black)
        }
        trailing?.invoke()
    }
}

// ── HOME ──────────────────────────────────────────────────────────────────────────────

@Composable
private fun CsHomeTab(vm: CreativeStudioState, dark: Boolean, go: (CsTab) -> Unit, onExit: () -> Unit) {
    val hero = vm.gallery.firstOrNull { !it.isVideo } ?: vm.gallery.firstOrNull()
    val recents = vm.gallery.take(8)

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            CsHeader(dark, vm.organization ?: "ALMA Lifestyle", "ক্রিয়েটিভ স্টুডিও", onBack = onExit) {
                Row(
                    Modifier.almaGlass(dark, 999).padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text("✨", fontSize = 12.sp)
                    Text("${bn(vm.gallery.size)}টি", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Hero card — the featured creative with a bottom gradient + CTA.
        item {
            Box(
                Modifier.fillMaxWidth().aspectRatio(0.86f)
                    .clip(RoundedCornerShape(28.dp))
                    .plainClick { go(CsTab.CREATE) },
            ) {
                CsPhoto(hero?.imageUrl, Modifier.fillMaxSize())
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.1f), Color.Black.copy(alpha = 0.86f))),
                    ),
                )
                Column(
                    Modifier.align(Alignment.BottomStart).padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text("ঈদ ২০২৬ · সিগনেচার", color = CsPalette.coralLt, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    Text("প্রিমিয়াম ফ্যামিলি সিন", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Black)
                    Text(
                        "এক প্রোডাক্ট ছবি থেকে ঈদের পুরো ফ্যামিলি ক্যাম্পেইন — এক ট্যাপে।",
                        color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp,
                    )
                    Text(
                        "🪄 এখনই বানাও",
                        color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                            .background(CsPalette.cta, RoundedCornerShape(16.dp))
                            .plainClick { go(CsTab.CREATE) }
                            .padding(vertical = 13.dp),
                    )
                }
            }
        }

        item { CsSectionHeader("শুরু করুন", "সব মোড", dark) { go(CsTab.CREATE) } }
        item {
            CsFeatureRow(vm.gallery.getOrNull(0)?.imageUrl, "Product→Model", "নতুন",
                "প্রোডাক্ট ছবি → রিয়েল মডেল শট", "FASHN / Gemini", dark) { go(CsTab.CREATE) }
        }
        item {
            CsFeatureRow(vm.gallery.getOrNull(1)?.imageUrl, "ফ্যামিলি সেট", "প্রিমিয়াম",
                "বাবা+ছেলে / মা+মেয়ে — লাইব্রেরির মডেল দিয়ে", "Gemini মাল্টি-পারসন", dark) { go(CsTab.CREATE) }
        }
        item {
            CsFeatureRow(vm.gallery.getOrNull(2)?.imageUrl, "Try-On", null,
                "মডেলের গায়ে আপনার পোশাক", "FASHN tryon-max", dark) { go(CsTab.CREATE) }
        }

        item { CsSectionHeader("সাম্প্রতিক তৈরি", "গ্যালারি", dark) { go(CsTab.GALLERY) } }
        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(11.dp),
            ) {
                Column(
                    Modifier.width(116.dp).height(150.dp).almaGlass(dark, 18).plainClick { go(CsTab.CREATE) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Box(Modifier.size(40.dp).background(CsPalette.cta, RoundedCornerShape(AlmaTheme.R_CONTROL.dp)), Alignment.Center) {
                        Text("+", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("নতুন", color = CsPalette.muted(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
                recents.forEach { item ->
                    Box(Modifier.width(116.dp).height(150.dp).clip(RoundedCornerShape(18.dp))) {
                        CsPhoto(item.imageUrl, Modifier.fillMaxSize())
                        Text(
                            item.title, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth()
                                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.72f))))
                                .padding(8.dp),
                        )
                    }
                }
            }
        }

        item { CsSectionHeader("ট্রেন্ডিং সিন", null, dark, null) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                vm.gallery.take(6).chunked(2).forEach { pair ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEach { it ->
                            Box(Modifier.weight(1f)) { CsGalleryTile(it, dark, null, onTap = {}) }
                        }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

// ── GALLERY ───────────────────────────────────────────────────────────────────────────

@Composable
private fun CsGalleryTab(vm: CreativeStudioState, dark: Boolean, scope: CoroutineScope, onOpen: (CsGalleryItem) -> Unit) {
    val filters = listOf("সব" to "all", "ছবি" to "image", "ভিডিও" to "video", "পোস্ট হয়েছে" to "executed", "পেন্ডিং" to "pending")

    // Manual 2-col grid inside a LazyColumn (avoids a second same-named `items` import).
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(Modifier.padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${bn(vm.gallery.size)}টি ক্রিয়েটিভ", color = CsPalette.coralLt, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text("গ্যালারি", color = AlmaTheme.ink(dark), fontSize = 30.sp, fontWeight = FontWeight.Black)
            }
        }
        item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                filters.forEach { (label, key) ->
                    CsChip(label, vm.galleryFilter == key, dark) { vm.galleryFilter = key }
                }
            }
        }
        if (vm.pendingCount > 0) {
            item {
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, 14).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(Modifier.size(16.dp), color = CsPalette.coral, strokeWidth = 2.dp)
                    Text(
                        "${bn(vm.pendingCount)}টি ছবি/ভিডিও তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে, Boss",
                        color = CsPalette.coral, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        if (vm.gallery.isEmpty()) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 40.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (vm.loading) CircularProgressIndicator(Modifier.size(22.dp), color = CsPalette.coral, strokeWidth = 2.dp)
                    else Text("🎨", fontSize = 34.sp)
                    Text(
                        if (vm.loading) "লোড হচ্ছে…" else "এখনো কিছু তৈরি হয়নি",
                        color = CsPalette.muted(dark), fontSize = 14.sp,
                    )
                }
            }
        }
        items(vm.filteredGallery.chunked(2), key = { it.first().id }) { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { item ->
                    Box(Modifier.weight(1f)) {
                        CsGalleryTile(item, dark, onRetry = { scope.launch { vm.retry(item) } }) {
                            if (item.previewUrl != null) onOpen(item)
                        }
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun CsGalleryTile(item: CsGalleryItem, dark: Boolean, onRetry: (() -> Unit)?, onTap: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().aspectRatio(0.78f)
            .clip(RoundedCornerShape(20.dp))
            .border(1.dp, Color.White.copy(alpha = 0.08f), RoundedCornerShape(20.dp))
            .plainClick(onTap),
    ) {
        when {
            item.previewUrl == null && item.isPending -> CsGeneratingTile(if (item.isVideo) "ভিডিও হচ্ছে…" else "তৈরি হচ্ছে…")
            item.previewUrl == null && item.isFailed -> Column(
                Modifier.fillMaxSize().background(Color.White.copy(alpha = if (dark) 0.04f else 0.3f)),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    "ব্যর্থ" + (item.error?.let { " · ${it.take(36)}" } ?: ""),
                    color = Color(0xFFFF7373), fontSize = 10.5.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
                onRetry?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "🔁 আবার চালাও", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(CsPalette.coral, CircleShape).plainClick(it).padding(horizontal = 13.dp, vertical = 7.dp),
                    )
                }
            }
            else -> {
                CsPhoto(item.imageUrl, Modifier.fillMaxSize())
                Row(Modifier.align(Alignment.TopStart).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    val (label, tint) = when {
                        item.isExecuted -> "পোস্ট" to CsPalette.teal
                        item.isFailed -> "ব্যর্থ" to Color(0xFFEF4444)
                        else -> "পেন্ডিং" to CsPalette.gold
                    }
                    Text(
                        label, color = if (item.isExecuted) Color(0xFF08130D) else Color(0xFF2C1F00),
                        fontSize = 9.5.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(tint, CircleShape).padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                    if (item.brandedUrl != null) {
                        Text(
                            "Branded", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.background(CsPalette.coral.copy(alpha = 0.9f), CircleShape).padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
                if (item.isVideo || item.isAudio) {
                    Box(
                        Modifier.align(Alignment.Center).size(40.dp).background(Color.Black.copy(alpha = 0.5f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Text(if (item.isVideo) "▶" else "🎵", color = Color.White, fontSize = 16.sp) }
                }
                Column(
                    Modifier.align(Alignment.BottomStart).fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.82f))))
                        .padding(11.dp),
                ) {
                    Text(item.title, color = Color.White, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(item.modeLabel, color = Color.White.copy(alpha = 0.62f), fontSize = 10.sp)
                }
            }
        }
    }
}

/** Rising fill + Bangla percent that climbs toward 95% (web GeneratingTile twin). */
@Composable
private fun CsGeneratingTile(label: String) {
    var pct by remember { mutableStateOf(3.0) }
    LaunchedEffect(Unit) {
        val start = System.currentTimeMillis()
        while (true) {
            val elapsed = (System.currentTimeMillis() - start) / 1000.0
            val target = 95 * (1 - Math.exp(-elapsed / 38.0))
            if (target > pct) pct += (target - pct) * 0.25
            delay(150)
        }
    }
    Box(
        Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF29262E), Color(0xFF3D2A3D)))),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeightFraction(pct.toFloat() / 100f)
                .background(Brush.verticalGradient(listOf(CsPalette.coral.copy(alpha = 0.06f), CsPalette.coral.copy(alpha = 0.45f)))),
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("${bn(pct.toInt())}%", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black)
            Text(label, color = Color.White.copy(alpha = 0.7f), fontSize = 10.5.sp)
        }
    }
}

private fun Modifier.fillMaxHeightFraction(f: Float): Modifier =
    this.fillMaxHeight(f.coerceIn(0.02f, 1f))

// ── Small shared building blocks ──────────────────────────────────────────────────────

@Composable
private fun CsSectionHeader(title: String, trailing: String?, dark: Boolean, action: (() -> Unit)? = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        trailing?.let {
            Text(
                it, color = if (action != null) CsPalette.coralLt else CsPalette.muted(dark),
                fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold,
                modifier = if (action != null) Modifier.plainClick(action) else Modifier,
            )
        }
    }
}

@Composable
private fun CsChip(text: String, on: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        text,
        color = if (on) Color.White else CsPalette.muted(dark),
        fontSize = 12.5.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
        modifier = Modifier
            .then(if (on) Modifier.background(CsPalette.cta, CircleShape) else Modifier.almaGlass(dark, 999))
            .plainClick(onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
    )
}

@Composable
private fun CsFeatureRow(image: String?, name: String, badge: String?, desc: String, credits: String, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onClick).padding(11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        CsPhoto(image, Modifier.size(76.dp).clip(RoundedCornerShape(16.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(name, color = AlmaTheme.ink(dark), fontSize = 15.5.sp, fontWeight = FontWeight.Bold)
                badge?.let {
                    val tint = if (it == "নতুন") CsPalette.teal else CsPalette.gold
                    Text(
                        it, color = tint, fontSize = 9.5.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(tint.copy(alpha = 0.16f), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
            Text(desc, color = CsPalette.muted(dark), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("✨ $credits", color = CsPalette.muted(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
        Text("›", color = CsPalette.muted(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Native CREATE tab (product photo → Auto generate; web parity, no escape) ──────────

@Composable
private fun CsCreateTab(vm: CreativeStudioState, dark: Boolean, scope: CoroutineScope, onDone: () -> Unit) {
    var picked by remember { mutableStateOf<PickedImage?>(null) }
    var includeFamily by remember { mutableStateOf(false) }
    var includeReel by remember { mutableStateOf(false) }
    val pickGallery = rememberGalleryPick { it?.let { p -> picked = p } }
    val pickCamera = rememberCameraPick { it?.let { p -> picked = p } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        CsHeader(dark, "নতুন জেনারেশন", "ক্রিয়েটিভ বানাও", onBack = null)
        Spacer(Modifier.height(16.dp))
        // Product photo picker / preview.
        Box(
            Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(20.dp))
                .almaGlass(dark, 20).plainClick { pickGallery() },
            contentAlignment = Alignment.Center,
        ) {
            val p = picked
            if (p != null) {
                AsyncImage(
                    model = ImageRequest.Builder(LocalContext.current).data(p.bytes).build(),
                    contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("📷", fontSize = 40.sp)
                    Text("প্রোডাক্ট ছবি বাছুন", color = CsPalette.muted(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("ট্যাপ করে গ্যালারি — নিচে ক্যামেরাও আছে", color = CsPalette.muted(dark), fontSize = 11.sp)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CsPickChip("🖼 গ্যালারি", dark, Modifier.weight(1f)) { pickGallery() }
            CsPickChip("📸 ক্যামেরা", dark, Modifier.weight(1f)) { pickCamera() }
        }
        Spacer(Modifier.height(16.dp))
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            CsSwitchRow("পরিবার সহ (মা + সন্তান)", includeFamily, dark) { includeFamily = it }
            CsSwitchRow("সাথে রিল ভিডিও", includeReel, dark) { includeReel = it }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "ডিফল্ট সেভ করা মডেলকে এই প্রোডাক্টে সাজিয়ে ছবি বানাবে। মডেল না থাকলে Library ট্যাবে একটি সেভ করুন।",
            color = CsPalette.muted(dark), fontSize = 11.sp, modifier = Modifier.padding(horizontal = 4.dp),
        )
        Spacer(Modifier.height(16.dp))
        val ready = picked != null && !vm.creating
        Box(
            Modifier.fillMaxWidth().background(CsPalette.cta, RoundedCornerShape(16.dp))
                .alpha(if (ready) 1f else 0.5f)
                .plainClick {
                    val p = picked
                    if (p != null && !vm.creating) scope.launch { if (vm.createAuto(p, includeFamily, includeReel)) onDone() }
                }
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (vm.creating) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
            else Text("🪄 তৈরি করুন", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(120.dp))
    }
}

@Composable
private fun CsPickChip(label: String, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier.almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onClick).padding(vertical = 11.dp),
    )
}

@Composable
private fun CsSwitchRow(label: String, checked: Boolean, dark: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 13.sp, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun CsEscapeTab(title: String, eyebrow: String, note: String, cta: String, dark: Boolean, onOpen: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        CsHeader(dark, eyebrow, title, onBack = null)
        Spacer(Modifier.height(40.dp))
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(note, color = CsPalette.muted(dark), fontSize = 13.sp, textAlign = TextAlign.Center)
            Text(
                cta, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().background(CsPalette.cta, RoundedCornerShape(16.dp)).plainClick(onOpen).padding(vertical = 13.dp),
            )
        }
    }
}

// ── Detail sheet (asset actions — web GeneratingTile/DetailSheet parity) ──────────────

@Composable
private fun CsDetailSheet(
    item: CsGalleryItem,
    vm: CreativeStudioState,
    dark: Boolean,
    scope: CoroutineScope,
    onDismiss: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var showBranded by remember { mutableStateOf(true) }
    var rating by remember { mutableStateOf<String?>(null) }
    var showFinish by remember { mutableStateOf(false) }
    var showPlayer by remember { mutableStateOf(false) }
    var mediaMsg by remember { mutableStateOf<String?>(null) }
    val displayUrl = if (showBranded) (item.brandedFull ?: item.previewFull) else item.previewFull ?: item.imageUrl

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp).padding(bottom = 40.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        // Media — image via Coil; video/audio play on web (native player deferred).
        Box(
            Modifier.fillMaxWidth().aspectRatio(if (item.isVideo) 9f / 13f else 0.82f).padding(top = 16.dp)
                .clip(RoundedCornerShape(22.dp))
                .border(1.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(22.dp)),
        ) {
            CsPhoto(displayUrl, Modifier.fillMaxSize())
            if (item.isVideo || item.isAudio) {
                Box(
                    Modifier.align(Alignment.Center).size(56.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape)
                        .plainClick { if (!displayUrl.isNullOrEmpty()) showPlayer = true },
                    contentAlignment = Alignment.Center,
                ) { Text(if (item.isVideo) "▶" else "🎵", color = Color.White, fontSize = 22.sp) }
            }
        }

        // Original ↔ Branded toggle (only when a branded variant exists)
        if (item.brandedUrl != null) {
            Row(
                Modifier.fillMaxWidth().padding(top = 12.dp).background(Color.Black.copy(alpha = 0.28f), CircleShape).padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                CsBrandedBtn(if (item.isVideo) "টেমপ্লেট সহ" else "Logo সহ", showBranded, dark, Modifier.weight(1f)) { showBranded = true }
                CsBrandedBtn("আসল", !showBranded, dark, Modifier.weight(1f)) { showBranded = false }
            }
        }

        Text(item.title, color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Black, modifier = Modifier.padding(top = 16.dp))
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            CsMetaTag(item.modeLabel, dark)
            CsMetaTag(item.provider ?: "—", dark)
            CsMetaTag(if (item.isExecuted) "পোস্ট হয়েছে" else if (item.isFailed) "ব্যর্থ" else "পেন্ডিং", dark)
        }

        // Actions — download & share are NATIVE now (fetch → native share sheet).
        // The finishing editor (drag/resize overlay) stays web for now.
        Row(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val mime = if (item.isVideo) "video/mp4" else if (item.isAudio) "audio/mp4" else "image/jpeg"
            val ext = if (item.isVideo) "mp4" else if (item.isAudio) "m4a" else "jpg"
            CsActionBtn("⬇ ডাউনলোড", primary = true, dark, Modifier.weight(1f)) {
                displayUrl?.let { u -> mediaMsg = "…"; downloadAndShareMedia(context, u, mime, "alma-${item.id}.$ext") { mediaMsg = it } }
            }
            CsActionBtn("↗ শেয়ার", primary = false, dark, Modifier.weight(1f)) {
                displayUrl?.let { u -> mediaMsg = "…"; downloadAndShareMedia(context, u, mime, "alma-${item.id}.$ext") { mediaMsg = it } }
            }
            CsActionBtn("⚙ এডিটর", primary = false, dark, Modifier.weight(1f)) { openWeb(CS_WEB_PATH, "ফিনিশিং এডিটর") }
        }
        mediaMsg?.takeIf { it.isNotEmpty() && it != "…" }?.let {
            Text(it, color = AlmaTheme.coral, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
        }

        // Retry (failed renders)
        if (item.isFailed) {
            CsWideBtn("🔁 আবার চালাও", CsPalette.coral, Modifier.padding(top = 14.dp)) {
                scope.launch { vm.retry(item) }; onDismiss()
            }
        }

        // CS4: AI brand model → save into the Models library
        if (item.modelCreator != null && item.isExecuted && item.storagePath != null) {
            CsWideBtn("✅ মডেল হিসেবে সেভ (${CsData.roleBn(item.modelCreator)})", CsPalette.teal, Modifier.padding(top = 14.dp)) {
                scope.launch { vm.saveGeneratedModel(item) }
            }
        }

        // V4: one-tap reel from any finished studio image (multi-clip for 16/24s)
        if (item.isExecuted && item.storagePath != null && !item.isVideo && !item.isAudio) {
            Text("এই ছবি থেকে রিল", color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 14.dp))
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(6, 16, 24).forEach { d ->
                    Text(
                        "${bn(d)}s ~৳${bn(CsData.longReelCostBdt(d))}",
                        color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(CsPalette.coral, CircleShape).plainClick { scope.launch { vm.reelFromImage(item, d) } }.padding(horizontal = 13.dp, vertical = 9.dp),
                    )
                }
            }
        }

        // Feedback → deterministic scene weighting (CS4)
        if (item.isExecuted) {
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CsRateBtn("👍 এমন সিন বেশি চাই", rating == "good", dark, Modifier.weight(1f)) {
                    rating = "good"; scope.launch { vm.rate(item, "good") }
                }
                CsRateBtn("👎 বাদ দাও", rating == "bad", dark, Modifier.weight(1f)) {
                    rating = "bad"; scope.launch { vm.rate(item, "bad") }
                }
            }
        }

        // Native finishing (image brand frame; video templates → web)
        if (item.storagePath != null && !item.isAudio && (item.isExecuted || !item.isVideo)) {
            CsWideBtnGradient(
                if (showFinish) "ফিনিশিং বন্ধ করুন" else if (item.isVideo) "টেমপ্লেট ফিনিশিং" else "ফিনিশিং (logo + code + hook)",
                Modifier.padding(top = 14.dp),
            ) {
                if (item.isVideo) openWeb(CS_WEB_PATH, "টেমপ্লেট ফিনিশিং") else showFinish = !showFinish
            }
            if (showFinish && !item.isVideo) {
                CsFinishPanel(item, vm, dark, scope, Modifier.padding(top = 12.dp)) { showFinish = false; showBranded = true }
            }
        }
    }

    if (showPlayer && !displayUrl.isNullOrEmpty()) {
        AlmaMediaPlayerSheet(
            url = displayUrl,
            isVideo = item.isVideo,
            title = item.title,
            dark = dark,
            onDismiss = { showPlayer = false },
        )
    }
}

@Composable
private fun CsBrandedBtn(label: String, active: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = if (active) Color.White else CsPalette.muted(dark), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier.then(if (active) Modifier.background(CsPalette.coral, CircleShape) else Modifier).plainClick(onClick).padding(vertical = 8.dp),
    )
}

@Composable
private fun CsMetaTag(t: String, dark: Boolean) {
    Text(t, color = CsPalette.muted(dark), fontSize = 11.sp, modifier = Modifier.almaGlass(dark, 999).padding(horizontal = 10.dp, vertical = 4.dp))
}

@Composable
private fun CsActionBtn(label: String, primary: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = if (primary) Color.White else AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .then(if (primary) Modifier.background(CsPalette.cta, RoundedCornerShape(16.dp)) else Modifier.almaGlass(dark, 16))
            .plainClick(onClick).padding(vertical = 14.dp),
    )
}

@Composable
private fun CsWideBtn(label: String, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().background(tint, RoundedCornerShape(16.dp)).plainClick(onClick).padding(14.dp),
    )
}

@Composable
private fun CsWideBtnGradient(label: String, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().background(CsPalette.cta, RoundedCornerShape(16.dp)).plainClick(onClick).padding(14.dp),
    )
}

@Composable
private fun CsRateBtn(label: String, active: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label, color = if (active) Color.White else AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(if (active) CsPalette.teal.copy(alpha = 0.9f) else Color.White.copy(alpha = if (dark) 0.05f else 0.4f), RoundedCornerShape(14.dp))
            .plainClick(onClick).padding(13.dp),
    )
}

// ── Finishing form (web FinishPanel twin: the owner types THIS image's code + hook) ───

@Composable
private fun CsFinishPanel(item: CsGalleryItem, vm: CreativeStudioState, dark: Boolean, scope: CoroutineScope, modifier: Modifier, onDone: () -> Unit) {
    var hook by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var eyebrow by remember { mutableStateOf("") }
    var offer by remember { mutableStateOf("") }
    var modeIdx by remember { mutableStateOf(0) }
    var themeIdx by remember { mutableStateOf(0) }
    var footer by remember { mutableStateOf(false) }
    var fitContain by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var showDragEditor by remember { mutableStateOf(false) }
    val isLifestyle = CsData.finishModes[modeIdx].first == "lifestyle"

    if (showDragEditor) {
        ModalBottomSheet(onDismissRequest = { showDragEditor = false }, containerColor = AlmaTheme.rootBg(dark)) {
            CSLifestyleEditorSheet(
                item = CsGalleryItemRef(item.previewFull ?: item.imageUrl),
                dark = dark, scope = scope,
                seedHook = hook, seedEyebrow = eyebrow, seedOffer = offer, seedCode = code, seedThemeIdx = themeIdx,
                onApply = { h, ey, of, cd, th, layout ->
                    val ok = vm.finishImage(item, h, cd, ey, of, "lifestyle", th, footer, fitContain, layout)
                    if (ok) onDone()
                    ok
                },
                onClose = { showDragEditor = false },
            )
        }
    }

    Column(modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (isLifestyle) CsField("ছোট লাইন (খালি রাখলে: নতুন এসেছে)", eyebrow) { eyebrow = it }
        CsField(if (isLifestyle) "মূল লেখা (যেমন: পার্পেল কালার ফ্যামিলি কম্বো সেট)" else "Hook (যেমন: ঈদ স্পেশাল অফার)", hook) { hook = it }
        if (isLifestyle) CsField("অফার লাইন (খালি রাখলে: অফার প্রাইস জানতে ইনবক্স করুন)", offer) { offer = it }
        CsField("Product code (যেমন: ALM-315) — ঐচ্ছিক", code) { code = it }

        Text("লেআউট", color = CsPalette.muted(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CsData.finishModes.forEachIndexed { i, (_, label) -> CsChip(label, modeIdx == i, dark) { modeIdx = i } }
        }
        Text("থিম", color = CsPalette.muted(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CsData.finishThemes.forEachIndexed { i, (_, label) -> CsChip(label, themeIdx == i, dark) { themeIdx = i } }
        }
        if (CsData.finishModes[modeIdx].first == "model_overlay") CsToggle("নিচে ফুটার (পেজ নাম + অর্ডার লাইন)", footer, dark) { footer = it }
        if (isLifestyle) CsToggle("পুরো ছবি রাখুন (ক্রপ ছাড়া)", fitContain, dark) { fitContain = it }

        // Native drag/resize finishing editor (iOS CSLifestyleEditor parity) — lifestyle only.
        if (isLifestyle) {
            Text(
                "🎨 ব্লক নিজে সাজান (ড্র্যাগ এডিটর)",
                color = AlmaTheme.violet, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().background(AlmaTheme.violet.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, AlmaTheme.violet.copy(alpha = 0.4f), CircleShape).plainClick { showDragEditor = true }.padding(vertical = 10.dp),
            )
        }

        if (busy) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = CsPalette.coral, strokeWidth = 2.dp)
            }
        } else {
            CsWideBtnGradient("✨ ফিনিশিং বসাও", Modifier) {
                if (hook.trim().isEmpty()) {
                    vm.flash(if (isLifestyle) "মূল লেখাটা (headline) দিন" else "একটা hook লেখা লাগবে")
                } else {
                    busy = true
                    scope.launch {
                        val ok = vm.finishImage(
                            item, hook.trim(), code.trim(), eyebrow.trim(), offer.trim(),
                            CsData.finishModes[modeIdx].first, CsData.finishThemes[themeIdx].first, footer, fitContain,
                        )
                        busy = false
                        if (ok) onDone()
                    }
                }
            }
        }
    }
}

@Composable
private fun CsField(placeholder: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange,
        placeholder = { Text(placeholder, fontSize = 12.sp) },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun CsToggle(label: String, on: Boolean, dark: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = onChange)
    }
}

// ── LIBRARY (models list + role-based creator + native set-default/remove) ────────────

@Composable
private fun CsLibraryTab(vm: CreativeStudioState, dark: Boolean, scope: CoroutineScope, openWeb: (String, String) -> Unit) {
    var logoUploading by remember { mutableStateOf(false) }
    var logoMsg by remember { mutableStateOf<String?>(null) }
    val pickLogo = rememberGalleryPick(maxSide = 600, quality = 90) { p ->
        if (p == null) return@rememberGalleryPick
        scope.launch {
            logoUploading = true; logoMsg = null
            logoMsg = try {
                AlmaApi.uploadMultipart(
                    "/api/assistant/creative-studio/branding",
                    listOf(p.toFilePart("logo")),
                )
                "✓ লোগো আপলোড হয়েছে"
            } catch (_: Exception) {
                "আপলোড হয়নি — আবার চেষ্টা করুন"
            } finally { logoUploading = false }
        }
    }
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { CsHeader(dark, "মডেল লাইব্রেরি", "লাইব্রেরি", onBack = null) }

        item { Text("সেভ করা মডেল", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold) }
        if (vm.models.isEmpty()) {
            item {
                Text(
                    "এখনো কোনো মডেল সেভ নেই। নিচে থেকে ব্র্যান্ড মডেল তৈরি করুন বা ওয়েবে ছবি আপলোড করুন।",
                    color = CsPalette.muted(dark), fontSize = 12.5.sp,
                    modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(16.dp),
                )
            }
        } else {
            items(vm.models.chunked(2), key = { it.first().id }) { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    pair.forEach { m -> Box(Modifier.weight(1f)) { CsModelCard(m, dark, scope, vm) } }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }

        // CS4: generate the brand's FICTIONAL model per role (role-based, text/tap flow).
        item { Text("ব্র্যান্ড মডেল তৈরি", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold) }
        item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CsData.creatorRoles.forEach { (role, label) ->
                    Text(
                        "✨ $label", color = Color.White, fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(CsPalette.cta, CircleShape)
                            .plainClick { scope.launch { vm.generateBrandModel(role, label) } }
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                    )
                }
            }
        }

        item {
            Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(4.dp)) {
                // Logo upload is NATIVE now (gallery → multipart). Model-add + studio
                // settings forms remain web for now (separate batch).
                CsToolRow(
                    "🏷 লোগো আপলোড",
                    logoMsg ?: if (logoUploading) "আপলোড হচ্ছে…" else "ব্র্যান্ড লোগো আপলোড (গ্যালারি)",
                    dark,
                ) { if (!logoUploading) pickLogo() }
                CsToolRow("📷 ছবি থেকে মডেল যোগ", "নতুন মডেলের ছবি আপলোড করুন", dark) { openWeb(CS_WEB_PATH, "মডেল যোগ") }
                CsToolRow("⚙ স্টুডিও সেটিংস", "QC লেভেল, নোটিফিকেশন, চাইল্ড গার্মেন্ট", dark) { openWeb(CS_WEB_PATH, "স্টুডিও সেটিংস") }
            }
        }
    }
}

@Composable
private fun CsModelCard(m: CsModel, dark: Boolean, scope: CoroutineScope, vm: CreativeStudioState) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(0.86f).clip(RoundedCornerShape(14.dp))) {
            CsPhoto(m.imageFull, Modifier.fillMaxSize())
            if (m.isDefault == true) {
                Text(
                    "ডিফল্ট", color = Color(0xFF08130D), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.TopStart).padding(6.dp)
                        .background(CsPalette.teal, CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
        }
        Text(m.name ?: "মডেল", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        m.role?.let { Text(it, color = CsPalette.muted(dark), fontSize = 10.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (m.isDefault != true) {
                Text(
                    "ডিফল্ট", color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).almaGlass(dark, 999).plainClick { scope.launch { vm.setDefaultModel(m.id) } }.padding(vertical = 6.dp),
                )
            }
            Text(
                "মুছুন", color = Color(0xFFEF4444), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).background(Color(0xFFEF4444).copy(alpha = 0.12f), CircleShape).plainClick { scope.launch { vm.removeModel(m.id) } }.padding(vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun CsToolRow(title: String, sub: String, dark: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().plainClick(onClick).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text(sub, color = CsPalette.muted(dark), fontSize = 11.5.sp)
        }
        Text("›", color = CsPalette.muted(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}
