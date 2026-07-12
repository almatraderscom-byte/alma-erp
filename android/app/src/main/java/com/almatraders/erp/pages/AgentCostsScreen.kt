//
//  AgentCostsScreen.kt
//  ALMA ERP — the agent AI-cost dashboard, ported 1:1 from AgentCostsSwiftUI.swift
//  (read-only). Blocks: today/month hero cost cards ($ monospaced) · budget-cap
//  indicator (amber near cap, red over) · per-model breakdown with gradient bars ·
//  provider split (this month) · 30-day day-history rows · API balance table.
//  Budget CONFIG, logs and CSV stay on the web — footer escape opens /agent/costs.
//
//  Endpoints (same as web/iOS, both served flat — no {ok,data} wrapper, but we
//  unwrap `data` defensively like every native screen):
//    GET /api/assistant/costs/summary
//    GET /api/assistant/costs/balances   (best-effort — page renders without it)
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.CircleShape
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
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / the dashboard's tokens) ────────────

private object CostPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val amber400 = Color(0xFFFBBF24)
    val emerald600 = Color(0xFF059669)
    val gold = Color(0xFFD4A84B)

    /** Web PROVIDER_COLORS (recharts fills) — same hexes. */
    fun provider(id: String): Color = when (id) {
        "anthropic" -> coral                       // #E07A5F
        "openai" -> Color(0xFF81B29A)
        "openrouter" -> Color(0xFFA78BFA)
        "gemini" -> Color(0xFF3B82F6)
        "google_tts" -> Color(0xFF8B5CF6)
        "twilio" -> Color(0xFFD4A84B)
        "elevenlabs" -> Color(0xFFEC4899)
        "veo" -> Color(0xFF0EA5E9)
        else -> Color(0xFF94A3B8)
    }

    /** Web MODEL_CHART_COLORS — deterministic cycle by index for the model bars.
     *  Pitfall guard: computed getter, never a stored companion list. */
    private val modelCycle: List<Color>
        get() = listOf(
            coral,                 // #E07A5F
            Color(0xFF81B29A),
            Color(0xFFA78BFA),
            Color(0xFF3B82F6),
            Color(0xFFD4A84B),
            Color(0xFFEC4899),
            Color(0xFF0EA5E9),
            Color(0xFF10B981),
            amber500,
            Color(0xFF6366F1),
            Color(0xFF94A3B8),
        )

    fun model(index: Int): Color = modelCycle.let { it[index % it.size] }

    /** Web balanceColor(): <$1 red · <$5 amber · else green · Free green. */
    fun balance(usd: Double?, free: Boolean, dark: Boolean): Color {
        if (free) return emerald600
        usd ?: return AlmaTheme.inkSecondary(dark)
        if (usd < 1) return red500
        if (usd < 5) return amber500
        return emerald600
    }

    /** Budget bar/label tone: ≥100% red (over cap) · ≥80% amber (near cap). */
    fun budget(pct: Double, dark: Boolean): Color = when {
        pct >= 100 -> red500
        pct >= 80 -> amber600
        else -> AlmaTheme.ink(dark)
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web DashboardData type declares) ──────────────────

private data class CostDayPoint(val date: String, val total: Double)

private data class CostModelRow(
    val modelId: String,
    val label: String,
    val provider: String,
    val monthUsd: Double,
    val todayUsd: Double,
)

private data class CostProviderRow(val provider: String, val totalUsd: Double)

private data class CostBudgets(val dailyUsd: Double?, val monthlyUsd: Double?)

