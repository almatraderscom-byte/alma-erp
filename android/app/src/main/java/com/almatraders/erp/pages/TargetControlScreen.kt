//
//  TargetControlScreen.kt
//  ALMA ERP — Trading Target Control, Kotlin/Compose twin of TargetControlSwiftUI.swift
//  (web /trading/target-control parity). Same endpoints, same numbers, same blocks:
//    GET   /api/trading/volume-targets?date=YYYY-MM-DD   → { targets, canManage }
//    GET   /api/trading/volume-targets/settings          → { settings, canManage }
//    GET   /api/trading/volume-targets/analytics?month=  → { analytics | summary }
//    GET   /api/trading/accounts?status=ACTIVE           → create-sheet picker
//  Money writes (owner 2026-07-11, FINANCIALLY SENSITIVE — exact snake_case payloads,
//  confirm dialog before each, SUPER_ADMIN gated via canManage):
//    POST   /api/trading/volume-targets            { trading_account_id, target_date,
//                                                    target_usdt, penalty_amount_bdt? }
//    POST   /api/trading/volume-targets/{id}/actions { action: REFRESH | APPLY_PENALTY |
//                                                    WAIVE_PENALTY | IGNORE, amount_bdt?,
//                                                    waive_amount_bdt? }
//    DELETE /api/trading/volume-targets/{id}
//    PATCH  /api/trading/volume-targets/settings   { auto_penalty_enabled, default_penalty_bdt }
//  Carried lessons: lenient row decoding, ONE spinner pattern, no global overlays,
//  confirm dialog before every money write (iOS confirmationDialog parity).
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
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
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object TCPalette {
    val tradingGreen = Color(0xFF82B399)
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val slate400 = Color(0xFF94A3B8)

    fun accentText(dark: Boolean) = if (dark) goldLt else goldDim
    fun positive(dark: Boolean) = if (dark) green400 else emerald600

    /** Target status tints: MET green · MISSED red · IGNORED slate · PENDING amber. */
    fun status(s: String?, dark: Boolean) = when (s) {
        "MET" -> positive(dark)
        "MISSED" -> red500
        "IGNORED" -> slate400
        else -> if (dark) amber500 else amber600
    }

    /** Penalty pill tints: APPLIED red · WAIVED slate · PARTIALLY_WAIVED gold · PENDING amber. */
    fun penalty(s: String?, dark: Boolean) = when (s) {
        "APPLIED" -> red400
        "WAIVED" -> slate400
        "PARTIALLY_WAIVED" -> accentText(dark)
        else -> if (dark) amber500 else amber600
    }
}

// ── Formatting helpers ──────────────────────────────────────────────────────────────

private object TCFormat {
    /** USDT amounts — whole numbers stay whole, decimals trim to 2 places. */
    fun usdt(v: Double): String {
        if (v == v.toLong().toDouble() && abs(v) < 1e15) return String.format("%,d", v.toLong())
        return String.format("%,.2f", v).trimEnd('0').trimEnd('.')
    }

    fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }.format(Date())

    fun fromPickerMillis(ms: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

    fun num(s: String): Double = s.replace(",", "").trim().toDoubleOrNull() ?: 0.0
}

// ── Models (same field names volumeTargetDto sends on the wire) ─────────────────────

private data class TCPenalty(
    val id: String,
    val status: String,
    val originalAmountBdt: Double,
    val finalPenaltyBdt: Double,
) {
    companion object {
        fun from(o: JSONObject) = TCPenalty(
            o.str("id") ?: "",
            o.str("status") ?: "PENDING",
            o.flexDouble("originalAmountBdt") ?: 0.0,
            o.flexDouble("finalPenaltyBdt") ?: 0.0,
        )
    }
}

