//
//  AlmaShellCatalog.swift
//  ALMA ERP — what the native shell OFFERS per role × business: the tab-bar
//  composition and the More-menu catalog, both derived from the web nav
//  (`AlmaAccess.nav(role:business:)` = filterNavByRole(getNavForBusiness(b))).
//  Pure data + functions (no UIKit) so AccessContractTests can assert the exact
//  tab layout every role gets and that every web nav href is offered somewhere.
//
//  Rule: tabs = the role's home + the first three allowed hrefs from a fixed
//  per-business priority list, then "More". The owner's Lifestyle bar therefore
//  stays exactly Dashboard · Orders · Assistant · Approvals · More; everyone else
//  gets a bar made only of pages they can actually open.
//

import Foundation

enum AlmaShellCatalog {

    // MARK: - Tabs

    /// Content-tab priority after the home tab. Hrefs are web nav hrefs.
    static func tabPriority(for business: AlmaBusinessId) -> [String] {
        switch business {
        case .ALMA_LIFESTYLE:
            return ["/orders", "/agent", "/approvals", "/invoice", "/attendance", "/payroll",
                    "/employees", "/crm", "/inventory", "/finance", "/analytics", "/portal"]
        case .ALMA_TRADING:
            return ["/agent", "/trading/accounts", "/approvals", "/trading/telegram", "/trading/hr",
                    "/attendance", "/payroll", "/portal", "/portal/office"]
        case .CREATIVE_DIGITAL_IT:
            return ["/agent", "/digital/clients", "/approvals", "/digital/projects", "/digital/invoices",
                    "/portal", "/attendance", "/payroll"]
        }
    }

    /// Home tab href: the web's `roleHomePath` when the role's nav contains it,
    /// else the first nav entry (a CDIT staffer, say, whose home page is admin-only).
    static func homeHref(role: AlmaRole, business: AlmaBusinessId) -> String {
        let nav = AlmaAccess.nav(role: role, business: business).map(\.href)
        let home = AlmaAccess.roleHomePath(role: role, business: business)
        if nav.contains(home) { return home }
        return nav.first ?? "/portal"
    }

    /// Home + up to three content tabs (More is appended by the shell).
    static func tabHrefs(role: AlmaRole, business: AlmaBusinessId) -> [String] {
        let nav = AlmaAccess.nav(role: role, business: business).map(\.href)
        let home = homeHref(role: role, business: business)
        var out = [home]
        for href in tabPriority(for: business) where href != home && nav.contains(href) {
            out.append(href)
            if out.count == 4 { break }
        }
        // Priority list exhausted — pad from the nav itself (never an empty bar).
        if out.count < 4 {
            for href in nav where !out.contains(href) && !href.hasPrefix("/settings") && !href.hasPrefix("/operations") {
                out.append(href)
                if out.count == 4 { break }
            }
        }
        return out
    }

    /// Title + SF Symbol for a tab href (from the web nav label; tab roots that the
    /// shell names differently keep their established names).
    static func tabTitle(for href: String, business: AlmaBusinessId) -> (title: String, symbol: String) {
        switch href {
        case "/": return ("Dashboard", "square.grid.2x2")
        case "/agent": return ("ALMA AI", "sparkles")
        case "/portal": return ("My Desk", "person.crop.square")
        default:
            if let item = AlmaNav.nav(for: business).first(where: { $0.href == href }) {
                return (item.label, item.symbol)
            }
            return (href, "circle")
        }
    }

    // MARK: - More menu

    struct MoreItem: Equatable {
        let title: String
        let symbol: String
        /// ERP route, or a `native:` sentinel the host resolves to a native screen.
        let path: String
        /// Route the access gate checks (sentinels gate on their owning area).
        let gatePath: String
        init(_ title: String, _ symbol: String, _ path: String, gate: String? = nil) {
            self.title = title; self.symbol = symbol; self.path = path; self.gatePath = gate ?? path
        }
    }
    struct MoreGroup: Equatable {
        let header: String
        let symbol: String
        let items: [MoreItem]
    }

