//
//  BriefingScreen.kt
//  ALMA ERP — the Morning Briefing, ported 1:1 from BriefingSwiftUI.swift (build 66).
//
//  Mirrors the web /briefing page — same endpoint, same blocks, same Bangla:
//    GET /api/briefing            → cached owner daily digest ({ ok, data: {…} })
//    GET /api/briefing?refresh=1  → forces a fresh tour (↻ chip)
//  Blocks: hero greeting (Dhaka-hour) + date line + refresh chip · 4 KPI cards
//  (yesterday sales / 7-day avg / pending orders / approvals) · আজকের করণীয় decision
//  cards (area badge, জরুরি chip, recommend →, 💡 knowledgeNote, clamp + আরো দেখুন) ·
//  রিঅর্ডার দরকার · কাস্টমার অপেক্ষমাণ · স্টাফ (গতকাল) · রিটার্ন ও প্রাইসিং flags ·
//  আজকের অ্যাড · আপনার টু-ডু · agent footer. READ-ONLY.
//

package com.almatraders.erp.pages

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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
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
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens, iOS twin) ──────────

private object BfPalette {
    val coral = AlmaTheme.coral                    // web --c-accent #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val emerald600 = Color(0xFF059669)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (structural — same fields the web Briefing type declares) ────────────────

private data class BfDecision(
    val area: String,
    val urgency: String,
    val text: String,
    val recommend: String,
    val knowledgeNote: String?,
) {
    companion object {
        fun from(o: JSONObject) = BfDecision(
            area = o.str("area") ?: "",
            urgency = o.str("urgency") ?: "normal",
            text = o.str("text") ?: "",
            recommend = o.str("recommend") ?: "",
            knowledgeNote = o.str("knowledgeNote"),
        )
    }
}

private data class BfReorder(
    val name: String,
    val reason: String,
    val suggestedQty: Int,
    val urgency: String,
) {
    companion object {
        fun from(o: JSONObject) = BfReorder(
            name = o.str("name") ?: "—",
            reason = o.str("reason") ?: "",
            suggestedQty = o.flexInt("suggestedQty") ?: 0,
            urgency = o.str("urgency") ?: "normal",
        )
    }
}

private data class BfTodo(val title: String, val priority: String?, val ageDays: Int) {
    companion object {
        fun from(o: JSONObject) = BfTodo(
            title = o.str("title") ?: "—",
            priority = o.str("priority"),
            ageDays = o.flexInt("ageDays") ?: 0,
        )
    }
}

private data class BfSales(
    val yesterdayTotal: Double,
    val yesterdayOrders: Int,
    val sevenDayAvg: Double,
    val sevenDayOrderAvg: Double,
)

private data class BfPendingOrders(val count: Int, val mismatch: Boolean?)

private data class BfCsWaiting(val unrepliedCount: Int, val nearWindowCount: Int, val openAlerts: Int) {
    val hasAnything get() = unrepliedCount > 0 || nearWindowCount > 0 || openAlerts > 0
}

private data class BfAdsCampaign(val name: String, val spend: Double, val ctr: Double)
private data class BfAdsAnomaly(val campaign: String, val dropPct: Double)
private data class BfAdsDigest(val campaigns: List<BfAdsCampaign>, val anomalies: List<BfAdsAnomaly>)

private data class BfLowPerformer(val name: String, val pct: Int, val daysLow: Int)
private data class BfStaffYesterday(val done: Int, val total: Int, val lowPerformers: List<BfLowPerformer>)

private class BfData(
    val sales: BfSales?,
    val pendingOrders: BfPendingOrders?,
    val reorderSuggestions: List<BfReorder>,
    val csWaiting: BfCsWaiting?,
    val adsDigest: BfAdsDigest?,
    val staffYesterday: BfStaffYesterday?,
    val flagLines: List<String>,      // returns.flags + pricing.flags (web order)
    val decisions: List<BfDecision>,  // high-urgency first (web ordering)
    val generatedAt: String?,
    val pendingApprovalsCount: Int?,
    val openTodos: List<BfTodo>,
) {
    companion object {
        private fun flags(o: JSONObject?, key: String): List<String> {
            val arr: JSONArray = o?.optJSONArray(key) ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                arr.optString(i, null)?.takeIf { it.isNotEmpty() }
            }
        }

        fun from(c: JSONObject): BfData {
            val sales = c.optJSONObject("sales")?.let {
                BfSales(
                    yesterdayTotal = it.flexDouble("yesterdayTotal") ?: 0.0,
                    yesterdayOrders = it.flexInt("yesterdayOrders") ?: 0,
                    sevenDayAvg = it.flexDouble("sevenDayAvg") ?: 0.0,
                    sevenDayOrderAvg = it.flexDouble("sevenDayOrderAvg") ?: 0.0,
                )
            }
            val pending = c.optJSONObject("pendingOrders")?.let {
                BfPendingOrders(it.flexInt("count") ?: 0, it.flexBool("mismatch"))
            }
            val cs = c.optJSONObject("csWaiting")?.let {
                BfCsWaiting(
                    it.flexInt("unrepliedCount") ?: 0,
                    it.flexInt("nearWindowCount") ?: 0,
                    it.flexInt("openAlerts") ?: 0,
                )
            }
            val ads = c.optJSONObject("adsDigest")?.let { d ->
                BfAdsDigest(
                    campaigns = d.optJSONArray("campaigns")?.mapObjects {
                        BfAdsCampaign(it.str("name") ?: "—", it.flexDouble("spend") ?: 0.0, it.flexDouble("ctr") ?: 0.0)
                    } ?: emptyList(),
                    anomalies = d.optJSONArray("anomalies")?.mapObjects {
                        BfAdsAnomaly(it.str("campaign") ?: "—", it.flexDouble("dropPct") ?: 0.0)
                    } ?: emptyList(),
                )
            }
            val staff = c.optJSONObject("staffYesterday")?.let { s ->
                BfStaffYesterday(
                    done = s.flexInt("done") ?: 0,
                    total = s.flexInt("total") ?: 0,
                    lowPerformers = s.optJSONArray("lowPerformers")?.mapObjects {
                        BfLowPerformer(it.str("name") ?: "—", it.flexInt("pct") ?: 0, it.flexInt("daysLow") ?: 0)
                    } ?: emptyList(),
                )
            }
            val rawDecisions = c.optJSONArray("decisions")?.mapObjects { BfDecision.from(it) } ?: emptyList()
            return BfData(
                sales = sales,
                pendingOrders = pending,
                reorderSuggestions = c.optJSONArray("reorderSuggestions")?.mapObjects { BfReorder.from(it) } ?: emptyList(),
                csWaiting = cs,
                adsDigest = ads,
                staffYesterday = staff,
                flagLines = flags(c.optJSONObject("returns"), "flags") + flags(c.optJSONObject("pricing"), "flags"),
                decisions = rawDecisions.filter { it.urgency == "high" } + rawDecisions.filter { it.urgency != "high" },
                generatedAt = c.str("generatedAt"),
                pendingApprovalsCount = c.flexInt("pendingApprovalsCount"),
                openTodos = c.optJSONArray("openTodos")?.mapObjects { BfTodo.from(it) } ?: emptyList(),
            )
        }
    }
}

