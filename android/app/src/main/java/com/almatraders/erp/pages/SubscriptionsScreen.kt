//
//  SubscriptionsScreen.kt
//  ALMA ERP — the owner's personal subscription tracker, ported 1:1 from
//  SubscriptionsSwiftUI.swift (v4). A MANUAL USD ledger (not a live API): the owner
//  records his own recurring services (Gemini, Claude, Vercel…), one card each, fully
//  editable from the phone. Blocks: hero grid (monthly total + next renewal) · upcoming
//  strip · assistant hint · stat trio · section header · service cards with monogram +
//  status capsule + meta grid · add button · full-screen editor sheet (create/edit/delete).
//
//  CRUD (owner-only, cookie-bridged via AlmaApi):
//    GET  /api/assistant/costs/subscriptions        → [ {id,name,amount,currency,…} ]
//    POST /api/assistant/costs/subscriptions        ← body (create)
//    PATCH/DELETE /api/assistant/costs/subscriptions/{id}
//  Status (Active/Expiring/Expired/Free) is DERIVED from amount + nextRenewalAt.
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

// ── Palette (exact hexes from the iOS SubPalette) ──────────────────────────────────

private object SubPalette {
    val coral = AlmaTheme.coral
    val violet = AlmaTheme.violet
    val goldLt = Color(0xFFEEB48F)
    val goldDim = Color(0xFFB4552F)
    val emerald = Color(0xFF3DBE8B)
    val amber = Color(0xFFE0A94B)
    val red = Color(0xFFE4756B)
    val sage = Color(0xFF81B29A)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** One tint per known service brand (iOS SubPalette.brand). */
    fun brand(name: String): Color {
        val n = name.lowercase()
        return when {
            n.contains("gemini") -> Color(0xFF5B8DEF)
            n.contains("claude") || n.contains("anthropic") -> coral
            n.contains("chatgpt") || n.contains("openai") -> emerald
            n.contains("vercel") -> Color(0xFFC9C7D7)
            n.contains("supabase") -> Color(0xFF3ECF8E)
            n.contains("openrouter") -> violet
            n.contains("github") -> Color(0xFFB8B5C4)
            n.contains("cloudflare") -> amber
            else -> FALLBACK[abs(name.hashCode()) % FALLBACK.size]
        }
    }

    /** Deterministic tint for unknown brands (iOS used a hashed HSV). */
    private val FALLBACK = listOf(
        Color(0xFF6AA0F0), Color(0xFF9B7BF0), Color(0xFF48C9A6),
        Color(0xFFE0A94B), Color(0xFFE4756B), Color(0xFF63B7C7),
    )
}

// ── Status + model ─────────────────────────────────────────────────────────────────

private enum class SubStatus(val label: String) {
    ACTIVE("সক্রিয়"), EXPIRING("শীঘ্রই রিনিউ"), EXPIRED("মেয়াদোত্তীর্ণ"), FREE("ফ্রি");

    fun color(): Color = when (this) {
        ACTIVE -> SubPalette.emerald
        EXPIRING -> SubPalette.amber
        EXPIRED -> SubPalette.red
        FREE -> SubPalette.sage
    }
}

private data class Subscription(
    val id: String,
    val name: String,
    val amount: Double,
    val currency: String,
    val billingCycle: String,
    val nextRenewalAt: Date?,
    val category: String?,
    val notes: String?,
    val active: Boolean,
    val plan: String?,
    val paymentMethod: String?,
) {
    val status: SubStatus
        get() {
            if (amount <= 0) return SubStatus.FREE
            val r = nextRenewalAt ?: return if (active) SubStatus.ACTIVE else SubStatus.EXPIRED
            val days = SubFormat.daysUntil(r)
            return when {
                days < 0 -> SubStatus.EXPIRED
                days <= 7 -> SubStatus.EXPIRING
                else -> SubStatus.ACTIVE
            }
        }
    val monthlyEquiv: Double get() = if (billingCycle == "yearly") amount / 12 else amount
    val symbol: String get() = if (currency == "USD") "$" else "$currency "
    val priceLabel: String get() = symbol + String.format(Locale.US, "%.2f", amount)
    val cycleLabel: String get() = if (billingCycle == "yearly") "বার্ষিক" else "মাসিক"
    val planLine: String get() = plan ?: category ?: billingCycle.replaceFirstChar { it.uppercase() }

    companion object {
        fun from(o: JSONObject): Subscription? {
            val id = o.str("id") ?: return null
            return Subscription(
                id = id,
                name = o.str("name") ?: "—",
                amount = o.flexDouble("amount") ?: 0.0,
                currency = o.str("currency") ?: "USD",
                billingCycle = o.str("billingCycle") ?: "monthly",
                nextRenewalAt = SubFormat.parse(o.str("nextRenewalAt")),
                category = o.str("category"),
                notes = o.str("notes"),
                active = o.flexBool("active") ?: true,
                plan = o.str("plan"),
                paymentMethod = o.str("paymentMethod"),
            )
        }
    }
}

