//
//  NativeShell.kt
//  ALMA ERP — the Android native shell: Compose bottom tab bar + native screens
//  wrapping the existing Capacitor app, mirroring the iOS AlmaTabBarController +
//  SwiftUIShell architecture 1:1:
//
//    • 5 tabs: Dashboard (Capacitor WebView, kept mounted — push/OneSignal/login
//      live there), Orders (native), Assistant (native), Approvals (native), More (native).
//    • Per-tab push stacks; pushed screens are native when AlmaNativeRouter knows the
//      route, web fallback otherwise (pushSmart). Native screens receive a FORCED-web
//      escape (never recurses into the router) — same recursion guard as iOS.
//    • "Native স্ক্রিন" escape hatch (AlmaTheme.nativeScreensOn, default ON): OFF =
//      the plain Capacitor app, exactly as before this shell existed.
//
//  MainActivity stays a BridgeActivity: install() re-parents Capacitor's view into
//  the Dashboard tab, so the bridge (plugins, OneSignal registration, the shared
//  login session) keeps running untouched — the reason the iOS Dashboard tab was
//  frozen on Capacitor is preserved the same way here.
//

package com.almatraders.erp.shell

import android.annotation.SuppressLint
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity
import java.lang.ref.WeakReference

// ── Push-stack entries ────────────────────────────────────────────────────────────

/** Context handed to pushed native screens (title bar + navigation closures). */
class PushCtx(
    val openSmart: (path: String, title: String) -> Unit,
    val openWebForced: (path: String, title: String) -> Unit,
    val pop: () -> Unit,
)

sealed class StackEntry {
    abstract val title: String

    /** Web fallback — holds its WebView so back/forward keeps state (iOS pushWeb twin). */
    class Web(override val title: String, val webView: WebView) : StackEntry()

    /** Migrated native screen (AlmaNativeRouter hit). */
    class Native(
        override val title: String,
        val content: @Composable (PushCtx) -> Unit,
    ) : StackEntry()
}

// ── Shell installation (called from MainActivity after super.onCreate) ────────────

object NativeShell {

    /** Every live ERP WebView (weak) — theme flips re-apply data-theme to all of them. */
    private val liveWebViews = ArrayList<WeakReference<WebView>>()

    fun registerWebView(view: WebView) {
        liveWebViews.removeAll { it.get() == null }
        liveWebViews.add(WeakReference(view))
    }

    fun applyThemeToWebViews() {
        val js = AlmaTheme.applyJs()
        liveWebViews.removeAll { it.get() == null }
        liveWebViews.forEach { it.get()?.evaluateJavascript(js, null) }
    }

    @JvmStatic
    fun install(activity: BridgeActivity) {
        AlmaTheme.loadInitial(activity)
        if (!AlmaTheme.nativeScreensOn) return // escape hatch: plain Capacitor app

        // Capacitor already called setContentView — lift its root out and wrap it.
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val capacitorRoot = content.getChildAt(0) ?: return
        content.removeView(capacitorRoot)

        // The Capacitor WebView is the Dashboard tab: give it the same embed-mode
        // flags the iOS shell installs (web hides its own bottom chrome; the native
        // tab bar is the only chrome).
        activity.bridge?.webView?.let { wv ->
            registerWebView(wv)
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                try {
                    WebViewCompat.addDocumentStartJavaScript(
                        wv, "window.__almaNative = true;", setOf("*"),
                    )
                } catch (_: Exception) { }
            }
        }

        // Edge-to-edge: the aurora paints under the system bars; bar icon tint follows theme.
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        // Keyboard: ADJUST_NOTHING so the window does NOT also resize — otherwise the
        // native chat gets pushed up by BOTH the window resize and Compose imePadding,
        // leaving a big empty gap between the keyboard and the input box. imePadding()
        // on the native screens now positions the input exactly above the keyboard.
        activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)

        val composeView = ComposeView(activity).apply {
            setContent { ShellRoot(activity, capacitorRoot) }
        }
        activity.setContentView(composeView)
    }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────────

