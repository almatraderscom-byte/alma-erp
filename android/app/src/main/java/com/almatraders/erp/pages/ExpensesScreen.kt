//
//  ExpensesScreen.kt
//  ALMA ERP — the Expenses page, ported 1:1 from ExpensesSwiftUI.swift (web /expenses parity).
//
//  Same endpoint, same numbers, same blocks as the iOS screen:
//    GET  /api/finance?business_id=ALMA_LIFESTYLE&startDate=…&endDate=…
//         → { total_expenses, cash_balance, by_category, expenses[] }
//    POST /api/finance {title, category, amount, payment_status, payment_method,
//         notes, recurring, date, business_id}
//         → SUPER_ADMIN: saved directly · anyone else: routed to the approval center
//           ({ pending_approval, message } — Bangla message verbatim).
//  Blocks: date-window chips · KPI bento board (dark hero: Total expenses + Ledger cash;
//  2 glass tiles: Line items / Active categories) · Expense mix donut (web PALETTE hexes) ·
//  Highest categories · category filter chips · ledger row cards · add-expense sheet.
//  Money is whole-taka BDT (AlmaTheme.taka/takaShort), dates Asia/Dhaka. Receipt upload +
//  PDF/CSV/Excel exports stay on the web escape hatch (multipart + FileProvider infra).
//

package com.almatraders.erp.pages

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.CreditCard
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
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
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS ExpensePalette) ──

private object ExpensePalette {
    val coral = AlmaTheme.coral               // web --c-accent  #E07A5F
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** Web donut PALETTE verbatim: E07A5F,C45A3C,F4A28C,B84A30,8B3A24,D4694F,6B2A18. */
    val donut = listOf(
        coral, goldDim, goldLt,
        Color(0xFFB84A30), Color(0xFF8B3A24), Color(0xFFD4694F), Color(0xFF6B2A18),
    )

    /** Web accent-tinted text: gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

/** The dark hero anchor base — iOS Color(0.094, 0.082, 0.157) = #181528. */
private val EXP_HERO_BASE = Color(0xFF181528)

private const val EXP_BUSINESS_ID = "ALMA_LIFESTYLE"

// ── Categories (src/lib/expense-categories.ts verbatim — same order) ─────────────────

private val EXPENSE_CATEGORIES = listOf(
    "office rent", "internet", "electricity", "salary", "marketing",
    "Facebook ads", "software", "courier", "transport", "equipment",
    "miscellaneous",
)

/** One Material icon per category (iOS SF-symbol twin). */
private fun expenseIcon(category: String): ImageVector = when (category.lowercase()) {
    "office rent" -> Icons.Filled.Home
    "internet" -> Icons.Filled.Wifi
    "electricity" -> Icons.Filled.Bolt
    "salary" -> Icons.Filled.Payments
    "marketing" -> Icons.Filled.Campaign
    "facebook ads" -> Icons.Filled.ThumbUp
    "software" -> Icons.Filled.Laptop
    "courier" -> Icons.Filled.LocalShipping
    "transport" -> Icons.Filled.DirectionsCar
    "equipment" -> Icons.Filled.Build
    else -> Icons.Filled.CreditCard
}

// ── Models (same field names ERPFinanceExpense declares) ─────────────────────────────

private data class ExpLedgerRow(
    val expId: String,
    val date: String,
    val category: String,
    val subCat: String?,
    val expType: String?,
    val title: String,
    val desc: String?,
    val vendor: String?,
    val amount: Int,
    val paymentMethod: String?,
    val paymentStatus: String?,
    val receiptRef: String?,
    val recurring: Boolean?,
    val notes: String?,
) {
    /** Web row key: exp_id + date + amount. */
    val rowKey: String get() = "$expId|$date|$amount"
}

private data class ExpCategoryAmount(val name: String, val amount: Int)

// ── Date window (the web's global date-range context, as native chips) ───────────────

private enum class ExpPreset(val label: String) {
    THIS_MONTH("This month"),
    TODAY("Today"),
    LAST7("Last 7 days"),
    LAST30("Last 30 days"),
    LAST_MONTH("Last month");

