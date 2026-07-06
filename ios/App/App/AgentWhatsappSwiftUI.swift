//
//  AgentWhatsappSwiftUI.swift
//  ALMA ERP — the owner's WhatsApp inbox as a native SwiftUI screen (read-only).
//
//  Mirrors the web /agent/whatsapp page (WhatsAppInbox.tsx) — same endpoint, same
//  Bangla strings, re-set in the app's aurora/glass look with an iOS Messages feel:
//    GET /api/assistant/wa-inbox  → { ok, count, awaitingReply, threads:[
//        { id, number, name, lastMessage, lastAt, needsReply,
//          messages:[{ from: "them"|"us", text, at }] } ] }
//  Blocks: filter chips (সব / Reply বাকি) · Messages-style conversation rows
//  (initials avatar · 1-line preview · unread badge · 24h-window countdown pill,
//  amber when the WhatsApp business window is about to close) · read-only thread
//  sheet (customer bubbles left, business bubbles right with coral tint) · 5s poll
//  like the web · web escape hatch. SENDING stays on the web (agent-composed replies).
//  Carried lessons: per-screen private aurora/glass copies, lenient decoding,
//  cancellation-safe .refreshable, auth-expired card.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum AgentWaPalette {
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
}

// MARK: - Models (same field names /api/assistant/wa-inbox returns)

struct AgentWaMessage: Decodable, Equatable {
    /// "them" = customer/staff inbound · "us" = business/agent outbound.
    let from: String
    let text: String
    let at: String?

    private enum Keys: String, CodingKey { case from, text, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        from = (try? c.decode(String.self, forKey: .from)) ?? "them"
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }
}

struct AgentWaThread: Decodable, Identifiable, Equatable {
    let id: String
    let number: String
    let name: String
    let lastMessage: String
    let lastAt: String?
    let needsReply: Bool
    let messages: [AgentWaMessage]

    private enum Keys: String, CodingKey {
        case id, number, name, lastMessage, lastAt, needsReply, messages
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        number = (try? c.decode(String.self, forKey: .number)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        lastMessage = (try? c.decode(String.self, forKey: .lastMessage)) ?? ""
        lastAt = try? c.decodeIfPresent(String.self, forKey: .lastAt)
        needsReply = (try? c.decode(Bool.self, forKey: .needsReply)) ?? false
        messages = (try? c.decode([AgentWaMessage].self, forKey: .messages)) ?? []
    }

    /// The WhatsApp Business 24h service window opens from the LAST inbound
    /// (customer) message — the web stores it implicitly in the message list.
    var lastCustomerAt: Date? {
        messages.last { $0.from == "them" }.flatMap { AgentWaFormat.parse($0.at) }
    }

    static func == (a: AgentWaThread, b: AgentWaThread) -> Bool {
        a.id == b.id && a.lastAt == b.lastAt
            && a.needsReply == b.needsReply && a.messages.count == b.messages.count
    }
}

/// The route answers flat `{ ok, count, awaitingReply, threads }` — decode
/// leniently (and tolerate an apiDataSuccess-style `{ ok, data:{…} }` wrap too).
struct AgentWaInboxResponse: Decodable {
    let ok: Bool?
    let count: Int?
    let awaitingReply: Int?
    let error: String?
    let threads: [AgentWaThread]

