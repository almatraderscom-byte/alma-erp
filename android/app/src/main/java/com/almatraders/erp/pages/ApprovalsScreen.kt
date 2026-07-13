//
//  ApprovalsScreen.kt
//  ALMA ERP — the Approvals tab, ported 1:1 from ApprovalsSwiftUI.swift (v2 web parity):
//  Business/Agent views · status filters (incl. ALL) · 5 KPI cards (web hexes) · rows
//  with requester + leave info + payout summary + salary-correction digest + linkage
//  warnings + "via" audit source · detail sheet · reject note (≥5 chars) · Integrity
//  monitor · WALLET_WITHDRAWAL approve collects the Transaction ID first.
//  Carried lesson: ONE spinner per row, never a global overlay.
//
//  Endpoints (same as web/iOS):
//    GET   /api/approvals?status=…&limit=80
//    PATCH /api/approvals/{id}  {action, note, operation_id, transactionId?}
//    GET   /api/approvals/integrity · POST /api/approvals/integrity
//    GET   /api/assistant/actions?status=pending|all&limit=50
//    POST  /api/assistant/actions/{id}/approve|reject   (410=expired, 409=done)
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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

private object ApprovalPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    fun priority(p: String?, dark: Boolean): Color = when (p) {
        "CRITICAL" -> red500
        "HIGH" -> amber600
        else -> AlmaTheme.inkSecondary(dark)
    }

    fun status(s: String): Color = when (s) {
        "PENDING" -> goldLt
        "APPROVED" -> emerald600
        else -> red500
    }

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names the web page types declare) ───────────────────────────

data class ApprovalRequester(val name: String?, val role: String?)

data class ApprovalPayout(
    val label: String?,
    val accountHolder: String?,
    val accountNumber: String?,
    val accountNumberMasked: String?,
    val isVerified: Boolean?,
    val status: String?,
)

data class ApprovalPayload(
    val kind: String?,
    val startDate: String?,
    val endDate: String?,
    val startMinutes: Int?,
    val endMinutes: Int?,
    val days: Int?,
    val employeeId: String?,
    val periodYm: String?,
    val currentAmount: Int?,
    val proposedAmount: Int?,
    val reversalCount: Int?,
)

data class AlmaApproval(
    val id: String,
    val module: String?,
    val type: String?,
    val businessId: String?,
    val entityId: String?,
    val entityLabel: String?,
    val status: String,
    val priority: String?,
    val reason: String?,
    val actionUrl: String?,
    val createdAt: String?,
    val businessName: String?,
    val executable: Boolean?,
    val linkageStatus: String?,
    val sourceStatus: String?,
    val requestedBy: String?,
    val requester: ApprovalRequester?,
    val payoutSummary: ApprovalPayout?,
    val payload: ApprovalPayload?,
    val auditSource: String?,
) {
    companion object {
        fun from(o: JSONObject): AlmaApproval? {
            val id = o.str("id") ?: return null
            val req = o.optJSONObject("requester")?.let {
                ApprovalRequester(it.str("name"), it.str("role"))
            }
            val payout = o.optJSONObject("payoutSummary")?.let {
                ApprovalPayout(
                    it.str("label"), it.str("accountHolder"), it.str("accountNumber"),
                    it.str("accountNumberMasked"), it.flexBool("isVerified"), it.str("status"),
                )
            }
            val payload = o.optJSONObject("payloadSnapshot")?.let {
                ApprovalPayload(
                    it.str("kind"), it.str("startDate"), it.str("endDate"),
                    it.flexInt("startMinutes"), it.flexInt("endMinutes"), it.flexInt("days"),
                    it.str("employeeId"), it.str("periodYm"),
                    it.flexInt("currentAmount"), it.flexInt("proposedAmount"),
                    it.optJSONArray("reversals")?.length(),
                )
            }
            // Last resolved audit source (telegram / attendance / erp) — the web's "via …".
            val auditSource = o.optJSONArray("auditHistory")?.let { arr ->
                var found: String? = null
                for (i in arr.length() - 1 downTo 0) {
                    val e = arr.optJSONObject(i) ?: continue
                    val action = e.str("action")
                    if (action == "APPROVED" || action == "REJECTED") {
                        found = e.str("source"); break
                    }
                }
                found
            }
            return AlmaApproval(
                id = id,
                module = o.str("module"),
                type = o.str("type"),
                businessId = o.str("businessId"),
                entityId = o.str("entityId"),
                entityLabel = o.str("entityLabel"),
                status = o.str("status") ?: "PENDING",
                priority = o.str("priority"),
                reason = o.str("reason"),
                actionUrl = o.str("actionUrl"),
                createdAt = o.str("createdAt"),
                businessName = o.str("businessName"),
                executable = o.flexBool("executable"),
                linkageStatus = o.str("linkageStatus"),
                sourceStatus = o.str("sourceStatus"),
                requestedBy = o.str("requestedBy"),
                requester = req,
                payoutSummary = payout,
                payload = payload,
                auditSource = auditSource,
            )
        }
    }
}

