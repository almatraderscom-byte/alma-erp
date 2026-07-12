//
//  ActivityScreen.kt
//  ALMA ERP — the Activity tab (unified audit timeline), ported 1:1 from
//  ActivitySwiftUI.swift. READ-ONLY feed: "who did what, when".
//
//  Endpoint (same as web/iOS, owner/admin only):
//    GET /api/audit-timeline → { ok, data: { entries, sources } }
//  Web-parity blocks: source filter chips with counts (only sources that have
//  entries) · Dhaka-day date dividers · rows with actor + action + resource +
//  detail + Bangla relative time. Native re-set: tinted icon chips per event
//  source, actor-initials avatars, client-side "আরো দেখুন" load-more (the server
//  returns the whole window at once — max 120 entries — so paging is local).
//

package com.almatraders.erp.pages

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.SettingsInputAntenna
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material.icons.filled.Verified
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
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

private object ActPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val blue500 = Color(0xFF3B82F6)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web SOURCE_META tones: approval gold · payment_method success · else muted. */
    fun tone(source: String, dark: Boolean): Color = when (source) {
        "approval" -> accentText(dark)
        "payment_method" -> emerald600
        else -> AlmaTheme.inkSecondary(dark)
    }

    /** One tint per event source — drives the tinted icon chips (owner spec 2026-07-08). */
    fun sourceTint(source: String): Color = when (source) {
        "approval" -> goldDim
        "payment_method" -> emerald600
        "archive" -> AlmaTheme.violet
        "trading_telegram" -> blue500
        "telegram_ops" -> AlmaTheme.sage
        "volume_target" -> amber600
        else -> coral
    }
}

// ── Source metadata (web SOURCE_META parity, emoji → material icons) ────────────────

/** Web chip order (Object.keys(SOURCE_META)). */
private val ACT_SOURCE_ORDER
    get() = listOf(
        "approval", "payment_method", "archive",
        "trading_telegram", "telegram_ops", "volume_target",
    )

private fun actSourceLabel(source: String): String = when (source) {
    "approval" -> "অনুমোদন"            // ✅
    "payment_method" -> "পেমেন্ট"       // 💳
    "archive" -> "আর্কাইভ"              // 📦
    "trading_telegram" -> "ট্রেডিং TG"  // ✉️
    "telegram_ops" -> "অপস"             // 📡
    "volume_target" -> "টার্গেট"        // 🎯
    else -> source
}

private fun actSourceIcon(source: String): ImageVector = when (source) {
    "approval" -> Icons.Filled.Verified
    "payment_method" -> Icons.Filled.CreditCard
    "archive" -> Icons.Filled.Archive
    "trading_telegram" -> Icons.AutoMirrored.Filled.Send
    "telegram_ops" -> Icons.Filled.SettingsInputAntenna
    "volume_target" -> Icons.Filled.TrackChanges
    else -> Icons.Filled.History
}

// ── Model (same field names the web page types declare) ─────────────────────────────

private data class ActEntry(
    val id: String,
    val at: String?,
    val source: String,
    val action: String?,
    val actor: String?,
    val resource: String?,
    val detail: String?,
    val businessId: String?,
) {
    companion object {
        fun from(o: JSONObject): ActEntry? {
            val id = o.str("id") ?: return null
            return ActEntry(
                id = id,
                at = o.str("at"),
                source = o.str("source") ?: "unknown",
                action = o.str("action"),
                actor = o.str("actor"),
                resource = o.str("resource"),
                detail = o.str("detail"),
                businessId = o.str("businessId"),
            )
        }
    }
}

// ── State holder (iOS ActivityVM twin) ──────────────────────────────────────────────

private const val ACT_PAGE_SIZE = 30

private class ActivityState {
    var entries by mutableStateOf(listOf<ActEntry>())
    var sourceCounts by mutableStateOf(mapOf<String, Int>())
    var filter by mutableStateOf("all")           // "all" | AuditSource
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    /** Client-side paging window — the API returns the whole feed (≤120 rows). */
    var visibleCount by mutableStateOf(ACT_PAGE_SIZE)

    val filtered: List<ActEntry>
        get() = if (filter == "all") entries else entries.filter { it.source == filter }
    val visible: List<ActEntry> get() = filtered.take(visibleCount)
    val hasMore: Boolean get() = filtered.size > visibleCount

    suspend fun load() {
        loading = true
        error = null
        try {
            // apiDataSuccess wrapper → { ok, data:{ entries, sources } }; unwrap both.
            val root = AlmaApi.getObject("/api/audit-timeline")
            val c = root.optJSONObject("data") ?: root
            entries = c.optJSONArray("entries")?.mapObjects { ActEntry.from(it) } ?: emptyList()
            val src = c.optJSONObject("sources")
            val counts = mutableMapOf<String, Int>()
            src?.keys()?.forEach { k -> src.flexInt(k)?.let { counts[k] = it } }
            sourceCounts = counts
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "লোড করা গেল না"
        } finally {
            loading = false
        }
    }

    fun applyFilter(f: String) {
        filter = f
        visibleCount = ACT_PAGE_SIZE
    }

