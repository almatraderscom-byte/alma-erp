//
//  SettingsSmsSwiftUI.swift
//  ALMA ERP — the /settings/sms page as a native SwiftUI screen (read-only).
//
//  Mirrors the web /settings/sms page — same endpoints, same colours, same blocks:
//    GET /api/sms/logs?business_id=…&status=…  → { logs, stats, catalog, setting }
//    GET /api/sms/balance                      → provider blob { balance, currency, … }
//  Native blocks: balance hero card (provider balance + master-switch state) ·
//  business chips · 5 KPI cards (Total/Delivered/Failed/Queued/Success) · SMS type
//  catalog (read-only, enabled ticks from setting.enabledTypes) · log rows with
//  delivery-status pills (sent/delivered emerald · failed red · queued/pending amber).
//  Sending test SMS, retry/report, and editing types stay on the web escape hatch.
//  Carried lessons: lenient decoding, ONE list shimmer, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsSmsPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Delivery pill: DELIVERED/SENT emerald · FAILED red · QUEUED/PENDING/SENDING amber.
    static func status(_ s: String) -> Color {
        switch s.uppercased() {
        case "DELIVERED", "SENT": return emerald600
        case "FAILED": return red500
        default: return amber500
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names /api/sms/logs returns)

struct SettingsSmsLogRow: Decodable, Identifiable, Equatable {
    let id: String
    let phone: String?
    let message: String?
    let type: String?
    let status: String
    let errorCode: String?
    let errorMessage: String?
    let requestId: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, phone, message, type, status, errorCode, errorMessage, requestId, createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        status = (try? c.decode(String.self, forKey: .status)) ?? "QUEUED"
        errorCode = try? c.decodeIfPresent(String.self, forKey: .errorCode)
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .errorMessage)
        requestId = try? c.decodeIfPresent(String.self, forKey: .requestId)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    static func == (a: SettingsSmsLogRow, b: SettingsSmsLogRow) -> Bool {
        a.id == b.id && a.status == b.status
    }
}

struct SettingsSmsStats: Decodable, Equatable {
    let total: Int
    let delivered: Int
    let failed: Int
    let queued: Int
    let successPct: Int

    private enum Keys: String, CodingKey { case total, delivered, failed, queued, successPct }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        total = Self.flexInt(c, .total) ?? 0
        delivered = Self.flexInt(c, .delivered) ?? 0
        failed = Self.flexInt(c, .failed) ?? 0
        queued = Self.flexInt(c, .queued) ?? 0
        successPct = Self.flexInt(c, .successPct) ?? 0
    }
    init() { total = 0; delivered = 0; failed = 0; queued = 0; successPct = 0 }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

/// smsSettingDto: { businessId, enabled, senderId, enabledTypes }.
struct SettingsSmsSetting: Decodable, Equatable {
    let businessId: String?
    let enabled: Bool
    let senderId: String?
    let enabledTypes: [String]

    private enum Keys: String, CodingKey { case businessId, enabled, senderId, enabledTypes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        senderId = try? c.decodeIfPresent(String.self, forKey: .senderId)
        enabledTypes = (try? c.decodeIfPresent([String].self, forKey: .enabledTypes)) ?? []
    }
}

/// One SMS_TYPE_CATALOG entry — the "template" list the web renders as checkboxes.
struct SettingsSmsCatalogItem: Decodable, Identifiable, Equatable {
    let type: String
    let label: String?
    let labelBn: String?
    let description: String?
    let audience: String?

    var id: String { type }

    private enum Keys: String, CodingKey { case type, label, labelBn, description, audience }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = (try? c.decode(String.self, forKey: .type)) ?? "—"
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        labelBn = try? c.decodeIfPresent(String.self, forKey: .labelBn)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        audience = try? c.decodeIfPresent(String.self, forKey: .audience)
    }
}

/// /api/sms/logs answers flat ({ logs, stats, catalog, setting }); decode the
/// wrapped { ok, data } shape too in case the route is ever normalized.
struct SettingsSmsLogsResponse: Decodable {
    let logs: [SettingsSmsLogRow]
    let stats: SettingsSmsStats
    let catalog: [SettingsSmsCatalogItem]
    let setting: SettingsSmsSetting?