data class AlmaAgentAction(
    val id: String,
    val type: String?,
    val status: String?,
    val summary: String?,
    val costEstimate: Int?,
    val createdAt: String?,
    val expired: Boolean?,
) {
    val typeLabel: String
        get() = when (type) {
            "agent_voice_call" -> "Voice call (two-way)"
            "outbound_call" -> "Voice call (one-way)"
            "dispatch_staff_tasks" -> "Dispatch tasks"
            else -> (type ?: "—").replace("_", " ")
        }

    companion object {
        fun from(o: JSONObject): AlmaAgentAction? {
            val id = o.str("id") ?: return null
            return AlmaAgentAction(
                id, o.str("type"), o.str("status"), o.str("summary"),
                o.flexInt("costEstimate"), o.str("createdAt"), o.flexBool("expired"),
            )
        }
    }
}

data class IntegrityReport(
    val scanned: Int,
    val pendingWaivers: Int,
    val walletOrphans: Int,
    val penaltyOrphans: Int,
    val orphans: List<Triple<String?, String?, String?>>, // kind, approvalId, waiverId
)

// ── State holder (iOS ApprovalsVM twin) ────────────────────────────────────────────

class ApprovalsState {
    var approvals by mutableStateOf(listOf<AlmaApproval>())
    var totalPending by mutableStateOf(0)
    var byModule by mutableStateOf(listOf<Pair<String, Int>>())
    var priorityCounts by mutableStateOf(mapOf<String, Int>())
    var statusFilter by mutableStateOf("PENDING")
    var loading by mutableStateOf(false)
    var busyIds by mutableStateOf(setOf<String>())
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    var showIntegrity by mutableStateOf(false)
    var integrity by mutableStateOf<IntegrityReport?>(null)
    var integrityLoading by mutableStateOf(false)
    var repairing by mutableStateOf(false)

    var agentActions by mutableStateOf(listOf<AlmaAgentAction>())
    var agentFilter by mutableStateOf("pending")
    var agentLoading by mutableStateOf(false)
    var agentBusyId by mutableStateOf<String?>(null)
    var agentNotice by mutableStateOf<String?>(null)
    var agentError by mutableStateOf<String?>(null)

    /** The approvals routes wrap payloads via apiDataSuccess → {ok, data:{…}} — unwrap both shapes. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/approvals", mapOf("status" to statusFilter, "limit" to "80")))
            approvals = c.optJSONArray("approvals")?.mapObjects { AlmaApproval.from(it) } ?: emptyList()
            totalPending = c.flexInt("totalPending") ?: 0
            byModule = c.optJSONArray("byModule")?.mapObjects { m ->
                m.str("module")?.let { it to (m.flexInt("count") ?: 0) }
            } ?: emptyList()
            priorityCounts = (
                c.optJSONArray("byPriority")?.mapObjects { p ->
                    p.str("priority")?.let { it to (p.flexInt("count") ?: 0) }
                } ?: emptyList()
                ).toMap()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** APPROVE/REJECT one item — same PATCH body the web tracker sends. */
    suspend fun act(approval: AlmaApproval, action: String, note: String = "", transactionId: String? = null) {
        if (approval.id in busyIds) return
        busyIds = busyIds + approval.id
        notice = null
        try {
            val body = JSONObject()
                .put("action", action)
                .put("note", note)
                .put("operation_id", "android-${UUID.randomUUID().toString().lowercase()}")
            if (!transactionId.isNullOrEmpty()) body.put("transactionId", transactionId)
            val resp = AlmaApi.send("PATCH", "/api/approvals/${approval.id}", body)
            val data = resp.optJSONObject("data") ?: resp
            notice = when {
                data.flexBool("reconciled") == true ->
                    data.str("warning") ?: "Approval synced with existing decision"
                else -> data.str("warning")
                    ?: (if (action == "APPROVE") "Approval committed" else "Rejection committed")
            }
            approvals = approvals.filter { it.id != approval.id }
            totalPending = maxOf(0, totalPending - 1)
            load()
        } catch (e: Exception) {
            error = e.message
        } finally {
            busyIds = busyIds - approval.id
        }
    }

    suspend fun loadIntegrity() {
        integrityLoading = true
        try {
            val c = unwrap(AlmaApi.getObject("/api/approvals/integrity"))
            integrity = IntegrityReport(
                scanned = c.flexInt("scanned") ?: 0,
                pendingWaivers = c.flexInt("pendingWaivers") ?: 0,
                walletOrphans = c.optJSONArray("walletOrphans")?.length() ?: 0,
                penaltyOrphans = (c.optJSONArray("penaltyApprovalOrphans")?.length() ?: 0) +
                    (c.optJSONArray("penaltyWaiverOrphans")?.length() ?: 0),
                orphans = c.optJSONArray("orphans")?.mapObjects {
                    Triple(it.str("kind"), it.str("approvalId"), it.str("waiverId"))
                } ?: emptyList(),
            )
        } catch (e: Exception) {
            error = "Integrity scan failed"
        } finally {
            integrityLoading = false
        }
    }

