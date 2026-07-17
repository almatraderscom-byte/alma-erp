//
//  DigitalProjectsSwiftUI.swift
//  ALMA ERP — the CDIT Projects page as a native SwiftUI screen (web /digital/projects parity).
//
//  Mirrors the web /digital/projects page — same endpoint, same colours, same blocks:
//    GET /api/digital/projects?business_id=CREATIVE_DIGITAL_IT&status=…&search=…  → { projects }
//  Web-parity blocks: search + status filter (Lead/Proposal/Active/Review/Completed/
//  On Hold/Cancelled) · project rows (name, client · service, PaymentStatusBadge,
//  PaymentProgressBar, Value/Paid/Due/status·deadline footer) · detail sheet with the
//  full project record + "View client" web link. NATIVE WRITES (verified 2026-07-17):
//  project create (POST /api/digital/projects).
//  Carried lessons: lenient row decoding, shimmer skeletons, no global overlays,
//  cancellation-safe pull-to-refresh.
//

import SwiftUI

// MARK: - Web palette (exact hexes from tailwind tokens the web page uses)

private enum DigitalProjectsPalette {
    /// CDIT accent — the digital section's hero blue.
    static let accentBlue = Color(red: 0.42, green: 0.56, blue: 0.88)
    static let gold = AlmaSwiftTheme.coral                                   // web --c-accent #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let zinc600 = Color(red: 0.322, green: 0.322, blue: 0.357)        // #52525B (Unpaid bar)
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B (Partial bar)
    static let amber400 = Color(red: 0.984, green: 0.749, blue: 0.141)       // #FBBF24 (Due text)
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let emerald500 = Color(red: 0.063, green: 0.725, blue: 0.506)     // #10B981 (Paid bar)
    static let emerald400 = Color(red: 0.204, green: 0.827, blue: 0.600)     // #34D399 (Paid text)
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// Accent-tinted text: gold-dim on cream, gold-lt over dark aurora (web text-gold).
    static func goldText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web PaymentProgress STATUS_COLOR: Unpaid zinc · Partial amber · Paid emerald.
    static func paymentBar(_ status: String) -> Color {
        switch status {
        case "Paid": return emerald500
        case "Partial Paid": return amber500
        default: return zinc600
        }
    }

    /// Web PaymentStatusBadge text tints (Unpaid muted · Partial amber-400 · Paid emerald-400).
    static func paymentText(_ status: String, _ scheme: ColorScheme) -> Color {
        switch status {
        case "Paid": return scheme == .dark ? emerald400 : emerald600
        case "Partial Paid": return scheme == .dark ? amber400 : amber600
        default: return slate400
        }
    }

    /// Amber "Due" footer text (web text-amber-400, darkened on cream).
    static func dueText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? amber400 : amber600
    }

    /// Emerald "Paid" footer text (web text-emerald-400, darkened on cream).
    static func paidText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? emerald400 : emerald600
    }
}

// MARK: - Model (same field names the web CditProject type declares — snake_case wire)

private struct DigitalProject: Decodable, Identifiable, Equatable {
    let id: String
    let clientId: String?
    let clientName: String?
    let projectName: String?
    let title: String?
    let serviceType: String?
    let status: String
    let currency: String?
    let startDate: String?
    let deadline: String?
    let assignedTo: String?
    let priority: String?
    let notes: String?
    let totalAmount: Int?
    let totalPaid: Int?
    let dueAmount: Int?
    let paymentPercentage: Double?
    let paymentStatus: String

    private enum Keys: String, CodingKey {
        case id, title, status, currency, deadline, priority, notes
        case clientId = "client_id"
        case clientName = "client_name"
        case projectName = "project_name"
        case serviceType = "service_type"
        case startDate = "start_date"
        case assignedTo = "assigned_to"
        case totalAmount = "total_amount"
        case totalPaid = "total_paid"
        case dueAmount = "due_amount"
        case paymentPercentage = "payment_percentage"
        case paymentStatus = "payment_status"
    }

