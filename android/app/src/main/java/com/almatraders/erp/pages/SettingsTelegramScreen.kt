//
//  SettingsTelegramScreen.kt
//  ALMA ERP — Settings ▸ Telegram Ops, ported 1:1 from SettingsTelegramSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET  /api/settings/telegram-ops?business_id=…        → {ok,data:{setting,recentQueue,stats}}
//    GET  /api/settings/telegram-ops/health?business_id=… → {ok, ownerRouting, telegram, queue, delivery}
//    POST /api/settings/telegram-ops/health?business_id=… → process queue now
//    POST /api/settings/telegram-ops/test                 → send test  {business_id}
//    POST /api/settings/telegram-ops/retry                → retry {id} | {retry_all,business_id}
//    PATCH /api/settings/telegram-ops                      → master toggle {business_id, enabled}
//  Blocks: business chips · health-stat grid · ops actions (toggle/process/test/retry) ·
//  owner-routing diagnostics · recipients & schedule (read-only) · alert toggles (read-only
//  state) · queue 7-day chips · last failure · recent queue rows (per-row retry).
//  Config edits (chat IDs / schedule / toggles) stay on the web escape hatch.
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object TelegramPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue500 = Color(0xFF3B82F6)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web HealthStat tones: ok emerald · warn amber · bad red. */
    fun tone(t: String?, dark: Boolean): Color = when (t) {
        "ok" -> emerald600
        "warn" -> amber600
        "bad" -> red500
        else -> AlmaTheme.inkSecondary(dark)
    }

    /** Web queue-status chips: SENT green · QUEUED amber · FAILED red · SENDING blue. */
    fun queueStatus(s: String?, dark: Boolean): Color = when (s?.uppercase()) {
        "SENT" -> emerald600
        "QUEUED" -> amber600
        "FAILED" -> red500
        "SENDING" -> blue500
        else -> AlmaTheme.inkSecondary(dark)
    }
}

// ── Models (same field names the web page types declare — all lenient) ─────────────

/** Web ALERT_TOGGLES table verbatim (key → label). */
private val TELEGRAM_TOGGLE_TABLE: List<Pair<String, String>>
    get() = listOf(
        "alertAttendanceCheckIn" to "Check-in + face verification alerts",
        "alertAttendanceLate" to "Late detail on check-in",
        "alertAttendanceAbsent" to "Absent / not arrived",
        "alertAttendanceCheckOut" to "Check-out alerts",
        "alertAttendanceNoCheckout" to "Missing checkout",
        "alertAttendanceEarlyLeave" to "Early leave",
        "alertAttendanceSuspicious" to "Suspicious check-in",
        "alertTradingScreenshot" to "Screenshot upload/failure",
        "alertTradingDeleteRequest" to "Delete requests",
        "alertWorkflowLifecycle" to "Approvals · approve / reject / submit",
        "alertOpsDailySummary" to "Daily ops summary",
    )

private data class TelegramSetting(
    val enabled: Boolean?,
    val ownerChatIds: String?,
    val officeStartMinutes: Int?,
    val gracePeriodMinutes: Int?,
    val checkoutCutoffMinutes: Int?,
    val earlyLeaveMinutes: Int?,
    val alertFlags: Map<String, Boolean>,
) {
    companion object {
        fun from(o: JSONObject): TelegramSetting {
            val flags = HashMap<String, Boolean>()
            for ((k, _) in TELEGRAM_TOGGLE_TABLE) o.flexBool(k)?.let { flags[k] = it }
            return TelegramSetting(
                enabled = o.flexBool("enabled"),
                ownerChatIds = o.str("ownerChatIds"),
                officeStartMinutes = o.flexInt("officeStartMinutes"),
                gracePeriodMinutes = o.flexInt("gracePeriodMinutes"),
                checkoutCutoffMinutes = o.flexInt("checkoutCutoffMinutes"),
                earlyLeaveMinutes = o.flexInt("earlyLeaveMinutes"),
                alertFlags = flags,
            )
        }
    }
}

