//
//  CrmSwiftUI.swift
//  ALMA ERP — the CRM tab as a native SwiftUI screen (web /crm parity).
//
//  Mirrors the web /crm page — same endpoint, same colours, same blocks:
//    GET /api/customers?business_id=…&segment=…&risk_level=…&search=…  → { customers }
//    GET /api/orders/orders?business_id=…&search=<phone>&limit=10     → recent orders
//  Web-parity blocks: 5 KPI cards (Total / Lifetime Revenue gold-lt / VIP gold /
//  Avg CLV blue-400 / High Risk red-400) · segment tabs (All + VIP/REGULAR/NEW/
//  RISKY/BLACKLIST/COLD) · risk filter · debounced search · contact-style rows with
//  initials avatars · detail sheet (spend summary, risk intelligence, recent orders,
//  profile, call/WhatsApp). Mutating actions (sync-from-orders, flag) stay on the web
//  escape hatch — this screen is read + contact only.
//  Carried lessons: lenient row decoding, ONE spinner pattern, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum CrmPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let blue400 = Color(red: 0.376, green: 0.647, blue: 0.980)        // #60A5FA
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web SEG_COLORS: VIP gold · REGULAR green · NEW blue · RISKY amber ·
    /// BLACKLIST red · COLD slate.
    static func segment(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "VIP": return accentText(scheme)
        case "REGULAR": return scheme == .dark ? green400 : emerald600
        case "NEW": return blue400
        case "RISKY": return scheme == .dark ? amber500 : amber600
        case "BLACKLIST": return red500
        default: return slate400          // COLD / unknown
        }
    }

    /// Web RISK_COLORS: LOW green · MEDIUM amber · HIGH red.
    static func risk(_ level: String?, _ scheme: ColorScheme) -> Color {
        switch level {
        case "HIGH": return red500
        case "MEDIUM": return scheme == .dark ? amber500 : amber600
        default: return scheme == .dark ? green400 : emerald600
        }
    }

    /// Web ClvBar: >60 gold · >30 amber · else muted.
    static func clv(_ score: Int, _ scheme: ColorScheme) -> Color {
        if score > 60 { return accentText(scheme) }
        if score > 30 { return scheme == .dark ? amber500 : amber600 }
        return .secondary
    }
}

// MARK: - Models (same field names the web Customer type declares — snake_case wire)

struct CrmCustomer: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let phone: String?
    let district: String?
    let address: String?
    let whatsapp: String?
    let totalOrders: Int?
    let delivered: Int?
    let returned: Int?
    let totalSpent: Int?
    let avgOrder: Int?
    let totalProfit: Int?
    let codFailPct: Double?
    let returnRate: Double?
    let lastOrder: String?
    let daysInactive: Int?
    let favCategory: String?
    let clvScore: Int?
    let riskScore: Int?
    let riskLevel: String?
    let segment: String?
    let loyaltyPts: Int?
    let source: String?
    let waOptin: String?
    let notes: String?

    private enum Keys: String, CodingKey {
        case id, name, phone, district, address, whatsapp
        case totalOrders = "total_orders"
        case delivered, returned
        case totalSpent = "total_spent"
        case avgOrder = "avg_order"
        case totalProfit = "total_profit"
        case codFailPct = "cod_fail_pct"
        case returnRate = "return_rate"
        case lastOrder = "last_order"
        case daysInactive = "days_inactive"
        case favCategory = "fav_category"
        case clvScore = "clv_score"
        case riskScore = "risk_score"
        case riskLevel = "risk_level"
        case segment
        case loyaltyPts = "loyalty_pts"
        case source
        case waOptin = "wa_optin"
        case notes
    }

    /// Sheet-backfilled rows carry ints in string fields and vice-versa — decode
    /// defensively so ONE bad row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawId = try? c.decodeIfPresent(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        id = rawId ?? "\(name)-\(phone ?? "")"
        district = try? c.decodeIfPresent(String.self, forKey: .district)
        address = try? c.decodeIfPresent(String.self, forKey: .address)
        whatsapp = try? c.decodeIfPresent(String.self, forKey: .whatsapp)
        totalOrders = Self.flexInt(c, .totalOrders)
        delivered = Self.flexInt(c, .delivered)
        returned = Self.flexInt(c, .returned)
        totalSpent = Self.flexInt(c, .totalSpent)
        avgOrder = Self.flexInt(c, .avgOrder)
        totalProfit = Self.flexInt(c, .totalProfit)
        codFailPct = Self.flexDouble(c, .codFailPct)
        returnRate = Self.flexDouble(c, .returnRate)
        lastOrder = try? c.decodeIfPresent(String.self, forKey: .lastOrder)
        daysInactive = Self.flexInt(c, .daysInactive)
        favCategory = try? c.decodeIfPresent(String.self, forKey: .favCategory)
        clvScore = Self.flexInt(c, .clvScore)
        riskScore = Self.flexInt(c, .riskScore)
        riskLevel = try? c.decodeIfPresent(String.self, forKey: .riskLevel)
        segment = try? c.decodeIfPresent(String.self, forKey: .segment)
        loyaltyPts = Self.flexInt(c, .loyaltyPts)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        waOptin = try? c.decodeIfPresent(String.self, forKey: .waOptin)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
    private static func flexDouble(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }

    static func == (a: CrmCustomer, b: CrmCustomer) -> Bool { a.id == b.id }

    /// wa.me deep link — server field when present, else strip the leading 0 and
    /// prefix the 880 country code (same rule as the Orders screen contact buttons).
    var whatsappURL: URL? {
        if let wa = whatsapp, wa.hasPrefix("http"), let url = URL(string: wa) { return url }
        guard let phone, phone.hasPrefix("0") else { return nil }
        return URL(string: "https://wa.me/880\(phone.dropFirst())")
    }
}