private data class TCRow(
    val id: String,
    val accountTitle: String,
    val assignedUserName: String?,
    val targetDate: String,
    val targetUsdt: Double,
    val actualUsdt: Double,
    val shortfallUsdt: Double,
    val status: String,
    val penaltyAmountBdt: Double?,
    val penalty: TCPenalty?,
) {
    /** 0…1 fill for the progress bar (never NaN when target is 0). */
    val progress: Double
        get() = if (targetUsdt > 0) min(1.0, max(0.0, actualUsdt / targetUsdt)) else if (actualUsdt > 0) 1.0 else 0.0

    companion object {
        fun from(o: JSONObject): TCRow {
            val title = o.str("accountTitle") ?: "Trading account"
            val date = o.str("targetDate") ?: ""
            val target = o.flexDouble("targetUsdt") ?: 0.0
            val actual = o.flexDouble("actualUsdt") ?: 0.0
            return TCRow(
                o.str("id") ?: "$title-$date",
                title,
                o.str("assignedUserName"),
                date,
                target,
                actual,
                o.flexDouble("shortfallUsdt") ?: max(0.0, target - actual),
                o.str("status") ?: "PENDING",
                o.flexDouble("penaltyAmountBdt"),
                o.optJSONObject("penalty")?.let { TCPenalty.from(it) },
            )
        }
    }
}

private data class TCSettings(val autoPenaltyEnabled: Boolean, val defaultPenaltyBdt: Int) {
    companion object {
        fun from(o: JSONObject) = TCSettings(
            o.flexBool("autoPenaltyEnabled") ?: false,
            o.flexInt("defaultPenaltyBdt") ?: 500,
        )
    }
}

private data class TCOffender(val employeeId: String, val count: Int)

private data class TCAnalytics(
    val month: String,
    val targetCount: Int,
    val met: Int,
    val missed: Int,
    val ignored: Int,
    val totalAppliedBdt: Int?,
    val totalWaivedBdt: Int?,
    val netPenaltiesBdt: Int?,
    val repeatOffenders: List<TCOffender>,
) {
    companion object {
        fun from(o: JSONObject) = TCAnalytics(
            o.str("month") ?: "",
            o.flexInt("targetCount") ?: 0,
            o.flexInt("met") ?: 0,
            o.flexInt("missed") ?: 0,
            o.flexInt("ignored") ?: 0,
            o.flexInt("totalAppliedBdt"),
            o.flexInt("totalWaivedBdt"),
            o.flexInt("netPenaltiesBdt"),
            o.optJSONArray("repeatOffenders")?.mapObjects {
                TCOffender(it.str("employeeId") ?: "—", it.flexInt("count") ?: 0)
            } ?: emptyList(),
        )
    }
}

private enum class TCTab(val label: String) { TARGETS("Accounts"), PENALTIES("Penalty queue"), ANALYTICS("Analytics"), SETTINGS("Settings") }

// ── State holder (iOS TargetControlVM twin) ─────────────────────────────────────────

private class TargetControlState {
    var dateParam by mutableStateOf(TCFormat.today())
    var targets by mutableStateOf(listOf<TCRow>())
    var settings by mutableStateOf<TCSettings?>(null)
    var analytics by mutableStateOf<TCAnalytics?>(null)
    var canManage by mutableStateOf(false)
    var tab by mutableStateOf(TCTab.TARGETS)
    var loading by mutableStateOf(false)
    var loadedOnce by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var busyId by mutableStateOf<String?>(null)
    var accounts by mutableStateOf(listOf<Pair<String, String>>())

    val monthParam: String get() = dateParam.take(7)

    /** Web penaltyQueue: MISSED rows whose penalty is absent or still PENDING. */
    val penaltyQueue: List<TCRow>
        get() = targets.filter { it.status == "MISSED" && (it.penalty == null || it.penalty.status == "PENDING") }

