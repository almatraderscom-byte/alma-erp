//
//  SettingsUsersScreen.kt
//  ALMA ERP — Settings ▸ Users, ported 1:1 from SettingsUsersSwiftUI.swift (READ-ONLY).
//
//  Endpoint (same as web/iOS):
//    GET /api/users → { users: [...] }  (SUPER_ADMIN / ADMIN only; flat, but a
//    { ok, data:{…} } wrapper is unwrapped too in case the route adopts apiDataSuccess)
//  Blocks: KPI strip (accounts / active / inactive) · role filter chips (client-side) ·
//  user rows (initials avatar, role capsule, active dot, business scope, HR ID) ·
//  detail sheet with role-capability hint.
//
//  ⚠️ STRICTLY READ-ONLY BY DESIGN: creating users, editing accounts, changing roles,
//  permissions and password resets are access-control writes — they ALL stay on the
//  web page via the escape hatch. This file must never gain a POST/PATCH.
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SettingsUsersPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val cyan400 = Color(0xFF22D3EE)   // web tone-cyan

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Role capsule tint — SUPER_ADMIN gold · ADMIN violet · HR cyan · VIEWER green ·
     *  STAFF neutral (the web RoleBadge tones, re-set on the app's accents). */
    fun role(role: String, dark: Boolean): Color = when (role) {
        "SUPER_ADMIN" -> goldDim
        "ADMIN" -> AlmaTheme.violet
        "HR" -> cyan400
        "VIEWER" -> green400
        else -> AlmaTheme.inkSecondary(dark)   // STAFF + unknown → neutral
    }
}

// ── Model (same field names /api/users selects) ────────────────────────────────────

private data class SettingsUserRow(
    val id: String,
    val email: String?,
    val name: String,
    val phone: String?,
    val role: String,
    val active: Boolean,
    val businessAccess: String,
    val employeeIdGas: String?,
    val joiningDate: String?,
    val salaryHint: Int?,
    val createdAt: String?,
) {
    /** Web RoleBadge text: underscore → space. */
    val roleLabel: String get() = role.replace("_", " ")

    /** businessAccess csv → the registry's short names ("Alma · CDIT · Trading"). */
    val businessShortNames: List<String>
        get() = businessAccess.split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map {
                when (it) {
                    "ALMA_LIFESTYLE" -> "Alma"
                    "CREATIVE_DIGITAL_IT" -> "CDIT"
                    "ALMA_TRADING" -> "Trading"
                    else -> it
                }
            }

    /** Same capability hints the web ALMA_ROLE_OPTIONS table shows. */
    val roleHint: String
        get() = when (role) {
            "SUPER_ADMIN" -> "Full access · manage users · branding · audit · delete-capable ops"
            "ADMIN" -> "Orders, CRM, inventory, invoices, analytics, finance/expenses · manage staff accounts"
            "HR" -> "Employees, payroll, advances approval, finance hub & expense ledger"
            "STAFF" -> "Create/track orders · invoice tools · CDIT ops (scoped) · employee portal"
            "VIEWER" -> "Read-only dashboards and lists — cannot edit data"
            else -> "—"
        }

    companion object {
        fun from(o: JSONObject): SettingsUserRow? {
            val id = o.str("id") ?: return null
            return SettingsUserRow(
                id = id,
                email = o.str("email"),
                name = o.str("name") ?: "—",
                phone = o.str("phone"),
                role = o.str("role") ?: "STAFF",
                active = o.flexBool("active") ?: true,
                businessAccess = o.str("businessAccess") ?: "",
                employeeIdGas = o.str("employeeIdGas"),
                joiningDate = o.str("joiningDate"),
                salaryHint = o.flexInt("salaryHint"),   // Prisma Decimal → string or number
                createdAt = o.str("createdAt"),
            )
        }
    }
}

// ── State holder (iOS SettingsUsersVM twin) ────────────────────────────────────────

