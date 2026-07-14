//
//  InsightsScreen.kt
//  ALMA ERP — the Business Insights page, ported 1:1 from InsightsSwiftUI.swift.
//
//  Mirrors the web /insights page — same endpoint, same blocks:
//    GET /api/insights            → cached analyzer bundle (apiDataSuccess → {ok, data})
//    GET /api/insights?refresh=1  → recompute fresh
//  Web-parity blocks: ফিনান্সিয়াল হেলথ (bento hero: revenue count-up + WoW · খরচ ·
//  নেট প্রফিট · মার্জিন + flags + টপ প্রোডাক্ট) · রিঅর্ডার দরকার · স্লো-মুভিং স্টক ·
//  কাস্টমার ইন্টেলিজেন্স (৩ KPI + ফিরিয়ে আনুন + টপ VIP + notes). Read-only screen —
//  every action escapes to the web page. iOS signature carried over: severity-tinted
//  icon badges (info=violet · warn=amber · critical=red · good=emerald), 5-line clamp
//  with expand on long text, customer detail sheet.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Report
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
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
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.roundToLong

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object InsPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

/** Severity tint + icon per insight card class (iOS InsightSeverity twin). */
private enum class InsSeverity { INFO, WARN, CRITICAL, GOOD }

private val InsSeverity.tint: Color
    get() = when (this) {
        InsSeverity.INFO -> AlmaTheme.violet
        InsSeverity.WARN -> InsPalette.amber600
        InsSeverity.CRITICAL -> InsPalette.red500
        InsSeverity.GOOD -> InsPalette.emerald600
    }

private val InsSeverity.icon: ImageVector
    get() = when (this) {
        InsSeverity.INFO -> Icons.Outlined.Info
        InsSeverity.WARN -> Icons.Outlined.WarningAmber
        InsSeverity.CRITICAL -> Icons.Outlined.Report
        InsSeverity.GOOD -> Icons.Outlined.Verified
    }

// ── Models (same field names the web page types declare) ───────────────────────────

private data class InsReorderItem(
    val id: String,
    val name: String,
    val currentStock: Int,
    val daysOfStock: Double,
    val suggestedQty: Int,
    val urgency: String,           // "high" | "normal"
    val reason: String,
) {
    companion object {
        fun from(o: JSONObject) = InsReorderItem(
            id = o.str("id") ?: "item-${o.hashCode()}",
            name = o.str("name") ?: "—",
            currentStock = o.flexInt("currentStock") ?: 0,
            daysOfStock = o.flexDouble("daysOfStock") ?: 0.0,
            suggestedQty = o.flexInt("suggestedQty") ?: 0,
            urgency = o.str("urgency") ?: "normal",
            reason = o.str("reason") ?: "",
        )
    }
}

private data class InsSlowMover(
    val id: String,
    val name: String,
    val currentStock: Int,
    val sales90d: Int,
) {
    companion object {
        fun from(o: JSONObject) = InsSlowMover(
            id = o.str("id") ?: "slow-${o.hashCode()}",
            name = o.str("name") ?: "—",
            currentStock = o.flexInt("currentStock") ?: 0,
            sales90d = o.flexInt("sales90d") ?: 0,
        )
    }
}

private data class InsTopProduct(
    val product: String,
    val revenue: Double,
    val units: Int,
    val marginPct: Double?,
) {
    companion object {
        fun from(o: JSONObject) = InsTopProduct(
            product = o.str("product") ?: "—",
            revenue = o.flexDouble("revenue") ?: 0.0,
            units = o.flexInt("units") ?: 0,
            marginPct = o.flexDouble("marginPct"),
        )
    }
}

