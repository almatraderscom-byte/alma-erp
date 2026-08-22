//
//  AlmaAccess.swift
//  ALMA ERP — role × business → route visibility. A 1:1 Swift port of the web
//  authority: `isPathAllowedForRole` / `filterNavByRole` / `can` in src/lib/roles.ts,
//  `getNavForBusiness` / `isRouteAllowed` in src/lib/businesses.ts and
//  `parseBusinessAccess` in src/lib/business-access.ts.
//
//  Why this exists (owner report 2026-08-22): the native shell built the FULL
//  super-admin tab bar + More menu for every role — three Trading-only staff were
//  handed the Lifestyle P&L tab, the owner's Assistant tab and a Finance/Payroll/
//  Users menu. Android got the port in 2026-07 (AlmaAccess.kt); iOS never did.
//
//  Drift guard: ios/access-contract.json is GENERATED from the web files by
//  `npm run access-contract:update` and AppParityV2Tests/AccessContractTests.swift
//  asserts this port answers identically for every role × business × path. Change
//  the web rule → regenerate → the Swift test tells you exactly which case drifted.
//  Do NOT hand-edit a rule here without the web side (the Android port already
//  rotted that way: /settings/notifications).
//
//  The server stays the real authority (proxy.ts redirects pages + 403s APIs); this
//  only decides what the app OFFERS, so a user never sees a tab/button they can't use.
//

import Foundation

// MARK: - Roles

/// Mirrors `AlmaRole` (src/lib/roles.ts). Raw values are the server strings.
enum AlmaRole: String, CaseIterable, Codable {
    case SUPER_ADMIN, ADMIN, HR, STAFF, VIEWER

    /// `normalizeAlmaRole`: trim, uppercase, spaces → underscore; unknown → VIEWER.
    static func normalize(_ raw: String?) -> AlmaRole {
        let u = (raw ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .replacingOccurrences(of: "\\s+", with: "_", options: .regularExpression)
        return AlmaRole(rawValue: u) ?? .VIEWER
    }

    /// Human label the web shows in the account drawer (`role.replace(/_/g, ' ')`).
    var label: String {
        switch self {
        case .SUPER_ADMIN: return "Super Admin"
        case .ADMIN: return "Admin"
        case .HR: return "HR"
        case .STAFF: return "Staff"
        case .VIEWER: return "Viewer"
        }
    }
}

// MARK: - Businesses

/// Mirrors `BusinessId` + `BUSINESSES` (src/lib/businesses.ts).
enum AlmaBusinessId: String, CaseIterable, Codable {
    case ALMA_LIFESTYLE, CREATIVE_DIGITAL_IT, ALMA_TRADING

    /// `ALL_BUSINESS_IDS` order (business-access.ts) — the order the switcher lists them.
    static let all: [AlmaBusinessId] = [.ALMA_LIFESTYLE, .CREATIVE_DIGITAL_IT, .ALMA_TRADING]
    /// `DEFAULT_BUSINESS_ID`.
    static let `default`: AlmaBusinessId = .ALMA_LIFESTYLE

    var name: String {
        switch self {
        case .ALMA_LIFESTYLE: return "Alma Lifestyle"
        case .CREATIVE_DIGITAL_IT: return "Creative Digital IT"
        case .ALMA_TRADING: return "Alma Trading"
        }
    }
    var shortName: String {
        switch self {
        case .ALMA_LIFESTYLE: return "Alma"
        case .CREATIVE_DIGITAL_IT: return "CDIT"
        case .ALMA_TRADING: return "Trading"
        }
    }
    var tagline: String {
        switch self {
        case .ALMA_LIFESTYLE: return "LIFESTYLE"
        case .CREATIVE_DIGITAL_IT: return "DIGITAL AGENCY"
        case .ALMA_TRADING: return "P2P OPERATIONS"
        }
    }
    var brandInitial: String {
        switch self {
        case .ALMA_LIFESTYLE: return "A"
        case .CREATIVE_DIGITAL_IT: return "C"
        case .ALMA_TRADING: return "T"
        }
    }
    /// Default route when switching to this business.
    var homePath: String {
        switch self {
        case .ALMA_LIFESTYLE: return "/"
        case .CREATIVE_DIGITAL_IT: return "/digital"
        case .ALMA_TRADING: return "/trading"
        }
    }