    suspend fun repairIntegrity() {
        repairing = true
        try {
            val resp = AlmaApi.send("POST", "/api/approvals/integrity", JSONObject())
            val data = resp.optJSONObject("data") ?: resp
            notice = "Repaired ${data.optJSONArray("repaired")?.length() ?: 0} item(s)"
            loadIntegrity()
            load()
        } catch (e: Exception) {
            error = e.message
        } finally {
            repairing = false
        }
    }

    suspend fun loadAgent() {
        agentLoading = true
        agentError = null
        try {
            val c = unwrap(AlmaApi.getObject("/api/assistant/actions", mapOf("status" to agentFilter, "limit" to "50")))
            agentActions = c.optJSONArray("actions")?.mapObjects { AlmaAgentAction.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            agentError = "তালিকা লোড করা যায়নি।"
        } finally {
            agentLoading = false
        }
    }

    suspend fun agentAct(action: AlmaAgentAction, kind: String) {
        agentBusyId = action.id
        agentNotice = null
        try {
            AlmaApi.send("POST", "/api/assistant/actions/${action.id}/$kind", JSONObject())
            agentNotice = if (kind == "approve") "✓ অনুমোদিত হয়েছে।" else "✓ বাতিল করা হয়েছে।"
        } catch (e: AlmaApiException.Http) {
            // Same wording the web tab shows for these two server verdicts.
            agentNotice = when (e.status) {
                410 -> "অনুমোদনের সময় শেষ — কার্ডটি মেয়াদোত্তীর্ণ।"
                409 -> "এই অ্যাকশনটি ইতিমধ্যে সম্পন্ন হয়েছে।"
                else -> if (kind == "approve") "অনুমোদন ব্যর্থ হয়েছে।" else "বাতিল ব্যর্থ হয়েছে।"
            }
        } catch (e: Exception) {
            agentNotice = "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।"
        } finally {
            agentBusyId = null
        }
        loadAgent()
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { ApprovalsState() }
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf("business") }
    var selected by remember { mutableStateOf<AlmaApproval?>(null) }
    var rejecting by remember { mutableStateOf<AlmaApproval?>(null) }
    var withdrawing by remember { mutableStateOf<AlmaApproval?>(null) }
    var confirmRepair by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    // Wallet withdrawals need a transaction id first (SMS to staff) — web modal parity.
    fun requestApprove(ap: AlmaApproval) {
        selected = null
        if (ap.type == "WALLET_WITHDRAWAL") withdrawing = ap
        else scope.launch { vm.act(ap, "APPROVE") }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // View toggle (web header: Business | Agent) + pending badge.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ApprovalChip("Business", view == "business", dark) {
                    view = "business"; scope.launch { vm.load() }
                }
                ApprovalChip("Agent", view == "agent", dark) {
                    view = "agent"; scope.launch { vm.loadAgent() }
                }
                Spacer(Modifier.weight(1f))
                if (vm.totalPending > 0) {
                    Text(
                        "${vm.totalPending}",
                        color = ApprovalPalette.accentText(dark),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .background(ApprovalPalette.coral.copy(alpha = 0.18f), CircleShape)
                            .border(1.dp, ApprovalPalette.coral.copy(alpha = 0.4f), CircleShape)
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }
        if (vm.authExpired) {
            item { AuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        if (view == "business") {
            vm.error?.let { item { NoticeCard(it, ApprovalPalette.red500, dark) } }
            vm.notice?.let { item { NoticeCard(it, ApprovalPalette.emerald600, dark) } }

            item {
                // Status filter chips + Integrity toggle.
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("PENDING", "APPROVED", "REJECTED", "ALL").forEach { s ->
                        ApprovalChip(
                            if (s == "ALL") "All" else s.lowercase().replaceFirstChar { it.uppercase() },
                            vm.statusFilter == s, dark,
                        ) {
                            vm.statusFilter = s
                            scope.launch { vm.load() }
                        }
                    }
                    ApprovalChip("Integrity", vm.showIntegrity, dark) {
                        vm.showIntegrity = !vm.showIntegrity
                        if (vm.showIntegrity && vm.integrity == null) scope.launch { vm.loadIntegrity() }
                    }
                }
            }

            if (vm.showIntegrity) {
                item { IntegrityCard(vm, dark, scope) { confirmRepair = true } }
            }

            item {
                // KPI strip — the web's 5 KpiCards with exact value colours.
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    KpiCard("PENDING", vm.totalPending, ApprovalPalette.goldLt, dark)
                    KpiCard("CRITICAL", vm.priorityCounts["CRITICAL"] ?: 0, ApprovalPalette.red500, dark)
                    KpiCard("HIGH", vm.priorityCounts["HIGH"] ?: 0, ApprovalPalette.amber600, dark)
                    KpiCard("NORMAL", vm.priorityCounts["NORMAL"] ?: 0, AlmaTheme.ink(dark), dark)
                    KpiCard("LOW", vm.priorityCounts["LOW"] ?: 0, AlmaTheme.ink(dark), dark)
                }
            }

            if (vm.loading && vm.approvals.isEmpty()) {
                items(4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            }

            items(vm.approvals, key = { it.id }) { ap ->
                ApprovalCard(
                    ap, dark,
                    busy = ap.id in vm.busyIds,
                    showStatusLine = vm.statusFilter != "PENDING",
                    onTap = { selected = ap },
                    onApprove = { requestApprove(ap) },
                    onReject = { rejecting = ap },
                )
            }

            if (!vm.loading && vm.approvals.isEmpty() && vm.error == null && !vm.authExpired) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 70.dp, bottom = 30.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text("✅", fontSize = 34.sp)
                        Text(
                            if (vm.statusFilter == "PENDING") "সব অনুমোদন সম্পন্ন ✅" else "কিছু নেই",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp,
                        )
                    }
                }
            }

            if (vm.byModule.isNotEmpty()) {
                item { ModuleSummary(vm.byModule, dark) }
            }

            item {
                Text(
                    "🌐 ওয়েব ভার্সন",
                    color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/approvals", "Approvals") }
                        .padding(vertical = 4.dp),
                )
            }
        } else {
            // ── Agent view ──
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ApprovalChip("Pending", vm.agentFilter == "pending", dark) {
                        vm.agentFilter = "pending"; scope.launch { vm.loadAgent() }
                    }
                    ApprovalChip("All", vm.agentFilter == "all", dark) {
                        vm.agentFilter = "all"; scope.launch { vm.loadAgent() }
                    }
                    Spacer(Modifier.weight(1f))
                    Box(
                        Modifier.size(34.dp).almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick { scope.launch { vm.loadAgent() } },
                        contentAlignment = Alignment.Center,
                    ) { Text("↻", color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp) }
                }
            }
            vm.agentNotice?.let { item { NoticeCard(it, AlmaTheme.inkSecondary(dark), dark) } }
            vm.agentError?.let { item { NoticeCard(it, ApprovalPalette.red500, dark) } }
            if (vm.agentLoading && vm.agentActions.isEmpty()) {
                items(4) { Box(Modifier.fillMaxWidth().height(120.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            }
            items(vm.agentActions, key = { it.id }) { action ->
                AgentActionCard(
                    action, dark,
                    busy = vm.agentBusyId == action.id,
                    onApprove = { scope.launch { vm.agentAct(action, "approve") } },
                    onReject = { scope.launch { vm.agentAct(action, "reject") } },
                )
            }
            if (!vm.agentLoading && vm.agentActions.isEmpty() && vm.agentError == null) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 60.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("🤖", fontSize = 34.sp)
                        Text(
                            if (vm.agentFilter == "pending") "কোনো অপেক্ষমাণ অ্যাকশন নেই" else "কোনো অ্যাকশন নেই",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp,
                        )
                        Text(
                            "এজেন্ট কোনো অনুমোদনের অনুরোধ পাঠালে এখানে দেখা যাবে।",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        )
                    }
                }
            }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }

    selected?.let { ap ->
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            ApprovalDetailSheet(
                ap, dark,
                busy = ap.id in vm.busyIds,
                onApprove = { requestApprove(ap) },
                onReject = { selected = null; rejecting = ap },
                openWeb = { p, t -> selected = null; ctx.openWebForced(p, t) },
            )
        }
    }

    rejecting?.let { ap ->
        ModalBottomSheet(onDismissRequest = { rejecting = null }, containerColor = AlmaTheme.rootBg(dark)) {
            RejectNoteSheet(ap, dark) { note ->
                rejecting = null
                scope.launch { vm.act(ap, "REJECT", note = note) }
            }
        }
    }

    withdrawing?.let { ap ->
        ModalBottomSheet(onDismissRequest = { withdrawing = null }, containerColor = AlmaTheme.rootBg(dark)) {
            WithdrawTxnSheet(ap, dark) { txn ->
                withdrawing = null
                scope.launch { vm.act(ap, "APPROVE", transactionId = txn) }
            }
        }
    }

    if (confirmRepair) {
        AlertDialog(
            onDismissRequest = { confirmRepair = false },
            title = { Text("অরফান রেকর্ডগুলো ঠিক করবেন?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRepair = false
                    scope.launch { vm.repairIntegrity() }
                }) { Text("হ্যাঁ, Repair চালাও") }
            },
            dismissButton = { TextButton(onClick = { confirmRepair = false }) { Text("বাতিল") } },
        )
    }
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

