//
//  ActivitySwiftUI.swift
//  ALMA ERP — the Activity tab (unified audit timeline) as a native SwiftUI screen.
//
//  Mirrors the web /activity page — same endpoint, same colours, same blocks:
//    GET /api/audit-timeline → { ok, data: { entries, sources } }   (owner/admin only)
//  Read-only feed: "who did what, when" across the ERP audit tables. Web-parity
//  blocks: source filter chips with counts (only sources that have entries) ·
//  Dhaka-day date dividers · rows with actor + action + resource + detail + Bangla
//  relative time. iOS re-set: SF Symbol icon squircles per event type (coral→violet
//  gradient), actor-initials avatars, client-side "আরো দেখুন" load-more (the server
//  returns the whole window at once — max 120 entries — so paging is local).
//  Carried lessons: lenient decoding, cancellation-safe .refreshable, auth card.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum ActivityPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web SOURCE_META tones: approval text-gold-lt · payment_method text-success ·
    /// everything else text-muted-hi.
    static func tone(_ source: String, _ scheme: ColorScheme) -> Color {
        switch source {
        case "approval": return accentText(scheme)
        case "payment_method": return emerald600
        default: return .secondary
        }
    }

    /// One tint per event source — drives the timeline's tinted icon chips (owner
    /// spec 2026-07-08: per-source colour instead of one uniform gradient).
    static func sourceTint(_ source: String) -> Color {
        switch source {
        case "approval": return goldDim
        case "payment_method": return emerald600
        case "archive": return AlmaSwiftTheme.violet
        case "trading_telegram": return Color(red: 0.231, green: 0.510, blue: 0.965) // #3B82F6
        case "telegram_ops": return AlmaSwiftTheme.sage
        case "volume_target": return amber600
        default: return coral
        }
    }
}

// MARK: - Source metadata (web SOURCE_META parity, emoji → SF Symbols)

struct ActivitySourceMeta {
    let label: String     // Bangla label, web-verbatim
    let symbol: String    // SF Symbol standing in for the web emoji

    /// Web chip order (Object.keys(SOURCE_META)).
    static let order: [String] = [
        "approval", "payment_method", "archive",
        "trading_telegram", "telegram_ops", "volume_target",
    ]

    static func meta(_ source: String) -> ActivitySourceMeta {
        switch source {
        case "approval":         return .init(label: "অনুমোদন", symbol: "checkmark.seal.fill")      // ✅
        case "payment_method":   return .init(label: "পেমেন্ট", symbol: "creditcard.fill")          // 💳
        case "archive":          return .init(label: "আর্কাইভ", symbol: "archivebox.fill")           // 📦
        case "trading_telegram": return .init(label: "ট্রেডিং TG", symbol: "paperplane.fill")        // ✉️
        case "telegram_ops":     return .init(label: "অপস", symbol: "antenna.radiowaves.left.and.right") // 📡
        case "volume_target":    return .init(label: "টার্গেট", symbol: "target")                    // 🎯
        default:                 return .init(label: source, symbol: "clock.arrow.circlepath")
        }
    }
}

// MARK: - Models (same field names the web page types declare)

struct ActivityEntry: Decodable, Identifiable, Equatable {
    let id: String
    let at: String?
    let source: String
    let action: String?
    let actor: String?
    let resource: String?
    let detail: String?
    let businessId: String?

    private enum Keys: String, CodingKey {
        case id, at, source, action, actor, resource, detail, businessId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        source = (try? c.decode(String.self, forKey: .source)) ?? "unknown"
        action = try? c.decodeIfPresent(String.self, forKey: .action)
        actor = try? c.decodeIfPresent(String.self, forKey: .actor)
        resource = try? c.decodeIfPresent(String.self, forKey: .resource)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
    }

    static func == (a: ActivityEntry, b: ActivityEntry) -> Bool { a.id == b.id }
}

/// The route wraps its payload via apiDataSuccess → `{ ok, data: {…} }` — decode
/// both shapes (nested preferred, flat fallback). Counts arrive per-source keyed by
/// name; flexInt keeps them safe if the JSON ever serialises them as doubles/strings.
struct ActivityTimelineResponse: Decodable {
    let entries: [ActivityEntry]
    let sources: [String: Int]