private class TabSpec(
    /** Stable identity + index into ALL_TABS — content/stacks key off this, not the
     *  visible position (which shifts as role gating hides tabs). */
    val index: Int,
    val title: String,
    val icon: ImageVector,
    val nativeHeader: Boolean,
    /** Route the tab leads to; null = always shown (Dashboard hosts the Capacitor
     *  bridge, More is the container). Non-null tabs are hidden when the role can't
     *  reach the route — the web `filterNavByRole` behaviour. */
    val gatePath: String?,
)

// The full tab set; the visible subset is computed per role in ShellRoot. Order and
// index are fixed so TabContent(index) and the per-tab push stacks stay stable.
private val ALL_TABS = listOf(
    TabSpec(0, "Dashboard", Icons.Outlined.GridView, nativeHeader = true, gatePath = null),
    TabSpec(1, "Orders", Icons.Outlined.Inventory2, nativeHeader = true, gatePath = "/orders"),
    TabSpec(2, "Assistant", Icons.Outlined.AutoAwesome, nativeHeader = false, gatePath = "/agent"),
    TabSpec(3, "Approvals", Icons.Outlined.Verified, nativeHeader = true, gatePath = "/approvals"),
    TabSpec(4, "More", Icons.Outlined.MoreHoriz, nativeHeader = true, gatePath = null),
)

/** Pending approvals count for the tab badge: business PENDING + agent pending. */
private suspend fun fetchApprovalsCount(): Int {
    var n = 0
    try {
        val r = AlmaApi.getObject("/api/approvals")
        val d = r.optJSONObject("data") ?: r
        n += d.flexInt("totalPending") ?: 0
    } catch (_: Exception) { }
    try {
        val a = AlmaApi.getObject("/api/assistant/actions", mapOf("status" to "pending", "limit" to "50"))
        val d = a.optJSONObject("data") ?: a
        n += (d.optJSONArray("actions") ?: a.optJSONArray("actions"))?.length() ?: 0
    } catch (_: Exception) { }
    return n
}

// ── Root composable ───────────────────────────────────────────────────────────────

@SuppressLint("MutableCollectionMutableState")
private fun agentTitle(path: String): String = when (path) {
    "/agent/creative-studio" -> "Studio"
    "/agent/whatsapp" -> "WhatsApp"
    "/agent/staff-monitor" -> "Monitor"
    "/agent/costs" -> "Costs"
    else -> "Assistant"
}