    /** (startDate, endDate) as yyyy-MM-dd in Asia/Dhaka — same params the web sends. */
    fun range(): Pair<String, String> {
        val tz = TimeZone.getTimeZone("Asia/Dhaka")
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = tz }
        val cal = Calendar.getInstance(tz)
        val today = fmt.format(cal.time)
        fun d() = fmt.format(cal.time)
        return when (this) {
            TODAY -> today to today
            LAST7 -> {
                cal.add(Calendar.DAY_OF_YEAR, -6); d() to today
            }
            LAST30 -> {
                cal.add(Calendar.DAY_OF_YEAR, -29); d() to today
            }
            THIS_MONTH -> {
                cal.set(Calendar.DAY_OF_MONTH, 1); d() to today
            }
            LAST_MONTH -> {
                cal.set(Calendar.DAY_OF_MONTH, 1)
                cal.add(Calendar.DAY_OF_YEAR, -1)          // prev month's last day
                val end = d()
                cal.set(Calendar.DAY_OF_MONTH, 1)          // prev month's first day
                d() to end
            }
        }
    }
}

// ── State holder (iOS ExpensesVM twin) ───────────────────────────────────────────────

private class ExpensesState {
    var expenses by mutableStateOf(listOf<ExpLedgerRow>())
    var totalExpenses by mutableStateOf(0)
    var cashBalance by mutableStateOf(0)
    var byCategory by mutableStateOf(listOf<ExpCategoryAmount>())   // sorted high → low
    var preset by mutableStateOf(ExpPreset.THIS_MONTH)
    var categoryFilter by mutableStateOf("ALL")
    var loading by mutableStateOf(false)
    var loaded by mutableStateOf(false)
    var saving by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val filtered: List<ExpLedgerRow>
        get() = if (categoryFilter == "ALL") expenses
        else expenses.filter { it.category == categoryFilter }

    /** Flat payload on the web, but tolerate an {ok,data:{…}} wrap too (iOS decoder parity). */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val (start, end) = preset.range()
            val r = unwrap(
                AlmaApi.getObject(
                    "/api/finance",
                    mapOf("business_id" to EXP_BUSINESS_ID, "startDate" to start, "endDate" to end),
                ),
            )
            totalExpenses = r.flexInt("total_expenses") ?: 0
            cashBalance = r.flexInt("cash_balance") ?: 0
            expenses = r.optJSONArray("expenses")?.mapObjects { m ->
                ExpLedgerRow(
                    expId = m.str("exp_id") ?: "",
                    date = m.str("date") ?: "",
                    category = m.str("category") ?: "—",
                    subCat = m.str("sub_cat"),
                    expType = m.str("exp_type"),
                    title = m.str("title") ?: "",
                    desc = m.str("desc"),
                    vendor = m.str("vendor"),
                    amount = m.flexInt("amount") ?: 0,
                    paymentMethod = m.str("payment_method"),
                    paymentStatus = m.str("payment_status"),
                    receiptRef = m.str("receipt_ref"),
                    recurring = m.flexBool("recurring"),
                    notes = m.str("notes"),
                )
            } ?: emptyList()
            val byCat = r.optJSONObject("by_category")
            byCategory = byCat?.let { obj ->
                obj.keys().asSequence().map { k ->
                    ExpCategoryAmount(k, obj.flexInt(k) ?: 0)
                }.sortedByDescending { it.amount }.toList()
            } ?: emptyList()
            if (categoryFilter != "ALL" && byCategory.none { it.name == categoryFilter }) {
                categoryFilter = "ALL"   // the window changed and the filter vanished
            }
            loaded = true
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** POST the same body the web form submits. SUPER_ADMIN saves directly; everyone else
     *  is routed to the approval center — surface the server's Bangla message verbatim. */
    suspend fun add(draft: ExpenseDraft): Boolean {
        val amount = draft.amount
        if (draft.category.isBlank() || amount == null || amount <= 0) {
            error = "Category and amount are required"   // web toast, verbatim
            return false
        }
        saving = true
        notice = null
        error = null
        try {
            val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }
            val body = JSONObject()
                .put("title", draft.title.trim())
                .put("category", draft.category)
                .put("amount", amount)
                .put("payment_status", draft.paymentStatus)
                .put("payment_method", draft.paymentMethod.trim())
                .put("notes", draft.notes.trim())
                .put("recurring", draft.recurring)
                .put("date", fmt.format(draft.date))
                .put("business_id", EXP_BUSINESS_ID)
            val resp = AlmaApi.send("POST", "/api/finance", body)
            notice = if (resp.flexBool("pending_approval") == true) {
                resp.str("message") ?: "খরচটি অনুমোদনের জন্য পাঠানো হয়েছে। অনুমোদন হলে যোগ হবে।"
            } else {
                "Expense recorded"                       // web toast, verbatim
            }
            load()
            return true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            return false
        } catch (e: Exception) {
            error = "Could not record expense. Please try again."   // web toast, verbatim
            return false
        } finally {
            saving = false
        }
    }
}