    /// `resolveBusinessId`: unknown → Lifestyle.
    static func resolve(_ raw: String?) -> AlmaBusinessId {
        AlmaBusinessId(rawValue: raw ?? "") ?? .ALMA_LIFESTYLE
    }

    /// `parseBusinessAccess` (business-access.ts): blank → ALL; unknown ids dropped;
    /// nothing valid left → [Lifestyle].
    static func parseAccess(_ raw: String?) -> [AlmaBusinessId] {
        let u = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if u.isEmpty { return all }
        let ids = u.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { AlmaBusinessId(rawValue: $0) }
        return ids.isEmpty ? [.ALMA_LIFESTYLE] : ids
    }

    /// `normalizeBusinessAccessForRole`: the system owner always has every business.
    static func accessForRole(_ access: [AlmaBusinessId], role: AlmaRole) -> [AlmaBusinessId] {
        role == .SUPER_ADMIN ? all : access
    }
}

// MARK: - Nav (getNavForBusiness)

/// One sidebar entry — `NavItem` in businesses.ts plus the SF Symbol the native
/// tab bar / More menu draws (the web uses emoji; `icon` keeps that for the contract).
struct AlmaNavItem: Equatable {
    let href: String
    let icon: String      // web emoji, contract-compared
    let label: String
    let symbol: String    // SF Symbol, native only

