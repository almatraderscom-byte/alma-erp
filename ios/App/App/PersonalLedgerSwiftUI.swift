//
//  PersonalLedgerSwiftUI.swift
//  ALMA ERP — owner personal পাওনা-দেনা khata as a native SwiftUI screen.
//
//  ⚠️ NOT WIRED YET (owner decision 2026-07-13): this file is intentionally NOT
//  added to the Xcode target — it does not compile into the app. When the owner
//  says go:
//    1. Add this file to the App target in Xcode (or via project.pbxproj).
//    2. Register the route in AlmaNativeRouter for /finance/personal-ledger.
//    3. In ApprovalsSwiftUI, EXPENSE_REIMBURSEMENT approvals must show the
//       payout chooser (👛 wallet / ⚡️ instant) and PATCH /api/approvals/[id]
//       with {"payoutMode":"wallet"|"instant"} — same contract as the web.
//
//  Mirrors the web page 1:1 — same endpoint, same semantics:
//    GET  /api/assistant… ✗ (not an agent route)
//    GET  /api/finance/personal-ledger              → parties + totals
//    GET  /api/finance/personal-ledger?party_id=…   → party + serial txns
//    POST /api/finance/personal-ledger {op: create_party|add_txn|edit_txn|delete_txn}
//  Direction: OUT = টাকা দিলাম (they owe more) · IN = টাকা নিলাম (they owe less).
//  Net > 0 → আমি পাব (emerald) · net < 0 → আমি দেব (red) · 0 → নিষ্পত্তি.
//

import SwiftUI

// MARK: - Palette (mirror of AlmaSwiftTheme — keep in sync)

private enum PLPalette {
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)   // #E07A5F
    static let coralLt = Color(red: 0.957, green: 0.635, blue: 0.549) // #F4A28C
    static let emerald = Color(red: 0.290, green: 0.871, blue: 0.502) // #4ADE80
    static let red = Color(red: 0.937, green: 0.267, blue: 0.267)     // #EF4444

    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? coralLt : Color(red: 0.769, green: 0.353, blue: 0.235)
    }
    static func netColor(_ net: Int, scheme: ColorScheme) -> Color {
        net > 0 ? emerald : net < 0 ? red : .secondary
    }
}

// MARK: - Models (same field names the web API returns)

struct PLParty: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let phone: String?
    let net: Int
    let txnCount: Int
    let lastTxnDate: String?
}

struct PLTxn: Decodable, Identifiable, Equatable {
    let id: String
    let direction: String // "OUT" | "IN"
    let amount: Int
    let reason: String
    let txnDate: String
    let createdAt: String?
    let edited: Bool
}

struct PLPartyDetail: Decodable, Equatable {
    let id: String
    let name: String
    let phone: String?
    let note: String?
    let net: Int
    let txns: [PLTxn]
}

private struct PLListResponse: Decodable {
    let ok: Bool?
    let parties: [PLParty]?
    let totalReceivable: Int?
    let totalPayable: Int?
    let net: Int?
}

private struct PLDetailResponse: Decodable {
    let ok: Bool?
    let party: PLPartyDetail?
}

// MARK: - API

/// POST body for every ledger write — op decides which fields matter (web parity).
struct PLOpBody: Encodable {
    var op: String // create_party | add_txn | edit_txn | delete_txn
    var name: String?
    var party_id: String?
    var txn_id: String?
    var direction: String? // OUT | IN
    var amount: Int?
    var reason: String?
    var txn_date: String? // YYYY-MM-DD
}

private struct PLOpResponse: Decodable {
    let ok: Bool?
    let message: String?
    let partyId: String?
}

@MainActor
final class PersonalLedgerModel: ObservableObject {
    @Published var parties: [PLParty] = []
    @Published var totalReceivable = 0
    @Published var totalPayable = 0
    @Published var net = 0
    @Published var detail: PLPartyDetail?
    @Published var loading = false
    @Published var errorText: String?

    func loadList() async {
        loading = true
        defer { loading = false }
        do {
            let parsed: PLListResponse = try await AlmaAPI.shared.get("/api/finance/personal-ledger")
            parties = parsed.parties ?? []
            totalReceivable = parsed.totalReceivable ?? 0
            totalPayable = parsed.totalPayable ?? 0
            net = parsed.net ?? 0
            errorText = nil
        } catch {
            errorText = "খাতা লোড করা যায়নি।"
        }
    }

    func openParty(_ id: String) async {
        loading = true
        defer { loading = false }
        do {
            let parsed: PLDetailResponse = try await AlmaAPI.shared.get(
                "/api/finance/personal-ledger", query: ["party_id": id])
            detail = parsed.party
        } catch {
            errorText = "খাতাটি লোড করা যায়নি।"
        }
    }

