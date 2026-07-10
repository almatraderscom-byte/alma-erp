//
//  DigitalInvoicesSwiftUI.swift
//  ALMA ERP — the CDIT (Creative Digital IT) invoices page as a native SwiftUI
//  screen (web /digital/invoices parity).
//
//  Mirrors the web /digital/invoices page — same endpoint, same colours, same blocks:
//    GET /api/digital/invoices?business_id=CREATIVE_DIGITAL_IT&status=…  → { invoices }
//  Web-parity blocks: status filter (All/Unpaid/Partial Paid/Paid/Sent/Draft — the
//  web's Select, server-side param) · date-range filter (the web's DateRangeFilter,
//  client-side on issued_date||created_at YMD — native preset chips) · invoice rows
//  (mono id · client · type + due date · PaymentStatusBadge Unpaid-muted /
//  Partial-amber / Paid-emerald · amount · Paid green / Due amber sublines).
//  MUTATIONS STAY WEB: create invoice, record payment and the premium PDF preview
//  are the web escape ("ওয়েবে খুলুন" → /digital/invoices) — this screen is read-only.
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum DigitalInvoicesPalette {
    /// CDIT hero accent — the digital wing's blue (owner spec for /digital natives).
    static let cditBlue = Color(red: 0.42, green: 0.56, blue: 0.88)
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let amber400 = Color(red: 0.984, green: 0.749, blue: 0.141)       // #FBBF24
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let emerald400 = Color(red: 0.204, green: 0.827, blue: 0.600)     // #34D399
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web PaymentStatusBadge: Unpaid text-muted · Partial Paid amber-400 ·
    /// Paid emerald-400 (light mode drops to the 600 shades for contrast).
    static func payment(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "Paid": return scheme == .dark ? emerald400 : emerald600
        case "Partial Paid": return scheme == .dark ? amber400 : amber600
        default: return slate400                       // Unpaid / unknown = muted
        }
    }

    /// Paid/Due sublines: web text-emerald-400 / text-amber-400.
    static func paidLine(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? emerald400 : emerald600
    }
    static func dueLine(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? amber400 : amber600
    }
}

// MARK: - Models (same field names the web CditInvoice type declares — snake_case wire)

private struct DigitalInvoiceRow: Decodable, Identifiable, Equatable {
    let id: String
    let clientId: String?
    let clientName: String
    let projectId: String?
    let invoiceType: String?          // "one-time" | "recurring"
    let amount: Int?
    let status: String?               // Draft | Sent | Paid | Overdue | Cancelled | Partial Paid
    let dueDate: String?
    let issuedDate: String?
    let recurringInterval: String?
    let notes: String?
    let createdAt: String?
    let totalPaid: Int?
    let dueAmount: Int?
    let paymentStatus: String?        // Unpaid | Partial Paid | Paid

    private enum Keys: String, CodingKey {
        case id
        case clientId = "client_id"
        case clientName = "client_name"
        case projectId = "project_id"
        case invoiceType = "invoice_type"
        case amount, status, notes
        case dueDate = "due_date"
        case issuedDate = "issued_date"
        case recurringInterval = "recurring_interval"
        case createdAt = "created_at"
        case totalPaid = "total_paid"
        case dueAmount = "due_amount"
        case paymentStatus = "payment_status"
    }

    /// Sheet-backfilled rows carry numbers in string fields and vice-versa — decode
    /// defensively so ONE bad row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawId = try? c.decodeIfPresent(String.self, forKey: .id)
        clientName = Self.flexString(c, .clientName) ?? "—"
        id = rawId ?? UUID().uuidString
        clientId = Self.flexString(c, .clientId)
        projectId = Self.flexString(c, .projectId)
        invoiceType = Self.flexString(c, .invoiceType)
        amount = Self.flexInt(c, .amount)
        status = Self.flexString(c, .status)
        dueDate = Self.flexString(c, .dueDate)
        issuedDate = Self.flexString(c, .issuedDate)
        recurringInterval = Self.flexString(c, .recurringInterval)
        notes = Self.flexString(c, .notes)
        createdAt = Self.flexString(c, .createdAt)
        totalPaid = Self.flexInt(c, .totalPaid)
        dueAmount = Self.flexInt(c, .dueAmount)
        paymentStatus = Self.flexString(c, .paymentStatus)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k), let d = Double(s) { return Int(d.rounded()) }
        return nil
    }
    private static func flexString(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return String(d) }
        return nil
    }

    static func == (a: DigitalInvoiceRow, b: DigitalInvoiceRow) -> Bool {
        a.id == b.id && a.paymentStatus == b.paymentStatus && a.totalPaid == b.totalPaid
    }

    /// Web invoiceYmd(): (issued_date || created_at).slice(0, 10).
    var ymd: String {
        let raw = (issuedDate?.isEmpty == false ? issuedDate : createdAt) ?? ""
        return String(raw.prefix(10))
    }
}