    init(_ href: String, _ icon: String, _ label: String, _ symbol: String) {
        self.href = href; self.icon = icon; self.label = label; self.symbol = symbol
    }
}

enum AlmaNav {
    // Exact lists from src/lib/businesses.ts — same hrefs, same order.
    private static let financeSuite: [AlmaNavItem] = [
        AlmaNavItem("/finance", "💰", "Finance", "banknote"),
        AlmaNavItem("/expenses", "💳", "Expenses", "creditcard"),
        AlmaNavItem("/employees", "👤", "Employees", "person.2"),
        AlmaNavItem("/attendance", "⏱", "Attendance", "calendar.badge.clock"),
        AlmaNavItem("/payroll", "💵", "Payroll", "dollarsign.circle"),
    ]
    static let agentItem = AlmaNavItem("/agent", "✨", "ALMA Agent", "sparkles")
    static let catalogImagesItem = AlmaNavItem("/agent/catalog-images", "📷", "Product Images", "photo.on.rectangle")
    static let officeItem = AlmaNavItem("/portal/office", "🏢", "Office", "building.2")
    private static let settingsNav: [AlmaNavItem] = [
        AlmaNavItem("/operations/task-spotlight", "🎯", "Task Spotlight", "target"),
        AlmaNavItem("/operations/business-archive", "📦", "Archive Control", "archivebox"),
        AlmaNavItem("/settings/session", "⚙️", "Session", "key"),
        AlmaNavItem("/settings/database", "🗄", "Database", "cylinder.split.1x2"),
        AlmaNavItem("/settings/users", "👥", "Users", "person.3"),
        AlmaNavItem("/settings/notifications", "🔔", "Notifications", "bell.badge"),
        AlmaNavItem("/settings/sms", "✉️", "SMS", "message"),
        AlmaNavItem("/settings/telegram-ops", "📡", "Telegram Ops", "paperplane"),
        AlmaNavItem("/audit", "📋", "Audit", "checklist"),
        AlmaNavItem("/settings/branding", "🎨", "Branding", "paintpalette"),
    ]
    private static let almaNav: [AlmaNavItem] = [
        AlmaNavItem("/", "🏠", "Dashboard", "square.grid.2x2"),
        AlmaNavItem("/briefing", "☀️", "Briefing", "newspaper"),
        AlmaNavItem("/insights", "🔮", "Insights", "lightbulb"),
        AlmaNavItem("/activity", "🕓", "Activity", "bolt"),
        AlmaNavItem("/approvals", "✅", "Approvals", "checkmark.seal"),
        AlmaNavItem("/portal", "🪪", "My desk", "person.crop.square"),
        officeItem,
        AlmaNavItem("/orders", "📦", "Orders", "shippingbox"),
        AlmaNavItem("/crm", "👥", "CRM", "person.crop.circle.badge.checkmark"),
        AlmaNavItem("/inventory", "📊", "Inventory", "archivebox"),
        catalogImagesItem,
        AlmaNavItem("/invoice", "🧾", "Invoice", "doc.text"),
    ] + financeSuite + [
        AlmaNavItem("/analytics", "📈", "Analytics", "chart.bar"),
        agentItem,
    ] + settingsNav
    private static let cditNav: [AlmaNavItem] = [
        AlmaNavItem("/digital", "🏠", "Dashboard", "square.grid.2x2"),
        AlmaNavItem("/approvals", "✅", "Approvals", "checkmark.seal"),
        AlmaNavItem("/portal", "🪪", "My desk", "person.crop.square"),
        officeItem,
        AlmaNavItem("/digital/clients", "👥", "Clients", "person.2"),
        AlmaNavItem("/digital/projects", "📂", "Projects", "folder"),
        AlmaNavItem("/digital/invoices", "🧾", "Invoices", "doc.text"),
    ] + financeSuite + [agentItem] + settingsNav
    private static let tradingNav: [AlmaNavItem] = [
        AlmaNavItem("/trading", "💹", "Trading", "chart.line.uptrend.xyaxis"),
        AlmaNavItem("/approvals", "✅", "Approvals", "checkmark.seal"),
        AlmaNavItem("/trading/accounts", "🏦", "Accounts", "building.columns"),
        AlmaNavItem("/trading/target-control", "🎯", "Target Control", "target"),
        AlmaNavItem("/trading/telegram", "✉️", "Telegram", "paperplane"),
        AlmaNavItem("/trading/hr", "👤", "Trading HR", "person.badge.clock"),
        AlmaNavItem("/employees", "👤", "Employees", "person.2"),
        AlmaNavItem("/attendance", "⏱", "Attendance", "calendar.badge.clock"),
        AlmaNavItem("/payroll", "💵", "Payroll", "dollarsign.circle"),
        AlmaNavItem("/trading/analytics", "📈", "Analytics", "chart.bar"),
        AlmaNavItem("/trading/analytics?view=reports", "📊", "Reports", "chart.bar.doc.horizontal"),
        AlmaNavItem("/portal", "🪪", "My desk", "person.crop.square"),
        officeItem,
        agentItem,
    ] + settingsNav

    /// `getNavForBusiness`.
    static func nav(for business: AlmaBusinessId) -> [AlmaNavItem] {
        switch business {
        case .CREATIVE_DIGITAL_IT: return cditNav
        case .ALMA_TRADING: return tradingNav
        case .ALMA_LIFESTYLE: return almaNav
        }
    }

    /// Every nav href across the three businesses (for catalog completeness checks).
    static var allHrefs: [String] {
        var seen = Set<String>(), out: [String] = []
        for b in AlmaBusinessId.all { for i in nav(for: b) where seen.insert(i.href).inserted { out.append(i.href) } }
        return out
    }
}

// MARK: - Capabilities (`can`)

/// `CAPABILITIES` in roles.ts — fine-grained UI gates; server APIs enforce separately.
enum AlmaCapability: String, CaseIterable {
    case ordersAdvanceStatus, ordersEditTracking, ordersEditField, ordersGenerateInvoice,
         ordersDeleteOrCancel, crmWrite, inventoryWrite, expenseWrite, payrollWrite,
         employeeWrite, brandingWrite, analyticsView, cditAdminWrite, userManage, advanceApprove

