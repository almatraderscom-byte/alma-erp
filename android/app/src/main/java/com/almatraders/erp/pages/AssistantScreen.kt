//
//  AssistantScreen.kt
//  ALMA ERP — the Assistant tab as a fully native Compose chat screen, ported 1:1
//  from ios/App/App/AssistantSwiftUI.swift (BUILD 66, S6b core chat parity v1).
//
//  Talks to the SAME /api/assistant/* endpoints the web agent page uses:
//    GET   /api/assistant/active-conversation             → last-open thread pointer
//    GET   /api/assistant/conversations?paginated=true    → drawer list (+cursor)
//    GET   /api/assistant/conversations/:id/messages      → history (blocks + cards + tools)
//    POST  /api/assistant/chat  (SSE)                     → send + stream the reply
//    POST  /api/assistant/turn  + GET /turn/:id/stream    → A2 worker fallback (slow turns)
//    POST  /api/assistant/turn/:id/cancel                 → Stop button
//    GET   /api/assistant/conversations/:id/turn-status   → resume a running turn
//    GET   /api/assistant/models · PATCH conversations/:id {modelId} → model pill
//    POST  /api/assistant/actions/:id/approve|reject      → confirm cards
//    POST  /api/assistant/ask-cards/:id/answer            → ask cards
//    GET   /api/assistant/files?path=…                    → signed URL for chat images
//    POST  /api/assistant/presence                        → push-suppression ping
//
//  SSE transport is a self-contained OkHttp streaming call in THIS file (AlmaApi is
//  plain request/response): cookies copied from the app-global WebView CookieManager,
//  redirect-follow OFF (307 → /login must surface as notAuthenticated), 330s read
//  timeout (a turn may legitimately run ~5 minutes), 15s first-event watchdog that
//  hands a hung serverless run to the VPS worker via POST /turn.
//
//  Design parity (iOS/web): living agent aurora, coral #E07A5F→#C45A3C user bubbles
//  (rounded, cut bottom-right), full-width serif assistant text, markdown-lite with
//  coral headers / bullets / fenced code cards with copy / tables as cards, "🔧 Nটি টুল"
//  expandable pill, thinking disclosure, coral confirm/ask cards, jump-to-bottom.
//
//  DEFERRED to web (escape hatches in the drawer): voice-to-voice orb, image
//  attach/upload, TTS "শুনুন", Studio / WhatsApp / Monitor / Costs sub-pages.
//

@file:OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package com.almatraders.erp.pages

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.almatraders.erp.shell.AlmaApi
import com.almatraders.erp.shell.AlmaApiException
import com.almatraders.erp.shell.AlmaTheme
import com.almatraders.erp.shell.PushCtx
import com.almatraders.erp.shell.flexBool
import com.almatraders.erp.shell.flexDouble
import com.almatraders.erp.shell.flexInt
import com.almatraders.erp.shell.mapObjects
import com.almatraders.erp.shell.plainClick
import com.almatraders.erp.shell.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit

// ── Palette (iOS AgentPalette / web globals.css + agent-ambient.css token parity) ──

private object AgentPal {
    val coral = Color(0xFFE07A5F)
    val coralDim = Color(0xFFC45A3C)
    val coralLt = Color(0xFFF4A28C)
    val teal = Color(0xFF81B29A)

    fun bg0(dark: Boolean) = if (dark) Color(0xFF141418) else Color(0xFFFAF9F6)
    fun ink(dark: Boolean) = if (dark) Color(0xFFF7F8FC) else Color(0xFF1A1A2E)
    fun muted(dark: Boolean) = if (dark) Color(0xFFAEB2C0) else Color(0xFF64748B)
    fun mutedHi(dark: Boolean) = if (dark) Color(0xFFD1D5E0) else Color(0xFF475569)
    fun card(dark: Boolean) = if (dark) Color(0xFF202027) else Color.White
    fun borderSubtle(dark: Boolean) =
        if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)
    fun glassFill(dark: Boolean) =
        if (dark) Color(0xFF1C1C22).copy(alpha = 0.82f) else Color(0xFFFAF9F6).copy(alpha = 0.88f)
    fun codeBg(dark: Boolean) = if (dark) Color.Black.copy(alpha = 0.45f) else Color(0xFF1E1E28)
}

/** Bangla digits — same convention as the web `toBn()` / iOS almaBn. */
private fun almaBn(n: Int): String {
    val bn = listOf("০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯")
    return n.toString().map { c -> if (c.isDigit()) bn[c - '0'] else c.toString() }.joinToString("")
}

// ── Models (JS camelCase wire shapes — parsed defensively via org.json) ────────────

private data class AgentTool(
    val id: String,
    val name: String,
    val ok: Boolean?,          // null while live
    val live: Boolean,
    val inputPretty: String?,
    val resultFull: String?,
)

private data class AgentConfirmCard(
    val id: String,            // pendingActionId
    val summary: String,
    val status: String,        // pending | approved | executed | failed | expired | rejected
    val actionType: String?,
    val costEstimate: Double?,
)

private data class AgentAskCard(
    val id: String,            // askCardId
    val question: String,
    val options: List<String>,
    val status: String,        // pending | answered | superseded
    val selectedOption: String?,
)

private data class AgentChatMessage(
    val id: String,
    val role: String,                              // "user" | "assistant"
    val text: String = "",
    val imagePaths: List<String> = emptyList(),
    val thinking: String? = null,
    val tools: List<AgentTool> = emptyList(),
    val confirmCards: List<AgentConfirmCard> = emptyList(),
    val askCards: List<AgentAskCard> = emptyList(),
    val tokensIn: Int? = null,
    val tokensOut: Int? = null,
    val costUsd: String? = null,
    val createdAt: String? = null,
    val isStreaming: Boolean = false,
) {
    /** Heartbeat self-wake seed renders as a divider, never an owner bubble (web parity). */
    val isHeartbeatWake: Boolean
        get() = role == "user" && text.trim().startsWith("[স্বয়ংক্রিয় হার্টবিট")
}

private data class AgentConversation(
    val id: String,
    val title: String?,
    val modelId: String?,
    val source: String?,
    val archived: Boolean?,
    val updatedAt: String?,
)

private data class AgentModelInfo(
    val id: String,
    val label: String,
    val provider: String?,
    val enabled: Boolean?,
)

/** Arbitrary tool input JSON → pretty text for the I/O sheet. */
private fun prettyJsonValue(v: Any?): String? = when (v) {
    null, JSONObject.NULL -> null
    is JSONObject -> try { v.toString(2) } catch (_: Exception) { v.toString() }
    is JSONArray -> try { v.toString(2) } catch (_: Exception) { v.toString() }
    else -> v.toString()
}

/** One persisted message wire row → UI model (blocks + cards + tools + timeline). */
private fun parseWireMessage(o: JSONObject): AgentChatMessage? {
    val id = o.str("id") ?: return null
    val role = o.str("role") ?: "assistant"
    var text = ""
    val images = ArrayList<String>()
    val confirms = ArrayList<AgentConfirmCard>()
    val asks = ArrayList<AgentAskCard>()
    o.optJSONArray("content")?.let { arr ->
        for (i in 0 until arr.length()) {
            val b = arr.optJSONObject(i) ?: continue
            when (b.str("type")) {
                "text" -> {
                    val t = b.str("text") ?: ""
                    text = if (text.isEmpty()) t else text + "\n" + t
                }
                "file_ref" -> {
                    val p = b.str("path")
                    if (p != null && (b.str("mediaType") ?: "").startsWith("image")) images.add(p)
                }
                "confirm_card" -> b.str("pendingActionId")?.let { pid ->
                    confirms.add(
                        AgentConfirmCard(
                            id = pid,
                            summary = b.str("summary") ?: "",
                            status = b.str("status") ?: "pending",
                            actionType = b.str("actionType"),
                            costEstimate = null,
                        ),
                    )
                }
                "ask_card" -> b.str("askCardId")?.let { aid ->
                    val opts = ArrayList<String>()
                    b.optJSONArray("options")?.let { oa ->
                        for (j in 0 until oa.length()) oa.optString(j)?.takeIf { it.isNotEmpty() }?.let(opts::add)
                    }
                    asks.add(
                        AgentAskCard(
                            id = aid,
                            question = b.str("question") ?: "",
                            options = opts,
                            status = b.str("status") ?: "pending",
                            selectedOption = b.str("selectedOption"),
                        ),
                    )
                }
            }
        }
    }
    // Flat toolCalls (legacy) — richer timeline entries override below when present.
    var tools: List<AgentTool> = o.optJSONArray("toolCalls")?.let { arr ->
        val out = ArrayList<AgentTool>()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            out.add(
                AgentTool(
                    id = t.str("id") ?: "tool-$id-$i",
                    name = t.str("name") ?: "?",
                    ok = t.flexBool("success"),
                    live = false,
                    inputPretty = null,
                    resultFull = t.str("result"),
                ),
            )
        }
        out
    } ?: emptyList()
    var thinking = o.str("thinking")
    // Persisted Claude-style timeline: t: 'think' | 'tool'.
    o.optJSONArray("timeline")?.let { arr ->
        val tlTools = ArrayList<AgentTool>()
        val thinkBuf = StringBuilder()
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            when (e.str("t")) {
                "think" -> e.str("text")?.trim()?.takeIf { it.isNotEmpty() }?.let {
                    if (thinkBuf.isNotEmpty()) thinkBuf.append("\n\n")
                    thinkBuf.append(it)
                }
                "tool" -> tlTools.add(
                    AgentTool(
                        id = e.str("id") ?: "tl-$id-$i",
                        name = e.str("name") ?: "টুল",
                        ok = e.flexBool("ok"),
                        live = false,
                        inputPretty = prettyJsonValue(e.opt("input")),
                        resultFull = e.str("result"),
                    ),
                )
            }
        }
        if (tlTools.isNotEmpty()) tools = tlTools
        if (thinking.isNullOrBlank() && thinkBuf.isNotEmpty()) thinking = thinkBuf.toString()
    }
    val cost = when (val c = o.opt("costUsd")) {
        is String -> c
        is Number -> String.format(Locale.US, "%.4f", c.toDouble())
        else -> null
    }
    return AgentChatMessage(
        id = id,
        role = if (role == "user") "user" else "assistant",
        text = text,
        imagePaths = images,
        thinking = thinking,
        tools = tools,
        confirmCards = confirms,
        askCards = asks,
        tokensIn = o.flexInt("tokensIn"),
        tokensOut = o.flexInt("tokensOut"),
        costUsd = cost,
        createdAt = o.str("createdAt"),
    )
}