/// GET /api/customers answers flat `{ customers, summary }`; tolerate an
/// apiDataSuccess `{ ok, data: {…} }` wrap too, like the approvals decoder does.
struct CrmCustomersResponse: Decodable {
    let customers: [CrmCustomer]

    private enum Keys: String, CodingKey { case ok, data, customers }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        customers = (try? c.decode([CrmCustomer].self, forKey: .customers)) ?? []
    }
}

/// Light slice of an order row for the detail sheet's "Recent Orders" block +
/// the order-derived return insights (web buildCustomerReturnInsights parity).
struct CrmRecentOrder: Decodable, Identifiable, Equatable {
    let id: String
    let date: String?
    let status: String
    let sellPrice: Int?
    /// Server-persisted return net profit when the sheet carries it (web reads
    /// `o.return_net_profit ?? calculateOrderAccounting(…)` — same precedence here).
    let returnNetProfitWire: Int?
    let shippingFee: Int?
    let courierCharge: Int?

    private enum Keys: String, CodingKey {
        case id, date, status
        case sellPrice = "sell_price"
        case returnNetProfitWire = "return_net_profit"
        case shippingFee = "shipping_fee"
        case courierCharge = "courier_charge"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        status = (try? c.decode(String.self, forKey: .status)) ?? "Pending"
        sellPrice = Self.flexInt(c, .sellPrice)
        returnNetProfitWire = Self.flexInt(c, .returnNetProfitWire)
        shippingFee = Self.flexInt(c, .shippingFee)
        courierCharge = Self.flexInt(c, .courierCharge)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    /// Web normalizeOrderStatusKey: trim → UPPER_SNAKE; FAILED_DELIVERY folds
    /// into RETURNED_UNPAID.
    var statusKey: String {
        let key = status.trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: "_")
        return key == "FAILED_DELIVERY" ? "RETURNED_UNPAID" : key
    }

    /// Web isTerminalReturnOrderStatus.
    var isReturn: Bool {
        let k = statusKey
        return k == "RETURNED" || k == "RETURNED_PAID" || k == "RETURNED_UNPAID"
    }

    /// Web return-scenario math (order-return-profit.ts): RETURNED_PAID nets
    /// shipping fee minus the round-trip courier; RETURNED / RETURNED_UNPAID eat
    /// the round-trip courier outright. Wire value wins when the sheet has it.
    var returnNetProfit: Int {
        if let wire = returnNetProfitWire { return wire }
        guard isReturn else { return 0 }
        let courier = max(0, courierCharge ?? 0)
        let ship = max(0, shippingFee ?? 0)
        return statusKey == "RETURNED_PAID" ? ship - 2 * courier : -(2 * courier)
    }

    /// Web `returnLoss`: only a negative return net counts as loss.
    var returnLoss: Int { returnNetProfit < 0 ? -returnNetProfit : 0 }

