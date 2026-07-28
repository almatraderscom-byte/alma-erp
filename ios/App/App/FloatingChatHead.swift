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

import Combine
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

/// UIKit-owned state that can change without rebuilding the SwiftUI robot.
@available(iOS 17.0, *)
@MainActor
private final class GlobalOfficeRobotHostState: ObservableObject {
    @Published var isCallActive = false
    @Published var isSuppressed = false
    @Published var isDragging = false
    @Published var dragDirection: OfficeRobotDragDirection = .right
}

/// The one app-wide SwiftUI robot surface. The task store is shared and
/// server-authoritative; the call state remains owned by the existing native
/// CallKit/office-call path.
@available(iOS 17.0, *)
@MainActor
private struct GlobalOfficeRobotView: View {
    @ObservedObject var store: GlobalOfficeRobotStore
    @ObservedObject var hostState: GlobalOfficeRobotHostState
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    let onTap: () -> Void
    let onLongPress: () -> Void

    var body: some View {
        OfficeRobotPetButton(
            isCallActive: hostState.isCallActive,
            taskCount: store.taskCount,
            completionToken: store.completionToken,
            // The robot observes Low Power Mode itself so it can resume live when
            // that setting changes; this input carries the current motion policy.
            reduceMotion: accessibilityReduceMotion,
            isVisible: !hostState.isSuppressed,
            isDragging: hostState.isDragging,
            dragDirection: hostState.dragDirection,
            onTap: onTap,
            onLongPress: onLongPress
        )
    }
}

@available(iOS 17.0, *)
@MainActor
final class FloatingChatHead {
    static let shared = FloatingChatHead()
    private init() {}

    private var overlay: PassthroughWindow?
    private var button: OfficeRobotPetContainerView?
    private var robotHost: UIHostingController<GlobalOfficeRobotView>?
    private let robotHostState = GlobalOfficeRobotHostState()
    /// The robot draws at roughly 64×64. Extra room keeps the task badge,
    /// glow and enlarged accessibility hit target inside the interactive view.
    private let petSize = CGSize(width: 88, height: 88)
    private let margin: CGFloat = 12
    private let posKey = "office.chathead.y"
    private var onRight = true
    private var callWatch: Timer?
    private var incomingUp = false
    private var suppressionReasons: Set<String> = []
    private var presentationHidesRobot = false

    /// Contextual native sheets own the full interaction plane. Hide the global
    /// chat head while one is presented so it cannot cover or intercept a row;
    /// restore it as soon as the presentation ends.
    func setSuppressed(_ suppressed: Bool, reason: String) {
        // The old chat glyph covered the Assistant composer, so the entire
        // Assistant screen suppressed it. The compact Robot is intentionally
        // global; presentation-specific reasons still hide it when required.
        guard reason != "assistant-screen" else { return }
        if suppressed { suppressionReasons.insert(reason) }
        else { suppressionReasons.remove(reason) }
        applyRobotVisibility()
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

        let store = GlobalOfficeRobotStore.shared
        store.install()
        robotHostState.isCallActive = OfficeCallCoordinator.shared.hasActiveCall
        robotHostState.isSuppressed = !suppressionReasons.isEmpty

        let robot = GlobalOfficeRobotView(
            store: store,
            hostState: robotHostState,
            onTap: { [weak self] in self?.openChat() },
            onLongPress: { [weak self] in self?.openQuickActions() }
        )
        let host = UIHostingController(rootView: robot)
        host.view.backgroundColor = .clear

        let b = OfficeRobotPetContainerView(
            frame: CGRect(origin: .zero, size: petSize))
        b.onDragChanged = { [weak self] center, velocityX in
            guard let self else { return }
            let previousX = self.button?.center.x ?? center.x
            let deltaX = center.x - previousX
            let directionSignal = abs(velocityX) >= 18 ? velocityX : deltaX
            if abs(directionSignal) >= 0.5 {
                self.updateDragDirection(
                    velocityX: directionSignal,
                    minimumMagnitude: 0.5
                )
                self.robotHostState.isDragging = true
            }
            self.button?.center = center
        }
        b.onDragEnded = { [weak self] center, velocityX in
            guard let self else { return }
            self.updateDragDirection(velocityX: velocityX)
            self.robotHostState.isDragging = false
            self.snap(to: center)
        }
        root.addChild(host)
        host.view.frame = b.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        b.addSubview(host.view)
        host.didMove(toParent: root)
        root.view.addSubview(b)
        button = b
        robotHost = host

        overlay = w
        applyRobotVisibility()
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
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(
            inWindow: w, overlayHeight: petSize.height)
        b.center = CGPoint(x: b.center.x, y: maxY)
        AlmaPerfLog.event("chatHead.parked", "y=\(Int(maxY)) winH=\(Int(w.bounds.height)) kb=\(Int(AlmaOverlayCoordinator.shared.keyboardHeight))")
    }