private data class TelegramQueueRow(
    val id: String,
    val eventType: String?,
    val status: String?,
    val chatId: String?,
    val attempts: Int?,
    val errorMessage: String?,
    val createdAt: String?,
    val employeeName: String?,
) {
    companion object {
        fun from(o: JSONObject): TelegramQueueRow = TelegramQueueRow(
            id = o.str("id") ?: java.util.UUID.randomUUID().toString(),
            eventType = o.str("eventType"),
            status = o.str("status"),
            chatId = o.str("chatId"),
            attempts = o.flexInt("attempts"),
            errorMessage = o.str("errorMessage"),
            createdAt = o.str("createdAt"),
            employeeName = o.str("employeeName"),
        )
    }
}

/** GET …/health answers FLAT: `{ok, ownerRouting, telegram, queue, delivery}`. */
private class TelegramDashboard(root: JSONObject) {
    val routingSource: String? = root.optJSONObject("ownerRouting")?.str("source")
    val chatIds: List<String> = root.optJSONObject("ownerRouting").strList("chatIds")
    val dbIds: List<String> = root.optJSONObject("ownerRouting").strList("dbIds")
    val envIds: List<String> = root.optJSONObject("ownerRouting").strList("envIds")
    val invalidDbTokens: List<String> = root.optJSONObject("ownerRouting").strList("invalidDbTokens")
    val invalidEnvTokens: List<String> = root.optJSONObject("ownerRouting").strList("invalidEnvTokens")
    val routingLabel: String? = root.optJSONObject("ownerRoutingHealth")?.str("label")
    val routingTone: String? = root.optJSONObject("ownerRoutingHealth")?.str("tone")

    private val tg = root.optJSONObject("telegram")
    val botOk: Boolean? = tg?.flexBool("botOk")
    val botError: String? = tg?.str("botError")
    val botUsername: String? = tg?.str("botUsername")
    val webhookHealthy: Boolean? = tg?.flexBool("webhookHealthy")
    val webhookNote: String? = tg?.str("webhookNote")
    val expectedWebhookUrl: String? = tg?.str("expectedWebhookUrl")

    private val q = root.optJSONObject("queue")
    val pendingDepth: Int? = q?.flexInt("pendingDepth")
    val businessPending: Int? = q?.flexInt("businessPending")
    val processingCount: Int? = q?.flexInt("processingCount")
    val retryWaitCount: Int? = q?.flexInt("retryWaitCount")
    val stuckSending: Int? = q?.flexInt("stuckSending")
    val businessFailed24h: Int? = q?.flexInt("businessFailed24h")
    val averageDeliveryLatencyMs: Int? = q?.flexInt("averageDeliveryLatencyMs")
    val stats7d: Map<String, Int> = (q?.optJSONArray("stats7d") ?: JSONArray())
        .mapObjects { it.str("status")?.let { s -> s to (it.flexInt("count") ?: 0) } }
        .toMap()

    private val d = root.optJSONObject("delivery")
    val sentLast24h: Int? = d?.flexInt("sentLast24h")
    val lastSuccessAt: String? = d?.optJSONObject("lastSuccessfulSend")?.str("sentAt")
    val lastSuccessEvent: String? = d?.optJSONObject("lastSuccessfulSend")?.str("eventType")
    val lastFailedEvent: String? = d?.optJSONObject("lastFailed")?.str("eventType")
    val lastFailedError: String? = d?.optJSONObject("lastFailed")?.str("errorMessage")
}

/** Web routingLabel(source) verbatim. */
private fun routingLabel(source: String?): String = when (source) {
    "database" -> "Database (primary)"
    "env_fallback" -> "Env fallback (TELEGRAM_OWNER_CHAT_IDS)"
    "disabled" -> "Disabled"
    else -> "No valid recipients"
}

/** Read a JSON array of strings, tolerating numeric members; null object → empty. */
private fun JSONObject?.strList(key: String): List<String> {
    val arr = this?.optJSONArray(key) ?: return emptyList()
    val out = ArrayList<String>(arr.length())
    for (i in 0 until arr.length()) arr.opt(i)?.let { if (it != JSONObject.NULL) out.add(it.toString()) }
    return out
}

// ── State holder (iOS SettingsTelegramVM twin) ─────────────────────────────────────

/** Web BUSINESS_LIST (src/lib/businesses.ts) — id → name, same order. */
private val TELEGRAM_BUSINESSES: List<Pair<String, String>>
    get() = listOf(
        "ALMA_LIFESTYLE" to "Alma Lifestyle",
        "CREATIVE_DIGITAL_IT" to "Creative Digital IT",
        "ALMA_TRADING" to "Alma Trading",
    )

