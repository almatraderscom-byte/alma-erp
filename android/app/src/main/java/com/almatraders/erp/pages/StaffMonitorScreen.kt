//
//  StaffMonitorScreen.kt
//  ALMA ERP — Staff Monitor ported 1:1 from StaffMonitorSwiftUI.swift (design truth).
//
//  Endpoints (same as web/iOS):
//    GET /api/agent/staff-monitor                 → live staff summaries + geo + feed
//    GET /api/agent/staff-monitor?date=YYYY-MM-DD → archived day summary
//  Owner control panels (safety-critical essentials, iOS parity):
//    GET+PATCH /api/assistant/controls            {paused} — master PAUSE/RESUME;
//              autonomy + capabilities READ-ONLY, changes stay web-escaped
//    GET+POST  /api/assistant/live-browser/watch  {action: stop|resume} — emergency STOP
//    GET       /api/assistant/heartbeat?limit=1   → settings.enabled + wakesToday
//    GET       /api/assistant/models              → on/off count status row
//  Every payload tolerates the { ok, data:{…} } wrap. Every mutating action passes a
//  Bangla confirm dialog first, and the SERVER'S echoed state is what the UI shows —
//  never an optimistic flip (claim-verifier ethos).
//  Blocks: Live/Archive day chips · KPI strip (active/tasks/unacked/staff) · owner
//  control panels · geo-fence note · staff cards (initial avatar + live status dot +
//  day-progress bar + Bangla location line) · productivity alerts · per-staff detail
//  sheet (progress, location + maps link, alerts, today's messages with ack badges) ·
//  web escape. Carried lessons: lenient org.json decoding, silent 10s ticks never
//  blank a working screen.
//

package com.almatraders.erp.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalUriHandler
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
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object SmPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val teal = Color(0xFF81B29A)             // web progress-gradient end
    val sky500 = Color(0xFF0EA5E9)           // driving dot

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web MonitorStaffCards statusInfo() — same precedence, same labels. */
    fun status(s: SmSummary, dark: Boolean): Pair<Color, String> = when {
        s.driving == true -> sky500 to "🚗 Driving"
        s.checkedIn == false -> AlmaTheme.inkSecondary(dark) to "Awaiting"
        s.failed > 0 -> red500 to "Issues"
        s.completionPct >= 100 -> emerald600 to "Complete"
        s.started && s.completionPct >= 50 -> amber500 to "Working"
        s.started -> amber500 to "Started"
        else -> AlmaTheme.inkSecondary(dark) to "Idle"
    }

    /** Web GEO_LABEL table — Bangla strings verbatim. (icon, text, color) */
    fun geo(status: String?, dark: Boolean): Triple<String, String, Color> = when (status) {
        "in_zone" -> Triple("✅", "অফিসে", emerald600)
        "outside" -> Triple("🚨", "বাইরে", red500)
        "stale" -> Triple("⏸️", "পুরোনো লোকেশন", amber600)
        else -> Triple("❓", "লোকেশন নেই", AlmaTheme.inkSecondary(dark))
    }
}

// ── Models (same field names as src/agent/lib/staff-monitor-types.ts) ───────────────

/** Web StaffSummary — one staff member's day progress. */
private data class SmSummary(
    val staffId: String,
    val staffName: String,
    val dispatched: Int,
    val delivered: Int,
    val failed: Int,
    val tasksTotal: Int,
    val tasksDone: Int,
    val completionPct: Int,
    val started: Boolean,
    val lastActivityAt: String?,
    val checkedIn: Boolean?,
    val driving: Boolean?,
) {
    companion object {
        fun from(o: JSONObject): SmSummary? { return SmSummary(
            staffId = o.str("staffId") ?: return null,
            staffName = o.str("staffName") ?: "—",
            dispatched = o.flexInt("dispatched") ?: 0,
            delivered = o.flexInt("delivered") ?: 0,
            failed = o.flexInt("failed") ?: 0,
            tasksTotal = o.flexInt("tasksTotal") ?: 0,
            tasksDone = o.flexInt("tasksDone") ?: 0,
            completionPct = o.flexInt("completionPct") ?: 0,
            started = o.flexBool("started") ?: false,
            lastActivityAt = o.str("lastActivityAt"),
            checkedIn = o.flexBool("checkedIn"),
            driving = o.flexBool("driving"),
        ) }
    }
}

/** Web GeoStaffStatus — office geo-fence state per staff. */
private data class SmGeo(
    val staffId: String,
    val status: String,
    val distanceM: Int?,
    val lastUpdate: String?,
    val mapsLink: String?,
) {
    companion object {
        fun from(o: JSONObject): SmGeo? = SmGeo(
            staffId = o.str("staffId") ?: "",
            status = o.str("status") ?: "no_data",
            distanceM = o.flexInt("distanceM"),
            lastUpdate = o.str("lastUpdate"),
            mapsLink = o.str("mapsLink"),
        )
    }
}

