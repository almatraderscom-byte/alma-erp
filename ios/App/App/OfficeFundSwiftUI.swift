//
//  OfficeFundSwiftUI.swift
//  ALMA ERP — the Office Fund (petty cash) page as a native SwiftUI screen.
//
//  Mirrors the web /finance/office-fund page — same endpoints, same colours, same
//  blocks — but READ-ONLY by deliberate scope (this is financial):
//    GET /api/finance/office-fund     → { ok, canTopUp, summary, ledger }
//    GET /api/finance/office-advance  → { ok, advances, outstanding, fundBalance }
//  Native blocks: balance hero (big rounded number) · in/out KPI strip · my office
//  advances (status badges, Bangla verbatim) · recent ledger with direction icons ·
//  transaction detail sheet. ALL mutating actions (টপ-আপ, অ্যাডভান্স আবেদন, হিসাব
//  দেওয়া) go through the web escape hatch — the native screen never writes money.
//  Carried lessons: lenient decoding, refresh cancellation is not an error, ONE
//  spinner pattern, aurora/glass copies stay private to the page file.
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

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Screen (READ-ONLY — every mutating action goes to the web escape hatch)

@available(iOS 17.0, *)
struct OfficeFundScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = OfficeFundVM()
    @State private var selected: OfficeFundLedgerRow? = nil
    @State private var flowFilter = "ALL"                // ALL | IN | OUT (client-side)
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
                if !vm.adminOnly {
                    balanceHero
                    kpiStrip
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
                    .officeFundGlass(colorScheme, corner: 10)
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
        .officeFundGlass(colorScheme, corner: 18)
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
        .officeFundGlass(colorScheme, corner: 14)
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
                        .officeFundGlass(colorScheme, corner: 12)
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
                    if adv.id != vm.advances.last?.id { Divider().opacity(0.4) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .officeFundGlass(colorScheme, corner: 16)
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
                        .officeFundGlass(colorScheme, corner: 12)
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
                    if row.id != filteredLedger.last?.id { Divider().opacity(0.4) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .officeFundGlass(colorScheme, corner: 16)
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

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(OfficeFundPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).officeFundGlass(colorScheme, corner: 12)
    }

    private var adminOnlyCard: some View {
        VStack(spacing: 8) {
            Image(systemName: "lock.shield").font(.largeTitle).foregroundStyle(.secondary)
            Text("অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।")
                .font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(24)
        .officeFundGlass(colorScheme, corner: 16)
        .padding(.top, 40)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .officeFundGlass(colorScheme, corner: 16)
    }

    /// READ-ONLY escape hatch — every write (টপ-আপ, অ্যাডভান্স আবেদন, হিসাব) is web-only.
    private var webEscape: some View {
        Button {
            openWeb("/finance/office-fund", "Office fund")
        } label: {
            Label("টপ-আপ / অ্যাডভান্স / হিসাব দিন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
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
        .officeFundGlass(colorScheme, corner: 14)
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
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
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
    func officeFundGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