private data class InsCustomer(
    val id: String,
    val name: String?,
    val phone: String?,
    val ordersCount: Int,
    val churnRisk: String,         // "low" | "medium" | "high"
    val tier: String,              // "vip" | "regular" | "occasional" | "new"
    val daysSinceLast: Int?,
    val estimatedClv: Double?,
    val engagementSuggestion: String,
    val clvNote: String?,
) {
    val displayName get() = name ?: phone ?: "কাস্টমার"

    companion object {
        fun from(o: JSONObject) = InsCustomer(
            id = o.str("id") ?: "cust-${o.hashCode()}",
            name = o.str("name"),
            phone = o.str("phone"),
            ordersCount = o.flexInt("ordersCount") ?: 0,
            churnRisk = o.str("churnRisk") ?: "low",
            tier = o.str("tier") ?: "regular",
            daysSinceLast = o.flexInt("daysSinceLast"),
            estimatedClv = o.flexDouble("estimatedClv"),
            engagementSuggestion = o.str("engagementSuggestion") ?: "",
            clvNote = o.str("clvNote"),
        )
    }
}

private data class InsFinance(
    val period: String?,
    val revenue: Double,
    val expensesTotal: Double,
    val netProfit: Double?,
    val marginPct: Double?,
    val revenueWoW: Double?,
    val expenseWoW: Double?,
    val flags: List<String>,
    val costDataMissing: Boolean,
    val topProducts: List<InsTopProduct>,
) {
    companion object {
        fun from(o: JSONObject): InsFinance {
            val flags = o.optJSONArray("flags")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            } ?: emptyList()
            return InsFinance(
                period = o.str("period"),
                revenue = o.flexDouble("revenue") ?: 0.0,
                expensesTotal = o.flexDouble("expensesTotal") ?: 0.0,
                netProfit = o.flexDouble("netProfit"),
                marginPct = o.flexDouble("marginPct"),
                revenueWoW = o.flexDouble("revenueWoW"),
                expenseWoW = o.flexDouble("expenseWoW"),
                flags = flags,
                costDataMissing = o.flexBool("costDataMissing") ?: false,
                topProducts = o.optJSONArray("topProducts")?.mapObjects { InsTopProduct.from(it) } ?: emptyList(),
            )
        }
    }
}

private data class InsCustomerDigest(
    val vipCount: Int,
    val highChurnCount: Int,
    val newThisWeekCount: Int,
    val highChurn: List<InsCustomer>,
    val topVips: List<InsCustomer>,
    val notes: List<String>,
) {
    companion object {
        fun from(o: JSONObject): InsCustomerDigest {
            val notes = o.optJSONArray("notes")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
            } ?: emptyList()
            return InsCustomerDigest(
                vipCount = o.flexInt("vipCount") ?: 0,
                highChurnCount = o.flexInt("highChurnCount") ?: 0,
                newThisWeekCount = o.flexInt("newThisWeekCount") ?: 0,
                highChurn = o.optJSONArray("highChurn")?.mapObjects { InsCustomer.from(it) } ?: emptyList(),
                topVips = o.optJSONArray("topVips")?.mapObjects { InsCustomer.from(it) } ?: emptyList(),
                notes = notes,
            )
        }
    }
}

private data class InsBundle(
    val reorder: List<InsReorderItem>,
    val slowMovers: List<InsSlowMover>,
    val finance: InsFinance?,
    val customers: InsCustomerDigest?,
) {
    companion object {
        fun from(root: JSONObject): InsBundle {
            // apiDataSuccess wrapper {ok, data:{…}} — unwrap both shapes.
            val c = root.optJSONObject("data") ?: root
            return InsBundle(
                reorder = c.optJSONArray("reorder")?.mapObjects { InsReorderItem.from(it) } ?: emptyList(),
                slowMovers = c.optJSONArray("slowMovers")?.mapObjects { InsSlowMover.from(it) } ?: emptyList(),
                finance = c.optJSONObject("finance")?.let { InsFinance.from(it) },
                customers = c.optJSONObject("customers")?.let { InsCustomerDigest.from(it) },
            )
        }
    }
}

