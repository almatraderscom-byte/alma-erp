//
//  TradingAccountAdminSwiftUI.swift
//  ALMA ERP — NP-6: trading account detail ADMIN section (TR-01 + TR-02).
//
//  Embedded in TradingAccountsDetailSheet. Native parity for the web
//  /trading/accounts/[id] money-sensitive actions:
//    · Trades: audit view · edit (PATCH /api/trading/trades/{id} {action:'edit',…,editReason})
//      · request/approve/reject delete ({action:'request_delete'|'approve_delete'|
//      'reject_delete', deleteReason/rejectionReason}) — web tradeStatus() gating rules
//    · Daily summary: bkash summaries list + native add
//      (POST /api/trading/accounts/{id}/bkash-summary)
//    · Performance: full screenshot history (GET …/performance, cursor paging +
//      archived toggle) + native upload (multipart, PhotosPicker)
//    · Settlement (TR-02): GET …/partnership preview + unsettled expenses +
//      history; POST …/partnership/settle {notes, adminOverrideBdt, postToWallet}
//      with BEFORE/AFTER verification — the before preview is captured, the
//      confirm dialog states account + ৳ amount + effect, and after the server
//      reply the preview/history are re-fetched and the delta is shown.
//  Whole-taka BDT everywhere the backend expects whole taka (Int rounding).
//

import SwiftUI
import PhotosUI

// MARK: - Money helpers

private func tkWhole(_ v: Double?) -> Int { Int((v ?? 0).rounded()) }
private func tk(_ v: Double?) -> String { "৳\(tkWhole(v).formatted())" }

private func flexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (web types verbatim, lenient)

struct TAAdminTrade: Decodable, Identifiable {
    let id: String
    let tradeType: String
    let usdtAmount: Double
    let bdtRate: Double
    let feeUsdt: Double
    let feeBdt: Double
    let netBdt: Double
    let netProfit: Double
    let tradeDate: String?
    let notes: String?
    let deletedAt: String?
    let deleteReason: String?
    let deleteApprovedAt: String?
    let editedCount: Int

    private enum Keys: String, CodingKey {
        case id, tradeType, usdtAmount, bdtRate, buyRateBdt, sellRateBdt, feeUsdt, feeBdt, feeAmount
        case netBdt, netProfit, tradeDate, notes, deletedAt, deleteReason, deleteApprovedAt, editHistory
    }
    private struct EditRow: Decodable { let action: String? }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        tradeType = (try? c.decodeIfPresent(String.self, forKey: .tradeType)) ?? "BUY"
        usdtAmount = flexDouble(c, .usdtAmount) ?? 0
        bdtRate = flexDouble(c, .bdtRate)
            ?? (tradeType == "BUY" ? flexDouble(c, .buyRateBdt) : flexDouble(c, .sellRateBdt)) ?? 0
        feeUsdt = flexDouble(c, .feeUsdt) ?? 0
        feeBdt = flexDouble(c, .feeBdt) ?? flexDouble(c, .feeAmount) ?? 0
        netBdt = flexDouble(c, .netBdt) ?? 0
        netProfit = flexDouble(c, .netProfit) ?? 0
        tradeDate = try? c.decodeIfPresent(String.self, forKey: .tradeDate)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        deletedAt = try? c.decodeIfPresent(String.self, forKey: .deletedAt)
        deleteReason = try? c.decodeIfPresent(String.self, forKey: .deleteReason)
        deleteApprovedAt = try? c.decodeIfPresent(String.self, forKey: .deleteApprovedAt)
        let history = (try? c.decodeIfPresent([EditRow].self, forKey: .editHistory)) ?? []
        editedCount = history.filter { $0.action == "EDITED" }.count
    }

    /// Web tradeStatus() verbatim.
    var status: String {
        if deletedAt != nil { return "DELETED" }
        if deleteReason != nil && deleteApprovedAt == nil { return "DELETE_PENDING" }
        if editedCount > 0 { return "EDITED" }
        return "ACTIVE"
    }
    var isActive: Bool { status != "DELETED" && status != "DELETE_PENDING" }
}

