//
//  OfficeFundSwiftUI.swift
//  ALMA ERP — the Office Fund (petty cash) page as a native SwiftUI screen.
//
//  Mirrors the web /finance/office-fund page — same endpoints, same colours, same
//  blocks — with FULL ACTION PARITY (owner instruction 2026-07-06):
//    GET   /api/finance/office-fund     → { ok, canTopUp, summary, ledger }
//    POST  /api/finance/office-fund     { amount, note? }                    টপ-আপ
//    GET   /api/finance/office-advance  → { ok, advances, outstanding, fundBalance }
//    POST  /api/finance/office-advance  { amount, purpose?, payout_method,
//                                         payout_number }                    আবেদন
//    PATCH /api/finance/office-advance  { advance_id, spent, leftover_method } হিসাব
//  Native blocks: balance hero · in/out KPI strip · action buttons (টপ-আপ /
//  অ্যাডভান্স আবেদন in sheets, number-pad amounts, Bangla confirmationDialog before
//  every money POST) · my office advances (status badges + হিসাব দিন sheet) ·
//  recent ledger with direction icons · transaction detail sheet. Follows the
//  ApprovalsSwiftUI act()/sheet pattern: per-action spinner, success/error notice
//  (the web's toast), reload after every mutation — web parity: টপ-আপ reloads the
//  fund, advance actions reload advances. Carried lessons: lenient decoding,
//  refresh cancellation is not an error, aurora/glass copies stay private.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum OfficeFundPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let sky400 = Color(red: 0.220, green: 0.741, blue: 0.973)         // #38BDF8 (OUTSTANDING)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    /// Web txt-pos: emerald reads better dark→green400, light→emerald600.
    static func positive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
}

// MARK: - Lenient number decoding (amounts sometimes arrive as strings)

private enum OfficeFundDecode {
    static func flexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) {
            if let i = Int(s) { return i }
            if let d = Double(s) { return Int(d.rounded()) }
        }
        return nil
    }
}

// MARK: - Models (same field names the web page types declare)

struct OfficeFundLedgerRow: Decodable, Identifiable, Equatable {
    let id: String
    let type: String
    let amount: Int
    let note: String?
    let refType: String?
    let refId: String?
    let createdByName: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, type, amount, note, refType, refId, createdByName, createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        type = (try? c.decode(String.self, forKey: .type)) ?? "—"
        amount = OfficeFundDecode.flexInt(c, .amount) ?? 0
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        refType = try? c.decodeIfPresent(String.self, forKey: .refType)
        refId = try? c.decodeIfPresent(String.self, forKey: .refId)
        createdByName = try? c.decodeIfPresent(String.self, forKey: .createdByName)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    /// Web TYPE_LABEL parity — Bangla strings verbatim.
    var labelBn: String {
        switch type {
        case "TOP_UP": return "টপ-আপ (যোগ)"
        case "RETURN_IN": return "ফেরত (যোগ)"
        case "ADVANCE_OUT": return "অ্যাডভান্স (বাদ)"
        case "EXPENSE": return "খরচ (বাদ)"
        case "ADJUSTMENT": return "সংশোধন"
        default: return type
        }
    }
    /// Web TYPE_LABEL.positive — money flowing INTO the fund.
    var isPositive: Bool {
        switch type {
        case "ADVANCE_OUT", "EXPENSE": return false
        default: return true
        }
    }

    static func == (a: OfficeFundLedgerRow, b: OfficeFundLedgerRow) -> Bool { a.id == b.id }
}

struct OfficeFundSummary: Decodable, Equatable {
    let businessId: String?
    let balance: Int
    let totalIn: Int
    let totalOut: Int
    let entryCount: Int

    private enum Keys: String, CodingKey { case businessId, balance, totalIn, totalOut, entryCount }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        balance = OfficeFundDecode.flexInt(c, .balance) ?? 0
        totalIn = OfficeFundDecode.flexInt(c, .totalIn) ?? 0
        totalOut = OfficeFundDecode.flexInt(c, .totalOut) ?? 0
        entryCount = OfficeFundDecode.flexInt(c, .entryCount) ?? 0
    }
}

/// GET /api/finance/office-fund answers flat `{ ok, canTopUp, summary, ledger }` —
/// decode a possible `{ ok, data: {…} }` wrapper too, like the approvals screen does.
struct OfficeFundResponse: Decodable {
    let canTopUp: Bool
    let summary: OfficeFundSummary?
    let ledger: [OfficeFundLedgerRow]

