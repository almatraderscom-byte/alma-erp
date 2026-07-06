//
//  BusinessArchiveSwiftUI.swift
//  ALMA ERP — Business Archive Control as a native SwiftUI screen (read-only).
//
//  Mirrors the web /operations/business-archive page's read side — same endpoints:
//    GET /api/business-archive/modules?business_id=…  → module registry + active/archived stats
//                                                       (+ schemaReady, migrationHint, warning)
//    GET /api/business-archive/batches?business_id=…  → archive batch history
//  Blocks: business picker chips · safety-mode card · schema-migration card ·
//  "Active vs archived stats" as a Files-app-like grouped list (SF Symbol doc icons) ·
//  Archive history list · module + batch detail sheets.
//  STRICTLY READ-ONLY: preview / execute / restore are destructive-adjacent Super-Admin
//  flows (typed confirmation phrase on web) — every mutation escapes to the web page.
//  Carried lessons: lenient decoding, cancellation-aware refresh, no global spinner.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum BusinessArchivePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Batch status → web tone: COMPLETED emerald · RESTORED muted · else amber.
    static func batchStatus(_ s: String?) -> Color {
        switch s {
        case "COMPLETED": return emerald600
        case "RESTORED": return .secondary
        case "FAILED": return red500
        default: return amber600
        }
    }
}

// MARK: - Models (same field names the web page types declare)

struct BusinessArchiveModule: Decodable, Identifiable, Equatable {
    let key: String
    let label: String?
    let detail: String?          // web "description"
    let storage: String?
    let integrationNote: String?

    var id: String { key }

    private enum Keys: String, CodingKey { case key, label, description, storage, integrationNote }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = (try? c.decode(String.self, forKey: .key)) ?? ""
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        detail = try? c.decodeIfPresent(String.self, forKey: .description)
        storage = try? c.decodeIfPresent(String.self, forKey: .storage)
        integrationNote = try? c.decodeIfPresent(String.self, forKey: .integrationNote)
    }

    /// Files-app feel: one SF Symbol document icon per module.
    var iconName: String {
        switch key {
        case "approvals": return "checkmark.seal"
        case "attendance": return "clock"
        case "attendance_waivers": return "clock.badge.exclamationmark"
        case "wallet_requests": return "wallet.pass"
        case "expenses": return "creditcard"
        case "invoices": return "doc.text"
        case "trading_trades": return "chart.line.uptrend.xyaxis"
        case "trading_expenses": return "banknote"
        case "telegram_drafts": return "paperplane"
        case "orders": return "shippingbox"
        case "inventory": return "square.stack.3d.up"
        case "crm": return "person.2"
        default: return "doc"
        }
    }
}

struct BusinessArchiveStat: Decodable, Identifiable, Equatable {
    let moduleKey: String
    let label: String?
    let activeCount: Int
    let archivedCount: Int
    let available: Bool?
    let warning: String?

    var id: String { moduleKey }

    private enum Keys: String, CodingKey { case moduleKey, label, activeCount, archivedCount, available, warning }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        moduleKey = (try? c.decode(String.self, forKey: .moduleKey)) ?? ""
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        activeCount = Self.flexInt(c, .activeCount) ?? 0
        archivedCount = Self.flexInt(c, .archivedCount) ?? 0
        available = try? c.decodeIfPresent(Bool.self, forKey: .available)
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct BusinessArchiveBatch: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let businessId: String?
    let moduleKeys: [String]
    let status: String?
    let recordCount: Int?
    let entityCount: Int?
    let createdAt: String?
    let completedAt: String?
    let restoredAt: String?

    private enum Keys: String, CodingKey {
        case id, name, businessId, moduleKeys, status, recordCount, entityCount
        case createdAt, completedAt, restoredAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        if let arr = try? c.decodeIfPresent([String].self, forKey: .moduleKeys) {
            moduleKeys = arr
        } else if let joined = try? c.decodeIfPresent(String.self, forKey: .moduleKeys) {
            moduleKeys = joined.split(separator: ",").map(String.init)
        } else {
            moduleKeys = []
        }
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        recordCount = Self.flexInt(c, .recordCount)
        entityCount = Self.flexInt(c, .entityCount)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        completedAt = try? c.decodeIfPresent(String.self, forKey: .completedAt)
        restoredAt = try? c.decodeIfPresent(String.self, forKey: .restoredAt)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    static func == (a: BusinessArchiveBatch, b: BusinessArchiveBatch) -> Bool {
        a.id == b.id && a.status == b.status
    }
}

/// /api/business-archive/modules wraps via apiDataSuccess → `{ ok, data: {…} }`;
/// decode both wrapped and flat shapes (pattern carried from the approvals routes).
struct BusinessArchiveModulesResponse: Decodable {
    let modules: [BusinessArchiveModule]
    let stats: [BusinessArchiveStat]
    let schemaReady: Bool?
    let migrationHint: String?
    let partialFailure: Bool?
    let warning: String?