private data class CostsSummary(
    val todayDhakaDate: String?,
    val todayUsd: Double,
    val todayOxylabsCredits: Double?,
    val monthUsd: Double,
    val forecastUsd: Double,
    val subscriptionAmortMonthUsd: Double?,
    val dailyLast30: List<CostDayPoint>,
    val byProvider: List<CostProviderRow>,
    val byModel: List<CostModelRow>,
    val telegramTodayUsd: Double?,
    val telegramMonthUsd: Double?,
    val budgets: CostBudgets,
    val dailyBudgetPct: Double?,
    val monthlyBudgetPct: Double?,
) {
    companion object {
        fun from(o: JSONObject) = CostsSummary(
            todayDhakaDate = o.str("todayDhakaDate"),
            todayUsd = o.flexDouble("todayUsd") ?: 0.0,
            todayOxylabsCredits = o.flexDouble("todayOxylabsCredits"),
            monthUsd = o.flexDouble("monthUsd") ?: 0.0,
            forecastUsd = o.flexDouble("forecastUsd") ?: 0.0,
            subscriptionAmortMonthUsd = o.flexDouble("subscriptionAmortMonthUsd"),
            dailyLast30 = o.optJSONArray("dailyLast30")?.mapObjects {
                CostDayPoint(it.str("date") ?: "", it.flexDouble("total") ?: 0.0)
            } ?: emptyList(),
            byProvider = o.optJSONArray("byProvider")?.mapObjects { p ->
                p.str("provider")?.let { CostProviderRow(it, p.flexDouble("totalUsd") ?: 0.0) }
            } ?: emptyList(),
            byModel = o.optJSONArray("byModel")?.mapObjects { m ->
                m.str("modelId")?.let { id ->
                    CostModelRow(
                        modelId = id,
                        label = m.str("label") ?: id,
                        provider = m.str("provider") ?: "",
                        monthUsd = m.flexDouble("monthUsd") ?: 0.0,
                        todayUsd = m.flexDouble("todayUsd") ?: 0.0,
                    )
                }
            } ?: emptyList(),
            telegramTodayUsd = o.flexDouble("telegramTodayUsd"),
            telegramMonthUsd = o.flexDouble("telegramMonthUsd"),
            budgets = o.optJSONObject("budgets")?.let {
                CostBudgets(it.flexDouble("dailyUsd"), it.flexDouble("monthlyUsd"))
            } ?: CostBudgets(null, null),
            dailyBudgetPct = o.flexDouble("dailyBudgetPct"),
            monthlyBudgetPct = o.flexDouble("monthlyBudgetPct"),
        )
    }
}

private data class CostBalanceRow(
    val id: String,
    val label: String,
    val balanceUsd: Double?,
    val todayUsd: Double?,
    val monthUsd: Double?,
    val free: Boolean,
    val syncedThrough: String?,
)

private data class CostsBalances(
    val checkedAt: String?,
    val providers: List<CostBalanceRow>,
) {
    companion object {
        fun from(o: JSONObject) = CostsBalances(
            checkedAt = o.str("checkedAt"),
            providers = o.optJSONArray("providers")?.mapObjects { r ->
                r.str("id")?.let { id ->
                    CostBalanceRow(
                        id = id,
                        label = r.str("label") ?: id,
                        balanceUsd = r.flexDouble("balanceUsd"),
                        todayUsd = r.flexDouble("todayUsd"),
                        monthUsd = r.flexDouble("monthUsd"),
                        free = r.flexBool("free") ?: false,
                        syncedThrough = r.str("syncedThrough"),
                    )
                }
            } ?: emptyList(),
        )
    }
}

// ── State holder (iOS AgentCostsVM twin) ───────────────────────────────────────────