// ── State holder (iOS InsightsVM twin) ─────────────────────────────────────────────

private class InsightsState {
    var bundle by mutableStateOf<InsBundle?>(null)
    var loading by mutableStateOf(false)
    var refreshing by mutableStateOf(false)    // web's "↻ রিফ্রেশ" (fresh recompute) state
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load(fresh: Boolean = false) {
        if (fresh) refreshing = true else loading = true
        error = null
        try {
            val root = AlmaApi.getObject(
                "/api/insights",
                if (fresh) mapOf("refresh" to "1") else emptyMap(),
            )
            bundle = InsBundle.from(root)
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "ইনসাইট লোড করা গেল না"
        } finally {
            loading = false
            refreshing = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsightsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { InsightsState() }
    val scope = rememberCoroutineScope()
    var selectedCustomer by remember { mutableStateOf<InsCustomer?>(null) }

    LaunchedEffect(Unit) { if (vm.bundle == null) vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // ── Header (web PageHeader subtitle + ↻ রিফ্রেশ) ──
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "রিঅর্ডার · ফিনান্সিয়াল হেলথ · কাস্টমার — গভীর বিশ্লেষণ",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    Modifier
                        .size(34.dp)
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { if (!vm.refreshing && !vm.loading) scope.launch { vm.load(fresh = true) } },
                    contentAlignment = Alignment.Center,
                ) {
                    if (vm.refreshing) {
                        CircularProgressIndicator(Modifier.size(15.dp), color = InsPalette.coral, strokeWidth = 2.dp)
                    } else {
                        Icon(
                            Icons.Outlined.Refresh, contentDescription = "রিফ্রেশ",
                            tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(17.dp),
                        )
                    }
                }
            }
        }

