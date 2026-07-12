//
//  DigitalProjectsScreen.kt
//  ALMA ERP — the CDIT Projects page, ported 1:1 from DigitalProjectsSwiftUI.swift
//  (web /digital/projects parity).
//
//  Blocks: bento hero (total contract value + Paid/Due/Projects split) · "+ New
//  Project" native form · status filter chips (Lead…Cancelled, tap again to clear) ·
//  debounced server-side search · project rows (name, client · service,
//  PaymentStatusBadge, PaymentProgressBar, Value/Paid/Due/status·deadline footer) ·
//  detail sheet with the full record + "View client" web link.
//  Money is SENSITIVE — endpoints/bodies verbatim from the iOS/web page:
//    GET  /api/digital/projects?business_id=CREATIVE_DIGITAL_IT&status=…&search=…
//                                                                → { projects }
//    POST /api/digital/projects  {project_name, title, client_id, client_name,
//         service_type, total_amount, currency:"BDT", start_date, status:"Lead",
//         deadline, assigned_to:"", priority:"Medium",
//         business_id:"CREATIVE_DIGITAL_IT"}                     → { ok, error? }
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays.
//

package com.almatraders.erp.pages

import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.shimmering
import com.almatraders.erp.shell.str
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// ── Web palette (exact hexes from the iOS/web tokens) ────────────────────────────────

private object DigitalProjectsPalette {
    /** CDIT accent — the digital section's hero blue. */
    val accentBlue = Color(0xFF6B8FE0)
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val zinc600 = Color(0xFF52525B)      // Unpaid bar
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)     // Partial bar
    val amber400 = Color(0xFFFBBF24)     // Due text
    val emerald600 = Color(0xFF059669)
    val emerald500 = Color(0xFF10B981)   // Paid bar
    val emerald400 = Color(0xFF34D399)   // Paid text
    val red500 = Color(0xFFEF4444)
    val slate400 = Color(0xFF94A3B8)

    /** Accent-tinted text: gold-dim on cream, gold-lt over dark aurora (web text-gold). */
    fun goldText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web PaymentProgress STATUS_COLOR: Unpaid zinc · Partial amber · Paid emerald. */
    fun paymentBar(status: String): Color = when (status) {
        "Paid" -> emerald500
        "Partial Paid" -> amber500
        else -> zinc600
    }

    /** Web PaymentStatusBadge tints (Unpaid muted · Partial amber-400 · Paid emerald-400). */
    fun paymentText(status: String, dark: Boolean): Color = when (status) {
        "Paid" -> if (dark) emerald400 else emerald600
        "Partial Paid" -> if (dark) amber400 else amber600
        else -> slate400
    }

    /** Amber "Due" / emerald "Paid" footer texts (darkened on cream). */
    fun dueText(dark: Boolean): Color = if (dark) amber400 else amber600
    fun paidText(dark: Boolean): Color = if (dark) emerald400 else emerald600
}

/** Web STATUSES constant, same order. */
private val PROJECT_STATUSES =
    listOf("Lead", "Proposal", "Active", "Review", "Completed", "On Hold", "Cancelled")

/** Web CDIT_SERVICES verbatim (src/types/cdit.ts). */
private val CDIT_SERVICES = listOf(
    "Website Development", "Facebook Marketing", "SEO",
    "Branding", "Video Editing", "Graphics", "Monthly Retainer",
)

// ── Model (same field names the web CditProject type declares — snake_case wire) ─────

