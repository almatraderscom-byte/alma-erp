//
//  AuditScreen.kt
//  ALMA ERP — the Audit log page, ported 1:1 from AuditSwiftUI.swift (web parity).
//
//  Endpoint (same as web/iOS):
//    GET /api/audit?limit=300 → { audit: [...], total }   (GAS with Supabase fallback;
//        flat today — a nested {ok,data} wrapper is unwrapped too, approvals pattern)
//  Blocks: status chips (All/OK/FAIL, client-side) + refresh · business chips derived
//  from the loaded window · bento dark hero (TOTAL count-up + OK/FAIL split — dark in
//  BOTH schemes, Dashboard hero recipe) · entry cards (Action mono-gold · Actor · Role ·
//  Business · Status badge · Summary · Time verbatim + Bangla relative) · detail sheet
//  with pretty-printed detail_json · web escape. Read-only log — no mutations.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaPullRefresh
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object AuditPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val green400 = Color(0xFF4ADE80)
    val emerald600 = Color(0xFF059669)

    /** Web: FAIL text-red-500 · else text-emerald-600. Unknown flags read amber. */
    fun status(flag: String?): Color = when ((flag ?: "").uppercase()) {
        "FAIL", "ERROR", "CRITICAL" -> red500
        "OK", "SUCCESS", "PASS" -> emerald600
        else -> amber600
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web page types declare) ───────────────────────────

private data class AuditEntry(
    val uid: String,                 // GAS rows carry no id — timestamp+route is not unique
    val timestamp: String?,
    val route: String?,
    val actor: String?,
    val actorRole: String?,
    val businessId: String?,
    val entityType: String?,
    val entityId: String?,
    val summary: String?,
    val detailJson: String?,
    val statusFlag: String?,
) {
    val isFail: Boolean get() = (statusFlag ?: "").uppercase() == "FAIL"

    companion object {
        /** GAS sheets sometimes hand back numbers where strings are expected — str() takes both. */
        fun from(o: JSONObject): AuditEntry = AuditEntry(
            uid = UUID.randomUUID().toString(),
            timestamp = o.str("timestamp"),
            route = o.str("route"),
            actor = o.str("actor"),
            actorRole = o.str("actor_role"),
            businessId = o.str("business_id"),
            entityType = o.str("entity_type"),
            entityId = o.str("entity_id"),
            summary = o.str("summary"),
            detailJson = o.str("detail_json"),
            statusFlag = o.str("status_flag"),
        )
    }
}

// ── State holder (iOS AuditVM twin) ────────────────────────────────────────────────

private class AuditState {
    var rows by mutableStateOf(listOf<AuditEntry>())
    var total by mutableStateOf(0)
    var statusFilter by mutableStateOf("ALL")        // ALL | OK | FAIL (client-side)
    var businessFilter by mutableStateOf("ALL")      // ALL | <business_id> (from loaded rows)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val okCount: Int get() = rows.count { !it.isFail }
    val failCount: Int get() = rows.count { it.isFail }

    /** Unique business ids present in the loaded window, for the category chip row. */
    val businesses: List<String>
        get() = rows.mapNotNull { it.businessId?.trim()?.takeIf { b -> b.isNotEmpty() } }
            .distinct().sorted()

    val filtered: List<AuditEntry>
        get() = rows.filter { r ->
            val statusOk = when (statusFilter) {
                "FAIL" -> r.isFail
                "OK" -> !r.isFail
                else -> true
            }
            statusOk && (businessFilter == "ALL" || (r.businessId ?: "") == businessFilter)
        }

