//
//  DigitalClientsSwiftUI.swift
//  ALMA ERP — the CDIT Client CRM as a native SwiftUI screen (web /digital/clients parity).
//
//  Mirrors the web /digital/clients (list) + /digital/clients/[id] (detail) pages:
//    GET /api/digital/clients?business_id=CREATIVE_DIGITAL_IT&search=…  → { clients, total }
//    GET /api/digital/clients/{id}?business_id=CREATIVE_DIGITAL_IT     → { client, summary,
//                                                     projects, invoices, payments, timeline }
//  Web-parity blocks — list: debounced search + contact-style rows (name, company ·
//  service, phone · email, id, notes preview). Detail (sheet): billing summary
//  (status badge + payment progress bar + value/paid/due rows) · contact card ·
//  projects with per-project payment progress · payment history table.
//  NATIVE WRITES (verified 2026-07-17): client create + payment record (POST via
//  /api/digital/clients paths). STILL WEB (parity ledger OP-08, phase NP-7):
//  contextual "create project from client detail" prefill.
//  CDIT accent: blue (0.42, 0.56, 0.88) hero accent.
//  Carried lessons: lenient row decoding, ONE spinner pattern, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from tailwind tokens + CDIT accent)

private enum DigitalClientsPalette {
    /// CDIT accent blue — the hero accent for the digital-agency business.
    static let cditBlue = Color(red: 0.42, green: 0.56, blue: 0.88)
    static let blue400 = Color(red: 0.376, green: 0.647, blue: 0.980)         // #60A5FA
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)      // #059669
    static let emerald400 = Color(red: 0.204, green: 0.827, blue: 0.600)      // #34D399
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)        // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)        // #F59E0B
    static let amber400 = Color(red: 0.984, green: 0.749, blue: 0.141)        // #FBBF24
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)          // #EF4444
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)        // #94A3B8
    static let zinc500 = Color(red: 0.443, green: 0.443, blue: 0.478)         // #71717A

    /// Accent text that stays readable on cream (light) and over the aurora (dark).
    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? blue400 : cditBlue
    }

    /// Web PaymentProgress STATUS_COLOR: Unpaid zinc · Partial Paid amber · Paid emerald.
    static func payStatus(_ status: String?, _ scheme: ColorScheme) -> Color {
        switch status {
        case "Paid": return scheme == .dark ? emerald400 : emerald600
        case "Partial Paid": return scheme == .dark ? amber400 : amber600
        default: return scheme == .dark ? slate400 : zinc500   // Unpaid / unknown
        }
    }

    /// FinanceSummaryRow highlights: gold→CDIT accent · green emerald · amber.
    static func highlight(_ kind: String, _ scheme: ColorScheme) -> Color {
        switch kind {
        case "green": return scheme == .dark ? emerald400 : emerald600
        case "amber": return scheme == .dark ? amber400 : amber600
        case "red": return red500
        default: return accent(scheme)     // "gold" on the web = brand accent here
        }
    }
}

// MARK: - Models (same snake_case wire fields the web CditClient types declare)

struct DigitalClientsClient: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let company: String?
    let phone: String?
    let email: String?
    let country: String?
    let serviceType: String?
    let leadSource: String?
    let notes: String?
    let tags: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, name, company, phone, email, country, notes, tags
        case serviceType = "service_type"
        case leadSource = "lead_source"
        case createdAt = "created_at"
    }

    /// Sheet-backfilled rows carry mixed types — decode defensively so ONE bad
    /// row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = DigitalClientsJSON.flexString(c, .name) ?? "—"
        let rawId = DigitalClientsJSON.flexString(c, .id)
        phone = DigitalClientsJSON.flexString(c, .phone)
        id = rawId ?? "\(name)-\(phone ?? "")"
        company = DigitalClientsJSON.flexString(c, .company)
        email = DigitalClientsJSON.flexString(c, .email)
        country = DigitalClientsJSON.flexString(c, .country)
        serviceType = DigitalClientsJSON.flexString(c, .serviceType)
        leadSource = DigitalClientsJSON.flexString(c, .leadSource)
        notes = DigitalClientsJSON.flexString(c, .notes)
        tags = DigitalClientsJSON.flexString(c, .tags)
        createdAt = DigitalClientsJSON.flexString(c, .createdAt)
    }

    static func == (a: DigitalClientsClient, b: DigitalClientsClient) -> Bool { a.id == b.id }
}

