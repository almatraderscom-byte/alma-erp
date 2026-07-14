//
//  PortalExpenseScreen.kt
//  ALMA ERP — the staff /portal/expense page ("নিজ খরচ ফেরত"), ported 1:1 from
//  PortalExpenseSwiftUI.swift (build 66).
//
//  Same endpoints, same colours, same blocks as the web page:
//    GET  /api/finance/reimbursement?business_id=…   → own claims + pendingTotal
//    POST /api/finance/reimbursement                 {business_id, amount, category, vendor?, note?}
//  Blocks: 2 summary cards (অপেক্ষমাণ amber / অনুমোদিত emerald + wallet link) · native
//  submit sheet (amount / category chips / vendor / note, confirm step) · "আমার আবেদনসমূহ"
//  history with Bangla status pills (PENDING amber · APPROVED emerald · REJECTED red) ·
//  add-only footnote · web escape hatch.
//  Receipt/photo attachment stays a WEB ESCAPE (file picker + data URL) — same as iOS.
//  Response is unwrapped for both {ok,claims,pendingTotal} flat and {ok,data:{…}} shapes.
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
import androidx.compose.ui.text.style.TextDecoration
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

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object PortalExpensePalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)

    /** Web StatusPill: PENDING amber · APPROVED emerald · REJECTED red. */
    fun status(s: String): Color = when (s) {
        "PENDING" -> amber500
        "APPROVED" -> emerald600
        else -> red500
    }

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Model (same field names the web ClaimRow declares) ─────────────────────────────

private data class PortalExpenseClaim(
    val id: String,
    val amount: Int,
    val category: String,
    val note: String?,
    val expenseDate: String?,
    val hasReceipt: Boolean,
    val status: String,
    val createdAt: String?,
) {
    /** Web StatusPill labels, verbatim. */
    val statusLabel: String
        get() = when (status) {
            "PENDING" -> "অপেক্ষমাণ"
            "APPROVED" -> "অনুমোদিত"
            "REJECTED" -> "প্রত্যাখ্যাত"
            else -> status
        }

    companion object {
        fun from(o: JSONObject): PortalExpenseClaim = PortalExpenseClaim(
            id = o.str("id") ?: "",
            amount = o.flexInt("amount") ?: 0,
            category = o.str("category") ?: "Reimbursement",
            note = o.str("note"),
            expenseDate = o.str("expenseDate"),
            hasReceipt = o.optBoolean("hasReceipt", false),
            status = o.str("status") ?: "PENDING",
            createdAt = o.str("createdAt"),
        )
    }
}

// ── State holder (iOS PortalExpenseVM twin) ────────────────────────────────────────

private const val EXPENSE_BUSINESS_ID = "ALMA_LIFESTYLE"

/** One not-yet-submitted expense in the batch basket (owner concept: staff adds
 *  many at once, then submits together — one approval per item server-side). */
private data class ReimburseDraft(
    val amount: Int,
    val category: String,
    val vendor: String,
    val note: String,
    val expenseDate: String,
    val receiptAttachmentId: String?,
)