/** Native add-expense form state (web modal fields; receipt stays on the web). */
private class ExpenseDraft {
    var title by mutableStateOf("")
    var category by mutableStateOf("")
    var amountText by mutableStateOf("")
    var date by mutableStateOf(Calendar.getInstance(TimeZone.getTimeZone("Asia/Dhaka")).time)
    var paymentStatus by mutableStateOf("Paid")   // web options: Paid | Pending | Partial
    var paymentMethod by mutableStateOf("")
    var notes by mutableStateOf("")
    var recurring by mutableStateOf(false)

    val amount: Int?
        get() {
            val t = amountText.trim()
            return t.toIntOrNull() ?: t.toDoubleOrNull()?.let { Math.round(it).toInt() }
        }
    val valid: Boolean get() = category.isNotBlank() && (amount ?: 0) > 0
}

// ── Screen ────────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpensesScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { ExpensesState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<ExpLedgerRow?>(null) }
    var adding by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { ExpHeaderRow(dark) { adding = true } }
        item {
            // Date-window chips (web global range picker).
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ExpPreset.entries.forEach { p ->
                    ExpChip(p.label, vm.preset == p, dark) {
                        vm.preset = p
                        scope.launch { vm.load() }
                    }
                }
            }
        }
        if (vm.authExpired) {
            item { ExpAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
        }
        vm.error?.let { item { ExpNoticeCard("⚠️ $it", ExpensePalette.red500, dark) } }
        vm.notice?.let { item { ExpNoticeCard("✓ $it", ExpensePalette.emerald600, dark) } }

        item { ExpBentoHero(vm, dark) }
        item { ExpStatGrid(vm, dark) }

        if (vm.loading && !vm.loaded) {
            items(3) { Box(Modifier.fillMaxWidth().height(84.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        } else {
            if (vm.byCategory.isNotEmpty()) {
                item { ExpMixCard(vm.byCategory, vm.totalExpenses, dark) }
                item { ExpHighestCard(vm.byCategory, dark) }
            }
            item { ExpLedgerHeader(vm, dark) }
            if (vm.byCategory.isNotEmpty()) {
                item {
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ExpChip("All", vm.categoryFilter == "ALL", dark) { vm.categoryFilter = "ALL" }
                        vm.byCategory.forEach { cat ->
                            ExpChip(cat.name, vm.categoryFilter == cat.name, dark) {
                                vm.categoryFilter = if (vm.categoryFilter == cat.name) "ALL" else cat.name
                            }
                        }
                    }
                }
            }
            val maxRow = maxOf(1, vm.filtered.maxOfOrNull { it.amount } ?: 1)
            items(vm.filtered, key = { it.rowKey }) { row ->
                ExpRowCard(row, row.amount.toFloat() / maxRow, dark) { selected = row }
            }
            if (vm.filtered.isEmpty() && !vm.authExpired && vm.error == null) {
                item { ExpEmptyState(dark) }
            }
        }

        item {
            Text(
                "🌐 ওয়েব ভার্সন (Excel export · রিসিট)",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
                    .plainClick { ctx.openWebForced("/expenses", "Expenses") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    selected?.let { row ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            ExpDetailSheet(row, dark, openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) })
        }
    }
    if (adding) {
        ModalBottomSheet(onDismissRequest = { adding = false }, containerColor = AlmaTheme.rootBg(dark)) {
            ExpAddSheet(vm, dark, onClose = { adding = false })
        }
    }
}

@Composable
private fun ExpHeaderRow(dark: Boolean, onAdd: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text("Expenses", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text(
                "Operational spend · approvals · attachments",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }
        Row(
            Modifier
                .background(ExpensePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f), CircleShape)
                .border(1.dp, ExpensePalette.coral.copy(alpha = 0.55f), CircleShape)
                .plainClick(onAdd)
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                Icons.Filled.Add, contentDescription = null,
                tint = ExpensePalette.accentText(dark), modifier = Modifier.size(15.dp),
            )
            Text(
                "Add expense",
                color = ExpensePalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

// ── KPI bento board (dark hero anchor + 2 glass tiles — same numbers/tints as web) ────

@Composable
private fun ExpBentoHero(vm: ExpensesState, dark: Boolean) {
    val placeholders = vm.loading && !vm.loaded
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(EXP_HERO_BASE)
            .drawBehind {
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.32f), Color.Transparent),
                        start = Offset.Zero, end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(Color.Transparent, ExpensePalette.coral.copy(alpha = 0.30f)),
                        start = Offset(size.width * 0.5f, size.height * 0.5f),
                        end = Offset(size.width, size.height),
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.sage.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.05f), radius = 220.dp.toPx(),
                    ),
                )
            }
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape).padding(16.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "TOTAL EXPENSES (RANGE)",
                color = ExpensePalette.goldLt, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp,
            )
            Spacer(Modifier.weight(1f))
            Text(
                vm.preset.label,
                color = Color.White.copy(alpha = 0.55f), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            if (placeholders) "—" else AlmaTheme.takaShort(vm.totalExpenses),
            color = Color.White, fontSize = 36.sp, fontWeight = FontWeight.Black, maxLines = 1,
            modifier = Modifier.padding(top = 8.dp),
        )
        Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                "LEDGER CASH READOUT",
                color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 0.4.sp,
            )
            Text(
                if (placeholders) "—" else AlmaTheme.takaShort(vm.cashBalance),
                color = if (vm.cashBalance < 0) ExpensePalette.red500 else ExpensePalette.green400,
                fontSize = 19.sp, fontWeight = FontWeight.Black, maxLines = 1,
            )
        }
    }
}