/// Web CditFinanceFields — shared by the client summary and each project.
struct DigitalClientsFinance: Decodable, Equatable {
    let totalAmount: Int
    let totalPaid: Int
    let dueAmount: Int
    let paymentPercentage: Double
    let paymentStatus: String

    private enum Keys: String, CodingKey {
        case totalAmount = "total_amount"
        case totalPaid = "total_paid"
        case dueAmount = "due_amount"
        case paymentPercentage = "payment_percentage"
        case paymentStatus = "payment_status"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalAmount = DigitalClientsJSON.flexInt(c, .totalAmount) ?? 0
        totalPaid = DigitalClientsJSON.flexInt(c, .totalPaid) ?? 0
        dueAmount = DigitalClientsJSON.flexInt(c, .dueAmount) ?? 0
        paymentPercentage = DigitalClientsJSON.flexDouble(c, .paymentPercentage) ?? 0
        paymentStatus = DigitalClientsJSON.flexString(c, .paymentStatus) ?? "Unpaid"
    }
}

struct DigitalClientsProject: Decodable, Identifiable, Equatable {
    let id: String
    let projectName: String
    let status: String?
    let serviceType: String?
    let deadline: String?
    let totalAmount: Int
    let totalPaid: Int
    let dueAmount: Int
    let paymentPercentage: Double
    let paymentStatus: String

    private enum Keys: String, CodingKey {
        case id, title, status, deadline
        case projectName = "project_name"
        case serviceType = "service_type"
        case totalAmount = "total_amount"
        case totalPaid = "total_paid"
        case dueAmount = "due_amount"
        case paymentPercentage = "payment_percentage"
        case paymentStatus = "payment_status"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawId = DigitalClientsJSON.flexString(c, .id)
        // Web renders `project_name || title` — same fallback chain here.
        let name = DigitalClientsJSON.flexString(c, .projectName)
            ?? DigitalClientsJSON.flexString(c, .title) ?? "—"
        projectName = name
        id = rawId ?? name
        status = DigitalClientsJSON.flexString(c, .status)
        serviceType = DigitalClientsJSON.flexString(c, .serviceType)
        deadline = DigitalClientsJSON.flexString(c, .deadline)
        totalAmount = DigitalClientsJSON.flexInt(c, .totalAmount) ?? 0
        totalPaid = DigitalClientsJSON.flexInt(c, .totalPaid) ?? 0
        dueAmount = DigitalClientsJSON.flexInt(c, .dueAmount) ?? 0
        paymentPercentage = DigitalClientsJSON.flexDouble(c, .paymentPercentage) ?? 0
        paymentStatus = DigitalClientsJSON.flexString(c, .paymentStatus) ?? "Unpaid"
    }

    static func == (a: DigitalClientsProject, b: DigitalClientsProject) -> Bool { a.id == b.id }
}

struct DigitalClientsPayment: Decodable, Identifiable, Equatable {
    let id: String
    let amount: Int
    let paymentMethod: String?
    let transactionId: String?
    let paymentDate: String?
    let note: String?

    private enum Keys: String, CodingKey {
        case id, amount, date, note, notes
        case paymentMethod = "payment_method"
        case transactionId = "transaction_id"
        case paymentDate = "payment_date"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        amount = DigitalClientsJSON.flexInt(c, .amount) ?? 0
        // Web renders `payment_date || date` and `transaction_id || note` — same here.
        paymentDate = DigitalClientsJSON.flexString(c, .paymentDate)
            ?? DigitalClientsJSON.flexString(c, .date)
        note = DigitalClientsJSON.flexString(c, .note)
            ?? DigitalClientsJSON.flexString(c, .notes)
        paymentMethod = DigitalClientsJSON.flexString(c, .paymentMethod)
        transactionId = DigitalClientsJSON.flexString(c, .transactionId)
        let rawId = DigitalClientsJSON.flexString(c, .id)
        id = rawId ?? "\(paymentDate ?? "")-\(amount)"
    }