/// Bkash daily summary — the web TradingBkashDailySummary verbatim
/// (totalOrders / totalProfitBdt / totalLossBdt / netResultBdt). The earlier
/// opening/closing/used field names never existed on this endpoint: the list
/// always read ৳0 and the form POSTed a payload the API ignored, which upserted
/// a ZERO row over the real one for that date.
struct TAAdminBkashSummary: Decodable, Identifiable {
    let id: String
    let summaryDate: String?
    let totalOrders: Int
    let totalProfitBdt: Double
    let totalLossBdt: Double
    let netResultBdt: Double
    let notes: String?
    private enum Keys: String, CodingKey {
        case id, summaryDate, totalOrders, totalProfitBdt, totalLossBdt, netResultBdt, notes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        summaryDate = try? c.decodeIfPresent(String.self, forKey: .summaryDate)
        totalOrders = Int(flexDouble(c, .totalOrders) ?? 0)
        totalProfitBdt = flexDouble(c, .totalProfitBdt) ?? 0
        totalLossBdt = flexDouble(c, .totalLossBdt) ?? 0
        netResultBdt = flexDouble(c, .netResultBdt) ?? (totalProfitBdt - totalLossBdt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
    }
}

struct TAAdminScreenshot: Decodable, Identifiable {
    let id: String
    let shotDate: String?
    let note: String?
    let uploaderName: String?
    /// The API returns `signedUrl` — a RELATIVE path (/api/trading/screenshots/{id}/preview)
    /// served behind the session cookie. The old decoder looked for imageUrl/url, which
    /// this endpoint has never sent, so every tile rendered an empty placeholder.
    let signedPath: String?
    let archivedAt: String?
    private enum Keys: String, CodingKey {
        case id, shotDate, note, signedUrl, imageUrl, url, archivedAt, uploader
    }
    private struct UploaderRef: Decodable { let name: String? }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        shotDate = try? c.decodeIfPresent(String.self, forKey: .shotDate)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        uploaderName = (try? c.decodeIfPresent(UploaderRef.self, forKey: .uploader))?.name
        signedPath = (try? c.decodeIfPresent(String.self, forKey: .signedUrl))
            ?? (try? c.decodeIfPresent(String.self, forKey: .imageUrl))
            ?? (try? c.decodeIfPresent(String.self, forKey: .url))
        archivedAt = try? c.decodeIfPresent(String.self, forKey: .archivedAt)
    }

    /// URLSession.shared shares HTTPCookieStorage with AlmaAPI's bridged cookies,
    /// so AsyncImage can fetch the authenticated preview directly.
    var imageURL: URL? {
        guard let signedPath, !signedPath.isEmpty else { return nil }
        if signedPath.hasPrefix("http") { return URL(string: signedPath) }
        return URL(string: signedPath, relativeTo: AlmaAPI.baseURL)
    }
}

struct TAPartnershipPreview: Decodable {
    let partnershipEnabled: Bool
    let staffSharePercent: Double
    let periodStart: String?
    let periodEnd: String?
    let netTradingDeltaBdt: Double
    let ownerPaidExpensesBdt: Double
    let staffPaidExpensesBdt: Double
    let staffTradingShareBdt: Double
    let expenseAdjustmentBdt: Double
    let netStaffOwesBdt: Double
    let unsettledCount: Int

    private enum Keys: String, CodingKey {
        case partnershipEnabled, staffSharePercent, periodStart, periodEnd
        case netTradingDeltaBdt, ownerPaidExpensesBdt, staffPaidExpensesBdt
        case staffTradingShareBdt, expenseAdjustmentBdt, netStaffOwesBdt, unsettledExpenses
    }
    private struct AnyRow: Decodable {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        partnershipEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .partnershipEnabled)) ?? false
        staffSharePercent = flexDouble(c, .staffSharePercent) ?? 0
        periodStart = try? c.decodeIfPresent(String.self, forKey: .periodStart)
        periodEnd = try? c.decodeIfPresent(String.self, forKey: .periodEnd)
        netTradingDeltaBdt = flexDouble(c, .netTradingDeltaBdt) ?? 0
        ownerPaidExpensesBdt = flexDouble(c, .ownerPaidExpensesBdt) ?? 0
        staffPaidExpensesBdt = flexDouble(c, .staffPaidExpensesBdt) ?? 0
        staffTradingShareBdt = flexDouble(c, .staffTradingShareBdt) ?? 0
        expenseAdjustmentBdt = flexDouble(c, .expenseAdjustmentBdt) ?? 0
        netStaffOwesBdt = flexDouble(c, .netStaffOwesBdt) ?? 0
        unsettledCount = ((try? c.decodeIfPresent([AnyRow].self, forKey: .unsettledExpenses)) ?? []).count
    }
}

struct TAPartnershipSettlement: Decodable, Identifiable {
    let id: String
    let periodStart: String?
    let periodEnd: String?
    let netStaffOwesBdt: Double
    let adminOverrideBdt: Double?
    let notes: String?
    let ledgerEntryId: String?
    private enum Keys: String, CodingKey {
        case id, periodStart, periodEnd, netStaffOwesBdt, adminOverrideBdt, notes, ledgerEntryId
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        periodStart = try? c.decodeIfPresent(String.self, forKey: .periodStart)
        periodEnd = try? c.decodeIfPresent(String.self, forKey: .periodEnd)
        netStaffOwesBdt = flexDouble(c, .netStaffOwesBdt) ?? 0
        adminOverrideBdt = flexDouble(c, .adminOverrideBdt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        ledgerEntryId = try? c.decodeIfPresent(String.self, forKey: .ledgerEntryId)
    }
}

// MARK: - Store

@available(iOS 17.0, *)
@Observable
@MainActor
final class TAAdminStore {
    let accountId: String
    init(accountId: String) { self.accountId = accountId }

    var trades: [TAAdminTrade] = []
    var bkash: [TAAdminBkashSummary] = []
    var screenshots: [TAAdminScreenshot] = []
    var screenshotsCursor: String? = nil
    var screenshotsArchived = false
    var preview: TAPartnershipPreview? = nil
    var history: [TAPartnershipSettlement] = []
    var busy = false
    var notice: String? = nil
    var settleResult: String? = nil     // before/after verification line

