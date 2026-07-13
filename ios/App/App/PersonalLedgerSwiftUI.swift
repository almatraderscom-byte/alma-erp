//
//  PersonalLedgerSwiftUI.swift
//  ALMA ERP — owner personal পাওনা-দেনা khata (/finance/personal-ledger) as a native
//  SwiftUI screen. Twin of the web page + Android PersonalLedgerScreen.kt.
//
//  SUPER_ADMIN only (the API enforces; non-owners get a Bangla forbidden card).
//  Same endpoint + semantics as web/Android:
//    GET  /api/finance/personal-ledger              → parties + totals
//    GET  /api/finance/personal-ledger?party_id=…   → party + serial txns (oldest→newest)
//    POST /api/finance/personal-ledger {op: create_party|add_txn|edit_txn|delete_txn, …}
//  Direction: OUT = টাকা দিলাম (they owe more) · IN = টাকা নিলাম (they owe less).
//  Net > 0 আমি পাব (green) · net < 0 আমি দেব (red) · 0 নিষ্পত্তি. Running balance is
//  recomputed per row (same math as the web detailRows memo).
//

import SwiftUI

// MARK: - Palette (web tokens + AlmaSwiftTheme)

private enum PLPalette {
    static let coral = AlmaSwiftTheme.coral
    static let coralLt = Color(red: 0.957, green: 0.635, blue: 0.549) // #F4A28C
    static let coralDim = Color(red: 0.769, green: 0.353, blue: 0.235) // #C45A3C

    static func accentText(_ s: ColorScheme) -> Color { s == .dark ? coralLt : coralDim }
    static func green(_ s: ColorScheme) -> Color { AlmaSwiftTheme.ios27Green(s) }
    static func red(_ s: ColorScheme) -> Color { AlmaSwiftTheme.ios27Red(s) }
    static func net(_ net: Int, _ s: ColorScheme) -> Color {
        net > 0 ? green(s) : net < 0 ? red(s) : .secondary
    }
    /// Web <Money>: whole-taka, ৳ + thousand separators.
    static func money(_ amount: Int) -> String { "৳\(abs(amount).formatted())" }
}

// MARK: - Models (web field names)

private struct PLParty: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let net: Int
    let txnCount: Int
    let lastTxnDate: String?

    private enum K: String, CodingKey { case id, name, net, txnCount, lastTxnDate }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        net = PLDecode.int(c, .net) ?? 0
        txnCount = PLDecode.int(c, .txnCount) ?? 0
        lastTxnDate = try? c.decodeIfPresent(String.self, forKey: .lastTxnDate)
    }
}

private struct PLTxn: Decodable, Identifiable, Equatable {
    let id: String
    let direction: String // OUT | IN
    let amount: Int
    let reason: String
    let txnDate: String
    let edited: Bool

    private enum K: String, CodingKey { case id, direction, amount, reason, txnDate, edited }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        direction = (try? c.decode(String.self, forKey: .direction)) ?? "OUT"
        amount = PLDecode.int(c, .amount) ?? 0
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        txnDate = (try? c.decode(String.self, forKey: .txnDate)) ?? ""
        edited = (try? c.decodeIfPresent(Bool.self, forKey: .edited)) ?? false
    }
    var out: Bool { direction == "OUT" }
}

private struct PLPartyDetail: Decodable, Equatable {
    let id: String
    let name: String
    let net: Int
    let txns: [PLTxn]

    private enum K: String, CodingKey { case id, name, net, txns }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        net = PLDecode.int(c, .net) ?? 0
        txns = (try? c.decode([PLTxn].self, forKey: .txns)) ?? []
    }
}

private struct PLListResponse: Decodable {
    let parties: [PLParty]?
    let totalReceivable: Int?
    let totalPayable: Int?
    let net: Int?

    private enum K: String, CodingKey { case parties, totalReceivable, totalPayable, net, data }
    init(from d: Decoder) throws {
        let root = try d.container(keyedBy: K.self)
        // apiDataSuccess may wrap in {data:{…}} — unwrap if present.
        let c = (try? root.nestedContainer(keyedBy: K.self, forKey: .data)) ?? root
        parties = try? c.decode([PLParty].self, forKey: .parties)
        totalReceivable = PLDecode.int(c, .totalReceivable)
        totalPayable = PLDecode.int(c, .totalPayable)
        net = PLDecode.int(c, .net)
    }
}