/// GET /api/digital/invoices answers flat `{ invoices }` — tolerate an
/// apiDataSuccess-style `{ ok, data: {…} }` wrap too, like the approvals decoder.
private struct DigitalInvoicesListResponse: Decodable {
    let invoices: [DigitalInvoiceRow]

    private enum Keys: String, CodingKey { case ok, data, invoices }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        invoices = (try? c.decode([DigitalInvoiceRow].self, forKey: .invoices)) ?? []
    }
}

// MARK: - Date-range presets (the web's DateRangeFilter, client-side YMD compare)

private enum DigitalInvoicesRange: String, CaseIterable {
    case all, today, week, thisMonth, days30

    var label: String {
        switch self {
        case .all: return "সব সময়"
        case .today: return "আজ"
        case .week: return "৭ দিন"
        case .thisMonth: return "এই মাস"
        case .days30: return "৩০ দিন"
        }
    }

    /// Start YMD in Asia/Dhaka (nil = no lower bound). End is always today — the
    /// same `ymd >= start && ymd <= end` string compare the web's inRangeYmd does.
    var startYmd: String? {
        switch self {
        case .all: return nil
        case .today: return DigitalInvoicesFormat.ymd(Date())
        case .week: return DigitalInvoicesFormat.ymd(daysAgo: 6)
        case .days30: return DigitalInvoicesFormat.ymd(daysAgo: 29)
        case .thisMonth: return DigitalInvoicesFormat.monthStartYmd()
        }
    }

    /// Web inRangeYmd parity: rows with a broken/missing date always pass.
    func contains(_ ymd: String) -> Bool {
        guard let start = startYmd else { return true }
        guard ymd.count >= 10 else { return true }
        return ymd >= start && ymd <= DigitalInvoicesFormat.ymd(Date())
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class DigitalInvoicesVM {
    var invoices: [DigitalInvoiceRow] = []
    var status = ""                       // "" (all) | Unpaid | Partial Paid | Paid | Sent | Draft
    var range: DigitalInvoicesRange = .all
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// The web's status Select options, verbatim (server-side `status` param).
    struct StatusOption: Identifiable {
        let label: String
        let value: String
        var id: String { value }
    }
    static let statusOptions: [StatusOption] = [
        .init(label: "All", value: ""),
        .init(label: "Unpaid", value: "Unpaid"),
        .init(label: "Partial Paid", value: "Partial Paid"),
        .init(label: "Paid", value: "Paid"),
        .init(label: "Sent", value: "Sent"),
        .init(label: "Draft", value: "Draft"),
    ]

    /// Client-side date-range cut, same as the web's filteredInvoices useMemo.
    var filtered: [DigitalInvoiceRow] {
        invoices.filter { range.contains($0.ymd) }
    }

    // ── Hero summary — computed from the filtered list (bento presentation of
    //    the same numbers every web row shows) ──
    var totalAmount: Int { filtered.reduce(0) { $0 + ($1.amount ?? 0) } }
    var totalPaid: Int { filtered.reduce(0) { $0 + ($1.totalPaid ?? 0) } }
    var totalDue: Int { filtered.reduce(0) { $0 + ($1.dueAmount ?? 0) } }
    func paymentCount(_ s: String) -> Int { filtered.filter { $0.paymentStatus == s }.count }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: DigitalInvoicesListResponse = try await AlmaAPI.shared.get(
                "/api/digital/invoices",
                query: ["business_id": "CREATIVE_DIGITAL_IT",
                        "status": status.isEmpty ? nil : status])
            invoices = resp.invoices
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
}

// MARK: - Screen

@available(iOS 17.0, *)
struct DigitalInvoicesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = DigitalInvoicesVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                heroBoard
                rangeChips
                statusChips
                if vm.loading && vm.invoices.isEmpty { loadingRows }
                ForEach(vm.filtered) { inv in
                    DigitalInvoiceCard(invoice: inv) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        openWeb("/digital/invoices", "CDIT Invoices")
                    }
                }
                if !vm.loading && vm.filtered.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(DigitalInvoicesAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Hero board — bento language (owner spec 2026-07-08): dark anchor with the
    //    invoiced total + Paid/Due split + paid-share bar, then the payment-status
    //    counts as glass tiles. Same numbers the web rows carry — presentation only. ──

    private var heroBoard: some View {
        VStack(spacing: 10) {
            DigitalInvoicesHeroCard(amount: vm.totalAmount,
                                    count: vm.filtered.count,
                                    paid: vm.totalPaid,
                                    due: vm.totalDue,
                                    rangeLabel: vm.range.label)
            HStack(spacing: 10) {
                DigitalInvoicesStatTile(label: "Paid", value: vm.paymentCount("Paid"),
                                        sub: "পরিশোধিত",
                                        tint: DigitalInvoicesPalette.paidLine(colorScheme),
                                        accent: DigitalInvoicesPalette.green400)
                DigitalInvoicesStatTile(label: "Partial", value: vm.paymentCount("Partial Paid"),
                                        sub: "আংশিক পেমেন্ট",
                                        tint: DigitalInvoicesPalette.dueLine(colorScheme),
                                        accent: DigitalInvoicesPalette.amber500)
                DigitalInvoicesStatTile(label: "Unpaid", value: vm.paymentCount("Unpaid"),
                                        sub: "বাকি আছে",
                                        tint: DigitalInvoicesPalette.slate400,
                                        accent: DigitalInvoicesPalette.cditBlue)
            }
        }
        .padding(.top, 4)
    }

    // ── Date-range filter (web DateRangeFilter — native preset chips) ──

    private var rangeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DigitalInvoicesRange.allCases, id: \.rawValue) { r in
                    digitalChip(r.label, tint: DigitalInvoicesPalette.cditBlue,
                                active: vm.range == r) {
                        vm.range = r          // client-side cut — no reload needed
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // ── Status filter (the web's Select — server-side `status` param) ──

    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DigitalInvoicesVM.statusOptions) { opt in
                    digitalChip(opt.label,
                                tint: opt.value.isEmpty
                                    ? DigitalInvoicesPalette.cditBlue
                                    : DigitalInvoicesPalette.payment(opt.value == "Sent" || opt.value == "Draft" ? nil : opt.value, colorScheme),
                                active: vm.status == opt.value) {
                        vm.status = opt.value
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func digitalChip(_ label: String, tint: Color, active: Bool,
                             action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? tint : .secondary)
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

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .digitalInvoicesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(DigitalInvoicesPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).digitalInvoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 84)
                .digitalInvoicesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .digitalInvoicesShimmer()
        }
    }

