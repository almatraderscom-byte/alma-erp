//
//  StaffMonitorSwiftUI.swift
//  ALMA ERP — Staff Monitor as a native SwiftUI screen (read-only).
//
//  Mirrors the web /agent/staff-monitor page's staff blocks — same endpoint,
//  same colours, same Bangla labels:
//    GET /api/agent/staff-monitor            → live staff summaries + geo + feed
//    GET /api/agent/staff-monitor?date=YYYY-MM-DD → archived day summary
//  (Session-cookie route — the exact browser fetch the web page itself makes.
//   No key-authed agent routes, no writes: dispatch/nudge/escalate stay on web.)
//
//  Blocks: Live/Archive day chips · KPI strip (active/tasks/unacked) · staff
//  cards with initials avatars + live status dots + day-progress bars + location
//  line (geo status + relative Bangla time) · per-staff detail sheet (progress,
//  location, productivity alerts, today's messages with ack badges) · web
//  escape hatch. Carried lessons: lenient decoding, cancellation-safe refresh.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum StaffMonitorPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let teal = Color(red: 0.506, green: 0.698, blue: 0.604)           // web #81B29A (progress gradient)
    static let sky500 = Color(red: 0.055, green: 0.647, blue: 0.914)         // #0EA5E9 (driving dot)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web MonitorStaffCards statusInfo() — same precedence, same labels.
    static func status(_ s: StaffMonitorSummary) -> (color: Color, label: String) {
        if s.driving == true { return (sky500, "🚗 Driving") }
        if s.checkedIn == false { return (.secondary, "Awaiting") }
        if s.failed > 0 { return (red500, "Issues") }
        if s.completionPct >= 100 { return (emerald600, "Complete") }
        if s.started && s.completionPct >= 50 { return (amber500, "Working") }
        if s.started { return (amber500, "Started") }
        return (.secondary, "Idle")
    }

    /// Web GEO_LABEL table — Bangla strings verbatim.
    static func geo(_ status: String?) -> (icon: String, text: String, color: Color) {
        switch status {
        case "in_zone": return ("✅", "অফিসে", emerald600)
        case "outside": return ("🚨", "বাইরে", red500)
        case "stale": return ("⏸️", "পুরোনো লোকেশন", amber600)
        default: return ("❓", "লোকেশন নেই", .secondary)
        }
    }
}

// MARK: - Lenient int decoding (API mixes Int/Double/String numerics)

private func staffMonitorFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
    return nil
}

// MARK: - Models (same field names as src/agent/lib/staff-monitor-types.ts)

/// Web StaffSummary — one staff member's day progress.
struct StaffMonitorSummary: Decodable, Identifiable, Equatable {
    let staffId: String
    let staffName: String
    let dispatched: Int
    let delivered: Int
    let failed: Int
    let tasksTotal: Int
    let tasksDone: Int
    let completionPct: Int
    let started: Bool
    let lastActivityAt: String?
    let checkedIn: Bool?
    let driving: Bool?

    var id: String { staffId }

    private enum Keys: String, CodingKey {
        case staffId, staffName, dispatched, delivered, failed
        case tasksTotal, tasksDone, completionPct, started, lastActivityAt, checkedIn, driving
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? UUID().uuidString
        staffName = (try? c.decode(String.self, forKey: .staffName)) ?? "—"
        dispatched = staffMonitorFlexInt(c, .dispatched) ?? 0
        delivered = staffMonitorFlexInt(c, .delivered) ?? 0
        failed = staffMonitorFlexInt(c, .failed) ?? 0
        tasksTotal = staffMonitorFlexInt(c, .tasksTotal) ?? 0
        tasksDone = staffMonitorFlexInt(c, .tasksDone) ?? 0
        completionPct = staffMonitorFlexInt(c, .completionPct) ?? 0
        started = (try? c.decodeIfPresent(Bool.self, forKey: .started)) ?? false
        lastActivityAt = try? c.decodeIfPresent(String.self, forKey: .lastActivityAt)
        checkedIn = try? c.decodeIfPresent(Bool.self, forKey: .checkedIn)
        driving = try? c.decodeIfPresent(Bool.self, forKey: .driving)
    }

