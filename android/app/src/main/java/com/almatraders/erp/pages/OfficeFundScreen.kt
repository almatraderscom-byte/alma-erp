//
//  OfficeFundScreen.kt
//  ALMA ERP — the Office Fund (petty cash) page, ported 1:1 from OfficeFundSwiftUI.swift
//  (web /finance/office-fund parity, FULL ACTION PARITY — owner instruction 2026-07-06):
//
//    GET   /api/finance/office-fund     → { ok, canTopUp, summary, ledger }
//    POST  /api/finance/office-fund     { amount, note? }                    টপ-আপ
//    GET   /api/finance/office-advance  → { ok, advances, outstanding }
//    POST  /api/finance/office-advance  { amount, purpose?, payout_method,
//                                         payout_number }                    আবেদন
//    PATCH /api/finance/office-advance  { advance_id, spent, leftover_method } হিসাব
//
//  Blocks: dark balance hero · in/out KPI tiles · action rows (টপ-আপ / অ্যাডভান্স
//  আবেদন sheets with Bangla confirm dialog before every money POST) · my office
//  advances (status badges + হিসাব দিন sheet) · recent ledger with flow chips and
//  tap-to-detail sheet. Carried lessons: per-action busy flags, server {ok:false,
//  message} surfaced verbatim, 403 → admin-only card, reload after every mutation.
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
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

private object OfPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val sky400 = Color(0xFF38BDF8)          // OUTSTANDING
    val heroBase = Color(0xFF181528)        // dark bento anchor base

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    fun positive(dark: Boolean): Color = if (dark) green400 else emerald600
}

// ── Formatting (OfficeFundFormat twins) ─────────────────────────────────────────────

private object OfFormat {
    /** Whole-taka display — ৳12,345 (whole-taka BDT, never floats). */
    fun taka(amount: Int): String =
        (if (amount < 0) "−" else "") + "৳" + String.format("%,d", kotlin.math.abs(amount.toLong()))

