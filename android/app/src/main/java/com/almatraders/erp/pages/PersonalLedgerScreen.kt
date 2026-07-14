//
//  PersonalLedgerScreen.kt
//  ALMA ERP — owner personal পাওনা-দেনা khata (/finance/personal-ledger) as a native
//  Compose screen. Twin of the web page; iOS twin = PersonalLedgerSwiftUI.swift
//  (written, not yet wired).
//
//  SUPER_ADMIN only (the API enforces; non-owners get a Bangla forbidden card).
//  Same endpoint + semantics as web:
//    GET  /api/finance/personal-ledger              → parties + totals
//    GET  /api/finance/personal-ledger?party_id=…   → party + serial txns (oldest→newest)
//    POST /api/finance/personal-ledger {op: create_party|add_txn|edit_txn|delete_txn, …}
//  Direction: OUT = টাকা দিলাম (they owe more) · IN = টাকা নিলাম (they owe less).
//  Net > 0 আমি পাব (emerald) · net < 0 আমি দেব (red) · 0 নিষ্পত্তি. Running balance is
//  recomputed client-side per row, exactly like the web detailRows memo.
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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

// ── Palette (web tokens) ────────────────────────────────────────────────────────────

private object LedgerPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val emerald600 = Color(0xFF059669)
    val emerald400 = Color(0xFF34D399)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
    fun emerald(dark: Boolean): Color = if (dark) emerald400 else emerald600

    /** net > 0 emerald (আমি পাব) · net < 0 red (আমি দেব) · 0 muted. */
    fun net(net: Int, dark: Boolean): Color =
        if (net > 0) emerald(dark) else if (net < 0) red500 else AlmaTheme.inkSecondary(dark)
}

// ── Models (web field names) ────────────────────────────────────────────────────────

private data class LedgerParty(
    val id: String,
    val name: String,
    val net: Int,
    val txnCount: Int,
    val lastTxnDate: String?,
) {
    companion object {
        fun from(o: JSONObject) = LedgerParty(
            id = o.str("id") ?: "",
            name = o.str("name") ?: "—",
            net = o.flexInt("net") ?: 0,
            txnCount = o.flexInt("txnCount") ?: 0,
            lastTxnDate = o.str("lastTxnDate"),
        )
    }
}

private data class LedgerTxn(
    val id: String,
    val direction: String, // OUT | IN
    val amount: Int,
    val reason: String,
    val txnDate: String,
    val edited: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = LedgerTxn(
            id = o.str("id") ?: "",
            direction = o.str("direction") ?: "OUT",
            amount = o.flexInt("amount") ?: 0,
            reason = o.str("reason") ?: "",
            txnDate = o.str("txnDate") ?: "",
            edited = o.optBoolean("edited", false),
        )
    }
}

private data class LedgerDetail(
    val id: String,
    val name: String,
    val net: Int,
    val txns: List<LedgerTxn>,
)

// ── State ───────────────────────────────────────────────────────────────────────────

private class LedgerState {
    var parties by mutableStateOf(listOf<LedgerParty>())
    var totalRecv by mutableStateOf(0)
    var totalPay by mutableStateOf(0)
    var netTotal by mutableStateOf(0)
    var detail by mutableStateOf<LedgerDetail?>(null)
    var loading by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var forbidden by mutableStateOf(false)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun loadList() {
        loading = true
        error = null
        try {
            val d = unwrap(AlmaApi.getObject("/api/finance/personal-ledger"))
            parties = d.optJSONArray("parties")?.mapObjects { LedgerParty.from(it) } ?: emptyList()
            totalRecv = d.flexInt("totalReceivable") ?: 0
            totalPay = d.flexInt("totalPayable") ?: 0
            netTotal = d.flexInt("net") ?: 0
            authExpired = false
            forbidden = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            // API 403 (not owner) also lands here via AlmaApi — show the owner-only card.
            forbidden = true
        } catch (e: Exception) {
            error = "খাতা লোড করা যায়নি।"
        } finally {
            loading = false
        }
    }