    private enum Keys: String, CodingKey {
        case ok, data, modules, stats, schemaReady, migrationHint, partialFailure, warning
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        modules = (try? c.decode([BusinessArchiveModule].self, forKey: .modules)) ?? []
        stats = (try? c.decode([BusinessArchiveStat].self, forKey: .stats)) ?? []
        schemaReady = try? c.decodeIfPresent(Bool.self, forKey: .schemaReady)
        migrationHint = try? c.decodeIfPresent(String.self, forKey: .migrationHint)
        partialFailure = try? c.decodeIfPresent(Bool.self, forKey: .partialFailure)
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
    }
}

/// /api/business-archive/batches answers flat `{ ok, batches, audit, warning? }`.
struct BusinessArchiveBatchesResponse: Decodable {
    let batches: [BusinessArchiveBatch]
    let warning: String?

    private enum Keys: String, CodingKey { case ok, data, batches, warning }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        batches = (try? c.decode([BusinessArchiveBatch].self, forKey: .batches)) ?? []
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
    }
}

/// The web page's business picker options (BUSINESS_LIST parity).
struct BusinessArchiveBusiness: Identifiable, Equatable {
    let id: String
    let name: String

    static let all: [BusinessArchiveBusiness] = [
        .init(id: "ALMA_LIFESTYLE", name: "Alma Lifestyle"),
        .init(id: "CREATIVE_DIGITAL_IT", name: "Creative Digital IT"),
        .init(id: "ALMA_TRADING", name: "Alma Trading"),
    ]
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class BusinessArchiveVM {
    var businessId = "ALMA_LIFESTYLE"     // web DEFAULT_BUSINESS_ID
    var modules: [BusinessArchiveModule] = []
    var stats: [BusinessArchiveStat] = []
    var batches: [BusinessArchiveBatch] = []
    var schemaReady = true
    var migrationHint: String? = nil
    var loadWarning: String? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func stat(for key: String) -> BusinessArchiveStat? {
        stats.first { $0.moduleKey == key }
    }

    var totalArchived: Int { stats.reduce(0) { $0 + $1.archivedCount } }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let modulesCall: BusinessArchiveModulesResponse = AlmaAPI.shared.get(
                "/api/business-archive/modules", query: ["business_id": businessId])
            async let batchesCall: BusinessArchiveBatchesResponse = AlmaAPI.shared.get(
                "/api/business-archive/batches", query: ["business_id": businessId])
            let (m, b) = try await (modulesCall, batchesCall)
            modules = m.modules
            stats = m.stats
            schemaReady = m.schemaReady ?? true
            migrationHint = m.migrationHint
            loadWarning = m.warning ?? b.warning
            batches = b.batches
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
struct BusinessArchiveScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = BusinessArchiveVM()
    @State private var selectedModule: BusinessArchiveModule? = nil
    @State private var selectedBatch: BusinessArchiveBatch? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                businessChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let warn = vm.loadWarning { noticeCard(warn, tone: .warning) }
                if !vm.schemaReady { migrationCard }
                safetyCard
                if vm.loading && vm.modules.isEmpty { loadingRows }
                if !vm.modules.isEmpty { modulesSection }
                historySection
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(BusinessArchiveAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selectedModule) { m in
            BusinessArchiveModuleSheet(module: m, stat: vm.stat(for: m.key), openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $selectedBatch) { b in
            BusinessArchiveBatchSheet(batch: b, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Business picker (web Step 1 · Business select) ──

    private var businessChips: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(BusinessArchiveBusiness.all) { b in
                        archiveChip(b.name, active: vm.businessId == b.id) {
                            vm.businessId = b.id
                            Task { await vm.load() }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
            if vm.totalArchived > 0 {
                Text("\(vm.totalArchived)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(BusinessArchivePalette.accentText(colorScheme))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(BusinessArchivePalette.coral.opacity(0.18), in: Capsule())
                    .overlay(Capsule().strokeBorder(BusinessArchivePalette.coral.opacity(0.4), lineWidth: 1))
            }
        }
        .padding(.top, 4)
    }

    // ── Safety / migration cards (web tone-amber / tone-red cards) ──

    /// Web "Safety mode" card, same copy.
    private var safetyCard: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label("Safety mode", systemImage: "shield.lefthalf.filled")
                .font(.footnote.weight(.bold))
                .foregroundStyle(BusinessArchivePalette.amber600)
            Text("This never permanently deletes records. Archived items are hidden from default views. Use archive_visibility=archived on APIs or Show Archived in UI.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(BusinessArchivePalette.amber500.opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(BusinessArchivePalette.amber500.opacity(0.25), lineWidth: 1))
    }

    /// Web "Database migration required" card, same copy.
    private var migrationCard: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label("Database migration required", systemImage: "exclamationmark.octagon")
                .font(.footnote.weight(.bold))
                .foregroundStyle(BusinessArchivePalette.red500)
            Text("\(vm.migrationHint ?? "Business Archive tables are not on this database yet.") ERP continues normally; run migrations on production to enable archive features.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(BusinessArchivePalette.red500.opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(BusinessArchivePalette.red500.opacity(0.25), lineWidth: 1))
    }

    // ── Modules (web "Active vs archived stats" as a Files-style grouped list) ──

    private var modulesSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Active vs archived stats")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 6)
            ForEach(Array(vm.modules.enumerated()), id: \.element.id) { index, m in
                BusinessArchiveModuleRow(
                    module: m,
                    stat: vm.stat(for: m.key),
                    onTap: { selectedModule = m })
                if index < vm.modules.count - 1 {
                    Divider().padding(.leading, 58)
                }
            }
            Color.clear.frame(height: 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .businessArchiveGlass(colorScheme, corner: 16)
    }

    // ── Archive history (web batch list) ──

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Archive history")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 6)
            if vm.batches.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "archivebox").font(.title2).foregroundStyle(.secondary)
                    Text(vm.loading ? "লোড হচ্ছে…" : "No archive batches yet.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                ForEach(Array(vm.batches.enumerated()), id: \.element.id) { index, b in
                    BusinessArchiveBatchRow(batch: b, onTap: { selectedBatch = b })
                    if index < vm.batches.count - 1 {
                        Divider().padding(.leading, 58)
                    }
                }
                Color.clear.frame(height: 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .businessArchiveGlass(colorScheme, corner: 16)
    }

    // ── Shared bits ──

    private func archiveChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? BusinessArchivePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? BusinessArchivePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? BusinessArchivePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, warning }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", BusinessArchivePalette.red500)
        case .warning: ("exclamationmark.circle", BusinessArchivePalette.amber600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).businessArchiveGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .businessArchiveGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .businessArchiveGlass(colorScheme, corner: 16)
                .businessArchiveShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/operations/business-archive", "Business archive")
        } label: {
            Label("আর্কাইভ / রিস্টোর করতে — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Module row (Files-app style: icon square + name + counts + chevron)

@available(iOS 17.0, *)
private struct BusinessArchiveModuleRow: View {
    let module: BusinessArchiveModule
    let stat: BusinessArchiveStat?
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var unavailable: Bool { stat?.available == false }

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: module.iconName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(BusinessArchivePalette.accentText(colorScheme))
                    .frame(width: 34, height: 34)
                    .background(BusinessArchivePalette.coral.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(BusinessArchivePalette.coral.opacity(0.28), lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(module.label ?? module.key)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                    // Web row: Active <emerald> · Archived <amber>
                    HStack(spacing: 4) {
                        Text("Active").font(.caption2).foregroundStyle(.secondary)
                        Text("\((stat?.activeCount ?? 0).formatted())")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(BusinessArchivePalette.emerald600)
                        Text("· Archived").font(.caption2).foregroundStyle(.secondary)
                        Text("\((stat?.archivedCount ?? 0).formatted())")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(BusinessArchivePalette.amber600)
                    }
                    if let warn = stat?.warning ?? module.integrationNote, !warn.isEmpty {
                        Text(warn)
                            .font(.system(size: 10))
                            .foregroundStyle(BusinessArchivePalette.amber600)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if unavailable {
                    Text("N/A")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .opacity(unavailable ? 0.7 : 1)   // web: unavailable modules render dimmed
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Batch row (archive history entry)

@available(iOS 17.0, *)
private struct BusinessArchiveBatchRow: View {
    let batch: BusinessArchiveBatch
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: batch.restoredAt != nil ? "arrow.uturn.backward.circle" : "archivebox")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(BusinessArchivePalette.accentText(colorScheme))
                    .frame(width: 34, height: 34)
                    .background(BusinessArchivePalette.coral.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(BusinessArchivePalette.coral.opacity(0.28), lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(batch.name ?? "—")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    // Web line: moduleKeys.join(', ') · recordCount records · status
                    Text("\(batch.moduleKeys.joined(separator: ", ")) · \((batch.recordCount ?? 0).formatted()) records")
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let d = BusinessArchiveFormat.dateTime(batch.createdAt) {
                        Text(d).font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 4)
                Text(batch.status ?? "—")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(BusinessArchivePalette.batchStatus(batch.status))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(BusinessArchivePalette.batchStatus(batch.status).opacity(0.10), in: Capsule())
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Module detail sheet (read-only; archive actions escape to web)

@available(iOS 17.0, *)
private struct BusinessArchiveModuleSheet: View {
    let module: BusinessArchiveModule
    let stat: BusinessArchiveStat?
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: module.iconName)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(BusinessArchivePalette.accentText(colorScheme))
                        .frame(width: 46, height: 46)
                        .background(BusinessArchivePalette.coral.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(BusinessArchivePalette.coral.opacity(0.28), lineWidth: 1))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(module.label ?? module.key).font(.headline)
                        if let d = module.detail {
                            Text(d).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                HStack(spacing: 10) {
                    countCard("ACTIVE", stat?.activeCount ?? 0, BusinessArchivePalette.emerald600)
                    countCard("ARCHIVED", stat?.archivedCount ?? 0, BusinessArchivePalette.amber600)
                }

                VStack(alignment: .leading, spacing: 10) {
                    infoRow("Module key", module.key)
                    infoRow("Storage", module.storage ?? "—")
                    infoRow("Available", stat?.available == false ? "No" : "Yes",
                            color: stat?.available == false ? BusinessArchivePalette.amber600
                                                            : BusinessArchivePalette.emerald600)
                    if let warn = stat?.warning ?? module.integrationNote, !warn.isEmpty {
                        infoRow("Warning", warn, color: BusinessArchivePalette.amber600)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .businessArchiveGlass(colorScheme, corner: 14)

                Text("আর্কাইভ চালাতে (dry run · confirm phrase) ওয়েব পেজ ব্যবহার করুন — এই স্ক্রিনটি শুধু দেখার জন্য।")
                    .font(.caption2).foregroundStyle(.secondary)

                Button {
                    dismiss()
                    openWeb("/operations/business-archive", "Business archive")
                } label: {
                    Label("Archive Control — ওয়েবে খুলুন", systemImage: "safari")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(BusinessArchivePalette.coral)
            }
            .padding(18)
        }
        .presentationBackground { BusinessArchiveAurora() }
    }

    private func countCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text("\(value.formatted())").font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .businessArchiveGlass(colorScheme, corner: 14)
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }
}

// MARK: - Batch detail sheet (read-only; restore escapes to web)

@available(iOS 17.0, *)
private struct BusinessArchiveBatchSheet: View {
    let batch: BusinessArchiveBatch
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(batch.name ?? "—").font(.headline)
                    HStack(spacing: 6) {
                        Text(batch.status ?? "—")
                            .font(.caption2.weight(.heavy))
                            .foregroundStyle(BusinessArchivePalette.batchStatus(batch.status))
                        Text(BusinessArchiveFormat.dateTime(batch.createdAt) ?? "—")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    infoRow("Business", batch.businessId ?? "—")
                    infoRow("Modules", batch.moduleKeys.isEmpty ? "—" : batch.moduleKeys.joined(separator: ", "))
                    infoRow("Records", "\((batch.recordCount ?? 0).formatted())")
                    if let e = batch.entityCount {
                        infoRow("Archived entities", "\(e.formatted())")
                    }
                    infoRow("Created", BusinessArchiveFormat.dateTime(batch.createdAt) ?? "—")
                    if let d = BusinessArchiveFormat.dateTime(batch.completedAt) {
                        infoRow("Completed", d)
                    }
                    if let d = BusinessArchiveFormat.dateTime(batch.restoredAt) {
                        infoRow("Restored", d, color: BusinessArchivePalette.emerald600)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .businessArchiveGlass(colorScheme, corner: 14)

                if batch.status == "COMPLETED" {
                    Text("Restore batch চালাতে ওয়েব পেজ ব্যবহার করুন — এই স্ক্রিনটি শুধু দেখার জন্য।")
                        .font(.caption2).foregroundStyle(.secondary)
                }

                Button {
                    dismiss()
                    openWeb("/operations/business-archive", "Business archive")
                } label: {
                    Label(batch.status == "COMPLETED" ? "Restore — ওয়েবে খুলুন" : "Archive Control — ওয়েবে খুলুন",
                          systemImage: "safari")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(BusinessArchivePalette.coral)
            }
            .padding(18)
        }
        .presentationBackground { BusinessArchiveAurora() }
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum BusinessArchiveFormat {
    /// createdAt → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
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

// MARK: - Aurora background + glass (BusinessArchive-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct BusinessArchiveAurora: View {
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
    func businessArchiveGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct BusinessArchiveShimmer: ViewModifier {
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
    func businessArchiveShimmer() -> some View { modifier(BusinessArchiveShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Business archive — Light") {
    BusinessArchiveScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
