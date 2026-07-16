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

    /// Posted after any approve/reject (business or agent) so the Approvals tab badge
    /// re-counts immediately instead of waiting for its 90s heartbeat.
    static let almaApprovalsChanged = Notification.Name("almaApprovalsChanged")
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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // IOSP-0 baseline: route.push → route.appeared brackets nav-to-screen time.
        AlmaPerfLog.event("route.appeared", title ?? String(describing: Content.self))
    }
}

/// Late-bound weak reference — the SwiftUI screens' closures need the nav controller
/// they end up hosted in, which doesn't exist yet when the rootView is built.
final class WeakRef<T: AnyObject> {
    weak var value: T?
}

// MARK: - Shared SwiftUI palette

/// The ALMA theme, mirrored for SwiftUI screens (owner rule: native screens must wear
/// the app's OWN colours — cream/aurora light, deep-violet dark, coral+violet accents —
/// never stock system greys). Values must stay equal to AlmaTheme (UIKit) and the web
/// tokens; resolved via colorScheme so theme flips animate correctly.
enum AlmaSwiftTheme {
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)   // #E07A5F
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.980)  // #a78bfa
    static let sage = Color(red: 0.506, green: 0.698, blue: 0.604)    // #81B29A

    static func rootBg(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 0.043, green: 0.039, blue: 0.070)     // #0b0a12
                   : Color(red: 0.949, green: 0.941, blue: 0.972)     // #F2F0F8 cream
    }
    /// Raised card surface (a step above rootBg, same as the More menu's cards).
    static func cardBg(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 0.090, green: 0.082, blue: 0.129)     // #171521
                   : .white
    }
    /// Whisper shadow so light-mode white cards separate from the cream page.
    static func cardShadow(_ s: ColorScheme) -> Color {
        .black.opacity(s == .dark ? 0 : 0.05)
    }

    /// Whole-taka display with the web's short scale: ৳1.44L / ৳35.1K / ৳960.
    static func takaShort(_ amount: Int) -> String {
        let a = abs(amount), sign = amount < 0 ? "-" : ""
        if a >= 100_000 { return "\(sign)৳\(String(format: "%.2f", Double(a) / 100_000))L" }
        if a >= 10_000 { return "\(sign)৳\(String(format: "%.1f", Double(a) / 1_000))K" }
        return "\(sign)৳\(a.formatted())"
    }

    // ── iOS 27 tokens (extracted 2026-07-08 from Apple's official iOS/iPadOS 27
    //    Figma kit variables). Brand accents stay ALMA (coral/violet — owner rule);
    //    these cover METRICS + semantic states + hairlines so native screens read
    //    as true iOS 27 without losing the app's own colours. ──────────────────
    /// Concentric corner radii (kit "Dimensions"): card 26, control 14, sheet 34.
    static let rCard: CGFloat = 26
    static let rControl: CGFloat = 14
    static let rSheet: CGFloat = 34
    /// Screen edge margin (kit: 16).
    static let margin: CGFloat = 16

    /// iOS 27 semantic accents (kit "Accents", light/dark pairs — note these CHANGED
    /// from classic iOS: green 34C759/30D158, red FF383C/FF4245, blue 0088FF/0091FF).
    static func ios27Green(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 0.188, green: 0.820, blue: 0.345) : Color(red: 0.204, green: 0.780, blue: 0.349)
    }
    static func ios27Red(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 1.0, green: 0.259, blue: 0.271) : Color(red: 1.0, green: 0.220, blue: 0.235)
    }
    static func ios27Blue(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 0.0, green: 0.569, blue: 1.0) : Color(red: 0.0, green: 0.533, blue: 1.0)
    }
    static func ios27Orange(_ s: ColorScheme) -> Color {
        s == .dark ? Color(red: 1.0, green: 0.573, blue: 0.188) : Color(red: 1.0, green: 0.553, blue: 0.157)
    }
    /// Non-opaque hairline separator (kit: black 12% light / white 17% dark).
    static func separator(_ s: ColorScheme) -> Color {
        s == .dark ? Color.white.opacity(0.17) : Color.black.opacity(0.12)
    }
    /// Control fill (kit "Fills/Secondary": 787880 16% / 32%).
    static func fill(_ s: ColorScheme) -> Color {
        Color(red: 0.471, green: 0.471, blue: 0.502).opacity(s == .dark ? 0.32 : 0.16)
    }
}

