//
//  SettingsNotificationsScreen.kt
//  ALMA ERP — Settings ▸ Notifications, ported 1:1 from SettingsNotificationsSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET  /api/notifications/stats      → { totals, broadcasts }  (flat; {ok,data} unwrapped too)
//    GET  /api/users                    → user options for the USER broadcast target
//    POST /api/notifications/broadcast  → { recipients } (admin broadcast)
//  Blocks: header + refresh · 4 KPI cards (Recipients/Delivered/Open rate/Ack rate) ·
//  App Lock row (the web toggle is a webview-local preference — natively an info row
//  that opens the web settings page; Android twin of the iOS Face ID row) · Admin
//  broadcast composer (title/message/priority/target ALL-ROLE-BUSINESS-USER, action
//  URL, "Pin this notification" switch) · Delivery dashboard rows.
//  NOTE: the web page has NO channel-preference toggles — nothing invented here.
//  Carried lesson: ONE spinner per action, never a global overlay.
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SettingsNotifPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)

    /** Web: CRITICAL text-red-500 · HIGH text-amber-600 · else muted. */
    fun priority(p: String?, dark: Boolean): Color = when (p) {
        "CRITICAL" -> red500
        "HIGH" -> amber600
        else -> AlmaTheme.inkSecondary(dark)
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web page types declare) ───────────────────────────

private data class SettingsNotifTotals(
    val recipients: Int,
    val delivered: Int,
    val openRate: Int,
    val ackRate: Int,
) {
    companion object {
        fun from(o: JSONObject) = SettingsNotifTotals(
            recipients = o.flexInt("recipients") ?: 0,
            delivered = o.flexInt("delivered") ?: 0,
            openRate = o.flexInt("openRate") ?: 0,
            ackRate = o.flexInt("ackRate") ?: 0,
        )
    }
}

private data class SettingsNotifBroadcast(
    val id: String,
    val title: String?,
    val target: String?,
    val priority: String?,
    val recipients: Int,
    val delivered: Int,
    val seen: Int,
    val acknowledged: Int,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject) = SettingsNotifBroadcast(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            title = o.str("title"),
            target = o.str("target"),
            priority = o.str("priority"),
            recipients = o.flexInt("recipients") ?: 0,
            delivered = o.flexInt("delivered") ?: 0,
            seen = o.flexInt("seen") ?: 0,
            acknowledged = o.flexInt("acknowledged") ?: 0,
            createdAt = o.str("createdAt"),
        )
    }
}

private data class SettingsNotifUser(val id: String, val name: String?, val email: String?) {
    val label: String get() = "${name ?: "—"} · ${email ?: "—"}"

    companion object {
        fun from(o: JSONObject): SettingsNotifUser? {
            val id = o.str("id") ?: return null
            return SettingsNotifUser(id, o.str("name"), o.str("email"))
        }
    }
}

// ── Static option lists (web src/lib/roles.ts + src/lib/businesses.ts parity) ──────

private val notifRoleOptions = listOf(
    "SUPER_ADMIN" to "Super Admin",
    "ADMIN" to "Admin",
    "HR" to "HR",
    "STAFF" to "Staff",
    "VIEWER" to "Viewer",
)
private val notifBusinessOptions = listOf(
    "ALMA_LIFESTYLE" to "Alma Lifestyle",
    "CREATIVE_DIGITAL_IT" to "Creative Digital IT",
    "ALMA_TRADING" to "Alma Trading",
)
private val notifPriorities = listOf("LOW", "NORMAL", "HIGH", "CRITICAL")
private val notifTargets = listOf("ALL", "ROLE", "BUSINESS", "USER")

// ── State holder (iOS SettingsNotifVM twin) ────────────────────────────────────────

