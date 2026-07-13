//
//  TaskSpotlightScreen.kt
//  ALMA ERP — Operations → Task Spotlight, ported 1:1 from TaskSpotlightSwiftUI.swift.
//
//  Endpoints (same as web/iOS):
//    GET   /api/operational-tasks                     → admin task list (business_id
//                                                       omitted = every business)
//    PATCH /api/operational-tasks/{id}  {action: "archive"}
//    PATCH /api/operational-tasks/{id}  {action: "resend", assignment_id}
//  Responses wrap via apiDataSuccess → {ok, data:{…}} — unwrap both shapes.
//  Blocks: status chips (ACTIVE/ARCHIVED/ALL, client-side) · KPI strip (active/
//  overdue/done) · Reminders-style task cards (status circle · due badge · initials
//  avatars · progress bar · Archive) · detail sheet (banner + per-assignee rows with
//  Resend spotlight) · archive confirm dialog. Task CREATION stays on the web escape.
//  Carried lesson: ONE spinner per row/card, never a global overlay.
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
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
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

private object SpotlightPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)

    /** Web: CRITICAL tone-red · HIGH tone-amber · else muted. */
    fun priority(p: String?, dark: Boolean): Color = when (p) {
        "CRITICAL" -> red500
        "HIGH" -> amber600
        else -> AlmaTheme.inkSecondary(dark)
    }

    /** Assignment status → Reminders-style circle tint. */
    fun assignment(s: String?, dark: Boolean): Color = when (s) {
        "COMPLETED" -> emerald600
        "IN_PROGRESS" -> amber500
        "ACKNOWLEDGED" -> goldLt
        "EXPIRED" -> red500
        else -> AlmaTheme.inkSecondary(dark)   // ACTIVE / ARCHIVED
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names listTasksForAdmin returns) ────────────────────────────

private data class SpotlightAssignment(
    val id: String,
    val userId: String?,
    val status: String?,
    val acknowledgedAt: String?,
    val startedAt: String?,
    val completedAt: String?,
    val assigneeName: String?,
) {
    /** Web row: `{a.assignee?.name || a.userId}` — same fallback chain. */
    val displayName: String get() = assigneeName ?: userId ?: "—"

    companion object {
        fun from(o: JSONObject): SpotlightAssignment? {
            val id = o.str("id") ?: return null
            return SpotlightAssignment(
                id = id,
                userId = o.str("userId"),
                status = o.str("status"),
                acknowledgedAt = o.str("acknowledgedAt"),
                startedAt = o.str("startedAt"),
                completedAt = o.str("completedAt"),
                assigneeName = o.optJSONObject("assignee")?.str("name"),
            )
        }
    }
}

private data class SpotlightStats(
    val assigned: Int,
    val completed: Int,
    val acknowledged: Int,
    val completionRate: Int,
) {
    companion object {
        fun from(o: JSONObject?): SpotlightStats = SpotlightStats(
            assigned = o?.flexInt("assigned") ?: 0,
            completed = o?.flexInt("completed") ?: 0,
            acknowledged = o?.flexInt("acknowledged") ?: 0,
            completionRate = o?.flexInt("completionRate") ?: 0,
        )
    }
}

private data class SpotlightTask(
    val id: String,
    val title: String,
    val description: String?,
    val priority: String?,
    val status: String,                      // ACTIVE | ARCHIVED
    val deadline: String?,
    val bannerImageUrl: String?,
    val acknowledgmentRequired: Boolean?,
    val createdAt: String?,
    val createdByName: String?,
    val stats: SpotlightStats,
    val assignments: List<SpotlightAssignment>,
) {
    val isDone: Boolean get() = stats.assigned > 0 && stats.completed >= stats.assigned
    val isOverdue: Boolean
        get() {
            if (status != "ACTIVE" || isDone) return false
            val d = SpotlightFormat.parse(deadline) ?: return false
            return d.before(Date())
        }
    val isDueToday: Boolean get() = SpotlightFormat.isToday(deadline)

    companion object {
        fun from(o: JSONObject): SpotlightTask? {
            val id = o.str("id") ?: return null
            return SpotlightTask(
                id = id,
                title = o.str("title") ?: "—",
                description = o.str("description"),
                priority = o.str("priority"),
                status = o.str("status") ?: "ACTIVE",
                deadline = o.str("deadline"),
                bannerImageUrl = o.str("bannerImageUrl"),
                acknowledgmentRequired = o.flexBool("acknowledgmentRequired"),
                createdAt = o.str("createdAt"),
                createdByName = o.optJSONObject("createdBy")?.str("name"),
                stats = SpotlightStats.from(o.optJSONObject("stats")),
                assignments = o.optJSONArray("assignments")
                    ?.mapObjects { SpotlightAssignment.from(it) } ?: emptyList(),
            )
        }
    }
}