// MARK: - iOS 27 Liquid Glass modifiers

/// Liquid-glass card: 26pt concentric corner, translucent surface with a light
/// top rim + soft float shadow (CSS .lg-material twin). Sits on the flat page bg,
/// so no backdrop material is needed — avoids the stock-material tint the owner
/// rejected for the bars while keeping the glass read.
struct AlmaGlassCard: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    var radius: CGFloat = AlmaSwiftTheme.rCard
    var padding: CGFloat? = AlmaSwiftTheme.margin

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .padding(.all, padding ?? 0)
            .background(AlmaSwiftTheme.cardBg(scheme).opacity(scheme == .dark ? 0.92 : 0.96), in: shape)
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(scheme == .dark ? 0.14 : 0.55),
                                 Color.white.opacity(scheme == .dark ? 0.03 : 0.08)],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
            )
            .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.10), radius: 14, y: 6)
            .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.04), radius: 2, y: 1)
    }
}

extension View {
    /// iOS 27 liquid-glass card (26pt continuous corner + rim light + float shadow).
    func lgCard(radius: CGFloat = AlmaSwiftTheme.rCard, padding: CGFloat? = AlmaSwiftTheme.margin) -> some View {
        modifier(AlmaGlassCard(radius: radius, padding: padding))
    }
}

