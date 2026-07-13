//
//  PaymentAccountsScreen.kt
//  ALMA ERP — staff payout methods (bKash / Nagad / Rocket / bank), ported 1:1 from
//  PaymentAccountsSwiftUI.swift (design truth).
//
//  Mirrors the web /portal/payment-accounts page (PaymentAccountsPanel):
//    GET /api/employee/payment-methods?business_id=…   → { ok, data: { methods } }
//  READ-ONLY BY DESIGN (security): the server already masks account numbers on this
//  GET (reveal:false) and adding/editing/deleting payout NUMBERS is sensitive, so the
//  native screen never POSTs/PATCHes/DELETEs — all mutations (add mobile/bank account,
//  set default, remove, reveal full number) go through the web escape hatch.
//  Wallet-app provider-tinted cards (bKash pink · Nagad orange · bank blue), masked
//  numbers in monospace, Verified / Pending-verify badges (green / amber), dark bento
//  hero with count-up. Carried lessons: lenient decoding, ONE screen-level skeleton,
//  no global overlays.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import com.almatraders.erp.shell.str
import com.almatraders.erp.shell.shimmering
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

// ── Web palette (exact hexes from globals.css / tailwind tokens) ─────────────────────

private object PayAcctPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    // Provider tints (Wallet-card look)
    val bkashPink = Color(0xFFEC4899)
    val nagadOrange = Color(0xFFF97316)
    val bankBlue = Color(0xFF3B82F6)
    val rocketViolet = AlmaTheme.violet

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** One tint per payout method — drives the Wallet-style card gradient. */
    fun tint(m: PayMethod): Color {
        if (m.type == "BANK_ACCOUNT") return bankBlue
        return when (m.provider) {
            "BKASH" -> bkashPink
            "NAGAD" -> nagadOrange
            "ROCKET" -> rocketViolet
            else -> coral
        }
    }
}

// ── Model (same field names the web MethodRow type declares) ─────────────────────────

private data class PayMethod(
    val id: String,
    val type: String?,               // MOBILE_BANKING | BANK_ACCOUNT
    val provider: String?,           // BKASH | NAGAD | ROCKET | OTHER
    val usageType: String?,          // PERSONAL | BUSINESS
    val accountHolderName: String?,
    val accountNumber: String?,      // server masks this on list (reveal:false)
    val accountNumberMasked: String?,
    val bankName: String?,
    val branchName: String?,
    val hasQr: Boolean?,
    val isPrimary: Boolean?,
    val isVerified: Boolean?,
    val status: String?,
    val suspiciousNote: String?,
    val displayLabel: String?,
) {
    /** Always show the MASKED number natively — never the full one (security rule). */
    val maskedNumber: String get() = accountNumberMasked ?: accountNumber ?: "—"

    /** Web methodDisplayLabel fallback when displayLabel is absent. */
    val label: String
        get() {
            displayLabel?.takeIf { it.isNotEmpty() }?.let { return it }
            if (type == "BANK_ACCOUNT") return bankName ?: "Bank"
            return (provider ?: "Mobile").lowercase().replaceFirstChar { it.uppercase() }
        }
}

private fun payMethodFrom(o: JSONObject): PayMethod? {
    val id = o.str("id") ?: return null
    return PayMethod(
        id = id,
        type = o.str("type"),
        provider = o.str("provider"),
        usageType = o.str("usageType"),
        accountHolderName = o.str("accountHolderName"),
        accountNumber = o.str("accountNumber"),
        accountNumberMasked = o.str("accountNumberMasked"),
        bankName = o.str("bankName"),
        branchName = o.str("branchName"),
        hasQr = o.flexBool("hasQr"),
        isPrimary = o.flexBool("isPrimary"),
        isVerified = o.flexBool("isVerified"),
        status = o.str("status"),
        suspiciousNote = o.str("suspiciousNote"),
        displayLabel = o.str("displayLabel"),
    )
}

/** Same default business the other native tabs scope to (web _businessId default). */
private val PAY_BUSINESSES: List<Pair<String, String>>
    get() = listOf(
        "ALMA_LIFESTYLE" to "ALMA Lifestyle",
        "ALMA_TRADING" to "ALMA Trading",
        "CREATIVE_DIGITAL_IT" to "CDIT",
    )