/** Web ProductivityAlert — idle / proof-timeout / slow-task nudges. */
private data class SmAlert(
    val staffId: String,
    val staffName: String?,
    val type: String,
    val message: String,
    val at: String?,
) {
    companion object {
        fun from(o: JSONObject): SmAlert? = SmAlert(
            staffId = o.str("staffId") ?: "",
            staffName = o.str("staffName"),
            type = o.str("type") ?: "",
            message = o.str("message") ?: "",
            at = o.str("at"),
        )
    }
}

/** Web StaffMonitorRow (outbox feed slice the detail sheet shows). */
private data class SmFeedRow(
    val id: String,
    val staffId: String?,
    val type: String,
    val content: String,
    val status: String,
    val acknowledgedAt: String?,
    val createdAt: String?,
    val sentAt: String?,
) {
    /** Web TYPE_LABELS — Bangla verbatim. */
    val typeLabel: String
        get() = when (type) {
            "task_dispatch" -> "টাস্ক"
            "announcement" -> "ঘোষণা"
            "reminder" -> "রিমাইন্ডার"
            "presence" -> "প্রেজেন্স"
            "coaching" -> "কোচিং"
            "feedback_ack" -> "ফিডব্যাক"
            "task_redo" -> "রিডু"
            "proof_reminder" -> "প্রমাণ"
            else -> type
        }

    companion object {
        fun from(o: JSONObject): SmFeedRow? { return SmFeedRow(
            id = o.str("id") ?: return null,
            staffId = o.str("staffId"),
            type = o.str("type") ?: "",
            content = o.str("content") ?: "",
            status = o.str("status") ?: "",
            acknowledgedAt = o.str("acknowledgedAt"),
            createdAt = o.str("createdAt"),
            sentAt = o.str("sentAt"),
        ) }
    }
}

/** GET /api/agent/staff-monitor payload. */
private data class SmData(
    val today: String?,
    val historyDates: List<String>,
    val staffSummaries: List<SmSummary>,
    val geoStatus: List<SmGeo>,
    val productivityAlerts: List<SmAlert>,
    val feed: List<SmFeedRow>,
    val historyFeed: List<SmFeedRow>,
    val unackedCount: Int,
    val geoFenceMonitoringEnabled: Boolean?,
    val generatedAt: String?,
) {
    companion object {
        fun from(c: JSONObject): SmData = SmData(
            today = c.str("today"),
            historyDates = c.optJSONArray("historyDates")?.let { arr ->
                (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotEmpty() } }
            } ?: emptyList(),
            staffSummaries = c.optJSONArray("staffSummaries")?.mapObjects { SmSummary.from(it) } ?: emptyList(),
            geoStatus = c.optJSONArray("geoStatus")?.mapObjects { SmGeo.from(it) } ?: emptyList(),
            productivityAlerts = c.optJSONArray("productivityAlerts")?.mapObjects { SmAlert.from(it) } ?: emptyList(),
            feed = c.optJSONArray("feed")?.mapObjects { SmFeedRow.from(it) } ?: emptyList(),
            historyFeed = c.optJSONArray("historyFeed")?.mapObjects { SmFeedRow.from(it) } ?: emptyList(),
            unackedCount = c.optJSONArray("unackedMessages")?.length() ?: 0,
            geoFenceMonitoringEnabled = c.flexBool("geoFenceMonitoringEnabled"),
            generatedAt = c.str("generatedAt"),
        )
    }
}

// ── State holder (iOS StaffMonitorVM twin) ──────────────────────────────────────────

private class StaffMonitorState {
    var data by mutableStateOf<SmData?>(null)
    /** null = live (Today); "YYYY-MM-DD" = archived day summary. */
    var selectedDate by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val isLive: Boolean get() = selectedDate == null

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load(silent: Boolean = false) {
        if (!silent) loading = true
        try {
            val c = unwrap(AlmaApi.getObject("/api/agent/staff-monitor", mapOf("date" to selectedDate)))
            data = SmData.from(c)
            error = null
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            // Silent 10s ticks never blank a working screen with an error banner.
            if (!silent || data == null) error = e.message
        } finally {
            if (!silent) loading = false
        }
    }

    // ── Derived lookups for the cards / detail sheet ──

    fun geo(staffId: String): SmGeo? = data?.geoStatus?.firstOrNull { it.staffId == staffId }
    fun alerts(staffId: String): List<SmAlert> =
        data?.productivityAlerts?.filter { it.staffId == staffId } ?: emptyList()
    fun messages(staffId: String): List<SmFeedRow> {
        val d = data ?: return emptyList()
        val rows = if (d.feed.isNotEmpty()) d.feed else d.historyFeed
        return rows.filter { it.staffId == staffId }
    }

    /** checkedIn may be missing in older payloads — treat undefined as active. */
    val activeCount: Int get() = data?.staffSummaries?.count { it.checkedIn != false } ?: 0
    val tasksDone: Int get() = data?.staffSummaries?.sumOf { it.tasksDone } ?: 0
    val tasksTotal: Int get() = data?.staffSummaries?.sumOf { it.tasksTotal } ?: 0
}

