//
//  MoreMenuSwiftUI.swift
//  ALMA ERP — SwiftUI rewrite of the More tab (replaces MoreMenuViewController's
//  UITableView with premium grouped "inset cards": ScrollView + LazyVStack, rounded-16
//  surfaces, tinted icon squares, soft haptics, Claude-style top fade).
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
//  Navigation stays in the host: rows call openPath(path, title) (web screen push) or
//  openCompanion() (native companion push) — this view owns zero WKWebView/nav state.
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

// MARK: - Screen

@available(iOS 17.0, *)
struct MoreMenuScreen: View {
    /// Pushes a web screen for an ERP route (host builds the AlmaWebTabViewController).
    let openPath: (_ path: String, _ title: String) -> Void
    /// Pushes the NATIVE Phone Companion screen (the "native:companion" row in UIKit).
    let openCompanion: () -> Void
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

    @Environment(\.colorScheme) private var colorScheme
    /// Mirrors AlmaTheme.isDark for the switch + sun/moon icon; resynced on every
    /// almaThemeChanged broadcast so an external flip (e.g. web toggle) can't desync it.
    @State private var isDark = MoreTheme.isDark
    /// Face ID lock switch position. Seeded from the local cache for an instant, correct
    /// first paint; reconciled against the web localStorage value on appear.
    @State private var faceLockOn = UserDefaults.standard.object(forKey: "alma-biometric-lock-cache") as? Bool ?? true

    // ── Menu data — EXACT copy of MoreMenuViewController's sections/items/paths/icons ──

    private struct MenuItem { let title: String; let icon: String; let path: String }
    private struct MenuGroup { let header: String; let items: [MenuItem] }

    private static let groups: [MenuGroup] = [
        // P3 mobile companion: "native:companion" is a sentinel — that row pushes the
        // NATIVE companion screen (openCompanion) instead of a web view.
        MenuGroup(header: "Agent", items: [
            MenuItem(title: "Phone Companion", icon: "iphone.radiowaves.left.and.right", path: "native:companion"),
            MenuItem(title: "Live Watch",      icon: "eye",                              path: "/agent/live-watch"),
        ]),
        MenuGroup(header: "Workspace", items: [
            MenuItem(title: "My Desk",         icon: "person.crop.square", path: "/portal"),
            MenuItem(title: "Office",          icon: "building.2",         path: "/portal/office"),
            MenuItem(title: "Product Images",  icon: "photo.on.rectangle", path: "/agent/catalog-images"),
            MenuItem(title: "Creative Studio", icon: "wand.and.stars",     path: "/agent/creative-studio"),
        ]),
        MenuGroup(header: "Money", items: [
            MenuItem(title: "Finance",  icon: "banknote",          path: "/finance"),
            MenuItem(title: "Expenses", icon: "creditcard",        path: "/expenses"),
            MenuItem(title: "Payroll",  icon: "dollarsign.circle", path: "/payroll"),
            MenuItem(title: "Invoices", icon: "doc.text",          path: "/invoice"),
        ]),
        MenuGroup(header: "Operations", items: [
            MenuItem(title: "Inventory",      icon: "shippingbox", path: "/inventory"),
            MenuItem(title: "Activity",       icon: "bolt",        path: "/activity"),
            MenuItem(title: "Task Spotlight", icon: "target",      path: "/operations/task-spotlight"),
            MenuItem(title: "Archive",        icon: "archivebox",  path: "/operations/business-archive"),
        ]),
        MenuGroup(header: "People", items: [
            MenuItem(title: "Employees",  icon: "person.2",                           path: "/employees"),
            MenuItem(title: "Attendance", icon: "calendar.badge.clock",               path: "/attendance"),
            MenuItem(title: "CRM",        icon: "person.crop.circle.badge.checkmark", path: "/crm"),
        ]),
        MenuGroup(header: "Insights", items: [
            MenuItem(title: "Analytics", icon: "chart.bar", path: "/analytics"),
            MenuItem(title: "Insights",  icon: "lightbulb", path: "/insights"),
            MenuItem(title: "Briefing",  icon: "newspaper", path: "/briefing"),
            MenuItem(title: "Audit",     icon: "checklist", path: "/audit"),
        ]),
        MenuGroup(header: "Settings", items: [
            MenuItem(title: "Users",         icon: "person.3",           path: "/settings/users"),
            MenuItem(title: "Notifications", icon: "bell.badge",         path: "/settings/notifications"),
            MenuItem(title: "Branding",      icon: "paintpalette",       path: "/settings/branding"),
            MenuItem(title: "SMS",           icon: "message",            path: "/settings/sms"),
            MenuItem(title: "Telegram Ops",  icon: "paperplane",         path: "/settings/telegram-ops"),
            MenuItem(title: "Database",      icon: "cylinder.split.1x2", path: "/settings/database"),
            MenuItem(title: "Session",       icon: "key",                path: "/settings/session"),
        ]),
    ]