private class PortalExpenseState {
    var claims by mutableStateOf(listOf<PortalExpenseClaim>())
    var pendingTotal by mutableStateOf(0)
    var loading by mutableStateOf(false)
    var submitting by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)     // success line (the web's toast)
    var authExpired by mutableStateOf(false)
    var drafts by mutableStateOf(listOf<ReimburseDraft>())

    /** Web: approvedTotal = sum of APPROVED claim amounts (already in the wallet). */
    val approvedTotal: Int
        get() = claims.filter { it.status == "APPROVED" }.sumOf { it.amount }

    /** apiDataSuccess wraps payloads → {ok, data:{…}} — unwrap both shapes. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/finance/reimbursement", mapOf("business_id" to EXPENSE_BUSINESS_ID)))
            claims = c.optJSONArray("claims")?.mapObjects { PortalExpenseClaim.from(it) } ?: emptyList()
            pendingTotal = c.flexInt("pendingTotal") ?: 0
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = "আপনার আবেদনগুলো লোড করা যায়নি।"
        } finally {
            loading = false
        }
    }

    /** Upload a receipt photo (multipart) → returns the attachment id to reference in
     *  the claim. Native replacement for the web file picker. */
    suspend fun uploadReceipt(picked: PickedImage): String? {
        return try {
            val resp = AlmaApi.uploadMultipart(
                "/api/finance/receipts",
                listOf(picked.toFilePart("file")),
                mapOf("business_id" to EXPENSE_BUSINESS_ID),
            )
            val data = resp.optJSONObject("data") ?: resp
            // /api/finance/receipts returns {ok, attachment:{id,…}} — read that first.
            data.optJSONObject("attachment")?.str("id")
                ?: data.str("id")
                ?: resp.str("id")
        } catch (_: Exception) {
            null
        }
    }

    /** POST every basket item in ONE request (items[]) — each becomes its own
     *  approval server-side, so the owner decides each expense independently. */
    suspend fun submitAll(): Boolean {
        if (submitting || drafts.isEmpty()) return false
        submitting = true
        notice = null
        try {
            val items = org.json.JSONArray()
            drafts.forEach { d ->
                val item = JSONObject()
                    .put("amount", d.amount)
                    .put("category", d.category)
                    .put("expense_date", d.expenseDate)
                d.vendor.trim().takeIf { it.isNotEmpty() }?.let { item.put("vendor", it) }
                d.note.trim().takeIf { it.isNotEmpty() }?.let { item.put("note", it) }
                d.receiptAttachmentId?.takeIf { it.isNotEmpty() }?.let { item.put("receipt_attachment_id", it) }
                items.put(item)
            }
            val body = JSONObject()
                .put("business_id", EXPENSE_BUSINESS_ID)
                .put("items", items)

            val resp = AlmaApi.send("POST", "/api/finance/reimbursement", body)
            val data = resp.optJSONObject("data") ?: resp
            notice = data.str("message") ?: "ফেরতের আবেদন পাঠানো হয়েছে।"
            drafts = emptyList()
            load()
            return true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            return false
        } catch (e: AlmaApiException.Http) {
            error = serverMessage(e) ?: "আবেদন পাঠানো যায়নি।"
            return false
        } catch (e: Exception) {
            error = "আবেদন পাঠানো যায়নি।"
            return false
        } finally {
            submitting = false
        }
    }

    /** Pull the server's Bangla message out of an apiFailure body (iOS serverMessage twin). */
    private fun serverMessage(e: AlmaApiException.Http): String? {
        val raw = e.message ?: return null
        val idx = raw.indexOf(": ")
        if (idx < 0) return null
        return try {
            val o = JSONObject(raw.substring(idx + 2))
            o.optJSONObject("error")?.str("message")?.takeIf { it.isNotEmpty() }
                ?: o.str("message")?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortalExpenseScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { PortalExpenseState() }
    val scope = rememberCoroutineScope()
    var showSubmit by remember { mutableStateOf(false) }
    var confirmSubmitAll by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { ExpenseHeader(dark) }
        if (vm.authExpired) {
            item { ExpenseAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { ExpenseNoticeCard("⚠️ $it", PortalExpensePalette.red500, dark) } }
        vm.notice?.let { item { ExpenseNoticeCard("✓ $it", PortalExpensePalette.emerald600, dark) } }
        item { ExpenseSummaryCards(vm, dark) { ctx.openSmart("/portal", "My Desk") } }
        item { ExpenseNewClaimButton(dark) { showSubmit = true } }
        if (vm.drafts.isNotEmpty()) {
            item {
                ExpenseBasketCard(vm, dark,
                    onRemove = { i -> vm.drafts = vm.drafts.filterIndexed { idx, _ -> idx != i } },
                    onSubmitAll = { confirmSubmitAll = true },
                )
            }
        }
        item { ExpenseHistoryCard(vm, dark) }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    if (showSubmit) {
        ModalBottomSheet(onDismissRequest = { showSubmit = false }, containerColor = AlmaTheme.rootBg(dark)) {
            PortalExpenseSubmitSheet(
                vm.submitting, dark,
                onUploadReceipt = { picked -> vm.uploadReceipt(picked) },
            ) { amount, category, vendor, note, receiptId, expenseDate ->
                vm.drafts = vm.drafts + ReimburseDraft(amount, category, vendor, note, expenseDate, receiptId)
                showSubmit = false
            }
        }
    }

    if (confirmSubmitAll) {
        val total = vm.drafts.sumOf { it.amount }
        AlertDialog(
            onDismissRequest = { confirmSubmitAll = false },
            title = { Text("${vm.drafts.size}টি খরচ · মোট ${PortalExpenseFormat.money(total)}") },
            text = { Text("সবগুলো একসাথে মালিকের Approval Center-এ যাবে — প্রতিটা আলাদা আলাদা অনুমোদন হবে। পাঠানোর পর সম্পাদনা করা যাবে না।") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSubmitAll = false
                    scope.launch { vm.submitAll() }
                }) { Text("হ্যাঁ, একসাথে জমা দিন") }
            },
            dismissButton = { TextButton(onClick = { confirmSubmitAll = false }) { Text("বাতিল") } },
        )
    }
}