// ── State holder (iOS TaskSpotlightVM twin) ────────────────────────────────────────

private class TaskSpotlightState {
    var tasks by mutableStateOf(listOf<SpotlightTask>())
    var statusFilter by mutableStateOf("ACTIVE")     // ACTIVE | ARCHIVED | ALL (client-side)
    var loading by mutableStateOf(false)
    var busyTaskIds by mutableStateOf(setOf<String>())        // per-card archive spinner
    var busyAssignmentIds by mutableStateOf(setOf<String>())  // per-row resend spinner
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)               // the web's toast line
    var authExpired by mutableStateOf(false)

    val filtered: List<SpotlightTask>
        get() = if (statusFilter == "ALL") tasks else tasks.filter { it.status == statusFilter }
    val activeCount: Int get() = tasks.count { it.status == "ACTIVE" }
    val overdueCount: Int get() = tasks.count { it.isOverdue }
    val doneCount: Int get() = tasks.count { it.status == "ACTIVE" && it.isDone }

    /** operational-tasks wraps via apiDataSuccess → {ok, data:{…}} — unwrap both shapes. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            // business_id omitted on purpose — listTasksForAdmin(null) returns every
            // business's tasks, which is what the owner wants on one native screen.
            val c = unwrap(AlmaApi.getObject("/api/operational-tasks"))
            tasks = c.optJSONArray("tasks")?.mapObjects { SpotlightTask.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** PATCH {action: "archive"} — same body the web archiveTask sends. */
    suspend fun archive(task: SpotlightTask) {
        if (task.id in busyTaskIds) return
        busyTaskIds = busyTaskIds + task.id
        notice = null
        try {
            AlmaApi.send("PATCH", "/api/operational-tasks/${task.id}", JSONObject().put("action", "archive"))
            notice = "Task archived"                    // web toast verbatim
            load()
        } catch (e: Exception) {
            error = e.message
        } finally {
            busyTaskIds = busyTaskIds - task.id
        }
    }

    /** PATCH {action: "resend", assignment_id} — resets one employee's spotlight. */
    suspend fun resend(taskId: String, assignmentId: String) {
        if (assignmentId in busyAssignmentIds) return
        busyAssignmentIds = busyAssignmentIds + assignmentId
        notice = null
        try {
            AlmaApi.send(
                "PATCH", "/api/operational-tasks/$taskId",
                JSONObject().put("action", "resend").put("assignment_id", assignmentId),
            )
            notice = "Spotlight reset — employee will see on next Start Work"   // web toast verbatim
            load()
        } catch (e: Exception) {
            error = e.message
        } finally {
            busyAssignmentIds = busyAssignmentIds - assignmentId
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskSpotlightScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { TaskSpotlightState() }
    val scope = rememberCoroutineScope()
    var selectedId by remember { mutableStateOf<String?>(null) }
    var archiving by remember { mutableStateOf<SpotlightTask?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (vm.authExpired) {
            item { SpotlightAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.let { item { SpotlightNotice(it, SpotlightPalette.red500, dark) } }
        vm.notice?.let { item { SpotlightNotice(it, SpotlightPalette.emerald600, dark) } }

        item {
            // Status filter chips + refresh (iOS: pull-to-refresh).
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("ACTIVE", "ARCHIVED", "ALL").forEach { s ->
                        SpotlightChip(
                            if (s == "ALL") "All" else s.lowercase().replaceFirstChar { it.uppercase() },
                            vm.statusFilter == s, dark,
                        ) { vm.statusFilter = s }
                    }
                }
                Box(
                    Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                        .plainClick { scope.launch { vm.load() } },
                    contentAlignment = Alignment.Center,
                ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
            }
        }

        item {
            // KPI strip: live tasks · overdue · fully-done.
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SpotlightKpi("ACTIVE", vm.activeCount, SpotlightPalette.goldLt, dark)
                SpotlightKpi("OVERDUE", vm.overdueCount, SpotlightPalette.red500, dark)
                SpotlightKpi("DONE", vm.doneCount, SpotlightPalette.emerald600, dark)
            }
        }

        if (vm.loading && vm.tasks.isEmpty()) {
            items(4) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }

        items(vm.filtered, key = { it.id }) { task ->
            SpotlightTaskCard(
                task, dark,
                busy = task.id in vm.busyTaskIds,
                onTap = { selectedId = task.id },
                onArchive = { archiving = task },
            )
        }

        if (!vm.loading && vm.filtered.isEmpty() && vm.error == null && !vm.authExpired) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("📋", fontSize = 34.sp)
                    Text(
                        if (vm.statusFilter == "ACTIVE") "কোনো চলমান টাস্ক নেই" else "কিছু নেই",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp,
                    )
                    Text(
                        "নতুন Task Spotlight তৈরি করতে ওয়েব পেজটি ব্যবহার করুন।",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    )
                }
            }
        }

        item {
            Text(
                "🌐 সব অপশন (নতুন টাস্ক তৈরি সহ) — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/operations/task-spotlight", "Task Spotlight") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selectedId?.let { id ->
        // Live copy — the state reloads after resend; keep the sheet's rows fresh.
        val task = vm.tasks.firstOrNull { it.id == id }
        if (task == null) {
            selectedId = null
        } else {
            ModalBottomSheet(onDismissRequest = { selectedId = null }, containerColor = AlmaTheme.rootBg(dark)) {
                SpotlightDetailSheet(
                    task, vm, dark,
                    onArchive = { selectedId = null; archiving = task },
                    onResend = { aId -> scope.launch { vm.resend(task.id, aId) } },
                    openWeb = { p, t -> selectedId = null; ctx.openWebForced(p, t) },
                )
            }
        }
    }

    archiving?.let { task ->
        AlertDialog(
            onDismissRequest = { archiving = null },
            title = { Text("টাস্কটি আর্কাইভ করবেন?") },
            text = { Text("${task.title} — সব অসম্পূর্ণ অ্যাসাইনমেন্টও আর্কাইভ হবে।") },
            confirmButton = {
                TextButton(onClick = {
                    archiving = null
                    scope.launch { vm.archive(task) }
                }) { Text("Archive", color = SpotlightPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { archiving = null }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun SpotlightChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) SpotlightPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) SpotlightPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) SpotlightPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun SpotlightNotice(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun SpotlightAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(SpotlightPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun SpotlightKpi(label: String, value: Int, tint: Color, dark: Boolean) {
    Column(Modifier.widthIn(min = 84.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp)) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text("$value", color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Task card (Reminders-style row: status circle · due badge · avatars · progress) ─

@Composable
private fun SpotlightTaskCard(
    task: SpotlightTask,
    dark: Boolean,
    busy: Boolean,
    onTap: () -> Unit,
    onArchive: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SpotlightStatusCircle(task, dark)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    task.title,
                    color = if (task.status == "ARCHIVED") AlmaTheme.inkSecondary(dark) else AlmaTheme.ink(dark),
                    fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    textDecoration = if (task.status == "ARCHIVED") TextDecoration.LineThrough else null,
                )
                task.description?.takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            task.priority?.takeIf { it == "CRITICAL" || it == "HIGH" }?.let { p ->
                Text(p, color = SpotlightPalette.priority(p, dark), fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SpotlightDueBadge(task, dark)
            if (task.status == "ARCHIVED") {
                Text("ARCHIVED", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.weight(1f))
            SpotlightAvatarStack(task.assignments, dark)
        }

        // Web: "{rate}% complete ({completed}/{assigned})" — as a thin native bar.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(
                Modifier.fillMaxWidth().height(5.dp)
                    .clip(CircleShape)
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.08f)),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(task.stats.completionRate.coerceIn(0, 100) / 100f)
                        .fillMaxHeight()
                        .clip(CircleShape)
                        .background(if (task.isDone) SpotlightPalette.emerald600 else SpotlightPalette.coral),
                )
            }
            Text(
                "${task.stats.completionRate}% complete (${task.stats.completed}/${task.stats.assigned})",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
        }

        if (task.status == "ACTIVE") {
            // ONE spinner per card, never a global overlay.
            if (busy) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(15.dp), color = SpotlightPalette.coral, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Processing…", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            } else {
                Text(
                    "🗄 Archive",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .border(1.dp, AlmaTheme.ink(dark).copy(alpha = 0.12f), CircleShape)
                        .plainClick(onArchive)
                        .padding(vertical = 8.dp),
                )
            }
        }
    }
}

/** Reminders-style leading circle — filled check when everyone is done,
 *  half-filled while in flight, open circle when nobody started. */
@Composable
private fun SpotlightStatusCircle(task: SpotlightTask, dark: Boolean) {
    when {
        task.isDone -> Box(
            Modifier.size(20.dp).background(SpotlightPalette.emerald600, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        task.stats.acknowledged > 0 -> Text("◐", color = SpotlightPalette.amber500, fontSize = 17.sp)
        else -> Box(Modifier.size(20.dp).border(1.5.dp, AlmaTheme.inkSecondary(dark), CircleShape))
    }
}

/** Due badge — overdue red, due today amber, else quiet date text. */
@Composable
private fun SpotlightDueBadge(task: SpotlightTask, dark: Boolean) {
    val deadline = SpotlightFormat.dateTime(task.deadline)
    when {
        deadline == null -> Text("কোনো ডেডলাইন নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        task.isOverdue -> SpotlightBadge("⏰ $deadline — সময় পেরিয়ে গেছে", SpotlightPalette.red500)
        task.isDueToday && !task.isDone -> SpotlightBadge("আজ $deadline", SpotlightPalette.amber500)
        else -> Text(deadline, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
    }
}

@Composable
private fun SpotlightBadge(text: String, tint: Color) {
    Text(
        text,
        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

/** Overlapping initials avatars — first 4 assignees + "+N". */
@Composable
private fun SpotlightAvatarStack(assignments: List<SpotlightAssignment>, dark: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
        assignments.take(4).forEach { a ->
            Box(
                Modifier
                    .size(26.dp)
                    .background(SpotlightPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, SpotlightPalette.coral.copy(alpha = 0.35f), CircleShape)
                    .border(1.dp, Color.White.copy(alpha = if (dark) 0.15f else 0.6f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    SpotlightFormat.initials(a.displayName),
                    color = SpotlightPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
        if (assignments.size > 4) {
            Box(
                Modifier.size(26.dp).background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "+${assignments.size - 4}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

// ── Detail sheet (full description + per-assignee rows + resend/archive) ───────────

@Composable
private fun SpotlightDetailSheet(
    task: SpotlightTask,
    vm: TaskSpotlightState,
    dark: Boolean,
    onArchive: () -> Unit,
    onResend: (assignmentId: String) -> Unit,
    openWeb: (path: String, title: String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp)
            .padding(bottom = 26.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Header.
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row {
                Text(
                    task.title, color = AlmaTheme.ink(dark), fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
                )
                task.priority?.let { p ->
                    Text(p, color = SpotlightPalette.priority(p, dark), fontSize = 11.sp, fontWeight = FontWeight.Black)
                }
            }
            Text(
                buildString {
                    append(task.status)
                    task.createdByName?.let { append(" · by $it") }
                    SpotlightFormat.dateTime(task.createdAt)?.let { append(" · $it") }
                },
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }

        task.bannerImageUrl?.takeIf { it.isNotEmpty() }?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp)
                    .clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp)),
            )
        }

        // Description card.
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("নির্দেশনা", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            Text(task.description ?: "—", color = AlmaTheme.ink(dark), fontSize = 13.sp, lineHeight = 18.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SpotlightFormat.dateTime(task.deadline)?.let { d ->
                    Text(
                        "📅 $d",
                        color = if (task.isOverdue) SpotlightPalette.red500 else AlmaTheme.inkSecondary(dark),
                        fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                if (task.acknowledgmentRequired == true) {
                    Text("Acknowledgment required", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
            }
        }

        // Per-assignee rows — status glyph + name + status + resend.
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "অ্যাসাইনি (${task.assignments.size})",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black,
            )
            task.assignments.forEach { a ->
                SpotlightAssigneeRow(
                    a, dark,
                    taskActive = task.status == "ACTIVE",
                    busy = a.id in vm.busyAssignmentIds,
                    onResend = { onResend(a.id) },
                )
            }
            if (task.assignments.isEmpty()) {
                Text("কাউকে অ্যাসাইন করা হয়নি", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            }
        }

        if (task.status == "ACTIVE") {
            Text(
                "🗄 Archive task",
                color = SpotlightPalette.red500, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SpotlightPalette.red500.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, SpotlightPalette.red500.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .plainClick(onArchive)
                    .padding(vertical = 10.dp),
            )
        }

        Text(
            "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb("/operations/task-spotlight", "Task Spotlight") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun SpotlightAssigneeRow(
    a: SpotlightAssignment,
    dark: Boolean,
    taskActive: Boolean,
    busy: Boolean,
    onResend: () -> Unit,
) {
    val tint = SpotlightPalette.assignment(a.status, dark)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            when (a.status) {
                "COMPLETED" -> "✓"
                "IN_PROGRESS" -> "◐"
                "ACKNOWLEDGED" -> "◎"
                "EXPIRED" -> "⚠"
                else -> "○"                       // ACTIVE — not seen yet / ARCHIVED
            },
            color = tint, fontSize = 15.sp, fontWeight = FontWeight.Bold,
        )
        Box(
            Modifier
                .size(26.dp)
                .background(SpotlightPalette.coral.copy(alpha = 0.16f), CircleShape)
                .border(1.dp, SpotlightPalette.coral.copy(alpha = 0.35f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                SpotlightFormat.initials(a.displayName),
                color = SpotlightPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(a.displayName, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(a.status ?: "—", color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                SpotlightFormat.timestampLine(a)?.let {
                    Text("· $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                }
            }
        }
        if (taskActive && a.status != "COMPLETED") {
            if (busy) {
                CircularProgressIndicator(Modifier.size(15.dp), color = SpotlightPalette.coral, strokeWidth = 2.dp)
            } else {
                // Web button verbatim: "Resend spotlight".
                Text(
                    "Resend",
                    color = SpotlightPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .background(SpotlightPalette.coral.copy(alpha = 0.13f), CircleShape)
                        .border(1.dp, SpotlightPalette.coral.copy(alpha = 0.35f), CircleShape)
                        .plainClick(onResend)
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
        }
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object SpotlightFormat {
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

    /** ISO → "5/7/2026, 8:50 PM" style in Asia/Dhaka (web: toLocaleString()). */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** Same calendar day as now, in Asia/Dhaka. */
    fun isToday(iso: String?): Boolean {
        val date = parse(iso) ?: return false
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date) == f.format(Date())
    }

    /** Bangla relative time — same strings as the app's other native screens. */
    fun timeAgo(iso: String?): String? {
        val date = parse(iso) ?: return null
        val mins = ((System.currentTimeMillis() - date.time) / 60_000).toInt()
        return when {
            mins < 1 -> "এইমাত্র"
            mins < 60 -> "$mins মিনিট আগে"
            mins < 24 * 60 -> "${mins / 60} ঘণ্টা আগে"
            else -> "${mins / (24 * 60)} দিন আগে"
        }
    }

    fun timestampLine(a: SpotlightAssignment): String? = when (a.status) {
        "COMPLETED" -> timeAgo(a.completedAt)
        "IN_PROGRESS" -> timeAgo(a.startedAt)
        "ACKNOWLEDGED" -> timeAgo(a.acknowledgedAt)
        else -> null
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}
