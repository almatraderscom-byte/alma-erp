//
//  AlmaCompanion.swift
//  App
//
//  P3 step 2 (docs/agent-computer-use-roadmap.md) — the PHONE companion.
//
//  The ALMA agent can drive a browser on the owner's PHONE the same way it
//  drives his Mac Chrome: this screen registers on the SAME live-browser
//  command bus as the Chrome extension (pair code → hashed bearer token →
//  long-poll /api/assistant/live-browser/poll → execute → POST /result).
//  The web view shares the app's default WKWebsiteDataStore, so sites the
//  owner logged into inside the app stay logged in here.
//
//  Safety model (mirrors the extension, enforced ON DEVICE):
//    • Runs ONLY while this screen is open and the app is foreground — the
//      owner literally watches every step (the strongest form of "owner
//      watches live"). Leaving the screen stops the poll loop instantly.
//    • Native STOP bar: one tap pauses the loop and fails the in-flight
//      command; the kv kill-switch and daily caps stay server-side.
//    • FINAL-SUBMIT BAN in code: the ported click routine refuses
//      Send/Post/Pay/Confirm/Delete-style buttons (same regex as the
//      extension + src/agent/lib/browser/final-submit.ts — keep in sync).
//    • §5.4 lockdown tiers: write verbs carry `lockdownDomains`; we check the
//      web view's REAL current host before clicking/typing.
//    • The agent never sees credentials: pairing is a one-time code the owner
//      types himself; the token only ever lives in UserDefaults.
//

import UIKit
import WebKit

// MARK: - Companion store (token + prefs)

enum AlmaCompanionStore {
    private static let d = UserDefaults.standard
    static var token: String {
        get { d.string(forKey: "alma_companion_token") ?? "" }
        set { d.set(newValue, forKey: "alma_companion_token") }
    }
    static var paused: Bool {
        get { d.bool(forKey: "alma_companion_paused") }
        set { d.set(newValue, forKey: "alma_companion_paused") }
    }
    static let baseURL = "https://alma-erp-six.vercel.app"
    static var isPaired: Bool { !token.isEmpty }
}

// MARK: - The companion screen