    val dayTarget: Double get() = targets.sumOf { it.targetUsdt }
    val dayActual: Double get() = targets.sumOf { it.actualUsdt }
    val dayProgress: Double
        get() = if (dayTarget > 0) min(1.0, max(0.0, dayActual / dayTarget)) else if (dayActual > 0) 1.0 else 0.0
    val dayMet: Int get() = targets.count { it.status == "MET" }

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            coroutineScope {
                val l = async { AlmaApi.getObject("/api/trading/volume-targets", mapOf("date" to dateParam)) }
                val s = async { AlmaApi.getObject("/api/trading/volume-targets/settings") }
                val a = async { AlmaApi.getObject("/api/trading/volume-targets/analytics", mapOf("month" to monthParam)) }

                val list = unwrap(l.await())
                targets = list.optJSONArray("targets")?.mapObjects { TCRow.from(it) } ?: emptyList()
                canManage = list.flexBool("canManage") ?: false

                settings = unwrap(s.await()).optJSONObject("settings")?.let { TCSettings.from(it) }

                val an = unwrap(a.await())
                analytics = (an.optJSONObject("analytics") ?: an.optJSONObject("summary"))?.let { TCAnalytics.from(it) }
            }
            authExpired = false
            loadedOnce = true
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

    suspend fun loadAccounts() {
        try {
            accounts = unwrap(AlmaApi.getObject("/api/trading/accounts", mapOf("status" to "ACTIVE")))
                .optJSONArray("accounts")?.mapObjects { row ->
                    row.str("id")?.let { it to (row.str("accountTitle") ?: "Account") }
                } ?: emptyList()
        } catch (_: Exception) { /* picker degrades to empty */ }
    }

    // ── Native writes (FINANCIALLY SENSITIVE — web volumeTarget* verbatim) ──

    private suspend fun write(path: String, method: String, body: JSONObject?, success: String): Boolean {
        return try {
            val resp = AlmaApi.send(method, path, body)
            val err = resp.str("error")
            if (err != null) { toast = err; false } else { toast = success; load(); true }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true; false
        } catch (e: AlmaApiException.Http) {
            toast = e.message; false
        } catch (e: Exception) {
            toast = e.message ?: "নেটওয়ার্ক সমস্যা"; false
        }
    }

    suspend fun createTarget(accountId: String, targetUsdt: Double, penaltyBdt: Double?): Boolean {
        val body = JSONObject()
            .put("trading_account_id", accountId)
            .put("target_date", dateParam)
            .put("target_usdt", targetUsdt)
        if (penaltyBdt != null) body.put("penalty_amount_bdt", penaltyBdt)
        return write("/api/trading/volume-targets", "POST", body, "Daily target created")
    }

    suspend fun runAction(id: String, action: String, amountBdt: Double? = null, waiveAmountBdt: Double? = null): Boolean {
        busyId = id
        val body = JSONObject().put("action", action)
        if (amountBdt != null) body.put("amount_bdt", amountBdt)
        if (waiveAmountBdt != null) body.put("waive_amount_bdt", waiveAmountBdt)
        val ok = write("/api/trading/volume-targets/$id/actions", "POST", body, "Updated")
        busyId = null
        return ok
    }

    suspend fun deleteTarget(id: String): Boolean {
        busyId = id
        val ok = write("/api/trading/volume-targets/$id", "DELETE", null, "Removed")
        busyId = null
        return ok
    }