    /// Web Empty parity: ◈ "No invoices in range" / "Adjust dates or create a new invoice".
    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("◈").font(.largeTitle).foregroundStyle(.secondary)
            Text("No invoices in range").font(.subheadline.weight(.semibold))
            Text("তারিখ বদলান, অথবা ওয়েবে নতুন ইনভয়েস তৈরি করুন")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 40)
        .padding(.bottom, 20)
    }

    /// Mutations + premium PDF stay on the web — the page's escape hatch.
    private var webEscape: some View {
        Button {
            openWeb("/digital/invoices", "CDIT Invoices")
        } label: {
            Label("নতুন ইনভয়েস / পেমেন্ট / PDF — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Invoice row card (mirrors one web list row)

@available(iOS 17.0, *)
private struct DigitalInvoiceCard: View {
    let invoice: DigitalInvoiceRow
    let onOpenWeb: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // Web: font-mono text-gold invoice id.
                Text(invoice.id)
                    .font(.caption2.monospaced().weight(.bold))
                    .foregroundStyle(DigitalInvoicesPalette.accentText(colorScheme))
                    .lineLimit(1)
                Spacer(minLength: 4)
                paymentBadge
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(invoice.clientName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    // Web: "{invoice_type} · Due {due_date || —}".
                    Text("\(typeLabel) · Due \(DigitalInvoicesFormat.orDash(invoice.dueDate))")
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(DigitalInvoicesFormat.taka(invoice.amount))
                        .font(.callout.weight(.bold).monospacedDigit())
                    HStack(spacing: 8) {
                        Text("Paid \(DigitalInvoicesFormat.taka(invoice.totalPaid))")
                            .font(.system(size: 10).weight(.semibold)).monospacedDigit()
                            .foregroundStyle(DigitalInvoicesPalette.paidLine(colorScheme))
                        Text("Due \(DigitalInvoicesFormat.taka(invoice.dueAmount))")
                            .font(.system(size: 10).weight(.semibold)).monospacedDigit()
                            .foregroundStyle(DigitalInvoicesPalette.dueLine(colorScheme))
                    }
                }
            }

            HStack(spacing: 6) {
                if invoice.invoiceType == "recurring",
                   let interval = invoice.recurringInterval, !interval.isEmpty {
                    Label(interval, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                // Web "Preview PDF" — the premium PDF modal is web-only; small link.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    onOpenWeb()
                } label: {
                    Label("PDF — ওয়েবে", systemImage: "doc.richtext")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        // Payment-tone wash: the row's glass carries a soft diagonal tint of its own
        // payment status (Paid green / Partial amber / Unpaid neutral slate).
        .background {
            digitalInvoicesBentoWash(DigitalInvoicesPalette.payment(invoice.paymentStatus, colorScheme),
                                     scheme: colorScheme)
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }

    private var typeLabel: String {
        (invoice.invoiceType?.isEmpty == false ? invoice.invoiceType! : "one-time")
    }

    private var paymentBadge: some View {
        let s = invoice.paymentStatus ?? "Unpaid"
        let tint = DigitalInvoicesPalette.payment(s, colorScheme)
        return Text(s.uppercased())
            .font(.system(size: 9, weight: .bold))
            .tracking(0.5)
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Formatting helpers (web util parity)

private enum DigitalInvoicesFormat {
    /// Whole-taka BDT — web Money component: `৳ Number(amount).toLocaleString()`.
    static func taka(_ amount: Int?) -> String {
        "৳\((amount ?? 0).formatted())"
    }

    static func orDash(_ s: String?) -> String {
        (s?.isEmpty == false) ? s! : "—"
    }

    private static let dhakaFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Today (or any date) as an Asia/Dhaka YMD string — the ERP's timezone.
    static func ymd(_ date: Date) -> String {
        dhakaFormatter.string(from: date)
    }

    static func ymd(daysAgo: Int) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let d = cal.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        return ymd(d)
    }

    static func monthStartYmd() -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let comps = cal.dateComponents([.year, .month], from: Date())
        return ymd(cal.date(from: comps) ?? Date())
    }
}

// MARK: - Aurora background + glass (DigitalInvoices-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct DigitalInvoicesAurora: View {
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
    func digitalInvoicesGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct DigitalInvoicesShimmer: ViewModifier {
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
    func digitalInvoicesShimmer() -> some View { modifier(DigitalInvoicesShimmer()) }
}

// MARK: - Bento components (DigitalInvoices-owned copies of the Dashboard board
// language — per-file copies are this repo's parallel-session convention)

/// Central motion gate — count-ups and bar sweeps freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func digitalInvoicesMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct DigitalInvoicesCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        DigitalInvoicesCountUpText(value: shown, format: format)
            .animation(digitalInvoicesMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if digitalInvoicesMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct DigitalInvoicesCountUpText: View, Animatable {
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

/// Shared tile/row backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func digitalInvoicesBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
private struct DigitalInvoicesStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: Int
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            DigitalInvoicesCountUp(target: value, format: { "\($0)" })
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { digitalInvoicesBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// Paid-share mini bar — sweeps to its fraction on appear, frozen when motion is limited.
@available(iOS 17.0, *)
private struct DigitalInvoicesMiniBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let fraction: CGFloat
    let color: Color
    var height: CGFloat = 7
    @State private var grow = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.55), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(geo.size.width * min(max(fraction, 0), 1), height) * (grow ? 1 : 0.001))
            }
        }
        .frame(height: height)
        .onAppear {
            if digitalInvoicesMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.6, bounce: 0.18)) { grow = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { grow = true }
            }
        }
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + washes; the CDIT wing swaps violet for its blue accent).
/// Invoiced-total count-up + Paid/Due split + a paid-share mini bar.
@available(iOS 17.0, *)
private struct DigitalInvoicesHeroCard: View {
    let amount: Int
    let count: Int
    let paid: Int
    let due: Int
    let rangeLabel: String

    private var paidShare: CGFloat {
        amount > 0 ? CGFloat(paid) / CGFloat(amount) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("CDIT ইনভয়েস · \(rangeLabel)").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(DigitalInvoicesPalette.cditBlue.opacity(0.95))
            DigitalInvoicesCountUp(target: amount, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.5)
                .padding(.top, 8)
            Text("\(count)টি ইনভয়েস · Creative Digital IT")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Paid", value: paid,
                         tint: DigitalInvoicesPalette.green400, sub: "পরিশোধিত")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Due", value: due,
                         tint: due > 0 ? DigitalInvoicesPalette.amber500 : .white, sub: "বাকি")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)

            DigitalInvoicesMiniBar(fraction: paidShare, color: DigitalInvoicesPalette.green400)
                .padding(.top, 12)
            Text("পেইড শেয়ার \(Int((paidShare * 100).rounded()))%")
                .font(.system(size: 9)).foregroundStyle(.white.opacity(0.5)).padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.082, green: 0.094, blue: 0.157))
                LinearGradient(colors: [DigitalInvoicesPalette.cditBlue.opacity(0.36), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.26), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.12), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            DigitalInvoicesCountUp(target: value, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("CDIT Invoices — Light") {
    DigitalInvoicesScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