private struct PLDetailResponse: Decodable {
    let party: PLPartyDetail?
    private enum K: String, CodingKey { case party, data }
    init(from d: Decoder) throws {
        let root = try d.container(keyedBy: K.self)
        let c = (try? root.nestedContainer(keyedBy: K.self, forKey: .data)) ?? root
        party = try? c.decode(PLPartyDetail.self, forKey: .party)
    }
}

private struct PLOpResponse: Decodable { let ok: Bool?; let message: String?; let partyId: String? }

/// Flexible int (legacy rows mix int/double/string) — iOS flexInt twin.
private enum PLDecode {
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(Double(s) ?? 0) }
        return nil
    }
}

/// POST body for every write op — op decides which fields matter (web parity).
private struct PLOpBody: Encodable {
    var op: String
    var name: String?
    var party_id: String?
    var txn_id: String?
    var direction: String?
    var amount: Int?
    var reason: String?
    var txn_date: String?
}

// MARK: - Model

@MainActor
private final class PersonalLedgerModel: ObservableObject {
    @Published var parties: [PLParty] = []
    @Published var totalReceivable = 0
    @Published var totalPayable = 0
    @Published var netTotal = 0
    @Published var detail: PLPartyDetail?
    @Published var loading = false
    @Published var busy = false
    @Published var errorText: String?
    @Published var notice: String?
    @Published var forbidden = false

    func loadList() async {
        loading = true; defer { loading = false }
        do {
            let r: PLListResponse = try await AlmaAPI.shared.get("/api/finance/personal-ledger")
            parties = r.parties ?? []
            totalReceivable = r.totalReceivable ?? 0
            totalPayable = r.totalPayable ?? 0
            netTotal = r.net ?? 0
            forbidden = false; errorText = nil
        } catch AlmaAPIError.notAuthenticated {
            forbidden = true
        } catch {
            // API 403 (not owner) arrives as .http(403) — treat as owner-only card.
            if case AlmaAPIError.http(let code, _) = error, code == 403 { forbidden = true }
            else { errorText = "খাতা লোড করা যায়নি।" }
        }
    }

    func openParty(_ id: String) async {
        loading = true; defer { loading = false }
        do {
            let r: PLDetailResponse = try await AlmaAPI.shared.get(
                "/api/finance/personal-ledger", query: ["party_id": id])
            detail = r.party
        } catch { errorText = "খাতাটি লোড করা যায়নি।" }
    }

    @discardableResult
    func post(_ body: PLOpBody) async -> Bool {
        if busy { return false }
        busy = true; notice = nil; defer { busy = false }
        do {
            let r: PLOpResponse = try await AlmaAPI.shared.send("POST", "/api/finance/personal-ledger", body: body)
            notice = r.message ?? "সংরক্ষণ হয়েছে।"
            return true
        } catch AlmaAPIError.notAuthenticated {
            forbidden = true; return false
        } catch {
            errorText = "সংরক্ষণ করা যায়নি।"; return false
        }
    }
}

// MARK: - Date helpers

private enum PLDate {
    static func today() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        return f.string(from: Date())
    }
    static func display(_ ymd: String?) -> String {
        guard let ymd, !ymd.isEmpty else { return "—" }
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"; inF.timeZone = TimeZone(identifier: "UTC")
        guard let d = inF.date(from: ymd) else { return ymd }
        let out = DateFormatter(); out.dateFormat = "d MMM, yyyy"; out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }
    static func toDate(_ ymd: String) -> Date {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: ymd) ?? Date()
    }
    static func fromDate(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }
}

// MARK: - Root screen

struct PersonalLedgerScreen: View {
    @StateObject private var model = PersonalLedgerModel()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            AlmaSwiftTheme.rootBg(scheme).ignoresSafeArea()
            Group {
                if model.forbidden {
                    PLForbiddenCard()
                } else if let detail = model.detail {
                    PLDetailView(model: model, detail: detail)
                } else {
                    PLListView(model: model)
                }
            }
        }
        .task { await model.loadList() }
    }
}

// MARK: - Forbidden

private struct PLForbiddenCard: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("🔒").font(.system(size: 30))
            Text("শুধু মালিকের জন্য").font(.headline)
            Text("এই খাতা শুধু Super Admin দেখতে পারেন।")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .lgCard()
        .padding(AlmaSwiftTheme.margin)
    }
}

// MARK: - Party list

