//
//  SystemDiagnosticsSwiftUI.swift
//  ALMA ERP — the /operations/system-diagnostics page as a native SwiftUI screen.
//
//  Mirrors the web page (READ-ONLY) — same endpoint, same blocks, same colours:
//    GET /api/operations/system-diagnostics?business_id=…   → whole diagnostics bundle
//  Web-parity blocks: System config (status-dot badges + red warning lines) ·
//  Telegram queue (by-status counts + pending/stuck/retry/dead-letter/latency/oldest) ·
//  Selfie photo storage last 24h (totals + recent rows with storage-type verdicts) ·
//  Recent Telegram delivery log (event/status/attempts/age/error rows).
//  The web POST actions (Process now / Retry failed / Retry single) MUTATE the queue,
//  so they deliberately stay on the web escape hatch — native only refreshes (GET).
//  Carried lessons: lenient decoding, ONE loading state, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SysDiagPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web StatusBadge map: QUEUED amber · SENDING blue · SENT green · FAILED red ·
    /// SKIPPED muted (blue reads as the theme violet on the aurora surface).
    static func queueStatus(_ s: String) -> Color {
        switch s {
        case "QUEUED": return amber600
        case "SENDING": return AlmaSwiftTheme.violet
        case "SENT": return emerald600
        case "FAILED": return red500
        default: return .secondary
        }
    }

    /// Web StorageTypeBadge: supabase ✓ green · inline_base64 ⚠ amber · unknown ✗ red.
    static func storageType(_ t: String?) -> (label: String, color: Color) {
        switch t {
        case "supabase": return ("supabase ✓", emerald600)
        case "inline_base64": return ("inline_base64 ⚠", amber600)
        default: return ("unknown ✗", red500)
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web DiagnosticsData type declares)

struct SysDiagStatusCount: Decodable, Equatable {
    let status: String
    let count: Int

    private enum Keys: String, CodingKey { case status, count }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        status = (try? c.decode(String.self, forKey: .status)) ?? "—"
        count = SysDiagFlex.int(c, .count) ?? 0
    }
}

struct SysDiagConfig: Decodable, Equatable {
    let botTokenConfigured: Bool
    let cronSecretConfigured: Bool
    let ownerChatIdsConfigured: Bool
    let ownerRoutingSource: String?
    let ownerChatIdsCount: Int?
    let storageConfigured: Bool

    private enum Keys: String, CodingKey {
        case botTokenConfigured, cronSecretConfigured, ownerChatIdsConfigured
        case ownerRoutingSource, ownerChatIdsCount, storageConfigured
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        botTokenConfigured = (try? c.decodeIfPresent(Bool.self, forKey: .botTokenConfigured)) ?? false
        cronSecretConfigured = (try? c.decodeIfPresent(Bool.self, forKey: .cronSecretConfigured)) ?? false
        ownerChatIdsConfigured = (try? c.decodeIfPresent(Bool.self, forKey: .ownerChatIdsConfigured)) ?? false
        ownerRoutingSource = try? c.decodeIfPresent(String.self, forKey: .ownerRoutingSource)
        ownerChatIdsCount = SysDiagFlex.int(c, .ownerChatIdsCount)
        storageConfigured = (try? c.decodeIfPresent(Bool.self, forKey: .storageConfigured)) ?? false
    }
}

struct SysDiagOldestQueued: Decodable, Equatable {
    let id: String?
    let eventType: String?
    let ageMinutes: Int?

    private enum Keys: String, CodingKey { case id, eventType, ageMinutes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        eventType = try? c.decodeIfPresent(String.self, forKey: .eventType)
        ageMinutes = SysDiagFlex.int(c, .ageMinutes)
    }
}

struct SysDiagTelegramQueue: Decodable, Equatable {
    let byStatus: [SysDiagStatusCount]
    let pendingDepth: Int
    let stuckSending: Int
    let processingCount: Int
    let retryWaitCount: Int
    let failedDeadLetter: Int?
    let maxAttempts: Int?
    let oldestQueued: SysDiagOldestQueued?
    let averageDeliveryLatencyMs: Int?

