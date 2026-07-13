//
//  SettingsSessionScreen.kt
//  ALMA ERP — Settings ▸ Session, ported 1:1 from SettingsSessionSwiftUI.swift (read-only).
//
//  Endpoints (same as web/iOS):
//    GET /api/users/me → signed-in identity ({user:{…}} or {data:{user}})
//    GET /api/health   → build/backend diagnostics (frontend git, GAS stamp, clasp @NN,
//                        environment, DB/GAS probes, checked-at)
//  Native additions (web can't show): current-session hero + "this device" card
//  (device model / Android version / app build).
//  READ-ONLY: profile edits, photo and password changes stay on the web escape hatch.
//

package com.almatraders.erp.pages

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object SessionPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web page's fetches return) ────────────────────────

private data class SessionUser(
    val id: String,
    val email: String?,
    val name: String?,
    val phone: String?,
    val role: String?,
    val active: Boolean?,
    val businessAccess: String?,
    val employeeIdGas: String?,
    val joiningDate: String?,
    val profileImageUrl: String?,
    val createdAt: String?,
    val isSystemOwner: Boolean?,
    val roleTitle: String?,
    val profileStatus: String?,
) {
    companion object {
        fun from(o: JSONObject): SessionUser {
            // businessAccess arrives as a string ("ALL" / comma list) — tolerate arrays too.
            val access = o.str("businessAccess") ?: o.optJSONArray("businessAccess")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.opt(it)?.toString() }.joinToString(", ")
            }
            val profile = o.optJSONObject("profile")
            return SessionUser(
                id = o.str("id") ?: "",
                email = o.str("email"),
                name = o.str("name"),
                phone = o.str("phone"),
                role = o.str("role"),
                active = o.flexBool("active"),
                businessAccess = access,
                employeeIdGas = o.str("employeeIdGas"),
                joiningDate = o.str("joiningDate"),
                profileImageUrl = o.str("profileImageUrl"),
                createdAt = o.str("createdAt"),
                isSystemOwner = o.flexBool("isSystemOwner"),
                roleTitle = profile?.str("roleTitle"),
                profileStatus = profile?.str("status"),
            )
        }

        /** {user:{…}} or {data:{user:{…}}}. */
        fun fromResponse(root: JSONObject): SessionUser? {
            root.optJSONObject("user")?.let { return from(it) }
            root.optJSONObject("data")?.optJSONObject("user")?.let { return from(it) }
            return null
        }
    }
}

private data class SessionHealth(
    val ok: Boolean?,
    val timestamp: String?,
    val environment: String?,
    val gasClaspVersion: String?,
    val frontendGitCommit: String?,
    val frontendCommitShort: String?,
    val frontendBranch: String?,
    val apiUrl: String?,
    val gasDeploymentId: String?,
    val gasOk: Boolean?,
    val gasReleaseStamp: String?,
    val databaseOk: Boolean?,
) {
    /** Web apiHost(): hostname of NEXT_PUBLIC_API_URL, "—" when unparsable. */
    val apiHost: String
        get() = apiUrl?.let { try { java.net.URI(it).host } catch (_: Exception) { null } } ?: "—"

    companion object {
        fun from(o: JSONObject): SessionHealth {
            val f = o.optJSONObject("frontend")
            val a = o.optJSONObject("api")
            val g = o.optJSONObject("gas")
            return SessionHealth(
                ok = o.flexBool("ok"),
                timestamp = o.str("timestamp"),
                environment = o.str("environment"),
                gasClaspVersion = o.str("gas_clasp_version"),
                frontendGitCommit = f?.str("git_commit"),
                frontendCommitShort = f?.str("commit_short"),
                frontendBranch = f?.str("branch"),
                apiUrl = a?.str("next_public_api_url"),
                gasDeploymentId = a?.str("gas_deployment_id"),
                gasOk = g?.flexBool("ok"),
                gasReleaseStamp = g?.str("gas_release_stamp"),
                databaseOk = o.optJSONObject("database")?.flexBool("ok"),
            )
        }
    }
}

