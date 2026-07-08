//
//  AuditSwiftUI.swift
//  ALMA ERP — the Audit log tab as a native SwiftUI screen (web parity).
//
//  Mirrors the web /audit page — same endpoint, same colours, same blocks:
//    GET /api/audit?limit=300 → { audit: [...], total }   (GAS with Supabase fallback)
//  Web-parity blocks: entry rows (Time · Action · Actor · Role · Business · Status ·
//  Summary) as glass cards · status colours (FAIL text-red-500 · else text-emerald-600) ·
//  refresh · empty state. Native extras: KPI strip (Total/OK/FAIL), status + business
//  filter chips (client-side — the API only takes limit), detail sheet with the full
//  summary + detail_json. The web page has NO run-scan action — read-only log; anything
//  heavier lives on the web escape hatch.
//  Carried lessons: lenient per-field decoding, no global spinner overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum AuditPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web: FAIL text-red-500 · else text-emerald-600. Unknown flags read amber.
    static func status(_ flag: String?) -> Color {
        switch (flag ?? "").uppercased() {
        case "FAIL", "ERROR", "CRITICAL": return red500
        case "OK", "SUCCESS", "PASS": return emerald600
        default: return amber600
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page types declare)

struct AuditLogEntry: Decodable, Identifiable, Equatable {
    let id: UUID
    let timestamp: String?
    let route: String?
    let actor: String?
    let actorRole: String?
    let businessId: String?
    let entityType: String?
    let entityId: String?
    let summary: String?
    let detailJson: String?
    let statusFlag: String?

    private enum Keys: String, CodingKey {
        case timestamp, route, actor, summary
        case actorRole = "actor_role"
        case businessId = "business_id"
        case entityType = "entity_type"
        case entityId = "entity_id"
        case detailJson = "detail_json"
        case statusFlag = "status_flag"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = UUID()   // GAS rows carry no id — timestamp+route is not unique
        timestamp = Self.flexString(c, .timestamp)
        route = Self.flexString(c, .route)
        actor = Self.flexString(c, .actor)
        actorRole = Self.flexString(c, .actorRole)
        businessId = Self.flexString(c, .businessId)
        entityType = Self.flexString(c, .entityType)
        entityId = Self.flexString(c, .entityId)
        summary = Self.flexString(c, .summary)
        detailJson = Self.flexString(c, .detailJson)
        statusFlag = Self.flexString(c, .statusFlag)
    }

    /// GAS sheets sometimes hand back numbers where strings are expected — take both.
    private static func flexString(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return String(d) }
        return nil
    }

    var isFail: Bool { (statusFlag ?? "").uppercased() == "FAIL" }

    static func == (a: AuditLogEntry, b: AuditLogEntry) -> Bool { a.id == b.id }
}

/// `/api/audit` returns the payload flat (`{ audit, total }`) — but decode a nested
/// `data` wrapper too, in case the route ever adopts apiDataSuccess like approvals.
struct AuditListResponse: Decodable {
    let audit: [AuditLogEntry]
    let total: Int?

    private enum Keys: String, CodingKey { case ok, data, audit, total }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        audit = (try? c.decode([AuditLogEntry].self, forKey: .audit)) ?? []
        total = try? c.decodeIfPresent(Int.self, forKey: .total)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class AuditVM {
    var rows: [AuditLogEntry] = []
    var total = 0
    var statusFilter = "ALL"        // ALL | OK | FAIL (client-side — API takes limit only)
    var businessFilter = "ALL"      // ALL | <business_id> (derived from loaded rows)
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: AuditListResponse = try await AlmaAPI.shared.get(
                "/api/audit", query: ["limit": "300"])
            rows = resp.audit
            total = resp.total ?? resp.audit.count
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

    var okCount: Int { rows.filter { !$0.isFail }.count }
    var failCount: Int { rows.filter { $0.isFail }.count }

    /// Unique business ids present in the loaded window, for the category chip row.
    var businesses: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for r in rows {
            let b = (r.businessId ?? "").trimmingCharacters(in: .whitespaces)
            guard !b.isEmpty, !seen.contains(b) else { continue }
            seen.insert(b)
            out.append(b)
        }
        return out.sorted()
    }

