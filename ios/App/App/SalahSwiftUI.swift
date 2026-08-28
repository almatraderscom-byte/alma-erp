//
//  SalahSwiftUI.swift
//  App
//
//  নামাজ section (owner request 2026-08-28): full salah system on iOS —
//  a visible calendar (week / month) of every waqt's prayed/missed state,
//  plus the complete settings the web card has (location presets with
//  AlmaAdhan autofill, abroad call toggle, per-waqt time editor).
//
//  Data:
//   · GET /api/assistant/salah/history?from&to      → calendar records
//   · GET/POST /api/agent/salah-times               → {config} 5×৩ times
//   · GET/POST /api/assistant/salah/location        → presets + autofill
//   · GET/POST /api/assistant/salah/abroad-calls    → { off }
//

import SwiftUI

// MARK: - Models

struct SalahWaqtRec: Decodable, Identifiable {
    let waqt: String
    let status: String
    let confirmedAt: String?
    let windowStart: String
    let windowEnd: String
    var id: String { waqt }
}

struct SalahDay: Decodable, Identifiable {
    let date: String            // YYYY-MM-DD (location calendar day)
    let waqts: [SalahWaqtRec]
    var id: String { date }
}

private struct SalahHistoryResp: Decodable {
    let today: String
    let offsetMin: Int
    let from: String
    let to: String
    let days: [SalahDay]
}

private enum SalahL10n {
    static let waqtNames: [String: String] = [
        "fajr": "ফজর", "dhuhr": "যোহর", "asr": "আসর", "maghrib": "মাগরিব", "isha": "ইশা",
    ]
    static let waqtShort: [String: String] = [
        "fajr": "ফ", "dhuhr": "য", "asr": "আ", "maghrib": "মা", "isha": "ই",
    ]
    static let order = ["fajr", "dhuhr", "asr", "maghrib", "isha"]

    static func statusLabel(_ s: String) -> String {
        switch s {
        case "prayed_on_time": return "সময়মতো পড়েছেন"
        case "prayed_late": return "দেরিতে পড়েছেন"
        case "qaza": return "কাযা করেছেন"
        case "missed": return "পড়া হয়নি"
        case "skipped": return "হিসাবের বাইরে"
        default: return "বাকি"
        }
    }

    static let monthNames = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
                             "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"]
    static let weekdayShort = ["র", "সো", "ম", "বু", "বৃ", "শু", "শ"] // Sun..Sat
}

private func salahStatusColor(_ status: String, _ scheme: ColorScheme) -> Color {
    switch status {
    case "prayed_on_time": return AlmaSwiftTheme.ios27Green(scheme)
    case "prayed_late": return Color.teal
    case "qaza": return AlmaSwiftTheme.ios27Orange(scheme)
    case "missed": return AlmaSwiftTheme.ios27Red(scheme)
    default: return Color.secondary.opacity(0.35)
    }
}

// MARK: - Pure YMD calendar math (no TimeZone traps — server day strings are truth)

private enum YmdCal {
    static func split(_ ymd: String) -> (y: Int, m: Int, d: Int) {
        let p = ymd.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return (2026, 1, 1) }
        return (p[0], p[1], p[2])
    }
    static func make(_ y: Int, _ m: Int, _ d: Int) -> String {
        String(format: "%04d-%02d-%02d", y, m, d)
    }
    static func daysInMonth(_ y: Int, _ m: Int) -> Int {
        let long = [1, 3, 5, 7, 8, 10, 12]
        if m == 2 {
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
            return leap ? 29 : 28
        }
        return long.contains(m) ? 31 : 30
    }
    /// Weekday of a Gregorian date, 0=Sunday … 6=Saturday (Sakamoto).
    static func weekday(_ y: Int, _ m: Int, _ d: Int) -> Int {
        let t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
        let yy = m < 3 ? y - 1 : y
        return (yy + yy / 4 - yy / 100 + yy / 400 + t[m - 1] + d) % 7
    }
    static func addDays(_ ymd: String, _ days: Int) -> String {
        var (y, m, d) = split(ymd)
        d += days
        while d > daysInMonth(y, m) { d -= daysInMonth(y, m); m += 1; if m > 12 { m = 1; y += 1 } }
        while d < 1 { m -= 1; if m < 1 { m = 12; y -= 1 }; d += daysInMonth(y, m) }
        return make(y, m, d)
    }
    /// "১২:৩০"-free simple clock: ISO instant → HH:mm on the location clock.
    static func clock(_ iso: String, offsetMin: Int) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let alt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) ?? alt.date(from: iso) else { return "—" }
        let shifted = date.addingTimeInterval(TimeInterval(offsetMin * 60))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.hour, .minute], from: shifted)
        let h24 = c.hour ?? 0, mi = c.minute ?? 0
        let h12 = h24 % 12 == 0 ? 12 : h24 % 12
        let ampm = h24 < 12 ? "AM" : "PM"
        return String(format: "%d:%02d %@", h12, mi, ampm)
    }
}