@Composable
private fun ShellRoot(activity: BridgeActivity, capacitorRoot: View) {
    val dark = AlmaTheme.isDark
    val context = LocalContext.current

    // System bar icon contrast follows the theme.
    val window = activity.window
    WindowInsetsControllerCompat(window, window.decorView).apply {
        isAppearanceLightStatusBars = !dark
        isAppearanceLightNavigationBars = !dark
    }

    var selectedTab = rememberSaveable { mutableIntStateOf(0) }
    // One push stack per tab (iOS: one UINavigationController per tab). Sized to the
    // FULL tab set (indexed by TabSpec.index) so gating a tab in/out never reshuffles.
    val stacks = remember { List(ALL_TABS.size) { mutableStateListOf<StackEntry>() } }

    // Role-gated visible tabs (fail-closed via AlmaSession.effectiveRole). Loaded once
    // at the shell root so the bar is correct before the first paint settles; reading
    // effectiveRole here makes the bar recompose the moment the real role arrives.
    LaunchedEffect(Unit) { AlmaSession.load() }
    val role = AlmaSession.effectiveRole

    // Pending-approvals badge count on the Approvals tab (polled; iOS parity).
    var approvalsCount by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            approvalsCount = fetchApprovalsCount()
            kotlinx.coroutines.delay(60_000L)
        }
    }
    val visibleTabs = remember(role) {
        ALL_TABS.filter { it.gatePath == null || AlmaSession.canSee(it.gatePath) }
    }
    // If the selected tab got gated away (e.g. role loaded after a default select),
    // fall back to Dashboard so we never render a hidden tab's content.
    LaunchedEffect(visibleTabs) {
        if (visibleTabs.none { it.index == selectedTab.intValue }) selectedTab.intValue = 0
    }
    val stack = stacks[selectedTab.intValue]

    fun pushWebForced(path: String, title: String) {
        val wv = buildErpWebView(context, path, hideWebHeader = true)
        NativeShell.registerWebView(wv)
        stack.add(StackEntry.Web(title, wv))
    }

    fun pushSmart(path: String, title: String) {
        val origin = path.substringBefore("?")
        val native = AlmaNativeRouter.screen(origin)
        if (native != null) {
            stack.add(StackEntry.Native(native.title) { ctx -> native.content(ctx) })
        } else {
            pushWebForced(path, title)
        }
    }

    val pushCtx = PushCtx(
        openSmart = { p, t -> pushSmart(p, t) },
        openWebForced = { p, t -> pushWebForced(p, t) },
        pop = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) },
    )

    // Hardware back: pop the active tab's stack first; empty stack falls through to
    // Capacitor's own handling (webview history / task background).
    BackHandler(enabled = stack.isNotEmpty()) {
        stack.removeAt(stack.lastIndex)
    }

    AuroraBackground(dark) {
        // The Capacitor bridge stays MOUNTED (1dp, non-interactive) so its plugins —
        // OneSignal push registration, the shared web login session — keep running
        // behind the native screens. Same reason the iOS Dashboard kept the bridge
        // VC in the hierarchy (DashboardHostController).
        Box(Modifier.size(1.dp)) {
            AndroidView(
                factory = {
                    capacitorRoot.also { v -> (v.parent as? ViewGroup)?.removeView(v) }
                },
                modifier = Modifier.size(1.dp),
            )
        }
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().padding(bottom = 0.dp).weight(1f).dismissKeyboardOnInteraction()) {
                // ── Active tab root ──
                val tabIndex = selectedTab.intValue
                val spec = ALL_TABS[tabIndex]
                if (spec.nativeHeader) {
                    // Content scrolls under a floating title bar and fades into the aura.
                    HeaderFadeScaffold(title = spec.title, dark = dark, onBack = null) {
                        TabContent(tabIndex, pushCtx)
                    }
                } else {
                    // Assistant etc. render their own header — no shell fade.
                    Box(Modifier.fillMaxSize()) { TabContent(tabIndex, pushCtx) }
                }
                // ── Pushed screen (top of stack) covers the tab, keeps its own header ──
                // Paint the AURORA (not a flat near-black) so every sub-page matches the
                // tab roots + iOS — the aurora gradient is opaque so it fully hides the
                // tab content behind it. Web pushes are opaque WebViews anyway.
                stack.lastOrNull()?.let { top ->
                    AuroraBackground(dark) {
                        when (top) {
                            // A WebView renders outside Compose (can't be alpha-masked) — keep
                            // the plain stacked header for web pushes.
                            is StackEntry.Web -> Column(Modifier.fillMaxSize()) {
                                ShellHeader(title = top.title, dark = dark, onBack = pushCtx.pop)
                                Box(Modifier.weight(1f)) {
                                    AndroidView(
                                        factory = { top.webView.also { wv -> (wv.parent as? ViewGroup)?.removeView(wv) } },
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                }
                            }
                            // Native pushed screen — content scrolls under the fading bar.
                            is StackEntry.Native -> HeaderFadeScaffold(title = top.title, dark = dark, onBack = pushCtx.pop) {
                                top.content(pushCtx)
                            }
                        }
                    }
                }

                // ── Floating assistive-touch dock (iOS parity) ──
                // Only at a tab root (no pushed screen) on Dashboard + Assistant.
                if (stack.isEmpty()) {
                    when (tabIndex) {
                        0 -> DashboardAssistiveDock(dark = dark) { p, t -> pushSmart(p, t) }
                        2 -> AgentAssistiveDock(dark = dark, activeIndex = 0) { p ->
                            if (p == "/agent") stacks[2].clear() else pushSmart(p, agentTitle(p))
                        }
                    }
                }
            }
            ShellTabBar(
                tabs = visibleTabs,
                selected = selectedTab.intValue,
                dark = dark,
                approvalsCount = approvalsCount,
                onSelect = { i ->
                    if (i == selectedTab.intValue) {
                        // Re-tap: pop to the tab root (iOS tab-bar behaviour).
                        stacks[i].clear()
                    }
                    selectedTab.intValue = i
                },
            )
        }

        // ── Always-visible office chat head (iOS FloatingChatHead parity) ──
        // Floats over every tab + pushed screen; tap = office group chat, long-press =
        // walkie-talkie intercom. Self-hides when there's no office session.
        com.almatraders.erp.pages.OfficeChatFloatingHead(dark = dark) { p, t -> pushWebForced(p, t) }

        // ── Startup native-login gate ──
        // If the server says we're NOT signed in (authed == false), cover the whole shell
        // with the native Sign-in screen so the app opens straight to native login — no
        // dashboard "session missing" card, no web login. A definite false only: an
        // offline launch (authed == null) still opens the app so a cached session works.
        // On success NativeLoginScreen calls AlmaSession.reload() → authed flips true →
        // this gate disappears and the shell shows with full role-based nav.
        // Hidden while a screen is pushed (Forgot-password / web-login escape) so those
        // are reachable; returns when that screen is popped. Cleared on successful login.
        if (AlmaSession.authed == false && stack.isEmpty()) {
            AuroraBackground(dark) {
                Box(Modifier.fillMaxSize().dismissKeyboardOnInteraction()) {
                    com.almatraders.erp.pages.NativeLoginScreen(pushCtx)
                }
            }
        }

        // ── App-wide offline takeover (iOS ConnectivityBeacon parity) ──
        // TRULY topmost — floats over every tab, pushed screen, the chat head AND the
        // login gate; renders nothing while online. A ConnectivityManager callback
        // drives the lighthouse beacon + auto-retry, dissolving when a real
        // /api/health probe succeeds.
        ConnectivityBeacon(dark = dark)

        // ── Native forced-update gate — MUST remain the final/topmost child ──
        // The web <ForcedUpdateGate> can't reach a native-first owner (WebView is 1dp).
        // This native twin covers login, connectivity, every native screen and the web
        // shell when the installed build is below min_native_android_build. Keeping it
        // last guarantees staff cannot dismiss or navigate around a mandatory release.
        ForcedUpdateGate(dark = dark)
    }
}

