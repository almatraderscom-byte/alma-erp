//
//  FloatingChatHead.swift
//  ALMA ERP — the owner's signature ask: a Messenger-style chat head that floats over the
//  WHOLE app (WebView + native screens). Drag it anywhere, it snaps to the nearest side edge,
//  and a tap opens the office group chat over whatever is on screen.
//
//  Implementation: a dedicated passthrough UIWindow one level above the app window. Its root
//  view is transparent and only the head button captures touches — every other touch falls
//  straight through to the app underneath, so nothing else is affected.
//

import UIKit
import SwiftUI

/// A window whose empty areas are transparent to touches — only real subviews (the head)
/// intercept; everything else passes through to the app window below.
final class PassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event) else { return nil }
        // The transparent root view itself must never swallow a touch.
        return hit == rootViewController?.view ? nil : hit
    }
}

/// UIHostingController that reports when it disappears, so the head can reappear after the
/// chat closes.
final class ChatHostController<Content: View>: UIHostingController<Content> {
    var onDisappear: (() -> Void)?
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        onDisappear?()
    }
}

@available(iOS 17.0, *)
final class FloatingChatHead {
    static let shared = FloatingChatHead()
    private init() {}

    private var overlay: PassthroughWindow?
    private var button: FloatingHeadButton?
    private let size: CGFloat = 60
    private let margin: CGFloat = 12
    private let posKey = "office.chathead.y"
    private var onRight = true
    private var callWatch: Timer?
    private var incomingUp = false
    private var suppressionReasons: Set<String> = []

    /// Contextual native sheets own the full interaction plane. Hide the global
    /// chat head while one is presented so it cannot cover or intercept a row;
    /// restore it as soon as the presentation ends.
    func setSuppressed(_ suppressed: Bool, reason: String) {
        if suppressed { suppressionReasons.insert(reason) }
        else { suppressionReasons.remove(reason) }
        overlay?.isHidden = !suppressionReasons.isEmpty
    }

    /// Create the overlay window + head. Safe to call more than once (no-op after first).
    func install() {
        guard overlay == nil else { return }
        // IOSP-2: shared scene lookup + z-order via AlmaOverlayCoordinator.
        guard let scene = AlmaOverlayCoordinator.shared.foregroundScene() else { return }

        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = AlmaOverlayCoordinator.Level.chatHead
        w.backgroundColor = .clear
        let root = UIViewController()
        root.view.backgroundColor = .clear
        w.rootViewController = root
        w.isHidden = !suppressionReasons.isEmpty

        let b = FloatingHeadButton(frame: CGRect(x: 0, y: 0, width: size, height: size))
        b.onTap = { [weak self] in self?.openChat() }
        b.onLongPress = { [weak self] in self?.openQuickActions() }
        b.onDragChanged = { [weak self] center in self?.button?.center = center }
        b.onDragEnded = { [weak self] center in self?.snap(to: center) }
        root.view.addSubview(b)
        button = b

        overlay = w
        DispatchQueue.main.async { [weak self] in self?.placeInitial() }
        // IOSP-2: when the keyboard rises (or the tab-bar exclusion changes), lift
        // the head above it so it never sits under the keyboard/composer.
        NotificationCenter.default.addObserver(
            self, selector: #selector(exclusionChanged),
            name: AlmaOverlayCoordinator.keyboardDidChange, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(callCoordinatorChanged),
            name: .officeCallCoordinatorDidChange, object: nil)
        startCallWatch()
    }

    #if DEBUG
    /// IOSP-2 test hook: park the head at the bottom exclusion edge so a subsequent
    /// keyboard-raise visibly lifts it (proves the exclusion actually moves it).
    func debugParkAtBottomEdge() {
        guard let w = overlay, let b = button else { return }
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(inWindow: w, overlayHeight: size)
        b.center = CGPoint(x: b.center.x, y: maxY)
        AlmaPerfLog.event("chatHead.parked", "y=\(Int(maxY)) winH=\(Int(w.bounds.height)) kb=\(Int(AlmaOverlayCoordinator.shared.keyboardHeight))")
    }
    #endif