// ── SSE transport (own OkHttp streaming — AlmaApi is plain request/response) ───────

private class SseNotAuthenticated : Exception("সেশন পাওয়া যায়নি — একবার লগইন করুন")

private val sseClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .followRedirects(false)     // 307 → /login must stay visible (iOS RedirectBlocker)
        .followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(330, TimeUnit.SECONDS)   // a turn may legitimately run ~5 minutes
        .build()
}

private val sseJsonMedia = "application/json; charset=utf-8".toMediaType()

/**
 * Open an SSE stream and deliver each parsed `data:` event on the Main dispatcher.
 * Blocking read runs on IO; caller cancels via [onCall]'s Call.cancel() + job cancel.
 */
private suspend fun sseStream(
    method: String,
    path: String,
    jsonBody: String?,
    onCall: (Call) -> Unit,
    onEvent: (JSONObject) -> Unit,
) = withContext(Dispatchers.IO) {
    val builder = Request.Builder()
        .url(AlmaTheme.BASE_URL + path)
        .header("Accept", "text/event-stream")
        .header("X-Requested-With", "XMLHttpRequest")
    android.webkit.CookieManager.getInstance()
        .getCookie(AlmaTheme.BASE_URL)?.let { builder.header("Cookie", it) }
    builder.method(method, jsonBody?.toRequestBody(sseJsonMedia))
    val call = sseClient.newCall(builder.build())
    onCall(call)
    call.execute().use { resp ->
        val status = resp.code
        if (status == 401 || status == 403 ||
            (status in 300..399 && (resp.header("Location") ?: "").contains("/login"))
        ) throw SseNotAuthenticated()
        if (status !in 200..299) throw AlmaApiException.Http(status, "stream")
        val source = resp.body?.source() ?: return@use
        while (isActive) {
            val line = source.readUtf8Line() ?: break
            if (!line.startsWith("data: ")) continue    // skip ": ping" keepalives
            val obj = try { JSONObject(line.removePrefix("data: ")) } catch (_: Exception) { continue }
            withContext(Dispatchers.Main) { onEvent(obj) }
        }
    }
}

// ── State holder (iOS AssistantVM twin) ────────────────────────────────────────────

private class AssistantState {
    // Thread state
    var conversationId by mutableStateOf<String?>(null)
    var messages by mutableStateOf(listOf<AgentChatMessage>())
    var loadingHistory by mutableStateOf(false)

    // Streaming state
    var isStreaming by mutableStateOf(false)
    var thinkingLive by mutableStateOf(false)
    var currentTurnId by mutableStateOf<String?>(null)
    private var turnJob: Job? = null
    @Volatile private var activeCall: Call? = null

    // Drawer / conversations
    var showDrawer by mutableStateOf(false)
    var conversations by mutableStateOf(listOf<AgentConversation>())
    var conversationsCursor by mutableStateOf<String?>(null)
    var loadingConversations by mutableStateOf(false)
    var loadingMoreConversations by mutableStateOf(false)

    // Model pill + picker
    var modelLabel by mutableStateOf<String?>(null)   // live label from stream model_info
    var modelId by mutableStateOf<String?>(null)      // null / "auto" = Auto
    var models by mutableStateOf(listOf<AgentModelInfo>())

    val isAutoModel: Boolean get() = modelId == null || modelId == "auto"
    val modelPillLabel: String
        get() {
            if (isAutoModel) return modelLabel?.let { "Auto · $it" } ?: "Auto"
            return models.firstOrNull { it.id == modelId }?.label ?: modelId ?: "Auto"
        }

    // Errors / auth
    var authExpired by mutableStateOf(false)
    var errorToast by mutableStateOf<String?>(null)

    // Signed image URLs (path → url) resolved lazily per thumbnail
    var signedURLs by mutableStateOf(mapOf<String, String>())

    /** The approvals-style unwrap: some assistant routes wrap via {ok, data:{…}}. */
    private fun unwrap(root: JSONObject): JSONObject = root.optJSONObject("data") ?: root

    // ── Bootstrap ──────────────────────────────────────────────────────────

    suspend fun bootstrap() {
        loadModels()
        loadActiveConversation()
    }

    suspend fun loadModels() {
        if (models.isNotEmpty()) return
        try {
            val resp = unwrap(AlmaApi.getObject("/api/assistant/models"))
            models = resp.optJSONArray("models")?.mapObjects { m ->
                val id = m.str("id") ?: return@mapObjects null
                AgentModelInfo(id, m.str("label") ?: id, m.str("provider"), m.flexBool("enabled"))
            }?.filter { it.enabled != false } ?: emptyList()
        } catch (_: Exception) { /* pill falls back to Auto */ }
    }