@Composable
private fun ExpStatGrid(vm: ExpensesState, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ExpStatTile(
            "Line items", "${vm.expenses.size}", "Ledger rows in range",
            AlmaTheme.ink(dark), AlmaTheme.violet, dark, Modifier.weight(1f),
        )
        ExpStatTile(
            "Active categories", "${vm.byCategory.size}", "With spend in range",
            AlmaTheme.ink(dark), AlmaTheme.sage, dark, Modifier.weight(1f),
        )
    }
}

/** Small glass stat tile — value + sub line over a soft diagonal accent wash. */
@Composable
private fun ExpStatTile(
    label: String,
    value: String,
    sub: String,
    tint: Color,
    accent: Color,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        modifier.almaGlass(dark, AlmaTheme.R_CARD)
            .background(
                Brush.linearGradient(listOf(accent.copy(alpha = if (dark) 0.14f else 0.10f), Color.Transparent)),
                shape,
            )
            .padding(horizontal = 13.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label.uppercase(),
            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp, maxLines = 1,
        )
        Text(value, color = tint, fontSize = 17.sp, fontWeight = FontWeight.Black, maxLines = 1)
        Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, maxLines = 1)
    }
}

// ── Expense mix (web donut card, same palette) ───────────────────────────────────────

@Composable
private fun ExpMixCard(slices: List<ExpCategoryAmount>, total: Int, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Expense mix", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            ExpDonut(slices, total, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                slices.take(5).forEachIndexed { i, s ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(
                            Modifier.size(9.dp)
                                .background(ExpensePalette.donut[i % ExpensePalette.donut.size], RoundedCornerShape(2.dp)),
                        )
                        Text(s.name, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1, modifier = Modifier.weight(1f))
                        Text(
                            AlmaTheme.takaShort(s.amount),
                            color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                if (slices.size > 5) {
                    Text("+ ${slices.size - 5} more", color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp)
                }
            }
        }
    }
}

