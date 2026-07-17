//
//  AlmaOverlayCoordinator.swift
//  ALMA ERP — IOSP-2: one presentation model for the app-wide overlay windows.
//
//  Before this, three independent passthrough windows (FloatingChatHead,
//  AlmaIslandBanner result pill, ConnectivityBeacon) each picked their own
//  window level, duplicated the "find the foreground scene" dance, clamped to
//  fixed pixel offsets, and ignored the keyboard, the tab bar, Reduce Motion and
//  Reduce Transparency. The IOSP-0 baseline caught the chat head overlapping
//  Dashboard content and sitting where the keyboard/composer would cover it.
//
//  This coordinator owns the shared rules; the overlays read from it:
//    • Level   — the single z-order authority (chat head < beacon < island <
//                system). No overlay hard-codes `.normal + N` any more.
//    • bottomInset(for:) — the exclusion zone an edge-docked overlay must stay
//                clear of: tab bar (49) OR the live keyboard, whichever is taller,
//                plus the window safe area. Keyboard height is tracked live.
//    • reduceMotion / reduceTransparency — accessibility passthroughs so every
//                overlay animates/veils consistently.
//    • foregroundScene() — the one scene lookup, deduped.
//

import UIKit

@available(iOS 17.0, *)
final class AlmaOverlayCoordinator {
    static let shared = AlmaOverlayCoordinator()

    /// Canonical z-order for every app-wide overlay window. All sit below system
    /// alerts (`.alert`). The offline beacon is a full-screen takeover, so it must
    /// cover the chat head and the island; the reconnect chip rides with it.
    enum Level {
        static let chatHead: UIWindow.Level = .normal + 1
        static let island: UIWindow.Level = .normal + 2
        static let beacon: UIWindow.Level = .alert - 1
    }

    /// Standard custom tab-bar height (SwiftUIShell). An edge overlay must never
    /// dock lower than this above the bottom safe area.
    static let tabBarHeight: CGFloat = 49

    /// Live keyboard height in window space (0 when hidden). Updated from the
    /// system keyboard-frame notifications.
    private(set) var keyboardHeight: CGFloat = 0
    /// Posted whenever `keyboardHeight` changes, so a docked overlay can re-clamp.
    static let keyboardDidChange = Notification.Name("alma.overlay.keyboardDidChange")

    private init() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillChange(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillHide),
            name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let screenH = foregroundScene()?.screen.bounds.height else { return }
        // Height of the on-screen portion of the keyboard (0 when it's off-screen).
        let visible = max(0, screenH - end.origin.y)
        setKeyboardHeight(visible)
    }

    @objc private func keyboardWillHide() { setKeyboardHeight(0) }

    private func setKeyboardHeight(_ h: CGFloat) {
        guard abs(h - keyboardHeight) > 0.5 else { return }
        keyboardHeight = h
        NotificationCenter.default.post(name: Self.keyboardDidChange, object: nil)
    }

    /// The bottom exclusion an edge-docked overlay of `height` must clear: the
    /// larger of the tab bar and the live keyboard, above the window safe area,
    /// plus a small gap. Returns the maximum allowed center-Y.
    func maxCenterY(inWindow window: UIWindow, overlayHeight: CGFloat, gap: CGFloat = 12) -> CGFloat {
        let obstruction = max(Self.tabBarHeight, keyboardHeight)
        return window.bounds.height - window.safeAreaInsets.bottom - obstruction - overlayHeight / 2 - gap
    }

    /// Accessibility passthroughs — one source so overlays stay consistent.
    var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }
    var reduceTransparency: Bool { UIAccessibility.isReduceTransparencyEnabled }

    /// The single foreground-scene lookup (was copied verbatim in three files).
    func foregroundScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }
}
