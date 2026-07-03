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

/// The embed user-script shared by every tab (and the Capacitor web view): hide the
/// web's own bottom nav so the native tab bar is the only chrome. Idempotent.
enum AlmaEmbed {
    static func userScript() -> WKUserScript {
        let js = """
        (function(){var id='__alma_native_embed';
        if(document.getElementById(id))return;
        var s=document.createElement('style');s.id=id;
        s.textContent='.mobile-app-chrome{display:none !important}';
        (document.head||document.documentElement).appendChild(s);})();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
    }
}

/// One content tab = a full-screen web view onto an ERP route, sharing the session
/// and hiding the web's own bottom nav.
final class AlmaWebTabViewController: UIViewController, WKNavigationDelegate {
    private let url: URL
    private let sharedProcessPool: WKProcessPool
    private var webView: WKWebView!
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(url: URL, processPool: WKProcessPool, tabTitle: String, systemImage: String) {
        self.url = url
        self.sharedProcessPool = processPool
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
        content.addUserScript(AlmaEmbed.userScript())

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
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }
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
            tabTitle: item.title, systemImage: item.icon)
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
        func tab(_ path: String, _ title: String, _ icon: String) -> AlmaWebTabViewController {
            AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: pool,
                                     tabTitle: title, systemImage: icon)
        }
        // "More" is a NATIVE menu wrapped in a nav controller so its rows push web
        // screens with a native slide + swipe-back (fixes the old /settings 404).
        let moreNav = UINavigationController(rootViewController: MoreMenuViewController(processPool: pool))
        moreNav.navigationBar.prefersLargeTitles = true
        moreNav.overrideUserInterfaceStyle = .dark
        let navA = UINavigationBarAppearance()
        navA.configureWithOpaqueBackground()
        navA.backgroundColor = UIColor(red: 0.055, green: 0.047, blue: 0.078, alpha: 1)
        navA.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
        navA.titleTextAttributes = [.foregroundColor: UIColor.white]
        moreNav.navigationBar.standardAppearance = navA
        moreNav.navigationBar.scrollEdgeAppearance = navA
        moreNav.navigationBar.tintColor = UIColor(red: 0.655, green: 0.545, blue: 0.980, alpha: 1)
        moreNav.tabBarItem = UITabBarItem(
            title: "More",
            image: UIImage(systemName: "ellipsis.circle"),
            selectedImage: UIImage(systemName: "ellipsis.circle.fill"))

        viewControllers = [
            dashboard,
            tab("/orders",    "Orders",    "shippingbox"),
            tab("/agent",     "Assistant", "sparkles"),
            tab("/approvals", "Approvals", "checkmark.seal"),
            moreNav,
        ]

        delegate = self
        applyDarkAppearance()
        selection.prepare()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

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
