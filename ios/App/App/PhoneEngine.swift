//
//  PhoneEngine.swift
//  ALMA ERP — the audio engine behind the native phone screen.
//
//  The native dialler (PhoneSwiftUI) is pure SwiftUI; the SIP registration and the
//  WebRTC call audio run in THIS hidden WKWebView, loading /agent/phone?headless=1.
//  That page is the same live-proven sip.js stack the browser phone uses (reconnect,
//  keep-alive, transport lessons included) — a native SIP stack would re-learn all of
//  it for zero user-visible gain. The engine is a singleton so the registration
//  SURVIVES tab navigation: leaving the phone screen no longer hangs up the phone.
//
//  Bridge contract (keep in lock-step with SoftphoneHeadless.tsx):
//   native → page:  window.__almaPhone.{connect|disconnect|dial(n)|answer|hangup|
//                   toggleMute|sendDtmf(d)}
//   page → native:  webkit.messageHandlers.almaPhone.postMessage({status, extension,
//                   peer, incoming, muted, seconds, error}) — and {ready:true} once.
//

import Foundation
import UIKit
import WebKit

@available(iOS 17.0, *)
final class PhoneEngine: NSObject, ObservableObject {
    static let shared = PhoneEngine()

    struct State: Equatable {
        var status: String = "idle"      // idle|connecting|registered|ringing|in-call|error
        var ext: String? = nil
        var peer: String? = nil
        var incoming = false
        var muted = false
        var seconds = 0
        var error: String? = nil
    }

    @Published private(set) var state = State()
    /// True once the headless page has installed its bridge (safe to send commands).
    @Published private(set) var ready = false
    /// Loading/navigation failure of the hidden page itself (network, login bounce).
    @Published private(set) var pageError: String? = nil

    private var webView: WKWebView? = nil
    private var pendingConnect = false

    private override init() {
        super.init()
        // Signing into the demo backend swaps the host under us — the engine must not
        // keep a phone registered against the deployment the user just left.
        NotificationCenter.default.addObserver(
            forName: AlmaBackend.didChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.teardown()
        }
    }

    // MARK: - Lifecycle

    /// Create (if needed) and load the hidden engine page. Idempotent.
    @MainActor
    func ensureLoaded() {
        if webView != nil { return }
        pageError = nil
        ready = false

        let content = WKUserContentController()
        content.add(WeakPhoneMessageHandler(self), name: "almaPhone")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()        // shared cookies → shared ERP login
        config.userContentController = content
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
        wv.uiDelegate = self
        wv.navigationDelegate = self
        wv.isUserInteractionEnabled = false
        // Not `isHidden` — a hidden WKWebView may be throttled. Practically invisible
        // instead, parked in a corner under everything.
        wv.alpha = 0.02
        webView = wv

        // WebRTC needs the view in a window to keep running reliably.
        if let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.windows.first {
            window.insertSubview(wv, at: 0)
        }

        var comps = URLComponents(url: AlmaAPI.baseURL, resolvingAgainstBaseURL: false)!
        comps.path = "/agent/phone"
        comps.queryItems = [URLQueryItem(name: "headless", value: "1")]
        wv.load(URLRequest(url: comps.url!))
    }

    /// Tear the engine down entirely (also drops any registration). Used on backend
    /// switch; ordinary "বন্ধ" just sends disconnect and keeps the page warm.
    @MainActor
    func teardown() {
        webView?.removeFromSuperview()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "almaPhone")
        webView = nil
        ready = false
        pendingConnect = false
        state = State()
    }

    // MARK: - Commands

    @MainActor func connect() {
        ensureLoaded()
        if ready { js("connect()") } else { pendingConnect = true }
    }
    @MainActor func disconnect() { js("disconnect()") }
    @MainActor func dial(_ number: String) {
        let digits = number.filter { "0123456789*#".contains($0) }
        guard !digits.isEmpty else { return }
        js("dial('\(digits)')")
    }
    @MainActor func answer() { js("answer()") }
    @MainActor func hangup() { js("hangup()") }
    @MainActor func toggleMute() { js("toggleMute()") }
    @MainActor func sendDtmf(_ digit: String) {
        guard let d = digit.first, "0123456789*#".contains(d) else { return }
        js("sendDtmf('\(d)')")
    }

    @MainActor private func js(_ call: String) {
        webView?.evaluateJavaScript("window.__almaPhone && window.__almaPhone.\(call)") { _, _ in }
    }

    // MARK: - Page → native

    fileprivate func handleMessage(_ body: Any) {
        guard let d = body as? [String: Any] else { return }
        DispatchQueue.main.async {
            if (d["ready"] as? Bool) == true {
                self.ready = true
                self.pageError = nil
                if self.pendingConnect { self.pendingConnect = false; self.js("connect()") }
                return
            }
            var s = State()
            s.status = (d["status"] as? String) ?? "idle"
            s.ext = d["extension"] as? String
            s.peer = d["peer"] as? String
            s.incoming = (d["incoming"] as? Bool) ?? false
            s.muted = (d["muted"] as? Bool) ?? false
            s.seconds = (d["seconds"] as? NSNumber)?.intValue ?? 0
            s.error = d["error"] as? String
            self.state = s
        }
    }
}

// MARK: - WKUIDelegate / WKNavigationDelegate

@available(iOS 17.0, *)
extension PhoneEngine: WKUIDelegate, WKNavigationDelegate {
    /// Auto-GRANT mic for our own origin — same rule as the visible web tabs. iOS
    /// still shows its one-time system mic prompt, which is the only one wanted.
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

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.async { self.pageError = error.localizedDescription }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.async { self.pageError = error.localizedDescription }
    }
}

/// Weak forwarding handler — WKUserContentController retains its handlers strongly,
/// which would otherwise cycle-retain the engine's web view.
@available(iOS 17.0, *)
private final class WeakPhoneMessageHandler: NSObject, WKScriptMessageHandler {
    weak var engine: PhoneEngine?
    init(_ engine: PhoneEngine) { self.engine = engine }
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        engine?.handleMessage(message.body)
    }
}