    var roles: [AlmaRole] {
        switch self {
        case .ordersAdvanceStatus, .ordersEditTracking, .ordersEditField,
             .ordersGenerateInvoice, .ordersDeleteOrCancel, .crmWrite, .inventoryWrite,
             .cditAdminWrite, .userManage:
            return [.SUPER_ADMIN, .ADMIN]
        case .expenseWrite, .advanceApprove:
            return [.SUPER_ADMIN, .ADMIN, .HR]
        case .payrollWrite, .employeeWrite:
            return [.SUPER_ADMIN, .HR]
        case .brandingWrite:
            return [.SUPER_ADMIN]
        case .analyticsView:
            return [.SUPER_ADMIN, .ADMIN, .HR, .STAFF, .VIEWER]
        }
    }
}

// MARK: - Access rules

enum AlmaAccess {

    private static func rootMatch(_ path: String, _ root: String) -> Bool {
        path == root || path.hasPrefix(root + "/")
    }

    /// `isRouteAllowed` (businesses.ts): routes exclusive to one business.
    static func isRouteAllowed(_ path: String, business: AlmaBusinessId) -> Bool {
        let digitalOnly = path.hasPrefix("/digital")
        let sharedOps = path.hasPrefix("/finance")
            || path.hasPrefix("/expenses")
            || path.hasPrefix("/employees")
            || path.hasPrefix("/attendance")
            || path.hasPrefix("/payroll")

        if path.hasPrefix("/settings")
            || path.hasPrefix("/operations")
            || path.hasPrefix("/agent")
            || path.hasPrefix("/invoice/share")
            || path.hasPrefix("/audit")
            || path.hasPrefix("/approvals") { return true }

        switch business {
        case .CREATIVE_DIGITAL_IT:
            return digitalOnly || sharedOps || path == "/"
        case .ALMA_TRADING:
            return path == "/"
                || path.hasPrefix("/trading")
                || path.hasPrefix("/attendance")
                || path.hasPrefix("/payroll")
                || path.hasPrefix("/employees")
                || path.hasPrefix("/portal")
                || path.hasPrefix("/settings")
                || path.hasPrefix("/audit")
        case .ALMA_LIFESTYLE:
            return (!digitalOnly && !path.hasPrefix("/digital") && !path.hasPrefix("/trading")) || sharedOps
        }
    }

    /// `isPathAllowedForRole` (roles.ts) — statement-for-statement.
    static func isPathAllowedForRole(_ pathname: String, role: AlmaRole, business: AlmaBusinessId) -> Bool {
        if !isRouteAllowed(pathname, business: business) { return false }

        if pathname.hasPrefix("/login")
            || pathname.hasPrefix("/forgot-password")
            || pathname.hasPrefix("/reset-password") { return true }

        if pathname.hasPrefix("/invoice/share") { return true }
        if pathname.hasPrefix("/portal") { return true }
        if pathname.hasPrefix("/settings/session") { return true }

        if pathname.hasPrefix("/settings/database") {
            return role == .SUPER_ADMIN || role == .ADMIN || role == .HR
        }
        if pathname.hasPrefix("/settings/notifications") { return true }

        if pathname.hasPrefix("/trading/target-control") {
            return role == .SUPER_ADMIN || role == .ADMIN
        }
        if pathname.hasPrefix("/trading/telegram") {
            if role == .SUPER_ADMIN || role == .ADMIN { return true }
            if role == .STAFF && business == .ALMA_TRADING { return true }
            return false
        }
        if pathname.hasPrefix("/operations") { return role == .SUPER_ADMIN }

        if pathname.hasPrefix("/agent/catalog-images") {
            return role == .SUPER_ADMIN || role == .ADMIN
        }
        if pathname.hasPrefix("/agent") { return role == .SUPER_ADMIN }
        if pathname.hasPrefix("/api/business-archive") { return role == .SUPER_ADMIN }

        if pathname.hasPrefix("/briefing") { return role == .SUPER_ADMIN || role == .ADMIN }
        if pathname.hasPrefix("/insights") { return role == .SUPER_ADMIN || role == .ADMIN }
        if pathname.hasPrefix("/activity") { return role == .SUPER_ADMIN || role == .ADMIN }

        if role == .SUPER_ADMIN { return true }

        if pathname.hasPrefix("/finance")
            || pathname.hasPrefix("/expenses")
            || pathname.hasPrefix("/digital") { return role == .ADMIN }

        if pathname.hasPrefix("/settings/users") { return role == .ADMIN }

        if pathname.hasPrefix("/audit") || pathname.hasPrefix("/settings/branding") { return false }

        if role == .VIEWER {
            let deny = ["/settings/users", "/settings/branding", "/settings/database", "/audit"]
            if deny.contains(where: { rootMatch(pathname, $0) }) { return false }
            return true
        }

        if role == .ADMIN {
            if pathname.hasPrefix("/employees") { return false }
            return true
        }

        if role == .HR {
            let hrRoots = business == .ALMA_TRADING
                ? ["/trading/hr", "/attendance", "/payroll", "/portal"]
                : ["/finance", "/expenses", "/employees", "/attendance", "/payroll", "/portal"]
            return hrRoots.contains { rootMatch(pathname, $0) }
        }

        if role == .STAFF {
            switch business {
            case .ALMA_TRADING:
                return ["/trading", "/portal"].contains { rootMatch(pathname, $0) }
            case .ALMA_LIFESTYLE:
                return ["/", "/orders", "/invoice", "/portal"].contains { rootMatch(pathname, $0) }
            case .CREATIVE_DIGITAL_IT:
                return ["/digital", "/invoice", "/portal"].contains { rootMatch(pathname, $0) }
            }
        }

        return false
    }