final class AlmaCompanionViewController: UIViewController, WKNavigationDelegate {
    private var webView: WKWebView!
    private var statusDot: UIView!
    private var statusLabel: UILabel!
    private var stopButton: UIButton!
    private var polling = false
    private var pollTask: Task<Void, Never>?
    /// Set true by STOP mid-command; the in-flight verb reports failed.
    private var stopRequested = false

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "Agent Companion"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    // MARK: UI

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.039, blue: 0.063, alpha: 1)

        // Native control bar — the owner ALWAYS sees who is driving + can stop.
        let bar = UIView()
        bar.backgroundColor = UIColor(red: 0.086, green: 0.078, blue: 0.122, alpha: 1)
        bar.layer.cornerRadius = 14
        bar.translatesAutoresizingMaskIntoConstraints = false

        statusDot = UIView()
        statusDot.backgroundColor = .systemGray
        statusDot.layer.cornerRadius = 5
        statusDot.translatesAutoresizingMaskIntoConstraints = false

        statusLabel = UILabel()
        statusLabel.text = "সংযোগ হচ্ছে…"
        statusLabel.textColor = UIColor(white: 1, alpha: 0.85)
        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.adjustsFontSizeToFitWidth = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        stopButton = UIButton(type: .system)
        stopButton.setTitle("⏹ STOP", for: .normal)
        stopButton.setTitleColor(.white, for: .normal)
        stopButton.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        stopButton.backgroundColor = UIColor(red: 0.88, green: 0.32, blue: 0.32, alpha: 1)
        stopButton.layer.cornerRadius = 12
        stopButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
        stopButton.addTarget(self, action: #selector(stopTapped), for: .touchUpInside)
        stopButton.translatesAutoresizingMaskIntoConstraints = false

        bar.addSubview(statusDot)
        bar.addSubview(statusLabel)
        bar.addSubview(stopButton)
        view.addSubview(bar)

        // Companion web surface — the default data store is what shares cookies
        // (and therefore the login) with every other webview in the app.
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            bar.heightAnchor.constraint(equalToConstant: 44),

            statusDot.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 14),
            statusDot.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            statusDot.widthAnchor.constraint(equalToConstant: 10),
            statusDot.heightAnchor.constraint(equalToConstant: 10),

            statusLabel.leadingAnchor.constraint(equalTo: statusDot.trailingAnchor, constant: 8),
            statusLabel.trailingAnchor.constraint(equalTo: stopButton.leadingAnchor, constant: -8),
            statusLabel.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            stopButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -10),
            stopButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            webView.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 6),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        webView.load(URLRequest(url: URL(string: "about:blank")!))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !AlmaCompanionStore.isPaired {
            promptForPairingCode()
        } else {
            AlmaCompanionStore.paused = false
            startPolling()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Leaving the screen = hands off. The agent's next command times out
        // server-side with companion_offline_or_busy (same as a closed Chrome).
        stopPolling()
    }

    @objc private func stopTapped() {
        AlmaCompanionStore.paused = true
        stopRequested = true
        stopPolling()
        setStatus(text: "থামানো হয়েছে — আবার চালু করতে স্ক্রিনটা খুলুন", color: .systemRed)
        let alert = UIAlertController(title: "থামানো হয়েছে",
                                      message: "এজেন্টের ফোন-কমপ্যানিয়ন বন্ধ। আবার চালু করবেন?",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "চালু করো", style: .default) { [weak self] _ in
            AlmaCompanionStore.paused = false
            self?.stopRequested = false
            self?.startPolling()
        })
        alert.addAction(UIAlertAction(title: "বন্ধ থাক", style: .cancel))
        present(alert, animated: true)
    }

    private func setStatus(text: String, color: UIColor) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel.text = text
            self?.statusDot.backgroundColor = color
        }
    }

    // MARK: Pairing

    private func promptForPairingCode() {
        let alert = UIAlertController(
            title: "ফোন কমপ্যানিয়ন যুক্ত করুন",
            message: "চ্যাটে এজেন্টকে বলুন: \"live browser pair code দাও\" — তারপর কোডটা এখানে বসান। এজেন্ট তখন এই ফোন দিয়ে কাজ করতে পারবে, আপনি সব লাইভ দেখবেন।",
            preferredStyle: .alert)
        alert.addTextField { tf in
            tf.placeholder = "যেমন: 4F9K-2T7Q"
            tf.autocapitalizationType = .allCharacters
            tf.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "যুক্ত করো", style: .default) { [weak self, weak alert] _ in
            let code = alert?.textFields?.first?.text ?? ""
            self?.redeemPairingCode(code)
        })
        alert.addAction(UIAlertAction(title: "বাতিল", style: .cancel) { [weak self] _ in
            self?.setStatus(text: "যুক্ত করা হয়নি", color: .systemGray)
        })
        present(alert, animated: true)
    }

    private func redeemPairingCode(_ code: String) {
        setStatus(text: "যুক্ত হচ্ছে…", color: .systemYellow)
        guard let url = URL(string: AlmaCompanionStore.baseURL + "/api/assistant/live-browser/pair") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let deviceName = "iPhone (\(UIDevice.current.name))".prefix(40)
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "code": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            "deviceName": String(deviceName),
        ])
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self else { return }
            let body = (try? JSONSerialization.jsonObject(with: data ?? Data())) as? [String: Any]
            if let token = body?["token"] as? String, !token.isEmpty {
                AlmaCompanionStore.token = token
                AlmaCompanionStore.paused = false
                self.setStatus(text: "যুক্ত হয়েছে — এজেন্টের কমান্ডের অপেক্ষায়", color: .systemGreen)
                self.startPolling()
            } else {
                let err = (body?["error"] as? String) ?? "pairing failed"
                self.setStatus(text: "যুক্ত করা যায়নি: \(err)", color: .systemRed)
                DispatchQueue.main.async { self.promptForPairingCode() }
            }
        }.resume()
    }

    // MARK: Poll loop

    private func startPolling() {
        guard !polling, AlmaCompanionStore.isPaired, !AlmaCompanionStore.paused else { return }
        polling = true
        stopRequested = false
        setStatus(text: "সংযুক্ত — অপেক্ষায়", color: .systemGreen)
        pollTask = Task { [weak self] in
            while let self, self.polling, !Task.isCancelled {
                await self.pollOnce()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopPolling() {
        polling = false
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollOnce() async {
        guard AlmaCompanionStore.isPaired, !AlmaCompanionStore.paused else { return }
        guard let url = URL(string: AlmaCompanionStore.baseURL + "/api/assistant/live-browser/poll") else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(AlmaCompanionStore.token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20

        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return }
        if (resp as? HTTPURLResponse)?.statusCode == 401 {
            AlmaCompanionStore.token = ""
            stopPolling()
            setStatus(text: "Pairing বাতিল হয়েছে — নতুন কোড লাগবে", color: .systemRed)
            await MainActor.run { promptForPairingCode() }
            return
        }
        guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cmd = body["command"] as? [String: Any],
              let id = cmd["id"] as? String,
              let action = cmd["action"] as? String
        else { return }

        setStatus(text: "কাজ চলছে: \(banglaVerb(action))", color: .systemYellow)
        let result = await executeCommand(action: action, cmd: cmd)
        await postResult(commandId: id, result: result)
        if polling { setStatus(text: "সংযুক্ত — অপেক্ষায়", color: .systemGreen) }
    }

    private func postResult(commandId: String, result: [String: Any]) async {
        guard let url = URL(string: AlmaCompanionStore.baseURL + "/api/assistant/live-browser/result") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(AlmaCompanionStore.token)", forHTTPHeaderField: "Authorization")
        var payload = result
        payload["commandId"] = commandId
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        _ = try? await URLSession.shared.data(for: req)
    }

    private func banglaVerb(_ action: String) -> String {
        switch action {
        case "navigate": return "পেজ খুলছে"
        case "read_text", "read_dom": return "পড়ছে"
        case "click": return "ক্লিক"
        case "type": return "লিখছে"
        case "press": return "কী চাপছে"
        case "select_option": return "অপশন বাছছে"
        case "screenshot": return "স্ক্রিনশট"
        case "scroll", "scroll_to": return "স্ক্রল"
        default: return action
        }
    }

    // MARK: Command execution

    private static let writeVerbs: Set<String> = ["click", "type", "press", "select_option"]

    private func executeCommand(action: String, cmd: [String: Any]) async -> [String: Any] {
        if stopRequested { return ["ok": false, "error": "owner_stop"] }

        switch action {
        case "ping":
            return ["ok": true, "data": ["pong": true, "device": "phone"]]
        case "wait":
            let ms = min(max((cmd["ms"] as? Double) ?? 1000, 0), 30000)
            try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
            return ["ok": true]
        case "switch_tab", "close_tab":
            return ["ok": false, "error": "not_supported_on_phone (single webview)"]
        default:
            break
        }

        // §5.4 lockdown: refuse writes on a lockdown-tier site (real current host).
        if Self.writeVerbs.contains(action),
           let locked = cmd["lockdownDomains"] as? [String],
           let host = await MainActor.run(body: { webView.url?.host?.lowercased() }) {
            let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            for d in locked {
                let dom = d.lowercased()
                if !dom.isEmpty, bare == dom || bare.hasSuffix("." + dom) {
                    return ["ok": false, "blocked": true,
                            "error": "site_lockdown: \(dom) — এই সাইট read-only তালিকায়; ফোনেও ক্লিক/টাইপ বন্ধ।"]
                }
            }
        }

        switch action {
        case "navigate":
            guard let raw = cmd["url"] as? String,
                  raw.lowercased().hasPrefix("http"),
                  let url = URL(string: raw) else {
                return ["ok": false, "error": "navigate needs http(s) url"]
            }
            return await navigate(to: url)
        case "go_back":
            return await MainActor.run {
                if webView.canGoBack { webView.goBack(); return ["ok": true, "data": ["back": true]] }
                return ["ok": false, "error": "no page to go back to"]
            }
        case "screenshot":
            return await snapshot()
        case "read_text", "read_dom", "click", "type", "press", "select_option",
             "hover", "scroll", "scroll_to":
            return await runPageScript(action: action, cmd: cmd)
        default:
            return ["ok": false, "error": "unsupported action: \(action)"]
        }
    }

    private func navigate(to url: URL) async -> [String: Any] {
        await MainActor.run { webView.load(URLRequest(url: url)) }
        // Wait for load (didFinish flips the flag) with a 15s budget + settle.
        loadFinished = false
        for _ in 0..<60 {
            if loadFinished { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        return ["ok": true, "data": ["url": url.absoluteString]]
    }

    private var loadFinished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loadFinished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFinished = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFinished = true }

    private func snapshot() async -> [String: Any] {
        await withCheckedContinuation { cont in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return cont.resume(returning: ["ok": false, "error": "gone"]) }
                let cfg = WKSnapshotConfiguration()
                self.webView.takeSnapshot(with: cfg) { image, error in
                    guard let image, let jpeg = image.jpegData(compressionQuality: 0.55) else {
                        return cont.resume(returning: ["ok": false, "error": error?.localizedDescription ?? "snapshot failed"])
                    }
                    cont.resume(returning: ["ok": true, "screenshot": "data:image/jpeg;base64," + jpeg.base64EncodedString()])
                }
            }
        }
    }

    /// Run one ported page routine (same behaviour as the Chrome extension's
    /// injected functions — element lookup by ref/selector/text, React-safe
    /// typing, final-submit ban in the click path).
    private func runPageScript(action: String, cmd: [String: Any]) async -> [String: Any] {
        var args: [String: Any] = [:]
        for key in ["selector", "text", "ref", "value", "option", "key", "by", "ms", "submit"] {
            if let v = cmd[key] { args[key] = v }
        }
        let js = AlmaCompanionJS.dispatcher
        do {
            let result = try await webView.callAsyncJavaScript(
                js,
                arguments: ["action": action, "arg": args],
                contentWorld: .defaultClient)
            if let dict = result as? [String: Any] { return dict }
            return ["ok": false, "error": "no result from page"]
        } catch {
            return ["ok": false, "error": "js: \(error.localizedDescription)"]
        }
    }
}

// MARK: - Ported page routines (single dispatcher, mirrors extension/alma-companion/background.js)

enum AlmaCompanionJS {
    /// One async JS body: (action, arg) → result object. Ported from the Chrome
    /// extension's page functions — keep the final-submit regex in sync with
    /// src/agent/lib/browser/final-submit.ts.
    static let dispatcher = #"""
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const findByRef = (ref) => { try { return document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]'); } catch { return null; } };
    const findBySel = (sel) => { try { return document.querySelector(sel); } catch { return null; } };

    if (action === 'read_text') {
      const t = document.body ? document.body.innerText : '';
      return { ok: true, data: { url: location.href, title: document.title, text: t.slice(0, 12000) } };
    }

    if (action === 'read_dom') {
      const out = [];
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=combobox],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[contenteditable=true]';
      const els = Array.from(document.querySelectorAll(sel)).slice(0, 250);
      let n = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const ref = 'e' + ++n;
        try { el.setAttribute('data-alma-ref', ref); } catch {}
        out.push({
          ref, tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : null),
          name: el.getAttribute('name') || el.getAttribute('aria-label') || null,
          text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
          options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 30).map((o) => (o.text || '').trim()) : undefined,
          id: el.id || null,
        });
      }
      return { ok: true, data: { url: location.href, title: document.title, elements: out } };
    }

    if (action === 'scroll') {
      const by = Number(arg.by) || 600;
      window.scrollBy({ top: by, behavior: 'smooth' });
      return { ok: true, scrolledBy: by };
    }

    if (action === 'scroll_to') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('a,button,h1,h2,h3,h4,li,td,th,span,p,label,[role=button],[role=link]'))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; })
          .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found to scroll to' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      return { ok: true, scrolledTo: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60) };
    }

    if (action === 'hover') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('a,button,li,span,div,[role=button],[role=link],[role=menuitem]'))
          .filter(visible)
          .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found to hover' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
        try { el.dispatchEvent(new MouseEvent(type, opts)); } catch {}
      }
      return { ok: true, hovered: (el.innerText || el.getAttribute('aria-label') || el.tagName || '').trim().slice(0, 60) };
    }

    if (action === 'click') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).trim().toLowerCase();
        const cand = Array.from(document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit],input[type=button],label,summary,[onclick]')).filter(visible);
        const hay = (e) => ((e.innerText || e.value || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).trim().toLowerCase();
        el = cand.find((e) => hay(e) === needle) || cand.find((e) => hay(e).includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found' };
      // FINAL-SUBMIT BAN — keep in sync with final-submit.ts + the extension.
      const finalSubmitRe = new RegExp([
        '\\b(send|post|publish|pay|buy|purchase|confirm|delete|transfer|submit|checkout)\\b',
        '\\bplace\\s+order\\b', '\\border\\s+now\\b',
        'পাঠান', 'পাঠিয়ে\\s*দিন', 'পোস্ট\\s*করুন', 'পাবলিশ', 'প্রকাশ\\s*করুন', 'কিনুন',
        'অর্ডার\\s*করুন', 'নিশ্চিত\\s*করুন', 'কনফার্ম', 'ডিলিট', 'মুছে\\s*ফেলুন', 'সাবমিট', 'পেমেন্ট\\s*করুন',
      ].join('|'), 'i');
      const elLabel = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim().slice(0, 120);
      if (finalSubmitRe.test(elLabel)) {
        return { ok: false, blocked: true, error: 'final_submit_blocked: "' + elLabel.slice(0, 60) + '" — এই শেষ ক্লিকটা owner নিজে চাপবেন।' };
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(350);
      const rect = el.getBoundingClientRect();
      const mo = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      try {
        el.dispatchEvent(new MouseEvent('mouseover', mo));
        el.dispatchEvent(new MouseEvent('mousedown', mo));
        el.dispatchEvent(new MouseEvent('mouseup', mo));
      } catch {}
      el.click();
      return { ok: true, clicked: (el.innerText || el.value || '').trim().slice(0, 60) };
    }

    if (action === 'type') {
      const setValue = (el, val) => {
        if (el.isContentEditable) {
          el.focus();
          try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, val); } catch {}
          if ((el.innerText || el.textContent || '').trim() === '' && val) {
            el.textContent = val;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
          }
          return;
        }
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, val); else el.value = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]')).filter(visible)
          .find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase().includes(needle)) || null;
      }
      if (!el) {
        const a = document.activeElement;
        if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) el = a;
      }
      if (!el) el = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable=true]')).filter(visible)[0] || null;
      if (!el) return { ok: false, error: 'field not found' };
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus();
      await sleep(250);
      const fullText = arg.value == null ? '' : String(arg.value);
      if (fullText.length > 3 && fullText.length <= 200) {
        const chunks = Math.min(6, Math.max(3, Math.ceil(fullText.length / 18)));
        for (let ci = 1; ci < chunks; ci++) {
          setValue(el, fullText.slice(0, Math.ceil((fullText.length * ci) / chunks)));
          await sleep(90);
        }
      }
      setValue(el, fullText);
      if (arg.submit) {
        await sleep(150);
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const kd = new KeyboardEvent('keydown', opts);
        el.dispatchEvent(kd);
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (!kd.defaultPrevented) {
          const form = el.closest && el.closest('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch { try { form.submit(); } catch {} } }
            else { try { form.submit(); } catch {} }
          }
        }
      }
      return { ok: true, typed: fullText, submitted: Boolean(arg.submit) };
    }

    if (action === 'press') {
      const key = String(arg.key || 'Enter');
      const map = {
        Enter: { keyCode: 13, code: 'Enter', k: 'Enter' }, Tab: { keyCode: 9, code: 'Tab', k: 'Tab' },
        Escape: { keyCode: 27, code: 'Escape', k: 'Escape' }, Esc: { keyCode: 27, code: 'Escape', k: 'Escape' },
        ArrowDown: { keyCode: 40, code: 'ArrowDown', k: 'ArrowDown' }, ArrowUp: { keyCode: 38, code: 'ArrowUp', k: 'ArrowUp' },
        ArrowLeft: { keyCode: 37, code: 'ArrowLeft', k: 'ArrowLeft' }, ArrowRight: { keyCode: 39, code: 'ArrowRight', k: 'ArrowRight' },
        Backspace: { keyCode: 8, code: 'Backspace', k: 'Backspace' }, Delete: { keyCode: 46, code: 'Delete', k: 'Delete' },
        Space: { keyCode: 32, code: 'Space', k: ' ' },
      };
      const info = map[key] || { keyCode: 0, code: key, k: key };
      const opts = { key: info.k, code: info.code, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true };
      const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      const kd = new KeyboardEvent('keydown', opts);
      el.dispatchEvent(kd);
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (key === 'Enter' && !kd.defaultPrevented) {
        let form = el.closest && el.closest('form');
        if (!form) {
          const cand = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea')).find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && e.closest('form');
          });
          form = cand && cand.closest('form');
        }
        if (form) {
          if (typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch { try { form.submit(); } catch {} } }
          else { try { form.submit(); } catch {} }
        }
      }
      return { ok: true, pressed: key };
    }

    if (action === 'select_option') {
      const want = String((arg.option != null ? arg.option : arg.value) ?? '');
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('select')).filter(visible)
          .find((s) => ((s.getAttribute('aria-label') || '') + ' ' + (s.name || '') + ' ' + (s.getAttribute('title') || '')).toLowerCase().includes(needle)) || null;
      }
      if (!el) el = Array.from(document.querySelectorAll('select')).filter(visible)[0] || null;
      if (!el) return { ok: false, error: 'select not found' };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'target is not a native <select>' };
      const opts = Array.from(el.options);
      const low = want.trim().toLowerCase();
      const opt = opts.find((o) => (o.text || '').trim().toLowerCase() === low)
        || opts.find((o) => String(o.value).toLowerCase() === low)
        || (low ? opts.find((o) => (o.text || '').trim().toLowerCase().includes(low)) : null);
      if (!opt) return { ok: false, error: 'option not found: ' + want, options: opts.slice(0, 20).map((o) => (o.text || '').trim()) };
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, opt.value); else el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: (opt.text || '').trim(), value: opt.value };
    }

    return { ok: false, error: 'unhandled action: ' + action };
    """#
}
