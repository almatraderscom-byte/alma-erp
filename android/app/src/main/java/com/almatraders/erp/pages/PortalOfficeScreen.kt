//
//  PortalOfficeScreen.kt
//  ALMA ERP — the Office tab (/portal/office), ported from PortalOfficeSwiftUI.swift (build 66).
//
//  Role-detected (GET /api/assistant/office/hub → {self}): the SAME tab shows the BOSS
//  dashboard to the owner and the staff office to employees. Same endpoints / Bangla / colours:
//    GET  /api/assistant/office/hub            → {self, hub?, staff?, motivation?} role + boss data
//    GET  /api/assistant/office/my-tasks       → today's open tasks {tasks:[{id,title,type,serial}]}
//    GET  /api/assistant/office/thread?taskId= → {task,comments,events}
//    POST /api/assistant/office/staff-action   → {action:'done'|'comment'|'update'|'self_create', …}
//    GET  /api/assistant/office/chat           → group feed {messages:[…]}
//    POST /api/assistant/office/chat           → send text {body, attachments:[]}
//    POST /api/assistant/office/chat/explain   → {taskId} agent explains a task
//    POST /api/assistant/office/chat/agent     → owner approve/dismiss agent draft
//    GET/POST /api/assistant/office/notifications → bell feed + mark read ({} all · {id} one)
//    POST /api/assistant/office/lunch          → {action:'start'|'end'} (45-min allowance)
//    POST /api/assistant/office/action         → owner task/proposal action
//    GET  /api/assistant/office/history        → past boards
//  Responses unwrap both flat and {ok,data:{…}} shapes.
//
//  DEFERRALS vs iOS build 66 (Android pass rule):
//   · The RICH staff office (getStaffOfficeData performer hero / proof upload) is a SEPARATE
//     page (PortalStaffOfficeScreen.kt) — staff role here renders the base my-tasks office.
//   · Chat image ATTACHMENTS + proof-photo submission = WEB ESCAPE (needs the file picker);
//     text send is native. Proof/chat images are shown inline (Coil) but tapping opens the web.
//   · Award manual selection (recompute/pin) = web escape.
//  Carried lessons: ONE spinner per action, never a global overlay. Chat sends don't confirm.
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.zIndex
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset as ChatHeadOffset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
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
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object OfficePalette {
    val coral = AlmaTheme.coral
    val violet = AlmaTheme.violet
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)

    /** The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora. */
    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Team member status dot: on green · lunch amber · else grey. */
    fun statusColor(s: String): Color = when (s) {
        "on" -> green400
        "lunch" -> amber500
        else -> Color.Gray
    }
}

private const val OFFICE_LUNCH_LIMIT_SEC = 45 * 60

/** A task where Boss requested an update — carries an absolute deadline for the live
 *  10-minute countdown (iOS UpdateAlertCard). */
private data class StaffUpdateReq(val id: String, val title: String, val note: String?, val deadlineMs: Long)

// ── Models (same field names the office routes return) ─────────────────────────────

/** One row of GET /api/assistant/office/my-tasks. */
private data class OfficeTask(val id: String, val title: String, val type: String?, val serial: Int?) {
    companion object {
        fun from(o: JSONObject) = OfficeTask(
            id = o.str("id") ?: "",
            title = o.str("title") ?: "—",
            type = o.str("type"),
            serial = o.flexInt("serial"),
        )
    }
}

/** One OfficeNotice row from the notifications feed (read is mutable in-place). */
private data class OfficeNotice(
    val id: String,
    val kind: String?,
    val title: String,
    val body: String?,
    var read: Boolean,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject) = OfficeNotice(
            id = o.str("id") ?: "",
            kind = o.str("kind"),
            title = o.str("title") ?: "—",
            body = o.str("body"),
            read = o.flexBool("read") ?: true,
            createdAt = o.str("createdAt"),
        )
    }
}

/** One comment row of GET /api/assistant/office/thread. */
private data class OfficeThreadMsg(val id: String, val authorType: String, val body: String, val createdAt: String?) {
    companion object {
        fun from(o: JSONObject) = OfficeThreadMsg(
            id = o.str("id") ?: "",
            authorType = o.str("authorType") ?: "staff",
            body = o.str("body") ?: "",
            createdAt = o.str("createdAt"),
        )
    }
}

/** One group-chat message — status=="pending" rows are owner-only agent drafts. */
private data class OfficeChatMsg(
    val id: String,
    val authorType: String,
    val authorName: String,
    val authorImageUrl: String?,
    val body: String,
    val imageURLs: List<String>,
    val status: String?,
    val isAgentReply: Boolean,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject): OfficeChatMsg {
            val atts = o.optJSONArray("attachments")?.mapObjects { it.str("url") } ?: emptyList()
            return OfficeChatMsg(
                id = o.str("id") ?: "",
                authorType = o.str("authorType") ?: "staff",
                authorName = o.str("authorName") ?: "—",
                authorImageUrl = o.str("authorImageUrl"),
                body = o.str("body") ?: "",
                imageURLs = atts.filter { it.startsWith("http") },
                status = o.str("status"),
                isAgentReply = o.flexBool("isAgentReply") ?: false,
                createdAt = o.str("createdAt"),
            )
        }
    }
}

/** Pull image URLs out of proofData: imageUrls[] first, then imageUrl/image/photo/url. */
private fun proofImageURLs(proof: JSONObject?): List<String> {
    if (proof == null) return emptyList()
    val urls = ArrayList<String>()
    proof.optJSONArray("imageUrls")?.let { arr ->
        for (i in 0 until arr.length()) (arr.opt(i) as? String)?.let { urls.add(it) }
    }
    for (k in listOf("imageUrl", "image", "photo", "url")) {
        proof.str(k)?.takeIf { it.isNotEmpty() }?.let { urls.add(it) }
    }
    val seen = HashSet<String>()
    return urls.filter { it.startsWith("http") && seen.add(it) }
}

/** GET /api/assistant/office/hub → hub task (owner board). proofData → imageUrls. */
private data class OfficeHubTask(
    val id: String,
    val title: String,
    val detail: String?,
    val type: String,
    val verificationStatus: String,
    val staffId: String,
    val staffName: String,
    val dueAt: String?,
    val needsOwner: Boolean,
    val alwaysEscalate: Boolean,
    val imageUrls: List<String>,
) {
    companion object {
        fun from(o: JSONObject) = OfficeHubTask(
            id = o.str("id") ?: "",
            title = o.str("title") ?: "—",
            detail = o.str("detail"),
            type = o.str("type") ?: "",
            verificationStatus = o.str("verificationStatus") ?: "",
            staffId = o.str("staffId") ?: "",
            staffName = o.str("staffName") ?: "অজানা",
            dueAt = o.str("dueAt"),
            needsOwner = o.flexBool("needsOwner") ?: false,
            alwaysEscalate = o.flexBool("alwaysEscalate") ?: false,
            imageUrls = proofImageURLs(o.optJSONObject("proofData")),
        )
    }
}

private data class OfficeAward(val staffName: String, val imageUrl: String?, val score: Int) {
    companion object {
        fun from(o: JSONObject) = OfficeAward(o.str("staffName") ?: "—", o.str("imageUrl"), o.flexInt("score") ?: 0)
    }
}

private data class OfficeAwardStats(val done: Int, val approvalRate: Int?, val avgQc: Int?, val selfInitiated: Int) {
    companion object {
        fun from(o: JSONObject) = OfficeAwardStats(
            o.flexInt("done") ?: 0, o.flexInt("approvalRate"), o.flexInt("avgQc"), o.flexInt("selfInitiated") ?: 0,
        )
    }
}

private data class OfficeTeamMember(
    val staffId: String, val name: String, val initial: String, val imageUrl: String?,
    val status: String, val sub: String, val doneToday: Int, val totalToday: Int, val checkedIn: Boolean,
) {
    companion object {
        fun from(o: JSONObject) = OfficeTeamMember(
            staffId = o.str("staffId") ?: "",
            name = o.str("name") ?: "—",
            initial = o.str("initial") ?: "?",
            imageUrl = o.str("imageUrl"),
            status = o.str("status") ?: "off",
            sub = o.str("sub") ?: "",
            doneToday = o.flexInt("doneToday") ?: 0,
            totalToday = o.flexInt("totalToday") ?: 0,
            checkedIn = o.flexBool("checkedIn") ?: false,
        )
    }
}

private data class OfficeLeader(val staffId: String, val name: String, val initial: String, val imageUrl: String?, val score: Int, val pct: Int) {
    companion object {
        fun from(o: JSONObject) = OfficeLeader(
            o.str("staffId") ?: "", o.str("name") ?: "—", o.str("initial") ?: "?",
            o.str("imageUrl"), o.flexInt("score") ?: 0, o.flexInt("pct") ?: 0,
        )
    }
}

private data class OfficePerf(val staffName: String, val done: Int, val onTimeRate: Int?, val redo: Int, val score: Int) {
    companion object {
        fun from(o: JSONObject) = OfficePerf(
            o.str("staffName") ?: "—", o.flexInt("done") ?: 0, o.flexInt("onTimeRate"),
            o.flexInt("redo") ?: 0, o.flexInt("score") ?: 0,
        )
    }
}

private data class OfficeProposal(val id: String, val staffName: String, val taskTitle: String?, val kind: String, val amount: Int?, val reason: String) {
    companion object {
        fun from(o: JSONObject) = OfficeProposal(
            o.str("id") ?: "", o.str("staffName") ?: "—", o.str("taskTitle"),
            o.str("kind") ?: "", o.flexInt("amount"), o.str("reason") ?: "",
        )
    }
}

/** The BOSS dashboard payload (getOwnerHubData). */
private class OfficeHub(
    val pending: Int, val active: Int, val doneToday: Int, val online: Int, val staffTotal: Int,
    val pendingApproval: List<OfficeHubTask>,
    val activeTasks: List<OfficeHubTask>,
    val doneTodayTasks: List<OfficeHubTask>,
    val selfInitiated: List<OfficeHubTask>,
    val award: OfficeAward?,
    val awardStats: OfficeAwardStats?,
    val team: List<OfficeTeamMember>,
    val leaderboard: List<OfficeLeader>,
    val performance: List<OfficePerf>,
    val proposals: List<OfficeProposal>,
) {
    companion object {
        fun from(o: JSONObject): OfficeHub {
            val k = o.optJSONObject("kpis") ?: JSONObject()
            fun list(key: String) = o.optJSONArray(key)?.mapObjects { OfficeHubTask.from(it) } ?: emptyList()
            return OfficeHub(
                pending = k.flexInt("pending") ?: 0,
                active = k.flexInt("active") ?: 0,
                doneToday = k.flexInt("doneToday") ?: 0,
                online = k.flexInt("online") ?: 0,
                staffTotal = k.flexInt("staffTotal") ?: 0,
                pendingApproval = list("pendingApproval"),
                activeTasks = list("activeTasks"),
                doneTodayTasks = list("doneTodayTasks"),
                selfInitiated = list("selfInitiated"),
                award = o.optJSONObject("award")?.let { OfficeAward.from(it) },
                awardStats = o.optJSONObject("awardStats")?.let { OfficeAwardStats.from(it) },
                team = o.optJSONArray("team")?.mapObjects { OfficeTeamMember.from(it) } ?: emptyList(),
                leaderboard = o.optJSONArray("leaderboard")?.mapObjects { OfficeLeader.from(it) } ?: emptyList(),
                performance = o.optJSONArray("performance")?.mapObjects { OfficePerf.from(it) } ?: emptyList(),
                proposals = o.optJSONArray("proposals")?.mapObjects { OfficeProposal.from(it) } ?: emptyList(),
            )
        }
    }
}