    /// The owner's 3 businesses. Switching is just navigation — the ERP derives the
    /// active business from the route (`/trading` → Trading, `/digital` → CDIT, `/` →
    /// Lifestyle), so opening a business home switches it. Monogram letter + colour
    /// match the UIKit a/t/c.circle.fill tints.
    private struct Biz { let name: String; let tagline: String; let letter: String; let color: Color; let path: String }
    private static let businesses: [Biz] = [
        Biz(name: "Alma Lifestyle",      tagline: "Lifestyle",      letter: "A",
            color: Color(red: 0.79, green: 0.66, blue: 0.30), path: "/"),
        Biz(name: "Alma Trading",        tagline: "P2P Operations", letter: "T",
            color: Color(red: 0.51, green: 0.70, blue: 0.60), path: "/trading"),
        Biz(name: "Creative Digital IT", tagline: "Digital Agency", letter: "C",
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
                section(header: "Switch business") {
                    ForEach(Array(Self.businesses.enumerated()), id: \.element.name) { idx, biz in
                        row(divider: idx > 0, action: { openPath(biz.path, biz.name) }) {
                            bizLabel(biz)
                        }
                    }
                }
                ForEach(Self.groups, id: \.header) { group in
                    section(header: group.header) {
                        ForEach(Array(group.items.enumerated()), id: \.element.title) { idx, item in
                            row(divider: idx > 0, action: { open(item) }) {
                                itemLabel(item)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 28)
        }
        // The owner's aurora — the same ambient the Orders / Assistant surfaces wear, so
        // More stops looking like a flat grey settings list and matches the app theme.
        .background(OrdersAurora())
        // Claude-style top scroll-edge fade under the (transparent-glass) UIKit nav bar.
        .claudeTopFade()
        // External theme flips (web toggle, another screen) must move OUR switch too.
        .onReceive(NotificationCenter.default.publisher(for: MoreTheme.changed)) { _ in
            isDark = MoreTheme.isDark
        }
        // Reconcile the Face ID switch with the real web localStorage value on appear.
        .onAppear {
            readBiometricLock? { on in faceLockOn = on }
        }
    }

    // ── Row actions ──

    private func open(_ item: MenuItem) {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        if item.path == "native:companion" { openCompanion() } else { openPath(item.path, item.title) }
    }

    // ── Section card scaffold ──

    /// Small uppercase header + rounded-16 card of rows (the "inset grouped" look,
    /// hand-built because List can't sit on the app's custom cream/aurora background).
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
                .ordersGlass(colorScheme, corner: 16)
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.06), radius: 10, y: 3)
        }
    }

    /// One tappable card row: soft haptic, pressed highlight, optional hairline divider
    /// above (inset past the icon column, like UITableView's separatorInset).
    private func row(divider: Bool, action: @escaping () -> Void,
                     @ViewBuilder label: () -> some View) -> some View {
        VStack(spacing: 0) {
            if divider {
                Divider().padding(.leading, 58)
            }
            Button(action: action) {
                HStack(spacing: 12) {
                    label()
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
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(item.title)
                .font(.body)
                .foregroundStyle(.primary)
        }
    }

    /// Business row: coloured circle monogram + name/tagline (subtitle style).
    private func bizLabel(_ biz: Biz) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(biz.color)
                Text(biz.letter)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(biz.name).font(.body).foregroundStyle(.primary)
                Text(biz.tagline).font(.caption).foregroundStyle(.secondary)
            }
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
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
