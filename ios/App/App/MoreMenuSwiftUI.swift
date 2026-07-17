//
//  MoreMenuSwiftUI.swift
//  ALMA ERP — the More tab, redesigned in the Apple-Watch-app layout (owner spec,
//  2026-07-08): large title = the logged-in user's NAME, a fixed glossy "Business"
//  pill top-left (bar button, wired in SwiftUIShell) that opens the business
//  switcher sheet, a horizontal row of three premium "hero" cards where the Watch
//  app shows My Faces (live clock/date/timezone · dynamic alerts · weekly+monthly
//  progress), and every nav group below PUSHES its own Settings-style page
//  (owner spec 2026-07-09 — replaced the earlier inline collapse/expand).
//
//  Deliberately DECOUPLED from AlmaTheme (SpikeNativeShell.swift) so this file
//  typechecks standalone and stays host-agnostic:
//    • isDark      → read from the same UserDefaults key AlmaTheme persists ("alma-theme-mode")
//    • change feed → the same "almaThemeChanged" notification, by string name
//    • toggle      → a `toggleDark` closure the host wires to AlmaTheme.toggle/set
//  Colours are derived from the SwiftUI colorScheme (the hosting nav controller sets
//  overrideUserInterfaceStyle from AlmaTheme), so the screen restyles for free on flip;
//  the UserDefaults read only drives the switch position + sun/moon icon.
//
//  Data: ONE cookie-authenticated fetch (AlmaAPI) of /api/assistant/more-pulse —
//  identity + alerts + progress together. If that route is unavailable (agent flag
//  off, older deploy) the screen falls back to /api/users/me for the name/business
//  list and the alert/progress cards degrade to their quiet empty states. The
//  clock card is fully local and never depends on the network.
//
//  Navigation stays in the host: rows call openPath(path, title) (web screen push)
//  or openCompanion() (native companion push) — this view owns zero WKWebView state.
//

import SwiftUI
import UIKit
import PhotosUI
import WebKit

// MARK: - Theme bridge (no import of SpikeNativeShell types)

/// Tiny read-only mirror of AlmaTheme's persisted state. Kept private to this screen —
/// writes still go through the host's closure so AlmaTheme remains the single writer.
private enum MoreTheme {
    /// Same Notification.Name AlmaTheme broadcasts (extension Notification.Name.almaThemeChanged).
    static let changed = Notification.Name("almaThemeChanged")
    /// Same key AlmaTheme.loadInitial reads (AlmaTheme.defaultsKey).
    static var isDark: Bool { UserDefaults.standard.string(forKey: "alma-theme-mode") == "dark" }
}

extension Notification.Name {
    /// Posted by the host's glossy "Business" bar-button pill (SwiftUIShell.makeMoreTab);
    /// the screen answers by presenting the business-switcher sheet.
    static let almaShowBusinessSwitch = Notification.Name("almaShowBusinessSwitch")
    /// Posted by the host's round avatar bar button (top-right); the screen answers
    /// by presenting the profile sheet.
    static let almaShowProfile = Notification.Name("almaShowProfile")
}

// MARK: - /api/assistant/more-pulse models (defensive decoding — one bad field
// must never blank the whole screen, same policy as AlmaOrder)

struct MorePulseUser: Decodable {
    let name: String
    let isOwner: Bool
    let businessAccess: [String]
    let email: String?
    let phone: String?
    let profileImageUrl: String?

    enum CodingKeys: String, CodingKey { case name, isOwner, businessAccess, email, phone, profileImageUrl }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        isOwner = (try? c.decode(Bool.self, forKey: .isOwner)) ?? false
        businessAccess = (try? c.decode([String].self, forKey: .businessAccess)) ?? []
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        profileImageUrl = try? c.decodeIfPresent(String.self, forKey: .profileImageUrl)
    }
}

struct MorePulseAlert: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String      // fine | missed_call | chat | agent
    let title: String
    let detail: String?
    let amount: Int?      // whole taka
    let at: String?

    enum CodingKeys: String, CodingKey { case id, kind, title, detail, amount, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "chat"
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        if let i = try? c.decodeIfPresent(Int.self, forKey: .amount) { amount = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .amount) { amount = Int(d.rounded()) }
        else { amount = nil }
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }

    var icon: String {
        switch kind {
        case "fine": return "bangladeshisign.circle.fill"
        case "missed_call": return "phone.arrow.down.left.fill"
        case "agent": return "sparkles"
        default: return "bubble.left.and.bubble.right.fill"
        }
    }
    var tint: Color {
        switch kind {
        case "fine": return Color(red: 0.878, green: 0.478, blue: 0.373)       // coral
        case "missed_call": return Color(red: 0.94, green: 0.62, blue: 0.25)   // amber
        case "agent": return Color(red: 0.655, green: 0.545, blue: 0.980)      // violet
        default: return Color(red: 0.35, green: 0.62, blue: 0.95)              // sky
        }
    }
}

struct MorePulseProgress: Decodable, Equatable {
    let weeklyPct: Int?
    let monthlyPct: Int?
    let weeklyLabel: String?
    let monthlyLabel: String?

    enum CodingKeys: String, CodingKey { case weeklyPct, monthlyPct, weeklyLabel, monthlyLabel }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func pct(_ k: CodingKeys) -> Int? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return max(0, min(100, i)) }
            if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return max(0, min(100, Int(d.rounded()))) }
            return nil
        }
        weeklyPct = pct(.weeklyPct)
        monthlyPct = pct(.monthlyPct)
        weeklyLabel = try? c.decodeIfPresent(String.self, forKey: .weeklyLabel)
        monthlyLabel = try? c.decodeIfPresent(String.self, forKey: .monthlyLabel)
    }
}

struct MorePulse: Decodable {
    let user: MorePulseUser?
    let alerts: [MorePulseAlert]
    let progress: MorePulseProgress?

    enum CodingKeys: String, CodingKey { case user, alerts, progress }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try? c.decodeIfPresent(MorePulseUser.self, forKey: .user)
        alerts = (try? c.decodeIfPresent([MorePulseAlert].self, forKey: .alerts)) ?? []
        progress = try? c.decodeIfPresent(MorePulseProgress.self, forKey: .progress)
    }
}