    /** createdAt → "05 Jul, 08:50 PM" (web fmtDate), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("dd MMM, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    fun parse(iso: String?): Date? {
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

/** Bangla-digit-tolerant whole-taka parser: "১০০০" → 1000, "10,000" → 10000. */
private fun ofParseTaka(raw: String): Int {
    val map = mapOf(
        '০' to '0', '১' to '1', '২' to '2', '৩' to '3', '৪' to '4',
        '৫' to '5', '৬' to '6', '৭' to '7', '৮' to '8', '৯' to '9',
    )
    val digits = raw.map { map[it] ?: it }.filter { it in '0'..'9' }.joinToString("")
    return digits.toIntOrNull() ?: 0
}

/** The web's PAYOUT_METHODS constant, verbatim order. */
private val OF_PAYOUT_METHODS = listOf("bKash", "Nagad", "Rocket", "ব্যাংক", "ক্যাশ")

// ── Models (same field names the web page types declare) ───────────────────────────

private data class OfLedgerRow(
    val id: String,
    val type: String,
    val amount: Int,
    val note: String?,
    val refType: String?,
    val refId: String?,
    val createdByName: String?,
    val createdAt: String?,
) {
    /** Web TYPE_LABEL parity — Bangla strings verbatim. */
    val labelBn: String
        get() = when (type) {
            "TOP_UP" -> "টপ-আপ (যোগ)"
            "RETURN_IN" -> "ফেরত (যোগ)"
            "ADVANCE_OUT" -> "অ্যাডভান্স (বাদ)"
            "EXPENSE" -> "খরচ (বাদ)"
            "ADJUSTMENT" -> "সংশোধন"
            else -> type
        }

    /** Web TYPE_LABEL.positive — money flowing INTO the fund. */
    val isPositive: Boolean
        get() = when (type) {
            "ADVANCE_OUT", "EXPENSE" -> false
            else -> true
        }

    companion object {
        fun from(o: JSONObject): OfLedgerRow = OfLedgerRow(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            type = o.str("type") ?: "—",
            amount = o.flexInt("amount") ?: 0,
            note = o.str("note"),
            refType = o.str("refType"),
            refId = o.str("refId"),
            createdByName = o.str("createdByName"),
            createdAt = o.str("createdAt"),
        )
    }
}

private data class OfSummary(
    val balance: Int,
    val totalIn: Int,
    val totalOut: Int,
    val entryCount: Int,
) {
    companion object {
        fun from(o: JSONObject?): OfSummary? {
            if (o == null) return null
            return OfSummary(
                balance = o.flexInt("balance") ?: 0,
                totalIn = o.flexInt("totalIn") ?: 0,
                totalOut = o.flexInt("totalOut") ?: 0,
                entryCount = o.flexInt("entryCount") ?: 0,
            )
        }
    }
}

private data class OfAdvanceRow(
    val id: String,
    val amount: Int,
    val purpose: String?,
    val payoutMethod: String?,
    val payoutNumber: String?,
    val status: String,
    val spentAmount: Int?,
    val leftoverAmount: Int?,
    val createdAt: String?,
) {
    /** Web ADV_STATUS parity — Bangla strings verbatim. */
    val statusBn: String
        get() = when (status) {
            "PENDING" -> "অপেক্ষমাণ"
            "OUTSTANDING" -> "বকেয়া (হিসাব দিন)"
            "SETTLED" -> "নিষ্পত্তি হয়েছে"
            "REJECTED" -> "প্রত্যাখ্যাত"
            "CANCELLED" -> "বাতিল"
            else -> status
        }

    fun statusColor(dark: Boolean): Color = when (status) {
        "PENDING" -> OfPalette.amber500
        "OUTSTANDING" -> OfPalette.sky400
        "SETTLED" -> OfPalette.emerald600
        "REJECTED" -> OfPalette.red500
        else -> AlmaTheme.inkSecondary(dark)
    }

    companion object {
        fun from(o: JSONObject): OfAdvanceRow = OfAdvanceRow(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            amount = o.flexInt("amount") ?: 0,
            purpose = o.str("purpose"),
            payoutMethod = o.str("payoutMethod"),
            payoutNumber = o.str("payoutNumber"),
            status = o.str("status") ?: "—",
            spentAmount = o.flexInt("spentAmount"),
            leftoverAmount = o.flexInt("leftoverAmount"),
            createdAt = o.str("createdAt"),
        )
    }
}

// ── State holder (OfficeFundVM twin) ────────────────────────────────────────────────

private class OfficeFundState {
    // Fund
    var summary by mutableStateOf<OfSummary?>(null)
    var ledger by mutableStateOf(listOf<OfLedgerRow>())
    var canTopUp by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    /** The route answers 403 for non-admins — web shows a toast; we show a card. */
    var adminOnly by mutableStateOf(false)
    var authExpired by mutableStateOf(false)

    // Advances
    var advances by mutableStateOf(listOf<OfAdvanceRow>())
    var outstandingCount by mutableStateOf(0)
    var outstandingTotal by mutableStateOf(0)
    var advLoading by mutableStateOf(false)

    // Actions (web toast parity: one success line + per-action busy flags)
    var notice by mutableStateOf<String?>(null)
    var topUpSaving by mutableStateOf(false)
    var advSaving by mutableStateOf(false)
    var recSaving by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loadFund()
        loadAdvances()
    }