    /// Re-clamp the head into the current exclusion zone (keyboard/tab bar).
    @objc private func exclusionChanged() {
        guard let w = overlay, let b = button else { return }
        let minY = w.safeAreaInsets.top + size / 2 + 44
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(inWindow: w, overlayHeight: size)
        let y = min(max(b.center.y, minY), max(minY, maxY))
        #if DEBUG
        AlmaPerfLog.event("chatHead.exclusion", "from=\(Int(b.center.y)) to=\(Int(y)) maxY=\(Int(maxY)) kb=\(Int(AlmaOverlayCoordinator.shared.keyboardHeight))")
        #endif
        guard abs(y - b.center.y) > 0.5 else { return }
        let animate = !AlmaOverlayCoordinator.shared.reduceMotion
        UIView.animate(withDuration: animate ? 0.26 : 0, delay: 0,
                       usingSpringWithDamping: 0.8, initialSpringVelocity: 0.4,
                       options: [.allowUserInteraction]) {
            b.center = CGPoint(x: b.center.x, y: y)
        }
    }

    // ── App-wide incoming-call ring ───────────────────────────────────────────
    // Polls the intercom feed on ANY screen so a staff member's phone rings a real
    // incoming call (native, loud) wherever they are — not only on the intercom tab.

    private func startCallWatch() {
        // IOSP-4: the 3s intercom poll is scene-aware. Foregrounded it keeps 3s so a
        // staff call rings promptly (owner's WhatsApp-style requirement); when the
        // app is backgrounded there is no UI to ring and PushKit/CallKit VoIP
        // (CallKitVoIP.start()) already delivers background calls — so the timer is
        // SUSPENDED in the background and resumed on foreground. This removes the
        // app-wide 3s polling whenever the related UI can't be active. (Full
        // push-only replacement foreground is a server-realtime change tracked for
        // a later phase — see the IOSP-4 report's evidence-backed exception.)
        NotificationCenter.default.addObserver(
            self, selector: #selector(resumeCallWatch),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(suspendCallWatch),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        resumeCallWatch()
    }

    @objc private func resumeCallWatch() {
        guard callWatch == nil else { return }
        AlmaPerfLog.event("callWatch.resume")
        callWatch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.pollIncoming() }
        }
    }

    @objc private func suspendCallWatch() {
        guard callWatch != nil else { return }
        AlmaPerfLog.event("callWatch.suspend")
        callWatch?.invalidate()
        callWatch = nil
    }

    @objc private func callCoordinatorChanged() {
        let active = OfficeCallCoordinator.shared.hasActiveCall
        button?.setCallActive(active)
    }

    @MainActor private func pollIncoming() async {
        guard !incomingUp,
              overlay?.rootViewController?.presentedViewController == nil else { return }
        if OfficeCallCoordinator.shared.hasActiveCall { return }
        guard let inc = await AgoraIntercom.shared.pendingIncomingCall() else { return }
        // Foreground fallback still enters the exact same CallKit/coordinator path
        // as PushKit. No second custom call lifecycle exists.
        CallKitVoIP.shared.showIncomingFromPoll(
            callId: inc.broadcastId, channel: inc.channel, caller: inc.caller)
    }

    private func placeInitial() {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        let savedY = CGFloat(UserDefaults.standard.double(forKey: posKey))
        let minY = inset.top + size / 2 + 44
        // IOSP-2: bottom clamp is now the shared tab-bar/keyboard exclusion, not a
        // magic -70. Keeps the head off the tab bar and above any live keyboard.
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(inWindow: w, overlayHeight: size)
        let y = savedY > 0 ? min(max(savedY, minY), max(minY, maxY)) : w.bounds.height * 0.60
        b.center = CGPoint(x: w.bounds.width - margin - size / 2, y: y)
    }

    private func snap(to center: CGPoint) {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        onRight = center.x >= w.bounds.width / 2
        let x = onRight ? w.bounds.width - margin - size / 2 : margin + size / 2
        let minY = inset.top + size / 2 + 44
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(inWindow: w, overlayHeight: size)
        let y = min(max(center.y, minY), max(minY, maxY))
        let animate = !AlmaOverlayCoordinator.shared.reduceMotion
        UIView.animate(withDuration: animate ? 0.38 : 0, delay: 0, usingSpringWithDamping: 0.62,
                       initialSpringVelocity: 0.6, options: [.allowUserInteraction]) {
            b.center = CGPoint(x: x, y: y)
        }
        UserDefaults.standard.set(Double(y), forKey: posKey)
    }

    private func present<Content: View>(_ view: Content, fullScreen: Bool = false) {
        guard let w = overlay, let root = w.rootViewController else { return }
        // Dismiss anything already up (e.g. the quick-actions sheet) before presenting.
        let target = root.presentedViewController ?? root
        button?.isHidden = true
        let host = ChatHostController(rootView: view)
        host.onDisappear = { [weak self] in
            // Only restore the head once nothing is presented over the overlay.
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.button?.isHidden = false
            }
        }
        if fullScreen {
            host.modalPresentationStyle = .overFullScreen
            host.view.backgroundColor = .clear
        }
        target.present(host, animated: true)
    }

    private func openChat() {
        if #available(iOS 17.0, *) {
            if OfficeCallCoordinator.shared.hasActiveCall { openIntercom() }
            else { present(OfficeChatStandalone()) }
        }
    }

    private func openIntercom() {
        if #available(iOS 17.0, *) { present(IntercomView()) }
    }

    private func openQuickActions() {
        guard #available(iOS 17.0, *) else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        guard let root = overlay?.rootViewController else { return }
        button?.isHidden = true
        let actions = ChatHeadQuickActions(
            onChat: { [weak self] in root.dismiss(animated: true) { self?.openChat() } },
            onWalkie: { [weak self] in root.dismiss(animated: true) { self?.openIntercom() } },
            onDismiss: { root.dismiss(animated: true) })
        let host = ChatHostController(rootView: actions)
        host.modalPresentationStyle = .overFullScreen
        host.view.backgroundColor = .clear
        host.onDisappear = { [weak self] in
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.button?.isHidden = false
            }
        }
        root.present(host, animated: true)
    }
}