/// Fallback identity: GET /api/users/me → { user: { name, businessAccess: "A,B,C" } }.
/// Used only when more-pulse is unreachable (agent flag off / older deploy).
private struct MoreMeResponse: Decodable {
    struct MeUser: Decodable {
        let name: String?
        let businessAccess: String?
        let isSystemOwner: Bool?
        let email: String?
        let phone: String?
        let profileImageUrl: String?
    }
    let user: MeUser?
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class MoreVM {
    var userName: String = ""
    var isOwner = false
    var email: String?
    var phone: String?
    /// Relative or absolute URL of the avatar (cookie-authed GET); nil = none set.
    var profileImageUrl: String?
    /// Business ids the user may switch to (ALMA_LIFESTYLE / ALMA_TRADING /
    /// CREATIVE_DIGITAL_IT). Empty = unknown yet → the sheet shows all three.
    var allowedBusinessIds: [String] = []
    var alerts: [MorePulseAlert] = []
    var progress: MorePulseProgress?
    /// True once ANY load attempt finished — flips the hero cards from their
    /// quiet loading look to real content / empty states.
    var loadedOnce = false

    private var lastLoad: Date?

    /// Refetch on appear at most every 3 minutes; pull-to-refresh forces it.
    func loadIfStale() async {
        if let last = lastLoad, Date().timeIntervalSince(last) < 180 { return }
        await load()
    }

    func load() async {
        defer { loadedOnce = true; lastLoad = Date() }
        do {
            let pulse: MorePulse = try await AlmaAPI.shared.get("/api/assistant/more-pulse")
            if let u = pulse.user {
                userName = u.name
                isOwner = u.isOwner
                allowedBusinessIds = u.businessAccess
                email = u.email
                phone = u.phone
                profileImageUrl = u.profileImageUrl
            }
            alerts = pulse.alerts
            progress = pulse.progress
        } catch {
            // Quiet degrade: cards keep previous/empty content. Still try to get the
            // name so the large title personalises even without the pulse route.
            if userName.isEmpty {
                if let me: MoreMeResponse = try? await AlmaAPI.shared.get("/api/users/me"),
                   let u = me.user {
                    userName = u.name ?? ""
                    isOwner = u.isSystemOwner ?? false
                    email = u.email
                    phone = u.phone
                    profileImageUrl = u.profileImageUrl
                    allowedBusinessIds = (u.businessAccess ?? "")
                        .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }
                }
            }
        }
    }
}

// MARK: - Accent (web colour variant) bridge

/// The web app's 5 accent presets (src/lib/theme.ts — single source of truth for the
/// values). The choice lives in the `alma-accent` COOKIE (SSR reads it before paint),
/// so native "applies" a variant by writing that cookie into the shared
/// WKWebsiteDataStore — every web surface picks it up on its next page load. Native
/// chrome keeps the app's locked violet/coral glass (owner spec); the swatches here
/// mirror the web's exact hexes.
enum AlmaAccent: String, CaseIterable {
    case coral, blue, green, violet, amber

    static let defaultsKey = "alma-accent"
    static let cookieName = "alma-accent"

    var label: String {
        switch self {
        case .coral: return "Coral"
        case .blue: return "Blue"
        case .green: return "Green"
        case .violet: return "Violet"
        case .amber: return "Amber"
        }
    }
    /// Swatch colour — same hex the web maps to --c-accent (theme.ts).
    var color: Color {
        switch self {
        case .coral: return Color(red: 224/255, green: 122/255, blue: 95/255)   // #E07A5F
        case .blue: return Color(red: 59/255, green: 130/255, blue: 246/255)    // #3B82F6
        case .green: return Color(red: 34/255, green: 167/255, blue: 122/255)   // #22A77A
        case .violet: return Color(red: 139/255, green: 92/255, blue: 246/255)  // #8B5CF6
        case .amber: return Color(red: 217/255, green: 152/255, blue: 49/255)   // #D99831
        }
    }

