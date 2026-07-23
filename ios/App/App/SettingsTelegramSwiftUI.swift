//
//  SettingsTelegramSwiftUI.swift
//  ALMA ERP — Telegram Ops settings as a native SwiftUI screen (read + native actions).
//
//  Mirrors the web /settings/telegram-ops page — same endpoints, same colours, same blocks:
//    GET /api/settings/telegram-ops?business_id=…        → {ok,data:{setting,recentQueue,stats}}
//    GET /api/settings/telegram-ops/health?business_id=… → {ok, ownerRouting, telegram, queue, delivery}
//  Blocks: business picker chips · health-stat grid (bot / webhook / owner routing /
//  queue depth / processing / retry wait / latency / stuck SENDING / failed / sent /
//  last success) · owner-routing diagnostics (chat IDs monospace) · recipients & master
//  switch (read-only) · schedule (BD) · alert toggles (read-only) · queue 7-day chips ·
//  last failure · recent queue rows.
//  NATIVE WRITES (NP-5, AD-07 complete): process queue (POST …/health), test message
//  (POST …/test), retry failed/single (POST …/retry), master enable + owner chat IDs
//  + schedule minutes + per-alert toggles (PATCH /api/settings/telegram-ops, the web
//  save() {business_id, <field>} payloads verbatim; reload = server echo).
//  Carried lessons: lenient decoding, ONE loading state, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsTelegramPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web HealthStat tones: ok text-emerald-600 · warn text-amber-600 · bad text-red-600.
    static func tone(_ t: String?) -> Color {
        switch t {
        case "ok": return emerald600
        case "warn": return amber600
        case "bad": return red500
        default: return .secondary
        }
    }

    /// Web queue-status chips: SENT green · QUEUED amber · FAILED red · SENDING blue-ish.
    static func queueStatus(_ s: String?) -> Color {
        switch s {
        case "SENT": return emerald600
        case "QUEUED": return amber600
        case "FAILED": return red500
        case "SENDING": return Color(red: 0.231, green: 0.510, blue: 0.965)  // blue-500 #3B82F6
        default: return .secondary
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page types declare — all lenient)

struct SettingsTelegramSetting: Decodable, Equatable {
    let businessId: String?
    let enabled: Bool?
    let ownerChatIds: String?
    let officeStartMinutes: Int?
    let gracePeriodMinutes: Int?
    let checkoutCutoffMinutes: Int?
    let earlyLeaveMinutes: Int?
    // Alert toggles — web ALERT_TOGGLES order + labels, kept as a dictionary so the
    // rows render from one static table.
    let alertFlags: [String: Bool]

    /// Web ALERT_TOGGLES table verbatim (key → label).
    static let toggleTable: [(key: String, label: String)] = [
        ("alertAttendanceCheckIn", "Check-in + face verification alerts"),
        ("alertAttendanceLate", "Late detail on check-in"),
        ("alertAttendanceAbsent", "Absent / not arrived"),
        ("alertAttendanceCheckOut", "Check-out alerts"),
        ("alertAttendanceNoCheckout", "Missing checkout"),
        ("alertAttendanceEarlyLeave", "Early leave"),
        ("alertAttendanceSuspicious", "Suspicious check-in"),
        ("alertTradingScreenshot", "Screenshot upload/failure"),
        ("alertTradingDeleteRequest", "Delete requests"),
        ("alertWorkflowLifecycle", "Approvals · approve / reject / submit"),
        ("alertOpsDailySummary", "Daily ops summary"),
    ]

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private enum Keys: String, CodingKey {
        case businessId, enabled, ownerChatIds
        case officeStartMinutes, gracePeriodMinutes, checkoutCutoffMinutes, earlyLeaveMinutes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        ownerChatIds = try? c.decodeIfPresent(String.self, forKey: .ownerChatIds)
        officeStartMinutes = Self.flexInt(c, .officeStartMinutes)
        gracePeriodMinutes = Self.flexInt(c, .gracePeriodMinutes)
        checkoutCutoffMinutes = Self.flexInt(c, .checkoutCutoffMinutes)
        earlyLeaveMinutes = Self.flexInt(c, .earlyLeaveMinutes)
        var flags: [String: Bool] = [:]
        if let any = try? decoder.container(keyedBy: AnyKey.self) {
            for entry in Self.toggleTable {
                if let k = AnyKey(stringValue: entry.key),
                   let v = try? any.decodeIfPresent(Bool.self, forKey: k) {
                    flags[entry.key] = v
                }
            }
        }
        alertFlags = flags
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct SettingsTelegramQueueRow: Decodable, Identifiable, Equatable {
    let id: String
    let eventType: String?
    let status: String?
    let chatId: String?
    let attempts: Int?
    let errorMessage: String?
    let createdAt: String?
    let employeeName: String?

    private enum Keys: String, CodingKey {
        case id, eventType, status, chatId, attempts, errorMessage, createdAt, employeeName
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        eventType = try? c.decodeIfPresent(String.self, forKey: .eventType)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        // chatId can arrive numeric — accept both.
        if let s = try? c.decodeIfPresent(String.self, forKey: .chatId) { chatId = s }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .chatId) { chatId = String(i) }
        else { chatId = nil }
        if let i = try? c.decodeIfPresent(Int.self, forKey: .attempts) { attempts = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .attempts) { attempts = Int(d.rounded()) }
        else { attempts = nil }
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .errorMessage)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        employeeName = try? c.decodeIfPresent(String.self, forKey: .employeeName)
    }
}

struct SettingsTelegramStatusCount: Decodable, Equatable {
    let status: String
    let count: Int
    private enum Keys: String, CodingKey { case status, count }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        status = (try? c.decode(String.self, forKey: .status)) ?? "—"
        if let i = try? c.decode(Int.self, forKey: .count) { count = i }
        else if let d = try? c.decode(Double.self, forKey: .count) { count = Int(d.rounded()) }
        else { count = 0 }
    }
}