private class AgentCostsState {
    var summary by mutableStateOf<CostsSummary?>(null)
    var balances by mutableStateOf<CostsBalances?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            summary = CostsSummary.from(unwrap(AlmaApi.getObject("/api/assistant/costs/summary")))
            authExpired = false
            // Balances are best-effort — the web page also renders without them.
            try {
                balances = CostsBalances.from(unwrap(AlmaApi.getObject("/api/assistant/costs/balances")))
            } catch (_: Exception) { }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message ?: "লোড করা গেল না"
        } finally {
            loading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun AgentCostsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AgentCostsState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (vm.authExpired) {
            item { CostAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { err ->
            item { CostErrorCard(err, dark) { scope.launch { vm.load() } } }
        }
        if (vm.loading && vm.summary == null) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }
        vm.summary?.let { s ->
            item { CostHeroCards(s, dark) }
            if ((s.dailyBudgetPct != null && s.budgets.dailyUsd != null) ||
                (s.monthlyBudgetPct != null && s.budgets.monthlyUsd != null)
            ) {
                item { CostBudgetCard(s, dark) }
            }
            if (s.byModel.isNotEmpty()) item { CostModelBreakdown(s, dark) }
            if (s.byProvider.isNotEmpty()) item { CostProviderBreakdown(s, dark) }
            if (s.dailyLast30.isNotEmpty()) item { CostDayHistory(s, dark) }
        }
        vm.balances?.takeIf { it.providers.isNotEmpty() }?.let { b ->
            item { CostBalancesCard(b, dark) }
        }
        item {
            Text(
                "🌐 সব অপশন (বাজেট/লগ/CSV সহ) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/agent/costs", "Costs") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

// ── Hero cost cards (আজ / এই মাস / পূর্বাভাস) — big monospaced dollars ─────────────

@Composable
private fun CostHeroCards(s: CostsSummary, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CostHeroCard(
                label = s.todayDhakaDate?.let { "আজ (Dhaka $it)" } ?: "আজ (USD API)",
                value = CostFormat.usd(s.todayUsd),
                sub = "Anthropic/Twilio/OpenAI ইত্যাদি — Oxylabs বাদ",
                tint = CostPalette.accentText(dark),
                dark = dark,
                modifier = Modifier.weight(1f),
            )
            CostHeroCard(
                label = "এই মাস",
                value = CostFormat.usd(s.monthUsd),
                sub = s.subscriptionAmortMonthUsd?.let { "+ সাবস্ক্রিপশন ${CostFormat.usd(it)}" },
                tint = AlmaTheme.ink(dark),
                dark = dark,
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CostSmallStat("পূর্বাভাস (মাস)", CostFormat.usd(s.forecastUsd), null, dark, Modifier.weight(1f))
            CostSmallStat(
                "Oxylabs আজ",
                "${(s.todayOxylabsCredits ?: 0.0).roundToInt()} ক্রেডিট",
                "Prepaid credit — USD নয়",
                dark,
                Modifier.weight(1f),
            )
        }
        if (s.telegramTodayUsd != null && s.telegramMonthUsd != null) {
            Text(
                "📱 Telegram — আজ ${CostFormat.usd(s.telegramTodayUsd)} · এই মাসে ${CostFormat.usd(s.telegramMonthUsd)}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 2.dp),
            )
        }
    }
}

@Composable
private fun CostHeroCard(label: String, value: String, sub: String?, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(value, color = tint, fontSize = 24.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        sub?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun CostSmallStat(label: String, value: String, sub: String?, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        sub?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp) }
    }
}

// ── Budget-cap indicator (read-only; config lives on the web) ──────────────────────

@Composable
private fun CostBudgetCard(s: CostsSummary, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("বাজেট সতর্কতা (USD)", color = CostPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        if (s.dailyBudgetPct != null && s.budgets.dailyUsd != null) {
            CostBudgetRow("আজকের বাজেট ব্যবহার", s.dailyBudgetPct, s.todayUsd, s.budgets.dailyUsd, dark)
        }
        if (s.monthlyBudgetPct != null && s.budgets.monthlyUsd != null) {
            CostBudgetRow("মাসিক বাজেট ব্যবহার", s.monthlyBudgetPct, s.monthUsd, s.budgets.monthlyUsd, dark)
        }
        Text("৮০% → Tier 1 সতর্কতা | ১০০% → Tier 2 critical", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

@Composable
private fun CostBudgetRow(label: String, pct: Double, spent: Double, cap: Double, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            Spacer(Modifier.weight(1f))
            Text(
                "${pct.roundToInt()}% (${CostFormat.usd(spent)} / ${CostFormat.usd(cap)})",
                color = CostPalette.budget(pct, dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        CostGradientBar(
            fraction = (pct / 100.0).toFloat(),
            brush = budgetBrush(pct),
            dark = dark,
            height = 6,
        )
    }
}

/** Web bar gradients: ≥100% red-500→red-400 · ≥80% amber-500→amber-400 ·
 *  else coral #E07A5F → gold #D4A84B. */
private fun budgetBrush(pct: Double): Brush = when {
    pct >= 100 -> Brush.horizontalGradient(listOf(CostPalette.red500, CostPalette.red400))
    pct >= 80 -> Brush.horizontalGradient(listOf(CostPalette.amber500, CostPalette.amber400))
    else -> Brush.horizontalGradient(listOf(CostPalette.coral, CostPalette.gold))
}

/** Capsule progress bar (the iOS GeometryReader capsule twin). */
@Composable
private fun CostGradientBar(fraction: Float, brush: Brush, dark: Boolean, height: Int = 7) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(height.dp)
            .clip(CircleShape)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.06f)),
    ) {
        if (fraction > 0f) {
            Box(
                Modifier
                    .fillMaxWidth(fraction.coerceIn(0.02f, 1f))
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(brush),
            )
        }
    }
}

// ── Per-model breakdown — gradient bars (web recharts bars, re-set) ────────────────

@Composable
private fun CostModelBreakdown(s: CostsSummary, dark: Boolean) {
    val maxMonth = maxOf(s.byModel.maxOfOrNull { it.monthUsd } ?: 0.0, 0.0001)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "🤖 মডেল অনুযায়ী খরচ (প্রতিটি API key আলাদা)",
            color = CostPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
        )
        Text("কোন মডেল কত খরচ করল — আজ ও এই মাসে", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        s.byModel.forEachIndexed { idx, m ->
            val tint = CostPalette.model(idx)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(7.dp).background(tint, CircleShape))
                    Text(
                        m.label, color = AlmaTheme.ink(dark), fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Text(CostFormat.providerLabel(m.provider), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
                    Spacer(Modifier.weight(1f))
                    Text("আজ ${CostFormat.usd(m.todayUsd)}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    Text(
                        CostFormat.usd(m.monthUsd),
                        color = CostPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    )
                }
                CostGradientBar(
                    fraction = (m.monthUsd / maxMonth).toFloat(),
                    brush = Brush.horizontalGradient(listOf(tint.copy(alpha = 0.55f), tint)),
                    dark = dark,
                )
            }
        }
    }
}

