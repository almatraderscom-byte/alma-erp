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

    init(url: URL, processPool: WKProcessPool, tabTitle: String, systemImage: String, hideWebHeader: Bool = false) {
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
        let bg = UIColor(red: 0.047, green: 0.043, blue: 0.071, alpha: 1) // #0c0b12
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg

        let root = UIView()
        root.backgroundColor = bg
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            // keyboardLayoutGuide handles BOTH: with no keyboard its top sits at the
            // safe-area bottom (above the native tab bar → content no longer hides
            // under it); when the keyboard shows it rides up to the keyboard top (so
            // the web composer lifts with it). Fixes tab-bar overlap AND typing.
            webView.bottomAnchor.constraint(equalTo: root.keyboardLayoutGuide.topAnchor)
        ])

        spinner.color = UIColor(white: 1, alpha: 0.7)
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: root.centerYAnchor)
        ])
        view = root
    }

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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimating()
        updateBackButton()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }

    // MARK: - almaShell bridge (web → native)

    /// Receives the web app's route events and updates the native header title.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let type = body["type"] as? String
        if type == "route" || type == "title" {
            if let t = (body["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                title = t
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
        Section(header: "Money", items: [
            Item(title: "Finance",   icon: "banknote",           path: "/finance"),
            Item(title: "Expenses",  icon: "creditcard",         path: "/expenses"),
            Item(title: "Payroll",   icon: "dollarsign.circle",  path: "/payroll"),
            Item(title: "Invoices",  icon: "doc.text",           path: "/invoice"),
        ]),
        Section(header: "Operations", items: [
            Item(title: "Inventory", icon: "shippingbox",        path: "/inventory"),
            Item(title: "Trading",   icon: "arrow.left.arrow.right", path: "/trading"),
            Item(title: "Digital",   icon: "globe",              path: "/digital"),
            Item(title: "Activity",  icon: "bolt",               path: "/activity"),
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

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    override func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int { sections[s].items.count }
    override func tableView(_ t: UITableView, titleForHeaderInSection s: Int) -> String? { sections[s].header }

    override func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let item = sections[ip.section].items[ip.row]
        let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
        var cfg = cell.defaultContentConfiguration()
        cfg.text = item.title
        cfg.image = UIImage(systemName: item.icon)
        cfg.imageProperties.tintColor = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)
        cell.contentConfiguration = cfg
        cell.backgroundColor = UIColor(red: 0.086, green: 0.078, blue: 0.122, alpha: 1) // #16141f
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        let item = sections[ip.section].items[ip.row]
        let base = "https://alma-erp-six.vercel.app"
        let vc = AlmaWebTabViewController(
            url: URL(string: base + item.path)!, processPool: sharedPool,
            tabTitle: item.title, systemImage: item.icon, hideWebHeader: true)
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

        dashboard.tabBarItem = UITabBarItem(
            title: "Dashboard",
            image: UIImage(systemName: "square.grid.2x2"),
            selectedImage: UIImage(systemName: "square.grid.2x2.fill"))

        let pool = WKProcessPool()

        // Content tabs that get a NATIVE header (title synced from the web route via
        // the almaShell bridge) + back button + swipe-back — wrapped in a dark nav
        // controller. Assistant keeps its own in-page header, and the Dashboard is
        // the Capacitor VC, so those two are not wrapped.
        func webNavTab(_ path: String, _ title: String, _ icon: String) -> UINavigationController {
            let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: pool,
                                              tabTitle: title, systemImage: icon, hideWebHeader: true)
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
            dashboard,
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
        // "Shadow type" header: a translucent dark blur (content scrolls under it)
        // with a soft drop shadow — floating, not a heavy solid black slab.
        let a = UINavigationBarAppearance()
        a.configureWithDefaultBackground()          // system dark blur material
        a.backgroundColor = UIColor(red: 0.055, green: 0.047, blue: 0.078, alpha: 0.72)
        a.shadowColor = .clear                       // no hard hairline; use a soft shadow instead
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
}
