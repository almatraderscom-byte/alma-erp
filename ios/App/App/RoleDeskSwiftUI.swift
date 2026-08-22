//
//  RoleDeskSwiftUI.swift
//  ALMA ERP — the home tab for every role that is NOT owner/admin: a native port
//  of `RoleDashboard` in src/app/page.tsx. A personalised greeting + big cards to
//  exactly what this role works with. NO business revenue/profit anywhere — the
//  web stopped showing STAFF/VIEWER the P&L in 2026-06; the native Dashboard tab
//  was still handing it to them (owner report 2026-08-22).
//

import SwiftUI

@available(iOS 17.0, *)
struct RoleDeskScreen: View {
    let openPath: (_ path: String, _ title: String) -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var session = AlmaSession.shared

    private struct DeskCard { let href: String; let icon: String; let title: String; let desc: String }

    /// `ROLE_DESK` (page.tsx) — same hrefs, titles and descriptions.
    private static func desk(for role: AlmaRole) -> (intro: String, cards: [DeskCard]) {
        switch role {
        case .HR:
            return ("HR ড্যাশবোর্ড", [
                DeskCard(href: "/attendance", icon: "clock.badge.checkmark", title: "হাজিরা", desc: "আজকের উপস্থিতি"),
                DeskCard(href: "/payroll", icon: "banknote", title: "বেতন ও ওয়ালেট", desc: "পেমেন্ট ও ওয়ালেট"),
                DeskCard(href: "/employees", icon: "person.2", title: "কর্মী", desc: "কর্মী তালিকা"),
                DeskCard(href: "/portal", icon: "person.text.rectangle", title: "আমার ডেস্ক", desc: "আপনার নিজের তথ্য"),
            ])
        case .VIEWER:
            return ("আপনার ভিউ", [
                DeskCard(href: "/orders", icon: "shippingbox", title: "অর্ডার", desc: "অর্ডার দেখুন"),
                DeskCard(href: "/analytics", icon: "chart.bar.xaxis", title: "অ্যানালিটিক্স", desc: "রিপোর্ট ও ট্রেন্ড"),
                DeskCard(href: "/portal", icon: "person.text.rectangle", title: "আমার ডেস্ক", desc: "আপনার নিজের তথ্য"),
            ])
        default:
            return ("আপনার কাজের ডেস্ক", [
                DeskCard(href: "/portal", icon: "person.text.rectangle", title: "আমার ডেস্ক", desc: "আপনার অর্ডার, টার্গেট ও ওয়ালেট"),
                DeskCard(href: "/orders", icon: "shippingbox", title: "অর্ডার", desc: "অর্ডার দেখুন ও তৈরি করুন"),
                DeskCard(href: "/invoice", icon: "doc.text", title: "ইনভয়েস", desc: "ইনভয়েস তৈরি করুন"),
            ])
        }
    }

    var body: some View {
        let role = session.effectiveRole
        let desk = Self.desk(for: role)
        // Only offer what the role may open here (web: the server redirects off anything else).
        let cards = desk.cards.filter { session.canSee($0.href) }
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("স্বাগতম")
                        .font(.caption2.weight(.black))
                        .tracking(2)
                        .foregroundStyle(AlmaSwiftTheme.coral)
                    Text(session.name.isEmpty ? "—" : session.name)
                        .font(.title2.weight(.black))
                        .foregroundStyle(.primary)
                    Text("\(desk.intro) — যা দরকার, এক ট্যাপ দূরে।")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(role.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AlmaSwiftTheme.violet)
                        .padding(.horizontal, 10).padding(.vertical, 3)
                        .background(AlmaSwiftTheme.violet.opacity(0.14), in: Capsule())
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .lgCard()

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(cards, id: \.href) { card in
                        Button {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            openPath(card.href, card.title)
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                Image(systemName: card.icon)
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(AlmaSwiftTheme.coral)
                                    .frame(width: 44, height: 44)
                                    .background(AlmaSwiftTheme.coral.opacity(scheme == .dark ? 0.18 : 0.10),
                                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                                Text(card.title)
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.primary)
                                Text(card.desc)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lgCard(padding: 14)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, AlmaSwiftTheme.margin)
            .padding(.top, 8)
            .padding(.bottom, 28)
        }
        .background(OrdersAurora())
        .claudeTopFade()
        .refreshable { await session.reload() }
    }
}
