//
//  TradingStaffScreen.kt
//  ALMA ERP — the ALMA Trading staff admin (/agent/trading-staff), ported 1:1 from
//  TradingStaffSwiftUI.swift. Same endpoint, same colours, same blocks:
//    GET  /api/assistant/internal/trading-staff/upsert → { staff, eligibleUsers }
//    POST /api/assistant/internal/trading-staff/upsert   {id?, userId?, name?, role?,
//                                                         telegramChatId?, active?}
//  Web-parity blocks: sub-header ("ALMA Trading · Staff" + Bangla subtitle) · filter
//  chips (All/Active/Inactive, client-side) · summary strip (staff/active/inactive/
//  telegram counts) · "Linked Trading staff (N)" cards (initials avatar · glowing
//  active dot · ERP link line · Telegram chat ID row · status pill) · "Link a new
//  Trading staff" eligible-user list (Link = confirm dialog → upsert) · detail sheet.
//  iOS puts activate/deactivate + chat-ID/role edits in a long-press contextMenu;
//  Android surfaces the same three actions inside the detail sheet (discoverable,
//  no hidden gesture). Carried lessons: lenient decoding, auth card, bottom toast.
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.draw.shadow
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
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object TSPalette {
    val coral = AlmaTheme.coral          // web --c-accent #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean) = if (dark) goldLt else goldDim

    /** Web: active dot emerald glow · inactive dot red glow. */
    fun activeDot(active: Boolean) = if (active) green400 else red500
    fun activeText(active: Boolean) = if (active) emerald600 else red500
}

// ── Models (same field names the web page's interfaces declare) ─────────────────────

private data class TSMember(
    val id: String,
    val name: String,
    val role: String,
    val telegramChatId: String?,   // Prisma string but numeric-looking — str() takes both
    val ntfyTopic: String?,
    val active: Boolean,
    val userId: String?,
    val userName: String?,
    val userEmail: String?,
) {
    companion object {
        fun from(o: JSONObject): TSMember? {
            val id = o.str("id") ?: return null
            val user = o.optJSONObject("user")
            return TSMember(
                id = id,
                name = o.str("name") ?: "Trading Staff",
                role = o.str("role") ?: "p2p_trader",
                telegramChatId = o.str("telegramChatId"),
                ntfyTopic = o.str("ntfyTopic"),
                active = o.flexBool("active") ?: true,
                userId = o.str("userId"),
                userName = user?.str("name"),
                userEmail = user?.str("email"),
            )
        }
    }
}

private data class TSUser(
    val id: String,
    val name: String,
    val email: String?,
    val role: String?,
) {
    companion object {
        fun from(o: JSONObject): TSUser? {
            val id = o.str("id") ?: return null
            return TSUser(id, o.str("name") ?: "—", o.str("email"), o.str("role"))
        }
    }
}

private fun tsInitials(name: String): String {
    val letters = name.split(" ").filter { it.isNotEmpty() }.take(2)
        .mapNotNull { it.firstOrNull()?.toString() }
    return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
}

// ── State holder (iOS TradingStaffVM twin) ──────────────────────────────────────────

private class TradingStaffState {
    var staff by mutableStateOf(listOf<TSMember>())
    var eligibleUsers by mutableStateOf(listOf<TSUser>())
    var filter by mutableStateOf("ALL")           // ALL | ACTIVE | INACTIVE (client-side)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)
    var saving by mutableStateOf(false)

    /** Users not yet linked to a staff row — the web's `availableUsers` computation. */
    val availableUsers: List<TSUser>
        get() {
            val linked = staff.mapNotNull { it.userId }.toSet()
            return eligibleUsers.filter { it.id !in linked }
        }

    val filteredStaff: List<TSMember>
        get() = when (filter) {
            "ACTIVE" -> staff.filter { it.active }
            "INACTIVE" -> staff.filter { !it.active }
            else -> staff
        }

    val activeCount: Int get() = staff.count { it.active }
    val telegramCount: Int get() = staff.count { !it.telegramChatId.isNullOrEmpty() }

