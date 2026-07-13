//
//  AgentGrowthScreen.kt
//  ALMA ERP — the Growth tab (/agent/growth), ported 1:1 from AgentGrowthSwiftUI.swift.
//
//  Read-only by design: connect/disconnect (OAuth) and every action stays on the
//  web escape hatch. Blocks: intro subtitle · tone summary chips (সবুজ/হলুদ/নীল) ·
//  GSC card (configured / connected / sites) · গ্রোথ ফিচার স্ট্যাটাস board with tone
//  dots · Bangla detail strings verbatim · amber/red anomaly strips.
//  Carried lesson: ONE independent loading state per block (the web loads the two
//  cards independently — the slower live-probe board never holds up the GSC card).
//
//  Endpoints (same as web/iOS):
//    GET /api/assistant/growth/gsc-status      → Google Search Console connection
//    GET /api/assistant/growth/feature-status  → live feature board (GA4 / GBP /
//                                                 IndexNow / SMS / Email / safety)
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
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
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object GrowthPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    // Web StatusRow dots + Google brand blue.
    val emerald400 = Color(0xFF34D399)
    val sky400 = Color(0xFF38BDF8)
    val amber400 = Color(0xFFFBBF24)
    val googleBlue = Color(0xFF4285F4)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

/** Web StatusRow tone: ok = emerald dot · pending = sky dot · warn = amber dot. */
private enum class GrowthTone { OK, PENDING, WARN }

private fun toneDot(t: GrowthTone): Color = when (t) {
    GrowthTone.OK -> GrowthPalette.emerald400
    GrowthTone.PENDING -> GrowthPalette.sky400
    GrowthTone.WARN -> GrowthPalette.amber400
}

// ── Models (same field names the web page types declare) ───────────────────────────

private data class GrowthGsc(
    val configured: Boolean,
    val connected: Boolean,
    val email: String?,
    val sites: List<String>,
    val sitesError: String?,
) {
    companion object {
        fun from(o: JSONObject) = GrowthGsc(
            configured = o.flexBool("configured") ?: false,
            connected = o.flexBool("connected") ?: false,
            email = o.str("email"),
            sites = o.optJSONArray("sites")?.let { arr ->
                (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotEmpty() } }
            } ?: emptyList(),
            sitesError = o.str("sitesError"),
        )
    }
}

private data class GrowthGa4(val state: String, val propertyId: String?, val sessions7d: Int?, val error: String?)
private data class GrowthGbp(val state: String, val location: String?, val error: String?)
private data class GrowthIndexNow(val state: String, val keyFileLive: Boolean)
private data class GrowthSms(val state: String, val balance: String?, val error: String?)
private data class GrowthEmail(val state: String, val domain: String?)

private data class GrowthFeatures(
    val generatedAt: String?,
    val gscConnected: Boolean,
    val ga4: GrowthGa4,
    val gbp: GrowthGbp,
    val indexnow: GrowthIndexNow,
    val sms: GrowthSms,
    val email: GrowthEmail,
    val finalSubmitServerLayer: Boolean,
) {
    companion object {
        /** Lenient decode — a missing/misshapen sub-object degrades to state "error". */
        fun from(o: JSONObject): GrowthFeatures {
            val ga4 = o.optJSONObject("ga4")?.let {
                GrowthGa4(it.str("state") ?: "error", it.str("propertyId"), it.flexInt("sessions7d"), it.str("error"))
            } ?: GrowthGa4("error", null, null, null)
            val gbp = o.optJSONObject("gbp")?.let {
                GrowthGbp(it.str("state") ?: "error", it.str("location"), it.str("error"))
            } ?: GrowthGbp("error", null, null)
            val indexnow = o.optJSONObject("indexnow")?.let {
                GrowthIndexNow(it.str("state") ?: "error", it.flexBool("keyFileLive") ?: false)
            } ?: GrowthIndexNow("error", false)
            val camp = o.optJSONObject("campaigns")
            val sms = camp?.optJSONObject("sms")?.let {
                GrowthSms(it.str("state") ?: "error", it.str("balance"), it.str("error"))
            } ?: GrowthSms("error", null, null)
            val email = camp?.optJSONObject("email")?.let {
                GrowthEmail(it.str("state") ?: "error", it.str("domain"))
            } ?: GrowthEmail("error", null)
            return GrowthFeatures(
                generatedAt = o.str("generatedAt"),
                gscConnected = o.flexBool("gscConnected") ?: false,
                ga4 = ga4, gbp = gbp, indexnow = indexnow, sms = sms, email = email,
                finalSubmitServerLayer = o.optJSONObject("finalSubmitBan")?.flexBool("serverLayer") ?: true,
            )
        }
    }
}