    private static let tradingStaffNavHide: Set<String> = [
        "/trading/target-control", "/trading/analytics", "/trading/hr", "/approvals",
        "/attendance", "/settings/database", "/settings/users", "/settings/sms",
        "/audit", "/settings/branding",
    ]

    /// `filterNavByRole`.
    static func filterNavByRole(_ items: [AlmaNavItem], role: AlmaRole, business: AlmaBusinessId) -> [AlmaNavItem] {
        items.filter { item in
            if item.href == "/agent" && role != .SUPER_ADMIN { return false }
            if item.href.hasPrefix("/operations/") && role != .SUPER_ADMIN { return false }
            if !isPathAllowedForRole(item.href, role: role, business: business) { return false }
            if business == .ALMA_TRADING && item.href == "/trading/target-control" && role != .SUPER_ADMIN {
                return false
            }
            if business == .ALMA_TRADING && role == .STAFF {
                if tradingStaffNavHide.contains(item.href) { return false }
                if item.href.hasPrefix("/trading/analytics") { return false }
            }
            return true
        }
    }

    /// The web nav a role sees for a business — `filterNavByRole(getNavForBusiness(b), role, b)`.
    static func nav(role: AlmaRole, business: AlmaBusinessId) -> [AlmaNavItem] {
        filterNavByRole(AlmaNav.nav(for: business), role: role, business: business)
    }

    /// `roleHomePath`.
    static func roleHomePath(role: AlmaRole, business: AlmaBusinessId) -> String {
        if role == .HR { return business == .ALMA_TRADING ? "/trading/hr" : "/employees" }
        return business.homePath
    }

    /// `can(role, capability)`.
    static func can(_ role: AlmaRole, _ capability: AlmaCapability) -> Bool {
        capability.roles.contains(role)
    }

    /// `canManageCatalogImages`.
    static func canManageCatalogImages(_ role: AlmaRole) -> Bool {
        role == .SUPER_ADMIN || role == .ADMIN
    }

    /// Which business a route belongs to, the way the web resolves it: `/trading*` →
    /// Trading, `/digital*` → CDIT (proxy.ts), otherwise the business the user is
    /// currently in when the route is valid there (BusinessContext), else Lifestyle.
    static func business(for path: String, current: AlmaBusinessId) -> AlmaBusinessId {
        if path.hasPrefix("/trading") { return .ALMA_TRADING }
        if path.hasPrefix("/digital") { return .CREATIVE_DIGITAL_IT }
        if isRouteAllowed(path, business: current) { return current }
        return .ALMA_LIFESTYLE
    }
}
