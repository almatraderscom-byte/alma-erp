//
//  SettingsSmsScreen.kt
//  ALMA ERP — /settings/sms, ported 1:1 from SettingsSmsSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET   /api/sms/logs?business_id=…&status=…  → { logs, stats, catalog, setting }
//    GET   /api/sms/balance                      → provider blob { balance, currency, … }
//    PATCH /api/sms/logs   { business_id, enabled } | { business_id, enabled_types }
//    POST  /api/sms/test   { business_id, phone }
//    POST  /api/sms/retry  { id } · POST /api/sms/report { id }
//  Blocks: business chips · balance hero (provider balance + master switch with
//  confirm) · 5 KPI cards · SMS type catalog toggles + Save types + test SMS ·
//  log rows with delivery-status pills + per-row Retry/Report.
//  Carried lessons: lenient decoding, ONE list placeholder, never a global overlay.
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
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
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SettingsSmsPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)

    /** Delivery pill: DELIVERED/SENT emerald · FAILED red · QUEUED/PENDING/SENDING amber. */
    fun status(s: String): Color = when (s.uppercase()) {
        "DELIVERED", "SENT" -> emerald600
        "FAILED" -> red500
        else -> amber500
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names /api/sms/logs returns) ────────────────────────────────

private data class SettingsSmsLogRow(
    val id: String,
    val phone: String?,
    val message: String?,
    val type: String?,
    val status: String,
    val errorCode: String?,
    val errorMessage: String?,
    val requestId: String?,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject) = SettingsSmsLogRow(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            phone = o.str("phone"),
            message = o.str("message"),
            type = o.str("type"),
            status = o.str("status") ?: "QUEUED",
            errorCode = o.str("errorCode"),
            errorMessage = o.str("errorMessage"),
            requestId = o.str("requestId"),
            createdAt = o.str("createdAt"),
        )
    }
}

private data class SettingsSmsStats(
    val total: Int = 0,
    val delivered: Int = 0,
    val failed: Int = 0,
    val queued: Int = 0,
    val successPct: Int = 0,
) {
    companion object {
        fun from(o: JSONObject?) = SettingsSmsStats(
            total = o?.flexInt("total") ?: 0,
            delivered = o?.flexInt("delivered") ?: 0,
            failed = o?.flexInt("failed") ?: 0,
            queued = o?.flexInt("queued") ?: 0,
            successPct = o?.flexInt("successPct") ?: 0,
        )
    }
}

/** smsSettingDto: { businessId, enabled, senderId, enabledTypes }. */
private data class SettingsSmsSetting(
    val enabled: Boolean,
    val senderId: String?,
    val enabledTypes: List<String>,
) {
    companion object {
        fun from(o: JSONObject): SettingsSmsSetting {
            val types = ArrayList<String>()
            o.optJSONArray("enabledTypes")?.let { arr ->
                for (i in 0 until arr.length()) arr.optString(i, null)?.let(types::add)
            }
            return SettingsSmsSetting(
                enabled = o.flexBool("enabled") ?: false,
                senderId = o.str("senderId"),
                enabledTypes = types,
            )
        }
    }
}

/** One SMS_TYPE_CATALOG entry — the "template" list the web renders as checkboxes. */
private data class SettingsSmsCatalogItem(
    val type: String,
    val label: String?,
    val labelBn: String?,
    val description: String?,
) {
    companion object {
        fun from(o: JSONObject) = SettingsSmsCatalogItem(
            type = o.str("type") ?: "—",
            label = o.str("label"),
            labelBn = o.str("labelBn"),
            description = o.str("description"),
        )
    }
}

// ── State holder (iOS SettingsSmsVM twin) ──────────────────────────────────────────

