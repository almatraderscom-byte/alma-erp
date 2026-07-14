//
//  AgentWhatsappScreen.kt
//  ALMA ERP — the owner's WhatsApp inbox, ported 1:1 from AgentWhatsappSwiftUI.swift
//  (read-only). Blocks: filter chips (সব / Reply বাকি) · Messages-style conversation
//  rows (initials avatar · 1-line preview · unread badge · 24h-window countdown pill,
//  amber when the WhatsApp business window is about to close) · read-only thread
//  sheet (customer bubbles left, business bubbles right with coral tint) · 5s poll
//  like the web · web escape hatch. SENDING stays on the web (agent-composed replies).
//
//  Endpoint (same as web/iOS):
//    GET /api/assistant/wa-inbox → { ok, count, awaitingReply, threads:[
//        { id, number, name, lastMessage, lastAt, needsReply,
//          messages:[{ from: "them"|"us", text, at }] } ] }
//

package com.almatraders.erp.pages

import kotlinx.coroutines.CancellationException

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// ── Web palette (exact hexes from globals.css / tailwind tokens) ───────────────────

private object WaPalette {
    val coral = AlmaTheme.coral
    val goldLt = Color(0xFFF4A28C)
    val goldDim = Color(0xFFC45A3C)
    val red500 = Color(0xFFEF4444)
    val amber600 = Color(0xFFD97706)
    val emerald600 = Color(0xFF059669)

    fun accentText(dark: Boolean): Color = if (dark) goldLt else goldDim
}

// ── Models (same field names /api/assistant/wa-inbox returns) ──────────────────────

private data class WaMessage(
    /** "them" = customer/staff inbound · "us" = business/agent outbound. */
    val from: String,
    val text: String,
    val at: String?,
)

private data class WaThread(
    val id: String,
    val number: String,
    val name: String,
    val lastMessage: String,
    val lastAt: String?,
    val needsReply: Boolean,
    val messages: List<WaMessage>,
) {
    /** The WhatsApp Business 24h service window opens from the LAST inbound
     *  (customer) message — the web stores it implicitly in the message list. */
    val lastCustomerAt: Date?
        get() = messages.lastOrNull { it.from == "them" }?.let { WaFormat.parse(it.at) }

    companion object {
        fun from(o: JSONObject): WaThread? {
            val id = o.str("id") ?: return null
            return WaThread(
                id = id,
                number = o.str("number") ?: "",
                name = o.str("name") ?: "",
                lastMessage = o.str("lastMessage") ?: "",
                lastAt = o.str("lastAt"),
                needsReply = o.flexBool("needsReply") ?: false,
                messages = o.optJSONArray("messages")?.mapObjects { m ->
                    WaMessage(m.str("from") ?: "them", m.str("text") ?: "", m.str("at"))
                } ?: emptyList(),
            )
        }
    }
}

// ── State holder (iOS AgentWhatsappVM twin) ────────────────────────────────────────

private class AgentWhatsappState {
    var threads by mutableStateOf(listOf<WaThread>())
    var filter by mutableStateOf("all")           // all | awaiting (web highlights needsReply)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authExpired by mutableStateOf(false)

