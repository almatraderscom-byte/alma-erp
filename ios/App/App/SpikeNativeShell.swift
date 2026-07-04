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
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let baseTitle: String
    /// When true the web hides its OWN page header (this VC shows a native one), so
    /// there is no double header. Off for Assistant (keeps its in-page header).
    private let hideWebHeader: Bool

    init(url: URL, processPool: WKProcessPool, tabTitle: String, systemImage: String,
         hideWebHeader: Bool = false) {
        self.url = url
        self.sharedProcessPool = processPool
        self.baseTitle = tabTitle
        self.hideWebHeader = hideWebHeader
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
        // Native header title-sync: the web posts {type:'route', path, title} here.
        content.add(WeakScriptMessageHandler(self), name: "almaShell")

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
        root.backgroundColor = bg
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
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

        spinner.color = UIColor(red: 0.42, green: 0.36, blue: 0.62, alpha: 0.75) // violet-gray on the light placeholder
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: root.centerYAnchor)
        ])
        view = root
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
        webView.scrollView.contentInset.bottom = overlap
        webView.scrollView.verticalScrollIndicatorInsets.bottom = overlap
    }

    @objc private func keyboardHide(_ note: Notification) {
        webView?.scrollView.contentInset.bottom = 0
        webView?.scrollView.verticalScrollIndicatorInsets.bottom = 0
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var loadedOnce = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Lazy first load: only fetch a tab's page when the owner first opens it,
        // so four background web views don't all hit the network at launch.
        guard !loadedOnce else { return }
        loadedOnce = true
        spinner.startAnimating()
        webView.load(URLRequest(url: url))
    }

    private var firstPaintDone = false
    private var offlineView: UIView?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimating()
        hideOffline() // a successful load clears any lingering offline screen
        // S3: on the FIRST paint, fade the content in over the light placeholder instead
        // of it popping in abruptly. Later navigations/reloads are instant (alpha == 1).
        if !firstPaintDone {
            firstPaintDone = true
            UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) {
                webView.alpha = 1
            }
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
        spinner.stopAnimating()
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
        spinner.startAnimating()
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

    // MARK: - almaShell bridge (web → native)

    /// Receives the web app's route events and updates the native header title.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let type = body["type"] as? String
        if type == "route" || type == "title" {
            if let t = (body["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                // Only the nav-wrapped tabs (Orders/Approvals/More-pushed) show a native
                // header that needs this title. On the BARE Assistant tab (a direct child
                // of the tab bar, no nav controller) setting `title` makes UITabBarController
                // rebuild its tab bar — and that relayout was corrupting a SIBLING tab's
                // button, so returning to Dashboard showed the Assistant icon/label (owner
                // report, fixed by restart). Skip the title write where it isn't needed.
                if navigationController != nil { title = t }
            }
            updateBackButton()
        }
    }

    /// Show a native back chevron whenever the web view has history to pop; tapping
    /// it (or swiping from the edge) drives the web app's own back navigation.
    private func updateBackButton() {
        // Only relevant when hosted in a nav controller as that stack's root.
        guard navigationController?.viewControllers.first === self else { return }
        if webView?.canGoBack == true {
            navigationItem.leftBarButtonItem = UIBarButtonItem(
                image: UIImage(systemName: "chevron.backward"),
                style: .plain, target: self, action: #selector(goBackTapped))
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
        func plainTab(_ path: String, _ title: String, _ icon: String) -> AlmaWebTabViewController {
            AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: pool,
                                     tabTitle: title, systemImage: icon)
        }

        // "More" is a NATIVE menu whose rows push web screens with a native slide.
        let moreNav = Self.darkNav(root: MoreMenuViewController(processPool: pool),
                                   tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)

        viewControllers = [
            Self.darkNav(root: dashboard, tabTitle: "Dashboard", icon: "square.grid.2x2", largeTitles: false),
            webNavTab("/orders",    "Orders",    "shippingbox"),
            plainTab ("/agent",     "Assistant", "sparkles"),
            webNavTab("/approvals", "Approvals", "checkmark.seal"),
            moreNav,
        ]

        delegate = self
        applyDarkAppearance()
        selection.prepare()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    /// A dark, violet-tinted UINavigationController wrapping `root`, with a tab item.
    static func darkNav(root: UIViewController, tabTitle: String, icon: String, largeTitles: Bool) -> UINavigationController {
        let nav = UINavigationController(rootViewController: root)
        nav.navigationBar.prefersLargeTitles = largeTitles
        nav.overrideUserInterfaceStyle = .dark
        // Aurora-frosted header: a genuine thin blur material so the app's purple
        // aurora + content scroll THROUGH the bar (not a flat violet slab), with just
        // a light violet tint on top so the white title stays readable over both the
        // light (Orders) and dark (Approvals) pages. Soft drop shadow so it floats.
        let a = UINavigationBarAppearance()
        a.configureWithDefaultBackground()
        a.backgroundEffect = UIBlurEffect(style: .systemThinMaterialDark) // stronger see-through blur
        a.backgroundColor = UIColor(red: 0.20, green: 0.14, blue: 0.38, alpha: 0.42) // light violet veil
        a.shadowColor = .clear                       // no hard hairline; soft layer shadow instead
        a.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
        a.titleTextAttributes = [.foregroundColor: UIColor.white]
        nav.navigationBar.standardAppearance = a
        nav.navigationBar.scrollEdgeAppearance = a
        nav.navigationBar.tintColor = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)
        nav.navigationBar.layer.shadowColor = UIColor.black.cgColor
        nav.navigationBar.layer.shadowOpacity = 0.28
        nav.navigationBar.layer.shadowRadius = 10
        nav.navigationBar.layer.shadowOffset = CGSize(width: 0, height: 3)
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