    private suspend fun loadActiveConversation() {
        try {
            val ptr = unwrap(AlmaApi.getObject("/api/assistant/active-conversation"))
            val cid = ptr.str("conversationId")
            if (cid != null) {
                conversationId = cid
                modelId = ptr.str("modelId")
                loadMessages(showSpinner = messages.isEmpty())
                resumeRunningTurnIfAny()
            }
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (_: Exception) {
            // Pointer is a nicety — fall through to an empty new-chat state.
        }
    }

    suspend fun loadMessages(showSpinner: Boolean = false) {
        val cid = conversationId ?: return
        if (showSpinner) loadingHistory = true
        try {
            val wire = AlmaApi.getArray("/api/assistant/conversations/$cid/messages")
            // Never clobber an in-flight streaming tail with the poll.
            if (isStreaming) return
            mergeServerMessages(wire.mapObjects { parseWireMessage(it) })
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            if (showSpinner) errorToast = e.message
        } finally {
            loadingHistory = false
        }
    }

    /**
     * Server truth replaces the thread WITHOUT clobbering a freshly streamed tail:
     * the settled tail keeps its id + richer streamed content wherever the server
     * copy is thinner (iOS mergeServerMessages, simplified).
     */
    private fun mergeServerMessages(wire: List<AgentChatMessage>) {
        val incoming = wire.toMutableList()
        val localTail = messages.lastOrNull {
            it.role == "assistant" && it.id.startsWith("stream-") && it.text.isNotBlank()
        }
        if (localTail != null) {
            val lastUserIdx = incoming.indexOfLast { it.role == "user" }
            val serverTailIdx = incoming.indexOfLast { it.role == "assistant" }
            if (serverTailIdx >= 0 && serverTailIdx > lastUserIdx) {
                val st = incoming[serverTailIdx]
                incoming[serverTailIdx] = st.copy(
                    id = localTail.id,   // stable row identity — prose never blinks
                    text = if (st.text.isBlank()) localTail.text else st.text,
                    thinking = st.thinking ?: localTail.thinking,
                    tools = if (st.tools.isEmpty()) localTail.tools else st.tools,
                )
            } else {
                // Server hasn't persisted the streamed reply yet → keep the local tail.
                incoming.add(localTail.copy(isStreaming = false))
            }
        }
        messages = incoming
    }

    /** Stream ended: settle the tail in place FIRST, then fold in server truth. */
    private suspend fun finalizeTurn() {
        settleTail()
        isStreaming = false
        thinkingLive = false
        val cid = conversationId ?: return
        try {
            val wire = AlmaApi.getArray("/api/assistant/conversations/$cid/messages")
            mergeServerMessages(wire.mapObjects { parseWireMessage(it) })
        } catch (_: Exception) { /* next poll folds it in */ }
    }

    private fun settleTail() {
        val idx = messages.indexOfLast { it.isStreaming }
        if (idx >= 0) messages = messages.toMutableList().also { it[idx] = it[idx].copy(isStreaming = false) }
    }

    /** If a turn was still running when the app was backgrounded, spin until it settles. */
    private suspend fun resumeRunningTurnIfAny() {
        val cid = conversationId ?: return
        val st = try {
            unwrap(AlmaApi.getObject("/api/assistant/conversations/$cid/turn-status"))
        } catch (_: Exception) { return }
        if (st.str("status") != "running") return
        isStreaming = true
        thinkingLive = true
        currentTurnId = st.str("turnId")
        for (i in 0 until 100) {
            delay(3_000)
            val s = try {
                unwrap(AlmaApi.getObject("/api/assistant/conversations/$cid/turn-status"))
            } catch (_: Exception) { null }
            if (s?.str("status") != "running") break
        }
        isStreaming = false
        thinkingLive = false
        loadMessages()
    }

    suspend fun pingPresence() {
        try { AlmaApi.send("POST", "/api/assistant/presence", JSONObject()) } catch (_: Exception) { }
    }

    // ── Conversations (drawer) ─────────────────────────────────────────────

    suspend fun loadConversations() {
        loadingConversations = conversations.isEmpty()
        try {
            val page = unwrap(
                AlmaApi.getObject(
                    "/api/assistant/conversations",
                    mapOf("paginated" to "true", "limit" to "30"),
                ),
            )
            conversations = page.optJSONArray("conversations")?.mapObjects { parseConversation(it) }
                ?.filter { it.archived != true } ?: emptyList()
            conversationsCursor = page.str("nextCursor")
            authExpired = false
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
        } catch (e: Exception) {
            errorToast = e.message
        } finally {
            loadingConversations = false
        }
    }

    suspend fun loadMoreConversations() {
        val cursor = conversationsCursor ?: return
        if (loadingMoreConversations) return
        loadingMoreConversations = true
        try {
            val page = unwrap(
                AlmaApi.getObject(
                    "/api/assistant/conversations",
                    mapOf("paginated" to "true", "limit" to "30", "cursor" to cursor),
                ),
            )
            val known = conversations.map { it.id }.toSet()
            conversations = conversations + (
                page.optJSONArray("conversations")?.mapObjects { parseConversation(it) }
                    ?.filter { it.archived != true && it.id !in known } ?: emptyList()
                )
            conversationsCursor = page.str("nextCursor")
        } catch (_: Exception) {
        } finally {
            loadingMoreConversations = false
        }
    }

    private fun parseConversation(o: JSONObject): AgentConversation? {
        val id = o.str("id") ?: return null
        return AgentConversation(
            id = id,
            title = o.str("title"),
            modelId = o.str("modelId"),
            source = o.str("source"),
            archived = o.flexBool("archived"),
            updatedAt = o.str("updatedAt"),
        )
    }

    suspend fun openConversation(id: String) {
        if (id == conversationId) return
        stopStreaming(cancelServer = false)
        conversationId = id
        modelId = conversations.firstOrNull { it.id == id }?.modelId   // pinned model follows the chat
        messages = emptyList()
        loadMessages(showSpinner = true)
        try {
            AlmaApi.send("POST", "/api/assistant/active-conversation", JSONObject().put("conversationId", id))
        } catch (_: Exception) { }
        resumeRunningTurnIfAny()
    }

    fun newChat() {
        stopStreaming(cancelServer = false)
        conversationId = null      // server creates one on the first send
        messages = emptyList()
    }

    suspend fun renameConversation(id: String, title: String) {
        val t = title.trim()
        if (t.isEmpty()) return
        conversations = conversations.map { if (it.id == id) it.copy(title = t) else it }
        try {
            AlmaApi.send("PATCH", "/api/assistant/conversations/$id", JSONObject().put("title", t))
        } catch (_: Exception) { }
    }

    suspend fun archiveConversation(id: String) {
        conversations = conversations.filter { it.id != id }
        try {
            AlmaApi.send("PATCH", "/api/assistant/conversations/$id", JSONObject().put("archived", true))
        } catch (_: Exception) { }
        if (conversationId == id) newChat()
    }

    suspend fun deleteConversation(id: String) {
        conversations = conversations.filter { it.id != id }
        try { AlmaApi.send("DELETE", "/api/assistant/conversations/$id") } catch (_: Exception) { }
        if (conversationId == id) newChat()
    }

    /** Owner picks a model (null = Auto): update pill instantly, persist, revert on failure. */
    fun selectModel(scope: CoroutineScope, id: String?) {
        val previous = modelId
        modelId = id
        val cid = conversationId ?: return
        scope.launch {
            try {
                AlmaApi.send("PATCH", "/api/assistant/conversations/$cid", JSONObject().put("modelId", id ?: "auto"))
            } catch (_: Exception) {
                modelId = previous
                errorToast = "মডেল বদলানো গেল না"
            }
        }
    }

    // ── Send + stream ──────────────────────────────────────────────────────

    fun send(scope: CoroutineScope, raw: String) {
        val text = raw.trim()
        if (text.isEmpty() || isStreaming) return
        messages = messages + AgentChatMessage(id = "local-${UUID.randomUUID()}", role = "user", text = text)
        isStreaming = true
        thinkingLive = true
        currentTurnId = null
        ensureStreamingTail()
        val body = JSONObject()
            .put("conversationId", conversationId ?: JSONObject.NULL)
            .put("message", text)
            .put("files", JSONArray())
            .put("modelId", modelId ?: "auto")
        turnJob = scope.launch { runTurn(body) }
    }

    private suspend fun runTurn(body: JSONObject) {
        var sawEvent = false
        try {
            var streamErr: Exception? = null
            val job = withContext(Dispatchers.Main) {
                CoroutineScope(coroutineContext).launch {
                    try {
                        sseStream("POST", "/api/assistant/chat", body.toString(),
                            onCall = { activeCall = it }) { ev ->
                            sawEvent = true
                            handle(ev)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        streamErr = e
                    }
                }
            }
            // 15s first-event watchdog (web parity: a hung serverless run goes to /turn).
            var waited = 0L
            while (waited < 15_000 && !sawEvent && job.isActive) {
                delay(250)
                waited += 250
            }
            if (!sawEvent) {
                activeCall?.cancel()
                job.cancel()
                job.join()
                runWorkerFallback(body)
            } else {
                job.join()
                streamErr?.let { throw it }
            }
            finalizeTurn()
        } catch (e: CancellationException) {
            settleTail()
            throw e
        } catch (e: SseNotAuthenticated) {
            authExpired = true
            settleTail()
        } catch (e: AlmaApiException.NotAuthenticated) {
            authExpired = true
            settleTail()
        } catch (e: Exception) {
            errorToast = e.message ?: "সমস্যা হয়েছে — আবার চেষ্টা করুন"
            settleTail()
        } finally {
            isStreaming = false
            thinkingLive = false
            activeCall = null
        }
    }

    /** A2 fallback: enqueue on the VPS worker queue and tail its durable stream. */
    private suspend fun runWorkerFallback(body: JSONObject) {
        val enqBody = JSONObject()
            .put("conversationId", conversationId ?: JSONObject.NULL)
            .put("message", body.optString("message"))
            .put("files", JSONArray())
        val resp = AlmaApi.send("POST", "/api/assistant/turn", enqBody)
        val data = resp.optJSONObject("data") ?: resp
        val turnId = data.str("turnId") ?: throw AlmaApiException.Http(500, "no turnId")
        currentTurnId = turnId
        if (conversationId == null) conversationId = data.str("conversationId")
        sseStream("GET", "/api/assistant/turn/$turnId/stream", null,
            onCall = { activeCall = it }) { ev -> handle(ev) }
    }

    /** Apply one SSE event to the streaming tail (runs on Main). */
    private fun handle(ev: JSONObject) {
        when (ev.str("type")) {
            "conversation_id" -> ev.str("id")?.let { conversationId = it }
            "turn_id" -> currentTurnId = ev.str("id")
            "model_info" -> ev.str("label")?.let { modelLabel = it }
            "thinking_delta" -> {
                ensureStreamingTail()
                updateTail { it.copy(thinking = (it.thinking ?: "") + (ev.str("delta") ?: "")) }
            }
            "text_delta" -> {
                ensureStreamingTail()
                updateTail { it.copy(text = it.text + (ev.str("delta") ?: "")) }
            }
            "tool_start" -> {
                ensureStreamingTail()
                val tid = ev.str("id") ?: UUID.randomUUID().toString()
                updateTail { m ->
                    if (m.tools.any { it.id == tid }) m
                    else m.copy(
                        tools = m.tools + AgentTool(
                            id = tid,
                            name = ev.str("name") ?: "টুল",
                            ok = null,
                            live = true,
                            inputPretty = prettyJsonValue(ev.opt("input")),
                            resultFull = null,
                        ),
                    )
                }
            }
            "tool_end" -> {
                val tid = ev.str("id") ?: return
                updateTail { m ->
                    m.copy(
                        tools = m.tools.map {
                            if (it.id == tid) it.copy(
                                ok = ev.flexBool("success") ?: true,
                                live = false,
                                resultFull = ev.str("resultPreview") ?: it.resultFull,
                            ) else it
                        },
                    )
                }
            }
            "confirm_card" -> {
                ensureStreamingTail()
                val pid = ev.str("pendingActionId") ?: return
                updateTail {
                    it.copy(
                        confirmCards = it.confirmCards + AgentConfirmCard(
                            id = pid,
                            summary = ev.str("summary") ?: "",
                            status = "pending",
                            actionType = ev.str("actionType"),
                            costEstimate = ev.flexDouble("costEstimate"),
                        ),
                    )
                }
            }
            "ask_card" -> {
                ensureStreamingTail()
                val aid = ev.str("askCardId") ?: return
                val opts = ArrayList<String>()
                ev.optJSONArray("options")?.let { oa ->
                    for (j in 0 until oa.length()) oa.optString(j)?.takeIf { it.isNotEmpty() }?.let(opts::add)
                }
                updateTail {
                    it.copy(
                        askCards = it.askCards + AgentAskCard(
                            id = aid,
                            question = ev.str("question") ?: "",
                            options = opts,
                            status = "pending",
                            selectedOption = null,
                        ),
                    )
                }
            }
            "done" -> thinkingLive = false
            "error" -> {
                thinkingLive = false
                errorToast = ev.str("message") ?: ev.str("error") ?: "সমস্যা হয়েছে — আবার চেষ্টা করুন"
            }
        }
    }

    private fun ensureStreamingTail() {
        if (messages.lastOrNull()?.isStreaming != true) {
            messages = messages + AgentChatMessage(
                id = "stream-${UUID.randomUUID()}", role = "assistant", isStreaming = true,
            )
        }
    }

    private fun updateTail(transform: (AgentChatMessage) -> AgentChatMessage) {
        val idx = messages.indexOfLast { it.isStreaming }
        if (idx >= 0) messages = messages.toMutableList().also { it[idx] = transform(it[idx]) }
    }

    fun stopStreaming(cancelServer: Boolean = true) {
        turnJob?.cancel()
        turnJob = null
        activeCall?.cancel()
        activeCall = null
        if (cancelServer) {
            val tid = currentTurnId
            if (tid != null) {
                CoroutineScope(Dispatchers.IO).launch {
                    try { AlmaApi.send("POST", "/api/assistant/turn/$tid/cancel", JSONObject()) } catch (_: Exception) { }
                }
            }
        }
        isStreaming = false
        thinkingLive = false
        settleTail()
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    suspend fun approveAction(cardId: String, approve: Boolean) {
        setConfirmStatus(cardId, if (approve) "approved" else "rejected")
        try {
            AlmaApi.send("POST", "/api/assistant/actions/$cardId/${if (approve) "approve" else "reject"}", JSONObject())
        } catch (e: Exception) {
            setConfirmStatus(cardId, "pending")
            errorToast = e.message
        }
        loadMessages()
    }

    private fun setConfirmStatus(cardId: String, status: String) {
        messages = messages.map { m ->
            if (m.confirmCards.any { it.id == cardId }) {
                m.copy(confirmCards = m.confirmCards.map { if (it.id == cardId) it.copy(status = status) else it })
            } else m
        }
    }

    /** Answer feeds back into the chat so the agent continues instantly (web onQuickSend). */
    fun answerAskCard(scope: CoroutineScope, cardId: String, option: String) {
        messages = messages.map { m ->
            if (m.askCards.any { it.id == cardId }) {
                m.copy(
                    askCards = m.askCards.map {
                        if (it.id == cardId) it.copy(status = "answered", selectedOption = option) else it
                    },
                )
            } else m
        }
        scope.launch {
            try {
                AlmaApi.send("POST", "/api/assistant/ask-cards/$cardId/answer", JSONObject().put("option", option))
            } catch (_: Exception) { }
            send(this, option)
        }
    }

    /** "আমার মত" — reject the pending action, then send the owner's correction. */
    fun submitOpinion(scope: CoroutineScope, cardId: String, note: String) {
        val trimmed = note.trim()
        if (trimmed.isEmpty()) return
        setConfirmStatus(cardId, "rejected")
        scope.launch {
            try { AlmaApi.send("POST", "/api/assistant/actions/$cardId/reject", JSONObject()) } catch (_: Exception) { }
            send(this, trimmed)
        }
    }

    suspend fun signedURL(path: String): String? {
        signedURLs[path]?.let { return it }
        return try {
            val resp = AlmaApi.getObject("/api/assistant/files", mapOf("path" to path))
            val url = (resp.optJSONObject("data") ?: resp).str("url") ?: return null
            signedURLs = signedURLs + (path to url)
            url
        } catch (_: Exception) { null }
    }
}

// ── Screen ─────────────────────────────────────────────────────────────────────────

@Composable
fun AssistantScreen(ctx: PushCtx) {
    val dark = AlmaTheme.isDark
    val vm = remember { AssistantState() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var showModelPicker by remember { mutableStateOf(false) }
    var toolSheet by remember { mutableStateOf<AgentTool?>(null) }
    var thinkingSheet by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.bootstrap() }

    // Web parity: quiet message re-poll every 12s + presence ping every ~24s.
    LaunchedEffect(Unit) {
        var tick = 0
        while (true) {
            delay(12_000)
            if (!vm.isStreaming) vm.loadMessages()
            tick++
            if (tick % 2 == 0) vm.pingPresence()
        }
    }

    val nearBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || last.index >= info.totalItemsCount - 2
        }
    }

    // Follow the stream while the owner is near the bottom.
    LaunchedEffect(vm.messages.size, vm.messages.lastOrNull()?.text?.length) {
        if (vm.messages.isEmpty()) return@LaunchedEffect
        if (nearBottom) {
            val total = listState.layoutInfo.totalItemsCount
            if (total > 0) listState.scrollToItem(total - 1)
        }
    }

    Box(Modifier.fillMaxSize()) {
        AgentAurora(dark)

        Column(Modifier.fillMaxSize().imePadding()) {
            AssistantTopBar(
                dark = dark,
                onMenu = {
                    vm.showDrawer = true
                    scope.launch { vm.loadConversations() }
                },
                onNewChat = { vm.newChat() },
            )

            Box(Modifier.weight(1f)) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 16.dp, end = 16.dp, top = 10.dp, bottom = 8.dp,
                    ),
                ) {
                    if (vm.loadingHistory && vm.messages.isEmpty()) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(top = 80.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(22.dp), color = AgentPal.coral, strokeWidth = 2.dp)
                            }
                        }
                    }
                    if (!vm.loadingHistory && vm.messages.isEmpty() && !vm.isStreaming) {
                        item { AgentEmptyState(dark) }
                    }
                    items(vm.messages, key = { it.id }) { msg ->
                        AgentMessageRow(
                            message = msg,
                            vm = vm,
                            dark = dark,
                            showWorkingIndicator = vm.isStreaming && msg.isStreaming &&
                                msg.id == vm.messages.lastOrNull { it.isStreaming }?.id,
                            onToolTap = { toolSheet = it },
                            onThinkingTap = { thinkingSheet = it },
                            onDecide = { cardId, approve -> scope.launch { vm.approveAction(cardId, approve) } },
                            onAnswer = { cardId, option -> vm.answerAskCard(scope, cardId, option) },
                            onOpinion = { cardId, note -> vm.submitOpinion(scope, cardId, note) },
                        )
                    }
                    item { Spacer(Modifier.height(4.dp)) }
                }

                // Jump-to-bottom — centered frosted circle just above the composer.
                if (!nearBottom) {
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 10.dp)
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(AgentPal.glassFill(dark))
                            .border(1.dp, Color.White.copy(alpha = 0.2f), CircleShape)
                            .plainClick {
                                scope.launch {
                                    val total = listState.layoutInfo.totalItemsCount
                                    if (total > 0) listState.animateScrollToItem(total - 1)
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Outlined.ArrowDownward, contentDescription = null,
                            tint = AgentPal.muted(dark), modifier = Modifier.size(16.dp),
                        )
                    }
                }

                // Auth banner — coral capsule at the top (iOS authBanner parity).
                if (vm.authExpired) {
                    Row(
                        Modifier
                            .align(Alignment.TopCenter)
                            .padding(top = 6.dp)
                            .clip(CircleShape)
                            .background(AgentPal.coral)
                            .plainClick { ctx.openSmart("/login", "Login") }
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("লগইন দরকার — এখানে চাপুন", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }

                // Error toast — glass card above the composer, auto-dismisses.
                vm.errorToast?.let { toast ->
                    LaunchedEffect(toast) {
                        delay(4_000)
                        if (vm.errorToast == toast) vm.errorToast = null
                    }
                    Text(
                        toast,
                        color = AgentPal.ink(dark), fontSize = 12.5.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 16.dp, start = 24.dp, end = 24.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(AgentPal.glassFill(dark))
                            .border(1.dp, AgentPal.coral.copy(alpha = 0.5f), RoundedCornerShape(14.dp))
                            .plainClick { vm.errorToast = null }
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }

            AgentComposer(
                vm = vm,
                dark = dark,
                onSend = { text -> vm.send(scope, text) },
                onStop = { vm.stopStreaming() },
                onModelPill = { showModelPicker = true },
                onVoice = { ctx.openSmart("/agent/voice", "ভয়েস") },
            )
        }

        // Conversation drawer — slides over a dimmed scrim (web AgentSidebar parity).
        if (vm.showDrawer) {
            AgentDrawer(
                vm = vm,
                dark = dark,
                scope = scope,
                onClose = { vm.showDrawer = false },
                openWeb = { p, t ->
                    vm.showDrawer = false
                    ctx.openWebForced(p, t)
                },
            )
        }
    }

    if (showModelPicker) {
        ModalBottomSheet(
            onDismissRequest = { showModelPicker = false },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            AgentModelPickerSheet(vm, dark) { id ->
                vm.selectModel(scope, id)
                showModelPicker = false
            }
        }
    }

    toolSheet?.let { tool ->
        ModalBottomSheet(
            onDismissRequest = { toolSheet = null },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            AgentToolIOSheet(tool, dark)
        }
    }

    thinkingSheet?.let { thinking ->
        ModalBottomSheet(
            onDismissRequest = { thinkingSheet = null },
            containerColor = AlmaTheme.rootBg(dark),
        ) {
            AgentThinkingSheet(thinking, dark)
        }
    }
}