    static func == (a: DigitalClientsPayment, b: DigitalClientsPayment) -> Bool { a.id == b.id }
}

/// GET /api/digital/clients answers flat `{ clients, total }`; tolerate an
/// apiDataSuccess `{ ok, data: {…} }` wrap too, like every other screen's decoder.
struct DigitalClientsListResponse: Decodable {
    let clients: [DigitalClientsClient]

    private enum Keys: String, CodingKey { case ok, data, clients }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        clients = (try? c.decode([DigitalClientsClient].self, forKey: .clients)) ?? []
    }
}

/// GET /api/digital/clients/{id} — CditClientDetail. Web uses `timeline ?? payments`
/// for the history table; the same fallback lives here.
struct DigitalClientsDetail: Decodable {
    let client: DigitalClientsClient?
    let summary: DigitalClientsFinance?
    let projects: [DigitalClientsProject]
    let history: [DigitalClientsPayment]

    private enum Keys: String, CodingKey { case ok, data, client, summary, projects, timeline, payments }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        client = try? c.decodeIfPresent(DigitalClientsClient.self, forKey: .client)
        summary = try? c.decodeIfPresent(DigitalClientsFinance.self, forKey: .summary)
        projects = (try? c.decodeIfPresent([DigitalClientsProject].self, forKey: .projects)) ?? []
        let timeline = (try? c.decodeIfPresent([DigitalClientsPayment].self, forKey: .timeline)) ?? []
        history = timeline.isEmpty
            ? ((try? c.decodeIfPresent([DigitalClientsPayment].self, forKey: .payments)) ?? [])
            : timeline
    }
}