    private enum Keys: String, CodingKey { case ok, data, count, awaitingReply, error, threads }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        ok = try? root.decodeIfPresent(Bool.self, forKey: .ok)
        count = Self.flexInt(c, .count)
        awaitingReply = Self.flexInt(c, .awaitingReply)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        threads = (try? c.decode([AgentWaThread].self, forKey: .threads)) ?? []
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class AgentWhatsappVM {
    var threads: [AgentWaThread] = []
    var filter = "all"                    // all | awaiting (web highlights needsReply)
    var loading = false
    var error: String? = nil
    var authExpired = false

    var awaiting: Int { threads.filter(\.needsReply).count }
    var visibleThreads: [AgentWaThread] {
        filter == "awaiting" ? threads.filter(\.needsReply) : threads
    }

    /// `silent` = the 5s poll (web parity) — no spinner churn, keep the list stable.
    func load(silent: Bool = false) async {
        if !silent { loading = true }
        defer { if !silent { loading = false } }
        do {
            let resp: AgentWaInboxResponse = try await AlmaAPI.shared.get("/api/assistant/wa-inbox")
            threads = resp.threads
            error = resp.error
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            if silent { return }                        // background poll fails quietly
            self.error = error.localizedDescription
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

// MARK: - Screen

@available(iOS 17.0, *)
struct AgentWhatsappScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AgentWhatsappVM()
    @State private var selected: AgentWaThread? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                headerRow
                if vm.authExpired { authCard }
                if let err = vm.error, !err.isEmpty { noticeCard(err) }
                if vm.loading && vm.threads.isEmpty { loadingRows }
                ForEach(vm.visibleThreads) { thread in
                    AgentWaThreadRow(thread: thread) { selected = thread }
                }
                if !vm.loading && vm.visibleThreads.isEmpty && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AgentWhatsappAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            // Web parity: poll every 5s so new messages appear live.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                await vm.load(silent: true)
            }
        }
        .sheet(item: $selected) { thread in
            AgentWaThreadSheet(thread: thread, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header: filter chips + web sub-header counts ──

    private var headerRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                agentWaChip("সব", active: vm.filter == "all") { vm.filter = "all" }
                agentWaChip("Reply বাকি", active: vm.filter == "awaiting") { vm.filter = "awaiting" }
                Spacer()
                if !vm.threads.isEmpty {
                    Text(vm.loading ? "লোড হচ্ছে…"
                         : "\(vm.threads.count) চ্যাট\(vm.awaiting > 0 ? " · \(vm.awaiting) reply বাকি" : "")")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 4)
    }

    private func agentWaChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? AgentWaPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? AgentWaPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? AgentWaPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Empty / error / auth / loading states ──

    /// Web empty state, exact strings.
    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("💬").font(.largeTitle)
            Text(vm.filter == "awaiting" ? "কোনো reply বাকি নেই" : "এখনো কোনো মেসেজ আসেনি")
                .font(.subheadline.weight(.semibold))
            if vm.filter != "awaiting" {
                Text("কেউ আপনার business WhatsApp নম্বরে মেসেজ দিলে সেটা এখানে লাইভ দেখা যাবে — ঠিক WhatsApp-এর মতো।\(vm.error == nil ? " (Twilio inbound webhook সেট থাকলে তবেই মেসেজ এখানে আসবে।)" : "")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
            }
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(AgentWaPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).agentWhatsappGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .agentWhatsappGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 74)
                .agentWhatsappGlass(colorScheme, corner: 16)
                .agentWhatsappShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/whatsapp", "WhatsApp inbox")
        } label: {
            Label("রিপ্লাই দিতে ও সম্পূর্ণ ভিউ — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Conversation row (iOS Messages feel: avatar · preview · badge · window pill)

@available(iOS 17.0, *)
private struct AgentWaThreadRow: View {
    let thread: AgentWaThread
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .center, spacing: 11) {
            avatar
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(thread.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(AgentWaFormat.time(thread.lastAt))
                        .font(.caption2)
                        .foregroundStyle(thread.needsReply ? AgentWaPalette.emerald600 : .secondary)
                }
                HStack(alignment: .center, spacing: 6) {
                    Text(thread.lastMessage.isEmpty ? "কোনো মেসেজ নেই" : thread.lastMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if thread.needsReply { unreadBadge }
                }
                if let window = AgentWaFormat.window(thread.lastCustomerAt) {
                    windowPill(window)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .agentWhatsappGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    private var avatar: some View {
        Text(AgentWaFormat.initials(thread.name))
            .font(.subheadline.weight(.bold))
            .foregroundStyle(AgentWaPalette.accentText(colorScheme))
            .frame(width: 46, height: 46)
            .background(AgentWaPalette.coral.opacity(0.16), in: Circle())
            .overlay(Circle().strokeBorder(AgentWaPalette.coral.opacity(0.35), lineWidth: 1))
    }

    /// Web's green "!" badge (needsReply) — the unread/awaiting marker.
    private var unreadBadge: some View {
        Text("!")
            .font(.caption2.weight(.heavy))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(AgentWaPalette.emerald600, in: Circle())
    }

    /// WhatsApp 24h business window countdown — amber when it's about to close.
    private func windowPill(_ window: AgentWaFormat.Window) -> some View {
        let (tint, icon): (Color, String) = switch window.tone {
        case .open: (AgentWaPalette.emerald600, "clock")
        case .closing: (AgentWaPalette.amber600, "clock.badge.exclamationmark")
        case .closed: (Color.secondary, "clock.badge.xmark")
        }
        return Label(window.label, systemImage: icon)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
            .padding(.top, 2)
    }
}

// MARK: - Thread sheet (read-only chat: customer left · business right, coral tint)

@available(iOS 17.0, *)
private struct AgentWaThreadSheet: View {
    let thread: AgentWaThread
    let vm: AgentWhatsappVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Live copy — the 5s poll keeps vm.threads fresh while the sheet is open.
    private var live: AgentWaThread {
        vm.threads.first { $0.id == thread.id } ?? thread
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if live.messages.isEmpty {
                            Text("কোনো মেসেজ নেই")
                                .font(.caption).foregroundStyle(.secondary)
                                .padding(.top, 40)
                        }
                        ForEach(Array(live.messages.enumerated()), id: \.offset) { i, message in
                            AgentWaBubble(message: message)
                                .id(i)
                        }
                        Color.clear.frame(height: 4).id("wa-end")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .onAppear { proxy.scrollTo("wa-end", anchor: .bottom) }
                .onChange(of: live.messages.count) {
                    withAnimation(.snappy) { proxy.scrollTo("wa-end", anchor: .bottom) }
                }
            }
            footer
        }
        .presentationBackground { AgentWhatsappAurora() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(AgentWaFormat.initials(live.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(AgentWaPalette.accentText(colorScheme))
                .frame(width: 42, height: 42)
                .background(AgentWaPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(AgentWaPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(live.name).font(.subheadline.weight(.bold)).lineLimit(1)
                Text(live.number).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if let window = AgentWaFormat.window(live.lastCustomerAt) {
                Text(window.label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(window.tone == .closing ? AgentWaPalette.amber600
                                     : window.tone == .open ? AgentWaPalette.emerald600 : .secondary)
            }
        }
        .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 10)
    }

    /// Web's read-only strip, exact string — replies go through the agent (web UI).
    private var footer: some View {
        VStack(spacing: 8) {
            Text("শুধু দেখার জন্য · রিপ্লাই দিতে এজেন্টকে বলুন")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Button {
                dismiss()
                openWeb("/agent/whatsapp", "WhatsApp inbox")
            } label: {
                Label("ওয়েবে খুলুন", systemImage: "safari")
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .foregroundStyle(AgentWaPalette.accentText(colorScheme))
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }
}

/// One chat bubble — customer ("them") left on glass, business ("us") right with
/// the app's coral tint (the native re-take of the web's green outgoing bubble).
@available(iOS 17.0, *)
private struct AgentWaBubble: View {
    let message: AgentWaMessage
    @Environment(\.colorScheme) private var colorScheme

    private var isUs: Bool { message.from == "us" }

    var body: some View {
        HStack {
            if isUs { Spacer(minLength: 44) }
            VStack(alignment: .trailing, spacing: 2) {
                Text(message.text)
                    .font(.footnote)
                    .foregroundStyle(.primary.opacity(0.9))
                    .frame(alignment: .leading)
                Text(AgentWaFormat.time(message.at))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(
                isUs ? AnyShapeStyle(AgentWaPalette.coral.opacity(colorScheme == .dark ? 0.30 : 0.18))
                     : AnyShapeStyle(.ultraThinMaterial),
                in: UnevenRoundedRectangle(
                    topLeadingRadius: isUs ? 12 : 3,
                    bottomLeadingRadius: 12,
                    bottomTrailingRadius: 12,
                    topTrailingRadius: isUs ? 3 : 12,
                    style: .continuous))
            .overlay(
                UnevenRoundedRectangle(
                    topLeadingRadius: isUs ? 12 : 3,
                    bottomLeadingRadius: 12,
                    bottomTrailingRadius: 12,
                    topTrailingRadius: isUs ? 3 : 12,
                    style: .continuous)
                .strokeBorder(isUs ? AgentWaPalette.coral.opacity(0.30)
                                   : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.45),
                              lineWidth: 1))
            if !isUs { Spacer(minLength: 44) }
        }
        .frame(maxWidth: .infinity, alignment: isUs ? .trailing : .leading)
    }
}

// MARK: - Formatting helpers (web util parity + 24h-window math)

private enum AgentWaFormat {
    /// ISO string → Date (server serializes Prisma Dates to ISO via Response.json).
    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Web fmtTime: "08:50 pm"-style hh:mm in Asia/Dhaka.
    static func time(_ iso: String?) -> String {
        guard let date = parse(iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Web initials(): first letter, 👤 for bare numbers, # when empty.
    static func initials(_ name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return "#" }
        let first = n.first!
        if first == "+" || first.isNumber { return "👤" }
        return String(first).uppercased()
    }

    // ── 24h WhatsApp Business window ──

    struct Window {
        enum Tone { case open, closing, closed }
        let label: String
        let tone: Tone
    }

    /// Countdown from the last customer message: the business can free-form reply
    /// for 24h. Amber under 4h ("closing"), muted once it has closed.
    static func window(_ lastCustomerAt: Date?, now: Date = Date()) -> Window? {
        guard let lastCustomerAt else { return nil }
        let deadline = lastCustomerAt.addingTimeInterval(24 * 3600)
        let remaining = deadline.timeIntervalSince(now)
        if remaining <= 0 {
            return Window(label: "২৪ঘ উইন্ডো বন্ধ", tone: .closed)
        }
        let hours = Int(remaining) / 3600
        let minutes = (Int(remaining) % 3600) / 60
        if remaining < 4 * 3600 {
            let label = hours > 0 ? "উইন্ডো বন্ধ হবে \(hours)ঘ \(minutes)মি পরে"
                                  : "উইন্ডো বন্ধ হবে \(minutes)মি পরে"
            return Window(label: label, tone: .closing)
        }
        return Window(label: "উইন্ডো খোলা · \(hours)ঘ বাকি", tone: .open)
    }
}

// MARK: - Aurora background + glass (AgentWhatsapp-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AgentWhatsappAurora: View {
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
    func agentWhatsappGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AgentWhatsappShimmer: ViewModifier {
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
    func agentWhatsappShimmer() -> some View { modifier(AgentWhatsappShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("WhatsApp inbox — Light") {
    AgentWhatsappScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