    static func == (a: StaffMonitorSummary, b: StaffMonitorSummary) -> Bool {
        a.staffId == b.staffId && a.completionPct == b.completionPct && a.tasksDone == b.tasksDone
    }
}

/// Web GeoStaffStatus — office geo-fence state per staff.
struct StaffMonitorGeo: Decodable, Equatable {
    let staffId: String
    let staffName: String?
    let status: String
    let distanceM: Int?
    let lastUpdate: String?
    let mapsLink: String?

    private enum Keys: String, CodingKey { case staffId, staffName, status, distanceM, lastUpdate, mapsLink }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? ""
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        status = (try? c.decode(String.self, forKey: .status)) ?? "no_data"
        distanceM = staffMonitorFlexInt(c, .distanceM)
        lastUpdate = try? c.decodeIfPresent(String.self, forKey: .lastUpdate)
        mapsLink = try? c.decodeIfPresent(String.self, forKey: .mapsLink)
    }
}

/// Web ProductivityAlert — idle / proof-timeout / slow-task nudges.
struct StaffMonitorAlert: Decodable, Equatable {
    let staffId: String
    let staffName: String?
    let type: String
    let message: String
    let at: String?

    private enum Keys: String, CodingKey { case staffId, staffName, type, message, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? ""
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        type = (try? c.decode(String.self, forKey: .type)) ?? ""
        message = (try? c.decode(String.self, forKey: .message)) ?? ""
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }
}

/// Web StaffMonitorRow (outbox feed slice the detail sheet shows).
struct StaffMonitorFeedRow: Decodable, Identifiable, Equatable {
    let id: String
    let staffId: String?
    let staffName: String?
    let type: String
    let content: String
    let status: String
    let requiresAck: Bool
    let acknowledgedAt: String?
    let createdAt: String?
    let sentAt: String?

    private enum Keys: String, CodingKey {
        case id, staffId, staffName, type, content, status, requiresAck, acknowledgedAt, createdAt, sentAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        staffId = try? c.decodeIfPresent(String.self, forKey: .staffId)
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        type = (try? c.decode(String.self, forKey: .type)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        requiresAck = (try? c.decodeIfPresent(Bool.self, forKey: .requiresAck)) ?? false
        acknowledgedAt = try? c.decodeIfPresent(String.self, forKey: .acknowledgedAt)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        sentAt = try? c.decodeIfPresent(String.self, forKey: .sentAt)
    }

    /// Web TYPE_LABELS — Bangla verbatim.
    var typeLabel: String {
        switch type {
        case "task_dispatch": return "টাস্ক"
        case "announcement": return "ঘোষণা"
        case "reminder": return "রিমাইন্ডার"
        case "presence": return "প্রেজেন্স"
        case "coaching": return "কোচিং"
        case "feedback_ack": return "ফিডব্যাক"
        case "task_redo": return "রিডু"
        case "proof_reminder": return "প্রমাণ"
        default: return type
        }
    }
}

/// GET /api/agent/staff-monitor — flat JSON (decode a `{ ok, data }` wrapper too,
/// defensively, matching the app's other screens).
struct StaffMonitorData: Decodable {
    let today: String?
    let isHistorical: Bool?
    let historyDates: [String]
    let staffSummaries: [StaffMonitorSummary]
    let geoStatus: [StaffMonitorGeo]
    let productivityAlerts: [StaffMonitorAlert]
    let feed: [StaffMonitorFeedRow]
    let historyFeed: [StaffMonitorFeedRow]
    let unackedMessages: [StaffMonitorFeedRow]
    let geoFenceMonitoringEnabled: Bool?
    let generatedAt: String?

