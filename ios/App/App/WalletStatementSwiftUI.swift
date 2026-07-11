//
//  WalletStatementSwiftUI.swift
//  App
//
//  Native "সম্পূর্ণ হিসাব" — the staff wallet transparency statement (web
//  /portal/wallet parity, PR #276).
//
//  API (all owner-approved server work already on main):
//    GET  /api/payroll/wallet/{empId}?business_id=…[&from=YYYY-MM-DD&to=YYYY-MM-DD]
//         → entries (labelBn + per-fine `appeal` info) · fineSummaries
//           (last30Days / thisMonth / sinceJoining / customRange) · summary
//    POST /api/attendance/waivers   → staff files a penalty appeal
//         { attendance_record_id, business_id, reason, request_type }
//
//  Owner rules surfaced here:
//   • every fine shows WHY + its appeal state forever (none/pending/approved/
//     rejected+reason/expired), refunds are linked "সমন্বয়" rows;
//   • appeals allowed for 30 days from the fine date (server enforces too);
//   • totals for গত ৩০ দিন / এই মাস / শুরু থেকে / custom date range.
//

import SwiftUI

// ── palette / format (file-local, same convention as PortalSwiftUI) ─────────

private enum WSPalette {
    static let coral = AlmaSwiftTheme.coral
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)   // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)  // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)   // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024) // #D97706
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)
    static let blue500 = Color(red: 0.231, green: 0.510, blue: 0.965)  // #3B82F6

    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

private enum WSFormat {
    private static let bn: [Character: Character] = [
        "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
        "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯",
    ]
    static let bnMonths = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
                           "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"]

    static func bnDigits(_ s: String) -> String {
        String(s.map { bn[$0] ?? $0 })
    }

    static func money(_ n: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        let base = f.string(from: NSNumber(value: n.rounded())) ?? String(Int(n))
        return "৳ " + base
    }

    static func moneyBn(_ n: Double) -> String { bnDigits(money(n)) }

    /// "2026-07-09…" → "৯ জুলাই ২০২৬"
    static func dateBn(_ iso: String?) -> String {
        guard let iso, iso.count >= 10 else { return "—" }
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return String(iso.prefix(10)) }
        return "\(bnDigits(String(parts[2]))) \(bnMonths[parts[1] - 1]) \(bnDigits(String(parts[0])))"
    }

    /// "2026-07" → "জুলাই ২০২৬"
    static func periodBn(_ ym: String) -> String {
        let parts = ym.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, (1...12).contains(parts[1]) else { return ym }
        return "\(bnMonths[parts[1] - 1]) \(bnDigits(String(parts[0])))"
    }
}

// ── decodables (tolerant, mirroring the web page's local types) ─────────────

private struct WSAppealInfo: Decodable {
    let status: String            // NONE|PENDING|APPROVED|PARTIALLY_APPROVED|REJECTED|CANCELLED|EXPIRED
    let appealable: Bool
    let daysLeft: Int
    let attendanceRecordId: String?
    let refundedAmount: Double?
    let adminNote: String?
}

private struct WSEntry: Decodable, Identifiable {
    let id: String
    let type: String
    let source: String?
    let note: String?
    let date: String?
    let labelBn: String?
    let signedAmount: Double
    let runningBalance: Double
    let appeal: WSAppealInfo?

    private enum K: String, CodingKey {
        case id, type, source, note, date, labelBn, signedAmount, runningBalance, appeal
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? "—"
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        labelBn = try? c.decodeIfPresent(String.self, forKey: .labelBn)
        signedAmount = (try? c.decodeIfPresent(Double.self, forKey: .signedAmount)) ?? 0
        runningBalance = (try? c.decodeIfPresent(Double.self, forKey: .runningBalance)) ?? 0
        appeal = try? c.decodeIfPresent(WSAppealInfo.self, forKey: .appeal)
    }

    var isFineRefund: Bool {
        type == "ADJUSTMENT" && ["attendance_late_penalty_reversal",
                                 "attendance_exception_refund",
                                 "attendance_reset_reversal"].contains(source ?? "")
    }
}

private struct WSFineWindow: Decodable {
    let fineCount: Int
    let fineTotal: Double
    let refundCount: Int
    let refundTotal: Double
    let pendingAppeals: Int
}

private struct WSFineSummaries: Decodable {
    let appealWindowDays: Int?
    let last30Days: WSFineWindow?
    let thisMonth: WSFineWindow?
    let sinceJoining: WSFineWindow?
    let customRange: WSFineWindow?
}

