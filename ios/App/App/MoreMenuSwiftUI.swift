//
//  MoreMenuSwiftUI.swift
//  ALMA ERP — the More tab, redesigned in the Apple-Watch-app layout (owner spec,
//  2026-07-08): large title = the logged-in user's NAME, a fixed glossy "Business"
//  pill top-left (bar button, wired in SwiftUIShell) that opens the business
//  switcher sheet, a horizontal row of three premium "hero" cards where the Watch
//  app shows My Faces (live clock/date/timezone · dynamic alerts · weekly+monthly
//  progress), and every nav group below COLLAPSIBLE with a spring chevron.
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
}

// MARK: - /api/assistant/more-pulse models (defensive decoding — one bad field
// must never blank the whole screen, same policy as AlmaOrder)

struct MorePulseUser: Decodable {
    let name: String
    let isOwner: Bool
    let businessAccess: [String]

    enum CodingKeys: String, CodingKey { case name, isOwner, businessAccess }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        isOwner = (try? c.decode(Bool.self, forKey: .isOwner)) ?? false
        businessAccess = (try? c.decode([String].self, forKey: .businessAccess)) ?? []
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
    }
    let user: MeUser?
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class MoreVM {
    var userName: String = ""
    var isOwner = false
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
                    allowedBusinessIds = (u.businessAccess ?? "")
                        .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }
                }
            }
        }
    }
}

// MARK: - Collapsible-group persistence