    /// Web tone-* pill colours (same table the Orders screen carries).
    var tint: Color {
        switch status {
        case "Pending": return Color(red: 0.961, green: 0.620, blue: 0.043)   // amber  #F59E0B
        case "Confirmed": return Color(red: 0.659, green: 0.333, blue: 0.969) // purple #A855F7
        case "Packed": return Color(red: 0.024, green: 0.714, blue: 0.831)    // cyan   #06B6D4
        case "Shipped": return Color(red: 0.231, green: 0.510, blue: 0.965)   // blue   #3B82F6
        case "Delivered": return Color(red: 0.133, green: 0.773, blue: 0.369) // green  #22C55E
        case "CANCELLED", "Cancelled": return CrmPalette.slate400
        case "RETURNED_PAID": return Color(red: 0.961, green: 0.620, blue: 0.043)
        default: return CrmPalette.red500                                     // returns
        }
    }
    var label: String {
        switch status {
        case "RETURNED_PAID": return "Returned (paid)"
        case "RETURNED_UNPAID": return "Returned (unpaid)"
        case "RETURNED": return "Returned"
        case "CANCELLED", "Cancelled": return "Cancelled"
        default: return status
        }
    }
}

struct CrmOrdersLookupResponse: Decodable {
    let orders: [CrmRecentOrder]
    private enum Keys: String, CodingKey { case ok, data, orders }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        orders = (try? c.decode([CrmRecentOrder].self, forKey: .orders)) ?? []
    }
}

/// Order-derived return insights for the detail sheet — the native mirror of the
/// web's buildCustomerReturnInsights (customer-order-insights.ts), computed over
/// the same per-customer order rows the sheet already fetches by phone.
private struct CrmReturnInsights {
    let totalOrders: Int
    let returnCount: Int
    let returnRatePct: Int
    let returnsLast30Days: Int
    let computedRisk: String      // LOW | MEDIUM | HIGH (web thresholds)
    let totalReturnLoss: Int

