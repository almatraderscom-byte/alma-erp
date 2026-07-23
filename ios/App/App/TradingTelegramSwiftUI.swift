//
//  TradingTelegramSwiftUI.swift
//  ALMA ERP — the Telegram Quick Entry monitor (/trading/telegram) as a native
//  SwiftUI screen (READ-ONLY).
//
//  Mirrors the web page — same endpoints, same colours, same blocks:
//    GET /api/trading/telegram/drafts?status=…&grouped=1&limit=100 → { drafts, groups }
//    GET /api/trading/telegram/monitor                             → owner monitoring payload
//    GET /api/trading/telegram/live?limit=40                       → { drafts, audits, counts } (8s poll)
//    GET /api/trading/telegram/users                               → { users }
//    GET /api/trading/telegram/aliases                             → { aliases }
//    GET /api/trading/telegram/chats                               → { chats }
//  Web-parity blocks: tab row (Drafts / Monitor / Live Feed / Groups / Mapping) ·
//  draft status filter · grouped draft cards (avatar initials, telegram handle,
//  account, raw-message mono block, status pill) · owner-monitoring KPIs · staff
//  pending-by-user · suspicious bot activity · live counts strip + latest trades +
//  events · registered groups · user/alias mapping overview.
//  ALL mutations (confirm→ledger, reject, edit, webhook, mapping writes) are
//  money-sensitive and stay on the web — footer escape opens /trading/telegram.
//  Carried lessons: lenient decoding, cancellation-safe .refreshable, auth card,
//  ONE spinner pattern, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingTelegramPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let amber300 = Color(red: 0.988, green: 0.827, blue: 0.302)       // #FCD34D
    static let orange500 = Color(red: 0.976, green: 0.451, blue: 0.086)      // #F97316
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let blue400 = Color(red: 0.376, green: 0.647, blue: 0.980)        // #60A5FA
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8
    /// Trading accent green (hero accent — matches web trading sage #81B29A).
    static let tradeGreen = Color(red: 0.51, green: 0.70, blue: 0.60)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web draft status tints: PENDING amber · LOCKED orange · POSTED emerald ·
    /// REJECTED/FAILED red · UNDONE slate · APPROVED blue.
    static func status(_ s: String, _ scheme: ColorScheme) -> Color {
        switch s {
        case "PENDING": return scheme == .dark ? amber500 : amber600
        case "LOCKED": return orange500
        case "POSTED": return scheme == .dark ? green400 : emerald600
        case "APPROVED": return blue400
        case "REJECTED", "FAILED": return red500
        default: return slate400                    // UNDONE / unknown
        }
    }
}

// MARK: - Models (same field names the web trading-telegram types declare)

/// One captured Telegram draft trade — also reused for the live-feed rows
/// (the live payload is a subset with the same field names).
struct TradingTelegramDraft: Decodable, Identifiable, Equatable {
    let id: String
    let status: String
    let tradeNumber: Int?
    let tradeType: String?
    let usdtAmount: Double?
    let bdtRate: Double?
    let feeUsdt: Double?
    let accountTitle: String?
    let accountAlias: String?
    let telegramUsername: String?
    let telegramUserId: String?
    let rawMessage: String?
    let userName: String?
    let lockedReason: String?
    let rejectReason: String?
    let parseError: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, status, tradeNumber, tradeType, usdtAmount, bdtRate, feeUsdt
        case accountTitle, accountAlias, telegramUsername, telegramUserId
        case rawMessage, user, lockedReason, rejectReason, parseError, createdAt
    }
    private enum UserKeys: String, CodingKey { case name }

    /// Wire numbers arrive as number OR string (Prisma Decimal serialisation) —
    /// decode defensively so ONE bad row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        status = (try? c.decode(String.self, forKey: .status)) ?? "PENDING"
        tradeNumber = Self.flexInt(c, .tradeNumber)
        tradeType = try? c.decodeIfPresent(String.self, forKey: .tradeType)
        usdtAmount = Self.flexDouble(c, .usdtAmount)
        bdtRate = Self.flexDouble(c, .bdtRate)
        feeUsdt = Self.flexDouble(c, .feeUsdt)
        accountTitle = try? c.decodeIfPresent(String.self, forKey: .accountTitle)
        accountAlias = try? c.decodeIfPresent(String.self, forKey: .accountAlias)
        telegramUsername = try? c.decodeIfPresent(String.self, forKey: .telegramUsername)
        telegramUserId = Self.flexString(c, .telegramUserId)
        rawMessage = try? c.decodeIfPresent(String.self, forKey: .rawMessage)
        let u = try? c.nestedContainer(keyedBy: UserKeys.self, forKey: .user)
        userName = u.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
        lockedReason = try? c.decodeIfPresent(String.self, forKey: .lockedReason)
        rejectReason = try? c.decodeIfPresent(String.self, forKey: .rejectReason)
        parseError = try? c.decodeIfPresent(String.self, forKey: .parseError)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    static func == (a: TradingTelegramDraft, b: TradingTelegramDraft) -> Bool {
        a.id == b.id && a.status == b.status
    }

    /// Web DraftRow headline: "#12 · BUY · 500 USDT @ 122.5 · fee 0.5".
    var headline: String {
        var bits: [String] = []
        if let n = tradeNumber { bits.append("#\(n)") }
        bits.append(tradeType ?? "—")
        bits.append("\(TradingTelegramFormat.num(usdtAmount)) USDT @ \(TradingTelegramFormat.num(bdtRate))")
        if let fee = feeUsdt, fee != 0 { bits.append("fee \(TradingTelegramFormat.num(fee))") }
        return bits.joined(separator: " · ")
    }
    var account: String { accountTitle ?? accountAlias ?? "—" }
    var telegramHandle: String { "@\(telegramUsername ?? telegramUserId ?? "—")" }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
    private static func flexDouble(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }
    private static func flexString(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        return nil
    }
}

/// Admin grouped view: one card per (staff × account) with its drafts.
struct TradingTelegramDraftGroup: Decodable, Identifiable, Equatable {
    let userName: String
    let telegramUsername: String?
    let telegramUserId: String?
    let accountTitle: String?
    let accountAlias: String?
    let drafts: [TradingTelegramDraft]

    var id: String { "\(userName):\(telegramUserId ?? "")-\(accountTitle ?? accountAlias ?? "")" }
    var account: String { accountTitle ?? accountAlias ?? "—" }
    var telegramHandle: String { "@\(telegramUsername ?? telegramUserId ?? "—")" }

    private enum Keys: String, CodingKey { case key, drafts }
    private enum KeyKeys: String, CodingKey {
        case userName, telegramUsername, telegramUserId, accountTitle, accountAlias
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let k = try? c.nestedContainer(keyedBy: KeyKeys.self, forKey: .key)
        userName = k.flatMap { try? $0.decodeIfPresent(String.self, forKey: .userName) } ?? "—"
        telegramUsername = k.flatMap { try? $0.decodeIfPresent(String.self, forKey: .telegramUsername) }
        telegramUserId = k.flatMap { try? $0.decodeIfPresent(String.self, forKey: .telegramUserId) }
        accountTitle = k.flatMap { try? $0.decodeIfPresent(String.self, forKey: .accountTitle) }
        accountAlias = k.flatMap { try? $0.decodeIfPresent(String.self, forKey: .accountAlias) }
        drafts = (try? c.decode([TradingTelegramDraft].self, forKey: .drafts)) ?? []
    }
    static func == (a: TradingTelegramDraftGroup, b: TradingTelegramDraftGroup) -> Bool { a.id == b.id }
}