    var filtered: [AuditLogEntry] {
        rows.filter { r in
            let statusOk: Bool = switch statusFilter {
            case "FAIL": r.isFail
            case "OK": !r.isFail
            default: true
            }
            let bizOk = businessFilter == "ALL" || (r.businessId ?? "") == businessFilter
            return statusOk && bizOk
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AuditScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AuditVM()
    @State private var selected: AuditLogEntry? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                statusChips
                if vm.businesses.count > 1 { businessChips }
                kpiStrip
                if vm.loading && vm.rows.isEmpty { loadingRows }
                ForEach(vm.filtered) { entry in
                    AuditEntryCard(entry: entry) { selected = entry }
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
        .background(AuditAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { entry in
            AuditDetailSheet(entry: entry, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Filter chips ──

    /// Status filter — All / OK / FAIL as the app's native capsule chips.
    private var statusChips: some View {
        HStack(spacing: 8) {
            ForEach(["ALL", "OK", "FAIL"], id: \.self) { s in
                auditChip(s == "ALL" ? "All" : s, active: vm.statusFilter == s) {
                    vm.statusFilter = s
                }
            }
            Spacer()
            Button {
                Task { await vm.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .auditGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            .disabled(vm.loading)
        }
        .padding(.top, 4)
    }

    /// Business/category chips — derived from the loaded window (the web table just
    /// shows the Business column; native gets a filter out of it).
    private var businessChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                auditChip("সব ব্যবসা", active: vm.businessFilter == "ALL") {
                    vm.businessFilter = "ALL"
                }
                ForEach(vm.businesses, id: \.self) { b in
                    auditChip(b, active: vm.businessFilter == b) {
                        vm.businessFilter = b
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // ── KPI strip (Total / OK / FAIL over the loaded window) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("TOTAL", vm.total, AuditPalette.goldLt)
                kpiCard("OK", vm.okCount, AuditPalette.emerald600)
                kpiCard("FAIL", vm.failCount,
                        vm.failCount > 0 ? AuditPalette.red500 : .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text("\(value)").font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .auditGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Shared bits ──

    private func auditChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? AuditPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? AuditPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? AuditPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", AuditPalette.red500)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).auditGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .auditGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 92)
                .auditGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .auditShimmer()
        }
    }

    /// Web Empty parity: "No entries" — kept in Bangla for the owner.
    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("◇").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো এন্ট্রি নেই").foregroundStyle(.secondary)
            Text("সেশন সেট থাকা অবস্থায় লেখালেখি হলে — GAS রেকর্ড করার পর সারি দেখা যাবে।")
                .font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 60)
        .padding(.bottom, 20)
    }

    private var webEscape: some View {
        Button {
            openWeb("/audit", "Audit")
        } label: {
            Label("সম্পূর্ণ অডিট লগ — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Entry card (mirrors one web table row, re-set as a native card)

@available(iOS 17.0, *)
private struct AuditEntryCard: View {
    let entry: AuditLogEntry
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // Web: Action column, font-mono text-gold.
                Text(entry.route ?? "—")
                    .font(.footnote.monospaced().weight(.semibold))
                    .foregroundStyle(AuditPalette.accentText(colorScheme))
                    .lineLimit(1)
                Spacer(minLength: 4)
                statusBadge
            }

            // Web: Actor + Role columns.
            HStack(spacing: 6) {
                Text(entry.actor ?? "—").font(.caption.weight(.semibold))
                if let role = entry.actorRole, !role.isEmpty {
                    Text(role.replacingOccurrences(of: "_", with: " "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let biz = entry.businessId, !biz.isEmpty {
                    Text(biz)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                }
            }

            if let summary = entry.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            // Web: Time column, font-mono text-muted — shown verbatim.
            Text(AuditFormat.timeLine(entry.timestamp))
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .auditGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Web status colours: FAIL text-red-500 · else text-emerald-600, as a badge.
    private var statusBadge: some View {
        let flag = (entry.statusFlag ?? "—").uppercased()
        let tint = AuditPalette.status(entry.statusFlag)
        return Text(flag)
            .font(.system(size: 10, weight: .heavy))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Detail sheet (full row — the web packs Summary into a truncated cell)

@available(iOS 17.0, *)
private struct AuditDetailSheet: View {
    let entry: AuditLogEntry
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoRows
                if let detail = prettyDetail {
                    detailBlock(detail)
                }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { AuditAurora() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.route ?? "—")
                    .font(.headline.monospaced())
                    .foregroundStyle(AuditPalette.accentText(colorScheme))
                Spacer(minLength: 4)
                Text((entry.statusFlag ?? "—").uppercased())
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(AuditPalette.status(entry.statusFlag))
            }
            Text(AuditFormat.timeLine(entry.timestamp))
                .font(.caption.monospaced()).foregroundStyle(.secondary)
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Actor", entry.actor ?? "—")
            infoRow("Role", (entry.actorRole ?? "—").replacingOccurrences(of: "_", with: " "))
            infoRow("Business", entry.businessId ?? "Global")
            if let et = entry.entityType, !et.isEmpty {
                infoRow("Entity", "\(et)\(entry.entityId.map { " · \($0)" } ?? "")")
            }
            infoRow("Summary", entry.summary ?? "—")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .auditGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold))
        }
    }

    private func detailBlock(_ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("DETAIL").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .auditGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// detail_json pretty-printed when it parses; raw string otherwise.
    private var prettyDetail: String? {
        guard let raw = entry.detailJson?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, raw != "{}" else { return nil }
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let s = String(data: pretty, encoding: .utf8) else { return raw }
        return s
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/audit", "Audit")
        } label: {
            Label("সম্পূর্ণ অডিট লগ — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum AuditFormat {
    /// The web shows the timestamp string verbatim (font-mono). When it parses as
    /// ISO, append a Bangla relative-time hint; otherwise show it raw.
    static func timeLine(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        guard let date = parse(raw) else { return raw }
        return "\(raw) · \(timeAgo(date))"
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Bangla relative time — same strings the Approvals agent tab uses.
    private static func timeAgo(_ date: Date) -> String {
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }
}

// MARK: - Aurora background + glass (Audit-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AuditAurora: View {
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
    func auditGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AuditShimmer: ViewModifier {
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
    func auditShimmer() -> some View { modifier(AuditShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Audit — Light") {
    AuditScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
