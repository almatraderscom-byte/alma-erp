//
//  CreditUsageScreen.kt
//  ALMA ERP — the agent cost dashboard, ported 1:1 from CreditUsageSwiftUI.swift (v4).
//
//  Two panes (glass segment): USAGE — big live spend hero with 1D/7D/30D/Custom range
//  and an interactive stacked daily bar chart (tap a bar to drill: hero retargets,
//  other bars dim) + provider credit wallet + model breakdown + budget (native PUT
//  editor). LOGS — OpenRouter-style range menu + Live auto-refresh (10s) + activity
//  mini-chart + filter chips + the end-to-end cost ledger; tap a row for token
//  intelligence incl. the FULL raw `units` DB JSON (owner rule: raw truth).
//
//  Material discipline (iOS v4): GLASS floats controls (segment, range switch, chips,
//  web escape); SOLID anchors dense data (hero, wallet, ledger, breakdown, budget).
//
//  Endpoints (same as web/iOS, {ok,data} unwrapped defensively):
//    GET  /api/assistant/costs/summary
//    GET  /api/assistant/costs/balances · POST (force provider refresh)
//    PUT  /api/assistant/costs/budget   {dailyUsd, monthlyUsd}  (null clears)
//    GET  /api/assistant/usage-logs?from&to&limit=100[&cursor]
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Palette (exact web PROVIDER_COLORS — iOS CUPalette twins) ───────────────────────

private object CUPalette {
    val coral = Color(0xFFE07A5F)
    val violet = Color(0xFFA78BFA)
    val sage = Color(0xFF81B29A)
    val gold = Color(0xFFD4A84B)
    val goldLt = Color(0xFFEEB48F)
    val emerald = Color(0xFF3DBE8B)
    val amber = Color(0xFFE0A94B)
    val red = Color(0xFFE4756B)

    fun provider(id: String): Color = when (id) {
        "anthropic" -> coral
        "openai" -> sage
        "openrouter" -> violet
        "gemini" -> Color(0xFF3B82F6)
        "google_tts" -> Color(0xFF8B5CF6)
        "twilio" -> gold
        "elevenlabs" -> Color(0xFFEC4899)
        "veo" -> Color(0xFF0EA5E9)
        else -> Color(0xFF94A3B8)
    }

    // PITFALL guard: never a STORED list on an object — `get() =` only.
    private val modelCycle: List<Color>
        get() = listOf(
            coral, sage, violet, Color(0xFF3B82F6), gold,
            Color(0xFFEC4899), Color(0xFF0EA5E9), Color(0xFF10B981),
            Color(0xFFF59E0B), Color(0xFF6366F1),
        )

    fun model(i: Int): Color = modelCycle[i % 10]

    fun accentText(dark: Boolean): Color = if (dark) goldLt else Color(0xFFB4552F)

    fun balance(usd: Double?, free: Boolean, dark: Boolean): Color = when {
        free -> emerald
        usd == null -> AlmaTheme.inkSecondary(dark)
        usd < 1 -> red
        usd < 5 -> amber
        else -> emerald
    }
}

private object CULabel {
    fun provider(id: String): String = when (id) {
        "anthropic" -> "Anthropic"; "openai" -> "OpenAI"
        "openrouter" -> "OpenRouter"; "gemini" -> "Gemini"
        "google_tts" -> "Google TTS"; "twilio" -> "Twilio"
        "elevenlabs" -> "ElevenLabs"; "veo" -> "VEO 3"
        "oxylabs" -> "Oxylabs"; else -> if (id.isEmpty()) "অন্যান্য" else id
    }

    /** Emoji badge (Android port style — iOS uses SF symbols). */
    fun icon(kind: String, provider: String): String {
        val k = kind.lowercase()
        if (k.contains("image") || k.contains("nano") || k.contains("veo")) return "🖼"
        if (k.contains("tts") || k.contains("speech_out")) return "🔊"
        if (k.contains("stt") || k.contains("whisper") || k.contains("transcri")) return "🎙"
        if (k.contains("call") || provider == "twilio") return "📞"
        if (k.contains("research") || k.contains("serp") || provider == "oxylabs") return "🔍"
        if (k.contains("cs_") || k.contains("customer")) return "💬"
        if (k.contains("escalat") || k.contains("opus")) return "⚡"
        if (k.contains("ops") || k.contains("tool")) return "🖥"
        return "✨"
    }

    fun roleTag(kind: String): String {
        val k = kind.lowercase()
        return when {
            k.contains("cs_") -> "cs"
            k.contains("image") -> "image"
            k.contains("tts") -> "voice"
            k.contains("stt") || k.contains("whisper") -> "voice"
            k.contains("call") -> "call"
            k.contains("research") -> "research"
            k.contains("escalat") -> "escalation"
            k.contains("ops") -> "ops"
            k.contains("chat") || k.contains("head") -> "head"
            else -> if (kind.isEmpty()) "event" else kind.take(12)
        }
    }
}

// ── Models (same field names the API sends; org.json flex readers) ──────────────────

private class CUDay(val date: String, val providers: Map<String, Double>) {
    val plottedTotal: Double get() = providers.values.sum()
    val topProvider: String? get() = providers.maxByOrNull { it.value }?.key

    companion object {
        fun from(o: JSONObject): CUDay? {
            val date = o.str("date") ?: return null
            val prov = LinkedHashMap<String, Double>()
            for (k in o.keys()) {
                if (k == "date" || k == "total" || k == "oxylabs") continue
                val v = o.flexDouble(k) ?: continue
                if (v != 0.0) prov[k] = v
            }
            return CUDay(date, prov)
        }
    }
}

private class CUModelRow(
    val modelId: String, val label: String, val provider: String,
    val monthUsd: Double, val todayUsd: Double,
) {
    companion object {
        fun from(o: JSONObject): CUModelRow? {
            val id = o.str("modelId") ?: return null
            return CUModelRow(
                id, o.str("label") ?: id, o.str("provider") ?: "",
                o.flexDouble("monthUsd") ?: 0.0, o.flexDouble("todayUsd") ?: 0.0,
            )
        }
    }
}