private data class DigitalProject(
    val id: String,
    val clientId: String?,
    val clientName: String?,
    val projectName: String?,
    val title: String?,
    val serviceType: String?,
    val status: String,
    val currency: String?,
    val startDate: String?,
    val deadline: String?,
    val assignedTo: String?,
    val priority: String?,
    val notes: String?,
    val totalAmount: Int?,
    val totalPaid: Int?,
    val dueAmount: Int?,
    val paymentPercentage: Double?,
    val paymentStatus: String,
) {
    /** Web row headline: `p.project_name || p.title`. */
    val name: String
        get() = projectName?.takeIf { it.isNotEmpty() }
            ?: title?.takeIf { it.isNotEmpty() }
            ?: "—"

    companion object {
        /** Sheet-backfilled rows mix ints/strings — decode defensively so ONE bad
         *  row can't kill the whole list (iOS flex decoder twin). */
        fun from(o: JSONObject): DigitalProject = DigitalProject(
            id = o.str("id") ?: UUID.randomUUID().toString(),
            clientId = o.str("client_id"),
            clientName = o.str("client_name"),
            projectName = o.str("project_name"),
            title = o.str("title"),
            serviceType = o.str("service_type"),
            status = o.str("status") ?: "Lead",
            currency = o.str("currency"),
            startDate = o.str("start_date"),
            deadline = o.str("deadline"),
            assignedTo = o.str("assigned_to"),
            priority = o.str("priority"),
            notes = o.str("notes"),
            totalAmount = o.flexInt("total_amount"),
            totalPaid = o.flexInt("total_paid"),
            dueAmount = o.flexInt("due_amount"),
            paymentPercentage = o.flexDouble("payment_percentage"),
            paymentStatus = o.str("payment_status") ?: "Unpaid",
        )
    }
}

// ── State holder (iOS DigitalProjectsVM twin) ────────────────────────────────────────