/// iOS 27 capsule button: full-pill radius, 0.97 press scale, 120ms ease.
struct AlmaCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Capsule())
            .clipShape(Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
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
        AlmaPerfLog.event("route.pushWeb", path)
        let vc = AlmaWebTabViewController(url: URL(string: Self.base + path)!, processPool: contentPool,
                                          tabTitle: title, systemImage: icon, hideWebHeader: true)
        vc.hidesBottomBarWhenPushed = false
        nav?.pushViewController(vc, animated: true)
    }

    /// Route-aware push: migrated pages open their NATIVE screen (AlmaNativeRouter),
    /// everything else falls back to the web view unchanged. Native screens get a
    /// FORCED-web escape closure so "ওয়েবে খুলুন" can never recurse into the router.
    private func pushSmart(on nav: UINavigationController?, path: String, title: String, icon: String) {
        AlmaPerfLog.event("route.push", path)
        // Query-carrying deep links (/orders?focus=…, /attendance?review=…) only
        // work on the web page — the router strips queries and native screens
        // don't receive them, so routing those "natively" would silently drop
        // the deep-link context.
        let bare = path.split(separator: "?").first.map(String.init) ?? path
        if path.dropFirst(bare.count).count > 1 {
            pushWeb(on: nav, path: path, title: title, icon: icon)
            return
        }
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *),
           let native = AlmaNativeRouter.screen(for: path, openWebForced: { [weak self, weak nav] p, t in
               // Same-page pushes are the screen's ESCAPE HATCH → always the real web
               // (recursion guard; prefix match so /employees/{id}'s escape to
               // /employees stays a real escape). Cross-page links route back
               // through the router so e.g. Finance → Office fund opens native.
               let origin = path.split(separator: "?").first.map(String.init) ?? path
               let target = p.split(separator: "?").first.map(String.init) ?? p
               if origin.hasPrefix(target) { self?.pushWeb(on: nav, path: p, title: t, icon: icon) }
               else { self?.pushSmart(on: nav, path: p, title: t, icon: icon) }
           }) {
            nav?.pushViewController(native, animated: true)
            return
        }
        pushWeb(on: nav, path: path, title: title, icon: icon)
    }

    /// openWeb closure for a native TAB ROOT: the tab's own path stays a real web
    /// escape hatch, query deep-links stay web, and every other link is routed
    /// through pushSmart so it opens NATIVE when a screen exists. Before this,
    /// tab roots were wired straight to pushWeb, so e.g. tapping a requester name
    /// on Approvals opened the WEB employee profile even though the native
    /// Employees screen exists (owner report 2026-07-15).
    private func smartOpen(origin: String, navRef: WeakRef<UINavigationController>,
                           icon: String) -> (_ path: String, _ title: String) -> Void {
        { [weak self] path, title in
            let target = path.split(separator: "?").first.map(String.init) ?? path
            if target == origin { self?.pushWeb(on: navRef.value, path: path, title: title, icon: icon) }
            else { self?.pushSmart(on: navRef.value, path: path, title: title, icon: icon) }
        }
    }

    /// Home tab (`/`). Owner lifted the FROZEN_CAPACITOR freeze (2026-07-06): when the
    /// SwiftUI flag is on we show the native `DashboardScreen`, but the Capacitor bridge VC
    /// stays MOUNTED behind it (DashboardHostController) so push / reminders / the N1–N5
    /// bridges keep running — the reason the tab was frozen. Flag off → the plain Capacitor
    /// dashboard, exactly as before. `detachDashboardVC` first frees the VC from any prior
    /// parent so the live flag-toggle (onSwiftUIFlagChanged) can re-mount it cleanly.
    func makeDashboardTab() -> UINavigationController {
        guard let dvc = dashboardVC else {
            // Unreachable in practice (set at init) — degrade to the web dashboard.
            return webTab("/", "Dashboard", "square.grid.2x2")
        }
        detachDashboardVC(dvc)
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let container = DashboardHostController(
                capacitor: dvc,
                openWeb: smartOpen(origin: "/", navRef: navRef, icon: "square.grid.2x2"))
            let nav = Self.darkNav(root: container, tabTitle: "Dashboard", icon: "square.grid.2x2", largeTitles: false)
            navRef.value = nav
            return nav
        }
        return Self.darkNav(root: dvc, tabTitle: "Dashboard", icon: "square.grid.2x2", largeTitles: false)
    }

    /// Free the Capacitor dashboard VC from whatever nav/container currently owns it, so it
    /// can be re-mounted (its view + loaded ERP webview are preserved — no reload).
    private func detachDashboardVC(_ dvc: UIViewController) {
        dvc.willMove(toParent: nil)
        dvc.view.removeFromSuperview()
        dvc.removeFromParent()
    }

    func makeOrdersTab() -> UINavigationController {
        if AlmaSwiftUIFlag.isActive, #available(iOS 17.0, *) {
            let navRef = WeakRef<UINavigationController>()
            let screen = OrdersScreen(
                openWeb: smartOpen(origin: "/orders", navRef: navRef, icon: "shippingbox"))
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
            let screen = ApprovalsScreen(
                openWeb: smartOpen(origin: "/approvals", navRef: navRef, icon: "checkmark.seal"))
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
            let avatarButton = Self.profileAvatarButton()
            let screen = MoreMenuScreen(
                openPath: { [weak self] path, title in
                    self?.pushSmart(on: navRef.value, path: path, title: title, icon: "safari")
                },
                openCompanion: { [weak self] in
                    guard let self else { return }
                    let host = AlmaHostingController(
                        rootView: CompanionScreen(processPool: self.contentPool))
                    host.title = "Phone Companion"
                    host.hidesBottomBarWhenPushed = false
                    navRef.value?.pushViewController(host, animated: true)
                },
                openSpinnerPreview: {
                    let host = AlmaHostingController(
                        rootView: NavigationStack { AlmaSpinnerPreviewScreen() })
                    host.title = "Loader Preview"
                    navRef.value?.pushViewController(host, animated: true)
                },
                toggleDark: { AlmaTheme.toggle() },
                nativeScreensOn: AlmaSwiftUIFlag.isOn,
                toggleNativeScreens: { AlmaSwiftUIFlag.isOn.toggle() },
                readBiometricLock: { [weak self] done in self?.readBiometricLock(done) },
                setBiometricLock: { [weak self] on in self?.writeBiometricLock(on) },
                // Watch-app layout: the large title becomes the logged-in user's
                // name once identity loads ("Alex's Apple Watch" slot). The root
                // host is addressed through the WEAK navRef — a closure captured
                // by the rootView must not retain its own hosting controller.
                onUserName: { name in
                    navRef.value?.viewControllers.first?.title = name
                },
                // The round avatar bar button shows the user's real photo once the
                // profile URL loads (and refreshes after an in-app photo change).
                // The button holds no reference back to the host — no cycle.
                onProfileImageUrl: { url in
                    Self.loadAvatar(into: avatarButton, from: url)
                },
                // Group rows push their item list as a native Settings-style page
                // (owner spec 2026-07-09) — same nav, tab bar stays visible.
                pushNative: { title, view in
                    let host = AlmaHostingController(rootView: view)
                    host.title = title
                    host.hidesBottomBarWhenPushed = false
                    navRef.value?.pushViewController(host, animated: true)
                })
            let host = AlmaHostingController(rootView: screen)
            host.title = "More"
            // The fixed glossy "Business" pill, top-left like the Watch app's
            // "All Watches" — a bar button so it stays anchored while the list
            // scrolls. It only posts a notification; the SwiftUI screen presents
            // the switcher sheet (single owner of presentation state).
            host.navigationItem.leftBarButtonItem = Self.businessPillBarButton()
            // Round PROFILE avatar, top-right (owner spec 2026-07-08): taps post a
            // notification; the SwiftUI screen presents the profile sheet.
            host.navigationItem.rightBarButtonItem = UIBarButtonItem(customView: avatarButton)
            let nav = Self.darkNav(root: host, tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)
            navRef.value = nav
            return nav
        }
        return Self.darkNav(root: MoreMenuViewController(processPool: contentPool),
                            tabTitle: "More", icon: "ellipsis.circle", largeTitles: true)
    }

    /// The glossy "Business" switcher pill (Watch-app "All Watches" style): a frosted
    /// capsule with a building glyph + label + tiny up/down chevron. Adaptive
    /// materials/colours (.systemThinMaterial + .label) so theme flips restyle it for
    /// free via the nav's overrideUserInterfaceStyle — no manual almaThemeChanged work.
    private static func businessPillBarButton() -> UIBarButtonItem {
        let container = UIButton(type: .custom, primaryAction: UIAction { _ in
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            NotificationCenter.default.post(name: .almaShowBusinessSwitch, object: nil)
        })
        container.translatesAutoresizingMaskIntoConstraints = false

        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.layer.cornerRadius = 16
        blur.clipsToBounds = true
        blur.isUserInteractionEnabled = false
        container.addSubview(blur)

        let icon = UIImageView(image: UIImage(
            systemName: "building.2.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))
        icon.tintColor = .label
        let label = UILabel()
        label.text = "Business"
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .label
        let chevron = UIImageView(image: UIImage(
            systemName: "chevron.up.chevron.down",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold)))
        chevron.tintColor = .secondaryLabel

        let stack = UIStackView(arrangedSubviews: [icon, label, chevron])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isUserInteractionEnabled = false
        blur.contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            container.heightAnchor.constraint(equalToConstant: 32),
            blur.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            blur.topAnchor.constraint(equalTo: container.topAnchor),
            blur.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
        ])

        // Hairline ring — visible enough to read as a control, quiet enough to stay
        // glassy. .separator adapts to light/dark on its own.
        container.layer.cornerRadius = 16
        container.layer.borderWidth = 1
        container.layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        return UIBarButtonItem(customView: container)
    }

    /// The round profile avatar (top-right of More). Starts as a neutral person
    /// glyph; loadAvatar() swaps in the user's real photo once the URL arrives.
    /// Tapping posts almaShowBusinessSwitch's sibling notification — the SwiftUI
    /// screen owns the sheet.
    private static func profileAvatarButton() -> UIButton {
        let size: CGFloat = 34
        let button = UIButton(type: .custom, primaryAction: UIAction { _ in
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            NotificationCenter.default.post(name: .almaShowProfile, object: nil)
        })
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: size),
            button.heightAnchor.constraint(equalToConstant: size),
        ])
        button.layer.cornerRadius = size / 2
        button.clipsToBounds = true
        button.layer.borderWidth = 1.5
        button.layer.borderColor = UIColor.separator.withAlphaComponent(0.5).cgColor
        button.backgroundColor = .secondarySystemFill
        button.setImage(UIImage(
            systemName: "person.crop.circle.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular))?
            .withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal), for: .normal)
        return button
    }

    /// Best-effort avatar download (session cookies already synced into
    /// HTTPCookieStorage.shared by AlmaAPI, so the profile-image proxy authorises).
    /// Failure just leaves the neutral glyph in place.
    private static func loadAvatar(into button: UIButton, from urlString: String?) {
        guard let urlString, !urlString.isEmpty else { return }
        let url: URL? = urlString.hasPrefix("http")
            ? URL(string: urlString)
            : URL(string: urlString, relativeTo: AlmaAPI.baseURL)
        guard let url else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                button.setImage(nil, for: .normal)
                button.backgroundColor = .clear
                // Fill the whole disc with the photo (aspect-fill via background layer).
                button.layer.contents = image.cgImage
                button.layer.contentsGravity = .resizeAspectFill
            }
        }.resume()
    }

    /// Swap Orders / Assistant / Approvals / More in place when the owner flips the
    /// toggle — the Dashboard (Capacitor) instance is preserved untouched.
    /// (makeAssistantTab lives in AssistantSwiftUI.swift.)
    @objc func onSwiftUIFlagChanged() {
        guard var vcs = viewControllers, vcs.count == 5 else { return }
        vcs[0] = makeDashboardTab()   // native ⇄ Capacitor (VC stays mounted either way)
        vcs[1] = makeOrdersTab()
        vcs[2] = makeAssistantTab()
        vcs[3] = makeApprovalsTab()
        vcs[4] = makeMoreTab()
        setViewControllers(vcs, animated: false)
        applyTheme() // restyle the fresh navs (glass strip installs via applyNav)
    }

    // MARK: - Notification-tap deep link (AlmaNavBridge → exact page)

    /// AlmaNavBridge posts .almaOpenPath with the ERP route from a notification tap.
    @objc func onOpenPath(_ note: Notification) {
        guard let path = note.userInfo?["path"] as? String, path.hasPrefix("/") else { return }
        routeNotificationTap(to: path)
    }

    /// Land a notification tap on its exact page.
    ///
    /// Root-tab paths select their tab (no duplicate copy pushed); everything else
    /// pushes on the CURRENT tab's nav so Back returns the user to where they were.
    /// Paths carrying a query string open the WEB page — AlmaNativeRouter strips
    /// queries, and deep links like /orders?q=… or /attendance?review=… only work
    /// on the web page. Bare paths go through pushSmart (native when migrated).
    func routeNotificationTap(to path: String) {
        // The tap can arrive before the shell is attached to a window (cold start
        // races the webview boot) — retry once the hierarchy is up.
        guard view.window != nil else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.routeNotificationTap(to: path)
            }
            return
        }
        // A presented sheet/full-screen cover (voice console, approval sheet…) would
        // swallow the navigation — dismiss it first, then route.
        if let presented = presentedViewController {
            presented.dismiss(animated: false) { [weak self] in self?.routeNotificationTap(to: path) }
            return
        }

        let clean = path.split(separator: "?").first.map(String.init) ?? path
        let query = path.dropFirst(clean.count)
        let hasQuery = query.count > 1 // "?" alone is not a real query

        // Tab roots: 0 Dashboard, 1 Orders, 2 Assistant, 3 Approvals, 4 More.
        let tabRoots: [String: Int] = [
            "/": 0, "/dashboard": 0,
            "/orders": 1,
            "/agent": 2,
            "/approvals": 3,
        ]
        if !hasQuery, let index = tabRoots[clean] {
            selectTabRootStably(index)
            return
        }

        guard let nav = selectedViewController as? UINavigationController else { return }
        let title = Self.notificationTapTitle(for: clean)
        if hasQuery {
            pushWeb(on: nav, path: path, title: title, icon: "bell.badge")
        } else {
            pushSmart(on: nav, path: path, title: title, icon: "bell.badge")
        }
    }

    /// Select a tab root and keep it selected against the cold-start reset race.
    ///
    /// On a notification cold-launch the sequence is: shell builds → biometric
    /// lock overlay → Face ID unlock → Capacitor Dashboard (re)mounts. Any of
    /// those late steps can snap `selectedIndex` back to 0 (Dashboard) AFTER a
    /// one-shot re-assert. Re-assert on a short repeating schedule that stops
    /// once the selection sticks, so the tap survives however long unlock takes.
    private func selectTabRootStably(_ index: Int) {
        selectedIndex = index
        (selectedViewController as? UINavigationController)?.popToRootViewController(animated: false)
        var attempts = 0
        // ~4.8s of coverage (8 × 0.6s) spans a slow Face ID unlock + webview
        // remount. Re-asserting an already-correct index is a no-op, so we just
        // hold it for the whole window rather than trying to detect "settled".
        Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            attempts += 1
            if self.selectedIndex != index { self.selectedIndex = index }
            if attempts >= 8 { timer.invalidate() }
        }
    }

    /// Human title for a pushed notification target ("/finance/office-fund" → "Office fund").
    private static func notificationTapTitle(for cleanPath: String) -> String {
        let segment = cleanPath.split(separator: "/").last.map(String.init) ?? "Alma ERP"
        let words = segment.replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