// MARK: - Store

@MainActor
final class SalahStore: ObservableObject {
    @Published var byDate: [String: SalahDay] = [:]
    @Published var today: String = ""
    @Published var offsetMin: Int = 360
    @Published var loading = false
    @Published var error: String?

    private var loadedRanges: [(String, String)] = []

    /// nil bounds = let the SERVER pick today/from/to on the owner's current
    /// location clock — the client's cached `today` can be a day off right
    /// after a location change (review-bot P2). The cached range is recorded
    /// from the response, which always carries the authoritative from/to.
    func loadRange(from: String?, to: String?) async {
        if let f = from, let t = to,
           loadedRanges.contains(where: { $0.0 <= f && t <= $0.1 }) { return }
        loading = byDate.isEmpty
        error = nil
        do {
            let r: SalahHistoryResp = try await AlmaAPI.shared.get(
                "/api/assistant/salah/history", query: ["from": from, "to": to])
            today = r.today
            offsetMin = r.offsetMin
            for day in r.days { byDate[day.date] = day }
            loadedRanges.append((r.from, r.to))
        } catch {
            self.error = "নামাজের হিসাব আনা যায়নি — নেটওয়ার্ক দেখুন।"
        }
        loading = false
    }

    func refresh() async {
        loadedRanges = []
        byDate = [:]
        await loadRange(from: nil, to: nil)
    }
}

// MARK: - Screen

struct SalahScreen: View {
    @StateObject private var store = SalahStore()
    @Environment(\.colorScheme) private var scheme