private class SettingsNotifState {
    var totals by mutableStateOf<SettingsNotifTotals?>(null)
    var broadcasts by mutableStateOf(listOf<SettingsNotifBroadcast>())
    var users by mutableStateOf(listOf<SettingsNotifUser>())
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)   // success line (the web's toast)
    var authExpired by mutableStateOf(false)

    // Broadcast composer form (web `form` state, same defaults).
    var title by mutableStateOf("")
    var message by mutableStateOf("")
    var priority by mutableStateOf("NORMAL")
    var target by mutableStateOf("ALL")
    var targetRole by mutableStateOf("STAFF")
    var targetBusinessId by mutableStateOf("ALMA_LIFESTYLE")
    var targetUserId by mutableStateOf("")
    var actionUrl by mutableStateOf("")
    var pinned by mutableStateOf(false)
    var sending by mutableStateOf(false)

    /** Web `disabled=` condition on the Send button, verbatim. */
    val canSend: Boolean
        get() = !sending && title.trim().isNotEmpty() && message.trim().isNotEmpty() &&
            !(target == "USER" && targetUserId.isEmpty())

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val stats = unwrap(AlmaApi.getObject("/api/notifications/stats"))
            totals = stats.optJSONObject("totals")?.let { SettingsNotifTotals.from(it) }
            broadcasts = stats.optJSONArray("broadcasts")?.mapObjects { SettingsNotifBroadcast.from(it) }
                ?: emptyList()
            // Users are only needed for the USER target picker — load leniently.
            try {
                val u = unwrap(AlmaApi.getObject("/api/users"))
                users = u.optJSONArray("users")?.mapObjects { SettingsNotifUser.from(it) } ?: emptyList()
            } catch (_: Exception) { }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** POST /api/notifications/broadcast — same JSON body the web `send()` posts. */
    suspend fun send() {
        if (!canSend) return
        sending = true
        notice = null
        error = null
        try {
            val body = JSONObject()
                .put("title", title)
                .put("message", message)
                .put("priority", priority)
                .put("target", target)
                .put("targetRole", targetRole)
                .put("targetBusinessId", targetBusinessId)
                .put("actionUrl", actionUrl)
                .put("pinned", pinned)
            if (targetUserId.isNotEmpty()) body.put("targetUserId", targetUserId)
            val resp = AlmaApi.send("POST", "/api/notifications/broadcast", body)
            val data = resp.optJSONObject("data") ?: resp
            // Web toast, verbatim: `Broadcast sent to ${json.recipients} recipient(s)`.
            notice = "Broadcast sent to ${data.flexInt("recipients") ?: resp.flexInt("recipients") ?: 0} recipient(s)"
            title = ""
            message = ""
            load()   // refresh KPIs + dashboard, keep numbers honest
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: AlmaApiException.Http) {
            // Server body is truncated inside the message — web error toast fallback.
            error = serverError(e.message) ?: "Could not send broadcast"
        } catch (e: Exception) {
            error = "Could not send broadcast"
        } finally {
            sending = false
        }
    }

    /** Best-effort `{ error: "…" }` extraction from the Http exception message. */
    private fun serverError(message: String?): String? {
        val json = message?.substringAfter(": ", "")?.takeIf { it.startsWith("{") } ?: return null
        return try { JSONObject(json).str("error") } catch (_: Exception) { null }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun SettingsNotificationsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SettingsNotifState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Header (web PageHeader parity) + refresh.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Notifications", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Broadcasts, push delivery, acknowledgments, and open-rate monitoring.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
                Box(
                    Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { if (!vm.loading) scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
            }
        }

        if (vm.authExpired) {
            item { NotifAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { NotifNoticeCard("⚠️ $it", SettingsNotifPalette.red500, dark) } }
        vm.notice?.let { item { NotifNoticeCard("✓ $it", SettingsNotifPalette.emerald600, dark) } }

        if (vm.loading && vm.totals == null) {
            items(3) { Box(Modifier.fillMaxWidth().height(76.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            item {
                // KPI strip (web's 4 KpiCards, labels verbatim).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    NotifKpiCard("Recipients", vm.totals?.recipients?.toString() ?: "—", dark)
                    NotifKpiCard("Delivered", vm.totals?.delivered?.toString() ?: "—", dark)
                    NotifKpiCard("Open rate", vm.totals?.let { "${it.openRate}%" } ?: "—", dark)
                    NotifKpiCard("Ack rate", vm.totals?.let { "${it.ackRate}%" } ?: "—", dark)
                }
            }
        }

        item { NotifAppLockRow(dark) { ctx.openWebForced("/settings/notifications", "Notifications") } }
        item { NotifComposerCard(vm, dark) { scope.launch { vm.send() } } }
        item { NotifDashboardCard(vm, dark) }

        item {
            Text(
                "🌐 সব অপশন — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/settings/notifications", "Notifications") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

// ── App Lock row — web BiometricLockToggle parity ───────────────────────────────────
// The web toggle is a webview-local preference (localStorage), invisible to native
// code — so natively it is an info row that opens the web settings page.

@Composable
private fun NotifAppLockRow(dark: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onOpen)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(34.dp)
                .background(SettingsNotifPalette.coral.copy(alpha = 0.14f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("🔒", fontSize = 15.sp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("অ্যাপ লক (বায়োমেট্রিক)", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "অ্যাপ খুললে বা কিছুক্ষণ পর ফিরে এলে ফিঙ্গারপ্রিন্ট/ফেস আনলক করতে হবে।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
            Text(
                "এই সুইচটি ওয়েব সেটিংসে আছে — খুলতে ট্যাপ করুন",
                color = SettingsNotifPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Text("›", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Admin broadcast composer (web card parity) ──────────────────────────────────────

@Composable
private fun NotifComposerCard(vm: SettingsNotifState, dark: Boolean, onSend: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Admin broadcast", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Send persistent in-app notifications and OneSignal push alerts when configured.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }

        OutlinedTextField(
            value = vm.title,
            onValueChange = { vm.title = it },
            placeholder = { Text("Notification title") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = vm.message,
            onValueChange = { vm.message = it },
            placeholder = { Text("Message") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )

        // Priority + target — the web's two Selects as native dropdown pills.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NotifPickerMenu(
                value = vm.priority,
                options = notifPriorities.map { it to it },
                tint = SettingsNotifPalette.priority(vm.priority, dark),
                dark = dark,
                modifier = Modifier.weight(1f),
            ) { vm.priority = it }
            NotifPickerMenu(
                value = vm.target,
                options = notifTargets.map { it to it },
                tint = null,
                dark = dark,
                modifier = Modifier.weight(1f),
            ) { vm.target = it }
        }

        // Conditional target pickers (web parity: ROLE / BUSINESS / USER).
        if (vm.target == "ROLE") {
            NotifPickerMenu(
                value = notifRoleOptions.firstOrNull { it.first == vm.targetRole }?.second ?: vm.targetRole,
                options = notifRoleOptions,
                tint = null, dark = dark, modifier = Modifier.fillMaxWidth(),
            ) { vm.targetRole = it }
        }
        if (vm.target == "BUSINESS") {
            NotifPickerMenu(
                value = notifBusinessOptions.firstOrNull { it.first == vm.targetBusinessId }?.second
                    ?: vm.targetBusinessId,
                options = notifBusinessOptions,
                tint = null, dark = dark, modifier = Modifier.fillMaxWidth(),
            ) { vm.targetBusinessId = it }
        }
        if (vm.target == "USER") {
            if (vm.users.isEmpty()) {
                Text(
                    "ইউজার তালিকা লোড হয়নি — ↻ বোতামে রিফ্রেশ করুন",
                    color = SettingsNotifPalette.amber600, fontSize = 11.sp,
                )
            } else {
                NotifPickerMenu(
                    value = vm.users.firstOrNull { it.id == vm.targetUserId }?.label ?: "Choose user",
                    options = vm.users.map { it.id to it.label },
                    tint = null, dark = dark, modifier = Modifier.fillMaxWidth(),
                ) { vm.targetUserId = it }
            }
        }

        OutlinedTextField(
            value = vm.actionUrl,
            onValueChange = { vm.actionUrl = it },
            placeholder = { Text("Action URL, e.g. /payroll") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Pin this notification", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            Spacer(Modifier.weight(1f))
            Switch(
                checked = vm.pinned,
                onCheckedChange = { vm.pinned = it },
                colors = SwitchDefaults.colors(checkedTrackColor = SettingsNotifPalette.coral),
            )
        }

        val alpha = if (vm.canSend) 1f else 0.5f
        Row(
            Modifier
                .fillMaxWidth()
                .background(SettingsNotifPalette.coral.copy(alpha = 0.13f * alpha), CircleShape)
                .border(1.dp, SettingsNotifPalette.coral.copy(alpha = 0.35f * alpha), CircleShape)
                .plainClick { if (vm.canSend) onSend() }
                .padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (vm.sending) {
                CircularProgressIndicator(Modifier.size(13.dp), color = SettingsNotifPalette.coral, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(
                if (vm.sending) "Sending…" else "Send broadcast",
                color = SettingsNotifPalette.accentText(dark).copy(alpha = alpha),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/** One web <Select> as a native glass pill + dropdown. */
@Composable
private fun NotifPickerMenu(
    value: String,
    options: List<Pair<String, String>>,
    tint: Color?,
    dark: Boolean,
    modifier: Modifier = Modifier,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CONTROL)
                .plainClick { open = true }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                value,
                color = tint ?: AlmaTheme.ink(dark).copy(alpha = 0.8f),
                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text("⌄", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (id, label) ->
                DropdownMenuItem(
                    text = { Text(label, fontSize = 13.sp) },
                    onClick = { open = false; onPick(id) },
                )
            }
        }
    }
}

// ── Delivery dashboard (web table re-set as cards for phone) ────────────────────────

@Composable
private fun NotifDashboardCard(vm: SettingsNotifState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Delivery dashboard", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        if (vm.loading && vm.broadcasts.isEmpty()) {
            Box(Modifier.fillMaxWidth().height(90.dp).almaGlass(dark, AlmaTheme.R_CONTROL))
        } else if (vm.broadcasts.isEmpty()) {
            Text("No broadcasts sent yet.", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        } else {
            vm.broadcasts.forEach { b -> NotifBroadcastRow(b, dark) }
        }
    }
}

/** One web table row as a card. */
@Composable
private fun NotifBroadcastRow(b: SettingsNotifBroadcast, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row {
            Text(
                b.title ?: "—",
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            b.priority?.let {
                Text(it, color = SettingsNotifPalette.priority(it, dark), fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
        }
        val meta = buildList {
            b.target?.let(::add)
            SettingsNotifFormat.dateTime(b.createdAt)?.let(::add)
        }
        Text(meta.joinToString(" · "), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            NotifStat("Delivered", "${b.delivered}/${b.recipients}", dark)
            NotifStat("Seen", "${b.seen}", dark)
            NotifStat("Ack", "${b.acknowledged}", dark)
        }
    }
}

@Composable
private fun NotifStat(label: String, value: String, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        Text(value, color = SettingsNotifPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

/** Light bento tile: soft coral wash over glass. */
@Composable
private fun NotifKpiCard(label: String, value: String, dark: Boolean) {
    Column(
        Modifier
            .widthIn(min = 84.dp)
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .background(
                Brush.linearGradient(
                    listOf(SettingsNotifPalette.coral.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent),
                ),
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp)
        Spacer(Modifier.height(3.dp))
        Text(value, color = SettingsNotifPalette.accentText(dark), fontSize = 17.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun NotifNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun NotifAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SettingsNotifPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SettingsNotifFormat {
    /** createdAt → "5/7/26, 8:50 PM" style (web: new Date(...).toLocaleString()), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yy, h:mm a", Locale.US)
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