    suspend fun openParty(id: String) {
        loading = true
        try {
            val d = unwrap(AlmaApi.getObject("/api/finance/personal-ledger", mapOf("party_id" to id)))
            val p = d.optJSONObject("party") ?: return
            detail = LedgerDetail(
                id = p.str("id") ?: id,
                name = p.str("name") ?: "—",
                net = p.flexInt("net") ?: 0,
                txns = p.optJSONArray("txns")?.mapObjects { LedgerTxn.from(it) } ?: emptyList(),
            )
        } catch (e: Exception) {
            error = "খাতাটি লোড করা যায়নি।"
        } finally {
            loading = false
        }
    }

    /** One POST for every write op — web parity body. Returns true on success. */
    suspend fun post(body: JSONObject): Boolean {
        if (busy) return false
        busy = true
        notice = null
        return try {
            val resp = AlmaApi.send("POST", "/api/finance/personal-ledger", body)
            val data = resp.optJSONObject("data") ?: resp
            notice = data.str("message") ?: "সংরক্ষণ হয়েছে।"
            true
        } catch (e: AlmaApiException.NotAuthenticated) {
            forbidden = true
            false
        } catch (e: Exception) {
            error = "সংরক্ষণ করা যায়নি।"
            false
        } finally {
            busy = false
        }
    }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonalLedgerScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { LedgerState() }
    val scope = rememberCoroutineScope()

