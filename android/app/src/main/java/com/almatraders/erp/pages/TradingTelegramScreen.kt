//
//  TradingTelegramScreen.kt
//  ALMA ERP — the Telegram Quick Entry monitor (/trading/telegram) ported 1:1 from
//  TradingTelegramSwiftUI.swift (design source of truth).
//
//  Endpoints (same as web/iOS):
//    GET   /api/trading/telegram/drafts?status=…&grouped=1&limit=100 → { drafts, groups }
//    GET   /api/trading/telegram/monitor                             → owner monitoring payload
//    GET   /api/trading/telegram/live?limit=40                       → { drafts, audits, counts } (8s poll)
//    GET   /api/trading/telegram/chats|users|aliases                 → mapping overview
//    PATCH /api/trading/telegram/drafts/{id}  {action, reason?, deleteReason?}
//  Every response tolerates the apiDataSuccess { ok, data:{…} } wrap.
//  Blocks: dark bento hero (trade-green accent, count-up) · tab row (Drafts / Monitor /
//  Live Feed / Groups / Mapping) · draft status filter · grouped draft cards (initials
//  avatar, telegram handle, account, raw-message mono block, status pill) · native
//  draft actions (confirm-to-ledger / reject / request-delete / reopen, Bangla confirm
//  first) · owner-monitoring KPIs · staff pending · suspicious bot activity · live
//  counts strip + latest trades + events · registered groups · user/alias mapping.
//  Bulk mapping writes / edit / webhook stay on the web — footer escape.
//  Carried lessons: ONE spinner per row, lenient org.json decoding, auth card.
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaSession
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.RememberSession
import com.almatraders.erp.shell.almaGlass
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens — iOS twin) ─────────

private object TtPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val red400 = Color(0xFFF87171)
    val amber600 = Color(0xFFD97706)
    val amber500 = Color(0xFFF59E0B)
    val amber300 = Color(0xFFFCD34D)
    val orange500 = Color(0xFFF97316)
    val emerald600 = Color(0xFF059669)
    val green400 = Color(0xFF4ADE80)
    val blue400 = Color(0xFF60A5FA)
    val slate400 = Color(0xFF94A3B8)

    /** Trading accent green (hero accent — matches web trading sage #81B29A). */
    val tradeGreen = Color(0xFF82B399)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim

    /** Web draft status tints: PENDING amber · LOCKED orange · POSTED emerald ·
     *  REJECTED/FAILED red · APPROVED blue · UNDONE slate. */
    fun status(s: String, dark: Boolean): Color = when (s) {
        "PENDING" -> if (dark) amber500 else amber600
        "LOCKED" -> orange500
        "POSTED" -> if (dark) green400 else emerald600
        "APPROVED" -> blue400
        "REJECTED", "FAILED" -> red500
        else -> slate400                     // UNDONE / unknown
    }
}

// ── Models (same field names the web trading-telegram types declare) ────────────────

/** One captured Telegram draft trade — also reused for the live-feed rows. */
private data class TtDraft(
    val id: String,
    val status: String,
    val tradeNumber: Int?,
    val tradeType: String?,
    val usdtAmount: Double?,
    val bdtRate: Double?,
    val feeUsdt: Double?,
    val accountTitle: String?,
    val accountAlias: String?,
    val telegramUsername: String?,
    val telegramUserId: String?,
    val rawMessage: String?,
    val userName: String?,
    val lockedReason: String?,
    val rejectReason: String?,
    val parseError: String?,
    val createdAt: String?,
) {
    /** Web DraftRow headline: "#12 · BUY · 500 USDT @ 122.5 · fee 0.5". */
    val headline: String
        get() {
            val bits = ArrayList<String>()
            tradeNumber?.let { bits.add("#$it") }
            bits.add(tradeType ?: "—")
            bits.add("${TtFormat.num(usdtAmount)} USDT @ ${TtFormat.num(bdtRate)}")
            feeUsdt?.let { if (it != 0.0) bits.add("fee ${TtFormat.num(it)}") }
            return bits.joinToString(" · ")
        }
    val account: String get() = accountTitle ?: accountAlias ?: "—"
    val telegramHandle: String get() = "@${telegramUsername ?: telegramUserId ?: "—"}"

    companion object {
        fun from(o: JSONObject): TtDraft? {
            val id = o.str("id") ?: return null
            return TtDraft(
                id = id,
                status = o.str("status") ?: "PENDING",
                tradeNumber = o.flexInt("tradeNumber"),
                tradeType = o.str("tradeType"),
                usdtAmount = o.flexDouble("usdtAmount"),
                bdtRate = o.flexDouble("bdtRate"),
                feeUsdt = o.flexDouble("feeUsdt"),
                accountTitle = o.str("accountTitle"),
                accountAlias = o.str("accountAlias"),
                telegramUsername = o.str("telegramUsername"),
                telegramUserId = o.str("telegramUserId"),
                rawMessage = o.str("rawMessage"),
                userName = o.optJSONObject("user")?.str("name"),
                lockedReason = o.str("lockedReason"),
                rejectReason = o.str("rejectReason"),
                parseError = o.str("parseError"),
                createdAt = o.str("createdAt"),
            )
        }
    }
}