    private struct DetailResp: Decodable {
        let recentTrades: [TAAdminTrade]
        let bkashSummaries: [TAAdminBkashSummary]
        let performanceScreenshots: [TAAdminScreenshot]
        private enum Keys: String, CodingKey { case ok, data, recentTrades, bkashSummaries, performanceScreenshots }
        init(from decoder: Decoder) throws {
            let root = try decoder.container(keyedBy: Keys.self)
            let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
            recentTrades = (try? c.decodeIfPresent([TAAdminTrade].self, forKey: .recentTrades)) ?? []
            bkashSummaries = (try? c.decodeIfPresent([TAAdminBkashSummary].self, forKey: .bkashSummaries)) ?? []
            performanceScreenshots = (try? c.decodeIfPresent([TAAdminScreenshot].self, forKey: .performanceScreenshots)) ?? []
        }
    }

    func load() async {
        if let d: DetailResp = try? await AlmaAPI.shared.get("/api/trading/accounts/\(accountId)/summary") {
            trades = d.recentTrades
            bkash = d.bkashSummaries
            if screenshots.isEmpty { screenshots = d.performanceScreenshots }
        }
        await loadPartnership()
    }

    func loadPartnership() async {
        struct Resp: Decodable {
            let preview: TAPartnershipPreview?
            let history: [TAPartnershipSettlement]
            private enum Keys: String, CodingKey { case ok, data, preview, history }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                preview = try? c.decodeIfPresent(TAPartnershipPreview.self, forKey: .preview)
                history = (try? c.decodeIfPresent([TAPartnershipSettlement].self, forKey: .history)) ?? []
            }
        }
        if let r: Resp = try? await AlmaAPI.shared.get("/api/trading/accounts/\(accountId)/partnership") {
            preview = r.preview
            history = r.history
        }
    }