    /** Flat payload `{ staff, eligibleUsers }`; tolerate an `{ ok, data }` wrap too. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/assistant/internal/trading-staff/upsert"))
            staff = c.optJSONArray("staff")?.mapObjects { TSMember.from(it) } ?: emptyList()
            eligibleUsers = c.optJSONArray("eligibleUsers")?.mapObjects { TSUser.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Web upsert() parity — one POST for link/activate/deactivate/chat-ID/role.
     *  Only the fields being changed travel (iOS omits nil optionals). */
    suspend fun upsert(
        id: String? = null,
        userId: String? = null,
        name: String? = null,
        role: String? = null,
        telegramChatId: String? = null,
        active: Boolean? = null,
    ): Boolean {
        saving = true
        return try {
            val body = JSONObject()
            id?.let { body.put("id", it) }
            userId?.let { body.put("userId", it) }
            name?.let { body.put("name", it) }
            role?.let { body.put("role", it) }
            telegramChatId?.let { body.put("telegramChatId", it) }
            active?.let { body.put("active", it) }
            val res = AlmaApi.send("POST", "/api/assistant/internal/trading-staff/upsert", body)
            val err = res.str("error")
            if (err != null) {
                toast = "সেভ ব্যর্থ: $err"
                false
            } else {
                toast = "সেভ হয়েছে"
                load()
                true
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: Exception) {
            toast = "সেভ ব্যর্থ: ${e.message}"
            false
        } finally {
            saving = false
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradingStaffScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { TradingStaffState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<TSMember?>(null) }
    var linking by remember { mutableStateOf<TSUser?>(null) }
    var editingChatId by remember { mutableStateOf<TSMember?>(null) }
    var chatIdDraft by remember { mutableStateOf("") }
    var editingRole by remember { mutableStateOf<TSMember?>(null) }
    var roleDraft by remember { mutableStateOf("") }

    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            delay(2600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                // Header (web AgentSubHeader parity: "ALMA Trading · Staff" + subtitle).
                Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text("ALMA Trading", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text("Staff", color = TSPalette.accentText(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(
                        "Binance P2P trader-দের লিঙ্ক ও Telegram chat ID",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }
            if (vm.authExpired) {
                item { TSAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.error?.let { item { TSNoticeCard("⚠ $it", TSPalette.red500, dark) } }

            item {
                // Filter chips (native — client-side Active/Inactive slice) + count badge.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TSChip("All", vm.filter == "ALL", dark) { vm.filter = "ALL" }
                    TSChip("Active", vm.filter == "ACTIVE", dark) { vm.filter = "ACTIVE" }
                    TSChip("Inactive", vm.filter == "INACTIVE", dark) { vm.filter = "INACTIVE" }
                    Spacer(Modifier.weight(1f))
                    if (vm.staff.isNotEmpty()) {
                        Text(
                            "${vm.staff.size}",
                            color = TSPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(TSPalette.coral.copy(alpha = 0.18f), CircleShape)
                                .border(1.dp, TSPalette.coral.copy(alpha = 0.4f), CircleShape)
                                .padding(horizontal = 9.dp, vertical = 4.dp),
                        )
                    }
                }
            }

            item {
                // Summary strip (honest client-side counts, KPI-card look).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    TSKpiCard("STAFF", vm.staff.size, TSPalette.goldLt, dark)
                    TSKpiCard("ACTIVE", vm.activeCount, TSPalette.emerald600, dark)
                    TSKpiCard(
                        "INACTIVE", vm.staff.size - vm.activeCount,
                        if (vm.staff.size - vm.activeCount > 0) TSPalette.red500 else AlmaTheme.ink(dark), dark,
                    )
                    TSKpiCard(
                        "TELEGRAM", vm.telegramCount,
                        if (vm.telegramCount < vm.staff.size) TSPalette.amber600 else AlmaTheme.ink(dark), dark,
                    )
                }
            }

            item { TSSectionHeader("Linked Trading staff (${vm.staff.size})", dark) }

            if (vm.loading && vm.staff.isEmpty()) {
                items(4) { Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering()) }
            } else if (vm.staff.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Text(
                        "এখনো কোনো Trading staff লিঙ্ক করা হয়নি।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                    )
                }
            } else {
                items(vm.filteredStaff, key = { it.id }) { member ->
                    TSStaffCard(member, dark) { selected = member }
                }
                if (vm.filteredStaff.isEmpty() && vm.staff.isNotEmpty()) {
                    item {
                        Text(
                            "এই ফিল্টারে কেউ নেই",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                        )
                    }
                }
            }

            item { TSSectionHeader("Link a new Trading staff", dark) }

            if (vm.availableUsers.isEmpty()) {
                if (!vm.loading && !vm.authExpired) {
                    item {
                        Text(
                            "সব eligible User ইতিমধ্যে লিঙ্ক করা আছে। নতুন trader add করতে User Management থেকে User তৈরি করুন (businessAccess-এ ALMA_TRADING রাখুন)।",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                            modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                        )
                    }
                }
            } else {
                item {
                    Column(
                        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        vm.availableUsers.forEach { u ->
                            TSEligibleRow(u, dark, enabled = !vm.saving) { linking = u }
                        }
                    }
                }
            }

            item {
                Text(
                    "🌐 সব অপশন (এডিট / লিঙ্ক সহ) — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/agent/trading-staff", "Trading staff") }
                        .padding(vertical = 4.dp),
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

    // ── Detail sheet (record + the iOS contextMenu actions, surfaced as buttons) ──
    selected?.let { member ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            TSDetailSheet(
                member, dark,
                saving = vm.saving,
                onToggleActive = {
                    selected = null
                    scope.launch { vm.upsert(id = member.id, active = !member.active) }
                },
                onEditChatId = {
                    selected = null
                    chatIdDraft = member.telegramChatId ?: ""
                    editingChatId = member
                },
                onEditRole = {
                    selected = null
                    roleDraft = member.role
                    editingRole = member
                },
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
            )
        }
    }

    // ── Link confirm (iOS confirmationDialog parity) ──
    linking?.let { u ->
        AlertDialog(
            onDismissRequest = { linking = null },
            title = { Text("${u.name}-কে Trading staff হিসেবে link করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    linking = null
                    scope.launch {
                        vm.upsert(userId = u.id, name = u.name, role = "p2p_trader", active = true)
                    }
                }) { Text("হ্যাঁ, link করুন") }
            },
            dismissButton = {
                TextButton(onClick = { linking = null }) { Text("বাতিল") }
            },
        )
    }

    // ── Telegram Chat ID edit (iOS alert-with-textfield parity) ──
    editingChatId?.let { m ->
        AlertDialog(
            onDismissRequest = { editingChatId = null },
            title = { Text("Telegram Chat ID") },
            text = {
                TSDialogField("123456789", chatIdDraft, dark, KeyboardType.Number) { chatIdDraft = it }
            },
            confirmButton = {
                TextButton(onClick = {
                    val v = chatIdDraft.trim()
                    editingChatId = null
                    // iOS omits the key when blank — an empty draft sends nothing.
                    if (v.isNotEmpty()) scope.launch { vm.upsert(id = m.id, telegramChatId = v) }
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { editingChatId = null }) { Text("বাতিল") }
            },
        )
    }

    // ── Role edit ──
    editingRole?.let { m ->
        AlertDialog(
            onDismissRequest = { editingRole = null },
            title = { Text("Role") },
            text = {
                TSDialogField("p2p_trader", roleDraft, dark, KeyboardType.Text) { roleDraft = it }
            },
            confirmButton = {
                TextButton(onClick = {
                    val v = roleDraft.trim()
                    editingRole = null
                    if (v.isNotEmpty()) scope.launch { vm.upsert(id = m.id, role = v) }
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { editingRole = null }) { Text("বাতিল") }
            },
        )
    }
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun TSSectionHeader(title: String, dark: Boolean) {
    Text(
        title.uppercase(),
        color = TSPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    )
}

@Composable
private fun TSChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) TSPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) TSPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) TSPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun TSKpiCard(label: String, value: Int, tint: Color, dark: Boolean) {
    Column(
        Modifier.widthIn(min = 84.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Text("$value", color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun TSNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun TSAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(TSPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun TSAvatar(name: String, size: Int, fontSize: Int, dark: Boolean) {
    Box(
        Modifier
            .size(size.dp)
            .background(TSPalette.coral.copy(alpha = 0.16f), CircleShape)
            .border(1.dp, TSPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            tsInitials(name),
            color = TSPalette.accentText(dark), fontSize = fontSize.sp, fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun TSStatusPill(active: Boolean) {
    val tint = TSPalette.activeText(active)
    Text(
        if (active) "Active" else "Inactive",
        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.10f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

// ── Staff card (mirrors one web staff row card) ─────────────────────────────────────

@Composable
private fun TSStaffCard(member: TSMember, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TSAvatar(member.name, 34, 11, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        member.name,
                        color = AlmaTheme.ink(dark).copy(alpha = if (member.active) 1f else 0.7f),
                        fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    )
                    // Web: glowing status dot next to the name.
                    Box(
                        Modifier
                            .size(9.dp)
                            .shadow(3.dp, CircleShape, spotColor = TSPalette.activeDot(member.active))
                            .background(TSPalette.activeDot(member.active), CircleShape),
                    )
                }
                // Web meta line: "ERP: {user} · Role: {role}".
                Text(
                    "ERP: ${member.userName ?: "— unlinked —"} · Role: ${member.role}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            TSStatusPill(member.active)
        }

        val chatId = member.telegramChatId
        if (!chatId.isNullOrEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(TSPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, TSPalette.coral.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("✈", color = TSPalette.accentText(dark), fontSize = 11.sp)
                Text("Telegram chat ID", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                Spacer(Modifier.weight(1f))
                Text(
                    chatId,
                    color = TSPalette.accentText(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                )
            }
        } else {
            Text(
                "Telegram chat ID নেই — dispatch পাঠানো যাবে না",
                color = TSPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(TSPalette.amber500.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, TSPalette.amber500.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

// ── Eligible-user row (web "Link a new Trading staff" — Link = native upsert) ───────

@Composable
private fun TSEligibleRow(u: TSUser, dark: Boolean, enabled: Boolean, onLink: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier
                .size(30.dp)
                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                .border(1.dp, AlmaTheme.ink(dark).copy(alpha = 0.12f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(tsInitials(u.name), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(u.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(
                listOfNotNull(u.email, u.role).joinToString(" · "),
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            "Link",
            color = TSPalette.accentText(dark).copy(alpha = if (enabled) 1f else 0.5f),
            fontSize = 11.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier
                .background(TSPalette.coral.copy(alpha = 0.13f), CircleShape)
                .border(1.dp, TSPalette.coral.copy(alpha = 0.35f), CircleShape)
                .plainClick { if (enabled) onLink() }
                .padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

// ── Detail sheet (full record + the contextMenu actions from iOS) ───────────────────

@Composable
private fun TSDetailSheet(
    member: TSMember,
    dark: Boolean,
    saving: Boolean,
    onToggleActive: () -> Unit,
    onEditChatId: () -> Unit,
    onEditRole: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TSAvatar(member.name, 44, 14, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(member.name, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(member.role, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            TSStatusPill(member.active)
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            TSInfoRow("ERP user", member.userName ?: "— unlinked —", AlmaTheme.ink(dark), dark)
            TSInfoRow("Email", member.userEmail ?: "—", AlmaTheme.ink(dark), dark)
            TSInfoRow("Role label", member.role, AlmaTheme.ink(dark), dark)
            TSInfoRow(
                "Telegram chat ID", member.telegramChatId ?: "—",
                if (member.telegramChatId.isNullOrEmpty()) TSPalette.amber600 else TSPalette.accentText(dark),
                dark, mono = true,
            )
            TSInfoRow("ntfy topic", member.ntfyTopic ?: "—", AlmaTheme.ink(dark), dark)
            TSInfoRow("Staff ID", member.id, AlmaTheme.ink(dark), dark, mono = true)
        }

        // iOS contextMenu actions, surfaced as buttons (same upsert calls).
        if (saving) {
            Box(Modifier.fillMaxWidth().padding(vertical = 7.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = TSPalette.coral, strokeWidth = 2.dp)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TSActionChip(
                    if (member.active) "Deactivate" else "Activate",
                    if (member.active) TSPalette.red500 else TSPalette.emerald600,
                    Modifier.weight(1f), onToggleActive,
                )
                TSActionChip("Chat ID", TSPalette.coral, Modifier.weight(1f), onEditChatId)
                TSActionChip("Role", TSPalette.coral, Modifier.weight(1f), onEditRole)
            }
        }

        Text(
            "🌐 এডিট / Activate-Deactivate — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/agent/trading-staff", "Trading staff") }
                .padding(vertical = 6.dp),
        )
        Spacer(Modifier.height(6.dp))
    }
}

@Composable
private fun TSInfoRow(label: String, value: String, color: Color, dark: Boolean, mono: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
        )
        Text(
            value,
            color = color, fontSize = 13.sp,
            fontWeight = if (mono) FontWeight.Normal else FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        )
    }
}

@Composable
private fun TSActionChip(label: String, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center, maxLines = 1,
        modifier = modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 9.dp),
    )
}

/** Text field for the edit dialogs (iOS alert TextField twin). */
@Composable
private fun TSDialogField(
    placeholder: String,
    value: String,
    dark: Boolean,
    keyboardType: KeyboardType,
    onChange: (String) -> Unit,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .padding(horizontal = 12.dp, vertical = 11.dp),
            ) {
                if (value.isEmpty()) {
                    Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                }
                inner()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}