/// The draggable coral→violet circle with a chat glyph.
final class FloatingHeadButton: UIView {
    var onTap: (() -> Void)?
    var onLongPress: (() -> Void)?
    var onDragChanged: ((CGPoint) -> Void)?
    var onDragEnded: ((CGPoint) -> Void)?

    private let gradient = CAGradientLayer()
    private let iconView = UIImageView()
    private var grabOffset: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = true
        gradient.colors = [
            UIColor(red: 0.902, green: 0.471, blue: 0.369, alpha: 1).cgColor,   // coral
            UIColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1).cgColor,   // violet
        ]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        gradient.cornerRadius = frame.width / 2
        gradient.frame = bounds
        layer.addSublayer(gradient)

        layer.cornerRadius = frame.width / 2
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.28
        layer.shadowRadius = 9
        layer.shadowOffset = CGSize(width: 0, height: 4)

        iconView.image = UIImage(
            systemName: "bubble.left.and.bubble.right.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 23, weight: .semibold))
        iconView.tintColor = .white
        iconView.contentMode = .center
        iconView.frame = bounds
        iconView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(iconView)

        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap)))
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
        longPress.minimumPressDuration = 0.45
        addGestureRecognizer(longPress)
        accessibilityLabel = "অফিস চ্যাট"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
    }

    func setCallActive(_ active: Bool) {
        iconView.image = UIImage(
            systemName: active ? "phone.fill" : "bubble.left.and.bubble.right.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 23, weight: .semibold))
        accessibilityLabel = active ? "চলমান কলে ফিরুন" : "অফিস চ্যাট"
        layer.shadowColor = active ? UIColor.systemGreen.cgColor : UIColor.black.cgColor
    }

    @objc private func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onTap?()
    }

    @objc private func longPress(_ g: UILongPressGestureRecognizer) {
        guard g.state == .began else { return }
        onLongPress?()
    }

    @objc private func pan(_ g: UIPanGestureRecognizer) {
        guard let parent = superview else { return }
        let p = g.location(in: parent)
        switch g.state {
        case .began:
            grabOffset = CGSize(width: center.x - p.x, height: center.y - p.y)
            UIView.animate(withDuration: 0.15) { self.transform = CGAffineTransform(scaleX: 1.12, y: 1.12) }
        case .changed:
            onDragChanged?(CGPoint(x: p.x + grabOffset.width, y: p.y + grabOffset.height))
        case .ended, .cancelled, .failed:
            UIView.animate(withDuration: 0.15) { self.transform = .identity }
            onDragEnded?(CGPoint(x: p.x + grabOffset.width, y: p.y + grabOffset.height))
        default:
            break
        }
    }
}