    static var current: AlmaAccent {
        AlmaAccent(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .coral
    }

    /// Persist locally + write the web's cookie (1 year, path /, same attributes the
    /// web sets). Web pages restyle on their next load — same one-way native→web
    /// model AlmaTheme uses for dark mode.
    static func set(_ accent: AlmaAccent) {
        UserDefaults.standard.set(accent.rawValue, forKey: defaultsKey)
        guard let host = AlmaAPI.baseURL.host,
              let cookie = HTTPCookie(properties: [
                  .name: cookieName,
                  .value: accent.rawValue,
                  .domain: host,
                  .path: "/",
                  .expires: Date(timeIntervalSinceNow: 365 * 86_400),
                  .secure: "TRUE",
              ]) else { return }
        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct MoreMenuScreen: View {
    /// Pushes a web screen for an ERP route (host builds the AlmaWebTabViewController).
    let openPath: (_ path: String, _ title: String) -> Void
    /// Pushes the NATIVE Phone Companion screen (the "native:companion" row in UIKit).
    let openCompanion: () -> Void
    /// DEBUG: pushes the native 12-spoke loader preview (native:spinner-preview row).
    var openSpinnerPreview: (() -> Void)? = nil
    /// Flips the app-wide theme (host calls AlmaTheme; we never touch it directly).
    let toggleDark: () -> Void
    /// S6 escape hatch: the "Native স্ক্রিন" switch — flips AlmaSwiftUIFlag and the host
    /// swaps Orders/Approvals/More back to the proven web/UIKit screens live. Optional
    /// (nil hides the row) so previews / other hosts don't need it.
    var nativeScreensOn: Bool = true
    var toggleNativeScreens: (() -> Void)? = nil

    /// iOS Face ID / Touch ID app-lock control. The enable flag lives in the web app's
    /// localStorage (BiometricLockGate); the host reads/writes it via a live webview.
    /// nil hides the row (e.g. previews / non-iOS hosts).
    var readBiometricLock: ((@escaping (Bool) -> Void) -> Void)? = nil
    var setBiometricLock: ((Bool) -> Void)? = nil

    /// Fired when the logged-in user's name arrives — the host sets it as the nav
    /// large title (Watch-app style "Alex's Apple Watch" slot). Optional for previews.
    var onUserName: (String) -> Void = { _ in }
    /// Fired when the avatar URL arrives/changes — the host refreshes the round
    /// profile bar button (top-right). Optional for previews.
    var onProfileImageUrl: (String?) -> Void = { _ in }

    /// Pushes a NATIVE SwiftUI page (title + view) onto the host nav — the group
    /// rows push their item list as a separate page (owner spec 2026-07-09:
    /// Settings-style navigation, no inline expand). nil (previews) = no-op.
    var pushNative: ((_ title: String, _ view: AnyView) -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = MoreVM()
    @State private var showBusinessSheet = false
    @State private var showProfileSheet = false

    // ── Menu data — same items as before; "Switch business" moved to the glossy
    //    pill + sheet, so it is no longer a list section ──

    fileprivate struct MenuItem { let title: String; let icon: String; let path: String }
    fileprivate struct MenuGroup { let header: String; let icon: String; let items: [MenuItem] }

    private static var groups: [MenuGroup] {
        // P3 mobile companion: "native:companion" is a sentinel — that row pushes the
        // NATIVE companion screen (openCompanion) instead of a web view.
        // Owner feedback 2026-07-17: NO duplicates — the Hub is the ONE agent
        // directory; the More menu keeps only the Hub + the native-sentinel row.
        var agentItems: [MenuItem] = [
            MenuItem(title: "Agent Hub",       icon: "square.grid.2x2.fill",             path: "/agent/hub"),
            MenuItem(title: "Phone Companion", icon: "iphone.radiowaves.left.and.right", path: "native:companion"),
        ]
        #if DEBUG
        agentItems.append(MenuItem(title: "Loader Preview", icon: "sparkles", path: "native:spinner-preview"))
        #endif
        return [
        MenuGroup(header: "Agent", icon: "sparkles", items: agentItems),
        MenuGroup(header: "Workspace", icon: "square.grid.2x2", items: [
            MenuItem(title: "My Desk",         icon: "person.crop.square", path: "/portal"),
            MenuItem(title: "Office",          icon: "building.2",         path: "/portal/office"),
            MenuItem(title: "Product Images",  icon: "photo.on.rectangle", path: "/agent/catalog-images"),
            MenuItem(title: "Creative Studio", icon: "wand.and.stars",     path: "/agent/creative-studio"),
        ]),
        MenuGroup(header: "Money", icon: "banknote", items: [
            MenuItem(title: "Finance",  icon: "banknote",          path: "/finance"),
            MenuItem(title: "Expenses", icon: "creditcard",        path: "/expenses"),
            MenuItem(title: "Payroll",  icon: "dollarsign.circle", path: "/payroll"),
            MenuItem(title: "Invoices", icon: "doc.text",          path: "/invoice"),
        ]),
        MenuGroup(header: "Operations", icon: "gearshape.2", items: [
            MenuItem(title: "Inventory",      icon: "shippingbox", path: "/inventory"),
            MenuItem(title: "Activity",       icon: "bolt",        path: "/activity"),
            MenuItem(title: "Task Spotlight", icon: "target",      path: "/operations/task-spotlight"),
            MenuItem(title: "Archive",        icon: "archivebox",  path: "/operations/business-archive"),
        ]),
        MenuGroup(header: "People", icon: "person.2", items: [
            MenuItem(title: "Employees",  icon: "person.2",                           path: "/employees"),
            MenuItem(title: "Attendance", icon: "calendar.badge.clock",               path: "/attendance"),
            MenuItem(title: "CRM",        icon: "person.crop.circle.badge.checkmark", path: "/crm"),
        ]),
        MenuGroup(header: "Insights", icon: "chart.bar", items: [
            MenuItem(title: "Analytics", icon: "chart.bar", path: "/analytics"),
            MenuItem(title: "Insights",  icon: "lightbulb", path: "/insights"),
            MenuItem(title: "Briefing",  icon: "newspaper", path: "/briefing"),
            MenuItem(title: "Audit",     icon: "checklist", path: "/audit"),
        ]),
        MenuGroup(header: "Settings", icon: "gearshape", items: [
            MenuItem(title: "Users",         icon: "person.3",           path: "/settings/users"),
            MenuItem(title: "Notifications", icon: "bell.badge",         path: "/settings/notifications"),
            MenuItem(title: "Branding",      icon: "paintpalette",       path: "/settings/branding"),
            MenuItem(title: "SMS",           icon: "message",            path: "/settings/sms"),
            MenuItem(title: "Telegram Ops",  icon: "paperplane",         path: "/settings/telegram-ops"),
            MenuItem(title: "Database",      icon: "cylinder.split.1x2", path: "/settings/database"),
            MenuItem(title: "Session",       icon: "key",                path: "/settings/session"),
        ]),
        ]
    }

    /// The owner's 3 businesses. Switching is just navigation — the ERP derives the
    /// active business from the route (`/trading` → Trading, `/digital` → CDIT, `/` →
    /// Lifestyle), so opening a business home switches it. `bizId` matches the ERP's
    /// businessAccess ids so the sheet can hide businesses the user can't access.
    fileprivate struct Biz {
        let bizId: String; let name: String; let tagline: String
        let letter: String; let color: Color; let path: String
    }
    fileprivate static let businesses: [Biz] = [
        Biz(bizId: "ALMA_LIFESTYLE", name: "Alma Lifestyle", tagline: "Lifestyle", letter: "A",
            color: Color(red: 0.79, green: 0.66, blue: 0.30), path: "/"),
        Biz(bizId: "ALMA_TRADING", name: "Alma Trading", tagline: "P2P Operations", letter: "T",
            color: Color(red: 0.51, green: 0.70, blue: 0.60), path: "/trading"),
        Biz(bizId: "CREATIVE_DIGITAL_IT", name: "Creative Digital IT", tagline: "Digital Agency", letter: "C",
            color: Color(red: 0.42, green: 0.56, blue: 0.88), path: "/digital"),
    ]

    // ── Palette (mirrors AlmaTheme, derived from colorScheme not AlmaTheme.isDark:
    //    the host flips the trait via overrideUserInterfaceStyle, so this is always
    //    in sync AND previews/theme transitions animate correctly) ──

    private var rootBg: Color {
        colorScheme == .dark ? Color(red: 0.043, green: 0.039, blue: 0.070)  // #0b0a12
                             : Color(red: 0.949, green: 0.941, blue: 0.972)  // #F2F0F8 cream
    }
    /// Card surface: a step above rootBg so the inset cards read as raised panels.
    private var cardBg: Color {
        colorScheme == .dark ? Color(red: 0.090, green: 0.082, blue: 0.129)  // #171521
                             : Color.white
    }
    private var violet: Color { Color(red: 0.655, green: 0.545, blue: 0.980) } // #a78bfa

    // ── Body ──

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                MoreHeroRow(vm: vm, openPath: openPath)
                // Appearance/Security switches live in the PROFILE sheet now (owner
                // spec 2026-07-08): More is pure navigation, profile is personal.
                ForEach(Self.groups, id: \.header) { group in
                    groupRow(group)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 28)
        }
        // The owner's aurora — the same ambient the Orders / Assistant surfaces wear, so
        // More stops looking like a flat grey settings list and matches the app theme.
        .background(OrdersAurora())
        .refreshable { await vm.load() }
        // Claude-style top scroll-edge fade under the (transparent-glass) UIKit nav bar.
        .claudeTopFade()
        .task { await vm.loadIfStale() }
        // The host's glossy "Business" pill (bar button) asks us to present the sheet.
        .onReceive(NotificationCenter.default.publisher(for: .almaShowBusinessSwitch)) { _ in
            showBusinessSheet = true
        }
        // The host's round avatar bar button (top-right) asks for the profile sheet.
        .onReceive(NotificationCenter.default.publisher(for: .almaShowProfile)) { _ in
            showProfileSheet = true
        }
        .onChange(of: vm.userName) { _, name in
            if !name.isEmpty { onUserName(name) }
        }
        .onChange(of: vm.profileImageUrl) { _, url in
            onProfileImageUrl(url)
        }
        .sheet(isPresented: $showBusinessSheet) {
            MoreBusinessSheet(
                businesses: allowedBusinesses,
                cardBg: cardBg, rootBg: rootBg,
                select: { biz in
                    showBusinessSheet = false
                    openPath(biz.path, biz.name)
                })
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showProfileSheet) {
            MoreProfileSheet(
                vm: vm,
                toggleDark: toggleDark,
                nativeScreensOn: nativeScreensOn,
                toggleNativeScreens: toggleNativeScreens,
                readBiometricLock: readBiometricLock,
                setBiometricLock: setBiometricLock,
                openPath: { path, title in
                    showProfileSheet = false
                    openPath(path, title)
                })
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    /// Businesses the sheet offers: filtered by the server's access list once known,
    /// all three while identity is still loading (server enforces access anyway).
    private var allowedBusinesses: [Biz] {
        guard !vm.allowedBusinessIds.isEmpty else { return Self.businesses }
        let allowed = Self.businesses.filter { vm.allowedBusinessIds.contains($0.bizId) }
        return allowed.isEmpty ? Self.businesses : allowed
    }

    // ── Nav group row (Settings-style: tap PUSHES the group's own page — owner
    //    spec 2026-07-09; the old inline expand felt unprofessional) ──

    @ViewBuilder
    private func groupRow(_ group: MenuGroup) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            pushNative?(group.header, AnyView(
                MoreGroupScreen(group: group, open: { item in open(item) })))
        } label: {
            HStack(spacing: 12) {
                Image(systemName: group.icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(violet)
                    .frame(width: 32, height: 32)
                    .background(violet.opacity(colorScheme == .dark ? 0.18 : 0.12),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                Text(group.header)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Text("\(group.items.count)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(MoreRowButtonStyle())
        // Frosted-glass card so the aurora glows through but the rows stay crisp.
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
    }

    // ── Row actions ──

    private func open(_ item: MenuItem) {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        if item.path == "native:companion" { openCompanion() }
        else if item.path == "native:spinner-preview" { openSpinnerPreview?() }
        else { openPath(item.path, item.title) }
    }

}

// MARK: - Group page (Settings-style pushed list — one page per nav group)

/// The page a group row pushes: the group's items as a frosted-glass list on the
/// aurora, same premium row style the old inline expand used. Pure navigation —
/// item taps run the SAME open() routing (native sentinels + smart web push).
@available(iOS 17.0, *)
private struct MoreGroupScreen: View {
    let group: MoreMenuScreen.MenuGroup
    let open: (MoreMenuScreen.MenuItem) -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var violet: Color { Color(red: 0.655, green: 0.545, blue: 0.980) } // #a78bfa

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(group.items.enumerated()), id: \.element.title) { index, item in
                        if index > 0 { Divider().padding(.leading, 58) }
                        Button {
                            open(item)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: item.icon)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(violet)
                                    .frame(width: 32, height: 32)
                                    .background(violet.opacity(colorScheme == .dark ? 0.18 : 0.12),
                                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                                Text(item.title)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 13)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(MoreRowButtonStyle())
                    }
                }
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 28)
        }
        .background(OrdersAurora())
        .claudeTopFade()
    }
}

// MARK: - Hero cards ("My Faces" slot — clock · alerts · progress)

@available(iOS 17.0, *)
private struct MoreHeroRow: View {
    let vm: MoreVM
    let openPath: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("TODAY")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(scheme == .dark ? Color.white.opacity(0.72)
                                                 : Color.black.opacity(0.55))
                .padding(.leading, 14)
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ClockHeroCard()
                    AlertsHeroCard(vm: vm) { openPath("/portal/office", "Office") }
                    ProgressHeroCard(vm: vm) { openPath("/attendance", "Attendance") }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
            // Bleed the row to the screen edges so cards peek from the right like
            // the Watch app's face carousel; padding matches the page's 16pt gutter.
            .padding(.horizontal, -16)
            .contentMargins(.horizontal, 16, for: .scrollContent)
        }
    }
}