/** The active tab's root content. */
@Composable
private fun TabContent(tabIndex: Int, pushCtx: PushCtx) {
    when (tabIndex) {
        0 -> com.almatraders.erp.pages.DashboardScreen(pushCtx)
        1 -> com.almatraders.erp.pages.OrdersScreen(pushCtx)
        2 -> com.almatraders.erp.pages.AssistantScreen(pushCtx)
        3 -> com.almatraders.erp.pages.ApprovalsScreen(pushCtx)
        4 -> com.almatraders.erp.pages.MoreMenuScreen(pushCtx)
    }
}

// ── Chrome pieces ─────────────────────────────────────────────────────────────────

/** Top inset a screen's scroll content should pad by, so at rest nothing sits under the
 *  floating title bar / fade zone; only SCROLLED content passes under it and dissolves. */
val LocalHeaderInset = androidx.compose.runtime.compositionLocalOf { 0.dp }

/** Claude-style header: the title bar FLOATS over the content, and the content's own top
 *  edge alpha-fades to transparent (revealing the aura behind) as it scrolls up under the
 *  bar. No blur, no opaque overlay layer — the content itself is masked; the title sits
 *  above it. A screen pads its scroll top by [LocalHeaderInset] so it's clean at rest. */
@Composable
fun HeaderFadeScaffold(
    title: String,
    dark: Boolean,
    onBack: (() -> Unit)?,
    content: @Composable () -> Unit,
) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val statusTop = androidx.compose.foundation.layout.WindowInsets.statusBars
        .asPaddingValues().calculateTopPadding()
    val barHeight = 52.dp
    val fadeTail = 30.dp
    val inset = statusTop + barHeight + fadeTail
    val statusTopPx = with(density) { statusTop.toPx() }
    val fadeEndPx = with(density) { inset.toPx() }

    Box(Modifier.fillMaxSize()) {
        // Content scrolls under the bar; its top edge fades out (reveals the aura).
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer(compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen)
                .drawWithContent {
                    drawContent()
                    drawRect(
                        brush = Brush.verticalGradient(
                            0f to Color.Transparent,
                            1f to Color.Black,
                            startY = statusTopPx,
                            endY = fadeEndPx,
                        ),
                        blendMode = androidx.compose.ui.graphics.BlendMode.DstIn,
                    )
                },
        ) {
            androidx.compose.runtime.CompositionLocalProvider(LocalHeaderInset provides inset) {
                content()
            }
        }
        // Floating title bar over the aura, above the faded content.
        Box(Modifier.fillMaxWidth().statusBarsPadding().height(barHeight)) {
            if (onBack != null) {
                IconButton(onClick = onBack, modifier = Modifier.align(Alignment.CenterStart)) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = AlmaTheme.ink(dark),
                    )
                }
            }
            Text(
                title,
                modifier = Modifier.align(Alignment.Center),
                color = AlmaTheme.ink(dark),
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** Alpha-fade the TOP edge of a composable's content to transparent (revealing whatever is
 *  behind it) — the Claude scroll-fade primitive. Use on a scroll container whose own header
 *  is stacked (not the shell header), e.g. the Assistant chat. Pad the scroll's top by the
 *  same [fadeEnd] so nothing is faded at rest. */