    /// Headless Simulator proof for the owner's Robot presentation and motion
    /// state contract. Production touch recognizers still own the real gestures.
    /// DEBUG-only and environment-gated: it exercises the same production
    /// presentation methods and drag state, but never ships in TestFlight.
    func debugRunInteractionSelfTestIfRequested() {
        guard ProcessInfo.processInfo.environment["ALMA_ROBOT_SELFTEST"] == "1" else { return }
        RobotSelfTestTrace.reset()
        AlmaPerfLog.event("robotSelfTest.start")

        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            NotificationCenter.default.post(
                name: .almaOpenPath,
                object: nil,
                userInfo: ["path": "/orders"]
            )
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            AlmaPerfLog.event("robotSelfTest.longPress")
            self?.openQuickActions {
                RobotSelfTestTrace.mark("robotSelfTest.longPress")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            AlmaPerfLog.event("robotSelfTest.tapChat")
            self?.openChat {
                RobotSelfTestTrace.mark("robotSelfTest.tapChat")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            AlmaPerfLog.event("robotSelfTest.openCall")
            self?.openIntercom {
                RobotSelfTestTrace.mark("robotSelfTest.openCall")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 19) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 21) { [weak self] in
            self?.debugAnimateDirectionalDrag()
        }
    }

    private func debugDismissRobotPresentation() {
        overlay?.rootViewController?.dismiss(animated: true)
    }

    private func debugAnimateDirectionalDrag() {
        guard let w = overlay, let b = button else { return }
        presentationHidesRobot = false
        applyRobotVisibility()
        robotHostState.isDragging = true

        let left = CGPoint(
            x: margin + petSize.width / 2 + 24,
            y: min(b.center.y + 70, w.bounds.height * 0.68)
        )
        let right = CGPoint(
            x: w.bounds.width - margin - petSize.width / 2 - 24,
            y: max(b.center.y - 50, w.bounds.height * 0.38)
        )

        robotHostState.dragDirection = .left
        UIView.animate(
            withDuration: 2.2,
            delay: 0,
            options: [.curveLinear, .allowUserInteraction]
        ) {
            b.center = left
        } completion: { [weak self] _ in
            guard let self else { return }
            self.robotHostState.dragDirection = .right
            UIView.animate(
                withDuration: 2.2,
                delay: 0,
                options: [.curveLinear, .allowUserInteraction]
            ) {
                b.center = right
            } completion: { [weak self] _ in
                guard let self else { return }
                self.robotHostState.dragDirection = .left
                UIView.animate(
                    withDuration: 1.7,
                    delay: 0,
                    options: [.curveLinear, .allowUserInteraction]
                ) {
                    b.center = left
                } completion: { [weak self] _ in
                    guard let self else { return }
                    self.robotHostState.isDragging = false
                    self.snap(to: left)
                    RobotSelfTestTrace.mark("robotSelfTest.dragDone")
                    AlmaPerfLog.event("robotSelfTest.dragDone")
                    RobotSelfTestTrace.mark("robotSelfTest.completed")
                    AlmaPerfLog.event("robotSelfTest.completed")
                }
            }
        }
    }
    #endif

    /// Re-clamp the head into the current exclusion zone (keyboard/tab bar).
    @objc private func exclusionChanged() {
        guard let w = overlay, let b = button else { return }
        let minY = w.safeAreaInsets.top + petSize.height / 2 + 44
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(
            inWindow: w, overlayHeight: petSize.height)
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
        robotHostState.isCallActive = OfficeCallCoordinator.shared.hasActiveCall
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
        let minY = inset.top + petSize.height / 2 + 44
        // IOSP-2: bottom clamp is now the shared tab-bar/keyboard exclusion, not a
        // magic -70. Keeps the head off the tab bar and above any live keyboard.
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(
            inWindow: w, overlayHeight: petSize.height)
        let y = savedY > 0 ? min(max(savedY, minY), max(minY, maxY)) : w.bounds.height * 0.60
        b.center = CGPoint(x: w.bounds.width - margin - petSize.width / 2, y: y)
    }

    private func snap(to center: CGPoint) {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        onRight = center.x >= w.bounds.width / 2
        let x = onRight
            ? w.bounds.width - margin - petSize.width / 2
            : margin + petSize.width / 2
        let minY = inset.top + petSize.height / 2 + 44
        let maxY = AlmaOverlayCoordinator.shared.maxCenterY(
            inWindow: w, overlayHeight: petSize.height)
        let y = min(max(center.y, minY), max(minY, maxY))
        let animate = !AlmaOverlayCoordinator.shared.reduceMotion
        UIView.animate(withDuration: animate ? 0.38 : 0, delay: 0, usingSpringWithDamping: 0.62,
                       initialSpringVelocity: 0.6, options: [.allowUserInteraction]) {
            b.center = CGPoint(x: x, y: y)
        }
        UserDefaults.standard.set(Double(y), forKey: posKey)
    }

    private func updateDragDirection(
        velocityX: CGFloat,
        minimumMagnitude: CGFloat = 18
    ) {
        guard abs(velocityX) >= minimumMagnitude else { return }
        let direction: OfficeRobotDragDirection = velocityX < 0 ? .left : .right
        if robotHostState.dragDirection != direction {
            robotHostState.dragDirection = direction
        }
    }

    private func present<Content: View>(
        _ view: Content,
        fullScreen: Bool = false,
        completion: (() -> Void)? = nil
    ) {
        guard let w = overlay, let root = w.rootViewController else { return }
        // Dismiss anything already up (e.g. the quick-actions sheet) before presenting.
        let target = root.presentedViewController ?? root
        presentationHidesRobot = true
        applyRobotVisibility()
        let host = ChatHostController(rootView: view)
        host.onDisappear = { [weak self] in
            // Only restore the head once nothing is presented over the overlay.
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.presentationHidesRobot = false
                self?.applyRobotVisibility()
            }
        }
        if fullScreen {
            host.modalPresentationStyle = .overFullScreen
            host.view.backgroundColor = .clear
        }
        target.present(host, animated: true, completion: completion)
    }