private class TelegramState {
    var businessId by mutableStateOf("ALMA_LIFESTYLE")
    var setting by mutableStateOf<TelegramSetting?>(null)
    var recentQueue by mutableStateOf(listOf<TelegramQueueRow>())
    var dashboard by mutableStateOf<TelegramDashboard?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val cfg = unwrap(AlmaApi.getObject("/api/settings/telegram-ops", mapOf("business_id" to businessId)))
            setting = cfg.optJSONObject("setting")?.let { TelegramSetting.from(it) }
            recentQueue = cfg.optJSONArray("recentQueue")?.mapObjects { TelegramQueueRow.from(it) } ?: emptyList()
            authExpired = false
            // Health is best-effort — the web page swallows its failure too.
            dashboard = try {
                TelegramDashboard(AlmaApi.getObject("/api/settings/telegram-ops/health", mapOf("business_id" to businessId)))
            } catch (_: Exception) { null }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    suspend fun processQueueNow() {
        busy = true
        try {
            val r = AlmaApi.send("POST", "/api/settings/telegram-ops/health?business_id=$businessId", JSONObject())
            val processed = r.optJSONObject("processed")?.flexInt("processed") ?: 0
            toast = "Reclaimed ${r.flexInt("reclaimed") ?: 0} stuck · processed $processed"
            load()
        } catch (e: Exception) { toast = e.message } finally { busy = false }
    }

    suspend fun sendTest() {
        busy = true
        try {
            val r = AlmaApi.send("POST", "/api/settings/telegram-ops/test", JSONObject().put("business_id", businessId))
            val n = r.optJSONObject("routing")?.optJSONArray("chatIds")?.length() ?: 0
            toast = "Test sent to $n owner chat(s)"
            load()
        } catch (e: Exception) { toast = e.message } finally { busy = false }
    }

    suspend fun retryAllFailed() {
        busy = true
        try {
            val r = AlmaApi.send("POST", "/api/settings/telegram-ops/retry",
                JSONObject().put("retry_all", true).put("business_id", businessId))
            toast = "Requeued ${r.flexInt("requeued") ?: 0} failed job(s)"
            load()
        } catch (e: Exception) { toast = e.message } finally { busy = false }
    }

    suspend fun retryQueue(id: String) {
        try {
            AlmaApi.send("POST", "/api/settings/telegram-ops/retry", JSONObject().put("id", id))
            toast = "Retry queued"
            load()
        } catch (e: Exception) { toast = e.message }
    }