@Composable
private fun ApprovalChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) ApprovalPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) ApprovalPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) ApprovalPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun NoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun AuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(ApprovalPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun KpiCard(label: String, value: Int, tint: Color, dark: Boolean) {
    Column(
        Modifier.widthIn(min = 84.dp).almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    ) {
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text("$value", color = tint, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun IntegrityCard(
    vm: ApprovalsState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
    onRepair: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(ApprovalPalette.amber500.copy(alpha = 0.08f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .border(1.dp, ApprovalPalette.amber500.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CARD.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Integrity Monitor", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(
                "Detects orphan approvals, hidden penalty appeals, and stale pending rows.",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
            )
        }
        vm.integrity?.let { r ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                IntegrityStat("Scanned", r.scanned, dark)
                IntegrityStat("Waivers", r.pendingWaivers, dark)
                IntegrityStat("Wallet", r.walletOrphans, dark, warn = r.walletOrphans > 0)
                IntegrityStat("Penalty", r.penaltyOrphans, dark, warn = r.penaltyOrphans > 0)
            }
            if (r.orphans.isEmpty() && !vm.integrityLoading) {
                Text(
                    "No linkage issues detected in scan window.",
                    color = ApprovalPalette.emerald600, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                )
            } else {
                r.orphans.take(8).forEach { (kind, approvalId, waiverId) ->
                    Text(
                        buildString {
                            append((kind ?: "").replace("_", " "))
                            approvalId?.let { append(" · approval ${it.take(8)}…") }
                            waiverId?.let { append(" · waiver ${it.take(8)}…") }
                        },
                        color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                    )
                }
            }
        }
        if (vm.integrityLoading || vm.repairing) {
            Box(Modifier.fillMaxWidth().padding(vertical = 7.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = ApprovalPalette.amber600, strokeWidth = 2.dp)
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Scan",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                        .border(1.dp, AlmaTheme.ink(dark).copy(alpha = 0.15f), CircleShape)
                        .plainClick { scope.launch { vm.loadIntegrity() } }
                        .padding(vertical = 8.dp),
                )
                val repairCount = vm.integrity?.orphans?.size ?: 0
                Text(
                    "Repair ($repairCount)",
                    color = ApprovalPalette.accentText(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .background(ApprovalPalette.coral.copy(alpha = 0.13f), CircleShape)
                        .border(1.dp, ApprovalPalette.coral.copy(alpha = 0.35f), CircleShape)
                        .plainClick { if (repairCount > 0) onRepair() }
                        .padding(vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun IntegrityStat(label: String, value: Int, dark: Boolean, warn: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold)
        Text(
            "$value",
            color = if (warn) ApprovalPalette.amber600 else AlmaTheme.ink(dark),
            fontSize = 14.sp, fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ModuleSummary(byModule: List<Pair<String, Int>>, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "PENDING BY MODULE",
            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
        )
        byModule.forEach { (module, count) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    module.replace("_", " "),
                    color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "$count",
                    color = ApprovalPalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(ApprovalPalette.coral.copy(alpha = 0.14f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
    }
}

// ── Row card (mirrors one web table row / mobile card) ─────────────────────────────

@Composable
private fun ApprovalCard(
    ap: AlmaApproval,
    dark: Boolean,
    busy: Boolean,
    showStatusLine: Boolean,
    onTap: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row {
            Text(
                (ap.type ?: "—").replace("_", " "),
                color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            ap.priority?.let { p ->
                Text(p, color = ApprovalPalette.priority(p, dark), fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
        }
        Text(metaLine(ap), color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)

        RequesterLine(ap, dark)

        if (ap.type == "SALARY_CORRECTION" && ap.payload != null) {
            SalaryCorrectionDigest(ap.payload, dark)
        } else {
            (ap.entityLabel ?: ap.entityId)?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            if (ap.type == "ATTENDANCE_LEAVE" && ap.payload != null) LeaveInfoBox(ap.payload, dark)
            ap.reason?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }

        if (ap.type in setOf("WALLET_ADVANCE", "WALLET_WITHDRAWAL", "SALARY_ADVANCE")) {
            PayoutSummaryBox(ap.payoutSummary, dark)
        }

        // Linkage warnings (web parity).
        when (ap.linkageStatus) {
            "orphan_source_already_resolved" -> Text(
                "Payroll already ${ap.sourceStatus ?: "resolved"} — reject will sync queue",
                color = ApprovalPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
            "orphan_missing_source" -> Text(
                "Source record missing",
                color = ApprovalPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
            "orphan_missing_approval" -> Text(
                "Central approval missing — run Integrity repair",
                color = ApprovalPalette.red500, fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (showStatusLine) {
                Text(ap.status, color = ApprovalPalette.status(ap.status), fontSize = 11.sp, fontWeight = FontWeight.Black)
            }
            ap.auditSource?.takeIf { it.isNotEmpty() }?.let {
                Text("VIA ${it.uppercase()}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.weight(1f))
            if (ap.status == "PENDING" && ap.executable == false) {
                Text("Manual review", color = ApprovalPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }

        if (ap.status == "PENDING") {
            // ONE spinner per row, never a global overlay.
            if (busy) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 9.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(15.dp), color = ApprovalPalette.coral, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Processing…", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (ap.executable != false) {
                        ActionChipButton("✓ Approve", ApprovalPalette.coral, ApprovalPalette.accentText(dark), Modifier.weight(1f), onApprove)
                    }
                    ActionChipButton("✕ Reject", ApprovalPalette.red500, ApprovalPalette.red500, Modifier.weight(1f), onReject)
                }
            }
        }
    }
}

private fun metaLine(ap: AlmaApproval): String {
    val bits = mutableListOf<String>()
    ap.module?.let { bits.add(it.replace("_", " ")) }
    bits.add(ap.businessName ?: ap.businessId ?: "Global")
    ApprovalFormat.dateTime(ap.createdAt)?.let(bits::add)
    return bits.joinToString(" · ")
}

@Composable
private fun RequesterLine(ap: AlmaApproval, dark: Boolean) {
    val name = ap.requester?.name ?: ap.requestedBy ?: "—"
    val role = (ap.requester?.role ?: "Requester").replace("_", " ")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier
                .size(30.dp)
                .background(ApprovalPalette.coral.copy(alpha = 0.16f), CircleShape)
                .border(1.dp, ApprovalPalette.coral.copy(alpha = 0.35f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                ApprovalFormat.initials(name),
                color = ApprovalPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
        }
        Column {
            Text(name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(role, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun ActionChipButton(label: String, tint: Color, text: Color, modifier: Modifier, onClick: () -> Unit) {
    Text(
        label,
        color = text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
        modifier = modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick)
            .padding(vertical = 9.dp),
    )
}

// ── Leave / payout / salary blocks (web component parity) ──────────────────────────

@Composable
private fun LeaveInfoBox(p: ApprovalPayload, dark: Boolean) {
    if (p.startDate == null && p.kind == null) return
    val range = p.startDate?.let { s ->
        if (p.endDate != null && p.endDate != s) "$s – ${p.endDate}" else s
    }
    val duration = when (p.kind) {
        "HOURS" -> "⏰ ${ApprovalFormat.leaveTime(p.startMinutes)} – ${ApprovalFormat.leaveTime(p.endMinutes)} (ঘণ্টাভিত্তিক ছুটি)"
        "SHIFTED_START" -> "⏰ ${ApprovalFormat.leaveTime(p.startMinutes)} থেকে দেরিতে শুরু"
        else -> "🗓️ ${p.days ?: 1} দিন" + if (p.kind == "DATE_RANGE") " (কয়েকদিন)" else ""
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(ApprovalPalette.amber500.copy(alpha = 0.07f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, ApprovalPalette.amber500.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        range?.takeIf { it.isNotEmpty() }?.let {
            Text("📅 $it", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Text(duration, color = ApprovalPalette.amber500, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun PayoutSummaryBox(payout: ApprovalPayout?, dark: Boolean) {
    if (payout == null || payout.status == "MISSING") {
        Text(
            "No payout method on file",
            color = ApprovalPalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier
                .fillMaxWidth()
                .background(ApprovalPalette.amber500.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, ApprovalPalette.amber500.copy(alpha = 0.30f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
    } else {
        Column(
            Modifier
                .fillMaxWidth()
                .background(ApprovalPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .border(1.dp, ApprovalPalette.coral.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text("PREFERRED PAYOUT", color = ApprovalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
            payout.label?.let { Text(it, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold) }
            payout.accountHolder?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp) }
            Text(
                payout.accountNumber ?: payout.accountNumberMasked ?: "—",
                color = ApprovalPalette.accentText(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
            )
            Text(
                if (payout.isVerified == true) "Verified" else "Not verified",
                color = if (payout.isVerified == true) ApprovalPalette.green400 else ApprovalPalette.amber600,
                fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun SalaryCorrectionDigest(p: ApprovalPayload, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(ApprovalPalette.coral.copy(alpha = 0.05f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .border(1.dp, ApprovalPalette.goldDim.copy(alpha = 0.25f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("SALARY CORRECTION", color = ApprovalPalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(
            "${p.employeeId ?: "—"} · ${p.periodYm ?: "—"}",
            color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
        )
        if (p.currentAmount != null && p.proposedAmount != null) {
            val delta = p.proposedAmount - p.currentAmount
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "${AlmaTheme.taka(p.currentAmount)} → ${AlmaTheme.taka(p.proposedAmount)}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontFamily = FontFamily.Monospace,
                )
                Text(
                    "(${if (delta >= 0) "+" else "−"}${AlmaTheme.taka(kotlin.math.abs(delta)).removePrefix("-")})",
                    color = if (delta >= 0) ApprovalPalette.green400 else ApprovalPalette.red400,
                    fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                )
            }
        }
        p.reversalCount?.takeIf { it > 0 }?.let {
            Text("$it reversal${if (it == 1) "" else "s"}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

// ── Agent action card (gradient icon badge · 5-line clamp with expand) ─────────────

@Composable
private fun AgentActionCard(
    action: AlmaAgentAction,
    dark: Boolean,
    busy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val isPending = action.status == "pending"
    // Dispatch briefs run hundreds of Bangla lines — clamp unless the owner expands.
    val isLong = (action.summary ?: "").length > 220

    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier
                    .size(34.dp)
                    .background(
                        Brush.linearGradient(listOf(ApprovalPalette.coral, AlmaTheme.violet)),
                        RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    when (action.type) {
                        "agent_voice_call" -> "📞"
                        "outbound_call" -> "📤"
                        "dispatch_staff_tasks" -> "📋"
                        else -> "✨"
                    },
                    fontSize = 15.sp,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(action.typeLabel, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(ApprovalFormat.timeAgo(action.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                    if (!isPending) {
                        Text(
                            (action.status ?: "").uppercase(),
                            color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(AlmaTheme.ink(dark).copy(alpha = 0.06f), CircleShape)
                                .padding(horizontal = 5.dp, vertical = 1.5.dp),
                        )
                    }
                    if (action.expired == true && isPending) {
                        Text(
                            "মেয়াদ শেষ",
                            color = ApprovalPalette.red500, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .background(ApprovalPalette.red500.copy(alpha = 0.12f), CircleShape)
                                .padding(horizontal = 5.dp, vertical = 1.5.dp),
                        )
                    }
                }
            }
            action.costEstimate?.takeIf { it > 0 }?.let { cost ->
                Text(
                    AlmaTheme.taka(cost),
                    color = ApprovalPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(ApprovalPalette.coral.copy(alpha = 0.12f), CircleShape)
                        .border(0.8.dp, ApprovalPalette.coral.copy(alpha = 0.30f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                action.summary ?: "বিস্তারিত নেই",
                color = AlmaTheme.ink(dark).copy(alpha = 0.85f),
                fontSize = 12.sp, lineHeight = 17.sp,
                maxLines = if (expanded || !isLong) Int.MAX_VALUE else 5,
                overflow = TextOverflow.Ellipsis,
            )
            if (isLong) {
                Text(
                    if (expanded) "কম দেখান ▲" else "আরো দেখুন ▼",
                    color = ApprovalPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.plainClick { expanded = !expanded },
                )
            }
        }

        if (isPending) {
            if (busy) {
                Box(Modifier.fillMaxWidth().padding(vertical = 7.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(15.dp), color = ApprovalPalette.coral, strokeWidth = 2.dp)
                }
            } else if (action.expired == true) {
                // Expired: only "সরান" (clear) — hits reject, server marks expired.
                ActionChipButton("🗑 সরান", AlmaTheme.inkSecondary(dark), AlmaTheme.inkSecondary(dark), Modifier.fillMaxWidth(), onReject)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionChipButton("✓ Approve", ApprovalPalette.coral, ApprovalPalette.accentText(dark), Modifier.weight(1f), onApprove)
                    ActionChipButton("✕ Reject", ApprovalPalette.red500, ApprovalPalette.red500, Modifier.weight(1f), onReject)
                }
            }
        }
    }
}

// ── Detail sheet (web "View Details" modal parity) ─────────────────────────────────

@Composable
private fun ApprovalDetailSheet(
    ap: AlmaApproval,
    dark: Boolean,
    busy: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                (ap.type ?: "—").replace("_", " "),
                color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(
                "${ap.module ?: "—"} · ${ApprovalFormat.dateTime(ap.createdAt) ?: "—"}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
        }

        Row(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val name = ap.requester?.name ?: ap.requestedBy ?: "—"
            Box(
                Modifier
                    .size(42.dp)
                    .background(ApprovalPalette.coral.copy(alpha = 0.16f), CircleShape)
                    .border(1.dp, ApprovalPalette.coral.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(ApprovalFormat.initials(name), color = ApprovalPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Text(
                    (ap.requester?.role ?: "Requester").replace("_", " "),
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                )
            }
        }

        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            DetailRow("Status", ap.status, ApprovalPalette.status(ap.status), dark)
            DetailRow("Priority", ap.priority ?: "—", ApprovalPalette.priority(ap.priority, dark), dark)
            DetailRow("Business", ap.businessName ?: ap.businessId ?: "Global", AlmaTheme.ink(dark), dark)
            if (ap.type == "SALARY_CORRECTION" && ap.payload != null) {
                SalaryCorrectionDigest(ap.payload, dark)
            } else {
                DetailRow("Entity / account affected", ap.entityLabel ?: ap.entityId ?: "—", AlmaTheme.ink(dark), dark)
                if (ap.type == "ATTENDANCE_LEAVE" && ap.payload != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("ছুটির সময়কাল", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
                        LeaveInfoBox(ap.payload, dark)
                    }
                }
                DetailRow("Reason", ap.reason ?: "—", AlmaTheme.ink(dark), dark)
            }
            if (ap.type in setOf("WALLET_ADVANCE", "WALLET_WITHDRAWAL", "SALARY_ADVANCE")) {
                PayoutSummaryBox(ap.payoutSummary, dark)
            }
        }

        if (ap.status == "PENDING") {
            if (busy) {
                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = ApprovalPalette.coral, strokeWidth = 2.dp)
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (ap.executable != false) {
                        Text(
                            "✓ Approve",
                            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(ApprovalPalette.coral, RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                                .plainClick(onApprove)
                                .padding(vertical = 11.dp),
                        )
                    }
                    Text(
                        "✕ Reject",
                        color = ApprovalPalette.red500, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .almaGlass(dark, AlmaTheme.R_CONTROL)
                            .plainClick(onReject)
                            .padding(vertical = 11.dp),
                    )
                    if (ap.executable == false) {
                        Text("Manual review", color = ApprovalPalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        Text(
            if (ap.actionUrl != null) "🌐 Open related record" else "🌐 সব অপশন — ওয়েবে খুলুন",
            color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .plainClick { openWeb(ap.actionUrl ?: "/approvals", "Approvals") }
                .padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun DetailRow(label: String, value: String, color: Color, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        Text(value, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Reject / withdraw sheets (web modal parity) ────────────────────────────────────

@Composable
private fun RejectNoteSheet(ap: AlmaApproval, dark: Boolean, onConfirm: (String) -> Unit) {
    var note by remember { mutableStateOf("") }
    val trimmed = note.trim()

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Reject Approval", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "${(ap.type ?: "—").replace("_", " ")} · ${ap.requester?.name ?: ap.requestedBy ?: "—"}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            placeholder = { Text("Rejection reason required (min. 5 characters)") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            if (trimmed.length < 5) "${5 - trimmed.length} more character(s) required"
            else "Reason will be stored on the approval record.",
            color = if (trimmed.length < 5) ApprovalPalette.amber600 else AlmaTheme.inkSecondary(dark),
            fontSize = 11.sp,
        )
        Text(
            "Reject request",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    if (trimmed.length >= 5) ApprovalPalette.red500 else ApprovalPalette.red500.copy(alpha = 0.4f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (trimmed.length >= 5) onConfirm(trimmed) }
                .padding(vertical = 11.dp),
        )
    }
}

@Composable
private fun WithdrawTxnSheet(ap: AlmaApproval, dark: Boolean, onConfirm: (String) -> Unit) {
    var txn by remember { mutableStateOf("") }
    val trimmed = txn.trim()

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Approve withdrawal", color = AlmaTheme.ink(dark), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "${ap.requester?.name ?: ap.requestedBy ?: "—"} · ${ap.businessName ?: ap.businessId ?: "Global"}",
            color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
        )
        Text("TRANSACTION ID", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Black)
        OutlinedTextField(
            value = txn,
            onValueChange = { txn = it },
            placeholder = { Text("যে নম্বর/ID থেকে টাকা পাঠালেন") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            if (trimmed.isEmpty()) "Transaction ID আবশ্যক" else "এই ID সহ staff-কে SMS পাঠানো হবে।",
            color = if (trimmed.isEmpty()) ApprovalPalette.amber600 else AlmaTheme.inkSecondary(dark),
            fontSize = 11.sp,
        )
        Text(
            "Confirm approval",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    if (trimmed.isNotEmpty()) ApprovalPalette.coral else ApprovalPalette.coral.copy(alpha = 0.4f),
                    RoundedCornerShape(AlmaTheme.R_CONTROL.dp),
                )
                .plainClick { if (trimmed.isNotEmpty()) onConfirm(trimmed) }
                .padding(vertical = 11.dp),
        )
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object ApprovalFormat {
    /** createdAt → "5/7/2026, 8:50 PM" style (web toLocaleString), Asia/Dhaka. */
    fun dateTime(iso: String?): String? {
        val date = parse(iso) ?: return null
        val f = SimpleDateFormat("M/d/yyyy, h:mm a", Locale.US)
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

    /** Minutes-since-midnight → "2:00 PM" (web fmtLeaveTime). */
    fun leaveTime(minutes: Int?): String {
        val m = minutes ?: return ""
        val h = m / 60
        val mm = m % 60
        val ap = if (h >= 12) "PM" else "AM"
        val h12 = ((h + 11) % 12) + 1
        return "$h12:${String.format("%02d", mm)} $ap"
    }

    /** Bangla relative time — the web agent tab's exact strings. */
    fun timeAgo(iso: String?): String {
        val date = parse(iso) ?: return ""
        val mins = ((System.currentTimeMillis() - date.time) / 60_000).toInt()
        return when {
            mins < 1 -> "এইমাত্র"
            mins < 60 -> "$mins মিনিট আগে"
            mins < 24 * 60 -> "${mins / 60} ঘণ্টা আগে"
            else -> "${mins / (24 * 60)} দিন আগে"
        }
    }

    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }
}