/** Admin grouped view: one card per (staff × account) with its drafts. */
private data class TtDraftGroup(
    val userName: String,
    val telegramUsername: String?,
    val telegramUserId: String?,
    val accountTitle: String?,
    val accountAlias: String?,
    val drafts: List<TtDraft>,
) {
    val id: String get() = "$userName:${telegramUserId ?: ""}-${accountTitle ?: accountAlias ?: ""}"
    val account: String get() = accountTitle ?: accountAlias ?: "—"
    val telegramHandle: String get() = "@${telegramUsername ?: telegramUserId ?: "—"}"

    companion object {
        fun from(o: JSONObject): TtDraftGroup? {
            val k = o.optJSONObject("key")
            return TtDraftGroup(
                userName = k?.str("userName") ?: "—",
                telegramUsername = k?.str("telegramUsername"),
                telegramUserId = k?.str("telegramUserId"),
                accountTitle = k?.str("accountTitle"),
                accountAlias = k?.str("accountAlias"),
                drafts = o.optJSONArray("drafts")?.mapObjects { TtDraft.from(it) } ?: emptyList(),
            )
        }
    }
}

/** Bot audit event (duplicates · undo · suspicious activity). */
private data class TtAudit(
    val id: String,
    val eventType: String,
    val telegramUsername: String?,
    val telegramUserId: String?,
    val rawMessage: String?,
    val detail: String?,
    val createdAt: String?,
) {
    companion object {
        fun from(o: JSONObject): TtAudit? {
            val id = o.str("id") ?: return null
            return TtAudit(
                id = id,
                eventType = o.str("eventType") ?: "EVENT",
                telegramUsername = o.str("telegramUsername"),
                telegramUserId = o.str("telegramUserId"),
                rawMessage = o.str("rawMessage"),
                detail = o.str("detail"),
                createdAt = o.str("createdAt"),
            )
        }
    }
}

private data class TtStaffSummary(
    val userId: String,
    val name: String,
    val role: String?,
    val pendingCount: Int,
) {
    companion object {
        fun from(o: JSONObject): TtStaffSummary? { return TtStaffSummary(
            userId = o.str("userId") ?: return null,
            name = o.str("name") ?: "—",
            role = o.str("role"),
            pendingCount = o.flexInt("pendingCount") ?: 0,
        ) }
    }
}

/** GET /api/trading/telegram/monitor payload (owner monitoring). */
private data class TtMonitor(
    val pendingDeleteApprovals: Int,
    val staffSummaries: List<TtStaffSummary>,
    val suspiciousAudits: List<TtAudit>,
    val draftCounts: Map<String, Int>,
) {
    val pendingAll: Int get() = (draftCounts["PENDING"] ?: 0) + (draftCounts["LOCKED"] ?: 0)
    val postedQueue: Int get() = draftCounts["POSTED"] ?: 0

    companion object {
        fun from(c: JSONObject): TtMonitor {
            val counts = HashMap<String, Int>()
            c.optJSONObject("draftCounts")?.let { dc ->
                for (key in dc.keys()) dc.flexInt(key)?.let { counts[key] = it }
            }
            return TtMonitor(
                pendingDeleteApprovals = c.flexInt("pendingDeleteApprovals") ?: 0,
                staffSummaries = c.optJSONArray("staffSummaries")?.mapObjects { TtStaffSummary.from(it) } ?: emptyList(),
                suspiciousAudits = c.optJSONArray("suspiciousAudits")?.mapObjects { TtAudit.from(it) } ?: emptyList(),
                draftCounts = counts,
            )
        }
    }
}

/** GET /api/trading/telegram/live payload — { drafts, audits, counts }. */
private data class TtLive(
    val drafts: List<TtDraft>,
    val audits: List<TtAudit>,
    val pending: Int,
    val locked: Int,
    val rejected: Int,
    val posted: Int,
    val undone: Int,
) {
    companion object {
        fun from(c: JSONObject): TtLive {
            val counts = c.optJSONObject("counts")
            return TtLive(
                drafts = c.optJSONArray("drafts")?.mapObjects { TtDraft.from(it) } ?: emptyList(),
                audits = c.optJSONArray("audits")?.mapObjects { TtAudit.from(it) } ?: emptyList(),
                pending = counts?.flexInt("pending") ?: 0,
                locked = counts?.flexInt("locked") ?: 0,
                rejected = counts?.flexInt("rejected") ?: 0,
                posted = counts?.flexInt("posted") ?: 0,
                undone = counts?.flexInt("undone") ?: 0,
            )
        }
    }
}

/** Registered Telegram group (Groups tab). */
private data class TtChat(
    val id: String,
    val chatId: String,
    val title: String?,
    val approved: Boolean,
    val lastSeenAt: String?,
) {
    companion object {
        fun from(o: JSONObject): TtChat? { return TtChat(
            id = o.str("id") ?: return null,
            chatId = o.str("chatId") ?: "—",
            title = o.str("title"),
            approved = o.flexBool("approved") ?: false,
            lastSeenAt = o.str("lastSeenAt"),
        ) }
    }
}