/** Native donut (web DonutChart parity — drawn arcs, ৳ total in the hole). */
@Composable
private fun ExpDonut(slices: List<ExpCategoryAmount>, total: Int, dark: Boolean) {
    val sum = maxOf(1, slices.sumOf { it.amount })
    Box(Modifier.size(124.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(124.dp)) {
            val stroke = 18.dp.toPx()
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            val topLeft = Offset(inset, inset)
            drawArc(
                color = Color.White.copy(alpha = if (dark) 0.10f else 0.06f),
                startAngle = 0f, sweepAngle = 360f, useCenter = false,
                topLeft = topLeft, size = arcSize, style = Stroke(width = stroke, cap = StrokeCap.Butt),
            )
            var cursor = -90f
            slices.forEachIndexed { i, s ->
                val sweep = s.amount.toFloat() / sum * 360f
                drawArc(
                    color = ExpensePalette.donut[i % ExpensePalette.donut.size],
                    startAngle = cursor, sweepAngle = sweep, useCenter = false,
                    topLeft = topLeft, size = arcSize, style = Stroke(width = stroke, cap = StrokeCap.Butt),
                )
                cursor += sweep
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                AlmaTheme.takaShort(total),
                color = ExpensePalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text("total", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}

/** Web "Highest categories": top 12, category left, ৳ amount right, gradient mini bar. */
@Composable
private fun ExpHighestCard(byCategory: List<ExpCategoryAmount>, dark: Boolean) {
    val top = byCategory.take(12)
    val maxAmt = maxOf(1, top.maxOfOrNull { it.amount } ?: 1)
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Highest categories", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        top.forEachIndexed { i, cat ->
            val color = ExpensePalette.donut[i % ExpensePalette.donut.size]
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(8.dp).background(color, CircleShape))
                    Text(cat.name, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
                    Spacer(Modifier.weight(1f))
                    Text(
                        "৳ ${grouped(cat.amount)}",
                        color = ExpensePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                ExpMiniBar(cat.amount.toFloat() / maxAmt, color, dark, 5.dp)
            }
        }
    }
}

/** Soft gradient mini progress bar. */
@Composable
private fun ExpMiniBar(fraction: Float, color: Color, dark: Boolean, height: androidx.compose.ui.unit.Dp = 4.dp) {
    Box(
        Modifier.fillMaxWidth().height(height)
            .background(Color.White.copy(alpha = if (dark) 0.10f else 0.06f), CircleShape),
    ) {
        Box(
            Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(height)
                .background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.55f), color)), CircleShape),
        )
    }
}

private fun grouped(a: Int): String = String.format("%,d", a)

// ── Ledger lines ──────────────────────────────────────────────────────────────────────

@Composable
private fun ExpLedgerHeader(vm: ExpensesState, dark: Boolean) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Ledger lines", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        Text(vm.preset.label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