/// Shared premium card scaffold: soft two-stop gradient, glass top highlight,
/// hairline border, continuous iOS-27 card corners. Colours differ per card + theme.
@available(iOS 17.0, *)
private struct HeroCardChrome<Content: View>: View {
    let light: (Color, Color)
    let dark: (Color, Color)
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var scheme

    /// Card width sized off the SCREEN so two cards + a visible sliver of the third
    /// always fit (owner spec 2026-07-09: the third card must peek, never fully hide).
    /// 16pt gutter + card + 12 gap + card + 12 gap + ~26pt peek = screen width.
    private static var cardWidth: CGFloat {
        let screen = UIScreen.main.bounds.width
        return max(150, (screen - 16 - 12 - 12 - 26) / 2)
    }

    var body: some View {
        let stops = scheme == .dark ? dark : light
        content
            .padding(14)
            .frame(width: Self.cardWidth, height: 168, alignment: .topLeading)
            .background(
                LinearGradient(colors: [stops.0, stops.1],
                               startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(
                // Glassy sheen: a whisper of white falling off the top edge.
                LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.10 : 0.35), .clear],
                               startPoint: .top, endPoint: .center)
                    .allowsHitTesting(false))
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .strokeBorder(.white.opacity(scheme == .dark ? 0.08 : 0.55), lineWidth: 1))
            .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.08), radius: 10, y: 4)
    }
}

/// Card 1 — live clock, day name, date, timezone. Fully local; ticks every minute.
@available(iOS 17.0, *)
private struct ClockHeroCard: View {
    @Environment(\.colorScheme) private var scheme