/// `{ drafts, groups }` — tolerate an apiDataSuccess `{ ok, data: {…} }` wrap too.
struct TradingTelegramDraftsResponse: Decodable {
    let drafts: [TradingTelegramDraft]
    let groups: [TradingTelegramDraftGroup]

    private enum Keys: String, CodingKey { case ok, data, drafts, groups }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        drafts = (try? c.decode([TradingTelegramDraft].self, forKey: .drafts)) ?? []
        groups = (try? c.decode([TradingTelegramDraftGroup].self, forKey: .groups)) ?? []
    }
}

/// GET /api/trading/telegram/monitor payload (owner monitoring).
struct TradingTelegramMonitor: Decodable {
    struct StaffSummary: Decodable, Identifiable {
        let userId: String
        let name: String
        let role: String?
        let pendingCount: Int
        var id: String { userId }

        private enum Keys: String, CodingKey { case userId, name, role, pendingCount }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            userId = (try? c.decode(String.self, forKey: .userId)) ?? UUID().uuidString
            name = (try? c.decode(String.self, forKey: .name)) ?? "—"
            role = try? c.decodeIfPresent(String.self, forKey: .role)
            pendingCount = (try? c.decodeIfPresent(Int.self, forKey: .pendingCount)) ?? 0
        }
    }

    let pendingDeleteApprovals: Int
    let staffSummaries: [StaffSummary]
    let suspiciousAudits: [TradingTelegramAudit]
    let draftCounts: [String: Int]

    var pendingAll: Int { (draftCounts["PENDING"] ?? 0) + (draftCounts["LOCKED"] ?? 0) }
    var postedQueue: Int { draftCounts["POSTED"] ?? 0 }

    private enum Keys: String, CodingKey {
        case ok, data, pendingDeleteApprovals, staffSummaries, suspiciousAudits, draftCounts
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        pendingDeleteApprovals = (try? c.decodeIfPresent(Int.self, forKey: .pendingDeleteApprovals)) ?? 0
        staffSummaries = (try? c.decode([StaffSummary].self, forKey: .staffSummaries)) ?? []
        suspiciousAudits = (try? c.decode([TradingTelegramAudit].self, forKey: .suspiciousAudits)) ?? []
        draftCounts = (try? c.decode([String: Int].self, forKey: .draftCounts)) ?? [:]
    }
}

/// Bot audit event (duplicates · undo · suspicious activity).
struct TradingTelegramAudit: Decodable, Identifiable, Equatable {
    let id: String
    let eventType: String
    let telegramUsername: String?
    let telegramUserId: String?
    let rawMessage: String?
    let detail: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, eventType, telegramUsername, telegramUserId, rawMessage, detail, createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        eventType = (try? c.decode(String.self, forKey: .eventType)) ?? "EVENT"
        telegramUsername = try? c.decodeIfPresent(String.self, forKey: .telegramUsername)
        if let s = try? c.decodeIfPresent(String.self, forKey: .telegramUserId) { telegramUserId = s }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .telegramUserId) { telegramUserId = String(i) }
        else { telegramUserId = nil }
        rawMessage = try? c.decodeIfPresent(String.self, forKey: .rawMessage)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
    static func == (a: TradingTelegramAudit, b: TradingTelegramAudit) -> Bool { a.id == b.id }
}

/// GET /api/trading/telegram/live payload — { drafts, audits, counts, serverTime }.
struct TradingTelegramLive: Decodable {
    let drafts: [TradingTelegramDraft]
    let audits: [TradingTelegramAudit]
    let pending: Int
    let locked: Int
    let rejected: Int
    let posted: Int
    let undone: Int

    private enum Keys: String, CodingKey { case ok, data, drafts, audits, counts }
    private enum CountKeys: String, CodingKey { case pending, locked, rejected, posted, undone }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        drafts = (try? c.decode([TradingTelegramDraft].self, forKey: .drafts)) ?? []
        audits = (try? c.decode([TradingTelegramAudit].self, forKey: .audits)) ?? []
        let counts = try? c.nestedContainer(keyedBy: CountKeys.self, forKey: .counts)
        pending = counts.flatMap { try? $0.decodeIfPresent(Int.self, forKey: .pending) } ?? 0
        locked = counts.flatMap { try? $0.decodeIfPresent(Int.self, forKey: .locked) } ?? 0
        rejected = counts.flatMap { try? $0.decodeIfPresent(Int.self, forKey: .rejected) } ?? 0
        posted = counts.flatMap { try? $0.decodeIfPresent(Int.self, forKey: .posted) } ?? 0
        undone = counts.flatMap { try? $0.decodeIfPresent(Int.self, forKey: .undone) } ?? 0
    }
}

/// Registered Telegram group (chats tab).
struct TradingTelegramChat: Decodable, Identifiable, Equatable {
    let id: String
    let chatId: String
    let title: String?
    let approved: Bool
    let lastSeenAt: String?

    private enum Keys: String, CodingKey { case id, chatId, title, approved, lastSeenAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        if let s = try? c.decodeIfPresent(String.self, forKey: .chatId) { chatId = s }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .chatId) { chatId = String(i) }
        else { chatId = "—" }
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        approved = (try? c.decodeIfPresent(Bool.self, forKey: .approved)) ?? false
        lastSeenAt = try? c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }
    static func == (a: TradingTelegramChat, b: TradingTelegramChat) -> Bool { a.id == b.id }
}

struct TradingTelegramChatsResponse: Decodable {
    let chats: [TradingTelegramChat]
    private enum Keys: String, CodingKey { case ok, data, chats }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        chats = (try? c.decode([TradingTelegramChat].self, forKey: .chats)) ?? []
    }
}

/// Telegram → ERP staff mapping row (users tab).
struct TradingTelegramUser: Decodable, Identifiable, Equatable {
    let id: String
    let telegramUserId: String?
    let telegramUsername: String?
    let approved: Bool
    let defaultAccountAlias: String?
    let userName: String?
    let lastSeenAt: String?

    private enum Keys: String, CodingKey {
        case id, telegramUserId, telegramUsername, approved, defaultAccountAlias, user, lastSeenAt
    }
    private enum UserKeys: String, CodingKey { case name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        if let s = try? c.decodeIfPresent(String.self, forKey: .telegramUserId) { telegramUserId = s }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .telegramUserId) { telegramUserId = String(i) }
        else { telegramUserId = nil }
        telegramUsername = try? c.decodeIfPresent(String.self, forKey: .telegramUsername)
        approved = (try? c.decodeIfPresent(Bool.self, forKey: .approved)) ?? false
        defaultAccountAlias = try? c.decodeIfPresent(String.self, forKey: .defaultAccountAlias)
        let u = try? c.nestedContainer(keyedBy: UserKeys.self, forKey: .user)
        userName = u.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
        lastSeenAt = try? c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }
    static func == (a: TradingTelegramUser, b: TradingTelegramUser) -> Bool { a.id == b.id }
}

struct TradingTelegramUsersResponse: Decodable {
    let users: [TradingTelegramUser]
    private enum Keys: String, CodingKey { case ok, data, users }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        users = (try? c.decode([TradingTelegramUser].self, forKey: .users)) ?? []
    }
}