    var filter by remember { mutableStateOf("all") } // all | recv | pay | settled
    var showNewParty by remember { mutableStateOf(false) }
    var showAddTxn by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<LedgerTxn?>(null) }
    var deleting by remember { mutableStateOf<LedgerTxn?>(null) }

    LaunchedEffect(Unit) { vm.loadList() }

    val detail = vm.detail

    AlmaPullRefresh(
        refreshing = vm.loading,
        onRefresh = { scope.launch { if (detail != null) vm.openParty(detail.id) else vm.loadList() } },
        dark = dark,
    ) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (vm.forbidden) {
                item { LedgerHeader(dark, detail = null) }
                item {
                    LedgerCenterCard("🔒", "শুধু মালিকের জন্য", "এই খাতা শুধু Super Admin দেখতে পারেন — একবার লগইন করে দেখুন।", dark) {
                        ctx.openSmart("/login", "Login")
                    }
                }
                return@LazyColumn
            }

            item { LedgerHeader(dark, detail) }
            vm.error?.let { item { LedgerNotice("⚠️ $it", LedgerPalette.red500, dark) } }
            vm.notice?.let { item { LedgerNotice("✓ $it", LedgerPalette.emerald(dark), dark) } }

            if (detail == null) {
                // ── Party list ──
                item { LedgerTotalsRow(vm, dark) }
                item { LedgerFilterChips(filter, dark) { filter = it } }
                item {
                    val rows = when (filter) {
                        "recv" -> vm.parties.filter { it.net > 0 }
                        "pay" -> vm.parties.filter { it.net < 0 }
                        "settled" -> vm.parties.filter { it.net == 0 }
                        else -> vm.parties
                    }
                    LedgerPartyListCard(rows, vm, dark) { scope.launch { vm.openParty(it.id) } }
                }
                item { LedgerPrimaryButton("＋ নতুন ব্যক্তি / প্রতিষ্ঠান", dark) { showNewParty = true } }
            } else {
                // ── Party detail (খতিয়ান) ──
                item {
                    Text(
                        "‹ পাওনা-দেনা তালিকায় ফিরুন",
                        color = LedgerPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.plainClick {
                            vm.detail = null
                            scope.launch { vm.loadList() }
                        },
                    )
                }
                item { LedgerHeroCard(detail, dark) }
                item {
                    LedgerTimelineCard(detail, dark, onEdit = { editing = it })
                }
                item { LedgerPrimaryButton("＋ নতুন লেনদেন", dark) { showAddTxn = true } }
                if (detail.net != 0) {
                    item {
                        Text(
                            if (detail.net > 0)
                                "টিপ: পুরো টাকা ফেরত পেলে \"টাকা নিলাম\"-এ সেই অঙ্ক লিখুন — খাতা নিজেই নিষ্পত্তি দেখাবে।"
                            else
                                "টিপ: পুরো টাকা দিয়ে দিলে \"টাকা দিলাম\"-এ লিখুন — খাতা নিষ্পত্তি হবে।",
                            color = AlmaTheme.inkTertiary(dark), fontSize = 10.sp, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            item { Spacer(Modifier.height(8.dp)) }
        }
    }

    // ── Sheets ──
    if (showNewParty) {
        ModalBottomSheet(onDismissRequest = { showNewParty = false }, containerColor = AlmaTheme.rootBg(dark)) {
            LedgerTxnForm(
                title = "নতুন ব্যক্তি / প্রতিষ্ঠান",
                dark = dark, busy = vm.busy,
                askName = true,
            ) { name, direction, amount, reason, date ->
                scope.launch {
                    val ok = vm.post(
                        JSONObject()
                            .put("op", "create_party")
                            .put("name", name)
                            .put("direction", direction)
                            .put("amount", amount)
                            .put("reason", reason)
                            .put("txn_date", date),
                    )
                    if (ok) {
                        showNewParty = false
                        vm.loadList()
                    }
                }
            }
        }
    }

    if (showAddTxn && detail != null) {
        ModalBottomSheet(onDismissRequest = { showAddTxn = false }, containerColor = AlmaTheme.rootBg(dark)) {
            LedgerTxnForm(
                title = "${detail.name} — নতুন লেনদেন",
                dark = dark, busy = vm.busy,
                askName = false,
            ) { _, direction, amount, reason, date ->
                scope.launch {
                    val ok = vm.post(
                        JSONObject()
                            .put("op", "add_txn")
                            .put("party_id", detail.id)
                            .put("direction", direction)
                            .put("amount", amount)
                            .put("reason", reason)
                            .put("txn_date", date),
                    )
                    if (ok) {
                        showAddTxn = false
                        vm.openParty(detail.id)
                    }
                }
            }
        }
    }

    editing?.let { txn ->
        ModalBottomSheet(onDismissRequest = { editing = null }, containerColor = AlmaTheme.rootBg(dark)) {
            LedgerTxnForm(
                title = "লেনদেন অ্যাডজাস্ট (+/−)",
                dark = dark, busy = vm.busy,
                askName = false,
                initialDirection = txn.direction,
                initialAmount = txn.amount.toString(),
                initialReason = txn.reason,
                initialDate = txn.txnDate,
                onDelete = { editing = null; deleting = txn },
            ) { _, direction, amount, reason, date ->
                scope.launch {
                    val ok = vm.post(
                        JSONObject()
                            .put("op", "edit_txn")
                            .put("txn_id", txn.id)
                            .put("direction", direction)
                            .put("amount", amount)
                            .put("reason", reason)
                            .put("txn_date", date),
                    )
                    if (ok) {
                        editing = null
                        detail?.let { vm.openParty(it.id) }
                    }
                }
            }
        }
    }

    deleting?.let { txn ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("লেনদেন মুছবেন?") },
            text = { Text("${if (txn.direction == "OUT") "টাকা দিলাম" else "টাকা নিলাম"} · ${LedgerFormat.money(txn.amount)} · ${txn.reason} — মুছে ফেললে ব্যালেন্স নতুন করে হিসাব হবে (রেকর্ড অডিটে থেকে যায়)।") },
            confirmButton = {
                TextButton(onClick = {
                    val t = txn
                    deleting = null
                    scope.launch {
                        val ok = vm.post(JSONObject().put("op", "delete_txn").put("txn_id", t.id))
                        if (ok) detail?.let { vm.openParty(it.id) }
                    }
                }) { Text("হ্যাঁ, মুছুন", color = LedgerPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("বাতিল") } },
        )
    }
}

// ── Header ──────────────────────────────────────────────────────────────────────────