    private enum Keys: String, CodingKey {
        case ok, data, today, isHistorical, historyDates, staffSummaries, geoStatus
        case productivityAlerts, feed, historyFeed, unackedMessages, geoFenceMonitoringEnabled, generatedAt
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        today = try? c.decodeIfPresent(String.self, forKey: .today)
        isHistorical = try? c.decodeIfPresent(Bool.self, forKey: .isHistorical)
        historyDates = (try? c.decodeIfPresent([String].self, forKey: .historyDates)) ?? []
        staffSummaries = (try? c.decodeIfPresent([StaffMonitorSummary].self, forKey: .staffSummaries)) ?? []
        geoStatus = (try? c.decodeIfPresent([StaffMonitorGeo].self, forKey: .geoStatus)) ?? []
        productivityAlerts = (try? c.decodeIfPresent([StaffMonitorAlert].self, forKey: .productivityAlerts)) ?? []
        feed = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .feed)) ?? []
        historyFeed = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .historyFeed)) ?? []
        unackedMessages = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .unackedMessages)) ?? []
        geoFenceMonitoringEnabled = try? c.decodeIfPresent(Bool.self, forKey: .geoFenceMonitoringEnabled)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class StaffMonitorVM {
    var data: StaffMonitorData? = nil
    /// nil = live (Today); "YYYY-MM-DD" = archived day summary.
    var selectedDate: String? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    var isLive: Bool { selectedDate == nil }

    func load(silent: Bool = false) async {
        if !silent { loading = true }
        defer { if !silent { loading = false } }
        do {
            let resp: StaffMonitorData = try await AlmaAPI.shared.get(
                "/api/agent/staff-monitor", query: ["date": selectedDate])
            data = resp
            error = nil
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            // Silent 10s ticks never blank a working screen with an error banner.
            if !silent || data == nil {
                self.error = error.localizedDescription
            }
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // ── Derived lookups for the cards / detail sheet ──

    func geo(for staffId: String) -> StaffMonitorGeo? {
        data?.geoStatus.first { $0.staffId == staffId }
    }
    func alerts(for staffId: String) -> [StaffMonitorAlert] {
        data?.productivityAlerts.filter { $0.staffId == staffId } ?? []
    }
    func messages(for staffId: String) -> [StaffMonitorFeedRow] {
        let rows = (data?.feed.isEmpty == false ? data?.feed : data?.historyFeed) ?? []
        return rows.filter { $0.staffId == staffId }
    }
    var activeCount: Int {
        // checkedIn may be missing in older payloads — treat undefined as active
        // (same rule as the web MonitorStaffCards).
        data?.staffSummaries.filter { $0.checkedIn != false }.count ?? 0
    }
    var tasksDoneTotal: (done: Int, total: Int) {
        let s = data?.staffSummaries ?? []
        return (s.reduce(0) { $0 + $1.tasksDone }, s.reduce(0) { $0 + $1.tasksTotal })
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct StaffMonitorScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = StaffMonitorVM()
    @State private var selected: StaffMonitorSummary? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                headerBar
                dayChips
                if vm.authExpired { authCard }
                if let err = vm.error, vm.data == nil { errorCard(err) }
                if vm.data != nil { kpiStrip }
                geoFenceNote
                if vm.loading && vm.data == nil { loadingRows }
                staffCards
                alertsSection
                if let d = vm.data, !vm.loading, d.staffSummaries.isEmpty, vm.error == nil, !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(StaffMonitorAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            // Web parity: auto-refresh every 10s while live; SwiftUI cancels this
            // task when the screen leaves the hierarchy.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                if vm.isLive { await vm.load(silent: true) }
            }
        }
        .sheet(item: $selected) { s in
            StaffMonitorDetailSheet(summary: s, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header: Live pulse / archive badge + meta line (web sticky header parity) ──

    private var headerBar: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Staff Monitor").font(.subheadline.weight(.bold))
                Text(metaLine).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if vm.isLive { livePulse } else if let d = vm.selectedDate { archiveBadge(d) }
        }
        .padding(.top, 4)
    }

    private var metaLine: String {
        guard let d = vm.data else { return "কন্ট্রোল • হার্টবিট • স্টাফ মনিটর" }
        if !vm.isLive { return "Viewing archive · press \"Today\" to return" }
        var bits: [String] = []
        if let today = d.today { bits.append(today) }
        bits.append("auto-refresh 10s")
        if let t = StaffMonitorFormat.clock(d.generatedAt) { bits.append("last \(t)") }
        return bits.joined(separator: " · ")
    }

    private var livePulse: some View {
        HStack(spacing: 5) {
            Circle().fill(StaffMonitorPalette.emerald600).frame(width: 7, height: 7)
                .shadow(color: StaffMonitorPalette.emerald600.opacity(0.6), radius: 3)
            Text("LIVE").font(.caption2.weight(.heavy))
                .foregroundStyle(StaffMonitorPalette.emerald600)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(StaffMonitorPalette.emerald600.opacity(0.10), in: Capsule())
        .overlay(Capsule().strokeBorder(StaffMonitorPalette.emerald600.opacity(0.30), lineWidth: 1))
    }

    private func archiveBadge(_ date: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(Color.secondary).frame(width: 7, height: 7)
            Text(date).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color.primary.opacity(0.06), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }

    // ── Day summary chips: Today (live) + archived dates ──

    @ViewBuilder private var dayChips: some View {
        if let dates = vm.data?.historyDates, !dates.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    staffMonitorChip("Today", active: vm.isLive) {
                        vm.selectedDate = nil
                        Task { await vm.load() }
                    }
                    ForEach(dates, id: \.self) { d in
                        staffMonitorChip(d, active: vm.selectedDate == d) {
                            vm.selectedDate = d
                            Task { await vm.load() }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    // ── KPI strip: active staff / tasks / unacked (web header badges + alert count) ──

    private var kpiStrip: some View {
        let tasks = vm.tasksDoneTotal
        let unacked = vm.data?.unackedMessages.count ?? 0
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("ACTIVE", "\(vm.activeCount)",
                        vm.activeCount > 0 ? StaffMonitorPalette.emerald600 : .primary)
                kpiCard("TASKS", "\(tasks.done)/\(tasks.total)", .primary)
                kpiCard("UNACKED", "\(unacked)",
                        unacked > 0 ? StaffMonitorPalette.amber600 : .primary)
                kpiCard("STAFF", "\(vm.data?.staffSummaries.count ?? 0)",
                        StaffMonitorPalette.accentText(colorScheme))
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .staffMonitorGlass(colorScheme, corner: 14)
    }

    // ── Geo-fence OFF note (web Bangla string verbatim) ──

    @ViewBuilder private var geoFenceNote: some View {
        if vm.data?.geoFenceMonitoringEnabled == false {
            Label("Office time-এ continuous location tracking বন্ধ। Attendance check-in/out-এ location এখনও বাধ্যতামূলক।",
                  systemImage: "location.slash")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .staffMonitorGlass(colorScheme, corner: 12)
        }
    }

    // ── Staff cards ──

    @ViewBuilder private var staffCards: some View {
        if let summaries = vm.data?.staffSummaries, !summaries.isEmpty {
            ForEach(summaries) { s in
                StaffMonitorCard(
                    summary: s,
                    geo: vm.geo(for: s.staffId),
                    alertCount: vm.alerts(for: s.staffId).count,
                    onTap: { selected = s })
            }
        }
    }

    // ── Productivity alerts (web "⚡ Productivity" block) ──

    @ViewBuilder private var alertsSection: some View {
        if let alerts = vm.data?.productivityAlerts, !alerts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("⚡ Productivity")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(Array(alerts.enumerated()), id: \.offset) { _, a in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(a.staffName ?? "—").font(.caption.weight(.bold))
                        Text(a.message).font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: 16)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("👥").font(.largeTitle)
            Text("আজকে কোনো স্টাফ অ্যাক্টিভ নেই।")
                .foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    // ── Shared bits ──

    private func staffMonitorChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? StaffMonitorPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? StaffMonitorPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? StaffMonitorPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Label("লোড করা যায়নি: \(message)", systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(StaffMonitorPalette.red500)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("আবার চেষ্টা") { Task { await vm.load() } }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(StaffMonitorPalette.coral)
        }
        .padding(12)
        .staffMonitorGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .staffMonitorGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .staffMonitorGlass(colorScheme, corner: 16)
                .staffMonitorShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/staff-monitor", "Staff monitor")
        } label: {
            Label("সব কন্ট্রোল ও অ্যাকশন (টাস্ক দাও • মেসেজ • এসকালেট) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Staff card (web MonitorStaffCards / MonitorStaffHub row parity)

@available(iOS 17.0, *)
private struct StaffMonitorCard: View {
    let summary: StaffMonitorSummary
    let geo: StaffMonitorGeo?
    let alertCount: Int
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let status = StaffMonitorPalette.status(summary)
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 10) {
                StaffMonitorAvatar(name: summary.staffName, dot: status.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.staffName).font(.footnote.weight(.semibold)).lineLimit(1)
                    locationLine
                }
                Spacer(minLength: 4)
                Text(status.label)
                    .font(.system(size: 9, weight: .bold))
                    .textCase(.uppercase)
                    .foregroundStyle(status.color)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(status.color.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(status.color.opacity(0.30), lineWidth: 0.8))
            }

            // Day-progress bar (web: coral→teal gradient + tabular % on the right)
            HStack(spacing: 8) {
                StaffMonitorProgressBar(percent: summary.completionPct)
                Text("\(summary.completionPct)%")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Text("📤 \(summary.dispatched)").font(.caption2).foregroundStyle(.secondary)
                Text("✓ \(summary.delivered)").font(.caption2).foregroundStyle(.secondary)
                if summary.failed > 0 {
                    Text("✗ \(summary.failed)").font(.caption2.weight(.bold))
                        .foregroundStyle(StaffMonitorPalette.red500)
                }
                if alertCount > 0 {
                    Text("⚡ \(alertCount)").font(.caption2.weight(.bold))
                        .foregroundStyle(StaffMonitorPalette.amber600)
                }
                Spacer()
                Text("🎯 \(summary.tasksDone)/\(summary.tasksTotal)")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Location line: geo-fence state (Bangla verbatim) + relative last-seen time.
    private var locationLine: some View {
        let g = StaffMonitorPalette.geo(geo?.status)
        var text = "\(g.icon) \(g.text)"
        if geo?.status == "outside", let d = geo?.distanceM { text += " (\(d)m)" }
        let seen = geo?.lastUpdate ?? summary.lastActivityAt
        if let ago = StaffMonitorFormat.timeAgo(seen), !ago.isEmpty { text += " · \(ago)" }
        return Text(text).font(.caption2).foregroundStyle(g.color).lineLimit(1)
    }
}

/// Initials avatar + live status dot (web StaffInitial + dot overlay).
@available(iOS 17.0, *)
private struct StaffMonitorAvatar: View {
    let name: String
    let dot: Color

    var body: some View {
        Text(StaffMonitorFormat.initials(name))
            .font(.subheadline.weight(.black))
            .foregroundStyle(StaffMonitorPalette.coral)
            .frame(width: 38, height: 38)
            .background(
                LinearGradient(colors: [StaffMonitorPalette.coral.opacity(0.20),
                                        StaffMonitorPalette.teal.opacity(0.10)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Circle())
            .overlay(Circle().strokeBorder(StaffMonitorPalette.coral.opacity(0.25), lineWidth: 1))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(dot)
                    .frame(width: 11, height: 11)
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1.6))
                    .shadow(color: dot.opacity(0.55), radius: 3)
                    .offset(x: 1.5, y: 1.5)
            }
    }
}

/// Web progress bar: coral→teal gradient fill on a faint track.
@available(iOS 17.0, *)
private struct StaffMonitorProgressBar: View {
    let percent: Int

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if percent > 0 {
                    Capsule()
                        .fill(LinearGradient(colors: [StaffMonitorPalette.coral, StaffMonitorPalette.teal],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, geo.size.width * CGFloat(min(percent, 100)) / 100))
                }
            }
        }
        .frame(height: 6)
    }
}

// MARK: - Detail sheet (per-staff: progress · location · alerts · today's messages)

@available(iOS 17.0, *)
private struct StaffMonitorDetailSheet: View {
    let summary: StaffMonitorSummary
    let vm: StaffMonitorVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var geo: StaffMonitorGeo? { vm.geo(for: summary.staffId) }
    private var alerts: [StaffMonitorAlert] { vm.alerts(for: summary.staffId) }
    private var messages: [StaffMonitorFeedRow] { vm.messages(for: summary.staffId) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                progressCard
                locationCard
                if !alerts.isEmpty { alertsCard }
                messagesCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { StaffMonitorAurora() }
    }

    private var header: some View {
        let status = StaffMonitorPalette.status(summary)
        return HStack(spacing: 12) {
            StaffMonitorAvatar(name: summary.staffName, dot: status.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.staffName).font(.headline)
                HStack(spacing: 6) {
                    Text(status.label)
                        .font(.caption2.weight(.heavy)).textCase(.uppercase)
                        .foregroundStyle(status.color)
                    if let ago = StaffMonitorFormat.timeAgo(summary.lastActivityAt), !ago.isEmpty {
                        Text("· \(ago)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
        }
    }

    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আজকের অগ্রগতি")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Text("\(summary.completionPct)%")
                    .font(.title3.weight(.bold).monospacedDigit())
                    .foregroundStyle(summary.completionPct >= 100
                                     ? StaffMonitorPalette.emerald600
                                     : StaffMonitorPalette.accentText(colorScheme))
                StaffMonitorProgressBar(percent: summary.completionPct)
            }
            HStack(spacing: 0) {
                statCell("📤", "\(summary.dispatched)", "Dispatched")
                statCell("✓", "\(summary.delivered)", "Delivered")
                statCell("✗", "\(summary.failed)", "Failed",
                         tint: summary.failed > 0 ? StaffMonitorPalette.red500 : .secondary)
                statCell("🎯", "\(summary.tasksDone)/\(summary.tasksTotal)", "Tasks")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: 14)
    }

    private func statCell(_ icon: String, _ value: String, _ label: String,
                          tint: Color = .primary) -> some View {
        VStack(spacing: 2) {
            Text(icon).font(.caption)
            Text(value).font(.footnote.weight(.bold).monospacedDigit()).foregroundStyle(tint)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var locationCard: some View {
        let g = StaffMonitorPalette.geo(geo?.status)
        return VStack(alignment: .leading, spacing: 6) {
            Text("লোকেশন")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text("\(g.icon) \(g.text)\(geo?.status == "outside" ? (geo?.distanceM).map { " (\($0)m)" } ?? "" : "")")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(g.color)
                Spacer()
                if let link = geo?.mapsLink, let url = URL(string: link) {
                    Link(destination: url) {
                        Label("ম্যাপ", systemImage: "map")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                    }
                }
            }
            if let ago = StaffMonitorFormat.timeAgo(geo?.lastUpdate), !ago.isEmpty {
                Text("শেষ আপডেট \(ago)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: 14)
    }

    private var alertsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("⚡ Productivity")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            ForEach(Array(alerts.enumerated()), id: \.offset) { _, a in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(a.message).font(.caption).foregroundStyle(StaffMonitorPalette.amber600)
                    Spacer(minLength: 0)
                    if let t = StaffMonitorFormat.clock(a.at) {
                        Text(t).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: 14)
    }

    private var messagesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আজকের মেসেজ")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            if messages.isEmpty {
                Text("এই স্টাফের অতিরিক্ত ডেটা এখনও নেই।")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(messages.prefix(12)) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(m.typeLabel)
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(StaffMonitorPalette.coral.opacity(0.12), in: Capsule())
                            if let t = StaffMonitorFormat.clock(m.sentAt ?? m.createdAt) {
                                Text(t).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Spacer()
                            ackBadge(m)
                        }
                        Text(m.content)
                            .font(.caption)
                            .foregroundStyle(.primary.opacity(0.85))
                            .lineLimit(4)
                    }
                    .padding(.vertical, 2)
                    if m.id != messages.prefix(12).last?.id { Divider().opacity(0.4) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: 14)
    }

    /// Web AckBadge parity: ✓ time · ⏳ unseen · sending…
    @ViewBuilder private func ackBadge(_ m: StaffMonitorFeedRow) -> some View {
        if let ack = m.acknowledgedAt, let t = StaffMonitorFormat.clock(ack) {
            Text("✓ \(t)")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(StaffMonitorPalette.emerald600)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(StaffMonitorPalette.emerald600.opacity(0.10), in: Capsule())
        } else if m.status == "delivered" || m.status == "sent" {
            Text("⏳ unseen")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(StaffMonitorPalette.amber600)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(StaffMonitorPalette.amber500.opacity(0.10), in: Capsule())
        } else if m.status == "queued" || m.status == "pending" {
            Text("sending…")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/agent/staff-monitor", "Staff monitor")
        } label: {
            Label("টাস্ক দাও • মেসেজ • এসকালেট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum StaffMonitorFormat {
    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Web fmtTime: HH:mm in Asia/Dhaka.
    static func clock(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Bangla relative time — the app's shared strings.
    static func timeAgo(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    /// Web StaffInitial: single first letter, uppercased.
    static func initials(_ name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }
}

// MARK: - Aurora background + glass (StaffMonitor-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct StaffMonitorAurora: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.075, green: 0.063, blue: 0.196), location: 0.0),  // deep indigo
                    .init(color: Color(red: 0.216, green: 0.125, blue: 0.439), location: 0.32), // violet
                    .init(color: Color(red: 0.478, green: 0.176, blue: 0.494), location: 0.62), // purple-magenta
                    .init(color: Color(red: 0.706, green: 0.255, blue: 0.404), location: 1.0),  // pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.35), .clear],
                               center: .init(x: 0.15, y: 0.18), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.93, green: 0.42, blue: 0.55).opacity(0.30), .clear],
                               center: .init(x: 0.9, y: 0.85), startRadius: 20, endRadius: 480)
            } else {
                AlmaSwiftTheme.rootBg(.light)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.902, green: 0.882, blue: 0.973), location: 0.0),  // pale violet
                    .init(color: Color(red: 0.949, green: 0.941, blue: 0.972), location: 0.45), // cream
                    .init(color: Color(red: 0.988, green: 0.918, blue: 0.925), location: 1.0),  // pale pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.14), .clear],
                               center: .init(x: 0.12, y: 0.15), startRadius: 10, endRadius: 380)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.12), .clear],
                               center: .init(x: 0.9, y: 0.9), startRadius: 20, endRadius: 420)
            }
        }
        .ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func staffMonitorGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct StaffMonitorShimmer: ViewModifier {
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
    func staffMonitorShimmer() -> some View { modifier(StaffMonitorShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Staff Monitor — Light") {
    StaffMonitorScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
