//
//  NativeShell.kt
//  ALMA ERP — the Android native shell: Compose bottom tab bar + native screens
//  wrapping the existing Capacitor app, mirroring the iOS AlmaTabBarController +
//  SwiftUIShell architecture 1:1:
//
//    • 5 tabs: Dashboard (Capacitor WebView, kept mounted — push/OneSignal/login
//      live there), Orders (native), Assistant (web), Approvals (native), More (native).
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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

        val composeView = ComposeView(activity).apply {
            setContent { ShellRoot(activity, capacitorRoot) }
        }
        activity.setContentView(composeView)
    }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────────

private class TabSpec(
    val title: String,
    val icon: ImageVector,
    val nativeHeader: Boolean,
)

private val TABS = listOf(
    TabSpec("Dashboard", Icons.Outlined.GridView, nativeHeader = true),
    TabSpec("Orders", Icons.Outlined.Inventory2, nativeHeader = true),
    TabSpec("Assistant", Icons.Outlined.AutoAwesome, nativeHeader = false),
    TabSpec("Approvals", Icons.Outlined.Verified, nativeHeader = true),
    TabSpec("More", Icons.Outlined.MoreHoriz, nativeHeader = true),
)

// ── Root composable ───────────────────────────────────────────────────────────────

@SuppressLint("MutableCollectionMutableState")
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
    // One push stack per tab (iOS: one UINavigationController per tab).
    val stacks = remember { List(TABS.size) { mutableStateListOf<StackEntry>() } }
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
            Box(Modifier.fillMaxSize().padding(bottom = 0.dp).weight(1f)) {
                // ── Active tab root ──
                val tabIndex = selectedTab.intValue
                val spec = TABS[tabIndex]
                Column(Modifier.fillMaxSize()) {
                    if (spec.nativeHeader && stack.isEmpty()) {
                        ShellHeader(title = spec.title, dark = dark, onBack = null)
                    }
                    Box(Modifier.weight(1f)) {
                        TabContent(tabIndex, pushCtx)
                    }
                }
                // ── Pushed screen (top of stack) covers the tab, keeps its own header ──
                stack.lastOrNull()?.let { top ->
                    Column(
                        Modifier
                            .fillMaxSize()
                            .background(AlmaTheme.rootBg(dark)),
                    ) {
                        ShellHeader(title = top.title, dark = dark, onBack = pushCtx.pop)
                        Box(Modifier.weight(1f)) {
                            when (top) {
                                is StackEntry.Web -> AndroidView(
                                    factory = { top.webView.also { wv -> (wv.parent as? ViewGroup)?.removeView(wv) } },
                                    modifier = Modifier.fillMaxSize(),
                                )
                                is StackEntry.Native -> top.content(pushCtx)
                            }
                        }
                    }
                }
            }
            ShellTabBar(
                selected = selectedTab.intValue,
                dark = dark,
                onSelect = { i ->
                    if (i == selectedTab.intValue) {
                        // Re-tap: pop to the tab root (iOS tab-bar behaviour).
                        stacks[i].clear()
                    }
                    selectedTab.intValue = i
                },
            )
        }
    }
}

/** The active tab's root content. */
@Composable
private fun TabContent(tabIndex: Int, pushCtx: PushCtx) {
    when (tabIndex) {
        0 -> com.almatraders.erp.pages.DashboardScreen(pushCtx)
        1 -> com.almatraders.erp.pages.OrdersScreen(pushCtx)
        2 -> WebTabScreen(
            path = "/agent", hideWebHeader = false,
            register = NativeShell::registerWebView,
        )
        3 -> com.almatraders.erp.pages.ApprovalsScreen(pushCtx)
        4 -> com.almatraders.erp.pages.MoreMenuScreen(pushCtx)
    }
}

// ── Chrome pieces ─────────────────────────────────────────────────────────────────

/** Slim centered-title header over the aurora (the iOS glass nav bar's Android twin —
 *  transparent, crisp title, optional back chevron). */
@Composable
fun ShellHeader(title: String, dark: Boolean, onBack: (() -> Unit)?) {
    Box(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(48.dp),
    ) {
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

/** Transparent tab bar: violet selected / muted unselected (AlmaTheme.tabBarAppearance twin). */
@Composable
private fun ShellTabBar(selected: Int, dark: Boolean, onSelect: (Int) -> Unit) {
    val mutedTint = if (dark) Color.White.copy(alpha = 0.45f) else Color.Black.copy(alpha = 0.42f)
    Row(
        Modifier
            .fillMaxWidth()
            .background(AlmaTheme.rootBg(dark).copy(alpha = 0.88f))
            .navigationBarsPadding()
            .height(56.dp),
    ) {
        TABS.forEachIndexed { i, tab ->
            TabItem(
                tab = tab,
                active = i == selected,
                activeTint = AlmaTheme.violet,
                mutedTint = mutedTint,
                onClick = { onSelect(i) },
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
                Icon(tab.icon, contentDescription = tab.title, tint = tint, modifier = Modifier.size(24.dp))
                Text(tab.title, color = tint, fontSize = 10.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}