    private enum Keys: String, CodingKey { case ok, data, canTopUp, summary, ledger }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        canTopUp = (try? c.decodeIfPresent(Bool.self, forKey: .canTopUp)) ?? false
        summary = try? c.decodeIfPresent(OfficeFundSummary.self, forKey: .summary)
        ledger = (try? c.decode([OfficeFundLedgerRow].self, forKey: .ledger)) ?? []
    }
}

struct OfficeFundAdvanceRow: Decodable, Identifiable, Equatable {
    let id: String
    let amount: Int
    let purpose: String?
    let payoutMethod: String?
    let payoutNumber: String?
    let status: String
    let spentAmount: Int?
    let leftoverAmount: Int?
    let approvedAt: String?
    let settledAt: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, amount, purpose, payoutMethod, payoutNumber, status
        case spentAmount, leftoverAmount, approvedAt, settledAt, createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        amount = OfficeFundDecode.flexInt(c, .amount) ?? 0
        purpose = try? c.decodeIfPresent(String.self, forKey: .purpose)
        payoutMethod = try? c.decodeIfPresent(String.self, forKey: .payoutMethod)
        payoutNumber = try? c.decodeIfPresent(String.self, forKey: .payoutNumber)
        status = (try? c.decode(String.self, forKey: .status)) ?? "—"
        spentAmount = OfficeFundDecode.flexInt(c, .spentAmount)
        leftoverAmount = OfficeFundDecode.flexInt(c, .leftoverAmount)
        approvedAt = try? c.decodeIfPresent(String.self, forKey: .approvedAt)
        settledAt = try? c.decodeIfPresent(String.self, forKey: .settledAt)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    /// Web ADV_STATUS parity — Bangla strings verbatim, tint per web class.
    var statusBn: String {
        switch status {
        case "PENDING": return "অপেক্ষমাণ"
        case "OUTSTANDING": return "বকেয়া (হিসাব দিন)"
        case "SETTLED": return "নিষ্পত্তি হয়েছে"
        case "REJECTED": return "প্রত্যাখ্যাত"
        case "CANCELLED": return "বাতিল"
        default: return status
        }
    }
    var statusColor: Color {
        switch status {
        case "PENDING": return OfficeFundPalette.amber500
        case "OUTSTANDING": return OfficeFundPalette.sky400
        case "SETTLED": return OfficeFundPalette.emerald600
        case "REJECTED": return OfficeFundPalette.red500
        default: return .secondary
        }
    }

    static func == (a: OfficeFundAdvanceRow, b: OfficeFundAdvanceRow) -> Bool {
        a.id == b.id && a.status == b.status
    }
}

struct OfficeFundAdvancesResponse: Decodable {
    let advances: [OfficeFundAdvanceRow]
    let outstandingCount: Int
    let outstandingTotal: Int

    private enum Keys: String, CodingKey { case ok, data, advances, outstanding }
    private enum OutKeys: String, CodingKey { case count, total }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        advances = (try? c.decode([OfficeFundAdvanceRow].self, forKey: .advances)) ?? []
        if let o = try? c.nestedContainer(keyedBy: OutKeys.self, forKey: .outstanding) {
            outstandingCount = OfficeFundDecode.flexInt(o, .count) ?? 0
            outstandingTotal = OfficeFundDecode.flexInt(o, .total) ?? 0
        } else {
            outstandingCount = 0
            outstandingTotal = 0
        }
    }
}

/// POST/PATCH replies — the routes answer `{ ok, message, … }`; apiFailure bodies
/// carry the same shape with ok=false, so one lenient decode covers both.
struct OfficeFundActionResponse: Decodable {
    let ok: Bool
    let message: String?

    private enum Keys: String, CodingKey { case ok, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }
}