    suspend fun setEnabled(enabled: Boolean) {
        try {
            AlmaApi.send("PATCH", "/api/settings/telegram-ops",
                JSONObject().put("business_id", businessId).put("enabled", enabled))
            toast = "Saved"
            load()
        } catch (e: Exception) { toast = e.message }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun SettingsTelegramScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { TelegramState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) { delay(2600); vm.toast = null }
    }

    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Spacer(Modifier.height(4.dp))
            // Business picker chips.
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TELEGRAM_BUSINESSES.forEach { (id, name) ->
                    TelegramChip(name, vm.businessId == id, dark) {
                        vm.businessId = id; scope.launch { vm.load() }
                    }
                }
            }

            if (vm.authExpired) TelegramAuthCard(dark) { ctx.openWebForced("/login", "Login") }
            vm.error?.let { TelegramNoticeCard(it, TelegramPalette.red500, dark) }

            if (vm.loading && vm.setting == null && vm.dashboard == null) {
                repeat(4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            } else {
                TelegramHealthGrid(vm.dashboard, dark)
                TelegramActionsCard(vm, dark, scope)
                TelegramRoutingCard(vm.dashboard, dark)
                TelegramConfigCard(vm.setting, dark)
                TelegramAlertTogglesCard(vm.setting, dark)
                TelegramQueueCard(vm, dark, scope)
            }

            Text(
                "🌐 কনফিগ পরিবর্তন (টগল/চ্যাট ID/রিট্রাই) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/settings/telegram-ops", "Telegram Ops") }
                    .padding(vertical = 6.dp),
            )
            Spacer(Modifier.height(8.dp))
        }

        // Auto-dismissing toast (iOS bottom capsule twin).
        vm.toast?.let { t ->
            Box(Modifier.fillMaxSize().padding(bottom = 24.dp), contentAlignment = Alignment.BottomCenter) {
                Text(
                    t, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .almaGlass(dark, 22)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
}

// ── Health grid (web HealthStat cards, 2-up on phone) ──────────────────────────────

@Composable
private fun TelegramHealthGrid(d: TelegramDashboard?, dark: Boolean) {
    data class Stat(val label: String, val value: String, val tone: String, val hint: String? = null)
    val q = d
    val stats = listOf(
        Stat("Bot (outbound)",
            if (q?.botOk == true) "@${q.botUsername ?: "ok"}" else (q?.botError ?: "Offline / misconfigured"),
            if (q?.botOk == true) "ok" else "bad"),
        Stat("Webhook (inbound)", if (q?.webhookHealthy == true) "Registered" else "Informational",
            "warn", q?.webhookNote ?: q?.expectedWebhookUrl),
        Stat("Owner routing", q?.routingLabel ?: routingLabel(q?.routingSource),
            q?.routingTone ?: (if (q?.chatIds?.isNotEmpty() == true) "ok" else "bad"),
            q?.chatIds?.joinToString(", ")),
        Stat("Queue depth", "${q?.pendingDepth ?: q?.businessPending ?: 0}",
            if ((q?.pendingDepth ?: 0) > 5) "warn" else "ok"),
        Stat("Processing", "${q?.processingCount ?: 0}", if ((q?.processingCount ?: 0) > 0) "warn" else "ok"),
        Stat("Retry wait", "${q?.retryWaitCount ?: 0}", if ((q?.retryWaitCount ?: 0) > 0) "warn" else "ok"),
        Stat("Avg latency (24h)", q?.averageDeliveryLatencyMs?.let { "${it}ms" } ?: "—", "ok"),
        Stat("Stuck SENDING", "${q?.stuckSending ?: 0}", if ((q?.stuckSending ?: 0) > 0) "bad" else "ok"),
        Stat("Failed (24h)", "${q?.businessFailed24h ?: 0}", if ((q?.businessFailed24h ?: 0) > 0) "warn" else "ok"),
        Stat("Sent (24h)", "${q?.sentLast24h ?: 0}", "ok"),
        Stat("Last success", TelegramFormat.dateTime(q?.lastSuccessAt) ?: "—",
            if (q?.lastSuccessAt != null) "ok" else "warn", q?.lastSuccessEvent),
    )
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        stats.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                pair.forEach { s ->
                    Column(
                        Modifier.weight(1f).heightIn(min = 66.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(s.label.uppercase(), color = AlmaTheme.inkSecondary(dark),
                            fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
                        Text(s.value, color = TelegramPalette.tone(s.tone, dark),
                            fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        s.hint?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

// ── Ops actions (owner 2026-07-11): toggle + process-now + test + retry-all ─────────

@Composable
private fun TelegramActionsCard(vm: TelegramState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val on = vm.setting?.enabled == true
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Telegram notifications", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            // Read-out pill doubling as the master toggle (write on tap).
            Text(
                if (on) "ON" else "OFF",
                color = if (on) TelegramPalette.emerald600 else TelegramPalette.red500,
                fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background((if (on) TelegramPalette.emerald600 else TelegramPalette.red500).copy(alpha = 0.14f), CircleShape)
                    .plainClick { if (!vm.busy) scope.launch { vm.setEnabled(!on) } }
                    .padding(horizontal = 12.dp, vertical = 5.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TelegramOpChip("▶ Process now", dark, vm.busy) { scope.launch { vm.processQueueNow() } }
            TelegramOpChip("✈ Send test", dark, vm.busy) { scope.launch { vm.sendTest() } }
            TelegramOpChip("⟳ Retry failed", dark, vm.busy) { scope.launch { vm.retryAllFailed() } }
        }
    }
}

@Composable
private fun TelegramOpChip(label: String, dark: Boolean, disabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (disabled) AlmaTheme.inkTertiary(dark) else AlmaTheme.ink(dark),
        fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(Color.White.copy(alpha = if (dark) 0.06f else 0.35f), CircleShape)
            .plainClick { if (!disabled) onClick() }
            .padding(horizontal = 9.dp, vertical = 7.dp),
    )
}

// ── Owner routing diagnostics (web card — chat IDs monospace) ──────────────────────

@Composable
private fun TelegramRoutingCard(d: TelegramDashboard?, dark: Boolean) {
    if (d == null) return
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TelegramCardTitle("Owner routing diagnostics", dark)
        TelegramMonoRow("Active source", routingLabel(d.routingSource), dark, accent = true)
        TelegramMonoRow("Delivering to", d.chatIds.joinToString(", "), dark)
        TelegramMonoRow("DB IDs", d.dbIds.joinToString(", "), dark)
        TelegramMonoRow("Env fallback IDs", d.envIds.joinToString(", "), dark)
        if (d.invalidDbTokens.isNotEmpty() || d.invalidEnvTokens.isNotEmpty()) {
            Text(
                "Invalid tokens ignored: DB [${d.invalidDbTokens.joinToString(", ")}] Env [${d.invalidEnvTokens.joinToString(", ")}]",
                color = TelegramPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Text("Priority: database chat IDs first. If empty or invalid, TELEGRAM_OWNER_CHAT_IDS env is used.",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Text("Delivery: enqueue → cron/worker (ERP never waits on Telegram API). High priority: approvals, penalties, wallet. Low priority: screenshots, summaries (45s delay).",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

@Composable
private fun TelegramMonoRow(label: String, value: String, dark: Boolean, accent: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            value.ifEmpty { "—" },
            color = if (accent) TelegramPalette.accentText(dark) else AlmaTheme.ink(dark),
            fontSize = 12.sp, fontFamily = FontFamily.Monospace,
        )
    }
}

// ── Recipients & schedule (READ-ONLY — changes stay on web) ────────────────────────

@Composable
private fun TelegramConfigCard(s: TelegramSetting?, dark: Boolean) {
    if (s == null) return
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TelegramCardTitle("Recipients & master switch", dark)
            Spacer(Modifier.weight(1f))
            val on = s.enabled == true
            Text(
                if (on) "Enabled" else "Disabled",
                color = if (on) TelegramPalette.emerald600 else TelegramPalette.red500,
                fontSize = 10.sp, fontWeight = FontWeight.Black,
                modifier = Modifier
                    .background((if (on) TelegramPalette.emerald600 else TelegramPalette.red500).copy(alpha = 0.12f), CircleShape)
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Owner chat IDs (comma-separated). Env fallback: TELEGRAM_OWNER_CHAT_IDS",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            Text(s.ownerChatIds?.takeIf { it.isNotEmpty() } ?: "—",
                color = TelegramPalette.accentText(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace)
        }
        TelegramCardTitle("Schedule (BD)", dark)
        Text(
            "Office ${TelegramFormat.minutesToTimeLabel(s.officeStartMinutes ?: 0)} · grace +${s.gracePeriodMinutes ?: 0}m · no-checkout ${TelegramFormat.minutesToTimeLabel(s.checkoutCutoffMinutes ?: 0)}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TelegramScheduleCell("Office start (min)", s.officeStartMinutes, dark, Modifier.weight(1f))
            TelegramScheduleCell("Grace (min)", s.gracePeriodMinutes, dark, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TelegramScheduleCell("Checkout cutoff (min)", s.checkoutCutoffMinutes, dark, Modifier.weight(1f))
            TelegramScheduleCell("Early leave under (min)", s.earlyLeaveMinutes, dark, Modifier.weight(1f))
        }
        Text("পরিবর্তন করতে ওয়েব পেজ ব্যবহার করুন — এখানে শুধু দেখা যায়।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

@Composable
private fun TelegramScheduleCell(label: String, value: Int?, dark: Boolean, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        modifier
            .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f), shape)
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.4f), shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Text(value?.toString() ?: "—", color = AlmaTheme.ink(dark), fontSize = 13.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
    }
}

// ── Alert toggles (web ALERT_TOGGLES — read-only state rows) ───────────────────────

@Composable
private fun TelegramAlertTogglesCard(s: TelegramSetting?, dark: Boolean) {
    if (s == null) return
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TelegramCardTitle("Alert toggles", dark)
        TELEGRAM_TOGGLE_TABLE.forEach { (key, label) ->
            val on = s.alertFlags[key] == true
            val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Color.White.copy(alpha = if (dark) 0.04f else 0.3f), shape)
                    .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.4f), shape)
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, color = AlmaTheme.ink(dark), fontSize = 13.sp)
                Spacer(Modifier.weight(1f))
                Text(
                    if (on) "✓" else "✕",
                    color = if (on) TelegramPalette.emerald600 else AlmaTheme.inkSecondary(dark),
                    fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Queue (7 days) chips + last failure + recent rows ──────────────────────────────

@Composable
private fun TelegramQueueCard(vm: TelegramState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    val stats = vm.dashboard?.stats7d ?: emptyMap()
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        TelegramCardTitle("Queue (7 days)", dark)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("SENT", "QUEUED", "FAILED", "SENDING").forEach { s ->
                val tint = TelegramPalette.queueStatus(s, dark)
                Text(
                    "$s: ${stats[s] ?: 0}",
                    color = tint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(tint.copy(alpha = 0.10f), CircleShape)
                        .border(1.dp, tint.copy(alpha = 0.30f), CircleShape)
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }

        val d = vm.dashboard
        if (d?.lastFailedEvent != null || d?.lastFailedError != null) {
            val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(TelegramPalette.red500.copy(alpha = 0.08f), shape)
                    .border(1.dp, TelegramPalette.red500.copy(alpha = 0.25f), shape)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text("Last failure", color = TelegramPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Black)
                d.lastFailedEvent?.let { Text(it, color = AlmaTheme.ink(dark), fontSize = 11.sp) }
                d.lastFailedError?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            }
        }

        TelegramCardTitle("Recent queue", dark)
        if (vm.recentQueue.isEmpty()) {
            Text("কিছু নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        vm.recentQueue.forEach { row -> TelegramQueueRowView(row, dark) { scope.launch { vm.retryQueue(row.id) } } }
    }
}

@Composable
private fun TelegramQueueRowView(row: TelegramQueueRow, dark: Boolean, onRetry: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    val tint = TelegramPalette.queueStatus(row.status, dark)
    Column(
        Modifier
            .fillMaxWidth()
            .background(Color.White.copy(alpha = if (dark) 0.04f else 0.3f), shape)
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.08f else 0.4f), shape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.employeeName ?: row.eventType ?: "—", color = AlmaTheme.ink(dark),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(
                row.status ?: "—", color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.background(tint.copy(alpha = 0.10f), CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        if (row.employeeName != null && row.eventType != null) {
            Text(row.eventType, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Chat ${row.chatId ?: "—"}", color = TelegramPalette.accentText(dark),
                fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            Text("· attempts ${row.attempts ?: 0}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            Spacer(Modifier.weight(1f))
            TelegramFormat.dateTime(row.createdAt)?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        }
        row.errorMessage?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = TelegramPalette.red500, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if ((row.status ?: "").uppercase() in listOf("FAILED", "QUEUED", "SENDING")) {
            Text(
                "Retry", color = TelegramPalette.amber600, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(TelegramPalette.amber600.copy(alpha = 0.12f), CircleShape)
                    .plainClick(onRetry)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun TelegramCardTitle(text: String, dark: Boolean) {
    Text(text.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp)
}

@Composable
private fun TelegramChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) TelegramPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) TelegramPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f), CircleShape,
            )
            .border(1.dp,
                if (active) TelegramPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f), CircleShape)
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun TelegramNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp))
}

@Composable
private fun TelegramAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text("লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(TelegramPalette.coral, CircleShape).plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp))
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object TelegramFormat {
    /** createdAt → short local date-time, Asia/Dhaka (web toLocaleString twin). */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** Minutes-since-midnight → "9:30 AM" (web minutesToTimeLabel verbatim). */
    fun minutesToTimeLabel(minutes: Int): String {
        val h = minutes / 60
        val m = minutes % 60
        val period = if (h >= 12) "PM" else "AM"
        val hour12 = if (h % 12 == 0) 12 else h % 12
        return "$hour12:${String.format("%02d", m)} $period"
    }

    private fun parse(iso: String?): Date? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US); f.timeZone = TimeZone.getTimeZone("UTC")
                return f.parse(iso)
            } catch (_: Exception) {}
        }
        return null
    }
}