    suspend fun loadFund() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/finance/office-fund"))
            summary = OfSummary.from(c.optJSONObject("summary"))
            ledger = c.optJSONArray("ledger")?.mapObjects { OfLedgerRow.from(it) } ?: emptyList()
            canTopUp = c.flexBool("canTopUp") ?: false
            adminOnly = false
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: AlmaApiException.Http) {
            if (e.status == 403) adminOnly = true   // web: "অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।"
            else error = "ফান্ড লোড করা যায়নি।"
        } catch (e: Exception) {
            error = "ফান্ড লোড করা যায়নি।"
        } finally {
            loading = false
        }
    }

    /** Web parity: advances failing is non-fatal — the fund still shows. */
    suspend fun loadAdvances() {
        advLoading = true
        try {
            val c = unwrap(AlmaApi.getObject("/api/finance/office-advance"))
            advances = c.optJSONArray("advances")?.mapObjects { OfAdvanceRow.from(it) } ?: emptyList()
            val out = c.optJSONObject("outstanding")
            outstandingCount = out?.flexInt("count") ?: 0
            outstandingTotal = out?.flexInt("total") ?: 0
        } catch (_: Exception) {
            // Non-fatal — the fund still loads; advances just stay empty.
        } finally {
            advLoading = false
        }
    }

    // ── Mutations (web parity: same endpoints, same bodies, reload after) ──

    /** POST /api/finance/office-fund { amount, note? } — owner-only টপ-আপ.
     *  Returns null on success (notice set + fund reloaded), or a Bangla error line. */
    suspend fun topUp(amount: Int, note: String): String? {
        if (amount <= 0) return "সঠিক একটি অঙ্ক দিন।"
        if (topUpSaving) return null
        topUpSaving = true
        notice = null
        try {
            val body = JSONObject().put("amount", amount)
            val trimmed = note.trim()
            if (trimmed.isNotEmpty()) body.put("note", trimmed)
            val resp = AlmaApi.send("POST", "/api/finance/office-fund", body)
            if (resp.flexBool("ok") == false) return resp.str("message") ?: "যোগ করা যায়নি।"
            notice = resp.str("message") ?: "যোগ হয়েছে।"
            loadFund()          // web: await load()
            return null
        } catch (e: Exception) {
            return failureMessage(e, "যোগ করা যায়নি।")
        } finally {
            topUpSaving = false
        }
    }

    /** POST /api/finance/office-advance { amount, purpose?, payout_method, payout_number }
     *  — অফিস অ্যাডভান্স আবেদন. Returns null on success, or a Bangla error line. */
    suspend fun requestAdvance(amount: Int, purpose: String, method: String, number: String): String? {
        if (amount <= 0) return "সঠিক একটি অঙ্ক দিন।"
        val trimmedNumber = number.trim()
        if (trimmedNumber.isEmpty()) return "টাকা কোথায় পাঠাবেন সেই নম্বর দিন।"
        if (advSaving) return null
        advSaving = true
        notice = null
        try {
            val body = JSONObject()
                .put("amount", amount)
                .put("payout_method", method)
                .put("payout_number", trimmedNumber)
            val trimmedPurpose = purpose.trim()
            if (trimmedPurpose.isNotEmpty()) body.put("purpose", trimmedPurpose)
            val resp = AlmaApi.send("POST", "/api/finance/office-advance", body)
            if (resp.flexBool("ok") == false) return resp.str("message") ?: "আবেদন পাঠানো যায়নি।"
            notice = resp.str("message") ?: "আবেদন পাঠানো হয়েছে।"
            loadAdvances()      // web: await loadAdvances()
            return null
        } catch (e: Exception) {
            return failureMessage(e, "আবেদন পাঠানো যায়নি।")
        } finally {
            advSaving = false
        }
    }

    /** PATCH /api/finance/office-advance { advance_id, spent, leftover_method } —
     *  হিসাব দেওয়া (reconcile an OUTSTANDING advance). Returns null on success. */
    suspend fun reconcile(advance: OfAdvanceRow, spent: Int, leftoverMethod: String): String? {
        if (spent < 0) return "সঠিক খরচের অঙ্ক দিন।"
        if (spent > advance.amount) return "খরচ অ্যাডভান্সের চেয়ে বেশি হতে পারে না।"
        if (recSaving) return null
        recSaving = true
        notice = null
        try {
            val leftover = advance.amount - spent
            val body = JSONObject()
                .put("advance_id", advance.id)
                .put("spent", spent)
                // Web parity: no leftover → method forced to CASH_RETURN.
                .put("leftover_method", if (leftover > 0) leftoverMethod else "CASH_RETURN")
            val resp = AlmaApi.send("PATCH", "/api/finance/office-advance", body)
            if (resp.flexBool("ok") == false) return resp.str("message") ?: "হিসাব পাঠানো যায়নি।"
            notice = resp.str("message") ?: "হিসাব পাঠানো হয়েছে।"
            loadAdvances()      // web: await loadAdvances()
            return null
        } catch (e: Exception) {
            return failureMessage(e, "হিসাব পাঠানো যায়নি।")
        } finally {
            recSaving = false
        }
    }

    /** apiFailure answers 4xx with `{ ok:false, message: <Bangla> }` — surface that
     *  exact server message when it's there, else the caller's fallback. */
    private fun failureMessage(e: Exception, fallback: String): String {
        if (e is AlmaApiException.NotAuthenticated) {
            authExpired = true
            return "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন।"
        }
        if (e is AlmaApiException.Http) {
            // Http keeps the body inside its message ("Server error 400: {…}").
            val raw = e.message?.substringAfter(": ", "") ?: ""
            try {
                val msg = JSONObject(raw).str("message")
                if (!msg.isNullOrEmpty()) return msg
            } catch (_: Exception) { }
        }
        return fallback
    }
}

