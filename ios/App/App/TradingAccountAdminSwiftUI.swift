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

struct TAAdminBkashSummary: Decodable, Identifiable {
    let id: String
    let summaryDate: String?
    let openingBdt: Double
    let closingBdt: Double
    let usedBdt: Double
    let notes: String?
    private enum Keys: String, CodingKey { case id, summaryDate, openingBdt, closingBdt, usedBdt, notes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        summaryDate = try? c.decodeIfPresent(String.self, forKey: .summaryDate)
        openingBdt = flexDouble(c, .openingBdt) ?? 0
        closingBdt = flexDouble(c, .closingBdt) ?? 0
        usedBdt = flexDouble(c, .usedBdt) ?? 0
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
    }
}

struct TAAdminScreenshot: Decodable, Identifiable {
    let id: String
    let shotDate: String?
    let note: String?
    let imageUrl: String?
    let archivedAt: String?
    private enum Keys: String, CodingKey { case id, shotDate, note, imageUrl, url, archivedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        shotDate = try? c.decodeIfPresent(String.self, forKey: .shotDate)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        imageUrl = (try? c.decodeIfPresent(String.self, forKey: .imageUrl))
            ?? (try? c.decodeIfPresent(String.self, forKey: .url))
        archivedAt = try? c.decodeIfPresent(String.self, forKey: .archivedAt)
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
    func addBkashSummary(date: String, opening: String, closing: String, notes: String) async -> Bool {
        guard !busy, let o = Double(opening), let cl = Double(closing) else {
            notice = "✗ সংখ্যাগুলো চেক করুন"
            return false
        }
        busy = true
        defer { busy = false }
        struct Body: Encodable {
            let tradingAccountId: String
            let summaryDate: String
            let openingBdt: Int
            let closingBdt: Int
            let notes: String?
        }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/trading/accounts/\(accountId)/bkash-summary",
                body: Body(tradingAccountId: accountId, summaryDate: date,
                           openingBdt: Int(o.rounded()), closingBdt: Int(cl.rounded()),
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

    /// Multipart upload — web uploadPerformanceScreenshot parity.
    func uploadScreenshot(data: Data, note: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        struct Resp: Decodable { let ok: Bool? }
        do {
            var fields: [String: String] = [:]
            if !note.isEmpty { fields["note"] = note }
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
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data),
                   let jpeg = img.jpegData(compressionQuality: 0.8) {
                    await store.uploadScreenshot(data: jpeg, note: "")
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
                Text("opening \(tk(b.openingBdt)) · closing \(tk(b.closingBdt))")
                    .font(.system(size: 10).monospacedDigit())
                Spacer()
                Text("used \(tk(b.usedBdt))")
                    .font(.system(size: 10, weight: .bold).monospacedDigit()).foregroundStyle(amber600)
            }
            .padding(.vertical, 3)
            Divider().opacity(0.3)
        }
    }

    // ── Screenshot history + upload ──

    @ViewBuilder private var shotsPanel: some View {
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
                    if let urlStr = shot.imageUrl, let url = URL(string: urlStr) {
                        AsyncImage(url: url) { img in
                            img.resizable().scaledToFill()
                        } placeholder: {
                            Color.primary.opacity(0.06)
                        }
                        .frame(height: 110)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    Text(String((shot.shotDate ?? "—").prefix(10)))
                        .font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    if let note = shot.note, !note.isEmpty {
                        Text(note).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
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
    @State private var opening = ""
    @State private var closing = ""
    @State private var notes = ""

    var body: some View {
        VStack(spacing: 6) {
            TextField("তারিখ YYYY-MM-DD", text: $date)
                .keyboardType(.numbersAndPunctuation)
            TextField("Opening ৳", text: $opening).keyboardType(.numberPad)
            TextField("Closing ৳", text: $closing).keyboardType(.numberPad)
            TextField("Notes", text: $notes)
            Button(store.busy ? "সেভ…" : "💾 সেভ") {
                Task { if await store.addBkashSummary(date: date, opening: opening,
                                                     closing: closing, notes: notes) { onDone() } }
            }
            .disabled(store.busy || date.count < 10 || opening.isEmpty || closing.isEmpty)
        }
        .font(.caption)
        .textFieldStyle(.roundedBorder)
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