@Composable
private fun ExpRowCard(row: ExpLedgerRow, fraction: Float, dark: Boolean, onTap: () -> Unit) {
    val paymentOpen = !row.paymentStatus.isNullOrEmpty() && row.paymentStatus != "Paid"
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onTap).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(34.dp)
                    .background(
                        Brush.linearGradient(listOf(ExpensePalette.coral, AlmaTheme.violet)),
                        RoundedCornerShape(10.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(expenseIcon(row.category), contentDescription = null, tint = Color.White, modifier = Modifier.size(15.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    row.title.ifEmpty { row.category },
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        row.date.take(10),
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                    Text(row.category, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1)
                    if (row.recurring == true) {
                        Icon(
                            Icons.Filled.Repeat, contentDescription = null,
                            tint = AlmaTheme.inkSecondary(dark), modifier = Modifier.size(10.dp),
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!row.receiptRef.isNullOrEmpty()) {
                        Text(
                            "Attachment",
                            color = ExpensePalette.green400, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(ExpensePalette.green400.copy(alpha = 0.10f), CircleShape)
                                .border(0.8.dp, ExpensePalette.green400.copy(alpha = 0.25f), CircleShape)
                                .padding(horizontal = 6.dp, vertical = 1.5.dp),
                        )
                    }
                    if (!row.paymentStatus.isNullOrEmpty()) {
                        Text(
                            row.paymentStatus,
                            color = if (row.paymentStatus == "Paid") AlmaTheme.inkSecondary(dark) else ExpensePalette.amber600,
                            fontSize = 9.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
            Text(
                "৳${grouped(row.amount)}",
                color = ExpensePalette.goldLt, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        ExpMiniBar(fraction, if (paymentOpen) ExpensePalette.amber500 else ExpensePalette.coral, dark, 4.dp)
    }
}

@Composable
private fun ExpEmptyState(dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 50.dp, bottom = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("◱", color = AlmaTheme.inkSecondary(dark), fontSize = 28.sp)
        Text("No expenses", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp)
        Text(
            "Relax filters or capture your first receipt",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
        )
    }
}

// ── Shared bits ───────────────────────────────────────────────────────────────────────

@Composable
private fun ExpChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) ExpensePalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) ExpensePalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) ExpensePalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun ExpNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun ExpAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(ExpensePalette.coral, CircleShape).plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Detail sheet ──────────────────────────────────────────────────────────────────────

@Composable
private fun ExpDetailSheet(row: ExpLedgerRow, dark: Boolean, openWeb: (String, String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(40.dp)
                    .background(Brush.linearGradient(listOf(ExpensePalette.coral, AlmaTheme.violet)), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(expenseIcon(row.category), contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.title.ifEmpty { row.category }, color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text("${row.category} · ${row.date.take(10)}", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        }
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ExpInfoRow("Amount", "৳${grouped(row.amount)}", ExpensePalette.accentText(dark), dark)
            ExpInfoRow("Status", row.paymentStatus ?: "—", AlmaTheme.ink(dark), dark)
            ExpInfoRow("Payment method", row.paymentMethod ?: "—", AlmaTheme.ink(dark), dark)
            if (!row.vendor.isNullOrEmpty()) ExpInfoRow("Vendor", row.vendor, AlmaTheme.ink(dark), dark)
            if (!row.expType.isNullOrEmpty()) ExpInfoRow("Type", row.expType, AlmaTheme.ink(dark), dark)
            if (!row.subCat.isNullOrEmpty()) ExpInfoRow("Sub-category", row.subCat, AlmaTheme.ink(dark), dark)
            if (row.recurring == true) ExpInfoRow("Recurring", "Yes", AlmaTheme.ink(dark), dark)
            if (!row.notes.isNullOrEmpty()) ExpInfoRow("Notes", row.notes, AlmaTheme.ink(dark), dark)
            if (!row.desc.isNullOrEmpty() && row.desc != row.notes) ExpInfoRow("Description", row.desc, AlmaTheme.ink(dark), dark)
            if (row.expId.isNotEmpty()) ExpInfoRow("Entry ID", row.expId, AlmaTheme.ink(dark), dark)
        }
        if (!row.receiptRef.isNullOrEmpty()) {
            Text(
                "রিসিট দেখুন (Attachment)",
                color = ExpensePalette.green400, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
                    .background(ExpensePalette.green400.copy(alpha = 0.10f), CircleShape)
                    .border(1.dp, ExpensePalette.green400.copy(alpha = 0.30f), CircleShape)
                    .plainClick {
                        val ref = row.receiptRef
                        openWeb(if (ref.startsWith("/")) ref else "/expenses", "Receipt")
                    }
                    .padding(vertical = 10.dp),
            )
        }
        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().plainClick { openWeb("/expenses", "Expenses") }.padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun ExpInfoRow(label: String, value: String, tint: Color, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Add-expense sheet (web "Add expense" modal — receipt upload stays on the web) ─────

@Composable
private fun ExpAddSheet(vm: ExpensesState, dark: Boolean, onClose: () -> Unit) {
    val draft = remember { ExpenseDraft() }
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf(false) }
    val dateLabel = remember {
        SimpleDateFormat("yyyy-MM-dd", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("Asia/Dhaka") }.format(draft.date)
    }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Add expense", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)

        ExpFieldBlock("Title", dark) {
            ExpInput(draft.title, "e.g. Office internet bill", dark) { draft.title = it }
        }

        // Category chips.
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text("CATEGORY", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                EXPENSE_CATEGORIES.forEach { cat ->
                    ExpChip(cat, draft.category == cat, dark) {
                        draft.category = if (draft.category == cat) "" else cat
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f)) {
                ExpFieldBlock("Amount (৳)", dark) {
                    ExpInput(draft.amountText, "0", dark, numeric = true) { new -> draft.amountText = new.filter { it.isDigit() } }
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("PAYMENT DATE", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                Text(
                    dateLabel,
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(11.dp),
                )
            }
        }

        // Payment status (web Paid | Pending | Partial).
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text("PAYMENT STATUS", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Paid", "Pending", "Partial").forEach { s ->
                    ExpChip(s, draft.paymentStatus == s, dark) { draft.paymentStatus = s }
                }
            }
        }

        ExpFieldBlock("Payment method", dark) {
            ExpInput(draft.paymentMethod, "bKash, bank…", dark) { draft.paymentMethod = it }
        }

        // Recurring toggle (pill).
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Recurring", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            ExpChip(if (draft.recurring) "On" else "Off", draft.recurring, dark) { draft.recurring = !draft.recurring }
        }

        ExpFieldBlock("Notes", dark) {
            ExpInput(draft.notes, "Notes", dark, singleLine = false) { draft.notes = it }
        }

        Text(
            "📎 রিসিট/ছবি — ওয়েব ভার্সনে যুক্ত করুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(11.dp),
        )

        if (!draft.valid) {
            Text(
                "Category and amount are required",
                color = ExpensePalette.amber600, fontSize = 11.sp,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                if (vm.saving) "Saving…" else "Save expense",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
                    .background(
                        if (draft.valid && !vm.saving) ExpensePalette.coral else ExpensePalette.coral.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { if (draft.valid && !vm.saving) confirming = true }
                    .padding(vertical = 11.dp),
            )
            Text(
                "Cancel",
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL).plainClick(onClose).padding(vertical = 11.dp),
            )
        }
        Spacer(Modifier.height(10.dp))
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = AlmaTheme.cardBg(dark),
            title = { Text("সেভ করবেন?", color = AlmaTheme.ink(dark)) },
            text = {
                Text(
                    "৳${grouped(draft.amount ?: 0)} · ${draft.category}",
                    color = AlmaTheme.inkSecondary(dark),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch { if (vm.add(draft)) onClose() }
                }) { Text("Save expense", color = ExpensePalette.coral) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("Cancel", color = AlmaTheme.inkSecondary(dark)) }
            },
        )
    }
}

@Composable
private fun ExpFieldBlock(label: String, dark: Boolean, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        content()
    }
}

@Composable
private fun ExpInput(
    value: String,
    placeholder: String,
    dark: Boolean,
    numeric: Boolean = false,
    singleLine: Boolean = true,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text(placeholder, color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp) },
        singleLine = singleLine,
        keyboardOptions = if (numeric) {
            KeyboardOptions(keyboardType = KeyboardType.Number)
        } else {
            KeyboardOptions.Default
        },
        modifier = Modifier.fillMaxWidth(),
        textStyle = androidx.compose.ui.text.TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
    )
}