        if (vm.authExpired) {
            item { InsAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { err ->
            item {
                Column(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("⚠ $err", color = InsPalette.red500, fontSize = 13.sp)
                    Text(
                        "আবার চেষ্টা",
                        color = InsPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .background(InsPalette.coral.copy(alpha = 0.13f), CircleShape)
                            .border(1.dp, InsPalette.coral.copy(alpha = 0.35f), CircleShape)
                            .plainClick { scope.launch { vm.load(fresh = true) } }
                            .padding(horizontal = 16.dp, vertical = 7.dp),
                    )
                }
            }
        }
        if (vm.loading && vm.bundle == null) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        vm.bundle?.let { bundle ->
            // ── ফিনান্সিয়াল হেলথ ──
            item { InsSectionTitle("💰", "ফিনান্সিয়াল হেলথ", sub = bundle.finance?.period, dark = dark) }
            val f = bundle.finance
            if (f != null) {
                item { InsBentoHero(f, dark) }
                f.flags.forEach { flag ->
                    item { InsFlagCard(flag, InsSeverity.WARN, dark) }
                }
                if (f.topProducts.isNotEmpty()) {
                    item { InsTopProductsCard(f.topProducts, dark) }
                }
            } else {
                item {
                    InsEmptyCard(
                        "ফিনান্সিয়াল ডেটা নেই",
                        "এই মুহূর্তে হিসাব আনা গেল না — রিফ্রেশ করে দেখুন।",
                        InsSeverity.INFO, dark,
                    )
                }
            }

            // ── রিঅর্ডার দরকার ──
            item { InsSectionTitle("📦", "রিঅর্ডার দরকার", count = bundle.reorder.size, dark = dark) }
            if (bundle.reorder.isEmpty()) {
                item { InsEmptyCard("স্টক ঠিক আছে ✓", "জরুরি রিঅর্ডার নেই, Boss।", InsSeverity.GOOD, dark) }
            } else {
                items(bundle.reorder.take(8), key = { "reorder-${it.id}" }) { item ->
                    InsReorderCard(item, dark)
                }
            }

            // ── স্লো-মুভিং স্টক ──
            item { InsSectionTitle("🐢", "স্লো-মুভিং স্টক", count = bundle.slowMovers.size, dark = dark) }
            if (bundle.slowMovers.isEmpty()) {
                item { InsEmptyCard("সব নড়ছে ✓", "পুঁজি আটকে নেই — সব স্টক বিক্রি হচ্ছে।", InsSeverity.GOOD, dark) }
            } else {
                item { InsSlowMoversCard(bundle.slowMovers, dark) }
            }

            // ── কাস্টমার ইন্টেলিজেন্স ──
            item { InsSectionTitle("👥", "কাস্টমার ইন্টেলিজেন্স", dark = dark) }
            val cs = bundle.customers
            if (cs != null) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        InsStatTile(
                            "VIP কাস্টমার", cs.vipCount, "top tier",
                            tint = InsPalette.accentText(dark), accent = InsPalette.coral,
                            dark = dark, modifier = Modifier.weight(1f),
                        )
                        InsStatTile(
                            "চার্ন ঝুঁকি", cs.highChurnCount, "হারানোর ঝুঁকি",
                            tint = if (cs.highChurnCount > 0) InsPalette.red500 else AlmaTheme.ink(dark),
                            accent = InsPalette.red500,
                            dark = dark, modifier = Modifier.weight(1f),
                        )
                        InsStatTile(
                            "নতুন (সপ্তাহ)", cs.newThisWeekCount, "new",
                            tint = InsPalette.emerald600, accent = InsPalette.green400,
                            dark = dark, modifier = Modifier.weight(1f),
                        )
                    }
                }
                if (cs.highChurn.isNotEmpty()) {
                    item {
                        InsCustomerListCard("⚠ ফিরিয়ে আনুন", InsPalette.red500, cs.highChurn, vip = false, dark = dark) {
                            selectedCustomer = it
                        }
                    }
                }
                if (cs.topVips.isNotEmpty()) {
                    item {
                        InsCustomerListCard("⭐ টপ VIP", InsPalette.accentText(dark), cs.topVips, vip = true, dark = dark) {
                            selectedCustomer = it
                        }
                    }
                }
                cs.notes.forEach { note ->
                    item { InsFlagCard(note, InsSeverity.INFO, dark) }
                }
            } else {
                item {
                    InsEmptyCard(
                        "কাস্টমার ডেটা নেই",
                        "বিশ্লেষণ আনা গেল না — রিফ্রেশ করে দেখুন।",
                        InsSeverity.INFO, dark,
                    )
                }
            }