private class DigitalProjectsState {
    var projects by mutableStateOf(listOf<DigitalProject>())
    var search by mutableStateOf("")
    var status by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)
    var toast by mutableStateOf<String?>(null)

    // Hero summary — computed from the loaded list (web subtitle "N projects ·
    // billing tracked", expanded into the bento hero's billing split).
    val totalValue: Int get() = projects.sumOf { it.totalAmount ?: 0 }
    val totalPaid: Int get() = projects.sumOf { it.totalPaid ?: 0 }
    val totalDue: Int get() = projects.sumOf { it.dueAmount ?: 0 }

    /** Flat `{ projects }` — tolerate an apiDataSuccess `{ ok, data:{…} }` wrap too. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            // Same query the web builds: bizParams() + status/search filters.
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/digital/projects",
                    mapOf(
                        "business_id" to "CREATIVE_DIGITAL_IT",
                        "status" to status,
                        "search" to search.ifEmpty { null },
                    ),
                )
            )
            projects = c.optJSONArray("projects")?.mapObjects { DigitalProject.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    // ── Native create (owner 2026-07-11) — web "New Project" card payload verbatim. ──

    suspend fun createProject(
        name: String,
        clientId: String,
        clientName: String,
        serviceType: String,
        totalAmount: Int,
        startDate: String,
        deadline: String,
    ): Boolean {
        val body = JSONObject()
            .put("project_name", name)
            .put("title", name)
            .put("client_id", clientId)
            .put("client_name", clientName)
            .put("service_type", serviceType)
            .put("total_amount", totalAmount)
            .put("currency", "BDT")
            .put("start_date", startDate)
            .put("status", "Lead")
            .put("deadline", deadline)
            .put("assigned_to", "")
            .put("priority", "Medium")
            .put("business_id", "CREATIVE_DIGITAL_IT")
        return try {
            val res = AlmaApi.send("POST", "/api/digital/projects", body)
            if (res.flexBool("ok") == true) {
                toast = "Project created"
                load()
                true
            } else {
                toast = res.str("error") ?: "Could not create project"
                false
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            false
        } catch (e: Exception) {
            toast = e.message ?: "Could not create project"
            false
        }
    }
}

// ── Screen ───────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DigitalProjectsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { DigitalProjectsState() }
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<DigitalProject?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var searchJob by remember { mutableStateOf<Job?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Toast auto-dismiss (iOS 2.6s parity).
    LaunchedEffect(vm.toast) {
        if (vm.toast != null) {
            delay(2_600)
            vm.toast = null
        }
    }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                ProjectsHeroCard(
                    totalValue = vm.totalValue,
                    totalPaid = vm.totalPaid,
                    totalDue = vm.totalDue,
                    count = vm.projects.size,
                )
            }

            item {
                // Web header "+ New Project" — native form sheet (owner 2026-07-11).
                Text(
                    "+ New Project",
                    color = DigitalProjectsPalette.goldText(dark),
                    fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            DigitalProjectsPalette.accentBlue.copy(alpha = 0.10f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .border(
                            1.dp,
                            DigitalProjectsPalette.accentBlue.copy(alpha = 0.3f),
                            RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                        )
                        .plainClick { showCreate = true }
                        .padding(vertical = 11.dp),
                )
            }

            item {
                // Status filter (web Select: All + the 7 statuses, tap again to clear).
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ProjectsChip("All", vm.status == null, dark) {
                        vm.status = null
                        scope.launch { vm.load() }
                    }
                    PROJECT_STATUSES.forEach { s ->
                        ProjectsChip(s, vm.status == s, dark) {
                            vm.status = if (vm.status == s) null else s
                            scope.launch { vm.load() }
                        }
                    }
                }
            }

            item {
                // Search (web SearchInput — server-side, debounced 450ms) + refresh.
                Row(
                    Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("🔍", fontSize = 13.sp)
                    BasicTextField(
                        value = vm.search,
                        onValueChange = { newValue ->
                            vm.search = newValue
                            searchJob?.cancel()
                            searchJob = scope.launch {
                                delay(450)
                                vm.load()
                            }
                        },
                        singleLine = true,
                        textStyle = TextStyle(color = AlmaTheme.ink(dark), fontSize = 14.sp),
                        cursorBrush = SolidColor(AlmaTheme.coral),
                        modifier = Modifier.weight(1f),
                        decorationBox = { inner ->
                            Box {
                                if (vm.search.isEmpty()) {
                                    Text(
                                        "Search projects…",
                                        color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    Text(
                        "↻",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp,
                        modifier = Modifier.plainClick { scope.launch { vm.load() } },
                    )
                }
            }

            if (vm.authExpired) {
                item { ProjectsAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
            }
            vm.error?.let { item { ProjectsNoticeCard("⚠ $it", DigitalProjectsPalette.red500, dark) } }

            if (vm.loading && vm.projects.isEmpty()) {
                items(6) {
                    Box(Modifier.fillMaxWidth().height(96.dp).almaGlass(dark, AlmaTheme.R_CARD).shimmering())
                }
            }

            items(vm.projects, key = { it.id }) { p ->
                DigitalProjectRowCard(p, dark) { selected = p }
            }

            if (!vm.loading && vm.projects.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("◰", color = AlmaTheme.inkSecondary(dark), fontSize = 34.sp)
                        Text("কোনো প্রজেক্ট পাওয়া যায়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
                        Text(
                            "ক্লায়েন্ট কাজ ট্র্যাক করতে ওয়েবে প্রজেক্ট যোগ করুন",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        )
                    }
                }
            }

            item {
                // Web escape hatch.
                Text(
                    "🌐 নতুন প্রজেক্ট / সব অপশন — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/digital/projects", "CDIT projects") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        // Bottom toast (iOS capsule overlay parity).
        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 20)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }

    selected?.let { p ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalProjectDetailSheet(
                p, dark,
                openWeb = { path, title -> selected = null; ctx.openWebForced(path, title) },
            )
        }
    }

    if (showCreate) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            DigitalProjectCreateSheet(vm, dark) { showCreate = false }
        }
    }
}

// ── Bento hero (dark anchor: contract value + Paid/Due/Projects split) ──────────────

@Composable
private fun ProjectsHeroCard(totalValue: Int, totalPaid: Int, totalDue: Int, count: Int) {
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).projectsHeroBg().padding(16.dp),
    ) {
        Text(
            "CDIT প্রজেক্ট বিলিং",
            color = DigitalProjectsPalette.accentBlue,
            fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(8.dp))
        ProjectsCountUp(totalValue, 38.sp, Color.White, format = { AlmaTheme.takaShort(it) })
        Spacer(Modifier.height(5.dp))
        Text("মোট কন্ট্রাক্ট ভ্যালু", color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp)

        Spacer(Modifier.height(14.dp))
        Row {
            ProjectsHeroStat(
                "Paid", totalPaid, DigitalProjectsPalette.emerald400, "আদায় হয়েছে",
                format = { AlmaTheme.takaShort(it) },
            )
            ProjectsHeroDivider()
            ProjectsHeroStat(
                "Due", totalDue, DigitalProjectsPalette.amber400, "বাকি আছে",
                format = { AlmaTheme.takaShort(it) },
            )
            ProjectsHeroDivider()
            ProjectsHeroStat("Projects", count, Color.White, "মোট প্রজেক্ট", format = { "$it" })
        }
    }
}

@Composable
private fun ProjectsHeroDivider() {
    Box(
        Modifier.padding(horizontal = 14.dp, vertical = 2.dp)
            .width(1.dp).height(44.dp)
            .background(Color.White.copy(alpha = 0.14f)),
    )
}

@Composable
private fun ProjectsHeroStat(
    label: String,
    value: Int,
    tint: Color,
    sub: String,
    format: (Int) -> String,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label.uppercase(),
            color = Color.White.copy(alpha = 0.55f), fontSize = 9.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        ProjectsCountUp(value, 18.sp, tint, format = format)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Count-up number (0 → target on appear) — iOS Animatable count-up twin. */