    /// Sheet-backfilled rows carry ints in string fields and vice-versa — decode
    /// defensively so ONE bad row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawId = try? c.decodeIfPresent(String.self, forKey: .id)
        projectName = Self.flexString(c, .projectName)
        title = Self.flexString(c, .title)
        id = rawId ?? "\(projectName ?? title ?? "?")-\(Int.random(in: 0..<1_000_000))"
        clientId = Self.flexString(c, .clientId)
        clientName = Self.flexString(c, .clientName)
        serviceType = Self.flexString(c, .serviceType)
        status = Self.flexString(c, .status) ?? "Lead"
        currency = Self.flexString(c, .currency)
        startDate = Self.flexString(c, .startDate)
        deadline = Self.flexString(c, .deadline)
        assignedTo = Self.flexString(c, .assignedTo)
        priority = Self.flexString(c, .priority)
        notes = Self.flexString(c, .notes)
        totalAmount = Self.flexInt(c, .totalAmount)
        totalPaid = Self.flexInt(c, .totalPaid)
        dueAmount = Self.flexInt(c, .dueAmount)
        paymentPercentage = Self.flexDouble(c, .paymentPercentage)
        paymentStatus = Self.flexString(c, .paymentStatus) ?? "Unpaid"
    }

    /// Web row headline: `p.project_name || p.title`.
    var name: String {
        if let n = projectName, !n.isEmpty { return n }
        if let t = title, !t.isEmpty { return t }
        return "—"
    }

    private static func flexString(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return String(d) }
        return nil
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) ?? Double(s).map { Int($0.rounded()) } }
        return nil
    }
    private static func flexDouble(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }

    static func == (a: DigitalProject, b: DigitalProject) -> Bool { a.id == b.id }
}

/// GET /api/digital/projects answers flat `{ projects }`; tolerate an
/// apiDataSuccess `{ ok, data: {…} }` wrap too, like the other native decoders do.
private struct DigitalProjectsResponse: Decodable {
    let projects: [DigitalProject]