            item {
                Text(
                    "ALMA Agent বিশ্লেষণ · ৩০ দিনের ডেটা",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    // ── Customer detail sheet (read-only; follow-up actions escape to the web) ──
    selectedCustomer?.let { customer ->
        ModalBottomSheet(onDismissRequest = { selectedCustomer = null }, containerColor = AlmaTheme.rootBg(dark)) {
            InsCustomerSheet(customer, dark) { p, t ->
                selectedCustomer = null
                ctx.openWebForced(p, t)
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun InsSectionTitle(
    emoji: String,
    title: String,
    count: Int? = null,
    sub: String? = null,
    dark: Boolean,
) {
    Row(
        Modifier.padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(emoji, fontSize = 12.sp)
        Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Black)
        if (count != null && count > 0) {
            Text(
                "$count",
                color = InsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(InsPalette.coral.copy(alpha = 0.15f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 1.5.dp),
            )
        }
        sub?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp) }
    }
}

@Composable
private fun InsAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(InsPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

/** Severity badge (squircle, tinted per class — the screen's signature). */
@Composable
private fun InsSeverityBadge(severity: InsSeverity) {
    val shape = RoundedCornerShape(9.dp)
    Box(
        Modifier
            .size(30.dp)
            .background(severity.tint.copy(alpha = 0.13f), shape)
            .border(1.dp, severity.tint.copy(alpha = 0.30f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(severity.icon, contentDescription = null, tint = severity.tint, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun InsEmptyCard(title: String, desc: String, severity: InsSeverity, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        InsSeverityBadge(severity)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(desc, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}

/** Flag / note card (web FlagLine "▸ …" with a severity badge + expandable text). */
@Composable
private fun InsFlagCard(text: String, severity: InsSeverity, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        InsSeverityBadge(severity)
        Box(Modifier.weight(1f)) { InsExpandableText(text, dark) }
    }
}

/** Small, calm body text — clamped to 5 lines; tapping "আরো দেখুন" expands
 *  (same recipe as the Approvals agent card). */
@Composable
private fun InsExpandableText(text: String, dark: Boolean, threshold: Int = 200) {
    var expanded by remember { mutableStateOf(false) }
    val isLong = text.length > threshold
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text,
            color = AlmaTheme.ink(dark).copy(alpha = 0.85f),
            fontSize = 12.sp, lineHeight = 17.sp,
            maxLines = if (expanded || !isLong) Int.MAX_VALUE else 5,
            overflow = TextOverflow.Ellipsis,
        )
        if (isLong) {
            Text(
                if (expanded) "কম দেখান ▲" else "আরো দেখুন ▼",
                color = InsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick { expanded = !expanded },
            )
        }
    }
}

// ── Bento hero (dark anchor in BOTH schemes — Dashboard hero recipe) ───────────────

/** Count-up number: 0 → target on first frame (iOS InsCountUp twin, tween not spring). */
@Composable
private fun insCountUp(target: Int): Int {
    var started by remember { mutableStateOf(false) }
    val v by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "insCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    return v
}

/** Web KpiCard TrendSub: "↑ x% WoW" green when moving the good way, red otherwise —
 *  mapped for the dark hero (emerald→bright green, secondary→soft white). */
private fun insTrend(pct: Double?, goodUp: Boolean): Pair<String, Color> {
    if (pct == null) return "WoW —" to Color.White.copy(alpha = 0.5f)
    val up = pct >= 0
    val good = up == goodUp
    return "${if (up) "↑" else "↓"} ${InsFormat.num(abs(pct))}% WoW" to
        (if (good) InsPalette.green400 else InsPalette.red500)
}

/** The dark hero anchor — 30-day revenue count-up with its WoW trend, plus the
 *  খরচ / নেট প্রফিট / মার্জিন split (the old 4-card strip's exact numbers). */
@Composable
private fun InsBentoHero(f: InsFinance, dark: Boolean) {
    val heroShape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    val revenueTrend = insTrend(f.revenueWoW, goodUp = true)
    val expensesTrend = insTrend(f.expenseWoW, goodUp = false)
    val netProfit = (f.netProfit ?: 0.0).roundToInt()

    Column(
        Modifier
            .fillMaxWidth()
            .clip(heroShape)
            .background(Color(0xFF181528))   // deep indigo (Dashboard hero recipe)
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, AlmaTheme.coral.copy(alpha = 0.30f))))
            .border(1.dp, Color.White.copy(alpha = 0.16f), heroShape)
            .padding(16.dp),
    ) {
        Text(
            "রেভিনিউ (৩০দিন) · REVENUE",
            color = InsPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Text(
            InsFormat.taka(insCountUp(f.revenue.roundToInt()).toDouble()),
            color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            revenueTrend.first,
            color = revenueTrend.second, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            InsHeroStat(
                "খরচ (৩০দিন)", InsFormat.taka(insCountUp(f.expensesTotal.roundToInt()).toDouble()),
                tint = Color.White,
                sub = expensesTrend.first, subColor = expensesTrend.second,
            )
            InsHeroDivider()
            InsHeroStat(
                "নেট প্রফিট", InsFormat.taka(insCountUp(netProfit).toDouble()),
                tint = if (netProfit >= 0) InsPalette.green400 else InsPalette.red500,
                sub = if (f.costDataMissing) "cost ডেটা অসম্পূর্ণ" else "আনুমানিক",
                subColor = Color.White.copy(alpha = 0.5f),
            )
            InsHeroDivider()
            InsHeroStat(
                "মার্জিন", f.marginPct?.let { "${InsFormat.num(it)}%" } ?: "—",
                tint = if ((f.marginPct ?: 0.0) < 0) InsPalette.red500 else Color.White,
                sub = "net margin", subColor = Color.White.copy(alpha = 0.5f),
            )
        }
    }
}

@Composable
private fun InsHeroDivider() {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(44.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun InsHeroStat(label: String, value: String, tint: Color, sub: String, subColor: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label,
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        Text(
            value,
            color = tint, fontSize = 15.sp, fontWeight = FontWeight.Black,
            maxLines = 1,
        )
        Text(sub, color = subColor, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Small glass stat tile — count-up value + sub line over a soft accent wash. */
@Composable
private fun InsStatTile(
    label: String,
    value: Int,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            "${insCountUp(value)}",
            color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1,
        )
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Top products / slow movers tables (web card parity) ────────────────────────────

/** Web "টপ প্রোডাক্ট (প্রফিট)" table — name · units · revenue · margin%. */
@Composable
private fun InsTopProductsCard(products: List<InsTopProduct>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        Text(
            "টপ প্রোডাক্ট (প্রফিট)",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
        products.forEachIndexed { index, p ->
            if (index > 0) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp)
                        .height(1.dp)
                        .background(AlmaTheme.separator(dark).copy(alpha = 0.25f)),
                )
            }
            Row(
                Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    p.product,
                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text("${p.units} pcs", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                Text(
                    InsFormat.taka(p.revenue),
                    color = InsPalette.accentText(dark), fontSize = 12.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
                p.marginPct?.let { margin ->
                    Text(
                        "${InsFormat.num(margin)}%",
                        color = if (margin >= 0) InsPalette.emerald600 else InsPalette.red500,
                        fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun InsSlowMoversCard(movers: List<InsSlowMover>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        Text(
            "৩০ দিনে বিক্রি নেই — পুঁজি আটকে আছে",
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
        movers.forEachIndexed { index, mover ->
            if (index > 0) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp)
                        .height(1.dp)
                        .background(AlmaTheme.separator(dark).copy(alpha = 0.25f)),
                )
            }
            Row(
                Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    mover.name,
                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text("৯০দিনে ${mover.sales90d}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                Text(
                    "${mover.currentStock} pcs",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

// ── Reorder card (web reorder Card parity: urgency chip · reason · stock line) ─────

@Composable
private fun InsReorderCard(item: InsReorderItem, dark: Boolean) {
    val isHigh = item.urgency == "high"
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .then(if (isHigh) Modifier.border(1.dp, InsPalette.red500.copy(alpha = 0.35f), shape) else Modifier)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        InsSeverityBadge(if (isHigh) InsSeverity.CRITICAL else InsSeverity.WARN)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    item.name,
                    color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    if (isHigh) "জরুরি" else "শীঘ্রই",
                    color = if (isHigh) InsPalette.red500 else InsPalette.accentText(dark),
                    fontSize = 10.sp, fontWeight = FontWeight.Black,
                    modifier = Modifier
                        .background(
                            (if (isHigh) InsPalette.red500 else InsPalette.coral).copy(alpha = 0.14f),
                            CircleShape,
                        )
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            if (item.reason.isNotEmpty()) {
                InsExpandableText(item.reason, dark)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "স্টক ${item.currentStock} · ~${item.daysOfStock.roundToInt()} দিন বাকি",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "~${item.suggestedQty}টি অর্ডার",
                    color = InsPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Customer list + detail sheet ───────────────────────────────────────────────────

@Composable
private fun InsCustomerListCard(
    title: String,
    tint: Color,
    customers: List<InsCustomer>,
    vip: Boolean,
    dark: Boolean,
    onTap: (InsCustomer) -> Unit,
) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD)) {
        Text(
            title.uppercase(),
            color = tint, fontSize = 10.sp, fontWeight = FontWeight.Black,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
        customers.forEachIndexed { index, customer ->
            if (index > 0) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp)
                        .height(1.dp)
                        .background(AlmaTheme.separator(dark).copy(alpha = 0.25f)),
                )
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .plainClick { onTap(customer) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        customer.displayName,
                        color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text("${customer.ordersCount} অর্ডার", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    val clv = customer.estimatedClv
                    if (vip && clv != null && clv > 0) {
                        Text(
                            InsFormat.taka(clv),
                            color = InsPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        )
                    } else if (customer.daysSinceLast != null) {
                        Text(
                            "${customer.daysSinceLast}দিন আগে",
                            color = InsPalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                }
                if (customer.engagementSuggestion.isNotEmpty()) {
                    Text(
                        customer.engagementSuggestion,
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

/** Detail sheet — the full engagement suggestion + CLV note, read-only. Any follow-up
 *  action (call/message the customer) escapes to the web page. */
@Composable
private fun InsCustomerSheet(
    customer: InsCustomer,
    dark: Boolean,
    openWeb: (path: String, title: String) -> Unit,
) {
    val churnColor = when (customer.churnRisk) {
        "high" -> InsPalette.red500
        "medium" -> InsPalette.amber600
        else -> InsPalette.emerald600
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header
        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier
                    .size(42.dp)
                    .background(InsPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, InsPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    InsFormat.initials(customer.displayName),
                    color = InsPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(customer.displayName, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        customer.tier.uppercase(),
                        color = InsPalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(InsPalette.coral.copy(alpha = 0.14f), CircleShape)
                            .padding(horizontal = 6.dp, vertical = 1.5.dp),
                    )
                    Text(
                        "চার্ন: ${customer.churnRisk.uppercase()}",
                        color = churnColor, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(churnColor.copy(alpha = 0.12f), CircleShape)
                            .padding(horizontal = 6.dp, vertical = 1.5.dp),
                    )
                }
            }
        }

        // Info rows
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            customer.phone?.let { InsInfoRow("ফোন", it, AlmaTheme.ink(dark), dark) }
            InsInfoRow("অর্ডার", "${customer.ordersCount} অর্ডার", AlmaTheme.ink(dark), dark)
            customer.daysSinceLast?.let {
                InsInfoRow(
                    "শেষ অর্ডার", "${it}দিন আগে",
                    if (customer.churnRisk == "high") InsPalette.red500 else AlmaTheme.ink(dark), dark,
                )
            }
            customer.estimatedClv?.takeIf { it > 0 }?.let {
                InsInfoRow("আনুমানিক CLV", InsFormat.taka(it), InsPalette.accentText(dark), dark)
            }
            customer.clvNote?.takeIf { it.isNotEmpty() }?.let {
                InsInfoRow("CLV নোট", it, AlmaTheme.ink(dark), dark)
            }
        }

        // Engagement suggestion
        if (customer.engagementSuggestion.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    "এনগেজমেন্ট পরামর্শ",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                Text(
                    customer.engagementSuggestion,
                    color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp, lineHeight = 17.sp,
                )
            }
        }

        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/insights", "Insights") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun InsInfoRow(label: String, value: String, color: Color, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object InsFormat {
    /** Web tk(): "৳12,345" — whole-taka, rounded. */
    fun taka(n: Double?): String =
        "৳" + String.format(Locale.US, "%,d", (n ?: 0.0).roundToLong())

    /** Percent-style number: integers stay bare ("12"), fractions keep one place. */
    fun num(d: Double): String =
        if (d == floor(d) && !d.isNaN()) "${d.toInt()}" else String.format(Locale.US, "%.1f", d)

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}