private class CUSummary(
    val todayUsd: Double, val monthUsd: Double, val forecastUsd: Double,
    val dailyLast30: List<CUDay>, val byModel: List<CUModelRow>,
    val budgetDailyUsd: Double?, val budgetMonthlyUsd: Double?,
    val dailyBudgetPct: Double?, val monthlyBudgetPct: Double?,
) {
    companion object {
        fun from(o: JSONObject): CUSummary {
            val budgets = o.optJSONObject("budgets")
            return CUSummary(
                todayUsd = o.flexDouble("todayUsd") ?: 0.0,
                monthUsd = o.flexDouble("monthUsd") ?: 0.0,
                forecastUsd = o.flexDouble("forecastUsd") ?: 0.0,
                dailyLast30 = o.optJSONArray("dailyLast30")?.mapObjects { CUDay.from(it) } ?: emptyList(),
                byModel = o.optJSONArray("byModel")?.mapObjects { CUModelRow.from(it) } ?: emptyList(),
                budgetDailyUsd = budgets?.flexDouble("dailyUsd"),
                budgetMonthlyUsd = budgets?.flexDouble("monthlyUsd"),
                dailyBudgetPct = o.flexDouble("dailyBudgetPct"),
                monthlyBudgetPct = o.flexDouble("monthlyBudgetPct"),
            )
        }
    }
}

private class CUBalanceRow(
    val id: String, val label: String,
    val balanceUsd: Double?, val todayUsd: Double?, val monthUsd: Double?,
    val free: Boolean,
) {
    companion object {
        fun from(o: JSONObject): CUBalanceRow? {
            val id = o.str("id") ?: return null
            return CUBalanceRow(
                id, o.str("label") ?: id,
                o.flexDouble("balanceUsd"), o.flexDouble("todayUsd"), o.flexDouble("monthUsd"),
                o.flexBool("free") ?: false,
            )
        }
    }
}

/** One ledger event — normalized fields + the FULL raw `units` JSON as stored in DB. */
private class CUUsageEvent(
    val id: String, val occurredAt: String, val provider: String, val kind: String,
    val kindLabel: String?, val modelId: String?, val model: String?, val taskLabel: String?,
    val costUsd: Double, val inputTokens: Int?, val outputTokens: Int?,
    val cacheReadTokens: Int?, val cacheWriteTokens: Int?, val ok: Boolean?,
    val conversationId: String?, val jobId: String?, val units: JSONObject?,
) {
    /** Short display model: drop any vendor prefix ("deepseek/deepseek-chat" → tail). */
    val shortModel: String
        get() {
            val raw = modelId ?: model ?: ""
            if (raw.isEmpty()) return CULabel.provider(provider)
            val slash = raw.lastIndexOf('/')
            return if (slash in 0 until raw.length - 1) raw.substring(slash + 1) else raw
        }

    companion object {
        fun from(o: JSONObject): CUUsageEvent {
            val occurredAt = o.str("occurredAt") ?: ""
            val provider = o.str("provider") ?: ""
            val kind = o.str("kind") ?: ""
            return CUUsageEvent(
                id = o.str("id") ?: "$provider-$occurredAt-$kind",
                occurredAt = occurredAt, provider = provider, kind = kind,
                kindLabel = o.str("kindLabel"), modelId = o.str("modelId"),
                model = o.str("model"), taskLabel = o.str("taskLabel"),
                costUsd = o.flexDouble("costUsd") ?: 0.0,
                inputTokens = o.flexInt("inputTokens"), outputTokens = o.flexInt("outputTokens"),
                cacheReadTokens = o.flexInt("cacheReadTokens"), cacheWriteTokens = o.flexInt("cacheWriteTokens"),
                ok = o.flexBool("ok"),
                conversationId = o.str("conversationId"), jobId = o.str("jobId"),
                units = o.optJSONObject("units"),
            )
        }
    }
}

private class CUBucket(val start: String, val calls: Int, val costUsd: Double) {
    companion object {
        fun from(o: JSONObject) = CUBucket(
            o.str("start") ?: "", o.flexInt("calls") ?: 0, o.flexDouble("costUsd") ?: 0.0,
        )
    }
}

// ── Ranges ───────────────────────────────────────────────────────────────────────────

private enum class CURange(val label: String) { D1("1D"), D7("7D"), D30("30D"), CUSTOM("Custom") }

/** OpenRouter-spirit log ranges. Presets slide with "now"; shortcuts anchor Dhaka days. */
private enum class CULogRange(val label: String) {
    M15("Past 15m"), M30("Past 30m"), H1("Past 1h"), H3("Past 3h"),
    D1("Past 1d"), D2("Past 2d"), W1("Past 1w"), MO1("Past 1mo"),
    TODAY("Today"), YESTERDAY("Yesterday"), THIS_WEEK("This Week"), THIS_MONTH("This Month"),
    CUSTOM("Custom");

    companion object {
        // PITFALL: stored companion lists crash — getters only.
        val presets: List<CULogRange> get() = listOf(M15, M30, H1, H3, D1, D2, W1, MO1)
        val shortcuts: List<CULogRange> get() = listOf(TODAY, YESTERDAY, THIS_WEEK, THIS_MONTH)
    }

    /** Resolve to a concrete [from, to] epoch-ms window at call time (Asia/Dhaka). */
    fun window(customFromMs: Long, customToMs: Long): Pair<Long, Long> {
        val now = System.currentTimeMillis()
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Dhaka"))
        cal.timeInMillis = now

        fun startOfDay(): Long {
            val c = cal.clone() as Calendar
            c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
            c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
            return c.timeInMillis
        }
        return when (this) {
            M15 -> (now - 15 * 60_000L) to now
            M30 -> (now - 30 * 60_000L) to now
            H1 -> (now - 3_600_000L) to now
            H3 -> (now - 3 * 3_600_000L) to now
            D1 -> (now - 86_400_000L) to now
            D2 -> (now - 2 * 86_400_000L) to now
            W1 -> (now - 7 * 86_400_000L) to now
            MO1 -> {
                val c = cal.clone() as Calendar
                c.add(Calendar.MONTH, -1)
                c.timeInMillis to now
            }
            TODAY -> startOfDay() to now
            YESTERDAY -> (startOfDay() - 86_400_000L) to startOfDay()
            THIS_WEEK -> {
                val c = cal.clone() as Calendar
                c.set(Calendar.DAY_OF_WEEK, c.firstDayOfWeek)
                c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
                c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
                c.timeInMillis to now
            }
            THIS_MONTH -> {
                val c = cal.clone() as Calendar
                c.set(Calendar.DAY_OF_MONTH, 1)
                c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
                c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
                c.timeInMillis to now
            }
            CUSTOM -> minOf(customFromMs, customToMs) to maxOf(customFromMs, customToMs)
        }
    }
}

// ── State holder (iOS CreditUsageVM twin) ────────────────────────────────────────────

private class CreditUsageState {
    var summary by mutableStateOf<CUSummary?>(null)
    var balances by mutableStateOf(listOf<CUBalanceRow>())
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var balancesRefreshing by mutableStateOf(false)