/// Flexible scalar decoding — sheet-backed rows swap ints/strings freely.
enum DigitalClientsJSON {
    static func flexString<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s.isEmpty ? nil : s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return String(d) }
        return nil
    }
    static func flexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) ?? Double(s).map { Int($0.rounded()) } }
        return nil
    }
    static func flexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class DigitalClientsVM {
    var clients: [DigitalClientsClient] = []
    var search = ""
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Distinct service types across the loaded book — hero split stat.
    var serviceCount: Int {
        Set(clients.compactMap { $0.serviceType }).count
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: DigitalClientsListResponse = try await AlmaAPI.shared.get(
                "/api/digital/clients",
                query: ["business_id": "CREATIVE_DIGITAL_IT",
                        "search": search.isEmpty ? nil : search])
            clients = resp.clients
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

    /// Detail sheet payload — one call, same shape the web detail page consumes.
    func detail(id: String) async -> DigitalClientsDetail? {
        do {
            return try await AlmaAPI.shared.get(
                "/api/digital/clients/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)",
                query: ["business_id": "CREATIVE_DIGITAL_IT"])
        } catch {
            return nil
        }
    }

    // ── Native writes (owner 2026-07-11) — web page payloads verbatim. ──

    var toast: String? = nil

    struct ClientPayload: Encodable {
        let name: String, company: String, phone: String, email: String
        let country: String, service_type: String, lead_source: String
        let notes: String, tags: String
        let business_id = "CREATIVE_DIGITAL_IT"
    }
    struct PaymentPayload: Encodable {
        let invoice_id: String?
        let project_id: String?
        let client_id: String
        let client_name: String
        let amount: Int
        let payment_method: String
        let payment_type = "income"
        let business_id = "CREATIVE_DIGITAL_IT"
    }
    private struct WriteResponse: Decodable { let ok: Bool?, error: String? }

    func createClient(_ p: ClientPayload) async -> Bool {
        await write("/api/digital/clients", p, success: "Client সেভ হয়েছে")
    }
    func recordPayment(_ p: PaymentPayload) async -> Bool {
        await write("/api/digital/payments", p, success: "Payment রেকর্ড হয়েছে")
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
struct DigitalClientsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = DigitalClientsVM()
    @State private var selected: DigitalClientsClient? = nil
    @State private var searchDebounce: Task<Void, Never>? = nil
    @State private var showCreate = false
    let openWeb: (_ path: String, _ title: String) -> Void
    /// Deep-link target: /digital/clients/{id} opens this client's native detail
    /// sheet once the list loads (project rows used to escape to the web page).
    var focusClientId: String? = nil

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                heroCard
                addClientButton
                searchRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.clients.isEmpty { loadingRows }
                ForEach(vm.clients) { c in
                    DigitalClientsRow(client: c) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = c
                    }
                }
                if !vm.loading && vm.clients.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(DigitalClientsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            if let fid = focusClientId, selected == nil {
                selected = vm.clients.first { $0.id == fid }
            }
        }
        .sheet(item: $selected) { c in
            DigitalClientsDetailSheet(client: c, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCreate) { DigitalClientsCreateSheet(vm: vm) }
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

    /// Web header "+ Add Client" — native form sheet (owner 2026-07-11).
    private var addClientButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showCreate = true
        } label: {
            Label("+ Add Client", systemImage: "person.badge.plus")
                .font(.caption.weight(.bold))
                .foregroundStyle(DigitalClientsPalette.accent(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(DigitalClientsPalette.cditBlue.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(DigitalClientsPalette.cditBlue.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Hero anchor (bento language) — client count + service split, CDIT blue wash ──

    private var heroCard: some View {
        DigitalClientsHeroCard(clients: vm.clients.count, services: vm.serviceCount)
            .padding(.top, 4)
    }

    // ── Search (web SearchInput — server-side, debounced like the web deferred value) ──

    private var searchRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search clients…", text: Binding(
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
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(DigitalClientsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 72)
                .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .digitalClientsShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.crop.rectangle.stack").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো ক্লায়েন্ট পাওয়া যায়নি").foregroundStyle(.secondary)
            Text("ওয়েবে প্রথম এজেন্সি ক্লায়েন্ট যোগ করুন").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    /// Mutations (add client / project / payment) live on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/digital/clients", "CDIT clients")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row (web list row: name · company·service · phone·email · id · notes)

@available(iOS 17.0, *)
private struct DigitalClientsRow: View {
    let client: DigitalClientsClient
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                avatar
                VStack(alignment: .leading, spacing: 2) {
                    Text(client.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(client.company ?? "—") · \(client.serviceType ?? "—")")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Text(contactLine)
                        .font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                Text(client.id)
                    .font(.system(size: 10, weight: .semibold).monospaced())
                    .foregroundStyle(DigitalClientsPalette.accent(colorScheme))
            }
            if let n = client.notes, !n.isEmpty {
                Text(n).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    private var contactLine: String {
        var bits: [String] = []
        if let p = client.phone, !p.isEmpty { bits.append(p) }
        if let e = client.email, !e.isEmpty { bits.append(e) }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    /// Initials circle in the CDIT blue tint.
    private var avatar: some View {
        Text(DigitalClientsFormat.initials(client.name))
            .font(.caption.weight(.bold))
            .foregroundStyle(DigitalClientsPalette.accent(colorScheme))
            .frame(width: 36, height: 36)
            .background(DigitalClientsPalette.cditBlue.opacity(0.14), in: Circle())
            .overlay(Circle().strokeBorder(
                DigitalClientsPalette.cditBlue.opacity(0.32), lineWidth: 1))
    }
}

// MARK: - Detail sheet (web /digital/clients/[id] parity)

@available(iOS 17.0, *)
private struct DigitalClientsDetailSheet: View {
    let client: DigitalClientsClient
    let vm: DigitalClientsVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var detail: DigitalClientsDetail? = nil
    @State private var loading = true
    @State private var showPayment = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if loading {
                    HStack(spacing: 10) {
                        AlmaStarburstLoader(mode: .searching, size: 18)
                        Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                } else {
                    billingCard
                    recordPaymentButton
                    contactCard
                    projectsCard
                    historyCard
                }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { DigitalClientsAurora() }
        .task {
            detail = await vm.detail(id: client.id)
            loading = false
        }
        .sheet(isPresented: $showPayment) {
            DigitalClientsPaymentSheet(clientId: client.id, clientName: client.name, vm: vm) {
                Task { detail = await vm.detail(id: client.id) }
            }
        }
    }

    /// Web client-detail "Record payment" — native sheet (owner 2026-07-11).
    private var recordPaymentButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showPayment = true
        } label: {
            Label("Record payment", systemImage: "banknote")
                .font(.caption.weight(.bold))
                .foregroundStyle(colorScheme == .dark ? DigitalClientsPalette.emerald400
                                                      : DigitalClientsPalette.emerald600)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(DigitalClientsPalette.emerald600.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(DigitalClientsPalette.emerald600.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    /// Freshest client record — the detail payload when it lands, list row before.
    private var liveClient: DigitalClientsClient { detail?.client ?? client }

    private var header: some View {
        HStack(spacing: 12) {
            Text(DigitalClientsFormat.initials(liveClient.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(DigitalClientsPalette.accent(colorScheme))
                .frame(width: 44, height: 44)
                .background(DigitalClientsPalette.cditBlue.opacity(0.14), in: Circle())
                .overlay(Circle().strokeBorder(DigitalClientsPalette.cditBlue.opacity(0.32), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(liveClient.name).font(.headline)
                Text([liveClient.company, liveClient.id].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // ── Billing summary (web: status badge + progress bar + value/paid/due rows) ──

    @ViewBuilder private var billingCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("BILLING SUMMARY")
                    .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                Spacer()
                if let s = detail?.summary {
                    DigitalClientsStatusBadge(status: s.paymentStatus)
                }
            }
            if let s = detail?.summary {
                DigitalClientsProgressBar(percentage: s.paymentPercentage, status: s.paymentStatus)
                financeRow("Total project value", s.totalAmount, highlight: "gold")
                financeRow("Total paid", s.totalPaid, highlight: "green")
                financeRow("Due balance", s.dueAmount, highlight: s.dueAmount > 0 ? "amber" : "green")
            } else {
                Text("কোনো বিলিং ডেটা নেই").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func financeRow(_ label: String, _ value: Int, highlight: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text("৳\(value.formatted())")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(DigitalClientsPalette.highlight(highlight, colorScheme))
        }
        .padding(.vertical, 2)
    }

    // ── Contact (web: phone / email / service · country / notes) ──

    private var contactCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CONTACT")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            infoRow("Phone", liveClient.phone ?? "—")
            infoRow("Email", liveClient.email ?? "—")
            infoRow("Service", liveClient.serviceType ?? "—")
            infoRow("Country", liveClient.country ?? "—")
            if let src = liveClient.leadSource, !src.isEmpty {
                infoRow("Lead source", src)
            }
            if let n = liveClient.notes, !n.isEmpty {
                Text(n).font(.caption).foregroundStyle(.secondary).padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.semibold))
                .multilineTextAlignment(.trailing)
        }
    }

    // ── Projects (web: each with name, id · status, badge, progress, value/paid/due) ──

    @ViewBuilder private var projectsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PROJECTS")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if (detail?.projects ?? []).isEmpty {
                Text("কোনো প্রজেক্ট নেই — ওয়েবে কন্ট্রাক্ট ভ্যালুসহ প্রজেক্ট যোগ করুন")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(detail?.projects ?? []) { p in
                    projectTile(p)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func projectTile(_ p: DigitalClientsProject) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.projectName).font(.footnote.weight(.semibold)).lineLimit(2)
                    Text("\(p.id) · \(p.status ?? "—")")
                        .font(.system(size: 9).monospaced()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                DigitalClientsStatusBadge(status: p.paymentStatus)
            }
            DigitalClientsProgressBar(percentage: p.paymentPercentage, status: p.paymentStatus)
            HStack(spacing: 12) {
                projectMoney("Value", p.totalAmount, .secondary)
                projectMoney("Paid", p.totalPaid,
                             DigitalClientsPalette.highlight("green", colorScheme))
                projectMoney("Due", p.dueAmount,
                             DigitalClientsPalette.highlight("amber", colorScheme))
                Spacer(minLength: 0)
            }
        }
        .padding(11)
        .background(Color.primary.opacity(colorScheme == .dark ? 0.05 : 0.03),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(AlmaSwiftTheme.separator(colorScheme), lineWidth: 0.8))
    }

    private func projectMoney(_ label: String, _ value: Int, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text("৳\(value.formatted())")
                .font(.system(size: 11, weight: .bold).monospacedDigit())
                .foregroundStyle(tint)
        }
    }

    // ── Payment history (web table: ID / Date / Method / Reference / Amount) ──

    @ViewBuilder private var historyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PAYMENT HISTORY")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if (detail?.history ?? []).isEmpty {
                Text("এখনো কোনো পেমেন্ট নেই — অ্যাডভান্স/মাইলস্টোন পেমেন্ট ওয়েবে রেকর্ড করুন")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(detail?.history ?? []) { pay in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(pay.id).font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(DigitalClientsPalette.accent(colorScheme))
                            Text([pay.paymentDate, pay.paymentMethod].compactMap { $0 }
                                .joined(separator: " · "))
                                .font(.caption2).foregroundStyle(.secondary)
                            if let ref = pay.transactionId ?? pay.note, !ref.isEmpty {
                                Text(ref).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        Text("৳\(pay.amount.formatted())")
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(DigitalClientsPalette.highlight("green", colorScheme))
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalClientsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// + Payment / + Project stay on the web page (read-only native screen).
    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/digital/clients", "CDIT clients")
        } label: {
            Label("পেমেন্ট/প্রজেক্ট যোগ — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Payment progress bits (web PaymentProgress.tsx twins)

/// Web PaymentProgressBar: 8px track, status-tinted fill, clamped 0–100.
@available(iOS 17.0, *)
private struct DigitalClientsProgressBar: View {
    let percentage: Double
    let status: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let pct = min(100, max(0, percentage))
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.08))
                Capsule().fill(DigitalClientsPalette.payStatus(status, colorScheme))
                    .frame(width: geo.size.width * pct / 100)
            }
        }
        .frame(height: 8)
    }
}

/// Web PaymentStatusBadge: uppercase pill, status-tinted border + wash.
@available(iOS 17.0, *)
private struct DigitalClientsStatusBadge: View {
    let status: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let tint = DigitalClientsPalette.payStatus(status, colorScheme)
        Text(status.uppercased())
            .font(.system(size: 9, weight: .bold)).tracking(0.5)
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }
}

// MARK: - Formatting helpers

private enum DigitalClientsFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (page-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct DigitalClientsAurora: View {
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
    func digitalClientsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct DigitalClientsShimmer: ViewModifier {
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
    func digitalClientsShimmer() -> some View { modifier(DigitalClientsShimmer()) }
}

// MARK: - Bento components (page-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func digitalClientsMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct DigitalClientsCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        DigitalClientsCountUpText(value: shown, format: format)
            .animation(digitalClientsMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if digitalClientsMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct DigitalClientsCountUpText: View, Animatable {
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

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base, here washed with the CDIT blue instead of violet). Client-count
/// count-up plus the Clients / Services split — the web page's "N clients" subtitle
/// grown into the bento anchor.
@available(iOS 17.0, *)
private struct DigitalClientsHeroCard: View {
    let clients: Int
    let services: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ক্লায়েন্ট CRM · CDIT").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(DigitalClientsPalette.blue400)
            DigitalClientsCountUp(target: clients, format: { "\($0)" })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("এজেন্সির মোট ক্লায়েন্ট")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Clients", value: clients,
                         tint: .white, sub: "মোট ক্লায়েন্ট")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Services", value: services,
                         tint: DigitalClientsPalette.blue400, sub: "সার্ভিস টাইপ")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.082, green: 0.094, blue: 0.157))
                LinearGradient(colors: [DigitalClientsPalette.cditBlue.opacity(0.34), .clear],
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
            DigitalClientsCountUp(target: value, format: { "\($0)" })
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("CDIT Clients — Light") {
    DigitalClientsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Create client (owner 2026-07-11: native writes — web "New Client" card parity,
// POST /api/digital/clients with the exact same payload).

@available(iOS 17.0, *)
private struct DigitalClientsCreateSheet: View {
    let vm: DigitalClientsVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    // Web CDIT_SERVICES verbatim (src/types/cdit.ts).
    private static let services = ["Website Development", "Facebook Marketing", "SEO",
                                   "Branding", "Video Editing", "Graphics", "Monthly Retainer"]

    @State private var name = ""
    @State private var company = ""
    @State private var phone = ""
    @State private var email = ""
    @State private var country = "Bangladesh"
    @State private var leadSource = ""
    @State private var tags = ""
    @State private var serviceType = "Website Development"
    @State private var notes = ""
    @State private var submitting = false
    @State private var errorText: String? = nil

    private var canSubmit: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("New Client").font(.subheadline.weight(.bold))
                    Text("Agency client — CRM এ যোগ হবে।").font(.caption2).foregroundStyle(.secondary)
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
                    field("Name *", text: $name)
                    field("Company", text: $company)
                    field("Phone", text: $phone, keyboard: .phonePad)
                    field("Email", text: $email, keyboard: .emailAddress)
                    field("Country", text: $country)
                    field("Lead source", text: $leadSource)
                    field("Tags", text: $tags)
                    Menu {
                        ForEach(Self.services, id: \.self) { s in
                            Button(s) { serviceType = s }
                        }
                    } label: {
                        HStack {
                            Text(serviceType).font(.subheadline.weight(.semibold))
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(Color.primary.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    }
                    field("Notes", text: $notes)
                    if let errorText {
                        Text(errorText).font(.caption2.weight(.semibold))
                            .foregroundStyle(DigitalClientsPalette.red500)
                    }
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)

            Divider().opacity(0.4)
            Button {
                submit()
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "Saving…" : "Save Client").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSubmit && !submitting
                            ? DigitalClientsPalette.cditBlue
                            : DigitalClientsPalette.cditBlue.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            .padding(.horizontal, 18).padding(.vertical, 14)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
    }

    private func field(_ placeholder: String, text: Binding<String>,
                       keyboard: UIKeyboardType = .default) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .textInputAutocapitalization(keyboard == .emailAddress ? .never : .words)
            .autocorrectionDisabled(keyboard == .emailAddress)
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
            let ok = await vm.createClient(.init(
                name: name.trimmingCharacters(in: .whitespaces),
                company: company, phone: phone, email: email,
                country: country, service_type: serviceType,
                lead_source: leadSource, notes: notes, tags: tags))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }
}

// MARK: - Record payment (owner 2026-07-11: native writes — web client-detail
// "Record payment" parity, POST /api/digital/payments).

@available(iOS 17.0, *)
struct DigitalClientsPaymentSheet: View {
    let clientId: String
    let clientName: String
    var invoiceId: String? = nil
    var projectId: String? = nil
    let vm: DigitalClientsVM
    var onDone: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    // Web CDIT_PAYMENT_METHODS verbatim.
    private static let methods = ["Bank Transfer", "bKash", "Nagad", "Cash",
                                  "PayPal", "Stripe", "Other"]

    @State private var amount = ""
    @State private var method = "Bank Transfer"
    @State private var submitting = false
    @State private var confirming = false
    @State private var errorText: String? = nil

    private var taka: Int { Int(Double(amount.replacingOccurrences(of: ",", with: "")) ?? 0) }
    private var canSubmit: Bool { taka > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Record payment").font(.subheadline.weight(.bold)).padding(.top, 20)
            Text(clientName).font(.caption).foregroundStyle(.secondary)
            TextField("Amount (BDT)", text: $amount)
                .keyboardType(.numberPad)
                .font(.title3.weight(.bold)).monospacedDigit()
                .padding(.horizontal, 12).padding(.vertical, 12)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Menu {
                ForEach(Self.methods, id: \.self) { m in Button(m) { method = m } }
            } label: {
                HStack {
                    Text(method).font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            if let errorText {
                Text(errorText).font(.caption2.weight(.semibold))
                    .foregroundStyle(DigitalClientsPalette.red500)
            }
            Button {
                confirming = true
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text("Record payment").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(canSubmit && !submitting
                            ? DigitalClientsPalette.emerald600
                            : DigitalClientsPalette.emerald600.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationDetents([.height(320)])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .confirmationDialog(
            "৳\(taka.formatted()) payment (\(method)) রেকর্ড করবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, রেকর্ড করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok = await vm.recordPayment(.init(
                invoice_id: invoiceId, project_id: projectId,
                client_id: clientId, client_name: clientName,
                amount: taka, payment_method: method))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { onDone?(); dismiss() } else { errorText = vm.toast }
        }
    }
}
