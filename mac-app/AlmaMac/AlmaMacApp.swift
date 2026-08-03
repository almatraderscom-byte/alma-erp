//
//  ALMA for Mac — a thin native shell around the ERP the owner already uses.
//
//  Deliberately small. The web app is the product; this exists so it lives in the
//  Dock and the menu bar like a real Mac app instead of a browser tab he has to
//  hunt for. `?native=1` tells the site to hide its own web chrome, the same flag
//  the iOS shell uses, so one set of screens serves both.
//
import SwiftUI
import WebKit

@main
struct AlmaMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 900, minHeight: 600)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Reload") { NotificationCenter.default.post(name: .almaReload, object: nil) }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

        // Menu-bar presence: the point of a Mac build is that the agent is one
        // click away while he works in other apps.
        MenuBarExtra("ALMA", systemImage: "sparkle") {
            Button("Open ALMA") { NSApp.activate(ignoringOtherApps: true) }
            Divider()
            Button("Agent") { NotificationCenter.default.post(name: .almaNavigate, object: "/agent") }
            Button("Orders") { NotificationCenter.default.post(name: .almaNavigate, object: "/orders") }
            Button("Mac control") { NotificationCenter.default.post(name: .almaNavigate, object: "/agent/mac") }
            Divider()
            Button("Quit") { NSApp.terminate(nil) }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

extension Notification.Name {
    static let almaReload = Notification.Name("almaReload")
    static let almaNavigate = Notification.Name("almaNavigate")
}

struct ContentView: View {
    var body: some View {
        AlmaWebView()
            .ignoresSafeArea()
    }
}

struct AlmaWebView: NSViewRepresentable {
    /// Overridable so a preview build can point at a branch deployment.
    private var baseURL: String {
        ProcessInfo.processInfo.environment["ALMA_BASE_URL"] ?? "https://alma-erp-six.vercel.app"
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // keep his login between launches

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        if let url = URL(string: "\(baseURL)/agent?native=1") {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(baseURL: baseURL) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        private let baseURL: String

        init(baseURL: String) {
            self.baseURL = baseURL
            super.init()
            NotificationCenter.default.addObserver(
                forName: .almaReload, object: nil, queue: .main
            ) { [weak self] _ in self?.webView?.reload() }

            NotificationCenter.default.addObserver(
                forName: .almaNavigate, object: nil, queue: .main
            ) { [weak self] note in
                guard let self, let path = note.object as? String,
                      let url = URL(string: "\(self.baseURL)\(path)?native=1") else { return }
                self.webView?.load(URLRequest(url: url))
                NSApp.activate(ignoringOtherApps: true)
            }
        }

        /// Keep ALMA inside the app and send everything else to the real browser —
        /// a payment page or an OAuth screen belongs in Safari, not in here.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, let host = url.host else {
                decisionHandler(.allow); return
            }
            let isAlma = host.contains("alma-erp") || host.contains("almatraders") || host == "localhost"
            if isAlma {
                decisionHandler(.allow)
            } else {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            }
        }
    }
}