// ── Top bar (iOS native nav-bar buttons: glass hamburger / coral compose) ──────────

@Composable
private fun AssistantTopBar(dark: Boolean, onMenu: () -> Unit, onNewChat: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(48.dp),
    ) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .padding(start = 10.dp)
                .size(34.dp)
                .clip(CircleShape)
                .background(AgentPal.glassFill(dark))
                .border(1.dp, AgentPal.borderSubtle(dark), CircleShape)
                .plainClick(onMenu),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = AgentPal.ink(dark), modifier = Modifier.size(17.dp))
        }
        Text(
            "ALMA AI",
            modifier = Modifier.align(Alignment.Center),
            color = AgentPal.ink(dark),
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Box(
            Modifier
                .align(Alignment.CenterEnd)
                .padding(end = 10.dp)
                .size(34.dp)
                .clip(CircleShape)
                .background(AgentPal.coral)
                .plainClick(onNewChat),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Edit, contentDescription = "নতুন কথোপকথন", tint = Color.White, modifier = Modifier.size(16.dp))
        }
    }
}

// ── Aurora background (web .ambient-bg-root / iOS AgentAuroraBackground parity) ────

@Composable
private fun AgentAurora(dark: Boolean) {
    val transition = rememberInfiniteTransition(label = "agentAurora")
    val drift by transition.animateFloat(
        initialValue = -1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(26_000, easing = LinearEasing), RepeatMode.Reverse),
        label = "auroraDrift",
    )
    Canvas(Modifier.fillMaxSize()) {
        drawRect(AgentPal.bg0(dark))
        drawRect(
            Brush.radialGradient(
                listOf(Color(0xFF6366F1).copy(alpha = if (dark) 0.22f else 0.10f), Color.Transparent),
                center = Offset(size.width * 0.5f, -size.height * 0.1f),
                radius = size.height * 0.8f,
            ),
        )
        drawRect(
            Brush.radialGradient(
                listOf(Color(0xFFEC4899).copy(alpha = if (dark) 0.28f else 0.12f), Color.Transparent),
                center = Offset(size.width * 0.5f, size.height * 1.15f),
                radius = size.height * 0.9f,
            ),
        )
        // Five drifting colour blobs — exact web --aurora-blob-1…5 hues.
        val blobs = listOf(
            // color, alphaDark, alphaLight, size, x, y, dx, dy
            arrayOf(Color(0xFF3880FF), 0.60f, 0.30f, 380f, 0.15f, 0.10f, 60f, 40f),
            arrayOf(Color(0xFF7C4DFF), 0.55f, 0.26f, 420f, 0.85f, 0.25f, -50f, 60f),
            arrayOf(Color(0xFFD633FF), 0.50f, 0.24f, 360f, 0.30f, 0.55f, 70f, -40f),
            arrayOf(Color(0xFFFF2E86), 0.55f, 0.26f, 400f, 0.80f, 0.80f, -60f, -50f),
            arrayOf(Color(0xFFFF6E50), 0.45f, 0.22f, 340f, 0.20f, 0.95f, 50f, -60f),
        )
        val density = 2.6f   // pt → px feel matching the iOS blob scale on phones
        blobs.forEach { b ->
            val color = (b[0] as Color).copy(alpha = if (dark) b[1] as Float else b[2] as Float)
            val blobSize = (b[3] as Float) * density * 0.62f
            val cx = size.width * (b[4] as Float) + (b[6] as Float) * drift * density
            val cy = size.height * (b[5] as Float) + (b[7] as Float) * drift * density
            drawCircle(
                Brush.radialGradient(
                    listOf(color, color.copy(alpha = 0f)),
                    center = Offset(cx, cy),
                    radius = blobSize,
                ),
                radius = blobSize,
                center = Offset(cx, cy),
            )
        }
    }
}

