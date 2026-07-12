//
//  SpikeNativeShell.swift
//  App
//
//  PHASE S1 — the real native app frame (graduated from the S0 spike).
//
//  A native UITabBarController is the app root. Unlike S0, the Capacitor bridge is
//  KEPT ALIVE as tab 0, so every native feature from N1–N5 keeps working:
//    • Tab 0 "Dashboard" = the storyboard's AlmaBridgeViewController (Capacitor).
//      Because `isCapacitorNative()` is true there, the web app's managers run —
//      OneSignal push, Live Pulse, local reminders, on-device plugins — exactly as
//      before. Widgets / Background refresh / Siri are native (AppDelegate) and are
//      untouched.
//    • Tabs 1–4 "Orders / Assistant / Approvals / More" = plain WKWebViews that
//      SHARE the login (default WKWebsiteDataStore cookies) but are not Capacitor,
//      so the native managers no-op there (they self-gate on isCapacitorNative) and
//      do no duplicate work. They are pure content views.
//
//  Each tab hides the web's own bottom nav (`.mobile-app-chrome`) via a small CSS
//  user-script, so ONLY the native tab bar shows — no double navigation. This is
//  done natively, so no ERP web deploy and zero production change (the formal
//  `?native=1` embed mode lands in S2 when native title-sync needs it).
//
//  Root is installed by AppDelegate, which reparents the storyboard's Capacitor VC
//  into tab 0. Revert = delete that block; the storyboard root returns unchanged.
//

import UIKit
import WebKit

extension Notification.Name {
    /// Broadcast when the owner flips light/dark so every tab's chrome + web content updates.
    static let almaThemeChanged = Notification.Name("almaThemeChanged")
}

/// Single source of truth for the app-wide light/dark mode in the native shell. Mirrors the
/// web's `alma-theme` cookie (light|dark) so the NATIVE chrome (tab bar, every nav bar,
/// roots, loaders) and the WEB content stay in lockstep — the owner's "everything the same
/// in both modes". Default light (the web's default); the real value is read from the cookie
/// at launch and can be flipped from the More tab's Dark-mode switch.
enum AlmaTheme {
    static let cookieName = "alma-theme"
    static let host = "alma-erp-six.vercel.app"
    static let defaultsKey = "alma-theme-mode"
    static private(set) var isDark = false

    /// Synchronous launch read (from UserDefaults, the native mirror) so the shell is built
    /// in the right mode with no light→dark flash. Call before building the tab bar.
    static func loadInitial() { isDark = (UserDefaults.standard.string(forKey: defaultsKey) == "dark") }

    // ── Palette (light ⇄ dark) ─────────────────────────────────────────────
    static let coral = UIColor(red: 0.878, green: 0.478, blue: 0.373, alpha: 1) // #E07A5F accent
    static let violet = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1) // #a78bfa
    static var rootBg: UIColor {
        isDark ? UIColor(red: 0.043, green: 0.039, blue: 0.070, alpha: 1)   // #0b0a12
               : UIColor(red: 0.949, green: 0.941, blue: 0.972, alpha: 1)   // #F2F0F8
    }
    static var navTitle: UIColor {
        isDark ? UIColor(white: 0.97, alpha: 1) : UIColor(red: 0.13, green: 0.11, blue: 0.16, alpha: 1)
    }
    static var tabBarBg: UIColor {
        isDark ? UIColor(red: 0.055, green: 0.047, blue: 0.078, alpha: 1)   // #0e0c14
               : UIColor(red: 0.976, green: 0.972, blue: 0.988, alpha: 1)   // near-white
    }
    static var interfaceStyle: UIUserInterfaceStyle { isDark ? .dark : .light }

    /// The Claude-style frosted nav-bar appearance for the current mode (clean system
    /// material, no violet slab — content blurs THROUGH it in both light and dark).
    static func navAppearance() -> UINavigationBarAppearance {
        let a = UINavigationBarAppearance()
        // PURE GLASSMORPHISM (owner spec 2026-07-05): the bar itself paints NOTHING —
        // no material, no background colour, no shadow line, no gradient. The frosted
        // blur comes from an AlmaGlassHeader strip each screen pins under its bar zone:
        // a UIVisualEffectView with the material's TINT layers stripped, leaving only
        // the gaussian backdrop blur. Every stock UIKit material tints (dark band in
        // dark mode, grey slab in light — sim-verified again 2026-07-05 with
        // .systemUltraThinMaterial), so a bar-painted material can never satisfy
        // "blurred + glossy in the app's own colours, zero dark tint".
        a.configureWithTransparentBackground()
        a.shadowColor = .clear
        // Claude-style: strong dark (light mode) / white (dark mode) semibold title.
        a.titleTextAttributes = [.foregroundColor: navTitle,
                                 .font: UIFont.systemFont(ofSize: 17, weight: .semibold)]
        a.largeTitleTextAttributes = [.foregroundColor: navTitle]
        return a
    }

    /// Apply the current mode's frosted appearance to a nav controller.
    static func applyNav(_ nav: UINavigationController) {
        nav.overrideUserInterfaceStyle = interfaceStyle
        let a = navAppearance()
        nav.navigationBar.standardAppearance = a
        nav.navigationBar.scrollEdgeAppearance = a
        nav.navigationBar.tintColor = navTitle
        // NO drop shadow — the bar must melt into the page as ONE layer (owner: the
        // shadow made the header read as a separate slab floating over the background).
        nav.navigationBar.layer.shadowOpacity = 0
        installGlassHeader(nav)
    }

    /// Pin the pure-blur glass strip under this nav's bar zone (status bar + nav bar),
    /// BELOW the navigationBar so the title/buttons stay crisp above the frost. One
    /// central hook — every tab and every pushed screen gets the identical header glass.
    /// Bottom tracks the bar's real bottom edge, so large-title expansion/collapse and
    /// rotation resize it automatically. Idempotent (tag guard) — applyNav re-runs on
    /// every theme flip.
    static func installGlassHeader(_ nav: UINavigationController) {
        guard nav.view.viewWithTag(AlmaGlassHeaderView.viewTag) == nil else { return }
        let glass = AlmaGlassHeaderView()
        glass.translatesAutoresizingMaskIntoConstraints = false
        nav.view.insertSubview(glass, belowSubview: nav.navigationBar)
        NSLayoutConstraint.activate([
            glass.topAnchor.constraint(equalTo: nav.view.topAnchor),
            glass.leadingAnchor.constraint(equalTo: nav.view.leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: nav.view.trailingAnchor),
            glass.bottomAnchor.constraint(equalTo: nav.navigationBar.bottomAnchor),
        ])
    }

    static func tabBarAppearance() -> UITabBarAppearance {
        let ap = UITabBarAppearance()
        // FULLY transparent, same reasoning as the nav bars: every UIKit material tints
        // (a visible band over the aurora), so the tab bar paints nothing — the web
        // renders a tint-free backdrop-blur strip in the tab-bar zone instead.
        ap.configureWithTransparentBackground()
        ap.shadowColor = .clear
        let sel = violet
        let muted = isDark ? UIColor(white: 1, alpha: 0.45) : UIColor(white: 0, alpha: 0.42)
        for item in [ap.stackedLayoutAppearance, ap.inlineLayoutAppearance, ap.compactInlineLayoutAppearance] {
            item.selected.iconColor = sel
            item.selected.titleTextAttributes = [.foregroundColor: sel]
            item.normal.iconColor = muted
            item.normal.titleTextAttributes = [.foregroundColor: muted]
        }
        return ap
    }

    /// Read the persisted mode from the shared cookie store, then run `done` on the main queue.
    static func loadFromCookies(_ done: @escaping () -> Void) {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            if let v = cookies.first(where: { $0.name == cookieName })?.value { isDark = (v == "dark") }
            DispatchQueue.main.async { done() }
        }
    }

    /// Set the mode, persist (cookie for the web + UserDefaults for the native launch read),
    /// and broadcast so all chrome + webviews restyle live.
    static func set(dark: Bool) {
        guard dark != isDark else { return }
        isDark = dark
        UserDefaults.standard.set(dark ? "dark" : "light", forKey: defaultsKey)
        persistCookie()
        NotificationCenter.default.post(name: .almaThemeChanged, object: nil)
    }
    static func toggle() { set(dark: !isDark) }

    static func persistCookie() {
        let props: [HTTPCookiePropertyKey: Any] = [
            .name: cookieName, .value: isDark ? "dark" : "light",
            .domain: host, .path: "/",
            .expires: Date(timeIntervalSinceNow: 60 * 60 * 24 * 365),
        ]
        if let c = HTTPCookie(properties: props) {
            WKWebsiteDataStore.default().httpCookieStore.setCookie(c)
        }
    }

    /// JS that forces the web content to the current mode instantly (data-theme + cookie),
    /// so a live toggle updates a WebView without waiting for a reload.
    static func applyJS() -> String {
        let mode = isDark ? "dark" : "light"
        return """
        (function(){try{document.documentElement.dataset.theme='\(mode)';
        document.cookie='alma-theme=\(mode); path=/; max-age=31536000; SameSite=Lax';}catch(e){}})();
        """
    }
}

/// PURE frosted glass for the header zone (owner spec 2026-07-05): a UIVisualEffectView
/// whose material TINT sublayers are stripped, leaving ONLY the gaussian backdrop blur.
/// Every stock UIKit material paints a tint over the content (dark band in dark mode,
/// grey wash in light — both rejected); the blur itself lives in the backdrop sublayer,
/// so hiding the non-backdrop sublayers yields true glassmorphism: scrolled content
/// reads blurred + glossy in the app's own colours, zero added tint, no gradients, no
/// shadows. Introspection is by class-name substring only (no private API calls); if a
/// future iOS renames the sublayers the view degrades to a stock blur — never breaks.
final class AlmaGlassHeaderView: UIVisualEffectView {
    static let viewTag = 987_431

    /// VARIABLE-blur mask: full blur at the top edge → gone at the bottom, so the
    /// header reads as the Claude scroll-edge DISSOLVE, not a uniform frosted slab
    /// (owner 2026-07-06: the old uniform strip's hard bottom edge read as a "band").
    private let blurMask = CAGradientLayer()
    /// Colour dissolve into the page background, masked by the same ramp so it fades
    /// out alongside the blur. Colour tracks the app's light/dark theme.
    private let scrim = CAGradientLayer()

