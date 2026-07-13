//
//  SettingsBrandingScreen.kt
//  ALMA ERP — Settings · Branding, ported 1:1 from SettingsBrandingSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET  /api/branding?all=1 → { ok, fallback?, branding_by_business: { <businessId>: {…} } }
//    POST /api/branding { action:'upload', asset_type, data(base64), mime_type,
//                         filename, business_id }   (native logo/favicon upload — iOS parity)
//  One call returns all three businesses (Lifestyle / CDIT / Trading), each a
//  per-business card: logo + favicon (through the authenticated image proxy
//  /api/branding/image-proxy?raw=1&url=… — Coil request carries the WebView session
//  cookie), brand colour swatches, company details, invoice branding. Colour and
//  name EDITS stay on the web escape hatch.
//

package com.almatraders.erp.pages

import android.util.Base64
import android.webkit.CookieManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SettingsBrandingPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val emerald600 = Color(0xFF059669)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Model (same snake_case field names /api/branding returns) ──────────────────────

private data class SettingsBrandingInfo(
    val businessId: String,
    val companyName: String?,
    val tagline: String?,
    val phone: String?,
    val email: String?,
    val website: String?,
    val address: String?,
    val facebook: String?,
    val logoUrl: String?,
    val faviconUrl: String?,
    val colorPrimary: String?,
    val colorSecondary: String?,
    val colorAccent: String?,
    val invoiceFooterThanks: String?,
    val invoiceFooterPolicy: String?,
    val invoiceFooterNote: String?,
    val invoicePrefix: String?,
    val invoiceWatermarkEnabled: Boolean?,
    /** Server stores this as a string ("0.08") but be lenient about numbers too. */
    val invoiceWatermarkOpacity: Double?,
    val updatedAt: String?,
) {
    val displayName: String
        get() = companyName?.takeIf { it.isNotEmpty() } ?: when (businessId) {
            "ALMA_LIFESTYLE" -> "Alma Lifestyle"
            "CREATIVE_DIGITAL_IT" -> "Creative Digital IT"
            "ALMA_TRADING" -> "Alma Trading"
            else -> businessId.replace("_", " ")
        }

    companion object {
        fun from(businessId: String, o: JSONObject) = SettingsBrandingInfo(
            businessId = o.str("business_id") ?: businessId,
            companyName = o.str("company_name"),
            tagline = o.str("tagline"),
            phone = o.str("phone"),
            email = o.str("email"),
            website = o.str("website"),
            address = o.str("address"),
            facebook = o.str("facebook"),
            logoUrl = o.str("logo_url"),
            faviconUrl = o.str("favicon_url"),
            colorPrimary = o.str("color_primary"),
            colorSecondary = o.str("color_secondary"),
            colorAccent = o.str("color_accent"),
            invoiceFooterThanks = o.str("invoice_footer_thanks"),
            invoiceFooterPolicy = o.str("invoice_footer_policy"),
            invoiceFooterNote = o.str("invoice_footer_note"),
            invoicePrefix = o.str("invoice_prefix"),
            invoiceWatermarkEnabled = o.flexBool("invoice_watermark_enabled"),
            invoiceWatermarkOpacity = o.flexDouble("invoice_watermark_opacity"),
            updatedAt = o.str("updated_at"),
        )
    }
}

// ── State holder (iOS SettingsBrandingVM twin) ─────────────────────────────────────