    /// The full curated catalog (every business). Filtered per user by `moreGroups`.
    static let curatedGroups: [MoreGroup] = [
        MoreGroup(header: "Agent", symbol: "sparkles", items: [
            MoreItem("Agent Hub", "square.grid.2x2.fill", "/agent/hub"),
            MoreItem("Phone Companion", "iphone.radiowaves.left.and.right", "native:companion", gate: "/agent"),
            MoreItem("কল হিস্টরি", "phone.badge.waveform.fill", "native:agent-calls", gate: "/agent"),
            MoreItem("Agent Loader", "sparkles.rectangle.stack.fill", "native:spinner-preview", gate: "/agent"),
        ]),
        MoreGroup(header: "Workspace", symbol: "square.grid.2x2", items: [
            MoreItem("My Desk", "person.crop.square", "/portal"),
            MoreItem("Office", "building.2", "/portal/office"),
            MoreItem("Product Images", "photo.on.rectangle", "/agent/catalog-images"),
            MoreItem("Creative Studio", "wand.and.stars", "/agent/creative-studio"),
        ]),
        MoreGroup(header: "Trading", symbol: "chart.line.uptrend.xyaxis", items: [
            MoreItem("Trading", "chart.line.uptrend.xyaxis", "/trading"),
            MoreItem("Accounts", "building.columns", "/trading/accounts"),
            MoreItem("Target Control", "target", "/trading/target-control"),
            MoreItem("Telegram", "paperplane", "/trading/telegram"),
            MoreItem("Trading HR", "person.badge.clock", "/trading/hr"),
            MoreItem("Analytics", "chart.bar", "/trading/analytics"),
            MoreItem("Reports", "chart.bar.doc.horizontal", "/trading/analytics?view=reports"),
        ]),
        MoreGroup(header: "CDIT", symbol: "desktopcomputer", items: [
            MoreItem("Dashboard", "square.grid.2x2", "/digital"),
            MoreItem("Clients", "person.2", "/digital/clients"),
            MoreItem("Projects", "folder", "/digital/projects"),
            MoreItem("Invoices", "doc.text", "/digital/invoices"),
        ]),
        MoreGroup(header: "Money", symbol: "banknote", items: [
            MoreItem("Finance", "banknote", "/finance"),
            MoreItem("Expenses", "creditcard", "/expenses"),
            MoreItem("Payroll", "dollarsign.circle", "/payroll"),
            MoreItem("Invoices", "doc.text", "/invoice"),
        ]),
        MoreGroup(header: "Operations", symbol: "gearshape.2", items: [
            MoreItem("Orders", "shippingbox", "/orders"),
            MoreItem("Inventory", "archivebox", "/inventory"),
            MoreItem("Activity", "bolt", "/activity"),
            MoreItem("Task Spotlight", "target", "/operations/task-spotlight"),
            MoreItem("Archive", "archivebox", "/operations/business-archive"),
        ]),
        MoreGroup(header: "People", symbol: "person.2", items: [
            MoreItem("Employees", "person.2", "/employees"),
            MoreItem("Attendance", "calendar.badge.clock", "/attendance"),
            MoreItem("CRM", "person.crop.circle.badge.checkmark", "/crm"),
        ]),
        MoreGroup(header: "Insights", symbol: "chart.bar", items: [
            MoreItem("Analytics", "chart.bar", "/analytics"),
            MoreItem("Insights", "lightbulb", "/insights"),
            MoreItem("Briefing", "newspaper", "/briefing"),
            MoreItem("Audit", "checklist", "/audit"),
        ]),
        MoreGroup(header: "Settings", symbol: "gearshape", items: [
            MoreItem("Users", "person.3", "/settings/users"),
            MoreItem("Notifications", "bell.badge", "/settings/notifications"),
            MoreItem("Branding", "paintpalette", "/settings/branding"),
            MoreItem("SMS", "message", "/settings/sms"),
            MoreItem("Telegram Ops", "paperplane", "/settings/telegram-ops"),
            MoreItem("Database", "cylinder.split.1x2", "/settings/database"),
            MoreItem("Session", "key", "/settings/session"),
        ]),
    ]

    /// The More menu for one user: curated rows the user may open IN THE CURRENT
    /// BUSINESS (web: the sidebar only lists the current business' nav), tab roots
    /// removed (they are already tabs), empty groups dropped, and — so nothing the
    /// web offers can go missing — any remaining allowed nav href appended to a
    /// trailing "আরও" group.
    static func moreGroups(role: AlmaRole, business: AlmaBusinessId,
                           tabHrefs: [String],
                           canSee: (String) -> Bool) -> [MoreGroup] {
        let nav = AlmaAccess.nav(role: role, business: business)
        let navHrefs = Set(nav.map(\.href))
        var offered = Set(tabHrefs)
        var groups: [MoreGroup] = []
        for group in curatedGroups {
            let items = group.items.filter { item in
                if tabHrefs.contains(item.path) { return false }
                let bare = item.gatePath.split(separator: "?").first.map(String.init) ?? item.gatePath
                guard AlmaAccess.business(for: bare, current: business) == business else { return false }
                // Rows that are web nav entries must be in this role's nav; native-only
                // rows (hub, companion, studio…) just need the access gate.
                if navHrefs.contains(item.gatePath) || AlmaNav.allHrefs.contains(item.gatePath) {
                    guard navHrefs.contains(item.gatePath) else { return false }
                }
                return canSee(item.gatePath)
            }
            if !items.isEmpty {
                groups.append(MoreGroup(header: group.header, symbol: group.symbol, items: items))
                items.forEach { offered.insert($0.path) }
            }
        }
        let leftovers = nav.filter { !offered.contains($0.href) && $0.href != "/" }
        if !leftovers.isEmpty {
            groups.append(MoreGroup(header: "আরও", symbol: "ellipsis.circle",
                                    items: leftovers.map { MoreItem($0.label, $0.symbol, $0.href) }))
        }
        return groups
    }

    /// Every href the shell can offer somewhere (tabs or More) — contract check.
    static var allOfferedHrefs: Set<String> {
        var set = Set(curatedGroups.flatMap { $0.items.map(\.path) })
        for b in AlmaBusinessId.all {
            tabPriority(for: b).forEach { set.insert($0) }
            set.insert(b.homePath)
            for r in AlmaRole.allCases { set.insert(homeHref(role: r, business: b)) }
        }
        // The trailing "আরও" group offers any allowed nav href by construction.
        AlmaNav.allHrefs.forEach { set.insert($0) }
        return set
    }
}