    suspend fun saveSettings(autoPenalty: Boolean, defaultPenaltyBdt: Double): Boolean = write(
        "/api/trading/volume-targets/settings", "PATCH",
        JSONObject().put("auto_penalty_enabled", autoPenalty).put("default_penalty_bdt", defaultPenaltyBdt),
        "Auto-penalty settings saved",
    )
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TargetControlScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { TargetControlState() }
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        vm.load()
        vm.loadAccounts()
    }
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) { delay(2600); vm.toast = null }
    }

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Spacer(Modifier.height(2.dp)) }
            item { TCHeroCard(vm.dayActual, vm.dayTarget, vm.dayProgress, vm.targets.size, vm.dayMet) }
            vm.analytics?.let { a ->
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        TCStatTile("Targets", a.targetCount, "এ মাসে মোট", AlmaTheme.ink(dark), TCPalette.tradingGreen, dark, Modifier.weight(1f))
                        TCStatTile("Met", a.met, "টার্গেট পূরণ", TCPalette.positive(dark), TCPalette.green400, dark, Modifier.weight(1f))
                        TCStatTile("Missed", a.missed, "টার্গেট মিস", TCPalette.red400, TCPalette.red500, dark, Modifier.weight(1f))
                        TCStatTile("Ignored", a.ignored, "মাফ করা", TCPalette.slate400, TCPalette.slate400, dark, Modifier.weight(1f))
                    }
                }
            }
            item { TCDateRow(vm, dark) { scope.launch { vm.load() } } }
            item { TCTabChips(vm, dark) }

            if (vm.authExpired) item { TCAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            vm.error?.let { item { TCErrorCard(it, dark) } }

            when (vm.tab) {
                TCTab.TARGETS, TCTab.PENALTIES -> {
                    if (vm.canManage) {
                        item { TCSetTargetButton(dark) { showCreate = true } }
                    }
                    val rows = if (vm.tab == TCTab.PENALTIES) vm.penaltyQueue else vm.targets
                    if (vm.loading && !vm.loadedOnce) {
                        items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
                    } else if (rows.isEmpty() && vm.error == null && !vm.authExpired) {
                        item { TCEmptyState(vm.tab, dark) }
                    } else {
                        items(rows.size) { i -> TCRowCard(rows[i], vm, scope, dark) }
                    }
                }
                TCTab.ANALYTICS -> item { TCAnalyticsCard(vm, dark) }
                TCTab.SETTINGS -> item { TCSettingsCard(vm, scope, dark) { ctx.openWebForced("/trading/target-control", "Target control") } }
            }

            item { Spacer(Modifier.height(8.dp)) }
        }
        }

        vm.toast?.let { t ->
            Text(
                t, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp)
                    .almaGlass(dark, 22).padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    if (showCreate) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            TCCreateSheet(vm, scope, dark) { showCreate = false }
        }
    }
}

// ── Hero + month KPI tiles (dark anchor, sage-green re-tint) ─────────────────────────

private val TC_SAGE_LT = Color(0xFFABD9C1)