/** Telegram → ERP staff mapping row (Mapping tab). */
private data class TtUser(
    val id: String,
    val telegramUserId: String?,
    val telegramUsername: String?,
    val approved: Boolean,
    val defaultAccountAlias: String?,
    val userName: String?,
) {
    companion object {
        fun from(o: JSONObject): TtUser? { return TtUser(
            id = o.str("id") ?: return null,
            telegramUserId = o.str("telegramUserId"),
            telegramUsername = o.str("telegramUsername"),
            approved = o.flexBool("approved") ?: false,
            defaultAccountAlias = o.str("defaultAccountAlias"),
            userName = o.optJSONObject("user")?.str("name"),
        ) }
    }
}

/** Account alias row ("bkash1" → trading account). */
private data class TtAlias(
    val id: String,
    val alias: String,
    val active: Boolean,
    val accountTitle: String?,
) {
    companion object {
        fun from(o: JSONObject): TtAlias? { return TtAlias(
            id = o.str("id") ?: return null,
            alias = o.str("alias") ?: "—",
            active = o.flexBool("active") ?: false,
            accountTitle = o.optJSONObject("tradingAccount")?.str("accountTitle"),
        ) }
    }
}

// ── Statics (top-level vals — never companion stored lists) ─────────────────────────

private val ttTabs = listOf(
    "drafts" to "Drafts",
    "monitor" to "Monitor",
    "live" to "Live Feed",
    "groups" to "Groups",
    "mapping" to "Mapping",
)
private val ttStatuses = listOf("PENDING", "LOCKED", "ALL", "REJECTED", "POSTED")

// ── State holder (iOS TradingTelegramVM twin) ───────────────────────────────────────

private class TradingTelegramState {
    var tab by mutableStateOf("drafts")
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    // Drafts tab
    var drafts by mutableStateOf(listOf<TtDraft>())
    var draftGroups by mutableStateOf(listOf<TtDraftGroup>())
    var draftStatus by mutableStateOf("PENDING")

    // Monitor tab (also feeds the hero KPIs)
    var monitor by mutableStateOf<TtMonitor?>(null)

    // Live tab (8s poll while visible, same as the web feed)
    var live by mutableStateOf<TtLive?>(null)

    // Groups + mapping tabs (fetched lazily the first time those tabs open)
    var chats by mutableStateOf(listOf<TtChat>())
    var users by mutableStateOf(listOf<TtUser>())
    var aliases by mutableStateOf(listOf<TtAlias>())
    var mappingLoaded by mutableStateOf(false)

    // Native draft actions — one spinner per row, never global.
    var toast by mutableStateOf<String?>(null)
    var actingDraftId by mutableStateOf<String?>(null)

    val pendingCount: Int get() = drafts.count { it.status == "PENDING" }