    private enum Keys: String, CodingKey { case ok, data, projects }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        projects = (try? c.decode([DigitalProject].self, forKey: .projects)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class DigitalProjectsVM {
    var projects: [DigitalProject] = []
    var search = ""
    var status: String? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Web STATUSES constant, same order.
    static let statuses = ["Lead", "Proposal", "Active", "Review", "Completed", "On Hold", "Cancelled"]

    // ── Hero summary — computed from the loaded list (web subtitle: "N projects ·
    //    billing tracked", expanded into the bento hero's billing split) ──
    var totalValue: Int { projects.reduce(0) { $0 + ($1.totalAmount ?? 0) } }
    var totalPaid: Int { projects.reduce(0) { $0 + ($1.totalPaid ?? 0) } }
    var totalDue: Int { projects.reduce(0) { $0 + ($1.dueAmount ?? 0) } }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Same query the web builds: bizParams() + status/search filters.
            let resp: DigitalProjectsResponse = try await AlmaAPI.shared.get(
                "/api/digital/projects",
                query: ["business_id": "CREATIVE_DIGITAL_IT",
                        "status": status,
                        "search": search.isEmpty ? nil : search])
            projects = resp.projects
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

    // ── Native create (owner 2026-07-11) — web "New Project" card payload verbatim. ──

    var toast: String? = nil

    struct ProjectPayload: Encodable {
        let project_name: String
        let title: String
        let client_id: String
        let client_name: String
        let service_type: String
        let total_amount: Int
        let currency = "BDT"
        let start_date: String
        let status = "Lead"
        let deadline: String
        let assigned_to = ""
        let priority = "Medium"
        let business_id = "CREATIVE_DIGITAL_IT"
    }
    private struct WriteResponse: Decodable { let ok: Bool?, error: String? }

    func createProject(_ p: ProjectPayload) async -> Bool {
        do {
            let res: WriteResponse = try await AlmaAPI.shared.send("POST", "/api/digital/projects", body: p)
            guard res.ok ?? false else {
                toast = res.error ?? "Could not create project"
                return false
            }
            toast = "Project created"
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
struct DigitalProjectsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = DigitalProjectsVM()
    @State private var selected: DigitalProject? = nil
    @State private var searchDebounce: Task<Void, Never>? = nil
    @State private var showCreate = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                hero
                newProjectButton
                statusChips
                searchRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.projects.isEmpty { loadingRows }
                ForEach(vm.projects) { p in
                    DigitalProjectRow(project: p) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = p
                    }
                }
                if !vm.loading && vm.projects.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(DigitalProjectsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { p in
            DigitalProjectDetailSheet(project: p, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCreate) { DigitalProjectsCreateSheet(vm: vm) }
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

    /// Web header "+ New Project" — native form sheet (owner 2026-07-11).
    private var newProjectButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showCreate = true
        } label: {
            Label("+ New Project", systemImage: "hammer")
                .font(.caption.weight(.bold))
                .foregroundStyle(DigitalProjectsPalette.goldText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(DigitalProjectsPalette.accentBlue.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(DigitalProjectsPalette.accentBlue.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Bento hero (web CditPageShell subtitle "N projects · billing tracked"
    //    expanded into the board's dark anchor: contract value + paid/due split) ──

    private var hero: some View {
        DigitalProjectsHeroCard(totalValue: vm.totalValue,
                                totalPaid: vm.totalPaid,
                                totalDue: vm.totalDue,
                                count: vm.projects.count)
            .padding(.top, 4)
    }

    // ── Status filter (web Select: All status + the 7 statuses, tap again to clear) ──

    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", active: vm.status == nil) {
                    vm.status = nil
                    Task { await vm.load() }
                }
                ForEach(DigitalProjectsVM.statuses, id: \.self) { s in
                    chip(s, active: vm.status == s) {
                        vm.status = vm.status == s ? nil : s
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func chip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? DigitalProjectsPalette.accentBlue : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active
                    ? DigitalProjectsPalette.accentBlue.opacity(colorScheme == .dark ? 0.28 : 0.16)
                    : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                    in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? DigitalProjectsPalette.accentBlue.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Search (web SearchInput — server-side, debounced) ──

    private var searchRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search projects…", text: Binding(
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
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(DigitalProjectsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .digitalProjectsShimmer()
        }
    }

    /// Web Empty: icon ◰ · "No projects" · "Start tracking client work here".
    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "square.grid.2x2").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো প্রজেক্ট পাওয়া যায়নি").foregroundStyle(.secondary)
            Text("ক্লায়েন্ট কাজ ট্র্যাক করতে ওয়েবে প্রজেক্ট যোগ করুন").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    /// Mutations (web "+ New Project" form) live on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/digital/projects", "CDIT projects")
        } label: {
            Label("নতুন প্রজেক্ট / সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row (web card row: name · client · service, badge, progress bar, money footer)

@available(iOS 17.0, *)
private struct DigitalProjectRow: View {
    let project: DigitalProject
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(.subheadline.weight(.bold)).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                DigitalPaymentBadge(status: project.paymentStatus)
            }
            DigitalPaymentBar(percentage: project.paymentPercentage ?? 0,
                              status: project.paymentStatus)
            footer
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    /// Web sub line: `{client_name} · {service_type}`.
    private var subtitle: String {
        var bits: [String] = []
        if let c = project.clientName, !c.isEmpty { bits.append(c) }
        if let s = project.serviceType, !s.isEmpty { bits.append(s) }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    /// Web footer: Value ৳X · Paid ৳X (emerald) · Due ৳X (amber) · {status} · Due {deadline}.
    private var footer: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { footerBits }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) { footerBits }
            }
        }
    }

    @ViewBuilder private var footerBits: some View {
        moneyBit("Value", project.totalAmount ?? 0, .secondary)
        moneyBit("Paid", project.totalPaid ?? 0, DigitalProjectsPalette.paidText(colorScheme))
        moneyBit("Due", project.dueAmount ?? 0, DigitalProjectsPalette.dueText(colorScheme))
        Text("\(project.status) · Due \(project.deadline?.isEmpty == false ? project.deadline! : "—")")
            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
    }

    private func moneyBit(_ label: String, _ amount: Int, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text("৳\(amount.formatted())")
                .font(.system(size: 10, weight: .bold)).monospacedDigit()
                .foregroundStyle(tint)
        }
    }
}

// MARK: - PaymentProgress parity (web PaymentProgressBar + PaymentStatusBadge)

/// Web PaymentProgressBar: h-2 rounded track (white/10) + status-coloured fill,
/// width = clamped percentage.
@available(iOS 17.0, *)
private struct DigitalPaymentBar: View {
    let percentage: Double
    let status: String

    var body: some View {
        let pct = min(100, max(0, percentage))
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10))
                Capsule().fill(DigitalProjectsPalette.paymentBar(status))
                    .frame(width: geo.size.width * pct / 100)
            }
        }
        .frame(height: 6)
        .animation(.easeInOut(duration: 0.5), value: pct)
    }
}

/// Web PaymentStatusBadge: uppercase tracking pill, tinted per status.
@available(iOS 17.0, *)
private struct DigitalPaymentBadge: View {
    let status: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let tint = DigitalProjectsPalette.paymentText(status, colorScheme)
        Text(status.uppercased())
            .font(.system(size: 9, weight: .bold)).tracking(0.6)
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
            .lineLimit(1)
            .fixedSize()
    }
}

