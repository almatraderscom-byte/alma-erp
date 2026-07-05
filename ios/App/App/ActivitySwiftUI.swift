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
                    .activityGlass(colorScheme, corner: 12)
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
            VStack(alignment: .leading, spacing: 8) {
                Text(group.day)
                    .font(.system(size: 10, weight: .black))
                    .kerning(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                ForEach(group.items) { entry in
                    ActivityCard(entry: entry)
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
        .activityGlass(colorScheme, corner: 16)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .activityGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 76)
                .activityGlass(colorScheme, corner: 16)
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
        .activityGlass(colorScheme, corner: 16)
    }

    /// Web: bold actor + muted action in one line.
    private var actorLine: some View {
        (Text(entry.actor ?? "System").fontWeight(.bold)
            + Text(" ")
            + Text(entry.action ?? "—").foregroundColor(.secondary))
            .font(.footnote)
            .lineSpacing(1.5)
    }

    /// Squircle icon badge — coral→violet gradient, one SF symbol per event source
    /// (the native stand-in for the web's emoji tile).
    private var iconBadge: some View {
        Image(systemName: ActivitySourceMeta.meta(entry.source).symbol)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(colors: [ActivityPalette.coral, AlmaSwiftTheme.violet],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: ActivityPalette.coral.opacity(0.35), radius: 5, y: 2)
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
    func activityGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