    private enum Keys: String, CodingKey {
        case byStatus, pendingDepth, stuckSending, processingCount, retryWaitCount
        case failedDeadLetter, maxAttempts, oldestQueued, averageDeliveryLatencyMs
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        byStatus = (try? c.decodeIfPresent([SysDiagStatusCount].self, forKey: .byStatus)) ?? []
        pendingDepth = SysDiagFlex.int(c, .pendingDepth) ?? 0
        stuckSending = SysDiagFlex.int(c, .stuckSending) ?? 0
        processingCount = SysDiagFlex.int(c, .processingCount) ?? 0
        retryWaitCount = SysDiagFlex.int(c, .retryWaitCount) ?? 0
        failedDeadLetter = SysDiagFlex.int(c, .failedDeadLetter)
        maxAttempts = SysDiagFlex.int(c, .maxAttempts)
        oldestQueued = try? c.decodeIfPresent(SysDiagOldestQueued.self, forKey: .oldestQueued)
        averageDeliveryLatencyMs = SysDiagFlex.int(c, .averageDeliveryLatencyMs)
    }
}

struct SysDiagSelfieLog: Decodable, Identifiable, Equatable {
    let id: String
    let employeeId: String?
    let capturedAt: String?
    let sizeBytes: Int?
    let storageType: String?
    let reviewedAt: String?

    private enum Keys: String, CodingKey {
        case id, employeeId, capturedAt, sizeBytes, storageType, reviewedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        capturedAt = try? c.decodeIfPresent(String.self, forKey: .capturedAt)
        sizeBytes = SysDiagFlex.int(c, .sizeBytes)
        storageType = try? c.decodeIfPresent(String.self, forKey: .storageType)
        reviewedAt = try? c.decodeIfPresent(String.self, forKey: .reviewedAt)
    }
}

struct SysDiagSelfieStorage: Decodable, Equatable {
    let last24hTotal: Int
    let missingStorageRefCount: Int
    let recentLogs: [SysDiagSelfieLog]

    private enum Keys: String, CodingKey { case last24hTotal, missingStorageRefCount, recentLogs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        last24hTotal = SysDiagFlex.int(c, .last24hTotal) ?? 0
        missingStorageRefCount = SysDiagFlex.int(c, .missingStorageRefCount) ?? 0
        recentLogs = (try? c.decodeIfPresent([SysDiagSelfieLog].self, forKey: .recentLogs)) ?? []
    }
}

struct SysDiagTelegramLog: Decodable, Identifiable, Equatable {
    let id: String
    let eventType: String?
    let status: String
    let attempts: Int?
    let maxAttempts: Int?
    let chatId: String?
    let createdAt: String?
    let sentAt: String?
    let errorMessage: String?
    let ageMinutes: Int?

    private enum Keys: String, CodingKey {
        case id, eventType, status, attempts, maxAttempts, chatId
        case createdAt, sentAt, errorMessage, ageMinutes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        eventType = try? c.decodeIfPresent(String.self, forKey: .eventType)
        status = (try? c.decode(String.self, forKey: .status)) ?? "—"
        attempts = SysDiagFlex.int(c, .attempts)
        maxAttempts = SysDiagFlex.int(c, .maxAttempts)
        chatId = try? c.decodeIfPresent(String.self, forKey: .chatId)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        sentAt = try? c.decodeIfPresent(String.self, forKey: .sentAt)
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .errorMessage)
        ageMinutes = SysDiagFlex.int(c, .ageMinutes)
    }
}

/// The route answers flat (`{ ok, generatedAt, config, … }`) today; decode a nested
/// `data` wrapper too in case the route is later moved onto apiDataSuccess.
struct SystemDiagnosticsResponse: Decodable {
    let generatedAt: String?
    let config: SysDiagConfig?
    let telegramQueue: SysDiagTelegramQueue?
    let selfieStorage: SysDiagSelfieStorage?
    let recentTelegramLogs: [SysDiagTelegramLog]