/// Account alias row ("bkash1" → trading account).
struct TradingTelegramAlias: Decodable, Identifiable, Equatable {
    let id: String
    let alias: String
    let active: Bool
    let accountTitle: String?

    private enum Keys: String, CodingKey { case id, alias, active, tradingAccount }
    private enum AccountKeys: String, CodingKey { case accountTitle }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        alias = (try? c.decode(String.self, forKey: .alias)) ?? "—"
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? false
        let a = try? c.nestedContainer(keyedBy: AccountKeys.self, forKey: .tradingAccount)
        accountTitle = a.flatMap { try? $0.decodeIfPresent(String.self, forKey: .accountTitle) }
    }
    static func == (a: TradingTelegramAlias, b: TradingTelegramAlias) -> Bool { a.id == b.id }
}

struct TradingTelegramAliasesResponse: Decodable {
    let aliases: [TradingTelegramAlias]
    private enum Keys: String, CodingKey { case ok, data, aliases }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        aliases = (try? c.decode([TradingTelegramAlias].self, forKey: .aliases)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class TradingTelegramVM {
    enum Tab: String, CaseIterable {
        case drafts, monitor, live, groups, mapping
        var label: String {
            switch self {
            case .drafts: return "Drafts"
            case .monitor: return "Monitor"
            case .live: return "Live Feed"
            case .groups: return "Groups"
            case .mapping: return "Mapping"
            }
        }
    }

    var tab: Tab = .drafts
    var loading = false
    var error: String? = nil
    var authExpired = false

    // Drafts tab
    var drafts: [TradingTelegramDraft] = []
    var draftGroups: [TradingTelegramDraftGroup] = []
    var draftStatus = "PENDING"           // PENDING | LOCKED | ALL | REJECTED | POSTED
    static let statuses = ["PENDING", "LOCKED", "ALL", "REJECTED", "POSTED"]

    // Monitor tab (also feeds the hero KPIs)
    var monitor: TradingTelegramMonitor? = nil

    // Live tab (8s poll while visible, same as the web feed)
    var live: TradingTelegramLive? = nil

    // Groups + mapping tabs
    var chats: [TradingTelegramChat] = []
    var users: [TradingTelegramUser] = []
    var aliases: [TradingTelegramAlias] = []
    var mappingLoaded = false

    var pendingCount: Int { drafts.filter { $0.status == "PENDING" }.count }

    /// First paint + pull-to-refresh: drafts list + owner monitor together.
    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: TradingTelegramDraftsResponse = try await AlmaAPI.shared.get(
                "/api/trading/telegram/drafts",
                query: ["status": draftStatus, "limit": "100", "grouped": "1"])
            drafts = resp.drafts
            draftGroups = resp.groups
            authExpired = false
            // Monitor payload feeds the hero card — non-fatal if the role can't see it.
            monitor = try? await AlmaAPI.shared.get("/api/trading/telegram/monitor", query: [:])
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    // ── Native draft actions (owner 2026-07-11: money writes go native — web
    //    TradingTelegramAdmin PATCH/bulk endpoints verbatim). ──

    var toast: String? = nil
    var actingDraftId: String? = nil       // one spinner per row, never global

    private struct DraftActionBody: Encodable {
        let action: String
        var reason: String? = nil
        var deleteReason: String? = nil
    }
    private struct DraftActionResponse: Decodable {
        let ok: Bool?, error: String?, posted: Int?, rejected: Int?, failed: Int?
    }

    /// PATCH /api/trading/telegram/drafts/{id} — approve | reject | reopen | request_delete.
    func draftAction(_ id: String, action: String,
                     reason: String? = nil, deleteReason: String? = nil) async -> Bool {
        actingDraftId = id
        defer { actingDraftId = nil }
        do {
            let res: DraftActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/trading/telegram/drafts/\(id)",
                body: DraftActionBody(action: action, reason: reason, deleteReason: deleteReason))
            if let err = res.error {
                toast = err
                return false
            }
            toast = switch action {
            case "approve": "Trade confirmed to ledger"
            case "reject": "Draft rejected"
            case "reopen": "Draft reopened"
            default: "Delete request sent to admin for approval"
            }
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

    // ── NP-6 (TR-03): draft edit + bulk confirm/reject — web payloads verbatim ──

    var selectedDrafts: Set<String> = []
    var bulkBusy = false

    struct DraftEditBody: Encodable {
        let action = "edit"
        let tradeType: String
        let usdtAmount: Double
        let bdtRate: Double
        let feeUsdt: Double
        var tradingAccountId: String? = nil
    }

    func editDraft(_ id: String, body: DraftEditBody) async -> Bool {
        actingDraftId = id
        defer { actingDraftId = nil }
        do {
            let res: DraftActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/trading/telegram/drafts/\(id)", body: body)
            if let err = res.error { toast = err; return false }
            toast = "Draft updated"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            toast = error.localizedDescription
            return false
        }
    }

    /// POST /drafts/bulk — confirm ({draftIds}) posts to ledger; reject adds
    /// {action:'reject', reason}. Exact server response counts surface in the toast.
    func bulkAction(reject: Bool, reason: String = "Rejected") async {
        guard !selectedDrafts.isEmpty, !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        struct Body: Encodable {
            let draftIds: [String]
            var action: String? = nil
            var reason: String? = nil
        }
        do {
            let res: DraftActionResponse = try await AlmaAPI.shared.send(
                "POST", "/api/trading/telegram/drafts/bulk",
                body: reject ? Body(draftIds: Array(selectedDrafts), action: "reject", reason: reason)
                             : Body(draftIds: Array(selectedDrafts)))
            if let err = res.error { toast = err; return }
            toast = reject ? "Rejected \(res.rejected ?? 0) draft(s). Failed: \(res.failed ?? 0)"
                           : "Posted \(res.posted ?? 0) trade(s). Failed: \(res.failed ?? 0)"
            selectedDrafts = []
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
        } catch {
            toast = error.localizedDescription
        }
    }

    // ── NP-6 (TR-04): user/alias/group/webhook admin — web payloads verbatim ──

    var adminBusy = false
    var webhookInfo: String? = nil

    private struct OkResp: Decodable { let ok: Bool?; let error: String?; let idempotentReplay: Bool? }

    func linkUser(telegramUserId: String, username: String, userId: String,
                  defaultAccountId: String, alias: String) async -> Bool {
        guard !adminBusy else { return false }
        adminBusy = true
        defer { adminBusy = false }
        struct Body: Encodable {
            let telegramUserId: String
            var telegramUsername: String? = nil
            let userId: String
            var defaultTradingAccountId: String? = nil
            var defaultAccountAlias: String? = nil
            let approved = true
        }
        do {
            let r: OkResp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/telegram/users",
                body: Body(telegramUserId: telegramUserId,
                           telegramUsername: username.isEmpty ? nil : username,
                           userId: userId,
                           defaultTradingAccountId: defaultAccountId.isEmpty ? nil : defaultAccountId,
                           defaultAccountAlias: alias.isEmpty ? nil : alias))
            if let err = r.error { toast = err; return false }
            toast = "Telegram user linked and approved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadMapping(force: true)
            return true
        } catch {
            toast = error.localizedDescription
            return false
        }
    }

    func unlinkUser(_ id: String) async {
        guard !adminBusy else { return }
        adminBusy = true
        defer { adminBusy = false }
        do {
            let r: OkResp = try await AlmaAPI.shared.send("DELETE", "/api/trading/telegram/users/\(id)")
            toast = r.idempotentReplay == true ? "Telegram mapping was already removed" : "Telegram mapping removed"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            toast = error.localizedDescription
        }
        await loadMapping(force: true)
    }

    func saveAlias(alias: String, accountId: String) async -> Bool {
        guard !adminBusy else { return false }
        // Web validation verbatim: 1–16 chars a-z 0-9 _ -
        let clean = alias.trimmingCharacters(in: .whitespaces).lowercased()
        guard clean.range(of: "^[a-z0-9_-]{1,16}$", options: .regularExpression) != nil else {
            toast = "Alias must be 1–16 characters (a-z, 0-9, _, -)"
            return false
        }
        guard !accountId.isEmpty else {
            toast = "Account required"
            return false
        }
        adminBusy = true
        defer { adminBusy = false }
        struct Body: Encodable { let alias: String; let tradingAccountId: String }
        do {
            let r: OkResp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/telegram/aliases", body: Body(alias: clean, tradingAccountId: accountId))
            if let err = r.error { toast = err; return false }
            toast = "Account alias saved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadMapping(force: true)
            return true
        } catch {
            toast = error.localizedDescription
            return false
        }
    }

    func registerGroup(chatId: String, title: String, notes: String) async -> Bool {
        guard !adminBusy else { return false }
        adminBusy = true
        defer { adminBusy = false }
        struct Body: Encodable {
            let chatId: String
            var title: String? = nil
            let approved = true
            var notes: String? = nil
        }
        do {
            let r: OkResp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/telegram/chats",
                body: Body(chatId: chatId.trimmingCharacters(in: .whitespaces),
                           title: title.isEmpty ? nil : title,
                           notes: notes.isEmpty ? nil : notes))
            if let err = r.error { toast = err; return false }
            toast = "Group registered + approved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadMapping(force: true)
            return true
        } catch {
            toast = error.localizedDescription
            return false
        }
    }

    func setGroupApproved(_ id: String, approved: Bool) async {
        guard !adminBusy else { return }
        adminBusy = true
        defer { adminBusy = false }
        struct Body: Encodable { let approved: Bool }
        do {
            let r: OkResp = try await AlmaAPI.shared.send(
                "PATCH", "/api/trading/telegram/chats/\(id)", body: Body(approved: approved))
            if let err = r.error { toast = err } else {
                toast = approved ? "Group approved" : "Group deactivated"
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        } catch {
            toast = error.localizedDescription
        }
        await loadMapping(force: true)
    }

    func testGroup(chatId: String) async {
        guard !adminBusy else { return }
        adminBusy = true
        defer { adminBusy = false }
        struct Body: Encodable { let chatId: String }
        do {
            let r: OkResp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/telegram/chats/test", body: Body(chatId: chatId))
            toast = r.error ?? "Test message পাঠানো হয়েছে ✓"
        } catch {
            toast = error.localizedDescription
        }
    }

    /// GET/POST /api/trading/telegram/setup — webhook status + register.
    func loadWebhook() async {
        struct Resp: Decodable {
            let webhookUrl: String?
            let registered: Bool?
            let botUsername: String?
            private enum Keys: String, CodingKey { case ok, data, webhookUrl, registered, botUsername }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                webhookUrl = try? c.decodeIfPresent(String.self, forKey: .webhookUrl)
                registered = try? c.decodeIfPresent(Bool.self, forKey: .registered)
                botUsername = try? c.decodeIfPresent(String.self, forKey: .botUsername)
            }
        }
        if let r: Resp = try? await AlmaAPI.shared.get("/api/trading/telegram/setup") {
            var bits: [String] = []
            if let b = r.botUsername { bits.append("@\(b)") }
            bits.append(r.registered == true ? "webhook ✓" : "webhook ✗")
            if let u = r.webhookUrl { bits.append(u) }
            webhookInfo = bits.joined(separator: " · ")
        }
    }

    func registerWebhook() async {
        guard !adminBusy else { return }
        adminBusy = true
        defer { adminBusy = false }
        struct Empty: Encodable {}
        do {
            let r: OkResp = try await AlmaAPI.shared.send("POST", "/api/trading/telegram/setup", body: Empty())
            toast = r.error ?? "Webhook registered successfully"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            toast = error.localizedDescription
        }
        await loadWebhook()
    }

    func loadLive() async {
        do {
            let resp: TradingTelegramLive = try await AlmaAPI.shared.get(
                "/api/trading/telegram/live", query: ["limit": "40"])
            live = resp
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            if live == nil { self.error = error.localizedDescription }
        }
    }

    /// Groups + mapping data — fetched lazily the first time those tabs open.
    func loadMapping(force: Bool = false) async {
        if mappingLoaded && !force { return }
        do {
            let c: TradingTelegramChatsResponse = try await AlmaAPI.shared.get(
                "/api/trading/telegram/chats", query: [:])
            let u: TradingTelegramUsersResponse = try await AlmaAPI.shared.get(
                "/api/trading/telegram/users", query: [:])
            let a: TradingTelegramAliasesResponse = try await AlmaAPI.shared.get(
                "/api/trading/telegram/aliases", query: [:])
            chats = c.chats
            users = u.users
            aliases = a.aliases
            mappingLoaded = true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            if !mappingLoaded { self.error = error.localizedDescription }
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
struct TradingTelegramScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingTelegramVM()
    @State private var bulkConfirming = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                heroCard
                tabChips
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.drafts.isEmpty && vm.draftGroups.isEmpty {
                    loadingRows
                } else {
                    switch vm.tab {
                    case .drafts: draftsSection
                    case .monitor: TradingTelegramMonitorSection(vm: vm)
                    case .live: TradingTelegramLiveSection(vm: vm)
                    case .groups: TradingTelegramGroupsSection(vm: vm)
                    case .mapping: TradingTelegramMappingSection(vm: vm)
                    }
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingTelegramAurora())
        .claudeTopFade()
        .refreshable {
            await vm.load()
            if vm.mappingLoaded { await vm.loadMapping(force: true) }
        }
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

    // ── Hero (bento anchor — trading green accent): pending queue + posted /
    //    pending-delete split, fed by the monitor payload. ──

    private var heroCard: some View {
        TradingTelegramHeroCard(
            pending: vm.monitor?.pendingAll ?? vm.pendingCount,
            posted: vm.monitor?.postedQueue ?? 0,
            deletes: vm.monitor?.pendingDeleteApprovals ?? 0)
            .padding(.top, 4)
    }

    // ── Tab row (web: Drafts / Monitor / Live Feed / Groups / Mapping) ──

    private var tabChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TradingTelegramVM.Tab.allCases, id: \.self) { t in
                    tabChip(t)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func tabChip(_ t: TradingTelegramVM.Tab) -> some View {
        let active = vm.tab == t
        let badge = t == .drafts ? vm.pendingCount : 0
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            vm.tab = t
            if t == .groups || t == .mapping {
                Task { await vm.loadMapping() }
            }
        } label: {
            HStack(spacing: 5) {
                Text(t.label).font(.footnote.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? TradingTelegramPalette.tradeGreen : .secondary)
                if badge > 0 {
                    Text("\(badge)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? TradingTelegramPalette.tradeGreen.opacity(colorScheme == .dark ? 0.28 : 0.16)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? TradingTelegramPalette.tradeGreen.opacity(0.55)
                       : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Drafts tab (read-only mirror of the web All Drafts list) ──

    /// NP-6 (TR-03): bulk bar — select-all-pending + confirm/reject with server counts.
    @ViewBuilder private var bulkBar: some View {
        if vm.tab == .drafts {
            HStack(spacing: 8) {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    let pending = (vm.drafts + vm.draftGroups.flatMap(\.drafts))
                        .filter { $0.status == "PENDING" || $0.status == "LOCKED" }
                    vm.selectedDrafts = Set(pending.map(\.id))
                } label: {
                    Text("সব pending").font(.system(size: 10, weight: .bold))
                }
                .buttonStyle(.bordered)
                if !vm.selectedDrafts.isEmpty {
                    Text("\(vm.selectedDrafts.count) selected")
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                        bulkConfirming = true
                    } label: {
                        Text(vm.bulkBusy ? "⏳" : "📗 Post to ledger").font(.system(size: 10, weight: .bold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(TradingTelegramPalette.tradeGreen)
                    .disabled(vm.bulkBusy)
                    .confirmationDialog("Post \(vm.selectedDrafts.count) draft(s) to the ledger?",
                                        isPresented: $bulkConfirming, titleVisibility: .visible) {
                        Button("Post to ledger", role: .destructive) {
                            Task { await vm.bulkAction(reject: false) }
                        }
                        Button("বাতিল", role: .cancel) {}
                    } message: {
                        Text("Balances আর P/L আপডেট হবে।")
                    }
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await vm.bulkAction(reject: true) }
                    } label: {
                        Text("✗ Reject").font(.system(size: 10, weight: .bold))
                    }
                    .buttonStyle(.bordered)
                    .tint(TradingTelegramPalette.red400)
                    .disabled(vm.bulkBusy)
                } else {
                    Spacer()
                }
            }
        }
    }

    @ViewBuilder private var draftsSection: some View {
        bulkBar
        statusChips
        infoBanner
        if vm.drafts.isEmpty && vm.draftGroups.isEmpty {
            emptyState("কোনো Telegram ড্রাফট নেই", icon: "paperplane")
        } else if !vm.draftGroups.isEmpty {
            ForEach(vm.draftGroups) { g in
                TradingTelegramGroupCard(group: g, vm: vm)
            }
        } else {
            ForEach(vm.drafts) { d in
                TradingTelegramDraftCard(draft: d, vm: vm)
            }
        }
    }

    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TradingTelegramVM.statuses, id: \.self) { s in
                    let active = vm.draftStatus == s
                    let tint = s == "ALL" ? TradingTelegramPalette.coral
                                          : TradingTelegramPalette.status(s, colorScheme)
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        vm.draftStatus = s
                        Task { await vm.load() }
                    } label: {
                        Text(s == "ALL" ? "All" : s.capitalized)
                            .font(.caption.weight(active ? .semibold : .regular))
                            .foregroundStyle(active ? tint : .secondary)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .background(active ? tint.opacity(colorScheme == .dark ? 0.24 : 0.14)
                                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                                        in: Capsule())
                            .overlay(Capsule().strokeBorder(
                                active ? tint.opacity(0.5)
                                       : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                                lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// Web amber banner: staff confirm their own drafts — the boss monitors.
    private var infoBanner: some View {
        Label("স্টাফরা নিজেদের ড্রাফট নিজেরাই কনফার্ম করে — কনফার্মের আগে ব্যালান্স বদলায় না। কনফার্ম/এডিট ওয়েবে।",
              systemImage: "info.circle")
            .font(.caption)
            .foregroundStyle(colorScheme == .dark ? TradingTelegramPalette.amber300
                                                  : TradingTelegramPalette.amber600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(TradingTelegramPalette.amber500.opacity(colorScheme == .dark ? 0.10 : 0.08),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(TradingTelegramPalette.amber500.opacity(0.25), lineWidth: 1))
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TradingTelegramPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 84)
                .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingTelegramShimmer()
        }
    }

    private func emptyState(_ message: String, icon: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(.secondary)
            Text(message).foregroundStyle(.secondary)
        }
        .padding(.top, 50)
        .padding(.bottom, 30)
    }

    private var webEscape: some View {
        Button {
            openWeb("/trading/telegram", "Telegram Quick Entry")
        } label: {
            Label("কনফার্ম / এডিট / ম্যাপিং — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Draft cards (web DraftRow / grouped cards, read-only)

@available(iOS 17.0, *)
private struct TradingTelegramGroupCard: View {
    let group: TradingTelegramDraftGroup
    var vm: TradingTelegramVM? = nil
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(TradingTelegramFormat.initials(group.userName))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TradingTelegramPalette.tradeGreen)
                    .frame(width: 34, height: 34)
                    .background(TradingTelegramPalette.tradeGreen.opacity(0.14), in: Circle())
                    .overlay(Circle().strokeBorder(
                        TradingTelegramPalette.tradeGreen.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.userName).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(group.telegramHandle) · \(group.account)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text("\(group.drafts.count)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary)
            }
            Divider().opacity(0.4)
            ForEach(group.drafts) { d in
                TradingTelegramDraftBody(draft: d, showMeta: false, vm: vm)
            }
        }
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramDraftCard: View {
    let draft: TradingTelegramDraft
    var vm: TradingTelegramVM? = nil
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TradingTelegramDraftBody(draft: draft, showMeta: true, vm: vm)
            .padding(14)
            .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramDraftBody: View {
    let draft: TradingTelegramDraft
    let showMeta: Bool
    var vm: TradingTelegramVM? = nil
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmingApprove = false
    @State private var rejectReason = ""
    @State private var askingReject = false
    @State private var deleteReason = ""
    @State private var askingDelete = false

    @State private var showEdit = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                // NP-6 (TR-03): bulk selection — PENDING/LOCKED rows only (web rule).
                if let vm, draft.status == "PENDING" || draft.status == "LOCKED" {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        if vm.selectedDrafts.contains(draft.id) { vm.selectedDrafts.remove(draft.id) }
                        else { vm.selectedDrafts.insert(draft.id) }
                    } label: {
                        Image(systemName: vm.selectedDrafts.contains(draft.id)
                              ? "checkmark.circle.fill" : "circle")
                            .font(.footnote)
                            .foregroundStyle(vm.selectedDrafts.contains(draft.id)
                                             ? TradingTelegramPalette.tradeGreen : Color.secondary)
                    }
                    .buttonStyle(.plain)
                }
                Text(draft.headline)
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let vm, draft.status == "PENDING" || draft.status == "LOCKED" {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        showEdit = true
                    } label: {
                        Image(systemName: "pencil.circle").font(.footnote).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .sheet(isPresented: $showEdit) {
                        TradingTelegramDraftEditSheet(vm: vm, draft: draft) { showEdit = false }
                            .presentationDetents([.medium])
                    }
                }
                TradingTelegramStatusPill(status: draft.status)
            }
            if showMeta {
                Text("ERP: \(draft.userName ?? "—") · \(draft.telegramHandle)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text("Account: \(draft.account)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if let reason = draft.lockedReason, !reason.isEmpty {
                Text(reason).font(.caption2)
                    .foregroundStyle(TradingTelegramPalette.orange500)
            }
            if let reason = draft.rejectReason, !reason.isEmpty {
                Text(reason).font(.caption2)
                    .foregroundStyle(TradingTelegramPalette.red400)
            }
            if let err = draft.parseError, !err.isEmpty {
                Text(err).font(.caption2)
                    .foregroundStyle(TradingTelegramPalette.amber500)
            }
            if let raw = draft.rawMessage, !raw.isEmpty {
                Text(raw)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if let at = draft.createdAt {
                Text(TradingTelegramFormat.when(at))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            actionsRow
        }
    }

    // ── Native draft actions (owner 2026-07-11): confirm-to-ledger / reject /
    //    request-delete on PENDING·LOCKED, reopen on REJECTED — web parity. ──

    @ViewBuilder private var actionsRow: some View {
        if let vm {
            let acting = vm.actingDraftId == draft.id
            HStack(spacing: 8) {
                if draft.status == "PENDING" || draft.status == "LOCKED" {
                    actionButton("লেজারে পোস্ট", tint: TradingTelegramPalette.tradeGreen, busy: acting) {
                        confirmingApprove = true
                    }
                    actionButton("Reject", tint: TradingTelegramPalette.red400, busy: acting) {
                        rejectReason = ""; askingReject = true
                    }
                    actionButton("Delete?", tint: TradingTelegramPalette.amber500, busy: acting) {
                        deleteReason = ""; askingDelete = true
                    }
                } else if draft.status == "REJECTED" {
                    actionButton("Reopen", tint: TradingTelegramPalette.orange500, busy: acting) {
                        Task { _ = await vm.draftAction(draft.id, action: "reopen") }
                    }
                }
            }
            .confirmationDialog(
                "এই draft লেজারে পোস্ট করবেন? Balance আর P/L বদলাবে।\n\(draft.headline)",
                isPresented: $confirmingApprove, titleVisibility: .visible
            ) {
                Button("হ্যাঁ, পোস্ট করুন") {
                    Task { _ = await vm.draftAction(draft.id, action: "approve") }
                }
                Button("বাতিল", role: .cancel) {}
            }
            .alert("Reject reason?", isPresented: $askingReject) {
                TextField("Rejected", text: $rejectReason)
                Button("Reject", role: .destructive) {
                    Task {
                        _ = await vm.draftAction(draft.id, action: "reject",
                                                 reason: rejectReason.isEmpty ? "Rejected" : rejectReason)
                    }
                }
                Button("বাতিল", role: .cancel) {}
            }
            .alert("Delete request-এর কারণ?", isPresented: $askingDelete) {
                TextField("Why delete this draft?", text: $deleteReason)
                Button("Request delete", role: .destructive) {
                    let r = deleteReason.trimmingCharacters(in: .whitespaces)
                    guard !r.isEmpty else { return }
                    Task { _ = await vm.draftAction(draft.id, action: "request_delete", deleteReason: r) }
                }
                Button("বাতিল", role: .cancel) {}
            }
        }
    }

    private func actionButton(_ label: String, tint: Color, busy: Bool,
                              action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            HStack(spacing: 4) {
                if busy { ProgressView().controlSize(.mini) }
                Text(label).font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.8))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramStatusPill: View {
    let status: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let tint = TradingTelegramPalette.status(status, colorScheme)
        Text(status)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }
}

// MARK: - Monitor tab (web "Owner monitoring" card + staff pending + suspicious)

@available(iOS 17.0, *)
private struct TradingTelegramMonitorSection: View {
    let vm: TradingTelegramVM
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let m = vm.monitor {
            monitorKpis(m)
            staffPending(m)
            suspicious(m)
        } else {
            HStack(spacing: 8) {
                AlmaMiniLoader()
                Text("মনিটর ডেটা লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(24)
            .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            .task { await vm.load() }
        }
    }

    private func monitorKpis(_ m: TradingTelegramMonitor) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("OWNER MONITORING")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            Text("স্টাফরা নিজেদের ড্রাফট কনফার্ম করে — আপনি অপারেশন আর রিস্ক দেখেন।")
                .font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 0) {
                kpi("Pending deletes", m.pendingDeleteApprovals,
                    tint: colorScheme == .dark ? TradingTelegramPalette.amber300
                                               : TradingTelegramPalette.amber600)
                divider
                kpi("Pending drafts", m.pendingAll, tint: .primary)
                divider
                kpi("Posted (queue)", m.postedQueue,
                    tint: colorScheme == .dark ? TradingTelegramPalette.green400
                                               : TradingTelegramPalette.emerald600)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var divider: some View {
        Rectangle().fill(Color.primary.opacity(0.10)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 12)
    }

    private func kpi(_ label: String, _ value: Int, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 8.5, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
            Text("\(value)").font(.system(size: 22, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
        }
    }

    @ViewBuilder private func staffPending(_ m: TradingTelegramMonitor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STAFF PENDING BY USER")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if m.staffSummaries.isEmpty {
                Text("কোনো স্টাফের ড্রাফট পেন্ডিং নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(m.staffSummaries) { s in
                    HStack {
                        Text(s.name).font(.caption)
                        Spacer()
                        Text("\(s.pendingCount) pending")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(colorScheme == .dark ? TradingTelegramPalette.amber300
                                                                  : TradingTelegramPalette.amber600)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    @ViewBuilder private func suspicious(_ m: TradingTelegramMonitor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SUSPICIOUS BOT ACTIVITY")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if m.suspiciousAudits.isEmpty {
                Text("সাম্প্রতিক কোনো অ্যালার্ট নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(m.suspiciousAudits) { a in
                    TradingTelegramAuditRow(audit: a)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }
}

// MARK: - Live tab (counts strip + latest trades + events, 8s poll like web)

@available(iOS 17.0, *)
private struct TradingTelegramLiveSection: View {
    let vm: TradingTelegramVM
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let live = vm.live {
                countsStrip(live)
                Text("প্রতি ৮ সেকেন্ডে রিফ্রেশ হচ্ছে · লাইভ ভিউ")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                latestTrades(live)
                events(live)
            } else {
                HStack(spacing: 8) {
                    AlmaMiniLoader()
                    Text("লাইভ ফিড লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(24)
                .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            }
        }
        // Poll only while the tab is on screen — the task dies with the view.
        .task {
            while !Task.isCancelled {
                await vm.loadLive()
                try? await Task.sleep(nanoseconds: 8_000_000_000)
            }
        }
    }

    private func countsStrip(_ live: TradingTelegramLive) -> some View {
        let cells: [(String, Int, Color)] = [
            ("Pending", live.pending, colorScheme == .dark ? TradingTelegramPalette.amber500
                                                           : TradingTelegramPalette.amber600),
            ("Locked", live.locked, TradingTelegramPalette.orange500),
            ("Posted", live.posted, colorScheme == .dark ? TradingTelegramPalette.green400
                                                         : TradingTelegramPalette.emerald600),
            ("Rejected", live.rejected, TradingTelegramPalette.red500),
            ("Undone", live.undone, TradingTelegramPalette.slate400),
        ]
        return HStack(spacing: 8) {
            ForEach(cells, id: \.0) { cell in
                VStack(spacing: 2) {
                    Text("\(cell.1)").font(.subheadline.weight(.heavy)).monospacedDigit()
                        .foregroundStyle(cell.2)
                    Text(cell.0.uppercased()).font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
        }
    }

    @ViewBuilder private func latestTrades(_ live: TradingTelegramLive) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LATEST TRADES")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if live.drafts.isEmpty {
                Text("সাম্প্রতিক কোনো ড্রাফট নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(live.drafts) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .top, spacing: 8) {
                            Text(d.headline)
                                .font(.caption.weight(.bold).monospacedDigit())
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            TradingTelegramStatusPill(status: d.status)
                        }
                        Text("\(d.userName ?? "—") · \(d.telegramHandle) · \(d.account)")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .padding(.vertical, 4)
                    if d != live.drafts.last { Divider().opacity(0.3) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    @ViewBuilder private func events(_ live: TradingTelegramLive) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("EVENTS (DUPLICATES · UNDO)")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if live.audits.isEmpty {
                Text("সাম্প্রতিক কোনো ইভেন্ট নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(live.audits) { a in
                    TradingTelegramAuditRow(audit: a)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramAuditRow: View {
    let audit: TradingTelegramAudit
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(audit.eventType)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TradingTelegramPalette.accentText(colorScheme))
                if let who = audit.telegramUsername ?? audit.telegramUserId {
                    Text("@\(who)").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let at = audit.createdAt {
                    Text(TradingTelegramFormat.when(at))
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
            if let text = audit.detail ?? audit.rawMessage, !text.isEmpty {
                Text(text).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.primary.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Groups tab (registered Telegram groups — read-only list)

@available(iOS 17.0, *)
private struct TradingTelegramGroupsSection: View {
    let vm: TradingTelegramVM
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if !vm.mappingLoaded {
            loadingCard
        } else if vm.chats.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "person.3").font(.largeTitle).foregroundStyle(.secondary)
                Text("কোনো গ্রুপ রেজিস্টার করা নেই").foregroundStyle(.secondary)
            }
            .padding(.vertical, 40)
        } else {
            registerGroupCard
            ForEach(vm.chats) { c in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(c.chatId)
                            .font(.footnote.monospaced().weight(.semibold))
                            .lineLimit(1)
                        approvedPill(c.approved)
                        Spacer(minLength: 0)
                        // NP-6 (TR-04): approve/deactivate + test — web chat admin.
                        Button(c.approved ? "🚫" : "✅") {
                            UISelectionFeedbackGenerator().selectionChanged()
                            Task { await vm.setGroupApproved(c.id, approved: !c.approved) }
                        }
                        .buttonStyle(.bordered)
                        .font(.system(size: 10))
                        .disabled(vm.adminBusy)
                        if c.approved {
                            Button("🧪") {
                                UISelectionFeedbackGenerator().selectionChanged()
                                Task { await vm.testGroup(chatId: c.chatId) }
                            }
                            .buttonStyle(.bordered)
                            .font(.system(size: 10))
                            .disabled(vm.adminBusy)
                        }
                    }
                    Text(c.title?.isEmpty == false ? c.title! : "Untitled group")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Last message: \(TradingTelegramFormat.when(c.lastSeenAt))")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            }
        }
    }

    // NP-6 (TR-04): group register (web POST /chats {chatId,title,approved,notes}).
    @State private var grChatId = ""
    @State private var grTitle = ""

    private var registerGroupCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("REGISTER GROUP")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            TextField("Chat ID (গ্রুপ হলে -100… দিয়ে শুরু)", text: $grChatId)
                .keyboardType(.numbersAndPunctuation)
            TextField("Title (ঐচ্ছিক)", text: $grTitle)
            Button(vm.adminBusy ? "…" : "➕ Register + approve") {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task {
                    if await vm.registerGroup(chatId: grChatId, title: grTitle, notes: "") {
                        grChatId = ""; grTitle = ""
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(TradingTelegramPalette.tradeGreen)
            .disabled(vm.adminBusy || grChatId.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .font(.caption)
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingCard: some View {
        HStack(spacing: 8) {
            AlmaMiniLoader()
            Text("গ্রুপ লিস্ট লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func approvedPill(_ approved: Bool) -> some View {
        let tint = approved
            ? (colorScheme == .dark ? TradingTelegramPalette.green400 : TradingTelegramPalette.emerald600)
            : (colorScheme == .dark ? TradingTelegramPalette.amber300 : TradingTelegramPalette.amber600)
        return Text(approved ? "Approved" : "Inactive")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }
}

// MARK: - Mapping tab (users + aliases overview — writes stay on the web)

@available(iOS 17.0, *)
private struct TradingTelegramMappingSection: View {
    let vm: TradingTelegramVM
    @Environment(\.colorScheme) private var colorScheme
    @State private var unlinkTarget: TradingTelegramUser? = nil

    var body: some View {
        if !vm.mappingLoaded {
            HStack(spacing: 8) {
                AlmaMiniLoader()
                Text("ম্যাপিং লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(24)
            .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        } else {
            usersCard
            aliasesCard
            adminFormsCard
        }
    }

    // NP-6 (TR-04): link user + alias + webhook — web payloads verbatim.
    @State private var nuTelegramId = ""
    @State private var nuUsername = ""
    @State private var nuUserId = ""
    @State private var nuAccountId = ""
    @State private var nuAlias = ""
    @State private var alAlias = ""
    @State private var alAccountId = ""

    @ViewBuilder private var adminFormsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LINK TELEGRAM USER")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            TextField("Telegram user ID (সংখ্যা)", text: $nuTelegramId)
                .keyboardType(.numberPad)
            TextField("@username (ঐচ্ছিক)", text: $nuUsername)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("ERP user ID", text: $nuUserId)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Default trading account ID (ঐচ্ছিক)", text: $nuAccountId)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Default alias (ঐচ্ছিক)", text: $nuAlias)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(vm.adminBusy ? "…" : "🔗 Link + approve") {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task {
                    if await vm.linkUser(telegramUserId: nuTelegramId, username: nuUsername,
                                         userId: nuUserId, defaultAccountId: nuAccountId, alias: nuAlias) {
                        nuTelegramId = ""; nuUsername = ""; nuUserId = ""; nuAccountId = ""; nuAlias = ""
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(TradingTelegramPalette.tradeGreen)
            .disabled(vm.adminBusy || nuTelegramId.isEmpty || nuUserId.isEmpty)

            Divider().opacity(0.4)
            Text("NEW ACCOUNT ALIAS")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            TextField("alias (a-z, 0-9, _, -)", text: $alAlias)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Trading account ID", text: $alAccountId)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(vm.adminBusy ? "…" : "💾 Save alias") {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task {
                    if await vm.saveAlias(alias: alAlias, accountId: alAccountId) {
                        alAlias = ""; alAccountId = ""
                    }
                }
            }
            .buttonStyle(.bordered)
            .disabled(vm.adminBusy || alAlias.isEmpty || alAccountId.isEmpty)

            Divider().opacity(0.4)
            Text("WEBHOOK")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if let info = vm.webhookInfo {
                Text(info).font(.system(size: 10).monospaced()).foregroundStyle(.secondary)
            }
            Button(vm.adminBusy ? "…" : "⚙️ Register webhook") {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task { await vm.registerWebhook() }
            }
            .buttonStyle(.bordered)
            .disabled(vm.adminBusy)
        }
        .font(.caption)
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .task { await vm.loadWebhook() }
    }

    @ViewBuilder private var usersCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TELEGRAM USERS (\(vm.users.count))")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if vm.users.isEmpty {
                Text("কোনো Telegram ইউজার লিঙ্ক করা নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.users) { u in
                    HStack(alignment: .top, spacing: 10) {
                        // NP-6 (TR-04): unlink mapping (web DELETE /users/{id}).
                        Text(TradingTelegramFormat.initials(u.userName ?? u.telegramUsername ?? "?"))
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(TradingTelegramPalette.tradeGreen)
                            .frame(width: 28, height: 28)
                            .background(TradingTelegramPalette.tradeGreen.opacity(0.14), in: Circle())
                        VStack(alignment: .leading, spacing: 1) {
                            Text(u.userName ?? "Unlinked").font(.caption.weight(.semibold))
                            Text("@\(u.telegramUsername ?? "—") · ID \(u.telegramUserId ?? "—")")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            if let alias = u.defaultAccountAlias, !alias.isEmpty {
                                Text("Default: \(alias)").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        Spacer(minLength: 0)
                        Text(u.approved ? "Approved" : "Pending")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(u.approved
                                ? (colorScheme == .dark ? TradingTelegramPalette.green400
                                                        : TradingTelegramPalette.emerald600)
                                : (colorScheme == .dark ? TradingTelegramPalette.amber300
                                                        : TradingTelegramPalette.amber600))
                        // NP-6 (TR-04): unlink (web DELETE /users/{id} with confirm).
                        Button("🗑️") {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            unlinkTarget = u
                        }
                        .buttonStyle(.bordered)
                        .font(.system(size: 10))
                        .disabled(vm.adminBusy)
                    }
                    .padding(.vertical, 3)
                    if u != vm.users.last { Divider().opacity(0.3) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .confirmationDialog(
            unlinkTarget.map { "\($0.userName ?? $0.telegramUsername ?? "user") — mapping মুছবেন?" } ?? "",
            isPresented: Binding(get: { unlinkTarget != nil }, set: { if !$0 { unlinkTarget = nil } }),
            titleVisibility: .visible,
            presenting: unlinkTarget
        ) { u in
            Button("Unlink", role: .destructive) {
                Task { await vm.unlinkUser(u.id) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { u in
            Text("Telegram ID \(u.telegramUserId ?? "—") আর ট্রেড পাঠাতে পারবে না।")
        }
    }

    @ViewBuilder private var aliasesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ACCOUNT ALIASES (\(vm.aliases.count))")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if vm.aliases.isEmpty {
                Text("কোনো অ্যাকাউন্ট অ্যালিয়াস নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.aliases) { a in
                    HStack {
                        Text(a.alias)
                            .font(.caption.monospaced().weight(.bold))
                            .foregroundStyle(TradingTelegramPalette.accentText(colorScheme))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 8)).foregroundStyle(.tertiary)
                        Text(a.accountTitle ?? "—").font(.caption).lineLimit(1)
                        Spacer(minLength: 0)
                        Circle()
                            .fill(a.active
                                ? TradingTelegramPalette.green400
                                : TradingTelegramPalette.slate400)
                            .frame(width: 7, height: 7)
                    }
                    .padding(.vertical, 3)
                    if a != vm.aliases.last { Divider().opacity(0.3) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingTelegramGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
}

// MARK: - Bento hero (dark anchor — trading green accent, Dashboard hero recipe)

@available(iOS 17.0, *)
private struct TradingTelegramHeroCard: View {
    let pending: Int
    let posted: Int
    let deletes: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("TELEGRAM QUICK ENTRY · TRADING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(TradingTelegramPalette.tradeGreen)
            TradingTelegramCountUp(target: pending, format: { "\($0)" })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("পেন্ডিং ড্রাফট — স্টাফের কনফার্মের অপেক্ষায়")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Posted", value: posted,
                         tint: TradingTelegramPalette.green400, sub: "লেজারে গেছে")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Delete req.", value: deletes,
                         tint: TradingTelegramPalette.amber300, sub: "অ্যাপ্রুভাল দরকার")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [TradingTelegramPalette.tradeGreen.opacity(0.30), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.26), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.14), .clear],
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
            TradingTelegramCountUp(target: value, format: { "\($0)" })
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Formatting helpers

private enum TradingTelegramFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    /// Trim trailing zeros: 500.0 → "500", 122.50 → "122.5".
    static func num(_ value: Double?) -> String {
        guard let value else { return "—" }
        if value == value.rounded() && abs(value) < 1e12 {
            return String(Int(value))
        }
        return String(format: "%.2f", value)
            .replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
    }

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let display: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "d MMM · h:mm a"
        return f
    }()

    /// ISO wire timestamp → "8 Jul · 3:42 pm" (Never / raw string on parse miss).
    static func when(_ at: String?) -> String {
        guard let at, !at.isEmpty else { return "Never" }
        if let d = isoFrac.date(from: at) ?? iso.date(from: at) {
            return display.string(from: d)
        }
        return at
    }
}

// MARK: - Aurora background + glass (page-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingTelegramAurora: View {
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
    func tradingTelegramGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramShimmer: ViewModifier {
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
    func tradingTelegramShimmer() -> some View { modifier(TradingTelegramShimmer()) }
}

// MARK: - Count-up (page-owned copy of the Dashboard board language)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func tradingTelegramMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TradingTelegramCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        TradingTelegramCountUpText(value: shown, format: format)
            .animation(tradingTelegramMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if tradingTelegramMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TradingTelegramCountUpText: View, Animatable {
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

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Telegram Quick Entry — Light") {
    TradingTelegramScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}


// MARK: - NP-6 (TR-03): draft edit sheet (web saveEdit payload verbatim)

@available(iOS 17.0, *)
private struct TradingTelegramDraftEditSheet: View {
    let vm: TradingTelegramVM
    let draft: TradingTelegramDraft
    let onDone: () -> Void
    @State private var type = "BUY"
    @State private var usdt = ""
    @State private var rate = ""
    @State private var feeUsdt = ""
    @State private var accountId = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Draft #\(draft.id.prefix(8))") {
                    Picker("Type", selection: $type) {
                        Text("BUY").tag("BUY")
                        Text("SELL").tag("SELL")
                    }
                    TextField("USDT amount", text: $usdt).keyboardType(.decimalPad)
                    TextField("BDT rate", text: $rate).keyboardType(.decimalPad)
                    TextField("Fee (USDT)", text: $feeUsdt).keyboardType(.decimalPad)
                    TextField("Trading account ID (ঐচ্ছিক)", text: $accountId)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            .navigationTitle("Edit draft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বাতিল") { onDone() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("সেভ") {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task {
                            guard let u = Double(usdt), let r = Double(rate) else { return }
                            if await vm.editDraft(draft.id, body: .init(
                                tradeType: type, usdtAmount: u, bdtRate: r,
                                feeUsdt: Double(feeUsdt) ?? 0,
                                tradingAccountId: accountId.isEmpty ? nil : accountId)) {
                                onDone()
                            }
                        }
                    }
                    .disabled(Double(usdt) == nil || Double(rate) == nil)
                }
            }
            .onAppear {
                type = draft.tradeType ?? "BUY"
                usdt = draft.usdtAmount.map { String($0) } ?? ""
                rate = draft.bdtRate.map { String($0) } ?? ""
                feeUsdt = draft.feeUsdt.map { String($0) } ?? ""
            }
        }
    }
}