    fun loadMore() {
        visibleCount += ACT_PAGE_SIZE
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun ActivityScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { ActivityState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    // Consecutive-run day grouping — the feed arrives sorted desc, so equal day
    // keys are always adjacent (same trick the web page uses).
    val groups = buildList<Pair<String, MutableList<ActEntry>>> {
        for (e in vm.visible) {
            val k = ActFormat.dayKey(e.at)
            if (isNotEmpty() && last().first == k) last().second.add(e)
            else add(k to mutableListOf(e))
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(top = 6.dp, bottom = 8.dp),
    ) {
        item {
            // Header line (web PageHeader subtitle + ↻ ghost button).
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "কে কখন কী করল — এক জায়গায়",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { if (!vm.loading) scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
            }
        }
        if (vm.authExpired) {
            item { ActAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { err ->
            item { ActErrorCard(err, dark) { scope.launch { vm.load() } } }
        }
        item {
            // Source filter chips (web: সব + only sources that have entries).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ActChip("সব", null, vm.entries.size, vm.filter == "all", dark) { vm.applyFilter("all") }
                ACT_SOURCE_ORDER.filter { (vm.sourceCounts[it] ?: 0) > 0 }.forEach { s ->
                    ActChip(
                        actSourceLabel(s), actSourceIcon(s),
                        vm.sourceCounts[s] ?: 0, vm.filter == s, dark,
                    ) { vm.applyFilter(s) }
                }
            }
        }
        if (vm.loading && vm.entries.isEmpty()) {
            repeat(6) {
                item { Box(Modifier.fillMaxWidth().height(76.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            }
        }
        groups.forEach { (day, items) ->
            item {
                // Dhaka-day divider (web group-by-day parity).
                Text(
                    day.uppercase(),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    fontWeight = FontWeight.Black, letterSpacing = 1.6.sp,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                )
            }
            items.forEachIndexed { i, entry ->
                item {
                    Column {
                        ActCard(entry, dark)
                        // Hairline connector between rows — a true timeline thread,
                        // aligned to the icon chip's centre (12dp pad + 17dp half-chip).
                        if (i < items.size - 1) {
                            Box(
                                Modifier
                                    .padding(start = 28.5.dp)
                                    .width(1.dp)
                                    .height(14.dp)
                                    .background(AlmaTheme.separator(dark)),
                            )
                        }
                    }
                }
            }
        }
        if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("🕘", fontSize = 34.sp)
                    Text("কিছু নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    Text(
                        "এই ফিল্টারে কোনো কার্যকলাপ পাওয়া যায়নি।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }
        }
        if (vm.hasMore) {
            item {
                // Load more (client-side append over the already-fetched feed).
                Text(
                    "⌄ আরো দেখুন (${vm.filtered.size - vm.visibleCount})",
                    color = ActPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(ActPalette.coral.copy(alpha = 0.13f), CircleShape)
                        .border(1.dp, ActPalette.coral.copy(alpha = 0.35f), CircleShape)
                        .plainClick { vm.loadMore() }
                        .padding(vertical = 10.dp),
                )
            }
        }
    }
}

// ── Chips / states ──────────────────────────────────────────────────────────────────

@Composable
private fun ActChip(
    label: String,
    icon: ImageVector?,
    count: Int,
    active: Boolean,
    dark: Boolean,
    onClick: () -> Unit,
) {
    val tint = if (active) ActPalette.accentText(dark) else AlmaTheme.inkSecondary(dark)
    Row(
        Modifier
            .background(
                if (active) ActPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) ActPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(12.dp))
        }
        Text(
            label,
            color = tint, fontSize = 13.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        )
        Text("$count", color = tint.copy(alpha = 0.6f), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ActErrorCard(message: String, dark: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(message, color = ActPalette.red500, fontSize = 13.sp)
        Text(
            "আবার চেষ্টা",
            color = ActPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(ActPalette.coral.copy(alpha = 0.13f), CircleShape)
                .border(1.dp, ActPalette.coral.copy(alpha = 0.35f), CircleShape)
                .plainClick(onRetry)
                .padding(horizontal = 14.dp, vertical = 7.dp),
        )
    }
}

@Composable
private fun ActAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(ActPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Row card (tinted icon chip per source + actor-initials avatar + rel time) ───────

@Composable
private fun ActCard(entry: ActEntry, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(12.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Icon chip — TINTED per event source (owner spec 2026-07-08).
        val tint = ActPalette.sourceTint(entry.source)
        Box(
            Modifier
                .size(34.dp)
                .background(tint.copy(alpha = if (dark) 0.20f else 0.14f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, tint.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(actSourceIcon(entry.source), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            // Web: bold actor + muted action in one line.
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = AlmaTheme.ink(dark))) {
                        append(entry.actor ?: "System")
                    }
                    append(" ")
                    withStyle(SpanStyle(color = AlmaTheme.inkSecondary(dark))) {
                        append(entry.action ?: "—")
                    }
                },
                fontSize = 13.sp, lineHeight = 18.sp,
            )
            Text(
                entry.resource ?: "—",
                color = ActPalette.tone(entry.source, dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
            entry.detail?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, lineHeight = 15.sp)
            }
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(ActFormat.timeAgo(entry.at), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            Box(
                Modifier
                    .size(24.dp)
                    .background(ActPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, ActPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    ActFormat.initials(entry.actor ?: "System"),
                    color = ActPalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Formatting helpers (web util parity) ────────────────────────────────────────────

private object ActFormat {
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

    /** Bangla relative time — the web relTime's exact strings. */
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

    /** Dhaka calendar day → "2026-07-06" (web dayKey: toLocaleDateString en-CA). */
    fun dayKey(iso: String?): String {
        val date = parse(iso) ?: return "—"
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}
