//
//  SettingsDatabaseScreen.kt
//  ALMA ERP — Settings ▸ Database, ported 1:1 from SettingsDatabaseSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET /api/settings/database-status  → connection diagnostics + user row count (flat)
//    GET /api/health                    → env validation · wallet ledger · GAS · storage (nested)
//  Blocks: health hero (green/amber/red) · Connection info card · Live status rows
//  (dot + label + mono detail + OK/Issue) · table stats (mono counts) · infra/backup card ·
//  Quick fixes (read-only text).
//  ⚠️ STRICTLY READ-ONLY — migrations/backup/restore/cleanup stay on the web escape hatch.
//

package com.almatraders.erp.pages

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Divider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import org.json.JSONObject

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object DatabasePalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web StatusJson / HealthJson types declare) ────────

/** GET /api/settings/database-status — flat JSON, no ok/data wrapper. */
private data class DatabaseStatus(
    val databaseUrlConfigured: Boolean?,
    val databaseUrlHint: String?,
    val postgresReachable: Boolean?,
    val prismaWorks: Boolean?,
    val userRowCount: Int?,
    val nextAuthSecretConfigured: Boolean?,
    val nextAuthUrl: String?,
    val error: String?,
) {
    companion object {
        fun from(o: JSONObject): DatabaseStatus = DatabaseStatus(
            databaseUrlConfigured = o.flexBool("databaseUrlConfigured"),
            databaseUrlHint = o.str("databaseUrlHint"),
            postgresReachable = o.flexBool("postgresReachable"),
            prismaWorks = o.flexBool("prismaWorks"),
            userRowCount = o.flexInt("userRowCount"),
            nextAuthSecretConfigured = o.flexBool("nextAuthSecretConfigured"),
            nextAuthUrl = o.str("nextAuthUrl"),
            error = o.str("error"),
        )
    }
}

/** GET /api/health — the slice the web page renders plus the infra card bits. */
private data class DatabaseHealth(
    val ok: Boolean?,
    val environment: String?,
    val envOk: Boolean?,
    val envMissing: Int?,
    val envPlaceholder: Int?,
    val dbOk: Boolean?,
    val dbError: String?,
    val walletLedgerOk: Boolean?,
    val cronConfigured: Boolean?,
    val notificationsDbOk: Boolean?,
    val storageConfigured: Boolean?,
    val storageBucket: String?,
    val commitShort: String?,
    val branch: String?,
    val gasOk: Boolean?,
    val gasReleaseStamp: String?,
) {
    companion object {
        fun from(o: JSONObject): DatabaseHealth {
            val env = o.optJSONObject("env")
            val db = o.optJSONObject("database")
            val notif = o.optJSONObject("notifications")
            val storage = o.optJSONObject("storage")
            val frontend = o.optJSONObject("frontend")
            val gas = o.optJSONObject("gas")
            return DatabaseHealth(
                ok = o.flexBool("ok"),
                environment = o.str("environment"),
                envOk = env?.flexBool("ok"),
                envMissing = env?.optJSONArray("missing")?.length(),
                envPlaceholder = env?.optJSONArray("placeholder")?.length(),
                dbOk = db?.flexBool("ok"),
                dbError = db?.str("error"),
                walletLedgerOk = db?.flexBool("wallet_ledger_ok"),
                cronConfigured = o.optJSONObject("cron")?.flexBool("configured"),
                notificationsDbOk = notif?.flexBool("database_ok"),
                storageConfigured = storage?.flexBool("expense_receipts_configured"),
                storageBucket = storage?.str("expense_receipts_bucket"),
                commitShort = frontend?.str("commit_short"),
                branch = frontend?.str("branch"),
                gasOk = gas?.flexBool("ok"),
                gasReleaseStamp = gas?.str("gas_release_stamp"),
            )
        }
    }
}

// ── State holder (iOS SettingsDatabaseVM twin) ─────────────────────────────────────

private enum class DatabaseVerdict { HEALTHY, DEGRADED, DOWN }

private class DatabaseState {
    var status by mutableStateOf<DatabaseStatus?>(null)
    var health by mutableStateOf<DatabaseHealth?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val verdict: DatabaseVerdict
        get() {
            val s = status ?: return DatabaseVerdict.DEGRADED
            if (s.postgresReachable != true || s.prismaWorks != true) return DatabaseVerdict.DOWN
            val degraded = s.databaseUrlConfigured != true ||
                s.nextAuthSecretConfigured != true ||
                health?.envOk == false ||
                health?.walletLedgerOk == false ||
                health?.ok == false
            return if (degraded) DatabaseVerdict.DEGRADED else DatabaseVerdict.HEALTHY
        }