@Composable
private fun LedgerHeader(dark: Boolean, detail: LedgerDetail?) {
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(detail?.name ?: "পাওনা-দেনা", color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            if (detail == null) "আপনার ব্যক্তিগত লেনদেন — স্টাফ নয়, বাইরের ব্যক্তি/প্রতিষ্ঠান"
            else "লেনদেনের খতিয়ান · পুরোনো থেকে নতুন · ✎ চেপে +/− অ্যাডজাস্ট",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
    }
}

// ── Totals ──────────────────────────────────────────────────────────────────────────

@Composable
private fun LedgerTotalsRow(vm: LedgerState, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LedgerStatCard(Modifier.weight(1f), "মোট পাওনা", vm.totalRecv, LedgerPalette.emerald(dark), dark)
        LedgerStatCard(Modifier.weight(1f), "মোট দেনা", vm.totalPay, LedgerPalette.red500, dark)
        LedgerStatCard(Modifier.weight(1f), "নিট", kotlin.math.abs(vm.netTotal), LedgerPalette.net(vm.netTotal, dark), dark, negative = vm.netTotal < 0)
    }
}

@Composable
private fun LedgerStatCard(modifier: Modifier, label: String, amount: Int, tint: Color, dark: Boolean, negative: Boolean = false) {
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .background(
                Brush.linearGradient(listOf(tint.copy(alpha = if (dark) 0.13f else 0.09f), Color.Transparent)),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .padding(11.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            (if (negative) "−" else "") + LedgerFormat.money(amount),
            color = tint, fontSize = 15.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

// ── Filters ─────────────────────────────────────────────────────────────────────────

@Composable
private fun LedgerFilterChips(active: String, dark: Boolean, onPick: (String) -> Unit) {
    val options = listOf("all" to "সব", "recv" to "পাওনা", "pay" to "দেনা", "settled" to "নিষ্পত্তি")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (key, label) ->
            val isActive = key == active
            Text(
                label,
                color = if (isActive) Color.White else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .background(
                        if (isActive) LedgerPalette.coral else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                        CircleShape,
                    )
                    .border(1.dp, if (isActive) LedgerPalette.coral else Color.White.copy(alpha = if (dark) 0.10f else 0.4f), CircleShape)
                    .plainClick { onPick(key) }
                    .padding(horizontal = 14.dp, vertical = 7.dp),
            )
        }
    }
}

// ── Party list ──────────────────────────────────────────────────────────────────────

@Composable
private fun LedgerPartyListCard(rows: List<LedgerParty>, vm: LedgerState, dark: Boolean, onOpen: (LedgerParty) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("খাতা · ${vm.parties.size} জন", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        when {
            vm.loading && vm.parties.isEmpty() ->
                repeat(3) { Box(Modifier.fillMaxWidth().height(56.dp).almaGlass(dark, AlmaTheme.R_CONTROL)) }
            rows.isEmpty() -> Column(
                Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("📭", fontSize = 26.sp)
                Text("এই ফিল্টারে কেউ নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            else -> rows.forEachIndexed { i, p ->
                LedgerPartyRow(p, dark) { onOpen(p) }
                if (i < rows.size - 1) HorizontalDivider(color = AlmaTheme.separator(dark))
            }
        }
    }
}

@Composable
private fun LedgerPartyRow(p: LedgerParty, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().plainClick(onClick).padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(p.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${p.txnCount}টি লেনদেন · শেষ: ${LedgerFormat.day(p.lastTxnDate) ?: "—"}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                (if (p.net < 0) "−" else "") + LedgerFormat.money(kotlin.math.abs(p.net)),
                color = LedgerPalette.net(p.net, dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            LedgerNetPill(p.net, dark)
        }
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 16.sp)
    }
}

@Composable
private fun LedgerNetPill(net: Int, dark: Boolean) {
    val color = LedgerPalette.net(net, dark)
    Text(
        if (net > 0) "আমি পাব" else if (net < 0) "আমি দেব" else "নিষ্পত্তি",
        color = color, fontSize = 9.5.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(color.copy(alpha = 0.10f), CircleShape)
            .border(1.dp, color.copy(alpha = 0.25f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 2.5.dp),
    )
}

// ── Detail hero + timeline ──────────────────────────────────────────────────────────

@Composable
private fun LedgerHeroCard(detail: LedgerDetail, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            (if (detail.net < 0) "−" else "") + LedgerFormat.money(kotlin.math.abs(detail.net)),
            color = LedgerPalette.net(detail.net, dark), fontSize = 26.sp, fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            if (detail.net > 0) "সে আমাকে দেবে (আমি পাব)"
            else if (detail.net < 0) "আমি তাকে দেব (আমার দেনা)"
            else "হিসাব নিষ্পত্তি ✓",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
    }
}

@Composable
private fun LedgerTimelineCard(detail: LedgerDetail, dark: Boolean, onEdit: (LedgerTxn) -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "লেনদেনের খতিয়ান · ${detail.txns.size}টি",
            color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
        )
        if (detail.txns.isEmpty()) {
            Text("কোনো লেনদেন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        } else {
            var run = 0
            detail.txns.forEachIndexed { i, t ->
                run += if (t.direction == "OUT") t.amount else -t.amount
                LedgerTxnRow(t, run, dark) { onEdit(t) }
                if (i < detail.txns.size - 1) HorizontalDivider(color = AlmaTheme.separator(dark))
            }
        }
    }
}

