//
//  AlmaCompanionScreen.kt
//  ALMA ERP — the PHONE companion (Android port of iOS AlmaCompanion.swift).
//
//  The ALMA agent can drive a browser on the owner's PHONE the same way it drives his
//  Mac Chrome: this screen registers on the SAME live-browser command bus as the Chrome
//  extension (pair code → bearer token → long-poll /api/assistant/live-browser/poll →
//  execute in this WebView → POST /result). The WebView shares the app's cookies, so
//  sites the owner logged into inside the app stay logged in here.
//
//  Safety model (mirrors the extension + iOS, enforced ON DEVICE):
//    • Runs ONLY while this screen is open — leaving stops the poll loop instantly.
//    • Native STOP bar pauses the loop + fails the in-flight command.
//    • FINAL-SUBMIT BAN in the click path (regex kept in sync with final-submit.ts).
//    • §5.4 lockdown tiers: write verbs check the WebView's REAL host before acting.
//    • The agent never sees credentials: pairing is a one-time code the owner types.
//

package com.almatraders.erp.pages

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.almatraders.erp.shell.plainClick
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

private const val COMPANION_PREFS = "alma-native-shell"
private const val COMPANION_BASE = "https://alma-erp-six.vercel.app"

/** Token + pause prefs — the token only ever lives on-device. */
private object CompanionStore {
    fun token(c: android.content.Context) =
        c.getSharedPreferences(COMPANION_PREFS, 0).getString("alma_companion_token", "") ?: ""
    fun setToken(c: android.content.Context, v: String) =
        c.getSharedPreferences(COMPANION_PREFS, 0).edit().putString("alma_companion_token", v).apply()
    fun paused(c: android.content.Context) =
        c.getSharedPreferences(COMPANION_PREFS, 0).getBoolean("alma_companion_paused", false)
    fun setPaused(c: android.content.Context, v: Boolean) =
        c.getSharedPreferences(COMPANION_PREFS, 0).edit().putBoolean("alma_companion_paused", v).apply()
    fun isPaired(c: android.content.Context) = token(c).isNotEmpty()
}

/** Bridge that the injected page routine calls back with its JSON result, keyed by id. */
private class CompanionBridge {
    val pending = ConcurrentHashMap<String, (String) -> Unit>()
    @JavascriptInterface
    fun deliver(cid: String, json: String) { pending.remove(cid)?.invoke(json) }
}