    private func openChat(completion: (() -> Void)? = nil) {
        if #available(iOS 17.0, *) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if OfficeCallCoordinator.shared.hasActiveCall {
                openIntercom(completion: completion)
            } else {
                present(OfficeChatStandalone(), completion: completion)
            }
        }
    }

    private func openIntercom(completion: (() -> Void)? = nil) {
        if #available(iOS 17.0, *) {
            present(IntercomView(), completion: completion)
        }
    }

    private func openQuickActions(completion: (() -> Void)? = nil) {
        guard #available(iOS 17.0, *) else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        guard let root = overlay?.rootViewController else { return }
        presentationHidesRobot = true
        applyRobotVisibility()
        let actions = ChatHeadQuickActions(
            onChat: { [weak self] in root.dismiss(animated: true) { self?.openChat() } },
            onWalkie: { [weak self] in root.dismiss(animated: true) { self?.openIntercom() } },
            onDismiss: { root.dismiss(animated: true) })
        let host = ChatHostController(rootView: actions)
        host.modalPresentationStyle = .overFullScreen
        host.view.backgroundColor = .clear
        host.onDisappear = { [weak self] in
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.presentationHidesRobot = false
                self?.applyRobotVisibility()
            }
        }
        root.present(host, animated: true, completion: completion)
    }

    private func applyRobotVisibility() {
        let overlaySuppressed = !suppressionReasons.isEmpty
        let robotHidden = overlaySuppressed || presentationHidesRobot
        if robotHidden {
            robotHostState.isDragging = false
            button?.transform = .identity
        }
        overlay?.isHidden = overlaySuppressed
        button?.isHidden = robotHidden
        robotHostState.isSuppressed = robotHidden
    }
}

/// UIKit drag shell around the tightly-sized SwiftUI robot. Tap and long-press
/// remain inside `OfficeRobotPetButton`; this view owns only movement/snap.
@available(iOS 17.0, *)
final class OfficeRobotPetContainerView: UIView {
    var onDragChanged: ((CGPoint, CGFloat) -> Void)?
    var onDragEnded: ((CGPoint, CGFloat) -> Void)?

    private var grabOffset: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = true
        clipsToBounds = false
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func pan(_ g: UIPanGestureRecognizer) {
        guard let parent = superview else { return }
        let p = g.location(in: parent)
        switch g.state {
        case .began:
            grabOffset = CGSize(width: center.x - p.x, height: center.y - p.y)
            if !AlmaOverlayCoordinator.shared.reduceMotion {
                UIView.animate(withDuration: 0.15) {
                    self.transform = CGAffineTransform(scaleX: 1.12, y: 1.12)
                }
            }
        case .changed:
            onDragChanged?(
                CGPoint(x: p.x + grabOffset.width, y: p.y + grabOffset.height),
                g.velocity(in: parent).x
            )
        case .ended, .cancelled, .failed:
            let duration = AlmaOverlayCoordinator.shared.reduceMotion ? 0 : 0.15
            UIView.animate(withDuration: duration) { self.transform = .identity }
            onDragEnded?(
                CGPoint(x: p.x + grabOffset.width, y: p.y + grabOffset.height),
                g.velocity(in: parent).x
            )
        default:
            break
        }
    }
}