// ── Owner control panels — models + state (web monitor panels' exact shapes) ────────

/** GET/PATCH /api/assistant/controls — web defaulting rule mirrored: paused only when
 *  explicitly true, capabilities ON unless explicitly false, autonomy falls back "ask". */
private data class SmControls(
    val paused: Boolean,
    val autonomy: String,
    val webResearch: Boolean,
    val socialPosting: Boolean,
    val imageVideoGen: Boolean,
) {
    /** Web AUTONOMY_OPTIONS labels verbatim. */
    val autonomyLabel: String
        get() = when (autonomy) {
            "notify" -> "করে জানাও"
            "auto" -> "স্বয়ংক্রিয়"
            else -> "আগে জিজ্ঞেস"
        }

    companion object {
        fun from(c: JSONObject): SmControls {
            val caps = c.optJSONObject("capabilities")
            return SmControls(
                paused = c.flexBool("paused") ?: false,
                autonomy = c.str("autonomy") ?: "ask",
                webResearch = caps?.flexBool("webResearch") ?: true,
                socialPosting = caps?.flexBool("socialPosting") ?: true,
                imageVideoGen = caps?.flexBool("imageVideoGen") ?: true,
            )
        }
    }
}

/** GET /api/assistant/live-browser/watch — status essentials only (the native panel
 *  never reads latestScreenshot: ~100KB dataURL, web-escaped anyway). */
private data class SmWatchStep(val action: String, val target: String, val status: String)

private data class SmWatchFeed(
    val enabled: Boolean,
    val onlineCount: Int,
    val steps: List<SmWatchStep>,
) {
    /** Web LiveBrowserWatchPanel `running` rule verbatim. */
    val running: Boolean get() = steps.any { it.status == "queued" || it.status == "delivered" }
    val currentStep: SmWatchStep? get() = steps.firstOrNull { it.status == "queued" || it.status == "delivered" }

    companion object {
        fun from(c: JSONObject): SmWatchFeed = SmWatchFeed(
            enabled = c.flexBool("enabled") ?: false,
            onlineCount = c.optJSONArray("devices")?.mapObjects { d ->
                if (d.flexBool("online") == true) true else null
            }?.size ?: 0,
            steps = c.optJSONArray("steps")?.mapObjects { s ->
                SmWatchStep(s.str("action") ?: "", s.str("target") ?: "", s.str("status") ?: "")
            } ?: emptyList(),
        )
    }
}

/** Web ACTION_BN table (subset shown on the one-line "current step" status). */
private fun smActionBn(action: String): String = when (action) {
    "navigate" -> "🌐 পেজ খুলছে"
    "read_text" -> "📖 পড়ছে"
    "read_dom" -> "👀 দেখছে"
    "click" -> "🖱️ ক্লিক"
    "type" -> "⌨️ লিখছে"
    "press" -> "⏎ কী চাপছে"
    "select_option" -> "🔽 অপশন বাছছে"
    "hover" -> "🫳 হোভার"
    "scroll", "scroll_to" -> "↕️ স্ক্রল"
    "wait" -> "⏳ অপেক্ষা"
    "screenshot" -> "📸 স্ক্রিনশট"
    "go_back" -> "↩️ পিছনে"
    "switch_tab" -> "🗂️ ট্যাব বদল"
    "close_tab" -> "❌ ট্যাব বন্ধ"
    "ping" -> "📡 পিং"
    else -> action
}

/** The four mutating actions the native panel offers — each carries its own Bangla
 *  confirm copy so a single AlertDialog serves all of them. (`get() =` only — never
 *  stored companion state.) */
private enum class SmControlAction {
    PAUSE_AGENT, RESUME_AGENT, STOP_BROWSER, RESUME_BROWSER;

    val title: String
        get() = when (this) {
            PAUSE_AGENT -> "Agent বন্ধ করবেন?"
            RESUME_AGENT -> "Agent আবার চালু করবেন?"
            STOP_BROWSER -> "লাইভ ব্রাউজার — সব থামাবেন?"
            RESUME_BROWSER -> "লাইভ ব্রাউজার আবার চালু করবেন?"
        }
    val message: String
        get() = when (this) {
            PAUSE_AGENT -> "এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)।"
            RESUME_AGENT -> "Agent আবার উত্তর ও কাজ শুরু করবে।"
            STOP_BROWSER -> "সার্ভার-সাইড কিল-সুইচ — অপেক্ষমাণ সব কমান্ড সাথে সাথে বাতিল হবে।"
            RESUME_BROWSER -> "Agent আবার আপনার Chrome-এ কাজ করতে পারবে।"
        }
    val confirmLabel: String
        get() = when (this) {
            PAUSE_AGENT -> "🛑 Agent বন্ধ করুন"
            RESUME_AGENT -> "🟢 চালু করুন"
            STOP_BROWSER -> "⏹ সব থামাও"
            RESUME_BROWSER -> "▶️ আবার চালু করো"
        }
    val isDestructive: Boolean
        get() = this == PAUSE_AGENT || this == STOP_BROWSER
}