    val awaiting: Int get() = threads.count { it.needsReply }
    val visibleThreads: List<WaThread>
        get() = if (filter == "awaiting") threads.filter { it.needsReply } else threads

    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    /** `silent` = the 5s poll (web parity) — no spinner churn, keep the list stable. */
    suspend fun load(silent: Boolean = false) {
        if (!silent) loading = true
        try {
            val c = unwrap(AlmaApi.getObject("/api/assistant/wa-inbox"))
            threads = c.optJSONArray("threads")?.mapObjects { WaThread.from(it) } ?: emptyList()
            error = c.str("error")
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!silent) error = e.message  // background poll fails quietly
        } finally {
            if (!silent) loading = false
        }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentWhatsappScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AgentWhatsappState() }
    val __scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<WaThread?>(null) }

    // Initial load + web-parity 5s poll (cancelled when the screen leaves composition).
    LaunchedEffect(Unit) {
        vm.load()
        while (true) {
            delay(5_000)
            vm.load(silent = true)
        }
    }

    AlmaPullRefresh(refreshing = vm.loading, onRefresh = { __scope.launch { vm.load() } }, dark = dark) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = com.almatraders.erp.shell.LocalHeaderInset.current),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            // Header: filter chips + web sub-header counts.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WaChip("সব", vm.filter == "all", dark) { vm.filter = "all" }
                WaChip("Reply বাকি", vm.filter == "awaiting", dark) { vm.filter = "awaiting" }
                Spacer(Modifier.weight(1f))
                if (vm.threads.isNotEmpty()) {
                    Text(
                        if (vm.loading) "লোড হচ্ছে…"
                        else "${vm.threads.size} চ্যাট" + if (vm.awaiting > 0) " · ${vm.awaiting} reply বাকি" else "",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        if (vm.authExpired) {
            item { WaAuthCard(dark) { ctx.openSmart("/login", "Login") } }
        }
        vm.error?.takeIf { it.isNotEmpty() }?.let {
            item {
                Text(
                    "⚠️ $it", color = WaPalette.red500, fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().almaGlass(dark, AlmaTheme.R_CONTROL).padding(12.dp),
                )
            }
        }
        if (vm.loading && vm.threads.isEmpty()) {
            items(5) { Box(Modifier.fillMaxWidth().height(74.dp).almaGlass(dark, AlmaTheme.R_CARD)) }
        }
        items(vm.visibleThreads, key = { it.id }) { thread ->
            WaThreadRow(thread, dark) { selected = thread }
        }
        if (!vm.loading && vm.visibleThreads.isEmpty() && !vm.authExpired) {
            item { WaEmptyState(vm, dark) }
        }
        item {
            Text(
                "🌐 রিপ্লাই দিতে ও সম্পূর্ণ ভিউ — ওয়েবে খুলুন",
                color = AlmaTheme.inkSecondary(dark).copy(alpha = 0.7f), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .plainClick { ctx.openWebForced("/agent/whatsapp", "WhatsApp inbox") }
                    .padding(vertical = 6.dp),
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }

    selected?.let { snapshot ->
        // Live copy — the 5s poll keeps vm.threads fresh while the sheet is open.
        val live = vm.threads.firstOrNull { it.id == snapshot.id } ?: snapshot
        ModalBottomSheet(onDismissRequest = { selected = null }, containerColor = AlmaTheme.rootBg(dark)) {
            WaThreadSheet(live, dark) {
                selected = null
                ctx.openWebForced("/agent/whatsapp", "WhatsApp inbox")
            }
        }
    }
}

// ── Header chip / empty / auth blocks ──────────────────────────────────────────────

@Composable
private fun WaChip(label: String, active: Boolean, dark: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) WaPalette.accentText(dark) else AlmaTheme.inkSecondary(dark),
        fontSize = 13.sp,
        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .background(
                if (active) WaPalette.coral.copy(alpha = if (dark) 0.28f else 0.14f)
                else Color.White.copy(alpha = if (dark) 0.08f else 0.45f),
                CircleShape,
            )
            .border(
                1.dp,
                if (active) WaPalette.coral.copy(alpha = 0.55f)
                else Color.White.copy(alpha = if (dark) 0.10f else 0.4f),
                CircleShape,
            )
            .plainClick(onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

/** Web empty state, exact strings. */
@Composable
private fun WaEmptyState(vm: AgentWhatsappState, dark: Boolean) {
    Column(
        Modifier.fillMaxWidth().padding(top = 60.dp, bottom = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("💬", fontSize = 34.sp)
        Text(
            if (vm.filter == "awaiting") "কোনো reply বাকি নেই" else "এখনো কোনো মেসেজ আসেনি",
            color = AlmaTheme.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
        )
        if (vm.filter != "awaiting") {
            Text(
                "কেউ আপনার business WhatsApp নম্বরে মেসেজ দিলে সেটা এখানে লাইভ দেখা যাবে — ঠিক WhatsApp-এর মতো।" +
                    if (vm.error == null) " (Twilio inbound webhook সেট থাকলে তবেই মেসেজ এখানে আসবে।)" else "",
                color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 18.dp),
            )
        }
    }
}

@Composable
private fun WaAuthCard(dark: Boolean, onLogin: () -> Unit) {
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
                .background(WaPalette.coral, CircleShape)
                .plainClick(onLogin)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        )
    }
}

// ── Conversation row (Messages feel: avatar · preview · badge · window pill) ───────

@Composable
private fun WaThreadRow(thread: WaThread, dark: Boolean, onTap: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .almaGlass(dark, AlmaTheme.R_CARD)
            .plainClick(onTap)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        WaAvatar(thread.name, dark, 46)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    thread.name,
                    color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    WaFormat.time(thread.lastAt),
                    color = if (thread.needsReply) WaPalette.emerald600 else AlmaTheme.inkSecondary(dark),
                    fontSize = 10.sp,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    thread.lastMessage.ifEmpty { "কোনো মেসেজ নেই" },
                    color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (thread.needsReply) {
                    // Web's green "!" badge (needsReply) — the unread/awaiting marker.
                    Box(
                        Modifier.size(18.dp).background(WaPalette.emerald600, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Text("!", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Black) }
                }
            }
            WaFormat.window(thread.lastCustomerAt)?.let { WaWindowPill(it) }
        }
    }
}