    @State private var mode = 0                     // 0 সপ্তাহ · 1 মাস
    @State private var monthAnchor: (y: Int, m: Int)? = nil
    @State private var detailDay: SalahDay?
    @State private var settingsOpen = false
    @State private var locationChanged = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                summaryCard
                HStack(spacing: 10) {
                    Picker("", selection: $mode) {
                        Text("সপ্তাহ").tag(0)
                        Text("মাস").tag(1)
                    }
                    .pickerStyle(.segmented)
                    Button { settingsOpen = true } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(AlmaSwiftTheme.coral)
                            .frame(width: 36, height: 32)
                            .background(AlmaSwiftTheme.coral.opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .accessibilityLabel("নামাজ সেটিংস")
                }
                if store.loading {
                    ProgressView().padding(.top, 40)
                } else if let err = store.error {
                    VStack(spacing: 10) {
                        Text(err).font(.footnote).foregroundStyle(.secondary)
                        Button("আবার চেষ্টা") { Task { await store.refresh() } }
                            .buttonStyle(.bordered)
                    }
                    .padding(.top, 30)
                } else if mode == 0 {
                    weekList
                } else {
                    monthGrid
                }
                legend
            }
            .padding(.horizontal, AlmaSwiftTheme.margin)
            .padding(.vertical, 12)
        }
        .background(AlmaSwiftTheme.rootBg(scheme).ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { settingsOpen = true } label: {
                    Image(systemName: "gearshape.fill").foregroundStyle(AlmaSwiftTheme.coral)
                }
            }
        }
        .sheet(item: $detailDay) { day in
            SalahDayDetailSheet(day: day, offsetMin: store.offsetMin, today: store.today)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $settingsOpen, onDismiss: {
            // Location / time edits change the calendar's day windows — drop the
            // range cache and refetch so the grid reflects them immediately.
            // After a LOCATION change the worker rebuilds today's records only
            // on its next 5-minute tick — schedule follow-up refreshes so the
            // new windows appear without a manual pull (review-bot P2).
            let followUp = locationChanged
            locationChanged = false
            Task {
                await reloadAll()
                if followUp {
                    try? await Task.sleep(nanoseconds: 90 * 1_000_000_000)
                    await reloadAll()
                    try? await Task.sleep(nanoseconds: 240 * 1_000_000_000)
                    await reloadAll()
                }
            }
        }) {
            SalahSettingsSheet(onLocationApplied: { locationChanged = true })
        }
        .task {
            // Server picks the bounds on the owner's location clock.
            await store.loadRange(from: nil, to: nil)
        }
        .onChange(of: scenePhase) { phase in
            // Foregrounding after midnight: re-ask the server for its current
            // day so today's row/marker roll over (review-bot P2). nil bounds
            // bypass the range cache, so this always refetches fresh.
            if phase == .active {
                Task { await store.loadRange(from: nil, to: nil) }
            }
        }
        .refreshable { await reloadAll() }
    }

    /// Full refresh that also re-pulls the month the user is LOOKING at — the
    /// month grid's .task(id:) won't rerun for an unchanged month, so a bare
    /// store.refresh() would leave it empty when it sits outside the default
    /// server range (review-bot P2).
    private func reloadAll() async {
        await store.refresh()
        if mode == 1 {
            let a = currentAnchor
            await store.loadRange(from: YmdCal.make(a.y, a.m, 1),
                                  to: YmdCal.make(a.y, a.m, YmdCal.daysInMonth(a.y, a.m)))
        }
    }

    // ── Summary (this week / this month) ──

    private func counts(from: String, to: String) -> (done: Int, total: Int) {
        var done = 0, total = 0
        var d = from
        while d <= to {
            if let day = store.byDate[d] {
                // 'skipped' = window reconciled away after a time change — no
                // prayer outcome, so it must not depress the ratio (Codex P2).
                for w in day.waqts where w.status != "pending" && w.status != "skipped" {
                    total += 1
                    if w.status == "prayed_on_time" || w.status == "prayed_late" || w.status == "qaza" { done += 1 }
                }
            }
            d = YmdCal.addDays(d, 1)
        }
        return (done, total)
    }

    private var summaryCard: some View {
        let today = store.today.isEmpty ? YmdCal.make(2026, 1, 1) : store.today
        let week = counts(from: YmdCal.addDays(today, -6), to: today)
        let month = counts(from: YmdCal.addDays(today, -29), to: today)
        return HStack(spacing: 12) {
            statTile("এই সপ্তাহ", week)
            statTile("৩০ দিনে", month)
        }
    }

    private func statTile(_ title: String, _ c: (done: Int, total: Int)) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(c.done)")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(AlmaSwiftTheme.coral)
                Text("/ \(c.total) ওয়াক্ত")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ProgressView(value: c.total == 0 ? 0 : Double(c.done) / Double(c.total))
                .tint(AlmaSwiftTheme.coral)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AlmaSwiftTheme.cardBg(scheme),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .shadow(color: AlmaSwiftTheme.cardShadow(scheme), radius: 8, y: 2)
    }

    // ── Week view: last 7 days, one row per day ──

    private var weekList: some View {
        let today = store.today.isEmpty ? YmdCal.make(2026, 1, 1) : store.today
        let days: [String] = (0..<7).map { YmdCal.addDays(today, -$0) }
        return VStack(spacing: 8) {
            ForEach(days, id: \.self) { ymd in
                weekRow(ymd)
            }
        }
    }

    private func weekRow(_ ymd: String) -> some View {
        let (y, m, d) = YmdCal.split(ymd)
        let wd = YmdCal.weekday(y, m, d)
        let day = store.byDate[ymd]
        let isToday = ymd == store.today
        return Button {
            if let day { detailDay = day }
        } label: {
            HStack(spacing: 12) {
                VStack(spacing: 1) {
                    Text(SalahL10n.weekdayShort[wd]).font(.caption2).foregroundStyle(.secondary)
                    Text("\(d)")
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(isToday ? AlmaSwiftTheme.coral : .primary)
                }
                .frame(width: 34)
                if let day {
                    HStack(spacing: 6) {
                        ForEach(day.waqts) { w in
                            Text(SalahL10n.waqtShort[w.waqt] ?? "?")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 26, height: 26)
                                .background(salahStatusColor(w.status, scheme), in: Circle())
                        }
                    }
                } else {
                    Text("রেকর্ড নেই").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 4)
                if isToday {
                    Text("আজ").font(.caption2.weight(.bold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(AlmaSwiftTheme.coral.opacity(0.14), in: Capsule())
                        .foregroundStyle(AlmaSwiftTheme.coral)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(AlmaSwiftTheme.cardBg(scheme),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl + 4, style: .continuous))
            .shadow(color: AlmaSwiftTheme.cardShadow(scheme), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }

    // ── Month grid ──

    private var currentAnchor: (y: Int, m: Int) {
        if let a = monthAnchor { return a }
        let (y, m, _) = YmdCal.split(store.today.isEmpty ? YmdCal.make(2026, 1, 1) : store.today)
        return (y, m)
    }

    private var monthGrid: some View {
        let a = currentAnchor
        let first = YmdCal.make(a.y, a.m, 1)
        let nDays = YmdCal.daysInMonth(a.y, a.m)
        let lead = YmdCal.weekday(a.y, a.m, 1)      // 0=Sun leading blanks
        let cells: [String?] = Array(repeating: nil, count: lead)
            + (1...nDays).map { YmdCal.make(a.y, a.m, $0) }
        return VStack(spacing: 10) {
            HStack {
                Button { shiftMonth(-1) } label: { Image(systemName: "chevron.left") }
                Spacer()
                Text("\(SalahL10n.monthNames[a.m - 1]) \(String(a.y))")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
                Button { shiftMonth(1) } label: { Image(systemName: "chevron.right") }
            }
            .foregroundStyle(AlmaSwiftTheme.coral)
            .padding(.horizontal, 6)

            HStack(spacing: 0) {
                ForEach(SalahL10n.weekdayShort, id: \.self) { w in
                    Text(w).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 6) {
                ForEach(Array(cells.enumerated()), id: \.offset) { _, ymd in
                    if let ymd {
                        monthCell(ymd)
                    } else {
                        Color.clear.frame(height: 46)
                    }
                }
            }
        }
        .padding(12)
        .background(AlmaSwiftTheme.cardBg(scheme),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .shadow(color: AlmaSwiftTheme.cardShadow(scheme), radius: 8, y: 2)
        .task(id: first) {
            await store.loadRange(from: first, to: YmdCal.make(a.y, a.m, nDays))
        }
    }

    private func monthCell(_ ymd: String) -> some View {
        let (_, _, d) = YmdCal.split(ymd)
        let day = store.byDate[ymd]
        let isToday = ymd == store.today
        let isFuture = !store.today.isEmpty && ymd > store.today
        return Button {
            if let day { detailDay = day }
        } label: {
            VStack(spacing: 4) {
                Text("\(d)")
                    .font(.system(size: 13, weight: isToday ? .bold : .medium, design: .rounded))
                    .foregroundStyle(isToday ? AlmaSwiftTheme.coral
                                     : (isFuture ? Color.secondary.opacity(0.45) : Color.primary))
                HStack(spacing: 2) {
                    if let day {
                        ForEach(day.waqts) { w in
                            Circle()
                                .fill(salahStatusColor(w.status, scheme))
                                .frame(width: 5, height: 5)
                        }
                    } else {
                        Circle().fill(.clear).frame(width: 5, height: 5)
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isToday ? AlmaSwiftTheme.coral.opacity(0.10) : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(isToday ? AlmaSwiftTheme.coral.opacity(0.55) : .clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func shiftMonth(_ delta: Int) {
        var a = currentAnchor
        a.m += delta
        if a.m > 12 { a.m = 1; a.y += 1 }
        if a.m < 1 { a.m = 12; a.y -= 1 }
        monthAnchor = a
    }

    // ── Legend ──

    private var legend: some View {
        HStack(spacing: 12) {
            legendDot("সময়মতো", salahStatusColor("prayed_on_time", scheme))
            legendDot("দেরিতে", salahStatusColor("prayed_late", scheme))
            legendDot("কাযা", salahStatusColor("qaza", scheme))
            legendDot("হয়নি", salahStatusColor("missed", scheme))
            legendDot("বাকি", salahStatusColor("pending", scheme))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 2)
    }

    private func legendDot(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Day detail sheet

struct SalahDayDetailSheet: View {
    let day: SalahDay
    let offsetMin: Int
    let today: String
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(day.waqts) { w in
                    HStack(spacing: 12) {
                        Circle()
                            .fill(salahStatusColor(w.status, scheme))
                            .frame(width: 12, height: 12)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(SalahL10n.waqtNames[w.waqt] ?? w.waqt)
                                .font(.system(size: 15, weight: .semibold))
                            Text("\(YmdCal.clock(w.windowStart, offsetMin: offsetMin)) – \(YmdCal.clock(w.windowEnd, offsetMin: offsetMin))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(SalahL10n.statusLabel(w.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(salahStatusColor(w.status, scheme))
                    }
                    .padding(.vertical, 2)
                }
            }
            .navigationTitle(titleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("বন্ধ") { dismiss() }
                }
            }
        }
    }

    private var titleText: String {
        let (y, m, d) = YmdCal.split(day.date)
        let suffix = day.date == today ? " · আজ" : ""
        return "\(d) \(SalahL10n.monthNames[m - 1]) \(String(y))\(suffix)"
    }
}

// MARK: - Settings sheet (full web-card parity)

struct SalahSettingsSheet: View {
    /// Parent hook: a location preset was successfully applied (the worker will
    /// rebuild today's records on its next tick — parent schedules re-reads).
    var onLocationApplied: (() -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    typealias TimeConfig = [String: [String: String]]

    @State private var config: TimeConfig?
    @State private var locationLabel = ""
    /// nil = the persisted value could not be loaded — never fabricate `false`.
    @State private var abroadOff: Bool? = nil
    @State private var abroadBusy = false
    @State private var locationLoadFailed = false
    @State private var loading = true
    @State private var busy = false
    @State private var toast: String?

    private struct TimesResp: Decodable { let config: TimeConfig? }
    private struct LocResp: Decodable { let offsetMin: Int; let label: String }
    private struct AbroadResp: Decodable { let off: Bool }

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    // A transient failure must not leave a dead sheet — surface
                    // it with a retry instead of empty fields (review-bot P2).
                    if config == nil || locationLoadFailed {
                        Section {
                            Button {
                                Task { await load() }
                            } label: {
                                Label(config == nil ? "নামাজের সময় লোড হয়নি — আবার চেষ্টা" : "লোকেশন লোড হয়নি — আবার চেষ্টা",
                                      systemImage: "arrow.clockwise")
                                    .foregroundStyle(AlmaSwiftTheme.coral)
                            }
                        }
                    }
                    locationSection
                    abroadSection
                    timesSection
                }
                if let toast {
                    Section { Text(toast).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("নামাজ সেটিংস")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("বন্ধ") { dismiss() }.disabled(busy || abroadBusy)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(busy ? "সেভ হচ্ছে…" : "সেভ") { Task { await saveTimes() } }
                        .disabled(busy || config == nil)
                        .fontWeight(.semibold)
                }
            }
            .task { await load() }
            // A dismissal mid-write would let the parent's reload race the
            // mutation (preset autofill can take ~15s) — hold the sheet until
            // the write lands (review-bot P2).
            .interactiveDismissDisabled(busy || abroadBusy)
        }
    }

    // ── Sections ──

    private var locationSection: some View {
        Section("অবস্থান — চাপলেই ওই শহরের নামাজের সময় অটো বসে") {
            HStack {
                Image(systemName: "location.fill").foregroundStyle(AlmaSwiftTheme.coral)
                Text(locationLabel.isEmpty ? "সেট নেই" : locationLabel)
                Spacer()
            }
            HStack(spacing: 10) {
                presetButton("বাংলাদেশ (ঢাকা)", offsetMin: 360, city: "Dhaka",
                             country: "Bangladesh", method: 1, school: 1)
                presetButton("UAE (দুবাই)", offsetMin: 240, city: "Dubai",
                             country: "United Arab Emirates", method: 8, school: 0)
            }
        }
    }

    private var abroadSection: some View {
        Section(footer: Text("চালু করলে আপনার বাংলাদেশি নম্বরে কোনো কল যাবে না — সব কল app-এ আসবে। দেশে ফিরে বন্ধ করলেই আবার নম্বরে কল আসবে।")) {
            if let current = abroadOff {
                Toggle(isOn: Binding(
                    get: { current },
                    set: { v in Task { await setAbroad(v) } }
                )) {
                    Label("দেশের বাইরে আছি", systemImage: "airplane")
                }
                .tint(AlmaSwiftTheme.coral)
                .disabled(abroadBusy)
            } else {
                HStack {
                    Label("দেশের বাইরে আছি", systemImage: "airplane")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("লোড হয়নি — আবার") {
                        Task {
                            if let a: AbroadResp = try? await AlmaAPI.shared.get("/api/assistant/salah/abroad-calls") {
                                abroadOff = a.off
                            }
                        }
                    }
                    .font(.caption)
                }
            }
        }
    }

    private var timesSection: some View {
        Section(footer: Text("সময় HH:mm (২৪ ঘণ্টা), যেমন 16:47। বদলে উপরে সেভ চাপুন।")) {
            if let cfg = config {
                ForEach(SalahL10n.order, id: \.self) { waqt in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(SalahL10n.waqtNames[waqt] ?? waqt)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AlmaSwiftTheme.coral)
                        HStack(spacing: 8) {
                            timeField(waqt, "azan", "আজান", cfg)
                            timeField(waqt, "prayer", "জামাত", cfg)
                            timeField(waqt, "end", "শেষ", cfg)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func timeField(_ waqt: String, _ field: String, _ label: String, _ cfg: TimeConfig) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            TextField("HH:mm", text: Binding(
                get: { config?[waqt]?[field] ?? "" },
                set: { v in
                    var c = config ?? [:]
                    var w = c[waqt] ?? [:]
                    w[field] = v
                    c[waqt] = w
                    config = c
                }
            ))
            .font(.system(size: 14, weight: .medium, design: .monospaced))
            .keyboardType(.numbersAndPunctuation)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(AlmaSwiftTheme.fill(scheme),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    private func presetButton(_ label: String, offsetMin: Int, city: String,
                              country: String, method: Int, school: Int) -> some View {
        Button {
            Task { await applyPreset(label: label, offsetMin: offsetMin, city: city,
                                     country: country, method: method, school: school) }
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
        }
        .buttonStyle(.bordered)
        .tint(locationLabel == label ? AlmaSwiftTheme.coral : .secondary)
        .disabled(busy)
    }

    // ── Networking ──

    private func load() async {
        loading = true
        if let t: TimesResp = try? await AlmaAPI.shared.get("/api/agent/salah-times") { config = t.config }
        if let l: LocResp = try? await AlmaAPI.shared.get("/api/assistant/salah/location") {
            locationLabel = l.label
            locationLoadFailed = false
        } else {
            locationLoadFailed = true
        }
        if let a: AbroadResp = try? await AlmaAPI.shared.get("/api/assistant/salah/abroad-calls") { abroadOff = a.off }
        loading = false
    }

    private func saveTimes() async {
        guard let cfg = config, !busy else { return }
        busy = true
        defer { busy = false }
        struct Body: Encodable { let config: TimeConfig }
        do {
            let r: TimesResp = try await AlmaAPI.shared.send("POST", "/api/agent/salah-times", body: Body(config: cfg))
            if let c = r.config { config = c }
            toast = "✓ নামাজের সময় সেভ হয়েছে"
        } catch {
            toast = "সেভ হয়নি — আবার চেষ্টা করুন"
        }
    }

    private func setAbroad(_ v: Bool) async {
        // One write at a time — the toggle is disabled while a POST is in
        // flight, so a rapid on-off can't land out of order (Codex P2).
        guard !abroadBusy else { return }
        abroadBusy = true
        defer { abroadBusy = false }
        let prev = abroadOff
        abroadOff = v
        struct Body: Encodable { let off: Bool }
        do {
            let r: AbroadResp = try await AlmaAPI.shared.send("POST", "/api/assistant/salah/abroad-calls", body: Body(off: v))
            abroadOff = r.off
            toast = v ? "বিদেশ মোড চালু — কল app-এ আসবে" : "দেশ মোড — কল নম্বরে আসবে"
        } catch {
            abroadOff = prev
            toast = "টগল সেভ হয়নি"
        }
    }

    private func applyPreset(label: String, offsetMin: Int, city: String,
                             country: String, method: Int, school: Int) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        struct Autofill: Encodable { let city: String; let country: String; let method: Int; let school: Int }
        struct Body: Encodable { let offsetMin: Int; let label: String; let autofill: Autofill }
        struct Resp: Decodable { let ok: Bool?; let config: TimeConfig? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/salah/location",
                body: Body(offsetMin: offsetMin, label: label,
                           autofill: Autofill(city: city, country: country, method: method, school: school)))
            if let c = r.config { config = c }
            locationLabel = label
            toast = "✓ \(label) — নামাজের সময় অটো বসেছে"
            onLocationApplied?()
        } catch {
            // The server may have SAVED the location but failed the AlAdhan
            // autofill (502 partial success) — reload the true server state and
            // say so honestly instead of claiming nothing was saved (Codex P1).
            // The worker marker may already be invalidated, so the parent's
            // delayed refreshes are needed on this path too (Codex P2).
            await load()
            onLocationApplied?()
            toast = "লোকেশন সেভ হতে পারে কিন্তু সময় অটো আনা যায়নি — প্রিসেটটা আবার চাপুন"
        }
    }
}