// ── Screen (full action parity — টপ-আপ / আবেদন / হিসাব all native) ──────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfficeFundScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { OfficeFundState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<OfLedgerRow?>(null) }
    var flowFilter by remember { mutableStateOf("ALL") }   // ALL | IN | OUT (client-side)
    var showTopUp by remember { mutableStateOf(false) }
    var showAdvance by remember { mutableStateOf(false) }
    var reconciling by remember { mutableStateOf<OfAdvanceRow?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    val filteredLedger = when (flowFilter) {
        "IN" -> vm.ledger.filter { it.isPositive }
        "OUT" -> vm.ledger.filter { !it.isPositive }
        else -> vm.ledger
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { OfAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        if (vm.adminOnly) {
            item { OfAdminOnlyCard(dark) }
        }
        vm.error?.let { item { OfNoticeCard(it, OfPalette.red500, dark) } }
        vm.notice?.let { item { OfNoticeCard(it, OfPalette.positive(dark), dark) } }

        if (!vm.adminOnly) {
            item { OfBalanceHero(vm, dark) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OfKpiCard(
                        "মোট যোগ হয়েছে", vm.summary?.totalIn ?: 0, "↓",
                        OfPalette.positive(dark), dark, Modifier.weight(1f),
                    )
                    OfKpiCard(
                        "মোট বের হয়েছে", vm.summary?.totalOut ?: 0, "↑",
                        OfPalette.red500, dark, Modifier.weight(1f),
                    )
                }
            }
            item { OfActionsCard(vm, dark, onTopUp = { showTopUp = true }, onAdvance = { showAdvance = true }) }
            item { OfAdvancesCard(vm, dark, onReconcile = { reconciling = it }) }
            item {
                OfLedgerCard(
                    vm, dark, filteredLedger, flowFilter,
                    onFilter = { flowFilter = it },
                    onSelect = { selected = it },
                )
            }
            item {
                Text(
                    "🌐 ওয়েব ভার্সন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/finance/office-fund", "Office fund") }
                        .padding(vertical = 4.dp),
                )
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { row ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            OfTxnDetailSheet(row, dark) {
                selected = null
                ctx.openWebForced("/finance/office-fund", "Office fund")
            }
        }
    }

    if (showTopUp) {
        ModalBottomSheet(onDismissRequest = { if (!vm.topUpSaving) showTopUp = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfTopUpSheet(vm, dark, scope) { showTopUp = false }
        }
    }

    if (showAdvance) {
        ModalBottomSheet(onDismissRequest = { if (!vm.advSaving) showAdvance = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfAdvanceSheet(vm, dark, scope) { showAdvance = false }
        }
    }

    reconciling?.let { adv ->
        ModalBottomSheet(onDismissRequest = { if (!vm.recSaving) reconciling = null }, containerColor = AlmaTheme.rootBg(dark)) {
            OfReconcileSheet(vm, adv, dark, scope) { reconciling = null }
        }
    }
}

// ── Balance hero (the board's DARK bento anchor — dark in BOTH themes) ──────────────

@Composable
private fun OfBalanceHero(vm: OfficeFundState, dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(OfPalette.heroBase)
            .background(Brush.linearGradient(listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent)))
            .background(Brush.linearGradient(listOf(Color.Transparent, OfPalette.coral.copy(alpha = 0.30f))))
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("৳", color = OfPalette.goldLt, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "ফান্ড ব্যালেন্স",
                color = Color.White.copy(alpha = 0.62f), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
        if (vm.loading && vm.summary == null) {
            Box(Modifier.fillMaxWidth().height(44.dp))
        } else {
            Text(
                OfFormat.taka(vm.summary?.balance ?: 0),
                color = OfPalette.green400, fontSize = 40.sp, fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
        Text(
            "অফিসের চলতি ফান্ড (পেটি ক্যাশ) · ALMA Lifestyle",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
        )
    }
}

@Composable
private fun OfKpiCard(label: String, value: Int, glyph: String, tint: Color, dark: Boolean, modifier: Modifier) {
    Row(
        modifier.almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.size(26.dp).background(tint.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text(glyph, color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold) }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                AlmaTheme.takaShort(value),
                color = tint, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        }
    }
}

// ── Actions card (web টপ-আপ + অ্যাডভান্স form cards, promoted to sheets) ─────────────

@Composable
private fun OfActionsCard(vm: OfficeFundState, dark: Boolean, onTopUp: () -> Unit, onAdvance: () -> Unit) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 4.dp)) {
        if (vm.canTopUp) {
            OfActionRow(
                glyph = "＋",
                title = "ফান্ডে টাকা যোগ করুন",
                sub = "শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন।",
                busy = vm.topUpSaving, dark = dark, onClick = onTopUp,
            )
            Box(Modifier.fillMaxWidth().height(0.5.dp).background(AlmaTheme.separator(dark)))
        }
        OfActionRow(
            glyph = "↗",
            title = "অফিস অ্যাডভান্স নিন",
            sub = "অফিসের কাজে ফান্ড থেকে টাকা নিন — মালিক অনুমোদন করলে পাঠাবেন।",
            busy = vm.advSaving, dark = dark, onClick = onAdvance,
        )
    }
}