// ── State holder (iOS SettingsSessionVM twin) ──────────────────────────────────────

private class SessionState {
    var user by mutableStateOf<SessionUser?>(null)
    var health by mutableStateOf<SessionHealth?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            user = SessionUser.fromResponse(AlmaApi.getObject("/api/users/me"))
            health = SessionHealth.from(AlmaApi.getObject("/api/health"))
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun SettingsSessionScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SessionState() }

    LaunchedEffect(Unit) { vm.load() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(4.dp))
        if (vm.authExpired) SessionAuthCard(dark) { ctx.openSmart("/login", "Login") }
        vm.error?.let { SessionNoticeCard(it, dark) }

        if (vm.loading && vm.user == null && vm.health == null) {
            repeat(3) { Box(Modifier.fillMaxWidth().height(130.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            vm.user?.let { u ->
                SessionHeroCard(u, dark)
                SessionDeviceCard(dark)
                SessionAccountCard(u, dark)
            } ?: run {
                if (!vm.authExpired && vm.error == null && !vm.loading) SessionDeviceCard(dark)
            }
            SessionBuildBackendCard(vm.health, vm.loading, dark)
        }

        Text(
            "🌐 প্রোফাইল এডিট ও পাসওয়ার্ড পরিবর্তন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { ctx.openWebForced("/settings/session", "Session") }
                .padding(vertical = 6.dp),
        )
        Spacer(Modifier.height(8.dp))
    }
}

// ── Build / backend card (web "Build / backend" Card parity) ───────────────────────

@Composable
private fun SessionBuildBackendCard(h: SessionHealth?, loading: Boolean, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("BUILD / BACKEND", color = SessionPalette.accentText(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Black, letterSpacing = 1.4.sp)
        if (h != null) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SessionKvRow("Frontend git", h.frontendCommitShort ?: h.frontendGitCommit ?: "—", dark, mono = true)
                h.frontendBranch?.takeIf { it.isNotEmpty() }?.let { SessionKvRow("Branch", it, dark, mono = true) }
                SessionKvRow("GAS stamp", h.gasReleaseStamp ?: "—", dark, mono = true, valueColor = SessionPalette.goldLt)
                SessionKvRow("Clasp @NN", h.gasClaspVersion ?: "—", dark, mono = true)
                SessionKvRow("Deployment ID", h.gasDeploymentId ?: "—", dark, mono = true)
                SessionKvRow("API URL host", h.apiHost, dark, mono = true)
                SessionKvRow("Environment", h.environment ?: "—", dark)
                SessionProbeRow("Database", h.databaseOk, dark)
                SessionProbeRow("GAS backend", h.gasOk, dark)
                SessionKvRow("Checked", SessionFormat.dateTime(h.timestamp) ?: h.timestamp ?: "—", dark, mono = true)
            }
            if (h.ok == false) {
                Text("Backend probe returned ok:false — compare NEXT_PUBLIC_API_URL with clasp deployment.",
                    color = SessionPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        } else if (loading) {
            Box(Modifier.fillMaxWidth().height(90.dp).almaGlass(dark, AlmaTheme.R_CONTROL))
        } else {
            Text("Could not load /api/health", color = SessionPalette.red500, fontSize = 12.sp)
        }
    }
}

@Composable
private fun SessionKvRow(label: String, value: String, dark: Boolean, mono: Boolean = false, valueColor: Color? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(value, color = valueColor ?: AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else null, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 200.dp))
    }
}