    /** Tolerate the apiDataSuccess { ok, data:{…} } wrap on every payload. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** First paint + refresh: drafts list + owner monitor together. */
    suspend fun load() {
        loading = true
        error = null
        try {
            val c = unwrap(
                AlmaApi.getObject(
                    "/api/trading/telegram/drafts",
                    mapOf("status" to draftStatus, "limit" to "100", "grouped" to "1"),
                ),
            )
            drafts = c.optJSONArray("drafts")?.mapObjects { TtDraft.from(it) } ?: emptyList()
            draftGroups = c.optJSONArray("groups")?.mapObjects { TtDraftGroup.from(it) } ?: emptyList()
            authExpired = false
            // Monitor payload feeds the hero card — non-fatal if the role can't see it.
            try {
                monitor = TtMonitor.from(unwrap(AlmaApi.getObject("/api/trading/telegram/monitor")))
            } catch (_: Exception) { }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    /** PATCH /api/trading/telegram/drafts/{id} — approve | reject | reopen |
     *  request_delete. Web TradingTelegramAdmin payload verbatim. */
    suspend fun draftAction(id: String, action: String, reason: String? = null, deleteReason: String? = null) {
        if (actingDraftId != null) return
        actingDraftId = id
        try {
            val body = JSONObject().put("action", action)
            reason?.let { body.put("reason", it) }
            deleteReason?.let { body.put("deleteReason", it) }
            val resp = AlmaApi.send("PATCH", "/api/trading/telegram/drafts/$id", body)
            val data = resp.optJSONObject("data") ?: resp
            val err = data.str("error") ?: resp.str("error")
            if (err != null) {
                toast = err
            } else {
                toast = when (action) {
                    "approve" -> "Trade confirmed to ledger"
                    "reject" -> "Draft rejected"
                    "reopen" -> "Draft reopened"
                    else -> "Delete request sent to admin for approval"
                }
                actingDraftId = null
                load()
            }
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            toast = e.message
        } finally {
            actingDraftId = null
        }
    }

    suspend fun loadLive() {
        try {
            live = TtLive.from(unwrap(AlmaApi.getObject("/api/trading/telegram/live", mapOf("limit" to "40"))))
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            if (live == null) error = e.message
        }
    }

    suspend fun loadMapping(force: Boolean = false) {
        if (mappingLoaded && !force) return
        try {
            chats = unwrap(AlmaApi.getObject("/api/trading/telegram/chats"))
                .optJSONArray("chats")?.mapObjects { TtChat.from(it) } ?: emptyList()
            users = unwrap(AlmaApi.getObject("/api/trading/telegram/users"))
                .optJSONArray("users")?.mapObjects { TtUser.from(it) } ?: emptyList()
            aliases = unwrap(AlmaApi.getObject("/api/trading/telegram/aliases"))
                .optJSONArray("aliases")?.mapObjects { TtAlias.from(it) } ?: emptyList()
            mappingLoaded = true
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            if (!mappingLoaded) error = e.message
        }
    }
}

// ── Screen ──────────────────────────────────────────────────────────────────────────

@Composable
fun TradingTelegramScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    // Role gating (defense-in-depth) — on web only admins see Monitor / Live Feed / Groups /
    // Mapping (users+aliases) / Webhook-setup; staff see just their own Drafts tab (and
    // confirm their own drafts — the quick entry that stays). Server remains authority.
    RememberSession()
    val canManage = AlmaSession.isAdmin
    val vm = remember { TradingTelegramState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { vm.load() }

    // Poll the live feed only while that tab is on screen (web 8s parity) —
    // key change / leaving composition cancels this coroutine.
    LaunchedEffect(vm.tab) {
        if (vm.tab == "live") {
            while (true) {
                vm.loadLive()
                delay(8_000)
            }
        }
    }

    // Toast auto-dismiss (iOS: 2.6s bottom capsule).
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
                TtHeroCard(
                    pending = vm.monitor?.pendingAll ?: vm.pendingCount,
                    posted = vm.monitor?.postedQueue ?: 0,
                    deletes = vm.monitor?.pendingDeleteApprovals ?: 0,
                )
            }
            item { TtTabChips(vm, canManage, dark, scope) }
            if (vm.authExpired) {
                item { TtAuthCard(dark) { ctx.openWebForced("/login", "Login") } }
            }
            vm.error?.let { item { TtErrorCard(it, dark) } }

            if (vm.loading && vm.drafts.isEmpty() && vm.draftGroups.isEmpty()) {
                items(5) { Box(Modifier.fillMaxWidth().height(84.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
            } else {
                when (vm.tab) {
                    "drafts" -> {
                        item { TtStatusChips(vm, dark, scope) }
                        item { TtInfoBanner(dark) }
                        if (vm.drafts.isEmpty() && vm.draftGroups.isEmpty()) {
                            item { TtEmptyState("কোনো Telegram ড্রাফট নেই", "✈️", dark) }
                        } else if (vm.draftGroups.isNotEmpty()) {
                            items(vm.draftGroups, key = { it.id }) { g -> TtGroupCard(g, vm, dark, scope) }
                        } else {
                            items(vm.drafts, key = { it.id }) { d ->
                                Column(Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp)) {
                                    TtDraftBody(d, showMeta = true, vm, dark, scope)
                                }
                            }
                        }
                    }
                    // Admin-only tabs — guarded so a non-admin can never render them even
                    // if `tab` were somehow set to one (fail-closed defense-in-depth).
                    "monitor" -> if (canManage) ttMonitorSection(vm, dark)
                    "live" -> if (canManage) ttLiveSection(vm, dark)
                    "groups" -> if (canManage) ttGroupsSection(vm, dark)
                    "mapping" -> if (canManage) ttMappingSection(vm, dark)
                }
            }

            item {
                // Web escape: confirm bulk / edit / mapping writes stay on the web.
                Text(
                    "🌐 কনফার্ম / এডিট / ম্যাপিং — ওয়েবে খুলুন",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .plainClick { ctx.openWebForced("/trading/telegram", "Telegram Quick Entry") }
                        .padding(vertical = 6.dp),
                )
            }
            item { Spacer(Modifier.height(8.dp)) }
        }

        vm.toast?.let { t ->
            Text(
                t,
                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .almaGlass(dark, 22)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}

// ── Hero (bento dark anchor — trade-green accent, iOS TradingTelegramHeroCard) ──────

@Composable
private fun TtHeroCard(pending: Int, posted: Int, deletes: Int) {
    val shape = RoundedCornerShape(AlmaTheme.R_CARD.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .clip(shape)
            .background(Color(0xFF181528))          // iOS (0.094, 0.082, 0.157)
            .drawBehind {
                drawRect(
                    Brush.linearGradient(
                        listOf(TtPalette.tradeGreen.copy(alpha = 0.30f), Color.Transparent),
                        start = Offset.Zero,
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.linearGradient(
                        listOf(AlmaTheme.violet.copy(alpha = 0.26f), Color.Transparent),
                        start = Offset(size.width, size.height),
                        end = Offset(size.width * 0.5f, size.height * 0.5f),
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(AlmaTheme.coral.copy(alpha = 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.05f),
                        radius = 220.dp.toPx(),
                    ),
                )
            }
            .border(1.dp, Color.White.copy(alpha = 0.16f), shape)
            .padding(16.dp),
    ) {
        Text(
            "TELEGRAM QUICK ENTRY · TRADING",
            color = TtPalette.tradeGreen, fontSize = 10.sp, fontWeight = FontWeight.Bold,
            letterSpacing = 0.8.sp,
        )
        TtCountUp(pending, Color.White, 40.sp)
        Text(
            "পেন্ডিং ড্রাফট — স্টাফের কনফার্মের অপেক্ষায়",
            color = Color.White.copy(alpha = 0.6f), fontSize = 11.sp,
            modifier = Modifier.padding(top = 5.dp),
        )
        Row(Modifier.padding(top = 14.dp)) {
            TtHeroStat("POSTED", posted, TtPalette.green400, "লেজারে গেছে")
            Box(
                Modifier
                    .padding(horizontal = 14.dp, vertical = 2.dp)
                    .width(1.dp)
                    .height(44.dp)
                    .background(Color.White.copy(alpha = 0.14f)),
            )
            TtHeroStat("DELETE REQ.", deletes, TtPalette.amber300, "অ্যাপ্রুভাল দরকার")
        }
    }
}

@Composable
private fun TtHeroStat(label: String, value: Int, tint: Color, sub: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label, color = Color.White.copy(alpha = 0.55f),
            fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp,
        )
        TtCountUp(value, tint, 20.sp)
        Text(sub, color = Color.White.copy(alpha = 0.5f), fontSize = 9.sp)
    }
}

/** Count-up number, 0 → target on first appearance (iOS TradingTelegramCountUp). */
@Composable
private fun TtCountUp(target: Int, color: Color, fontSize: TextUnit) {
    var started by remember { mutableStateOf(false) }
    val shown by animateIntAsState(
        targetValue = if (started) target else 0,
        animationSpec = tween(900),
        label = "ttCountUp",
    )
    LaunchedEffect(Unit) { started = true }
    Text("$shown", color = color, fontSize = fontSize, fontWeight = FontWeight.Black, maxLines = 1)
}

// ── Tab + status chips ──────────────────────────────────────────────────────────────

@Composable
private fun TtTabChips(vm: TradingTelegramState, canManage: Boolean, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    // Non-admins get only the Drafts tab (their own quick entry); the rest are admin-only.
    val visibleTabs = if (canManage) ttTabs else ttTabs.filter { it.first == "drafts" }
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        visibleTabs.forEach { (key, label) ->
            val active = vm.tab == key
            val badge = if (key == "drafts") vm.pendingCount else 0
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .background(
                        if (active) TtPalette.tradeGreen.copy(alpha = if (dark) 0.28f else 0.16f)
                        else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                        CircleShape,
                    )
                    .border(
                        1.dp,
                        if (active) TtPalette.tradeGreen.copy(alpha = 0.55f)
                        else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                        CircleShape,
                    )
                    .plainClick {
                        vm.tab = key
                        if (key == "groups" || key == "mapping") scope.launch { vm.loadMapping() }
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
            ) {
                Text(
                    label,
                    color = if (active) TtPalette.tradeGreen else AlmaTheme.inkSecondary(dark),
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                )
                if (badge > 0) {
                    Text(
                        "$badge",
                        color = AlmaTheme.inkSecondary(dark),
                        fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun TtStatusChips(vm: TradingTelegramState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ttStatuses.forEach { s ->
            val active = vm.draftStatus == s
            val tint = if (s == "ALL") TtPalette.coral else TtPalette.status(s, dark)
            Text(
                if (s == "ALL") "All" else s.lowercase().replaceFirstChar { it.uppercase() },
                color = if (active) tint else AlmaTheme.inkSecondary(dark),
                fontSize = 12.sp,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier
                    .background(
                        if (active) tint.copy(alpha = if (dark) 0.24f else 0.14f)
                        else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                        CircleShape,
                    )
                    .border(
                        1.dp,
                        if (active) tint.copy(alpha = 0.5f)
                        else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                        CircleShape,
                    )
                    .plainClick {
                        vm.draftStatus = s
                        scope.launch { vm.load() }
                    }
                    .padding(horizontal = 11.dp, vertical = 6.dp),
            )
        }
    }
}

/** Web amber banner: staff confirm their own drafts — the boss monitors. */
@Composable
private fun TtInfoBanner(dark: Boolean) {
    val shape = RoundedCornerShape(AlmaTheme.R_CONTROL.dp)
    Text(
        "ℹ️ স্টাফরা নিজেদের ড্রাফট নিজেরাই কনফার্ম করে — কনফার্মের আগে ব্যালান্স বদলায় না। কনফার্ম/এডিট ওয়েবে।",
        color = if (dark) TtPalette.amber300 else TtPalette.amber600,
        fontSize = 12.sp,
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(TtPalette.amber500.copy(alpha = if (dark) 0.10f else 0.08f))
            .border(1.dp, TtPalette.amber500.copy(alpha = 0.25f), shape)
            .padding(12.dp),
    )
}

// ── Draft cards (web DraftRow / grouped cards) ──────────────────────────────────────

@Composable
private fun TtGroupCard(g: TtDraftGroup, vm: TradingTelegramState, dark: Boolean, scope: kotlinx.coroutines.CoroutineScope) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier
                    .size(34.dp)
                    .background(TtPalette.tradeGreen.copy(alpha = 0.14f), CircleShape)
                    .border(1.dp, TtPalette.tradeGreen.copy(alpha = 0.35f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    TtFormat.initials(g.userName),
                    color = TtPalette.tradeGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    g.userName, color = AlmaTheme.ink(dark),
                    fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${g.telegramHandle} · ${g.account}",
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                "${g.drafts.size}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }
        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.4f))
        g.drafts.forEach { d ->
            TtDraftBody(d, showMeta = false, vm, dark, scope)
        }
    }
}

@Composable
private fun TtDraftBody(
    d: TtDraft,
    showMeta: Boolean,
    vm: TradingTelegramState,
    dark: Boolean,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    var confirmingApprove by remember(d.id) { mutableStateOf(false) }
    var askingReject by remember(d.id) { mutableStateOf(false) }
    var rejectReason by remember(d.id) { mutableStateOf("") }
    var askingDelete by remember(d.id) { mutableStateOf(false) }
    var deleteReason by remember(d.id) { mutableStateOf("") }
    val acting = vm.actingDraftId == d.id

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                d.headline,
                color = AlmaTheme.ink(dark), fontSize = 13.sp, fontWeight = FontWeight.Bold,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TtStatusPill(d.status, dark)
        }
        if (showMeta) {
            Text(
                "ERP: ${d.userName ?: "—"} · ${d.telegramHandle}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                "Account: ${d.account}",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        d.lockedReason?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = TtPalette.orange500, fontSize = 11.sp)
        }
        d.rejectReason?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = TtPalette.red400, fontSize = 11.sp)
        }
        d.parseError?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = TtPalette.amber500, fontSize = 11.sp)
        }
        d.rawMessage?.takeIf { it.isNotEmpty() }?.let { raw ->
            Text(
                raw,
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AlmaTheme.ink(dark).copy(alpha = 0.05f), RoundedCornerShape(10.dp))
                    .padding(8.dp),
            )
        }
        d.createdAt?.let {
            Text(TtFormat.whenAt(it), color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp)
        }

        // Native draft actions (owner 2026-07-11): confirm-to-ledger / reject /
        // request-delete on PENDING·LOCKED, reopen on REJECTED — web parity.
        if (d.status == "PENDING" || d.status == "LOCKED") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TtActionButton("লেজারে পোস্ট", TtPalette.tradeGreen, acting) { confirmingApprove = true }
                TtActionButton("Reject", TtPalette.red400, acting) { rejectReason = ""; askingReject = true }
                TtActionButton("Delete?", TtPalette.amber500, acting) { deleteReason = ""; askingDelete = true }
            }
        } else if (d.status == "REJECTED") {
            Row {
                TtActionButton("Reopen", TtPalette.orange500, acting) {
                    scope.launch { vm.draftAction(d.id, "reopen") }
                }
            }
        }
    }

    if (confirmingApprove) {
        AlertDialog(
            onDismissRequest = { confirmingApprove = false },
            title = { Text("এই draft লেজারে পোস্ট করবেন? Balance আর P/L বদলাবে।") },
            text = { Text(d.headline) },
            confirmButton = {
                TextButton(onClick = {
                    confirmingApprove = false
                    scope.launch { vm.draftAction(d.id, "approve") }
                }) { Text("হ্যাঁ, পোস্ট করুন") }
            },
            dismissButton = { TextButton(onClick = { confirmingApprove = false }) { Text("বাতিল") } },
        )
    }

    if (askingReject) {
        AlertDialog(
            onDismissRequest = { askingReject = false },
            title = { Text("Reject reason?") },
            text = {
                OutlinedTextField(
                    value = rejectReason,
                    onValueChange = { rejectReason = it },
                    placeholder = { Text("Rejected") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    askingReject = false
                    val r = rejectReason.trim().ifEmpty { "Rejected" }
                    scope.launch { vm.draftAction(d.id, "reject", reason = r) }
                }) { Text("Reject", color = TtPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { askingReject = false }) { Text("বাতিল") } },
        )
    }

    if (askingDelete) {
        AlertDialog(
            onDismissRequest = { askingDelete = false },
            title = { Text("Delete request-এর কারণ?") },
            text = {
                OutlinedTextField(
                    value = deleteReason,
                    onValueChange = { deleteReason = it },
                    placeholder = { Text("Why delete this draft?") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val r = deleteReason.trim()
                        if (r.isNotEmpty()) {
                            askingDelete = false
                            scope.launch { vm.draftAction(d.id, "request_delete", deleteReason = r) }
                        }
                    },
                ) { Text("Request delete", color = TtPalette.red500) }
            },
            dismissButton = { TextButton(onClick = { askingDelete = false }) { Text("বাতিল") } },
        )
    }
}