    var range by mutableStateOf(CURange.D30)
    var customFromMs by mutableStateOf(System.currentTimeMillis() - 7 * 86_400_000L)
    var customToMs by mutableStateOf(System.currentTimeMillis())

    // ── Logs explorer (owner default: Past 1 hour, never huge) ──
    var logRange by mutableStateOf(CULogRange.H1)
    var logCustomFromMs by mutableStateOf(System.currentTimeMillis() - 86_400_000L)
    var logCustomToMs by mutableStateOf(System.currentTimeMillis())
    var live by mutableStateOf(false)
    var logFilter by mutableStateOf("সব")
    var usageEvents by mutableStateOf(listOf<CUUsageEvent>())
    var buckets by mutableStateOf(listOf<CUBucket>())
    var totalCalls by mutableStateOf<Int?>(null)
    var totalCostUsd by mutableStateOf<Double?>(null)
    var nextCursor by mutableStateOf<String?>(null)
    var logsLoading by mutableStateOf(false)
    var loadingMore by mutableStateOf(false)
    var logsError by mutableStateOf<String?>(null)
    var windowFromMs by mutableStateOf(System.currentTimeMillis() - 3_600_000L)
    var windowToMs by mutableStateOf(System.currentTimeMillis())

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            summary = CUSummary.from(unwrap(AlmaApi.getObject("/api/assistant/costs/summary")))
            authExpired = false
            try {
                val b = unwrap(AlmaApi.getObject("/api/assistant/costs/balances"))
                balances = b.optJSONArray("providers")?.mapObjects { CUBalanceRow.from(it) } ?: balances
            } catch (_: Exception) { /* balances are best-effort */ }
            loadUsageLogs()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Native budget config — web saveBudget parity: PUT {dailyUsd, monthlyUsd} (null clears). */
    suspend fun saveBudget(daily: Double?, monthly: Double?) {
        try {
            val body = JSONObject()
                .put("dailyUsd", daily ?: JSONObject.NULL)
                .put("monthlyUsd", monthly ?: JSONObject.NULL)
            AlmaApi.send("PUT", "/api/assistant/costs/budget", body)
            load()
        } catch (e: Exception) {
            error = "বাজেট সংরক্ষণ ব্যর্থ"
        }
    }

    /** Web's manual "refresh balances" — POST forces the provider fetch (20s poll only reads cache). */
    suspend fun refreshBalances() {
        if (balancesRefreshing) return
        balancesRefreshing = true
        try {
            val b = unwrap(AlmaApi.send("POST", "/api/assistant/costs/balances"))
            balances = b.optJSONArray("providers")?.mapObjects { CUBalanceRow.from(it) } ?: balances
        } catch (_: Exception) {
        } finally {
            balancesRefreshing = false
        }
    }

    /** First page (reset) or next page. Load-more keeps the SAME window the first page
     *  resolved, so keyset pagination stays consistent while "Past X" slides with the clock. */
    suspend fun loadUsageLogs(reset: Boolean = true) {
        if (reset) {
            logsLoading = true
        } else {
            if (nextCursor == null || loadingMore) return
            loadingMore = true
        }
        logsError = null
        if (reset) {
            val (f, t) = logRange.window(logCustomFromMs, logCustomToMs)
            windowFromMs = f
            windowToMs = t
        }
        val q = mutableMapOf<String, String?>(
            "from" to CUFormat.isoString(windowFromMs),
            "to" to CUFormat.isoString(windowToMs),
            "limit" to "100",
        )
        if (!reset) q["cursor"] = nextCursor
        try {
            val page = unwrap(AlmaApi.getObject("/api/assistant/usage-logs", q))
            val events = page.optJSONArray("events")?.mapObjects { CUUsageEvent.from(it) } ?: emptyList()
            if (reset) {
                usageEvents = events
                buckets = page.optJSONArray("buckets")?.mapObjects { CUBucket.from(it) } ?: emptyList()
                totalCalls = page.flexInt("totalCalls")
                totalCostUsd = page.flexDouble("totalCostUsd")
            } else {
                val known = usageEvents.map { it.id }.toSet()
                usageEvents = usageEvents + events.filter { it.id !in known }
            }
            nextCursor = page.str("nextCursor")
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: AlmaApiException.Http) {
            logsError = if (e.status == 404) {
                // Route not on the production deploy yet — calm Bangla notice, never raw HTML.
                "লগ ফিড এখনো সার্ভারে লাইভ হয়নি — ওয়েব আপডেট ডিপ্লয় হলে এখানে দেখা যাবে।"
            } else {
                e.message
            }
        } catch (e: Exception) {
            logsError = e.message
        } finally {
            logsLoading = false
            loadingMore = false
        }
    }

    val visibleDays: List<CUDay>
        get() {
            val all = summary?.dailyLast30 ?: return emptyList()
            if (all.isEmpty()) return emptyList()
            return when (range) {
                CURange.D1 -> all.takeLast(1)
                CURange.D7 -> all.takeLast(7)
                CURange.D30 -> all
                CURange.CUSTOM -> {
                    val f = CUFormat.ymd(customFromMs)
                    val t = CUFormat.ymd(customToMs)
                    val lo = minOf(f, t)
                    val hi = maxOf(f, t)
                    all.filter { it.date in lo..hi }
                }
            }
        }
    val rangeTotal: Double get() = visibleDays.sumOf { it.plottedTotal }
    val avgPerDay: Double get() = rangeTotal / maxOf(visibleDays.size, 1)
    val rangeByProvider: List<Pair<String, Double>>
        get() {
            val acc = LinkedHashMap<String, Double>()
            for (d in visibleDays) for ((k, v) in d.providers) acc[k] = (acc[k] ?: 0.0) + v
            return acc.entries.sortedByDescending { it.value }.map { it.key to it.value }
        }
    val stackOrder: List<String> get() = rangeByProvider.map { it.first }

    val filteredUsageEvents: List<CUUsageEvent>
        get() {
            if (logFilter == "সব") return usageEvents
            return usageEvents.filter { e ->
                when (logFilter) {
                    "Gemini" -> e.provider == "gemini"
                    "Anthropic" -> e.provider == "anthropic"
                    "OpenRouter" -> e.provider == "openrouter"
                    "Voice" -> e.provider == "google_tts" ||
                        listOf("tts", "stt", "whisper").any { e.kind.lowercase().contains(it) }
                    "Image" -> e.kind.lowercase().contains("image")
                    "ব্যর্থ" -> e.ok == false
                    else -> true
                }
            }
        }