// ── State holder (iOS SubscriptionsVM twin) ────────────────────────────────────────

private class SubscriptionsState {
    var subs by mutableStateOf(listOf<Subscription>())
    var loading by mutableStateOf(false)
    var saving by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    suspend fun load() {
        loading = true
        error = null
        try {
            subs = AlmaApi.getArray("/api/assistant/costs/subscriptions")
                .mapObjects { Subscription.from(it) }
                .filter { it.active }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** POST create / PATCH edit — same body the web/iOS SubPayload sends. */
    suspend fun save(body: JSONObject, editingId: String?): Boolean {
        saving = true
        return try {
            if (editingId != null) AlmaApi.send("PATCH", "/api/assistant/costs/subscriptions/$editingId", body)
            else AlmaApi.send("POST", "/api/assistant/costs/subscriptions", body)
            load()
            true
        } catch (e: Exception) {
            error = e.message
            false
        } finally {
            saving = false
        }
    }

    suspend fun delete(id: String) {
        try {
            AlmaApi.send("DELETE", "/api/assistant/costs/subscriptions/$id")
        } catch (_: Exception) { }
        load()
    }

    val activeSubs: List<Subscription>
        get() = subs.filter { it.status != SubStatus.EXPIRED && it.status != SubStatus.FREE }
    val monthlyTotal: Double get() = activeSubs.sumOf { it.monthlyEquiv }
    val yearlyTotal: Double get() = monthlyTotal * 12
    val upcoming: List<Subscription>
        get() = subs.filter { it.nextRenewalAt != null && it.status != SubStatus.EXPIRED && it.status != SubStatus.FREE }
            .sortedBy { it.nextRenewalAt?.time ?: Long.MAX_VALUE }
    val nextRenewal: Subscription? get() = upcoming.firstOrNull()
    fun count(s: SubStatus): Int = subs.count { it.status == s }
}

// ── Hero + strips ──────────────────────────────────────────────────────────────────

@Composable
private fun HeroGrid(vm: SubscriptionsState, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Column(
            Modifier.weight(1f).subSolid(dark).padding(16.dp),
        ) {
            Text("মাসিক মোট", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Text(
                fmtUsd(vm.monthlyTotal),
                color = SubPalette.accentText(dark), fontSize = 29.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, modifier = Modifier.padding(top = 7.dp),
            )
            Text(
                "${vm.activeSubs.size}টি সক্রিয় · বছরে ≈ ${fmtUsd(vm.yearlyTotal)}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, modifier = Modifier.padding(top = 6.dp),
            )
        }
        Column(
            Modifier.weight(1f).subSolid(dark).padding(16.dp),
        ) {
            Text("পরের রিনিউ", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            val countdown = vm.nextRenewal?.nextRenewalAt?.let { r ->
                val d = SubFormat.daysUntil(r); if (d <= 0) "আজ" else "$d দিন"
            } ?: "—"
            Text(countdown, color = AlmaTheme.ink(dark), fontSize = 26.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.padding(top = 7.dp))
            Text(
                vm.nextRenewal?.let { "${it.name} · ${it.priceLabel}" } ?: "—",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun UpcomingStrip(vm: SubscriptionsState, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Text(
            "আসন্ন রিনিউ", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 3.dp),
        )
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            vm.upcoming.take(6).forEach { s ->
                Row(
                    Modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(start = 9.dp, end = 13.dp, top = 9.dp, bottom = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    Monogram(s, 28.dp, 9)
                    Column {
                        Text(s.name, color = AlmaTheme.ink(dark), fontSize = 11.5.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                        Text(renewShort(s), color = AlmaTheme.inkSecondary(dark), fontSize = 9.5.sp)
                    }
                }
            }
        }
    }
}

private fun renewShort(s: Subscription): String {
    val r = s.nextRenewalAt ?: return "—"
    val days = SubFormat.daysUntil(r)
    return "${SubFormat.dayMonth(r)} · ${if (days <= 0) "আজ" else "$days দিন"}"
}

@Composable
private fun AssistantHint(dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(34.dp).background(
                Brush.linearGradient(listOf(SubPalette.coral, SubPalette.violet)),
                RoundedCornerShape(10.dp),
            ),
            contentAlignment = Alignment.Center,
        ) { Text("🎙️", fontSize = 15.sp) }
        Text(
            "Assistant-কে বলুন — \"Vercel-এর খরচ \$20 করো\" বা \"Gemini Pro Plan-এ আপডেট করো\"। সরাসরি এই হিসাব আপডেট হবে।",
            color = AlmaTheme.ink(dark), fontSize = 11.5.sp,
        )
    }
}

@Composable
private fun StatTrio(vm: SubscriptionsState, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        StatCell("${vm.count(SubStatus.ACTIVE)}", "সক্রিয়", SubPalette.emerald, dark, Modifier.weight(1f))
        StatCell("${vm.count(SubStatus.EXPIRING)}", "শীঘ্রই শেষ", SubPalette.amber, dark, Modifier.weight(1f))
        StatCell("${vm.count(SubStatus.EXPIRED)}", "মেয়াদোত্তীর্ণ", SubPalette.red, dark, Modifier.weight(1f))
    }
}

@Composable
private fun StatCell(value: String, key: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier.subSolid(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Text(key, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

@Composable
private fun SectionHeader(count: Int, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("সব সাবস্ক্রিপশন", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        Text("ম্যানুয়াল · ${count}টি", color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp)
    }
}

// ── Formatting helpers (iOS SubFormat twin) ────────────────────────────────────────

private object SubFormat {
    private fun tz() = TimeZone.getTimeZone("Asia/Dhaka")

    /** ISO date/datetime → Date (accepts "yyyy-MM-dd" and ISO timestamps). */
    fun parse(iso: String?): Date? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd",
        )
        for (p in patterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                f.timeZone = if (p == "yyyy-MM-dd") tz() else TimeZone.getTimeZone("UTC")
                return f.parse(iso)
            } catch (_: Exception) { }
        }
        return null
    }

    /** Whole calendar days from now to [d], Asia/Dhaka (matches iOS dateComponents). */
    fun daysUntil(d: Date): Int {
        val cal = Calendar.getInstance(tz())
        fun midnight(t: Long): Long {
            cal.timeInMillis = t
            cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
            cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }
        val diff = midnight(d.time) - midnight(System.currentTimeMillis())
        return Math.round(diff / 86_400_000.0).toInt()
    }

    fun ymd(d: Date): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US); f.timeZone = tz(); return f.format(d)
    }

    fun dayMonth(d: Date): String {
        val f = SimpleDateFormat("d MMM", Locale("bn", "BD")); f.timeZone = tz(); return f.format(d)
    }
}

// ── Editor sheet (iOS SubEditor twin) ──────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubEditor(
    existing: Subscription?,
    saving: Boolean,
    dark: Boolean,
    onDelete: (String) -> Unit,
    onSave: (JSONObject, String?) -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var plan by remember { mutableStateOf(existing?.plan ?: "") }
    var amount by remember { mutableStateOf(existing?.let { String.format(Locale.US, "%.2f", it.amount) } ?: "") }
    var currency by remember { mutableStateOf(existing?.currency ?: "USD") }
    var cycle by remember { mutableStateOf(existing?.billingCycle ?: "monthly") }
    var renewal by remember { mutableStateOf(existing?.nextRenewalAt ?: Date()) }
    var payment by remember { mutableStateOf(existing?.paymentMethod ?: "") }
    var category by remember { mutableStateOf(existing?.category ?: "") }
    var notes by remember { mutableStateOf(existing?.notes ?: "") }
    var showDate by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            if (existing == null) "নতুন সাবস্ক্রিপশন" else "এডিট",
            color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold,
        )
        OutlinedTextField(name, { name = it }, label = { Text("নাম (যেমন Gemini)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(plan, { plan = it }, label = { Text("প্ল্যান (যেমন Google AI Pro)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(amount, { amount = it }, label = { Text("খরচ") }, prefix = { Text(if (currency == "USD") "$" else currency) }, singleLine = true, modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            EditorToggle("USD", currency == "USD", dark, Modifier.weight(1f)) { currency = "USD" }
            EditorToggle("BDT", currency == "BDT", dark, Modifier.weight(1f)) { currency = "BDT" }
            EditorToggle("মাসিক", cycle == "monthly", dark, Modifier.weight(1f)) { cycle = "monthly" }
            EditorToggle("বার্ষিক", cycle == "yearly", dark, Modifier.weight(1f)) { cycle = "yearly" }
        }
        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).plainClick { showDate = true }.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("পরের রিনিউ", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
            Spacer(Modifier.weight(1f))
            Text(SubFormat.ymd(renewal), color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        OutlinedTextField(payment, { payment = it }, label = { Text("Payment (যেমন Visa •••• 4242)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(category, { category = it }, label = { Text("Category") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(notes, { notes = it }, label = { Text("নোট") }, modifier = Modifier.fillMaxWidth())

        val canSave = name.trim().isNotEmpty() && !saving
        Text(
            if (saving) "সেভ হচ্ছে…" else "সেভ",
            color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .fillMaxWidth()
                .background(if (canSave) SubPalette.coral else SubPalette.coral.copy(alpha = 0.4f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick {
                    if (canSave) {
                        val body = JSONObject()
                            .put("name", name.trim())
                            .put("amount", amount.toDoubleOrNull() ?: 0.0)
                            .put("currency", currency)
                            .put("billingCycle", cycle)
                            .put("nextRenewalAt", SubFormat.ymd(renewal))
                            .put("category", category.ifBlank { JSONObject.NULL })
                            .put("notes", notes.ifBlank { JSONObject.NULL })
                            .put("plan", plan.ifBlank { JSONObject.NULL })
                            .put("paymentMethod", payment.ifBlank { JSONObject.NULL })
                        onSave(body, existing?.id)
                    }
                }
                .padding(vertical = 13.dp),
        )
        existing?.let { e ->
            Text(
                "🗑 এই সাবস্ক্রিপশন মুছুন",
                color = SubPalette.red, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.fillMaxWidth().plainClick { onDelete(e.id) }.padding(vertical = 8.dp),
            )
        }
    }

    if (showDate) {
        val dpState = rememberDatePickerState(initialSelectedDateMillis = renewal.time)
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    dpState.selectedDateMillis?.let { renewal = Date(it) }
                    showDate = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showDate = false }) { Text("বাতিল") } },
        ) { DatePicker(state = dpState) }
    }
}

@Composable
private fun EditorToggle(label: String, active: Boolean, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SubPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 12.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        modifier = modifier
            .background(
                if (active) SubPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SubPalette.coral.copy(alpha = 0.55f) else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(vertical = 9.dp),
    )
}

private fun fmtUsd(n: Double): String = "$" + String.format(Locale.US, "%.2f", n)

// ── Service card + shared bits ─────────────────────────────────────────────────────

@Composable
private fun SubCard(s: Subscription, dark: Boolean, onEdit: () -> Unit) {
    Column(Modifier.fillMaxWidth().subSolid(dark).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Monogram(s, 42.dp, 13)
            Column(Modifier.weight(1f)) {
                Text(s.name, color = AlmaTheme.ink(dark), fontSize = 15.5.sp, fontWeight = FontWeight.Bold)
                Text(s.planLine, color = AlmaTheme.inkSecondary(dark), fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(s.priceLabel, color = AlmaTheme.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text(if (s.status == SubStatus.FREE) "ফ্রি" else "/${s.cycleLabel}", color = AlmaTheme.inkSecondary(dark), fontSize = 9.5.sp)
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val sc = s.status.color()
            Row(
                Modifier
                    .background(sc.copy(alpha = 0.13f), CircleShape)
                    .border(1.dp, sc.copy(alpha = 0.28f), CircleShape)
                    .padding(horizontal = 9.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Box(Modifier.size(6.dp).background(sc, CircleShape))
                Text(s.status.label, color = sc, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.size(29.dp).almaGlass(dark, 9).plainClick(onEdit),
                contentAlignment = Alignment.Center,
            ) { Text("✎", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp) }
        }
        MetaGrid(s, dark)
    }
}

@Composable
private fun MetaGrid(s: Subscription, dark: Boolean) {
    Column(Modifier.padding(top = 13.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(AlmaTheme.separator(dark)))
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            MetaCell("Billing", s.cycleLabel, dark, Modifier.weight(1f))
            MetaCell("Next Renewal", if (s.nextRenewalAt == null) "—" else renewShort(s), dark, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            MetaCell("Payment", s.paymentMethod ?: "—", dark, Modifier.weight(1f))
            MetaCell("Cycle Cost", s.priceLabel, dark, Modifier.weight(1f))
        }
    }
}

@Composable
private fun MetaCell(key: String, value: String, dark: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(key.uppercase(), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Monogram(s: Subscription, size: androidx.compose.ui.unit.Dp, radius: Int) {
    val c = SubPalette.brand(s.name)
    Box(
        Modifier
            .size(size)
            .background(AlmaTheme.ink(AlmaTheme.isDark).copy(alpha = 0.04f), RoundedCornerShape(radius.dp))
            .border(1.dp, c.copy(alpha = 0.4f), RoundedCornerShape(radius.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            s.name.take(1).uppercase(),
            color = c, fontWeight = FontWeight.Bold,
            fontSize = (size.value * 0.44f).sp,
        )
    }
}

@Composable
private fun AddButton(dark: Boolean, onClick: () -> Unit) {
    Text(
        "+ নতুন সাবস্ক্রিপশন যোগ করুন",
        color = AlmaTheme.inkSecondary(dark), fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .fillMaxWidth()
            .almaGlass(dark, 16)
            .plainClick(onClick)
            .padding(15.dp),
    )
}

@Composable
private fun AuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().subSolid(dark).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(SubPalette.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun ErrorCard(msg: String, dark: Boolean) {
    Text(
        "⚠️ $msg", color = SubPalette.red, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().subSolid(dark, 12).padding(12.dp),
    )
}

/** Opaque card surface (iOS subSolid/subRaised): solid fill + hairline ring. */
private fun Modifier.subSolid(dark: Boolean, corner: Int = AlmaTheme.R_CARD): Modifier {
    val shape = RoundedCornerShape(corner.dp)
    return this
        .background(AlmaTheme.cardBg(dark), shape)
        .border(1.dp, Color.White.copy(alpha = if (dark) 0.06f else 0.6f), shape)
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { SubscriptionsState() }
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<Subscription?>(null) }
    var showEditor by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Spacer(Modifier.height(2.dp)) }
        if (vm.authExpired) item { AuthCard(dark) { ctx.openSmart("/login", "Login") } }
        vm.error?.let { item { ErrorCard(it, dark) } }
        if (vm.loading && vm.subs.isEmpty()) {
            items(4) { Box(Modifier.fillMaxWidth().height(108.dp).subSolid(dark)) }
        }
        if (vm.subs.isNotEmpty() || (!vm.loading && !vm.authExpired)) {
            item { HeroGrid(vm, dark) }
            if (vm.upcoming.isNotEmpty()) item { UpcomingStrip(vm, dark) }
            item { AssistantHint(dark) }
            item { StatTrio(vm, dark) }
            item { SectionHeader(vm.subs.size, dark) }
            items(vm.subs, key = { it.id }) { s ->
                SubCard(s, dark, onEdit = { editing = s; showEditor = true })
            }
            item {
                AddButton(dark) { editing = null; showEditor = true }
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    if (showEditor) {
        ModalBottomSheet(
            onDismissRequest = { showEditor = false },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            SubEditor(
                existing = editing,
                saving = vm.saving,
                dark = dark,
                onDelete = { id -> showEditor = false; scope.launch { vm.delete(id) } },
                onSave = { body, id ->
                    scope.launch { if (vm.save(body, id)) showEditor = false }
                },
            )
        }
    }
}