private val companionHttp = OkHttpClient.Builder()
    .callTimeout(30, TimeUnit.SECONDS)
    .readTimeout(25, TimeUnit.SECONDS)
    .build()

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AlmaCompanionScreen(dark: Boolean, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var status by remember { mutableStateOf("সংযোগ হচ্ছে…") }
    var dot by remember { mutableStateOf(Color(0xFF8E8E93)) }
    var showPair by remember { mutableStateOf(false) }
    var pairSubmit by remember { mutableStateOf<String?>(null) }
    var running by remember { mutableStateOf(true) }        // false after STOP
    var paired by remember { mutableStateOf(CompanionStore.isPaired(context)) }
    val bridge = remember { CompanionBridge() }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val loadFinished = remember { java.util.concurrent.atomic.AtomicBoolean(false) }
    val stopRequested = remember { java.util.concurrent.atomic.AtomicBoolean(false) }

    fun setStatus(t: String, c: Color) { status = t; dot = c }

    BackHandler { onClose() }

    // Stop the loop when the screen leaves (owner-watches-live invariant).
    DisposableEffect(Unit) {
        onDispose { running = false; webView?.stopLoading() }
    }

    Box(Modifier.fillMaxSize().background(Color(0xFF0B0A10))) {
        Column(Modifier.fillMaxSize()) {
            // Native control bar — the owner ALWAYS sees who is driving + can stop.
            Row(
                Modifier
                    .statusBarsPadding()
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .background(Color(0xFF16141F), RoundedCornerShape(14.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(10.dp).background(dot, CircleShape))
                Spacer(Modifier.width(10.dp))
                Text(status, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                Box(
                    Modifier
                        .background(Color(0xFFE05252), RoundedCornerShape(12.dp))
                        .plainClick {
                            stopRequested.set(true)
                            running = false
                            CompanionStore.setPaused(context, true)
                            setStatus("থামানো হয়েছে — আবার চালু করতে STOP ছাড়ুন", Color(0xFFE05252))
                        }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    Text("⏹ STOP", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.databaseEnabled = true
                        settings.mediaPlaybackRequiresUserGesture = false
                        settings.userAgentString = settings.userAgentString + " AlmaCompanion"
                        CookieManager.getInstance().setAcceptCookie(true)
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                        addJavascriptInterface(bridge, "AlmaCompanionBridge")
                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) { loadFinished.set(true) }
                            override fun onReceivedError(v: WebView?, r: WebResourceRequest?, e: WebResourceError?) { loadFinished.set(true) }
                        }
                        loadData(
                            "<html><body style='background:#0B0A10;color:#8a8a93;font-family:sans-serif;padding:24px'>" +
                                "<h3>Agent Companion</h3><p>এজেন্টকে চ্যাটে বলুন \"live browser pair code দাও\", কোডটা এখানে বসান — তারপর এজেন্ট এই ফোন দিয়ে কাজ করবে, আপনি লাইভ দেখবেন।</p></body></html>",
                            "text/html", "utf-8",
                        )
                        webView = this
                    }
                },
            )
        }
    }

    // Pairing dialog.
    if (showPair) {
        var code by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showPair = false; setStatus("যুক্ত করা হয়নি", Color(0xFF8E8E93)) },
            title = { Text("ফোন কমপ্যানিয়ন যুক্ত করুন") },
            text = {
                Column {
                    Text("চ্যাটে এজেন্টকে বলুন: \"live browser pair code দাও\" — তারপর কোডটা এখানে বসান।",
                        fontSize = 13.sp)
                    Spacer(Modifier.size(10.dp))
                    OutlinedTextField(code, { code = it.uppercase() }, singleLine = true,
                        placeholder = { Text("যেমন: 4F9K-2T7Q") })
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    showPair = false
                    stopRequested.set(false)
                    pairSubmit = code.trim()
                }) { Text("যুক্ত করো") }
            },
            dismissButton = { TextButton(onClick = { showPair = false }) { Text("বাতিল") } },
        )
    }

    // Pair redemption (separate effect so the dialog can trigger it).
    LaunchedEffect(pairSubmit) {
        val code = pairSubmit ?: return@LaunchedEffect
        pairSubmit = null
        setStatus("যুক্ত হচ্ছে…", Color(0xFFF5C518))
        val token = withContext(Dispatchers.IO) { redeemPair(code) }
        if (token != null) {
            CompanionStore.setToken(context, token)
            CompanionStore.setPaused(context, false)
            setStatus("যুক্ত হয়েছে — এজেন্টের কমান্ডের অপেক্ষায়", Color(0xFF34C759))
            running = true
            paired = true          // re-keys the poll loop below so it starts polling
        } else {
            setStatus("যুক্ত করা যায়নি — আবার চেষ্টা করুন", Color(0xFFE05252))
            showPair = true
        }
    }

    // The poll loop — active only while `running` and the screen is composed.
    // Keyed on `paired` too so it (re)starts the instant a fresh token lands.
    LaunchedEffect(running, paired) {
        if (!running) return@LaunchedEffect
        if (!CompanionStore.isPaired(context)) { showPair = true; return@LaunchedEffect }
        if (CompanionStore.paused(context)) return@LaunchedEffect
        stopRequested.set(false)
        setStatus("সংযুক্ত — অপেক্ষায়", Color(0xFF34C759))
        while (isActive && running) {
            val wv = webView
            if (wv != null) {
                val outcome = pollOnce(context, wv, bridge, loadFinished, stopRequested, ::setStatus)
                if (outcome == PollOutcome.UNPAIRED) {
                    CompanionStore.setToken(context, "")
                    setStatus("Pairing বাতিল — নতুন কোড লাগবে", Color(0xFFE05252))
                    showPair = true
                    break
                }
            }
            kotlinx.coroutines.delay(1000)
        }
    }
}

private enum class PollOutcome { IDLE, RAN, UNPAIRED }