private struct WSResponse: Decodable {
    let entries: [WSEntry]
    let fineSummaries: WSFineSummaries?

    private enum K: String, CodingKey { case entries, fineSummaries }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        entries = (try? c.decodeIfPresent([WSEntry].self, forKey: .entries)) ?? []
        fineSummaries = try? c.decodeIfPresent(WSFineSummaries.self, forKey: .fineSummaries)
    }
}

private struct WSOkResponse: Decodable { let ok: Bool? }

// ── view model ───────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
@Observable
@MainActor
private final class WalletStatementVM {
    let employeeId: String
    let businessId: String
    init(employeeId: String, businessId: String) {
        self.employeeId = employeeId
        self.businessId = businessId
    }

    enum Preset: String, CaseIterable {
        case last30 = "গত ৩০ দিন", month = "এই মাস", all = "শুরু থেকে", custom = "কাস্টম"
    }

    var full: WSResponse? = nil
    var custom: WSResponse? = nil
    var preset: Preset = .last30
    var customFrom = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
    var customTo = Date()
    var loading = false
    var customLoading = false
    var error: String? = nil
    var notice: String? = nil
    var visibleCount = 40
    var appealBusy = false

    var activeEntries: [WSEntry] {
        preset == .custom ? (custom?.entries ?? []) : (full?.entries ?? [])
    }
    var activeFineWindow: WSFineWindow? {
        switch preset {
        case .last30: return full?.fineSummaries?.last30Days
        case .month: return full?.fineSummaries?.thisMonth
        case .all: return full?.fineSummaries?.sinceJoining
        case .custom: return custom?.fineSummaries?.customRange
        }
    }
    var currentBalance: Double { full?.entries.last?.runningBalance ?? 0 }
    var appealWindowDays: Int { full?.fineSummaries?.appealWindowDays ?? 30 }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: WSResponse = try await AlmaAPI.shared.get(
                "/api/payroll/wallet/\(employeeId)", query: ["business_id": businessId])
            full = resp
        } catch {
            self.error = error.localizedDescription
        }
    }

    private static let dayFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        return f
    }()

    func loadCustom() async {
        customLoading = true
        defer { customLoading = false }
        do {
            let resp: WSResponse = try await AlmaAPI.shared.get(
                "/api/payroll/wallet/\(employeeId)",
                query: [
                    "business_id": businessId,
                    "from": Self.dayFmt.string(from: customFrom),
                    "to": Self.dayFmt.string(from: customTo),
                ])
            custom = resp
        } catch {
            self.error = error.localizedDescription
        }
    }

    func submitAppeal(recordId: String, reason: String) async -> Bool {
        appealBusy = true
        defer { appealBusy = false }
        do {
            let _: WSOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/attendance/waivers",
                body: [
                    "attendance_record_id": recordId,
                    "business_id": businessId,
                    "reason": reason,
                    "request_type": "FULL_WAIVE",
                ])
            notice = "আপিল জমা হয়েছে — Boss দেখে সিদ্ধান্ত দেবেন।"
            await load()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

// ── screen ───────────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
struct WalletStatementScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var vm: WalletStatementVM
    @State private var appealTarget: WSEntry? = nil

    init(employeeId: String, businessId: String) {
        _vm = State(initialValue: WalletStatementVM(employeeId: employeeId, businessId: businessId))
    }

    /// Newest-first, paginated FIRST (visibleCount rows), then month-bucketed —
    /// so "আরো দেখুন" extends the list without result-builder mutation tricks.
    private var monthGroups: [(key: String, rows: [WSEntry])] {
        let limited = vm.activeEntries.reversed().prefix(vm.visibleCount)
        var order: [String] = []
        var map: [String: [WSEntry]] = [:]
        for e in limited {
            let ym = String((e.date ?? "").prefix(7))
            if map[ym] == nil { order.append(ym); map[ym] = [] }
            map[ym]?.append(e)
        }
        return order.map { ($0, map[$0] ?? []) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if let err = vm.error { noticeRow(err, color: WSPalette.red500) }
                if let ok = vm.notice { noticeRow(ok, color: WSPalette.emerald600) }
                if vm.loading && vm.full == nil {
                    ProgressView().padding(.vertical, 60)
                } else {
                    balanceCard
                    fineSummaryCard
                    statementCard
                }
                Color.clear.frame(height: 12)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PortalAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $appealTarget) { entry in
            WSAppealSheet(entry: entry, busy: vm.appealBusy) { reason in
                guard let rid = entry.appeal?.attendanceRecordId else { return }
                Task {
                    if await vm.submitAppeal(recordId: rid, reason: reason) {
                        appealTarget = nil
                    }
                }
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
    }

    // ── header / hero ──

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("সম্পূর্ণ হিসাব").font(.title3.weight(.bold))
                Text("সব লেনদেন · জরিমানা ও আপিলের অবস্থা")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
                    .padding(9)
                    .background(.thinMaterial, in: Circle())
            }
            .accessibilityLabel("বন্ধ করুন")
        }
        .padding(.top, 4)
    }

    private var balanceCard: some View {
        VStack(spacing: 4) {
            Text("বর্তমান ব্যালেন্স")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(WSPalette.accentText(colorScheme))
            Text(WSFormat.moneyBn(vm.currentBalance))
                .font(.system(size: 34, weight: .heavy, design: .rounded))
                .monospacedDigit()
            Text("মোট \(WSFormat.bnDigits(String(vm.full?.entries.count ?? 0)))টি লেনদেন")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .background(cardBg)
    }

    // ── fine summary ──

    private var fineSummaryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("জরিমানা ও আপিল")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(WSPalette.accentText(colorScheme))

            Picker("", selection: $vm.preset) {
                ForEach(WalletStatementVM.Preset.allCases, id: \.self) { p in
                    Text(p.rawValue).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: vm.preset) { _, p in
                if p == .custom && vm.custom == nil { Task { await vm.loadCustom() } }
            }

            if vm.preset == .custom {
                VStack(spacing: 8) {
                    HStack {
                        DatePicker("শুরু", selection: $vm.customFrom, displayedComponents: .date)
                        DatePicker("শেষ", selection: $vm.customTo, displayedComponents: .date)
                    }
                    .font(.caption)
                    Button {
                        Task { await vm.loadCustom() }
                    } label: {
                        if vm.customLoading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("প্রয়োগ করুন").font(.caption.weight(.bold)).frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WSPalette.coral)
                }
            }

            if let w = vm.activeFineWindow {
                HStack(spacing: 0) {
                    fineStat("মোট জরিমানা", "\(WSFormat.bnDigits(String(w.fineCount)))টি",
                             WSFormat.moneyBn(w.fineTotal), WSPalette.red500)
                    divider
                    fineStat("আপিলে ফেরত", "\(WSFormat.bnDigits(String(w.refundCount)))টি",
                             WSFormat.moneyBn(w.refundTotal), WSPalette.emerald600)
                    divider
                    fineStat("আপিল অপেক্ষায়", "\(WSFormat.bnDigits(String(w.pendingAppeals)))টি",
                             nil, WSPalette.amber600)
                    divider
                    fineStat("নিট খরচ", nil,
                             WSFormat.moneyBn(w.fineTotal - w.refundTotal),
                             colorScheme == .dark ? .white : .black)
                }
            } else if vm.preset == .custom {
                Text("তারিখ বেছে নিয়ে ‘প্রয়োগ করুন’ চাপুন।")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            Text("আপিলের সময়সীমা: জরিমানার দিন থেকে \(WSFormat.bnDigits(String(vm.appealWindowDays))) দিন")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBg)
    }

    private var divider: some View {
        Rectangle().fill(.quaternary).frame(width: 0.5, height: 34)
    }

    private func fineStat(_ label: String, _ count: String?, _ amount: String?, _ tone: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.system(size: 9, weight: .bold))
                .foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
            if let count {
                Text(count).font(.caption.weight(.heavy)).foregroundStyle(tone)
            }
            if let amount {
                Text(amount).font(.system(size: 10, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(count == nil ? tone : .secondary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // ── statement ──

    private var statementCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("লেনদেনের বিস্তারিত বিবরণী")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(WSPalette.accentText(colorScheme))
                .padding(14)

            if vm.activeEntries.isEmpty {
                Text(vm.preset == .custom ? "এই রেঞ্জে কোনো লেনদেন নেই।" : "এখনো কোনো লেনদেন নেই।")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.bottom, 14)
            } else {
                ForEach(monthGroups, id: \.key) { group in
                    Text(WSFormat.periodBn(group.key))
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quinary)
                    ForEach(group.rows) { e in
                        entryRow(e)
                    }
                }
                if vm.activeEntries.count > vm.visibleCount {
                    Button {
                        vm.visibleCount += 40
                    } label: {
                        Text("আরো দেখুন")
                            .font(.caption.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                }
            }
        }
        .background(cardBg)
    }

    private func entryRow(_ e: WSEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                entryIcon(e)
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.labelBn ?? e.type.replacingOccurrences(of: "_", with: " "))
                        .font(.system(size: 13, weight: .semibold))
                    if let note = e.note, !note.isEmpty {
                        Text(note).font(.system(size: 11)).foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Text(WSFormat.dateBn(e.date))
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(e.signedAmount >= 0 ? "+" : "−")\(WSFormat.moneyBn(abs(e.signedAmount)))")
                        .font(.system(size: 13, weight: .bold)).monospacedDigit()
                        .foregroundStyle(e.signedAmount >= 0 ? WSPalette.green400 : WSPalette.red500)
                    Text(WSFormat.moneyBn(e.runningBalance))
                        .font(.system(size: 10)).monospacedDigit()
                        .foregroundStyle(WSPalette.goldLt)
                }
            }
            if e.type == "PENALTY" { appealChip(e) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .padding(.leading, e.isFineRefund ? 18 : 0)   // refund rows indent under their fine
        .overlay(alignment: .bottom) { Divider().padding(.leading, 14) }
    }

    private func entryIcon(_ e: WSEntry) -> some View {
        let (name, tone): (String, Color) =
            e.type == "PENALTY" ? ("flag.fill", WSPalette.red500)
            : e.isFineRefund ? ("arrow.uturn.backward", WSPalette.blue500)
            : e.signedAmount >= 0 ? ("arrow.down", WSPalette.emerald600)
            : ("arrow.up", WSPalette.amber600)
        return Image(systemName: name)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(tone)
            .frame(width: 30, height: 30)
            .background(tone.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
    }

    @ViewBuilder
    private func appealChip(_ e: WSEntry) -> some View {
        if let a = e.appeal {
            switch a.status {
            case "PENDING":
                chip("আপিল অপেক্ষায় — Boss দেখছেন", WSPalette.blue500)
            case "APPROVED", "PARTIALLY_APPROVED":
                chip("আপিল মঞ্জুর — \(WSFormat.moneyBn(a.refundedAmount ?? 0)) ফেরত", WSPalette.emerald600)
            case "REJECTED":
                VStack(alignment: .leading, spacing: 2) {
                    chip("আপিল নাকচ", WSPalette.red500)
                    if let note = a.adminNote, !note.isEmpty {
                        Text("কারণ: \(note)").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
            case "EXPIRED":
                chip("আপিলের সময় শেষ — \(WSFormat.bnDigits(String(vm.appealWindowDays))) দিন পেরিয়েছে", .secondary)
            default:
                if a.appealable && a.attendanceRecordId != nil {
                    Button {
                        appealTarget = e
                    } label: {
                        Text("আপিল করুন — আর \(WSFormat.bnDigits(String(a.daysLeft))) দিন")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(WSPalette.coral)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(WSPalette.coral.opacity(0.12), in: Capsule())
                            .overlay(Capsule().strokeBorder(WSPalette.coral.opacity(0.5), lineWidth: 1))
                    }
                }
            }
        }
    }

    private func chip(_ text: String, _ tone: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(tone)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(tone.opacity(0.12), in: Capsule())
    }

    private func noticeRow(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    private var cardBg: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(.thinMaterial)
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.quaternary, lineWidth: 0.5))
    }
}

// ── appeal sheet ─────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
private struct WSAppealSheet: View {
    let entry: WSEntry
    let busy: Bool
    let onSubmit: (String) -> Void
    @State private var reason = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("জরিমানার আপিল").font(.headline.weight(.bold))
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.labelBn ?? "জরিমানা").font(.subheadline.weight(.semibold))
                Text("\(WSFormat.dateBn(entry.date)) · \(WSFormat.moneyBn(abs(entry.signedAmount)))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quinary, in: RoundedRectangle(cornerRadius: 12))

            Text("কেন জরিমানাটা ভুল বা মাফযোগ্য — লিখুন:")
                .font(.caption).foregroundStyle(.secondary)
            TextField("যেমন: অফিসের কাজে বাইরে ছিলাম…", text: $reason, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)

            Button {
                onSubmit(reason.trimmingCharacters(in: .whitespacesAndNewlines))
            } label: {
                if busy {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("আপিল পাঠান")
                        .font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(AlmaSwiftTheme.coral)
            .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)

            Button("বাতিল") { dismiss() }
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .padding(18)
    }
}