private struct PLListView: View {
    @ObservedObject var model: PersonalLedgerModel
    @Environment(\.colorScheme) private var scheme
    @State private var filter = 0 // 0 সব · 1 পাওনা · 2 দেনা · 3 নিষ্পত্তি
    @State private var showNewParty = false

    private var filtered: [PLParty] {
        switch filter {
        case 1: return model.parties.filter { $0.net > 0 }
        case 2: return model.parties.filter { $0.net < 0 }
        case 3: return model.parties.filter { $0.net == 0 }
        default: return model.parties
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("পাওনা-দেনা").font(.title2.bold())
                    Text("আপনার ব্যক্তিগত লেনদেন — স্টাফ নয়, বাইরের ব্যক্তি/প্রতিষ্ঠান")
                        .font(.caption).foregroundStyle(.secondary)
                }

                model.errorText.map { PLNotice(text: "⚠️ \($0)", tint: PLPalette.red(scheme)) }
                model.notice.map { PLNotice(text: "✓ \($0)", tint: PLPalette.green(scheme)) }

                HStack(spacing: 8) {
                    PLStat(label: "মোট পাওনা", amount: model.totalReceivable, tint: PLPalette.green(scheme))
                    PLStat(label: "মোট দেনা", amount: model.totalPayable, tint: PLPalette.red(scheme))
                    PLStat(label: "নিট", amount: abs(model.netTotal),
                           tint: PLPalette.net(model.netTotal, scheme), negative: model.netTotal < 0)
                }

                Picker("ফিল্টার", selection: $filter) {
                    Text("সব").tag(0); Text("পাওনা").tag(1); Text("দেনা").tag(2); Text("নিষ্পত্তি").tag(3)
                }.pickerStyle(.segmented)

                VStack(alignment: .leading, spacing: 0) {
                    Text("খাতা · \(model.parties.count) জন").font(.subheadline.bold()).padding(.bottom, 6)
                    if filtered.isEmpty {
                        Text("এই ফিল্টারে কেউ নেই").font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                    } else {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { i, p in
                            Button { Task { await model.openParty(p.id) } } label: { PLPartyRow(party: p) }
                                .buttonStyle(.plain)
                            if i < filtered.count - 1 { Divider().background(AlmaSwiftTheme.separator(scheme)) }
                        }
                    }
                }
                .lgCard()

                Button { showNewParty = true } label: {
                    Text("＋ নতুন ব্যক্তি / প্রতিষ্ঠান")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PLPalette.accentText(scheme))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(PLPalette.coral.opacity(scheme == .dark ? 0.22 : 0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(PLPalette.coral.opacity(0.45), lineWidth: 1))
                }
            }
            .padding(AlmaSwiftTheme.margin)
        }
        .refreshable { await model.loadList() }
        .sheet(isPresented: $showNewParty) {
            PLTxnForm(title: "নতুন ব্যক্তি / প্রতিষ্ঠান", askName: true, busy: model.busy) { name, dir, amt, reason, date in
                Task {
                    let ok = await model.post(PLOpBody(op: "create_party", name: name, direction: dir,
                                                       amount: amt, reason: reason, txn_date: date))
                    if ok { showNewParty = false; await model.loadList() }
                }
            }
            .presentationDetents([.large])
        }
    }
}

private struct PLPartyRow: View {
    let party: PLParty
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(party.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(party.txnCount)টি লেনদেন · শেষ: \(PLDate.display(party.lastTxnDate))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(party.net < 0 ? "−" : "")\(PLPalette.money(party.net))")
                    .font(.subheadline.weight(.bold)).monospacedDigit()
                    .foregroundStyle(PLPalette.net(party.net, scheme))
                Text(party.net > 0 ? "আমি পাব" : party.net < 0 ? "আমি দেব" : "নিষ্পত্তি")
                    .font(.caption2.weight(.bold)).foregroundStyle(PLPalette.net(party.net, scheme))
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}

// MARK: - Party detail (খতিয়ান)

private struct PLDetailView: View {
    @ObservedObject var model: PersonalLedgerModel
    let detail: PLPartyDetail
    @Environment(\.colorScheme) private var scheme
    @State private var showAddTxn = false
    @State private var editing: PLTxn?
    @State private var deleting: PLTxn?