    func loadScreenshots(archived: Bool, cursor: String? = nil) async {
        struct Resp: Decodable {
            let screenshots: [TAAdminScreenshot]
            let nextCursor: String?
            private enum Keys: String, CodingKey { case ok, data, screenshots, nextCursor }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                screenshots = (try? c.decodeIfPresent([TAAdminScreenshot].self, forKey: .screenshots)) ?? []
                nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
            }
        }
        if let r: Resp = try? await AlmaAPI.shared.get(
            "/api/trading/accounts/\(accountId)/performance",
            query: ["archived": archived ? "1" : "", "cursor": cursor ?? "", "limit": "30"]) {
            if cursor == nil { screenshots = r.screenshots }
            else { screenshots += r.screenshots }
            screenshotsCursor = r.nextCursor
            screenshotsArchived = archived
        }
    }

    /// PATCH /api/trading/trades/{id} — the web TradingTradeActionInput verbatim.
    func tradeAction(_ trade: TAAdminTrade, mode: String,
                     edit: (type: String, usdt: String, rate: String, feeUsdt: String, date: String, notes: String)? = nil,
                     reason: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        struct Body: Encodable {
            let action: String
            var tradeType: String? = nil
            var usdtAmount: Double? = nil
            var bdtRate: Double? = nil
            var feeUsdt: Double? = nil
            var tradeDate: String? = nil
            var notes: String? = nil
            var editReason: String? = nil
            var deleteReason: String? = nil
            var rejectionReason: String? = nil
        }
        var body = Body(action: mode)
        switch mode {
        case "edit":
            guard let e = edit, let usdt = Double(e.usdt), let rate = Double(e.rate) else {
                notice = "✗ সংখ্যাগুলো চেক করুন"
                return false
            }
            body.tradeType = e.type
            body.usdtAmount = usdt
            body.bdtRate = rate
            body.feeUsdt = Double(e.feeUsdt) ?? 0
            body.tradeDate = e.date.isEmpty ? nil : e.date
            body.notes = e.notes.isEmpty ? nil : e.notes
            body.editReason = reason
        case "request_delete": body.deleteReason = reason
        case "reject_delete": body.rejectionReason = reason
        default: break
        }
        struct Resp: Decodable { let ok: Bool?; let error: String? }
        do {
            let _: Resp = try await AlmaAPI.shared.send("PATCH", "/api/trading/trades/\(trade.id)", body: body)
            notice = "✓ Trade \(mode.replacingOccurrences(of: "_", with: " ")) হয়েছে"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            notice = "✗ ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }

    /// POST /api/trading/accounts/{id}/bkash-summary — daily summary entry.
    /// Payload is the web form's verbatim: totalOrders (integer) + non-negative
    /// totalProfitBdt / totalLossBdt. The column is a 2-dp decimal and the web
    /// dashboard modal posts what was typed, so amounts travel UNROUNDED — the
    /// route upserts on (account, date), and rounding here would overwrite a
    /// decimal row saved from the web with a changed number.
    /// A non-empty field that does not parse is rejected rather than silently
    /// becoming 0, for the same reason.
    func addBkashSummary(date: String, orders: String, profit: String, loss: String,
                         notes: String) async -> Bool {
        guard !busy else { return false }
        guard let ordersValue = Self.parseCount(orders),
              let profitValue = Self.parseAmount(profit),
              let lossValue = Self.parseAmount(loss),
              ordersValue >= 0, profitValue >= 0, lossValue >= 0 else {
            notice = "✗ সংখ্যাগুলো চেক করুন"
            return false
        }
        busy = true
        defer { busy = false }
        struct Body: Encodable {
            let tradingAccountId: String
            let summaryDate: String
            let totalOrders: Int
            let totalProfitBdt: Double
            let totalLossBdt: Double
            let notes: String?
        }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/accounts/\(accountId)/bkash-summary",
                body: Body(tradingAccountId: accountId, summaryDate: date,
                           totalOrders: ordersValue,
                           totalProfitBdt: profitValue,
                           totalLossBdt: lossValue,
                           notes: notes.isEmpty ? nil : notes))
            notice = "✓ Daily summary সেভ হয়েছে"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            notice = "✗ ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }

    /// Empty means "not entered" (0); anything else must parse, so a stray "." or
    /// pasted text can never post as a zero over a real row.
    static func parseAmount(_ raw: String) -> Double? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return 0 }
        return Double(t)
    }
    static func parseCount(_ raw: String) -> Int? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return 0 }
        return Int(t)
    }

    /// Multipart upload — web uploadPerformanceScreenshot parity (the web form
    /// posts the shot DATE alongside the file, so a backfilled screenshot lands on
    /// the day it belongs to instead of today).
    func uploadScreenshot(data: Data, note: String, shotDate: String = "") async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        struct Resp: Decodable { let ok: Bool? }
        do {
            var fields: [String: String] = [:]
            if !note.isEmpty { fields["note"] = note }
            if !shotDate.isEmpty { fields["shotDate"] = shotDate }
            let _: Resp = try await AlmaAPI.shared.uploadMultipart(
                "/api/trading/accounts/\(accountId)/performance",
                fileField: "file", filename: "performance.jpg", mime: "image/jpeg",
                data: data, fields: fields)
            notice = "✓ Screenshot আপলোড হয়েছে"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadScreenshots(archived: screenshotsArchived)
        } catch {
            notice = "✗ Upload ব্যর্থ: \(error.localizedDescription)"
        }
    }

    /// TR-02 settle — BEFORE/AFTER verification built in (roadmap money rules).
    func settle(notes: String, overrideBdt: String, postToWallet: Bool) async -> Bool {
        guard !busy, let before = preview else { return false }
        busy = true
        defer { busy = false }
        struct Body: Encodable {
            let notes: String?
            let adminOverrideBdt: Int?
            let postToWallet: Bool
        }
        struct Resp: Decodable { let ok: Bool?; let ledgerEntryId: String? }
        let beforeOwes = tkWhole(before.netStaffOwesBdt)
        let beforeHistory = history.count
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/accounts/\(accountId)/partnership/settle",
                body: Body(notes: notes.isEmpty ? nil : notes,
                           adminOverrideBdt: Double(overrideBdt).map { Int($0.rounded()) },
                           postToWallet: postToWallet))
            // AFTER: re-fetch server truth and assert the settlement landed.
            await loadPartnership()
            let afterOwes = tkWhole(preview?.netStaffOwesBdt)
            let landed = history.count > beforeHistory
            settleResult = landed
                ? "✅ Settlement verified — আগে ৳\(beforeOwes.formatted()) বাকি ছিল, এখন ৳\(afterOwes.formatted())" +
                  " · history \(beforeHistory)→\(history.count)" +
                  (r.ledgerEntryId != nil ? " · wallet posted" : "")
                : "⚠️ Settlement reply OK কিন্তু history-তে এখনো দেখা যাচ্ছে না — রিফ্রেশ করে দেখুন"
            UINotificationFeedbackGenerator().notificationOccurred(landed ? .success : .warning)
            return true
        } catch {
            settleResult = "✗ Settle ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }
}

// MARK: - Admin section view (embedded in the account detail sheet)

@available(iOS 17.0, *)
struct TradingAccountAdminSection: View {
    let accountId: String
    let accountTitle: String
    let partnershipEnabled: Bool
    let isSuperAdmin: Bool
    @Environment(\.colorScheme) private var scheme
    @State private var store: TAAdminStore
    @State private var seg = 0   // 0 trades · 1 daily · 2 screenshots · 3 settlement
    @State private var tradeSheet: TradeSheetMode? = nil
    @State private var showBkashForm = false
    @State private var photoItem: PhotosPickerItem? = nil
    @State private var zoomShot: TAAdminScreenshot? = nil
    @State private var shotNote = ""
    @State private var shotDate = ""
    @State private var settleConfirm = false
    @State private var settleNotes = ""
    @State private var settleOverride = ""
    @State private var settlePostWallet = false