private class SmControlsState {
    var controls by mutableStateOf<SmControls?>(null)
    var watch by mutableStateOf<SmWatchFeed?>(null)
    var heartbeatEnabled by mutableStateOf<Boolean?>(null)
    var wakesToday by mutableStateOf(0)
    var modelsOn by mutableStateOf<Int?>(null)
    var modelsTotal by mutableStateOf(0)
    var busy by mutableStateOf(false)
    var actionError by mutableStateOf<String?>(null)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** Each GET fails independently — a 403 (non-owner), AGENT_ENABLED gate, or cold
     *  start just hides that panel; the rest of the screen never blanks. */
    suspend fun loadAll() {
        try {
            controls = SmControls.from(unwrap(AlmaApi.getObject("/api/assistant/controls")))
        } catch (_: Exception) { }
        refreshWatch()
        try {
            val h = unwrap(AlmaApi.getObject("/api/assistant/heartbeat", mapOf("limit" to "1")))
            heartbeatEnabled = h.optJSONObject("settings")?.flexBool("enabled") ?: false
            wakesToday = h.flexInt("wakesToday") ?: 0
        } catch (_: Exception) { }
        try {
            val rows = unwrap(AlmaApi.getObject("/api/assistant/models"))
                .optJSONArray("models")?.mapObjects { it.flexBool("enabled") ?: true } ?: emptyList()
            modelsTotal = rows.size
            modelsOn = rows.count { it }
        } catch (_: Exception) { }
    }

    suspend fun refreshWatch() {
        try {
            watch = SmWatchFeed.from(unwrap(AlmaApi.getObject("/api/assistant/live-browser/watch", mapOf("limit" to "30"))))
        } catch (_: Exception) { }
    }

    /** PATCH {paused} — exactly the web AgentControlCenter payload. The route echoes
     *  the full updated controls back; showing that echo IS the verification. */
    suspend fun setPaused(paused: Boolean) {
        if (busy) return
        busy = true
        try {
            val resp = AlmaApi.send("PATCH", "/api/assistant/controls", JSONObject().put("paused", paused))
            controls = SmControls.from(resp.optJSONObject("data") ?: resp)
            actionError = null
        } catch (e: Exception) {
            actionError = "পরিবর্তন ব্যর্থ: ${e.message}"
        } finally {
            busy = false
        }
    }

    /** POST {action: stop|resume} — web LiveBrowserWatchPanel payload. Server replies
     *  {ok, enabled}; the feed is re-fetched so the pill shows the verified state. */
    suspend fun liveBrowser(stop: Boolean) {
        if (busy) return
        busy = true
        try {
            val resp = AlmaApi.send(
                "POST", "/api/assistant/live-browser/watch",
                JSONObject().put("action", if (stop) "stop" else "resume"),
            )
            actionError = if (resp.flexBool("ok") == true) null else "ব্যর্থ — আবার চেষ্টা করুন"
        } catch (e: Exception) {
            actionError = "ব্যর্থ: ${e.message}"
        } finally {
            busy = false
        }
        refreshWatch()
    }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StaffMonitorScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { StaffMonitorState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<SmSummary?>(null) }