    private static let time: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm"; return f
    }()
    private static let ampm: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "a"; return f
    }()
    private static let day: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEEE"; return f
    }()
    private static let date: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "d MMMM yyyy"; return f
    }()

    /// "Asia/Dhaka · GMT+6" from the device's live timezone (owner spec: show it).
    private var tzLine: String {
        let tz = TimeZone.current
        let hours = tz.secondsFromGMT() / 3600
        let mins = abs(tz.secondsFromGMT() / 60) % 60
        let off = mins == 0 ? "GMT\(hours >= 0 ? "+" : "")\(hours)"
                            : String(format: "GMT%+d:%02d", hours, mins)
        return "\(tz.identifier) · \(off)"
    }

    var body: some View {
        TimelineView(.everyMinute) { context in
            let now = context.date
            let hour = Calendar.current.component(.hour, from: now)
            HeroCardChrome(
                light: (Color(red: 1.00, green: 0.91, blue: 0.76), Color(red: 1.00, green: 0.97, blue: 0.90)),
                dark: (Color(red: 0.180, green: 0.128, blue: 0.259), Color(red: 0.090, green: 0.082, blue: 0.129))
            ) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(Self.day.string(from: now))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Image(systemName: (6..<18).contains(hour) ? "sun.max.fill" : "moon.stars.fill")
                            .font(.subheadline)
                            .foregroundStyle((6..<18).contains(hour)
                                             ? Color(red: 0.95, green: 0.65, blue: 0.15)
                                             : Color(red: 0.655, green: 0.545, blue: 0.980))
                    }
                    Spacer(minLength: 6)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(Self.time.string(from: now))
                            .font(.system(size: 40, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.primary)
                            .contentTransition(.numericText())
                        Text(Self.ampm.string(from: now))
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    Text(Self.date.string(from: now))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.primary.opacity(0.8))
                    Text(tzLine)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.top, 1)
                }
            }
        }
    }
}

/// Card 2 — dynamic alerts (fines · missed intercom calls · unread chat · agent
/// no-response). Rotates through items every 4s when there are more than two.
@available(iOS 17.0, *)
private struct AlertsHeroCard: View {
    let vm: MoreVM
    let onTap: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        } label: {
            HeroCardChrome(
                light: (Color(red: 0.85, green: 0.93, blue: 1.00), Color(red: 0.95, green: 0.98, blue: 1.00)),
                dark: (Color(red: 0.105, green: 0.150, blue: 0.270), Color(red: 0.078, green: 0.094, blue: 0.164))
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "bell.badge.fill")
                            .font(.subheadline)
                            .foregroundStyle(Color(red: 0.35, green: 0.62, blue: 0.95))
                        Text("Alerts")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        if !vm.alerts.isEmpty {
                            Text("\(vm.alerts.count)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Color(red: 0.878, green: 0.478, blue: 0.373), in: Capsule())
                        }
                    }
                    if vm.alerts.isEmpty {
                        Spacer()
                        VStack(alignment: .leading, spacing: 6) {
                            Image(systemName: vm.loadedOnce ? "checkmark.seal.fill" : "ellipsis")
                                .font(.title2)
                                .foregroundStyle(vm.loadedOnce
                                                 ? Color(red: 0.506, green: 0.698, blue: 0.604)
                                                 : Color.secondary)
                            Text(vm.loadedOnce ? "সব ঠিক আছে" : "লোড হচ্ছে…")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                        }
                        Spacer()
                    } else {
                        // Two visible rows, rotating through the list every 4 seconds.
                        TimelineView(.periodic(from: .now, by: 4)) { context in
                            let n = vm.alerts.count
                            let idx = n <= 2 ? 0 : Int(context.date.timeIntervalSinceReferenceDate / 4) % n
                            VStack(alignment: .leading, spacing: 8) {
                                alertRow(vm.alerts[idx])
                                if n > 1 { alertRow(vm.alerts[(idx + 1) % n]) }
                            }
                            .id(idx)
                            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity),
                                                    removal: .opacity))
                            .animation(.spring(response: 0.5, dampingFraction: 0.9), value: idx)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .buttonStyle(HeroPressStyle())
    }

    private func alertRow(_ alert: MorePulseAlert) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: alert.icon)
                .font(.caption)
                .foregroundStyle(alert.tint)
                .frame(width: 22, height: 22)
                .background(alert.tint.opacity(scheme == .dark ? 0.22 : 0.15), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(alert.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let detail = alert.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let amount = alert.amount, amount != 0 {
                Text("৳\(amount.formatted())")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
            }
        }
    }
}

/// Card 3 — weekly + monthly progress (task completion + office-time compliance,
/// computed server-side). Bars sweep in with a spring on first appearance.
@available(iOS 17.0, *)
private struct ProgressHeroCard: View {
    let vm: MoreVM
    let onTap: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var appeared = false

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        } label: {
            HeroCardChrome(
                light: (Color(red: 0.87, green: 0.96, blue: 0.91), Color(red: 0.95, green: 0.99, blue: 0.96)),
                dark: (Color(red: 0.070, green: 0.180, blue: 0.135), Color(red: 0.063, green: 0.113, blue: 0.090))
            ) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "chart.line.uptrend.xyaxis")
                            .font(.subheadline)
                            .foregroundStyle(Color(red: 0.506, green: 0.698, blue: 0.604))
                        Text("Progress")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    Spacer(minLength: 0)
                    if let progress = vm.progress,
                       progress.weeklyPct != nil || progress.monthlyPct != nil {
                        progressRow(name: "Weekly", pct: progress.weeklyPct, label: progress.weeklyLabel)
                        progressRow(name: "Monthly", pct: progress.monthlyPct, label: progress.monthlyLabel)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Image(systemName: vm.loadedOnce ? "chart.bar" : "ellipsis")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            Text(vm.loadedOnce ? "এখনো ডেটা নেই" : "লোড হচ্ছে…")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .buttonStyle(HeroPressStyle())
        .onAppear {
            withAnimation(.spring(response: 0.8, dampingFraction: 0.85).delay(0.2)) {
                appeared = true
            }
        }
    }

    private func barColor(_ pct: Int) -> Color {
        if pct >= 75 { return Color(red: 0.506, green: 0.698, blue: 0.604) }  // sage
        if pct >= 45 { return Color(red: 0.94, green: 0.62, blue: 0.25) }     // amber
        return Color(red: 0.878, green: 0.478, blue: 0.373)                   // coral
    }

    @ViewBuilder
    private func progressRow(name: String, pct: Int?, label: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Text(pct.map { "\($0)%" } ?? "—")
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(pct.map { barColor($0) } ?? Color.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(scheme == .dark ? 0.14 : 0.08))
                    if let pct {
                        Capsule()
                            .fill(LinearGradient(colors: [barColor(pct).opacity(0.75), barColor(pct)],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: appeared ? geo.size.width * CGFloat(pct) / 100 : 0)
                    }
                }
            }
            .frame(height: 7)
            if let label, !label.isEmpty {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// Hero-card press feedback: gentle scale instead of the row-darken style.
@available(iOS 17.0, *)
private struct HeroPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

// MARK: - Profile sheet (opened by the round avatar bar button, top-right)

/// Absolute URL for API-relative paths like /api/users/{id}/profile-image —
/// URLSession/AsyncImage send the synced session cookies for the ERP host.
private func almaAbsoluteURL(_ s: String?) -> URL? {
    guard let s, !s.isEmpty else { return nil }
    if s.hasPrefix("http") { return URL(string: s) }
    return URL(string: s, relativeTo: AlmaAPI.baseURL)
}

private struct MoreAvatarUploadResponse: Decodable {
    let ok: Bool?
    let profileImageUrl: String?
}
private struct MoreOkResponse: Decodable { let ok: Bool? }
private struct MoreCsrfResponse: Decodable { let csrfToken: String? }

/// Square-crop (centre) + downscale + JPEG-encode a picked photo into the web
/// endpoint's `data:` URL format. 640px is plenty for a 120pt avatar and stays
/// far under the server's 8 MB decoded-buffer cap.
private func almaAvatarDataURL(_ image: UIImage, maxSide: CGFloat = 640) -> String? {
    let side = min(image.size.width, image.size.height)
    let origin = CGPoint(x: (image.size.width - side) / 2, y: (image.size.height - side) / 2)
    let target = min(side, maxSide)
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: target, height: target))
    let squared = renderer.image { _ in
        // Draw the FULL image scaled so the centre square lands exactly on the
        // target canvas; everything outside the square falls off the edges.
        let scale = target / side
        image.draw(in: CGRect(x: -origin.x * scale, y: -origin.y * scale,
                              width: image.size.width * scale, height: image.size.height * scale))
    }
    guard let jpeg = squared.jpegData(compressionQuality: 0.85) else { return nil }
    return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
}

