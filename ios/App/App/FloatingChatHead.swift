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

    /// Create the overlay window + head. Safe to call more than once (no-op after first).
    func install() {
        guard overlay == nil else { return }
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }

        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = .normal + 1          // above the app, below system alerts
        w.backgroundColor = .clear
        let root = UIViewController()
        root.view.backgroundColor = .clear
        w.rootViewController = root
        w.isHidden = false

        let b = FloatingHeadButton(frame: CGRect(x: 0, y: 0, width: size, height: size))
        b.onTap = { [weak self] in self?.openChat() }
        b.onLongPress = { [weak self] in self?.openQuickActions() }
        b.onDragChanged = { [weak self] center in self?.button?.center = center }
        b.onDragEnded = { [weak self] center in self?.snap(to: center) }
        root.view.addSubview(b)
        button = b

        overlay = w
        DispatchQueue.main.async { [weak self] in self?.placeInitial() }
        startCallWatch()
    }

    // ── App-wide incoming-call ring ───────────────────────────────────────────
    // Polls the intercom feed on ANY screen so a staff member's phone rings a real
    // incoming call (native, loud) wherever they are — not only on the intercom tab.

    private func startCallWatch() {
        guard callWatch == nil else { return }
        callWatch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.pollIncoming() }
        }
    }

    @MainActor private func pollIncoming() async {
        guard !incomingUp,
              overlay?.rootViewController?.presentedViewController == nil else { return }
        if AgoraIntercom.shared.mode == .calling || AgoraIntercom.shared.mode == .ringing { return }
        guard let inc = await AgoraIntercom.shared.pendingIncomingCall() else { return }
        incomingUp = true
        let host = ChatHostController(rootView: IncomingCallView(incoming: inc))
        host.modalPresentationStyle = .overFullScreen
        host.view.backgroundColor = .clear
        host.onDisappear = { [weak self] in
            self?.incomingUp = false
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.button?.isHidden = false
            }
        }
        button?.isHidden = true
        overlay?.rootViewController?.present(host, animated: true)
    }

    private func placeInitial() {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        let savedY = CGFloat(UserDefaults.standard.double(forKey: posKey))
        let minY = inset.top + size / 2 + 44
        let maxY = w.bounds.height - inset.bottom - size / 2 - 70
        let y = savedY > 0 ? min(max(savedY, minY), maxY) : w.bounds.height * 0.60
        b.center = CGPoint(x: w.bounds.width - margin - size / 2, y: y)
    }

    private func snap(to center: CGPoint) {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        onRight = center.x >= w.bounds.width / 2
        let x = onRight ? w.bounds.width - margin - size / 2 : margin + size / 2
        let minY = inset.top + size / 2 + 44
        let maxY = w.bounds.height - inset.bottom - size / 2 - 70
        let y = min(max(center.y, minY), maxY)
        UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.62,
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
        if #available(iOS 17.0, *) { present(OfficeChatStandalone()) }
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

        let icon = UIImageView(image: UIImage(
            systemName: "bubble.left.and.bubble.right.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 23, weight: .semibold)))
        icon.tintColor = .white
        icon.contentMode = .center
        icon.frame = bounds
        icon.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(icon)

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