// ── Provider split (এই মাস) — the web pie, re-set as gradient bars ─────────────────

@Composable
private fun CostProviderBreakdown(s: CostsSummary, dark: Boolean) {
    val sorted = s.byProvider.sortedByDescending { it.totalUsd }
    val maxUsd = maxOf(sorted.maxOfOrNull { it.totalUsd } ?: 0.0, 0.0001)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("প্রোভাইডার (এই মাস)", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        sorted.forEach { p ->
            val tint = CostPalette.provider(p.provider)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(7.dp).background(tint, CircleShape))
                    Text(
                        CostFormat.providerLabel(p.provider),
                        color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        CostFormat.usd(p.totalUsd),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    )
                }
                CostGradientBar(
                    fraction = (p.totalUsd / maxUsd).toFloat(),
                    brush = Brush.horizontalGradient(listOf(tint.copy(alpha = 0.55f), tint)),
                    dark = dark,
                )
            }
        }
    }
}

// ── Day-history rows (দৈনিক খরচ — ৩০ দিন), newest first ────────────────────────────

@Composable
private fun CostDayHistory(s: CostsSummary, dark: Boolean) {
    val maxTotal = maxOf(s.dailyLast30.maxOfOrNull { it.total } ?: 0.0, 0.0001)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("দৈনিক খরচ (৩০ দিন)", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        if (s.dailyLast30.all { it.total == 0.0 }) {
            Text(
                "এখনো কোনো ইভেন্ট নেই",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
            )
        } else {
            s.dailyLast30.asReversed().forEach { d ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        CostFormat.dayLabel(d.date),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.width(44.dp),
                    )
                    Box(Modifier.weight(1f)) {
                        CostGradientBar(
                            fraction = (d.total / maxTotal).toFloat(),
                            brush = Brush.horizontalGradient(listOf(CostPalette.goldLt, CostPalette.coral)),
                            dark = dark,
                            height = 6,
                        )
                    }
                    Text(
                        CostFormat.usd(d.total),
                        color = if (d.total > 0) AlmaTheme.ink(dark) else AlmaTheme.inkSecondary(dark),
                        fontSize = 10.sp,
                        textAlign = TextAlign.End,
                        modifier = Modifier.width(58.dp),
                    )
                }
            }
        }
    }
}