private class SettingsSmsState {
    var logs by mutableStateOf(listOf<SettingsSmsLogRow>())
    var stats by mutableStateOf(SettingsSmsStats())
    var catalog by mutableStateOf(listOf<SettingsSmsCatalogItem>())
    var setting by mutableStateOf<SettingsSmsSetting?>(null)
    var balanceText by mutableStateOf("—")
    var businessId by mutableStateOf("ALMA_LIFESTYLE")
    var statusFilter by mutableStateOf("ALL")   // ALL | QUEUED | PENDING | SENDING | SENT | DELIVERED | FAILED
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    var toast by mutableStateOf<String?>(null)
    var pendingTypes by mutableStateOf(setOf<String>())   // draft enabled_types before "Save types"
    var typesDirty by mutableStateOf(false)
    var writing by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/sms/logs",
                    mapOf("business_id" to businessId, "status" to statusFilter),
                ),
            )
            logs = c.optJSONArray("logs")?.mapObjects { SettingsSmsLogRow.from(it) } ?: emptyList()
            stats = SettingsSmsStats.from(c.optJSONObject("stats"))
            catalog = c.optJSONArray("catalog")?.mapObjects { SettingsSmsCatalogItem.from(it) } ?: emptyList()
            setting = c.optJSONObject("setting")?.let { SettingsSmsSetting.from(it) }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "SMS settings load failed — আবার চেষ্টা করুন"
        } finally {
            loading = false
        }
        loadBalance()   // best-effort; a provider hiccup never blanks the page
    }

    /** The provider blob is free-form — mirror the web's balanceText logic over raw JSON. */
    private suspend fun loadBalance() {
        if (authExpired) return
        balanceText = try {
            balanceDisplay(AlmaApi.get("/api/sms/balance"))
        } catch (_: Exception) {
            "—"
        }
    }

    private fun balanceDisplay(raw: String): String {
        val trimmed = raw.trim()
        try {
            if (trimmed.startsWith("{")) {
                val o = JSONObject(trimmed)
                for (key in listOf("balance", "amount", "credits", "sms_balance")) {
                    if (o.has(key) && !o.isNull(key)) {
                        val v = o.opt(key).toString()
                        val cur = o.str("currency") ?: o.str("unit")
                        return if (cur != null) "$v $cur" else v
                    }
                }
            } else if (trimmed.startsWith("[")) {
                JSONArray(trimmed)   // valid array — fall through to raw text
            }
        } catch (_: Exception) { }
        return if (trimmed.length > 80) trimmed.take(80) + "..." else trimmed.ifEmpty { "—" }
    }

    // ── Writes (web patchSetting / sendTestSms / retry / report parity) ──

    private suspend fun write(success: String, op: suspend () -> JSONObject) {
        writing = true
        try {
            val resp = op()
            val root = resp.optJSONObject("data") ?: resp
            val err = root.str("error") ?: resp.str("error")
            toast = err ?: success
            if (err == null) load()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            toast = "Network সমস্যা — আবার চেষ্টা করুন"
        } finally {
            writing = false
        }
    }

    suspend fun setEnabled(enabled: Boolean) = write(
        if (enabled) "SMS enabled for this business" else "SMS disabled",
    ) {
        AlmaApi.send(
            "PATCH", "/api/sms/logs",
            JSONObject().put("business_id", businessId).put("enabled", enabled),
        )
    }

    suspend fun saveTypes() {
        write("SMS types saved") {
            AlmaApi.send(
                "PATCH", "/api/sms/logs",
                JSONObject().put("business_id", businessId).put("enabled_types", JSONArray(pendingTypes.toList())),
            )
        }
        typesDirty = false
    }

    suspend fun sendTest(phone: String) = write("Test SMS queued") {
        AlmaApi.send(
            "POST", "/api/sms/test",
            JSONObject().put("business_id", businessId).put("phone", phone),
        )
    }

    suspend fun retry(id: String) = write("Retry queued") {
        AlmaApi.send("POST", "/api/sms/retry", JSONObject().put("id", id))
    }

    suspend fun report(id: String) = write("Report refreshed") {
        AlmaApi.send("POST", "/api/sms/report", JSONObject().put("id", id))
    }
}

// ── Static option lists (web BUSINESS_LIST / status filter parity) ─────────────────