@Composable
private fun TCHeroCard(actual: Double, target: Double, progress: Double, accounts: Int, met: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(Color(0xFF14201B))   // deep sage-black in BOTH themes (iOS parity)
            .background(Brush.linearGradient(listOf(TCPalette.tradingGreen.copy(alpha = 0.38f), Color.Transparent)))
            .background(
                Brush.linearGradient(
                    0f to Color.Transparent, 0.55f to Color.Transparent,
                    1f to AlmaTheme.violet.copy(alpha = 0.22f),
                ),
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text("ডেইলি ভলিউম টার্গেট · TRADING", color = TC_SAGE_LT, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(TCFormat.usdt(actual), color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
            Spacer(Modifier.width(6.dp))
            Text("USDT", color = Color.White.copy(alpha = 0.55f), fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 6.dp))
        }
        Text("টার্গেট ${TCFormat.usdt(target)} USDT-এর মধ্যে আজকের ভলিউম", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp, modifier = Modifier.padding(top = 5.dp))

        // Day progress bar.
        Box(
            Modifier.fillMaxWidth().height(7.dp).padding(top = 0.dp).clip(CircleShape)
                .background(Color.White.copy(alpha = 0.12f)),
        ) {
            Box(
                Modifier.fillMaxWidth(progress.toFloat().coerceIn(0.02f, 1f)).height(7.dp).clip(CircleShape)
                    .background(Brush.horizontalGradient(listOf(TCPalette.tradingGreen, TC_SAGE_LT))),
            )
        }
        Spacer(Modifier.height(12.dp))
        Row {
            TCHeroStat("Accounts", "$accounts", Color.White, "আজকের টার্গেট")
            TCHeroDivider()
            TCHeroStat("Met", "$met", TC_SAGE_LT, "টার্গেট পূরণ")
            TCHeroDivider()
            TCHeroStat("Progress", "${(progress * 100).roundToInt()}%", Color.White, "দিনের অগ্রগতি")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun TCHeroDivider() {
    Box(Modifier.padding(horizontal = 12.dp, vertical = 2.dp).width(1.dp).height(40.dp).background(Color.White.copy(alpha = 0.14f)))
}

@Composable
private fun TCHeroStat(label: String, value: String, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label.uppercase(), color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        Text(value, color = tint, fontSize = 20.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

@Composable
private fun TCStatTile(label: String, value: Int, sub: String, tint: Color, accent: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                RoundedCornerShape(AlmaTheme.R_CARD.dp),
            )
            .padding(horizontal = 11.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("$value", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TCDateRow(vm: TargetControlState, dark: Boolean, onReload: () -> Unit) {
    var showPicker by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.CalendarMonth, contentDescription = null, tint = TCPalette.tradingGreen, modifier = Modifier.size(16.dp))
        Text(
            "${vm.dateParam} ▾", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.plainClick { showPicker = true }.padding(vertical = 4.dp),
        )
        Spacer(Modifier.weight(1f))
        if (vm.loading) {
            CircularProgressIndicator(Modifier.size(15.dp), color = AlmaTheme.inkSecondary(dark), strokeWidth = 2.dp)
        } else {
            Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp, modifier = Modifier.plainClick(onReload).padding(2.dp))
        }
    }
    if (showPicker) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { vm.dateParam = TCFormat.fromPickerMillis(it); onReload() }
                    showPicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showPicker = false }) { Text("বাতিল") } },
        ) { DatePicker(state = state) }
    }
}