/// Which nav groups are expanded, persisted so the owner's arrangement survives
/// relaunch. First run = everything collapsed (the Watch-app "clean" look).
private enum MoreExpandState {
    private static let key = "alma-more-expanded-groups"
    static func load() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }
    static func save(_ groups: Set<String>) {
        UserDefaults.standard.set(Array(groups).sorted(), forKey: key)
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

    @Environment(\.colorScheme) private var colorScheme
    /// Mirrors AlmaTheme.isDark for the switch + sun/moon icon; resynced on every
    /// almaThemeChanged broadcast so an external flip (e.g. web toggle) can't desync it.
    @State private var isDark = MoreTheme.isDark
    /// Face ID lock switch position. Seeded from the local cache for an instant, correct
    /// first paint; reconciled against the web localStorage value on appear.
    @State private var faceLockOn = UserDefaults.standard.object(forKey: "alma-biometric-lock-cache") as? Bool ?? true
    @State private var vm = MoreVM()
    @State private var expandedGroups: Set<String> = MoreExpandState.load()
    @State private var showBusinessSheet = false

    // ── Menu data — same items as before; "Switch business" moved to the glossy
    //    pill + sheet, so it is no longer a list section ──

    fileprivate struct MenuItem { let title: String; let icon: String; let path: String }
    fileprivate struct MenuGroup { let header: String; let icon: String; let items: [MenuItem] }

    private static var groups: [MenuGroup] {
        // P3 mobile companion: "native:companion" is a sentinel — that row pushes the
        // NATIVE companion screen (openCompanion) instead of a web view.
        var agentItems: [MenuItem] = [
            MenuItem(title: "Phone Companion", icon: "iphone.radiowaves.left.and.right", path: "native:companion"),
            MenuItem(title: "Live Watch",      icon: "eye",                              path: "/agent/live-watch"),
            MenuItem(title: "Credit Usage",    icon: "chart.bar.xaxis",                  path: "/agent/credit-usage"),
            MenuItem(title: "Subscriptions",   icon: "repeat.circle",                    path: "/agent/subscriptions"),
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
                ForEach(Self.groups, id: \.header) { group in
                    collapsibleGroup(group)
                }
                section(header: "Appearance") {
                    darkModeRow
                    if toggleNativeScreens != nil {
                        Divider().padding(.leading, 58)
                        nativeScreensRow
                    }
                }
                if readBiometricLock != nil {
                    section(header: "Security") { faceLockRow }
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
        // External theme flips (web toggle, another screen) must move OUR switch too.
        .onReceive(NotificationCenter.default.publisher(for: MoreTheme.changed)) { _ in
            isDark = MoreTheme.isDark
        }
        // The host's glossy "Business" pill (bar button) asks us to present the sheet.
        .onReceive(NotificationCenter.default.publisher(for: .almaShowBusinessSwitch)) { _ in
            showBusinessSheet = true
        }
        .onChange(of: vm.userName) { _, name in
            if !name.isEmpty { onUserName(name) }
        }
        // Reconcile the Face ID switch with the real web localStorage value on appear.
        .onAppear {
            readBiometricLock? { on in faceLockOn = on }
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
    }

    /// Businesses the sheet offers: filtered by the server's access list once known,
    /// all three while identity is still loading (server enforces access anyway).
    private var allowedBusinesses: [Biz] {
        guard !vm.allowedBusinessIds.isEmpty else { return Self.businesses }
        let allowed = Self.businesses.filter { vm.allowedBusinessIds.contains($0.bizId) }
        return allowed.isEmpty ? Self.businesses : allowed
    }

    // ── Collapsible nav group (Watch-app style card whose header row toggles it) ──

    @ViewBuilder
    private func collapsibleGroup(_ group: MenuGroup) -> some View {
        let expanded = expandedGroups.contains(group.header)
        VStack(spacing: 0) {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                withAnimation(.spring(response: 0.36, dampingFraction: 0.86)) {
                    if expanded { expandedGroups.remove(group.header) }
                    else { expandedGroups.insert(group.header) }
                    MoreExpandState.save(expandedGroups)
                }
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
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 0 : -90))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(MoreRowButtonStyle())

            if expanded {
                ForEach(Array(group.items.enumerated()), id: \.element.title) { _, item in
                    Divider().padding(.leading, 58)
                    Button {
                        open(item)
                    } label: {
                        HStack(spacing: 12) {
                            itemLabel(item)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(MoreRowButtonStyle())
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
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

    // ── Section card scaffold (non-collapsible, used by Appearance / Security) ──

    /// Small uppercase header + rounded card of rows (the "inset grouped" look,
    /// hand-built because List can't sit on the app's aurora background).
    @ViewBuilder
    private func section(header: String, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(header.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                // On the raw aurora (outside the card) headers need real contrast, not
                // the washed-out .secondary the owner flagged as hard to read.
                .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.72)
                                                      : Color.black.opacity(0.55))
                .padding(.leading, 14)
            // Frosted-glass card so the aurora glows through but the rows stay crisp.
            VStack(spacing: 0) { rows() }
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
        }
    }

    // ── Row labels ──

    /// Module row: SF Symbol in a violet-tinted rounded square (premium-iOS icon chip).
    private func itemLabel(_ item: MenuItem) -> some View {
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
        }
    }

    /// Appearance row — the app-wide Dark Mode switch. Icon mirrors the UIKit cell
    /// (moon = violet in dark, sun = orange in light). The Toggle's setter only calls
    /// the host's toggleDark(); state comes BACK via the almaThemeChanged broadcast,
    /// keeping AlmaTheme the single source of truth.
    private var darkModeRow: some View {
        HStack(spacing: 12) {
            Image(systemName: isDark ? "moon.fill" : "sun.max.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(isDark ? violet : Color.orange)
                .frame(width: 32, height: 32)
                .background((isDark ? violet : Color.orange).opacity(isDark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Text("Dark Mode")
                .font(.body)
                .foregroundStyle(.primary)
            Spacer(minLength: 8)
            Toggle("Dark Mode", isOn: Binding(
                get: { isDark },
                set: { newValue in
                    guard newValue != isDark else { return }
                    UISelectionFeedbackGenerator().selectionChanged() // same tick as UIKit
                    toggleDark()
                }
            ))
            .labelsHidden()
            .tint(violet)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    /// App-lock switch — Face ID / Touch ID gate on cold start + resume-after-idle.
    /// Writes the web app's localStorage flag through the host; state seeds from the
    /// local cache and reconciles with the real value on appear.
    private var faceLockRow: some View {
        let green = Color(red: 0.231, green: 0.784, blue: 0.522)
        return HStack(spacing: 12) {
            Image(systemName: "faceid")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(green)
                .frame(width: 32, height: 32)
                .background(green.opacity(colorScheme == .dark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text("অ্যাপ লক (Face ID)").font(.body).foregroundStyle(.primary)
                Text("অ্যাপ খুললে বা কিছুক্ষণ পর ফিরে এলে Face ID / Touch ID দিয়ে আনলক")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
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
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    /// "Native স্ক্রিন" switch — OFF instantly restores the web Orders/Approvals and the
    /// UIKit More menu (one-tap escape if a native screen misbehaves; no reinstall).
    private var nativeScreensRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "swift")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
                .frame(width: 32, height: 32)
                .background(Color(red: 0.878, green: 0.478, blue: 0.373).opacity(colorScheme == .dark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text("Native স্ক্রিন").font(.body).foregroundStyle(.primary)
                Text("বন্ধ করলে আগের ওয়েব স্ক্রিন ফিরবে").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("Native screens", isOn: Binding(
                get: { nativeScreensOn },
                set: { _ in
                    UISelectionFeedbackGenerator().selectionChanged()
                    toggleNativeScreens?()
                }
            ))
            .labelsHidden()
            .tint(Color(red: 0.878, green: 0.478, blue: 0.373))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
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

    var body: some View {
        let stops = scheme == .dark ? dark : light
        content
            .padding(14)
            .frame(width: 210, height: 168, alignment: .topLeading)
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