@Composable
private fun OfActionRow(glyph: String, title: String, sub: String, busy: Boolean, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().plainClick { if (!busy) onClick() }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(glyph, color = OfPalette.accentText(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
        if (busy) {
            CircularProgressIndicator(Modifier.size(14.dp), color = OfPalette.coral, strokeWidth = 2.dp)
        } else {
            Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// ── My office advances (web "আমার অ্যাডভান্সসমূহ" card) ──────────────────────────────

@Composable
private fun OfAdvancesCard(vm: OfficeFundState, dark: Boolean, onReconcile: (OfAdvanceRow) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row {
            Text("আমার অ্যাডভান্সসমূহ", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (vm.outstandingCount > 0) {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text("বকেয়া হিসাব", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    Text(
                        OfFormat.taka(vm.outstandingTotal),
                        color = OfPalette.red500, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "${vm.outstandingCount} টি অ্যাডভান্স",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                }
            }
        }
        if (vm.advLoading && vm.advances.isEmpty()) {
            repeat(2) { Box(Modifier.fillMaxWidth().height(48.dp).almaGlass(dark, AlmaTheme.R_CONTROL)) }
        } else if (vm.advances.isEmpty()) {
            Text(
                "কোনো অ্যাডভান্স নেই",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp),
            )
        } else {
            vm.advances.forEach { adv ->
                OfAdvanceRowView(adv, vm, dark, onReconcile)
            }
        }
    }
}

@Composable
private fun OfAdvanceRowView(adv: OfAdvanceRow, vm: OfficeFundState, dark: Boolean, onReconcile: (OfAdvanceRow) -> Unit) {
    val tone = adv.statusColor(dark)
    Row(
        Modifier
            .fillMaxWidth()
            .background(tone.copy(alpha = if (dark) 0.07f else 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, tone.copy(alpha = 0.22f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                adv.purpose?.takeIf { it.isNotEmpty() } ?: "অফিস অ্যাডভান্স",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                ofAdvanceMeta(adv),
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                OfFormat.taka(adv.amount),
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
            )
            Text(
                adv.statusBn,
                color = tone, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(tone.copy(alpha = 0.12f), CircleShape)
                    .border(0.8.dp, tone.copy(alpha = 0.3f), CircleShape)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
            // Web parity: OUTSTANDING rows carry the "হিসাব দিন" button.
            if (adv.status == "OUTSTANDING") {
                if (vm.recSaving) {
                    CircularProgressIndicator(Modifier.size(12.dp), color = OfPalette.coral, strokeWidth = 2.dp)
                } else {
                    Text(
                        "হিসাব দিন",
                        color = OfPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(OfPalette.coral.copy(alpha = if (dark) 0.24f else 0.14f), CircleShape)
                            .border(0.8.dp, OfPalette.coral.copy(alpha = 0.45f), CircleShape)
                            .plainClick { onReconcile(adv) }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
    }
    Spacer(Modifier.height(2.dp))
}

private fun ofAdvanceMeta(adv: OfAdvanceRow): String {
    val bits = mutableListOf<String>()
    OfFormat.dateTime(adv.createdAt)?.let(bits::add)
    adv.payoutMethod?.let { m ->
        bits.add(adv.payoutNumber?.let { "$m $it" } ?: m)
    }
    if (adv.status == "SETTLED") {
        adv.spentAmount?.let { bits.add("খরচ ${OfFormat.taka(it)}") }
    }
    return bits.joinToString(" · ")
}

// ── Recent ledger (web "সাম্প্রতিক লেনদেন" card + native flow chips) ─────────────────

@Composable
private fun OfLedgerCard(
    vm: OfficeFundState,
    dark: Boolean,
    filtered: List<OfLedgerRow>,
    flowFilter: String,
    onFilter: (String) -> Unit,
    onSelect: (OfLedgerRow) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সাম্প্রতিক লেনদেন", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OfChip("সব", flowFilter == "ALL", dark) { onFilter("ALL") }
            OfChip("যোগ", flowFilter == "IN", dark) { onFilter("IN") }
            OfChip("বাদ", flowFilter == "OUT", dark) { onFilter("OUT") }
        }
        if (vm.loading && vm.ledger.isEmpty()) {
            repeat(4) { Box(Modifier.fillMaxWidth().height(46.dp).almaGlass(dark, AlmaTheme.R_CONTROL)) }
        } else if (filtered.isEmpty()) {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("🗂", fontSize = 20.sp)
                Text("এখনো কোনো লেনদেন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        } else {
            filtered.forEach { row ->
                OfLedgerRowView(row, dark) { onSelect(row) }
            }
        }
    }
}

@Composable
private fun OfLedgerRowView(row: OfLedgerRow, dark: Boolean, onTap: () -> Unit) {
    val tint = if (row.isPositive) OfPalette.positive(dark) else OfPalette.red500
    Row(
        Modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = if (dark) 0.06f else 0.04f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, Color.White.copy(alpha = if (dark) 0.10f else 0.45f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .plainClick(onTap)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(28.dp).background(tint.copy(alpha = 0.14f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(if (row.isPositive) "↓" else "↑", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(row.labelBn, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text(
                ofLedgerMeta(row),
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            "${if (row.isPositive) "+" else "−"}${OfFormat.taka(row.amount)}",
            color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold,
        )
    }
    Spacer(Modifier.height(2.dp))
}

private fun ofLedgerMeta(row: OfLedgerRow): String {
    val bits = mutableListOf<String>()
    OfFormat.dateTime(row.createdAt)?.let(bits::add)
    row.createdByName?.takeIf { it.isNotEmpty() }?.let(bits::add)
    row.note?.takeIf { it.isNotEmpty() }?.let(bits::add)
    return if (bits.isEmpty()) "—" else bits.joinToString(" · ")
}

// ── Transaction detail sheet ───────────────────────────────────────────────────────

@Composable
private fun OfTxnDetailSheet(row: OfLedgerRow, dark: Boolean, openWeb: () -> Unit) {
    val tint = if (row.isPositive) OfPalette.positive(dark) else OfPalette.red500
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.size(28.dp).background(tint.copy(alpha = 0.14f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Text(if (row.isPositive) "↓" else "↑", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold) }
                Text(row.labelBn, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                "${if (row.isPositive) "+" else "−"}${OfFormat.taka(row.amount)}",
                color = tint, fontSize = 34.sp, fontWeight = FontWeight.Bold,
            )
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OfInfoRow("সময়", OfFormat.dateTime(row.createdAt) ?: "—", dark)
            OfInfoRow("যিনি করেছেন", row.createdByName ?: "—", dark)
            OfInfoRow("নোট", row.note?.takeIf { it.isNotEmpty() } ?: "—", dark)
            row.refType?.let { refType ->
                OfInfoRow("রেফারেন্স", row.refId?.let { "$refType · $it" } ?: refType, dark)
            }
        }
        Text(
            "🌐 ওয়েব ভার্সন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick(openWeb).padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun OfInfoRow(label: String, value: String, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Top-up sheet (POST /api/finance/office-fund { amount, note? }) ──────────────────

@Composable
private fun OfTopUpSheet(
    vm: OfficeFundState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onDone: () -> Unit,
) {
    var amount by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    val amountInt = ofParseTaka(amount)

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("ফান্ডে টাকা যোগ করুন", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন। (আপনি নিজে বিকাশ/ক্যাশে রেখে এখানে রেকর্ড করবেন।)",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        OfField("টাকার অঙ্ক (৳)", dark) {
            OutlinedTextField(
                value = amount, onValueChange = { amount = it },
                placeholder = { Text("যেমন 10000") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OfField("নোট (ঐচ্ছিক)", dark) {
            OutlinedTextField(
                value = note, onValueChange = { note = it },
                placeholder = { Text("যেমন জুনের পেটি ক্যাশ") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        localError?.let {
            Text(it, color = OfPalette.red500, fontSize = 11.sp)
        }
        OfSubmitButton("যোগ করুন", busy = vm.topUpSaving, disabled = amountInt <= 0) {
            localError = null
            confirming = true
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("৳${String.format("%,d", amountInt)} ফান্ডে যোগ হবে — নিশ্চিত?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        val err = vm.topUp(amountInt, note)
                        if (err != null) localError = err else onDone()
                    }
                }) { Text("হ্যাঁ, ৳${String.format("%,d", amountInt)} যোগ করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

// ── Advance request sheet (POST /api/finance/office-advance) ────────────────────────

@Composable
private fun OfAdvanceSheet(
    vm: OfficeFundState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onDone: () -> Unit,
) {
    var amount by remember { mutableStateOf("") }
    var purpose by remember { mutableStateOf("") }
    var method by remember { mutableStateOf(OF_PAYOUT_METHODS[0]) }
    var number by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    var methodOpen by remember { mutableStateOf(false) }
    val amountInt = ofParseTaka(amount)
    val numberTrimmed = number.trim()

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("অফিস অ্যাডভান্স নিন", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "অফিসের কাজে ফান্ড থেকে টাকা নিন — মালিক অনুমোদন করলে আপনার নম্বরে পাঠাবেন।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        OfField("টাকার অঙ্ক (৳)", dark) {
            OutlinedTextField(
                value = amount, onValueChange = { amount = it },
                placeholder = { Text("যেমন 2000") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OfField("কী কাজে", dark) {
            OutlinedTextField(
                value = purpose, onValueChange = { purpose = it },
                placeholder = { Text("যেমন প্যাকেজিং সামগ্রী কেনা") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        OfField("কোথায় পাঠাবে", dark) {
            Box {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { methodOpen = true }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(method, color = AlmaTheme.ink(dark), fontSize = 14.sp)
                    Spacer(Modifier.weight(1f))
                    Text("⌄", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                }
                DropdownMenu(expanded = methodOpen, onDismissRequest = { methodOpen = false }) {
                    OF_PAYOUT_METHODS.forEach { m ->
                        DropdownMenuItem(
                            text = { Text(if (m == method) "✓ $m" else m) },
                            onClick = { method = m; methodOpen = false },
                        )
                    }
                }
            }
        }
        OfField("বিকাশ/ওয়ালেট নম্বর", dark) {
            OutlinedTextField(
                value = number, onValueChange = { number = it },
                placeholder = { Text("01XXXXXXXXX") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            "অনুমোদনের পর টাকা আপনার দায়িত্বে থাকবে — খরচ শেষে হিসাব দিতে হবে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        localError?.let {
            Text(it, color = OfPalette.red500, fontSize = 11.sp)
        }
        OfSubmitButton("আবেদন পাঠান", busy = vm.advSaving, disabled = amountInt <= 0 || numberTrimmed.isEmpty()) {
            localError = null
            confirming = true
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("৳${String.format("%,d", amountInt)} অ্যাডভান্সের আবেদন যাবে ($method $numberTrimmed) — নিশ্চিত?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        val err = vm.requestAdvance(amountInt, purpose, method, numberTrimmed)
                        if (err != null) localError = err else onDone()
                    }
                }) { Text("হ্যাঁ, আবেদন পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

// ── Reconcile sheet (PATCH /api/finance/office-advance) ─────────────────────────────

@Composable
private fun OfReconcileSheet(
    vm: OfficeFundState,
    advance: OfAdvanceRow,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onDone: () -> Unit,
) {
    var spent by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("CASH_RETURN") }   // CASH_RETURN | WALLET_DEDUCT
    var confirming by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    val spentInt = ofParseTaka(spent)
    /** Web leftoverPreview = max(0, amount − spent). */
    val leftover = maxOf(0, advance.amount - spentInt)
    val methodBn = if (method == "WALLET_DEDUCT") "আমার ওয়ালেট থেকে কাটা হবে" else "ক্যাশ ফেরত দেব"

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("হিসাব দিন", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "${advance.purpose?.takeIf { it.isNotEmpty() } ?: "অফিস অ্যাডভান্স"} · ${OfFormat.taka(advance.amount)}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Text(
            "কত টাকা খরচ হয়েছে লিখুন — বাকি টাকা কীভাবে ফেরত দেবেন তা বেছে নিন। (দুটোই মালিকের অনুমোদন লাগবে।)",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
        OfField("খরচ হয়েছে (৳)", dark) {
            OutlinedTextField(
                value = spent, onValueChange = { spent = it },
                placeholder = { Text("সর্বোচ্চ ${advance.amount}") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("বাকি থাকবে:", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            Text(OfFormat.taka(leftover), color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        if (leftover > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OfChip("ক্যাশ ফেরত দেব", method == "CASH_RETURN", dark) { method = "CASH_RETURN" }
                OfChip("আমার ওয়ালেট থেকে কাটুন", method == "WALLET_DEDUCT", dark) { method = "WALLET_DEDUCT" }
            }
        }
        localError?.let {
            Text(it, color = OfPalette.red500, fontSize = 11.sp)
        }
        OfSubmitButton("হিসাব পাঠান", busy = vm.recSaving, disabled = spentInt > advance.amount) {
            localError = null
            if (spentInt > advance.amount) {
                localError = "খরচ অ্যাডভান্সের চেয়ে বেশি হতে পারে না।"
            } else {
                confirming = true
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = {
                Text(
                    if (leftover > 0)
                        "খরচ ৳${String.format("%,d", spentInt)}, বাকি ৳${String.format("%,d", leftover)} ($methodBn) — হিসাব পাঠাবেন?"
                    else
                        "খরচ ৳${String.format("%,d", spentInt)}, কিছু বাকি নেই — হিসাব পাঠাবেন?",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        val err = vm.reconcile(advance, spentInt, method)
                        if (err != null) localError = err else onDone()
                    }
                }) { Text("হ্যাঁ, হিসাব পাঠান") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun OfField(label: String, dark: Boolean, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
        )
        content()
    }
}

@Composable
private fun OfSubmitButton(title: String, busy: Boolean, disabled: Boolean, onClick: () -> Unit) {
    if (busy) {
        Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(18.dp), color = OfPalette.coral, strokeWidth = 2.dp)
        }
    } else {
        Text(
            title,
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    if (disabled) OfPalette.coral.copy(alpha = 0.4f) else OfPalette.coral,
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (!disabled) onClick() }
                .padding(vertical = 11.dp),
        )
    }
}

@Composable
private fun OfChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) OfPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 12.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) OfPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) OfPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun OfNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun OfAdminOnlyCard(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("🔒", fontSize = 28.sp)
        Text(
            "অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp,
        )
    }
}

@Composable
private fun OfAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(OfPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}