@Composable
private fun TCTabChips(vm: TargetControlState, dark: Boolean) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TCTab.entries.forEach { t ->
            val active = vm.tab == t
            val badge = if (t == TCTab.PENALTIES) vm.penaltyQueue.size else 0
            val tint = if (t == TCTab.PENALTIES && badge > 0) TCPalette.red400 else TCPalette.tradingGreen
            Row(
                Modifier.clip(CircleShape)
                    .background(if (active) tint.copy(alpha = if (dark) 0.28f else 0.16f) else Color.White.copy(alpha = if (dark) 0.08f else 0.45f))
                    .border(1.dp, if (active) tint.copy(alpha = 0.55f) else Color.White.copy(alpha = if (dark) 0.10f else 0.4f), CircleShape)
                    .plainClick { vm.tab = t }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(t.label, color = if (active) tint else AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
                if (t == TCTab.PENALTIES && badge > 0) {
                    Text("$badge", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun TCAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text("লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(AlmaTheme.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp))
    }
}

@Composable
private fun TCErrorCard(message: String, dark: Boolean) {
    Text("⚠ $message", color = TCPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp))
}

@Composable
private fun TCSetTargetButton(dark: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Text(
        "+ Set target", color = TCPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
            .background(TCPalette.tradingGreen.copy(alpha = 0.10f), shape)
            .border(1.dp, TCPalette.tradingGreen.copy(alpha = 0.3f), shape)
            .plainClick(onClick).padding(vertical = 11.dp),
    )
}

@Composable
private fun TCEmptyState(tab: TCTab, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 44.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("🎯", fontSize = 30.sp)
        Text(if (tab == TCTab.PENALTIES) "কোনো পেনাল্টি বাকি নেই" else "কোনো টার্গেট নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
        Text(
            if (tab == TCTab.PENALTIES) "মিস করা টার্গেটের পেনাল্টি এখানে আসবে" else "এই দিনের জন্য কোনো USDT টার্গেট সেট করা হয়নি",
            color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp, textAlign = TextAlign.Center,
        )
    }
}

// ── Target row card (web account · assignee/date · target vs actual · status pill) ──

@Composable
private fun TCRowCard(row: TCRow, vm: TargetControlState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean) {
    var confirmingDelete by remember { mutableStateOf(false) }
    var confirmingPenalty by remember { mutableStateOf(false) }
    val barTint = when {
        row.status == "MET" || row.progress >= 1 -> TCPalette.positive(dark)
        row.status == "MISSED" -> TCPalette.red400
        else -> if (dark) TCPalette.amber500 else TCPalette.amber600
    }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.accountTitle, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${row.assignedUserName ?: "Unassigned"} · ${row.targetDate.take(10)}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(6.dp))
            TCStatusPill(row.status, dark)
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(TCFormat.usdt(row.actualUsdt), color = barTint, fontSize = 18.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(4.dp))
            Text("/ ${TCFormat.usdt(row.targetUsdt)} USDT", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 2.dp))
            Spacer(Modifier.weight(1f))
            if (row.shortfallUsdt > 0) {
                Text("Short ${TCFormat.usdt(row.shortfallUsdt)}", color = TCPalette.red400, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 2.dp))
            }
        }
        Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(AlmaTheme.ink(dark).copy(alpha = 0.08f))) {
            Box(Modifier.fillMaxWidth(row.progress.toFloat().coerceIn(0.02f, 1f)).height(6.dp).clip(CircleShape)
                .background(Brush.horizontalGradient(listOf(barTint.copy(alpha = 0.75f), barTint))))
        }
        row.penalty?.let { TCPenaltyLine(it, dark) } ?: run {
            if (row.status == "MISSED" && row.penaltyAmountBdt != null) {
                Text("Penalty due · ${AlmaTheme.taka(row.penaltyAmountBdt.roundToInt())}", color = TCPalette.amber500, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        if (vm.canManage) {
            val busy = vm.busyId == row.id
            val defaultPenalty = (vm.settings?.defaultPenaltyBdt ?: 500).toDouble()
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TCActionChip("Refresh", TCPalette.tradingGreen, busy) { scope.launch { vm.runAction(row.id, "REFRESH") } }
                if (row.status == "MISSED" && (row.penalty == null || row.penalty.status == "PENDING")) {
                    TCActionChip("Penalty", TCPalette.red400, busy) { confirmingPenalty = true }
                    row.penalty?.let { p ->
                        TCActionChip("Waive", TCPalette.slate400, busy) { scope.launch { vm.runAction(row.id, "WAIVE_PENALTY", waiveAmountBdt = p.finalPenaltyBdt) } }
                    }
                    TCActionChip("Ignore", TCPalette.slate400, busy) { scope.launch { vm.runAction(row.id, "IGNORE") } }
                }
                TCActionChip("Delete", TCPalette.red400, busy) { confirmingDelete = true }
            }
            if (confirmingDelete) {
                AlertDialog(
                    onDismissRequest = { confirmingDelete = false },
                    title = { Text("Delete this target?") },
                    confirmButton = { TextButton(onClick = { confirmingDelete = false; scope.launch { vm.deleteTarget(row.id) } }) { Text("Delete") } },
                    dismissButton = { TextButton(onClick = { confirmingDelete = false }) { Text("বাতিল") } },
                )
            }
            if (confirmingPenalty) {
                val amt = row.penaltyAmountBdt ?: defaultPenalty
                AlertDialog(
                    onDismissRequest = { confirmingPenalty = false },
                    title = { Text("${AlmaTheme.taka(amt.roundToInt())} penalty apply করবেন?") },
                    confirmButton = { TextButton(onClick = { confirmingPenalty = false; scope.launch { vm.runAction(row.id, "APPLY_PENALTY", amountBdt = amt) } }) { Text("হ্যাঁ, apply করুন") } },
                    dismissButton = { TextButton(onClick = { confirmingPenalty = false }) { Text("বাতিল") } },
                )
            }
        }
    }
}