private val smsBusinesses = listOf(
    "ALMA_LIFESTYLE" to "Alma Lifestyle",
    "CREATIVE_DIGITAL_IT" to "Creative Digital IT",
    "ALMA_TRADING" to "Alma Trading",
)
private val smsStatuses = listOf("ALL", "QUEUED", "PENDING", "SENDING", "SENT", "DELIVERED", "FAILED")

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun SettingsSmsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SettingsSmsState() }
    val scope = rememberCoroutineScope()
    var confirmingMaster by remember { mutableStateOf(false) }
    var testPhone by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            kotlinx.coroutines.delay(2600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.authExpired) {
                item { SmsAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { SmsNoticeCard("⚠️ $it", SettingsSmsPalette.red500, dark) } }

            item {
                // Business chips (the web's business select).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    smsBusinesses.forEach { (id, name) ->
                        SmsChip(name, vm.businessId == id, dark) {
                            vm.businessId = id
                            scope.launch { vm.load() }
                        }
                    }
                }
            }

            item { SmsBalanceHero(vm, dark) { confirmingMaster = true } }

            item {
                // KPI strip (web's 5 KpiCards: Total/Delivered/Failed/Queued/Success).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SmsKpiCard("TOTAL", "${vm.stats.total}", AlmaTheme.ink(dark), dark)
                    SmsKpiCard("DELIVERED", "${vm.stats.delivered}", SettingsSmsPalette.emerald600, dark)
                    SmsKpiCard("FAILED", "${vm.stats.failed}", SettingsSmsPalette.red500, dark)
                    SmsKpiCard("QUEUED", "${vm.stats.queued}", SettingsSmsPalette.amber600, dark)
                    SmsKpiCard("SUCCESS", "${vm.stats.successPct}%", SettingsSmsPalette.goldLt, dark)
                }
            }

            item {
                SmsTemplatesCard(
                    vm, dark, testPhone,
                    onTestPhone = { testPhone = it },
                    onSaveTypes = { scope.launch { vm.saveTypes() } },
                    onSendTest = {
                        val p = testPhone.trim()
                        if (p.isEmpty()) vm.toast = "Test phone number দিন"
                        else scope.launch { vm.sendTest(p) }
                    },
                )
            }

            item {
                // Logs header + status filter chips.
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("SMS logs", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        smsStatuses.forEach { s ->
                            SmsChip(
                                if (s == "ALL") "All" else s.lowercase().replaceFirstChar { it.uppercase() },
                                vm.statusFilter == s, dark,
                            ) {
                                vm.statusFilter = s
                                scope.launch { vm.load() }
                            }
                        }
                    }
                }
            }

            if (vm.loading && vm.logs.isEmpty()) {
                items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            }

            items(vm.logs, key = { it.id }) { row ->
                SettingsSmsLogCard(
                    row, dark,
                    busy = vm.writing,
                    onRetry = { scope.launch { vm.retry(row.id) } },
                    onReport = { scope.launch { vm.report(row.id) } },
                )
            }

            if (!vm.loading && vm.logs.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("✉️", fontSize = 34.sp)
                        Text("No SMS logs yet.", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                    }
                }
            }

            item {
                Text(
                    "🌐 সব অপশন — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/settings/sms", "SMS") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }
        }

        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 22)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    if (confirmingMaster) {
        val on = vm.setting?.enabled == true
        AlertDialog(
            onDismissRequest = { confirmingMaster = false },
            title = { Text(if (on) "এই business-এর SMS বন্ধ করবেন?" else "এই business-এর SMS চালু করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingMaster = false
                    scope.launch { vm.setEnabled(!on) }
                }) { Text(if (on) "হ্যাঁ, বন্ধ করুন" else "হ্যাঁ, চালু করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmingMaster = false }) { Text("বাতিল") } },
        )
    }
}

// ── Balance hero (web "Business & master switch" card, re-set as a hero) ───────────

@Composable
private fun SmsBalanceHero(vm: SettingsSmsState, dark: Boolean, onMasterTap: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier
                    .size(36.dp)
                    .background(
                        Brush.linearGradient(listOf(SettingsSmsPalette.coral, AlmaTheme.violet)),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) { Text("💬", fontSize = 15.sp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("SMS BALANCE", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                Text(
                    vm.balanceText,
                    color = SettingsSmsPalette.accentText(dark),
                    fontSize = 17.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            // Master switch — confirm dialog before PATCH (web saveEnabled parity).
            val on = vm.setting?.enabled == true
            val tint = if (on) SettingsSmsPalette.emerald600 else SettingsSmsPalette.red500
            Text(
                if (on) "⏻ SMS চালু" else "⭘ SMS বন্ধ",
                color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(tint.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
                    .plainClick(onMasterTap)
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }
        vm.setting?.senderId?.takeIf { it.isNotEmpty() }?.let {
            Text(
                "Sender: $it",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontFamily = FontFamily.Monospace,
            )
        }
        // Web hint, verbatim.
        Text(
            "Recharge-এর পর Enable SMS চাপুন। Master switch বন্ধ থাকলে নিচের কোনো type চালু থাকলেও SMS যাবে না।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
    }
}

// ── Templates (web "কোন SMS চালু থাকবে" — native toggles) ───────────────────────────

@Composable
private fun SmsTemplatesCard(
    vm: SettingsSmsState,
    dark: Boolean,
    testPhone: String,
    onTestPhone: (String) -> Unit,
    onSaveTypes: () -> Unit,
    onSendTest: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("কোন SMS চালু থাকবে", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (vm.typesDirty) {
                Text(
                    "Save types",
                    color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(SettingsSmsPalette.emerald600, CircleShape)
                        .plainClick(onSaveTypes)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
        if (vm.catalog.isEmpty()) {
            Text(
                if (vm.loading) "Loading…" else "—",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        } else {
            vm.catalog.forEach { item ->
                val checked = if (vm.typesDirty) item.type in vm.pendingTypes
                else vm.setting?.enabledTypes?.contains(item.type) == true
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            item.labelBn ?: item.label ?: item.type,
                            color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        )
                        item.description?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                        }
                    }
                    Switch(
                        checked = checked,
                        onCheckedChange = { on ->
                            if (!vm.typesDirty) {
                                vm.pendingTypes = (vm.setting?.enabledTypes ?: emptyList()).toSet()
                                vm.typesDirty = true
                            }
                            vm.pendingTypes = if (on) vm.pendingTypes + item.type else vm.pendingTypes - item.type
                        },
                        colors = SwitchDefaults.colors(checkedTrackColor = SettingsSmsPalette.emerald600),
                    )
                }
            }
        }
        // Native test-SMS (web sendTestSms parity).
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = testPhone,
                onValueChange = onTestPhone,
                placeholder = { Text("Test phone (01XXXXXXXXX)", fontSize = 12.sp) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Text(
                "Test SMS",
                color = SettingsSmsPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(SettingsSmsPalette.coral.copy(alpha = 0.13f), CircleShape)
                    .border(1.dp, SettingsSmsPalette.coral.copy(alpha = 0.35f), CircleShape)
                    .plainClick(onSendTest)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

// ── Log row card (one web table row as a native card) ──────────────────────────────

@Composable
private fun SettingsSmsLogCard(
    row: SettingsSmsLogRow,
    dark: Boolean,
    busy: Boolean,
    onRetry: () -> Unit,
    onReport: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.phone ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f),
            )
            val tint = SettingsSmsPalette.status(row.status)
            Text(
                row.status.uppercase(),
                color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(tint.copy(alpha = 0.12f), CircleShape)
                    .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }
        val meta = buildList {
            SettingsSmsFormat.dateTime(row.createdAt)?.let(::add)
            row.type?.takeIf { it.isNotEmpty() }?.let { add(it.replace("_", " ")) }
        }
        Text(
            if (meta.isEmpty()) "—" else meta.joinToString(" · "),
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        row.message?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it, color = AlmaTheme.ink(dark).copy(alpha = 0.85f), fontSize = 12.sp,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
        }
        row.errorCode?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = SettingsSmsPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        row.errorMessage?.takeIf { it.isNotEmpty() }?.let {
            Text(
                it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        // Per-row Retry (FAILED, errorCode≠CANCELLED) + Report (requestId) — web parity.
        val canRetry = row.status.uppercase() == "FAILED" && row.errorCode != "CANCELLED"
        val canReport = !row.requestId.isNullOrEmpty()
        if (canRetry || canReport) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (canRetry) SmsActionChip("Retry", SettingsSmsPalette.amber600) { if (!busy) onRetry() }
                if (canReport) SmsActionChip("Report", SettingsSmsPalette.emerald600) { if (!busy) onReport() }
                if (busy) {
                    CircularProgressIndicator(Modifier.size(12.dp), color = SettingsSmsPalette.coral, strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun SmsActionChip(label: String, tint: Color, onClick: () -> Unit) {
    Text(
        label,
        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.3f), CircleShape)
            .plainClick(onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun SmsChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SettingsSmsPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SettingsSmsPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SettingsSmsPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

/** Light bento tile: soft accent wash of the KPI's own tint over glass. */
@Composable
private fun SmsKpiCard(label: String, value: String, tint: Color, dark: Boolean) {
    Column(
        Modifier
            .widthIn(min = 84.dp)
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .background(
                Brush.linearGradient(
                    listOf(tint.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp)
        Spacer(Modifier.height(3.dp))
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun SmsNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun SmsAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SettingsSmsPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SettingsSmsFormat {
    /** createdAt → "5/7/26, 8:50 PM" style (web: new Date(...).toLocaleString()), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        )
        var date: Date? = null
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.timeZone = TimeZone.getTimeZone("UTC")
                date = f.parse(iso)
                break
            } catch (_: Exception) { }
        }
        val d = date ?: return null
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(d)
    }
}