    init() {
        super.init(effect: UIBlurEffect(style: .regular))
        tag = Self.viewTag
        isUserInteractionEnabled = false

        blurMask.colors = [UIColor.black.cgColor,
                           UIColor.black.withAlphaComponent(0.55).cgColor,
                           UIColor.clear.cgColor]
        blurMask.locations = [0.0, 0.55, 1.0]
        blurMask.startPoint = CGPoint(x: 0.5, y: 0)
        blurMask.endPoint = CGPoint(x: 0.5, y: 1)
        layer.mask = blurMask

        scrim.startPoint = CGPoint(x: 0.5, y: 0)
        scrim.endPoint = CGPoint(x: 0.5, y: 1)
        contentView.layer.addSublayer(scrim)
        applyScrimColours()

        stripTint()
        NotificationCenter.default.addObserver(self, selector: #selector(applyScrimColours),
                                               name: .almaThemeChanged, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // The effect view rebuilds its sublayers on window / layout changes — re-strip.
    override func didMoveToWindow() { super.didMoveToWindow(); stripTint() }
    override func layoutSubviews() {
        super.layoutSubviews()
        stripTint()
        // Mask + scrim layers don't autoresize — track bounds without implicit animation.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blurMask.frame = bounds
        scrim.frame = bounds
        CATransaction.commit()
    }

    /// Scrim colour = the page background top (dark aura indigo #1C1830 / light cream
    /// #FAF9F6, same tokens as ClaudeTopFadeTheme), strong at the top → transparent, so
    /// scrolled content melts into the page colour instead of showing a tinted band.
    @objc private func applyScrimColours() {
        let c = AlmaTheme.isDark
            ? UIColor(red: 0.110, green: 0.094, blue: 0.188, alpha: 1)   // #1C1830
            : UIColor(red: 0.980, green: 0.976, blue: 0.965, alpha: 1)   // #FAF9F6
        scrim.colors = [c.withAlphaComponent(0.55).cgColor,
                        c.withAlphaComponent(0.22).cgColor,
                        c.withAlphaComponent(0.0).cgColor]
        scrim.locations = [0.0, 0.55, 1.0]
    }

    private func stripTint() {
        for sub in subviews where sub !== contentView {
            let cls = String(describing: type(of: sub))
            if !cls.contains("Backdrop") {
                sub.isHidden = true
                sub.backgroundColor = .clear
            }
        }
    }
}

/// Scripts shared by every tab (and the Capacitor web view).
enum AlmaEmbed {
    /// Runs at document START, before the web app's JS: sets the flag the ERP's
    /// native embed mode (Lane 2) reads to hide its own chrome and report navigation.
    /// Until that web code deploys this flag is simply ignored — safe either way.
    static func flagScript() -> WKUserScript {
        let js = "window.__almaNative = true;"
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    /// Belt-and-suspenders CSS at document END: hide the web's own bottom nav so the
    /// native tab bar is the only chrome, even on builds where the web embed mode
    /// isn't live yet. Idempotent.
    static func hideChromeScript() -> WKUserScript {
        let js = """
        (function(){var id='__alma_native_embed';
        if(document.getElementById(id))return;
        var s=document.createElement('style');s.id=id;
        s.textContent='.mobile-app-chrome{display:none !important}';
        (document.head||document.documentElement).appendChild(s);})();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
    }

    /// Sets `window.__almaNativeHeader = true` so the ERP hides its OWN page header
    /// (a native header replaces it) — only for tabs/screens that get one.
    static func headerFlagScript() -> WKUserScript {
        WKUserScript(source: "window.__almaNativeHeader = true;",
                     injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    /// Add the scripts to a content controller. `hideWebHeader` additionally tells
    /// the web to drop its own page header where a native header is shown.
    static func install(into content: WKUserContentController, hideWebHeader: Bool = false) {
        content.addUserScript(flagScript())
        if hideWebHeader { content.addUserScript(headerFlagScript()) }
        content.addUserScript(hideChromeScript())
    }
}

/// Breaks the retain cycle WKUserContentController → messageHandler → webView by
/// pointing back at the real handler only weakly.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(ucc, didReceive: message)
    }
}

/// One content tab = a full-screen web view onto an ERP route, sharing the session
/// and hiding the web's own bottom nav. When hosted in a UINavigationController it
/// shows a NATIVE header whose title tracks the web app's current route (via the
/// `almaShell` bridge), with a back button that drives web history.
final class AlmaWebTabViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private let url: URL
    private let sharedProcessPool: WKProcessPool
    private var webView: WKWebView!
    private var loader: AlmaPremiumLoader!   // premium branded first-paint / transition loader
    private let baseTitle: String
    /// When true the web hides its OWN page header (this VC shows a native one), so
    /// there is no double header. Off for Assistant (keeps its in-page header).
    private let hideWebHeader: Bool

    /// When non-empty, a NATIVE segmented control is shown at the top of this tab and
    /// the web's own agent sub-nav (the "double bottom bar") is hidden — this is the
    /// Assistant tab's Chat/Studio/WhatsApp/Monitor/Costs switcher, made native.
    private let agentSegments: [(title: String, url: URL)]
    private var assistiveNav: AgentAssistiveNav?

    init(url: URL, processPool: WKProcessPool, tabTitle: String, systemImage: String,
         hideWebHeader: Bool = false, agentSegments: [(title: String, url: URL)] = []) {
        self.url = url
        self.sharedProcessPool = processPool
        self.baseTitle = tabTitle
        self.hideWebHeader = hideWebHeader
        self.agentSegments = agentSegments
        super.init(nibName: nil, bundle: nil)
        title = tabTitle   // shown in the nav bar when this VC is pushed (e.g. from More)
        tabBarItem = UITabBarItem(
            title: tabTitle,
            image: UIImage(systemName: systemImage),
            selectedImage: UIImage(systemName: systemImage + ".fill") ?? UIImage(systemName: systemImage)
        )
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func loadView() {
        let content = WKUserContentController()
        AlmaEmbed.install(into: content, hideWebHeader: hideWebHeader)
        // When this tab has a native segmented control, tell the web to hide its own
        // agent sub-nav (the web bar that stacked above the native tab bar).
        if !agentSegments.isEmpty {
            content.addUserScript(WKUserScript(
                // Hide the web agent sub-nav (replaced by the AssistiveTouch nav) AND
                // tell the agent's keyboard hook to defer to the native --kb-inset
                // injection below (its own visualViewport path can't see the keyboard
                // in this stable-height WKWebView, so the composer stayed covered).
                source: "window.__almaAgentNative = true; window.__almaKbNative = true;",
                injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        // Native header title-sync: the web posts {type:'route', path, title} here.
        content.add(WeakScriptMessageHandler(self), name: "almaShell")
        // Soft native haptics for the plain (non-Capacitor) WebViews: the web posts
        // {kind:'selection'|'impact'|'notify', style?} and native fires a real
        // UIFeedbackGenerator. Unlike the iOS-web switch-tick shim this doesn't steal
        // focus, so the keyboard-typing tick works without dismissing the keyboard.
        content.add(WeakScriptMessageHandler(self), name: "almaHaptic")
        // Native long-press context menu: the web posts {title, subtitle?, items:[{key,
        // label, role?}]} and native shows a real UIKit action sheet; the picked key is
        // sent back via window.__almaCtxPick(key). Gives order cards etc. a native menu.
        content.add(WeakScriptMessageHandler(self), name: "almaContextMenu")

        let config = WKWebViewConfiguration()
        config.processPool = sharedProcessPool
        config.websiteDataStore = .default()   // shared cookies -> shared login with Capacitor tab
        config.userContentController = content
        config.allowsInlineMediaPlayback = true
        // Voice: the agent's TTS reply must AUTOPLAY right after a response (no tap),
        // and the mic/orb audio graph must run inline — clear the default gesture gate.
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self   // media-capture (mic) permission handling below
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        // S3 first-paint: the ERP pages are LIGHT, so paint the placeholder LIGHT (was a
        // dark slab that flashed dark→light on every first load). Matched to the ERP's
        // pale lavender so the content fades in without a flash. (The dark native header
        // sits above this in its own bar.)
        let bg = AlmaTheme.rootBg   // placeholder tracks the current light/dark mode
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
        webView.alpha = 0 // S3: fade the content in on first paint (see didFinish) — no pop-in.
        // Pull-to-refresh is now the web robot mascot (MobilePullToRefresh) — no native
        // UIRefreshControl (it would double up and can't show the robot). Web owns it.

        let root = UIView()
        // Root tracks the app-wide light/dark mode so nothing flashes the wrong shade behind
        // the frosted bar / at the edges. Restyled live on theme change (see applyTheme).
        root.backgroundColor = bg
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false

        // GLASS MOTION (every tab): the web view is pinned FULL-BLEED to the root —
        // y=0 UNDER the translucent nav bar and all the way down UNDER the frosted
        // tab bar — so page content scrolls THROUGH both bars, blurred (the Claude-app
        // feel). The web reserves the covered zones itself via the natively-injected
        // `--alma-top-inset` / `--alma-bottom-inset` CSS vars (see setWebInsetVars);
        // env(safe-area-inset-*) is NOT reliable here because the scroll view runs
        // `contentInsetAdjustmentBehavior = .never`.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            // FULL height to the root bottom (under the glass tab bar). We deliberately
            // do NOT pin to keyboardLayoutGuide: resizing a WKWebView the instant its
            // input becomes first responder made iOS resign that input — the keyboard
            // dismissed on the very first keystroke and text was dropped (owner report,
            // reproduced on Orders search too). Instead the view stays a stable size and
            // the keyboard OVERLAPS it; we lift the focused field above the keyboard
            // with a scroll-view bottom inset (see keyboard observers), the standard
            // WKWebView pattern that keeps text input alive.
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        startObservingKeyboard()

        // Premium branded loader covering the whole tab during first-paint / navigation.
        // Light wash for the ERP web views (no dark→light flash), deep violet for the
        // dark Assistant. It sits ABOVE the web view and fades out when content is ready.
        loader = AlmaPremiumLoader(style: AlmaTheme.isDark ? .dark : .light)
        loader.translatesAutoresizingMaskIntoConstraints = false
        loader.isHidden = true
        root.addSubview(loader)
        NSLayoutConstraint.activate([
            loader.topAnchor.constraint(equalTo: root.topAnchor),
            loader.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            loader.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            loader.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])

        // Assistant tab: an iOS-AssistiveTouch-style FLOATING nav for the agent sections
        // — no bar at all, just a draggable translucent button that springs open into a
        // blur panel of Chat/Studio/WhatsApp/Monitor/Costs. Replaces the web sub-nav.
        if !agentSegments.isEmpty {
            let nav = AgentAssistiveNav(items: agentSegments.map { seg in
                AgentAssistiveNav.Item(title: seg.title, icon: Self.agentIcon(seg.title)) { [weak self] in
                    self?.webView.load(URLRequest(url: seg.url))
                }
            })
            root.addSubview(nav)
            nav.attach(to: root, tabBarHeight: 49)
            assistiveNav = nav
        }
        view = root
    }

    /// SF Symbol for each agent section.
    private static func agentIcon(_ title: String) -> String {
        switch title {
        case "Chat": return "bubble.left.and.text.bubble.right"
        case "Studio": return "wand.and.stars"
        case "WhatsApp": return "message.fill"
        case "Monitor": return "chart.bar.xaxis"
        case "Costs": return "dollarsign.circle"
        default: return "sparkles"
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Restyle this tab's chrome whenever the owner flips light/dark.
        NotificationCenter.default.addObserver(self, selector: #selector(onThemeChanged),
                                               name: .almaThemeChanged, object: nil)
        guard !agentSegments.isEmpty else { return }
        navigationItem.title = "ALMA AI"
        applyAgentBar()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Re-assert theme + insets every time the tab comes forward: iOS can suspend a
        // BACKGROUND WebView, silently dropping the evaluateJavaScript pushed on a theme
        // flip — the tab then reappears in the OLD theme (seen: agent stayed dark after
        // a More-tab light switch). Idempotent, so the common case is a no-op.
        webView?.evaluateJavaScript(AlmaTheme.applyJS(), completionHandler: nil)
        setWebInsetVars()
        // Build-67 safety net: a web view PUSHED above a native full-takeover screen
        // (those hide the UIKit nav bar) must always get the bar back — without it
        // there is no back chevron and the only escape is killing the app
        // (owner report: Creative Studio dropped him into the web with no way out).
        if let nav = navigationController, nav.viewControllers.first !== self, nav.isNavigationBarHidden {
            nav.setNavigationBarHidden(false, animated: animated)
        }
    }

    /// Agent = the Claude surface: fixed "ALMA AI" title + Claude-exact bar buttons — LEFT a
    /// frosted hamburger (opens the sidebar), RIGHT a SOLID CORAL compose bubble (new chat).
    /// The hamburger's frosted body flips with the mode (frosted-white in light, frosted-dark
    /// in dark); the coral stays the accent in both.
    private func applyAgentBar() {
        guard !agentSegments.isEmpty else { return }
        navigationItem.leftBarButtonItem = Self.glassBarButton(
            icon: "line.3.horizontal", target: self, action: #selector(agentHistory), light: !AlmaTheme.isDark)
        navigationItem.rightBarButtonItem = Self.coralBarButton(
            icon: "square.and.pencil", target: self, action: #selector(agentNewChat))
    }

    /// Light ⇄ dark: restyle the root + loader + agent buttons, and push the mode into the
    /// web content so it flips instantly (no reload). The nav bar material/title are handled
    /// centrally by AlmaTabBarController.applyTheme.
    @objc private func onThemeChanged() {
        view.backgroundColor = AlmaTheme.rootBg
        webView?.backgroundColor = AlmaTheme.rootBg
        webView?.scrollView.backgroundColor = AlmaTheme.rootBg
        webView?.evaluateJavaScript(AlmaTheme.applyJS(), completionHandler: nil)
        applyAgentBar()
        updateBackButton()
    }

    /// A Claude-style frosted circular bar button. `light: true` = ultra-thin WHITE material
    /// + dark icon (the LIGHT agent header); `light: false` = thin DARK material + white icon
    /// (the dark ERP tabs' back chevron). Hairline ring + soft shadow either way.
    static func glassBarButton(icon: String, target: Any, action: Selector, light: Bool = false) -> UIBarButtonItem {
        let size: CGFloat = 36
        let iconColor = light ? UIColor(red: 0.16, green: 0.14, blue: 0.20, alpha: 1) : UIColor.white
        let container = UIButton(type: .custom)
        // Fixed 36×36 via constraints — a bare frame gets squished by the nav bar into a
        // lens shape, so pin the size and the icon color is BAKED (.alwaysOriginal) so the
        // dark hamburger reads clearly over the frosted-white body (tintColor washed out).
        // FULL Auto Layout — a frame-set blur inside a constraint-sized (0×0-at-init)
        // container broke autoresizing and dropped the glyph to the bottom edge. Pin the
        // blur to the container's edges and the icon to the blur's centre, so the disc is a
        // true circle and the hamburger sits dead-centre. Icon colour is BAKED
        // (.alwaysOriginal) so the dark glyph reads over the frosted-white body.
        container.translatesAutoresizingMaskIntoConstraints = false
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: light ? .systemThinMaterialLight : .systemThinMaterialDark))
        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.layer.cornerRadius = size / 2
        blur.clipsToBounds = true
        blur.isUserInteractionEnabled = false
        blur.contentView.backgroundColor = light
            ? UIColor(white: 1, alpha: 0.34)   // frosted-white body
            : UIColor(white: 0, alpha: 0.14)   // deepen so it reads dark over light content
        container.addSubview(blur)
        let iconView = UIImageView(image: UIImage(systemName: icon,
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .bold))?
            .withTintColor(iconColor, renderingMode: .alwaysOriginal))
        iconView.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(iconView)
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalToConstant: size),
            container.heightAnchor.constraint(equalToConstant: size),
            blur.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            blur.topAnchor.constraint(equalTo: container.topAnchor),
            blur.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            iconView.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
        ])
        container.layer.cornerRadius = size / 2
        container.layer.borderWidth = 1
        // Hairline only — Claude's discs have no visible ring (a bright ring read as a
        // white halo around the dark hamburger in dark mode, owner comparison 2026-07-05).
        container.layer.borderColor = (light ? UIColor(white: 0, alpha: 0.08) : UIColor(white: 1, alpha: 0.10)).cgColor
        // NO drop shadow (owner spec: zero black shadows anywhere in the header —
        // the frosted disc + hairline ring alone carry the depth).
        container.layer.shadowOpacity = 0
        container.addTarget(target, action: action, for: .touchUpInside)
        return UIBarButtonItem(customView: container)
    }

    /// Claude-style SOLID CORAL circular action button (baked white icon) — the new-chat
    /// button, exactly like Claude's orange compose bubble on the top-right of the header.
    static func coralBarButton(icon: String, target: Any, action: Selector) -> UIBarButtonItem {
        let size: CGFloat = 36
        let coral = UIColor(red: 0.878, green: 0.478, blue: 0.373, alpha: 1) // #E07A5F (ALMA accent)
        let container = UIButton(type: .custom)
        container.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalToConstant: size),
            container.heightAnchor.constraint(equalToConstant: size),
        ])
        container.backgroundColor = coral
        let img = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))?
            .withTintColor(.white, renderingMode: .alwaysOriginal)
        container.setImage(img, for: .normal)
        container.layer.cornerRadius = size / 2
        container.layer.masksToBounds = false
        // Flat — no shadow at all in the header zone (owner spec 2026-07-05).
        container.layer.shadowOpacity = 0
        container.addTarget(target, action: action, for: .touchUpInside)
        return UIBarButtonItem(customView: container)
    }

    @objc private func agentHistory() {
        Self.selectionGen.selectionChanged()
        webView?.evaluateJavaScript("var b=document.querySelector('[aria-label=\"সাইডবার\"]'); if(b) b.click();", completionHandler: nil)
    }
    @objc private func agentNewChat() {
        Self.selectionGen.selectionChanged()
        webView?.evaluateJavaScript("var b=document.querySelector('[aria-label=\"নতুন চ্যাট\"]'); if(b) b.click();", completionHandler: nil)
    }

    // MARK: - Keyboard avoidance (without resizing the WebView)

    /// The WebView is a stable full-height size and the keyboard overlaps it. To keep
    /// the focused field (search boxes, forms, the agent composer) visible we raise the
    /// scroll view's bottom inset by the overlap so WKWebView scrolls the field above
    /// the keyboard — the standard pattern, and one that does NOT resign first responder
    /// the way pinning the view to keyboardLayoutGuide did.
    private func startObservingKeyboard() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(keyboardChange(_:)),
                       name: UIResponder.keyboardWillShowNotification, object: nil)
        nc.addObserver(self, selector: #selector(keyboardChange(_:)),
                       name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        nc.addObserver(self, selector: #selector(keyboardHide(_:)),
                       name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func keyboardChange(_ note: Notification) {
        guard let webView = webView,
              let endFrame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }
        // Overlap of the keyboard with the web view, in the web view's own coordinates.
        let kbInView = webView.convert(endFrame, from: nil)
        let overlap = max(0, webView.bounds.maxY - kbInView.minY)
        if !agentSegments.isEmpty {
            // Agent (Claude surface): the agent layout rides the keyboard via
            // `--kb-inset` + `body.kb-open` (its `.agent-main-height` = 100lvh − inset),
            // so the composer sits directly above the keyboard. The plain WKWebView's
            // visualViewport can't see the keyboard, so feed it the exact height here.
            setAgentKbInset(overlap)
        } else {
            // Full-bleed view: the overlap now also spans the tab-bar zone the view
            // underlaps — that's correct, the keyboard covers that zone too, so this
            // inset still puts the content bottom exactly at the keyboard's top edge.
            webView.scrollView.contentInset.bottom = overlap
            webView.scrollView.verticalScrollIndicatorInsets.bottom = overlap
        }
    }

    @objc private func keyboardHide(_ note: Notification) {
        if !agentSegments.isEmpty {
            setAgentKbInset(0)
        } else {
            webView?.scrollView.contentInset.bottom = 0
            webView?.scrollView.verticalScrollIndicatorInsets.bottom = 0
        }
    }

    /// Drive the agent layout's `--kb-inset` / `body.kb-open` from the native keyboard.
    private func setAgentKbInset(_ px: CGFloat) {
        let v = Int(px.rounded())
        let js = v > 1
            ? "document.documentElement.style.setProperty('--kb-inset','\(v)px');document.body.classList.add('kb-open');"
            : "document.documentElement.style.setProperty('--kb-inset','0px');document.body.classList.remove('kb-open');"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    /// GLASS MOTION insets — the web view underlaps BOTH bars (full-bleed), so inject
    /// the EXACT nav-bar overlap (`--alma-top-inset` = safeAreaInsets.top) and tab-bar
    /// overlap (`--alma-bottom-inset` = safeAreaInsets.bottom) so the page CONTENT can
    /// reserve those zones while still scrolling under the glass. Injected natively
    /// instead of relying on `env(safe-area-inset-*)`, which is unreliable here: the
    /// plain WKWebView runs `contentInsetAdjustmentBehavior = .never` (the web owns all
    /// insets), and under that mode env() does not track the underlapped bars. Same
    /// proven bridge as `--kb-inset`. Every tab (agent AND ERP); the web falls back to
    /// env() when the vars are absent (older builds / non-native), so this is additive
    /// and safe. setProperty is idempotent, so re-running is cheap.
    private func setWebInsetVars() {
        webView?.evaluateJavaScript(
            Self.insetVarsJS(top: view.safeAreaInsets.top, bottom: view.safeAreaInsets.bottom),
            completionHandler: nil)
    }

    /// The one snippet that writes both inset vars — shared with the Capacitor
    /// Dashboard tab (AlmaTabBarController injects it there too).
    static func insetVarsJS(top: CGFloat, bottom: CGFloat) -> String {
        let t = Int(top.rounded()), b = Int(bottom.rounded())
        return "document.documentElement.style.setProperty('--alma-top-inset','\(t)px');"
             + "document.documentElement.style.setProperty('--alma-bottom-inset','\(b)px');"
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        setWebInsetVars()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var loadedOnce = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Lazy first load: only fetch a tab's page when the owner first opens it,
        // so four background web views don't all hit the network at launch.
        guard !loadedOnce else { return }
        loadedOnce = true
        loader.alpha = 1
        loader.start()
        webView.load(URLRequest(url: url))
    }

    private var firstPaintDone = false
    private var offlineView: UIView?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideOffline() // a successful load clears any lingering offline screen
        setWebInsetVars() // re-assert the glass-motion top/bottom insets on the fresh DOM
        // S3: on the FIRST paint, fade the content in over the placeholder instead of it
        // popping in abruptly. Later navigations/reloads are instant (alpha == 1).
        if !firstPaintDone {
            firstPaintDone = true
            UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) {
                webView.alpha = 1
            }
        }
        // Cross-fade the premium loader out over the now-painted content, then stop it.
        if !loader.isHidden {
            UIView.animate(withDuration: 0.32, delay: 0.04, options: [.curveEaseOut]) {
                self.loader.alpha = 0
            } completion: { _ in self.loader.stop() }
        }
        updateBackButton()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    // MARK: - WKUIDelegate: mic permission for the voice assistant

    /// Voice fix: a plain WKWebView re-prompts getUserMedia on EVERY call by default,
    /// which broke the assistant's tap-to-talk orb (2-3 taps then dead) and the "ALMA"
    /// wake-word continuous listening. Auto-GRANT media capture for our own origin —
    /// iOS still shows its own one-time system mic prompt (NSMicrophoneUsageDescription)
    /// the first time, which is the only prompt the owner should ever see.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        if origin.host == AlmaTheme.host || origin.host.hasSuffix("." + AlmaTheme.host) {
            decisionHandler(.grant)
        } else {
            decisionHandler(.deny)
        }
    }

    // MARK: - S4: native offline screen

    private func handleLoadFailure(_ error: Error) {
        loader.stop()
        firstPaintDone = true
        webView?.alpha = 1
        // Only show the offline screen for genuine connectivity failures. NSURLErrorCancelled
        // (-999) fires routinely when a new navigation supersedes an in-flight one (e.g. the
        // owner taps a link before the page finished) — that is NOT an error to surface.
        let connectivity: Set<Int> = [
            NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost,
            NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost,
            NSURLErrorDNSLookupFailed, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff,
        ]
        if connectivity.contains((error as NSError).code) { showOffline() }
    }

    @objc private func retryLoad() {
        hideOffline()
        loader.alpha = 1
        loader.start()
        webView.load(URLRequest(url: url))
    }

    private func showOffline() {
        guard offlineView == nil else { return }
        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = UIColor(red: 0.949, green: 0.941, blue: 0.972, alpha: 1) // #F2F0F8

        let icon = UIImageView(image: UIImage(systemName: "wifi.slash"))
        icon.tintColor = UIColor(red: 0.42, green: 0.36, blue: 0.62, alpha: 0.85)
        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .regular)

        let title = UILabel()
        title.text = "ইন্টারনেট সংযোগ নেই"
        title.font = .systemFont(ofSize: 19, weight: .semibold)
        title.textColor = UIColor(red: 0.20, green: 0.17, blue: 0.32, alpha: 1)
        title.textAlignment = .center

        let subtitle = UILabel()
        subtitle.text = "সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"
        subtitle.font = .systemFont(ofSize: 14, weight: .regular)
        subtitle.textColor = UIColor(red: 0.42, green: 0.38, blue: 0.52, alpha: 1)
        subtitle.textAlignment = .center
        subtitle.numberOfLines = 0

        var btnCfg = UIButton.Configuration.filled()
        btnCfg.title = "আবার চেষ্টা করুন"
        btnCfg.baseBackgroundColor = UIColor(red: 0.42, green: 0.36, blue: 0.62, alpha: 1)
        btnCfg.baseForegroundColor = .white
        btnCfg.cornerStyle = .large
        btnCfg.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 26, bottom: 12, trailing: 26)
        let retry = UIButton(configuration: btnCfg)
        retry.addTarget(self, action: #selector(retryLoad), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [icon, title, subtitle, retry])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(20, after: subtitle)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        view.addSubview(card)
        offlineView = card

        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: card.centerYAnchor, constant: -24),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: card.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -32),
        ])
    }

    private func hideOffline() {
        offlineView?.removeFromSuperview()
        offlineView = nil
    }

    // MARK: - S5: AssistiveTouch-style agent nav (Assistant tab)

    /// Keep the floating nav's active highlight in sync when the web navigates itself
    /// (e.g. a link inside the chat) — match the current path to a section.
    private func syncSegment(toPath path: String) {
        guard let nav = assistiveNav, !agentSegments.isEmpty else { return }
        // Longest-matching section wins (so /agent/costs beats /agent).
        let idx = agentSegments.enumerated()
            .filter { path == $0.element.url.path || path.hasPrefix($0.element.url.path + "/") }
            .max(by: { $0.element.url.path.count < $1.element.url.path.count })?.offset
        if let idx = idx { nav.setActiveIndex(idx) }
    }

    // MARK: - S4: scroll-to-top on active-tab re-tap (iOS-standard)

    /// Called when the owner taps the already-active tab. The ERP pages usually scroll an
    /// INNER container (not the webView's own scrollView), so reset both: the native
    /// scrollView AND, via JS, the window plus whatever element is actually scrolled.
    func scrollToTop() {
        guard let webView = webView else { return }
        let top = -webView.scrollView.adjustedContentInset.top
        webView.scrollView.setContentOffset(CGPoint(x: 0, y: top), animated: true)
        webView.evaluateJavaScript(Self.scrollTopJS, completionHandler: nil)
    }

    private static let scrollTopJS = """
    (function(){
      try {
        window.scrollTo({top:0,behavior:'smooth'});
        (document.scrollingElement||document.documentElement).scrollTo({top:0,behavior:'smooth'});
        document.querySelectorAll('main,[data-scroll-root],.overflow-y-auto,.overflow-auto,.overflow-y-scroll').forEach(function(e){ if(e.scrollTop>0){ e.scrollTo({top:0,behavior:'smooth'}); } });
      } catch(e){}
    })();
    """

    // MARK: - almaHaptic bridge (web → native soft feedback)

    // Shared, pre-warmed generators. The selection generator is Apple's SOFT
    // keyboard/picker tick — what the owner asked for ("soft") — and firing it
    // natively never touches web focus, so it works while typing.
    private static let selectionGen = UISelectionFeedbackGenerator()
    private static let lightGen = UIImpactFeedbackGenerator(style: .light)
    private static let mediumGen = UIImpactFeedbackGenerator(style: .medium)
    private static let heavyGen = UIImpactFeedbackGenerator(style: .heavy)
    private static let notifyGen = UINotificationFeedbackGenerator()

    /// Fires the requested feedback and re-primes the generator for low latency.
    /// Called on the main thread (WKScriptMessage delivery is main-thread).
    static func fireHaptic(_ body: [String: Any]?) {
        let kind = (body?["kind"] as? String) ?? "selection"
        let style = (body?["style"] as? String) ?? ""
        switch kind {
        case "impact":
            let g = style == "HEAVY" ? heavyGen : (style == "MEDIUM" ? mediumGen : lightGen)
            g.impactOccurred(); g.prepare()
        case "notify":
            let t: UINotificationFeedbackGenerator.FeedbackType =
                style == "ERROR" ? .error : (style == "WARNING" ? .warning : .success)
            notifyGen.notificationOccurred(t); notifyGen.prepare()
        default: // "selection" — the soft tick
            selectionGen.selectionChanged(); selectionGen.prepare()
        }
    }

    // MARK: - S5: native long-press context menu (web → native action sheet)

    /// Web posts {title?, subtitle?, items:[{key,label,role?}]} on a card long-press;
    /// show a native action sheet and send the picked key back to the web.
    private func showContextMenu(_ body: [String: Any]?) {
        guard let items = body?["items"] as? [[String: Any]], !items.isEmpty else { return }
        let sheet = UIAlertController(title: body?["title"] as? String,
                                      message: body?["subtitle"] as? String,
                                      preferredStyle: .actionSheet)
        for item in items {
            guard let key = item["key"] as? String, let label = item["label"] as? String else { continue }
            let style: UIAlertAction.Style = (item["role"] as? String) == "destructive" ? .destructive : .default
            sheet.addAction(UIAlertAction(title: label, style: style) { [weak self] _ in
                self?.pickContextItem(key)
            })
        }
        sheet.addAction(UIAlertAction(title: "বাতিল", style: .cancel))
        if let pop = sheet.popoverPresentationController { // iPad-safe anchor
            pop.sourceView = webView
            pop.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        Self.selectionGen.selectionChanged() // soft tick as the menu opens
        present(sheet, animated: true)
    }

    private func pickContextItem(_ key: String) {
        let esc = key.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        webView?.evaluateJavaScript("window.__almaCtxPick && window.__almaCtxPick('\(esc)')", completionHandler: nil)
    }

    // MARK: - almaShell bridge (web → native)

    /// Receives the web app's route events and updates the native header title.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "almaHaptic" {
            Self.fireHaptic(message.body as? [String: Any])
            return
        }
        if message.name == "almaContextMenu" {
            showContextMenu(message.body as? [String: Any])
            return
        }
        guard let body = message.body as? [String: Any] else { return }
        let type = body["type"] as? String
        if type == "route" {
            // Keep the Assistant's native segmented control in sync with web navigation.
            if let path = body["path"] as? String { syncSegment(toPath: path) }
        }
        if type == "route" || type == "title" {
            if let t = (body["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                // Only the nav-wrapped tabs (Orders/Approvals/More-pushed) show a native
                // header that needs this title. On the BARE Assistant tab (a direct child
                // of the tab bar, no nav controller) setting `title` makes UITabBarController
                // rebuild its tab bar — and that relayout was corrupting a SIBLING tab's
                // button, so returning to Dashboard showed the Assistant icon/label (owner
                // report, fixed by restart). Skip the title write where it isn't needed.
                if navigationController != nil && agentSegments.isEmpty { title = t }
            }
            updateBackButton()
        }
    }

    /// Show a native back chevron whenever the web view has history to pop; tapping
    /// it (or swiping from the edge) drives the web app's own back navigation.
    private func updateBackButton() {
        // The agent keeps its history/new-chat bar buttons (set in viewDidLoad) — it
        // navigates via the AssistiveTouch nav + swipe-back, not a header back chevron.
        guard agentSegments.isEmpty else { return }
        // Only relevant when hosted in a nav controller as that stack's root.
        guard navigationController?.viewControllers.first === self else { return }
        if webView?.canGoBack == true {
            navigationItem.leftBarButtonItem = Self.glassBarButton(
                icon: "chevron.backward", target: self, action: #selector(goBackTapped), light: !AlmaTheme.isDark)
        } else {
            navigationItem.leftBarButtonItem = nil
        }
    }

    @objc private func goBackTapped() {
        if webView?.canGoBack == true { webView.goBack() }
    }
}

/// PHASE S1.1 — the "More" tab as a NATIVE menu (not a web page). Fixes the earlier
/// 404 (`/settings` has no index) and gives the first taste of native content: a
/// grouped list that pushes each module as a web screen with a native slide + a
/// swipe-back gesture (a preview of the S2 native navigation, scoped to More).
final class MoreMenuViewController: UITableViewController {
    private struct Item { let title: String; let icon: String; let path: String }
    private struct Section { let header: String; let items: [Item] }
    private let sharedPool: WKProcessPool

    private let sections: [Section] = [
        // P3 mobile companion: the agent drives a browser ON THIS PHONE (same
        // command bus as the Mac Chrome extension) + the live watch feed.
        // "native:companion" is a sentinel handled in didSelectRowAt — it pushes
        // the NATIVE companion screen instead of a web view.
        Section(header: "Agent", items: [
            Item(title: "Phone Companion", icon: "iphone.radiowaves.left.and.right", path: "native:companion"),
            Item(title: "Live Watch",      icon: "eye",                              path: "/agent/live-watch"),
        ]),
        Section(header: "Workspace", items: [
            Item(title: "My Desk",        icon: "person.crop.square",  path: "/portal"),
            Item(title: "Office",         icon: "building.2",          path: "/portal/office"),
            Item(title: "Product Images",  icon: "photo.on.rectangle",  path: "/agent/catalog-images"),
            Item(title: "Creative Studio", icon: "wand.and.stars",      path: "/agent/creative-studio"),
        ]),
        Section(header: "Money", items: [
            Item(title: "Finance",   icon: "banknote",           path: "/finance"),
            Item(title: "Expenses",  icon: "creditcard",         path: "/expenses"),
            Item(title: "Payroll",   icon: "dollarsign.circle",  path: "/payroll"),
            Item(title: "Invoices",  icon: "doc.text",           path: "/invoice"),
        ]),
        Section(header: "Operations", items: [
            Item(title: "Inventory",      icon: "shippingbox",            path: "/inventory"),
            Item(title: "Activity",       icon: "bolt",                   path: "/activity"),
            Item(title: "Task Spotlight", icon: "target",                 path: "/operations/task-spotlight"),
            Item(title: "Archive",        icon: "archivebox",             path: "/operations/business-archive"),
        ]),
        Section(header: "People", items: [
            Item(title: "Employees",  icon: "person.2",          path: "/employees"),
            Item(title: "Attendance", icon: "calendar.badge.clock", path: "/attendance"),
            Item(title: "CRM",        icon: "person.crop.circle.badge.checkmark", path: "/crm"),
        ]),
        Section(header: "Insights", items: [
            Item(title: "Analytics", icon: "chart.bar",          path: "/analytics"),
            Item(title: "Insights",  icon: "lightbulb",          path: "/insights"),
            Item(title: "Briefing",  icon: "newspaper",          path: "/briefing"),
            Item(title: "Audit",     icon: "checklist",          path: "/audit"),
        ]),
        Section(header: "Settings", items: [
            Item(title: "Users",         icon: "person.3",              path: "/settings/users"),
            Item(title: "Notifications", icon: "bell.badge",            path: "/settings/notifications"),
            Item(title: "Branding",      icon: "paintpalette",          path: "/settings/branding"),
            Item(title: "SMS",           icon: "message",               path: "/settings/sms"),
            Item(title: "Telegram Ops",  icon: "paperplane",            path: "/settings/telegram-ops"),
            Item(title: "Database",      icon: "cylinder.split.1x2",    path: "/settings/database"),
            Item(title: "Session",       icon: "key",                   path: "/settings/session"),
        ]),
    ]

    /// The owner's 3 businesses. Switching is just navigation: the ERP derives the
    /// active business from the route (`/trading` → Trading, `/digital` → CDIT, `/` →
    /// Lifestyle) in BusinessContext, so opening a business's home switches it — no
    /// native/web state plumbing needed. They live in their OWN "Switch business"
    /// section (top), not as flat operation buttons.
    private struct Biz { let name: String; let tagline: String; let symbol: String; let color: UIColor; let path: String }
    private let businesses: [Biz] = [
        Biz(name: "Alma Lifestyle",     tagline: "Lifestyle",      symbol: "a.circle.fill", color: UIColor(red: 0.79, green: 0.66, blue: 0.30, alpha: 1), path: "/"),
        Biz(name: "Alma Trading",       tagline: "P2P Operations", symbol: "t.circle.fill", color: UIColor(red: 0.51, green: 0.70, blue: 0.60, alpha: 1), path: "/trading"),
        Biz(name: "Creative Digital IT", tagline: "Digital Agency", symbol: "c.circle.fill", color: UIColor(red: 0.42, green: 0.56, blue: 0.88, alpha: 1), path: "/digital"),
    ]

    init(processPool: WKProcessPool) {
        self.sharedPool = processPool
        super.init(style: .insetGrouped)
        title = "More"
        tabBarItem = UITabBarItem(
            title: "More",
            image: UIImage(systemName: "ellipsis.circle"),
            selectedImage: UIImage(systemName: "ellipsis.circle.fill"))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .always
        // System grouped background so the whole menu flips with the app light/dark mode
        // (the nav's overrideUserInterfaceStyle, set by AlmaTheme, drives the trait).
        tableView.backgroundColor = .systemGroupedBackground
    }

    // Section 0 = Appearance (Dark-mode + Native-screens switches); section 1 = business
    // switcher; 2… = modules. Row (0,1) is the S6 re-entry: this UIKit menu is what the
    // owner sees AFTER turning the SwiftUI screens off, so the way back lives here.
    override func numberOfSections(in tableView: UITableView) -> Int { sections.count + 2 }
    override func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int {
        s == 0 ? 2 : (s == 1 ? businesses.count : sections[s - 2].items.count)
    }
    override func tableView(_ t: UITableView, titleForHeaderInSection s: Int) -> String? {
        s == 0 ? "Appearance" : (s == 1 ? "Switch business" : sections[s - 2].header)
    }

    override func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        // Appearance row 1 — the "Native স্ক্রিন" (S6 SwiftUI screens) switch.
        if ip.section == 0 && ip.row == 1 {
            let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
            var cfg = cell.defaultContentConfiguration()
            cfg.text = "Native স্ক্রিন"
            cfg.secondaryText = "Orders · Approvals · More"
            cfg.secondaryTextProperties.color = .secondaryLabel
            cfg.image = UIImage(systemName: "swift")
            cfg.imageProperties.tintColor = AlmaTheme.coral
            cell.contentConfiguration = cfg
            let sw = UISwitch()
            sw.isOn = AlmaSwiftUIFlag.isOn
            sw.onTintColor = AlmaTheme.coral
            sw.addTarget(self, action: #selector(nativeScreensToggled(_:)), for: .valueChanged)
            cell.accessoryView = sw
            cell.selectionStyle = .none
            return cell
        }
        // Appearance — a Dark-mode switch that flips the whole app (chrome + web content).
        if ip.section == 0 {
            let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
            var cfg = cell.defaultContentConfiguration()
            cfg.text = "Dark Mode"
            cfg.image = UIImage(systemName: AlmaTheme.isDark ? "moon.fill" : "sun.max.fill")
            cfg.imageProperties.tintColor = AlmaTheme.isDark ? AlmaTheme.violet : .systemOrange
            cell.contentConfiguration = cfg
            let sw = UISwitch()
            sw.isOn = AlmaTheme.isDark
            sw.onTintColor = AlmaTheme.violet
            sw.addTarget(self, action: #selector(darkModeToggled(_:)), for: .valueChanged)
            cell.accessoryView = sw
            cell.selectionStyle = .none
            return cell
        }
        if ip.section == 1 {
            let biz = businesses[ip.row]
            let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
            var cfg = cell.defaultContentConfiguration()
            cfg.text = biz.name
            cfg.secondaryText = biz.tagline
            cfg.secondaryTextProperties.color = .secondaryLabel
            cfg.image = UIImage(systemName: biz.symbol,
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 26))
            cfg.imageProperties.tintColor = biz.color
            cfg.imageToTextPadding = 12
            cell.contentConfiguration = cfg
            cell.accessoryType = .disclosureIndicator
            return cell
        }
        let item = sections[ip.section - 2].items[ip.row]
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        var cfg = cell.defaultContentConfiguration()
        cfg.text = item.title
        cfg.image = UIImage(systemName: item.icon)
        cfg.imageProperties.tintColor = AlmaTheme.violet
        cell.contentConfiguration = cfg
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    @objc private func nativeScreensToggled(_ sw: UISwitch) {
        UISelectionFeedbackGenerator().selectionChanged()
        AlmaSwiftUIFlag.isOn = sw.isOn   // tab controller swaps Orders/Approvals/More live
    }

    @objc private func darkModeToggled(_ sw: UISwitch) {
        UISelectionFeedbackGenerator().selectionChanged()
        AlmaTheme.set(dark: sw.isOn)  // flips + persists + broadcasts → chrome + all webviews restyle
        // Refresh the Appearance row so its sun/moon icon matches (colours flip via the trait).
        tableView.reloadRows(at: [IndexPath(row: 0, section: 0)], with: .none)
    }

    override func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        guard ip.section >= 1 else { return }   // Appearance row is switch-only
        let base = "https://alma-erp-six.vercel.app"
        let path: String, tabTitle: String, symbol: String
        if ip.section == 1 {
            let biz = businesses[ip.row]
            path = biz.path; tabTitle = biz.name; symbol = biz.symbol
        } else {
            let item = sections[ip.section - 2].items[ip.row]
            path = item.path; tabTitle = item.title; symbol = item.icon
        }
        // Native (non-web) rows: the phone companion is a native screen.
        if path == "native:companion" {
            let vc = AlmaCompanionViewController(processPool: sharedPool)
            vc.hidesBottomBarWhenPushed = false
            navigationController?.pushViewController(vc, animated: true)
            return
        }
        let vc = AlmaWebTabViewController(
            url: URL(string: base + path)!, processPool: sharedPool,
            tabTitle: tabTitle, systemImage: symbol, hideWebHeader: true)
        vc.hidesBottomBarWhenPushed = false
        navigationController?.pushViewController(vc, animated: true)
    }
}

/// The native app root: a tab bar hosting the Capacitor dashboard (tab 0) and four
/// session-sharing content tabs, with a dark appearance and a haptic tick on switch.
final class AlmaTabBarController: UITabBarController, UITabBarControllerDelegate {
    private let selection = UISelectionFeedbackGenerator()
    static let base = "https://alma-erp-six.vercel.app"
    weak var dashboardVC: UIViewController?  // internal: makeDashboardTab() (SwiftUIShell.swift) mounts it
    private var approvalsBadgeTimer: Timer?
    private static let approvalsTabIndex = 3
    /// Shared by every content web view (and the S6 SwiftUI screens' web escapes +
    /// the Companion) — one pool = one logged-in session everywhere.
    let contentPool = WKProcessPool()

    /// - Parameter dashboard: the storyboard's Capacitor bridge VC, reused as tab 0.
    init(dashboard: UIViewController) {
        super.init(nibName: nil, bundle: nil)
        AlmaTheme.loadInitial()   // build the shell in the persisted mode (no flash)
        dashboardVC = dashboard
        NotificationCenter.default.addObserver(self, selector: #selector(onThemeChanged),
                                               name: .almaThemeChanged, object: nil)

        // The Dashboard (Capacitor) tab gets a native header too (S3) — give the VC a
        // title for that header and wrap it in a dark nav controller below, like the
        // other content tabs. Its web page-header is hidden via AlmaBridgeViewController.
        dashboard.title = "Dashboard"

        // S6: Dashboard / Orders / Assistant / Approvals / More are SwiftUI when the flag
        // is on (iOS 17+), web/UIKit otherwise — makeXxxTab() decides per launch, and the
        // flag toggle in More swaps them live (onSwiftUIFlagChanged). Dashboard (owner
        // 2026-07-06, freeze lifted): the native DashboardScreen lays over the Capacitor
        // bridge VC, which stays MOUNTED (DashboardHostController) so push / reminders /
        // N1–N5 keep running — see makeDashboardTab(). Assistant's builder lives in
        // AssistantSwiftUI.swift (native chat; web fallback keeps the old segmented
        // Chat/Studio/WhatsApp/Monitor/Costs construction verbatim).
        viewControllers = [
            makeDashboardTab(),
            makeOrdersTab(),
            makeAssistantTab(),
            makeApprovalsTab(),
            makeMoreTab(),
        ]
        NotificationCenter.default.addObserver(self, selector: #selector(onSwiftUIFlagChanged),
                                               name: .almaSwiftUIFlagChanged, object: nil)

        // Approvals tab badge: any PENDING business approval OR PENDING agent action
        // surfaces as a red count on the Approvals tab. Refresh on foreground, on an
        // approve/reject (posted by ApprovalsVM), and on a 90s heartbeat.
        NotificationCenter.default.addObserver(self, selector: #selector(refreshApprovalsBadge),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refreshApprovalsBadge),
                                               name: .almaApprovalsChanged, object: nil)

        delegate = self
        applyDarkAppearance()
        selection.prepare()
        // UserDefaults is the SINGLE source of truth for the mode (loadInitial above).
        // We deliberately do NOT read the cookie back: a stale/raced cookie kept
        // reverting a fresh launch to the previous mode (owner-visible bug). The
        // in-app web has no reachable theme toggle, so one-way native→web is safe:
        // push the persisted mode INTO the cookie store, then restyle everything.
        AlmaTheme.persistCookie()
        applyTheme()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private var didRunCompanionSelfTest = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // The window doesn't exist during init-time applyTheme — re-assert here so the
        // window-level trait (sheet presentations) matches from the first frame on.
        view.window?.overrideUserInterfaceStyle = AlmaTheme.interfaceStyle
        // DEBUG self-test hook: ALMA_DASH_APPEARANCE=light|dark flips the app theme via the
        // REAL theme API (same as the More toggle) so a headless sim proof can capture both
        // modes without GUI clicks. Never set on a real launch.
        if let a = ProcessInfo.processInfo.environment["ALMA_DASH_APPEARANCE"] {
            AlmaTheme.set(dark: a != "light")
        }
        // Approvals badge: first fetch once the shell is on screen, then a 90s heartbeat.
        refreshApprovalsBadge()
        if approvalsBadgeTimer == nil {
            approvalsBadgeTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in
                self?.refreshApprovalsBadge()
            }
        }
        // DEBUG self-test hook: ALMA_FADE_DEMO=1 presents the ClaudeTopFade demo screen
        // (see ClaudeTopFade.swift) so the scroll-edge fade can be screenshotted headlessly.
        ClaudeTopFadeSelfTest.presentIfRequested(over: self)
        // DEBUG self-test hook: ALMA_OPEN_TAB=<0-4> jumps straight to a tab at launch, so
        // sim proofs need no GUI clicks. Read env OR launch argv (simctl passes KEY=val
        // as a positional argument, not an env var).
        let openTabRaw = ProcessInfo.processInfo.environment["ALMA_OPEN_TAB"]
            ?? ProcessInfo.processInfo.arguments.first { $0.hasPrefix("ALMA_OPEN_TAB=") }?
                .split(separator: "=").last.map(String.init)
        if let t = openTabRaw, let i = Int(t),
           (0..<(viewControllers?.count ?? 0)).contains(i) {
            selectedIndex = i
            // The Capacitor Dashboard reparent can reset the selection right after the
            // first appearance — re-assert once the launch dust settles.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.selectedIndex = i
            }
        }
        // DEBUG self-test hook (never fires in production): when launched with
        // ALMA_OPEN_COMPANION=1 (only set by the local `simctl launch` self-test),
        // jump to More and push the native Phone Companion so its render + pairing
        // dialog can be screenshotted headlessly. No effect on any real launch.
        guard !didRunCompanionSelfTest,
              ProcessInfo.processInfo.environment["ALMA_OPEN_COMPANION"] == "1" else { return }
        didRunCompanionSelfTest = true
        selectedIndex = 4 // More
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let nav = self?.viewControllers?.last as? UINavigationController else { return }
            nav.pushViewController(AlmaCompanionViewController(processPool: WKProcessPool()), animated: false)
        }
    }

    /// A frosted-glass UINavigationController wrapping `root`, with a tab item. The bar's
    /// light/dark frosted appearance tracks the app-wide mode via AlmaTheme (Claude-style in
    /// both) — the Assistant adds its own hamburger/coral buttons on top.
    static func darkNav(root: UIViewController, tabTitle: String, icon: String, largeTitles: Bool) -> UINavigationController {
        let nav = UINavigationController(rootViewController: root)
        nav.navigationBar.prefersLargeTitles = largeTitles
        AlmaTheme.applyNav(nav)
        nav.tabBarItem = UITabBarItem(
            title: tabTitle,
            image: UIImage(systemName: icon),
            selectedImage: UIImage(systemName: icon + ".fill") ?? UIImage(systemName: icon))
        return nav
    }

    /// Restyle the whole shell — tab bar + every nav bar + the Capacitor Dashboard's web
    /// content — for the current light/dark mode. The plain web tabs restyle their own root
    /// + content via their `.almaThemeChanged` observer; here we drive the shared chrome.
    func applyTheme() {
        overrideUserInterfaceStyle = AlmaTheme.interfaceStyle
        // The WINDOW must carry the override too: SwiftUI .sheet presentations attach at
        // the window's presentation layer, ABOVE this tab controller's trait override —
        // without this a sheet rendered light while the app sat in dark (S6 finding).
        view.window?.overrideUserInterfaceStyle = AlmaTheme.interfaceStyle
        let ap = AlmaTheme.tabBarAppearance()
        tabBar.standardAppearance = ap
        tabBar.scrollEdgeAppearance = ap
        tabBar.tintColor = AlmaTheme.violet
        for vc in viewControllers ?? [] {
            if let nav = vc as? UINavigationController { AlmaTheme.applyNav(nav) }
        }
        // The Capacitor Dashboard isn't an AlmaWebTabViewController, so flip its web content
        // here (find its WKWebView without importing Capacitor).
        styleDashboardWebView()
    }

    /// The Capacitor web view's background is hardcoded DARK by capacitor.config
    /// (#0c0b12), so in light mode the Dashboard showed black strips where the page
    /// underlaps the bars. Re-base every layer under it on the themed root colour and
    /// push the theme + the glass-motion inset vars into the page — the same
    /// `--alma-top-inset` / `--alma-bottom-inset` bridge the plain tabs use (the
    /// Dashboard fills the tab controller, so OUR safeAreaInsets are its overlaps).
    /// Idempotent; runs at launch (applyTheme via init), on theme flips, and on
    /// safe-area changes.
    private func styleDashboardWebView() {
        guard let dvc = dashboardVC, let w = Self.firstWebView(in: dvc.view) else { return }
        let bg = AlmaTheme.rootBg
        w.isOpaque = false
        w.backgroundColor = bg
        w.scrollView.backgroundColor = bg
        w.superview?.backgroundColor = bg
        dvc.view.backgroundColor = bg
        w.evaluateJavaScript(AlmaTheme.applyJS(), completionHandler: nil)
        // Anchor web overlays (todo pill) to the nav bar's REAL bottom edge, measured
        // from the bar itself — Capacitor pads the VC's safeAreaInsets with its own
        // additional insets, which threw the injected value off by tens of points.
        let nav = dvc.navigationController?.navigationBar
        let barBottom = nav.map { $0.convert($0.bounds, to: nil).maxY } ?? dvc.view.safeAreaInsets.top
        w.evaluateJavaScript(
            AlmaWebTabViewController.insetVarsJS(top: barBottom,
                                                 bottom: view.safeAreaInsets.bottom),
            completionHandler: nil)
    }

    /// Safe-area geometry lands AFTER init-time applyTheme (insets are 0 until layout),
    /// so re-inject the Dashboard's inset vars when the real values arrive.
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        styleDashboardWebView()
    }

    private static func firstWebView(in view: UIView) -> WKWebView? {
        if let w = view as? WKWebView { return w }
        for sub in view.subviews { if let w = firstWebView(in: sub) { return w } }
        return nil
    }

    // ── Face ID app-lock flag bridge (More menu → web localStorage) ─────────────────
    // The lock is implemented web-side (BiometricLockGate reads localStorage key
    // `alma_biometric_lock_enabled` on the production origin). The Capacitor Dashboard
    // webview lives on that origin after its boot handoff, and every webview shares the
    // default data store, so reading/writing localStorage there is the same value the
    // gate uses. A UserDefaults cache gives the switch an instant, correct first paint.

    private static let biometricLockKey = "alma_biometric_lock_enabled"
    static var cachedBiometricLock: Bool {
        get { UserDefaults.standard.object(forKey: "alma-biometric-lock-cache") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "alma-biometric-lock-cache") }
    }

    /// Read the web lock flag ('0' = off; null/absent/anything else = on, the web default).
    /// Falls back to the cache if no production-origin webview is reachable yet.
    func readBiometricLock(_ completion: @escaping (Bool) -> Void) {
        guard let dvc = dashboardVC, let w = Self.firstWebView(in: dvc.view) else {
            completion(Self.cachedBiometricLock); return
        }
        let js = """
        (function(){try{if(location.host.indexOf('alma-erp-six')<0)return '__na__';\
        var v=localStorage.getItem('\(Self.biometricLockKey)');return v===null?'__unset__':v;}catch(e){return '__na__';}})()
        """
        w.evaluateJavaScript(js) { result, _ in
            let s = result as? String
            if s == "__na__" || s == nil {
                completion(Self.cachedBiometricLock)               // origin not ready → cache
            } else {
                let on = (s != "0")                                // unset or non-'0' ⇒ ON
                Self.cachedBiometricLock = on
                completion(on)
            }
        }
    }

    /// Write the web lock flag. Cache always updates (drives the switch); the localStorage
    /// write only fires on the real production origin so we never poison a bootstrap page.
    func writeBiometricLock(_ on: Bool) {
        Self.cachedBiometricLock = on
        guard let dvc = dashboardVC, let w = Self.firstWebView(in: dvc.view) else { return }
        let v = on ? "1" : "0"
        let js = """
        try{if(location.host.indexOf('alma-erp-six')>=0){localStorage.setItem('\(Self.biometricLockKey)','\(v)');}}catch(e){}
        """
        w.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc private func onThemeChanged() { applyTheme() }

    private func applyDarkAppearance() { applyTheme() }

    /// Fetch pending business approvals + pending agent actions and stamp the sum on
    /// the Approvals tab as a badge (nil when zero). Best-effort: a failed fetch leaves
    /// the last known badge untouched rather than clearing a real count on a blip.
    @objc func refreshApprovalsBadge() {
        Task { @MainActor [weak self] in
            guard self != nil else { return }
            // BOTH counts must load before we touch the badge — a transient failure of
            // either endpoint must not wrongly clear (or halve) a real pending count.
            guard let biz: ApprovalsListResponse = try? await AlmaAPI.shared.get(
                    "/api/approvals", query: ["status": "PENDING", "limit": "80"]),
                  let agent: AgentActionsResponse = try? await AlmaAPI.shared.get(
                    "/api/assistant/actions", query: ["status": "pending", "limit": "50"]),
                  let self else { return }
            let count = (biz.totalPending ?? biz.approvals.count) + agent.actions.count
            self.setApprovalsBadge(count)
        }
    }

    private func setApprovalsBadge(_ count: Int) {
        guard let vcs = viewControllers, vcs.count > Self.approvalsTabIndex else { return }
        vcs[Self.approvalsTabIndex].tabBarItem.badgeValue = count > 0 ? "\(count)" : nil
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        selection.selectionChanged()
        selection.prepare()
    }

    /// Re-tapping the already-active tab scrolls its web content back to the top
    /// (the iOS-standard gesture). Returning true still lets the tap proceed normally.
    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        if viewController === tabBarController.selectedViewController {
            let visible = (viewController as? UINavigationController)?.topViewController ?? viewController
            (visible as? AlmaWebTabViewController)?.scrollToTop()
        }
        return true
    }
}

/// An iOS-AssistiveTouch-style floating navigator for the agent sections.
///
/// A draggable, edge-snapping translucent button that idles to low opacity and springs
/// open into a blurred panel of sections (Chat / Studio / WhatsApp / Monitor / Costs).
/// Pure UIKit so the feel — spring physics, blur, drag inertia, haptics — is authentic.
/// The view fills its host but passes touches through to the web view when closed, so
/// only the floating button (and the backdrop while open) are interactive.
final class AgentAssistiveNav: UIView {
    struct Item { let title: String; let icon: String; let onSelect: () -> Void }

    private let items: [Item]
    private let fab = UIView()
    private let fabIcon = UIImageView()
    private var backdrop: UIControl?
    private var itemViews: [UIControl] = []   // radial item buttons (fanned around the FAB)
    private var isOpen = false
    private var activeIndex = 0
    private var positioned = false
    private var tabBarHeight: CGFloat = 49
    private var idleTimer: Timer?
    private let haptic = UISelectionFeedbackGenerator()
    private let impact = UIImpactFeedbackGenerator(style: .light)

    private let fabSize: CGFloat = 56
    private let edge: CGFloat = 12

    init(items: [Item]) {
        self.items = items
        super.init(frame: .zero)
        buildFab()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // MARK: build + attach

    private func buildFab() {
        fab.frame = CGRect(x: 0, y: 0, width: fabSize, height: fabSize)
        fab.backgroundColor = UIColor(red: 0.10, green: 0.09, blue: 0.14, alpha: 0.82)
        fab.layer.cornerRadius = 17
        fab.layer.cornerCurve = .continuous
        fab.layer.borderWidth = 1
        fab.layer.borderColor = UIColor(white: 1, alpha: 0.22).cgColor
        fab.layer.shadowColor = UIColor.black.cgColor
        fab.layer.shadowOpacity = 0.35
        fab.layer.shadowRadius = 10
        fab.layer.shadowOffset = CGSize(width: 0, height: 4)

        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
        blur.frame = fab.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blur.layer.cornerRadius = 17
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        blur.isUserInteractionEnabled = false
        fab.addSubview(blur)

        fabIcon.image = UIImage(systemName: "sparkles",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold))
        fabIcon.tintColor = .white
        fabIcon.contentMode = .center
        fabIcon.frame = fab.bounds
        fabIcon.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blur.contentView.addSubview(fabIcon)

        fab.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(fabTapped)))
        fab.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(fabPanned(_:))))
        addSubview(fab)
    }

    func attach(to host: UIView, tabBarHeight: CGFloat) {
        self.tabBarHeight = tabBarHeight
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor),
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
        ])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !positioned, bounds.width > 0 else { return }
        positioned = true
        let sa = safeAreaInsets
        fab.center = CGPoint(x: bounds.width - fabSize / 2 - edge - sa.right,
                             y: bounds.height - fabSize / 2 - tabBarHeight - 18 - sa.bottom)
        scheduleIdle()
    }

    // Pass touches through to the web view unless they hit the button (closed) or the
    // whole overlay is open (backdrop catches them).
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if isOpen { return super.hitTest(point, with: event) }
        return fab.frame.insetBy(dx: -8, dy: -8).contains(point) ? super.hitTest(point, with: event) : nil
    }

    // MARK: idle fade

    private func scheduleIdle() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            guard let self = self, !self.isOpen else { return }
            UIView.animate(withDuration: 0.4) { self.fab.alpha = 0.42 }
        }
    }
    private func wake() {
        UIView.animate(withDuration: 0.15) { self.fab.alpha = 1 }
        scheduleIdle()
    }

    // MARK: drag

    @objc private func fabPanned(_ g: UIPanGestureRecognizer) {
        wake()
        let t = g.translation(in: self)
        switch g.state {
        case .began:
            if isOpen { close() }
            impact.impactOccurred(intensity: 0.5); impact.prepare()   // grab
            UIView.animate(withDuration: 0.12) { self.fab.transform = CGAffineTransform(scaleX: 0.94, y: 0.94) }
        case .changed:
            var c = CGPoint(x: fab.center.x + t.x, y: fab.center.y + t.y)
            let sa = safeAreaInsets
            let half = fabSize / 2
            c.x = min(max(c.x, half + edge + sa.left), bounds.width - half - edge - sa.right)
            c.y = min(max(c.y, half + edge + sa.top), bounds.height - half - tabBarHeight - sa.bottom)
            fab.center = c
            g.setTranslation(.zero, in: self)
        case .ended, .cancelled:
            snapToEdge(velocity: g.velocity(in: self))
        default: break
        }
    }

    /// iOS-AssistiveTouch release physics: carry the flick's momentum (project a landing
    /// point from the release velocity), snap X to the nearest edge — biased by horizontal
    /// velocity — and settle with an under-damped spring so it OVERSHOOTS slightly and eases
    /// back, exactly like the system button (not a linear/CSS glide).
    private func snapToEdge(velocity: CGPoint) {
        let sa = safeAreaInsets
        let half = fabSize / 2
        let minY = half + edge + sa.top
        let maxY = bounds.height - half - tabBarHeight - sa.bottom
        // Momentum: where would the flick carry it? (projectile decay ≈ velocity * k)
        let projectedY = fab.center.y + velocity.y * 0.14
        let y = min(max(projectedY, minY), maxY)
        // Snap side: strong horizontal flick wins, else nearest edge.
        let goRight = velocity.x > 250 ? true : (velocity.x < -250 ? false : fab.center.x > bounds.width / 2)
        let x = goRight ? bounds.width - half - edge - sa.right : half + edge + sa.left
        let target = CGPoint(x: x, y: y)
        let speed = hypot(velocity.x, velocity.y)
        impact.impactOccurred(intensity: 0.7); impact.prepare()   // release/snap
        UIView.animate(withDuration: 0.6, delay: 0,
                       usingSpringWithDamping: 0.66,               // < 1 → overshoot + settle
                       initialSpringVelocity: min(speed / 450, 14),
                       options: [.allowUserInteraction, .curveEaseOut]) {
            self.fab.center = target
            self.fab.transform = .identity
        }
    }

    // MARK: open / close

    @objc private func fabTapped() {
        wake()
        isOpen ? close() : open()
    }

    private let itemCircle: CGFloat = 54     // frosted icon disc
    private let arcRadius: CGFloat = 132      // distance from FAB centre to each item

    /// Where item `i` sits on the fan arc around the FAB. The arc occupies the screen
    /// QUADRANT that opens toward the centre (FAB bottom-right → fan up-left, etc.), so
    /// the items always fan INTO the screen, never off an edge. y grows downward, so the
    /// angle convention is 0=right, 90°=down, 180°=left, 270°=up.
    private func arcCenter(for i: Int) -> CGPoint {
        let onRight = fab.center.x > bounds.width / 2
        let topHalf = fab.center.y < bounds.height / 2
        // Quadrant sweep (degrees), inset a touch from the pure axes so end items don't
        // hug the edge.
        let (startDeg, endDeg): (CGFloat, CGFloat)
        switch (onRight, topHalf) {
        case (true,  false): (startDeg, endDeg) = (184, 274)   // bottom-right → up-left
        case (false, false): (startDeg, endDeg) = (266, 356)   // bottom-left  → up-right
        case (true,  true):  (startDeg, endDeg) = (86, 176)    // top-right    → down-left
        case (false, true):  (startDeg, endDeg) = (4, 94)      // top-left     → down-right
        }
        let n = items.count
        let t: CGFloat = n <= 1 ? 0.5 : CGFloat(i) / CGFloat(n - 1)
        let deg = startDeg + t * (endDeg - startDeg)
        let rad = deg * .pi / 180
        var c = CGPoint(x: fab.center.x + arcRadius * cos(rad),
                        y: fab.center.y + arcRadius * sin(rad))
        // Keep every disc fully on-screen.
        let sa = safeAreaInsets, half = itemCircle / 2
        c.x = min(max(c.x, half + edge + sa.left), bounds.width - half - edge - sa.right)
        c.y = min(max(c.y, half + edge + sa.top), bounds.height - half - edge - sa.bottom - tabBarHeight)
        return c
    }

    private func open() {
        guard !isOpen, bounds.width > 0 else { return }
        isOpen = true
        impact.impactOccurred(); impact.prepare()

        let back = UIControl(frame: bounds)
        back.backgroundColor = UIColor.black.withAlphaComponent(0.28)   // dim so the fan reads
        back.alpha = 0
        back.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        insertSubview(back, belowSubview: fab)
        backdrop = back
        UIView.animate(withDuration: 0.22) { back.alpha = 1 }

        // Build the fan and pop each disc OUT from the FAB centre to its arc seat with a
        // staggered spring — the true iOS-AssistiveTouch radial feel.
        itemViews = []
        for (i, _) in items.enumerated() {
            let v = makeRadialItem(i)
            let seat = arcCenter(for: i)
            v.center = seat
            insertSubview(v, belowSubview: fab)
            itemViews.append(v)

            let dx = fab.center.x - seat.x, dy = fab.center.y - seat.y
            v.transform = CGAffineTransform(translationX: dx, y: dy).scaledBy(x: 0.2, y: 0.2)
            v.alpha = 0
            UIView.animate(withDuration: 0.42, delay: 0.03 + Double(i) * 0.045,
                           usingSpringWithDamping: 0.68, initialSpringVelocity: 0.7,
                           options: [.curveEaseOut]) {
                v.transform = .identity
                v.alpha = 1
            }
        }
        UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.6,
                       initialSpringVelocity: 0.5, options: [.curveEaseOut]) {
            self.fabIcon.transform = CGAffineTransform(rotationAngle: .pi / 4)   // + → ×
        }
    }

    @objc private func close() {
        guard isOpen else { return }
        isOpen = false
        haptic.selectionChanged()
        let views = itemViews, back = backdrop
        itemViews = []; backdrop = nil
        // Suck each disc back INTO the FAB, staggered from the outer item inward.
        for (i, v) in views.enumerated() {
            let dx = fab.center.x - v.center.x, dy = fab.center.y - v.center.y
            UIView.animate(withDuration: 0.22, delay: Double(views.count - 1 - i) * 0.025,
                           options: [.curveEaseIn]) {
                v.transform = CGAffineTransform(translationX: dx, y: dy).scaledBy(x: 0.2, y: 0.2)
                v.alpha = 0
            } completion: { _ in v.removeFromSuperview() }
        }
        UIView.animate(withDuration: 0.24, delay: 0, options: [.curveEaseIn]) {
            back?.alpha = 0
            self.fabIcon.transform = .identity
        } completion: { _ in back?.removeFromSuperview() }
        scheduleIdle()
    }

    // MARK: radial item

    /// A single fan item: a frosted circular disc (icon) with a small label below.
    /// Subview tags: 1 = blur disc, 2 = icon, 3 = label — used by setActiveIndex.
    private func makeRadialItem(_ i: Int) -> UIControl {
        let item = items[i]
        let on = i == activeIndex
        let v = UIControl(frame: CGRect(x: 0, y: 0, width: itemCircle, height: itemCircle))
        v.tag = i
        v.clipsToBounds = false   // let the label overflow below the disc
        v.addTarget(self, action: #selector(itemTapped(_:)), for: .touchUpInside)

        let disc = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
        disc.tag = 1
        disc.frame = v.bounds
        disc.layer.cornerRadius = itemCircle / 2
        disc.clipsToBounds = true
        disc.isUserInteractionEnabled = false
        disc.layer.borderWidth = 1
        disc.layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
        disc.contentView.backgroundColor = on
            ? UIColor(red: 0.42, green: 0.36, blue: 0.62, alpha: 0.92) : .clear
        v.addSubview(disc)

        // Soft shadow so discs float above the dimmed backdrop.
        v.layer.shadowColor = UIColor.black.cgColor
        v.layer.shadowOpacity = 0.3
        v.layer.shadowRadius = 8
        v.layer.shadowOffset = CGSize(width: 0, height: 3)

        let iv = UIImageView(image: UIImage(systemName: item.icon,
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)))
        iv.tag = 2
        iv.tintColor = on ? .white : UIColor(white: 0.9, alpha: 1)
        iv.frame = v.bounds
        iv.contentMode = .center
        iv.isUserInteractionEnabled = false
        v.addSubview(iv)

        let label = UILabel(frame: CGRect(x: (itemCircle - 78) / 2, y: itemCircle + 4, width: 78, height: 14))
        label.tag = 3
        label.text = item.title
        label.font = .systemFont(ofSize: 10.5, weight: on ? .bold : .semibold)
        label.textColor = on ? .white : UIColor(white: 0.96, alpha: 1)
        label.textAlignment = .center
        label.isUserInteractionEnabled = false
        label.layer.shadowColor = UIColor.black.cgColor      // legible over any content
        label.layer.shadowOpacity = 0.6
        label.layer.shadowRadius = 2
        label.layer.shadowOffset = .zero
        v.addSubview(label)
        return v
    }

    @objc private func itemTapped(_ sender: UIControl) {
        let i = sender.tag
        guard i >= 0, i < items.count else { return }
        haptic.selectionChanged(); haptic.prepare()
        setActiveIndex(i)
        let action = items[i].onSelect
        close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { action() }
    }

    func setActiveIndex(_ i: Int) {
        guard i >= 0, i < items.count else { return }
        activeIndex = i
        for (idx, v) in itemViews.enumerated() {
            let on = idx == i
            (v.viewWithTag(1) as? UIVisualEffectView)?.contentView.backgroundColor = on
                ? UIColor(red: 0.42, green: 0.36, blue: 0.62, alpha: 0.92) : .clear
            (v.viewWithTag(2) as? UIImageView)?.tintColor = on ? .white : UIColor(white: 0.9, alpha: 1)
            if let l = v.viewWithTag(3) as? UILabel {
                l.font = .systemFont(ofSize: 10.5, weight: on ? .bold : .semibold)
            }
        }
    }

    deinit { idleTimer?.invalidate() }
}

/// A premium branded first-paint / page-transition loader — replaces the plain
/// UIActivityIndicator on a flat light slab the owner found "too normal / white".
///
/// It paints a soft themed gradient backdrop and, centred on it, a BREATHING violet
/// gradient orb (radial glow that pulses in scale + opacity) over three staggered
/// morphing dots. Two styles: `.light` for the ERP web views (a pale lavender wash so
/// the light pages fade in with no dark→light flash) and `.dark` for the Assistant
/// (deep violet-black to match its dark glass). Pure CoreAnimation, GPU-cheap, and it
/// stops when hidden so it costs nothing at rest.
final class AlmaPremiumLoader: UIView {
    enum Style { case light, dark }

    private let style: Style
    private let backdrop = CAGradientLayer()
    private let orb = UIView()
    private let orbGradient = CAGradientLayer()
    private var dots: [CALayer] = []
    private let orbSize: CGFloat = 78

    init(style: Style) {
        self.style = style
        super.init(frame: .zero)
        isUserInteractionEnabled = false

        // Themed backdrop wash (vertical gradient) — never a flat white.
        switch style {
        case .light:
            backdrop.colors = [
                UIColor(red: 0.957, green: 0.949, blue: 0.980, alpha: 1).cgColor, // #F4F2FA
                UIColor(red: 0.910, green: 0.898, blue: 0.964, alpha: 1).cgColor, // pale lavender
            ]
        case .dark:
            backdrop.colors = [
                UIColor(red: 0.055, green: 0.047, blue: 0.086, alpha: 1).cgColor, // #0e0c16
                UIColor(red: 0.086, green: 0.063, blue: 0.145, alpha: 1).cgColor, // deep violet
            ]
        }
        backdrop.startPoint = CGPoint(x: 0.5, y: 0)
        backdrop.endPoint = CGPoint(x: 0.5, y: 1)
        layer.addSublayer(backdrop)

        // Breathing orb — a radial violet glow.
        orb.isUserInteractionEnabled = false
        orbGradient.type = .radial
        orbGradient.colors = [
            UIColor(red: 0.68, green: 0.55, blue: 1.0, alpha: 0.98).cgColor,
            UIColor(red: 0.47, green: 0.35, blue: 0.86, alpha: 0.80).cgColor,
            UIColor(red: 0.36, green: 0.26, blue: 0.70, alpha: 0.0).cgColor,
        ]
        orbGradient.locations = [0, 0.55, 1]
        orbGradient.startPoint = CGPoint(x: 0.5, y: 0.5)
        orbGradient.endPoint = CGPoint(x: 1, y: 1)
        orb.layer.addSublayer(orbGradient)
        orb.layer.shadowColor = UIColor(red: 0.55, green: 0.42, blue: 0.98, alpha: 1).cgColor
        orb.layer.shadowOpacity = 0.55
        orb.layer.shadowRadius = 26
        orb.layer.shadowOffset = .zero
        addSubview(orb)

        // Three staggered morphing dots below the orb.
        for _ in 0..<3 {
            let d = CALayer()
            d.backgroundColor = UIColor(red: 0.60, green: 0.48, blue: 0.96, alpha: 1).cgColor
            layer.addSublayer(d)
            dots.append(d)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        backdrop.frame = bounds
        let cx = bounds.midX, cy = bounds.midY
        orb.frame = CGRect(x: cx - orbSize / 2, y: cy - orbSize / 2 - 12, width: orbSize, height: orbSize)
        orbGradient.frame = orb.bounds
        orb.layer.shadowPath = UIBezierPath(ovalIn: orb.bounds).cgPath
        let dotSize: CGFloat = 9, gap: CGFloat = 17
        let dotY = orb.frame.maxY + 20
        for (i, d) in dots.enumerated() {
            d.frame = CGRect(x: cx + CGFloat(i - 1) * gap - dotSize / 2, y: dotY, width: dotSize, height: dotSize)
            d.cornerRadius = dotSize / 2
        }
        CATransaction.commit()
    }

    /// Begin the breathing + dot animations and reveal the loader.
    func start() {
        isHidden = false
        // Orb: breathe (scale + opacity), gently forever.
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.84; scale.toValue = 1.12
        scale.duration = 1.3; scale.autoreverses = true; scale.repeatCount = .infinity
        scale.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        orb.layer.add(scale, forKey: "breathe")
        let glow = CABasicAnimation(keyPath: "opacity")
        glow.fromValue = 0.7; glow.toValue = 1.0
        glow.duration = 1.3; glow.autoreverses = true; glow.repeatCount = .infinity
        glow.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        orb.layer.add(glow, forKey: "glow")
        // Dots: staggered rise (scale + opacity), phase-shifted via timeOffset.
        for (i, d) in dots.enumerated() {
            let a = CAKeyframeAnimation(keyPath: "transform.scale")
            a.values = [0.5, 1.15, 0.5]; a.keyTimes = [0, 0.5, 1]
            a.duration = 1.05; a.repeatCount = .infinity
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            a.timeOffset = Double(i) * 0.18
            d.add(a, forKey: "morph")
            let o = CAKeyframeAnimation(keyPath: "opacity")
            o.values = [0.35, 1.0, 0.35]; o.keyTimes = [0, 0.5, 1]
            o.duration = 1.05; o.repeatCount = .infinity
            o.timeOffset = Double(i) * 0.18
            d.add(o, forKey: "fade")
        }
    }

    /// Stop the animations (call when hiding, so it costs nothing at rest).
    func stop() {
        orb.layer.removeAllAnimations()
        dots.forEach { $0.removeAllAnimations() }
        isHidden = true
    }
}