    func post(_ body: PLOpBody) async -> Bool {
        do {
            let _: PLOpResponse = try await AlmaAPI.shared.send("POST", "/api/finance/personal-ledger", body: body)
            return true
        } catch {
            errorText = "সংরক্ষণ করা যায়নি।"
            return false
        }
    }
}

// MARK: - Screens

struct PersonalLedgerScreen: View {
    @StateObject private var model = PersonalLedgerModel()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let detail = model.detail {
                PLPartyDetailView(model: model, detail: detail)
            } else {
                PLPartyListView(model: model)
            }
        }
        .task { await model.loadList() }
    }
}

private struct PLPartyListView: View {
    @ObservedObject var model: PersonalLedgerModel
    @Environment(\.colorScheme) private var scheme
    @State private var filter = 0 // 0 সব · 1 পাওনা · 2 দেনা · 3 নিষ্পত্তি

    private var filtered: [PLParty] {
        switch filter {
        case 1: return model.parties.filter { $0.net > 0 }
        case 2: return model.parties.filter { $0.net < 0 }
        case 3: return model.parties.filter { $0.net == 0 }
        default: return model.parties
        }
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    PLStat(label: "মোট পাওনা", amount: model.totalReceivable, color: PLPalette.emerald)
                    PLStat(label: "মোট দেনা", amount: model.totalPayable, color: PLPalette.red)
                    PLStat(label: "নিট", amount: abs(model.net), color: PLPalette.netColor(model.net, scheme: scheme))
                }
                .listRowBackground(Color.clear)
            }
            Section {
                Picker("ফিল্টার", selection: $filter) {
                    Text("সব").tag(0)
                    Text("পাওনা").tag(1)
                    Text("দেনা").tag(2)
                    Text("নিষ্পত্তি").tag(3)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            Section("খাতা · \(model.parties.count) জন") {
                ForEach(filtered) { party in
                    Button {
                        Task { await model.openParty(party.id) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(party.name).font(.subheadline.weight(.semibold))
                                Text("\(party.txnCount)টি লেনদেন · শেষ: \(party.lastTxnDate ?? "—")")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(party.net < 0 ? "−" : "")৳\(abs(party.net).formatted())")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(PLPalette.netColor(party.net, scheme: scheme))
                                Text(party.net > 0 ? "আমি পাব" : party.net < 0 ? "আমি দেব" : "নিষ্পত্তি")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(PLPalette.netColor(party.net, scheme: scheme))
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("পাওনা-দেনা")
        .refreshable { await model.loadList() }
    }
}

private struct PLPartyDetailView: View {
    @ObservedObject var model: PersonalLedgerModel
    let detail: PLPartyDetail
    @Environment(\.colorScheme) private var scheme

    /// Serial rows with running balance (oldest → newest), same math as web.
    private var rows: [(txn: PLTxn, run: Int)] {
        var run = 0
        return detail.txns.map { t in
            run += t.direction == "OUT" ? t.amount : -t.amount
            return (t, run)
        }
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 4) {
                    Text("\(detail.net < 0 ? "−" : "")৳\(abs(detail.net).formatted())")
                        .font(.title.weight(.black))
                        .foregroundStyle(PLPalette.netColor(detail.net, scheme: scheme))
                    Text(detail.net > 0 ? "সে আমাকে দেবে (আমি পাব)" : detail.net < 0 ? "আমি তাকে দেব (আমার দেনা)" : "হিসাব নিষ্পত্তি ✓")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
            Section("লেনদেনের খতিয়ান · \(detail.txns.count)টি") {
                ForEach(rows, id: \.txn.id) { row in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("\(row.txn.direction == "OUT" ? "↑ টাকা দিলাম" : "↓ টাকা নিলাম") · \(row.txn.reason)")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("\(row.txn.direction == "OUT" ? "−" : "+")৳\(row.txn.amount.formatted())")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(row.txn.direction == "OUT" ? PLPalette.red : PLPalette.emerald)
                        }
                        Text(row.txn.txnDate).font(.caption2).foregroundStyle(.secondary)
                        Text("ব্যালেন্স: \(row.run < 0 ? "−" : "")৳\(abs(row.run).formatted()) \(row.run > 0 ? "আমি পাব" : row.run < 0 ? "আমি দেব" : "— নিষ্পত্তি")")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    // Edit/delete: swipe actions call model.post(op: edit_txn/delete_txn)
                    // — wire when this screen is added to the target.
                }
            }
            Section {
                Button("‹ পাওনা-দেনা তালিকায় ফিরুন") {
                    model.detail = nil
                    Task { await model.loadList() }
                }
                .foregroundStyle(PLPalette.accentText(scheme))
            }
        }
        .navigationTitle(detail.name)
    }
}

private struct PLStat: View {
    let label: String
    let amount: Int
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text("৳\(amount.formatted())").font(.subheadline.weight(.bold)).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}