    /** /api/audit answers flat ({audit, total}); unwrap a {ok,data} wrapper too. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/audit", mapOf("limit" to "300")))
            rows = c.optJSONArray("audit")?.mapObjects { AuditEntry.from(it) } ?: emptyList()
            total = c.flexInt("total") ?: rows.size
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
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuditScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AuditState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<AuditEntry?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { AuditAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { AuditNotice(it, AuditPalette.red500, dark) } }

        item {
            // Status filter — All / OK / FAIL + refresh.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("ALL", "OK", "FAIL").forEach { s ->
                    AuditChip(if (s == "ALL") "All" else s, vm.statusFilter == s, dark) {
                        vm.statusFilter = s
                    }
                }
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { if (!vm.loading) scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
            }
        }

        if (vm.businesses.size > 1) {
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AuditChip("সব ব্যবসা", vm.businessFilter == "ALL", dark) { vm.businessFilter = "ALL" }
                    vm.businesses.forEach { b ->
                        AuditChip(b, vm.businessFilter == b, dark) { vm.businessFilter = b }
                    }
                }
            }
        }

        item {
            // KPI hero — bento dark anchor (owner spec 2026-07-08): dark in BOTH schemes.
            AuditBentoHero(total = vm.total, ok = vm.okCount, fail = vm.failCount)
        }

        if (vm.loading && vm.rows.isEmpty()) {
            items(5) { Box(Modifier.fillMaxWidth().height(92.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        items(vm.filtered, key = { it.uid }) { entry ->
            AuditEntryCard(entry, dark) { selected = entry }
        }

        if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("◇", color = AlmaTheme.inkSecondary(dark), fontSize = 34.sp)
                    Text("কোনো এন্ট্রি নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    Text(
                        "সেশন সেট থাকা অবস্থায় লেখালেখি হলে — GAS রেকর্ড করার পর সারি দেখা যাবে।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { entry ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            AuditDetailSheet(entry, dark) { p, t ->
                selected = null
                // Related-record link → native route when known, web fallback otherwise.
                ctx.openSmart(p, t)
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun AuditChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) AuditPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) AuditPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) AuditPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun AuditNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun AuditAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AuditPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Bento dark hero (Dashboard board language — dark in BOTH schemes) ──────────────

/** Count-up number (0 → target on appear, old → new on refresh). */
@Composable
private fun AuditCountUp(target: Int, fontSize: TextUnit, tint: Color) {
    var started by remember { mutableStateOf(false) }
    val shown by animateFloatAsState(
        targetValue = if (started) target.toFloat() else 0f,
        animationSpec = tween(900),
        label = "auditCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    Text(
        "${shown.roundToInt()}",
        color = tint, fontSize = fontSize, fontWeight = FontWeight.Black,
        maxLines = 1,
    )
}

/** Deep-indigo hero anchor: violet/coral washes + a sage hint (Dashboard hero recipe). */
@Composable
private fun AuditBentoHero(total: Int, ok: Int, fail: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .drawBehind {
                drawRect(Color(0xFF181528))   // iOS (0.094, 0.082, 0.157)
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                        start = Offset.Zero,
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.coral.copy(alpha = 0.30f), Color.Transparent),
                        start = Offset(size.width, size.height),
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.05f),
                        radius = 220.dp.toPx(),
                    ),
                )
            }
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "অডিট লগ · TOTAL",
            color = AuditPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        AuditCountUp(total, 40.sp, Color.White)
        Spacer(Modifier.height(5.dp))
        Text(
            if (fail == 0) "সব চেক পাশ — ফেইল নেই" else "${fail}টি ফেইল দেখা দরকার",
            color = Color.White.copy(alpha = 0.6f), fontSize = 10.sp,
        )
        Spacer(Modifier.height(14.dp))
        Row {
            AuditHeroStat("OK", ok, AuditPalette.green400, "সফল")
            Box(
                Modifier.width(1.dp).height(44.dp).background(Color.White.copy(alpha = 0.14f))
                    .padding(vertical = 2.dp),
            )
            Spacer(Modifier.width(14.dp))
            AuditHeroStat("FAIL", fail, if (fail > 0) AuditPalette.red500 else Color.White, "ব্যর্থ")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun AuditHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(Modifier.padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
        )
        AuditCountUp(value, 20.sp, tint)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Entry card (mirrors one web table row, re-set as a native card) ────────────────

@Composable
private fun AuditEntryCard(entry: AuditEntry, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Web: Action column, font-mono text-gold.
            Text(
                entry.route ?: "—",
                color = AuditPalette.accentText(dark), fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            AuditStatusBadge(entry.statusFlag)
        }

        // Web: Actor + Role + Business columns.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(entry.actor ?: "—", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            entry.actorRole?.takeIf { it.isNotEmpty() }?.let {
                Text(it.replace("_", " "), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Spacer(Modifier.weight(1f))
            entry.businessId?.takeIf { it.isNotEmpty() }?.let {
                Text(
                    it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }

        entry.summary?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }

        // Web: Time column, font-mono text-muted — shown verbatim.
        Text(
            AuditFormat.timeLine(entry.timestamp),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
        )
    }
}

/** Web status colours: FAIL text-red-500 · else text-emerald-600, as a badge. */
@Composable
private fun AuditStatusBadge(flag: String?) {
    val tint = AuditPalette.status(flag)
    Text(
        (flag ?: "—").uppercase(),
        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Black,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

// ── Detail sheet (full row — the web packs Summary into a truncated cell) ──────────

@Composable
private fun AuditDetailSheet(entry: AuditEntry, dark: Boolean, openWeb: (path: String, title: String) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    entry.route ?: "—",
                    color = AuditPalette.accentText(dark), fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    (entry.statusFlag ?: "—").uppercase(),
                    color = AuditPalette.status(entry.statusFlag),
                    fontSize = 12.sp, fontWeight = FontWeight.Black,
                )
            }
            Text(
                AuditFormat.timeLine(entry.timestamp),
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            )
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AuditInfoRow("Actor", entry.actor ?: "—", dark)
            AuditInfoRow("Role", (entry.actorRole ?: "—").replace("_", " "), dark)
            AuditInfoRow("Business", entry.businessId ?: "Global", dark)
            entry.entityType?.takeIf { it.isNotEmpty() }?.let { et ->
                AuditInfoRow("Entity", et + (entry.entityId?.let { " · $it" } ?: ""), dark)
            }
            AuditInfoRow("Summary", entry.summary ?: "—", dark)
        }

        AuditFormat.prettyDetail(entry.detailJson)?.let { detail ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("DETAIL", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                Row(Modifier.horizontalScroll(rememberScrollState())) {
                    Text(
                        detail,
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }

    }
}

@Composable
private fun AuditInfoRow(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Formatting helpers ─────────────────────────────────────────────────────────────

private object AuditFormat {
    /** The web shows the timestamp string verbatim (font-mono). When it parses as
     *  ISO, append a Bangla relative-time hint; otherwise show it raw. */
    fun timeLine(raw: String?): String {
        if (raw.isNullOrEmpty()) return "—"
        val date = parse(raw) ?: return raw
        val mins = ((System.currentTimeMillis() - date.time) / 60_000).toInt()
        val ago = when {
            mins < 1 -> "এইমাত্র"
            mins < 60 -> "$mins মিনিট আগে"
            mins < 24 * 60 -> "${mins / 60} ঘণ্টা আগে"
            else -> "${mins / (24 * 60)} দিন আগে"
        }
        return "$raw · $ago"
    }

    private fun parse(iso: String): java.util.Date? {
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

    /** detail_json pretty-printed when it parses; raw string otherwise; null when empty. */
    fun prettyDetail(raw: String?): String? {
        val t = raw?.trim() ?: return null
        if (t.isEmpty() || t == "{}") return null
        return try {
            JSONObject(t).toString(2)
        } catch (_: Exception) {
            try {
                JSONArray(t).toString(2)
            } catch (_: Exception) {
                t
            }
        }
    }
}