// ── Empty state (web AgentEmptyState — greeting only, owner call 2026-07-06) ───────

@Composable
private fun AgentEmptyState(dark: Boolean) {
    val dayPart = remember {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Dhaka"))
        val h = cal.get(Calendar.HOUR_OF_DAY)
        when {
            h in 5..11 -> 0
            h in 12..16 -> 1
            h in 17..20 -> 2
            else -> 3
        }
    }
    val subtitle = listOf(
        "শুভ সকাল, Boss — দিনটা শুরু করি",
        "শুভ দুপুর, Boss — কীভাবে সাহায্য করতে পারি",
        "শুভ সন্ধ্যা, Boss — দিনটা গুছিয়ে নিই",
        "শুভ রাত্রি, Boss — কী দেখে নেবো",
    )[dayPart]
    Column(
        Modifier.fillMaxWidth().padding(top = 110.dp, start = 24.dp, end = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("✨", fontSize = 40.sp)
        Text("আস্সালামু আলাইকুম", color = AgentPal.ink(dark), fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
        Text(subtitle, color = AgentPal.muted(dark), fontSize = 13.5.sp, textAlign = TextAlign.Center)
    }
}

// ── Message rows ───────────────────────────────────────────────────────────────────

@Composable
private fun AgentMessageRow(
    message: AgentChatMessage,
    vm: AssistantState,
    dark: Boolean,
    showWorkingIndicator: Boolean,
    onToolTap: (AgentTool) -> Unit,
    onThinkingTap: (String) -> Unit,
    onDecide: (String, Boolean) -> Unit,
    onAnswer: (String, String) -> Unit,
    onOpinion: (String, String) -> Unit,
) {
    if (message.isHeartbeatWake) {
        // Autonomous self-wake — an inline divider, never a fake owner bubble.
        Row(
            Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.weight(1f).height(1.dp).background(AgentPal.borderSubtle(dark)))
            Row(
                Modifier
                    .clip(CircleShape)
                    .background(AgentPal.coral.copy(alpha = 0.06f))
                    .border(1.dp, AgentPal.coral.copy(alpha = 0.25f), CircleShape)
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text("💓", fontSize = 10.sp)
                Text("ALMA নিজে থেকে জাগল", color = AgentPal.coral.copy(alpha = 0.9f), fontSize = 11.sp, fontWeight = FontWeight.Medium)
            }
            Box(Modifier.weight(1f).height(1.dp).background(AgentPal.borderSubtle(dark)))
        }
        return
    }

    if (message.role == "user") {
        // Coral gradient bubble — rounded with the cut bottom-right corner (web parity).
        Column(
            Modifier.fillMaxWidth().padding(start = 44.dp, bottom = 18.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (message.imagePaths.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    message.imagePaths.forEach { p -> AgentChatImage(p, vm, dark) }
                }
            }
            if (message.text.isNotEmpty()) {
                Text(
                    message.text,
                    color = Color.White,
                    fontSize = 15.sp,
                    lineHeight = 22.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomEnd = 6.dp, bottomStart = 20.dp))
                        .background(
                            Brush.linearGradient(listOf(AgentPal.coral, AgentPal.coralDim)),
                        )
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }
        return
    }

    // Assistant — full-width plain text on the aurora (LOCKED §1: no glass card).
    Column(
        Modifier.fillMaxWidth().padding(bottom = 26.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Thinking disclosure — one compact muted row (Claude-style).
        message.thinking?.takeIf { it.isNotBlank() }?.let { thinking ->
            val headline = thinking.lineSequence().firstOrNull { it.isNotBlank() }
                ?.replace("**", "")?.replace("##", "")?.trim()
                ?.let { if (it.length > 64) it.take(64) + "…" else it } ?: "Thinking"
            CompactActivityRow(
                icon = { Icon(Icons.Outlined.Schedule, null, tint = AgentPal.muted(dark), modifier = Modifier.size(15.dp)) },
                label = headline,
                italic = true,
                labelColor = AgentPal.muted(dark),
                dark = dark,
            ) { onThinkingTap(thinking) }
        }

        // "🔧 Nটি টুল" pill — expandable list of tool rows.
        if (message.tools.isNotEmpty()) {
            AgentToolsPill(message.tools, dark, onToolTap)
        }

        if (message.text.isNotEmpty()) {
            AgentMarkdownText(
                text = message.text,
                dark = dark,
                dim = message.isStreaming,
            )
        }

        message.imagePaths.forEach { p -> AgentChatImage(p, vm, dark) }

        message.confirmCards.forEach { card ->
            AgentConfirmCardView(card, dark, onDecide = { approve -> onDecide(card.id, approve) }) { note ->
                onOpinion(card.id, note)
            }
        }
        message.askCards.forEach { card ->
            AgentAskCardView(card, dark) { option -> onAnswer(card.id, option) }
        }

        if (showWorkingIndicator) {
            AgentWorkingIndicator(dark)
        }

        // ALMA wordmark footer + relative time + copy + tokens (LOCKED §4, TTS deferred).
        if (!message.isStreaming && message.text.isNotEmpty()) {
            AgentMessageFooter(message, dark)
        }
    }
}

@Composable
private fun AgentChatImage(path: String, vm: AssistantState, dark: Boolean) {
    var url by remember(path) { mutableStateOf(vm.signedURLs[path]) }
    LaunchedEffect(path) {
        if (url == null) url = vm.signedURL(path)
    }
    Box(
        Modifier
            .size(80.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(AgentPal.card(dark).copy(alpha = 0.4f))
            .border(1.dp, AgentPal.borderSubtle(dark), RoundedCornerShape(16.dp)),
        contentAlignment = Alignment.Center,
    ) {
        val u = url
        if (u != null) {
            AsyncImage(
                model = u,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text("🖼️", fontSize = 16.sp)
        }
    }
}

@Composable
private fun CompactActivityRow(
    icon: @Composable () -> Unit,
    label: String,
    italic: Boolean = false,
    labelColor: Color,
    dark: Boolean,
    failed: Boolean = false,
    onTap: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .plainClick(onTap)
            .padding(end = 72.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (failed) {
            Icon(Icons.Outlined.Close, null, tint = Color(0xFFEF4444).copy(alpha = 0.8f), modifier = Modifier.size(15.dp))
        } else {
            icon()
        }
        Text(
            label,
            color = labelColor,
            fontSize = 14.sp,
            fontWeight = if (italic) FontWeight.Normal else FontWeight.Medium,
            fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(Icons.Outlined.ChevronRight, null, tint = labelColor.copy(alpha = 0.45f), modifier = Modifier.size(14.dp))
    }
}

/** "🔧 Nটি টুল" pill → expands into per-tool rows; tap a row → the I/O sheet. */
@Composable
private fun AgentToolsPill(tools: List<AgentTool>, dark: Boolean, onToolTap: (AgentTool) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val anyLive = tools.any { it.live }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier
                .clip(CircleShape)
                .background(AgentPal.coral.copy(alpha = 0.08f))
                .border(1.dp, AgentPal.coral.copy(alpha = 0.3f), CircleShape)
                .plainClick { expanded = !expanded }
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("🔧 ${almaBn(tools.size)}টি টুল", color = AgentPal.coral, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            if (anyLive) {
                CircularProgressIndicator(Modifier.size(10.dp), color = AgentPal.coral, strokeWidth = 1.5.dp)
            }
            Icon(
                Icons.Outlined.KeyboardArrowDown, null,
                tint = AgentPal.coral.copy(alpha = 0.6f),
                modifier = Modifier.size(14.dp),
            )
        }
        if (expanded) {
            tools.forEach { t ->
                CompactActivityRow(
                    icon = {
                        if (t.live) {
                            CircularProgressIndicator(Modifier.size(13.dp), color = AgentPal.muted(dark), strokeWidth = 1.5.dp)
                        } else {
                            Icon(Icons.Outlined.Build, null, tint = AgentPal.muted(dark), modifier = Modifier.size(14.dp))
                        }
                    },
                    label = t.name,
                    labelColor = AgentPal.mutedHi(dark),
                    dark = dark,
                    failed = t.ok == false,
                ) { onToolTap(t) }
            }
        }
    }
}

/** Live indicator — pulsing coral spark while the turn runs (Claude parity, no label). */
@Composable
private fun AgentWorkingIndicator(dark: Boolean) {
    val transition = rememberInfiniteTransition(label = "working")
    val pulse by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
        label = "workingPulse",
    )
    Row(
        Modifier.padding(bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text("✦", color = AgentPal.coral, fontSize = 18.sp, modifier = Modifier.alpha(pulse))
        Text("কাজ করছি…", color = AgentPal.muted(dark).copy(alpha = pulse), fontSize = 13.sp)
    }
}

@Composable
private fun AgentMessageFooter(message: AgentChatMessage, dark: Boolean) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("✦ ALMA", color = AgentPal.coral, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        relativeTimeBn(message.createdAt)?.let {
            Text(it, color = AgentPal.muted(dark), fontSize = 10.sp)
        }
        Box(
            Modifier.size(28.dp).plainClick {
                clipboard.setText(AnnotatedString(message.text))
                copied = true
            },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                contentDescription = "কপি করুন",
                tint = if (copied) AgentPal.teal else AgentPal.muted(dark),
                modifier = Modifier.size(13.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        message.tokensIn?.let { tin ->
            Text(
                "↑$tin" + (message.tokensOut?.let { " ↓$it" } ?: "") + (message.costUsd?.let { " $$it" } ?: ""),
                color = AgentPal.muted(dark).copy(alpha = 0.8f),
                fontSize = 9.5.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
            )
        }
    }
}

private fun relativeTimeBn(iso: String?): String? {
    if (iso == null) return null
    val date = parseIsoDate(iso) ?: return null
    val mins = kotlin.math.max(0L, (System.currentTimeMillis() - date.time) / 60_000L).toInt()
    return when {
        mins < 1 -> "এইমাত্র"
        mins < 60 -> "${almaBn(mins)} মিনিট আগে"
        mins < 1440 -> "${almaBn(mins / 60)} ঘণ্টা আগে"
        else -> "${almaBn(mins / 1440)} দিন আগে"
    }
}

private fun parseIsoDate(iso: String): Date? {
    val patterns = listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ssXXX")
    for (p in patterns) {
        try {
            val f = SimpleDateFormat(p, Locale.US)
            f.timeZone = TimeZone.getTimeZone("UTC")
            return f.parse(iso)
        } catch (_: Exception) { }
    }
    return null
}

// ── Markdown-lite renderer (headers / bullets / code cards / tables / inline) ──────

@Composable
private fun AgentMarkdownText(text: String, dark: Boolean, dim: Boolean = false) {
    val ink = AgentPal.ink(dark).copy(alpha = if (dim) 0.55f else 1f)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val parts = text.split("```")
        parts.forEachIndexed { i, part ->
            if (i % 2 == 1) {
                // Fenced block: first line = language tag.
                val lines = part.split("\n")
                val lang = lines.firstOrNull()?.trim() ?: ""
                val body = lines.drop(1).joinToString("\n").trim('\n')
                AgentCodeCard(lang, body, dark)
            } else {
                // Plain text — pull out contiguous table blocks.
                val buf = ArrayList<String>()
                val tbl = ArrayList<String>()
                @Composable
                fun renderBuf(list: List<String>) {
                    if (list.joinToString("\n").isNotBlank()) AgentParagraph(list, ink, dark)
                }
                val segments = ArrayList<Pair<Boolean, List<String>>>()  // isTable to lines
                part.split("\n").forEach { line ->
                    if (line.trim().startsWith("|")) {
                        if (buf.isNotEmpty()) { segments.add(false to buf.toList()); buf.clear() }
                        tbl.add(line)
                    } else {
                        if (tbl.isNotEmpty()) { segments.add(true to tbl.toList()); tbl.clear() }
                        buf.add(line)
                    }
                }
                if (buf.isNotEmpty()) segments.add(false to buf.toList())
                if (tbl.isNotEmpty()) segments.add(true to tbl.toList())
                segments.forEach { (isTable, lines) ->
                    if (isTable) AgentTableCard(lines.joinToString("\n"), dark)
                    else renderBuf(lines)
                }
            }
        }
    }
}

@Composable
private fun AgentParagraph(lines: List<String>, ink: Color, dark: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        lines.forEach { line ->
            val trimmed = line.trim()
            when {
                trimmed.isEmpty() -> Unit
                trimmed.startsWith("###") || trimmed.startsWith("##") || trimmed.startsWith("# ") -> {
                    Text(
                        trimmed.dropWhile { it == '#' || it == ' ' },
                        color = AgentPal.coral,
                        fontSize = if (trimmed.startsWith("# ")) 18.sp else 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ") -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text("•", color = AgentPal.muted(dark), fontSize = 15.5.sp)
                        Text(
                            inlineMarkdown(trimmed.drop(2), ink),
                            color = ink,
                            fontSize = 15.5.sp,
                            lineHeight = 24.sp,
                            fontFamily = FontFamily.Serif,
                        )
                    }
                }
                else -> {
                    Text(
                        inlineMarkdown(line, ink),
                        color = ink,
                        fontSize = 15.5.sp,
                        lineHeight = 24.sp,
                        fontFamily = FontFamily.Serif,
                    )
                }
            }
        }
    }
}

/** Inline **bold** + `code` spans (the iOS AttributedString inline-markdown twin). */
private fun inlineMarkdown(s: String, ink: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    var bold = false
    var code = false
    fun spanStyle() = SpanStyle(
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        fontFamily = if (code) FontFamily.Monospace else FontFamily.Serif,
        background = if (code) ink.copy(alpha = 0.08f) else Color.Transparent,
    )
    val buf = StringBuilder()
    fun flush() {
        if (buf.isNotEmpty()) {
            pushStyle(spanStyle())
            append(buf.toString())
            pop()
            buf.clear()
        }
    }
    while (i < s.length) {
        when {
            s.startsWith("**", i) -> {
                flush(); bold = !bold; i += 2
            }
            s[i] == '`' -> {
                flush(); code = !code; i += 1
            }
            else -> {
                buf.append(s[i]); i += 1
            }
        }
    }
    flush()
}

/** Web parity: ```copy/caption/post/text = branded coral copy card; else dark code card. */
@Composable
private fun AgentCodeCard(lang: String, body: String, dark: Boolean) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    val isCopyCard = lang.lowercase() in listOf("copy", "caption", "post", "text", "")
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (isCopyCard) AgentPal.coral.copy(alpha = 0.06f) else AgentPal.codeBg(dark))
            .border(
                1.dp,
                if (isCopyCard) AgentPal.coral.copy(alpha = 0.25f) else Color.White.copy(alpha = 0.08f),
                shape,
            )
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (isCopyCard) "কপি করার জন্য" else lang.uppercase(),
                color = if (isCopyCard) AgentPal.coral else Color.White.copy(alpha = 0.55f),
                fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
            Row(
                Modifier
                    .clip(CircleShape)
                    .background(if (isCopyCard) AgentPal.coral.copy(alpha = 0.13f) else Color.Transparent)
                    .border(
                        1.dp,
                        if (isCopyCard) AgentPal.coral.copy(alpha = 0.45f) else Color.Transparent,
                        CircleShape,
                    )
                    .plainClick {
                        clipboard.setText(AnnotatedString(body))
                        copied = true
                    }
                    .padding(horizontal = if (isCopyCard) 10.dp else 2.dp, vertical = if (isCopyCard) 5.dp else 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(
                    if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                    contentDescription = null,
                    tint = if (isCopyCard) AgentPal.coral else Color.White.copy(alpha = 0.8f),
                    modifier = Modifier.size(12.dp),
                )
                Text(
                    "কপি করুন",
                    color = if (isCopyCard) AgentPal.coral else Color.White.copy(alpha = 0.8f),
                    fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Text(
            body,
            color = if (isCopyCard) AgentPal.ink(dark) else Color.White.copy(alpha = 0.92f),
            fontSize = 13.5.sp,
            lineHeight = 19.sp,
            fontFamily = if (isCopyCard) FontFamily.Serif else FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Table block → horizontally scrollable monospace card (iOS tableCard parity). */
@Composable
private fun AgentTableCard(s: String, dark: Boolean) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(AgentPal.card(dark).copy(alpha = 0.75f))
            .border(1.dp, AgentPal.borderSubtle(dark), shape)
            .horizontalScroll(rememberScrollState()),
    ) {
        Text(
            s,
            color = AgentPal.ink(dark),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(12.dp),
        )
    }
}

// ── Confirm card (অনুমোদন / বাতিল / আমার মত — owner rule: always 3 options) ────────

@Composable
private fun AgentConfirmCardView(
    card: AgentConfirmCard,
    dark: Boolean,
    onDecide: (Boolean) -> Unit,
    onOpinion: (String) -> Unit,
) {
    var showOpinion by remember(card.id) { mutableStateOf(false) }
    var opinionText by remember(card.id) { mutableStateOf("") }
    val shape = RoundedCornerShape(20.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(AgentPal.glassFill(dark))
            .border(1.dp, Color.White.copy(alpha = 0.10f), shape),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("🔔", fontSize = 12.sp)
            Text("অনুমোদন দরকার", color = AgentPal.coral, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            card.costEstimate?.takeIf { it > 0 }?.let {
                Text(String.format(Locale.US, "~$%.2f", it), color = AgentPal.muted(dark), fontSize = 10.5.sp)
            }
        }
        Text(
            card.summary,
            color = AgentPal.ink(dark), fontSize = 14.sp, lineHeight = 20.sp,
            modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 12.dp),
        )
        if (card.status == "pending") {
            if (showOpinion) {
                Column(
                    Modifier.padding(horizontal = 16.dp).padding(bottom = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("আপনার মত লিখুন", color = AgentPal.mutedHi(dark), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(
                        value = opinionText,
                        onValueChange = { opinionText = it },
                        placeholder = { Text("আপনার মতামত…", fontSize = 14.sp, color = AgentPal.muted(dark)) },
                        textStyle = TextStyle(fontSize = 14.sp, color = AgentPal.ink(dark)),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "পাঠান",
                            color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier
                                .clip(CircleShape)
                                .background(AgentPal.coral)
                                .plainClick {
                                    if (opinionText.isNotBlank()) onOpinion(opinionText)
                                }
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                        Text(
                            "বাতিল",
                            color = AgentPal.muted(dark), fontSize = 13.sp,
                            modifier = Modifier.plainClick { showOpinion = false }.padding(8.dp),
                        )
                    }
                }
            } else {
                Row(
                    Modifier.padding(horizontal = 16.dp).padding(bottom = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "অনুমোদন",
                        color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(12.dp))
                            .background(AgentPal.coral)
                            .plainClick { onDecide(true) }
                            .padding(vertical = 10.dp),
                    )
                    Text(
                        "বাতিল",
                        color = AgentPal.muted(dark), fontSize = 13.sp, fontWeight = FontWeight.Medium,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White.copy(alpha = 0.04f))
                            .border(1.dp, AgentPal.borderSubtle(dark), RoundedCornerShape(12.dp))
                            .plainClick { onDecide(false) }
                            .padding(vertical = 10.dp),
                    )
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(AgentPal.borderSubtle(dark)))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .plainClick { showOpinion = true }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("💬", fontSize = 13.sp)
                    Text("আমার মত", color = AgentPal.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.weight(1f))
                    Icon(
                        Icons.Outlined.ChevronRight, null,
                        tint = AgentPal.muted(dark).copy(alpha = 0.5f), modifier = Modifier.size(14.dp),
                    )
                }
            }
        } else {
            val (label, color) = when (card.status) {
                "approved" -> "✓ অনুমোদিত" to AgentPal.teal
                "executed" -> "✓ সম্পন্ন হয়েছে" to AgentPal.teal
                "failed" -> "⚠ ব্যর্থ হয়েছে" to Color(0xFFEF4444)
                "expired" -> "মেয়াদ শেষ" to AgentPal.muted(dark)
                else -> "✕ বাতিল করা হয়েছে" to AgentPal.muted(dark)
            }
            Text(
                label, color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 14.dp),
            )
        }
    }
}

// ── Ask card (question + numbered option pills + free-text answer) ─────────────────

@Composable
private fun AgentAskCardView(card: AgentAskCard, dark: Boolean, onAnswer: (String) -> Unit) {
    var otherActive by remember(card.id) { mutableStateOf(false) }
    var otherText by remember(card.id) { mutableStateOf("") }
    val shape = RoundedCornerShape(22.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(AgentPal.glassFill(dark))
            .border(1.dp, Color.White.copy(alpha = 0.10f), shape),
    ) {
        if (card.status == "pending") {
            Text(
                card.question,
                color = AgentPal.ink(dark),
                fontSize = 15.5.sp, lineHeight = 22.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Serif,
                modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 18.dp, bottom = 10.dp),
            )
            card.options.forEachIndexed { idx, opt ->
                if (idx > 0) {
                    Box(
                        Modifier.fillMaxWidth().padding(start = 18.dp).height(1.dp)
                            .background(Color.White.copy(alpha = 0.06f)),
                    )
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .plainClick { onAnswer(opt) }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        almaBn(idx + 1),
                        color = AgentPal.mutedHi(dark), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .size(26.dp)
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.07f))
                            .border(1.dp, Color.White.copy(alpha = 0.08f), CircleShape)
                            .padding(top = 3.dp),
                    )
                    Text(opt, color = AgentPal.ink(dark), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Color.White.copy(alpha = 0.06f)))
            Row(
                Modifier
                    .fillMaxWidth()
                    .plainClick { otherActive = true }
                    .padding(horizontal = 16.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("✏️", fontSize = 13.sp)
                Text(
                    "Type your answer…",
                    color = if (otherActive) AgentPal.ink(dark) else AgentPal.muted(dark),
                    fontSize = 14.sp,
                )
            }
            if (otherActive) {
                Row(
                    Modifier.padding(start = 18.dp, end = 18.dp, bottom = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = otherText,
                        onValueChange = { otherText = it },
                        placeholder = { Text("আপনার মতামত…", fontSize = 14.sp, color = AgentPal.muted(dark)) },
                        textStyle = TextStyle(fontSize = 14.sp, color = AgentPal.ink(dark)),
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(12.dp),
                    )
                    Box(
                        Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(AgentPal.coral)
                            .plainClick {
                                val t = otherText.trim()
                                if (t.isNotEmpty()) onAnswer(t)
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Outlined.ArrowUpward, null, tint = Color.White, modifier = Modifier.size(16.dp))
                    }
                }
            }
        } else {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(card.question, color = AgentPal.muted(dark), fontSize = 13.sp)
                card.selectedOption?.let { sel ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Icon(Icons.Outlined.Check, null, tint = AgentPal.coral, modifier = Modifier.size(13.dp))
                        Text(sel, color = AgentPal.coral, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

// ── Composer (web AgentComposer parity — neon border, model pill, send/stop) ───────

@Composable
private fun AgentComposer(
    vm: AssistantState,
    dark: Boolean,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onModelPill: () -> Unit,
    onVoice: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    val sendEnabled = draft.trim().isNotEmpty()
    val shape = RoundedCornerShape(24.dp)
    // Static approximation of the web agent-neon-input conic border: coral → gold → blue.
    val neonBrush = remember {
        Brush.sweepGradient(
            listOf(
                AgentPal.coral.copy(alpha = 0f),
                AgentPal.coral.copy(alpha = 0.85f),
                Color(0xFFF5C878).copy(alpha = 0.95f),
                Color(0xFF78C8F5).copy(alpha = 0.85f),
                AgentPal.coral.copy(alpha = 0f),
                AgentPal.coral.copy(alpha = 0f),
            ),
        )
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .padding(bottom = 8.dp)
            .clip(shape)
            .background(AgentPal.glassFill(dark))
            .border(1.5.dp, neonBrush, shape)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        BasicTextField(
            value = draft,
            onValueChange = { draft = it },
            textStyle = TextStyle(fontSize = 16.sp, color = AgentPal.ink(dark)),
            cursorBrush = SolidColor(AgentPal.coral),
            maxLines = 5,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp)
                .padding(top = 8.dp),
            decorationBox = { inner ->
                Box {
                    if (draft.isEmpty()) {
                        Text("বার্তা লিখুন…", color = AgentPal.muted(dark), fontSize = 16.sp)
                    }
                    inner()
                }
            },
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            // Model pill — display + native picker (web AgentModelSelector parity).
            Row(
                Modifier
                    .widthIn(max = 150.dp)
                    .clip(CircleShape)
                    .background(AgentPal.card(dark).copy(alpha = 0.5f))
                    .border(
                        1.dp,
                        if (vm.isAutoModel) AgentPal.borderSubtle(dark) else AgentPal.coral.copy(alpha = 0.35f),
                        CircleShape,
                    )
                    .plainClick { if (!vm.isStreaming) onModelPill() }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    vm.modelPillLabel,
                    color = if (vm.isAutoModel) AgentPal.muted(dark) else AgentPal.coral,
                    fontSize = 10.5.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    Icons.Outlined.KeyboardArrowDown, null,
                    tint = if (vm.isAutoModel) AgentPal.muted(dark) else AgentPal.coral,
                    modifier = Modifier.size(11.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            // Voice — web escape (native orb deferred on Android v1).
            Box(
                Modifier.size(36.dp).plainClick(onVoice),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.GraphicEq, contentDescription = "ভয়েস", tint = AgentPal.teal, modifier = Modifier.size(18.dp))
            }
            // Send / stop.
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(
                        if (sendEnabled || vm.isStreaming) AgentPal.coral
                        else AgentPal.card(dark).copy(alpha = 0.5f),
                    )
                    .plainClick {
                        if (vm.isStreaming) {
                            onStop()
                        } else if (sendEnabled) {
                            val text = draft
                            draft = ""
                            onSend(text)
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (vm.isStreaming) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward,
                    contentDescription = if (vm.isStreaming) "থামান" else "পাঠান",
                    tint = if (sendEnabled || vm.isStreaming) Color.White else AgentPal.muted(dark),
                    modifier = Modifier.size(17.dp),
                )
            }
        }
    }
}

// ── Model picker sheet (⚡ Auto + enabled models grouped by provider) ───────────────

@Composable
private fun AgentModelPickerSheet(vm: AssistantState, dark: Boolean, onPick: (String?) -> Unit) {
    LaunchedEffect(Unit) { vm.loadModels() }
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 18.dp, end = 18.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            "মডেল",
            color = AgentPal.ink(dark), fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
        )
        ModelRow("⚡ Auto", vm.isAutoModel, dark) { onPick(null) }
        listOf(
            "anthropic" to "Anthropic",
            "google" to "Google",
            "openai" to "OpenAI",
            "openrouter" to "OpenRouter",
        ).forEach { (key, label) ->
            val group = vm.models.filter { it.provider == key }
            if (group.isNotEmpty()) {
                Text(
                    label,
                    color = AgentPal.muted(dark), fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 14.dp, bottom = 4.dp),
                )
                group.forEach { m ->
                    ModelRow(m.label, vm.modelId == m.id, dark) { onPick(m.id) }
                }
            }
        }
    }
}

@Composable
private fun ModelRow(label: String, selected: Boolean, dark: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .plainClick(onClick)
            .padding(horizontal = 10.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = if (selected) AgentPal.coral else AgentPal.ink(dark),
            fontSize = 15.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
        Spacer(Modifier.weight(1f))
        if (selected) {
            Icon(Icons.Outlined.Check, null, tint = AgentPal.coral, modifier = Modifier.size(15.dp))
        }
    }
}

// ── Tool I/O + Thinking sheets ─────────────────────────────────────────────────────

@Composable
private fun AgentToolIOSheet(tool: AgentTool, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Outlined.Build, null, tint = AgentPal.coral, modifier = Modifier.size(15.dp))
            Text(
                tool.name,
                color = AgentPal.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (tool.ok == false) {
                Text(
                    "ব্যর্থ",
                    color = Color(0xFFBA1C1C), fontSize = 10.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .background(Color(0xFFEF4444).copy(alpha = 0.12f), CircleShape)
                        .border(1.dp, Color(0xFFEF4444).copy(alpha = 0.3f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            } else if (!tool.live) {
                Text(
                    "সম্পন্ন",
                    color = Color(0xFF14803D), fontSize = 10.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .background(AgentPal.teal.copy(alpha = 0.14f), CircleShape)
                        .border(1.dp, AgentPal.teal.copy(alpha = 0.3f), CircleShape)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
        if (tool.inputPretty.isNullOrEmpty() && tool.resultFull.isNullOrEmpty()) {
            Text(
                "এই টুলের কোনো ইনপুট/ফলাফল নেই।",
                color = AgentPal.muted(dark), fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
            )
        }
        tool.inputPretty?.takeIf { it.isNotEmpty() }?.let {
            ToolIOBlock("ইনপুট · INPUT", it, dark, failed = false)
        }
        tool.resultFull?.takeIf { it.isNotEmpty() }?.let {
            ToolIOBlock("ফলাফল · OUTPUT", it, dark, failed = tool.ok == false)
        }
    }
}

@Composable
private fun ToolIOBlock(label: String, body: String, dark: Boolean, failed: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, color = AgentPal.muted(dark).copy(alpha = 0.7f), fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 300.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color.Black.copy(alpha = 0.25f))
                .border(1.dp, Color.White.copy(alpha = 0.06f), RoundedCornerShape(12.dp))
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                body,
                color = if (failed) Color(0xFFEF4444).copy(alpha = 0.85f) else AgentPal.ink(dark).copy(alpha = 0.85f),
                fontSize = 12.sp, lineHeight = 17.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}

@Composable
private fun AgentThinkingSheet(thinking: String, dark: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Outlined.Schedule, null, tint = AgentPal.coral, modifier = Modifier.size(15.dp))
            Text("চিন্তার ধারা", color = AgentPal.ink(dark), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
        Text(
            thinking,
            color = AgentPal.ink(dark).copy(alpha = 0.85f),
            fontSize = 13.sp, lineHeight = 20.sp,
        )
    }
}

// ── Drawer (conversation list + web escape hatches) ────────────────────────────────

@Composable
private fun AgentDrawer(
    vm: AssistantState,
    dark: Boolean,
    scope: CoroutineScope,
    onClose: () -> Unit,
    openWeb: (String, String) -> Unit,
) {
    var search by remember { mutableStateOf("") }
    var menuFor by remember { mutableStateOf<AgentConversation?>(null) }
    var renameTarget by remember { mutableStateOf<AgentConversation?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<AgentConversation?>(null) }

    val filtered = vm.conversations.filter { c ->
        c.archived != true &&
            (search.isEmpty() || (c.title ?: "").contains(search, ignoreCase = true))
    }

    Box(Modifier.fillMaxSize()) {
        // Scrim
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.30f))
                .plainClick(onClose),
        )
        // Drawer panel — web w-72, rounded right corners.
        Column(
            Modifier
                .width(288.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(topEnd = 24.dp, bottomEnd = 24.dp))
                .background(AlmaTheme.rootBg(dark))
                .background(AgentPal.glassFill(dark))
                .statusBarsPadding(),
        ) {
            // নতুন কথোপকথন — one clear primary action.
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp)
                    .padding(top = 14.dp)
                    .clip(CircleShape)
                    .background(AgentPal.coral)
                    .plainClick {
                        vm.newChat()
                        onClose()
                    }
                    .padding(vertical = 11.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Edit, null, tint = Color.White, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text("নতুন কথোপকথন", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }

            // Search
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp)
                    .padding(top = 10.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(Color.White.copy(alpha = if (dark) 0.06f else 0.5f))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.Search, null, tint = AgentPal.muted(dark), modifier = Modifier.size(14.dp))
                BasicTextField(
                    value = search,
                    onValueChange = { search = it },
                    textStyle = TextStyle(fontSize = 15.sp, color = AgentPal.ink(dark)),
                    cursorBrush = SolidColor(AgentPal.coral),
                    singleLine = true,
                    modifier = Modifier.weight(1f).padding(vertical = 6.dp),
                    decorationBox = { inner ->
                        Box {
                            if (search.isEmpty()) {
                                Text("খুঁজুন…", color = AgentPal.muted(dark), fontSize = 15.sp)
                            }
                            inner()
                        }
                    },
                )
                if (search.isNotEmpty()) {
                    Icon(
                        Icons.Outlined.Close, null,
                        tint = AgentPal.muted(dark).copy(alpha = 0.7f),
                        modifier = Modifier.size(14.dp).plainClick { search = "" },
                    )
                }
            }

            // Conversation list
            LazyColumn(Modifier.weight(1f).padding(top = 6.dp)) {
                if (vm.loadingConversations) {
                    item {
                        Text(
                            "লোড হচ্ছে…",
                            color = AgentPal.muted(dark), fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                        )
                    }
                } else if (filtered.isEmpty()) {
                    item {
                        Text(
                            "কোনো কথোপকথন নেই — নতুন চ্যাট শুরু করুন",
                            color = AgentPal.muted(dark), fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                        )
                    }
                }
                items(filtered, key = { it.id }) { c ->
                    val active = c.id == vm.conversationId
                    Box {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 8.dp, vertical = 2.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (active) AgentPal.coral.copy(alpha = 0.10f) else Color.Transparent)
                                .combinedClickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = {
                                        scope.launch { vm.openConversation(c.id) }
                                        onClose()
                                    },
                                    onLongClick = { menuFor = c },
                                )
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            if (c.source == "day_shift") Text("🏢", fontSize = 13.sp)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(
                                    c.title?.takeIf { it.isNotEmpty() } ?: "(শিরোনাম নেই)",
                                    color = if (active) AgentPal.coral else AgentPal.ink(dark),
                                    fontSize = 14.sp,
                                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    (if (c.source == "day_shift") "অফিস লাইভ · " else "") + shortDateBn(c.updatedAt),
                                    color = AgentPal.muted(dark), fontSize = 11.sp,
                                )
                            }
                            if (active) {
                                Box(Modifier.size(6.dp).clip(CircleShape).background(AgentPal.coral))
                            }
                        }
                        DropdownMenu(expanded = menuFor?.id == c.id, onDismissRequest = { menuFor = null }) {
                            DropdownMenuItem(
                                text = { Text("নাম পরিবর্তন") },
                                onClick = {
                                    renameText = c.title ?: ""
                                    renameTarget = c
                                    menuFor = null
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("আর্কাইভ") },
                                onClick = {
                                    scope.launch { vm.archiveConversation(c.id) }
                                    menuFor = null
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("মুছুন", color = Color(0xFFEF4444)) },
                                onClick = {
                                    deleteTarget = c
                                    menuFor = null
                                },
                            )
                        }
                    }
                }
                if (vm.conversationsCursor != null) {
                    item {
                        Text(
                            if (vm.loadingMoreConversations) "লোড হচ্ছে…" else "আরও দেখুন",
                            color = AgentPal.muted(dark), fontSize = 12.sp, fontWeight = FontWeight.Medium,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .plainClick { scope.launch { vm.loadMoreConversations() } }
                                .padding(vertical = 12.dp),
                        )
                    }
                }
            }

            // Web escape hatches (voice / images / TTS / sub-pages stay web for now).
            Box(Modifier.fillMaxWidth().height(1.dp).background(AgentPal.borderSubtle(dark)))
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "ভয়েস, ছবি ও শুনুন — আপাতত ওয়েব ভার্সনে",
                    color = AgentPal.muted(dark), fontSize = 10.sp,
                )
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf(
                        "Studio" to "/agent/creative-studio",
                        "WhatsApp" to "/agent/whatsapp",
                        "Monitor" to "/agent/staff-monitor",
                        "Costs" to "/agent/costs",
                    ).forEach { (label, path) ->
                        Text(
                            "🌐 $label",
                            color = AgentPal.mutedHi(dark), fontSize = 12.sp, fontWeight = FontWeight.Medium,
                            modifier = Modifier
                                .clip(CircleShape)
                                .background(Color.White.copy(alpha = if (dark) 0.05f else 0.35f))
                                .border(1.dp, AgentPal.borderSubtle(dark), CircleShape)
                                .plainClick { openWeb(path, label) }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        )
                    }
                }
            }
        }
    }

    renameTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("নাম পরিবর্তন") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    placeholder = { Text("শিরোনাম") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { vm.renameConversation(target.id, renameText) }
                    renameTarget = null
                }) { Text("সংরক্ষণ") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("বাতিল") }
            },
        )
    }

    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("কথোপকথন মুছবেন?") },
            text = { Text("এই কথোপকথন এবং সকল বার্তা স্থায়ীভাবে মুছে যাবে।") },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { vm.deleteConversation(target.id) }
                    deleteTarget = null
                }) { Text("মুছুন", color = Color(0xFFEF4444)) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("বাতিল") }
            },
        )
    }
}

private fun shortDateBn(iso: String?): String {
    val date = iso?.let { parseIsoDate(it) } ?: return ""
    val df = SimpleDateFormat("dd MMM", Locale("en", "BD"))
    return df.format(date)
}