/// GET /api/settings/telegram-ops wraps via apiDataSuccess → `{ok, data:{…}}`;
/// decode both wrapped and flat shapes (same lesson as the approvals routes).
struct SettingsTelegramConfigResponse: Decodable {
    let setting: SettingsTelegramSetting?
    let recentQueue: [SettingsTelegramQueueRow]
    let stats: [SettingsTelegramStatusCount]

    private enum Keys: String, CodingKey { case ok, data, setting, recentQueue, stats }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        setting = try? c.decodeIfPresent(SettingsTelegramSetting.self, forKey: .setting)
        recentQueue = (try? c.decode([SettingsTelegramQueueRow].self, forKey: .recentQueue)) ?? []
        stats = (try? c.decode([SettingsTelegramStatusCount].self, forKey: .stats)) ?? []
    }
}

/// GET /api/settings/telegram-ops/health answers FLAT: `{ok, ownerRouting, …}`.
struct SettingsTelegramDashboard: Decodable {
    struct OwnerRouting: Decodable {
        let source: String?
        let chatIds: [String]
        let dbIds: [String]
        let envIds: [String]
        let invalidDbTokens: [String]
        let invalidEnvTokens: [String]
        private enum Keys: String, CodingKey {
            case source, chatIds, dbIds, envIds, invalidDbTokens, invalidEnvTokens
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            source = try? c.decodeIfPresent(String.self, forKey: .source)
            chatIds = (try? c.decode([String].self, forKey: .chatIds)) ?? []
            dbIds = (try? c.decode([String].self, forKey: .dbIds)) ?? []
            envIds = (try? c.decode([String].self, forKey: .envIds)) ?? []
            invalidDbTokens = (try? c.decode([String].self, forKey: .invalidDbTokens)) ?? []
            invalidEnvTokens = (try? c.decode([String].self, forKey: .invalidEnvTokens)) ?? []
        }
    }
    struct RoutingHealth: Decodable {
        let label: String?
        let tone: String?
        private enum Keys: String, CodingKey { case label, tone }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            tone = try? c.decodeIfPresent(String.self, forKey: .tone)
        }
    }
    struct Telegram: Decodable {
        let botOk: Bool?
        let botError: String?
        let botUsername: String?
        let webhookHealthy: Bool?
        let webhookNote: String?
        let expectedWebhookUrl: String?
        private enum Keys: String, CodingKey {
            case botOk, botError, botUsername, webhookHealthy, webhookNote, expectedWebhookUrl
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            botOk = try? c.decodeIfPresent(Bool.self, forKey: .botOk)
            botError = try? c.decodeIfPresent(String.self, forKey: .botError)
            botUsername = try? c.decodeIfPresent(String.self, forKey: .botUsername)
            webhookHealthy = try? c.decodeIfPresent(Bool.self, forKey: .webhookHealthy)
            webhookNote = try? c.decodeIfPresent(String.self, forKey: .webhookNote)
            expectedWebhookUrl = try? c.decodeIfPresent(String.self, forKey: .expectedWebhookUrl)
        }
    }
    struct Queue: Decodable {
        let pendingDepth: Int?
        let businessPending: Int?
        let processingCount: Int?
        let retryWaitCount: Int?
        let stuckSending: Int?
        let businessFailed24h: Int?
        let averageDeliveryLatencyMs: Int?
        let stats7d: [SettingsTelegramStatusCount]
        private enum Keys: String, CodingKey {
            case pendingDepth, businessPending, processingCount, retryWaitCount
            case stuckSending, businessFailed24h, averageDeliveryLatencyMs, stats7d
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            pendingDepth = Self.flexInt(c, .pendingDepth)
            businessPending = Self.flexInt(c, .businessPending)
            processingCount = Self.flexInt(c, .processingCount)
            retryWaitCount = Self.flexInt(c, .retryWaitCount)
            stuckSending = Self.flexInt(c, .stuckSending)
            businessFailed24h = Self.flexInt(c, .businessFailed24h)
            averageDeliveryLatencyMs = Self.flexInt(c, .averageDeliveryLatencyMs)
            stats7d = (try? c.decode([SettingsTelegramStatusCount].self, forKey: .stats7d)) ?? []
        }
        private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
            if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
            if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
            return nil
        }
    }
    struct Delivery: Decodable {
        struct LastSend: Decodable {
            let sentAt: String?
            let eventType: String?
            let chatId: String?
            private enum Keys: String, CodingKey { case sentAt, eventType, chatId }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                sentAt = try? c.decodeIfPresent(String.self, forKey: .sentAt)
                eventType = try? c.decodeIfPresent(String.self, forKey: .eventType)
                chatId = try? c.decodeIfPresent(String.self, forKey: .chatId)
            }
        }
        struct LastFailed: Decodable {
            let at: String?
            let eventType: String?
            let errorMessage: String?
            private enum Keys: String, CodingKey { case at, eventType, errorMessage }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                at = try? c.decodeIfPresent(String.self, forKey: .at)
                eventType = try? c.decodeIfPresent(String.self, forKey: .eventType)
                errorMessage = try? c.decodeIfPresent(String.self, forKey: .errorMessage)
            }
        }
        let sentLast24h: Int?
        let lastSuccessfulSend: LastSend?
        let lastFailed: LastFailed?
        private enum Keys: String, CodingKey { case sentLast24h, lastSuccessfulSend, lastFailed }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            if let i = try? c.decodeIfPresent(Int.self, forKey: .sentLast24h) { sentLast24h = i }
            else if let d = try? c.decodeIfPresent(Double.self, forKey: .sentLast24h) { sentLast24h = Int(d.rounded()) }
            else { sentLast24h = nil }
            lastSuccessfulSend = try? c.decodeIfPresent(LastSend.self, forKey: .lastSuccessfulSend)
            lastFailed = try? c.decodeIfPresent(LastFailed.self, forKey: .lastFailed)
        }
    }

    let ownerRouting: OwnerRouting?
    let ownerRoutingHealth: RoutingHealth?
    let telegram: Telegram?
    let queue: Queue?
    let delivery: Delivery?

    private enum Keys: String, CodingKey { case ownerRouting, ownerRoutingHealth, telegram, queue, delivery }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ownerRouting = try? c.decodeIfPresent(OwnerRouting.self, forKey: .ownerRouting)
        ownerRoutingHealth = try? c.decodeIfPresent(RoutingHealth.self, forKey: .ownerRoutingHealth)
        telegram = try? c.decodeIfPresent(Telegram.self, forKey: .telegram)
        queue = try? c.decodeIfPresent(Queue.self, forKey: .queue)
        delivery = try? c.decodeIfPresent(Delivery.self, forKey: .delivery)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsTelegramVM {
    /// Web BUSINESS_LIST (src/lib/businesses.ts) — id → name, same order.
    static let businesses: [(id: String, name: String)] = [
        ("ALMA_LIFESTYLE", "Alma Lifestyle"),
        ("CREATIVE_DIGITAL_IT", "Creative Digital IT"),
        ("ALMA_TRADING", "Alma Trading"),
    ]

    var businessId = "ALMA_LIFESTYLE"
    var setting: SettingsTelegramSetting? = nil
    var recentQueue: [SettingsTelegramQueueRow] = []
    var dashboard: SettingsTelegramDashboard? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Same pair the web page fires in parallel.
            async let configTask: SettingsTelegramConfigResponse = AlmaAPI.shared.get(
                "/api/settings/telegram-ops", query: ["business_id": businessId])
            async let healthTask: SettingsTelegramDashboard = AlmaAPI.shared.get(
                "/api/settings/telegram-ops/health", query: ["business_id": businessId])
            let config = try await configTask
            setting = config.setting
            recentQueue = config.recentQueue
            // Health is best-effort on the web too (dashboard set to nil on failure).
            dashboard = try? await healthTask
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

    /// Web routingLabel(source) verbatim.
    func routingLabel(_ source: String?) -> String {
        switch source {
        case "database": return "Database (primary)"
        case "env_fallback": return "Env fallback (TELEGRAM_OWNER_CHAT_IDS)"
        case "disabled": return "Disabled"
        default: return "No valid recipients"
        }
    }

    var queueStats7d: [String: Int] {
        Dictionary(uniqueKeysWithValues: (dashboard?.queue?.stats7d ?? []).map { ($0.status, $0.count) })
    }

    // ── Native writes (owner 2026-07-11) — web processQueueNow/sendTest/retry/save. ──

    var toast: String? = nil
    var busy = false

    private struct EmptyBody: Encodable {}
    private struct RetryBody: Encodable {
        var id: String? = nil
        var retry_all: Bool? = nil
        var business_id: String? = nil
    }
    private struct TestBody: Encodable { let business_id: String }
    private struct SavePatch: Encodable {
        let business_id: String
        var enabled: Bool? = nil
        var alert_toggles: [String: Bool]? = nil
    }

    func processQueueNow() async {
        struct Resp: Decodable {
            struct Inner: Decodable { let processed: Int? }
            let reclaimed: Int?, processed: Inner?
        }
        busy = true; defer { busy = false }
        do {
            let res: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/settings/telegram-ops/health",
                query: ["business_id": businessId], body: EmptyBody())
            toast = "Reclaimed \(res.reclaimed ?? 0) stuck · processed \(res.processed?.processed ?? 0)"
            await load()
        } catch { toast = error.localizedDescription }
    }

    func sendTest() async {
        struct Resp: Decodable {
            struct Routing: Decodable { let source: String?, chatIds: [String]? }
            let routing: Routing?
        }
        busy = true; defer { busy = false }
        do {
            let res: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/settings/telegram-ops/test", body: TestBody(business_id: businessId))
            toast = "Test sent to \(res.routing?.chatIds?.count ?? 0) owner chat(s)"
            await load()
        } catch { toast = error.localizedDescription }
    }

    func retryAllFailed() async {
        struct Resp: Decodable { let requeued: Int? }
        busy = true; defer { busy = false }
        do {
            let res: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/settings/telegram-ops/retry",
                body: RetryBody(retry_all: true, business_id: businessId))
            toast = "Requeued \(res.requeued ?? 0) failed job(s)"
            await load()
        } catch { toast = error.localizedDescription }
    }

    func retryQueue(_ id: String) async {
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/settings/telegram-ops/retry", body: RetryBody(id: id))
            toast = "Retry queued"
            await load()
        } catch { toast = error.localizedDescription }
    }

    // NP-5 (AD-07): owner chat IDs + schedule + per-alert toggles — the web save()
    // payload verbatim ({business_id, <camelCase field>: value}); reload = echo.
    struct ConfigPatch: Encodable {
        let business_id: String
        var ownerChatIds: String? = nil
        var officeStartMinutes: Int? = nil
        var gracePeriodMinutes: Int? = nil
        var checkoutCutoffMinutes: Int? = nil
        var earlyLeaveMinutes: Int? = nil
        var alertAttendanceCheckIn: Bool? = nil
        var alertAttendanceLate: Bool? = nil
        var alertAttendanceAbsent: Bool? = nil
        var alertAttendanceCheckOut: Bool? = nil
        var alertAttendanceNoCheckout: Bool? = nil
        var alertAttendanceEarlyLeave: Bool? = nil
        var alertAttendanceSuspicious: Bool? = nil
        var alertTradingScreenshot: Bool? = nil
        var alertTradingDeleteRequest: Bool? = nil
        var alertWorkflowLifecycle: Bool? = nil
        var alertOpsDailySummary: Bool? = nil
    }

    var configSaving = false

    func saveConfig(_ mutate: (inout ConfigPatch) -> Void) async {
        guard !configSaving else { return }
        configSaving = true
        defer { configSaving = false }
        var patch = ConfigPatch(business_id: businessId)
        mutate(&patch)
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send("PATCH", "/api/settings/telegram-ops", body: patch)
            toast = "Saved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            toast = "Save ব্যর্থ: \(error.localizedDescription)"
        }
        await load()
    }

    func alertToggle(_ key: String, _ on: Bool) async {
        await saveConfig { p in
            switch key {
            case "alertAttendanceCheckIn": p.alertAttendanceCheckIn = on
            case "alertAttendanceLate": p.alertAttendanceLate = on
            case "alertAttendanceAbsent": p.alertAttendanceAbsent = on
            case "alertAttendanceCheckOut": p.alertAttendanceCheckOut = on
            case "alertAttendanceNoCheckout": p.alertAttendanceNoCheckout = on
            case "alertAttendanceEarlyLeave": p.alertAttendanceEarlyLeave = on
            case "alertAttendanceSuspicious": p.alertAttendanceSuspicious = on
            case "alertTradingScreenshot": p.alertTradingScreenshot = on
            case "alertTradingDeleteRequest": p.alertTradingDeleteRequest = on
            case "alertWorkflowLifecycle": p.alertWorkflowLifecycle = on
            case "alertOpsDailySummary": p.alertOpsDailySummary = on
            default: break
            }
        }
    }

    func setEnabled(_ enabled: Bool) async {
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "PATCH", "/api/settings/telegram-ops",
                body: SavePatch(business_id: businessId, enabled: enabled))
            toast = "Saved"
            await load()
        } catch { toast = error.localizedDescription }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsTelegramScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsTelegramVM()
    @State private var ownerChatIdsDraft = ""    // NP-5 (AD-07)
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                businessChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if vm.loading && vm.setting == nil && vm.dashboard == nil {
                    loadingRows
                } else {
                    healthGrid
                    actionsCard
                    routingCard
                    configCard
                    alertTogglesCard
                    queueCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsTelegramAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
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

    /// Native ops actions (owner 2026-07-11): master toggle + process-now + test +
    /// retry-all — web parity.
    private var actionsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Telegram notifications", isOn: Binding(
                get: { vm.setting?.enabled == true },
                set: { on in Task { await vm.setEnabled(on) } }))
                .font(.footnote.weight(.semibold))
                .tint(SettingsTelegramPalette.emerald600)
            HStack(spacing: 8) {
                opChip("Process now", "play.circle") { Task { await vm.processQueueNow() } }
                opChip("Send test", "paperplane") { Task { await vm.sendTest() } }
                opChip("Retry failed", "arrow.clockwise") { Task { await vm.retryAllFailed() } }
                if vm.busy { ProgressView().controlSize(.mini) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func opChip(_ label: String, _ icon: String, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.system(size: 10, weight: .bold))
                .padding(.horizontal, 9).padding(.vertical, 7)
                .background(Color.primary.opacity(0.06), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(vm.busy)
    }

    // ── Business picker (web Select over BUSINESS_LIST) ──

    private var businessChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SettingsTelegramVM.businesses, id: \.id) { b in
                    settingsChip(b.name, active: vm.businessId == b.id) {
                        vm.businessId = b.id
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    // ── Health grid (web HealthStat cards, 2-up on phone) ──

    private var healthGrid: some View {
        let tg = vm.dashboard?.telegram
        let q = vm.dashboard?.queue
        let d = vm.dashboard?.delivery
        let routing = vm.dashboard?.ownerRouting
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())],
                         spacing: 10) {
            healthStat("Bot (outbound)",
                       tg?.botOk == true ? "@\(tg?.botUsername ?? "ok")"
                                         : (tg?.botError ?? "Offline / misconfigured"),
                       tone: tg?.botOk == true ? "ok" : "bad")
            healthStat("Webhook (inbound)",
                       tg?.webhookHealthy == true ? "Registered" : "Informational",
                       tone: "warn",
                       hint: tg?.webhookNote ?? tg?.expectedWebhookUrl)
            healthStat("Owner routing",
                       vm.dashboard?.ownerRoutingHealth?.label ?? vm.routingLabel(routing?.source),
                       tone: vm.dashboard?.ownerRoutingHealth?.tone
                           ?? ((routing?.chatIds.isEmpty == false) ? "ok" : "bad"),
                       hint: routing?.chatIds.joined(separator: ", "))
            healthStat("Queue depth",
                       "\(q?.pendingDepth ?? q?.businessPending ?? 0)",
                       tone: (q?.pendingDepth ?? 0) > 5 ? "warn" : "ok")
            healthStat("Processing", "\(q?.processingCount ?? 0)",
                       tone: (q?.processingCount ?? 0) > 0 ? "warn" : "ok")
            healthStat("Retry wait", "\(q?.retryWaitCount ?? 0)",
                       tone: (q?.retryWaitCount ?? 0) > 0 ? "warn" : "ok")
            healthStat("Avg latency (24h)",
                       q?.averageDeliveryLatencyMs.map { "\($0)ms" } ?? "—", tone: "ok")
            healthStat("Stuck SENDING", "\(q?.stuckSending ?? 0)",
                       tone: (q?.stuckSending ?? 0) > 0 ? "bad" : "ok")
            healthStat("Failed (24h)", "\(q?.businessFailed24h ?? 0)",
                       tone: (q?.businessFailed24h ?? 0) > 0 ? "warn" : "ok")
            healthStat("Sent (24h)", "\(d?.sentLast24h ?? 0)", tone: "ok")
            healthStat("Last success",
                       SettingsTelegramFormat.dateTime(d?.lastSuccessfulSend?.sentAt) ?? "—",
                       tone: d?.lastSuccessfulSend != nil ? "ok" : "warn",
                       hint: d?.lastSuccessfulSend?.eventType)
        }
    }

    private func healthStat(_ label: String, _ value: String, tone: String, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .kerning(0.8)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.footnote.weight(.bold))
                .foregroundStyle(SettingsTelegramPalette.tone(tone))
                .lineLimit(2)
            if let hint, !hint.isEmpty {
                Text(hint).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .topLeading)
        .padding(12)
        .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Owner routing diagnostics (web card — chat IDs monospace) ──

    @ViewBuilder private var routingCard: some View {
        if let r = vm.dashboard?.ownerRouting {
            VStack(alignment: .leading, spacing: 8) {
                Text("Owner routing diagnostics")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                labeledMonoRow("Active source", vm.routingLabel(r.source), accent: true)
                labeledMonoRow("Delivering to", r.chatIds.joined(separator: ", "))
                labeledMonoRow("DB IDs", r.dbIds.joined(separator: ", "))
                labeledMonoRow("Env fallback IDs", r.envIds.joined(separator: ", "))
                if !r.invalidDbTokens.isEmpty || !r.invalidEnvTokens.isEmpty {
                    Text("Invalid tokens ignored: DB [\(r.invalidDbTokens.joined(separator: ", "))] Env [\(r.invalidEnvTokens.joined(separator: ", "))]")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(SettingsTelegramPalette.amber600)
                }
                Text("Priority: database chat IDs first. If empty or invalid, TELEGRAM_OWNER_CHAT_IDS env is used.")
                    .font(.caption2).foregroundStyle(.secondary)
                Text("Delivery: enqueue → cron/worker (ERP never waits on Telegram API). High priority: approvals, penalties, wallet. Low priority: screenshots, summaries (45s delay).")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private func labeledMonoRow(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value.isEmpty ? "—" : value)
                .font(.caption.monospaced())
                .foregroundStyle(accent ? SettingsTelegramPalette.accentText(colorScheme) : .primary)
        }
    }

    // ── Recipients & master switch + schedule (READ-ONLY — changes stay on web) ──

    @ViewBuilder private var configCard: some View {
        if let s = vm.setting {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Recipients & master switch")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Text(s.enabled == true ? "Enabled" : "Disabled")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(s.enabled == true ? SettingsTelegramPalette.emerald600
                                                           : SettingsTelegramPalette.red500)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background((s.enabled == true ? SettingsTelegramPalette.emerald600
                                                       : SettingsTelegramPalette.red500).opacity(0.12),
                                    in: Capsule())
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Owner chat IDs (comma-separated). Env fallback: TELEGRAM_OWNER_CHAT_IDS")
                        .font(.caption2).foregroundStyle(.secondary)
                    // NP-5 (AD-07): editable — saves the web's {ownerChatIds} patch.
                    HStack(spacing: 8) {
                        TextField("123456789, 987654321", text: $ownerChatIdsDraft)
                            .font(.footnote.monospaced())
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.numbersAndPunctuation)
                            .autocorrectionDisabled()
                        Button(vm.configSaving ? "…" : "সেভ") {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await vm.saveConfig { $0.ownerChatIds = ownerChatIdsDraft } }
                        }
                        .font(.caption.weight(.bold))
                        .buttonStyle(.bordered)
                        .disabled(vm.configSaving)
                    }
                    .onAppear { ownerChatIdsDraft = s.ownerChatIds ?? "" }
                }

                Text("Schedule (BD)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    .padding(.top, 2)
                Text("Office \(SettingsTelegramFormat.minutesToTimeLabel(s.officeStartMinutes ?? 0)) · grace +\(s.gracePeriodMinutes ?? 0)m · no-checkout \(SettingsTelegramFormat.minutesToTimeLabel(s.checkoutCutoffMinutes ?? 0))")
                    .font(.caption2).foregroundStyle(.secondary)
                // NP-5 (AD-07): editable schedule — web onBlur-save parity (save on submit).
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())],
                          spacing: 8) {
                    scheduleField("Office start (min)", s.officeStartMinutes) { v in
                        Task { await vm.saveConfig { $0.officeStartMinutes = v } }
                    }
                    scheduleField("Grace (min)", s.gracePeriodMinutes) { v in
                        Task { await vm.saveConfig { $0.gracePeriodMinutes = v } }
                    }
                    scheduleField("Checkout cutoff (min)", s.checkoutCutoffMinutes) { v in
                        Task { await vm.saveConfig { $0.checkoutCutoffMinutes = v } }
                    }
                    scheduleField("Early leave under (min)", s.earlyLeaveMinutes) { v in
                        Task { await vm.saveConfig { $0.earlyLeaveMinutes = v } }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    /// NP-5 (AD-07): editable schedule cell — commits the web {field: minutes} patch
    /// on submit (keyboard done), mirroring the web's onBlur save.
    private func scheduleField(_ label: String, _ value: Int?, onCommit: @escaping (Int) -> Void) -> some View {
        SettingsTelegramScheduleField(label: label, value: value, disabled: vm.configSaving, onCommit: onCommit)
    }

    private func scheduleCell(_ label: String, _ value: Int?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(value.map(String.init) ?? "—")
                .font(.footnote.monospaced().weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.4), lineWidth: 1))
    }

    // ── Alert toggles (web ALERT_TOGGLES — read-only state rows) ──

    @ViewBuilder private var alertTogglesCard: some View {
        if let s = vm.setting {
            VStack(alignment: .leading, spacing: 8) {
                Text("Alert toggles")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(SettingsTelegramSetting.toggleTable, id: \.key) { t in
                    let on = s.alertFlags[t.key] == true
                    HStack(spacing: 8) {
                        Text(t.label).font(.footnote)
                        Spacer()
                        // NP-5 (AD-07): live toggle — web checkbox save parity.
                        Toggle("", isOn: Binding(get: { on }, set: { newOn in
                            UISelectionFeedbackGenerator().selectionChanged()
                            Task { await vm.alertToggle(t.key, newOn) }
                        }))
                        .labelsHidden()
                        .tint(SettingsTelegramPalette.emerald600)
                        .disabled(vm.configSaving)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Color.white.opacity(colorScheme == .dark ? 0.04 : 0.3),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.4), lineWidth: 1))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── Queue (7 days) chips + last failure + recent rows ──

    @ViewBuilder private var queueCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Queue (7 days)")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            let stats = vm.queueStats7d
            HStack(spacing: 8) {
                queueStatChip("SENT", stats["SENT"] ?? 0)
                queueStatChip("QUEUED", stats["QUEUED"] ?? 0)
                queueStatChip("FAILED", stats["FAILED"] ?? 0)
                queueStatChip("SENDING", stats["SENDING"] ?? 0)
            }

            if let failed = vm.dashboard?.delivery?.lastFailed {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Last failure").font(.caption2.weight(.heavy))
                        .foregroundStyle(SettingsTelegramPalette.red500)
                    if let ev = failed.eventType { Text(ev).font(.caption2) }
                    if let msg = failed.errorMessage, !msg.isEmpty {
                        Text(msg).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(SettingsTelegramPalette.red500.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(SettingsTelegramPalette.red500.opacity(0.25), lineWidth: 1))
            }

            Text("Recent queue")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                .padding(.top, 2)
            if vm.recentQueue.isEmpty {
                Text("কিছু নেই").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(vm.recentQueue) { row in
                queueRow(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func queueStatChip(_ label: String, _ count: Int) -> some View {
        let tint = SettingsTelegramPalette.queueStatus(label)
        return Text("\(label): \(count)")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(tint.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }

    private func queueRow(_ row: SettingsTelegramQueueRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(row.employeeName ?? row.eventType ?? "—")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(row.status ?? "—")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(SettingsTelegramPalette.queueStatus(row.status))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(SettingsTelegramPalette.queueStatus(row.status).opacity(0.10),
                                in: Capsule())
            }
            if row.employeeName != nil, let ev = row.eventType {
                Text(ev).font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text("Chat \(row.chatId ?? "—")")
                    .font(.caption2.monospaced())
                    .foregroundStyle(SettingsTelegramPalette.accentText(colorScheme))
                Text("· attempts \(row.attempts ?? 0)")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if let d = SettingsTelegramFormat.dateTime(row.createdAt) {
                    Text(d).font(.caption2).foregroundStyle(.secondary)
                }
            }
            if let err = row.errorMessage, !err.isEmpty {
                Text(err).font(.caption2).foregroundStyle(SettingsTelegramPalette.red500).lineLimit(2)
            }
            // Native per-row retry (owner 2026-07-11) — web shows it on FAILED/QUEUED/SENDING.
            if ["FAILED", "QUEUED", "SENDING"].contains((row.status ?? "").uppercased()) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task { await vm.retryQueue(row.id) }
                } label: {
                    Text("Retry").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(SettingsTelegramPalette.amber600)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(SettingsTelegramPalette.amber600.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.04 : 0.3),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.4), lineWidth: 1))
    }

    // ── Shared bits (pattern parity) ──

    private func settingsChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? SettingsTelegramPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? SettingsTelegramPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? SettingsTelegramPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SettingsTelegramPalette.red500)
        case .success: ("checkmark.circle", SettingsTelegramPalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .settingsTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsTelegramShimmer()
        }
    }

    /// Config changes (chat IDs, toggles, schedule, send-test/process/retry) are
    /// web-only by design — standing-rule config must not be mutated natively.
    private var webEscape: some View {
        Button {
            openWeb("/settings/telegram-ops", "Telegram Ops")
        } label: {
            Label("কনফিগ পরিবর্তন (টগল/চ্যাট ID/রিট্রাই) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum SettingsTelegramFormat {
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

    /// Minutes-since-midnight → "9:30 AM" (web minutesToTimeLabel verbatim).
    static func minutesToTimeLabel(_ minutes: Int) -> String {
        let h = minutes / 60
        let m = minutes % 60
        let period = h >= 12 ? "PM" : "AM"
        let hour12 = h % 12 == 0 ? 12 : h % 12
        return "\(hour12):\(String(format: "%02d", m)) \(period)"
    }
}

// MARK: - Aurora background + glass (SettingsTelegram-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsTelegramAurora: View {
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
    func settingsTelegramGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsTelegramShimmer: ViewModifier {
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
    func settingsTelegramShimmer() -> some View { modifier(SettingsTelegramShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Telegram Ops — Light") {
    SettingsTelegramScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}


/// NP-5 (AD-07): one editable minutes field (own state so typing doesn't re-render the card).
@available(iOS 17.0, *)
private struct SettingsTelegramScheduleField: View {
    let label: String
    let value: Int?
    let disabled: Bool
    let onCommit: (Int) -> Void
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            TextField("0", text: $draft)
                .font(.footnote.monospaced().weight(.semibold))
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
                .disabled(disabled)
                .onSubmit { commit() }
                .submitLabel(.done)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { draft = value.map(String.init) ?? "" }
        .onChange(of: value) { _, new in draft = new.map(String.init) ?? "" }
        .overlay(alignment: .topTrailing) {
            if Int(draft) != value, let _ = Int(draft) {
                Button("সেভ") { commit() }
                    .font(.system(size: 10, weight: .bold))
                    .buttonStyle(.bordered)
                    .disabled(disabled)
            }
        }
    }

    private func commit() {
        guard let v = Int(draft), v != value else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onCommit(v)
    }
}
