//
//  SpikeNativeShell.swift
//  App
//
//  PHASE S0 — throwaway SPIKE to let the owner FEEL a native app frame on device.
//
//  What it proves (and nothing more):
//    • a real native UITabBarController at the bottom — instant tab switching,
//      each tab's WKWebView stays alive (scroll/state preserved), haptic on switch;
//    • ONE shared login — both tabs use the default WKWebsiteDataStore, so a sign-in
//      in one tab carries to the other (and cookies persist across launches);
//    • NO double navigation — a tiny CSS user-script hides the web's own bottom nav
//      (`.mobile-app-chrome`) so only the native tab bar shows. This is done from the
//      NATIVE side, so NO web deploy and NO change to production is required.
//
//  Deliberately NOT wired to Capacitor: this spike is two plain web views, so the
//  Capacitor plugins (push, Face ID, widgets, Live Activity, background refresh)
//  are inert in THIS build only. That is the accepted cost of a cheap feel-test;
//  Phase S1 rebuilds the same native frame WITH the full Capacitor bridge intact.
//
//  Reachable because AppDelegate makes this the window root for the spike build.
//  To revert: delete this file's use in AppDelegate — the storyboard root
//  (AlmaBridgeViewController) returns unchanged.
//

import UIKit
import WebKit

/// One tab = one full-screen web view onto an ERP route, with the web's own
/// bottom nav hidden so the native tab bar is the only chrome.
final class SpikeWebTabViewController: UIViewController, WKNavigationDelegate {
    private let url: URL
    private let sharedProcessPool: WKProcessPool
    private var webView: WKWebView!
    private let spinner = UIActivityIndicatorView(style: .medium)

    init(url: URL, processPool: WKProcessPool, tabTitle: String, systemImage: String) {
        self.url = url
        self.sharedProcessPool = processPool
        super.init(nibName: nil, bundle: nil)
        tabBarItem = UITabBarItem(
            title: tabTitle,
            image: UIImage(systemName: systemImage),
            selectedImage: UIImage(systemName: systemImage + ".fill") ?? UIImage(systemName: systemImage)
        )
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func loadView() {
        // Inject the "embed mode" CSS from the native side, at document end, on every
        // navigation. Hiding `.mobile-app-chrome` removes the web bottom nav so it
        // can't stack under our native tab bar. Idempotent (guarded by an id).
        let css = ".mobile-app-chrome{display:none !important}"
        let js = """
        (function(){var id='__alma_native_embed';var s=document.getElementById(id);
        if(!s){s=document.createElement('style');s.id=id;s.textContent=\(cssLiteral(css));
        (document.head||document.documentElement).appendChild(s);}})();
        """
        let script = WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: false)

        let content = WKUserContentController()
        content.addUserScript(script)

        let config = WKWebViewConfiguration()
        config.processPool = sharedProcessPool                 // shared session across tabs
        config.websiteDataStore = .default()                    // shared cookies -> shared login
        config.userContentController = content
        config.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.047, green: 0.043, blue: 0.071, alpha: 1) // #0c0b12
        webView.scrollView.backgroundColor = webView.backgroundColor

        let root = UIView()
        root.backgroundColor = webView.backgroundColor
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])

        spinner.color = UIColor(white: 1, alpha: 0.7)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        root.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: root.centerYAnchor)
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        spinner.startAnimating()
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { spinner.stopAnimating() }

    /// Encode a CSS string as a safe JS string literal.
    private func cssLiteral(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
                       .replacingOccurrences(of: "'", with: "\\'")
        return "'\(escaped)'"
    }
}

/// The spike root: a native tab bar hosting the two web tabs, with a dark
/// appearance that matches the app and a haptic tick on every tab switch.
final class SpikeTabBarController: UITabBarController, UITabBarControllerDelegate {
    private let selection = UISelectionFeedbackGenerator()

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self

        let pool = WKProcessPool()
        let base = "https://alma-erp-six.vercel.app"
        let dashboard = SpikeWebTabViewController(
            url: URL(string: base + "/")!, processPool: pool,
            tabTitle: "Dashboard", systemImage: "square.grid.2x2")
        let assistant = SpikeWebTabViewController(
            url: URL(string: base + "/agent")!, processPool: pool,
            tabTitle: "Assistant", systemImage: "sparkles")
        viewControllers = [dashboard, assistant]

        applyDarkAppearance()
        selection.prepare()
    }

    private func applyDarkAppearance() {
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
        overrideUserInterfaceStyle = .dark
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        selection.selectionChanged()
        selection.prepare()
    }
}