    private enum Keys: String, CodingKey {
        case ok, data, generatedAt, config, telegramQueue, selfieStorage, recentTelegramLogs
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)).flatMap {
            $0.contains(.config) || $0.contains(.telegramQueue) ? $0 : nil
        } ?? root
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        config = try? c.decodeIfPresent(SysDiagConfig.self, forKey: .config)
        telegramQueue = try? c.decodeIfPresent(SysDiagTelegramQueue.self, forKey: .telegramQueue)
        selfieStorage = try? c.decodeIfPresent(SysDiagSelfieStorage.self, forKey: .selfieStorage)
        recentTelegramLogs = (try? c.decodeIfPresent([SysDiagTelegramLog].self, forKey: .recentTelegramLogs)) ?? []
    }
}

/// Shared lenient number decoding — the ERP JSON mixes Int / Double / numeric strings.
private enum SysDiagFlex {
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SystemDiagnosticsVM {
    /// The same business the other native tabs scope to (web _businessId default).
    static let businessId = "ALMA_LIFESTYLE"

    var data: SystemDiagnosticsResponse? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: SystemDiagnosticsResponse = try await AlmaAPI.shared.get(
                "/api/operations/system-diagnostics",
                query: ["business_id": Self.businessId])
            data = resp
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch AlmaAPIError.http(let status, _) where status == 403 {
            // The route is SUPER_ADMIN-only — same wording the web toast surfaces.
            self.error = "SUPER_ADMIN only"
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
struct SystemDiagnosticsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SystemDiagnosticsVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                headerRow
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if vm.loading && vm.data == nil {
                    loadingRows
                } else if let d = vm.data {
                    configCard(d)
                    telegramQueueCard(d.telegramQueue)
                    selfieStorageCard(d.selfieStorage)
                    telegramLogCard(d.recentTelegramLogs, generatedAt: d.generatedAt)
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SystemDiagnosticsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Header (web PageHeader subtitle + Refresh action) ──

    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Telegram queue এবং photo storage-এর read-only অবস্থা। SUPER_ADMIN only.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await vm.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .systemDiagnosticsGlass(colorScheme, corner: 12)
            }
            .buttonStyle(.plain)
            .disabled(vm.loading)
        }
        .padding(.top, 4)
    }

    // ── System config (web ConfigBadge dots + red warning lines) ──

