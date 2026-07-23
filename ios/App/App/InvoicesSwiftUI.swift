//
//  InvoicesSwiftUI.swift
//  ALMA ERP — the Invoices tab as a native SwiftUI screen (web /invoice parity).
//
//  Mirrors the web /invoice page — same endpoints, same colours, same blocks:
//    GET   /api/invoice?business_id=…&search=…&payment_status=…   → registry + totals
//    POST  /api/invoice  {id, allow_regenerate, business_id}      → generate / regenerate
//    PATCH /api/invoice  {id, payment_status}                     → payment status change
//    GET   /api/orders/orders?business_id=…&status=Delivered      → pending-invoice KPI
//  Web-parity blocks: 3 KPI cards (Delivered/Invoiced/Pending) · search · payment-status
//  filter chips (All/Unpaid/Partial/Paid/Void) · "Pending Invoices" amber section with
//  native Generate (confirm dialog, per-row spinner) · "Invoice Registry" cards ·
//  detail sheet with payment-status change (VOID confirm-guarded), Regenerate
//  (confirm-guarded, web message verbatim) + native ShareLink on the public
//  /invoice/share/alma-<orderId> URL (the web's copy-link target).
//  PDF PREVIEW stays web — small per-row "PDF" links open the share page in the web view.
//  Carried lessons: ONE spinner per row, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum InvoicePalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web row chip: PAID tone-green · PARTIAL tone-amber · UNPAID muted · VOID red.
    static func payment(_ s: String?) -> Color {
        switch s {
        case "PAID": return emerald600
        case "PARTIAL": return amber600
        case "VOID": return red500
        default: return .secondary
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web InvoiceRegistryRecord declares)

struct InvoiceRecord: Decodable, Identifiable, Equatable {
    let id: String
    let invoiceNumber: String
    let orderId: String
    let customerName: String?
    let customerPhone: String?
    let businessId: String?
    let amount: Int?
    var paymentStatus: String
    let driveUrl: String?
    let fileUrl: String?
    let shareUrl: String?
    let fileName: String?
    let generatedByName: String?
    let createdAt: String?
    let updatedAt: String?
    let events: [InvoiceEvent]

    struct InvoiceEvent: Decodable, Identifiable, Equatable {
        let id: String
        let type: String?
        let actorName: String?
        let note: String?
        let createdAt: String?

        private enum Keys: String, CodingKey { case id, type, actorName, note, createdAt }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
            type = try? c.decodeIfPresent(String.self, forKey: .type)
            actorName = try? c.decodeIfPresent(String.self, forKey: .actorName)
            note = try? c.decodeIfPresent(String.self, forKey: .note)
            createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        }
    }

    private enum Keys: String, CodingKey {
        case id, invoiceNumber, orderId, customerName, customerPhone, businessId, amount
        case paymentStatus, driveUrl, fileUrl, shareUrl, fileName, generatedByName
        case createdAt, updatedAt, events
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        invoiceNumber = (try? c.decode(String.self, forKey: .invoiceNumber)) ?? "—"
        orderId = (try? c.decode(String.self, forKey: .orderId)) ?? ""
        customerName = try? c.decodeIfPresent(String.self, forKey: .customerName)
        customerPhone = try? c.decodeIfPresent(String.self, forKey: .customerPhone)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        amount = Self.flexInt(c, .amount)
        paymentStatus = (try? c.decode(String.self, forKey: .paymentStatus)) ?? "UNPAID"
        driveUrl = try? c.decodeIfPresent(String.self, forKey: .driveUrl)
        fileUrl = try? c.decodeIfPresent(String.self, forKey: .fileUrl)
        shareUrl = try? c.decodeIfPresent(String.self, forKey: .shareUrl)
        fileName = try? c.decodeIfPresent(String.self, forKey: .fileName)
        generatedByName = try? c.decodeIfPresent(String.self, forKey: .generatedByName)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
        events = (try? c.decodeIfPresent([InvoiceEvent].self, forKey: .events)) ?? []
    }

    /// Prisma serializes the Decimal `amount` as a number OR a string ("12500.00") —
    /// decode all three shapes into whole taka.
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k), let d = Double(s) { return Int(d.rounded()) }
        return nil
    }

    /// The web's internalInvoiceUrl → /invoice/share/alma-<encodeURIComponent(orderId)>.
    var sharePath: String { "/invoice/share/alma-\(InvoiceFormat.uriComponent(orderId))" }
    /// Absolute public share URL — what the web's Share button copies to the clipboard.
    var publicShareURL: URL? { URL(string: AlmaAPI.baseURL.absoluteString + sharePath) }

    static func == (a: InvoiceRecord, b: InvoiceRecord) -> Bool {
        a.id == b.id && a.paymentStatus == b.paymentStatus
    }
}

