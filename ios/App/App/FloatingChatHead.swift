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
    @Published var isDockedRight = true
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
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: (CGSize, CGFloat) -> Void
    let onOpenPendingItem: (GlobalOfficeRobotStore.TaskItem) -> Void

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
            isDockedRight: hostState.isDockedRight,
            pendingItems: store.items.filter { $0.status == "attention" },
            transientHeadlineItem: store.transientHeadlineItem,
            approvalReaction: store.approvalReaction,
            onTap: onTap,
            onLongPress: onLongPress,
            onDragChanged: onDragChanged,
            onDragEnded: onDragEnded,
            onOpenPendingItem: onOpenPendingItem
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
    private var islandEntryPending = false
    private var islandEntryAnimating = false
    private var launchMergeAnimating = false
    private var launchMergeCompleted = false
    private var approvalReactionCancellable: AnyCancellable?
    private var approvalReactionId: UUID?
    private var approvalHomeCenter: CGPoint?
    private var dragStartCenter: CGPoint?
    private var lastDragTranslationX: CGFloat = 0

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

    /// Exact center of the canonical 88×88 floating host converted into the
    /// temporary launch overlay's coordinate space. The launch sprite uses the
    /// same center, then hands ownership back without an approximate hard-coded
    /// destination or a second persistent robot.
    func launchDestinationCenter(in view: UIView) -> CGPoint? {
        guard let b = button, b.window != nil, view.window != nil else { return nil }
        return b.convert(
            CGPoint(x: b.bounds.midX, y: b.bounds.midY),
            to: view
        )
    }

    /// Reveal the one canonical host after the launch representation has been
    /// absorbed. The approved v4 pop/settle/shake runs on this real host, so its
    /// live task badge and interaction state never need to be duplicated.
    func completeLaunchMerge(animated: Bool) {
        if overlay == nil || button == nil {
            install()
            DispatchQueue.main.async { [weak self] in
                self?.completeLaunchMerge(animated: animated)
            }
            return
        }

        suppressionReasons.remove("launch-animation")
        presentationHidesRobot = false
        applyRobotVisibility()

        guard !launchMergeCompleted, let b = button else { return }
        launchMergeCompleted = true
        launchMergeAnimating = animated
        b.layer.removeAllAnimations()
        b.isUserInteractionEnabled = false
        robotHostState.isDragging = false

        let home = b.center
        guard animated,
              !AlmaOverlayCoordinator.shared.reduceMotion,
              !ProcessInfo.processInfo.isLowPowerModeEnabled,
              !b.isHidden
        else {
            b.alpha = 1
            b.center = home
            b.transform = .identity
            b.isUserInteractionEnabled = true
            launchMergeAnimating = false
            AlmaPerfLog.event("launchRobot.fixedHostRevealed", "reduced=true")
            return
        }

        b.alpha = 0
        b.center = CGPoint(x: home.x, y: home.y + 8)
        b.transform = CGAffineTransform(scaleX: 0.42, y: 0.42)
        UIView.animate(
            withDuration: 0.24,
            delay: 0,
            usingSpringWithDamping: 0.58,
            initialSpringVelocity: 0.82,
            options: [.curveEaseOut, .allowUserInteraction]
        ) {
            b.alpha = 1
            b.center = CGPoint(x: home.x, y: home.y - 14)
            b.transform = CGAffineTransform(scaleX: 1.22, y: 1.22)
        } completion: { [weak self, weak b] _ in
            guard let self, let b else { return }
            UIView.animate(
                withDuration: 0.22,
                delay: 0,
                usingSpringWithDamping: 0.68,
                initialSpringVelocity: 0.62,
                options: [.curveEaseInOut, .allowUserInteraction]
            ) {
                b.center = CGPoint(x: home.x, y: home.y + 1)
                b.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
            } completion: { [weak self, weak b] _ in
                guard let self, let b else { return }
                b.center = home
                b.transform = .identity
                UIView.animateKeyframes(
                    withDuration: 0.34,
                    delay: 0,
                    options: [.allowUserInteraction]
                ) {
                    UIView.addKeyframe(withRelativeStartTime: 0.00, relativeDuration: 0.22) {
                        b.transform = CGAffineTransform(rotationAngle: -0.12)
                    }
                    UIView.addKeyframe(withRelativeStartTime: 0.22, relativeDuration: 0.24) {
                        b.transform = CGAffineTransform(rotationAngle: 0.12)
                    }
                    UIView.addKeyframe(withRelativeStartTime: 0.46, relativeDuration: 0.24) {
                        b.transform = CGAffineTransform(rotationAngle: -0.075)
                    }
                    UIView.addKeyframe(withRelativeStartTime: 0.70, relativeDuration: 0.30) {
                        b.transform = .identity
                    }
                } completion: { [weak self, weak b] _ in
                    b?.center = home
                    b?.transform = .identity
                    b?.alpha = 1
                    b?.isUserInteractionEnabled = true
                    AlmaPerfLog.event("launchRobot.fixedHostRevealed", "reduced=false")
                    Task { @MainActor [weak self] in
                        self?.launchMergeAnimating = false
                    }
                }
            }
        }
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
        approvalReactionCancellable = store.$approvalReaction
            .receive(on: RunLoop.main)
            .sink { [weak self] reaction in
                self?.handleApprovalReaction(reaction)
            }
        robotHostState.isCallActive = OfficeCallCoordinator.shared.hasActiveCall
        robotHostState.isSuppressed = !suppressionReasons.isEmpty

        let robot = GlobalOfficeRobotView(
            store: store,
            hostState: robotHostState,
            onTap: { [weak self] in self?.openTaskTray() },
            onLongPress: { [weak self] in self?.openQuickActions() },
            onDragChanged: { [weak self] translation in
                self?.handleRobotDragChanged(translation)
            },
            onDragEnded: { [weak self] translation, predictedVelocityX in
                self?.handleRobotDragEnded(
                    translation,
                    predictedVelocityX: predictedVelocityX
                )
            },
            onOpenPendingItem: { [weak self] item in
                self?.openAgentItem(item)
            }
        )
        let host = UIHostingController(rootView: robot)
        host.view.backgroundColor = .clear

        let b = OfficeRobotPetContainerView(
            frame: CGRect(origin: .zero, size: petSize))
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
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActiveForRobotEntry),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActiveForRobotEntry),
            name: UIApplication.willResignActiveNotification, object: nil)
        #if DEBUG
        NotificationCenter.default.addObserver(
            self, selector: #selector(debugAppDidEnterBackgroundForRobotEntry),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        #endif
        startCallWatch()

        if islandEntryPending {
            DispatchQueue.main.async { [weak self] in
                self?.playPendingIslandEntryIfPossible()
            }
        }
    }

    /// Called by the dedicated Dynamic Island deep link. iOS owns the
    /// SpringBoard-to-app transition; once ALMA is active, this finite animation
    /// continues it by growing the same global Robot from the Island's position
    /// and landing it at its saved dock.
    func requestIslandEntryTransition() {
        islandEntryPending = true
        AlmaPerfLog.event("robotIslandEntry.received")
        playPendingIslandEntryIfPossible()
    }

    @objc private func appDidBecomeActiveForRobotEntry() {
        #if DEBUG
        if debugIslandEntryWasBackgrounded,
           ProcessInfo.processInfo.environment[
               "ALMA_ROBOT_ISLAND_ENTRY_SELFTEST"
           ] == "1" {
            debugIslandEntryWasBackgrounded = false
            islandEntryPending = true
            RobotSelfTestTrace.mark("robotSelfTest.islandEntryReceived")
        }
        #endif
        playPendingIslandEntryIfPossible()
    }

    @objc private func appWillResignActiveForRobotEntry() {
        if launchMergeAnimating, let b = button {
            b.layer.removeAllAnimations()
            b.transform = .identity
            b.alpha = 1
            b.isUserInteractionEnabled = true
            launchMergeAnimating = false
        }
        if approvalReactionId != nil, let b = button {
            b.layer.removeAllAnimations()
            b.center = approvalHomeCenter ?? b.center
            b.transform = .identity
            b.alpha = 1
            b.isUserInteractionEnabled = true
            approvalReactionId = nil
            approvalHomeCenter = nil
        }
        guard islandEntryAnimating, let b = button else { return }
        b.layer.removeAllAnimations()
        b.transform = .identity
        b.alpha = 1
        b.isUserInteractionEnabled = true
        robotHostState.isDragging = false
        islandEntryAnimating = false
        AlmaPerfLog.event("robotIslandEntry.cancelled")
    }

    private func playPendingIslandEntryIfPossible() {
        guard islandEntryPending,
              !islandEntryAnimating,
              UIApplication.shared.applicationState == .active,
              suppressionReasons.isEmpty,
              !presentationHidesRobot,
              let w = overlay,
              let b = button
        else { return }

        islandEntryPending = false
        islandEntryAnimating = true
        b.layer.removeAllAnimations()

        let destination = b.center
        let start = CGPoint(
            x: w.bounds.midX,
            y: max(w.safeAreaInsets.top + 16, 34)
        )
        let shouldAnimate = !AlmaOverlayCoordinator.shared.reduceMotion

        presentationHidesRobot = false
        applyRobotVisibility()
        b.isUserInteractionEnabled = false
        b.alpha = shouldAnimate ? 0.18 : 1
        b.center = shouldAnimate ? start : destination
        b.transform = shouldAnimate
            ? CGAffineTransform(scaleX: 0.34, y: 0.34)
                .rotated(by: destination.x < start.x ? -0.10 : 0.10)
            : .identity
        robotHostState.dragDirection = destination.x < start.x ? .left : .right
        robotHostState.isDragging = shouldAnimate

        AlmaPerfLog.event("robotIslandEntry.animationStarted")
        #if DEBUG
        if ProcessInfo.processInfo.environment[
            "ALMA_ROBOT_ISLAND_ENTRY_SELFTEST"
        ] == "1" {
            RobotSelfTestTrace.mark("robotSelfTest.islandEntryAnimationStarted")
        }
        #endif

        guard shouldAnimate else {
            finishIslandEntry(on: b, destination: destination)
            return
        }

        UIView.animate(
            withDuration: 0.20,
            delay: 0,
            options: [.curveEaseOut, .allowUserInteraction]
        ) {
            b.alpha = 1
            b.center = CGPoint(
                x: start.x + (destination.x - start.x) * 0.18,
                y: start.y + 34
            )
            b.transform = CGAffineTransform(scaleX: 0.58, y: 0.58)
                .rotated(by: destination.x < start.x ? -0.06 : 0.06)
        } completion: { [weak self, weak b] _ in
            guard let self, let b else { return }
            UIView.animate(
                withDuration: 0.72,
                delay: 0,
                usingSpringWithDamping: 0.64,
                initialSpringVelocity: 0.72,
                options: [.curveEaseInOut, .allowUserInteraction]
            ) {
                b.center = destination
                b.transform = CGAffineTransform(scaleX: 1.08, y: 1.08)
            } completion: { [weak self, weak b] _ in
                guard let self, let b else { return }
                UIView.animate(
                    withDuration: 0.16,
                    delay: 0,
                    options: [.curveEaseOut, .allowUserInteraction]
                ) {
                    b.transform = .identity
                } completion: { [weak self, weak b] _ in
                    guard let self, let b else { return }
                    self.finishIslandEntry(on: b, destination: destination)
                }
            }
        }
    }

    private func finishIslandEntry(
        on button: OfficeRobotPetContainerView,
        destination: CGPoint
    ) {
        button.layer.removeAllAnimations()
        button.center = destination
        button.transform = .identity
        button.alpha = 1
        button.isUserInteractionEnabled = true
        robotHostState.isDragging = false
        islandEntryAnimating = false
        AlmaPerfLog.event("robotIslandEntry.completed")
        #if DEBUG
        if ProcessInfo.processInfo.environment[
            "ALMA_ROBOT_ISLAND_ENTRY_SELFTEST"
        ] == "1" {
            RobotSelfTestTrace.mark("robotSelfTest.islandEntryCompleted")
        }
        #endif
    }

    private func handleApprovalReaction(
        _ reaction: GlobalOfficeRobotStore.ApprovalReaction?
    ) {
        guard UIApplication.shared.applicationState == .active,
              let w = overlay,
              let b = button
        else { return }

        guard let reaction else {
            guard approvalReactionId != nil else { return }
            approvalReactionId = nil
            let destination = approvalHomeCenter ?? b.center
            approvalHomeCenter = nil
            let animate = !AlmaOverlayCoordinator.shared.reduceMotion
            UIView.animate(
                withDuration: animate ? 0.56 : 0,
                delay: 0,
                usingSpringWithDamping: 0.72,
                initialSpringVelocity: 0.55,
                options: [.curveEaseInOut, .allowUserInteraction]
            ) {
                b.center = destination
                b.transform = .identity
                b.alpha = 1
            } completion: { [weak b] _ in
                b?.isUserInteractionEnabled = true
            }
            return
        }

        presentationHidesRobot = false
        applyRobotVisibility()
        b.isUserInteractionEnabled = false

        if approvalReactionId != reaction.id {
            if approvalReactionId == nil {
                approvalHomeCenter = b.center
            }
            approvalReactionId = reaction.id
            let start = b.center
            let center = CGPoint(
                x: w.bounds.midX,
                y: max(w.safeAreaInsets.top + 190, w.bounds.height * 0.43)
            )
            let animate = !AlmaOverlayCoordinator.shared.reduceMotion
            b.layer.removeAllAnimations()
            b.center = start
            b.transform = animate
                ? CGAffineTransform(scaleX: 0.72, y: 0.72)
                : CGAffineTransform(scaleX: 2.05, y: 2.05)
            b.alpha = animate ? 0.72 : 1
            UIView.animate(
                withDuration: animate ? 0.68 : 0,
                delay: 0,
                usingSpringWithDamping: 0.62,
                initialSpringVelocity: 0.72,
                options: [.curveEaseInOut, .allowUserInteraction]
            ) {
                b.center = center
                b.transform = CGAffineTransform(scaleX: 2.05, y: 2.05)
                b.alpha = 1
            }
            return
        }

        guard reaction.phase != .processing,
              !AlmaOverlayCoordinator.shared.reduceMotion
        else { return }
        UIView.animate(
            withDuration: 0.20,
            delay: 0,
            options: [.curveEaseOut, .allowUserInteraction]
        ) {
            b.transform = CGAffineTransform(scaleX: 2.28, y: 2.28)
        } completion: { [weak b] _ in
            guard let b else { return }
            UIView.animate(
                withDuration: 0.34,
                delay: 0,
                usingSpringWithDamping: 0.58,
                initialSpringVelocity: 0.7,
                options: [.allowUserInteraction]
            ) {
                b.transform = CGAffineTransform(scaleX: 2.05, y: 2.05)
            }
        }
    }

    #if DEBUG
    private var debugIslandEntryWasBackgrounded: Bool {
        get {
            UserDefaults.standard.bool(
                forKey: "alma.robot.debugIslandEntryWasBackgrounded"
            )
        }
        set {
            UserDefaults.standard.set(
                newValue,
                forKey: "alma.robot.debugIslandEntryWasBackgrounded"
            )
        }
    }

    @objc private func debugAppDidEnterBackgroundForRobotEntry() {
        guard ProcessInfo.processInfo.environment[
            "ALMA_ROBOT_ISLAND_ENTRY_SELFTEST"
        ] == "1" else { return }
        debugIslandEntryWasBackgrounded = true
    }
    #endif

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
            self?.debugOpenQuickActionsWhenReady()
        }
    }

    /// The launch-v4 handoff intentionally suppresses the canonical Robot until
    /// its merge completes. Fresh CI Simulators can still be inside that handoff
    /// at the self-test's five-second mark, so presenting against the hidden
    /// overlay never calls UIKit's presentation completion. Retry only inside
    /// the DEBUG harness; real long-press handling remains immediate.
    private func debugOpenQuickActionsWhenReady(remainingAttempts: Int = 80) {
        guard remainingAttempts > 0 else {
            AlmaPerfLog.event("robotSelfTest.longPressTimeout")
            return
        }

        guard suppressionReasons.isEmpty,
              overlay?.isHidden == false,
              button?.isHidden == false,
              button?.isUserInteractionEnabled == true,
              overlay?.rootViewController?.presentedViewController == nil
        else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.debugOpenQuickActionsWhenReady(
                    remainingAttempts: remainingAttempts - 1
                )
            }
            return
        }

        AlmaPerfLog.event("robotSelfTest.longPress")
        openQuickActions { [weak self] in
            RobotSelfTestTrace.mark("robotSelfTest.longPress")
            self?.debugScheduleRemainingInteractions()
        }
    }

    private func debugScheduleRemainingInteractions() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            AlmaPerfLog.event("robotSelfTest.tapChat")
            self?.openChat {
                RobotSelfTestTrace.mark("robotSelfTest.tapChat")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            AlmaPerfLog.event("robotSelfTest.openCall")
            self?.openIntercom {
                RobotSelfTestTrace.mark("robotSelfTest.openCall")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in
            self?.debugDismissRobotPresentation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 16) { [weak self] in
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
        let y = savedY > 0 ? min(max(savedY, minY), max(minY, maxY)) : w.bounds.height * 0.45
        onRight = true
        robotHostState.isDockedRight = true
        b.center = CGPoint(x: w.bounds.width - margin - petSize.width / 2, y: y)
    }

    private func snap(to center: CGPoint) {
        guard let w = overlay, let b = button else { return }
        let inset = w.safeAreaInsets
        onRight = center.x >= w.bounds.width / 2
        robotHostState.isDockedRight = onRight
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

    private func handleRobotDragChanged(_ translation: CGSize) {
        guard let b = button else { return }
        if dragStartCenter == nil {
            dragStartCenter = b.center
            lastDragTranslationX = 0
        }
        guard let start = dragStartCenter else { return }

        let deltaX = translation.width - lastDragTranslationX
        lastDragTranslationX = translation.width
        if abs(deltaX) >= 0.5 {
            updateDragDirection(velocityX: deltaX, minimumMagnitude: 0.5)
        }
        robotHostState.isDragging = true
        b.center = CGPoint(
            x: start.x + translation.width,
            y: start.y + translation.height
        )
    }

    private func handleRobotDragEnded(
        _ translation: CGSize,
        predictedVelocityX: CGFloat
    ) {
        guard let b = button else { return }
        let start = dragStartCenter ?? b.center
        let center = CGPoint(
            x: start.x + translation.width,
            y: start.y + translation.height
        )
        let directionSignal = abs(predictedVelocityX) >= 0.5
            ? predictedVelocityX
            : translation.width
        updateDragDirection(
            velocityX: directionSignal,
            minimumMagnitude: 0.5
        )
        dragStartCenter = nil
        lastDragTranslationX = 0
        robotHostState.isDragging = false
        snap(to: center)
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

    private func openTaskTray(completion: (() -> Void)? = nil) {
        guard #available(iOS 17.0, *) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard let root = overlay?.rootViewController else { return }
        presentationHidesRobot = true
        applyRobotVisibility()
        let tray = OfficeRobotTaskTray(
            store: GlobalOfficeRobotStore.shared,
            onOpenItem: { [weak self] item in
                root.dismiss(animated: true) {
                    self?.openAgentItem(item)
                }
            },
            onOfficeChat: { [weak self] in
                root.dismiss(animated: true) { self?.openChat() }
            },
            onClose: {
                root.dismiss(animated: true)
            }
        )
        let host = ChatHostController(rootView: tray)
        host.modalPresentationStyle = .pageSheet
        host.onDisappear = { [weak self] in
            if self?.overlay?.rootViewController?.presentedViewController == nil {
                self?.presentationHidesRobot = false
                self?.applyRobotVisibility()
            }
        }
        root.present(host, animated: true, completion: completion)
    }

    private func openAgentItem(_ item: GlobalOfficeRobotStore.TaskItem) {
        // A pending action is actionable in the native Agent Approvals list.
        // Route there first even when it also belongs to a conversation, so a
        // Robot-row tap never lands on a chat that cannot expose Approve/Reject.
        if let actionId = item.actionId, !actionId.isEmpty {
            AlmaApprovalNav.pendingAgentActionId = actionId
            NotificationCenter.default.post(
                name: .almaOpenPath,
                object: nil,
                userInfo: ["path": "/approvals"]
            )
            NotificationCenter.default.post(
                name: .almaOpenAgentApproval,
                object: nil,
                userInfo: ["actionId": actionId]
            )
        } else if let conversationId = item.conversationId, !conversationId.isEmpty {
            AlmaAgentNav.pendingConversationId = conversationId
            AlmaAgentNav.pendingActionId = nil
            NotificationCenter.default.post(
                name: .almaOpenPath,
                object: nil,
                userInfo: ["path": "/agent"]
            )
            NotificationCenter.default.post(
                name: .almaOpenAgentConversation,
                object: nil,
                userInfo: ["conversationId": conversationId]
            )
        } else {
            NotificationCenter.default.post(
                name: .almaOpenPath,
                object: nil,
                userInfo: ["path": "/agent"]
            )
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

/// Tightly-sized UIKit shell around the SwiftUI Robot. SwiftUI owns the
/// mutually-aware tap, long-press and drag gestures so one recognizer cannot
/// starve another while deciding what the owner's touch means.
@available(iOS 17.0, *)
final class OfficeRobotPetContainerView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = true
        clipsToBounds = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