// ── State holder (iOS BriefingVM twin) ──────────────────────────────────────────────

private class BriefingState {
    var data by mutableStateOf<BfData?>(null)
    var loading by mutableStateOf(false)
    var refreshing by mutableStateOf(false)   // the web's "রিফ্রেশ হচ্ছে…" state
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load(fresh: Boolean = false) {
        if (fresh) refreshing = true else loading = true
        error = null
        try {
            // The briefing route wraps its payload via apiDataSuccess → {ok, data:{…}} —
            // unwrap both shapes (same defensive pattern as approvals).
            val root = AlmaApi.getObject(
                "/api/briefing",
                if (fresh) mapOf("refresh" to "1") else emptyMap(),
            )
            data = BfData.from(root.optJSONObject("data") ?: root)
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "ব্রিফিং লোড করা গেল না"
        } finally {
            loading = false
            refreshing = false
        }
    }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@Composable
fun BriefingScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { BriefingState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (vm.authExpired) {
            item { BfAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.takeIf { vm.data == null }?.let { err ->
            item { BfErrorCard(err, dark) { scope.launch { vm.load(fresh = true) } } }
        }
        if (vm.loading && vm.data == null) {
            item { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(2) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            repeat(2) {
                                Box(
                                    Modifier.weight(1f).height(78.dp)
                                        .almaGlass(dark, AlmaTheme.R_CONTROL).shimmering(),
                                )
                            }
                        }
                    }
                }
            }
            items(3) {
                Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
            }
        }
        vm.data?.let { data ->
            item { BfHeroCard(data, dark, refreshing = vm.refreshing) { scope.launch { vm.load(fresh = true) } } }
            item { BfKpiGrid(data, dark) }

            // Today's actions — the centerpiece.
            item { BfSection(Icons.Filled.TrackChanges, "আজকের করণীয়", dark, count = data.decisions.size) }
            if (data.decisions.isEmpty()) {
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(22.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Text("সব শান্ত ✓", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        Text(
                            "জরুরি কোনো সিদ্ধান্ত নেই — ব্যবসা স্বাভাবিক চলছে, Boss।",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
                        )
                    }
                }
            } else {
                items(data.decisions.size) { i -> BfDecisionCard(data.decisions[i], dark) }
            }

            // Reorder suggestions.
            if (data.reorderSuggestions.isNotEmpty()) {
                item {
                    BfSection(
                        Icons.Filled.Inventory2, "রিঅর্ডার দরকার", dark,
                        count = data.reorderSuggestions.size,
                        linkTitle = "দেখুন →",
                    ) { ctx.openSmart("/inventory", "Inventory") }
                }
                val reorders = data.reorderSuggestions.take(6)
                items(reorders.size) { i -> BfReorderCard(reorders[i], dark) }
            }

            // CS waiting.
            data.csWaiting?.takeIf { it.hasAnything }?.let { cs ->
                item { BfSection(Icons.Filled.Forum, "কাস্টমার অপেক্ষমাণ", dark) }
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        BfMiniRow(
                            "অপেক্ষমাণ রিপ্লাই", "${cs.unrepliedCount}", dark,
                            tint = if (cs.unrepliedCount >= 5) BfPalette.goldLt else AlmaTheme.ink(dark),
                        )
                        BfMiniRow(
                            "২৪ঘ window প্রায় শেষ", "${cs.nearWindowCount}", dark,
                            tint = if (cs.nearWindowCount > 0) BfPalette.red500 else AlmaTheme.ink(dark),
                        )
                        BfMiniRow(
                            "খোলা alert", "${cs.openAlerts}", dark,
                            tint = if (cs.openAlerts > 0) BfPalette.goldLt else AlmaTheme.ink(dark),
                        )
                    }
                }
            }

            // Staff yesterday.
            data.staffYesterday?.let { staff ->
                item { BfSection(Icons.Filled.People, "স্টাফ (গতকাল)", dark) }
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        BfMiniRow("কাজ শেষ", "${staff.done}/${staff.total}", dark, tint = AlmaTheme.ink(dark))
                        if (staff.lowPerformers.isEmpty()) {
                            Text("সবাই ভালো করছে ✓", color = BfPalette.emerald600, fontSize = 12.sp)
                        } else {
                            staff.lowPerformers.take(4).forEach { p ->
                                Row {
                                    Text(p.name, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                                    Spacer(Modifier.weight(1f))
                                    Text(
                                        "${p.pct}% · ${p.daysLow} দিন কম",
                                        color = BfPalette.red500, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Returns & pricing flags.
            if (data.flagLines.isNotEmpty()) {
                item { BfSection(Icons.Filled.Replay, "রিটার্ন ও প্রাইসিং", dark) }
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        data.flagLines.forEach { BfFlagLine(it, dark) }
                    }
                }
            }

            // Ads digest.
            data.adsDigest?.takeIf { it.campaigns.isNotEmpty() }?.let { ads ->
                item { BfSection(Icons.Filled.Campaign, "আজকের অ্যাড", dark) }
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        ads.campaigns.take(4).forEach { c ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    c.name, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    "${BfFormat.tk(c.spend)} · CTR ${BfFormat.pct(c.ctr)}%",
                                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                                )
                            }
                        }
                        ads.anomalies.take(2).forEach { a ->
                            BfFlagLine("${a.campaign}: CTR গড়ের ${BfFormat.pct(a.dropPct)}% নিচে", dark)
                        }
                    }
                }
            }

            // Todos.
            if (data.openTodos.isNotEmpty()) {
                item { BfSection(Icons.Filled.Checklist, "আপনার টু-ডু", dark, count = data.openTodos.size) }
                item {
                    val todos = data.openTodos.take(8)
                    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
                        todos.forEachIndexed { i, t ->
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(
                                    Modifier.size(6.dp).background(
                                        if (t.priority == "high") BfPalette.red500 else BfPalette.coral,
                                        CircleShape,
                                    ),
                                )
                                Text(
                                    t.title, color = AlmaTheme.ink(dark), fontSize = 12.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                if (t.ageDays >= 3) {
                                    Text(
                                        "${t.ageDays} দিন",
                                        color = BfPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                                    )
                                }
                            }
                            if (i < todos.size - 1) {
                                HorizontalDivider(
                                    Modifier.padding(start = 30.dp),
                                    thickness = 0.7.dp,
                                    color = AlmaTheme.separator(dark).copy(alpha = 0.07f),
                                )
                            }
                        }
                    }
                }
            }

            // Agent footer.
            item {
                Text(
                    "ব্রিফিং তৈরি করেছে ALMA Agent" +
                        (data.generatedAt?.let { " · ${BfFormat.timeAgo(it)}" } ?: ""),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

// ── Hero greeting (web gold Card + Dhaka greeting) + refresh chip ───────────────────

@Composable
private fun BfHeroCard(data: BfData, dark: Boolean, refreshing: Boolean, onRefresh: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Box(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).clip(shape)) {
        // The web hero's gold glow blob, clipped to the card (radial falloff, no blur).
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset(x = 36.dp, y = (-44).dp)
                .size(176.dp)
                .background(
                    Brush.radialGradient(listOf(BfPalette.coral.copy(alpha = 0.12f), Color.Transparent)),
                    CircleShape,
                ),
        )
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "${BfFormat.greeting()}, BOSS",
                color = BfPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                letterSpacing = 1.6.sp,
            )
            Text("আজকের ব্যবসা ব্রিফিং", color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Black)
            Text(BfFormat.dhakaDateLine(), color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            Row(
                Modifier.padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(bfHeroMetaLine(data), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                Spacer(Modifier.weight(1f))
                // The web header's gold "↻ রিফ্রেশ" button as a native capsule chip.
                Row(
                    Modifier
                        .background(BfPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f), CircleShape)
                        .border(1.dp, BfPalette.coral.copy(alpha = 0.55f), CircleShape)
                        .plainClick { if (!refreshing) onRefresh() }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    if (refreshing) {
                        CircularProgressIndicator(
                            Modifier.size(11.dp), color = BfPalette.accentText(dark), strokeWidth = 1.5.dp,
                        )
                    } else {
                        Text("↻", color = BfPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Text(
                        if (refreshing) "রিফ্রেশ হচ্ছে…" else "রিফ্রেশ",
                        color = BfPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

private fun bfHeroMetaLine(data: BfData): String {
    val bits = mutableListOf<String>()
    data.generatedAt?.let { bits.add("আপডেট: ${BfFormat.timeAgo(it)}") }
    bits.add(if (data.decisions.isEmpty()) "সব ঠিক আছে ✓" else "${data.decisions.size}টি করণীয়")
    return bits.joinToString(" · ")
}

// ── KPI grid (web: grid-cols-2 KpiCards, exact labels/colours) ──────────────────────

@Composable
private fun BfKpiGrid(data: BfData, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BfKpiCard(
                "গতকালের বিক্রি", BfFormat.tk(data.sales?.yesterdayTotal ?: 0.0),
                tint = BfPalette.goldLt,
                sub = data.sales?.let { "${it.yesterdayOrders} অর্ডার" } ?: "ডেটা নেই",
                dark = dark, modifier = Modifier.weight(1f),
            )
            BfKpiCard(
                "৭-দিন গড়/দিন", BfFormat.tk(data.sales?.sevenDayAvg ?: 0.0),
                tint = AlmaTheme.ink(dark),
                sub = data.sales?.let { "${BfFormat.pct(it.sevenDayOrderAvg)} অর্ডার/দিন" } ?: "—",
                dark = dark, modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BfKpiCard(
                "পেন্ডিং অর্ডার", "${data.pendingOrders?.count ?: 0}",
                tint = if ((data.pendingOrders?.count ?: 0) >= 10) BfPalette.red500 else AlmaTheme.ink(dark),
                sub = if (data.pendingOrders?.mismatch == true) "⚠️ sync mismatch" else "অপেক্ষমাণ",
                dark = dark, modifier = Modifier.weight(1f),
            )
            BfKpiCard(
                "অনুমোদন বাকি", "${data.pendingApprovalsCount ?: 0}",
                tint = if ((data.pendingApprovalsCount ?: 0) > 0) BfPalette.goldLt else AlmaTheme.ink(dark),
                sub = "approvals",
                dark = dark, modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun BfKpiCard(label: String, value: String, tint: Color, sub: String, dark: Boolean, modifier: Modifier = Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(
            value, color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Section header (gradient icon badge + count capsule + optional link) ────────────

@Composable
private fun BfSection(
    icon: ImageVector,
    title: String,
    dark: Boolean,
    count: Int? = null,
    linkTitle: String? = null,
    onLink: (() -> Unit)? = null,
) {
    Row(
        Modifier.padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(26.dp)
                .background(
                    Brush.linearGradient(listOf(BfPalette.coral, AlmaTheme.violet)),
                    RoundedCornerShape(8.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
        }
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Black)
        if (count != null && count > 0) {
            Text(
                "$count",
                color = BfPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(BfPalette.coral.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        if (linkTitle != null && onLink != null) {
            Text(
                linkTitle,
                color = BfPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onLink),
            )
        }
    }
}

// ── Decision card (web DecisionCard — area badge · জরুরি chip · text ·
// recommend → · 💡 knowledgeNote; long text clamps with "আরো দেখুন" expand) ──────────

@Composable
private fun BfDecisionCard(d: BfDecision, dark: Boolean) {
    var expanded by remember { mutableStateOf(false) }
    val high = d.urgency == "high"
    // Digest decisions can run long Bangla paragraphs — clamp unless expanded.
    val isLong = (d.text.length + d.recommend.length + (d.knowledgeNote?.length ?: 0)) > 320
    val (icon, areaLabel) = bfArea(d.area)
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)

    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, if (high) BfPalette.red500.copy(alpha = 0.35f) else Color.Transparent, shape)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(34.dp)
                .background(
                    (if (high) BfPalette.red500 else BfPalette.coral).copy(alpha = 0.13f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon, contentDescription = null,
                tint = if (high) BfPalette.red500 else BfPalette.accentText(dark),
                modifier = Modifier.size(16.dp),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    areaLabel.uppercase(),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                    letterSpacing = 1.sp,
                )
                if (high) {
                    Text(
                        "জরুরি",
                        color = BfPalette.red500, fontSize = 9.sp, fontWeight = FontWeight.Black,
                        modifier = Modifier
                            .background(BfPalette.red500.copy(alpha = 0.13f), CircleShape)
                            .padding(horizontal = 6.dp, vertical = 1.5.dp),
                    )
                }
            }
            Text(
                d.text,
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                lineHeight = 19.sp,
                maxLines = if (expanded || !isLong) Int.MAX_VALUE else 6,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("→", color = BfPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                Text(
                    d.recommend,
                    color = BfPalette.accentText(dark), fontSize = 12.sp, lineHeight = 17.sp,
                    maxLines = if (expanded || !isLong) Int.MAX_VALUE else 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            d.knowledgeNote?.takeIf { it.isNotEmpty() && (expanded || !isLong) }?.let { note ->
                Text(
                    "💡 $note",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, lineHeight = 15.sp,
                    fontStyle = FontStyle.Italic,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                        .border(
                            1.dp, AlmaTheme.ink(dark).copy(alpha = 0.08f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .padding(horizontal = 9.dp, vertical = 6.dp),
                )
            }
            if (isLong) {
                Text(
                    if (expanded) "কম দেখান ▲" else "আরো দেখুন ▼",
                    color = BfPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick { expanded = !expanded },
                )
            }
        }
    }
}

/** Web AREA table — same Bangla labels, material icons instead of emoji. */
private fun bfArea(area: String): Pair<ImageVector, String> = when (area) {
    "stock" -> Icons.Filled.Inventory2 to "স্টক"
    "sales" -> Icons.Filled.Payments to "বিক্রি"
    "orders" -> Icons.Filled.ShoppingCart to "অর্ডার"
    "customers" -> Icons.Filled.Groups to "কাস্টমার"
    "ads" -> Icons.Filled.Campaign to "অ্যাড"
    "staff" -> Icons.Filled.People to "স্টাফ"
    "returns" -> Icons.Filled.Replay to "রিটার্ন"
    "pricing" -> Icons.Filled.Sell to "প্রাইসিং"
    "marketing" -> Icons.Filled.AutoAwesome to "মার্কেটিং"
    else -> Icons.Filled.Circle to area
}

// ── Reorder card (web reorder Card — জরুরি/শীঘ্রই chip + reason + qty) ──────────────

@Composable
private fun BfReorderCard(r: BfReorder, dark: Boolean) {
    val high = r.urgency == "high"
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, if (high) BfPalette.red500.copy(alpha = 0.35f) else Color.Transparent, shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                r.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                if (high) "জরুরি" else "শীঘ্রই",
                color = if (high) BfPalette.red500 else BfPalette.goldLt,
                fontSize = 10.sp, fontWeight = FontWeight.Black,
                modifier = Modifier
                    .background(
                        (if (high) BfPalette.red500 else BfPalette.coral).copy(alpha = 0.13f),
                        CircleShape,
                    )
                    .padding(horizontal = 8.dp, vertical = 2.5.dp),
            )
        }
        if (r.reason.isNotEmpty()) {
            Text(r.reason, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, lineHeight = 17.sp)
        }
        Text(
            "~${r.suggestedQty}টি রিঅর্ডার করুন",
            color = BfPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

// ── Small shared rows / states ──────────────────────────────────────────────────────

@Composable
private fun BfMiniRow(label: String, value: String, dark: Boolean, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value, color = tint, fontSize = 14.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun BfFlagLine(text: String, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("▸", color = BfPalette.accentText(dark), fontSize = 12.sp)
        Text(text, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, lineHeight = 17.sp)
    }
}

@Composable
private fun BfAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(BfPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun BfErrorCard(message: String, dark: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("⚠️ $message", color = BfPalette.red500, fontSize = 13.sp)
        Text(
            "আবার চেষ্টা করুন",
            color = BfPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(BfPalette.coral.copy(alpha = 0.14f), CircleShape)
                .border(1.dp, BfPalette.coral.copy(alpha = 0.55f), CircleShape)
                .plainClick(onRetry)
                .padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ────────────────────────────────────────────

private object BfFormat {
    /** Web tk(): `৳` + whole-taka with thousands separators. */
    fun tk(n: Double?): String = "৳" + String.format("%,d", ((n ?: 0.0)).roundToInt())

    /** Compact numeric text for CTR / averages — trims trailing zeros ("2.5", "3"). */
    fun pct(n: Double): String =
        if (n == kotlin.math.round(n)) "${n.toInt()}" else String.format("%.1f", n)

    /** Web greeting(): Dhaka-hour greeting for the owner — exact strings. */
    fun greeting(): String {
        val h = Calendar.getInstance(TimeZone.getTimeZone("Asia/Dhaka")).get(Calendar.HOUR_OF_DAY)
        return when {
            h < 12 -> "শুভ সকাল"
            h < 17 -> "শুভ অপরাহ্ন"
            h < 20 -> "শুভ সন্ধ্যা"
            else -> "শুভ রাত্রি"
        }
    }

    /** Native date header — today in Bangla, Dhaka time ("সোমবার, ৬ জুলাই ২০২৬"). */
    fun dhakaDateLine(): String {
        val f = SimpleDateFormat("EEEE, d MMMM yyyy", Locale("bn", "BD"))
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date())
    }

    /** Web relTime() — exact Bangla strings. */
    fun timeAgo(iso: String?): String {
        val date = parse(iso) ?: return ""
        val mins = ((System.currentTimeMillis() - date.time) / 60_000).toInt()
        return when {
            mins < 1 -> "এইমাত্র"
            mins < 60 -> "$mins মিনিট আগে"
            mins < 24 * 60 -> "${mins / 60} ঘণ্টা আগে"
            else -> "${mins / (24 * 60)} দিন আগে"
        }
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
