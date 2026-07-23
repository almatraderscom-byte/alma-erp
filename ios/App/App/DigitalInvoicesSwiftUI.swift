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
//  NATIVE WRITES (verified 2026-07-17): invoice create, payment record, PDF generation
//  (POST /api/digital/invoices/pdf). STILL WEB (parity ledger FN-02, phase NP-7):
//  in-app PDF preview (PDFKit/Quick Look).
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays.
//

import SwiftUI
import PDFKit

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum DigitalInvoicesPalette {
    /// CDIT hero accent — the digital wing's blue (owner spec for /digital natives).
    static let cditBlue = Color(red: 0.42, green: 0.56, blue: 0.88)
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
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

    // ── Native writes (owner 2026-07-11) — web page payloads verbatim. ──

    var toast: String? = nil

    struct InvoicePayload: Encodable {
        let client_name: String
        let client_id: String
        let project_id: String
        let amount: Int                      // web roundMoney() → whole taka
        let invoice_type: String             // one-time | recurring
        let due_date: String
        let recurring_interval: String
        let notes: String
        let status = "Sent"
        let business_id = "CREATIVE_DIGITAL_IT"
    }
    struct PaymentPayload: Encodable {
        let invoice_id: String
        let client_id: String
        let client_name: String
        let amount: Int
        let payment_method: String
        let payment_type = "income"
        let business_id = "CREATIVE_DIGITAL_IT"
    }
    private struct WriteResponse: Decodable { let ok: Bool?, error: String? }
    private struct PdfResponse: Decodable { let ok: Bool?, pdf_url: String?, error: String? }

    func createInvoice(_ p: InvoicePayload) async -> Bool {
        await write("/api/digital/invoices", p, success: "Invoice created")
    }
    func recordPayment(_ p: PaymentPayload) async -> Bool {
        await write("/api/digital/payments", p, success: "Payment recorded")
    }
    /// Web api.digital.invoices.generatePdf — POST returns a hosted pdf_url.
    func generatePdf(invoiceId: String) async -> URL? {
        struct Body: Encodable { let invoice_id: String }
        do {
            let res: PdfResponse = try await AlmaAPI.shared.send(
                "POST", "/api/digital/invoices/pdf", body: Body(invoice_id: invoiceId))
            guard res.ok ?? false, let raw = res.pdf_url, let url = URL(string: raw) else {
                toast = res.error ?? "PDF তৈরি হয়নি"
                return nil
            }
            return url
        } catch {
            toast = error.localizedDescription
            return nil
        }
    }
    private func write(_ path: String, _ body: some Encodable, success: String) async -> Bool {
        do {
            let res: WriteResponse = try await AlmaAPI.shared.send("POST", path, body: body)
            guard res.ok ?? false else {
                toast = res.error ?? "সেভ হয়নি — আবার চেষ্টা করুন"
                return false
            }
            toast = success
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch {
            if Self.isCancellation(error) { return false }
            toast = error.localizedDescription
            return false
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct DigitalInvoicesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = DigitalInvoicesVM()
    @State private var showCreate = false
    @State private var selected: DigitalInvoiceRow? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                heroBoard
                newInvoiceButton
                rangeChips
                statusChips
                if vm.loading && vm.invoices.isEmpty { loadingRows }
                ForEach(vm.filtered) { inv in
                    DigitalInvoiceCard(invoice: inv) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = inv          // native actions sheet (owner 2026-07-11)
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
        .sheet(isPresented: $showCreate) { DigitalInvoicesCreateSheet(vm: vm) }
        .sheet(item: $selected) { inv in
            DigitalInvoiceActionsSheet(invoice: inv, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .bottom) {
            if let t = vm.toast {
                Text(t)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        withAnimation { vm.toast = nil }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: vm.toast != nil)
    }

    /// Web header "+ New Invoice" — native form sheet (owner 2026-07-11).
    private var newInvoiceButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showCreate = true
        } label: {
            Label("+ New Invoice", systemImage: "doc.badge.plus")
                .font(.caption.weight(.bold))
                .foregroundStyle(DigitalInvoicesPalette.accentText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(DigitalInvoicesPalette.cditBlue.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(DigitalInvoicesPalette.cditBlue.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
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
                .lineLimit(1).minimumScaleFactor(0.5)
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

// MARK: - Native write sheets (owner 2026-07-11 — web "+ New Invoice" form, per-invoice
// Record-payment + premium PDF, same endpoints/payloads as the web page).

@available(iOS 17.0, *)
private struct DigitalInvoicesCreateSheet: View {
    let vm: DigitalInvoicesVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var clientName = ""
    @State private var clientId = ""
    @State private var projectId = ""
    @State private var amount = ""
    @State private var invoiceType = "one-time"
    @State private var dueDate: Date? = nil
    @State private var recurringInterval = ""
    @State private var notes = ""
    @State private var submitting = false
    @State private var confirming = false
    @State private var errorText: String? = nil

    private var taka: Int { Int(Double(amount.replacingOccurrences(of: ",", with: "")) ?? 0) }
    private var canSubmit: Bool { !clientName.trimmingCharacters(in: .whitespaces).isEmpty && taka > 0 }
    private static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("New Invoice").font(.subheadline.weight(.bold))
                    Text("তৈরি হলে status = Sent।").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Close") { dismiss() }
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 12)
            Divider().opacity(0.4)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("Client name *", text: $clientName)
                    field("Client ID", text: $clientId)
                    field("Project ID", text: $projectId)
                    field("Amount (BDT) *", text: $amount, keyboard: .numberPad)
                    Picker("Type", selection: $invoiceType) {
                        Text("One-time").tag("one-time")
                        Text("Recurring").tag("recurring")
                    }
                    .pickerStyle(.segmented)
                    if invoiceType == "recurring" {
                        field("Recurring interval (e.g. monthly)", text: $recurringInterval)
                    }
                    HStack {
                        Text("Due date").font(.subheadline)
                        Spacer()
                        if let d = dueDate {
                            DatePicker("", selection: Binding(get: { d }, set: { dueDate = $0 }),
                                       displayedComponents: .date)
                                .labelsHidden()
                            Button {
                                dueDate = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Button("সেট করুন") { dueDate = Date() }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color.primary.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    field("Notes", text: $notes)
                    if let errorText {
                        Text(errorText).font(.caption2.weight(.semibold))
                            .foregroundStyle(DigitalInvoicesPalette.red500)
                    }
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)

            Divider().opacity(0.4)
            Button {
                confirming = true
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "Saving…" : "Create Invoice").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSubmit && !submitting
                            ? DigitalInvoicesPalette.cditBlue
                            : DigitalInvoicesPalette.cditBlue.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            .padding(.horizontal, 18).padding(.vertical, 14)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .confirmationDialog(
            "\(clientName)-এর জন্য ৳\(taka.formatted()) invoice তৈরি করবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, তৈরি করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func field(_ placeholder: String, text: Binding<String>,
                       keyboard: UIKeyboardType = .default) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .font(.subheadline)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok = await vm.createInvoice(.init(
                client_name: clientName.trimmingCharacters(in: .whitespaces),
                client_id: clientId, project_id: projectId, amount: taka,
                invoice_type: invoiceType,
                due_date: dueDate.map { Self.ymd.string(from: $0) } ?? "",
                recurring_interval: recurringInterval, notes: notes))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }
}

/// Per-invoice actions: record payment (native POST), premium PDF (native generate +
/// share), open on web. Replaces the old row tap that always bounced to the web page.
@available(iOS 17.0, *)
private struct DigitalInvoiceActionsSheet: View {
    let invoice: DigitalInvoiceRow
    let vm: DigitalInvoicesVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    private static let methods = ["Bank Transfer", "bKash", "Nagad", "Cash",
                                  "PayPal", "Stripe", "Other"]

    @State private var payAmount = ""
    @State private var payMethod = "Bank Transfer"
    @State private var paying = false
    @State private var confirmingPay = false
    @State private var pdfURL: URL? = nil
    @State private var previewBusy = false
    @State private var previewFile: URL? = nil
    @State private var makingPdf = false

    private var taka: Int { Int(Double(payAmount.replacingOccurrences(of: ",", with: "")) ?? 0) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // Header — invoice identity + status.
                VStack(alignment: .leading, spacing: 4) {
                    Text(invoice.clientName).font(.headline)
                    Text("\(invoice.id) · \(invoice.invoiceType ?? "one-time")")
                        .font(.caption2).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        stat("Amount", invoice.amount ?? 0)
                        stat("Paid", invoice.totalPaid ?? 0)
                        stat("Due", invoice.dueAmount ?? 0)
                    }
                    .padding(.top, 6)
                }

                // Record payment (web handlePartialPay parity).
                VStack(alignment: .leading, spacing: 10) {
                    Text("RECORD PAYMENT").font(.system(size: 9, weight: .bold)).tracking(1)
                        .foregroundStyle(.secondary)
                    TextField("Amount (BDT)", text: $payAmount)
                        .keyboardType(.numberPad)
                        .font(.title3.weight(.bold)).monospacedDigit()
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(Color.primary.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    Menu {
                        ForEach(Self.methods, id: \.self) { m in Button(m) { payMethod = m } }
                    } label: {
                        HStack {
                            Text(payMethod).font(.subheadline.weight(.semibold))
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(Color.primary.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    }
                    Button {
                        confirmingPay = true
                    } label: {
                        HStack(spacing: 8) {
                            if paying { ProgressView().tint(.white) }
                            Text("Record payment").font(.subheadline.weight(.bold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(taka > 0 && !paying
                                    ? DigitalInvoicesPalette.emerald600
                                    : DigitalInvoicesPalette.emerald600.opacity(0.4),
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(taka <= 0 || paying)
                }
                .padding(12)
                .background(Color.primary.opacity(0.04),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))

                // Premium PDF — native generate + iOS share sheet.
                if let pdfURL {
                    // NP-7 (FN-02): native in-app preview (PDFKit) + save/share.
                    Button {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        previewBusy = true
                        Task {
                            defer { previewBusy = false }
                            if let (data, _) = try? await URLSession.shared.data(from: pdfURL) {
                                let f = FileManager.default.temporaryDirectory
                                    .appendingPathComponent("cdit-invoice-\(invoice.id).pdf")
                                try? data.write(to: f, options: .atomic)
                                previewFile = f
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if previewBusy { ProgressView().controlSize(.mini) }
                            Label("👁️ PDF দেখুন", systemImage: "doc.text.magnifyingglass")
                                .font(.caption.weight(.bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                    }
                    .buttonStyle(.bordered)
                    .disabled(previewBusy)
                    .sheet(item: $previewFile) { f in
                        AlmaPDFPreviewSheet(fileURL: f)
                    }
                    ShareLink(item: pdfURL) {
                        Label("PDF শেয়ার করুন", systemImage: "square.and.arrow.up")
                            .font(.caption.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button {
                        makingPdf = true
                        Task {
                            pdfURL = await vm.generatePdf(invoiceId: invoice.id)
                            makingPdf = false
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if makingPdf { ProgressView().controlSize(.mini) }
                            Label("Premium PDF তৈরি করুন", systemImage: "doc.richtext")
                                .font(.caption.weight(.bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                    }
                    .buttonStyle(.bordered)
                    .disabled(makingPdf)
                }

                Button {
                    dismiss()
                    openWeb("/digital/invoices", "CDIT Invoices")
                } label: {
                    Label("ওয়েবে খুলুন", systemImage: "safari").font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
            }
            .padding(18)
        }
        .background(AlmaSwiftTheme.rootBg(scheme))
        .confirmationDialog(
            "৳\(taka.formatted()) payment (\(payMethod)) রেকর্ড করবেন?",
            isPresented: $confirmingPay, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, রেকর্ড করুন") { pay() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func stat(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
            Text("৳\(value.formatted())").font(.caption.weight(.bold)).monospacedDigit()
        }
    }

    private func pay() {
        guard taka > 0, !paying else { return }
        paying = true
        Task {
            defer { paying = false }
            let ok = await vm.recordPayment(.init(
                invoice_id: invoice.id, client_id: invoice.clientId ?? "",
                client_name: invoice.clientName, amount: taka, payment_method: payMethod))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() }
        }
    }
}


// MARK: - NP-7 (FN-02): PDFKit preview sheet (hosted PDF displayed natively)

extension URL: Identifiable {
    public var id: String { absoluteString }
}

@available(iOS 17.0, *)
struct AlmaPDFPreviewSheet: View {
    let fileURL: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AlmaPDFKitView(url: fileURL)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("PDF")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("বন্ধ") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: fileURL) { Image(systemName: "square.and.arrow.up") }
                    }
                }
        }
    }
}

@available(iOS 17.0, *)
private struct AlmaPDFKitView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(url: url)
        return v
    }
    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url {
            view.document = PDFDocument(url: url)
        }
    }
}