    private enum Keys: String, CodingKey { case ok, data, entries, sources }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        entries = (try? c.decode([ActivityEntry].self, forKey: .entries)) ?? []
        sources = Self.flexCounts(c, .sources)
    }

    private static func flexCounts(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> [String: Int] {
        if let ints = try? c.decodeIfPresent([String: Int].self, forKey: k) {
            return ints
        }
        if let doubles = try? c.decodeIfPresent([String: Double].self, forKey: k) {
            return doubles.mapValues { Int($0.rounded()) }
        }
        if let strings = try? c.decodeIfPresent([String: String].self, forKey: k) {
            return strings.compactMapValues { Int($0) }
        }
        return [:]
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class ActivityVM {
    var entries: [ActivityEntry] = []
    var sourceCounts: [String: Int] = [:]
    var filter = "all"                    // "all" | AuditSource
    var loading = false
    var error: String? = nil
    var authExpired = false
    /// Client-side paging window — the API returns the whole feed (≤120 rows) in one
    /// response, so "load more" just widens what's rendered.
    var visibleCount = ActivityVM.pageSize

    static let pageSize = 30

    var filtered: [ActivityEntry] {
        filter == "all" ? entries : entries.filter { $0.source == filter }
    }
    var visible: [ActivityEntry] { Array(filtered.prefix(visibleCount)) }
    var hasMore: Bool { filtered.count > visibleCount }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: ActivityTimelineResponse = try await AlmaAPI.shared.get("/api/audit-timeline")
            entries = resp.entries
            sourceCounts = resp.sources
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "লোড করা গেল না"
        }
    }

    func setFilter(_ f: String) {
        filter = f
        visibleCount = Self.pageSize
    }

    func loadMore() {
        visibleCount += Self.pageSize
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
struct ActivityScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = ActivityVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                subtitleRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                sourceChips
                if vm.loading && vm.entries.isEmpty { loadingRows }
                timeline
                if !vm.loading && vm.filtered.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                if vm.hasMore { loadMoreButton }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(ActivityAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Header line (web PageHeader subtitle + ↻ ghost button) ──

    private var subtitleRow: some View {
        HStack(spacing: 8) {
            Text("কে কখন কী করল — এক জায়গায়")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button {
                Task { await vm.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .activityGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            .disabled(vm.loading)
        }
        .padding(.top, 4)
    }

    // ── Source filter chips (web: সব + only sources with entries) ──

    private var sourceChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                activityChip("সব", count: vm.entries.count, active: vm.filter == "all") {
                    vm.setFilter("all")
                }
                ForEach(ActivitySourceMeta.order.filter { (vm.sourceCounts[$0] ?? 0) > 0 },
                        id: \.self) { s in
                    let meta = ActivitySourceMeta.meta(s)
                    activityChip(meta.label, symbol: meta.symbol,
                                 count: vm.sourceCounts[s] ?? 0,
                                 active: vm.filter == s) {
                        vm.setFilter(s)
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// The web's gold chip (border-gold-dim/60 · bg-gold/15 · text-gold-lt) on the
    /// app's glass surface — label + faded count, exactly like the web Chip.
    private func activityChip(_ label: String, symbol: String? = nil, count: Int,
                              active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            HStack(spacing: 5) {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                }
                Text(label).font(.footnote.weight(active ? .semibold : .regular))
                Text("\(count)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .opacity(0.6)
            }
            .foregroundStyle(active ? ActivityPalette.accentText(colorScheme) : .secondary)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? ActivityPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? ActivityPalette.coral.opacity(0.55)
                       : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Timeline: Dhaka-day dividers + event rows (web group-by-day parity) ──

    /// Consecutive-run grouping — the feed arrives sorted desc, so equal day keys
    /// are always adjacent (same trick the web page uses).
    private var groups: [(day: String, items: [ActivityEntry])] {
        var out: [(day: String, items: [ActivityEntry])] = []
        for e in vm.visible {
            let k = ActivityFormat.dayKey(e.at)
            if let lastIndex = out.indices.last, out[lastIndex].day == k {
                out[lastIndex].items.append(e)
            } else {
                out.append((day: k, items: [e]))
            }
        }
        return out
    }

    @ViewBuilder private var timeline: some View {
        ForEach(groups, id: \.day) { group in
            VStack(alignment: .leading, spacing: 0) {
                Text(group.day)
                    .font(.system(size: 10, weight: .black))
                    .kerning(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 8)
                ForEach(Array(group.items.enumerated()), id: \.element.id) { i, entry in
                    ActivityCard(entry: entry)
                    // Hairline connector between rows — a true timeline thread,
                    // aligned to the icon chip's centre (12pt card pad + 17pt half-chip).
                    if i < group.items.count - 1 {
                        Rectangle()
                            .fill(AlmaSwiftTheme.separator(colorScheme))
                            .frame(width: 1, height: 14)
                            .padding(.leading, 28.5)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }

    // ── Load more (client-side append over the already-fetched feed) ──

    private var loadMoreButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            withAnimation(.snappy) { vm.loadMore() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                Text("আরো দেখুন (\(vm.filtered.count - vm.visibleCount))")
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ActivityPalette.accentText(colorScheme))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(ActivityPalette.coral.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(ActivityPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
    }

    // ── States ──

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "clock.arrow.circlepath").font(.largeTitle).foregroundStyle(.secondary)
            Text("কিছু নেই").foregroundStyle(.secondary)
            Text("এই ফিল্টারে কোনো কার্যকলাপ পাওয়া যায়নি।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(ActivityPalette.red500)
            Button {
                Task { await vm.load() }
            } label: {
                Text("আবার চেষ্টা")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ActivityPalette.accentText(colorScheme))
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(ActivityPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(ActivityPalette.coral.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .activityGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .activityGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 76)
                .activityGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .activityShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/activity", "Activity")
        } label: {
            Label("পুরো টাইমলাইন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row card (mirrors one web timeline card, re-set for iOS:
// gradient icon squircle per event type + actor-initials avatar + relative time)

@available(iOS 17.0, *)
private struct ActivityCard: View {
    let entry: ActivityEntry
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            iconBadge
            VStack(alignment: .leading, spacing: 3) {
                actorLine
                Text(entry.resource ?? "—")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ActivityPalette.tone(entry.source, colorScheme))
                if let d = entry.detail, !d.isEmpty {
                    Text(d)
                        .font(.caption2)
                        .lineSpacing(2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                Text(ActivityFormat.timeAgo(entry.at))
                    .font(.caption2).foregroundStyle(.secondary)
                initialsAvatar
            }
        }
        .padding(12)
        .activityGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Web: bold actor + muted action in one line.
    private var actorLine: some View {
        (Text(entry.actor ?? "System").fontWeight(.bold)
            + Text(" ")
            + Text(entry.action ?? "—").foregroundColor(.secondary))
            .font(.footnote)
            .lineSpacing(1.5)
    }

    /// Squircle icon chip — TINTED per event source (owner spec 2026-07-08), one SF
    /// symbol per source (the native stand-in for the web's emoji tile).
    private var iconBadge: some View {
        let tint = ActivityPalette.sourceTint(entry.source)
        return Image(systemName: ActivitySourceMeta.meta(entry.source).symbol)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 34, height: 34)
            .background(tint.opacity(colorScheme == .dark ? 0.20 : 0.14),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }

    private var initialsAvatar: some View {
        Text(ActivityFormat.initials(entry.actor ?? "System"))
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ActivityPalette.accentText(colorScheme))
            .frame(width: 24, height: 24)
            .background(ActivityPalette.coral.opacity(0.16), in: Circle())
            .overlay(Circle().strokeBorder(ActivityPalette.coral.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Formatting helpers (web util parity)

private enum ActivityFormat {
    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Bangla relative time — the web relTime's exact strings.
    static func timeAgo(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "" }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    /// Dhaka calendar day → "2026-07-06" (web dayKey: toLocaleDateString en-CA).
    static func dayKey(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (Activity-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct ActivityAurora: View {
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
    func activityGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct ActivityShimmer: ViewModifier {
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
    func activityShimmer() -> some View { modifier(ActivityShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Activity — Light") {
    ActivityScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