    init(orders: [CrmRecentOrder], now: Date = Date()) {
        totalOrders = orders.count
        let cutoff = now.addingTimeInterval(-30 * 86_400)
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy-MM-dd"
        var returns = 0, recent30 = 0, loss = 0
        for o in orders where o.isReturn {
            returns += 1
            loss += o.returnLoss
            if let raw = o.date, raw.count >= 10,
               let d = df.date(from: String(raw.prefix(10))), d >= cutoff {
                recent30 += 1
            }
        }
        returnCount = returns
        returnsLast30Days = recent30
        totalReturnLoss = loss
        returnRatePct = totalOrders > 0
            ? Int((Double(returns) / Double(totalOrders) * 100).rounded()) : 0
        // Web: >2 returns in 30d = HIGH; any in 30d or 2+ lifetime = MEDIUM.
        if recent30 > 2 { computedRisk = "HIGH" }
        else if recent30 >= 1 || returns >= 2 { computedRisk = "MEDIUM" }
        else { computedRisk = "LOW" }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CrmVM {
    var customers: [CrmCustomer] = []
    var search = ""
    var segment: String? = nil            // VIP | REGULAR | NEW | RISKY | BLACKLIST | COLD
    var risk: String? = nil               // LOW | MEDIUM | HIGH
    var loading = false
    var error: String? = nil
    var authExpired = false

    static let segments = ["VIP", "REGULAR", "NEW", "RISKY", "BLACKLIST", "COLD"]

    // ── KPI summary — computed from the loaded list, same as the web page ──
    var totalRevenue: Int { customers.reduce(0) { $0 + ($1.totalSpent ?? 0) } }
    var vipCount: Int { customers.filter { $0.segment == "VIP" }.count }
    var highRiskCount: Int { customers.filter { $0.riskLevel == "HIGH" }.count }
    var avgClv: Int {
        guard !customers.isEmpty else { return 0 }
        let sum = customers.reduce(0) { $0 + ($1.clvScore ?? 0) }
        return Int((Double(sum) / Double(customers.count)).rounded())
    }
    func segmentCount(_ s: String) -> Int { customers.filter { $0.segment == s }.count }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: CrmCustomersResponse = try await AlmaAPI.shared.get(
                "/api/customers",
                query: ["business_id": "ALMA_LIFESTYLE",
                        "segment": segment,
                        "risk_level": risk,
                        "search": search.isEmpty ? nil : search])
            customers = resp.customers
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// Recent orders for the detail sheet — server-side search by phone digits
    /// (the orders search matches the phone column).
    func recentOrders(phone: String?) async -> [CrmRecentOrder] {
        guard let phone, !phone.isEmpty else { return [] }
        do {
            let resp: CrmOrdersLookupResponse = try await AlmaAPI.shared.get(
                "/api/orders/orders",
                query: ["business_id": "ALMA_LIFESTYLE", "search": phone, "limit": "10"])
            return resp.orders
        } catch {
            return []
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct CrmScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = CrmVM()
    @State private var selected: CrmCustomer? = nil
    @State private var searchDebounce: Task<Void, Never>? = nil
    @State private var syncing = false
    @State private var confirmingSync = false
    @State private var syncNote: String? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                kpiStrip
                segmentChips
                searchRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.customers.isEmpty { loadingRows }
                ForEach(vm.customers) { c in
                    CrmCustomerRow(customer: c) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = c
                    }
                }
                if !vm.loading && vm.customers.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(CrmAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .overlay(alignment: .bottom) {
            if let t = syncNote {
                Text(t)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: syncNote != nil)
        .sheet(item: $selected) { c in
            CrmDetailSheet(customer: c, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI board (web: Total / Lifetime Revenue / VIP / Avg CLV / High Risk) —
    //    bento language (owner spec 2026-07-08): lifetime revenue = the dark hero
    //    anchor with customers/VIP split, CLV + high-risk = 2 accent tiles.
    //    Same numbers, same tints — presentation only. ──

    private var kpiStrip: some View {
        VStack(spacing: 10) {
            CrmBentoHeroCard(revenue: vm.totalRevenue,
                             customers: vm.customers.count,
                             vips: vm.vipCount)
            HStack(spacing: 10) {
                CrmBentoStatTile(label: "Avg CLV score", value: vm.avgClv,
                                 format: { "\($0)/100" }, sub: "কাস্টমার ভ্যালু",
                                 tint: CrmPalette.blue400, accent: CrmPalette.blue400)
                CrmBentoStatTile(label: "High risk", value: vm.highRiskCount,
                                 format: { "\($0)" }, sub: "ঝুঁকিপূর্ণ কাস্টমার",
                                 tint: CrmPalette.red400, accent: CrmPalette.red500)
            }
        }
        .padding(.top, 4)
    }

    // ── Segment tabs (web: All + the 6 segments, tap again to clear) ──

    private var segmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                crmChip("All", count: vm.customers.count, tint: CrmPalette.coral,
                        active: vm.segment == nil) {
                    vm.segment = nil
                    Task { await vm.load() }
                }
                ForEach(CrmVM.segments, id: \.self) { s in
                    crmChip(s == "VIP" ? "✦ VIP" : s, count: vm.segmentCount(s),
                            tint: CrmPalette.segment(s, colorScheme),
                            active: vm.segment == s) {
                        vm.segment = vm.segment == s ? nil : s
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func crmChip(_ label: String, count: Int, tint: Color, active: Bool,
                         action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            HStack(spacing: 5) {
                Text(label).font(.footnote.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? tint : .secondary)
                if count > 0 {
                    Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? tint.opacity(colorScheme == .dark ? 0.28 : 0.16)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? tint.opacity(0.55) : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Search + risk filter (web SearchInput + risk Select) ──

    private var searchRow: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search by name, phone, district…", text: Binding(
                    get: { vm.search },
                    set: { newValue in
                        vm.search = newValue
                        searchDebounce?.cancel()
                        searchDebounce = Task { // server-side search, debounced
                            try? await Task.sleep(nanoseconds: 450_000_000)
                            if !Task.isCancelled { await vm.load() }
                        }
                    }))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

            riskMenu
        }
    }

    private var riskMenu: some View {
        Menu {
            Button("All risk levels") { vm.risk = nil; Task { await vm.load() } }
            Button("Low") { vm.risk = "LOW"; Task { await vm.load() } }
            Button("Medium") { vm.risk = "MEDIUM"; Task { await vm.load() } }
            Button("High") { vm.risk = "HIGH"; Task { await vm.load() } }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal.decrease.circle")
                if let r = vm.risk {
                    Text(r.capitalized).font(.footnote.weight(.semibold))
                }
            }
            .foregroundStyle(vm.risk == nil ? Color.secondary
                                            : CrmPalette.risk(vm.risk, colorScheme))
            .padding(.horizontal, 12).padding(.vertical, 10)
            .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(CrmPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 72)
                .crmGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .crmShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.2").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো কাস্টমার পাওয়া যায়নি").foregroundStyle(.secondary)
            Text("অন্য ফিল্টার চেষ্টা করুন").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    private var webEscape: some View {
        VStack(spacing: 10) {
            // Native "Sync from orders" (owner 2026-07-11) — web syncFromOrders parity,
            // POST /api/customers/backfill (server enforces the SUPER_ADMIN gate).
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                confirmingSync = true
            } label: {
                HStack(spacing: 6) {
                    if syncing { ProgressView().controlSize(.mini) }
                    Label(syncing ? "Syncing…" : "Sync from orders",
                          systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.bold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 9)
            }
            .buttonStyle(.bordered)
            .disabled(syncing)
            .confirmationDialog(
                "Orders থেকে customer profiles sync করবেন?",
                isPresented: $confirmingSync, titleVisibility: .visible
            ) {
                Button("হ্যাঁ, sync করুন") { runSync() }
                Button("বাতিল", role: .cancel) {}
            }
            Button {
                openWeb("/crm", "CRM")
            } label: {
                Label("ওয়েব ভার্সন", systemImage: "safari")
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func runSync() {
        guard !syncing else { return }
        syncing = true
        Task {
            defer { syncing = false }
            struct Body: Encodable { let business_id = "ALMA_LIFESTYLE" }
            struct Resp: Decodable { let processed: Int?, created: Int?, error: String? }
            do {
                let res: Resp = try await AlmaAPI.shared.send(
                    "POST", "/api/customers/backfill", body: Body())
                if let err = res.error {
                    syncNote = err
                } else {
                    syncNote = "Synced: \(res.processed ?? 0) processed, \(res.created ?? 0) new"
                    await vm.load()
                }
            } catch {
                syncNote = "Sync failed — আবার চেষ্টা করুন"
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            syncNote = nil
        }
    }
}

// MARK: - Row (contacts-style: avatar · name · district/phone · orders + spent)

@available(iOS 17.0, *)
private struct CrmCustomerRow: View {
    let customer: CrmCustomer
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                avatar
                VStack(alignment: .leading, spacing: 2) {
                    Text(customer.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("৳\((customer.totalSpent ?? 0).formatted())")
                        .font(.footnote.weight(.bold).monospacedDigit())
                    HStack(spacing: 5) {
                        Text("\(customer.totalOrders ?? 0) orders")
                            .font(.caption2).foregroundStyle(.secondary)
                        segmentPill
                    }
                }
            }
            clvBar
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    /// Web ClvBar (row-level): thin track filled to the score, number at right —
    /// same >60 gold / >30 amber / else muted map as the detail sheet.
    private var clvBar: some View {
        let score = min(max(customer.clvScore ?? 0, 0), 100)
        let tint = CrmPalette.clv(score, colorScheme)
        return HStack(spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule().fill(tint)
                        .frame(width: geo.size.width * CGFloat(score) / 100)
                }
            }
            .frame(height: 3)
            Text("\(score)")
                .font(.system(size: 10, weight: .bold)).monospacedDigit()
                .foregroundStyle(score > 60 ? CrmPalette.accentText(colorScheme) : .secondary)
        }
    }

    /// Web Avatar: initials circle — VIP wears the gold tint, others muted glass.
    private var avatar: some View {
        let vip = customer.segment == "VIP"
        return Text(CrmFormat.initials(customer.name))
            .font(.caption.weight(.bold))
            .foregroundStyle(vip ? CrmPalette.accentText(colorScheme) : .secondary)
            .frame(width: 36, height: 36)
            .background(vip ? CrmPalette.coral.opacity(0.16)
                            : Color.primary.opacity(0.06), in: Circle())
            .overlay(Circle().strokeBorder(
                vip ? CrmPalette.coral.opacity(0.35) : Color.primary.opacity(0.10), lineWidth: 1))
    }

    private var subtitle: String {
        var bits: [String] = []
        if let d = customer.district, !d.isEmpty { bits.append(d) }
        if let p = customer.phone, !p.isEmpty { bits.append(p) }
        if let last = customer.lastOrder, !last.isEmpty { bits.append(last) }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    private var segmentPill: some View {
        let tint = CrmPalette.segment(customer.segment, colorScheme)
        return Text(customer.segment ?? "—")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }
}

// MARK: - Detail sheet (web detail drawer parity)

@available(iOS 17.0, *)
private struct CrmDetailSheet: View {
    let customer: CrmCustomer
    let vm: CrmVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var recentOrders: [CrmRecentOrder] = []
    @State private var ordersLoading = true

    /// Order-derived return insights — recomputed over the fetched rows (≤10).
    private var insights: CrmReturnInsights { CrmReturnInsights(orders: recentOrders) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                badges
                spendGrid
                riskCard
                recentOrdersCard
                profileCard
                contactButtons
                webLink
            }
            .padding(18)
        }
        .presentationBackground { CrmAurora() }
        .task {
            recentOrders = await vm.recentOrders(phone: customer.phone)
            ordersLoading = false
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(CrmFormat.initials(customer.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(CrmPalette.accentText(colorScheme))
                .frame(width: 44, height: 44)
                .background(CrmPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(CrmPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(customer.name).font(.headline)
                Text("\(customer.id) · \(customer.district ?? "—")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var badges: some View {
        HStack(spacing: 6) {
            pill(customer.segment ?? "—", CrmPalette.segment(customer.segment, colorScheme))
            pill(customer.riskLevel ?? "LOW", CrmPalette.risk(customer.riskLevel, colorScheme))
            returnRiskBadge
            if customer.waOptin == "Yes" {
                pill("WA Opt-in", CrmPalette.green400)
            }
            Spacer()
        }
    }

    /// Web escalation badge (page.tsx): shows when the order-derived risk is HIGH,
    /// or MEDIUM while the sheet still says LOW, or any returns exist at all.
    @ViewBuilder private var returnRiskBadge: some View {
        if !ordersLoading, !recentOrders.isEmpty {
            let ins = insights
            let escalated = ins.computedRisk == "HIGH"
                || (ins.computedRisk == "MEDIUM" && (customer.riskLevel ?? "LOW") == "LOW")
            if escalated || ins.returnCount > 0 {
                pill("Return risk: \(ins.computedRisk)"
                        + (ins.returnsLast30Days > 0 ? " · \(ins.returnsLast30Days) in 30d" : ""),
                     ins.computedRisk == "HIGH" ? CrmPalette.red400 : CrmPalette.amber500)
            }
        }
    }

    private func pill(_ label: String, _ tint: Color) -> some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }

    // ── Spend summary (web 2×2 grid: Spend / Profit / Delivered / Loyalty) ──

    private var spendGrid: some View {
        let cols = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        return LazyVGrid(columns: cols, spacing: 10) {
            statCell("Lifetime Spend", "৳\((customer.totalSpent ?? 0).formatted())",
                     CrmPalette.accentText(colorScheme))
            statCell("Lifetime Profit", "৳\((customer.totalProfit ?? 0).formatted())",
                     (customer.totalProfit ?? 0) >= 0 ? CrmPalette.green400 : CrmPalette.red400)
            statCell("Delivered", "\(customer.delivered ?? 0)/\(customer.totalOrders ?? 0)", .primary)
            statCell("Loyalty", "\(customer.loyaltyPts ?? 0) pts", CrmPalette.accentText(colorScheme))
        }
    }

    private func statCell(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(spacing: 3) {
            Text(value).font(.subheadline.weight(.bold)).foregroundStyle(tint)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Risk intelligence (web card: score bar + stat rows) ──

    private var riskCard: some View {
        let score = customer.riskScore ?? 0
        let scoreTint: Color = score > 60 ? CrmPalette.red400
            : score > 30 ? CrmPalette.amber500 : CrmPalette.green400
        return VStack(alignment: .leading, spacing: 10) {
            Text("RISK INTELLIGENCE")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            HStack {
                Text("Risk Score").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(score)/100").font(.caption.weight(.bold)).foregroundStyle(scoreTint)
            }
            scoreBar(value: score, tint: scoreTint)
            statRow("COD Fail Rate", CrmFormat.pct(customer.codFailPct),
                    tint: (customer.codFailPct ?? 0) > 0.5 ? CrmPalette.red400 : CrmPalette.green400)
            statRow("Return Rate (sheet)", CrmFormat.pct(customer.returnRate),
                    tint: (customer.returnRate ?? 0) > 0.3 ? CrmPalette.red400 : CrmPalette.green400)
            if !ordersLoading, !recentOrders.isEmpty {
                let ins = insights
                statRow("Return Rate (orders)", "\(ins.returnRatePct)%",
                        tint: ins.returnRatePct > 30 ? CrmPalette.red400 : .primary)
                statRow("Return Loss (orders)", "৳\(ins.totalReturnLoss.formatted())",
                        tint: ins.totalReturnLoss > 0 ? CrmPalette.red400 : CrmPalette.green400)
            }
            statRow("CLV Score", "\(customer.clvScore ?? 0)/100",
                    tint: CrmPalette.clv(customer.clvScore ?? 0, colorScheme))
            statRow("Days Inactive", "\(customer.daysInactive ?? 0)",
                    tint: (customer.daysInactive ?? 0) > 90 ? CrmPalette.amber500 : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func scoreBar(value: Int, tint: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(tint)
                    .frame(width: geo.size.width * CGFloat(min(max(value, 0), 100)) / 100)
            }
        }
        .frame(height: 5)
    }

    private func statRow(_ label: String, _ value: String, tint: Color = .primary) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.bold)).foregroundStyle(tint)
        }
    }

    // ── Recent orders (web block — loaded here by phone lookup) ──

    @ViewBuilder private var recentOrdersCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT ORDERS")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if ordersLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
                }
            } else if recentOrders.isEmpty {
                Text("কোনো অর্ডার পাওয়া যায়নি").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(recentOrders) { o in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(o.id).font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(CrmPalette.accentText(colorScheme))
                            if let d = o.date, !d.isEmpty {
                                Text(d).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if let amt = o.sellPrice {
                            Text("৳\(amt.formatted())")
                                .font(.caption.weight(.bold).monospacedDigit())
                        }
                        VStack(alignment: .trailing, spacing: 3) {
                            HStack(spacing: 4) {
                                Circle().fill(o.tint).frame(width: 6, height: 6)
                                Text(o.label).font(.caption2.weight(.semibold))
                            }
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(o.tint.opacity(0.13), in: Capsule())
                            // Web: returned rows carry their loss under the badge.
                            if o.isReturn && o.returnLoss > 0 {
                                Text("−৳\(o.returnLoss.formatted())")
                                    .font(.caption2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(CrmPalette.red400)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Profile (web block: phone / address / source / fav cat / last order / notes) ──

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROFILE")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            statRow("Phone", customer.phone ?? "—")
            statRow("Address", customer.address?.isEmpty == false ? customer.address! : "—")
            statRow("Source", customer.source?.isEmpty == false ? customer.source! : "—")
            statRow("Fav Cat.", customer.favCategory?.isEmpty == false ? customer.favCategory! : "—")
            statRow("Last Order", customer.lastOrder?.isEmpty == false ? customer.lastOrder! : "—")
            if let n = customer.notes, !n.isEmpty {
                statRow("Notes", n, tint: CrmPalette.amber500)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .crmGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Contact (call + WhatsApp, same 880 rule as the Orders screen) ──

    @ViewBuilder private var contactButtons: some View {
        if let phone = customer.phone, !phone.isEmpty {
            HStack(spacing: 10) {
                Link(destination: URL(string: "tel://\(phone)")!) {
                    Label("Call", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                if let wa = customer.whatsappURL {
                    Link(destination: wa) {
                        Label("WhatsApp", systemImage: "message.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(CrmPalette.emerald600)
                }
            }
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/crm", "CRM")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum CrmFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    /// 0..1 ratio → "42%" (web pct()).
    static func pct(_ ratio: Double?) -> String {
        "\(Int(((ratio ?? 0) * 100).rounded()))%"
    }
}

// MARK: - Aurora background + glass (CRM-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct CrmAurora: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    private struct AuroraBlob { let color: Color; let size: CGFloat; let x: CGFloat; let y: CGFloat; let dx: CGFloat; let dy: CGFloat }

    var body: some View {
        let dark = scheme == .dark
        // Agent-parity living aurora (web --aurora-blob-1…5): five blurred colour blobs
        // drifting corner-to-corner over the page canvas. Owner directive 2026-07-08:
        // every native page shares the Assistant tab's moving aurora.
        let blobs: [AuroraBlob] = [
            .init(color: Color(red: 0.220, green: 0.502, blue: 1.000).opacity(dark ? 0.60 : 0.30), size: 380, x: 0.15, y: 0.10, dx: 60, dy: 40),
            .init(color: Color(red: 0.486, green: 0.302, blue: 1.000).opacity(dark ? 0.55 : 0.26), size: 420, x: 0.85, y: 0.25, dx: -50, dy: 60),
            .init(color: Color(red: 0.839, green: 0.200, blue: 1.000).opacity(dark ? 0.50 : 0.24), size: 360, x: 0.30, y: 0.55, dx: 70, dy: -40),
            .init(color: Color(red: 1.000, green: 0.180, blue: 0.525).opacity(dark ? 0.55 : 0.26), size: 400, x: 0.80, y: 0.80, dx: -60, dy: -50),
            .init(color: Color(red: 1.000, green: 0.431, blue: 0.314).opacity(dark ? 0.45 : 0.22), size: 340, x: 0.20, y: 0.95, dx: 50, dy: -60),
        ]
        GeometryReader { geo in
            ZStack {
                (dark ? Color(red: 0.078, green: 0.078, blue: 0.094)
                      : Color(red: 0.980, green: 0.976, blue: 0.965))
                RadialGradient(colors: [Color(red: 0.388, green: 0.400, blue: 0.945).opacity(dark ? 0.22 : 0.10), .clear],
                               center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: geo.size.height * 0.8)
                RadialGradient(colors: [Color(red: 0.925, green: 0.282, blue: 0.600).opacity(dark ? 0.28 : 0.12), .clear],
                               center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: geo.size.height * 0.9)
                ForEach(Array(blobs.enumerated()), id: \.offset) { _, b in
                    Circle()
                        // Radial-gradient falloff reads the same as the old blur(70)
                        // but costs ZERO gaussian passes — the live blurs were the
                        // app-wide transition/scroll jank source (perf audit 2026-07-08).
                        .fill(RadialGradient(colors: [b.color, b.color.opacity(0)],
                                             center: .center,
                                             startRadius: b.size * 0.10,
                                             endRadius: b.size * 0.62))
                        .frame(width: b.size * 1.35, height: b.size * 1.35)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                }
            }
            .onAppear { updateDrift() }
            // Covered/backgrounded screens must not keep animating — pausing here means
            // a stack of pushed pages costs nothing while hidden.
            .onDisappear { pauseDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func pauseDrift() {
        var tx = Transaction(); tx.disablesAnimations = true
        withTransaction(tx) { drift = false }
    }

    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            // Start the drift AFTER the push/present transition settles — kicking a
            // repeatForever animation mid-transition made every slide-in stutter.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                guard !drift, !reduceMotion,
                      !ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
                withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
            }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func crmGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct CrmShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content
            .overlay(
                LinearGradient(colors: [.clear, .white.opacity(0.25), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .offset(x: phase * 320)
                    .clipped()
            )
            .onAppear {
                withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 }
            }
    }
}

@available(iOS 17.0, *)
private extension View {
    func crmShimmer() -> some View { modifier(CrmShimmer()) }
}

// MARK: - Bento components (CRM-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func crmMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct CrmCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        CrmCountUpText(value: shown, format: format)
            .animation(crmMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if crmMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct CrmCountUpText: View, Animatable {
    var value: Double
    var format: (Int) -> String
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text(format(Int(value.rounded())))
    }
}

/// Shared tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func crmBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
    ZStack {
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous).fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
        LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.14 : 0.10), .clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
}

/// Small glass stat tile — count-up value + sub line over a soft accent wash.
@available(iOS 17.0, *)
private struct CrmBentoStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: Int
    let format: (Int) -> String
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            CrmCountUp(target: value, format: format)
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { crmBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Lifetime-revenue count-up
/// plus the Customers / VIP split — the same numbers the old strip showed.
@available(iOS 17.0, *)
private struct CrmBentoHeroCard: View {
    let revenue: Int
    let customers: Int
    let vips: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("লাইফটাইম রেভিনিউ · CRM").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(CrmPalette.goldLt)
            CrmCountUp(target: revenue, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("সব কাস্টমারের মোট কেনাকাটা")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Customers", value: customers, format: { "\($0)" },
                         tint: .white, sub: "মোট কাস্টমার")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "VIP", value: vips, format: { "\($0)" },
                         tint: CrmPalette.goldLt, sub: "টপ টিয়ার")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Int, format: @escaping (Int) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            CrmCountUp(target: value, format: format)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("CRM — Light") {
    CrmScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
