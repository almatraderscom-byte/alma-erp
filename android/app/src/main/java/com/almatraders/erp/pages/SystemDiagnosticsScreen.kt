//
//  SystemDiagnosticsScreen.kt
//  ALMA ERP — /operations/system-diagnostics, ported 1:1 from SystemDiagnosticsSwiftUI.swift.
//  READ-ONLY — the web POST actions (Process now / Retry failed / Retry single) MUTATE
//  the queue, so they deliberately stay on the web escape hatch; native only refreshes.
//
//  Endpoint (same as web/iOS):
//    GET /api/operations/system-diagnostics?business_id=…   → whole diagnostics bundle
//  The route answers flat ({ok, generatedAt, config, …}) today; a nested data wrapper
//  is unwrapped too in case the route later moves onto apiDataSuccess.
//  Blocks: System config (status-dot badges + red warning lines) · Telegram queue
//  (by-status tiles + pending/stuck/retry/dead-letter/latency/oldest) · Selfie photo
//  storage last 24h (totals + recent rows with storage-type verdicts) · Recent Telegram
//  delivery log. 403 → "SUPER_ADMIN only" (web toast wording).
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
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
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SysDiagPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)

    /** Web StatusBadge map: QUEUED amber · SENDING violet · SENT green · FAILED red · else muted. */
    fun queueStatus(s: String, dark: Boolean): Color = when (s) {
        "QUEUED" -> amber600
        "SENDING" -> AlmaTheme.violet
        "SENT" -> emerald600
        "FAILED" -> red500
        else -> AlmaTheme.inkSecondary(dark)
    }

    /** Web StorageTypeBadge: supabase ✓ green · inline_base64 ⚠ amber · unknown ✗ red. */
    fun storageType(t: String?): Pair<String, Color> = when (t) {
        "supabase" -> "supabase ✓" to emerald600
        "inline_base64" -> "inline_base64 ⚠" to amber600
        else -> "unknown ✗" to red500
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

/** Business picker options (global business switcher parity — iOS SysDiagBusiness). */
private val sysDiagBusinesses: List<Pair<String, String>>
    get() = listOf(
        "ALMA_LIFESTYLE" to "Alma Lifestyle",
        "ALMA_TRADING" to "Alma Trading",
        "CREATIVE_DIGITAL_IT" to "Creative Digital IT",
    )

// ── Models (same field names the web DiagnosticsData type declares) ────────────────

private data class DiagConfig(
    val botTokenConfigured: Boolean,
    val cronSecretConfigured: Boolean,
    val ownerChatIdsConfigured: Boolean,
    val ownerRoutingSource: String?,
    val ownerChatIdsCount: Int?,
    val storageConfigured: Boolean,
) {
    companion object {
        fun from(o: JSONObject?): DiagConfig? {
            if (o == null) return null
            return DiagConfig(
                botTokenConfigured = o.flexBool("botTokenConfigured") ?: false,
                cronSecretConfigured = o.flexBool("cronSecretConfigured") ?: false,
                ownerChatIdsConfigured = o.flexBool("ownerChatIdsConfigured") ?: false,
                ownerRoutingSource = o.str("ownerRoutingSource"),
                ownerChatIdsCount = o.flexInt("ownerChatIdsCount"),
                storageConfigured = o.flexBool("storageConfigured") ?: false,
            )
        }
    }
}

private data class DiagQueue(
    val byStatus: List<Pair<String, Int>>,
    val pendingDepth: Int,
    val stuckSending: Int,
    val retryWaitCount: Int,
    val failedDeadLetter: Int?,
    val maxAttempts: Int?,
    val oldestEventType: String?,
    val oldestAgeMinutes: Int?,
    val averageDeliveryLatencyMs: Int?,
) {
    companion object {
        fun from(o: JSONObject?): DiagQueue? {
            if (o == null) return null
            val oldest = o.optJSONObject("oldestQueued")
            return DiagQueue(
                byStatus = o.optJSONArray("byStatus")?.mapObjects { s ->
                    s.str("status")?.let { it to (s.flexInt("count") ?: 0) }
                } ?: emptyList(),
                pendingDepth = o.flexInt("pendingDepth") ?: 0,
                stuckSending = o.flexInt("stuckSending") ?: 0,
                retryWaitCount = o.flexInt("retryWaitCount") ?: 0,
                failedDeadLetter = o.flexInt("failedDeadLetter"),
                maxAttempts = o.flexInt("maxAttempts"),
                oldestEventType = oldest?.str("eventType"),
                oldestAgeMinutes = oldest?.flexInt("ageMinutes"),
                averageDeliveryLatencyMs = o.flexInt("averageDeliveryLatencyMs"),
            )
        }
    }
}

private data class DiagSelfieLog(
    val id: String,
    val employeeId: String?,
    val capturedAt: String?,
    val sizeBytes: Int?,
    val storageType: String?,
    val reviewedAt: String?,
) {
    companion object {
        fun from(o: JSONObject): DiagSelfieLog = DiagSelfieLog(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            employeeId = o.str("employeeId"),
            capturedAt = o.str("capturedAt"),
            sizeBytes = o.flexInt("sizeBytes"),
            storageType = o.str("storageType"),
            reviewedAt = o.str("reviewedAt"),
        )
    }
}

private data class DiagSelfieStorage(
    val last24hTotal: Int,
    val missingStorageRefCount: Int,
    val recentLogs: List<DiagSelfieLog>,
) {
    companion object {
        fun from(o: JSONObject?): DiagSelfieStorage? {
            if (o == null) return null
            return DiagSelfieStorage(
                last24hTotal = o.flexInt("last24hTotal") ?: 0,
                missingStorageRefCount = o.flexInt("missingStorageRefCount") ?: 0,
                recentLogs = o.optJSONArray("recentLogs")?.mapObjects { DiagSelfieLog.from(it) } ?: emptyList(),
            )
        }
    }
}

private data class DiagTelegramLog(
    val id: String,
    val eventType: String?,
    val status: String,
    val attempts: Int?,
    val maxAttempts: Int?,
    val errorMessage: String?,
    val ageMinutes: Int?,
) {
    companion object {
        fun from(o: JSONObject): DiagTelegramLog = DiagTelegramLog(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            eventType = o.str("eventType"),
            status = o.str("status") ?: "—",
            attempts = o.flexInt("attempts"),
            maxAttempts = o.flexInt("maxAttempts"),
            errorMessage = o.str("errorMessage"),
            ageMinutes = o.flexInt("ageMinutes"),
        )
    }
}

private data class DiagData(
    val generatedAt: String?,
    val config: DiagConfig?,
    val telegramQueue: DiagQueue?,
    val selfieStorage: DiagSelfieStorage?,
    val recentTelegramLogs: List<DiagTelegramLog>,
) {
    companion object {
        fun from(root: JSONObject): DiagData {
            // Flat today; unwrap a nested data wrapper only when it looks like the bundle.
            val d = root.optJSONObject("data")
            val c = if (d != null && (d.has("config") || d.has("telegramQueue"))) d else root
            return DiagData(
                generatedAt = c.str("generatedAt"),
                config = DiagConfig.from(c.optJSONObject("config")),
                telegramQueue = DiagQueue.from(c.optJSONObject("telegramQueue")),
                selfieStorage = DiagSelfieStorage.from(c.optJSONObject("selfieStorage")),
                recentTelegramLogs = c.optJSONArray("recentTelegramLogs")
                    ?.mapObjects { DiagTelegramLog.from(it) } ?: emptyList(),
            )
        }
    }
}

// ── State holder (iOS SystemDiagnosticsVM twin) ────────────────────────────────────

private class SystemDiagnosticsState {
    var businessId by mutableStateOf("ALMA_LIFESTYLE")     // web DEFAULT_BUSINESS_ID
    var data by mutableStateOf<DiagData?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            val root = AlmaApi.getObject(
                "/api/operations/system-diagnostics",
                mapOf("business_id" to businessId),
            )
            data = DiagData.from(root)
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: AlmaApiException.Http) {
            // The route is SUPER_ADMIN-only — same wording the web toast surfaces.
            error = if (e.status == 403) "SUPER_ADMIN only" else e.message
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

@Composable
fun SystemDiagnosticsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SystemDiagnosticsState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Header (web PageHeader subtitle + Refresh action).
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Telegram queue এবং photo storage-এর read-only অবস্থা। SUPER_ADMIN only.",
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

        item {
            // Business picker (web global business switcher parity).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                sysDiagBusinesses.forEach { (id, name) ->
                    SysDiagChip(name, vm.businessId == id, dark) {
                        vm.businessId = id
                        scope.launch { vm.load() }
                    }
                }
            }
        }

        if (vm.authExpired) {
            item { SysDiagAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { SysDiagNotice(it, SysDiagPalette.red500, dark) } }

        if (vm.loading && vm.data == null) {
            items(4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            vm.data?.let { d ->
                item { SysDiagConfigCard(d.config, dark) }
                item { SysDiagQueueCard(d.telegramQueue, dark) }
                item { SysDiagSelfieCard(d.selfieStorage, dark) }
                item { SysDiagLogCard(d.recentTelegramLogs, d.generatedAt, dark) }
            }
        }

        item {
            // The mutating actions (Process now / Retry) intentionally live ONLY here.
            Text(
                "🌐 সব অ্যাকশন (Process/Retry সহ) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/operations/system-diagnostics", "System diagnostics") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun SysDiagChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SysDiagPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SysDiagPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SysDiagPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun SysDiagNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun SysDiagAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SysDiagPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun SysDiagSectionTitle(text: String, dark: Boolean) {
    Text(
        text.uppercase(),
        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun SysDiagWarningLine(text: String, tint: Color = SysDiagPalette.red500) {
    Text(text, color = tint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
}

// ── System config (web ConfigBadge dots + red warning lines) ───────────────────────

@Composable
private fun SysDiagConfigCard(config: DiagConfig?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SysDiagSectionTitle("System config", dark)
        SysDiagStatusDotRow("Telegram Bot Token", config?.botTokenConfigured ?: false, dark)
        SysDiagStatusDotRow("CRON_SECRET", config?.cronSecretConfigured ?: false, dark)
        SysDiagStatusDotRow(
            "Owner Chat IDs", config?.ownerChatIdsConfigured ?: false, dark,
            trailing = config?.ownerChatIdsCount?.toString(),
        )
        SysDiagStatusDotRow("Supabase Storage", config?.storageConfigured ?: false, dark)

        if (config?.cronSecretConfigured == false) {
            SysDiagWarningLine("⚠ CRON_SECRET is not set — Vercel cron job will return 500 and no Telegram rows will be processed automatically. Set CRON_SECRET in Vercel environment variables.")
        }
        if (config?.botTokenConfigured == false) {
            SysDiagWarningLine("⚠ TELEGRAM_BOT_TOKEN is missing — all deliveries will fail immediately.")
        }
        if (config?.ownerChatIdsConfigured == false) {
            SysDiagWarningLine("⚠ No owner Telegram chat IDs (DB or TELEGRAM_OWNER_CHAT_IDS env) — check-in alerts are skipped at enqueue. Configure IDs in Settings → Telegram Ops.")
        }
        if (config?.ownerRoutingSource == "disabled") {
            SysDiagWarningLine(
                "⚠ Telegram ops is disabled for this business — notifications will not enqueue.",
                tint = SysDiagPalette.amber600,
            )
        }
    }
}

/** Web ConfigBadge, re-set as a native status-dot service row. */
@Composable
private fun SysDiagStatusDotRow(label: String, ok: Boolean, dark: Boolean, trailing: String? = null) {
    val tint = if (ok) SysDiagPalette.emerald600 else SysDiagPalette.red500
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(tint))
        Text(label, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        trailing?.let {
            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            if (ok) "OK" else "MISSING",
            color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier
                .background(tint.copy(alpha = 0.12f), CircleShape)
                .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

// ── Telegram queue (web by-status grid + health metric tiles) ──────────────────────

@Composable
private fun SysDiagQueueCard(q: DiagQueue?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SysDiagSectionTitle("Telegram queue", dark)

        val byStatus = q?.byStatus.orEmpty()
        if (byStatus.isNotEmpty()) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                byStatus.forEach { (status, count) ->
                    val tint = SysDiagPalette.queueStatus(status, dark)
                    Column(
                        Modifier.widthIn(min = 78.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Box(Modifier.size(6.dp).clip(CircleShape).background(tint))
                            Text(status, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                        }
                        Text("$count", color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        val pending = q?.pendingDepth ?: 0
        val stuck = q?.stuckSending ?: 0
        val dead = q?.failedDeadLetter ?: 0
        SysDiagMetricRow(
            "Pending depth", "$pending", dark,
            tint = if (pending > 0) SysDiagPalette.amber600 else SysDiagPalette.emerald600,
        )
        SysDiagMetricRow(
            "Stuck sending", "$stuck", dark,
            tint = if (stuck > 0) SysDiagPalette.red500 else SysDiagPalette.emerald600,
        )
        SysDiagMetricRow("Retry wait", "${q?.retryWaitCount ?: 0}", dark)
        SysDiagMetricRow(
            "Dead letter (max attempts)",
            "$dead${q?.maxAttempts?.let { " / $it" } ?: ""}", dark,
            tint = if (dead > 0) SysDiagPalette.red500 else SysDiagPalette.emerald600,
        )
        SysDiagMetricRow(
            "Avg delivery latency",
            q?.averageDeliveryLatencyMs?.let { "${it}ms" } ?: "N/A", dark,
        )
        val oldestType = q?.oldestEventType
        val oldestAge = q?.oldestAgeMinutes
        if (oldestType != null || oldestAge != null) {
            SysDiagMetricRow(
                "Oldest pending",
                "${oldestType ?: "—"} · ${oldestAge ?: 0}min ago", dark,
                tint = SysDiagPalette.amber600,
            )
        } else {
            SysDiagMetricRow("Oldest pending", "None", dark, tint = SysDiagPalette.emerald600)
        }
    }
}

@Composable
private fun SysDiagMetricRow(label: String, value: String, dark: Boolean, tint: Color? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(
            value,
            color = tint ?: AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
            textAlign = TextAlign.End,
        )
    }
}

// ── Selfie photo storage (last 24h) ────────────────────────────────────────────────

@Composable
private fun SysDiagSelfieCard(s: DiagSelfieStorage?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SysDiagSectionTitle("Selfie photo storage (last 24h)", dark)

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SysDiagSelfieKpi("TOTAL SELFIES", "${s?.last24hTotal ?: 0}", AlmaTheme.ink(dark), dark, Modifier.weight(1f))
            val missing = s?.missingStorageRefCount ?: 0
            SysDiagSelfieKpi(
                "MISSING STORAGE REF", "$missing",
                if (missing > 0) SysDiagPalette.red500 else SysDiagPalette.emerald600,
                dark, Modifier.weight(1f),
            )
        }

        (s?.missingStorageRefCount ?: 0).takeIf { it > 0 }?.let { missing ->
            SysDiagWarningLine("⚠ $missing selfie row(s) in the last 24h lack a valid Supabase storage reference. These may be legacy inline base64 rows. Telegram cannot deliver photos for these.")
        }

        s?.recentLogs?.takeIf { it.isNotEmpty() }?.let { logs ->
            Column {
                logs.forEachIndexed { idx, row ->
                    SysDiagSelfieLogRow(row, dark)
                    if (idx < logs.size - 1) {
                        Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.4f)))
                    }
                }
            }
        }
    }
}

@Composable
private fun SysDiagSelfieKpi(label: String, value: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(value, color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun SysDiagSelfieLogRow(row: DiagSelfieLog, dark: Boolean) {
    val (storageLabel, storageTint) = SysDiagPalette.storageType(row.storageType)
    Column(Modifier.padding(vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                row.employeeId ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 12.sp,
                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            Text(storageLabel, color = storageTint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            row.sizeBytes?.let {
                Text(
                    "${it / 1024}KB",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
            }
            SysDiagFormat.dateTime(row.capturedAt)?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Spacer(Modifier.weight(1f))
            Text(
                if (row.reviewedAt != null) "Reviewed ✓" else "Not reviewed",
                color = if (row.reviewedAt != null) SysDiagPalette.emerald600 else AlmaTheme.inkSecondary(dark),
                fontSize = 10.sp,
            )
        }
    }
}

// ── Recent Telegram delivery log ───────────────────────────────────────────────────

@Composable
private fun SysDiagLogCard(logs: List<DiagTelegramLog>, generatedAt: String?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SysDiagSectionTitle("Recent Telegram delivery log", dark)

        if (logs.isEmpty()) {
            Text("No Telegram queue rows found.", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        } else {
            Column {
                logs.forEachIndexed { idx, row ->
                    SysDiagTelegramLogRow(row, dark)
                    if (idx < logs.size - 1) {
                        Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark).copy(alpha = 0.4f)))
                    }
                }
            }
        }

        SysDiagFormat.dateTime(generatedAt)?.let {
            Text("Generated $it · Read-only diagnostics", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        }
    }
}

@Composable
private fun SysDiagTelegramLogRow(row: DiagTelegramLog, dark: Boolean) {
    val tint = SysDiagPalette.queueStatus(row.status, dark)
    Column(Modifier.padding(vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(tint))
            Text(
                (row.eventType ?: "—").replace("ATTENDANCE_", ""),
                color = AlmaTheme.ink(dark), fontSize = 12.sp,
                fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                row.status,
                color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(tint.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.attempts?.let {
                Text(
                    "$it/${row.maxAttempts ?: 0}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
            }
            row.ageMinutes?.let {
                Text("${it}m", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
        row.errorMessage?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it, color = SysDiagPalette.red500, fontSize = 10.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SysDiagFormat {
    /** ISO string → "5/7/2026, 8:50 PM" style (web toLocaleString), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        for (p in patterns) {
            try {
                val parser = SimpleDateFormat(p, Locale.US)
                parser.timeZone = TimeZone.getTimeZone("UTC")
                val date = parser.parse(iso) ?: continue
                val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
                f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
                return f.format(date)
            } catch (_: Exception) { }
        }
        return null
    }
}