/** WhatsApp 24h business window countdown — amber when it's about to close. */
@Composable
private fun WaWindowPill(window: WaWindow) {
    val (tint, icon) = when (window.tone) {
        WaWindowTone.OPEN -> WaPalette.emerald600 to "🕐"
        WaWindowTone.CLOSING -> WaPalette.amber600 to "⏳"
        WaWindowTone.CLOSED -> Color(0xFF94A3B8) to "🚫"
    }
    Text(
        "$icon ${window.label}",
        color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier
            .padding(top = 2.dp)
            .background(tint.copy(alpha = 0.12f), CircleShape)
            .border(0.8.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun WaAvatar(name: String, dark: Boolean, sizeDp: Int) {
    Box(
        Modifier
            .size(sizeDp.dp)
            .background(WaPalette.coral.copy(alpha = 0.16f), CircleShape)
            .border(1.dp, WaPalette.coral.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            WaFormat.initials(name),
            color = WaPalette.accentText(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
        )
    }
}

// ── Thread sheet (read-only chat: customer left · business right, coral tint) ──────

@Composable
private fun WaThreadSheet(live: WaThread, dark: Boolean, onOpenWeb: () -> Unit) {
    val listState = rememberLazyListState()

    // Auto-stick to the newest message (poll appends while the sheet is open).
    LaunchedEffect(live.messages.size) {
        if (live.messages.isNotEmpty()) listState.scrollToItem(live.messages.size - 1)
    }

    Column(Modifier.fillMaxWidth()) {
        // Header
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            WaAvatar(live.name, dark, 42)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    live.name, color = AlmaTheme.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    live.number, color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            WaFormat.window(live.lastCustomerAt)?.let { w ->
                Text(
                    w.label,
                    color = when (w.tone) {
                        WaWindowTone.CLOSING -> WaPalette.amber600
                        WaWindowTone.OPEN -> WaPalette.emerald600
                        WaWindowTone.CLOSED -> AlmaTheme.inkSecondary(dark)
                    },
                    fontSize = 10.sp, fontWeight = FontWeight.Bold,
                )
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp, max = 460.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (live.messages.isEmpty()) {
                item {
                    Text(
                        "কোনো মেসেজ নেই",
                        color = AlmaTheme.inkSecondary(dark), fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 40.dp),
                    )
                }
            }
            items(live.messages.size) { i -> WaBubble(live.messages[i], dark) }
        }

        // Web's read-only strip, exact string — replies go through the agent (web UI).
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "শুধু দেখার জন্য · রিপ্লাই দিতে এজেন্টকে বলুন",
                color = AlmaTheme.inkSecondary(dark), fontSize = 10.sp,
            )
            Text(
                "🌐 ওয়েবে খুলুন",
                color = WaPalette.accentText(dark), fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().plainClick(onOpenWeb).padding(vertical = 4.dp),
            )
            Spacer(Modifier.height(14.dp))
        }
    }
}

/** One chat bubble — customer ("them") left on glass, business ("us") right with
 *  the app's coral tint (the native re-take of the web's green outgoing bubble). */
@Composable
private fun WaBubble(message: WaMessage, dark: Boolean) {
    val isUs = message.from == "us"
    val shape = RoundedCornerShape(
        topStart = if (isUs) 12.dp else 3.dp,
        topEnd = if (isUs) 3.dp else 12.dp,
        bottomEnd = 12.dp,
        bottomStart = 12.dp,
    )
    Row(Modifier.fillMaxWidth()) {
        if (isUs) Spacer(Modifier.weight(1f).widthIn(min = 44.dp))
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .background(
                    if (isUs) WaPalette.coral.copy(alpha = if (dark) 0.30f else 0.18f)
                    else Color.White.copy(alpha = if (dark) 0.075f else 0.62f),
                    shape,
                )
                .border(
                    1.dp,
                    if (isUs) WaPalette.coral.copy(alpha = 0.30f)
                    else Color.White.copy(alpha = if (dark) 0.10f else 0.45f),
                    shape,
                )
                .padding(horizontal = 10.dp, vertical = 7.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                message.text,
                color = AlmaTheme.ink(dark).copy(alpha = 0.9f), fontSize = 12.sp, lineHeight = 17.sp,
                modifier = Modifier.align(Alignment.Start),
            )
            Text(WaFormat.time(message.at), color = AlmaTheme.inkSecondary(dark), fontSize = 9.sp)
        }
        if (!isUs) Spacer(Modifier.weight(1f).widthIn(min = 44.dp))
    }
}