// ── State holder (iOS PaymentAccountsVM twin) ────────────────────────────────────────

private class PayAccountsState {
    var methods by mutableStateOf(listOf<PayMethod>())
    var businessId by mutableStateOf("ALMA_LIFESTYLE")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)   // transient "Copied" line
    var authExpired by mutableStateOf(false)

    /** The route wraps via apiSuccess → { ok, data: { methods } } — unwrap both shapes. */
    suspend fun load() {
        loading = true
        error = null
        try {
            val root = AlmaApi.getObject("/api/employee/payment-methods", mapOf("business_id" to businessId))
            val c = root.optJSONObject("data") ?: root
            methods = c.optJSONArray("methods")?.mapObjects { payMethodFrom(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "Could not load payment accounts"
        } finally {
            loading = false
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@Composable
fun PaymentAccountsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { PayAccountsState() }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    LaunchedEffect(Unit) { vm.load() }

    // Transient "Copied" notice (2s), iOS parity.
    LaunchedEffect(vm.notice) {
        if (vm.notice == "Copied") {
            delay(2000)
            if (vm.notice == "Copied") vm.notice = null
        }
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(6.dp)) }

        // Bento dark hero — COUNTS ONLY (this screen has no balances).
        item { PayHeroCard(total = vm.methods.size,
            verified = vm.methods.count { it.isVerified == true },
            pending = vm.methods.count { it.isVerified != true }) }

        // Business scope chips — the web page reads it from BusinessContext; natively
        // the owner flips it here (same three businesses).
        item {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PAY_BUSINESSES.forEach { (id, label) ->
                    PayChip(label, vm.businessId == id, dark) {
                        vm.businessId = id
                        scope.launch { vm.load() }
                    }
                }
            }
        }

        if (vm.authExpired) {
            item { PayAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { PayNoticeCard("⚠️ $it", PayAcctPalette.red500, dark) } }
        vm.notice?.let { item { PayNoticeCard("✓ $it", PayAcctPalette.emerald600, dark) } }

        if (vm.loading && vm.methods.isEmpty()) {
            items(3) {
                Box(Modifier.fillMaxWidth().height(150.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
            }
        }

        items(vm.methods, key = { it.id }) { m ->
            PayAccountCard(m, dark) {
                // Copies the MASKED number only — the full number never reaches this screen.
                clipboard.setText(AnnotatedString(m.maskedNumber))
                vm.notice = "Copied"
            }
        }

        if (!vm.loading && vm.methods.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 50.dp, bottom = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("💳", fontSize = 34.sp)
                    Text(
                        "No payout accounts yet. Add bKash, Nagad, Rocket, or a bank account.",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        "ওয়েবে অ্যাকাউন্ট যোগ করুন",
                        color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .background(PayAcctPalette.coral, CircleShape)
                            .plainClick { ctx.openWebForced("/portal/payment-accounts", "Payment accounts") }
                            .padding(horizontal = 16.dp, vertical = 9.dp),
                    )
                }
            }
        }

        // Security note — the native screen is deliberately view-only.
        item {
            Text(
                "🔒 নিরাপত্তার জন্য অ্যাকাউন্ট যোগ / পরিবর্তন / মুছে ফেলা শুধু ওয়েবে হয়।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            )
        }

        item {
            Text(
                "সব অপশন (Add · Set default · Remove) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/portal/payment-accounts", "Payment accounts") }
                    .padding(vertical = 6.dp),
            )
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

// ── Shared bits (pattern parity) ─────────────────────────────────────────────────────

@Composable
private fun PayChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) PayAcctPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) PayAcctPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) PayAcctPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun PayNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun PayAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(PayAcctPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Dark bento hero (Dashboard hero recipe — deliberately dark in BOTH schemes) ─────

@Composable
private fun PayCountUp(target: Int, fontSize: Int, tint: Color) {
    var started by remember { mutableStateOf(false) }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "payCountUp",
    )
    LaunchedEffect(target) { started = true }
    Text("$shown", color = tint, fontSize = fontSize.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace)
}

