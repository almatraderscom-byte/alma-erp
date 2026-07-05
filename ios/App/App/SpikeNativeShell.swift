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
final class AlmaWebTabViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
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

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        // S3 first-paint: the ERP pages are LIGHT, so paint the placeholder LIGHT (was a
        // dark slab that flashed dark→light on every first load). Matched to the ERP's
        // pale lavender so the content fades in without a flash. (The dark native header
        // sits above this in its own bar.)
        let bg = UIColor(red: 0.949, green: 0.941, blue: 0.972, alpha: 1) // #F2F0F8
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
        webView.alpha = 0 // S3: fade the content in on first paint (see didFinish) — no pop-in.
        // Pull-to-refresh is now the web robot mascot (MobilePullToRefresh) — no native
        // UIRefreshControl (it would double up and can't show the robot). Web owns it.

        let root = UIView()
        // The agent is now the CLAUDE-style LIGHT surface: a LIGHT frosted (ultra-thin white)
        // nav bar over the light agent content, so the chat blurs THROUGH the bar cleanly as
        // it scrolls under. So the root stays LIGHT for every tab (no dark slab behind the
        // agent bar — that was for the old dark-glass header).
        root.backgroundColor = bg
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false

        // GLASS MOTION (Assistant only): pin the web view to the very TOP of the root
        // (y=0, UNDER the translucent dark-glass nav bar) so the chat scrolls THROUGH
        // the bar, blurred — the Claude-app top-bar feel. Because the view now underlaps
        // the bar, iOS reports env(safe-area-inset-top) = the bar's bottom INSIDE the
        // WebView, and the web (gated on `alma-native-hdr`) turns that inset into the
        // chat scroll area's CONTENT top padding: the first message clears the bar at
        // rest, later messages pass under it. Every OTHER tab stays pinned below the bar
        // (safe-area top) — their pages are opaque and must not underlap. On build 28 the
        // web change is a no-op (env-top there is 0), so the web deploy is safe either way.
        let topAnchor = agentSegments.isEmpty
            ? root.safeAreaLayoutGuide.topAnchor
            : root.topAnchor
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            // FULL height to the safe-area bottom (above the native tab bar → no tab-bar
            // overlap). We deliberately do NOT pin to keyboardLayoutGuide: resizing a
            // WKWebView the instant its input becomes first responder made iOS resign
            // that input — the keyboard dismissed on the very first keystroke and text
            // was dropped (owner report, reproduced on Orders search too). Instead the
            // view stays a stable size and the keyboard OVERLAPS it; we lift the focused
            // field above the keyboard with a scroll-view bottom inset (see keyboard
            // observers), the standard WKWebView pattern that keeps text input alive.
            webView.bottomAnchor.constraint(equalTo: root.safeAreaLayoutGuide.bottomAnchor)
        ])
        startObservingKeyboard()

        // Premium branded loader covering the whole tab during first-paint / navigation.
        // Light wash for the ERP web views (no dark→light flash), deep violet for the
        // dark Assistant. It sits ABOVE the web view and fades out when content is ready.
        loader = AlmaPremiumLoader(style: .light) // agent is now the LIGHT Claude surface too
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
        guard !agentSegments.isEmpty else { return }
        // Agent = the Claude surface: a fixed "ALMA AI" title in the native LIGHT frosted
        // header, with Claude-exact bar buttons — LEFT a frosted-white hamburger (opens the
        // agent sidebar), RIGHT a SOLID CORAL compose bubble (new chat) — driving the web
        // agent's own controls. The light web top bar is hidden (hideWebHeader).
        navigationItem.title = "ALMA AI"
        navigationItem.leftBarButtonItem = Self.glassBarButton(
            icon: "line.3.horizontal", target: self, action: #selector(agentHistory), light: true)
        navigationItem.rightBarButtonItem = Self.coralBarButton(
            icon: "square.and.pencil", target: self, action: #selector(agentNewChat))
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
        container.layer.borderColor = (light ? UIColor(white: 0, alpha: 0.10) : UIColor(white: 1, alpha: 0.18)).cgColor
        container.layer.shadowColor = UIColor.black.cgColor
        container.layer.shadowOpacity = light ? 0.12 : 0
        container.layer.shadowRadius = 4
        container.layer.shadowOffset = CGSize(width: 0, height: 1)
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
        container.layer.shadowColor = coral.cgColor
        container.layer.shadowOpacity = 0.40
        container.layer.shadowRadius = 6
        container.layer.shadowOffset = CGSize(width: 0, height: 2)
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

    /// GLASS MOTION top inset — inject the EXACT status-bar+nav-bar height into
    /// `--alma-top-inset` so the agent's chat scroll CONTENT can clear the bar (and
    /// scroll under it). We inject it natively instead of relying on the WebView's
    /// `env(safe-area-inset-top)`, which is unreliable here: the plain WKWebView runs
    /// `contentInsetAdjustmentBehavior = .never` (so the web owns all insets), and under
    /// that mode env() does not track the underlapped nav bar. Same proven bridge as
    /// `--kb-inset`. Agent tab only; the web falls back to env() when the var is absent
    /// (older builds / non-native), so this is additive and safe.
    private func setAgentTopInset() {
        guard !agentSegments.isEmpty else { return }
        let px = Int(view.safeAreaInsets.top.rounded())
        webView?.evaluateJavaScript(
            "document.documentElement.style.setProperty('--alma-top-inset','\(px)px');",
            completionHandler: nil)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        setAgentTopInset()
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
        setAgentTopInset() // re-assert the glass-motion top inset on the fresh DOM
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
                icon: "chevron.backward", target: self, action: #selector(goBackTapped))
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
        Section(header: "Workspace", items: [
            Item(title: "My Desk",        icon: "person.crop.square",  path: "/portal"),
            Item(title: "Office",         icon: "building.2",          path: "/portal/office"),
            Item(title: "Product Images", icon: "photo.on.rectangle",  path: "/agent/catalog-images"),
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
        tableView.backgroundColor = UIColor(red: 0.043, green: 0.039, blue: 0.063, alpha: 1) // #0b0a10
    }

    // Section 0 = the business switcher; sections 1… = the module groups.
    override func numberOfSections(in tableView: UITableView) -> Int { sections.count + 1 }
    override func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int {
        s == 0 ? businesses.count : sections[s - 1].items.count
    }
    override func tableView(_ t: UITableView, titleForHeaderInSection s: Int) -> String? {
        s == 0 ? "Switch business" : sections[s - 1].header
    }

    override func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let rowBg = UIColor(red: 0.086, green: 0.078, blue: 0.122, alpha: 1) // #16141f
        if ip.section == 0 {
            let biz = businesses[ip.row]
            let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
            var cfg = cell.defaultContentConfiguration()
            cfg.text = biz.name
            cfg.secondaryText = biz.tagline
            cfg.secondaryTextProperties.color = UIColor(white: 1, alpha: 0.5)
            cfg.image = UIImage(systemName: biz.symbol,
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 26))
            cfg.imageProperties.tintColor = biz.color
            cfg.imageToTextPadding = 12
            cell.contentConfiguration = cfg
            cell.backgroundColor = rowBg
            cell.accessoryType = .disclosureIndicator
            return cell
        }
        let item = sections[ip.section - 1].items[ip.row]
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        var cfg = cell.defaultContentConfiguration()
        cfg.text = item.title
        cfg.image = UIImage(systemName: item.icon)
        cfg.imageProperties.tintColor = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)
        cell.contentConfiguration = cfg
        cell.backgroundColor = rowBg
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        let base = "https://alma-erp-six.vercel.app"
        let path: String, tabTitle: String, symbol: String
        if ip.section == 0 {
            let biz = businesses[ip.row]
            path = biz.path; tabTitle = biz.name; symbol = biz.symbol
        } else {
            let item = sections[ip.section - 1].items[ip.row]
            path = item.path; tabTitle = item.title; symbol = item.icon
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
    private static let base = "https://alma-erp-six.vercel.app"

    /// - Parameter dashboard: the storyboard's Capacitor bridge VC, reused as tab 0.
    init(dashboard: UIViewController) {
        super.init(nibName: nil, bundle: nil)

        // The Dashboard (Capacitor) tab gets a native header too (S3) — give the VC a
        // title for that header and wrap it in a dark nav controller below, like the
        // other content tabs. Its web page-header is hidden via AlmaBridgeViewController.
        dashboard.title = "Dashboard"

        let pool = WKProcessPool()

        // Content tabs that get a NATIVE header (title synced from the web route via
        // the almaShell bridge) + back button + swipe-back — wrapped in a dark nav
        // controller. Assistant keeps its own in-page header, and the Dashboard is
        // the Capacitor VC, so those two are not wrapped.
        func webNavTab(_ path: String, _ title: String, _ icon: String) -> UINavigationController {
            let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: pool,
                                              tabTitle: title, systemImage: icon,
                                              hideWebHeader: true)
            return Self.darkNav(root: vc, tabTitle: title, icon: icon, largeTitles: false)
        }
        // Assistant = the "Claude" surface: a native segmented control (Chat / Studio /
        // WhatsApp / Monitor / Costs) at the top replaces the web sub-nav that used to
        // stack above the native tab bar (the "double bottom bar"). Each segment loads
        // its /agent route in the shared web view.
        func agentURL(_ p: String) -> URL { URL(string: Self.base + p)! }
        let assistant = AlmaWebTabViewController(
            url: agentURL("/agent"), processPool: pool,
            tabTitle: "Assistant", systemImage: "sparkles",
            hideWebHeader: true,   // native dark-glass header replaces the light web top bar
            agentSegments: [
                ("Chat", agentURL("/agent")),
                ("Studio", agentURL("/agent/creative-studio")),
                ("WhatsApp", agentURL("/agent/whatsapp")),
                ("Monitor", agentURL("/agent/staff-monitor")),
                ("Costs", agentURL("/agent/costs")),
            ])
        let assistantNav = Self.darkNav(root: assistant, tabTitle: "Assistant",
                                        icon: "sparkles", largeTitles: false, light: true)

        // "More" is a NATIVE menu whose rows push web screens with a native slide.
        let moreNav = Self.darkNav(root: MoreMenuViewController(processPool: pool),
                                   tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)

        viewControllers = [
            Self.darkNav(root: dashboard, tabTitle: "Dashboard", icon: "square.grid.2x2", largeTitles: false),
            webNavTab("/orders",    "Orders",    "shippingbox"),
            assistantNav,
            webNavTab("/approvals", "Approvals", "checkmark.seal"),
            moreNav,
        ]

        delegate = self
        applyDarkAppearance()
        selection.prepare()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    /// A frosted-glass UINavigationController wrapping `root`, with a tab item.
    /// `light: true` = the CLAUDE-style LIGHT frosted bar (ultra-thin white material, dark
    /// title, content scrolls UNDER it and blurs THROUGH clearly) — used for the Assistant.
    /// `light: false` = the dark violet frosted bar for the ERP tabs.
    static func darkNav(root: UIViewController, tabTitle: String, icon: String, largeTitles: Bool, light: Bool = false) -> UINavigationController {
        let nav = UINavigationController(rootViewController: root)
        nav.navigationBar.prefersLargeTitles = largeTitles
        let a = UINavigationBarAppearance()
        a.configureWithDefaultBackground()
        a.shadowColor = .clear                       // no hard hairline; soft layer shadow instead
        if light {
            // CLAUDE glass: use the STANDARD iOS translucent nav-bar material (the same
            // systemChromeMaterial Claude uses) — forced to a LIGHT interface so it reads as
            // clean frosted WHITE and the chat blurs THROUGH it as it scrolls under. Do NOT
            // override backgroundEffect/backgroundColor — the ultra-thin+tint override read
            // muddy grey; the plain default background is the authentic frosted bar.
            nav.overrideUserInterfaceStyle = .light
            let darkTitle = UIColor(red: 0.13, green: 0.11, blue: 0.16, alpha: 1)
            a.largeTitleTextAttributes = [.foregroundColor: darkTitle]
            a.titleTextAttributes = [.foregroundColor: darkTitle]
            nav.navigationBar.standardAppearance = a
            nav.navigationBar.scrollEdgeAppearance = a
            nav.navigationBar.tintColor = darkTitle
            nav.navigationBar.layer.shadowColor = UIColor.black.cgColor
            nav.navigationBar.layer.shadowOpacity = 0.10
            nav.navigationBar.layer.shadowRadius = 8
            nav.navigationBar.layer.shadowOffset = CGSize(width: 0, height: 2)
        } else {
            nav.overrideUserInterfaceStyle = .dark
            a.backgroundEffect = UIBlurEffect(style: .systemThinMaterialDark) // stronger see-through blur
            a.backgroundColor = UIColor(red: 0.20, green: 0.14, blue: 0.38, alpha: 0.42) // light violet veil
            a.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
            a.titleTextAttributes = [.foregroundColor: UIColor.white]
            nav.navigationBar.standardAppearance = a
            nav.navigationBar.scrollEdgeAppearance = a
            nav.navigationBar.tintColor = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)
            nav.navigationBar.layer.shadowColor = UIColor.black.cgColor
            nav.navigationBar.layer.shadowOpacity = 0.28
            nav.navigationBar.layer.shadowRadius = 10
            nav.navigationBar.layer.shadowOffset = CGSize(width: 0, height: 3)
        }
        nav.tabBarItem = UITabBarItem(
            title: tabTitle,
            image: UIImage(systemName: icon),
            selectedImage: UIImage(systemName: icon + ".fill") ?? UIImage(systemName: icon))
        return nav
    }

    private func applyDarkAppearance() {
        overrideUserInterfaceStyle = .dark
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(red: 0.055, green: 0.047, blue: 0.078, alpha: 1) // ~#0e0c14
        let violet = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1) // #a78bfa
        let muted = UIColor(white: 1, alpha: 0.45)
        for item in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance] {
            item.selected.iconColor = violet
            item.selected.titleTextAttributes = [.foregroundColor: violet]
            item.normal.iconColor = muted
            item.normal.titleTextAttributes = [.foregroundColor: muted]
        }
        tabBar.standardAppearance = appearance
        tabBar.scrollEdgeAppearance = appearance
        tabBar.tintColor = violet
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