private class SettingsUsersState {
    var users by mutableStateOf(listOf<SettingsUserRow>())
    var roleFilter by mutableStateOf("ALL")   // ALL | SUPER_ADMIN | ADMIN | HR | STAFF | VIEWER
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val filtered: List<SettingsUserRow>
        get() = if (roleFilter == "ALL") users else users.filter { it.role == roleFilter }
    val activeCount: Int get() = users.count { it.active }
    val inactiveCount: Int get() = users.size - activeCount

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/users"))
            users = c.optJSONArray("users")?.mapObjects { SettingsUserRow.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            // /api/users answers 403 for non-admin roles too — same card either way.
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsUsersScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SettingsUsersState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<SettingsUserRow?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { UsersAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { UsersNoticeCard(it, SettingsUsersPalette.red500, dark) } }

        item {
            // KPI strip (accounts / active / inactive).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                UsersKpiCard("ACCOUNTS", vm.users.size, SettingsUsersPalette.goldLt, dark)
                UsersKpiCard("ACTIVE", vm.activeCount, SettingsUsersPalette.emerald600, dark)
                UsersKpiCard("INACTIVE", vm.inactiveCount, SettingsUsersPalette.red500, dark)
            }
        }

        item {
            // Role filter chips (client-side — /api/users returns the full list).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("ALL", "SUPER_ADMIN", "ADMIN", "HR", "STAFF", "VIEWER").forEach { r ->
                    UsersChip(
                        if (r == "ALL") "All"
                        else r.replace("_", " ").lowercase()
                            .split(" ").joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } },
                        vm.roleFilter == r, dark,
                    ) { vm.roleFilter = r }
                }
            }
        }

        if (vm.loading && vm.users.isEmpty()) {
            items(5) { Box(Modifier.fillMaxWidth().height(74.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        items(vm.filtered, key = { it.id }) { user ->
            SettingsUserRowCard(user, dark) { selected = user }
        }

        if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("👥", fontSize = 34.sp)
                    Text(
                        if (vm.roleFilter == "ALL") "কোনো ইউজার নেই" else "এই রোলে কেউ নেই",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp,
                    )
                }
            }
        }

        item {
            // The web page keeps ALL account writes — this button is the only way there.
            Text(
                "🌐 ইউজার তৈরি / এডিট / পাসওয়ার্ড — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/settings/users", "Users") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { user ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            SettingsUserDetailSheet(user, dark) { path, title ->
                selected = null
                ctx.openWebForced(path, title)
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun UsersChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SettingsUsersPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SettingsUsersPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SettingsUsersPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

/** Light bento tile: soft accent wash of the KPI's own tint over glass. */
@Composable
private fun UsersKpiCard(label: String, value: Int, tint: Color, dark: Boolean) {
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
        Text("$value", color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun UsersNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun UsersAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SettingsUsersPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Row card (mirrors one web table row / mobile card — read-only) ─────────────────

@Composable
private fun SettingsUserRowCard(user: SettingsUserRow, dark: Boolean, onTap: () -> Unit) {
    val rowAlpha = if (user.active) 1f else 0.62f   // inactive accounts read dimmed
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        UsersAvatar(user.name, 36, dark)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    user.name,
                    color = AlmaTheme.ink(dark).copy(alpha = rowAlpha),
                    fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                // Web status column: Active green-400 · Inactive red-400 — as a dot.
                Box(
                    Modifier
                        .size(7.dp)
                        .background(
                            if (user.active) SettingsUsersPalette.green400 else SettingsUsersPalette.red400,
                            CircleShape,
                        ),
                )
            }
            // Phone (web: font-mono text-gold-lt) or email fallback.
            Text(
                user.phone?.takeIf { it.isNotEmpty() }?.let { SettingsUsersFormat.bdPhone(it) }
                    ?: user.email ?: "—",
                color = SettingsUsersPalette.accentText(dark).copy(alpha = rowAlpha),
                fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            val scope = buildList {
                if (user.businessShortNames.isNotEmpty()) add(user.businessShortNames.joinToString(" · "))
                user.employeeIdGas?.takeIf { it.isNotEmpty() }?.let(::add)
            }
            if (scope.isNotEmpty()) {
                Text(
                    scope.joinToString("  ·  "),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        UsersRoleCapsule(user, dark)
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun UsersRoleCapsule(user: SettingsUserRow, dark: Boolean) {
    val tint = SettingsUsersPalette.role(user.role, dark)
    Text(
        user.roleLabel.uppercase(),
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun UsersAvatar(name: String, sizeDp: Int, dark: Boolean) {
    Box(
        Modifier
            .size(sizeDp.dp)
            .background(SettingsUsersPalette.coral.copy(alpha = 0.16f), CircleShape)
            .border(1.dp, SettingsUsersPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            SettingsUsersFormat.initials(name),
            color = SettingsUsersPalette.accentText(dark),
            fontSize = (sizeDp * 0.31f).sp, fontWeight = FontWeight.Bold,
        )
    }
}

// ── Detail sheet (read-only account card; all writes → web escape hatch) ───────────

@Composable
private fun SettingsUserDetailSheet(
    user: SettingsUserRow,
    dark: Boolean,
    openWeb: (String, String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            UsersAvatar(user.name, 46, dark)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(user.name, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    UsersRoleCapsule(user, dark)
                    Text(
                        if (user.active) "Active" else "Inactive",
                        color = if (user.active) SettingsUsersPalette.green400 else SettingsUsersPalette.red400,
                        fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            UsersInfoRow("Phone", user.phone?.let { SettingsUsersFormat.bdPhone(it) } ?: "—",
                SettingsUsersPalette.accentText(dark), dark, mono = true)
            UsersInfoRow("Email", user.email ?: "—", AlmaTheme.ink(dark), dark, mono = true)
            UsersInfoRow(
                "Business access",
                if (user.businessShortNames.isEmpty()) "—" else user.businessShortNames.joinToString(" · "),
                AlmaTheme.ink(dark), dark,
            )
            UsersInfoRow("HR employee ID (GAS)", user.employeeIdGas ?: "—",
                SettingsUsersPalette.accentText(dark), dark, mono = true)
            UsersInfoRow("Joining date", SettingsUsersFormat.date(user.joiningDate) ?: "—", AlmaTheme.ink(dark), dark)
            user.salaryHint?.let {
                UsersInfoRow("Salary hint", AlmaTheme.taka(it), AlmaTheme.ink(dark), dark, mono = true)
            }
            UsersInfoRow("Account created", SettingsUsersFormat.date(user.createdAt) ?: "—", AlmaTheme.ink(dark), dark)
        }

        // Web "Role capabilities" modal parity — the server-enforced scope hint.
        Column(
            Modifier
                .fillMaxWidth()
                .background(SettingsUsersPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, SettingsUsersPalette.goldDim.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                "ROLE CAPABILITIES",
                color = SettingsUsersPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            )
            Text(user.roleHint, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            Text(
                "রোল / পারমিশন / পাসওয়ার্ড পরিবর্তন শুধু ওয়েবে হয় — নিচের বাটনে যান।",
                color = SettingsUsersPalette.amber600, fontSize = 11.sp,
            )
        }

        Text(
            "🌐 এডিট / পারমিশন / পাসওয়ার্ড — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/settings/users", "Users") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun UsersInfoRow(label: String, value: String, color: Color, dark: Boolean, mono: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            value, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else null,
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SettingsUsersFormat {
    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** Web displayBdPhone parity: "+880 1XX XXX XXXX" grouping when it fits. */
    fun bdPhone(raw: String): String {
        var digits = raw.trim().filter { it.isDigit() || it == '+' }
        if (!digits.startsWith("+")) {
            if (digits.startsWith("880")) digits = "+$digits"
            else if (digits.startsWith("01") && digits.length == 11) digits = "+88$digits"
        }
        if (!digits.startsWith("+880") || digits.length != 14) return digits
        return "${digits.substring(0, 4)} ${digits.substring(4, 7)} ${digits.substring(7, 10)} ${digits.substring(10, 14)}"
    }

    /** ISO timestamp (or plain yyyy-MM-dd) → short local date, Asia/Dhaka. */
    fun date(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("MMM d, yyyy", Locale.US)
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
        // joiningDate can arrive as plain "yyyy-MM-dd".
        if (iso.length >= 10) {
            try {
                val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                day.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
                return day.parse(iso.substring(0, 10))
            } catch (_: Exception) { }
        }
        return null
    }
}