struct InvoiceTotals: Decodable, Equatable {
    let count: Int
    let amount: Int
    let paid: Int
    let unpaid: Int

    private enum Keys: String, CodingKey { case count, amount, paid, unpaid }
    init() { count = 0; amount = 0; paid = 0; unpaid = 0 }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        count = Self.flexInt(c, .count) ?? 0
        amount = Self.flexInt(c, .amount) ?? 0
        paid = Self.flexInt(c, .paid) ?? 0
        unpaid = Self.flexInt(c, .unpaid) ?? 0
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k), let d = Double(s) { return Int(d.rounded()) }
        return nil
    }
}

/// GET /api/invoice answers flat `{ ok, invoices, totals }` — decode leniently
/// (and tolerate an apiDataSuccess-style `{ ok, data: {…} }` wrap, like approvals).
struct InvoicesListResponse: Decodable {
    let invoices: [InvoiceRecord]
    let totals: InvoiceTotals

    private enum Keys: String, CodingKey { case ok, data, invoices, totals }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        invoices = (try? c.decode([InvoiceRecord].self, forKey: .invoices)) ?? []
        totals = (try? c.decode(InvoiceTotals.self, forKey: .totals)) ?? InvoiceTotals()
    }
}

/// PATCH /api/invoice answers `{ ok, invoice }` with the updated record.
struct InvoicePatchResponse: Decodable {
    let invoice: InvoiceRecord?
    private enum Keys: String, CodingKey { case ok, data, invoice }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        invoice = try? c.decodeIfPresent(InvoiceRecord.self, forKey: .invoice)
    }
}

/// POST /api/invoice (generate / regenerate) answers flat snake_case fields —
/// the same shape the web's api.mutations.generateInvoice consumes.
struct InvoiceGenerateResponse: Decodable {
    let ok: Bool
    let invoiceNumber: String?
    let duplicate: Bool
    let driveSync: String?
    let errorMessage: String?

    private enum Keys: String, CodingKey {
        case ok, error, duplicate
        case invoiceNumber = "invoice_number"
        case driveSync = "drive_sync"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        invoiceNumber = try? c.decodeIfPresent(String.self, forKey: .invoiceNumber)
        duplicate = (try? c.decodeIfPresent(Bool.self, forKey: .duplicate)) ?? false
        driveSync = try? c.decodeIfPresent(String.self, forKey: .driveSync)
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// Slim delivered-order row — only the fields the web page uses to compute
/// "Pending Invoices" (delivered orders without a registry record / invoice_num).
struct InvoiceOrderLite: Decodable, Identifiable, Equatable {
    let id: String
    let date: String?
    let customer: String?
    let product: String?
    let sellPrice: Int?
    let invoiceNum: String?