    private let emerald = Color(red: 0.020, green: 0.588, blue: 0.412)
    private let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)
    private let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)
    private let gold = Color(red: 0.831, green: 0.659, blue: 0.294)

    enum TradeSheetMode: Identifiable {
        case audit(TAAdminTrade), edit(TAAdminTrade), requestDelete(TAAdminTrade), rejectDelete(TAAdminTrade)
        var id: String {
            switch self {
            case .audit(let t): return "a-\(t.id)"
            case .edit(let t): return "e-\(t.id)"
            case .requestDelete(let t): return "d-\(t.id)"
            case .rejectDelete(let t): return "r-\(t.id)"
            }
        }
    }

    init(accountId: String, accountTitle: String, partnershipEnabled: Bool, isSuperAdmin: Bool) {
        self.accountId = accountId
        self.accountTitle = accountTitle
        self.partnershipEnabled = partnershipEnabled
        self.isSuperAdmin = isSuperAdmin
        _store = State(initialValue: TAAdminStore(accountId: accountId))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $seg) {
                Text("Trades").tag(0)
                Text("Daily").tag(1)
                Text("Shots").tag(2)
                if partnershipEnabled { Text("Settle").tag(3) }
            }
            .pickerStyle(.segmented)
            if let n = store.notice {
                Text(n).font(.caption2)
                    .foregroundStyle(n.hasPrefix("✓") ? emerald : red500)
            }
            switch seg {
            case 1: dailyPanel
            case 2: shotsPanel
            case 3: settlementPanel
            default: tradesPanel
            }
        }
        .task { await store.load() }
        .sheet(item: $tradeSheet) { mode in
            TradeActionSheet(store: store, mode: mode) { tradeSheet = nil }
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $zoomShot) { shot in
            TAShotZoomSheet(shot: shot)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data),
                   let jpeg = img.jpegData(compressionQuality: 0.8) {
                    await store.uploadScreenshot(data: jpeg, note: shotNote, shotDate: shotDate)
                    shotNote = ""
                }
                photoItem = nil
            }
        }
    }

    // ── Trades (audit/edit/delete flows — web TradeList gating) ──

    @ViewBuilder private var tradesPanel: some View {
        if store.trades.isEmpty {
            Text("No trades yet").font(.caption2).foregroundStyle(.secondary)
        }
        ForEach(store.trades) { t in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(t.tradeType)
                        .font(.caption.weight(.black))
                        .foregroundStyle(t.tradeType == "BUY" ? gold : emerald)
                    Text("\(t.usdtAmount.formatted()) USDT · rate \(String(format: "%.4f", t.bdtRate))")
                        .font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Text(t.status)
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(t.status == "DELETED" ? red500
                                         : t.status == "DELETE_PENDING" ? amber600
                                         : t.status == "EDITED" ? gold : emerald)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background((t.status == "ACTIVE" ? emerald : amber600).opacity(0.10), in: Capsule())
                }
                HStack(spacing: 8) {
                    Text("Net \(tk(t.netBdt))").font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    Text("P/L \(tk(t.netProfit))")
                        .font(.system(size: 10, weight: .bold).monospacedDigit())
                        .foregroundStyle(t.netProfit >= 0 ? emerald : red500)
                    Spacer()
                    Button("Audit") { tradeSheet = .audit(t) }
                        .font(.system(size: 10, weight: .bold)).buttonStyle(.bordered)
                    if t.isActive {
                        Button("Edit") { tradeSheet = .edit(t) }
                            .font(.system(size: 10, weight: .bold)).buttonStyle(.bordered)
                        Button("Delete?") { tradeSheet = .requestDelete(t) }
                            .font(.system(size: 10, weight: .bold)).buttonStyle(.bordered).tint(red500)
                    }
                    if isSuperAdmin && t.status == "DELETE_PENDING" {
                        Button("✓") {
                            Task { _ = await store.tradeAction(t, mode: "approve_delete", reason: "") }
                        }
                        .font(.system(size: 10, weight: .bold)).buttonStyle(.borderedProminent).tint(emerald)
                        Button("✗") { tradeSheet = .rejectDelete(t) }
                            .font(.system(size: 10, weight: .bold)).buttonStyle(.bordered).tint(red500)
                    }
                }
            }
            .padding(.vertical, 4)
            Divider().opacity(0.3)
        }
    }

    // ── Daily summary (bkash) ──

    @ViewBuilder private var dailyPanel: some View {
        Button {
            showBkashForm.toggle()
        } label: {
            Label("দিনের সামারি যোগ করুন", systemImage: "plus.circle")
                .font(.caption.weight(.bold))
        }
        .buttonStyle(.bordered)
        if showBkashForm {
            TABkashForm(store: store) { showBkashForm = false }
        }
        ForEach(store.bkash) { b in
            HStack(spacing: 8) {
                Text(String((b.summaryDate ?? "—").prefix(10)))
                    .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                Text("\(b.totalOrders) orders · profit \(tk(b.totalProfitBdt)) · loss \(tk(b.totalLossBdt))")
                    .font(.system(size: 10).monospacedDigit())
                    .lineLimit(1).minimumScaleFactor(0.7)
                Spacer()
                Text("Net \(tk(b.netResultBdt))")
                    .font(.system(size: 10, weight: .bold).monospacedDigit())
                    .foregroundStyle(b.netResultBdt >= 0 ? Color.green : Color.red)
            }
            .padding(.vertical, 3)
            Divider().opacity(0.3)
        }
    }

    // ── Screenshot history + upload ──

    @ViewBuilder private var shotsPanel: some View {
        Text("দিনের Binance প্রোফাইল স্ক্রিনশট। সর্বশেষ ৭টি দেখা যায় · পুরনোগুলো Archived-এ।")
            .font(.system(size: 10)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        // Web PerformancePanel date + note fields travel with the upload.
        HStack(spacing: 8) {
            TextField("তারিখ YYYY-MM-DD", text: $shotDate)
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.plain)
                .font(.caption)
                .taAdminFieldChrome()
            TextField("Growth note…", text: $shotNote)
                .textFieldStyle(.plain)
                .font(.caption)
                .taAdminFieldChrome()
        }
        .onAppear {
            if shotDate.isEmpty {
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd"
                f.timeZone = TimeZone(identifier: "Asia/Dhaka")
                shotDate = f.string(from: Date())
            }
        }
        HStack {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label(store.busy ? "আপলোড হচ্ছে…" : "📸 আপলোড", systemImage: "square.and.arrow.up")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.bordered)
            .disabled(store.busy)
            Spacer()
            Toggle("Archived", isOn: Binding(
                get: { store.screenshotsArchived },
                set: { on in Task { await store.loadScreenshots(archived: on) } }))
                .font(.caption2)
                .toggleStyle(.button)
        }
        .task { await store.loadScreenshots(archived: false) }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(store.screenshots) { shot in
                VStack(alignment: .leading, spacing: 3) {
                    TAShotThumb(url: shot.imageURL, height: 110)
                    Text(String((shot.shotDate ?? "—").prefix(10)))
                        .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    if let note = shot.note, !note.isEmpty {
                        Text(note).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { zoomShot = shot }
            }
        }
        if store.screenshotsCursor != nil {
            Button("আরও দেখুন") {
                Task { await store.loadScreenshots(archived: store.screenshotsArchived,
                                                  cursor: store.screenshotsCursor) }
            }
            .font(.caption.weight(.bold))
            .buttonStyle(.bordered)
            .frame(maxWidth: .infinity)
        }
        beforeAfterCard
    }

    /// Web PerformancePanel "Before vs After" — oldest visible shot beside the newest.
    @ViewBuilder private var beforeAfterCard: some View {
        let rows = store.screenshots
        if let after = rows.first, let before = rows.last, before.id != after.id,
           before.imageURL != nil, after.imageURL != nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("BEFORE vs AFTER").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    comparisonShot("Before", before)
                    comparisonShot("After", after)
                }
            }
            .padding(.top, 6)
        }
    }

    private func comparisonShot(_ label: String, _ shot: TAAdminScreenshot) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            TAShotThumb(url: shot.imageURL, height: 96)
            Text("\(label) · \(String((shot.shotDate ?? "—").prefix(10)))")
                .font(.system(size: 9, weight: .bold)).foregroundStyle(gold)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { zoomShot = shot }
    }

    // ── Settlement (TR-02) ──

    @ViewBuilder private var settlementPanel: some View {
        if let p = store.preview {
            VStack(alignment: .leading, spacing: 6) {
                Text("Preview — staff share \(Int(p.staffSharePercent))% · period \(String((p.periodStart ?? "শুরু").prefix(10))) → \(String((p.periodEnd ?? "—").prefix(10)))")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                settleRow("Net trading delta", p.netTradingDeltaBdt)
                settleRow("Staff trading share", p.staffTradingShareBdt)
                settleRow("Owner-paid expenses", p.ownerPaidExpensesBdt)
                settleRow("Staff-paid expenses", p.staffPaidExpensesBdt)
                settleRow("Expense adjustment", p.expenseAdjustmentBdt)
                HStack {
                    Text("NET STAFF OWES").font(.caption.weight(.black))
                    Spacer()
                    Text(tk(p.netStaffOwesBdt))
                        .font(.caption.weight(.black).monospacedDigit())
                        .foregroundStyle(p.netStaffOwesBdt >= 0 ? amber600 : emerald)
                }
                if p.unsettledCount > 0 {
                    Text("⚠️ \(p.unsettledCount) unsettled expense এই হিসাবের ভেতরে ধরা আছে")
                        .font(.system(size: 10)).foregroundStyle(amber600)
                }
                TextField("Notes (ঐচ্ছিক)", text: $settleNotes)
                    .font(.caption).textFieldStyle(.roundedBorder)
                TextField("Admin override ৳ (ঐচ্ছিক)", text: $settleOverride)
                    .font(.caption).textFieldStyle(.roundedBorder).keyboardType(.numberPad)
                Toggle("Wallet-এ পোস্ট করুন", isOn: $settlePostWallet).font(.caption)
                Button {
                    UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                    settleConfirm = true
                } label: {
                    Text(store.busy ? "⏳ Settling…" : "💰 Confirm settlement")
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(gold.opacity(0.15), in: Capsule())
                        .foregroundStyle(gold)
                }
                .buttonStyle(.plain)
                .disabled(store.busy)
                .confirmationDialog("Settlement নিশ্চিত করবেন?", isPresented: $settleConfirm,
                                    titleVisibility: .visible) {
                    Button("Settle ৳\(tkWhole(Double(settleOverride) ?? p.netStaffOwesBdt).formatted())",
                           role: .destructive) {
                        Task { _ = await store.settle(notes: settleNotes, overrideBdt: settleOverride,
                                                      postToWallet: settlePostWallet) }
                    }
                    Button("বাতিল", role: .cancel) {}
                } message: {
                    Text("\(accountTitle) — ৳\(tkWhole(Double(settleOverride) ?? p.netStaffOwesBdt).formatted()) BDT settle হবে\(settlePostWallet ? " এবং wallet-এ পোস্ট হবে" : "")। এই টাকার হিসাব বদলে যাবে।")
                }
                if let r = store.settleResult {
                    Text(r).font(.caption2)
                        .foregroundStyle(r.hasPrefix("✅") ? emerald : r.hasPrefix("⚠️") ? amber600 : red500)
                }
                if !store.history.isEmpty {
                    Divider().opacity(0.4)
                    Text("Settlement history").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                    ForEach(store.history) { h in
                        HStack {
                            Text("\(String((h.periodStart ?? "—").prefix(10))) → \(String((h.periodEnd ?? "—").prefix(10)))")
                                .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                            Spacer()
                            Text(tk(h.adminOverrideBdt ?? h.netStaffOwesBdt))
                                .font(.system(size: 10, weight: .bold).monospacedDigit())
                            if h.ledgerEntryId != nil {
                                Text("wallet").font(.system(size: 8)).foregroundStyle(emerald)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        } else {
            Text("Partnership preview লোড হচ্ছে…").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func settleRow(_ label: String, _ v: Double) -> some View {
        HStack {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Spacer()
            Text(tk(v)).font(.system(size: 10).monospacedDigit())
        }
    }
}

// MARK: - Bkash daily summary form

@available(iOS 17.0, *)
private struct TABkashForm: View {
    let store: TAAdminStore
    let onDone: () -> Void
    @State private var date = ""
    @State private var orders = ""
    @State private var profit = ""
    @State private var loss = ""
    @State private var notes = ""

    /// Web DailySummaryPanel: "Net result is profit minus loss" — on the exact
    /// amounts entered, which is what gets posted.
    private var netResult: Double {
        (Double(profit.trimmingCharacters(in: .whitespaces)) ?? 0)
            - (Double(loss.trimmingCharacters(in: .whitespaces)) ?? 0)
    }

    var body: some View {
        VStack(spacing: 6) {
            Text("Bkash Daily Summary — high-volume micro-trading-এর দিনের ফল। Net = profit − loss।")
                .font(.system(size: 10)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            TextField("তারিখ YYYY-MM-DD", text: $date)
                .keyboardType(.numbersAndPunctuation)
            TextField("Total orders", text: $orders).keyboardType(.numberPad)
            TextField("Total profit (BDT)", text: $profit).keyboardType(.decimalPad)
            TextField("Total loss (BDT)", text: $loss).keyboardType(.decimalPad)
            TextField("Notes", text: $notes)
            HStack {
                Text("Net result").font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Text(tk(netResult))
                    .font(.system(size: 11, weight: .bold).monospacedDigit())
                    .foregroundStyle(netResult >= 0 ? Color.green : Color.red)
            }
            Button(store.busy ? "সেভ…" : "💾 সেভ") {
                Task { if await store.addBkashSummary(date: date, orders: orders,
                                                     profit: profit, loss: loss,
                                                     notes: notes) { onDone() } }
            }
            .disabled(store.busy || date.count < 10
                      || (orders.isEmpty && profit.isEmpty && loss.isEmpty))
        }
        .font(.caption)
        .textFieldStyle(.plain)
        .taAdminFieldChrome()
        .onAppear {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = TimeZone(identifier: "Asia/Dhaka")
            date = f.string(from: Date())
        }
    }
}

// MARK: - Trade action sheet (audit / edit / request-delete / reject-delete)

@available(iOS 17.0, *)
private struct TradeActionSheet: View {
    let store: TAAdminStore
    let mode: TradingAccountAdminSection.TradeSheetMode
    let onDone: () -> Void
    @State private var type = "BUY"
    @State private var usdt = ""
    @State private var rate = ""
    @State private var feeUsdt = ""
    @State private var date = ""
    @State private var notes = ""
    @State private var reason = ""

    private var trade: TAAdminTrade {
        switch mode {
        case .audit(let t), .edit(let t), .requestDelete(let t), .rejectDelete(let t): return t
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                switch mode {
                case .audit:
                    Section("Trade audit") {
                        auditRow("Type", trade.tradeType)
                        auditRow("USDT", trade.usdtAmount.formatted())
                        auditRow("Rate", String(format: "%.4f", trade.bdtRate))
                        auditRow("Fee (USDT)", trade.feeUsdt.formatted())
                        auditRow("Net BDT", tk(trade.netBdt))
                        auditRow("P/L", tk(trade.netProfit))
                        auditRow("Date", trade.tradeDate ?? "—")
                        auditRow("Status", trade.status)
                        auditRow("Edits", "\(trade.editedCount)")
                        if let r = trade.deleteReason { auditRow("Delete reason", r) }
                        if let n = trade.notes, !n.isEmpty { auditRow("Notes", n) }
                    }
                case .edit:
                    Section("Edit trade") {
                        Picker("Type", selection: $type) {
                            Text("BUY").tag("BUY")
                            Text("SELL").tag("SELL")
                        }
                        TextField("USDT amount", text: $usdt).keyboardType(.decimalPad)
                        TextField("BDT rate", text: $rate).keyboardType(.decimalPad)
                        TextField("Fee (USDT)", text: $feeUsdt).keyboardType(.decimalPad)
                        TextField("Date YYYY-MM-DD", text: $date).keyboardType(.numbersAndPunctuation)
                        TextField("Notes", text: $notes)
                        TextField("Edit reason (required)", text: $reason)
                    }
                case .requestDelete:
                    Section("Delete request") {
                        Text("\(trade.tradeType) · \(trade.usdtAmount.formatted()) USDT · \(tk(trade.netBdt))")
                            .font(.caption)
                        TextField("কারণ (required)", text: $reason)
                    }
                case .rejectDelete:
                    Section("Reject delete request") {
                        if let r = trade.deleteReason {
                            Text("অনুরোধের কারণ: \(r)").font(.caption)
                        }
                        TextField("Rejection reason", text: $reason)
                    }
                }
            }
            .navigationTitle(titleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বন্ধ") { onDone() } }
                if actionLabel != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(store.busy ? "…" : actionLabel!) {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { if await run() { onDone() } }
                        }
                        .disabled(store.busy || reason.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .onAppear {
                if case .edit(let t) = mode {
                    type = t.tradeType
                    usdt = String(t.usdtAmount)
                    rate = String(t.bdtRate)
                    feeUsdt = String(t.feeUsdt)
                    date = String((t.tradeDate ?? "").prefix(10))
                    notes = t.notes ?? ""
                }
            }
        }
    }

    private var titleText: String {
        switch mode {
        case .audit: return "Audit"
        case .edit: return "Edit trade"
        case .requestDelete: return "Request delete"
        case .rejectDelete: return "Reject delete"
        }
    }
    private var actionLabel: String? {
        switch mode {
        case .audit: return nil
        case .edit: return "সেভ"
        case .requestDelete: return "রিকোয়েস্ট"
        case .rejectDelete: return "Reject"
        }
    }

    private func run() async -> Bool {
        switch mode {
        case .audit: return true
        case .edit(let t):
            return await store.tradeAction(t, mode: "edit",
                                           edit: (type, usdt, rate, feeUsdt, date, notes), reason: reason)
        case .requestDelete(let t):
            return await store.tradeAction(t, mode: "request_delete", reason: reason)
        case .rejectDelete(let t):
            return await store.tradeAction(t, mode: "reject_delete", reason: reason)
        }
    }

    private func auditRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.callout.monospacedDigit())
        }
        .font(.caption)
    }
}

// MARK: - Screenshot thumbnail + zoom (web <img src={signedUrl}> parity)

/// One performance-screenshot tile. The preview endpoint is cookie-authenticated;
/// URLSession.shared shares HTTPCookieStorage with AlmaAPI, so AsyncImage works
/// without any extra bridging. A nil URL falls back to the web's placeholder tone.
@available(iOS 17.0, *)
private struct TAShotThumb: View {
    let url: URL?
    var height: CGFloat = 110

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.06))
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        // The preview route 404s once a shot passes its 30-day
                        // expiry — say so instead of showing a dead tile.
                        VStack(spacing: 3) {
                            Image(systemName: "clock.badge.xmark").foregroundStyle(.secondary)
                            Text("মেয়াদ শেষ / লোড হয়নি")
                                .font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                    default:
                        ProgressView().controlSize(.small)
                    }
                }
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Tap a tile → full-screen view (web opens the signed URL in a new tab).
@available(iOS 17.0, *)
private struct TAShotZoomSheet: View {
    let shot: TAAdminScreenshot
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                if let url = shot.imageURL {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image): image.resizable().scaledToFit()
                        case .failure: Text("ছবি লোড হয়নি").font(.footnote).foregroundStyle(.secondary)
                        default: ProgressView()
                        }
                    }
                } else {
                    Text("ছবি নেই").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(String((shot.shotDate ?? "Screenshot").prefix(10)))
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if let note = shot.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.ultraThinMaterial)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বন্ধ") { dismiss() }
                }
            }
        }
    }
}


// MARK: - Field chrome (the app's control surface, not the stock rounded border)

private struct TAAdminFieldChrome: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
    }
}

private extension View {
    func taAdminFieldChrome() -> some View { modifier(TAAdminFieldChrome()) }
}