private class SettingsBrandingState {
    var brandings by mutableStateOf(listOf<SettingsBrandingInfo>())
    var fallback by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var uploading by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/branding", mapOf("all" to "1")))
            fallback = c.flexBool("fallback") == true
            val map = c.optJSONObject("branding_by_business") ?: JSONObject()
            // Stable web order: Lifestyle → CDIT → Trading, unknown tenants appended.
            val order = listOf("ALMA_LIFESTYLE", "CREATIVE_DIGITAL_IT", "ALMA_TRADING")
            val out = ArrayList<SettingsBrandingInfo>()
            order.forEach { id ->
                map.optJSONObject(id)?.let { out.add(SettingsBrandingInfo.from(id, it)) }
            }
            val extras = ArrayList<SettingsBrandingInfo>()
            map.keys().forEach { key ->
                if (key !in order) map.optJSONObject(key)?.let { extras.add(SettingsBrandingInfo.from(key, it)) }
            }
            out.addAll(extras.sortedBy { it.businessId })
            brandings = out
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Native asset upload — web api.branding.uploadAsset parity (owner 2026-07-11). */
    suspend fun uploadAsset(businessId: String, assetType: String, data: ByteArray, mime: String) {
        uploading = true
        try {
            val body = JSONObject()
                .put("action", "upload")
                .put("asset_type", assetType)          // logo | favicon
                .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                .put("mime_type", mime)
                .put("filename", "$assetType.${mime.substringAfter("/", "png")}")
                .put("business_id", businessId)
            val resp = AlmaApi.send("POST", "/api/branding", body)
            val root = resp.optJSONObject("data") ?: resp
            if (resp.flexBool("ok") == true || root.flexBool("ok") == true) {
                toast = if (assetType == "logo") "Logo আপলোড হয়েছে" else "Favicon আপলোড হয়েছে"
                load()
            } else {
                toast = root.str("error") ?: resp.str("error") ?: "আপলোড হয়নি"
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            toast = e.message ?: "আপলোড হয়নি"
        } finally {
            uploading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun SettingsBrandingScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SettingsBrandingState() }

    LaunchedEffect(Unit) { vm.load() }
    // Toast auto-dismiss (iOS bottom toast parity).
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            kotlinx.coroutines.delay(2600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (vm.authExpired) {
                item { BrandingAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { BrandingNoticeCard("⚠️ $it", SettingsBrandingPalette.red500, dark) } }
            if (vm.fallback) {
                item {
                    BrandingNoticeCard(
                        "সার্ভার থেকে সেভ করা ব্র্যান্ডিং আনা যায়নি — ডিফল্ট দেখানো হচ্ছে।",
                        AlmaTheme.inkSecondary(dark), dark,
                    )
                }
            }

            item {
                // The web's gold recommendations box ("Brand assets").
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(SettingsBrandingPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .border(1.dp, SettingsBrandingPalette.coral.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        "BRAND ASSETS",
                        color = SettingsBrandingPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                    )
                    Text(
                        "Logo: 1200x400 PNG (3:1) · Favicon/PWA: 512x512 square",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                    Text(
                        "লোগো/ফ্যাভিকন এখান থেকেই আপলোড করা যায় — রং বা নাম বদলাতে হলে ওয়েবে করুন।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }

            if (vm.loading && vm.brandings.isEmpty()) {
                items(3) { Box(Modifier.fillMaxWidth().height(220.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            }

            items(vm.brandings, key = { it.businessId }) { branding ->
                SettingsBrandingCard(branding, vm, dark)
            }

            if (!vm.loading && vm.brandings.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("🎨", fontSize = 34.sp)
                        Text("কিছু নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    }
                }
            }

            item {
                Text(
                    "🌐 রং ও নাম এডিট — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/settings/branding", "Branding") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 22)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}

// ── Per-business branding card (web page sections, one glass card per tenant) ──────

@Composable
private fun SettingsBrandingCard(branding: SettingsBrandingInfo, vm: SettingsBrandingState, dark: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    /** SAF picker — Android twin of the iOS PhotosPicker upload row. */
    var pickType by remember { mutableStateOf("logo") }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            val mime = context.contentResolver.getType(uri) ?: "image/png"
            val bytes = try {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            } catch (_: Exception) { null }
            if (bytes != null) scope.launch { vm.uploadAsset(branding.businessId, pickType, bytes, mime) }
            else vm.toast = "ছবি পড়া যায়নি"
        }
    }

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // ── Header: brand initial badge + company name + tagline + tenant capsule ──
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val primary = SettingsBrandingFormat.color(branding.colorPrimary) ?: SettingsBrandingPalette.coral
            val secondary = SettingsBrandingFormat.color(branding.colorSecondary) ?: AlmaTheme.violet
            Box(
                Modifier
                    .size(38.dp)
                    .background(
                        Brush.linearGradient(listOf(primary, secondary)),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    SettingsBrandingFormat.initials(branding.displayName),
                    color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(branding.displayName, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                branding.tagline?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it.uppercase(), color = AlmaTheme.inkSecondary(dark),
                        fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                branding.businessId.replace("_", " "),
                color = SettingsBrandingPalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(SettingsBrandingPalette.coral.copy(alpha = 0.14f), CircleShape)
                    .border(1.dp, SettingsBrandingPalette.coral.copy(alpha = 0.35f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }

        // ── Native logo/favicon upload (web uploadAsset parity, owner 2026-07-11) ──
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BrandingUploadChip("🖼 Logo আপলোড", dark) { pickType = "logo"; picker.launch("image/*") }
            BrandingUploadChip("Favicon", dark) { pickType = "favicon"; picker.launch("image/*") }
            if (vm.uploading) {
                CircularProgressIndicator(Modifier.size(13.dp), color = SettingsBrandingPalette.coral, strokeWidth = 2.dp)
            }
        }

        // ── Logo + favicon (web preview boxes; images through the auth image-proxy) ──
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BrandingAssetBox("LOGO", branding.logoUrl, "No logo", dark, Modifier.weight(1f))
            BrandingAssetBox("FAVICON", branding.faviconUrl, "No favicon", dark, Modifier.width(88.dp))
        }

        // ── Brand colours (web "Brand colors" card → swatch chips) ──
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("BRAND COLORS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BrandingSwatch("Primary", branding.colorPrimary, dark, Modifier.weight(1f))
                BrandingSwatch("Secondary", branding.colorSecondary, dark, Modifier.weight(1f))
                BrandingSwatch("Accent", branding.colorAccent, dark, Modifier.weight(1f))
            }
        }

        // ── Company details (web grid → compact rows) ──
        val details = listOf(
            "📞" to branding.phone,
            "✉️" to branding.email,
            "🌐" to branding.website,
            "📍" to branding.address,
            "👍" to branding.facebook,
        ).filter { !it.second.isNullOrEmpty() }
        if (details.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("COMPANY DETAILS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                details.forEach { (icon, value) ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(icon, fontSize = 11.sp)
                        Text(value ?: "", color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp)
                    }
                }
            }
        }

        // ── Invoice branding (web "Invoice watermark" + "Invoice footer" cards) ──
        Column(
            Modifier
                .fillMaxWidth()
                .background(SettingsBrandingPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, SettingsBrandingPalette.goldDim.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("INVOICE", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                branding.invoicePrefix?.takeIf { it.isNotEmpty() }?.let { prefix ->
                    Text(
                        prefix,
                        color = SettingsBrandingPalette.accentText(dark),
                        fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .background(SettingsBrandingPalette.coral.copy(alpha = 0.12f), CircleShape)
                            .border(1.dp, SettingsBrandingPalette.coral.copy(alpha = 0.30f), CircleShape)
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
                val watermarkOff = branding.invoiceWatermarkEnabled == false
                Text(
                    if (watermarkOff) "Watermark off"
                    else "Watermark on · ${(((branding.invoiceWatermarkOpacity ?: 0.08) * 100).roundToInt())}%",
                    color = if (watermarkOff) AlmaTheme.inkSecondary(dark) else SettingsBrandingPalette.emerald600,
                    fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
            }
            listOf(
                "Thank you line" to branding.invoiceFooterThanks,
                "Policy / terms" to branding.invoiceFooterPolicy,
                "Legal note" to branding.invoiceFooterNote,
            ).forEach { (label, value) ->
                if (!value.isNullOrEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                        Text(value, color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp)
                    }
                }
            }
        }

        SettingsBrandingFormat.dateTime(branding.updatedAt)?.let {
            Text("Updated $it", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun BrandingUploadChip(label: String, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
            .plainClick(onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp),
    )
}

/** Logo/favicon preview through the authenticated image proxy (Coil + session cookie). */
@Composable
private fun BrandingAssetBox(
    title: String,
    rawUrl: String?,
    emptyText: String,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Box(
            Modifier
                .fillMaxWidth()
                .height(72.dp)
                .background(
                    Color.White.copy(alpha = if (dark) 0.06f else 0.55f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .border(
                    1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.45f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            val proxied = SettingsBrandingFormat.proxyUrl(rawUrl)
            if (proxied != null) {
                val cookie = remember { CookieManager.getInstance().getCookie(AlmaTheme.BASE_URL) }
                AsyncImage(
                    model = ImageRequest.Builder(LocalContext.current)
                        .data(proxied)
                        .apply { if (cookie != null) setHeader("Cookie", cookie) }
                        .crossfade(true)
                        .build(),
                    contentDescription = title,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                )
            } else {
                Text(emptyText, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun BrandingSwatch(label: String, hex: String?, dark: Boolean, modifier: Modifier = Modifier) {
    Row(
        modifier
            .background(
                Color.White.copy(alpha = if (dark) 0.05f else 0.40f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .border(
                1.dp, Color.White.copy(alpha = if (dark) 0.09f else 0.40f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .size(18.dp)
                .background(
                    SettingsBrandingFormat.color(hex) ?: AlmaTheme.inkSecondary(dark).copy(alpha = 0.25f),
                    CircleShape,
                )
                .border(1.dp, Color.White.copy(alpha = 0.5f), CircleShape),
        )
        Column {
            Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
            Text(
                (hex ?: "—").uppercase(),
                color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun BrandingNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun BrandingAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SettingsBrandingPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SettingsBrandingFormat {
    /** "#E07A5F" / "E07A5F" / "abc" → Color (the web renders these via <input type=color>). */
    fun color(hex: String?): Color? {
        var s = hex?.trim() ?: return null
        if (s.isEmpty()) return null
        if (s.startsWith("#")) s = s.substring(1)
        if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
        if (s.length != 6) return null
        val value = s.toLongOrNull(16) ?: return null
        return Color(
            red = ((value shr 16) and 0xFF).toInt() / 255f,
            green = ((value shr 8) and 0xFF).toInt() / 255f,
            blue = (value and 0xFF).toInt() / 255f,
        )
    }

    /** The web loads brand images through its authenticated proxy — same here. */
    fun proxyUrl(raw: String?): String? {
        if (raw.isNullOrEmpty()) return null
        return AlmaTheme.BASE_URL + "/api/branding/image-proxy?raw=1&url=" + URLEncoder.encode(raw, "UTF-8")
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** updated_at → "5/7/26, 8:50 PM" style (web: new Date(...).toLocaleString()), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        var date: Date? = null
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.timeZone = TimeZone.getTimeZone("UTC")
                date = f.parse(iso)
                break
            } catch (_: Exception) { }
        }
        val d = date ?: return null
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(d)
    }
}