// ── State holder (iOS AgentGrowthVM twin) ──────────────────────────────────────────

private class AgentGrowthState {
    var gsc by mutableStateOf<GrowthGsc?>(null)
    var features by mutableStateOf<GrowthFeatures?>(null)
    var loading by mutableStateOf(false)           // GSC card (web `loading`)
    var featuresLoading by mutableStateOf(false)   // feature board loads independently
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** Same order as the web: GSC status first, then the slower live-probe board. */
    suspend fun load() {
        loading = true
        error = null
        try {
            gsc = GrowthGsc.from(unwrap(AlmaApi.getObject("/api/assistant/growth/gsc-status")))
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            loading = false
            return
        } catch (e: Exception) {
            error = "স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।"
        }
        loading = false

        featuresLoading = true
        try {
            features = GrowthFeatures.from(unwrap(AlmaApi.getObject("/api/assistant/growth/feature-status")))
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            // The board shows its own inline warn line when `features` stays null.
        } finally {
            featuresLoading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun AgentGrowthScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AgentGrowthState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Header intro (web subtitle, verbatim) + refresh.
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "এখান থেকে Google-এর ফ্রি ডেটা সোর্সগুলো একবার যুক্ত করুন। যুক্ত হলে এজেন্ট আসল search ডেটা দিয়ে SEO সিদ্ধান্ত নিতে পারবে (Oxylabs খরচ ছাড়াই)।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, lineHeight = 17.sp,
                    modifier = Modifier.weight(1f).padding(top = 4.dp),
                )
                Box(
                    Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
            }
        }
        if (vm.authExpired) {
            item { GrowthAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { GrowthWarnCard(it, dark) } }
        item { GrowthSummaryChips(vm.features, dark) }
        item { GrowthGscCard(vm, dark) { p, t -> ctx.openWebForced(p, t) } }
        item { GrowthFeatureBoard(vm, dark) }
        item {
            // Connect / disconnect (OAuth) and every write stays on the web page.
            Text(
                "🌐 সংযোগ যুক্ত/বিচ্ছিন্ন করতে — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/agent/growth", "Growth") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

// ── Tone summary chips (native strip: সবুজ = চলছে · হলুদ = কাজ বাকি · নীল = অপেক্ষা) ──

@Composable
private fun GrowthSummaryChips(features: GrowthFeatures?, dark: Boolean) {
    val f = features ?: return
    val tones = listOf(
        if (f.gscConnected) GrowthTone.OK else GrowthTone.WARN,
        if (f.ga4.state == "ok") GrowthTone.OK else GrowthTone.WARN,
        when (f.gbp.state) {
            "ok" -> GrowthTone.OK
            "pending_google" -> GrowthTone.PENDING
            else -> GrowthTone.WARN
        },
        if (f.indexnow.state == "ok") GrowthTone.OK else GrowthTone.WARN,
        if (f.sms.state == "ok") GrowthTone.OK else GrowthTone.WARN,
        if (f.email.state == "ok") GrowthTone.OK else GrowthTone.WARN,
        GrowthTone.OK, // Final-submit safety — always on when the route answers.
    )
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GrowthToneChip("চলছে", tones.count { it == GrowthTone.OK }, GrowthTone.OK, dark)
        GrowthToneChip("কাজ বাকি", tones.count { it == GrowthTone.WARN }, GrowthTone.WARN, dark)
        GrowthToneChip("অপেক্ষায়", tones.count { it == GrowthTone.PENDING }, GrowthTone.PENDING, dark)
    }
}

@Composable
private fun GrowthToneChip(label: String, count: Int, tone: GrowthTone, dark: Boolean) {
    Row(
        Modifier
            .background(Color.White.copy(alpha = if (dark) 0.08f else 0.45f), CircleShape)
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.4f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).background(toneDot(tone), CircleShape))
        Text(label, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Text("$count", color = toneDot(tone), fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Google Search Console card (web card parity) ───────────────────────────────────

@Composable
private fun GrowthGscCard(vm: AgentGrowthState, dark: Boolean, openWeb: (String, String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier
                    .size(36.dp)
                    .background(GrowthPalette.googleBlue.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
                contentAlignment = Alignment.Center,
            ) { Text("🔍", fontSize = 15.sp) }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Google Search Console", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Text(
                    "আসল Google search ডেটা — impressions, clicks, position, top queries",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                )
            }
        }

        val gsc = vm.gsc
        when {
            vm.loading && gsc == null ->
                Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)

            gsc != null && !gsc.configured -> GrowthAmberBox(
                "OAuth client সেট করা নেই। Vercel-এ GSC_CLIENT_ID ও GSC_CLIENT_SECRET সেট করুন (অথবা বিদ্যমান GOOGLE_DRIVE_CLIENT_ID/SECRET রি-ইউজ হবে)।",
            )

            gsc != null && gsc.connected -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(GrowthPalette.emerald400.copy(alpha = 0.07f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .border(1.dp, GrowthPalette.emerald400.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("যুক্ত আছে ✓", color = GrowthPalette.emerald400, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        gsc.email?.let {
                            Text(
                                it, color = GrowthPalette.emerald400.copy(alpha = 0.7f), fontSize = 10.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Text("✅", fontSize = 14.sp)
                }
                when {
                    gsc.sitesError != null -> Text(
                        "Property তালিকা আনা যায়নি: ${gsc.sitesError}",
                        color = GrowthPalette.amber400, fontSize = 10.sp,
                    )
                    gsc.sites.isNotEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("PROPERTIES", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                        gsc.sites.forEach { s ->
                            Text(
                                s, color = AlmaTheme.ink(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(
                                        Color.White.copy(alpha = if (dark) 0.06f else 0.35f),
                                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                                    )
                                    .padding(horizontal = 8.dp, vertical = 5.dp),
                            )
                        }
                    }
                    else -> Text(
                        "এই account-এ কোনো Search Console property নেই।",
                        color = GrowthPalette.amber400, fontSize = 10.sp,
                    )
                }
            }

            gsc != null -> {
                // Connect = Google OAuth redirect — must run in the web view.
                Text(
                    "Google Search Console যুক্ত করুন",
                    color = GrowthPalette.googleBlue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(GrowthPalette.googleBlue.copy(alpha = 0.08f), CircleShape)
                        .border(1.dp, GrowthPalette.googleBlue.copy(alpha = 0.30f), CircleShape)
                        .plainClick { openWeb("/agent/growth", "Growth") }
                        .padding(vertical = 10.dp),
                )
            }

            !vm.loading -> Text(
                "স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।",
                color = GrowthPalette.amber400, fontSize = 12.sp,
            )
        }
    }
}

// ── Growth feature status board (web Features 1–8 board, verbatim strings) ─────────

@Composable
private fun GrowthFeatureBoard(vm: AgentGrowthState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("গ্রোথ ফিচার স্ট্যাটাস", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(
                "সব integration-এর এখনকার আসল অবস্থা — সবুজ = চলছে, হলুদ = আপনার একটা কাজ বাকি, নীল = অন্যের অনুমোদনের অপেক্ষা।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }

        val f = vm.features
        when {
            vm.featuresLoading && f == null -> repeat(4) {
                Box(Modifier.fillMaxWidth().height(62.dp).almaGlass(dark, AlmaTheme.R_CONTROL))
            }
            f != null -> {
                GrowthStatusRow(
                    tone = if (f.gscConnected) GrowthTone.OK else GrowthTone.WARN, icon = "🔍",
                    title = "Search Console (SEO ডেটা)",
                    detail = if (f.gscConnected) "যুক্ত আছে — আসল search ডেটা আসছে।" else "যুক্ত নেই।",
                    action = if (f.gscConnected) null else "উপরের বাটন থেকে connect করুন",
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = if (f.ga4.state == "ok") GrowthTone.OK else GrowthTone.WARN, icon = "📊",
                    title = "Google Analytics (ট্রাফিক ও ROI)",
                    detail = ga4Detail(f.ga4),
                    critical = f.ga4.state == "error",
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = when (f.gbp.state) {
                        "ok" -> GrowthTone.OK
                        "pending_google" -> GrowthTone.PENDING
                        else -> GrowthTone.WARN
                    },
                    icon = "📍",
                    title = "Business Profile (Google রিভিউ)",
                    detail = gbpDetail(f.gbp),
                    action = if (f.gbp.state == "pending_google")
                        "Google-এর access form (project 207682606576)" else null,
                    actionUrl = if (f.gbp.state == "pending_google")
                        "https://support.google.com/business/contact/api_default" else null,
                    critical = f.gbp.state == "error",
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = if (f.indexnow.state == "ok") GrowthTone.OK else GrowthTone.WARN, icon = "⚡",
                    title = "IndexNow (দ্রুত re-crawl)",
                    detail = indexnowDetail(f.indexnow),
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = if (f.sms.state == "ok") GrowthTone.OK else GrowthTone.WARN, icon = "📱",
                    title = "SMS ক্যাম্পেইন (sms.net.bd)",
                    detail = smsDetail(f.sms),
                    critical = f.sms.state == "bad_key",
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = if (f.email.state == "ok") GrowthTone.OK else GrowthTone.WARN, icon = "📧",
                    title = "Email ক্যাম্পেইন (Resend)",
                    detail = emailDetail(f.email),
                    action = if (f.email.state in setOf("sandbox", "send_only"))
                        "Resend → Domains → Add almatraders.com" else null,
                    actionUrl = if (f.email.state in setOf("sandbox", "send_only"))
                        "https://resend.com/domains" else null,
                    critical = f.email.state == "bad_key",
                    dark = dark,
                )
                GrowthStatusRow(
                    tone = GrowthTone.OK, icon = "🛡️",
                    title = "Final-submit নিরাপত্তা (ব্রাউজার)",
                    detail = "Send/Pay/Delete-জাতীয় শেষ বাটন এজেন্ট আর চাপতে পারে না — কোড-লেভেলে ব্লক (server লেয়ার চালু)। Extension লেয়ারের জন্য chrome://extensions-এ একবার Reload।",
                    dark = dark,
                )
                GrowthFormat.dateTime(f.generatedAt)?.let { stamp ->
                    Text(
                        "লাইভ স্ট্যাটাস: $stamp",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        textAlign = TextAlign.End,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            vm.featuresLoading ->
                Text("লাইভ স্ট্যাটাস আনা হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            !vm.authExpired ->
                Text("স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।", color = GrowthPalette.amber400, fontSize = 12.sp)
        }
    }
}

// Web detail strings, verbatim per state.

private fun ga4Detail(g: GrowthGa4): String = when (g.state) {
    "ok" -> "চলছে — গত ৭ দিনে ${g.sessions7d ?: 0}টি ভিজিট (property ${g.propertyId ?: "—"})।"
    "needs_env" -> "GA4_PROPERTY_ID সেট করা নেই।"
    "needs_reconnect" -> "Analytics permission নেই — আবার connect করুন।"
    "needs_connect" -> "Google connect করা নেই।"
    "timeout" -> "Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
    else -> "সমস্যা: ${g.error ?: "অজানা"}"
}

private fun gbpDetail(g: GrowthGbp): String = when (g.state) {
    "ok" -> "চলছে — location: ${if (!g.location.isNullOrEmpty()) g.location else "পাওয়া গেছে"}।"
    "pending_google" -> "কোড রেডি — Google-এর API access অনুমোদনের অপেক্ষায় (form submit করলে কয়েক দিনে চালু হবে)।"
    "needs_reconnect" -> "Business Profile permission নেই — আবার connect করুন।"
    "no_location" -> "এই Google account-এ কোনো Business Profile নেই।"
    "needs_connect" -> "Google connect করা নেই।"
    "timeout" -> "Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
    else -> "সমস্যা: ${g.error ?: "অজানা"}"
}

private fun indexnowDetail(i: GrowthIndexNow): String = when (i.state) {
    "ok" -> "চলছে — key file লাইভ, SEO ফিক্সের পর Bing/Yandex সাথে সাথে জানবে।"
    "needs_env" -> "INDEXNOW_KEY সেট করা নেই।"
    else -> "Key file storefront-এ পাওয়া যাচ্ছে না।"
}

private fun smsDetail(s: GrowthSms): String = when (s.state) {
    "ok" -> {
        val bal = s.balance?.let { ", ব্যালেন্স ৳$it" } ?: ""
        "চলছে — key যাচাই হয়েছে$bal।"
    }
    "needs_env" -> "SMS_API_KEY সেট করা নেই।"
    "bad_key" -> "Key কাজ করছে না: ${s.error ?: "provider error"}"
    else -> "Provider সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
}

private fun emailDetail(e: GrowthEmail): String = when (e.state) {
    "ok" -> "চলছে — domain verified (${e.domain ?: "—"}), কাস্টমারদের পাঠানো যাবে।"
    "sandbox" -> "Sandbox mode — শুধু নিজের ঠিকানায় যায়। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।"
    "send_only" -> "Key কাজ করছে (send-only) — পাঠানো যায়, তবে domain state check করা যায় না। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।"
    "needs_env" -> "RESEND_API_KEY সেট করা নেই।"
    "bad_key" -> "Resend key কাজ করছে না।"
    else -> "Resend সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।"
}

// ── Status row (web StatusRow parity: dot + emoji + title + detail + action hint) ──

@Composable
private fun GrowthStatusRow(
    tone: GrowthTone,
    icon: String,
    title: String,
    detail: String,
    dark: Boolean,
    action: String? = null,
    actionUrl: String? = null,
    critical: Boolean = false,
) {
    val uriHandler = LocalUriHandler.current
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                Color.White.copy(alpha = if (dark) 0.05f else 0.30f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .padding(horizontal = 10.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(icon, fontSize = 15.sp, modifier = Modifier.padding(top = 1.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(8.dp).background(toneDot(tone), CircleShape))
                Text(title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                detail,
                color = if (critical) GrowthPalette.red500 else AlmaTheme.inkSecondary(dark),
                fontSize = 10.sp, lineHeight = 14.sp,
            )
            if (action != null) {
                // External destination (GBP access form, Resend domains) opens the browser.
                Text(
                    "→ $action" + if (actionUrl != null) " ↗" else "",
                    color = GrowthPalette.amber400, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    textDecoration = if (actionUrl != null) TextDecoration.Underline else null,
                    modifier = if (actionUrl != null)
                        Modifier.plainClick { try { uriHandler.openUri(actionUrl) } catch (_: Exception) {} }
                    else Modifier,
                )
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun GrowthAmberBox(text: String) {
    Text(
        text,
        color = GrowthPalette.amber600, fontSize = 10.sp, lineHeight = 14.sp,
        modifier = Modifier
            .fillMaxWidth()
            .background(GrowthPalette.amber500.copy(alpha = 0.07f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, GrowthPalette.amber500.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

@Composable
private fun GrowthWarnCard(message: String, dark: Boolean) {
    Text(
        "⚠️ $message", color = GrowthPalette.amber600, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun GrowthAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(GrowthPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object GrowthFormat {
    /** ISO stamp → "5/7/2026, 8:50 PM" style in Asia/Dhaka (web toLocaleString parity). */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

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
}
