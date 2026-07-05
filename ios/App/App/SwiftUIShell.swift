//
//  SwiftUIShell.swift
//  ALMA ERP — S6 infrastructure: hosts the new SwiftUI screens inside the existing
//  UIKit tab shell (tabs, glass nav bars, AlmaTheme, shared web session all stay).
//
//  Design: SwiftUI replaces SCREEN CONTENT, not the shell. Each SwiftUI screen mounts
//  via AlmaHostingController inside the same darkNav the web tabs use, so the pure-glass
//  header (AlmaGlassHeaderView), swipe-back, theme flips and the tab bar behave
//  identically across web and native screens. The Capacitor Dashboard is untouched
//  (push / reminders / N1–N5 live only there — hard rule from the S6 plan).
//
//  Safety: everything is behind AlmaSwiftUIFlag (UserDefaults "alma-swiftui-screens",
//  default ON). Turning it OFF from the More screen rebuilds the tabs with the previous
//  web/UIKit screens — a one-tap escape hatch if a native screen misbehaves, no reinstall.
//

import SwiftUI
import UIKit
import WebKit

// MARK: - Feature flag

enum AlmaSwiftUIFlag {
    private static let key = "alma-swiftui-screens"

    /// Default ON: the owner asked for the SwiftUI screens; the toggle exists so a bad
    /// screen can be escaped instantly, not to hide the work.
    static var isOn: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: key)
            NotificationCenter.default.post(name: .almaSwiftUIFlagChanged, object: nil)
        }
    }

    /// The SwiftUI screens need iOS 17 (they use Observation-era APIs); older devices
    /// silently keep the proven web/UIKit screens.
    static var isActive: Bool {
        if #available(iOS 17.0, *) { return isOn }
        return false
    }
}

extension Notification.Name {
    /// Posted when the owner flips the SwiftUI-screens toggle — the tab controller
    /// rebuilds the affected tabs in place.
    static let almaSwiftUIFlagChanged = Notification.Name("almaSwiftUIFlagChanged")
}

// MARK: - Hosting controller

/// UIHostingController that keeps its background glued to the app theme, so the area
/// behind the glass bars never flashes an alien colour when tabs switch or the owner
/// flips dark mode. The colorScheme inside SwiftUI follows the nav controller's
/// overrideUserInterfaceStyle (set by AlmaTheme.applyNav), so views just read
/// @Environment(\.colorScheme) and match the rest of the app.
final class AlmaHostingController<Content: View>: UIHostingController<Content> {
    override init(rootView: Content) {
        super.init(rootView: rootView)
        NotificationCenter.default.addObserver(self, selector: #selector(applyThemeBg),
                                               name: .almaThemeChanged, object: nil)
    }
    @available(*, unavailable)
    @MainActor dynamic required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        applyThemeBg()
        // Full-bleed under the glass bars, same as the web tabs: SwiftUI handles the
        // safe areas itself, and the glass strip + tab bar float above the content.
        view.insetsLayoutMarginsFromSafeArea = true
    }

    @objc private func applyThemeBg() {
        view.backgroundColor = AlmaTheme.rootBg
    }
}

/// Late-bound weak reference — the SwiftUI screens' closures need the nav controller
/// they end up hosted in, which doesn't exist yet when the rootView is built.
final class WeakRef<T: AnyObject> {
    weak var value: T?
}

// MARK: - Tab builders (S6 wiring)

extension AlmaTabBarController {

    /// Web fallback tab (the pre-S6 construction, verbatim).
    private func webTab(_ path: String, _ title: String, _ icon: String) -> UINavigationController {
        let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: contentPool,
                                          tabTitle: title, systemImage: icon, hideWebHeader: true)
        return Self.darkNav(root: vc, tabTitle: title, icon: icon, largeTitles: false)
    }

    /// Push a web screen onto whatever nav a SwiftUI screen lives in — the S6 escape
    /// hatch (create order, full drawer, login) and the More rows all go through here.
    private func pushWeb(on nav: UINavigationController?, path: String, title: String, icon: String) {
        let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: contentPool,
                                          tabTitle: title, systemImage: icon, hideWebHeader: true)
        vc.hidesBottomBarWhenPushed = false
        nav?.pushViewController(vc, animated: true)
    }

    func makeOrdersTab() -> UINavigationController {
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let screen = OrdersScreen(openWeb: { [weak self] path, title in
                self?.pushWeb(on: navRef.value, path: path, title: title, icon: "shippingbox")
            })
            let host = AlmaHostingController(rootView: screen)
            host.title = "Orders"
            let nav = Self.darkNav(root: host, tabTitle: "Orders", icon: "shippingbox", largeTitles: false)
            navRef.value = nav
            return nav
        }
        return webTab("/orders", "Orders", "shippingbox")
    }

    func makeApprovalsTab() -> UINavigationController {
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let screen = ApprovalsScreen(openWeb: { [weak self] path, title in
                self?.pushWeb(on: navRef.value, path: path, title: title, icon: "checkmark.seal")
            })
            let host = AlmaHostingController(rootView: screen)
            host.title = "Approvals"
            let nav = Self.darkNav(root: host, tabTitle: "Approvals", icon: "checkmark.seal", largeTitles: false)
            navRef.value = nav
            return nav
        }
        return webTab("/approvals", "Approvals", "checkmark.seal")
    }

    func makeMoreTab() -> UINavigationController {
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let screen = MoreMenuScreen(
                openPath: { [weak self] path, title in
                    self?.pushWeb(on: navRef.value, path: path, title: title, icon: "safari")
                },
                openCompanion: { [weak self] in
                    guard let self else { return }
                    let host = AlmaHostingController(
                        rootView: CompanionScreen(processPool: self.contentPool))
                    host.title = "Phone Companion"
                    host.hidesBottomBarWhenPushed = false
                    navRef.value?.pushViewController(host, animated: true)
                },
                toggleDark: { AlmaTheme.toggle() },
                nativeScreensOn: AlmaSwiftUIFlag.isOn,
                toggleNativeScreens: { AlmaSwiftUIFlag.isOn.toggle() })
            let host = AlmaHostingController(rootView: screen)
            host.title = "More"
            let nav = Self.darkNav(root: host, tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)
            navRef.value = nav
            return nav
        }
        return Self.darkNav(root: MoreMenuViewController(processPool: contentPool),
                            tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)
    }

    /// Swap Orders / Approvals / More in place when the owner flips the toggle —
    /// Dashboard (Capacitor) and Assistant instances are preserved untouched.
    @objc func onSwiftUIFlagChanged() {
        guard var vcs = viewControllers, vcs.count == 5 else { return }
        vcs[1] = makeOrdersTab()
        vcs[3] = makeApprovalsTab()
        vcs[4] = makeMoreTab()
        setViewControllers(vcs, animated: false)
        applyTheme() // restyle the fresh navs (glass strip installs via applyNav)
    }
}