private data class OfficeArchiveDay(val date: String, val label: String, val total: Int, val done: Int, val approved: Int, val staffCount: Int) {
    companion object {
        fun from(o: JSONObject) = OfficeArchiveDay(
            date = o.str("date") ?: "",
            label = o.str("label") ?: (o.str("date") ?: ""),
            total = o.flexInt("total") ?: 0,
            done = o.flexInt("done") ?: 0,
            approved = o.flexInt("approved") ?: 0,
            staffCount = o.flexInt("staffCount") ?: 0,
        )
    }
}

// TEMP-PROOF sample (prod may lack /office/hub) so the boss dashboard can render. iOS parity.
private val OFFICE_SAMPLE_HUB = """
{"kpis":{"pending":2,"active":3,"overdue":1,"doneToday":6,"online":2,"staffTotal":3},
 "pendingApproval":[
   {"id":"t1","title":"১৩৩ কালেকশনের নতুন ছবি","type":"ফটোগ্রাফি","status":"awaiting_owner","verificationStatus":"proof_submitted","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":true,"redoCount":0,"source":"assigned","createdAt":"2026-07-07T04:00:00Z","proofData":{"imageUrls":["https://picsum.photos/seed/alma133a/700","https://picsum.photos/seed/alma133b/700"]}},
   {"id":"t2","title":"ফেসবুক পোস্টের ক্যাপশন","type":"কনটেন্ট","status":"awaiting_owner","verificationStatus":"auto_verified","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"redoCount":1,"source":"assigned","createdAt":"2026-07-07T03:00:00Z","proofData":{"imageUrl":"https://picsum.photos/seed/almafbpost/700"}}],
 "activeTasks":[
   {"id":"t3","title":"দুপুরের ডেলিভারি হ্যান্ডওভার","type":"সেলস","status":"active","verificationStatus":"in_progress","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","needsOwner":false,"createdAt":"2026-07-07T02:00:00Z","dueAt":"2026-07-07T12:00:00Z"},
   {"id":"a2","title":"২টা রিটার্ন অর্ডার ফলোআপ","type":"সাপোর্ট","status":"active","verificationStatus":"in_progress","staffId":"s2","staffName":"সাদিয়া","needsOwner":false,"createdAt":"2026-07-07T01:00:00Z"}],
 "doneTodayTasks":[
   {"id":"d1","title":"১৩৩ কালেকশনের ছবি তোলা","type":"ফটোগ্রাফি","status":"done","verificationStatus":"owner_approved","staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","createdAt":"2026-07-07T05:00:00Z"},
   {"id":"d3","title":"নতুন কাস্টমার মেসেজের রিপ্লাই","type":"সাপোর্ট","status":"done","verificationStatus":"owner_approved","staffId":"s2","staffName":"সাদিয়া","createdAt":"2026-07-07T05:20:00Z"}],
 "selfInitiated":[{"id":"t5","title":"দোকান গুছিয়ে রেখেছি","type":"অন্যান্য","status":"proposed","verificationStatus":"proposed","staffId":"s3","staffName":"রফিক","source":"staff_initiated","createdAt":"2026-07-07T05:00:00Z"}],
 "award":{"staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","imageUrl":null,"score":92,"auto":true},
 "awardStats":{"done":18,"approvalRate":94,"avgQc":88,"selfInitiated":3},
 "team":[
   {"staffId":"s1","name":"মোহাম্মদ ইয়াফি","initial":"M","imageUrl":null,"status":"on","sub":"অফিসে · চেক-ইন ৯:০৫ AM","doneToday":4,"totalToday":6,"checkedIn":true},
   {"staffId":"s2","name":"সাদিয়া","initial":"S","imageUrl":null,"status":"lunch","sub":"লাঞ্চে · ২৪ মিনিট বাকি","doneToday":2,"totalToday":5,"checkedIn":true},
   {"staffId":"s3","name":"রফিক","initial":"R","imageUrl":null,"status":"off","sub":"এখনো চেক-ইন করেননি","doneToday":0,"totalToday":3,"checkedIn":false}],
 "leaderboard":[
   {"staffId":"s1","name":"মোহাম্মদ ইয়াফি","initial":"M","imageUrl":null,"score":92,"pct":100},
   {"staffId":"s2","name":"সাদিয়া","initial":"S","imageUrl":null,"score":74,"pct":80},
   {"staffId":"s3","name":"রফিক","initial":"R","imageUrl":null,"score":51,"pct":55}],
 "performance":[
   {"staffId":"s1","staffName":"মোহাম্মদ ইয়াফি","assigned":22,"done":18,"onTimeRate":89,"redo":1,"score":92},
   {"staffId":"s2","staffName":"সাদিয়া","assigned":15,"done":11,"onTimeRate":73,"redo":3,"score":74}],
 "proposals":[{"id":"p1","staffId":"s2","staffName":"সাদিয়া","taskTitle":"কুরিয়ার বুকিং","kind":"penalty","amount":100,"reason":"বারবার আপডেট চাওয়ার পরও দেরি","createdAt":"2026-07-07T05:35:00Z"}]}
"""

// ── State holder (iOS PortalOfficeVM twin) ─────────────────────────────────────────