// ── API balances (💳 API ব্যালেন্স) — read-only table ──────────────────────────────

@Composable
private fun CostBalancesCard(b: CostsBalances, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("💳 API ব্যালেন্স", color = CostPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            CostFormat.checkedAt(b.checkedAt)?.let {
                Text("শেষ চেক: $it", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
            }
        }
        b.providers.forEach { row ->
            Column(Modifier.padding(vertical = 3.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(7.dp).background(CostPalette.provider(row.id), CircleShape))
                    Text(row.label, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    if (row.free) {
                        Text(
                            "Free",
                            color = CostPalette.emerald600, fontSize = 8.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(CostPalette.emerald600.copy(alpha = 0.10f), CircleShape)
                                .border(0.8.dp, CostPalette.emerald600.copy(alpha = 0.30f), CircleShape)
                                .padding(horizontal = 5.dp, vertical = 1.5.dp),
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    Text(
                        if (row.free) "Free" else (row.balanceUsd?.let { CostFormat.usd(it) } ?: "—"),
                        color = CostPalette.balance(row.balanceUsd, row.free, dark),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                }
                Row(
                    Modifier.padding(start = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "আজ খরচ ${CostFormat.spend(row.todayUsd, row.id)} · এই মাসে ${CostFormat.spend(row.monthUsd, row.id)}",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    row.syncedThrough?.let {
                        Text("⏳ $it পর্যন্ত sync", color = CostPalette.amber600, fontSize = 9.sp)
                    }
                }
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun CostAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(CostPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun CostErrorCard(message: String, dark: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("⚠️ $message", color = CostPalette.red500, fontSize = 13.sp)
        Text(
            "আবার চেষ্টা",
            color = CostPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(CostPalette.coral.copy(alpha = 0.13f), CircleShape)
                .border(1.dp, CostPalette.coral.copy(alpha = 0.35f), CircleShape)
                .plainClick(onRetry)
                .padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object CostFormat {
    /** Web fmtUsd: 2 decimals; 4 when 0 < n < $0.01 (sub-cent API events). */
    fun usd(n: Double): String {
        val digits = if (n < 0.01 && n > 0) 4 else 2
        return "$" + String.format("%.${digits}f", n)
    }

    /** Web fmtSpendCell: Oxylabs shows prepaid credits, everything else USD. */
    fun spend(n: Double?, providerId: String): String {
        n ?: return "—"
        if (providerId == "oxylabs") return "${n.roundToInt()} ক্রেডিট"
        return usd(n)
    }

    /** Web PROVIDER_LABELS. */
    fun providerLabel(id: String): String = when (id) {
        "anthropic" -> "Anthropic"
        "openai" -> "OpenAI"
        "openrouter" -> "OpenRouter"
        "gemini" -> "Gemini"
        "google_tts" -> "Google TTS"
        "twilio" -> "Twilio"
        "elevenlabs" -> "ElevenLabs"
        "veo" -> "VEO 3"
        "oxylabs" -> "Oxylabs"
        else -> id
    }

    /** "2026-07-05" → "07-05" (the web slices off the year the same way). */
    fun dayLabel(ymd: String): String = if (ymd.length > 5) ymd.substring(5) else ymd

    /** checkedAt ISO → Dhaka-time short stamp (web fmtCheckedAt, bn-BD). */
    fun checkedAt(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Locale("bn", "BD"))
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