/// The web's PAYOUT_METHODS constant, verbatim order.
private let officeFundPayoutMethods = ["bKash", "Nagad", "Rocket", "ব্যাংক", "ক্যাশ"]

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class OfficeFundVM {
    // Fund
    var summary: OfficeFundSummary? = nil
    var ledger: [OfficeFundLedgerRow] = []
    var canTopUp = false
    var loading = false
    var error: String? = nil
    /// The route answers 403 for non-admins — the web shows a toast; we show a card.
    var adminOnly = false
    var authExpired = false

    // Advances
    var advances: [OfficeFundAdvanceRow] = []
    var outstandingCount = 0
    var outstandingTotal = 0
    var advLoading = false

    // Actions (web toast parity: one success line + per-action busy flags)
    var notice: String? = nil
    var topUpSaving = false
    var advSaving = false
    var recSaving = false

    func load() async {
        await loadFund()
        await loadAdvances()
    }

    private func loadFund() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: OfficeFundResponse = try await AlmaAPI.shared.get("/api/finance/office-fund")
            summary = resp.summary
            ledger = resp.ledger
            canTopUp = resp.canTopUp
            adminOnly = false
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch AlmaAPIError.http(let status, _) where status == 403 {
            adminOnly = true       // web: "অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।"
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "ফান্ড লোড করা যায়নি।"
        }
    }

    /// Web parity: advances failing is non-fatal — the fund still shows.
    private func loadAdvances() async {
        advLoading = true
        defer { advLoading = false }
        do {
            let resp: OfficeFundAdvancesResponse = try await AlmaAPI.shared.get("/api/finance/office-advance")
            advances = resp.advances
            outstandingCount = resp.outstandingCount
            outstandingTotal = resp.outstandingTotal
        } catch {
            // Non-fatal — the fund still loads; advances just stay empty.
        }
    }

    // ── Mutations (web parity: same endpoints, same bodies, reload after) ──

    /// POST /api/finance/office-fund { amount, note? } — owner-only টপ-আপ.
    /// Returns nil on success (notice set + fund reloaded), or a Bangla error line.
    func topUp(amount: Int, note: String) async -> String? {
        guard amount > 0 else { return "সঠিক একটি অঙ্ক দিন।" }
        guard !topUpSaving else { return nil }
        topUpSaving = true
        notice = nil
        defer { topUpSaving = false }
        do {
            var body: [String: AnyEncodable] = ["amount": AnyEncodable(amount)]
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { body["note"] = AnyEncodable(trimmed) }
            let resp: OfficeFundActionResponse = try await AlmaAPI.shared.send(
                "POST", "/api/finance/office-fund", body: body)
            guard resp.ok else { return resp.message ?? "যোগ করা যায়নি।" }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = resp.message ?? "যোগ হয়েছে।"
            await loadFund()          // web: await load()
            return nil
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return Self.failureMessage(error, fallback: "যোগ করা যায়নি।")
        }
    }

    /// POST /api/finance/office-advance { amount, purpose?, payout_method, payout_number }
    /// — অফিস অ্যাডভান্স আবেদন. Returns nil on success, or a Bangla error line.
    func requestAdvance(amount: Int, purpose: String, method: String, number: String) async -> String? {
        guard amount > 0 else { return "সঠিক একটি অঙ্ক দিন।" }
        let trimmedNumber = number.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedNumber.isEmpty else { return "টাকা কোথায় পাঠাবেন সেই নম্বর দিন।" }
        guard !advSaving else { return nil }
        advSaving = true
        notice = nil
        defer { advSaving = false }
        do {
            var body: [String: AnyEncodable] = [
                "amount": AnyEncodable(amount),
                "payout_method": AnyEncodable(method),
                "payout_number": AnyEncodable(trimmedNumber),
            ]
            let trimmedPurpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedPurpose.isEmpty { body["purpose"] = AnyEncodable(trimmedPurpose) }
            let resp: OfficeFundActionResponse = try await AlmaAPI.shared.send(
                "POST", "/api/finance/office-advance", body: body)
            guard resp.ok else { return resp.message ?? "আবেদন পাঠানো যায়নি।" }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = resp.message ?? "আবেদন পাঠানো হয়েছে।"
            await loadAdvances()      // web: await loadAdvances()
            return nil
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return Self.failureMessage(error, fallback: "আবেদন পাঠানো যায়নি।")
        }
    }

    /// PATCH /api/finance/office-advance { advance_id, spent, leftover_method } —
    /// হিসাব দেওয়া (reconcile an OUTSTANDING advance). Returns nil on success.
    func reconcile(advance: OfficeFundAdvanceRow, spent: Int, leftoverMethod: String) async -> String? {
        guard spent >= 0 else { return "সঠিক খরচের অঙ্ক দিন।" }
        guard spent <= advance.amount else { return "খরচ অ্যাডভান্সের চেয়ে বেশি হতে পারে না।" }
        guard !recSaving else { return nil }
        recSaving = true
        notice = nil
        defer { recSaving = false }
        do {
            let leftover = advance.amount - spent
            let body: [String: AnyEncodable] = [
                "advance_id": AnyEncodable(advance.id),
                "spent": AnyEncodable(spent),
                // Web parity: no leftover → method forced to CASH_RETURN.
                "leftover_method": AnyEncodable(leftover > 0 ? leftoverMethod : "CASH_RETURN"),
            ]
            let resp: OfficeFundActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/finance/office-advance", body: body)
            guard resp.ok else { return resp.message ?? "হিসাব পাঠানো যায়নি।" }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = resp.message ?? "হিসাব পাঠানো হয়েছে।"
            await loadAdvances()      // web: await loadAdvances()
            return nil
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return Self.failureMessage(error, fallback: "হিসাব পাঠানো যায়নি।")
        }
    }

    /// apiFailure answers 4xx with `{ ok:false, message: <Bangla> }` — surface that
    /// exact server message when it's there, else the caller's fallback.
    private static func failureMessage(_ error: Error, fallback: String) -> String {
        if case AlmaAPIError.notAuthenticated = error {
            return "সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন।"
        }
        if case AlmaAPIError.http(_, let body) = error,
           let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["message"] as? String, !msg.isEmpty {
            return msg
        }
        return fallback
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Screen (full action parity — টপ-আপ / আবেদন / হিসাব all native)

@available(iOS 17.0, *)
struct OfficeFundScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = OfficeFundVM()
    @State private var selected: OfficeFundLedgerRow? = nil
    @State private var flowFilter = "ALL"                // ALL | IN | OUT (client-side)
    @State private var showTopUp = false                 // ফান্ডে টাকা যোগ sheet
    @State private var showAdvance = false               // অ্যাডভান্স আবেদন sheet
    @State private var reconciling: OfficeFundAdvanceRow? = nil  // হিসাব দিন sheet
    let openWeb: (_ path: String, _ title: String) -> Void

    private var filteredLedger: [OfficeFundLedgerRow] {
        switch flowFilter {
        case "IN": return vm.ledger.filter { $0.isPositive }
        case "OUT": return vm.ledger.filter { !$0.isPositive }
        default: return vm.ledger
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if vm.adminOnly { adminOnlyCard }
                if let err = vm.error { noticeCard(err) }
                if let ok = vm.notice { noticeCard(ok, success: true) }
                if !vm.adminOnly {
                    balanceHero
                    kpiStrip
                    actionsCard
                    advancesCard
                    ledgerCard
                    webEscape
                }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(OfficeFundAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { row in
            OfficeFundTxnDetailSheet(row: row, openWeb: openWeb)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showTopUp) {
            OfficeFundTopUpSheet(vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAdvance) {
            OfficeFundAdvanceSheet(vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $reconciling) { adv in
            OfficeFundReconcileSheet(vm: vm, advance: adv)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Actions card (web টপ-আপ + অ্যাডভান্স form cards, promoted to sheets) ──

    private var actionsCard: some View {
        VStack(spacing: 0) {
            if vm.canTopUp {
                actionRow(icon: "plus.circle.fill",
                          title: "ফান্ডে টাকা যোগ করুন",
                          sub: "শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন।",
                          busy: vm.topUpSaving) { showTopUp = true }
                Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
            }
            actionRow(icon: "arrow.up.forward.circle.fill",
                      title: "অফিস অ্যাডভান্স নিন",
                      sub: "অফিসের কাজে ফান্ড থেকে টাকা নিন — মালিক অনুমোদন করলে পাঠাবেন।",
                      busy: vm.advSaving) { showAdvance = true }
        }
        .padding(.horizontal, 14).padding(.vertical, 4)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func actionRow(icon: String, title: String, sub: String,
                           busy: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(OfficeFundPalette.accentText(colorScheme))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.caption.weight(.bold)).foregroundStyle(.primary)
                    Text(sub).font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold)).foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    // ── Balance hero (web KpiCard "ফান্ড ব্যালেন্স", promoted to an iOS hero) ──

    private var balanceHero: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "banknote")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OfficeFundPalette.accentText(colorScheme))
                Text("ফান্ড ব্যালেন্স")
                    .font(.caption.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(.secondary)
            }
            if vm.loading && vm.summary == nil {
                Color.clear.frame(width: 160, height: 40)
                    .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    .officeFundShimmer()
            } else {
                Text(OfficeFundFormat.taka(vm.summary?.balance ?? 0))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(OfficeFundPalette.positive(colorScheme))
                    .contentTransition(.numericText())
            }
            Text("অফিসের চলতি ফান্ড (পেটি ক্যাশ) · ALMA Lifestyle")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── In / out KPI strip (web's other two KpiCards) ──

    private var kpiStrip: some View {
        HStack(spacing: 10) {
            kpiCard("মোট যোগ হয়েছে", vm.summary?.totalIn ?? 0,
                    icon: "arrow.down.circle.fill", tint: OfficeFundPalette.positive(colorScheme))
            kpiCard("মোট বের হয়েছে", vm.summary?.totalOut ?? 0,
                    icon: "arrow.up.circle.fill", tint: OfficeFundPalette.red500)
        }
    }

    private func kpiCard(_ label: String, _ value: Int, icon: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Text(AlmaSwiftTheme.takaShort(value))
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(tint)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── My office advances (web "আমার অ্যাডভান্সসমূহ" card — read-only rows) ──

    private var advancesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text("আমার অ্যাডভান্সসমূহ")
                    .font(.footnote.weight(.bold))
                Spacer()
                if vm.outstandingCount > 0 {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text("বকেয়া হিসাব").font(.caption2).foregroundStyle(.secondary)
                        Text(OfficeFundFormat.taka(vm.outstandingTotal))
                            .font(.footnote.weight(.bold)).monospacedDigit()
                            .foregroundStyle(OfficeFundPalette.red500)
                        Text("\(vm.outstandingCount) টি অ্যাডভান্স")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if vm.advLoading && vm.advances.isEmpty {
                ForEach(0..<2, id: \.self) { _ in
                    Color.clear.frame(height: 48)
                        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        .officeFundShimmer()
                }
            } else if vm.advances.isEmpty {
                Text("কোনো অ্যাডভান্স নেই")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            } else {
                ForEach(vm.advances) { adv in
                    advanceRow(adv)
                    if adv.id != vm.advances.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func advanceRow(_ adv: OfficeFundAdvanceRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(adv.purpose?.isEmpty == false ? adv.purpose! : "অফিস অ্যাডভান্স")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(advanceMeta(adv))
                    .font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 3) {
                Text(OfficeFundFormat.taka(adv.amount))
                    .font(.footnote.weight(.bold)).monospacedDigit()
                Text(adv.statusBn)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(adv.statusColor)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(adv.statusColor.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(adv.statusColor.opacity(0.3), lineWidth: 0.8))
                // Web parity: OUTSTANDING rows carry the "হিসাব দিন" button.
                if adv.status == "OUTSTANDING" {
                    Button {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        reconciling = adv
                    } label: {
                        if vm.recSaving && reconciling?.id == adv.id {
                            ProgressView().controlSize(.mini)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                        } else {
                            Text("হিসাব দিন")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(OfficeFundPalette.accentText(colorScheme))
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(OfficeFundPalette.coral.opacity(colorScheme == .dark ? 0.24 : 0.14),
                                            in: Capsule())
                                .overlay(Capsule().strokeBorder(OfficeFundPalette.coral.opacity(0.45), lineWidth: 0.8))
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.recSaving)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func advanceMeta(_ adv: OfficeFundAdvanceRow) -> String {
        var bits: [String] = []
        if let d = OfficeFundFormat.dateTime(adv.createdAt) { bits.append(d) }
        if let m = adv.payoutMethod {
            bits.append(adv.payoutNumber.map { "\(m) \($0)" } ?? m)
        }
        if adv.status == "SETTLED", let spent = adv.spentAmount {
            bits.append("খরচ \(OfficeFundFormat.taka(spent))")
        }
        return bits.joined(separator: " · ")
    }

    // ── Recent ledger (web "সাম্প্রতিক লেনদেন" card + native flow chips) ──

    private var ledgerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("সাম্প্রতিক লেনদেন")
                .font(.footnote.weight(.bold))
            flowChips
            if vm.loading && vm.ledger.isEmpty {
                ForEach(0..<4, id: \.self) { _ in
                    Color.clear.frame(height: 46)
                        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        .officeFundShimmer()
                }
            } else if filteredLedger.isEmpty {
                VStack(spacing: 4) {
                    Image(systemName: "tray").font(.title3).foregroundStyle(.secondary)
                    Text("এখনো কোনো লেনদেন নেই")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)
            } else {
                ForEach(filteredLedger) { row in
                    ledgerRow(row)
                    if row.id != filteredLedger.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var flowChips: some View {
        HStack(spacing: 8) {
            officeFundChip("সব", active: flowFilter == "ALL") { flowFilter = "ALL" }
            officeFundChip("যোগ", active: flowFilter == "IN") { flowFilter = "IN" }
            officeFundChip("বাদ", active: flowFilter == "OUT") { flowFilter = "OUT" }
            Spacer()
        }
    }

    private func ledgerRow(_ row: OfficeFundLedgerRow) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            selected = row
        } label: {
            HStack(spacing: 10) {
                Image(systemName: row.isPositive ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                    .font(.title3)
                    .foregroundStyle(row.isPositive ? OfficeFundPalette.positive(colorScheme)
                                                    : OfficeFundPalette.red500)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.labelBn)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(ledgerMeta(row))
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Text("\(row.isPositive ? "+" : "−")\(OfficeFundFormat.taka(row.amount))")
                    .font(.footnote.weight(.bold)).monospacedDigit()
                    .foregroundStyle(row.isPositive ? OfficeFundPalette.positive(colorScheme)
                                                    : OfficeFundPalette.red500)
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func ledgerMeta(_ row: OfficeFundLedgerRow) -> String {
        var bits: [String] = []
        if let d = OfficeFundFormat.dateTime(row.createdAt) { bits.append(d) }
        if let by = row.createdByName, !by.isEmpty { bits.append(by) }
        if let n = row.note, !n.isEmpty { bits.append(n) }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    // ── Shared bits ──

    /// Same capsule chip pattern as the other native screens.
    private func officeFundChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? OfficeFundPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? OfficeFundPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? OfficeFundPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String, success: Bool = false) -> some View {
        Label(message, systemImage: success ? "checkmark.circle" : "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(success ? OfficeFundPalette.positive(colorScheme) : OfficeFundPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var adminOnlyCard: some View {
        VStack(spacing: 8) {
            Image(systemName: "lock.shield").font(.largeTitle).foregroundStyle(.secondary)
            Text("অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।")
                .font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(24)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .padding(.top, 40)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Every action is native now — a small link remains for the web version.
    private var webEscape: some View {
        Button {
            openWeb("/finance/office-fund", "Office fund")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption2)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tertiary)
        .padding(.vertical, 4)
    }
}

// MARK: - Transaction detail sheet

@available(iOS 17.0, *)
private struct OfficeFundTxnDetailSheet: View {
    let row: OfficeFundLedgerRow
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoRows
                webLink
            }
            .padding(18)
        }
        .presentationBackground { OfficeFundAurora() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: row.isPositive ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                    .font(.title3)
                    .foregroundStyle(row.isPositive ? OfficeFundPalette.positive(colorScheme)
                                                    : OfficeFundPalette.red500)
                Text(row.labelBn).font(.headline)
            }
            Text("\(row.isPositive ? "+" : "−")\(OfficeFundFormat.taka(row.amount))")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(row.isPositive ? OfficeFundPalette.positive(colorScheme)
                                                : OfficeFundPalette.red500)
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("সময়", OfficeFundFormat.dateTime(row.createdAt) ?? "—")
            infoRow("যিনি করেছেন", row.createdByName ?? "—")
            infoRow("নোট", (row.note?.isEmpty == false ? row.note! : "—"))
            if let refType = row.refType {
                infoRow("রেফারেন্স", row.refId.map { "\(refType) · \($0)" } ?? refType)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold))
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/finance/office-fund", "Office fund")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption2)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Shared form bits for the action sheets

/// Bangla-digit-tolerant whole-taka parser: "১০০০" → 1000, "10,000" → 10000.
private func officeFundParseTaka(_ raw: String) -> Int {
    let map: [Character: Character] = [
        "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4",
        "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9",
    ]
    let digits = raw.map { map[$0] ?? $0 }.filter { $0.isASCII && $0.isNumber }
    return Int(String(digits)) ?? 0
}

/// Labelled glass field — the web's `<label> + <Input>` pair.
@available(iOS 17.0, *)
private struct OfficeFundField<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            content()
                .padding(12)
                .officeFundGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }
}

/// Prominent submit button with the ONE per-action spinner.
@available(iOS 17.0, *)
private struct OfficeFundSubmitButton: View {
    let title: String
    let busy: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if busy { ProgressView().tint(.white) } else { Text(title).font(.subheadline.weight(.semibold)) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .tint(OfficeFundPalette.coral)
        .disabled(busy || disabled)
    }
}

// MARK: - Top-up sheet (web "ফান্ডে টাকা যোগ করুন" card → native sheet)
// POST /api/finance/office-fund { amount, note? }

@available(iOS 17.0, *)
private struct OfficeFundTopUpSheet: View {
    let vm: OfficeFundVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var amount = ""
    @State private var note = ""
    @State private var confirming = false
    @State private var localError: String? = nil
    @FocusState private var focused: Bool

    private var amountInt: Int { officeFundParseTaka(amount) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("ফান্ডে টাকা যোগ করুন").font(.headline)
                Text("শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন। (আপনি নিজে বিকাশ/ক্যাশে রেখে এখানে রেকর্ড করবেন।)")
                    .font(.caption).foregroundStyle(.secondary)
                OfficeFundField(label: "টাকার অঙ্ক (৳)") {
                    TextField("যেমন 10000", text: $amount)
                        .keyboardType(.numberPad)
                        .focused($focused)
                }
                OfficeFundField(label: "নোট (ঐচ্ছিক)") {
                    TextField("যেমন জুনের পেটি ক্যাশ", text: $note)
                }
                if let e = localError {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption2).foregroundStyle(OfficeFundPalette.red500)
                }
                OfficeFundSubmitButton(title: "যোগ করুন", busy: vm.topUpSaving,
                                       disabled: amountInt <= 0) {
                    localError = nil
                    confirming = true
                }
            }
            .padding(18)
        }
        .presentationBackground { OfficeFundAurora() }
        .interactiveDismissDisabled(vm.topUpSaving)
        .onAppear { focused = true }
        .confirmationDialog(
            "৳\(amountInt.formatted()) ফান্ডে যোগ হবে — নিশ্চিত?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, ৳\(amountInt.formatted()) যোগ করুন") {
                Task {
                    if let err = await vm.topUp(amount: amountInt, note: note) {
                        localError = err
                    } else {
                        dismiss()
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        }
    }
}

// MARK: - Advance request sheet (web "অফিস অ্যাডভান্স নিন" card → native sheet)
// POST /api/finance/office-advance { amount, purpose?, payout_method, payout_number }

@available(iOS 17.0, *)
private struct OfficeFundAdvanceSheet: View {
    let vm: OfficeFundVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var amount = ""
    @State private var purpose = ""
    @State private var method = officeFundPayoutMethods[0]
    @State private var number = ""
    @State private var confirming = false
    @State private var localError: String? = nil
    @FocusState private var focused: Bool

    private var amountInt: Int { officeFundParseTaka(amount) }
    private var numberTrimmed: String { number.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("অফিস অ্যাডভান্স নিন").font(.headline)
                Text("অফিসের কাজে ফান্ড থেকে টাকা নিন — মালিক অনুমোদন করলে আপনার নম্বরে পাঠাবেন।")
                    .font(.caption).foregroundStyle(.secondary)
                OfficeFundField(label: "টাকার অঙ্ক (৳)") {
                    TextField("যেমন 2000", text: $amount)
                        .keyboardType(.numberPad)
                        .focused($focused)
                }
                OfficeFundField(label: "কী কাজে") {
                    TextField("যেমন প্যাকেজিং সামগ্রী কেনা", text: $purpose)
                }
                OfficeFundField(label: "কোথায় পাঠাবে") {
                    Menu {
                        ForEach(officeFundPayoutMethods, id: \.self) { m in
                            Button {
                                method = m
                            } label: {
                                if m == method { Label(m, systemImage: "checkmark") } else { Text(m) }
                            }
                        }
                    } label: {
                        HStack {
                            Text(method).font(.subheadline).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                }
                OfficeFundField(label: "বিকাশ/ওয়ালেট নম্বর") {
                    TextField("01XXXXXXXXX", text: $number)
                        .keyboardType(.phonePad)
                }
                Text("অনুমোদনের পর টাকা আপনার দায়িত্বে থাকবে — খরচ শেষে হিসাব দিতে হবে।")
                    .font(.caption2).foregroundStyle(.secondary)
                if let e = localError {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption2).foregroundStyle(OfficeFundPalette.red500)
                }
                OfficeFundSubmitButton(title: "আবেদন পাঠান", busy: vm.advSaving,
                                       disabled: amountInt <= 0 || numberTrimmed.isEmpty) {
                    localError = nil
                    confirming = true
                }
            }
            .padding(18)
        }
        .presentationBackground { OfficeFundAurora() }
        .interactiveDismissDisabled(vm.advSaving)
        .onAppear { focused = true }
        .confirmationDialog(
            "৳\(amountInt.formatted()) অ্যাডভান্সের আবেদন যাবে (\(method) \(numberTrimmed)) — নিশ্চিত?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, আবেদন পাঠান") {
                Task {
                    if let err = await vm.requestAdvance(amount: amountInt, purpose: purpose,
                                                         method: method, number: numberTrimmed) {
                        localError = err
                    } else {
                        dismiss()
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        }
    }
}

// MARK: - Reconcile sheet (web inline "হিসাব দিন" panel → native sheet)
// PATCH /api/finance/office-advance { advance_id, spent, leftover_method }

@available(iOS 17.0, *)
private struct OfficeFundReconcileSheet: View {
    let vm: OfficeFundVM
    let advance: OfficeFundAdvanceRow
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var spent = ""
    @State private var method = "CASH_RETURN"            // CASH_RETURN | WALLET_DEDUCT
    @State private var confirming = false
    @State private var localError: String? = nil
    @FocusState private var focused: Bool

    private var spentInt: Int { officeFundParseTaka(spent) }
    /// Web leftoverPreview = max(0, amount − spent).
    private var leftover: Int { max(0, advance.amount - spentInt) }
    private var methodBn: String {
        method == "WALLET_DEDUCT" ? "আমার ওয়ালেট থেকে কাটা হবে" : "ক্যাশ ফেরত দেব"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("হিসাব দিন").font(.headline)
                Text("\(advance.purpose?.isEmpty == false ? advance.purpose! : "অফিস অ্যাডভান্স") · \(OfficeFundFormat.taka(advance.amount))")
                    .font(.caption).foregroundStyle(.secondary)
                Text("কত টাকা খরচ হয়েছে লিখুন — বাকি টাকা কীভাবে ফেরত দেবেন তা বেছে নিন। (দুটোই মালিকের অনুমোদন লাগবে।)")
                    .font(.caption2).foregroundStyle(.secondary)
                OfficeFundField(label: "খরচ হয়েছে (৳)") {
                    TextField("সর্বোচ্চ \(advance.amount)", text: $spent)
                        .keyboardType(.numberPad)
                        .focused($focused)
                }
                HStack(spacing: 4) {
                    Text("বাকি থাকবে:").font(.caption).foregroundStyle(.secondary)
                    Text(OfficeFundFormat.taka(leftover))
                        .font(.caption.weight(.bold)).monospacedDigit()
                }
                if leftover > 0 {
                    HStack(spacing: 8) {
                        methodChip("ক্যাশ ফেরত দেব", value: "CASH_RETURN")
                        methodChip("আমার ওয়ালেট থেকে কাটুন", value: "WALLET_DEDUCT")
                    }
                }
                if let e = localError {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption2).foregroundStyle(OfficeFundPalette.red500)
                }
                OfficeFundSubmitButton(title: "হিসাব পাঠান", busy: vm.recSaving,
                                       disabled: spentInt > advance.amount) {
                    localError = nil
                    if spentInt > advance.amount {
                        localError = "খরচ অ্যাডভান্সের চেয়ে বেশি হতে পারে না।"
                    } else {
                        confirming = true
                    }
                }
            }
            .padding(18)
        }
        .presentationBackground { OfficeFundAurora() }
        .interactiveDismissDisabled(vm.recSaving)
        .onAppear { focused = true }
        .confirmationDialog(
            leftover > 0
                ? "খরচ ৳\(spentInt.formatted()), বাকি ৳\(leftover.formatted()) (\(methodBn)) — হিসাব পাঠাবেন?"
                : "খরচ ৳\(spentInt.formatted()), কিছু বাকি নেই — হিসাব পাঠাবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, হিসাব পাঠান") {
                Task {
                    if let err = await vm.reconcile(advance: advance, spent: spentInt,
                                                    leftoverMethod: method) {
                        localError = err
                    } else {
                        dismiss()
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        }
    }

    /// The web's two leftover-method toggle buttons, as capsule chips.
    private func methodChip(_ label: String, value: String) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            method = value
        } label: {
            Text(label)
                .font(.caption2.weight(.bold))
                .foregroundStyle(method == value
                                 ? OfficeFundPalette.accentText(colorScheme)
                                 : Color.secondary)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(method == value
                            ? OfficeFundPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                            : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    method == value ? OfficeFundPalette.coral.opacity(0.55)
                                    : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum OfficeFundFormat {
    /// Whole-taka display — ৳12,345 (whole-taka BDT, never floats).
    static func taka(_ amount: Int) -> String {
        let sign = amount < 0 ? "−" : ""
        return "\(sign)৳\(abs(amount).formatted())"
    }

    /// createdAt → "05 Jul, 08:50 PM" (web fmtDate: day 2-digit, month short, h:mm).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "dd MMM, h:mm a"
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

// MARK: - Aurora background + glass (OfficeFund-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct OfficeFundAurora: View {
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
    func officeFundGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct OfficeFundShimmer: ViewModifier {
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
    func officeFundShimmer() -> some View { modifier(OfficeFundShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Office Fund — Light") {
    OfficeFundScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