    private enum Keys: String, CodingKey { case ok, data, logs, stats, catalog, setting }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        logs = (try? c.decode([SettingsSmsLogRow].self, forKey: .logs)) ?? []
        stats = (try? c.decode(SettingsSmsStats.self, forKey: .stats)) ?? SettingsSmsStats()
        catalog = (try? c.decode([SettingsSmsCatalogItem].self, forKey: .catalog)) ?? []
        setting = try? c.decodeIfPresent(SettingsSmsSetting.self, forKey: .setting)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsSmsVM {
    var logs: [SettingsSmsLogRow] = []
    var stats = SettingsSmsStats()
    var catalog: [SettingsSmsCatalogItem] = []
    var setting: SettingsSmsSetting? = nil
    var balanceText = "—"
    var businessId = "ALMA_LIFESTYLE"     // ALMA_LIFESTYLE | CREATIVE_DIGITAL_IT | ALMA_TRADING
    var statusFilter = "ALL"              // ALL | QUEUED | PENDING | SENDING | SENT | DELIVERED | FAILED
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: SettingsSmsLogsResponse = try await AlmaAPI.shared.get(
                "/api/sms/logs", query: ["business_id": businessId, "status": statusFilter])
            logs = resp.logs
            stats = resp.stats
            catalog = resp.catalog
            setting = resp.setting
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "SMS settings load failed — আবার চেষ্টা করুন"
        }
        await loadBalance()   // best-effort; a provider hiccup never blanks the page
    }

    /// The provider blob is free-form ({ balance: "123.45", currency: "BDT" }, or an
    /// error object) — mirror the web's balanceText logic over raw JSON.
    private func loadBalance() async {
        guard !authExpired else { return }
        do {
            let data = try await AlmaAPI.shared.getRaw("/api/sms/balance")
            balanceText = Self.balanceDisplay(data)
        } catch {
            if Self.isCancellation(error) { return }
            balanceText = "—"
        }
    }

    static func balanceDisplay(_ data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) else { return "—" }
        if let dict = json as? [String: Any] {
            let val = dict["balance"] ?? dict["amount"] ?? dict["credits"] ?? dict["sms_balance"]
            if let val {
                let cur = (dict["currency"] ?? dict["unit"]) as? String
                return cur != nil ? "\(val) \(cur!)" : "\(val)"
            }
        }
        if let s = json as? String { return s }
        if let n = json as? NSNumber { return n.stringValue }
        let text = String(data: data, encoding: .utf8) ?? "—"
        return text.count > 80 ? "\(text.prefix(80))..." : text
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
struct SettingsSmsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsSmsVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    /// BUSINESS_LIST names, same order as the web select.
    private static let businesses: [(id: String, name: String)] = [
        ("ALMA_LIFESTYLE", "Alma Lifestyle"),
        ("CREATIVE_DIGITAL_IT", "Creative Digital IT"),
        ("ALMA_TRADING", "Alma Trading"),
    ]
    private static let statuses = ["ALL", "QUEUED", "PENDING", "SENDING", "SENT", "DELIVERED", "FAILED"]

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                businessChips
                balanceHero
                kpiStrip
                templatesCard
                logsHeader
                if vm.loading && vm.logs.isEmpty { loadingRows }
                ForEach(vm.logs) { row in
                    SettingsSmsLogCard(row: row)
                }
                if !vm.loading && vm.logs.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsSmsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Business chips (the web's business select) ──

    private var businessChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.businesses, id: \.id) { b in
                    smsChip(b.name, active: vm.businessId == b.id) {
                        vm.businessId = b.id
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    // ── Balance hero (web "Business & master switch" card, re-set as an iOS hero) ──

    private var balanceHero: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "message.badge.filled.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(
                        LinearGradient(colors: [SettingsSmsPalette.coral, AlmaSwiftTheme.violet],
                                       startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .shadow(color: SettingsSmsPalette.coral.opacity(0.35), radius: 5, y: 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text("SMS BALANCE")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(.secondary)
                    Text(vm.balanceText)
                        .font(.title3.monospaced().weight(.bold))
                        .foregroundStyle(SettingsSmsPalette.accentText(colorScheme))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                Spacer(minLength: 4)
                masterSwitchPill
            }
            if let sender = vm.setting?.senderId, !sender.isEmpty {
                Text("Sender: \(sender)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            // Web hint, verbatim.
            Text("Recharge-এর পর Enable SMS চাপুন। Master switch বন্ধ থাকলে নিচের কোনো type চালু থাকলেও SMS যাবে না।")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Master switch state — read-only pill (toggling stays on the web).
    private var masterSwitchPill: some View {
        let on = vm.setting?.enabled == true
        return Text(on ? "SMS চালু" : "SMS বন্ধ")
            .font(.caption2.weight(.bold))
            .foregroundStyle(on ? SettingsSmsPalette.emerald600 : SettingsSmsPalette.red500)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background((on ? SettingsSmsPalette.emerald600 : SettingsSmsPalette.red500).opacity(0.12),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                (on ? SettingsSmsPalette.emerald600 : SettingsSmsPalette.red500).opacity(0.35),
                lineWidth: 1))
    }

    // ── KPI strip (web's 5 KpiCards: Total/Delivered/Failed/Queued/Success) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("TOTAL", "\(vm.stats.total)", .primary)
                kpiCard("DELIVERED", "\(vm.stats.delivered)", SettingsSmsPalette.emerald600)
                kpiCard("FAILED", "\(vm.stats.failed)", SettingsSmsPalette.red500)
                kpiCard("QUEUED", "\(vm.stats.queued)", SettingsSmsPalette.amber600)
                kpiCard("SUCCESS", "\(vm.stats.successPct)%", SettingsSmsPalette.goldLt)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    /// Light bento pass (owner spec 2026-07-08): tile skin with a soft accent wash
    /// of the KPI's own tint — same values, presentation only.
    private func kpiCard(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary)
            Text(value).font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background {
            LinearGradient(colors: [tint.opacity(colorScheme == .dark ? 0.14 : 0.10), .clear],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
        .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Templates (web "কোন SMS চালু থাকবে" card — read-only on iOS) ──

    private var templatesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("কোন SMS চালু থাকবে")
                    .font(.subheadline.weight(.bold))
                Spacer()
                Text("Read-only")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if vm.catalog.isEmpty {
                Text(vm.loading ? "Loading…" : "—")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.catalog) { item in
                    SettingsSmsTemplateRow(
                        item: item,
                        enabled: vm.setting?.enabledTypes.contains(item.type) == true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Logs header + status filter chips ──

    private var logsHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SMS logs")
                .font(.subheadline.weight(.bold))
                .padding(.top, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.statuses, id: \.self) { s in
                        smsChip(s == "ALL" ? "All" : s.capitalized, active: vm.statusFilter == s) {
                            vm.statusFilter = s
                            Task { await vm.load() }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "envelope").font(.largeTitle).foregroundStyle(.secondary)
            Text("No SMS logs yet.").foregroundStyle(.secondary)
        }
        .padding(.top, 40)
        .padding(.bottom, 20)
    }

    // ── Shared bits ──

    private func smsChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? SettingsSmsPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? SettingsSmsPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? SettingsSmsPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(SettingsSmsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsSmsShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/settings/sms", "SMS")
        } label: {
            Label("Test SMS পাঠানো ও type চালু/বন্ধ — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Template row (one SMS_TYPE_CATALOG entry, read-only tick)

@available(iOS 17.0, *)
private struct SettingsSmsTemplateRow: View {
    let item: SettingsSmsCatalogItem
    let enabled: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: enabled ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(enabled ? SettingsSmsPalette.emerald600 : Color.secondary.opacity(0.5))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.labelBn ?? item.label ?? item.type)
                    .font(.footnote.weight(.semibold))
                Text("\(item.label ?? "—") · \(item.type)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let desc = item.description, !desc.isEmpty {
                    Text(desc).font(.caption2).foregroundStyle(.secondary)
                }
                if let audience = item.audience, !audience.isEmpty {
                    Text("কে পাবে: \(audience)")
                        .font(.caption2)
                        .foregroundStyle(SettingsSmsPalette.accentText(colorScheme))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.04 : 0.30),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.35), lineWidth: 1))
    }
}

// MARK: - Log row card (one web table row as a native card)

@available(iOS 17.0, *)
private struct SettingsSmsLogCard: View {
    let row: SettingsSmsLogRow
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.phone ?? "—")
                    .font(.subheadline.monospaced().weight(.bold))
                Spacer()
                statusPill
            }
            Text(metaLine)
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let message = row.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(3)
            }
            if let code = row.errorCode, !code.isEmpty {
                Text(code)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(SettingsSmsPalette.red500)
            }
            if let msg = row.errorMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSmsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var metaLine: String {
        var bits: [String] = []
        if let d = SettingsSmsFormat.dateTime(row.createdAt) { bits.append(d) }
        if let t = row.type, !t.isEmpty { bits.append(t.replacingOccurrences(of: "_", with: " ")) }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    private var statusPill: some View {
        let tint = SettingsSmsPalette.status(row.status)
        return Text(row.status.uppercased())
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Formatting helpers (web util parity)

private enum SettingsSmsFormat {
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

// MARK: - Aurora background + glass (SettingsSms-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsSmsAurora: View {
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
    func settingsSmsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsSmsShimmer: ViewModifier {
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
    func settingsSmsShimmer() -> some View { modifier(SettingsSmsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("SMS Settings — Light") {
    SettingsSmsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