@Composable
private fun SessionProbeRow(label: String, ok: Boolean?, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        when (ok) {
            true -> Text("✓ OK", color = SessionPalette.emerald600, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            false -> Text("⚠ FAIL", color = SessionPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            null -> Text("—", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

// ── Hero card (current session: who is signed in, as what) ─────────────────────────

@Composable
private fun SessionHeroCard(user: SessionUser, dark: Boolean) {
    val displayName = user.name ?: user.email ?: "Account"
    val roleLine = if (user.isSystemOwner == true) "System Owner"
        else (user.roleTitle ?: user.role ?: "—").replace("_", " ")
    val isActive = user.active ?: true
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("SIGNED-IN IDENTITY", color = SessionPalette.accentText(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Black, letterSpacing = 1.4.sp)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.size(52.dp)
                    .background(SessionPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, SessionPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(SessionFormat.initials(displayName), color = SessionPalette.accentText(dark),
                    fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(displayName, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                Text(roleLine, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                user.email?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SessionStatusPill(if (isActive) "ACTIVE" else "INACTIVE",
                if (isActive) SessionPalette.green400 else SessionPalette.red500, dark)
            user.businessAccess?.takeIf { it.isNotEmpty() }?.let {
                SessionStatusPill(it.replace("_", " "), SessionPalette.coral, dark,
                    textColor = SessionPalette.accentText(dark))
            }
        }
    }
}

@Composable
private fun SessionStatusPill(label: String, tint: Color, dark: Boolean, textColor: Color? = null) {
    Text(
        label, color = textColor ?: tint, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 9.dp, vertical = 4.dp),
    )
}

// ── This-device card (native-only: what the web page can't see) ────────────────────

@Composable
private fun SessionDeviceCard(dark: Boolean) {
    val context = LocalContext.current
    val appVersion = remember {
        try {
            @Suppress("DEPRECATION")
            val pi = context.packageManager.getPackageInfo(context.packageName, 0)
            "${pi.versionName} (${pi.versionCode})"
        } catch (_: Exception) { "—" }
    }
    val model = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }
        .joinToString(" ").ifBlank { "Android device" }
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("এই ডিভাইস", color = SessionPalette.accentText(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Black, letterSpacing = 1.4.sp)
        SessionDeviceRow("📱", model, "Android ${Build.VERSION.RELEASE}", dark)
        SessionDeviceRow("✅", "ALMA ERP অ্যাপ", "সংস্করণ $appVersion", dark)
    }
}

@Composable
private fun SessionDeviceRow(glyph: String, title: String, subtitle: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier.size(34.dp)
                .background(
                    Brush.linearGradient(listOf(SessionPalette.coral, AlmaTheme.violet)),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                ),
            contentAlignment = Alignment.Center,
        ) { Text(glyph, fontSize = 15.sp) }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

// ── Account details card (rows from /api/users/me) ─────────────────────────────────

@Composable
private fun SessionAccountCard(user: SessionUser, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("অ্যাকাউন্ট তথ্য", color = SessionPalette.accentText(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Black, letterSpacing = 1.4.sp)
        SessionAccountRow("☎", "ফোন", user.phone ?: "—", dark)
        SessionAccountRow("🪪", "Employee ID", user.employeeIdGas ?: "—", dark)
        SessionAccountRow("📅", "যোগদানের তারিখ", SessionFormat.dateOnly(user.joiningDate) ?: "—", dark)
        SessionAccountRow("🕐", "অ্যাকাউন্ট তৈরি", SessionFormat.dateOnly(user.createdAt) ?: "—", dark)
        user.profileStatus?.takeIf { it.isNotEmpty() }?.let {
            SessionAccountRow("✔", "প্রোফাইল স্ট্যাটাস", it.replace("_", " "), dark)
        }
    }
}

@Composable
private fun SessionAccountRow(glyph: String, label: String, value: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier.size(26.dp)
                .background(SessionPalette.coral.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
            contentAlignment = Alignment.Center,
        ) { Text(glyph, fontSize = 12.sp) }
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(value, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun SessionNoticeCard(message: String, dark: Boolean) {
    Text(message, color = SessionPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp))
}

@Composable
private fun SessionAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text("লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(SessionPalette.coral, CircleShape).plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp))
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SessionFormat {
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    fun dateOnly(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("MMM d, yyyy", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
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
        if (iso.length >= 10) {
            try {
                val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                day.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
                return day.parse(iso.substring(0, 10))
            } catch (_: Exception) {}
        }
        return null
    }
}