/** POST /pair → token (null on failure). */
private fun redeemPair(code: String): String? = try {
    val body = JSONObject()
        .put("code", code.uppercase())
        .put("deviceName", "Android (${android.os.Build.MODEL})".take(40))
        .toString().toRequestBody("application/json".toMediaType())
    val req = Request.Builder().url("$COMPANION_BASE/api/assistant/live-browser/pair").post(body).build()
    companionHttp.newCall(req).execute().use { resp ->
        val json = resp.body?.string()?.let { JSONObject(it) }
        json?.optString("token")?.takeIf { it.isNotEmpty() }
    }
} catch (_: Exception) { null }

/** One poll → optional command → execute → post result. */
private suspend fun pollOnce(
    context: android.content.Context,
    webView: WebView,
    bridge: CompanionBridge,
    loadFinished: java.util.concurrent.atomic.AtomicBoolean,
    stopRequested: java.util.concurrent.atomic.AtomicBoolean,
    setStatus: (String, Color) -> Unit,
): PollOutcome {
    val token = CompanionStore.token(context)
    if (token.isEmpty() || CompanionStore.paused(context)) return PollOutcome.IDLE

    val cmd = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("$COMPANION_BASE/api/assistant/live-browser/poll")
                .header("Authorization", "Bearer $token").build()
            companionHttp.newCall(req).execute().use { resp ->
                if (resp.code == 401) return@withContext "UNPAIRED"
                val obj = resp.body?.string()?.let { JSONObject(it) } ?: return@withContext null
                obj.optJSONObject("command")?.toString()
            }
        } catch (_: Exception) { null }
    }
    if (cmd == "UNPAIRED") return PollOutcome.UNPAIRED
    if (cmd == null) return PollOutcome.IDLE
    val command = JSONObject(cmd)
    val id = command.optString("id").ifEmpty { return PollOutcome.IDLE }
    val action = command.optString("action").ifEmpty { return PollOutcome.IDLE }

    setStatus("কাজ চলছে: ${banglaVerb(action)}", Color(0xFFF5C518))
    val result = executeCommand(webView, bridge, loadFinished, stopRequested, action, command)
    withContext(Dispatchers.IO) {
        try {
            val payload = JSONObject(result.toString()).put("commandId", id)
                .toString().toRequestBody("application/json".toMediaType())
            val req = Request.Builder()
                .url("$COMPANION_BASE/api/assistant/live-browser/result")
                .header("Authorization", "Bearer $token").post(payload).build()
            companionHttp.newCall(req).execute().close()
        } catch (_: Exception) { }
    }
    setStatus("সংযুক্ত — অপেক্ষায়", Color(0xFF34C759))
    return PollOutcome.RAN
}

private fun banglaVerb(a: String) = when (a) {
    "navigate" -> "পেজ খুলছে"
    "read_text", "read_dom" -> "পড়ছে"
    "click" -> "ক্লিক"
    "type" -> "লিখছে"
    "press" -> "কী চাপছে"
    "select_option" -> "অপশন বাছছে"
    "screenshot" -> "স্ক্রিনশট"
    "scroll", "scroll_to" -> "স্ক্রল"
    else -> a
}

private val WRITE_VERBS = setOf("click", "type", "press", "select_option")