    // First paint + web-parity 10s auto-refresh while live; leaving composition
    // cancels this coroutine.
    LaunchedEffect(Unit) {
        vm.load()
        while (true) {
            delay(10_000)
            if (vm.isLive) vm.load(silent = true)
        }
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { SmHeaderBar(vm, dark) }
        smDayChips(vm, dark, scope)
        if (vm.authExpired) {
            item { SmAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        if (vm.error != null && vm.data == null) {
            item { SmErrorCard(vm.error ?: "", dark) { scope.launch { vm.load() } } }
        }
        if (vm.data != null) {
            item { SmKpiStrip(vm, dark) }
        }
        // Owner control panels (web page order: control panels above staff blocks).
        if (!vm.authExpired) {
            item { SmControlsSection(dark) { p, t -> ctx.openWebForced(p, t) } }
        }
        if (vm.data?.geoFenceMonitoringEnabled == false) {
            item {
                Text(
                    "📵 Office time-এ continuous location tracking বন্ধ। Attendance check-in/out-এ location এখনও বাধ্যতামূলক।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                )
            }
        }
        if (vm.loading && vm.data == null) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }
        vm.data?.staffSummaries?.let { summaries ->
            items(summaries, key = { it.staffId }) { s ->
                SmStaffCard(
                    s,
                    geo = vm.geo(s.staffId),
                    alertCount = vm.alerts(s.staffId).size,
                    dark = dark,
                ) { selected = s }
            }
        }
        vm.data?.productivityAlerts?.takeIf { it.isNotEmpty() }?.let { alerts ->
            item {
                Column(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "⚡ PRODUCTIVITY",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                    alerts.forEach { a ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                a.staffName ?: "—",
                                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            )
                            Text(
                                a.message,
                                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        }
        vm.data?.let { d ->
            if (!vm.loading && d.staffSummaries.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("👥", fontSize = 34.sp)
                        Text("আজকে কোনো স্টাফ অ্যাক্টিভ নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    }
                }
            }
        }
        item {
            Text(
                "🌐 সব কন্ট্রোল ও অ্যাকশন (টাস্ক দাও • মেসেজ • এসকালেট) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/agent/staff-monitor", "Staff monitor") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { s ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            SmDetailSheet(s, vm, dark, openWeb = { p, t ->
                selected = null
                ctx.openWebForced(p, t)
            })
        }
    }
}

// ── Header: Live pulse / archive badge + meta line (web sticky header parity) ───────

@Composable
private fun SmHeaderBar(vm: StaffMonitorState, dark: Boolean) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 4.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Staff Monitor", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text(smMetaLine(vm), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        if (vm.isLive) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .background(SmPalette.emerald600.copy(alpha = 0.10f), CircleShape)
                    .border(1.dp, SmPalette.emerald600.copy(alpha = 0.30f), CircleShape)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            ) {
                Box(Modifier.size(7.dp).background(SmPalette.emerald600, CircleShape))
                Text("LIVE", color = SmPalette.emerald600, fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
        } else {
            vm.selectedDate?.let { d ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .border(1.dp, AlmaTheme.ink(dark).copy(alpha = 0.12f), CircleShape)
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                ) {
                    Box(Modifier.size(7.dp).background(AlmaTheme.inkSecondary(dark), CircleShape))
                    Text(d, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

private fun smMetaLine(vm: StaffMonitorState): String {
    val d = vm.data ?: return "কন্ট্রোল • হার্টবিট • স্টাফ মনিটর"
    if (!vm.isLive) return "Viewing archive · press \"Today\" to return"
    val bits = ArrayList<String>()
    d.today?.let { bits.add(it) }
    bits.add("auto-refresh 10s")
    SmFormat.clock(d.generatedAt)?.let { bits.add("last $it") }
    return bits.joinToString(" · ")
}

// ── Day summary chips: Today (live) + archived dates ────────────────────────────────

private fun LazyListScope.smDayChips(vm: StaffMonitorState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    val dates = vm.data?.historyDates ?: emptyList()
    if (dates.isEmpty()) return
    item {
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SmChip("Today", vm.isLive, dark) {
                vm.selectedDate = null
                scope.launch { vm.load() }
            }
            dates.forEach { d ->
                SmChip(d, vm.selectedDate == d, dark) {
                    vm.selectedDate = d
                    scope.launch { vm.load() }
                }
            }
        }
    }
}

@Composable
private fun SmChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SmPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SmPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SmPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

// ── KPI strip: active staff / tasks / unacked / staff ───────────────────────────────

@Composable
private fun SmKpiStrip(vm: StaffMonitorState, dark: Boolean) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val unacked = vm.data?.unackedCount ?: 0
        SmKpiCard("ACTIVE", "${vm.activeCount}", if (vm.activeCount > 0) SmPalette.emerald600 else AlmaTheme.ink(dark), dark)
        SmKpiCard("TASKS", "${vm.tasksDone}/${vm.tasksTotal}", AlmaTheme.ink(dark), dark)
        SmKpiCard("UNACKED", "$unacked", if (unacked > 0) SmPalette.amber600 else AlmaTheme.ink(dark), dark)
        SmKpiCard("STAFF", "${vm.data?.staffSummaries?.size ?: 0}", SmPalette.accentText(dark), dark)
    }
}

@Composable
private fun SmKpiCard(label: String, value: String, tint: Color, dark: Boolean) {
    Column(
        Modifier.widthIn(min = 84.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Owner control panels — section (iOS StaffMonitorControlsSection twin) ───────────

@Composable
private fun SmControlsSection(dark: Boolean, openWeb: (String, String) -> Unit) {
    val vm = remember { SmControlsState() }
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<SmControlAction?>(null) }

    // Watch state must stay fresh (emergency panel); 10s matches the screen's own
    // live cadence. Cancelled with the composable.
    LaunchedEffect(Unit) {
        vm.loadAll()
        while (true) {
            delay(10_000)
            vm.refreshWatch()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // ── 🎛️ Control Center: native master pause + read-only autonomy/capabilities ──
        vm.controls?.let { c ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "🎛️ কন্ট্রোল সেন্টার",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.weight(1f))
                    if (vm.busy) {
                        CircularProgressIndicator(Modifier.size(12.dp), color = SmPalette.coral, strokeWidth = 1.5.dp)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            if (c.paused) "🛑 Agent বন্ধ আছে" else "🟢 Agent চালু আছে",
                            color = if (c.paused) SmPalette.red500 else SmPalette.emerald600,
                            fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            if (c.paused) "এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)।"
                            else "সব কিছু বন্ধ করতে চাইলে সুইচ দিয়ে সাথে সাথে থামান।",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        )
                    }
                    // Never flips optimistically — it only raises the confirm dialog;
                    // the switch moves when the server echo lands.
                    Switch(
                        checked = !c.paused,
                        onCheckedChange = { on ->
                            pending = if (on) SmControlAction.RESUME_AGENT else SmControlAction.PAUSE_AGENT
                        },
                        enabled = !vm.busy,
                        colors = SwitchDefaults.colors(checkedTrackColor = SmPalette.emerald600),
                    )
                }
                HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
                // READ-ONLY (owner spec): changing autonomy/capabilities stays on web.
                SmReadOnlyRow("🧭 অটোনমি", c.autonomyLabel, null, dark)
                SmReadOnlyRow("🔎 ওয়েব রিসার্চ", if (c.webResearch) "চালু" else "বন্ধ", c.webResearch, dark)
                SmReadOnlyRow("📣 সোশ্যাল পোস্ট ও অ্যাড", if (c.socialPosting) "চালু" else "বন্ধ", c.socialPosting, dark)
                SmReadOnlyRow("🎨 ছবি ও ভিডিও", if (c.imageVideoGen) "চালু" else "বন্ধ", c.imageVideoGen, dark)
                vm.actionError?.let { Text(it, color = SmPalette.red500, fontSize = 11.sp) }
                SmWebLink("অটোনমি ও ফিচার বদলাতে — ওয়েবে খুলুন", dark) {
                    openWeb("/agent/staff-monitor", "Staff monitor")
                }
            }
        }

        // ── 🖥️ Live Browser: native emergency STOP/resume + read-only status line ──
        vm.watch?.let { w ->
            val tint = if (w.enabled) SmPalette.red500 else SmPalette.emerald600
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "🖥️ লাইভ ব্রাউজার",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.weight(1f))
                    if (w.running) SmStatusPill("🤖 কাজ চলছে", SmPalette.amber600)
                    SmStatusPill(
                        if (w.enabled) "🟢 চালু · অনলাইন ${w.onlineCount}" else "🔴 বন্ধ",
                        if (w.enabled) SmPalette.emerald600 else AlmaTheme.inkSecondary(dark),
                    )
                }
                w.currentStep?.let { step ->
                    Text(
                        smActionBn(step.action) + if (step.target.isEmpty()) "" else " · ${step.target}",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    if (w.enabled) "⏹ সব থামাও" else "▶️ আবার চালু করো",
                    color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(tint.copy(alpha = 0.15f), CircleShape)
                        .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
                        .plainClick {
                            if (!vm.busy) {
                                pending = if (w.enabled) SmControlAction.STOP_BROWSER
                                else SmControlAction.RESUME_BROWSER
                            }
                        }
                        .padding(vertical = 9.dp),
                )
                SmWebLink("স্ক্রিনশট ও লাইভ স্টেপ ফিড — ওয়েবে খুলুন", dark) {
                    openWeb("/agent/staff-monitor", "Staff monitor")
                }
            }
        }

        // ── 💓/🧠 Heartbeat + models: read-only status rows only ──
        if (vm.heartbeatEnabled != null || vm.modelsOn != null) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "এজেন্ট স্ট্যাটাস",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
                vm.heartbeatEnabled?.let { on ->
                    SmReadOnlyRow(
                        "💓 হার্টবিট",
                        if (on) "চালু · আজ ${vm.wakesToday} বার জেগেছে" else "বন্ধ",
                        on, dark,
                    )
                }
                vm.modelsOn?.let { on ->
                    SmReadOnlyRow("🧠 মডেল", "$on/${vm.modelsTotal} চালু", on > 0, dark)
                }
                SmWebLink("হার্টবিট ও মডেল কন্ট্রোল — ওয়েবে খুলুন", dark) {
                    openWeb("/agent/staff-monitor", "Staff monitor")
                }
            }
        }
    }

    pending?.let { action ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(action.title) },
            text = { Text(action.message) },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    scope.launch {
                        when (action) {
                            SmControlAction.PAUSE_AGENT -> vm.setPaused(true)
                            SmControlAction.RESUME_AGENT -> vm.setPaused(false)
                            SmControlAction.STOP_BROWSER -> vm.liveBrowser(stop = true)
                            SmControlAction.RESUME_BROWSER -> vm.liveBrowser(stop = false)
                        }
                    }
                }) {
                    Text(
                        action.confirmLabel,
                        color = if (action.isDestructive) SmPalette.red500 else SmPalette.emerald600,
                    )
                }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun SmReadOnlyRow(label: String, value: String, ok: Boolean?, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            label, color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp,
            modifier = Modifier.weight(1f),
        )
        Text(
            value,
            color = when (ok) {
                null -> SmPalette.accentText(dark)
                true -> SmPalette.emerald600
                false -> SmPalette.red500
            },
            fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SmStatusPill(text: String, color: Color) {
    Text(
        text,
        color = color, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(color.copy(alpha = 0.10f), CircleShape)
            .border(0.8.dp, color.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

@Composable
private fun SmWebLink(label: String, dark: Boolean, onClick: () -> Unit) {
    Text(
        "🌐 $label",
        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        modifier = Modifier.plainClick(onClick).padding(vertical = 2.dp),
    )
}

// ── Staff card (web MonitorStaffCards / MonitorStaffHub row parity) ─────────────────

@Composable
private fun SmStaffCard(s: SmSummary, geo: SmGeo?, alertCount: Int, dark: Boolean, onTap: () -> Unit) {
    val (statusColor, statusLabel) = SmPalette.status(s, dark)
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SmAvatar(s.staffName, statusColor)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    s.staffName,
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                SmLocationLine(s, geo, dark)
            }
            Text(
                statusLabel.uppercase(),
                color = statusColor, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(statusColor.copy(alpha = 0.12f), CircleShape)
                    .border(0.8.dp, statusColor.copy(alpha = 0.30f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }

        // Day-progress bar (web: coral→teal gradient + % on the right).
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmProgressBar(s.completionPct, Modifier.weight(1f))
            Text(
                "${s.completionPct}%",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("📤 ${s.dispatched}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            Text("✓ ${s.delivered}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            if (s.failed > 0) {
                Text("✗ ${s.failed}", color = SmPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            if (alertCount > 0) {
                Text("⚡ $alertCount", color = SmPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.weight(1f))
            Text(
                "🎯 ${s.tasksDone}/${s.tasksTotal}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/** Location line: geo-fence state (Bangla verbatim) + relative last-seen time. */
@Composable
private fun SmLocationLine(s: SmSummary, geo: SmGeo?, dark: Boolean) {
    val (icon, label, color) = SmPalette.geo(geo?.status, dark)
    var text = "$icon $label"
    if (geo?.status == "outside") geo.distanceM?.let { text += " (${it}m)" }
    val seen = geo?.lastUpdate ?: s.lastActivityAt
    SmFormat.timeAgo(seen)?.takeIf { it.isNotEmpty() }?.let { text += " · $it" }
    Text(text, color = color, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Initials avatar + live status dot (web StaffInitial + dot overlay). */
@Composable
private fun SmAvatar(name: String, dot: Color) {
    Box(Modifier.size(38.dp)) {
        Box(
            Modifier
                .fillMaxSize()
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        listOf(SmPalette.coral.copy(alpha = 0.20f), SmPalette.teal.copy(alpha = 0.10f)),
                    ),
                )
                .border(1.dp, SmPalette.coral.copy(alpha = 0.25f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(SmFormat.initial(name), color = SmPalette.coral, fontSize = 15.sp, fontWeight = FontWeight.Black)
        }
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .offset(x = 1.5.dp, y = 1.5.dp)
                .size(11.dp)
                .clip(CircleShape)
                .background(dot)
                .border(1.6.dp, Color.White.copy(alpha = 0.9f), CircleShape),
        )
    }
}

/** Web progress bar: coral→teal gradient fill on a faint track. */
@Composable
private fun SmProgressBar(percent: Int, modifier: Modifier = Modifier) {
    Box(
        modifier
            .height(6.dp)
            .clip(CircleShape)
            .background(Color(0xFF787880).copy(alpha = 0.16f)),
    ) {
        if (percent > 0) {
            Box(
                Modifier
                    .fillMaxSize()
                    .fillMaxWidth(fraction = (percent.coerceIn(0, 100)) / 100f)
                    .clip(CircleShape)
                    .background(Brush.horizontalGradient(listOf(SmPalette.coral, SmPalette.teal))),
            )
        }
    }
}

// ── Detail sheet (per-staff: progress · location · alerts · today's messages) ───────

@Composable
private fun SmDetailSheet(s: SmSummary, vm: StaffMonitorState, dark: Boolean, openWeb: (String, String) -> Unit) {
    val geo = vm.geo(s.staffId)
    val alerts = vm.alerts(s.staffId)
    val messages = vm.messages(s.staffId)
    val (statusColor, statusLabel) = SmPalette.status(s, dark)
    val uriHandler = LocalUriHandler.current

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SmAvatar(s.staffName, statusColor)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(s.staffName, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        statusLabel.uppercase(),
                        color = statusColor, fontSize = 11.sp, fontWeight = FontWeight.Black,
                    )
                    SmFormat.timeAgo(s.lastActivityAt)?.takeIf { it.isNotEmpty() }?.let {
                        Text("· $it", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                    }
                }
            }
        }

        // Progress
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "আজকের অগ্রগতি",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "${s.completionPct}%",
                    color = if (s.completionPct >= 100) SmPalette.emerald600 else SmPalette.accentText(dark),
                    fontSize = 20.sp, fontWeight = FontWeight.Bold,
                )
                SmProgressBar(s.completionPct, Modifier.weight(1f))
            }
            Row {
                SmStatCell("📤", "${s.dispatched}", "Dispatched", AlmaTheme.ink(dark), dark)
                SmStatCell("✓", "${s.delivered}", "Delivered", AlmaTheme.ink(dark), dark)
                SmStatCell(
                    "✗", "${s.failed}", "Failed",
                    if (s.failed > 0) SmPalette.red500 else AlmaTheme.inkSecondary(dark), dark,
                )
                SmStatCell("🎯", "${s.tasksDone}/${s.tasksTotal}", "Tasks", AlmaTheme.ink(dark), dark)
            }
        }

        // Location — mapsLink is a plain Google-Maps URL; opens in the system browser
        // (iOS Link twin — no native map view needed, no Maps API key available).
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                "লোকেশন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            val (icon, label, color) = SmPalette.geo(geo?.status, dark)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val dist = if (geo?.status == "outside" && geo.distanceM != null) " (${geo.distanceM}m)" else ""
                Text(
                    "$icon $label$dist",
                    color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                geo?.mapsLink?.takeIf { it.isNotEmpty() }?.let { link ->
                    Text(
                        "🗺️ ম্যাপ",
                        color = SmPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.plainClick {
                            try { uriHandler.openUri(link) } catch (_: Exception) { }
                        },
                    )
                }
            }
            SmFormat.timeAgo(geo?.lastUpdate)?.takeIf { it.isNotEmpty() }?.let {
                Text("শেষ আপডেট $it", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }

        // Alerts
        if (alerts.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    "⚡ PRODUCTIVITY",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
                )
                alerts.forEach { a ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            a.message, color = SmPalette.amber600, fontSize = 12.sp,
                            modifier = Modifier.weight(1f),
                        )
                        SmFormat.clock(a.at)?.let {
                            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        }
                    }
                }
            }
        }

        // Today's messages
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "আজকের মেসেজ",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (messages.isEmpty()) {
                Text(
                    "এই স্টাফের অতিরিক্ত ডেটা এখনও নেই।",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            } else {
                val shown = messages.take(12)
                shown.forEachIndexed { i, m ->
                    Column(Modifier.padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                m.typeLabel,
                                color = SmPalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier
                                    .background(SmPalette.coral.copy(alpha = 0.12f), CircleShape)
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                            SmFormat.clock(m.sentAt ?: m.createdAt)?.let {
                                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                            }
                            Spacer(Modifier.weight(1f))
                            SmAckBadge(m, dark)
                        }
                        Text(
                            m.content,
                            color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp,
                            maxLines = 4, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (i != shown.lastIndex) {
                        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
                    }
                }
            }
        }

        Text(
            "🌐 টাস্ক দাও • মেসেজ • এসকালেট — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/agent/staff-monitor", "Staff monitor") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun RowScope.SmStatCell(icon: String, value: String, label: String, tint: Color, dark: Boolean) {
    Column(
        Modifier.weight(1f),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(icon, fontSize = 12.sp)
        Text(value, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

/** Web AckBadge parity: ✓ time · ⏳ unseen · sending… */
@Composable
private fun SmAckBadge(m: SmFeedRow, dark: Boolean) {
    val ackClock = m.acknowledgedAt?.let { SmFormat.clock(it) }
    when {
        ackClock != null -> Text(
            "✓ $ackClock",
            color = SmPalette.emerald600, fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(SmPalette.emerald600.copy(alpha = 0.10f), CircleShape)
                .padding(horizontal = 5.dp, vertical = 2.dp),
        )
        m.status == "delivered" || m.status == "sent" -> Text(
            "⏳ unseen",
            color = SmPalette.amber600, fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(SmPalette.amber500.copy(alpha = 0.10f), CircleShape)
                .padding(horizontal = 5.dp, vertical = 2.dp),
        )
        m.status == "queued" || m.status == "pending" -> Text(
            "sending…",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
        )
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun SmAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SmPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun SmErrorCard(message: String, dark: Boolean, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("⚠️ লোড করা যায়নি: $message", color = SmPalette.red500, fontSize = 13.sp)
        Text(
            "আবার চেষ্টা",
            color = SmPalette.coral, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .border(1.dp, SmPalette.coral.copy(alpha = 0.5f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick(onRetry)
                .padding(horizontal = 14.dp, vertical = 7.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ────────────────────────────────────────────

private object SmFormat {
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

    /** Web fmtTime: HH:mm in Asia/Dhaka. */
    fun clock(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("HH:mm", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** Bangla relative time — the app's shared strings. */
    fun timeAgo(iso: String?): String? {
        val date = parse(iso) ?: return null
        val mins = ((System.currentTimeMillis() - date.time) / 60_000).toInt()
        return when {
            mins < 1 -> "এইমাত্র"
            mins < 60 -> "$mins মিনিট আগে"
            mins < 24 * 60 -> "${mins / 60} ঘণ্টা আগে"
            else -> "${mins / (24 * 60)} দিন আগে"
        }
    }

    /** Web StaffInitial: single first letter, uppercased. */
    fun initial(name: String): String {
        val c = name.trim().firstOrNull() ?: return "?"
        return c.toString().uppercase()
    }
}
