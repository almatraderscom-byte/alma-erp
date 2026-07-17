//
//  AgentHubSwiftUI.swift
//  ALMA ERP — NP-1 (AG-09): the canonical Agent Hub.
//
//  One visible native menu for EVERY Agent surface: Chat, LIVE Business Monitor,
//  Creative Studio, WhatsApp, Costs, Growth, Known People, Product Images,
//  Trading Staff, Subscriptions, Live Watch, Phone Companion. The floating
//  radial menu stays as a shortcut; this hub is the discoverable entry point
//  (the deep-audit finding: Monitor/WhatsApp/Growth/Trading Staff were hidden
//  in inconsistent groups or missing from navigation entirely).
//
//  Navigation: every row posts `.almaOpenPath` — the SAME single decision path a
//  notification tap / almaerp:// deep link takes (routeNotificationTap →
//  pushSmart → AlmaNavCoordinator). No parallel router, no web fallthrough.
//  Phone Companion is the one native-sentinel row: it presents the native
//  CompanionScreen in a sheet (same screen the More menu pushes).
//

import SwiftUI

@available(iOS 17.0, *)
struct AgentHubScreen: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var showCompanion = false

    private struct HubItem: Identifiable {
        let title: String
        let subtitle: String
        let icon: String
        let tint: Color
        let path: String   // "native:companion" = sheet sentinel
        var id: String { path }
    }

    private static let items: [HubItem] = [
        .init(title: "Agent চ্যাট", subtitle: "কথা বলুন, কাজ দিন", icon: "bubble.left.and.text.bubble.right",
              tint: Color(red: 0.878, green: 0.478, blue: 0.373), path: "/agent"),
        .init(title: "LIVE Business", subtitle: "মনিটর · কন্ট্রোল রুম", icon: "chart.bar.xaxis",
              tint: Color(red: 0.357, green: 0.549, blue: 1.000), path: "/agent/staff-monitor"),
        .init(title: "Live Watch", subtitle: "লাইভ ব্রাউজার ফিড", icon: "eye",
              tint: Color(red: 0.659, green: 0.333, blue: 0.969), path: "/agent/live-watch"),
        .init(title: "Creative Studio", subtitle: "ছবি · ভিডিও · কনটেন্ট", icon: "wand.and.stars",
              tint: Color(red: 0.925, green: 0.282, blue: 0.600), path: "/agent/creative-studio"),
        .init(title: "WhatsApp Inbox", subtitle: "কাস্টমার মেসেজ", icon: "message.fill",
              tint: Color(red: 0.133, green: 0.827, blue: 0.647), path: "/agent/whatsapp"),
        .init(title: "Credit Usage", subtitle: "AI খরচ · বাজেট", icon: "dollarsign.circle",
              tint: Color(red: 0.961, green: 0.620, blue: 0.043), path: "/agent/costs"),
        .init(title: "Growth", subtitle: "SEO · Search Console", icon: "chart.line.uptrend.xyaxis",
              tint: Color(red: 0.020, green: 0.588, blue: 0.412), path: "/agent/growth"),
        .init(title: "Known People", subtitle: "চেনা মুখ · ক্যামেরা", icon: "person.crop.rectangle.badge.plus",
              tint: Color(red: 0.055, green: 0.647, blue: 0.914), path: "/agent/known-people"),
        .init(title: "Product Images", subtitle: "ক্যাটালগ ছবি", icon: "photo.on.rectangle",
              tint: Color(red: 0.506, green: 0.698, blue: 0.604), path: "/agent/catalog-images"),
        .init(title: "Trading Staff", subtitle: "ট্রেডিং টিম লিঙ্ক", icon: "person.2.badge.gearshape",
              tint: Color(red: 0.769, green: 0.353, blue: 0.235), path: "/agent/trading-staff"),
        .init(title: "Subscriptions", subtitle: "সাবস্ক্রিপশন খরচ", icon: "repeat.circle",
              tint: Color(red: 0.486, green: 0.302, blue: 1.000), path: "/agent/subscriptions"),
        .init(title: "Phone Companion", subtitle: "এই ফোনে ব্রাউজার চালান", icon: "iphone.radiowaves.left.and.right",
              tint: Color(red: 0.388, green: 0.400, blue: 0.945), path: "native:companion"),
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                      spacing: 10) {
                ForEach(Self.items) { item in
                    hubCard(item)
                }
            }
            .padding(14)
            Color.clear.frame(height: 40)
        }
        .background(AgentHubAurora())
        .claudeTopFade()
        .sheet(isPresented: $showCompanion) {
            if #available(iOS 17.0, *) {
                NavigationStack {
                    CompanionScreen()
                        .navigationTitle("Phone Companion")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("বন্ধ") { showCompanion = false }
                            }
                        }
                }
            }
        }
    }

    private func hubCard(_ item: HubItem) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            if item.path == "native:companion" {
                showCompanion = true
            } else {
                // Single decision path: routeNotificationTap → pushSmart →
                // AlmaNavCoordinator (native / tabRoot / allowlisted web / fail-loud).
                NotificationCenter.default.post(name: .almaOpenPath, object: nil,
                                                userInfo: ["path": item.path])
            }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(item.tint.opacity(0.16))
                        .frame(width: 40, height: 40)
                    Image(systemName: item.icon)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(item.tint)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(item.subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(13)
            .background(.ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(item.title) — \(item.subtitle)"))
    }
}

// MARK: - Aurora background (page-owned copy per parallel-session rule)

@available(iOS 17.0, *)
private struct AgentHubAurora: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        GeometryReader { geo in
            ZStack {
                (dark ? Color(red: 0.078, green: 0.078, blue: 0.094)
                      : Color(red: 0.980, green: 0.976, blue: 0.965))
                RadialGradient(colors: [Color(red: 0.388, green: 0.400, blue: 0.945).opacity(dark ? 0.22 : 0.10), .clear],
                               center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: geo.size.height * 0.8)
                RadialGradient(colors: [Color(red: 0.925, green: 0.282, blue: 0.600).opacity(dark ? 0.28 : 0.12), .clear],
                               center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: geo.size.height * 0.9)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

@available(iOS 17.0, *)
#Preview("Agent Hub — Light") {
    AgentHubScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