@Composable
private fun TCActionChip(label: String, tint: Color, busy: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.clip(CircleShape).background(tint.copy(alpha = 0.12f)).border(0.8.dp, tint.copy(alpha = 0.3f), CircleShape)
            .plainClick { if (!busy) onClick() }.padding(horizontal = 9.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(10.dp), color = tint, strokeWidth = 1.5.dp)
        Text(label, color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun TCStatusPill(status: String, dark: Boolean) {
    val tint = TCPalette.status(status, dark)
    Text(status, color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.clip(CircleShape).background(tint.copy(alpha = 0.13f)).border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape).padding(horizontal = 7.dp, vertical = 3.dp))
}

@Composable
private fun TCPenaltyLine(p: TCPenalty, dark: Boolean) {
    val tint = TCPalette.penalty(p.status, dark)
    Row(
        Modifier.fillMaxWidth().clip(CircleShape).background(tint.copy(alpha = 0.10f)).padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(tint))
        Text("Penalty ${p.status.replace("_", " ").lowercase()}", color = tint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        Text(AlmaTheme.taka(p.finalPenaltyBdt.roundToInt()), color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

// ── Analytics tab ───────────────────────────────────────────────────────────────────

@Composable
private fun TCAnalyticsCard(vm: TargetControlState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("MONTH ANALYTICS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
        val a = vm.analytics
        if (a != null) {
            TCStatRow("Month", a.month.ifEmpty { vm.monthParam }, AlmaTheme.ink(dark), dark)
            TCStatRow("Targets", "${a.targetCount}", AlmaTheme.ink(dark), dark)
            TCStatRow("Met", "${a.met}", TCPalette.positive(dark), dark)
            TCStatRow("Missed", "${a.missed}", TCPalette.red400, dark)
            TCStatRow("Ignored", "${a.ignored}", TCPalette.slate400, dark)
            if (a.totalAppliedBdt != null) {
                HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
                TCStatRow("Penalties applied", AlmaTheme.taka(a.totalAppliedBdt), TCPalette.red400, dark)
                TCStatRow("Waived", AlmaTheme.taka(a.totalWaivedBdt ?: 0), TCPalette.slate400, dark)
                TCStatRow("Net penalties", AlmaTheme.taka(a.netPenaltiesBdt ?: 0), TCPalette.accentText(dark), dark)
            }
            if (a.repeatOffenders.isNotEmpty()) {
                HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
                Text("REPEAT OFFENDERS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
                a.repeatOffenders.forEach { o -> TCStatRow(o.employeeId, "${o.count}×", TCPalette.amber500, dark) }
            }
        } else {
            Text(
                if (vm.canManage) "Use Accounts and Penalty queue for enforcement. Month KPIs are shown above."
                else "Summary KPIs above reflect the selected month. Contact Super Admin for penalty actions.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun TCStatRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.weight(1f))
        Text(value, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

// ── Settings tab (native save when canManage; read-only mirror otherwise) ───────────

@Composable
private fun TCSettingsCard(vm: TargetControlState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean, onWeb: () -> Unit) {
    val s = vm.settings
    var autoPenalty by remember(s) { mutableStateOf(s?.autoPenaltyEnabled ?: false) }
    var penaltyText by remember(s) { mutableStateOf("${s?.defaultPenaltyBdt ?: 500}") }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("AUTO-PENALTY CONFIGURATION", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
        if (s != null && vm.canManage) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Auto-penalty", color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                Switch(checked = autoPenalty, onCheckedChange = { autoPenalty = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = TCPalette.tradingGreen))
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Default penalty (৳)", color = AlmaTheme.ink(dark), fontSize = 14.sp, modifier = Modifier.weight(1f))
                Box(Modifier.width(110.dp).background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 8.dp)) {
                    BasicTextField(
                        value = penaltyText, onValueChange = { penaltyText = it }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End, fontFamily = FontFamily.Monospace),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(TCPalette.tradingGreen),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            Text(
                "Save settings", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().background(TCPalette.tradingGreen, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { scope.launch { vm.saveSettings(autoPenalty, penaltyText.toDoubleOrNull() ?: 500.0) } }.padding(vertical = 10.dp),
            )
        } else if (s != null) {
            TCStatRow("Auto-penalty", if (s.autoPenaltyEnabled) "On" else "Off", if (s.autoPenaltyEnabled) TCPalette.positive(dark) else TCPalette.slate400, dark)
            TCStatRow("Default penalty", AlmaTheme.taka(s.defaultPenaltyBdt), TCPalette.accentText(dark), dark)
        } else {
            Text("সেটিংস লোড হয়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        Text(
            "🌐 ওয়েব ভার্সন", color = TCPalette.tradingGreen, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().clip(CircleShape).background(TCPalette.tradingGreen.copy(alpha = if (dark) 0.22f else 0.14f))
                .border(1.dp, TCPalette.tradingGreen.copy(alpha = 0.4f), CircleShape).plainClick(onWeb).padding(vertical = 9.dp),
        )
    }
}

// ── Create target sheet (web "+ Set target" form parity) ────────────────────────────

@Composable
private fun TCCreateSheet(vm: TargetControlState, scope: kotlinx.coroutines.CoroutineScope, dark: Boolean, onClose: () -> Unit) {
    var accountId by remember { mutableStateOf(vm.accounts.firstOrNull()?.first ?: "") }
    var targetUsdt by remember { mutableStateOf("") }
    var penaltyBdt by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var pickerOpen by remember { mutableStateOf(false) }
    val canSubmit = accountId.isNotEmpty() && TCFormat.num(targetUsdt) > 0

    Column(Modifier.fillMaxWidth().padding(18.dp).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Set daily target", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text("তারিখ: ${vm.dateParam}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Box(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).plainClick { pickerOpen = true }.padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(vm.accounts.firstOrNull { it.first == accountId }?.second ?: "অ্যাকাউন্ট বাছুন", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            DropdownMenu(expanded = pickerOpen, onDismissRequest = { pickerOpen = false }) {
                vm.accounts.forEach { (id, title) ->
                    DropdownMenuItem(text = { Text((if (id == accountId) "✓ " else "") + title) }, onClick = { accountId = id; pickerOpen = false })
                }
            }
        }
        TCSheetField("Target USDT", targetUsdt, dark, bold = true) { targetUsdt = it }
        TCSheetField("Penalty BDT (ঐচ্ছিক — default ${vm.settings?.defaultPenaltyBdt ?: 500})", penaltyBdt, dark) { penaltyBdt = it }
        Row(
            Modifier.fillMaxWidth().background(if (canSubmit && !submitting) TCPalette.tradingGreen else TCPalette.tradingGreen.copy(alpha = 0.4f), RoundedCornerShape(14.dp))
                .plainClick { if (canSubmit && !submitting) confirming = true }.padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
        ) {
            if (submitting) { CircularProgressIndicator(Modifier.size(15.dp), color = Color.White, strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
            Text("Create target", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("${TCFormat.usdt(TCFormat.num(targetUsdt))} USDT target সেট করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false; submitting = true
                    scope.launch {
                        val ok = vm.createTarget(accountId, TCFormat.num(targetUsdt), if (penaltyBdt.isBlank()) null else TCFormat.num(penaltyBdt))
                        submitting = false
                        if (ok) onClose()
                    }
                }) { Text("হ্যাঁ, সেট করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun TCSheetField(placeholder: String, value: String, dark: Boolean, bold: Boolean = false, onChange: (String) -> Unit) {
    BasicTextField(
        value = value, onValueChange = onChange, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = if (bold) 18.sp else 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal, fontFamily = if (bold) FontFamily.Monospace else FontFamily.Default),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(TCPalette.tradingGreen),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).padding(horizontal = 12.dp, vertical = 11.dp)) {
                if (value.isEmpty()) Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                inner()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}