// ── Formatting helpers (web util parity + 24h-window math) ─────────────────────────

private enum class WaWindowTone { OPEN, CLOSING, CLOSED }
private data class WaWindow(val label: String, val tone: WaWindowTone)

private object WaFormat {
    /** ISO string → Date (server serializes Prisma Dates to ISO via Response.json). */
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

    /** Web fmtTime: "8:50 PM"-style h:mm in Asia/Dhaka. */
    fun time(iso: String?): String {
        val date = parse(iso) ?: return ""
        val f = SimpleDateFormat("h:mm a", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Dhaka")
        return f.format(date)
    }

    /** Web initials(): first letter, 👤 for bare numbers, # when empty. */
    fun initials(name: String): String {
        val n = name.trim()
        if (n.isEmpty()) return "#"
        val first = n.first()
        if (first == '+' || first.isDigit()) return "👤"
        return first.uppercase()
    }

    /** Countdown from the last customer message: the business can free-form reply
     *  for 24h. Amber under 4h ("closing"), muted once it has closed. */
    fun window(lastCustomerAt: Date?, now: Date = Date()): WaWindow? {
        lastCustomerAt ?: return null
        val deadline = lastCustomerAt.time + 24L * 3600_000
        val remaining = deadline - now.time
        if (remaining <= 0) return WaWindow("২৪ঘ উইন্ডো বন্ধ", WaWindowTone.CLOSED)
        val hours = (remaining / 3600_000).toInt()
        val minutes = ((remaining % 3600_000) / 60_000).toInt()
        if (remaining < 4L * 3600_000) {
            val label = if (hours > 0) "উইন্ডো বন্ধ হবে ${hours}ঘ ${minutes}মি পরে"
            else "উইন্ডো বন্ধ হবে ${minutes}মি পরে"
            return WaWindow(label, WaWindowTone.CLOSING)
        }
        return WaWindow("উইন্ডো খোলা · ${hours}ঘ বাকি", WaWindowTone.OPEN)
    }
}