@Composable
private fun ProjectsCountUp(target: Int, fontSize: TextUnit, color: Color, format: (Int) -> String) {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { started = true }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "countUp",
    )
    Text(format(shown), color = color, fontSize = fontSize, fontWeight = FontWeight.ExtraBold, maxLines = 1)
}

// ── Row card (web card row: name · client · service, badge, bar, money footer) ──────

@Composable
private fun DigitalProjectRowCard(p: DigitalProject, dark: Boolean, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    p.name,
                    color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                // Web sub line: `{client_name} · {service_type}`.
                Text(
                    listOfNotNull(
                        p.clientName?.takeIf { it.isNotEmpty() },
                        p.serviceType?.takeIf { it.isNotEmpty() },
                    ).joinToString(" · ").ifEmpty { "—" },
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            ProjectsPaymentBadge(p.paymentStatus, dark)
        }

        ProjectsPaymentBar(p.paymentPercentage ?: 0.0, p.paymentStatus, dark)

        // Web footer: Value ৳X · Paid ৳X (emerald) · Due ৳X (amber) · {status} · Due {deadline}.
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ProjectsMoneyBit("Value", p.totalAmount ?: 0, AlmaTheme.inkSecondary(dark), dark)
            ProjectsMoneyBit("Paid", p.totalPaid ?: 0, DigitalProjectsPalette.paidText(dark), dark)
            ProjectsMoneyBit("Due", p.dueAmount ?: 0, DigitalProjectsPalette.dueText(dark), dark)
            Text(
                "${p.status} · Due ${p.deadline?.takeIf { it.isNotEmpty() } ?: "—"}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1,
            )
        }
    }
}

@Composable
private fun ProjectsMoneyBit(label: String, amount: Int, tint: Color, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        Text(AlmaTheme.taka(amount), color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

/** Web PaymentProgressBar: rounded track + status-coloured fill, width = clamped %. */
@Composable
private fun ProjectsPaymentBar(percentage: Double, status: String, dark: Boolean) {
    val pct = (percentage.coerceIn(0.0, 100.0) / 100.0).toFloat()
    val animated by animateFloatAsState(targetValue = pct, animationSpec = tween(500), label = "payBar")
    Box(
        Modifier.fillMaxWidth().height(6.dp).clip(CircleShape)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.10f)),
    ) {
        if (animated > 0f) {
            Box(
                Modifier.fillMaxWidth(animated).fillMaxHeight().clip(CircleShape)
                    .background(DigitalProjectsPalette.paymentBar(status)),
            )
        }
    }
}