@available(iOS 17.0, *)
private struct MoreProfileSheet: View {
    let vm: MoreVM
    let toggleDark: () -> Void
    var nativeScreensOn: Bool
    var toggleNativeScreens: (() -> Void)?
    var readBiometricLock: ((@escaping (Bool) -> Void) -> Void)?
    var setBiometricLock: ((Bool) -> Void)?
    /// Web push (used to reach the login page after sign-out).
    let openPath: (_ path: String, _ title: String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    /// Mirrors AlmaTheme.isDark; resynced on every almaThemeChanged broadcast.
    @State private var isDark = MoreTheme.isDark
    /// Face ID switch — seeded from cache, reconciled with web localStorage on appear.
    @State private var faceLockOn = UserDefaults.standard.object(forKey: "alma-biometric-lock-cache") as? Bool ?? true
    @State private var accent = AlmaAccent.current
    @State private var photoItem: PhotosPickerItem?
    @State private var uploadingPhoto = false
    @State private var photoError: String?
    @State private var showPasswordSheet = false
    @State private var showContactSheet = false
    @State private var confirmSignOut = false
    @State private var signingOut = false

    private var violet: Color { Color(red: 0.655, green: 0.545, blue: 0.980) }
    private var coral: Color { Color(red: 0.878, green: 0.478, blue: 0.373) }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header
                appearanceCard
                securityCard
                accountCard
                signOutCard
                versionFooter
            }
            .padding(.horizontal, 16)
            .padding(.top, 26)
            .padding(.bottom, 30)
        }
        .background(OrdersAurora())
        .onReceive(NotificationCenter.default.publisher(for: MoreTheme.changed)) { _ in
            isDark = MoreTheme.isDark
        }
        .onAppear { readBiometricLock? { on in faceLockOn = on } }
        .sheet(isPresented: $showPasswordSheet) {
            MoreChangePasswordSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showContactSheet) {
            MoreEditContactSheet(vm: vm)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog("সাইন আউট করবেন?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("সাইন আউট", role: .destructive) { Task { await signOut() } }
            Button("বাতিল", role: .cancel) {}
        }
    }

    // ── Header: round avatar + camera badge + identity ──

    private var header: some View {
        VStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let url = almaAbsoluteURL(vm.profileImageUrl) {
                        AsyncImage(url: url) { phase in
                            if let image = phase.image {
                                image.resizable().scaledToFill()
                            } else {
                                initialsCircle
                            }
                        }
                    } else {
                        initialsCircle
                    }
                }
                .frame(width: 120, height: 120)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(.white.opacity(scheme == .dark ? 0.18 : 0.75), lineWidth: 3))
                .shadow(color: .black.opacity(scheme == .dark ? 0.4 : 0.12), radius: 12, y: 5)
                .overlay {
                    if uploadingPhoto {
                        Circle().fill(.black.opacity(0.35))
                        ProgressView().tint(.white)
                    }
                }

                // Camera badge = the photo picker (upload / change).
                PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "camera.fill")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(violet, in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.9), lineWidth: 2))
                }
                .disabled(uploadingPhoto)
            }
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task { await uploadPhoto(item) }
            }

            VStack(spacing: 3) {
                Text(vm.userName.isEmpty ? "—" : vm.userName)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.primary)
                if let email = vm.email, !email.isEmpty {
                    Text(email).font(.footnote).foregroundStyle(.secondary)
                }
                Text(vm.isOwner ? "Owner" : "Staff")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(vm.isOwner ? coral : violet)
                    .padding(.horizontal, 10).padding(.vertical, 3)
                    .background((vm.isOwner ? coral : violet).opacity(0.14), in: Capsule())
            }
            if let photoError {
                Text(photoError).font(.caption).foregroundStyle(coral)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var initialsCircle: some View {
        ZStack {
            LinearGradient(colors: [violet.opacity(0.85), coral.opacity(0.75)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(String(vm.userName.prefix(1)).uppercased())
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    private func uploadPhoto(_ item: PhotosPickerItem) async {
        photoError = nil
        uploadingPhoto = true
        defer { uploadingPhoto = false; photoItem = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let dataURL = almaAvatarDataURL(image) else {
                photoError = "ছবিটা পড়া যায়নি — অন্য একটা ছবি চেষ্টা করুন"
                return
            }
            struct Body: Encodable { let image_data_url: String }
            let resp: MoreAvatarUploadResponse = try await AlmaAPI.shared.send(
                "POST", "/api/users/me/profile-image", body: Body(image_data_url: dataURL))
            if resp.ok == true {
                // ?v=timestamp in the returned URL busts AsyncImage/URLCache.
                vm.profileImageUrl = resp.profileImageUrl
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                photoError = "আপলোড হয়নি — আবার চেষ্টা করুন"
            }
        } catch {
            photoError = "আপলোড হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
        }
    }

    // ── Appearance: dark mode · accent variants · native screens ──

    private var appearanceCard: some View {
        profileSection(header: "Appearance") {
            // Dark Mode (moved here from the More list — owner spec).
            profileRow(icon: isDark ? "moon.fill" : "sun.max.fill",
                       tint: isDark ? violet : .orange, title: "Dark Mode") {
                Toggle("Dark Mode", isOn: Binding(
                    get: { isDark },
                    set: { newValue in
                        guard newValue != isDark else { return }
                        UISelectionFeedbackGenerator().selectionChanged()
                        toggleDark()
                    }
                ))
                .labelsHidden()
                .tint(violet)
            }
            Divider().padding(.leading, 58)
            // Accent variants — the web menu's colour presets, now native.
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 12) {
                    Image(systemName: "paintpalette.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(accent.color)
                        .frame(width: 32, height: 32)
                        .background(accent.color.opacity(scheme == .dark ? 0.18 : 0.12),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    Text("Accent Color").font(.body).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text(accent.label).font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 14) {
                    ForEach(AlmaAccent.allCases, id: \.rawValue) { option in
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            accent = option
                            AlmaAccent.set(option)
                        } label: {
                            ZStack {
                                Circle().fill(option.color)
                                if option == accent {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.heavy))
                                        .foregroundStyle(.white)
                                }
                            }
                            .frame(width: 30, height: 30)
                            .overlay(Circle().strokeBorder(
                                option == accent ? option.color.opacity(0.45) : .clear, lineWidth: 3)
                                .padding(-4))
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                }
                .padding(.leading, 44)
                Text("ওয়েব পেজগুলোতে পরের লোড থেকে নতুন রং কার্যকর হবে")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.leading, 44)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            if toggleNativeScreens != nil {
                Divider().padding(.leading, 58)
                profileRow(icon: "swift", tint: coral, title: "Native স্ক্রিন",
                           subtitle: "বন্ধ করলে আগের ওয়েব স্ক্রিন ফিরবে") {
                    Toggle("Native screens", isOn: Binding(
                        get: { nativeScreensOn },
                        set: { _ in
                            UISelectionFeedbackGenerator().selectionChanged()
                            toggleNativeScreens?()
                        }
                    ))
                    .labelsHidden()
                    .tint(coral)
                }
            }
        }
    }

    // ── Security: Face ID lock · change password ──

    private var securityCard: some View {
        let green = Color(red: 0.231, green: 0.784, blue: 0.522)
        return profileSection(header: "Security") {
            if readBiometricLock != nil {
                profileRow(icon: "faceid", tint: green, title: "অ্যাপ লক (Face ID)",
                           subtitle: "অ্যাপ খুললে বা কিছুক্ষণ পর ফিরে এলে Face ID / Touch ID দিয়ে আনলক") {
                    Toggle("App lock", isOn: Binding(
                        get: { faceLockOn },
                        set: { newValue in
                            guard newValue != faceLockOn else { return }
                            UISelectionFeedbackGenerator().selectionChanged()
                            faceLockOn = newValue
                            setBiometricLock?(newValue)
                        }
                    ))
                    .labelsHidden()
                    .tint(green)
                }
                Divider().padding(.leading, 58)
            }
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showPasswordSheet = true
            } label: {
                profileRow(icon: "key.fill", tint: violet, title: "Password পরিবর্তন") {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(MoreRowButtonStyle())
        }
    }

    // ── Account: name/phone (editable) · email (admin-managed) ──

    private var accountCard: some View {
        profileSection(header: "Account") {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showContactSheet = true
            } label: {
                profileRow(icon: "person.text.rectangle", tint: violet, title: "নাম ও ফোন",
                           subtitle: [vm.userName, vm.phone ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")) {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(MoreRowButtonStyle())
            Divider().padding(.leading, 58)
            // Email is the login identifier — self-service change has no backend
            // (only admins via /api/users/[id]), so it is shown read-only on purpose.
            profileRow(icon: "envelope.fill", tint: .secondary, title: "Email",
                       subtitle: (vm.email?.isEmpty == false ? vm.email! : "সেট করা নেই")
                           + " · পরিবর্তনের জন্য অ্যাডমিন") {
                Image(systemName: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // ── Sign out + version ──

    private var signOutCard: some View {
        Button {
            confirmSignOut = true
        } label: {
            HStack {
                Spacer()
                if signingOut {
                    ProgressView().tint(coral)
                } else {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.subheadline.weight(.semibold))
                    Text("সাইন আউট").font(.body.weight(.semibold))
                }
                Spacer()
            }
            .foregroundStyle(coral)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(MoreRowButtonStyle())
        .disabled(signingOut)
        .ordersGlass(scheme, corner: AlmaSwiftTheme.rCard)
        .shadow(color: .black.opacity(scheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
    }

    private var versionFooter: some View {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return Text("ALMA ERP v\(version) (\(build))")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
    }

    /// NextAuth sign-out, natively: CSRF token → form-POST /api/auth/signout →
    /// purge the session cookies from BOTH cookie jars (URLSession + WKWebView)
    /// so no surface stays half-logged-in → land on the web login page.
    private func signOut() async {
        signingOut = true
        defer { signingOut = false }
        do {
            let csrf: MoreCsrfResponse = try await AlmaAPI.shared.get("/api/auth/csrf")
            guard let token = csrf.csrfToken, !token.isEmpty else { return }
            var request = URLRequest(url: AlmaAPI.baseURL.appendingPathComponent("api/auth/signout"))
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
            request.httpBody = "csrfToken=\(encoded)&json=true".data(using: .utf8)
            _ = try await URLSession.shared.data(for: request)
        } catch {
            // Even if the POST failed, fall through to the local purge — the user
            // asked to sign out; a dead session cookie must not keep them "in".
        }
        await purgeSessionCookies()
        AlmaAPI.shared.invalidateCookieCache()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
        openPath("/login", "Login")
    }

    private func purgeSessionCookies() async {
        // URLSession jar
        for cookie in HTTPCookieStorage.shared.cookies ?? []
        where cookie.name.contains("next-auth.session-token") {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        // WKWebView jar (shared by every web tab)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async {
                let store = WKWebsiteDataStore.default().httpCookieStore
                store.getAllCookies { cookies in
                    let session = cookies.filter { $0.name.contains("next-auth.session-token") }
                    guard !session.isEmpty else { continuation.resume(); return }
                    var remaining = session.count
                    for cookie in session {
                        store.delete(cookie) {
                            remaining -= 1
                            if remaining == 0 { continuation.resume() }
                        }
                    }
                }
            }
        }
    }

    // ── Shared scaffolding (glass cards on the aurora, same look as More) ──

    @ViewBuilder
    private func profileSection(header: String, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(header.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(scheme == .dark ? Color.white.opacity(0.72)
                                                 : Color.black.opacity(0.55))
                .padding(.leading, 14)
            VStack(spacing: 0) { rows() }
                .ordersGlass(scheme, corner: AlmaSwiftTheme.rCard)
                .shadow(color: .black.opacity(scheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
        }
    }

    @ViewBuilder
    private func profileRow(icon: String, tint: Color, title: String,
                            subtitle: String? = nil,
                            @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(scheme == .dark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body).foregroundStyle(.primary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

// MARK: - Change-password sheet (POST /api/users/me/password)

@available(iOS 17.0, *)
private struct MoreChangePasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var current = ""
    @State private var newPassword = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var errorText: String?

    private var valid: Bool {
        !current.isEmpty && newPassword.count >= 8 && newPassword == confirm
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Password পরিবর্তন")
                    .font(.title3.weight(.bold))
                    .padding(.top, 18)
                VStack(spacing: 0) {
                    secureRow("বর্তমান password", text: $current)
                    Divider().padding(.leading, 14)
                    secureRow("নতুন password (কমপক্ষে ৮ অক্ষর)", text: $newPassword)
                    Divider().padding(.leading, 14)
                    secureRow("নতুন password আবার লিখুন", text: $confirm)
                }
                .ordersGlass(scheme, corner: AlmaSwiftTheme.rCard)
                if !newPassword.isEmpty && newPassword.count < 8 {
                    Text("নতুন password কমপক্ষে ৮ অক্ষরের হতে হবে")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !confirm.isEmpty && confirm != newPassword {
                    Text("দুইবার লেখা password মিলছে না")
                        .font(.caption).foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
                }
                if let errorText {
                    Text(errorText).font(.caption)
                        .foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
                }
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Spacer()
                        if busy { ProgressView().tint(.white) }
                        else { Text("পরিবর্তন করুন").font(.body.weight(.semibold)) }
                        Spacer()
                    }
                    .foregroundStyle(.white)
                    .padding(.vertical, 13)
                    .background(Color(red: 0.655, green: 0.545, blue: 0.980).opacity(valid ? 1 : 0.4),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
                .disabled(!valid || busy)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
        .background(OrdersAurora())
    }

    private func secureRow(_ placeholder: String, text: Binding<String>) -> some View {
        SecureField(placeholder, text: text)
            .textContentType(.password)
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        errorText = nil
        struct Body: Encodable { let currentPassword: String; let newPassword: String }
        do {
            let resp: MoreOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/users/me/password",
                body: Body(currentPassword: current, newPassword: newPassword))
            if resp.ok == true {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } else {
                errorText = "পরিবর্তন হয়নি — আবার চেষ্টা করুন"
            }
        } catch let e as AlmaAPIError {
            if case .http(let status, let bodyText) = e, status == 400,
               bodyText.contains("incorrect") {
                errorText = "বর্তমান password ভুল"
            } else {
                errorText = "পরিবর্তন হয়নি — আবার চেষ্টা করুন"
            }
        } catch {
            errorText = "পরিবর্তন হয়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন"
        }
    }
}

// MARK: - Edit name/phone sheet (PATCH /api/users/me)

@available(iOS 17.0, *)
private struct MoreEditContactSheet: View {
    let vm: MoreVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var name = ""
    @State private var phone = ""
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("নাম ও ফোন")
                    .font(.title3.weight(.bold))
                    .padding(.top, 18)
                VStack(spacing: 0) {
                    TextField("নাম", text: $name)
                        .textContentType(.name)
                        .padding(.horizontal, 14).padding(.vertical, 13)
                    Divider().padding(.leading, 14)
                    TextField("ফোন (01… / +880…)", text: $phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)
                        .padding(.horizontal, 14).padding(.vertical, 13)
                }
                .ordersGlass(scheme, corner: AlmaSwiftTheme.rCard)
                if let errorText {
                    Text(errorText).font(.caption)
                        .foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
                }
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Spacer()
                        if busy { ProgressView().tint(.white) }
                        else { Text("সেভ করুন").font(.body.weight(.semibold)) }
                        Spacer()
                    }
                    .foregroundStyle(.white)
                    .padding(.vertical, 13)
                    .background(Color(red: 0.655, green: 0.545, blue: 0.980)
                        .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.4 : 1),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
        .background(OrdersAurora())
        .onAppear {
            name = vm.userName
            phone = vm.phone ?? ""
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        errorText = nil
        struct Body: Encodable { let name: String; let phone: String }
        do {
            let trimmedName = name.trimmingCharacters(in: .whitespaces)
            let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
            let _: MoreOkResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/users/me", body: Body(name: trimmedName, phone: trimmedPhone))
            vm.userName = trimmedName
            vm.phone = trimmedPhone.isEmpty ? nil : trimmedPhone
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            errorText = "সেভ হয়নি — আবার চেষ্টা করুন"
        }
    }
}

// MARK: - Business switcher sheet (opened by the glossy nav pill)

@available(iOS 17.0, *)
private struct MoreBusinessSheet: View {
    let businesses: [MoreMenuScreen.Biz]
    let cardBg: Color
    let rootBg: Color
    let select: (MoreMenuScreen.Biz) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Switch Business")
                    .font(.title3.weight(.bold))
                Text("যে বিজনেসে যেতে চান সেটি বেছে নিন")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 18)
            VStack(spacing: 0) {
                ForEach(Array(businesses.enumerated()), id: \.element.bizId) { idx, biz in
                    if idx > 0 { Divider().padding(.leading, 62) }
                    Button {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        select(biz)
                    } label: {
                        HStack(spacing: 14) {
                            ZStack {
                                Circle().fill(biz.color)
                                Text(biz.letter)
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(.white)
                            }
                            .frame(width: 36, height: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(biz.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                                Text(biz.tagline).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.right.circle.fill")
                                .font(.title3)
                                .foregroundStyle(biz.color.opacity(0.8))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(MoreRowButtonStyle())
                }
            }
            .background(cardBg, in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .presentationBackground(rootBg)
    }
}

// MARK: - Pressed-state style

/// UITableView-like touch feedback: brief darken of the row while pressed
/// (plain Button's default opacity fade looks web-ish inside opaque cards).
@available(iOS 17.0, *)
private struct MoreRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.primary.opacity(0.07) : .clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - Previews (stub closures, both themes)

@available(iOS 17.0, *)
#Preview("More — Light") {
    NavigationStack {
        MoreMenuScreen(openPath: { path, title in print("open \(title): \(path)") },
                       openCompanion: { print("open companion") },
                       toggleDark: { print("toggle dark") })
            .navigationTitle("More")
    }
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("More — Dark") {
    NavigationStack {
        MoreMenuScreen(openPath: { path, title in print("open \(title): \(path)") },
                       openCompanion: { print("open companion") },
                       toggleDark: { print("toggle dark") })
            .navigationTitle("More")
    }
    .preferredColorScheme(.dark)
}