@Composable
private fun PayHeroCard(total: Int, verified: Int, pending: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF181528))          // deep indigo base (iOS hero recipe)
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, AlmaTheme.coral.copy(alpha = 0.30f))))
            .background(
                Brush.radialGradient(
                    listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                    radius = 480f,
                ),
            )
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "পেমেন্ট অ্যাকাউন্ট · PAYMENT ACCOUNTS",
            color = PayAcctPalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        PayCountUp(total, 40, Color.White)
        Spacer(Modifier.height(5.dp))
        // Web explainer line kept verbatim.
        Text(
            "Used for salary payouts, wallet advances, and withdrawals. Numbers are masked on shared screens.",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
        )
        Spacer(Modifier.height(14.dp))
        Row {
            PayHeroStat("VERIFIED", verified, PayAcctPalette.green400, "যাচাই হয়েছে")
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp)
                    .height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            PayHeroStat("PENDING VERIFY", pending, if (pending > 0) PayAcctPalette.amber500 else Color.White, "যাচাই বাকি")
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun PayHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        PayCountUp(value, 20, tint)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

// ── Wallet-style account card (provider-tinted, masked monospace number) ────────────

@Composable
private fun PayAccountCard(m: PayMethod, dark: Boolean, onCopy: () -> Unit) {
    val tint = PayAcctPalette.tint(m)
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (dark) Color.White.copy(alpha = 0.075f) else Color.White.copy(alpha = 0.62f))
            // Provider-tinted wash over the glass — the Wallet-card feel.
            .background(
                Brush.linearGradient(
                    listOf(
                        tint.copy(alpha = if (dark) 0.22f else 0.12f),
                        tint.copy(alpha = if (dark) 0.06f else 0.03f),
                    ),
                ),
            )
            .border(1.dp, tint.copy(alpha = if (m.isPrimary == true) 0.45f else 0.25f), shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Provider badge (gradient squircle, bank vs mobile glyph).
            Box(
                Modifier
                    .size(32.dp)
                    .background(
                        Brush.linearGradient(listOf(tint, tint.copy(alpha = 0.7f))),
                        RoundedCornerShape(9.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (m.type == "BANK_ACCOUNT") "🏦" else "📱", fontSize = 14.sp)
            }
            Text(m.label, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (m.isPrimary == true) {
                PayTagPill("Primary", PayAcctPalette.accentText(dark), PayAcctPalette.coral.copy(alpha = 0.15f))
            }
        }

        Text(m.accountHolderName ?: "—", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)

        // Masked number — the Wallet-card centrepiece. Server masks on list;
        // reveal lives on the web only.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                m.maskedNumber,
                color = PayAcctPalette.accentText(dark),
                fontSize = 19.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                letterSpacing = 1.2.sp, maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            Box(
                Modifier
                    .size(30.dp)
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                    .plainClick(onCopy),
                contentAlignment = Alignment.Center,
            ) { Text("📋", fontSize = 12.sp) }
        }

        if (m.type == "BANK_ACCOUNT" && m.bankName != null) {
            Text(
                m.branchName?.let { "${m.bankName} · $it" } ?: m.bankName,
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            // Web badge parity: Verified (green) / Pending verify (amber).
            if (m.isVerified == true) {
                PayTagPill("Verified", PayAcctPalette.green400, PayAcctPalette.green400.copy(alpha = 0.13f))
            } else {
                PayTagPill("Pending verify", PayAcctPalette.amber600, PayAcctPalette.amber500.copy(alpha = 0.13f))
            }
            if (m.usageType == "BUSINESS") {
                PayTagPill("Business", AlmaTheme.inkSecondary(dark), AlmaTheme.ink(dark).copy(alpha = 0.06f))
            }
            if (m.hasQr == true) {
                PayTagPill("QR", AlmaTheme.inkSecondary(dark), AlmaTheme.ink(dark).copy(alpha = 0.06f))
            }
        }

        m.suspiciousNote?.takeIf { it.isNotEmpty() }?.let {
            Text("⚠️ $it", color = PayAcctPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun PayTagPill(label: String, text: Color, bg: Color) {
    Text(
        label,
        color = text, fontSize = 10.sp, fontWeight = FontWeight.Black,
        modifier = Modifier
            .background(bg, CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}