/** Web PaymentStatusBadge: uppercase tracking pill, tinted per status. */
@Composable
private fun ProjectsPaymentBadge(status: String, dark: Boolean) {
    val tint = DigitalProjectsPalette.paymentText(status, dark)
    Text(
        status.uppercase(),
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp,
        maxLines = 1,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

// ── Detail sheet (full record + web "View client →" escape) ─────────────────────────

@Composable
private fun DigitalProjectDetailSheet(
    p: DigitalProject,
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
        // Header.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    p.name,
                    color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                ProjectsPaymentBadge(p.paymentStatus, dark)
            }
            Text(
                "${p.clientName ?: "—"} · ${p.serviceType ?: "—"}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }

        // Billing (progress bar + Value / Paid / Due cells — the web row's numbers).
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "BILLING",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            )
            ProjectsPaymentBar(p.paymentPercentage ?: 0.0, p.paymentStatus, dark)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ProjectsStatCell("Value", p.totalAmount ?: 0, DigitalProjectsPalette.goldText(dark), dark, Modifier.weight(1f))
                ProjectsStatCell("Paid", p.totalPaid ?: 0, DigitalProjectsPalette.paidText(dark), dark, Modifier.weight(1f))
                ProjectsStatCell("Due", p.dueAmount ?: 0, DigitalProjectsPalette.dueText(dark), dark, Modifier.weight(1f))
            }
        }

        // Project record (status / priority / dates / assignee / currency).
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "PROJECT",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            )
            ProjectsDetailRow("Status", p.status, DigitalProjectsPalette.accentBlue, dark)
            ProjectsDetailRow("Priority", p.priority?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            ProjectsDetailRow("Start", p.startDate?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            ProjectsDetailRow("Deadline", p.deadline?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            ProjectsDetailRow("Assigned to", p.assignedTo?.takeIf { it.isNotEmpty() } ?: "—", AlmaTheme.ink(dark), dark)
            ProjectsDetailRow("Currency", p.currency?.takeIf { it.isNotEmpty() } ?: "BDT", AlmaTheme.ink(dark), dark)
        }

        p.notes?.takeIf { it.isNotEmpty() }?.let { n ->
            Column(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "NOTES",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
                )
                Text(n, color = AlmaTheme.ink(dark), fontSize = 12.sp)
            }
        }

        // Web escapes (web "View client →" link + page escape).
        p.clientId?.takeIf { it.isNotEmpty() }?.let { cid ->
            Text(
                "👤 ক্লায়েন্ট দেখুন",
                color = DigitalProjectsPalette.accentBlue, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        DigitalProjectsPalette.accentBlue.copy(alpha = 0.10f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .border(
                        1.dp,
                        DigitalProjectsPalette.accentBlue.copy(alpha = 0.3f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { openWeb("/digital/clients/$cid", p.clientName ?: "Client") }
                    .padding(vertical = 11.dp),
            )
        }
        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/digital/projects", "CDIT projects") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun ProjectsStatCell(label: String, amount: Int, tint: Color, dark: Boolean, modifier: Modifier) {
    Column(
        modifier
            .background(AlmaTheme.ink(dark).copy(alpha = 0.05f), RoundedCornerShape(10.dp))
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            AlmaTheme.taka(amount),
            color = tint, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        )
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
    }
}

@Composable
private fun ProjectsDetailRow(label: String, value: String, tint: Color, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text(value, color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
    }
}

// ── Create sheet (web "New Project" card — POST /api/digital/projects verbatim) ─────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DigitalProjectCreateSheet(vm: DigitalProjectsState, dark: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var projectName by remember { mutableStateOf("") }
    var clientId by remember { mutableStateOf("") }
    var clientName by remember { mutableStateOf("") }
    var totalAmount by remember { mutableStateOf("") }
    var serviceType by remember { mutableStateOf("Website Development") }
    var serviceMenu by remember { mutableStateOf(false) }
    var startDate by remember { mutableStateOf<String?>(null) }
    var deadline by remember { mutableStateOf<String?>(null) }
    var pickingStart by remember { mutableStateOf(false) }
    var pickingDeadline by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val taka = totalAmount.replace(",", "").trim().toDoubleOrNull()?.toInt() ?: 0
    val canSubmit = projectName.trim().isNotEmpty()

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("New Project", color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("Billing-tracked client project।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }

        OutlinedTextField(
            value = projectName, onValueChange = { projectName = it },
            placeholder = { Text("Project name *") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = clientId, onValueChange = { clientId = it },
            placeholder = { Text("Client ID") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = clientName, onValueChange = { clientName = it },
            placeholder = { Text("Client name") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = totalAmount, onValueChange = { totalAmount = it },
            placeholder = { Text("Contract value (BDT)") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        // Service type (web CDIT_SERVICES menu).
        Box {
            Row(
                Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
                    .plainClick { serviceMenu = true }
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(serviceType, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text("▾", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
            DropdownMenu(expanded = serviceMenu, onDismissRequest = { serviceMenu = false }) {
                CDIT_SERVICES.forEach { s ->
                    DropdownMenuItem(text = { Text(s) }, onClick = { serviceType = s; serviceMenu = false })
                }
            }
        }

        // Optional dates (web's empty-string-when-unset inputs).
        ProjectsOptionalDateRow("Start date", startDate, dark,
            onPick = { pickingStart = true }, onClear = { startDate = null })
        ProjectsOptionalDateRow("Deadline", deadline, dark,
            onPick = { pickingDeadline = true }, onClear = { deadline = null })

        errorText?.let {
            Text(it, color = DigitalProjectsPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }

        if (submitting) {
            Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(
                    Modifier.size(18.dp),
                    color = DigitalProjectsPalette.accentBlue, strokeWidth = 2.dp,
                )
            }
        } else {
            Text(
                "Create Project",
                color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (canSubmit) DigitalProjectsPalette.accentBlue
                        else DigitalProjectsPalette.accentBlue.copy(alpha = 0.4f),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    )
                    .plainClick { if (canSubmit) confirming = true }
                    .padding(vertical = 14.dp),
            )
        }
    }

    if (pickingStart || pickingDeadline) {
        val dpState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { pickingStart = false; pickingDeadline = false },
            confirmButton = {
                TextButton(onClick = {
                    dpState.selectedDateMillis?.let { millis ->
                        val ymd = ProjectsFormat.utcYmd(millis)
                        if (pickingStart) startDate = ymd else deadline = ymd
                    }
                    pickingStart = false
                    pickingDeadline = false
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { pickingStart = false; pickingDeadline = false }) { Text("বাতিল") }
            },
        ) { DatePicker(dpState) }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = {
                Text(
                    "\"${projectName.trim()}\" তৈরি করবেন?" +
                        if (taka > 0) " Value ${AlmaTheme.taka(taka)}" else ""
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        submitting = true
                        errorText = null
                        val ok = vm.createProject(
                            name = projectName.trim(),
                            clientId = clientId,
                            clientName = clientName,
                            serviceType = serviceType,
                            totalAmount = taka,
                            startDate = startDate ?: "",
                            deadline = deadline ?: "",
                        )
                        submitting = false
                        if (ok) onDone() else errorText = vm.toast
                    }
                }) { Text("হ্যাঁ, তৈরি করুন") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun ProjectsOptionalDateRow(
    label: String,
    value: String?,
    dark: Boolean,
    onPick: () -> Unit,
    onClear: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Spacer(Modifier.weight(1f))
        if (value != null) {
            Text(
                value,
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onPick),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                "✕",
                color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp,
                modifier = Modifier.plainClick(onClear),
            )
        } else {
            Text(
                "সেট করুন",
                color = DigitalProjectsPalette.goldText(dark), fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.plainClick(onPick),
            )
        }
    }
}

// ── Shared bits ──────────────────────────────────────────────────────────────────────

@Composable
private fun ProjectsChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) DigitalProjectsPalette.accentBlue else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) DigitalProjectsPalette.accentBlue.copy(alpha = if (dark) 0.28f else 0.16f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) DigitalProjectsPalette.accentBlue.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun ProjectsNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun ProjectsAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(AlmaTheme.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Formatting + surface recipes (page-owned copies — parallel-session convention) ──

private object ProjectsFormat {
    /** Material3 DatePicker hands back UTC-midnight millis — format in UTC. */
    fun utcYmd(millis: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(millis))
    }
}

/** The dark hero anchor backdrop — deep indigo base + CDIT-blue/violet washes
 *  (deliberately dark in BOTH schemes, Dashboard hero recipe). */
private fun Modifier.projectsHeroBg(): Modifier {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    return this
        .clip(shape)
        .background(Color(0xFF151828))
        .background(
            Brush.linearGradient(
                0f to DigitalProjectsPalette.accentBlue.copy(alpha = 0.36f),
                0.55f to Color.Transparent,
            )
        )
        .background(
            Brush.linearGradient(
                0.45f to Color.Transparent,
                1f to AlmaTheme.violet.copy(alpha = 0.28f),
            )
        )
        .background(
            Brush.radialGradient(
                listOf(DigitalProjectsPalette.emerald500.copy(alpha = 0.12f), Color.Transparent),
                center = Offset(750f, 40f),
                radius = 450f,
            )
        )
        .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
}