    /// Serial rows with running balance (oldest → newest), same math as web/Android.
    private var rows: [(txn: PLTxn, run: Int)] {
        var run = 0
        return detail.txns.map { t in run += t.out ? t.amount : -t.amount; return (t, run) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Button { model.detail = nil; Task { await model.loadList() } } label: {
                    Text("‹ পাওনা-দেনা তালিকায় ফিরুন")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(PLPalette.accentText(scheme))
                }.buttonStyle(.plain)

                VStack(spacing: 3) {
                    Text("\(detail.net < 0 ? "−" : "")\(PLPalette.money(detail.net))")
                        .font(.system(size: 26, weight: .black)).monospacedDigit()
                        .foregroundStyle(PLPalette.net(detail.net, scheme))
                    Text(detail.net > 0 ? "সে আমাকে দেবে (আমি পাব)"
                         : detail.net < 0 ? "আমি তাকে দেব (আমার দেনা)" : "হিসাব নিষ্পত্তি ✓")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 18).lgCard()

                model.notice.map { PLNotice(text: "✓ \($0)", tint: PLPalette.green(scheme)) }

                VStack(alignment: .leading, spacing: 0) {
                    Text("লেনদেনের খতিয়ান · \(detail.txns.count)টি").font(.subheadline.bold()).padding(.bottom, 6)
                    if rows.isEmpty {
                        Text("কোনো লেনদেন নেই").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(rows.enumerated()), id: \.element.txn.id) { i, row in
                            PLTxnRow(txn: row.txn, run: row.run) { editing = row.txn }
                            if i < rows.count - 1 { Divider().background(AlmaSwiftTheme.separator(scheme)) }
                        }
                    }
                }.lgCard()

                Button { showAddTxn = true } label: {
                    Text("＋ নতুন লেনদেন")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(PLPalette.accentText(scheme))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(PLPalette.coral.opacity(scheme == .dark ? 0.22 : 0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(PLPalette.coral.opacity(0.45), lineWidth: 1))
                }

                if detail.net != 0 {
                    Text(detail.net > 0
                         ? "টিপ: পুরো টাকা ফেরত পেলে “টাকা নিলাম”-এ সেই অঙ্ক লিখুন — খাতা নিজেই নিষ্পত্তি দেখাবে।"
                         : "টিপ: পুরো টাকা দিয়ে দিলে “টাকা দিলাম”-এ লিখুন — খাতা নিষ্পত্তি হবে।")
                        .font(.caption2).foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .padding(AlmaSwiftTheme.margin)
        }
        .refreshable { await model.openParty(detail.id) }
        .sheet(isPresented: $showAddTxn) {
            PLTxnForm(title: "\(detail.name) — নতুন লেনদেন", askName: false, busy: model.busy) { _, dir, amt, reason, date in
                Task {
                    let ok = await model.post(PLOpBody(op: "add_txn", party_id: detail.id, direction: dir,
                                                       amount: amt, reason: reason, txn_date: date))
                    if ok { showAddTxn = false; await model.openParty(detail.id) }
                }
            }.presentationDetents([.large])
        }
        .sheet(item: $editing) { txn in
            PLTxnForm(title: "লেনদেন অ্যাডজাস্ট (+/−)", askName: false, busy: model.busy,
                      initialDir: txn.direction, initialAmount: "\(txn.amount)",
                      initialReason: txn.reason, initialDate: txn.txnDate,
                      onDelete: { editing = nil; deleting = txn }) { _, dir, amt, reason, date in
                Task {
                    let ok = await model.post(PLOpBody(op: "edit_txn", txn_id: txn.id, direction: dir,
                                                       amount: amt, reason: reason, txn_date: date))
                    if ok { editing = nil; await model.openParty(detail.id) }
                }
            }.presentationDetents([.large])
        }
        .confirmationDialog("লেনদেন মুছবেন?",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("হ্যাঁ, মুছুন", role: .destructive) {
                if let t = deleting {
                    deleting = nil
                    Task {
                        let ok = await model.post(PLOpBody(op: "delete_txn", txn_id: t.id))
                        if ok { await model.openParty(detail.id) }
                    }
                }
            }
            Button("বাতিল", role: .cancel) { deleting = nil }
        } message: {
            Text("মুছে ফেললে ব্যালেন্স নতুন করে হিসাব হবে (রেকর্ড অডিটে থেকে যায়)।")
        }
    }
}

private struct PLTxnRow: View {
    let txn: PLTxn
    let run: Int
    let onEdit: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(txn.out ? "↑" : "↓")
                .font(.subheadline.bold())
                .foregroundStyle(txn.out ? PLPalette.red(scheme) : PLPalette.green(scheme))
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background((txn.out ? PLPalette.red(scheme) : PLPalette.green(scheme)).opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("\(txn.out ? "টাকা দিলাম" : "টাকা নিলাম") · \(txn.reason)" + (txn.edited ? " (অ্যাডজাস্ট করা)" : ""))
                    .font(.subheadline.weight(.semibold))
                Text(PLDate.display(txn.txnDate)).font(.caption2).foregroundStyle(.secondary)
                Text("ব্যালেন্স: \(run < 0 ? "−" : "")\(PLPalette.money(run)) " +
                     (run > 0 ? "আমি পাব" : run < 0 ? "আমি দেব" : "— নিষ্পত্তি"))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(txn.out ? "−" : "+")\(PLPalette.money(txn.amount))")
                    .font(.subheadline.weight(.bold)).monospacedDigit()
                    .foregroundStyle(txn.out ? PLPalette.red(scheme) : PLPalette.green(scheme))
                Button(action: onEdit) {
                    Image(systemName: "pencil").font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(6).background(AlmaSwiftTheme.fill(scheme), in: Circle())
                }.buttonStyle(.plain)
            }
        }
        .padding(.vertical, 9)
    }
}