private suspend fun executeCommand(
    webView: WebView,
    bridge: CompanionBridge,
    loadFinished: java.util.concurrent.atomic.AtomicBoolean,
    stopRequested: java.util.concurrent.atomic.AtomicBoolean,
    action: String,
    cmd: JSONObject,
): JSONObject {
    if (stopRequested.get()) return jsonOf("ok" to false, "error" to "owner_stop")

    when (action) {
        "ping" -> return jsonOf("ok" to true, "data" to JSONObject().put("pong", true).put("device", "phone"))
        "wait" -> {
            val ms = (cmd.optDouble("ms", 1000.0)).coerceIn(0.0, 30000.0)
            kotlinx.coroutines.delay(ms.toLong())
            return jsonOf("ok" to true)
        }
        "switch_tab", "close_tab" -> return jsonOf("ok" to false, "error" to "not_supported_on_phone (single webview)")
    }

    // §5.4 lockdown: refuse writes on a lockdown-tier site (real current host).
    if (action in WRITE_VERBS) {
        val locked = cmd.optJSONArray("lockdownDomains")
        if (locked != null && locked.length() > 0) {
            val host = withContext(Dispatchers.Main) {
                android.net.Uri.parse(webView.url ?: "").host?.lowercase()
            }
            if (host != null) {
                val bare = if (host.startsWith("www.")) host.drop(4) else host
                for (i in 0 until locked.length()) {
                    val dom = locked.optString(i).lowercase()
                    if (dom.isNotEmpty() && (bare == dom || bare.endsWith(".$dom"))) {
                        return jsonOf("ok" to false, "blocked" to true,
                            "error" to "site_lockdown: $dom — এই সাইট read-only তালিকায়; ফোনেও ক্লিক/টাইপ বন্ধ।")
                    }
                }
            }
        }
    }

    return when (action) {
        "navigate" -> {
            val raw = cmd.optString("url")
            if (!raw.lowercase().startsWith("http")) jsonOf("ok" to false, "error" to "navigate needs http(s) url")
            else navigate(webView, loadFinished, raw)
        }
        "go_back" -> withContext(Dispatchers.Main) {
            if (webView.canGoBack()) { webView.goBack(); jsonOf("ok" to true, "data" to JSONObject().put("back", true)) }
            else jsonOf("ok" to false, "error" to "no page to go back to")
        }
        "screenshot" -> snapshot(webView)
        "read_text", "read_dom", "click", "type", "press", "select_option",
        "hover", "scroll", "scroll_to" -> runPageScript(webView, bridge, action, cmd)
        else -> jsonOf("ok" to false, "error" to "unsupported action: $action")
    }
}

private suspend fun navigate(webView: WebView, loadFinished: java.util.concurrent.atomic.AtomicBoolean, url: String): JSONObject {
    loadFinished.set(false)
    withContext(Dispatchers.Main) { webView.loadUrl(url) }
    repeat(60) {
        if (loadFinished.get()) return@repeat
        kotlinx.coroutines.delay(250)
    }
    kotlinx.coroutines.delay(500)
    return jsonOf("ok" to true, "data" to JSONObject().put("url", url))
}

private suspend fun snapshot(webView: WebView): JSONObject = withContext(Dispatchers.Main) {
    try {
        val w = webView.width.coerceAtLeast(1)
        val h = webView.height.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        webView.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 55, out)
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        jsonOf("ok" to true, "screenshot" to "data:image/jpeg;base64,$b64")
    } catch (e: Exception) {
        jsonOf("ok" to false, "error" to (e.message ?: "snapshot failed"))
    }
}

/** Run one page routine via the injected dispatcher; await its JSON via the bridge. */
private suspend fun runPageScript(
    webView: WebView,
    bridge: CompanionBridge,
    action: String,
    cmd: JSONObject,
): JSONObject {
    val arg = JSONObject()
    for (k in listOf("selector", "text", "ref", "value", "option", "key", "by", "ms", "submit")) {
        if (cmd.has(k)) arg.put(k, cmd.get(k))
    }
    val cid = "c" + System.nanoTime()
    val actionJson = JSONObject.quote(action)
    val argJson = arg.toString()
    val call = "(async function(action, arg){ ${AlmaCompanionJs.DISPATCHER} })($actionJson, $argJson)" +
        ".then(function(r){ AlmaCompanionBridge.deliver('$cid', JSON.stringify(r)); })" +
        ".catch(function(e){ AlmaCompanionBridge.deliver('$cid', JSON.stringify({ok:false,error:String(e)})); });"

    val json = withTimeoutOrNull(20_000) {
        suspendCancellableCoroutine<String> { cont ->
            bridge.pending[cid] = { result -> if (cont.isActive) cont.resume(result) }
            webView.post { webView.evaluateJavascript(call, null) }
            cont.invokeOnCancellation { bridge.pending.remove(cid) }
        }
    }
    return if (json == null) jsonOf("ok" to false, "error" to "page script timeout")
    else try { JSONObject(json) } catch (_: Exception) { jsonOf("ok" to false, "error" to "bad page result") }
}

private fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) o.put(k, v)
    return o
}