    private func configCard(_ d: SystemDiagnosticsResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("System config")
            statusDotRow("Telegram Bot Token", ok: d.config?.botTokenConfigured ?? false)
            statusDotRow("CRON_SECRET", ok: d.config?.cronSecretConfigured ?? false)
            statusDotRow("Owner Chat IDs", ok: d.config?.ownerChatIdsConfigured ?? false,
                         trailing: (d.config?.ownerChatIdsCount).map { "\($0)" })
            statusDotRow("Supabase Storage", ok: d.config?.storageConfigured ?? false)

            if d.config?.cronSecretConfigured == false {
                warningLine("⚠ CRON_SECRET is not set — Vercel cron job will return 500 and no Telegram rows will be processed automatically. Set CRON_SECRET in Vercel environment variables.")
            }
            if d.config?.botTokenConfigured == false {
                warningLine("⚠ TELEGRAM_BOT_TOKEN is missing — all deliveries will fail immediately.")
            }
            if d.config?.ownerChatIdsConfigured == false {
                warningLine("⚠ No owner Telegram chat IDs (DB or TELEGRAM_OWNER_CHAT_IDS env) — check-in alerts are skipped at enqueue. Configure IDs in Settings → Telegram Ops.")
            }
            if d.config?.ownerRoutingSource == "disabled" {
                warningLine("⚠ Telegram ops is disabled for this business — notifications will not enqueue.",
                            color: SysDiagPalette.amber600)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .systemDiagnosticsGlass(colorScheme, corner: 16)
    }

    /// Web ConfigBadge, re-set as a native status-dot service row.
    private func statusDotRow(_ label: String, ok: Bool, trailing: String? = nil) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(ok ? SysDiagPalette.emerald600 : SysDiagPalette.red500)
                .frame(width: 8, height: 8)
                .shadow(color: (ok ? SysDiagPalette.emerald600 : SysDiagPalette.red500).opacity(0.6),
                        radius: 3)
            Text(label)
                .font(.footnote.weight(.semibold))
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(ok ? "OK" : "MISSING")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(ok ? SysDiagPalette.emerald600 : SysDiagPalette.red500)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background((ok ? SysDiagPalette.emerald600 : SysDiagPalette.red500).opacity(0.12),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    (ok ? SysDiagPalette.emerald600 : SysDiagPalette.red500).opacity(0.35),
                    lineWidth: 1))
        }
    }

    private func warningLine(_ text: String, color: Color = SysDiagPalette.red500) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }

    // ── Telegram queue (web by-status grid + health metric tiles) ──

    private func telegramQueueCard(_ q: SysDiagTelegramQueue?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Telegram queue")

            if let counts = q?.byStatus, !counts.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(counts, id: \.status) { s in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(SysDiagPalette.queueStatus(s.status))
                                        .frame(width: 6, height: 6)
                                    Text(s.status)
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                Text("\(s.count)")
                                    .font(.headline.weight(.bold).monospacedDigit())
                                    .foregroundStyle(SysDiagPalette.queueStatus(s.status))
                            }
                            .frame(minWidth: 78, alignment: .leading)
                            .padding(10)
                            .systemDiagnosticsGlass(colorScheme, corner: 12)
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.vertical, 1)
                }
            }

            let pending = q?.pendingDepth ?? 0
            let stuck = q?.stuckSending ?? 0
            let dead = q?.failedDeadLetter ?? 0
            metricRow("Pending depth", "\(pending)",
                      color: pending > 0 ? SysDiagPalette.amber600 : SysDiagPalette.emerald600)
            metricRow("Stuck sending", "\(stuck)",
                      color: stuck > 0 ? SysDiagPalette.red500 : SysDiagPalette.emerald600)
            metricRow("Retry wait", "\(q?.retryWaitCount ?? 0)")
            metricRow("Dead letter (max attempts)",
                      "\(dead)\((q?.maxAttempts).map { " / \($0)" } ?? "")",
                      color: dead > 0 ? SysDiagPalette.red500 : SysDiagPalette.emerald600)
            metricRow("Avg delivery latency",
                      (q?.averageDeliveryLatencyMs).map { "\($0)ms" } ?? "N/A")
            if let oldest = q?.oldestQueued, oldest.eventType != nil || oldest.ageMinutes != nil {
                metricRow("Oldest pending",
                          "\(oldest.eventType ?? "—") · \(oldest.ageMinutes ?? 0)min ago",
                          color: SysDiagPalette.amber600)
            } else {
                metricRow("Oldest pending", "None", color: SysDiagPalette.emerald600)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .systemDiagnosticsGlass(colorScheme, corner: 16)
    }

    private func metricRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.footnote.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        }
    }

    // ── Selfie photo storage (last 24h) ──

    private func selfieStorageCard(_ s: SysDiagSelfieStorage?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Selfie photo storage (last 24h)")

            HStack(spacing: 10) {
                selfieKpi("Total selfies", "\(s?.last24hTotal ?? 0)", color: .primary)
                selfieKpi("Missing storage ref", "\(s?.missingStorageRefCount ?? 0)",
                          color: (s?.missingStorageRefCount ?? 0) > 0
                              ? SysDiagPalette.red500 : SysDiagPalette.emerald600)
            }

            if let missing = s?.missingStorageRefCount, missing > 0 {
                warningLine("⚠ \(missing) selfie row(s) in the last 24h lack a valid Supabase storage reference. These may be legacy inline base64 rows. Telegram cannot deliver photos for these.")
            }

            if let logs = s?.recentLogs, !logs.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(logs.enumerated()), id: \.element.id) { idx, row in
                        selfieLogRow(row)
                        if idx < logs.count - 1 {
                            Divider().opacity(0.4)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .systemDiagnosticsGlass(colorScheme, corner: 16)
    }

    private func selfieKpi(_ label: String, _ value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(value)
                .font(.headline.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .systemDiagnosticsGlass(colorScheme, corner: 12)
    }

    private func selfieLogRow(_ row: SysDiagSelfieLog) -> some View {
        let storage = SysDiagPalette.storageType(row.storageType)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(row.employeeId ?? "—")
                    .font(.caption.weight(.bold).monospaced())
                Spacer()
                Text(storage.label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(storage.color)
            }
            HStack(spacing: 6) {
                if let size = row.sizeBytes {
                    Text("\(size / 1024)KB")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                if let captured = SysDiagFormat.dateTime(row.capturedAt) {
                    Text(captured).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(row.reviewedAt != nil ? "Reviewed ✓" : "Not reviewed")
                    .font(.caption2)
                    .foregroundStyle(row.reviewedAt != nil ? SysDiagPalette.emerald600 : Color.secondary)
            }
        }
        .padding(.vertical, 7)
    }

    // ── Recent Telegram delivery log ──

    private func telegramLogCard(_ logs: [SysDiagTelegramLog], generatedAt: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Recent Telegram delivery log")

            if logs.isEmpty {
                Text("No Telegram queue rows found.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(logs.enumerated()), id: \.element.id) { idx, row in
                        telegramLogRow(row)
                        if idx < logs.count - 1 {
                            Divider().opacity(0.4)
                        }
                    }
                }
            }

            if let gen = SysDiagFormat.dateTime(generatedAt) {
                Text("Generated \(gen) · Read-only diagnostics")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .systemDiagnosticsGlass(colorScheme, corner: 16)
    }

    private func telegramLogRow(_ row: SysDiagTelegramLog) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle()
                    .fill(SysDiagPalette.queueStatus(row.status))
                    .frame(width: 6, height: 6)
                Text((row.eventType ?? "—").replacingOccurrences(of: "ATTENDANCE_", with: ""))
                    .font(.caption.weight(.bold).monospaced())
                    .lineLimit(1)
                Spacer()
                Text(row.status)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(SysDiagPalette.queueStatus(row.status))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(SysDiagPalette.queueStatus(row.status).opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(
                        SysDiagPalette.queueStatus(row.status).opacity(0.35), lineWidth: 1))
            }
            HStack(spacing: 8) {
                if let attempts = row.attempts {
                    Text("\(attempts)/\(row.maxAttempts ?? 0)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                if let age = row.ageMinutes {
                    Text("\(age)m").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if let err = row.errorMessage, !err.isEmpty {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(SysDiagPalette.red500)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 7)
    }

    // ── Shared bits ──

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SysDiagPalette.red500)
        case .success: ("checkmark.circle", SysDiagPalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).systemDiagnosticsGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .systemDiagnosticsGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .systemDiagnosticsGlass(colorScheme, corner: 16)
                .systemDiagnosticsShimmer()
        }
    }

    /// The web page's mutating actions (Process now / Retry failed / Retry single)
    /// intentionally live ONLY behind this escape hatch.
    private var webEscape: some View {
        Button {
            openWeb("/operations/system-diagnostics", "System diagnostics")
        } label: {
            Label("সব অ্যাকশন (Process/Retry সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum SysDiagFormat {
    /// ISO string → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

// MARK: - Aurora background + glass (SystemDiagnostics-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SystemDiagnosticsAurora: View {
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
    func systemDiagnosticsGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SystemDiagnosticsShimmer: ViewModifier {
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
    func systemDiagnosticsShimmer() -> some View { modifier(SystemDiagnosticsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("System Diagnostics — Light") {
    SystemDiagnosticsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