@Composable
private fun LedgerTxnRow(t: LedgerTxn, run: Int, dark: Boolean, onEdit: () -> Unit) {
    val out = t.direction == "OUT"
    Row(
        Modifier.fillMaxWidth().padding(vertical = 9.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            if (out) "↑" else "↓",
            color = if (out) LedgerPalette.red500 else LedgerPalette.emerald(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier
                .background((if (out) LedgerPalette.red500 else LedgerPalette.emerald(dark)).copy(alpha = 0.12f), CircleShape)
                .padding(horizontal = 9.dp, vertical = 4.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                "${if (out) "টাকা দিলাম" else "টাকা নিলাম"} · ${t.reason}" + (if (t.edited) " (অ্যাডজাস্ট করা)" else ""),
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(LedgerFormat.day(t.txnDate) ?: t.txnDate, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            Text(
                "ব্যালেন্স: ${if (run < 0) "−" else ""}${LedgerFormat.money(kotlin.math.abs(run))} " +
                    (if (run > 0) "আমি পাব" else if (run < 0) "আমি দেব" else "— নিষ্পত্তি"),
                color = AlmaTheme.inkTertiary(dark), fontSize = 9.5.sp,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "${if (out) "−" else "+"}${LedgerFormat.money(t.amount)}",
                color = if (out) LedgerPalette.red500 else LedgerPalette.emerald(dark),
                fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
            )
            Text(
                "✎",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                modifier = Modifier
                    .background(AlmaTheme.fill(dark), CircleShape)
                    .plainClick(onEdit)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun LedgerPrimaryButton(label: String, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(LedgerPalette.coral.copy(alpha = if (dark) 0.22f else 0.12f), CircleShape)
            .border(1.dp, LedgerPalette.coral.copy(alpha = 0.45f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(label, color = LedgerPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun LedgerNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun LedgerCenterCard(emoji: String, title: String, hint: String, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onTap).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(emoji, fontSize = 26.sp)
        Text(title, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(hint, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center)
    }
}

// ── Add/edit form sheet (shared by create_party / add_txn / edit_txn) ───────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LedgerTxnForm(
    title: String,
    dark: Boolean,
    busy: Boolean,
    askName: Boolean,
    initialDirection: String = "OUT",
    initialAmount: String = "",
    initialReason: String = "",
    initialDate: String = LedgerFormat.today(),
    onDelete: (() -> Unit)? = null,
    onSubmit: (name: String, direction: String, amount: Int, reason: String, date: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var direction by remember { mutableStateOf(initialDirection) }
    var amount by remember { mutableStateOf(initialAmount) }
    var reason by remember { mutableStateOf(initialReason) }
    var date by remember { mutableStateOf(initialDate) }
    var showPicker by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    val parsedAmount = amount.filter { it.isDigit() }.toIntOrNull() ?: 0

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        localError?.let { Text("⚠️ $it", color = LedgerPalette.red500, fontSize = 12.sp) }

        if (askName) {
            LedgerFieldLabel("নাম *", dark)
            OutlinedTextField(
                value = name, onValueChange = { name = it },
                placeholder = { Text("যেমন: করিম ট্রেডার্স") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
        }

        LedgerFieldLabel("ধরন *", dark)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LedgerDirectionChip("টাকা দিলাম", direction == "OUT", LedgerPalette.red500, dark, Modifier.weight(1f)) { direction = "OUT" }
            LedgerDirectionChip("টাকা নিলাম", direction == "IN", LedgerPalette.emerald(dark), dark, Modifier.weight(1f)) { direction = "IN" }
        }

        LedgerFieldLabel("পরিমাণ (৳) *", dark)
        OutlinedTextField(
            value = amount,
            onValueChange = { amount = it.filter { ch -> ch.isDigit() } },
            placeholder = { Text("যেমন: 4000") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        LedgerFieldLabel("কারণ *", dark)
        OutlinedTextField(
            value = reason, onValueChange = { reason = it },
            placeholder = { Text("যেমন: ধার দিলাম / ধার নিলাম") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )

        LedgerFieldLabel("তারিখ *", dark)
        Text(
            "📅 ${LedgerFormat.day(date) ?: date}",
            color = AlmaTheme.ink(dark), fontSize = 13.sp,
            modifier = Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CONTROL)
                .plainClick { showPicker = true }
                .padding(horizontal = 13.dp, vertical = 11.dp),
        )

        Row(
            Modifier
                .fillMaxWidth()
                .background(LedgerPalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick {
                    when {
                        askName && name.trim().isEmpty() -> localError = "নাম দিন।"
                        parsedAmount <= 0 -> localError = "সঠিক একটি টাকার অঙ্ক দিন।"
                        reason.trim().isEmpty() -> localError = "কারণ লিখুন।"
                        busy -> Unit
                        else -> {
                            localError = null
                            onSubmit(name.trim(), direction, parsedAmount, reason.trim(), date)
                        }
                    }
                }
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text("সংরক্ষণ করুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }

        onDelete?.let {
            Text(
                "এই লেনদেনটি মুছে ফেলুন",
                color = LedgerPalette.red500, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(LedgerPalette.red500.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick(it)
                    .padding(vertical = 11.dp),
            )
        }
    }

    if (showPicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = LedgerFormat.millis(date))
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { date = LedgerFormat.fromMillis(it) }
                    showPicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showPicker = false }) { Text("বাতিল") } },
        ) {
            DatePicker(state = state, title = { Text("তারিখ বাছাই করুন", modifier = Modifier.padding(16.dp)) })
        }
    }
}

@Composable
private fun LedgerFieldLabel(text: String, dark: Boolean) {
    Text(text, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun LedgerDirectionChip(label: String, active: Boolean, tint: Color, dark: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) tint else AlmaTheme.inkSecondary(dark),
        fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
        modifier = modifier
            .background(
                if (active) tint.copy(alpha = 0.14f) else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .border(
                1.dp,
                if (active) tint.copy(alpha = 0.5f) else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
            )
            .plainClick(onClick)
            .padding(vertical = 10.dp),
    )
}

// ── Formatting ──────────────────────────────────────────────────────────────────────

private object LedgerFormat {
    fun money(amount: Int): String = "৳" + String.format(Locale.US, "%,d", amount)

    private val ymd = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    private val display = SimpleDateFormat("d MMM, yyyy", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

    fun today(): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date())
    }

    fun day(raw: String?): String? {
        if (raw.isNullOrEmpty()) return null
        return try { display.format(ymd.parse(raw)!!) } catch (_: Exception) { raw }
    }

    fun millis(raw: String): Long =
        try { ymd.parse(raw)!!.time } catch (_: Exception) { Date().time }

    fun fromMillis(ms: Long): String = ymd.format(Date(ms))
}