    private enum Keys: String, CodingKey {
        case id, date, customer, product
        case sellPrice = "sell_price"
        case invoiceNum = "invoice_num"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        customer = try? c.decodeIfPresent(String.self, forKey: .customer)
        product = try? c.decodeIfPresent(String.self, forKey: .product)
        sellPrice = Self.flexInt(c, .sellPrice)
        invoiceNum = try? c.decodeIfPresent(String.self, forKey: .invoiceNum)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k), let d = Double(s) { return Int(d.rounded()) }
        return nil
    }
}

struct InvoiceOrdersResponse: Decodable {
    let orders: [InvoiceOrderLite]
    private enum Keys: String, CodingKey { case ok, data, orders }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        orders = (try? c.decode([InvoiceOrderLite].self, forKey: .orders)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
@MainActor
final class InvoicesVM {
    var invoices: [InvoiceRecord] = []
    var totals = InvoiceTotals()
    var deliveredOrders: [InvoiceOrderLite] = []
    var statusFilter = ""                 // "" (all) | UNPAID | PARTIAL | PAID | VOID
    var search = ""
    var loading = false
    var busyIds: Set<String> = []         // per-row spinners, never a global one
    var busyOrderIds: Set<String> = []    // generate/regenerate in-flight, keyed by order id
    var error: String? = nil
    var notice: String? = nil             // success line (the web's toast)
    var authExpired = false

    /// Web parity: delivered orders with no registry record and no legacy
    /// invoice_num — the "Pending Invoices" amber section + KPI.
    var pendingOrders: [InvoiceOrderLite] {
        let invoiced = Set(invoices.map { $0.orderId })
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return deliveredOrders.filter { o in
            guard !invoiced.contains(o.id), (o.invoiceNum ?? "").isEmpty else { return false }
            guard !q.isEmpty else { return true }
            return [o.id, o.customer ?? "", o.product ?? ""].contains { $0.lowercased().contains(q) }
        }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
            let resp: InvoicesListResponse = try await AlmaAPI.shared.get(
                "/api/invoice",
                query: [
                    "business_id": "ALMA_LIFESTYLE",
                    "search": trimmed.isEmpty ? nil : trimmed,
                    "payment_status": statusFilter.isEmpty ? nil : statusFilter,
                ])
            invoices = resp.invoices
            totals = resp.totals
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
            return
        }
        await loadDeliveredOrders()
    }

    /// KPI/pending support only — a failure here must never blank the registry.
    private func loadDeliveredOrders() async {
        do {
            let resp: InvoiceOrdersResponse = try await AlmaAPI.shared.get(
                "/api/orders/orders",
                query: ["business_id": "ALMA_LIFESTYLE", "status": "Delivered"])
            deliveredOrders = resp.orders
        } catch {
            // Silent: the registry list is the page's core; KPIs just show 0.
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// The web's generateInvoice mutation verbatim:
    /// POST /api/invoice { id, allow_regenerate, business_id } — generate for a pending
    /// delivered order (allowRegenerate=false) or regenerate an existing record (true).
    func generate(orderId: String, allowRegenerate: Bool) async {
        guard !busyOrderIds.contains(orderId) else { return }
        busyOrderIds.insert(orderId)
        notice = nil
        error = nil
        defer { busyOrderIds.remove(orderId) }
        do {
            let resp: InvoiceGenerateResponse = try await AlmaAPI.shared.send(
                "POST", "/api/invoice",
                body: [
                    "id": AnyEncodable(orderId),
                    "allow_regenerate": AnyEncodable(allowRegenerate),
                    "business_id": AnyEncodable("ALMA_LIFESTYLE"),
                ])
            guard resp.ok else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                self.error = resp.errorMessage ?? "Invoice generation failed"
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            let number = resp.invoiceNumber ?? ""
            // Web toast strings verbatim.
            if allowRegenerate {
                notice = "Regenerated \(number.isEmpty ? orderId : number)"
            } else if resp.duplicate {
                notice = "Invoice already exists: \(number)"
            } else if resp.driveSync == "pending" {
                notice = "Invoice \(number) ready — Google Drive upload finishing in background"
            } else {
                notice = "Saved invoice: \(number)"
            }
            await load()
        } catch {
            // The native URLSession caps requests at 20s while PDF + Drive can take
            // longer (the web waits 75s) — a timeout usually means the server is still
            // finishing, so refresh instead of scaring the owner with an error.
            if Self.isTimeout(error) {
                notice = "Invoice generation is still running on the server — pull to refresh in a moment."
                await load()
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                self.error = Self.serverMessage(error)
            }
        }
    }

    static func isTimeout(_ error: Error) -> Bool {
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .timedOut { return true }
        return (error as? URLError)?.code == .timedOut
    }

    /// Prefer the API's own { error } message over the raw HTTP dump.
    static func serverMessage(_ error: Error) -> String {
        if case AlmaAPIError.http(_, let body) = error,
           let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String, !msg.isEmpty {
            return msg
        }
        return (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
    }

    /// Same PATCH body the web sends: { id, payment_status }; optimistic, reverts on error.
    func setPayment(_ invoice: InvoiceRecord, to status: String) async {
        guard invoice.paymentStatus != status, !busyIds.contains(invoice.id) else { return }
        busyIds.insert(invoice.id)
        notice = nil
        let previous = invoice.paymentStatus
        replaceStatus(invoice.id, with: status)
        defer { busyIds.remove(invoice.id) }
        do {
            let resp: InvoicePatchResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/invoice",
                body: ["id": invoice.id, "payment_status": status])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            if let updated = resp.invoice {
                withAnimation(.snappy) {
                    if let idx = invoices.firstIndex(where: { $0.id == updated.id }) {
                        invoices[idx] = updated
                    }
                }
            }
            notice = "Invoice status updated"        // web toast verbatim
            await load()                              // refresh totals, keep numbers honest
        } catch {
            replaceStatus(invoice.id, with: previous)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.serverMessage(error)
        }
    }

    private func replaceStatus(_ id: String, with status: String) {
        guard let idx = invoices.firstIndex(where: { $0.id == id }) else { return }
        withAnimation(.snappy) { invoices[idx].paymentStatus = status }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct InvoicesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = InvoicesVM()
    @State private var selected: InvoiceRecord? = nil
    @FocusState private var searchFocused: Bool
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                kpiStrip
                searchField
                statusChips
                if vm.loading && vm.invoices.isEmpty { loadingRows }
                pendingSection
                registrySection
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(InvoicesAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { inv in
            InvoiceDetailSheet(invoice: inv, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI board — bento language (owner spec 2026-07-08): dark hero anchor from the
    //    registry totals (amount count-up + paid/unpaid split + paid-share mini bar),
    //    then the web's three counts (Delivered/Invoiced/Pending) as glass tiles.
    //    Same numbers, same tints — presentation only. ──

    private var kpiStrip: some View {
        VStack(spacing: 10) {
            InvBentoHeroCard(amount: vm.totals.amount,
                             count: vm.totals.count,
                             paid: vm.totals.paid,
                             unpaid: vm.totals.unpaid)
            HStack(spacing: 10) {
                InvBentoStatTile(label: "Delivered", value: vm.deliveredOrders.count,
                                 sub: "ডেলিভারড অর্ডার",
                                 tint: .primary, accent: AlmaSwiftTheme.sage)
                InvBentoStatTile(label: "Invoiced", value: vm.totals.count,
                                 sub: "রেজিস্ট্রিতে আছে",
                                 tint: InvoicePalette.emerald600, accent: InvoicePalette.green400)
                InvBentoStatTile(label: "Pending", value: vm.pendingOrders.count,
                                 sub: "ইনভয়েস বাকি",
                                 tint: InvoicePalette.amber600, accent: InvoicePalette.amber500)
            }
        }
        .padding(.top, 4)
    }

    // ── Search (web SearchInput parity — server-side search param) ──

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
            TextField("Search invoices, orders, customers…", text: $vm.search)
                .font(.footnote)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { Task { await vm.load() } }
            if !vm.search.isEmpty {
                Button {
                    vm.search = ""
                    Task { await vm.load() }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Payment-status filter — the web's Select options as capsule chips.
    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chipButton("All", value: "")
                chipButton("Unpaid", value: "UNPAID")
                chipButton("Partial", value: "PARTIAL")
                chipButton("Paid", value: "PAID")
                chipButton("Void", value: "VOID")
            }
            .padding(.horizontal, 2)
        }
    }

    private func chipButton(_ label: String, value: String) -> some View {
        invoiceChip(label, active: vm.statusFilter == value) {
            vm.statusFilter = value
            Task { await vm.load() }
        }
    }

    // ── Pending Invoices (web amber section — native Generate, PDF preview stays web) ──

    @ViewBuilder private var pendingSection: some View {
        if !vm.pendingOrders.isEmpty && vm.statusFilter.isEmpty {
            sectionHeader("Pending Invoices", tint: InvoicePalette.amber600)
            ForEach(vm.pendingOrders) { order in
                InvoicePendingCard(
                    order: order,
                    busy: vm.busyOrderIds.contains(order.id),
                    onGenerate: { Task { await vm.generate(orderId: order.id, allowRegenerate: false) } },
                    onWebPreview: { openWeb("/invoice", "Invoices") })
            }
        }
    }

    // ── Invoice Registry ──

    @ViewBuilder private var registrySection: some View {
        sectionHeader("Invoice Registry", tint: InvoicePalette.emerald600)
        ForEach(vm.invoices) { inv in
            InvoiceCard(invoice: inv,
                        busy: vm.busyIds.contains(inv.id) || vm.busyOrderIds.contains(inv.orderId),
                        onOpenPDF: { openWeb(inv.sharePath, inv.invoiceNumber) }) {
                selected = inv
            }
        }
        if !vm.loading && vm.invoices.isEmpty && vm.error == nil && !vm.authExpired {
            emptyState
        }
    }

    private func sectionHeader(_ title: String, tint: Color) -> some View {
        Text(title.uppercased())
            .font(.caption2.weight(.bold))
            .kerning(1.2)
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("◈").font(.largeTitle).foregroundStyle(.secondary)
            Text("No invoice records").font(.subheadline.weight(.semibold))
            Text("ইনভয়েস তৈরি করলে এখানে স্থায়ী রেকর্ড দেখা যাবে।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 40)
        .padding(.bottom, 20)
    }

    // ── Shared bits ──

    private func invoiceChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? InvoicePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? InvoicePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? InvoicePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", InvoicePalette.red500)
        case .success: ("checkmark.circle", InvoicePalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .invoicesShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/invoice", "Invoices")
        } label: {
            Text("ওয়েব ভার্সন")
                .font(.caption2)
                .underline()
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Registry row card (mirrors one web registry Card)

@available(iOS 17.0, *)
private struct InvoiceCard: View {
    let invoice: InvoiceRecord
    let busy: Bool
    let onOpenPDF: () -> Void
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(invoice.invoiceNumber)
                    .font(.footnote.monospaced().weight(.bold))
                    .foregroundStyle(InvoicePalette.emerald600)
                Text("Order \(invoice.orderId)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(InvoicePalette.accentText(colorScheme))
                    .lineLimit(1)
                Spacer(minLength: 4)
                paymentChip
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(invoice.customerName ?? "—")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text("\(invoice.generatedByName ?? "System") · \(InvoiceFormat.dateTime16(invoice.createdAt))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(InvoiceFormat.taka(invoice.amount))
                    .font(.callout.weight(.bold).monospacedDigit())
            }

            if let last = invoice.events.first {
                Text("Last: \((last.type ?? "—").replacingOccurrences(of: "_", with: " ")) · \(InvoiceFormat.day10(last.createdAt))")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            HStack(spacing: 6) {
                if busy {
                    ProgressView().controlSize(.mini)
                    Text("Updating…").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                Spacer()
                // PDF preview stays on the web — small per-row link to the share page.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    onOpenPDF()
                } label: {
                    Label("PDF", systemImage: "doc.richtext")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .buttonStyle(.plain)
                if let url = invoice.publicShareURL {
                    ShareLink(item: url) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(InvoicePalette.accentText(colorScheme))
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(InvoicePalette.coral.opacity(0.13), in: Capsule())
                            .overlay(Capsule().strokeBorder(InvoicePalette.coral.opacity(0.35), lineWidth: 1))
                    }
                }
            }
        }
        .padding(14)
        // Payment-tone wash: the row's glass carries a soft diagonal tint of its own
        // payment status (PAID green / PARTIAL amber / VOID red / UNPAID neutral).
        .background { invBentoWash(InvoicePalette.payment(invoice.paymentStatus), scheme: colorScheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.10 : 0.45), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    private var paymentChip: some View {
        let tint = InvoicePalette.payment(invoice.paymentStatus)
        return Text(invoice.paymentStatus)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Pending order card (web amber "Pending Invoices" row — native Generate)

@available(iOS 17.0, *)
private struct InvoicePendingCard: View {
    let order: InvoiceOrderLite
    let busy: Bool
    let onGenerate: () -> Void
    let onWebPreview: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmGenerate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(order.id)
                        .font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(InvoicePalette.accentText(colorScheme))
                    Text(order.customer ?? "—")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(order.product ?? "—")
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(InvoiceFormat.taka(order.sellPrice))
                        .font(.callout.weight(.bold).monospacedDigit())
                    Text(order.date ?? "")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                // The web's generate POST, native — confirm first, per-row spinner.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    confirmGenerate = true
                } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.mini) }
                        Text(busy ? "Generating…" : "ইনভয়েস তৈরি করুন")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(InvoicePalette.amber600)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(InvoicePalette.amber500.opacity(0.14), in: Capsule())
                    .overlay(Capsule().strokeBorder(InvoicePalette.amber500.opacity(0.4), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .confirmationDialog(
                    "Order \(order.id) — ইনভয়েস তৈরি করবেন?",
                    isPresented: $confirmGenerate, titleVisibility: .visible
                ) {
                    Button("ইনভয়েস তৈরি করুন") { onGenerate() }
                    Button("বাতিল", role: .cancel) {}
                }
                Spacer()
                // PDF preview is a web-only flow (React-PDF + branding) — small link.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    onWebPreview()
                } label: {
                    Text("PDF প্রিভিউ — ওয়েব ভার্সন")
                        .font(.caption2)
                        .underline()
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(InvoicePalette.amber500.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Detail sheet

@available(iOS 17.0, *)
private struct InvoiceDetailSheet: View {
    let invoice: InvoiceRecord
    let vm: InvoicesVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmVoid = false
    @State private var confirmRegenerate = false

    /// Live copy — payment changes made in the sheet reflect immediately.
    private var current: InvoiceRecord {
        vm.invoices.first { $0.id == invoice.id } ?? invoice
    }
    private var busy: Bool { vm.busyIds.contains(invoice.id) }
    private var busyGen: Bool { vm.busyOrderIds.contains(invoice.orderId) }
    /// Web parity: Regenerate only offered while the delivered order still exists.
    private var hasOrder: Bool { vm.deliveredOrders.contains { $0.id == invoice.orderId } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let ok = vm.notice {
                    Label(ok, systemImage: "checkmark.circle")
                        .font(.footnote).foregroundStyle(InvoicePalette.emerald600)
                }
                if let err = vm.error {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(InvoicePalette.red500)
                }
                infoRows
                paymentPicker
                if !current.events.isEmpty { eventsCard }
                shareActions
                regenerateSection
                webLink
            }
            .padding(18)
        }
        .presentationBackground { InvoicesAurora() }
    }

    /// The web's per-row Regenerate button (danger) — confirm message verbatim.
    @ViewBuilder private var regenerateSection: some View {
        if hasOrder {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                confirmRegenerate = true
            } label: {
                HStack(spacing: 6) {
                    if busyGen { ProgressView().controlSize(.small) }
                    Label(busyGen ? "Regenerating…" : "Regenerate", systemImage: "arrow.clockwise")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.bordered)
            .tint(InvoicePalette.red500)
            .disabled(busyGen)
            .confirmationDialog(
                "Regenerate invoice for order \(current.orderId)? The existing registry record will be updated and the event will be audited.",
                isPresented: $confirmRegenerate, titleVisibility: .visible
            ) {
                Button("Regenerate", role: .destructive) {
                    Task { await vm.generate(orderId: current.orderId, allowRegenerate: true) }
                }
                Button("বাতিল", role: .cancel) {}
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(current.invoiceNumber)
                    .font(.headline.monospaced())
                let tint = InvoicePalette.payment(current.paymentStatus)
                Text(current.paymentStatus)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(tint.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
            }
            Text("Order \(current.orderId) · \(InvoiceFormat.dateTime16(current.createdAt))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Customer", current.customerName ?? "—")
            if let phone = current.customerPhone, !phone.isEmpty {
                infoRow("Phone", phone)
            }
            infoRow("Amount", InvoiceFormat.taka(current.amount))
            infoRow("Business", current.businessId ?? "—")
            infoRow("Generated by", current.generatedByName ?? "System")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold))
        }
    }

    /// The web's payment-status Select as tinted capsules (PATCH /api/invoice).
    private var paymentPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PAYMENT STATUS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach(["UNPAID", "PARTIAL", "PAID", "VOID"], id: \.self) { s in
                    statusOption(s)
                }
            }
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Updating…").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        .confirmationDialog(
            "\(current.invoiceNumber) — ইনভয়েসটি VOID করবেন?",
            isPresented: $confirmVoid, titleVisibility: .visible
        ) {
            Button("VOID করুন", role: .destructive) {
                Task { await vm.setPayment(current, to: "VOID") }
            }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func statusOption(_ status: String) -> some View {
        let active = current.paymentStatus == status
        let tint = InvoicePalette.payment(status)
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            // Voiding is destructive — confirm first (web offers it raw in a Select).
            if status == "VOID", current.paymentStatus != "VOID" {
                confirmVoid = true
            } else {
                Task { await vm.setPayment(current, to: status) }
            }
        } label: {
            Text(status.capitalized)
                .font(.caption2.weight(active ? .bold : .semibold))
                .foregroundStyle(active ? tint : .secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(tint.opacity(active ? 0.16 : 0.0), in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? tint.opacity(0.5) : Color.white.opacity(colorScheme == .dark ? 0.12 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var eventsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HISTORY").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            ForEach(current.events) { e in
                VStack(alignment: .leading, spacing: 1) {
                    HStack {
                        Text((e.type ?? "—").replacingOccurrences(of: "_", with: " "))
                            .font(.caption.weight(.semibold))
                        Spacer()
                        Text(InvoiceFormat.day10(e.createdAt))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let actor = e.actorName, !actor.isEmpty {
                        Text(actor).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let note = e.note, !note.isEmpty {
                        Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .invoicesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Native ShareLink on the same public URL the web's Share button copies,
    /// plus a copy-to-clipboard twin ("Invoice link copied" — web toast verbatim).
    @ViewBuilder private var shareActions: some View {
        if let url = current.publicShareURL {
            HStack(spacing: 10) {
                ShareLink(item: url) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(InvoicePalette.coral)
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    vm.notice = "Invoice link copied"
                } label: {
                    Label("লিংক কপি", systemImage: "doc.on.doc")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .tint(InvoicePalette.coral)
            }
        }
    }

    private var webLink: some View {
        VStack(spacing: 4) {
            Button {
                dismiss()
                openWeb(current.sharePath, current.invoiceNumber)
            } label: {
                Label("ইনভয়েস দেখুন (PDF)", systemImage: "doc.richtext")
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.top, 2)
            Button {
                dismiss()
                openWeb("/invoice", "Invoices")
            } label: {
                Text("ওয়েব ভার্সন")
                    .font(.caption2)
                    .underline()
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.top, 6)
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum InvoiceFormat {
    /// Whole-taka BDT — web: `৳ Number(amount).toLocaleString('en-BD')`.
    static func taka(_ amount: Int?) -> String {
        "৳\((amount ?? 0).formatted())"
    }

    /// Web: String(createdAt).slice(0, 16).replace('T', ' ') → "2026-07-01 10:22".
    static func dateTime16(_ iso: String?) -> String {
        guard let iso, !iso.isEmpty else { return "—" }
        return String(iso.prefix(16)).replacingOccurrences(of: "T", with: " ")
    }

    /// Web: String(createdAt).slice(0, 10) → "2026-07-01".
    static func day10(_ iso: String?) -> String {
        guard let iso, !iso.isEmpty else { return "—" }
        return String(iso.prefix(10))
    }

    /// encodeURIComponent parity for the share slug (order ids are simple, but stay exact).
    static func uriComponent(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

// MARK: - Aurora background + glass (Invoices-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct InvoicesAurora: View {
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
    func invoicesGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct InvoicesShimmer: ViewModifier {
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
    func invoicesShimmer() -> some View { modifier(InvoicesShimmer()) }
}

// MARK: - Bento components (Invoices-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups and bar sweeps freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func invMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct InvCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        InvCountUpText(value: shown, format: format)
            .animation(invMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if invMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct InvCountUpText: View, Animatable {
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
private func invBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
private struct InvBentoStatTile: View {
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
            InvCountUp(target: value, format: { "\($0)" })
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { invBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// Paid-share mini bar — sweeps to its fraction on appear, frozen when motion is limited.
@available(iOS 17.0, *)
private struct InvMiniBar: View {
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
            if invMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.6, bounce: 0.18)) { grow = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { grow = true }
            }
        }
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Registry totals: invoiced
/// amount count-up + Paid/Unpaid split + a paid-share mini bar. Money via the file's
/// own InvoiceFormat.taka — the exact strings the old cards would show.
@available(iOS 17.0, *)
private struct InvBentoHeroCard: View {
    let amount: Int
    let count: Int
    let paid: Int
    let unpaid: Int

    // paid/unpaid are invoice COUNTS from the registry (route counts .length),
    // amount alone is money — share must be count/count, S8 audit fix.
    private var paidShare: CGFloat {
        count > 0 ? CGFloat(paid) / CGFloat(count) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("মোট ইনভয়েস · INVOICED").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(InvoicePalette.goldLt)
            InvCountUp(target: amount, format: { InvoiceFormat.taka($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.5)
                .padding(.top, 8)
            Text("\(count)টি ইনভয়েস রেজিস্ট্রিতে")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Paid", value: paid,
                         tint: InvoicePalette.green400, sub: "পরিশোধিত")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Unpaid", value: unpaid,
                         tint: unpaid > 0 ? InvoicePalette.amber500 : .white, sub: "বাকি")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)

            InvMiniBar(fraction: paidShare, color: InvoicePalette.green400)
                .padding(.top, 12)
            Text("পেইড শেয়ার \(Int((paidShare * 100).rounded()))%")
                .font(.system(size: 9)).foregroundStyle(.white.opacity(0.5)).padding(.top, 4)
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

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            InvCountUp(target: value, format: { "\($0)টি" })
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Invoices — Light") {
    InvoicesScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