// ── Batch basket (owner concept: many expenses → one submit) ────────────────────────

@Composable
private fun ExpenseBasketCard(
    vm: PortalExpenseState,
    dark: Boolean,
    onRemove: (Int) -> Unit,
    onSubmitAll: () -> Unit,
) {
    val total = vm.drafts.sumOf { it.amount }
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .border(1.dp, PortalExpensePalette.coral.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("জমা দেওয়ার তালিকা (${vm.drafts.size}টি)", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        vm.drafts.forEachIndexed { i, d ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        "${PortalExpenseFormat.money(d.amount)} · ${d.category}",
                        color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        d.expenseDate +
                            (if (d.vendor.isNotEmpty()) " · ${d.vendor}" else "") +
                            (if (d.receiptAttachmentId != null) " · 📎 রসিদ" else ""),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    "✕",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    modifier = Modifier
                        .background(AlmaTheme.fill(dark), CircleShape)
                        .plainClick { onRemove(i) }
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
            if (i < vm.drafts.size - 1) HorizontalDivider(color = AlmaTheme.separator(dark))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .background(PortalExpensePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick { if (!vm.submitting) onSubmitAll() }
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (vm.submitting) {
                CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(
                "একসাথে জমা দিন (${vm.drafts.size}টি · ${PortalExpenseFormat.money(total)})",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            "সব খরচ একসাথে মালিকের Approval Center-এ যাবে।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ── Header (web FinancePageChrome title/subtitle) ──────────────────────────────────

@Composable
private fun ExpenseHeader(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("নিজ খরচ ফেরত", color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "নিজের পকেট থেকে অফিসের খরচ করেছেন? এখানে ফেরতের আবেদন করুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
    }
}

// ── Summary cards (web: অপেক্ষমাণ amber / অনুমোদিত emerald + wallet link) ─────────────

@Composable
private fun ExpenseSummaryCards(vm: PortalExpenseState, dark: Boolean, onWallet: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ExpenseWashCard(
            Modifier.weight(1f), PortalExpensePalette.amber500, dark,
        ) {
            Text(
                "অপেক্ষমাণ".uppercase(),
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            )
            Text(
                PortalExpenseFormat.money(vm.pendingTotal),
                color = PortalExpensePalette.amber500, fontSize = 17.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text("মালিকের অনুমোদনের অপেক্ষায়", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        }
        ExpenseWashCard(
            Modifier.weight(1f), PortalExpensePalette.emerald600, dark,
        ) {
            Text(
                "অনুমোদিত (ওয়ালেটে যুক্ত)".uppercase(),
                color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                PortalExpenseFormat.money(vm.approvedTotal),
                color = PortalExpensePalette.emerald600, fontSize = 17.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                "আমার ওয়ালেট দেখুন →",
                color = PortalExpensePalette.accentText(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.plainClick(onWallet),
            )
        }
    }
}

/** Soft accent-wash card (iOS LinearGradient wash + glass). */
@Composable
private fun ExpenseWashCard(modifier: Modifier, accent: Color, dark: Boolean, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        modifier
            .almaGlass(dark, AlmaTheme.R_CONTROL)
            .background(
                Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                shape,
            )
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) { content() }
}

// ── New claim entry point (opens the native submit sheet) ──────────────────────────

@Composable
private fun ExpenseNewClaimButton(dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(PortalExpensePalette.coral.copy(alpha = if (dark) 0.22f else 0.12f), CircleShape)
            .border(1.dp, PortalExpensePalette.coral.copy(alpha = 0.45f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("＋ খরচ যোগ করুন", color = PortalExpensePalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── History ("আমার আবেদনসমূহ") ─────────────────────────────────────────────────────

@Composable
private fun ExpenseHistoryCard(vm: PortalExpenseState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("আমার আবেদনসমূহ", color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
        when {
            vm.loading && vm.claims.isEmpty() -> {
                repeat(3) { Box(Modifier.fillMaxWidth().height(56.dp).almaGlass(dark, AlmaTheme.R_CONTROL)) }
            }
            vm.claims.isEmpty() && !vm.authExpired -> {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 26.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("📥", fontSize = 26.sp)
                    Text("কোনো আবেদন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text("আপনি এখনো কোনো ফেরতের আবেদন করেননি।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                }
            }
            else -> {
                vm.claims.forEachIndexed { index, claim ->
                    ExpenseClaimRow(claim, dark)
                    if (index < vm.claims.size - 1) HorizontalDivider(color = AlmaTheme.separator(dark))
                }
            }
        }
        HorizontalDivider(color = AlmaTheme.separator(dark))
        Text(
            "শুধু যোগ করা যায় — পাঠানো আবেদন সম্পাদনা বা মুছে ফেলা যায় না (নিরাপত্তার জন্য)।",
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp,
        )
    }
}

/** One web claim row: category · note · date | amount · pill. */
@Composable
private fun ExpenseClaimRow(claim: PortalExpenseClaim, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                claim.category + (if (claim.hasReceipt) " 📎" else ""),
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            claim.note?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(
                (claim.expenseDate?.let { "খরচ: $it · " } ?: "") + (PortalExpenseFormat.dateTime(claim.createdAt) ?: ""),
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                PortalExpenseFormat.money(claim.amount),
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            ExpenseStatusPill(claim, dark)
        }
    }
}

/** Web StatusPill parity — tinted capsule, Bangla label. */
@Composable
private fun ExpenseStatusPill(claim: PortalExpenseClaim, dark: Boolean) {
    val color = PortalExpensePalette.status(claim.status)
    Text(
        claim.statusLabel,
        color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(color.copy(alpha = 0.10f), CircleShape)
            .border(1.dp, color.copy(alpha = 0.25f), CircleShape)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

// ── Shared cards ───────────────────────────────────────────────────────────────────

@Composable
private fun ExpenseNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun ExpenseAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(PortalExpensePalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Submit sheet (web "নতুন আবেদন" card → native form + confirm step) ────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PortalExpenseSubmitSheet(
    submitting: Boolean,
    dark: Boolean,
    onUploadReceipt: suspend (PickedImage) -> String?,
    onAddToBasket: (amount: Int, category: String, vendor: String, note: String, receiptAttachmentId: String?, expenseDate: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var receiptId by remember { mutableStateOf<String?>(null) }
    var uploadingReceipt by remember { mutableStateOf(false) }
    fun onPicked(p: PickedImage?) {
        if (p == null) return
        scope.launch {
            uploadingReceipt = true
            receiptId = onUploadReceipt(p)
            uploadingReceipt = false
        }
    }
    val pickReceiptGallery = rememberGalleryPick(onResult = ::onPicked)
    val pickReceiptCamera = rememberCameraPick(onResult = ::onPicked)
    // Web CATEGORY_OPTIONS, verbatim.
    val categories = listOf(
        "যাতায়াত / কুরিয়ার",
        "অফিস সামগ্রী",
        "খাবার / আপ্যায়ন",
        "মেরামত",
        "অন্যান্য",
    )
    var amount by remember { mutableStateOf("") }
    var category by remember { mutableStateOf(categories[0]) }
    var vendor by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var expenseDate by remember { mutableStateOf(PortalExpenseFormat.today()) }
    var showDatePicker by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }

    val parsedAmount = amount.filter { it.isDigit() }.toIntOrNull() ?: 0

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("খরচ যোগ করুন", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        localError?.let { Text("⚠️ $it", color = PortalExpensePalette.red500, fontSize = 12.sp) }

        ExpenseFieldLabel("টাকার অঙ্ক *", dark)
        OutlinedTextField(
            value = amount,
            onValueChange = { amount = it.filter { ch -> ch.isDigit() } },
            placeholder = { Text("যেমন: 500") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        ExpenseFieldLabel("খরচের তারিখ *", dark)
        Text(
            "📅 $expenseDate",
            color = AlmaTheme.ink(dark), fontSize = 13.sp,
            modifier = Modifier
                .fillMaxWidth()
                .almaGlass(dark, AlmaTheme.R_CONTROL)
                .plainClick { showDatePicker = true }
                .padding(horizontal = 13.dp, vertical = 11.dp),
        )

        ExpenseFieldLabel("খরচের ধরন", dark)
        ExpenseCategoryChips(categories, category, dark) { category = it }

        ExpenseFieldLabel("কোথায় খরচ (ঐচ্ছিক)", dark)
        OutlinedTextField(
            value = vendor,
            onValueChange = { vendor = it },
            placeholder = { Text("দোকান / প্রতিষ্ঠানের নাম") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        ExpenseFieldLabel("নোট (ঐচ্ছিক)", dark)
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            placeholder = { Text("সংক্ষিপ্ত বিবরণ") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )

        // ── Native receipt / photo attach (camera or gallery → multipart upload) ──
        ExpenseFieldLabel("রসিদ / ছবি (ঐচ্ছিক)", dark)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Text(
                when {
                    uploadingReceipt -> "আপলোড হচ্ছে…"
                    receiptId != null -> "✓ রসিদ যুক্ত হয়েছে"
                    else -> "📷 ক্যামেরা"
                },
                color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
                    .background(if (receiptId != null) PortalExpensePalette.emerald600 else PortalExpensePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { if (!uploadingReceipt) pickReceiptCamera() }
                    .padding(vertical = 10.dp),
            )
            Text(
                "🖼️ গ্যালারি",
                color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
                    .background(PortalExpensePalette.coral.copy(alpha = 0.85f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick { if (!uploadingReceipt) pickReceiptGallery() }
                    .padding(vertical = 10.dp),
            )
        }

        Text("যোগ করলে তালিকায় জমবে — এখনই পাঠানো হবে না। একসাথে যতগুলো দরকার যোগ করুন।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)

        Row(
            Modifier
                .fillMaxWidth()
                .background(PortalExpensePalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .plainClick {
                    if (parsedAmount <= 0) {
                        localError = "সঠিক একটি টাকার অঙ্ক দিন।"
                    } else if (uploadingReceipt) {
                        localError = "রসিদ আপলোড শেষ হওয়া পর্যন্ত অপেক্ষা করুন।"
                    } else if (!submitting) {
                        localError = null
                        onAddToBasket(parsedAmount, category, vendor, note, receiptId, expenseDate)
                    }
                }
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("＋ তালিকায় যোগ করুন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    if (showDatePicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = PortalExpenseFormat.ymdMillis(expenseDate))
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { expenseDate = PortalExpenseFormat.ymdFromMillis(it) }
                    showDatePicker = false
                }) { Text("ঠিক আছে") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("বাতিল") } },
        ) {
            DatePicker(state = state, title = { Text("খরচের তারিখ", modifier = Modifier.padding(16.dp)) })
        }
    }
}

@Composable
private fun ExpenseFieldLabel(text: String, dark: Boolean) {
    Text(text, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
}

/** Web <select> re-set as native capsule chips — one tap, no dropdown (2 per row). */
@Composable
private fun ExpenseCategoryChips(items: List<String>, selected: String, dark: Boolean, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { item ->
                    val active = item == selected
                    Text(
                        item,
                        color = if (active) PortalExpensePalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
                        fontSize = 12.sp,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier
                            .background(
                                if (active) PortalExpensePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                                CircleShape,
                            )
                            .border(
                                1.dp,
                                if (active) PortalExpensePalette.coral.copy(alpha = 0.55f)
                                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                                CircleShape,
                            )
                            .plainClick { onPick(item) }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                    )
                }
            }
        }
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object PortalExpenseFormat {
    /** Web <Money>: whole-taka with ৳ sign and thousand separators. */
    fun money(amount: Int): String = "৳" + String.format(Locale.US, "%,d", amount)

    private val ymd = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

    /** Today in Asia/Dhaka as YYYY-MM-DD (web todayYmd twin). */
    fun today(): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date())
    }

    fun ymdMillis(raw: String): Long = try { ymd.parse(raw)!!.time } catch (_: Exception) { Date().time }
    fun ymdFromMillis(ms: Long): String = ymd.format(Date(ms))

    /** Web fmtDate: Asia/Dhaka, "5 Jul, 8:50 PM" style. */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("d MMM, h:mm a", Locale.US)
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