    /** > 1 day window → log rows show the date next to HH:mm:ss. */
    val windowSpansDays: Boolean get() = windowToMs - windowFromMs > 86_460_000L
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CreditUsageScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { CreditUsageState() }
    val scope = rememberCoroutineScope()
    var pane by remember { mutableStateOf(0) }
    var selectedBar by remember { mutableStateOf<Int?>(null) }
    var detailEvent by remember { mutableStateOf<CUUsageEvent?>(null) }
    var editingBudget by remember { mutableStateOf(false) }
    var budgetDailyDraft by remember { mutableStateOf("") }
    var budgetMonthlyDraft by remember { mutableStateOf("") }
    // Sequential custom-range picks: 0 = closed, 1 = from, 2 = to (Orders pattern).
    var usagePickStep by remember { mutableStateOf(0) }
    var logPickStep by remember { mutableStateOf(0) }

    LaunchedEffect(Unit) { vm.load() }

    // Live mode: ~10s auto-refresh of the first log page while ON.
    LaunchedEffect(vm.live, pane) {
        if (vm.live && pane == 1) {
            while (true) {
                delay(10_000)
                if (!vm.logsLoading && !vm.loadingMore) vm.loadUsageLogs()
            }
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            CUSegment(listOf("Usage", "Logs"), pane, dark) { pane = it }
        }
        if (vm.authExpired) {
            item { CUAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { item { CUErrorCard(it, dark) } }
        if (vm.loading && vm.summary == null) {
            items(3) { Box(Modifier.fillMaxWidth().height(120.dp).cuSolid(dark, 18)) }
        }

        if (pane == 0) {
            // ═══ USAGE ═══
            vm.summary?.let { s ->
                item {
                    SpendHero(
                        s, vm, dark,
                        selectedBar = selectedBar,
                        onSelectBar = { selectedBar = if (selectedBar == it) null else it },
                        onRange = { r ->
                            vm.range = r
                            selectedBar = null
                            if (r == CURange.CUSTOM) usagePickStep = 1
                        },
                        onCustomTap = { usagePickStep = 1 },
                    )
                }
                if (vm.balances.isNotEmpty()) {
                    item { WalletRow(vm.balances, vm.balancesRefreshing, dark) { scope.launch { vm.refreshBalances() } } }
                }
                item { StatTrio(s, dark) }
                if (s.byModel.isNotEmpty()) {
                    item { ModelBreakdown(s.byModel, dark) }
                }
                item {
                    BudgetCard(s, dark) {
                        budgetDailyDraft = s.budgetDailyUsd?.let { String.format(Locale.US, "%.2f", it) } ?: ""
                        budgetMonthlyDraft = s.budgetMonthlyUsd?.let { String.format(Locale.US, "%.2f", it) } ?: ""
                        editingBudget = true
                    }
                }
            }
        } else {
            // ═══ LOGS ═══
            item {
                LogRangeBar(
                    vm, dark,
                    onPick = { r ->
                        if (r == CULogRange.CUSTOM) {
                            logPickStep = 1
                        } else {
                            vm.logRange = r
                            scope.launch { vm.loadUsageLogs() }
                        }
                    },
                    onToggleLive = {
                        vm.live = !vm.live
                        if (vm.live) scope.launch { vm.loadUsageLogs() }
                    },
                )
            }
            item { ActivityCard(vm, dark) }
            item { LogFilterChips(vm, dark) }
            vm.logsError?.let { item { CUErrorCard(it, dark) } }
            if (vm.logsLoading && vm.usageEvents.isEmpty()) {
                items(3) { Box(Modifier.fillMaxWidth().height(120.dp).cuSolid(dark, 18)) }
            } else if (vm.filteredUsageEvents.isEmpty()) {
                item {
                    Text(
                        "এই রেঞ্জে কোনো ইভেন্ট নেই",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 30.dp),
                    )
                }
            } else {
                item {
                    // One SOLID ledger card holding every row (iOS design parity).
                    Column(Modifier.fillMaxWidth().cuSolid(dark, 18)) {
                        vm.filteredUsageEvents.forEach { e ->
                            UsageRow(e, vm.windowSpansDays, dark) { detailEvent = e }
                        }
                    }
                }
            }
            if (vm.nextCursor != null && !vm.logsLoading) {
                item {
                    Text(
                        if (vm.loadingMore) "লোড হচ্ছে…" else "আরো দেখুন",
                        color = CUPalette.accentText(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { if (!vm.loadingMore) scope.launch { vm.loadUsageLogs(reset = false) } }
                            .padding(vertical = 12.dp),
                    )
                }
            }
        }

        item {
            // Web escape: budget config / CSV stay on the web.
            Text(
                "🌐 বাজেট কনফিগ / CSV — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { ctx.openWebForced("/agent/costs", "Costs") }
                    .padding(vertical = 12.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    // ── Budget editor (iOS alert parity) ──
    if (editingBudget) {
        AlertDialog(
            onDismissRequest = { editingBudget = false },
            title = { Text("Budget (USD)") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = budgetDailyDraft, onValueChange = { budgetDailyDraft = it },
                        label = { Text("Daily USD (খালি = নেই)") }, singleLine = true,
                    )
                    OutlinedTextField(
                        value = budgetMonthlyDraft, onValueChange = { budgetMonthlyDraft = it },
                        label = { Text("Monthly USD (খালি = নেই)") }, singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    editingBudget = false
                    scope.launch {
                        vm.saveBudget(budgetDailyDraft.trim().toDoubleOrNull(), budgetMonthlyDraft.trim().toDoubleOrNull())
                    }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editingBudget = false }) { Text("বাতিল") } },
        )
    }

    // ── Log detail sheet: EVERY stored DB field, raw truth ──
    detailEvent?.let { e ->
        ModalBottomSheet(onDismissRequest = { detailEvent = null }, containerColor = AlmaTheme.rootBg(dark)) {
            LogDetailSheet(e, dark)
        }
    }

    // ── Custom range pickers (two sequential date picks — Orders pattern) ──
    if (usagePickStep > 0) {
        key(usagePickStep) {
            CUDatePick(
                title = if (usagePickStep == 1) "শুরু" else "শেষ",
                initialMs = if (usagePickStep == 1) vm.customFromMs else vm.customToMs,
                onDismiss = { usagePickStep = 0 },
            ) { ms ->
                if (usagePickStep == 1) {
                    vm.customFromMs = ms
                    usagePickStep = 2
                } else {
                    vm.customToMs = ms + 86_399_000L
                    vm.range = CURange.CUSTOM
                    selectedBar = null
                    usagePickStep = 0
                }
            }
        }
    }
    if (logPickStep > 0) {
        key(logPickStep + 10) {
            CUDatePick(
                title = if (logPickStep == 1) "শুরু" else "শেষ",
                initialMs = if (logPickStep == 1) vm.logCustomFromMs else vm.logCustomToMs,
                onDismiss = { logPickStep = 0 },
            ) { ms ->
                if (logPickStep == 1) {
                    vm.logCustomFromMs = ms
                    logPickStep = 2
                } else {
                    vm.logCustomToMs = minOf(ms + 86_399_000L, System.currentTimeMillis())
                    vm.logRange = CULogRange.CUSTOM
                    logPickStep = 0
                    scope.launch { vm.loadUsageLogs() }
                }
            }
        }
    }
}

// ── Usage pane blocks ───────────────────────────────────────────────────────────────

@Composable
private fun SpendHero(
    s: CUSummary,
    vm: CreditUsageState,
    dark: Boolean,
    selectedBar: Int?,
    onSelectBar: (Int) -> Unit,
    onRange: (CURange) -> Unit,
    onCustomTap: () -> Unit,
) {
    val days = vm.visibleDays
    val sel = selectedBar?.let { days.getOrNull(it) }
    val shown = sel?.plottedTotal ?: if (vm.range == CURange.D1) s.todayUsd else vm.rangeTotal

    Column(Modifier.fillMaxWidth().cuRaised(dark, AlmaTheme.R_CARD).padding(18.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(
                "এই সময়ের খরচ · CREDIT USAGE",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            // Range switch (glass pill).
            Row(
                Modifier.almaGlass(dark, 10).padding(2.dp),
                horizontalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                CURange.values().forEach { r ->
                    val on = vm.range == r
                    Text(
                        r.label,
                        color = if (on) AlmaTheme.ink(dark) else AlmaTheme.inkSecondary(dark),
                        fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(7.dp))
                            .background(if (on) Color.White.copy(alpha = if (dark) 0.12f else 0.5f) else Color.Transparent)
                            .plainClick { onRange(r) }
                            .padding(horizontal = 9.dp, vertical = 5.dp),
                    )
                }
            }
        }
        Text(
            CUFormat.usd(shown),
            color = CUPalette.accentText(dark), fontSize = 44.sp, fontWeight = FontWeight.Bold,
            maxLines = 1,
            modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
        )
        if (sel != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(CUPalette.provider(sel.topProvider ?: "")))
                Text(
                    "${CUFormat.dayLabel(sel.date)} · ${CULabel.provider(sel.topProvider ?: "")} শীর্ষে",
                    color = CUPalette.accentText(dark), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
                )
            }
        } else {
            Text(
                when (vm.range) {
                    CURange.D1 -> "আজকের খরচ · একটি bar-এ ট্যাপ করুন →"
                    CURange.CUSTOM -> "${days.size} দিন · গড় ${CUFormat.usd(vm.avgPerDay)}/দিন"
                    else -> "পূর্বাভাস ~${CUFormat.usd(s.forecastUsd)} · গড় ${CUFormat.usd(vm.avgPerDay)}/দিন · ট্যাপ →"
                },
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        if (vm.range == CURange.CUSTOM) {
            Text(
                "📅 ${CUFormat.pretty(vm.customFromMs)} – ${CUFormat.pretty(vm.customToMs)} ▾",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .padding(top = 12.dp)
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick(onCustomTap)
                    .padding(horizontal = 13.dp, vertical = 9.dp),
            )
        }
        StackedDailyChart(days, vm.stackOrder, selectedBar, vm.range == CURange.D1, dark, onSelectBar)
        // Legend (top-6 providers over the range).
        val byProv = vm.rangeByProvider
        if (byProv.isNotEmpty()) {
            Box(Modifier.fillMaxWidth().padding(top = 14.dp).height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.5f)))
            androidx.compose.foundation.layout.FlowRow(
                Modifier.fillMaxWidth().padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                byProv.take(6).forEach { (p, v) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(CUPalette.provider(p)))
                        Text(CULabel.provider(p), color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        Text(CUFormat.usd(v), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

/** Interactive stacked daily bars — tap to drill, others dim (iOS chart twin). */
@Composable
private fun StackedDailyChart(
    days: List<CUDay>,
    order: List<String>,
    selected: Int?,
    isD1: Boolean,
    dark: Boolean,
    onTap: (Int) -> Unit,
) {
    val gridColor = AlmaTheme.ink(dark).copy(alpha = 0.05f)
    val maxT = maxOf(days.maxOfOrNull { it.plottedTotal } ?: 0.0, 0.0001)
    Column(Modifier.fillMaxWidth().padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.fillMaxWidth().height(118.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                for (i in 0..3) {
                    val y = size.height * i / 4f
                    drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
                }
            }
            if (days.isEmpty()) {
                Text(
                    "এখনো কোনো খরচ নেই",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    modifier = Modifier.align(Alignment.Center),
                )
            } else {
                Row(
                    Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(if (days.size > 20) 2.dp else 3.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    days.forEachIndexed { idx, d ->
                        val frac = (d.plottedTotal / maxT).toFloat()
                        val h = maxOf(118f * frac, if (d.plottedTotal > 0) 3f else 1f)
                        val dimmed = selected != null && selected != idx
                        val total = maxOf(d.plottedTotal, 0.0001)
                        Column(
                            Modifier
                                .weight(1f)
                                .height(h.dp)
                                .clip(RoundedCornerShape(2.5.dp))
                                .alpha(if (dimmed) 0.32f else 1f)
                                .plainClick { onTap(idx) },
                            verticalArrangement = Arrangement.spacedBy(1.dp),
                        ) {
                            val segs = order.reversed().mapNotNull { p ->
                                val v = d.providers[p] ?: 0.0
                                if (v > 0) p to v else null
                            }
                            if (segs.isEmpty()) {
                                Box(Modifier.fillMaxSize().background(AlmaTheme.fill(dark)))
                            } else {
                                segs.forEach { (p, v) ->
                                    Box(
                                        Modifier
                                            .fillMaxWidth()
                                            .weight((v / total).toFloat())
                                            .background(CUPalette.provider(p)),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        if (days.isNotEmpty()) {
            Row {
                Text(CUFormat.axis(days.first().date), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp)
                Spacer(Modifier.weight(1f))
                Text(if (isD1) "এখন" else CUFormat.axis(days.last().date), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp)
            }
        }
    }
}

@Composable
private fun WalletRow(rows: List<CUBalanceRow>, refreshing: Boolean, dark: Boolean, onRefresh: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.padding(horizontal = 3.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Provider ক্রেডিট", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (refreshing) {
                CircularProgressIndicator(Modifier.size(13.dp), color = CUPalette.coral, strokeWidth = 2.dp)
            } else {
                Text(
                    "↻", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick(onRefresh).padding(horizontal = 6.dp),
                )
            }
            Spacer(Modifier.width(6.dp))
            Text("← swipe", color = AlmaTheme.inkTertiary(dark), fontSize = 10.5.sp)
        }
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            rows.forEach { row -> WalletCard(row, dark) }
        }
    }
}

@Composable
private fun WalletCard(row: CUBalanceRow, dark: Boolean) {
    val tint = CUPalette.provider(row.id)
    Column(Modifier.width(158.dp).cuSolid(dark, 17)) {
        // Top accent strip (iOS overlay parity).
        Box(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp)
                .height(2.5.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(tint),
        )
        Column(Modifier.padding(horizontal = 14.dp).padding(top = 11.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.size(24.dp).clip(RoundedCornerShape(7.dp)).background(tint.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(row.label.take(1), color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
                Text(
                    row.label, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text(
                    if (row.free) "FREE" else "LIVE",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 8.sp, fontWeight = FontWeight.Black,
                    modifier = Modifier
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.08f), CircleShape)
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
            Text(
                if (row.free) "Free" else row.balanceUsd?.let { CUFormat.usd(it) } ?: "—",
                color = CUPalette.balance(row.balanceUsd, row.free, dark),
                fontSize = 22.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 13.dp),
            )
            Text(
                "আজ ${CUFormat.usd(row.todayUsd ?: 0.0)} · মাস ${CUFormat.usd(row.monthUsd ?: 0.0)}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.5.sp,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

@Composable
private fun StatTrio(s: CUSummary, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        StatPill("আজ খরচ", CUFormat.usd(s.todayUsd), dark, Modifier.weight(1f))
        StatPill("এই মাস", CUFormat.usd(s.monthUsd), dark, Modifier.weight(1f))
        StatPill("পূর্বাভাস", CUFormat.usd(s.forecastUsd), dark, Modifier.weight(1f))
    }
}

@Composable
private fun StatPill(k: String, v: String, dark: Boolean, modifier: Modifier) {
    Column(modifier.cuSolid(dark, 15).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(k, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        Text(v, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun ModelBreakdown(byModel: List<CUModelRow>, dark: Boolean) {
    val maxMonth = maxOf(byModel.maxOfOrNull { it.monthUsd } ?: 0.0, 0.0001)
    Column(Modifier.fillMaxWidth().cuSolid(dark, 18).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row {
            Text("মডেল অনুযায়ী খরচ", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text("এই মাস", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        byModel.take(8).forEachIndexed { idx, m ->
            val tint = CUPalette.model(idx)
            Column(verticalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.padding(vertical = 3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(tint))
                    Text(
                        m.label, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    Text(CUFormat.usd(m.monthUsd), color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
                    Text("আজ ${CUFormat.usd(m.todayUsd)}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
                Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(AlmaTheme.ink(dark).copy(alpha = 0.06f))) {
                    val frac = (m.monthUsd / maxMonth).toFloat().coerceIn(0f, 1f)
                    if (m.monthUsd > 0) {
                        Box(Modifier.fillMaxWidth(maxOf(frac, 0.02f)).height(6.dp).clip(CircleShape).background(tint))
                    }
                }
            }
            if (idx < minOf(byModel.size, 8) - 1) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.4f)))
            }
        }
    }
}

@Composable
private fun BudgetCard(s: CUSummary, dark: Boolean, onEdit: () -> Unit) {
    val hasDaily = s.dailyBudgetPct != null && s.budgetDailyUsd != null
    val hasMonthly = s.monthlyBudgetPct != null && s.budgetMonthlyUsd != null
    Column(Modifier.fillMaxWidth().cuSolid(dark, 18).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("রিমেইনিং বাজেট", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(
                "⚙", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                modifier = Modifier.plainClick(onEdit).padding(4.dp),
            )
        }
        if (hasMonthly) BudgetRow(s.monthUsd, s.budgetMonthlyUsd!!, s.monthlyBudgetPct!!, "এই মাস", dark)
        if (hasDaily) BudgetRow(s.todayUsd, s.budgetDailyUsd!!, s.dailyBudgetPct!!, "আজ", dark)
        if (!hasDaily && !hasMonthly) {
            Text("বাজেট সেট করা নেই — উপরের বোতামে সেট করুন", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun BudgetRow(spent: Double, cap: Double, pct: Double, label: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            Text(
                "$label · ${CUFormat.usd(maxOf(cap - spent, 0.0))} বাকি",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
            Text(
                "${Math.round(pct)}%",
                color = when {
                    pct >= 100 -> CUPalette.red
                    pct >= 80 -> CUPalette.amber
                    else -> CUPalette.accentText(dark)
                },
                fontSize = 13.sp, fontWeight = FontWeight.Bold,
            )
        }
        Box(Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(AlmaTheme.ink(dark).copy(alpha = 0.07f))) {
            val frac = (pct.coerceIn(0.0, 100.0) / 100.0).toFloat()
            Box(
                Modifier
                    .fillMaxWidth(maxOf(frac, 0.02f))
                    .height(8.dp)
                    .clip(CircleShape)
                    .background(Brush.horizontalGradient(listOf(CUPalette.coral, CUPalette.gold))),
            )
        }
    }
}

// ── Logs pane blocks ────────────────────────────────────────────────────────────────

@Composable
private fun LogRangeBar(
    vm: CreditUsageState,
    dark: Boolean,
    onPick: (CULogRange) -> Unit,
    onToggleLive: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box {
            val chipLabel = if (vm.logRange == CULogRange.CUSTOM) {
                "${CUFormat.prettyDT(vm.logCustomFromMs)} – ${CUFormat.prettyDT(vm.logCustomToMs)}"
            } else {
                vm.logRange.label
            }
            Text(
                "🕐 $chipLabel ▾",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                maxLines = 1,
                modifier = Modifier
                    .almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { menuOpen = true }
                    .padding(horizontal = 13.dp, vertical = 9.dp),
            )
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                CULogRange.presets.forEach { r ->
                    DropdownMenuItem(
                        text = { Text(if (vm.logRange == r) "✓ ${r.label}" else r.label) },
                        onClick = { menuOpen = false; onPick(r) },
                    )
                }
                CULogRange.shortcuts.forEach { r ->
                    DropdownMenuItem(
                        text = { Text(if (vm.logRange == r) "✓ ${r.label}" else r.label) },
                        onClick = { menuOpen = false; onPick(r) },
                    )
                }
                DropdownMenuItem(
                    text = { Text("📅 Custom range…") },
                    onClick = { menuOpen = false; onPick(CULogRange.CUSTOM) },
                )
            }
        }
        Spacer(Modifier.weight(1f))
        // Live chip: green dot pulses while ON.
        Row(
            Modifier
                .almaGlass(dark, AlmaTheme.R_CONTROL)
                .border(
                    1.dp,
                    if (vm.live) CUPalette.emerald.copy(alpha = 0.55f) else Color.Transparent,
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick(onToggleLive)
                .padding(horizontal = 13.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            CULiveDot(vm.live, dark)
            Text(
                "Live",
                color = if (vm.live) CUPalette.emerald else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun CULiveDot(on: Boolean, dark: Boolean) {
    Box(Modifier.size(9.dp), contentAlignment = Alignment.Center) {
        if (on) {
            val transition = rememberInfiniteTransition(label = "liveDot")
            val pulse by transition.animateFloat(
                initialValue = 1f, targetValue = 0.3f,
                animationSpec = infiniteRepeatable(tween(1400), RepeatMode.Reverse),
                label = "liveDotPulse",
            )
            Box(Modifier.size(9.dp).alpha(pulse).clip(CircleShape).background(CUPalette.emerald.copy(alpha = 0.5f)))
        }
        Box(
            Modifier.size(7.dp).clip(CircleShape)
                .background(if (on) CUPalette.emerald else AlmaTheme.inkSecondary(dark).copy(alpha = 0.45f)),
        )
    }
}

/** Activity mini-chart: calls per bucket over the selected range. */
@Composable
private fun ActivityCard(vm: CreditUsageState, dark: Boolean) {
    val maxCalls = maxOf(vm.buckets.maxOfOrNull { it.calls } ?: 0, 1)
    val spansDays = vm.windowSpansDays
    Column(Modifier.fillMaxWidth().cuSolid(dark, 18).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "${vm.totalCalls ?: vm.usageEvents.size}",
                color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold,
            )
            Text("কল · এই রেঞ্জে", color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp)
            Spacer(Modifier.weight(1f))
            Text(
                CUFormat.usd(vm.totalCostUsd ?: 0.0),
                color = CUPalette.accentText(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold,
            )
        }
        if (vm.buckets.isEmpty()) {
            Text(
                if (vm.logsLoading) "লোড হচ্ছে…" else "এই রেঞ্জে কোনো কল নেই",
                color = AlmaTheme.inkTertiary(dark), fontSize = 10.5.sp,
                modifier = Modifier.fillMaxWidth().height(44.dp),
            )
        } else {
            Row(
                Modifier.fillMaxWidth().height(44.dp),
                horizontalArrangement = Arrangement.spacedBy(if (vm.buckets.size > 40) 1.5.dp else 2.5.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                vm.buckets.forEach { b ->
                    val h = if (b.calls > 0) maxOf(44f * b.calls / maxCalls, 3f) else 2f
                    Box(
                        Modifier
                            .weight(1f)
                            .height(h.dp)
                            .clip(RoundedCornerShape(1.5.dp))
                            .background(
                                if (b.calls > 0) {
                                    Brush.verticalGradient(listOf(CUPalette.gold, CUPalette.coral))
                                } else {
                                    Brush.verticalGradient(
                                        listOf(
                                            AlmaTheme.ink(dark).copy(alpha = 0.06f),
                                            AlmaTheme.ink(dark).copy(alpha = 0.06f),
                                        ),
                                    )
                                },
                            ),
                    )
                }
            }
        }
        Row {
            Text(CUFormat.windowAxis(vm.windowFromMs, spansDays), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp)
            Spacer(Modifier.weight(1f))
            Text(CUFormat.windowAxis(vm.windowToMs, spansDays), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp)
        }
    }
}

@Composable
private fun LogFilterChips(vm: CreditUsageState, dark: Boolean) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        listOf("সব", "Gemini", "Anthropic", "OpenRouter", "Voice", "Image", "ব্যর্থ").forEach { f ->
            val on = vm.logFilter == f
            Text(
                f,
                color = if (on) CUPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
                fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(
                        if (on) CUPalette.coral.copy(alpha = 0.16f) else AlmaTheme.ink(dark).copy(alpha = 0.05f),
                        CircleShape,
                    )
                    .border(
                        1.dp,
                        if (on) CUPalette.coral.copy(alpha = 0.4f) else Color.Transparent,
                        CircleShape,
                    )
                    .plainClick { vm.logFilter = f }
                    .padding(horizontal = 13.dp, vertical = 7.dp),
            )
        }
    }
}

@Composable
private fun UsageRow(e: CUUsageEvent, withDate: Boolean, dark: Boolean, onTap: () -> Unit) {
    val tint = CUPalette.provider(e.provider)
    Column(Modifier.fillMaxWidth().plainClick(onTap)) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            Box(
                Modifier.size(31.dp).clip(RoundedCornerShape(9.dp)).background(tint.copy(alpha = 0.10f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(CULabel.icon(e.kind, e.provider), fontSize = 13.sp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        e.shortModel, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        e.taskLabel ?: CULabel.roleTag(e.kind),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 8.5.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        modifier = Modifier
                            .background(AlmaTheme.ink(dark).copy(alpha = 0.08f), CircleShape)
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(CUFormat.logTime(e.occurredAt, withDate), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    e.inputTokens?.let { Text("↓${CUFormat.tok(it)}", color = CUPalette.sage, fontSize = 10.sp) }
                    e.outputTokens?.let { Text("↑${CUFormat.tok(it)}", color = CUPalette.violet, fontSize = 10.sp) }
                    e.cacheReadTokens?.takeIf { it > 0 }?.let {
                        Text("⚡${CUFormat.tok(it)}", color = AlmaTheme.inkTertiary(dark), fontSize = 10.sp)
                    }
                }
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(CUFormat.usd(e.costUsd), color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                e.ok?.let { ok ->
                    Text(
                        if (ok) "● সফল" else "● ব্যর্থ",
                        color = if (ok) CUPalette.emerald else CUPalette.red,
                        fontSize = 8.5.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        Box(
            Modifier.fillMaxWidth().padding(start = 14.dp).height(1.dp)
                .background(AlmaTheme.separator(dark).copy(alpha = 0.4f)),
        )
    }
}

/** Detail sheet: EVERY stored DB field, raw truth — never fabricate a field. */
@Composable
private fun LogDetailSheet(e: CUUsageEvent, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("লগ বিস্তারিত", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)

        CUDetailSection("ইভেন্ট", dark) {
            CUDetailRow("সময়", CUFormat.fullDT(e.occurredAt), dark)
            CUDetailRow("Provider", CULabel.provider(e.provider), dark)
            CUDetailRow("Kind", e.kindLabel?.let { "${e.kind} · $it" } ?: e.kind, dark)
            e.modelId?.let { CUDetailRow("Model", it, dark) }
            e.model?.takeIf { it != e.modelId }?.let { CUDetailRow("Model label", it, dark) }
            CUDetailRow("Cost (USD)", CUFormat.usdFull(e.costUsd), dark)
        }
        CUDetailSection("টোকেন", dark) {
            CUDetailRow("Input", e.inputTokens?.toString() ?: "—", dark)
            CUDetailRow("Output", e.outputTokens?.toString() ?: "—", dark)
            CUDetailRow("Cache read", e.cacheReadTokens?.toString() ?: "—", dark)
            CUDetailRow("Cache write", e.cacheWriteTokens?.toString() ?: "—", dark)
        }
        CUDetailSection("Raw — units (DB)", dark) {
            val units = e.units
            if (units == null || units.length() == 0) {
                Text("খালি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                units.keys().asSequence().sorted().forEach { k ->
                    CUDetailRow(k, cuJsonDisplay(units.opt(k)), dark)
                }
            }
        }
        CUDetailSection("রেফারেন্স", dark) {
            CUDetailRow("Event ID", e.id, dark)
            e.conversationId?.let { CUDetailRow("Conversation", it, dark) }
            e.jobId?.let { CUDetailRow("Message/Job", it, dark) }
        }
    }
}

@Composable
private fun CUDetailSection(title: String, dark: Boolean, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Text(title.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        content()
    }
}

@Composable
private fun CUDetailRow(k: String, v: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(k.uppercase(), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
        Text(v, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
    }
}

/** iOS CUJSON.display twin — raw DB value shown verbatim (ints without trailing .0). */
private fun cuJsonDisplay(v: Any?): String = when (v) {
    null, JSONObject.NULL -> "null"
    is Boolean -> if (v) "true" else "false"
    is Double -> if (v == Math.floor(v) && Math.abs(v) < 1e15) v.toLong().toString() else v.toString()
    is JSONObject -> "{" + v.keys().asSequence().sorted()
        .joinToString(", ") { "$it: ${cuJsonDisplay(v.opt(it))}" } + "}"
    is JSONArray -> "[" + (0 until v.length()).joinToString(", ") { cuJsonDisplay(v.opt(it)) } + "]"
    else -> v.toString()
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun CUSegment(items: List<String>, selection: Int, dark: Boolean, onSelect: (Int) -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        items.forEachIndexed { i, t ->
            val on = selection == i
            Text(
                t,
                color = if (on) AlmaTheme.ink(dark) else AlmaTheme.inkSecondary(dark),
                fontSize = 13.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(11.dp))
                    .background(if (on) Color.White.copy(alpha = if (dark) 0.14f else 0.7f) else Color.Transparent)
                    .plainClick { onSelect(i) }
                    .padding(vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun CUAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().cuSolid(dark, 16).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(CUPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun CUErrorCard(msg: String, dark: Boolean) {
    Text(
        "⚠ $msg",
        color = CUPalette.red, fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().cuSolid(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CUDatePick(title: String, initialMs: Long, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = initialMs)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = { state.selectedDateMillis?.let(onPick) ?: onDismiss() }) { Text("প্রয়োগ") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("বাতিল") } },
    ) {
        DatePicker(state = state, title = { Text(title, Modifier.padding(16.dp)) })
    }
}

// ── Solid / raised surfaces (iOS cuSolid / cuRaised twins — glass = shared almaGlass) ─

private fun Modifier.cuSolid(dark: Boolean, corner: Int): Modifier {
    val shape = RoundedCornerShape(corner.dp)
    return this
        .clip(shape)
        .background(if (dark) Color(0xFF14121D) else Color.White)
        .border(1.dp, Color.White.copy(alpha = if (dark) 0.055f else 0.6f), shape)
}

private fun Modifier.cuRaised(dark: Boolean, corner: Int): Modifier {
    val shape = RoundedCornerShape(corner.dp)
    return this
        .clip(shape)
        .background(
            if (dark) {
                Brush.verticalGradient(listOf(Color(0xFF1B1826), Color(0xFF141019)))
            } else {
                Brush.verticalGradient(listOf(Color.White, Color.White))
            },
        )
        .border(1.dp, Color.White.copy(alpha = if (dark) 0.07f else 0.7f), shape)
}

// ── Formatting (Asia/Dhaka; Bangla month labels where iOS used bn_BD) ───────────────

private object CUFormat {
    fun usd(n: Double): String {
        val digits = if (n < 0.01 && n > 0) 4 else 2
        return "$" + String.format(Locale.US, "%.${digits}f", n)
    }

    /** Full-precision USD for the detail sheet — cost_usd is Decimal(10,6) in the DB. */
    fun usdFull(n: Double): String = "$" + String.format(Locale.US, "%.6f", n)

    fun tok(n: Int): String =
        if (n >= 1000) String.format(Locale.US, "%.1fk", n / 1000.0) else "$n"

    private fun dhaka(pattern: String, locale: Locale = Locale.US): SimpleDateFormat =
        SimpleDateFormat(pattern, locale).apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }

    fun ymd(ms: Long): String = dhaka("yyyy-MM-dd").format(Date(ms))

    fun pretty(ms: Long): String = dhaka("d MMM", Locale("bn", "BD")).format(Date(ms))

    fun axis(ymd: String): String = if (ymd.length > 5) ymd.substring(5) else ymd

    /** "2026-07-05" → Bangla "৫ জুলাই" for the drill-down readout. */
    fun dayLabel(ymd: String): String {
        val d = try { dhaka("yyyy-MM-dd").parse(ymd) } catch (_: Exception) { null } ?: return axis(ymd)
        return dhaka("d MMM", Locale("bn", "BD")).format(d)
    }

    fun parseIso(iso: String?): Date? {
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

    fun isoString(ms: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(ms))

    /** Log-row time: HH:mm:ss, date prefixed when the window spans > 1 day. */
    fun logTime(iso: String, withDate: Boolean): String {
        val d = parseIso(iso) ?: return ""
        return dhaka(if (withDate) "d MMM · HH:mm:ss" else "HH:mm:ss").format(d)
    }

    fun windowAxis(ms: Long, spansDays: Boolean): String =
        dhaka(if (spansDays) "d MMM HH:mm" else "HH:mm").format(Date(ms))

    fun prettyDT(ms: Long): String = dhaka("d MMM HH:mm").format(Date(ms))

    fun fullDT(iso: String): String {
        val d = parseIso(iso) ?: return iso
        return dhaka("d MMM yyyy · HH:mm:ss").format(d)
    }
}