fun Modifier.topFadeEdge(fadeEnd: Dp, fadeStart: Dp = 0.dp): Modifier = this
    .graphicsLayer(compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        drawRect(
            brush = Brush.verticalGradient(
                0f to Color.Transparent,
                1f to Color.Black,
                startY = fadeStart.toPx(),
                endY = fadeEnd.toPx(),
            ),
            blendMode = androidx.compose.ui.graphics.BlendMode.DstIn,
        )
    }

/** Slim centered-title header over the aurora (the iOS glass nav bar's Android twin).
 *  The header's OWN background is a soft vertical fade — the page colour holds under the
 *  status-bar + title, then dissolves to transparent at the header's bottom edge, so the
 *  bar melts into the content below (no separate overlay layer, no blur). */
@Composable
fun ShellHeader(title: String, dark: Boolean, onBack: (() -> Unit)?) {
    val bg = AlmaTheme.rootBg(dark)
    Box(
        Modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    0.00f to bg.copy(alpha = 0.86f),
                    0.62f to bg.copy(alpha = 0.72f),
                    1.00f to Color.Transparent,
                ),
            ),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .height(58.dp),
        ) {
            if (onBack != null) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.align(Alignment.CenterStart).padding(bottom = 8.dp),
                ) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = AlmaTheme.ink(dark),
                    )
                }
            }
            Text(
                title,
                modifier = Modifier.align(Alignment.Center).padding(bottom = 8.dp),
                color = AlmaTheme.ink(dark),
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** Transparent tab bar: violet selected / muted unselected (AlmaTheme.tabBarAppearance
 *  twin). Renders only the role-visible tabs; each keys off its stable TabSpec.index. */
@Composable
private fun ShellTabBar(tabs: List<TabSpec>, selected: Int, dark: Boolean, approvalsCount: Int, onSelect: (Int) -> Unit) {
    val mutedTint = if (dark) Color.White.copy(alpha = 0.45f) else Color.Black.copy(alpha = 0.42f)
    Row(
        Modifier
            .fillMaxWidth()
            .background(AlmaTheme.rootBg(dark).copy(alpha = 0.88f))
            .navigationBarsPadding()
            .height(56.dp),
    ) {
        tabs.forEach { tab ->
            TabItem(
                tab = tab,
                active = tab.index == selected,
                activeTint = AlmaTheme.violet,
                mutedTint = mutedTint,
                badge = if (tab.index == 3) approvalsCount else 0,
                onClick = { onSelect(tab.index) },
            )
        }
    }
}

@Composable
private fun RowScope.TabItem(
    tab: TabSpec,
    active: Boolean,
    activeTint: Color,
    mutedTint: Color,
    badge: Int = 0,
    onClick: () -> Unit,
) {
    val tint = if (active) activeTint else mutedTint
    Column(
        Modifier
            .weight(1f)
            .fillMaxSize()
            .plainClick(onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box {
                    Icon(tab.icon, contentDescription = tab.title, tint = tint, modifier = Modifier.size(24.dp))
                    if (badge > 0) {
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .offset(x = 9.dp, y = (-5).dp)
                                .background(AlmaTheme.coral, androidx.compose.foundation.shape.CircleShape)
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        ) {
                            Text(
                                if (badge > 99) "99+" else badge.toString(),
                                color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }
                Text(tab.title, color = tint, fontSize = 10.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}