@Composable
private fun TtActionButton(label: String, tint: Color, busy: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.3f), CircleShape)
            .plainClick { if (!busy) onClick() }
            .padding(horizontal = 10.dp, vertical = 7.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(10.dp), color = tint, strokeWidth = 1.5.dp)
        }
        Text(label, color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun TtStatusPill(status: String, dark: Boolean) {
    val tint = TtPalette.status(status, dark)
    Text(
        status,
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.13f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

// ── Monitor tab (web "Owner monitoring" card + staff pending + suspicious) ──────────

private fun androidx.compose.foundation.lazy.LazyListScope.ttMonitorSection(vm: TradingTelegramState, dark: Boolean) {
    val m = vm.monitor
    if (m == null) {
        item { TtLoadingCard("মনিটর ডেটা লোড হচ্ছে…", dark) }
        return
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "OWNER MONITORING",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            Text(
                "স্টাফরা নিজেদের ড্রাফট কনফার্ম করে — আপনি অপারেশন আর রিস্ক দেখেন।",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            Row(verticalAlignment = Alignment.Top) {
                TtMonitorKpi("PENDING DELETES", m.pendingDeleteApprovals, if (dark) TtPalette.amber300 else TtPalette.amber600, dark)
                TtKpiDivider(dark)
                TtMonitorKpi("PENDING DRAFTS", m.pendingAll, AlmaTheme.ink(dark), dark)
                TtKpiDivider(dark)
                TtMonitorKpi("POSTED (QUEUE)", m.postedQueue, if (dark) TtPalette.green400 else TtPalette.emerald600, dark)
            }
        }
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "STAFF PENDING BY USER",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (m.staffSummaries.isEmpty()) {
                Text("কোনো স্টাফের ড্রাফট পেন্ডিং নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                m.staffSummaries.forEach { s ->
                    Row {
                        Text(s.name, color = AlmaTheme.ink(dark), fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text(
                            "${s.pendingCount} pending",
                            color = if (dark) TtPalette.amber300 else TtPalette.amber600,
                            fontSize = 12.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "SUSPICIOUS BOT ACTIVITY",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (m.suspiciousAudits.isEmpty()) {
                Text("সাম্প্রতিক কোনো অ্যালার্ট নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                m.suspiciousAudits.forEach { a -> TtAuditRow(a, dark) }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.TtMonitorKpi(label: String, value: Int, tint: Color, dark: Boolean) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            label, color = AlmaTheme.inkSecondary(dark),
            fontSize = 8.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text("$value", color = tint, fontSize = 22.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun TtKpiDivider(dark: Boolean) {
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .width(1.dp)
            .height(38.dp)
            .background(AlmaTheme.ink(dark).copy(alpha = 0.10f)),
    )
}

@Composable
private fun TtAuditRow(a: TtAudit, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(AlmaTheme.ink(dark).copy(alpha = 0.04f), RoundedCornerShape(10.dp))
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                a.eventType,
                color = TtPalette.accentText(dark), fontSize = 11.sp, fontWeight = FontWeight.Bold,
            )
            (a.telegramUsername ?: a.telegramUserId)?.let { who ->
                Text("@$who", color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp)
            }
            Spacer(Modifier.weight(1f))
            a.createdAt?.let {
                Text(TtFormat.whenAt(it), color = AlmaTheme.inkTertiary(dark), fontSize = 9.sp)
            }
        }
        (a.detail ?: a.rawMessage)?.takeIf { it.isNotEmpty() }?.let { text ->
            Text(
                text, color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── Live tab (counts strip + latest trades + events, 8s poll like web) ──────────────

private fun androidx.compose.foundation.lazy.LazyListScope.ttLiveSection(vm: TradingTelegramState, dark: Boolean) {
    val live = vm.live
    if (live == null) {
        item { TtLoadingCard("লাইভ ফিড লোড হচ্ছে…", dark) }
        return
    }
    item {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TtLiveCell("PENDING", live.pending, if (dark) TtPalette.amber500 else TtPalette.amber600, dark)
            TtLiveCell("LOCKED", live.locked, TtPalette.orange500, dark)
            TtLiveCell("POSTED", live.posted, if (dark) TtPalette.green400 else TtPalette.emerald600, dark)
            TtLiveCell("REJECTED", live.rejected, TtPalette.red500, dark)
            TtLiveCell("UNDONE", live.undone, TtPalette.slate400, dark)
        }
    }
    item {
        Text(
            "প্রতি ৮ সেকেন্ডে রিফ্রেশ হচ্ছে · লাইভ ভিউ",
            color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp,
        )
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "LATEST TRADES",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (live.drafts.isEmpty()) {
                Text("সাম্প্রতিক কোনো ড্রাফট নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                live.drafts.forEachIndexed { i, d ->
                    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                d.headline,
                                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            TtStatusPill(d.status, dark)
                        }
                        Text(
                            "${d.userName ?: "—"} · ${d.telegramHandle} · ${d.account}",
                            color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (i != live.drafts.lastIndex) {
                        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.3f))
                    }
                }
            }
        }
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "EVENTS (DUPLICATES · UNDO)",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (live.audits.isEmpty()) {
                Text("সাম্প্রতিক কোনো ইভেন্ট নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                live.audits.forEach { a -> TtAuditRow(a, dark) }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.TtLiveCell(label: String, value: Int, tint: Color, dark: Boolean) {
    Column(
        Modifier.weight(1f).almaGlass(dark, AlmaTheme.R_CONTROL).padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("$value", color = tint, fontSize = 15.sp, fontWeight = FontWeight.Black)
        Text(
            label, color = AlmaTheme.inkSecondary(dark),
            fontSize = 8.sp, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

// ── Groups tab (registered Telegram groups — read-only list) ────────────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.ttGroupsSection(vm: TradingTelegramState, dark: Boolean) {
    if (!vm.mappingLoaded) {
        item { TtLoadingCard("গ্রুপ লিস্ট লোড হচ্ছে…", dark) }
        return
    }
    if (vm.chats.isEmpty()) {
        item { TtEmptyState("কোনো গ্রুপ রেজিস্টার করা নেই", "👥", dark) }
        return
    }
    items(vm.chats, key = { it.id }) { c ->
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    c.chatId,
                    color = AlmaTheme.ink(dark), fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                TtApprovedPill(c.approved, dark)
            }
            Text(
                if (c.title.isNullOrEmpty()) "Untitled group" else c.title,
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
            )
            Text(
                "Last message: ${TtFormat.whenAt(c.lastSeenAt)}",
                color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun TtApprovedPill(approved: Boolean, dark: Boolean) {
    val tint = if (approved) {
        if (dark) TtPalette.green400 else TtPalette.emerald600
    } else {
        if (dark) TtPalette.amber300 else TtPalette.amber600
    }
    Text(
        if (approved) "Approved" else "Inactive",
        color = tint, fontSize = 9.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

// ── Mapping tab (users + aliases overview — writes stay on the web) ─────────────────

private fun androidx.compose.foundation.lazy.LazyListScope.ttMappingSection(vm: TradingTelegramState, dark: Boolean) {
    if (!vm.mappingLoaded) {
        item { TtLoadingCard("ম্যাপিং লোড হচ্ছে…", dark) }
        return
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "TELEGRAM USERS (${vm.users.size})",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (vm.users.isEmpty()) {
                Text("কোনো Telegram ইউজার লিঙ্ক করা নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                vm.users.forEachIndexed { i, u ->
                    Row(
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.padding(vertical = 3.dp),
                    ) {
                        Box(
                            Modifier
                                .size(28.dp)
                                .background(TtPalette.tradeGreen.copy(alpha = 0.14f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                TtFormat.initials(u.userName ?: u.telegramUsername ?: "?"),
                                color = TtPalette.tradeGreen, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(
                                u.userName ?: "Unlinked",
                                color = AlmaTheme.ink(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                "@${u.telegramUsername ?: "—"} · ID ${u.telegramUserId ?: "—"}",
                                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            u.defaultAccountAlias?.takeIf { it.isNotEmpty() }?.let {
                                Text("Default: $it", color = AlmaTheme.inkTertiary(dark), fontSize = 11.sp)
                            }
                        }
                        Text(
                            if (u.approved) "Approved" else "Pending",
                            color = if (u.approved) {
                                if (dark) TtPalette.green400 else TtPalette.emerald600
                            } else {
                                if (dark) TtPalette.amber300 else TtPalette.amber600
                            },
                            fontSize = 9.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                    if (i != vm.users.lastIndex) {
                        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.3f))
                    }
                }
            }
        }
    }
    item {
        Column(
            Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "ACCOUNT ALIASES (${vm.aliases.size})",
                color = AlmaTheme.inkSecondary(dark), fontSize = 11.sp, fontWeight = FontWeight.Black,
            )
            if (vm.aliases.isEmpty()) {
                Text("কোনো অ্যাকাউন্ট অ্যালিয়াস নেই", color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
            } else {
                vm.aliases.forEachIndexed { i, a ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(vertical = 3.dp),
                    ) {
                        Text(
                            a.alias,
                            color = TtPalette.accentText(dark), fontSize = 12.sp,
                            fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                        )
                        Text("→", color = AlmaTheme.inkTertiary(dark), fontSize = 10.sp)
                        Text(
                            a.accountTitle ?: "—",
                            color = AlmaTheme.ink(dark), fontSize = 12.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Box(
                            Modifier
                                .size(7.dp)
                                .background(if (a.active) TtPalette.green400 else TtPalette.slate400, CircleShape),
                        )
                    }
                    if (i != vm.aliases.lastIndex) {
                        HorizontalDivider(color = AlmaTheme.separator(dark).copy(alpha = 0.3f))
                    }
                }
            }
        }
    }
}

// ── Shared bits ─────────────────────────────────────────────────────────────────────

@Composable
private fun TtAuthCard(dark: Boolean, onLogin: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন",
            color = AlmaTheme.ink(dark), fontSize = 14.sp, textAlign = TextAlign.Center,
        )
        Text(
            "লগইন খুলুন",
            color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(TtPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

@Composable
private fun TtErrorCard(message: String, dark: Boolean) {
    Text(
        "⚠️ $message",
        color = TtPalette.red500, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
    )
}

@Composable
private fun TtLoadingCard(message: String, dark: Boolean) {
    Row(
        Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CARD).padding(24.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(14.dp), color = TtPalette.coral, strokeWidth = 2.dp)
        Text(message, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp)
    }
}

@Composable
private fun TtEmptyState(message: String, icon: String, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 50.dp, bottom = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(icon, fontSize = 34.sp)
        Text(message, color = AlmaTheme.inkSecondary(dark), fontSize = 15.sp)
    }
}

// ── Formatting helpers (iOS TradingTelegramFormat twin) ─────────────────────────────

private object TtFormat {
    fun initials(name: String): String {
        val letters = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first() }
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    /** Trim trailing zeros: 500.0 → "500", 122.50 → "122.5". */
    fun num(value: Double?): String {
        if (value == null) return "—"
        if (value == Math.floor(value) && Math.abs(value) < 1e12) return "${value.toLong()}"
        return String.format(Locale.US, "%.2f", value).trimEnd('0').trimEnd('.')
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

    /** ISO wire timestamp → "8 Jul · 3:42 pm" (Never / raw string on parse miss). */
    fun whenAt(at: String?): String {
        if (at.isNullOrEmpty()) return "Never"
        val d = parse(at) ?: return at
        val f = SimpleDateFormat("d MMM · h:mm a", Locale.UK)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(d)
    }
}