// MARK: - Detail sheet (full record + web "View client →" escape)

@available(iOS 17.0, *)
private struct DigitalProjectDetailSheet: View {
    let project: DigitalProject
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                billingCard
                detailsCard
                if let n = project.notes, !n.isEmpty { notesCard(n) }
                links
            }
            .padding(18)
        }
        .presentationBackground { DigitalProjectsAurora() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Text(project.name).font(.headline)
                Spacer(minLength: 8)
                DigitalPaymentBadge(status: project.paymentStatus)
            }
            Text("\(project.clientName ?? "—") · \(project.serviceType ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // ── Billing (progress bar + Value / Paid / Due cells — the web row's numbers) ──

    private var billingCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("BILLING")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            DigitalPaymentBar(percentage: project.paymentPercentage ?? 0,
                              status: project.paymentStatus)
            HStack(spacing: 10) {
                statCell("Value", project.totalAmount ?? 0,
                         DigitalProjectsPalette.goldText(colorScheme))
                statCell("Paid", project.totalPaid ?? 0,
                         DigitalProjectsPalette.paidText(colorScheme))
                statCell("Due", project.dueAmount ?? 0,
                         DigitalProjectsPalette.dueText(colorScheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func statCell(_ label: String, _ amount: Int, _ tint: Color) -> some View {
        VStack(spacing: 3) {
            Text("৳\(amount.formatted())")
                .font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // ── Project record (status / priority / dates / assignee / currency) ──

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROJECT")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            row("Status", project.status, tint: DigitalProjectsPalette.accentBlue)
            row("Priority", project.priority?.isEmpty == false ? project.priority! : "—")
            row("Start", project.startDate?.isEmpty == false ? project.startDate! : "—")
            row("Deadline", project.deadline?.isEmpty == false ? project.deadline! : "—")
            row("Assigned to", project.assignedTo?.isEmpty == false ? project.assignedTo! : "—")
            row("Currency", project.currency?.isEmpty == false ? project.currency! : "BDT")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func row(_ label: String, _ value: String, tint: Color = .primary) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.bold)).foregroundStyle(tint)
                .multilineTextAlignment(.trailing)
        }
    }

    private func notesCard(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NOTES")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            Text(notes).font(.caption).foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .digitalProjectsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Web escapes (web "View client →" link + page escape) ──

    @ViewBuilder private var links: some View {
        if let cid = project.clientId, !cid.isEmpty {
            Button {
                dismiss()
                openWeb("/digital/clients/\(cid)", project.clientName ?? "Client")
            } label: {
                Label("ক্লায়েন্ট দেখুন", systemImage: "person.crop.circle")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(DigitalProjectsPalette.accentBlue)
        }
        Button {
            dismiss()
            openWeb("/digital/projects", "CDIT projects")
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

// MARK: - Bento hero (page-owned copy of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func digitalProjectsMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct DigitalProjectsCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        DigitalProjectsCountUpText(value: shown, format: format)
            .animation(digitalProjectsMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if digitalProjectsMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct DigitalProjectsCountUpText: View, Animatable {
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
/// deep indigo base + CDIT-blue/violet washes). Total contract value count-up plus
/// Paid / Due / Projects split — the web subtitle's "billing tracked", made visible.
@available(iOS 17.0, *)
private struct DigitalProjectsHeroCard: View {
    let totalValue: Int
    let totalPaid: Int
    let totalDue: Int
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("CDIT প্রজেক্ট বিলিং").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(DigitalProjectsPalette.accentBlue)
            DigitalProjectsCountUp(target: totalValue, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("মোট কন্ট্রাক্ট ভ্যালু")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Paid", value: totalPaid,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: DigitalProjectsPalette.emerald400, sub: "আদায় হয়েছে")
                divider
                heroStat(label: "Due", value: totalDue,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: DigitalProjectsPalette.amber400, sub: "বাকি আছে")
                divider
                heroStat(label: "Projects", value: count, format: { "\($0)" },
                         tint: .white, sub: "মোট প্রজেক্ট")
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
                LinearGradient(colors: [DigitalProjectsPalette.accentBlue.opacity(0.36), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.28), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [DigitalProjectsPalette.emerald500.opacity(0.12), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 14)
    }

    private func heroStat(label: String, value: Int, format: @escaping (Int) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            DigitalProjectsCountUp(target: value, format: format)
                .font(.system(size: 18, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Aurora background + glass (page-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct DigitalProjectsAurora: View {
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
    func digitalProjectsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct DigitalProjectsShimmer: ViewModifier {
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
    func digitalProjectsShimmer() -> some View { modifier(DigitalProjectsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("CDIT Projects — Light") {
    DigitalProjectsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Create project (owner 2026-07-11: native writes — web "New Project" card
// parity, POST /api/digital/projects with the exact same payload).

@available(iOS 17.0, *)
private struct DigitalProjectsCreateSheet: View {
    let vm: DigitalProjectsVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    // Web CDIT_SERVICES verbatim (src/types/cdit.ts).
    private static let services = ["Website Development", "Facebook Marketing", "SEO",
                                   "Branding", "Video Editing", "Graphics", "Monthly Retainer"]

    @State private var projectName = ""
    @State private var clientId = ""
    @State private var clientName = ""
    @State private var totalAmount = ""
    @State private var serviceType = "Website Development"
    @State private var startDate: Date? = nil
    @State private var deadline: Date? = nil
    @State private var submitting = false
    @State private var confirming = false
    @State private var errorText: String? = nil

    private var taka: Int { Int(Double(totalAmount.replacingOccurrences(of: ",", with: "")) ?? 0) }
    private var canSubmit: Bool { !projectName.trimmingCharacters(in: .whitespaces).isEmpty }
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
                    Text("New Project").font(.subheadline.weight(.bold))
                    Text("Billing-tracked client project।").font(.caption2).foregroundStyle(.secondary)
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
                    field("Project name *", text: $projectName)
                    field("Client ID", text: $clientId)
                    field("Client name", text: $clientName)
                    field("Contract value (BDT)", text: $totalAmount, keyboard: .numberPad)
                    Menu {
                        ForEach(Self.services, id: \.self) { s in Button(s) { serviceType = s } }
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
                    optionalDate("Start date", date: $startDate)
                    optionalDate("Deadline", date: $deadline)
                    if let errorText {
                        Text(errorText).font(.caption2.weight(.semibold))
                            .foregroundStyle(DigitalProjectsPalette.red500)
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
                    Text(submitting ? "Saving…" : "Create Project").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSubmit && !submitting
                            ? DigitalProjectsPalette.accentBlue
                            : DigitalProjectsPalette.accentBlue.opacity(0.4),
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
            "\"\(projectName)\" তৈরি করবেন?\(taka > 0 ? " Value ৳\(taka.formatted())" : "")",
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

    /// Web's optional date inputs — empty string when unset.
    private func optionalDate(_ label: String, date: Binding<Date?>) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            if let d = date.wrappedValue {
                DatePicker("", selection: Binding(get: { d }, set: { date.wrappedValue = $0 }),
                           displayedComponents: .date)
                    .labelsHidden()
                Button {
                    date.wrappedValue = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            } else {
                Button("সেট করুন") { date.wrappedValue = Date() }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.primary.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        let name = projectName.trimmingCharacters(in: .whitespaces)
        Task {
            defer { submitting = false }
            let ok = await vm.createProject(.init(
                project_name: name, title: name,
                client_id: clientId, client_name: clientName,
                service_type: serviceType, total_amount: taka,
                start_date: startDate.map { Self.ymd.string(from: $0) } ?? "",
                deadline: deadline.map { Self.ymd.string(from: $0) } ?? ""))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }
}