private class OfficeState {
    var roleResolved by mutableStateOf(false)
    var selfRole by mutableStateOf("")           // "owner" | "staff" | "none"
    var hub by mutableStateOf<OfficeHub?>(null)
    var isSampleData by mutableStateOf(false)
    var authExpired by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)

    var tasks by mutableStateOf(listOf<OfficeTask>())
    var unread by mutableStateOf(0)
    var notices by mutableStateOf(listOf<OfficeNotice>())
    var loading by mutableStateOf(false)

    // Lunch (45-min allowance, live countdown)
    var lunchActive by mutableStateOf(false)
    var lunchStartedAt by mutableStateOf<Long?>(null)   // epoch millis
    var lunchBusy by mutableStateOf(false)
    var markingRead by mutableStateOf(false)

    // Rich staff office (getStaffOfficeData: performer hero / motivation / check-in /
    // 10-min update-request countdown) — iOS PortalStaffOffice parity. Sourced from the
    // /office/hub `staff` + top-level `motivation`; display-only, layered over base tasks.
    var motivationText by mutableStateOf<String?>(null)
    var motivationTag by mutableStateOf<String?>(null)
    var isWinner by mutableStateOf(false)
    var award by mutableStateOf<OfficeAward?>(null)
    var staffName by mutableStateOf("")
    var checkedIn by mutableStateOf(false)
    var checkedOut by mutableStateOf(false)
    var checkInLabel by mutableStateOf<String?>(null)
    var todayDoneCount by mutableStateOf(0)
    var todayActiveCount by mutableStateOf(0)
    var updateRequests by mutableStateOf(listOf<StaffUpdateReq>())

    // Task detail thread
    var thread by mutableStateOf(listOf<OfficeThreadMsg>())
    var threadLoading by mutableStateOf(false)
    var actionBusyTaskId by mutableStateOf<String?>(null)
    var creatingSelf by mutableStateOf(false)

    // Group chat
    var chat by mutableStateOf(listOf<OfficeChatMsg>())
    var chatLoading by mutableStateOf(false)
    var chatSending by mutableStateOf(false)
    var explainingTaskId by mutableStateOf<String?>(null)
    var chatDecidingId by mutableStateOf<String?>(null)

    // Owner action spinners
    var ownerBusyId by mutableStateOf<String?>(null)
    var proposalBusyId by mutableStateOf<String?>(null)

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** First call decides the whole screen: owner → boss hub, staff → base office. */
    suspend fun loadHub() {
        loading = true
        error = null
        try {
            val env = unwrap(AlmaApi.getObject("/api/assistant/office/hub"))
            selfRole = env.str("self") ?: "none"
            hub = env.optJSONObject("hub")?.let { OfficeHub.from(it) }
            isSampleData = false
            roleResolved = true
            authExpired = false
            // Resume the 45-min lunch timer from the staff envelope's lunch sub-object.
            env.optJSONObject("staff")?.optJSONObject("lunch")?.let { l ->
                lunchActive = l.flexBool("active") ?: false
                lunchStartedAt = OfficeFormat.parseMs(l.str("startedAt"))
            }
            // Rich staff office layer (motivation / performer / check-in / update countdown).
            env.optJSONObject("motivation")?.let { m ->
                motivationText = m.str("text")?.takeIf { it.isNotBlank() }
                motivationTag = m.str("tag")
            }
            env.optJSONObject("staff")?.let { s ->
                staffName = s.str("staffName") ?: ""
                isWinner = s.flexBool("isWinner") ?: false
                award = s.optJSONObject("award")?.let { OfficeAward.from(it) }
                s.optJSONObject("attendance")?.let { a ->
                    checkedIn = a.flexBool("checkedIn") ?: false
                    checkedOut = a.flexBool("checkedOut") ?: false
                    checkInLabel = a.str("checkInLabel")
                }
                val active = s.optJSONArray("active")
                val done = s.optJSONArray("done")
                todayActiveCount = active?.length() ?: 0
                todayDoneCount = done?.length() ?: 0
                // Tasks where Boss asked for an update → live 10-min countdown alerts.
                val now = System.currentTimeMillis()
                updateRequests = active?.mapObjects { it }
                    ?.filter { it.flexBool("needsUpdate") == true }
                    ?.map {
                        StaffUpdateReq(
                            id = it.str("id") ?: "",
                            title = it.str("title") ?: "—",
                            note = it.str("updateNote"),
                            deadlineMs = now + (it.flexInt("updateSecondsLeft") ?: 0).coerceAtLeast(0) * 1000L,
                        )
                    } ?: emptyList()
            }
            if (selfRole == "staff") load()
            else if (selfRole == "owner") loadNotifsOnly()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true; roleResolved = true
        } catch (e: Exception) {
            // TEMP-PROOF: prod may lack /office/hub — show the boss dashboard with sample data.
            try {
                hub = OfficeHub.from(JSONObject(OFFICE_SAMPLE_HUB))
                selfRole = "owner"; isSampleData = true; roleResolved = true
            } catch (_: Exception) {
                error = e.message; roleResolved = true
            }
        } finally {
            loading = false
        }
    }

    /** Staff: my-tasks + notifications. */
    suspend fun load() {
        loading = true
        try {
            tasks = unwrap(AlmaApi.getObject("/api/assistant/office/my-tasks"))
                .optJSONArray("tasks")?.mapObjects { OfficeTask.from(it) } ?: emptyList()
            val feed = unwrap(AlmaApi.getObject("/api/assistant/office/notifications"))
            unread = feed.flexInt("unread") ?: 0
            notices = feed.optJSONArray("items")?.mapObjects { OfficeNotice.from(it) } ?: emptyList()
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** Owner's notifications (bell) — owner's my-tasks is staff-only. */
    suspend fun loadNotifsOnly() {
        try {
            val feed = unwrap(AlmaApi.getObject("/api/assistant/office/notifications"))
            unread = feed.flexInt("unread") ?: 0
            notices = feed.optJSONArray("items")?.mapObjects { OfficeNotice.from(it) } ?: emptyList()
        } catch (_: Exception) { /* best-effort */ }
    }

    /** Start/end lunch — idempotent server-side (resumes an already-open lunch). */
    suspend fun lunchToggle() {
        if (lunchBusy) return
        lunchBusy = true
        notice = null
        try {
            if (lunchActive) {
                val r = unwrap(AlmaApi.send("POST", "/api/assistant/office/lunch", JSONObject().put("action", "end")))
                lunchActive = false
                lunchStartedAt = null
                r.flexInt("durationMin")?.let { notice = "🍽️ লাঞ্চ শেষ — ${OfficeFormat.bn(it)} মিনিট" }
            } else {
                val r = unwrap(AlmaApi.send("POST", "/api/assistant/office/lunch", JSONObject().put("action", "start")))
                lunchStartedAt = OfficeFormat.parseMs(r.str("startedAt")) ?: System.currentTimeMillis()
                lunchActive = true
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            // GETs succeed for any user, so a 403 here = the route's not_staff branch.
            if (!authExpired) notice = "লাঞ্চ টাইমার শুধু স্টাফ অ্যাকাউন্টের জন্য।"
        } catch (e: AlmaApiException.Http) {
            if (e.status == 404) { lunchActive = false; lunchStartedAt = null } else error = e.message
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        } finally {
            lunchBusy = false
        }
    }

    suspend fun markAllRead() {
        if (markingRead) return
        markingRead = true
        try {
            AlmaApi.send("POST", "/api/assistant/office/notifications", JSONObject())
            notices = notices.map { it.copy(read = true) }
            unread = 0
        } catch (_: Exception) { } finally { markingRead = false }
    }

    suspend fun markRead(n: OfficeNotice) {
        if (n.read) return
        try {
            AlmaApi.send("POST", "/api/assistant/office/notifications", JSONObject().put("id", n.id))
            notices = notices.map { if (it.id == n.id) it.copy(read = true) else it }
            unread = maxOf(0, unread - 1)
        } catch (_: Exception) { }
    }

    suspend fun loadThread(taskId: String) {
        threadLoading = true
        thread = emptyList()
        try {
            thread = unwrap(AlmaApi.getObject("/api/assistant/office/thread", mapOf("taskId" to taskId)))
                .optJSONArray("comments")?.mapObjects { OfficeThreadMsg.from(it) } ?: emptyList()
        } catch (_: Exception) { } finally { threadLoading = false }
    }

    /** One staff-action POST — 'done' | 'comment' | 'update'. Returns success. */
    suspend fun taskAction(taskId: String, action: String, body: String = ""): Boolean {
        if (actionBusyTaskId != null) return false
        actionBusyTaskId = taskId
        try {
            val payload = JSONObject().put("action", action).put("taskId", taskId)
            if (body.isNotEmpty()) payload.put("body", body)
            AlmaApi.send("POST", "/api/assistant/office/staff-action", payload)
            when (action) {
                "done" -> { notice = "✅ কাজটি সম্পন্ন হিসেবে পাঠানো হয়েছে — Boss অনুমোদন দিলে চূড়ান্ত হবে।"; load() }
                "comment" -> notice = "💬 কমেন্ট পাঠানো হয়েছে।"
                "update" -> notice = "📤 আপডেট পাঠানো হয়েছে।"
            }
            loadThread(taskId)
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            return false
        } finally {
            actionBusyTaskId = null
        }
    }

    /** 📎 Native proof submission (web escape removed): upload each photo to
     *  office/upload, then POST staff-action 'proof' with the resulting urls + text. */
    suspend fun submitProof(taskId: String, images: List<PickedImage>, text: String): Boolean {
        if (actionBusyTaskId != null) return false
        actionBusyTaskId = taskId
        try {
            val urls = ArrayList<String>()
            for (img in images) {
                val resp = AlmaApi.uploadMultipart("/api/assistant/office/upload", listOf(img.toFilePart("file")))
                val d = resp.optJSONObject("data") ?: resp
                (d.str("url") ?: resp.str("url"))?.let { urls.add(it) }
            }
            val payload = JSONObject().put("action", "proof").put("taskId", taskId)
            if (urls.isNotEmpty()) payload.put("imageUrls", org.json.JSONArray(urls))
            if (text.isNotEmpty()) payload.put("text", text)
            AlmaApi.send("POST", "/api/assistant/office/staff-action", payload)
            notice = "📎 প্রমাণ পাঠানো হয়েছে — Boss যাচাই করবেন।"
            load()
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            return false
        } finally {
            actionBusyTaskId = null
        }
    }

    suspend fun createSelfInitiated(title: String, detail: String): Boolean {
        if (creatingSelf) return false
        creatingSelf = true
        try {
            val payload = JSONObject().put("action", "self_create").put("title", title)
            if (detail.isNotEmpty()) payload.put("detail", detail)
            AlmaApi.send("POST", "/api/assistant/office/staff-action", payload)
            notice = "✨ নিজ উদ্যোগের কাজ পাঠানো হয়েছে — Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।"
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            return false
        } finally {
            creatingSelf = false
        }
    }

    suspend fun loadChat() {
        chatLoading = true
        try {
            val all = unwrap(AlmaApi.getObject("/api/assistant/office/chat"))
                .optJSONArray("messages")?.mapObjects { OfficeChatMsg.from(it) } ?: emptyList()
            // Drop dismissed; keep 'pending' agent drafts only for the owner.
            chat = all.filter { it.status != "dismissed" && (it.status != "pending" || selfRole == "owner") }
        } catch (_: Exception) { } finally { chatLoading = false }
    }

    /** Send a TEXT message to the group. Images stay web (needs the file picker). */
    suspend fun sendChat(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || chatSending) return false
        chatSending = true
        try {
            AlmaApi.send("POST", "/api/assistant/office/chat", JSONObject().put("body", trimmed).put("attachments", JSONArray()))
            loadChat()
            return true
        } catch (e: Exception) {
            return false
        } finally {
            chatSending = false
        }
    }

    suspend fun explainTask(taskId: String) {
        if (explainingTaskId != null) return
        explainingTaskId = taskId
        try {
            AlmaApi.send("POST", "/api/assistant/office/chat/explain", JSONObject().put("taskId", taskId))
            loadChat()
        } catch (_: Exception) { } finally { explainingTaskId = null }
    }

    /** Owner-only: approve / dismiss the agent's draft reply in the group. */
    suspend fun chatAgentDecide(id: String, approve: Boolean, editedBody: String?) {
        if (chatDecidingId != null) return
        chatDecidingId = id
        try {
            val body = JSONObject().put("action", if (approve) "approve" else "dismiss").put("id", id)
            if (approve && !editedBody.isNullOrEmpty()) body.put("body", editedBody)
            AlmaApi.send("POST", "/api/assistant/office/chat/agent", body)
            loadChat()
        } catch (_: Exception) { } finally { chatDecidingId = null }
    }

    /** Owner task/proposal action → POST /api/assistant/office/action, then refresh the hub. */
    suspend fun ownerAct(body: JSONObject, taskId: String? = null, proposalId: String? = null): Boolean {
        if (taskId != null) ownerBusyId = taskId
        if (proposalId != null) proposalBusyId = proposalId
        try {
            AlmaApi.send("POST", "/api/assistant/office/action", body)
            loadHub()
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            return false
        } finally {
            ownerBusyId = null; proposalBusyId = null
        }
    }
}

// ── Formatting helpers (web util parity) ───────────────────────────────────────────

private object OfficeFormat {
    private val bnDigits = charArrayOf('০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯')

    /** ASCII digits → Bangla numerals — the web's bn() helper. */
    fun bn(n: Int): String = bn(n.toString())
    fun bn(s: String): String = buildString {
        for (c in s) append(if (c in '0'..'9') bnDigits[c - '0'] else c)
    }

    fun parseMs(iso: String?): Long? = parse(iso)?.time

    /** Bangla long date for the header, e.g. "24 June, Tuesday" localised. */
    fun headerDate(): String {
        val f = SimpleDateFormat("d MMMM, EEEE", Locale("bn", "BD"))
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(Date())
    }

    /** Bangla relative time — the web bell's exact strings (Bangla digits). */
    fun timeAgo(iso: String?): String {
        val date = parse(iso) ?: return ""
        val m = ((System.currentTimeMillis() - date.time) / 60000).toInt()
        if (m < 1) return "এইমাত্র"
        if (m < 60) return "${bn(m)} মিনিট আগে"
        val h = m / 60
        if (h < 24) return "${bn(h)} ঘণ্টা আগে"
        return "${bn(h / 24)} দিন আগে"
    }

    /** Web KIND_ICON table verbatim. */
    fun kindIcon(kind: String?): String = when (kind) {
        "completed" -> "✅"
        "comment" -> "💬"
        "approved" -> "👍"
        "redo" -> "🔄"
        "update_request" -> "⏰"
        "escalation" -> "🚨"
        "self_initiated" -> "✨"
        "award" -> "🏆"
        "group_message" -> "👥"
        "task_assigned" -> "📋"
        else -> "🔔"
    }

    private fun parse(iso: String?): Date? {
        if (iso.isNullOrEmpty()) return null
        val patterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
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

// ── Shared widgets ─────────────────────────────────────────────────────────────────

/** Coral→violet squircle badge — the app's card-header mark. */
@Composable
private fun OfficeBadge(emoji: String) {
    Box(
        Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .background(Brush.linearGradient(listOf(OfficePalette.coral, OfficePalette.violet))),
        contentAlignment = Alignment.Center,
    ) { Text(emoji, fontSize = 16.sp) }
}

/** Circular avatar — real ERP profile photo when present, else a tinted initial. */
@Composable
private fun OfficeAvatar(url: String?, initial: String, size: Int) {
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(Brush.linearGradient(listOf(OfficePalette.violet, OfficePalette.coral))),
        contentAlignment = Alignment.Center,
    ) {
        if (!url.isNullOrEmpty()) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().clip(CircleShape))
        } else {
            Text(initial, color = Color.White, fontSize = (size / 2.4f).sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** Card-header row: badge + title + optional sub. */
@Composable
private fun OfficeCardHeader(emoji: String, title: String, sub: String, dark: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OfficeBadge(emoji)
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (sub.isNotEmpty()) Text(sub, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Spacer(Modifier.weight(1f))
    }
}

/** Tinted capsule button (filled = solid). */
@Composable
private fun OfficePill(label: String, tint: Color, filled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (filled) Color.White else tint, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(if (filled) tint else tint.copy(alpha = 0.14f), CircleShape)
            .then(if (filled) Modifier else Modifier.border(1.dp, tint.copy(alpha = 0.35f), CircleShape))
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun OfficeNoticeCard(message: String, tint: Color, dark: Boolean) {
    Text(
        message, color = tint, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun OfficeAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন", color = AlmaTheme.ink(dark), fontSize = 14.sp)
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(OfficePalette.coral, CircleShape).plainClick(onLogin).padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortalOfficeScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { OfficeState() }
    val scope = rememberCoroutineScope()

    var detailTask by remember { mutableStateOf<OfficeTask?>(null) }
    var ownerTask by remember { mutableStateOf<OfficeHubTask?>(null) }
    var showSelfCreate by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    var showIntercom by remember { mutableStateOf(false) }

    // Live 1s tick for the lunch countdown + the 10-min update-request countdown.
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(vm.lunchActive, vm.updateRequests) {
        while (vm.lunchActive || vm.updateRequests.isNotEmpty()) {
            nowMs = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }

    LaunchedEffect(Unit) { if (!vm.roleResolved) vm.loadHub() }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when {
            !vm.roleResolved -> items(count = 3) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            vm.authExpired -> {
                item { OfficeHeader(dark) }
                item { OfficeAuthCard(dark) { ctx.openSmart("/login", "Login") } }
            }
            vm.selfRole == "owner" -> ownerHub(vm, dark, scope = { block -> scope.launch { block() } }, onOwnerTask = { ownerTask = it }, onChat = { showChat = true }, onHistory = { showHistory = true }, onWeb = ctx.openWebForced)
            else -> staffOffice(vm, dark, nowMs, onTask = { detailTask = it }, onSelfCreate = { showSelfCreate = true }, onChat = { showChat = true }, onLunch = { scope.launch { vm.lunchToggle() } }, onMarkAll = { scope.launch { vm.markAllRead() } }, onMarkOne = { n -> scope.launch { vm.markRead(n) } }, onSubmitUpdate = { id, body -> scope.launch { if (vm.taskAction(id, "update", body)) vm.loadHub() } })
        }
        if (vm.roleResolved && !vm.authExpired) {
            item { IntercomLaunchCard(dark) { showIntercom = true } }
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    detailTask?.let { t ->
        ModalBottomSheet(onDismissRequest = { detailTask = null }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeTaskDetailSheet(t, vm, dark, onWeb = ctx.openWebForced, onDone = { detailTask = null })
        }
    }
    ownerTask?.let { t ->
        ModalBottomSheet(onDismissRequest = { ownerTask = null }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeOwnerTaskSheet(t, vm, dark, onClose = { ownerTask = null })
        }
    }
    if (showSelfCreate) {
        ModalBottomSheet(onDismissRequest = { showSelfCreate = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeSelfInitiatedSheet(vm, dark) { showSelfCreate = false }
        }
    }
    if (showChat) {
        ModalBottomSheet(onDismissRequest = { showChat = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeGroupChatSheet(vm, dark, isOwner = vm.selfRole == "owner", onWeb = ctx.openWebForced)
        }
    }
    if (showHistory) {
        ModalBottomSheet(onDismissRequest = { showHistory = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeHistorySheet(dark)
        }
    }
    if (showIntercom) {
        IntercomSheet(isOwner = vm.selfRole == "owner", dark = dark, onDismiss = { showIntercom = false })
    }
}

// ── Staff header (web .phead parity) ───────────────────────────────────────────────

@Composable
private fun OfficeHeader(dark: Boolean) {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("আমার অফিস · মোবাইল অ্যাপ", color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
        Text("👷 আমার কাজ", color = AlmaTheme.ink(dark), fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("কাজ দেখুন, রেজাল্ট জমা দিন, আর Boss-এর ফিডব্যাক সাথে সাথে পান।", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
        Text(OfficeFormat.headerDate(), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ── Rich staff layer: check-in banner / performer hero / motivation / update alert /
//    performance strip (iOS PortalStaffOffice parity) ─────────────────────────────────

@Composable
private fun OfficeCheckInBanner(vm: OfficeState, dark: Boolean) {
    val active = vm.checkedIn && !vm.checkedOut
    val tint = if (active) OfficePalette.emerald600 else AlmaTheme.inkSecondary(dark)
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(9.dp).background(tint, CircleShape))
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                when {
                    vm.checkedOut -> "🏁 আজকের অফিস শেষ"
                    active -> "✅ অফিসে চেক-ইন করা আছে"
                    else -> "⏳ এখনো চেক-ইন হয়নি"
                },
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
            vm.checkInLabel?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp)
            }
        }
    }
}

@Composable
private fun OfficePerformerCard(award: OfficeAward, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth()
            .background(Brush.horizontalGradient(listOf(OfficePalette.amber600.copy(alpha = 0.20f), OfficePalette.coral.copy(alpha = 0.12f))), RoundedCornerShape(AlmaTheme.R_CARD))
            .border(1.dp, OfficePalette.amber600.copy(alpha = 0.4f), RoundedCornerShape(AlmaTheme.R_CARD))
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("👑", fontSize = 30.sp)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("এই সপ্তাহের সেরা পারফর্মার!", color = OfficePalette.amber600, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            Text(award.staffName, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Black)
            if (award.score > 0) Text("স্কোর ${OfficeFormat.bn(award.score)} · অভিনন্দন Boss-এর পক্ষ থেকে 🎉", color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp)
        }
    }
}

@Composable
private fun OfficeMotivationCard(text: String, tag: String?, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth()
            .background(OfficePalette.violet.copy(alpha = 0.10f), RoundedCornerShape(AlmaTheme.R_CARD))
            .border(1.dp, OfficePalette.violet.copy(alpha = 0.3f), RoundedCornerShape(AlmaTheme.R_CARD))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("✨ আজকের অনুপ্রেরণা", color = OfficePalette.violet, fontSize = 10.5.sp, fontWeight = FontWeight.Bold)
        Text(text, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Medium)
        tag?.takeIf { it.isNotBlank() }?.let { Text("— $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.5.sp) }
    }
}

@Composable
private fun OfficePerfStrip(vm: OfficeState, dark: Boolean) {
    val total = vm.todayActiveCount + vm.todayDoneCount
    val pct = if (total > 0) vm.todayDoneCount.toFloat() / total else 0f
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OfficeBadge("📊")
            Text("আজকের পারফরম্যান্স", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text("${OfficeFormat.bn(vm.todayDoneCount)}/${OfficeFormat.bn(total)} সম্পন্ন", color = OfficePalette.emerald600, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.fillMaxWidth().height(8.dp).background(AlmaTheme.inkTertiary(dark).copy(alpha = 0.25f), CircleShape)) {
            Box(Modifier.fillMaxWidth(pct.coerceIn(0f, 1f)).height(8.dp).background(Brush.horizontalGradient(listOf(OfficePalette.emerald600, OfficePalette.violet)), CircleShape))
        }
    }
}

@Composable
private fun OfficeUpdateAlerts(vm: OfficeState, dark: Boolean, nowMs: Long, onSubmit: (String, String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        vm.updateRequests.forEach { req ->
            val secsLeft = ((req.deadlineMs - nowMs) / 1000).toInt()
            val over = secsLeft <= 0
            val mm = kotlin.math.abs(secsLeft) / 60
            val ss = kotlin.math.abs(secsLeft) % 60
            val clock = "${OfficeFormat.bn(mm)}:${OfficeFormat.bn(String.format(Locale.US, "%02d", ss))}"
            var answer by remember(req.id) { mutableStateOf("") }
            val busy = vm.actionBusyTaskId == req.id
            Column(
                Modifier.fillMaxWidth()
                    .background(OfficePalette.amber600.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CARD))
                    .border(1.dp, (if (over) OfficePalette.red500 else OfficePalette.amber600).copy(alpha = 0.5f), RoundedCornerShape(AlmaTheme.R_CARD))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("⚠️", fontSize = 18.sp)
                    Text("Boss আপডেট চেয়েছেন", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    Text(if (over) "⏰ $clock দেরি" else "⏳ $clock", color = if (over) OfficePalette.red500 else OfficePalette.amber600, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
                Text(req.title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                req.note?.takeIf { it.isNotBlank() }?.let { Text("“$it”", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp) }
                OutlinedTextField(
                    value = answer, onValueChange = { answer = it },
                    placeholder = { Text("সংক্ষেপে উত্তর দিন…", fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(), minLines = 1, maxLines = 3,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp, color = AlmaTheme.ink(dark)),
                )
                Box(
                    Modifier.fillMaxWidth()
                        .background(if (answer.isBlank() || busy) AlmaTheme.inkTertiary(dark).copy(alpha = 0.2f) else OfficePalette.emerald600, CircleShape)
                        .plainClick { if (answer.isNotBlank() && !busy) onSubmit(req.id, answer.trim()) }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                    else Text("উত্তর পাঠান", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// ── Staff office (base my-tasks view) ──────────────────────────────────────────────

private fun LazyListScope.staffOffice(
    vm: OfficeState,
    dark: Boolean,
    nowMs: Long,
    onTask: (OfficeTask) -> Unit,
    onSelfCreate: () -> Unit,
    onChat: () -> Unit,
    onLunch: () -> Unit,
    onMarkAll: () -> Unit,
    onMarkOne: (OfficeNotice) -> Unit,
    onSubmitUpdate: (String, String) -> Unit,
) {
    item { OfficeHeader(dark) }
    vm.error?.let { item { OfficeNoticeCard("⚠️ $it", OfficePalette.red500, dark) } }
    vm.notice?.let { item { OfficeNoticeCard("ℹ️ $it", AlmaTheme.inkSecondary(dark), dark) } }
    // ── Rich staff layer (iOS PortalStaffOffice parity) ──
    if (vm.checkedIn || vm.checkInLabel != null) item { OfficeCheckInBanner(vm, dark) }
    if (vm.isWinner && vm.award != null) item { OfficePerformerCard(vm.award!!, dark) }
    vm.motivationText?.let { txt -> item { OfficeMotivationCard(txt, vm.motivationTag, dark) } }
    if (vm.updateRequests.isNotEmpty()) {
        item { OfficeUpdateAlerts(vm, dark, nowMs, onSubmit = onSubmitUpdate) }
    }
    if (vm.todayActiveCount + vm.todayDoneCount > 0) item { OfficePerfStrip(vm, dark) }
    item { OfficeLunchCard(vm, dark, nowMs, onLunch) }
    if (vm.loading && vm.tasks.isEmpty() && vm.notices.isEmpty()) {
        items(count = 2) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
    } else {
        item { OfficeTasksCard(vm, dark, onTask, onSelfCreate) }
        item { OfficeChatEntry(dark, onChat) }
        item { OfficeNoticesCard(vm, dark, onMarkAll, onMarkOne) }
    }
}

// ── Lunch card (web LunchControl — 45-min allowance, live countdown) ───────────────

@Composable
private fun OfficeLunchCard(vm: OfficeState, dark: Boolean, nowMs: Long, onLunch: () -> Unit) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeBadge("🍴")
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("লাঞ্চ", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text("৪৫ মিনিটের বিরতি", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Spacer(Modifier.weight(1f))
        }
        val started = vm.lunchStartedAt
        if (vm.lunchActive && started != null) {
            val remaining = OFFICE_LUNCH_LIMIT_SEC - ((nowMs - started) / 1000).toInt()
            val over = remaining <= 0
            val mm = kotlin.math.abs(remaining) / 60
            val ss = kotlin.math.abs(remaining) % 60
            val clock = "${OfficeFormat.bn(mm)}:${OfficeFormat.bn(String.format(Locale.US, "%02d", ss))}"
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (over) "🍽️ লাঞ্চ · ⚠️ $clock বেশি" else "🍽️ লাঞ্চ · $clock বাকি",
                    color = if (over) OfficePalette.red500 else OfficePalette.amber600,
                    fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                if (vm.lunchBusy) CircularProgressIndicator(Modifier.size(16.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
                else OfficeChip("ফিরে এসেছি", OfficePalette.emerald600, dark, onLunch)
            }
        } else if (vm.lunchBusy) {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(18.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
            }
        } else {
            OfficeChipWide("🍽️ লাঞ্চে যাচ্ছি", OfficePalette.coral, OfficePalette.accentText(dark), onLunch)
        }
    }
}

@Composable
private fun OfficeChip(label: String, tint: Color, dark: Boolean, onClick: () -> Unit) {
    Text(
        label, color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.background(tint.copy(alpha = 0.13f), CircleShape).border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

@Composable
private fun OfficeChipWide(label: String, tint: Color, textColor: Color, onClick: () -> Unit) {
    Text(
        label, color = textColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().background(tint.copy(alpha = 0.13f), CircleShape).border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .plainClick(onClick).padding(vertical = 9.dp),
    )
}

// ── আজকের কাজ (GET my-tasks) ────────────────────────────────────────────────────────

@Composable
private fun OfficeTasksCard(vm: OfficeState, dark: Boolean, onTask: (OfficeTask) -> Unit, onSelfCreate: () -> Unit) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeBadge("📋")
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("আজকের কাজ", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text("আমার কাজ · ${OfficeFormat.headerDate()}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Spacer(Modifier.weight(1f))
            if (vm.tasks.isNotEmpty()) {
                Text(
                    OfficeFormat.bn(vm.tasks.size), color = OfficePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(OfficePalette.coral.copy(alpha = 0.18f), CircleShape).border(1.dp, OfficePalette.coral.copy(alpha = 0.4f), CircleShape)
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                )
            }
        }
        if (vm.tasks.isEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("আজ কোনো কাজ নেই", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text("নতুন কাজ এলে এখানে দেখতে পাবেন।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
        } else {
            vm.tasks.forEach { t -> OfficeTaskRow(t, vm, dark, onTask) }
            Text("রেজাল্ট জমা দিতে, কমেন্ট করতে বা ✅ সম্পন্ন দিতে কাজটিতে চাপ দিন।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        // নিজে থেকে একটা কাজ (web SelfInitiated composer)
        Text(
            "✨ নিজে থেকে একটা কাজ করেছি — জমা দিন",
            color = OfficePalette.violet, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().background(OfficePalette.violet.copy(alpha = 0.12f), CircleShape)
                .border(1.dp, OfficePalette.violet.copy(alpha = 0.4f), CircleShape).plainClick(onSelfCreate).padding(vertical = 10.dp),
        )
    }
}

@Composable
private fun OfficeTaskRow(t: OfficeTask, vm: OfficeState, dark: Boolean, onTask: (OfficeTask) -> Unit) {
    Row(
        Modifier.fillMaxWidth().plainClick { onTask(t) }.padding(vertical = 4.dp),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            OfficeFormat.bn(t.serial ?: 0), color = OfficePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.size(26.dp).background(OfficePalette.coral.copy(alpha = 0.16f), CircleShape)
                .border(1.dp, OfficePalette.coral.copy(alpha = 0.35f), CircleShape).padding(top = 4.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(t.title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            t.type?.takeIf { it.isNotEmpty() }?.let { Text("📦 $it", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp) }
        }
        if (vm.actionBusyTaskId == t.id) CircularProgressIndicator(Modifier.size(14.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
        else Text("›", color = AlmaTheme.inkSecondary(dark), fontSize = 16.sp)
    }
}

// ── গ্রুপ চ্যাট entry ─────────────────────────────────────────────────────────────────

@Composable
private fun OfficeChatEntry(dark: Boolean, onChat: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onChat).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OfficeBadge("💬")
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text("অফিস গ্রুপ চ্যাট", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text("● Agent, আপনি, টিম", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Spacer(Modifier.weight(1f))
        Text("›", color = AlmaTheme.inkSecondary(dark), fontSize = 16.sp)
    }
}

// ── নোটিফিকেশন (GET/POST notifications) ──────────────────────────────────────────────

@Composable
private fun OfficeNoticesCard(vm: OfficeState, dark: Boolean, onMarkAll: () -> Unit, onMarkOne: (OfficeNotice) -> Unit) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeBadge("🔔")
            Text("নোটিফিকেশন", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            if (vm.unread > 0) {
                Text(
                    if (vm.unread > 9) "৯+" else OfficeFormat.bn(vm.unread), color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(OfficePalette.red500, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            if (vm.unread > 0) {
                Text("সব পড়া হয়েছে", color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.plainClick(onMarkAll))
            }
        }
        if (vm.notices.isEmpty()) {
            Text("কোনো নোটিফিকেশন নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        } else {
            vm.notices.forEach { n -> OfficeNoticeRow(n, dark) { onMarkOne(n) } }
        }
    }
}

@Composable
private fun OfficeNoticeRow(n: OfficeNotice, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().plainClick(onClick).padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(26.dp).background(AlmaTheme.fill(dark), CircleShape), contentAlignment = Alignment.Center) {
            Text(OfficeFormat.kindIcon(n.kind), fontSize = 13.sp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(n.title, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = if (n.read) FontWeight.Normal else FontWeight.Bold)
            n.body?.takeIf { it.isNotEmpty() }?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Text(OfficeFormat.timeAgo(n.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        if (!n.read) Box(Modifier.padding(top = 5.dp).size(7.dp).background(OfficePalette.coral, CircleShape))
    }
}

// ── Owner Hub (the BOSS dashboard — role-detected) ─────────────────────────────────

private fun LazyListScope.ownerHub(
    vm: OfficeState,
    dark: Boolean,
    scope: ((suspend () -> Unit) -> Unit),
    onOwnerTask: (OfficeHubTask) -> Unit,
    onChat: () -> Unit,
    onHistory: () -> Unit,
    onWeb: (String, String) -> Unit,
) {
    val hub = vm.hub
    if (hub == null) {
        items(count = 3) { Box(Modifier.fillMaxWidth().height(110.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        return
    }
    item { OfficeHubHeader(hub, dark) }
    if (vm.isSampleData) item { OfficeDemoStrip(dark) }
    vm.error?.let { item { OfficeNoticeCard("⚠️ $it", OfficePalette.red500, dark) } }
    item { OfficeKpiGrid(hub, dark) }
    hub.award?.let { a -> item { OfficeAwardHero(a, hub.awardStats, dark, onWeb) } }
    if (hub.proposals.isNotEmpty()) item { OfficeProposalsCard(hub.proposals, vm, dark, scope) }
    item { OfficeApprovalCard(hub, vm, dark, scope, onOwnerTask) }
    item { OfficeTeamCard(hub, dark, onOwnerTask) }
    item { OfficeChatEntry(dark, onChat) }
    if (hub.leaderboard.isNotEmpty()) item { OfficeLeaderboardCard(hub.leaderboard, dark) }
    if (hub.performance.isNotEmpty()) item { OfficePerformanceCard(hub.performance, dark) }
    item { OfficeOwnerNoticesCard(vm, dark, scope) }
    item { OfficeHistoryButton(dark, onHistory) }
}

@Composable
private fun OfficeHubHeader(hub: OfficeHub, dark: Boolean) {
    Column(Modifier.fillMaxWidth().padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("বস ড্যাশবোর্ড", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text("Office", color = AlmaTheme.ink(dark), fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("আসসালামু আলাইকুম, Boss", color = AlmaTheme.ink(dark), fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("আজকের অফিস এক নজরে — কাজ, সাবমিশন আর অনুমোদন।", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(7.dp).background(OfficePalette.green400, CircleShape))
            Text("${OfficeFormat.bn(hub.online)} জন অনলাইন · ${OfficeFormat.headerDate()}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        }
    }
}

@Composable
private fun OfficeDemoStrip(dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Text(
        "ⓘ ডেমো ডেটা দেখানো হচ্ছে — লাইভ অফিস ডেটার জন্য hub রুট প্রোডাকশনে ডিপ্লয় হলে আসল স্টাফ ও টাস্ক দেখাবে।",
        color = OfficePalette.amber600, fontSize = 10.sp,
        modifier = Modifier.fillMaxWidth().background(OfficePalette.amber500.copy(alpha = 0.12f), shape).border(1.dp, OfficePalette.amber500.copy(alpha = 0.3f), shape).padding(11.dp),
    )
}

@Composable
private fun OfficeKpiGrid(hub: OfficeHub, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeKpiTile(Modifier.weight(1f), "⏳", "অনুমোদনের অপেক্ষায়", OfficeFormat.bn(hub.pending), OfficePalette.amber500, dark)
            OfficeKpiTile(Modifier.weight(1f), "🔄", "চলমান কাজ", OfficeFormat.bn(hub.active), OfficePalette.violet, dark)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeKpiTile(Modifier.weight(1f), "✅", "আজ সম্পন্ন", OfficeFormat.bn(hub.doneToday), OfficePalette.emerald600, dark)
            OfficeKpiTile(Modifier.weight(1f), "👥", "স্টাফ অনলাইন", "${OfficeFormat.bn(hub.online)}/${OfficeFormat.bn(hub.staffTotal)}", OfficePalette.coral, dark)
        }
    }
}

@Composable
private fun OfficeKpiTile(modifier: Modifier, emoji: String, label: String, value: String, tint: Color, dark: Boolean) {
    Column(modifier.almaGlass(dark, AlmaTheme.R_CARD).padding(15.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(emoji, fontSize = 20.sp)
        Spacer(Modifier.height(4.dp))
        Text(value, color = AlmaTheme.ink(dark), fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ── Performer of the week ──────────────────────────────────────────────────────────

@Composable
private fun OfficeAwardHero(a: OfficeAward, stats: OfficeAwardStats?, dark: Boolean, onWeb: (String, String) -> Unit) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier.fillMaxWidth()
            .background(Brush.linearGradient(listOf(OfficePalette.amber500.copy(alpha = 0.20f), OfficePalette.coral.copy(alpha = 0.12f))), shape)
            .border(1.dp, OfficePalette.amber500.copy(alpha = 0.4f), shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeAvatar(a.imageUrl, a.staffName.take(1).uppercase().ifEmpty { "★" }, 44)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("🏆 এই সপ্তাহের সেরা পারফরমার", color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text("${a.staffName} — মাশাআল্লাহ!", color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
            // Manual selection (recompute / pin) = web escape.
            Text("⚙", color = AlmaTheme.inkSecondary(dark), fontSize = 14.sp, modifier = Modifier.plainClick { onWeb("/portal/office", "Office") })
        }
        stats?.let { s ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OfficeAwardStat(Modifier.weight(1f), "সম্পন্ন", OfficeFormat.bn(s.done), dark)
                OfficeAwardStat(Modifier.weight(1f), "অনুমোদন", s.approvalRate?.let { "${OfficeFormat.bn(it)}%" } ?: "—", dark)
                OfficeAwardStat(Modifier.weight(1f), "QC", s.avgQc?.let { OfficeFormat.bn(it) } ?: "—", dark)
                OfficeAwardStat(Modifier.weight(1f), "নিজ উদ্যোগে", OfficeFormat.bn(s.selfInitiated), dark)
            }
        }
    }
}

@Composable
private fun OfficeAwardStat(modifier: Modifier, label: String, value: String, dark: Boolean) {
    Column(
        modifier.background(AlmaTheme.fill(dark), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        Text(value, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Text(label, color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
    }
}

// ── Proposals ──────────────────────────────────────────────────────────────────────

@Composable
private fun OfficeProposalsCard(rows: List<OfficeProposal>, vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit)) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OfficeCardHeader("🔍", "এজেন্টের প্রস্তাব", "আপনার সিদ্ধান্ত দরকার ${OfficeFormat.bn(rows.size)}টি", dark)
        Text("💡 এজেন্ট শুধু প্রস্তাব করে — টাকা/পেরোলে পরিবর্তন হয় না। অনুমোদন করলে আপনি নিজে ERP-তে প্রয়োগ করবেন।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        rows.forEach { p -> OfficeProposalRow(p, vm, dark, scope) }
    }
}

@Composable
private fun OfficeProposalRow(p: OfficeProposal, vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit)) {
    val reward = p.kind.lowercase().contains("reward") || p.kind.lowercase().contains("award")
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (reward) "🎁" else "⚠️", fontSize = 14.sp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    "${p.staffName} · ${if (reward) "রিওয়ার্ড" else "জরিমানা"}${p.amount?.let { " ৳${OfficeFormat.bn(it)}" } ?: ""}",
                    color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                )
                p.taskTitle?.takeIf { it.isNotEmpty() }?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        if (p.reason.isNotEmpty()) Text(p.reason, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Spacer(Modifier.weight(1f))
            if (vm.proposalBusyId == p.id) {
                CircularProgressIndicator(Modifier.size(16.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
            } else {
                OfficePill("খারিজ", OfficePalette.red500, false) {
                    scope { vm.ownerAct(JSONObject().put("action", "proposal_decide").put("proposalId", p.id).put("decision", "dismiss"), proposalId = p.id) }
                }
                OfficePill("অনুমোদন", OfficePalette.emerald600, true) {
                    scope { vm.ownerAct(JSONObject().put("action", "proposal_decide").put("proposalId", p.id).put("decision", "approve"), proposalId = p.id) }
                }
            }
        }
    }
}

// ── Approval queue ─────────────────────────────────────────────────────────────────

@Composable
private fun OfficeApprovalCard(hub: OfficeHub, vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit), onOwnerTask: (OfficeHubTask) -> Unit) {
    val count = hub.pendingApproval.size + hub.selfInitiated.size
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OfficeCardHeader("✔", "অনুমোদনের অপেক্ষায়", if (count > 0) "${OfficeFormat.bn(count)}টি" else "সব ক্লিয়ার ✓", dark)
        if (count == 0) Text("এই মুহূর্তে অনুমোদনের কিছু নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        hub.pendingApproval.forEach { t -> OfficeApprovalRow(t, vm, dark, scope, onOwnerTask) }
        hub.selfInitiated.forEach { t -> OfficeSelfRow(t, vm, dark, scope) }
    }
}

@Composable
private fun OfficeApprovalRow(t: OfficeHubTask, vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit), onOwnerTask: (OfficeHubTask) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(AlmaTheme.fill(dark), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(t.title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("👤 ${t.staffName}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                if (t.type.isNotEmpty()) Text("· ${t.type}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                if (t.needsOwner) Text("📌 রিভিউ দরকার", color = OfficePalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
        if (t.imageUrls.isNotEmpty()) {
            OfficeProofStrip(t.imageUrls) { onOwnerTask(t) }
            Text("ছবিতে চাপ দিন — বড় দেখুন, কমেন্ট করুন ও অনুমোদন দিন", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("বিস্তারিত", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.plainClick { onOwnerTask(t) })
            Spacer(Modifier.weight(1f))
            if (vm.ownerBusyId == t.id) {
                CircularProgressIndicator(Modifier.size(16.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
            } else {
                OfficePill("🔄 সংশোধন", OfficePalette.amber600, false) { onOwnerTask(t) }
                OfficePill("✅ অনুমোদন", OfficePalette.emerald600, true) {
                    scope { vm.ownerAct(JSONObject().put("action", "approve").put("taskId", t.id), taskId = t.id) }
                }
            }
        }
    }
}

@Composable
private fun OfficeSelfRow(t: OfficeHubTask, vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit)) {
    Column(
        Modifier.fillMaxWidth().background(OfficePalette.violet.copy(alpha = 0.06f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("✨", fontSize = 13.sp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(t.title, color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("নিজ উদ্যোগে · ${t.staffName}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Spacer(Modifier.weight(1f))
            if (vm.ownerBusyId == t.id) {
                CircularProgressIndicator(Modifier.size(16.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
            } else {
                OfficePill("প্রত্যাখ্যান", OfficePalette.red500, false) {
                    scope { vm.ownerAct(JSONObject().put("action", "self_reject").put("taskId", t.id), taskId = t.id) }
                }
                OfficePill("অনুমোদন", OfficePalette.emerald600, true) {
                    scope { vm.ownerAct(JSONObject().put("action", "self_approve").put("taskId", t.id), taskId = t.id) }
                }
            }
        }
    }
}

@Composable
private fun OfficeProofStrip(urls: List<String>, onTap: () -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        urls.forEach { s ->
            AsyncImage(
                model = s, contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.size(84.dp).clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
                    .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).plainClick(onTap),
            )
        }
    }
}

// ── Team status + each staff's todolist nested (accordion) ─────────────────────────

@Composable
private fun OfficeTeamCard(hub: OfficeHub, dark: Boolean, onOwnerTask: (OfficeHubTask) -> Unit) {
    var expanded by remember { mutableStateOf(setOf<String>()) }
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OfficeCardHeader("👨‍👩‍👦", "টিম স্ট্যাটাস ও টাস্ক", "${OfficeFormat.bn(hub.team.size)} জন", dark)
        hub.team.forEachIndexed { idx, m ->
            if (idx > 0) HorizontalDivider(color = AlmaTheme.separator(dark))
            val open = m.staffId in expanded
            val doneItems = hub.doneTodayTasks.filter { it.staffId == m.staffId }
            val activeItems = hub.activeTasks.filter { it.staffId == m.staffId }
            Column {
                Row(
                    Modifier.fillMaxWidth().plainClick { expanded = if (open) expanded - m.staffId else expanded + m.staffId }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp),
                ) {
                    Box(contentAlignment = Alignment.BottomEnd) {
                        OfficeAvatar(m.imageUrl, m.initial, 36)
                        Box(Modifier.size(11.dp).background(OfficePalette.statusColor(m.status), CircleShape).border(2.dp, AlmaTheme.rootBg(dark), CircleShape))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(m.name, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Box(Modifier.size(6.dp).background(OfficePalette.statusColor(m.status), CircleShape))
                            Text(m.sub, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Text("${OfficeFormat.bn(m.doneToday)}/${OfficeFormat.bn(m.totalToday)}", color = AlmaTheme.inkSecondary(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(if (open) "⌄" else "›", color = AlmaTheme.inkTertiary(dark), fontSize = 14.sp)
                }
                if (open) {
                    Column(Modifier.padding(start = 47.dp, bottom = 6.dp)) {
                        if (doneItems.isEmpty() && activeItems.isEmpty()) {
                            Text(
                                if (m.checkedIn) "আজ কোনো টাস্ক অ্যাসাইন করা হয়নি।" else "চেক-ইন করলে আজকের অ্যাসাইন করা টাস্ক এখানে দেখাবে।",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.padding(vertical = 8.dp),
                            )
                        } else {
                            doneItems.forEach { t -> OfficeTaskLine(t, true, dark, onOwnerTask) }
                            activeItems.forEach { t -> OfficeTaskLine(t, false, dark, onOwnerTask) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OfficeTaskLine(t: OfficeHubTask, done: Boolean, dark: Boolean, onOwnerTask: (OfficeHubTask) -> Unit) {
    Row(
        Modifier.fillMaxWidth().plainClick { onOwnerTask(t) }.padding(vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(20.dp).clip(CircleShape)
                .background(if (done) OfficePalette.emerald600 else Color.Transparent)
                .border(if (done) 0.dp else 1.8.dp, if (done) Color.Transparent else OfficePalette.violet.copy(alpha = 0.5f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { if (done) Text("✓", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        Text(
            t.title, color = if (done) AlmaTheme.inkSecondary(dark) else AlmaTheme.ink(dark), fontSize = 12.sp,
            textDecoration = if (done) TextDecoration.LineThrough else null, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (!done && (t.needsOwner || t.verificationStatus == "redo_requested")) {
            Text("রিভিউ", color = OfficePalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        } else if (t.type.isNotEmpty()) {
            Text(t.type, color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Text("›", color = AlmaTheme.inkTertiary(dark), fontSize = 13.sp)
    }
}

// ── Leaderboard ────────────────────────────────────────────────────────────────────

@Composable
private fun OfficeLeaderboardCard(rows: List<OfficeLeader>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OfficeCardHeader("🏆", "সাপ্তাহিক পারফরম্যান্স", "", dark)
        rows.forEachIndexed { idx, r ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(OfficeFormat.bn(idx + 1), color = OfficePalette.accentText(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(18.dp))
                OfficeAvatar(r.imageUrl, r.initial, 26)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(r.name, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(AlmaTheme.fill(dark))) {
                        Box(Modifier.fillMaxWidth(maxOf(0.06f, r.pct / 100f)).height(6.dp).clip(CircleShape)
                            .background(Brush.horizontalGradient(listOf(OfficePalette.coral, OfficePalette.amber500))))
                    }
                }
                Text(OfficeFormat.bn(r.score), color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

// ── Staff performance table ────────────────────────────────────────────────────────

@Composable
private fun OfficePerformanceCard(rows: List<OfficePerf>, dark: Boolean) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OfficeCardHeader("📊", "স্টাফ পারফরম্যান্স", "সপ্তাহ", dark)
        Row {
            Text("স্টাফ", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("সম্পন্ন", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(52.dp), textAlign = TextAlign.Center)
            Text("সময়মতো", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(56.dp), textAlign = TextAlign.Center)
            Text("সংশোধন", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(52.dp), textAlign = TextAlign.Center)
            Text("স্কোর", color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(40.dp), textAlign = TextAlign.Center)
        }
        rows.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.staffName, color = AlmaTheme.ink(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(OfficeFormat.bn(p.done), color = AlmaTheme.ink(dark), fontSize = 11.sp, modifier = Modifier.width(52.dp), textAlign = TextAlign.Center)
                Text(p.onTimeRate?.let { "${OfficeFormat.bn(it)}%" } ?: "—", color = AlmaTheme.ink(dark), fontSize = 11.sp, modifier = Modifier.width(56.dp), textAlign = TextAlign.Center)
                Text(OfficeFormat.bn(p.redo), color = AlmaTheme.ink(dark), fontSize = 11.sp, modifier = Modifier.width(52.dp), textAlign = TextAlign.Center)
                Text(OfficeFormat.bn(p.score), color = OfficePalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(40.dp), textAlign = TextAlign.Center)
            }
            HorizontalDivider(color = AlmaTheme.separator(dark))
        }
    }
}

// ── Owner notifications + history ──────────────────────────────────────────────────

@Composable
private fun OfficeOwnerNoticesCard(vm: OfficeState, dark: Boolean, scope: ((suspend () -> Unit) -> Unit)) {
    Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OfficeBadge("🔔")
            Text("নোটিফিকেশন", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            if (vm.unread > 0) {
                Text(
                    if (vm.unread > 9) "৯+" else OfficeFormat.bn(vm.unread), color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(OfficePalette.red500, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            if (vm.unread > 0) Text("সব পড়া হয়েছে", color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.plainClick { scope { vm.markAllRead() } })
        }
        if (vm.notices.isEmpty()) {
            Text("কোনো নোটিফিকেশন নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        } else {
            vm.notices.take(6).forEach { n ->
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(OfficeFormat.kindIcon(n.kind), fontSize = 13.sp, modifier = Modifier.width(22.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(n.title, color = AlmaTheme.ink(dark), fontSize = 11.sp, fontWeight = if (n.read) FontWeight.Normal else FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(OfficeFormat.timeAgo(n.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
                    }
                    if (!n.read) Box(Modifier.size(7.dp).background(OfficePalette.coral, CircleShape))
                }
            }
        }
    }
}

@Composable
private fun OfficeHistoryButton(dark: Boolean, onHistory: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).plainClick(onHistory).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OfficeBadge("📅")
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text("অফিসের ইতিহাস", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text("আগের দিনগুলোর বোর্ড", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
        Spacer(Modifier.weight(1f))
        Text("›", color = AlmaTheme.inkSecondary(dark), fontSize = 16.sp)
    }
}

// ── Task detail sheet (web StaffDetail — thread + ✅ done + 💬 comment) ────────────────

@Composable
private fun OfficeTaskDetailSheet(task: OfficeTask, vm: OfficeState, dark: Boolean, onWeb: (String, String) -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }
    val busy = vm.actionBusyTaskId == task.id

    LaunchedEffect(task.id) { vm.loadThread(task.id) }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.title, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            task.type?.takeIf { it.isNotEmpty() }?.let {
                Text("📦 $it", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.background(AlmaTheme.fill(dark), CircleShape).padding(horizontal = 10.dp, vertical = 4.dp))
            }
        }
        // Thread
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("আলোচনা", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            when {
                vm.threadLoading -> Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                vm.thread.isEmpty() -> Text("এখনো কোনো মন্তব্য নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                else -> vm.thread.forEach { c -> OfficeThreadBubble(c, task.title, dark) }
            }
        }
        // Compose comment / done
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("📎 রেজাল্ট / কমেন্ট জমা দিন", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            OutlinedTextField(value = draft, onValueChange = { draft = it }, placeholder = { Text("কমেন্ট লিখুন…") }, minLines = 1, modifier = Modifier.fillMaxWidth())
            OfficeChipWide(if (busy) "অপেক্ষা করুন…" else "পাঠান", OfficePalette.coral, OfficePalette.accentText(dark)) {
                val text = draft.trim()
                if (text.isNotEmpty() && !busy) scope.launch { if (vm.taskAction(task.id, "comment", text)) draft = "" }
            }
            OfficeChipWide("✅ সম্পন্ন হিসেবে চিহ্নিত করুন", OfficePalette.emerald600, OfficePalette.emerald600) {
                if (!busy) scope.launch { if (vm.taskAction(task.id, "done")) onDone() }
            }
        }
        // ── NATIVE photo proof: pick/shoot up to 5 → upload → staff-action 'proof' ──
        var proofImages by remember { mutableStateOf(listOf<PickedImage>()) }
        fun addProof(p: PickedImage?) { if (p != null && proofImages.size < 5) proofImages = proofImages + p }
        val proofGallery = rememberGalleryPick(onResult = ::addProof)
        val proofCamera = rememberCameraPick(onResult = ::addProof)
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "📎 ছবি প্রমাণ" + if (proofImages.isNotEmpty()) " · ${proofImages.size}টি যোগ হয়েছে" else "",
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) {
                    OfficeChipWide("📷 ক্যামেরা", OfficePalette.coral, OfficePalette.accentText(dark)) {
                        if (proofImages.size < 5) proofCamera()
                    }
                }
                Box(Modifier.weight(1f)) {
                    OfficeChipWide("🖼️ গ্যালারি", OfficePalette.coral, OfficePalette.accentText(dark)) {
                        if (proofImages.size < 5) proofGallery()
                    }
                }
            }
            if (proofImages.isNotEmpty()) {
                OfficeChipWide(if (busy) "পাঠানো হচ্ছে…" else "📎 প্রমাণ জমা দিন", OfficePalette.emerald600, OfficePalette.emerald600) {
                    if (!busy) scope.launch {
                        if (vm.submitProof(task.id, proofImages, draft.trim())) { proofImages = emptyList(); draft = ""; onDone() }
                    }
                }
            }
        }
        Text("Boss অনুমোদন দিলে কাজটি সম্পন্ন হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
    }
}

@Composable
private fun OfficeThreadBubble(c: OfficeThreadMsg, staffName: String, dark: Boolean) {
    val who = when (c.authorType) { "owner" -> "Boss"; "agent" -> "Agent"; else -> "আপনি" }
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(24.dp).background(AlmaTheme.fill(dark), CircleShape), contentAlignment = Alignment.Center) {
            Text(if (c.authorType == "owner") "M" else if (c.authorType == "agent") "🤖" else "•", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = AlmaTheme.ink(dark))
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(who, color = AlmaTheme.ink(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text(OfficeFormat.timeAgo(c.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
            Text(c.body, color = AlmaTheme.ink(dark), fontSize = 11.sp)
        }
    }
}

// ── Self-initiated sheet (web SelfInitiated — title + optional detail) ──────────────

@Composable
private fun OfficeSelfInitiatedSheet(vm: OfficeState, dark: Boolean, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("✨ নিজে থেকে একটা কাজ করেছি", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text("Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
        OutlinedTextField(value = title, onValueChange = { title = it }, placeholder = { Text("কাজের শিরোনাম") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = detail, onValueChange = { detail = it }, placeholder = { Text("বিস্তারিত (ঐচ্ছিক)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        val valid = title.trim().isNotEmpty()
        OfficeChipWide(if (vm.creatingSelf) "অপেক্ষা করুন…" else "পাঠান", OfficePalette.violet, if (valid) Color.White else AlmaTheme.inkTertiary(dark)) {
            val t = title.trim()
            if (t.isNotEmpty() && !vm.creatingSelf) scope.launch { if (vm.createSelfInitiated(t, detail.trim())) onClose() }
        }
    }
}

// ── Group chat sheet (web GroupChat — send text + explain a task) ────────────────────

@Composable
private fun OfficeGroupChatSheet(vm: OfficeState, dark: Boolean, isOwner: Boolean, onWeb: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }
    var tasksOpen by remember { mutableStateOf(false) }
    val editText = remember { mutableStateMapOf<String, String>() }

    // Live poll, messenger-style (15s).
    LaunchedEffect(Unit) {
        vm.loadChat()
        while (true) {
            kotlinx.coroutines.delay(15_000)
            vm.loadChat()
        }
    }

    Column(Modifier.fillMaxWidth().heightIn(min = 400.dp).padding(bottom = 8.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("🤖", fontSize = 13.sp)
            Column {
                Text("অফিস গ্রুপ", color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                Text("● Agent · আপনি · টিম", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
            }
        }
        Column(
            Modifier.fillMaxWidth().heightIn(max = 440.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when {
                vm.chatLoading && vm.chat.isEmpty() -> Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.padding(top = 20.dp))
                vm.chat.isEmpty() -> Text("— এখনো কোনো বার্তা নেই। প্রথম বার্তাটি লিখুন। —", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 24.dp))
                else -> vm.chat.forEach { m ->
                    if (m.status == "pending") OfficeDraftBubble(m, vm, dark, scope, editText) else OfficeChatBubble(m, dark, isOwner, onWeb)
                }
            }
        }
        if (tasksOpen && !isOwner) OfficeStaffTaskPicker(vm, dark, scope) { tasksOpen = false }
        // Composer
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Image attach = web escape (needs file picker).
            Box(Modifier.size(36.dp).background(AlmaTheme.fill(dark), CircleShape).plainClick { onWeb("/portal/office", "Office") }, contentAlignment = Alignment.Center) {
                Text("🖼", fontSize = 14.sp)
            }
            if (!isOwner) {
                Box(Modifier.size(36.dp).background(AlmaTheme.fill(dark), CircleShape).plainClick { tasksOpen = !tasksOpen }, contentAlignment = Alignment.Center) {
                    Text("📋", fontSize = 14.sp)
                }
            }
            OutlinedTextField(value = draft, onValueChange = { draft = it }, placeholder = { Text("গ্রুপে মেসেজ লিখুন…") }, minLines = 1, modifier = Modifier.weight(1f))
            Box(
                Modifier.size(36.dp).background(OfficePalette.coral, CircleShape).plainClick {
                    val text = draft
                    if (text.trim().isNotEmpty() && !vm.chatSending) scope.launch { if (vm.sendChat(text)) draft = "" }
                },
                contentAlignment = Alignment.Center,
            ) {
                if (vm.chatSending) CircularProgressIndicator(Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                else Text("➤", color = Color.White, fontSize = 14.sp)
            }
        }
    }
}

@Composable
private fun OfficeChatBubble(m: OfficeChatMsg, dark: Boolean, isOwner: Boolean, onWeb: (String, String) -> Unit) {
    val mine = isOwner && m.authorType == "owner"
    val isAgent = m.authorType == "agent"
    val name = if (isAgent) "Agent" else if (m.authorType == "owner") "Boss" else m.authorName
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Bottom) {
        if (!mine) OfficeAvatar(m.authorImageUrl, if (isAgent) "🤖" else m.authorName.take(1).uppercase().ifEmpty { "•" }, 28)
        Spacer(Modifier.width(6.dp))
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (!mine) Text(name, color = if (isAgent) OfficePalette.violet else OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            m.imageURLs.forEach { s ->
                AsyncImage(
                    model = s, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(160.dp).clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp)).plainClick { onWeb("/portal/office", "Office") },
                )
            }
            if (m.body.trim().isNotEmpty()) {
                val bg = if (mine) OfficePalette.coral else if (isAgent) OfficePalette.violet.copy(alpha = 0.15f) else AlmaTheme.fill(dark)
                Text(
                    m.body, color = if (mine) Color.White else AlmaTheme.ink(dark), fontSize = 12.sp,
                    modifier = Modifier.background(bg, RoundedCornerShape(AlmaTheme.R_CARD.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            Text(OfficeFormat.timeAgo(m.createdAt), color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        }
    }
}

@Composable
private fun OfficeDraftBubble(m: OfficeChatMsg, vm: OfficeState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope, editText: androidx.compose.runtime.snapshots.SnapshotStateMap<String, String>) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Column(
        Modifier.fillMaxWidth().background(OfficePalette.violet.copy(alpha = 0.08f), shape).border(1.dp, OfficePalette.violet.copy(alpha = 0.35f), shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("✨ Agent · খসড়া · শুধু আপনি দেখছেন", color = OfficePalette.violet, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        val value = editText[m.id] ?: m.body
        OutlinedTextField(value = value, onValueChange = { editText[m.id] = it }, placeholder = { Text("খসড়া…") }, minLines = 1, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Spacer(Modifier.weight(1f))
            if (vm.chatDecidingId == m.id) {
                CircularProgressIndicator(Modifier.size(16.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
            } else {
                Text("❌ খারিজ", color = OfficePalette.red500, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.plainClick { scope.launch { vm.chatAgentDecide(m.id, false, null) } })
                OfficePill("✅ অনুমোদন", OfficePalette.emerald600, true) { scope.launch { vm.chatAgentDecide(m.id, true, editText[m.id]) } }
            }
        }
    }
}

@Composable
private fun OfficeStaffTaskPicker(vm: OfficeState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(AlmaTheme.fill(dark)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("আজকের কাজ — যেটা বুঝছেন না, সেটায় চাপ দিন", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        if (vm.tasks.isEmpty()) {
            Text("আজ আপনার কোনো বাকি কাজ নেই।", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp)
        } else {
            vm.tasks.forEach { t ->
                Row(
                    Modifier.fillMaxWidth().plainClick { if (vm.explainingTaskId == null) scope.launch { vm.explainTask(t.id); onDone() } },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(OfficeFormat.bn(t.serial ?: 0), color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.size(22.dp).background(OfficePalette.coral.copy(alpha = 0.16f), CircleShape).padding(top = 3.dp))
                    Text(t.title, color = AlmaTheme.ink(dark), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (vm.explainingTaskId == t.id) CircularProgressIndicator(Modifier.size(14.dp), color = OfficePalette.coral, strokeWidth = 2.dp)
                    else Text("বুঝিয়ে দিন", color = OfficePalette.accentText(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// ── Owner task sheet (approve · redo · comment · set-due · always-escalate) ──────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfficeOwnerTaskSheet(task: OfficeHubTask, vm: OfficeState, dark: Boolean, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var showRedo by remember { mutableStateOf(false) }
    var showDue by remember { mutableStateOf(false) }
    var alwaysEscalate by remember { mutableStateOf(task.alwaysEscalate) }
    val busy = vm.ownerBusyId == task.id

    LaunchedEffect(task.id) { vm.loadThread(task.id) }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.title, color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("👤 ${task.staffName}", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                if (task.type.isNotEmpty()) Text(task.type, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.background(AlmaTheme.fill(dark), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp))
            }
            task.detail?.takeIf { it.isNotEmpty() }?.let { Text(it, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp) }
        }
        if (task.imageUrls.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("🖼 কাজের প্রমাণ", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    task.imageUrls.forEach { s ->
                        AsyncImage(model = s, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(200.dp).clip(RoundedCornerShape(AlmaTheme.R_CONTROL.dp)))
                    }
                }
            }
        }
        // Thread
        Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("আলোচনা", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
            when {
                vm.threadLoading -> Text("লোড হচ্ছে…", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                vm.thread.isEmpty() -> Text("এখনো কোনো মন্তব্য নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
                else -> vm.thread.forEach { c ->
                    val who = when (c.authorType) { "owner" -> "Boss"; "agent" -> "Agent"; else -> task.staffName }
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("$who · ${OfficeFormat.timeAgo(c.createdAt)}", color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        Text(c.body, color = AlmaTheme.ink(dark), fontSize = 11.sp)
                    }
                }
            }
        }
        OutlinedTextField(value = note, onValueChange = { note = it }, placeholder = { Text("কমেন্ট / নির্দেশনা…") }, minLines = 1, modifier = Modifier.fillMaxWidth())
        // Actions
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OfficeActionBtn("✅ অনুমোদন করুন", OfficePalette.emerald600, true, busy) {
                scope.launch { if (vm.ownerAct(JSONObject().put("action", "approve").put("taskId", task.id), taskId = task.id)) onClose() }
            }
            OfficeActionBtn("🔄 সংশোধনে ফেরত দিন", OfficePalette.amber600, false, busy) { showRedo = true }
            OfficeActionBtn("⏰ আপডেট চান", OfficePalette.violet, false, busy) {
                val body = JSONObject().put("action", "request_update").put("taskId", task.id)
                if (note.isNotEmpty()) body.put("note", note)
                scope.launch { vm.ownerAct(body, taskId = task.id) }
            }
            OfficeActionBtn("📅 ডিউ ডেট সেট করুন", OfficePalette.coral, false, busy) { showDue = true }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("সবসময় Boss-এ পাঠাও", color = AlmaTheme.ink(dark), fontSize = 11.sp)
                Spacer(Modifier.weight(1f))
                Switch(checked = alwaysEscalate, onCheckedChange = { on ->
                    alwaysEscalate = on
                    scope.launch { vm.ownerAct(JSONObject().put("action", "set_always_escalate").put("taskId", task.id).put("on", on), taskId = task.id) }
                })
            }
        }
    }

    if (showRedo) {
        var redoNote by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showRedo = false },
            title = { Text("সংশোধনের নোট") },
            text = { OutlinedTextField(value = redoNote, onValueChange = { redoNote = it }, placeholder = { Text("কী ঠিক করতে হবে…") }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                TextButton(onClick = {
                    showRedo = false
                    val body = JSONObject().put("action", "redo").put("taskId", task.id)
                    if (redoNote.isNotEmpty()) body.put("note", redoNote)
                    scope.launch { if (vm.ownerAct(body, taskId = task.id)) onClose() }
                }) { Text("ফেরত দিন") }
            },
            dismissButton = { TextButton(onClick = { showRedo = false }) { Text("বাতিল") } },
        )
    }
    if (showDue) {
        val state = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDue = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { ms ->
                        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
                        f.timeZone = TimeZone.getTimeZone("UTC")
                        val iso = f.format(Date(ms))
                        scope.launch { vm.ownerAct(JSONObject().put("action", "set_due").put("taskId", task.id).put("dueAt", iso), taskId = task.id) }
                    }
                    showDue = false
                }) { Text("সেট") }
            },
            dismissButton = { TextButton(onClick = { showDue = false }) { Text("বাতিল") } },
        ) { DatePicker(state = state) }
    }
}

@Composable
private fun OfficeActionBtn(label: String, tint: Color, filled: Boolean, busy: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .background(if (filled) tint else tint.copy(alpha = 0.13f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp))
            .then(if (filled) Modifier else Modifier.border(1.dp, tint.copy(alpha = 0.35f), RoundedCornerShape(AlmaTheme.R_CONTROL.dp)))
            .plainClick { if (!busy) onClick() }.padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(16.dp), color = if (filled) Color.White else tint, strokeWidth = 2.dp)
        else Text(label, color = if (filled) Color.White else tint, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

// ── Office history sheet (owner — past boards) ─────────────────────────────────────

@Composable
private fun OfficeHistorySheet(dark: Boolean) {
    var days by remember { mutableStateOf<List<OfficeArchiveDay>?>(null) }
    LaunchedEffect(Unit) {
        days = try {
            val root = AlmaApi.getObject("/api/assistant/office/history")
            (root.optJSONObject("data") ?: root).optJSONArray("days")?.mapObjects { OfficeArchiveDay.from(it) } ?: emptyList()
        } catch (_: Exception) { emptyList() }
    }
    Column(
        Modifier.fillMaxWidth().heightIn(min = 300.dp).padding(horizontal = 14.dp).padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("অফিসের ইতিহাস", color = AlmaTheme.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
        val d = days
        when {
            d == null -> repeat(4) { Box(Modifier.fillMaxWidth().height(64.dp).almaGlass(dark, AlmaTheme.R_CONTROL)) }
            d.isEmpty() -> Text("এখনো কোনো ইতিহাস নেই। দিন শেষে আজকের বোর্ড এখানে জমা হবে।", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, modifier = Modifier.padding(top = 30.dp))
            else -> d.forEach { day ->
                Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(day.label, color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "${OfficeFormat.bn(day.total)}টি কাজ · ${OfficeFormat.bn(day.done)}টি সম্পন্ন · ${OfficeFormat.bn(day.approved)}টি অনুমোদিত · ${OfficeFormat.bn(day.staffCount)} জন স্টাফ",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
                    )
                }
            }
        }
    }
}

// ── Always-visible office chat head (iOS FloatingChatHead parity) ────────────────────

private const val CHATHEAD_PREFS = "alma-native-shell"
private const val CHATHEAD_Y_KEY = "office.chathead.y"
private val CHATHEAD_CORAL = Color(0xFFE6785E)   // iOS 0.902/0.471/0.369
private val CHATHEAD_VIOLET = Color(0xFF8B5CF6)  // iOS 0.545/0.361/0.965

/**
 * The Messenger-style office chat head that floats over the WHOLE app (every tab +
 * pushed screen). Overlay this as the last child of the shell root Box. It self-loads
 * the office role once; with no office session it renders nothing. Drag → snaps to the
 * nearest side edge; tap → office group chat; long-press → walkie-talkie intercom.
 */
@Composable
fun OfficeChatFloatingHead(dark: Boolean, onWeb: (String, String) -> Unit) {
    val vm = remember { OfficeState() }
    LaunchedEffect(Unit) { if (!vm.roleResolved) vm.loadHub() }
    if (!vm.roleResolved || vm.authExpired || vm.selfRole == "none" || vm.selfRole.isBlank()) return

    val ctx = LocalContext.current
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()

    var showChat by remember { mutableStateOf(false) }
    var showIntercom by remember { mutableStateOf(false) }

    val sizePx = with(density) { 60.dp.toPx() }
    val marginPx = with(density) { 12.dp.toPx() }
    val topInsetPx = with(density) {
        WindowInsets.statusBars.asPaddingValues().calculateTopPadding().toPx()
    } + with(density) { 44.dp.toPx() }
    val bottomGuardPx = with(density) { 70.dp.toPx() }

    var size by remember { mutableStateOf(IntSize.Zero) }
    var placed by remember { mutableStateOf(false) }
    val cx = remember { Animatable(0f) }
    val cy = remember { Animatable(0f) }
    val scale = remember { Animatable(1f) }

    LaunchedEffect(size) {
        if (size != IntSize.Zero && !placed) {
            val savedY = ctx.getSharedPreferences(CHATHEAD_PREFS, android.content.Context.MODE_PRIVATE)
                .getFloat(CHATHEAD_Y_KEY, -1f)
            val minY = topInsetPx + sizePx / 2f
            val maxY = size.height - sizePx / 2f - bottomGuardPx
            val y = if (savedY > 0) savedY.coerceIn(minY, maxY) else size.height * 0.60f
            cx.snapTo(size.width - marginPx - sizePx / 2f)
            cy.snapTo(y)
            placed = true
        }
    }

    fun snap(vx: Float) {
        val half = sizePx / 2f
        val minY = topInsetPx + half
        val maxY = size.height - half - bottomGuardPx
        val goRight = if (vx > 250f) true else if (vx < -250f) false else cx.value > size.width / 2f
        val targetX = if (goRight) size.width - marginPx - half else marginPx + half
        val y = cy.value.coerceIn(minY, maxY)
        scope.launch { cx.animateTo(targetX, spring(0.62f, Spring.StiffnessMediumLow, 0.5f)) }
        scope.launch { cy.animateTo(y, spring(0.62f, Spring.StiffnessMediumLow, 0.5f)) }
        scope.launch { scale.animateTo(1f, tween(150)) }
        ctx.getSharedPreferences(CHATHEAD_PREFS, android.content.Context.MODE_PRIVATE)
            .edit().putFloat(CHATHEAD_Y_KEY, y).apply()
    }

    Box(Modifier.fillMaxSize().onSizeChanged { size = it }) {
        if (placed) {
            Box(
                Modifier
                    .zIndex(30f)
                    .graphicsLayer {
                        translationX = cx.value - sizePx / 2f
                        translationY = cy.value - sizePx / 2f
                        scaleX = scale.value
                        scaleY = scale.value
                    }
                    .size(60.dp)
                    .shadow(9.dp, CircleShape)
                    .background(Brush.linearGradient(listOf(CHATHEAD_CORAL, CHATHEAD_VIOLET)), CircleShape)
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onTap = {
                                haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                showChat = true
                            },
                            onLongPress = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                showIntercom = true
                            },
                        )
                    }
                    .pointerInput(size) {
                        detectDragGestures(
                            onDragStart = { scope.launch { scale.animateTo(1.12f, tween(150)) } },
                            onDragEnd = { snap(0f) },
                            onDragCancel = { snap(0f) },
                        ) { change, drag ->
                            change.consume()
                            val half = sizePx / 2f
                            scope.launch {
                                cx.snapTo((cx.value + drag.x).coerceIn(half + marginPx, size.width - half - marginPx))
                                cy.snapTo((cy.value + drag.y).coerceIn(topInsetPx + half, size.height - half - bottomGuardPx))
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("💬", fontSize = 24.sp)
            }
        }
    }

    if (showChat) {
        ModalBottomSheet(onDismissRequest = { showChat = false }, containerColor = AlmaTheme.rootBg(dark)) {
            OfficeGroupChatSheet(vm, dark, isOwner = vm.selfRole == "owner", onWeb = onWeb)
        }
    }
    if (showIntercom) {
        IntercomSheet(isOwner = vm.selfRole == "owner", dark = dark, onDismiss = { showIntercom = false })
    }
}