    suspend fun load() {
        loading = true
        error = null
        try {
            status = DatabaseStatus.from(AlmaApi.getObject("/api/settings/database-status"))
            authExpired = false
            // Health is best-effort — the web page swallows its failure too.
            health = try { DatabaseHealth.from(AlmaApi.getObject("/api/health")) } catch (_: Exception) { null }
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
fun SettingsDatabaseScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { DatabaseState() }

    LaunchedEffect(Unit) { vm.load() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Spacer(Modifier.height(4.dp))
        if (vm.authExpired) DatabaseAuthCard(dark) { ctx.openWebForced("/login", "Login") }
        vm.error?.let { DatabaseNoticeCard(it, DatabasePalette.red500, dark) }

        if (vm.loading && vm.status == null) {
            repeat(4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            vm.status?.let { s ->
                DatabaseHeroCard(vm.verdict, s, dark)
                s.error?.takeIf { it.isNotEmpty() }?.let { DatabaseNoticeCard(it, DatabasePalette.red500, dark) }
                DatabaseConnectionCard(dark)
                DatabaseLiveStatusCard(s, vm.health, dark)
                DatabaseTableStatsCard(s, vm.health, dark)
                DatabaseInfraCard(vm.health, dark)
                DatabaseQuickFixesCard(dark)
            }
        }

        Text(
            "🌐 মাইগ্রেশন/ব্যাকআপ টুলসসহ সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { ctx.openWebForced("/settings/database", "Database") }
                .padding(vertical = 6.dp),
        )
        Spacer(Modifier.height(8.dp))
    }
}

// ── Health hero (green/amber/red) ──────────────────────────────────────────────────

@Composable
private fun DatabaseHeroCard(verdict: DatabaseVerdict, s: DatabaseStatus, dark: Boolean) {
    val (tint, icon, title, sub) = when (verdict) {
        DatabaseVerdict.HEALTHY -> Quad(DatabasePalette.emerald600, "✅",
            "ডাটাবেস সচল", "PostgreSQL · Prisma · NextAuth — সব OK")
        DatabaseVerdict.DEGRADED -> Quad(DatabasePalette.amber600, "⚠️",
            "আংশিক সমস্যা", "সংযোগ আছে, কিছু চেক ব্যর্থ — নিচের তালিকা দেখুন")
        DatabaseVerdict.DOWN -> Quad(DatabasePalette.red500, "⛔",
            "ডাটাবেস সংযোগ নেই", "PostgreSQL পৌঁছানো যাচ্ছে না — Quick fixes দেখুন")
    }
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, tint.copy(alpha = 0.35f), shape)
            .padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(icon, fontSize = 26.sp)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            s.databaseUrlHint?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

private data class Quad(val tint: Color, val icon: String, val title: String, val sub: String)

// ── Connection card (web "Connection" gold card, verbatim copy) ────────────────────

@Composable
private fun DatabaseConnectionCard(dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, DatabasePalette.goldDim.copy(alpha = 0.25f), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("CONNECTION", color = DatabasePalette.accentText(dark),
            fontSize = 11.sp, fontWeight = FontWeight.Black, letterSpacing = 1.2.sp)
        Text("Uses Supabase Postgres for ERP accounts and RBAC. Google Sheets behaviour is unchanged (NEXT_PUBLIC_API_URL).",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Text("docs/SUPABASE_POSTGRES_SETUP.md", color = DatabasePalette.goldLt,
            fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(top = 4.dp))
    }
}

// ── Live status rows (web Row component parity: dot · label · detail · OK/Issue) ────

@Composable
private fun DatabaseLiveStatusCard(s: DatabaseStatus, h: DatabaseHealth?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
    ) {
        Text("Live status", color = AlmaTheme.ink(dark), fontSize = 15.sp,
            fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 6.dp))
        DatabaseStatusRow("PostgreSQL reachable", s.postgresReachable, s.databaseUrlHint, dark)
        DatabaseStatusRow("Prisma query OK", s.prismaWorks, null, dark)
        DatabaseStatusRow("DATABASE_URL configured", s.databaseUrlConfigured, s.databaseUrlHint, dark)
        DatabaseStatusRow("NextAuth signing secret", s.nextAuthSecretConfigured, s.nextAuthUrl, dark)
        DatabaseStatusRow("Environment validation", h?.envOk,
            h?.let { "missing=${it.envMissing ?: 0} placeholders=${it.envPlaceholder ?: 0}" }, dark)
        DatabaseStatusRow("Wallet ledger health", h?.walletLedgerOk, h?.dbError, dark, last = true)
    }
}

@Composable
private fun DatabaseStatusRow(label: String, ok: Boolean?, detail: String?, dark: Boolean, last: Boolean = false) {
    val tone = when (ok) {
        null -> AlmaTheme.inkSecondary(dark)
        true -> DatabasePalette.green400
        false -> DatabasePalette.red500
    }
    Column {
        Row(Modifier.padding(vertical = 7.dp)) {
            Box(Modifier.padding(top = 4.dp).size(8.dp)
                .background(if (ok == null) AlmaTheme.inkSecondary(dark).copy(alpha = 0.5f) else tone, CircleShape))
            Spacer(Modifier.size(8.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(label, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                detail?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.size(8.dp))
            Text(if (ok == null) "…" else if (ok) "OK" else "ISSUE",
                color = tone, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        if (!last) Divider(color = AlmaTheme.separator(dark))
    }
}

// ── Table stats (mono row counts) ──────────────────────────────────────────────────

@Composable
private fun DatabaseTableStatsCard(s: DatabaseStatus, h: DatabaseHealth?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("টেবিল পরিসংখ্যান", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp)
        DatabaseStatRow("users", s.userRowCount?.let { "%,d".format(it) } ?: "—",
            s.userRowCount != null, dark)
        DatabaseStatRow("employee_ledger (wallet)",
            statLabel(h?.walletLedgerOk), h?.walletLedgerOk != false, dark)
        DatabaseStatRow("notifications",
            statLabel(h?.notificationsDbOk), h?.notificationsDbOk != false, dark)
    }
}

private fun statLabel(b: Boolean?): String = when (b) { true -> "OK"; false -> "Issue"; null -> "—" }

@Composable
private fun DatabaseStatRow(name: String, value: String, ok: Boolean, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        Text(
            value, color = if (ok) DatabasePalette.accentText(dark) else DatabasePalette.red500,
            fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            modifier = Modifier.background(DatabasePalette.coral.copy(alpha = 0.14f), CircleShape)
                .padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

// ── Infra / backup card (read-only info) ───────────────────────────────────────────

@Composable
private fun DatabaseInfraCard(h: DatabaseHealth?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("স্টোরেজ ও ব্যাকআপ তথ্য", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp)
        DatabaseInfoRow("Environment", h?.environment ?: "—", dark)
        DatabaseInfoRow("Receipt storage (Supabase)",
            if (h?.storageConfigured == true) (h.storageBucket ?: "configured") else "not configured",
            dark, mono = true, tint = if (h?.storageConfigured == true) null else DatabasePalette.amber600)
        DatabaseInfoRow("Google Sheets (GAS)",
            if (h?.gasOk == true) (h.gasReleaseStamp ?: "OK") else if (h?.gasOk == false) "Issue" else "—",
            dark, mono = true, tint = if (h?.gasOk == false) DatabasePalette.red500 else null)
        DatabaseInfoRow("Cron secret", if (h?.cronConfigured == true) "configured" else "missing",
            dark, tint = if (h?.cronConfigured == true) null else DatabasePalette.amber600)
        DatabaseInfoRow("Build",
            listOfNotNull(h?.branch, h?.commitShort).joinToString(" · ").ifEmpty { "—" }, dark, mono = true)
    }
}

@Composable
private fun DatabaseInfoRow(label: String, value: String, dark: Boolean, mono: Boolean = false, tint: Color? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(value, color = tint ?: AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            fontFamily = if (mono) FontFamily.Monospace else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Quick fixes (informational only, actions stay on web) ──────────────────────────

@Composable
private fun DatabaseQuickFixesCard(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("QUICK FIXES", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 1.0.sp)
        listOf(
            "Copy the Supabase direct Postgres URI into both .env.local and .env.",
            "Run npx prisma db push then npm run db:seed.",
            "Ensure password characters are URL-encoded in the connection string.",
        ).forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                Text(line, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        }
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun DatabaseNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp))
}

@Composable
private fun DatabaseAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text("লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(DatabasePalette.coral, CircleShape).plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp))
    }
}