// MARK: - Shared bits

private struct PLStat: View {
    let label: String
    let amount: Int
    let tint: Color
    var negative = false
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            Text("\(negative ? "−" : "")\(PLPalette.money(amount))")
                .font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(tint).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

private struct PLNotice: View {
    let text: String
    let tint: Color
    var body: some View {
        Text(text).font(.footnote).foregroundStyle(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .lgCard(radius: AlmaSwiftTheme.rControl)
    }
}

// MARK: - Add/edit form (shared by create_party / add_txn / edit_txn)

private struct PLTxnForm: View {
    let title: String
    let askName: Bool
    let busy: Bool
    var initialDir = "OUT"
    var initialAmount = ""
    var initialReason = ""
    var initialDate = PLDate.today()
    var onDelete: (() -> Void)?
    let onSubmit: (_ name: String, _ dir: String, _ amount: Int, _ reason: String, _ date: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var name = ""
    @State private var dir = "OUT"
    @State private var amount = ""
    @State private var reason = ""
    @State private var date = Date()
    @State private var localError: String?
    @State private var loaded = false

    private var parsedAmount: Int { Int(amount.filter { $0.isNumber }) ?? 0 }

    var body: some View {
        NavigationStack {
            Form {
                localError.map { Text("⚠️ \($0)").font(.footnote).foregroundStyle(PLPalette.red(scheme)) }

                if askName {
                    Section("নাম *") {
                        TextField("যেমন: করিম ট্রেডার্স", text: $name)
                    }
                }
                Section("ধরন *") {
                    Picker("ধরন", selection: $dir) {
                        Text("টাকা দিলাম").tag("OUT")
                        Text("টাকা নিলাম").tag("IN")
                    }.pickerStyle(.segmented)
                }
                Section("পরিমাণ (৳) *") {
                    TextField("যেমন: 4000", text: $amount).keyboardType(.numberPad)
                }
                Section("কারণ *") {
                    TextField("যেমন: ধার দিলাম / ধার নিলাম", text: $reason)
                }
                Section("তারিখ *") {
                    DatePicker("তারিখ", selection: $date, displayedComponents: .date)
                        .datePickerStyle(.compact)
                }
                Section {
                    Button {
                        if askName && name.trimmingCharacters(in: .whitespaces).isEmpty { localError = "নাম দিন।" }
                        else if parsedAmount <= 0 { localError = "সঠিক একটি টাকার অঙ্ক দিন।" }
                        else if reason.trimmingCharacters(in: .whitespaces).isEmpty { localError = "কারণ লিখুন।" }
                        else if !busy {
                            localError = nil
                            onSubmit(name.trimmingCharacters(in: .whitespaces), dir, parsedAmount,
                                     reason.trimmingCharacters(in: .whitespaces), PLDate.fromDate(date))
                        }
                    } label: {
                        HStack {
                            if busy { ProgressView().tint(.white) }
                            Text("সংরক্ষণ করুন").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .listRowBackground(PLPalette.coral)

                    if let onDelete {
                        Button(role: .destructive) { onDelete() } label: {
                            Text("এই লেনদেনটি মুছে ফেলুন").frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } } }
            .onAppear {
                guard !loaded else { return }
                loaded = true
                dir = initialDir
                amount = initialAmount
                reason = initialReason
                date = PLDate.toDate(initialDate)
            }
        }
    }
}
