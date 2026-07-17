//
//  SettingsNotificationsSwiftUI.swift
//  ALMA ERP — Settings ▸ Notifications as a native SwiftUI screen.
//
//  Mirrors the web /settings/notifications page 1:1 — same endpoints, same blocks:
//    GET  /api/notifications/stats      → totals (recipients/delivered/open/ack) + broadcasts
//    GET  /api/users                    → user options for the USER broadcast target
//    POST /api/notifications/broadcast  → admin broadcast (title/message/priority/target…)
//  Web-parity blocks: 4 KPI cards (Recipients/Delivered/Open rate/Ack rate) · the
//  App Lock (Face ID) row — that toggle is a Capacitor/webview-local preference, so
//  natively it is an info row that opens the web settings page · the Admin broadcast
//  composer (title, message, priority, target ALL/ROLE/BUSINESS/USER with the web's
//  role/business option lists, action URL, native "Pin this notification" Toggle) ·
//  the Delivery dashboard (broadcast rows re-set as cards for phone).
//  NOTE: the web page today has NO channel-preference (push/telegram/ntfy) toggles —
//  there is no per-toggle preference endpoint, so nothing is invented here; the only
//  native Toggle is the form's "Pin this notification".
//  Carried lessons: ONE spinner per action, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsNotifPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web: CRITICAL text-red-500 · HIGH text-amber-600 · else muted.
    static func priority(_ p: String?) -> Color {
        switch p {
        case "CRITICAL": return red500
        case "HIGH": return amber600
        default: return .secondary
        }
    }
    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page types declare)

struct SettingsNotifTotals: Decodable, Equatable {
    let recipients: Int
    let delivered: Int
    let seen: Int
    let read: Int
    let acknowledged: Int
    let openRate: Int
    let ackRate: Int

    private enum Keys: String, CodingKey {
        case recipients, delivered, seen, read, acknowledged, openRate, ackRate
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        recipients = Self.flexInt(c, .recipients) ?? 0
        delivered = Self.flexInt(c, .delivered) ?? 0
        seen = Self.flexInt(c, .seen) ?? 0
        read = Self.flexInt(c, .read) ?? 0
        acknowledged = Self.flexInt(c, .acknowledged) ?? 0
        openRate = Self.flexInt(c, .openRate) ?? 0
        ackRate = Self.flexInt(c, .ackRate) ?? 0
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct SettingsNotifBroadcast: Decodable, Identifiable, Equatable {
    let id: String
    let title: String?
    let target: String?
    let priority: String?
    let recipients: Int
    let delivered: Int
    let seen: Int
    let acknowledged: Int
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, title, target, priority, recipients, delivered, seen, acknowledged, createdAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        target = try? c.decodeIfPresent(String.self, forKey: .target)
        priority = try? c.decodeIfPresent(String.self, forKey: .priority)
        recipients = Self.flexInt(c, .recipients) ?? 0
        delivered = Self.flexInt(c, .delivered) ?? 0
        seen = Self.flexInt(c, .seen) ?? 0
        acknowledged = Self.flexInt(c, .acknowledged) ?? 0
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

/// /api/notifications/stats answers flat `{ totals, broadcasts }` — decode a nested
/// `{ ok, data: {…} }` wrapper too, in case the route ever adopts apiDataSuccess.
struct SettingsNotifStatsResponse: Decodable {
    let totals: SettingsNotifTotals?
    let broadcasts: [SettingsNotifBroadcast]

    private enum Keys: String, CodingKey { case ok, data, totals, broadcasts }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        totals = try? c.decodeIfPresent(SettingsNotifTotals.self, forKey: .totals)
        broadcasts = (try? c.decode([SettingsNotifBroadcast].self, forKey: .broadcasts)) ?? []
    }
}

struct SettingsNotifUser: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let email: String?

    private enum Keys: String, CodingKey { case id, name, email }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
    }

    var label: String { "\(name ?? "—") · \(email ?? "—")" }
}

struct SettingsNotifUsersResponse: Decodable {
    let users: [SettingsNotifUser]
    private enum Keys: String, CodingKey { case ok, data, users }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        users = (try? c.decode([SettingsNotifUser].self, forKey: .users)) ?? []
    }
}

struct SettingsNotifBroadcastResponse: Decodable {
    let ok: Bool?
    let recipients: Int?
    let error: String?

    private enum Keys: String, CodingKey { case ok, data, recipients, error }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        ok = try? root.decodeIfPresent(Bool.self, forKey: .ok)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        if let i = try? c.decodeIfPresent(Int.self, forKey: .recipients) { recipients = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .recipients) { recipients = Int(d.rounded()) }
        else { recipients = nil }
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

// MARK: - Static option lists (web src/lib/roles.ts + src/lib/businesses.ts parity)

struct SettingsNotifOption: Identifiable, Equatable {
    let id: String
    let label: String
}

enum SettingsNotifOptions {
    /// Web ALMA_ROLE_OPTIONS (labels verbatim).
    static let roles: [SettingsNotifOption] = [
        .init(id: "SUPER_ADMIN", label: "Super Admin"),
        .init(id: "ADMIN", label: "Admin"),
        .init(id: "HR", label: "HR"),
        .init(id: "STAFF", label: "Staff"),
        .init(id: "VIEWER", label: "Viewer"),
    ]
    /// Web BUSINESS_LIST (names verbatim).
    static let businesses: [SettingsNotifOption] = [
        .init(id: "ALMA_LIFESTYLE", label: "Alma Lifestyle"),
        .init(id: "CREATIVE_DIGITAL_IT", label: "Creative Digital IT"),
        .init(id: "ALMA_TRADING", label: "Alma Trading"),
    ]
    static let priorities = ["LOW", "NORMAL", "HIGH", "CRITICAL"]
    static let targets = ["ALL", "ROLE", "BUSINESS", "USER"]
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
@MainActor
final class SettingsNotifVM {
    // Stats + dashboard
    var totals: SettingsNotifTotals? = nil
    var broadcasts: [SettingsNotifBroadcast] = []
    var users: [SettingsNotifUser] = []
    var loading = false
    var error: String? = nil
    var notice: String? = nil             // success line (the web's toast)
    var authExpired = false

    // Broadcast composer form (web `form` state, same defaults)
    var title = ""
    var message = ""
    var priority = "NORMAL"
    var target = "ALL"
    var targetRole = "STAFF"
    var targetBusinessId = "ALMA_LIFESTYLE"
    var targetUserId = ""
    var actionUrl = ""
    var pinned = false
    var sending = false

    /// Web `disabled=` condition on the Send button, verbatim.
    var canSend: Bool {
        !sending
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !(target == "USER" && targetUserId.isEmpty)
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Web load(): stats + users fetched in parallel.
            async let statsTask: SettingsNotifStatsResponse =
                AlmaAPI.shared.get("/api/notifications/stats")
            async let usersTask: SettingsNotifUsersResponse =
                AlmaAPI.shared.get("/api/users")
            let stats = try await statsTask
            totals = stats.totals
            broadcasts = stats.broadcasts
            // Users are only needed for the USER target picker — load leniently.
            if let u = try? await usersTask { users = u.users }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
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

    /// POST /api/notifications/broadcast — same JSON body the web `send()` posts.
    func send() async {
        guard canSend else { return }
        sending = true
        notice = nil
        error = nil
        defer { sending = false }
        do {
            var body: [String: AnyEncodable] = [
                "title": AnyEncodable(title),
                "message": AnyEncodable(message),
                "priority": AnyEncodable(priority),
                "target": AnyEncodable(target),
                "targetRole": AnyEncodable(targetRole),
                "targetBusinessId": AnyEncodable(targetBusinessId),
                "actionUrl": AnyEncodable(actionUrl),
                "pinned": AnyEncodable(pinned),
            ]
            if !targetUserId.isEmpty { body["targetUserId"] = AnyEncodable(targetUserId) }
            let resp: SettingsNotifBroadcastResponse = try await AlmaAPI.shared.send(
                "POST", "/api/notifications/broadcast", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // Web toast, verbatim: `Broadcast sent to ${json.recipients} recipient(s)`.
            notice = "Broadcast sent to \(resp.recipients ?? 0) recipient(s)"
            title = ""
            message = ""
            await load()   // refresh KPIs + dashboard, keep numbers honest
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch AlmaAPIError.http(_, let bodyText) {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            // Web error toast fallback, verbatim.
            let serverError = (try? JSONDecoder().decode(
                SettingsNotifBroadcastResponse.self, from: Data(bodyText.utf8)))?.error
            self.error = serverError ?? "Could not send broadcast"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = "Could not send broadcast"
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsNotifScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsNotifVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                if vm.loading && vm.totals == nil { loadingRows } else { kpiStrip }
                appLockRow
                composerCard
                dashboardCard
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsNotifAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Header (web PageHeader parity) ──

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications").font(.headline)
                Text("Broadcasts, push delivery, acknowledgments, and open-rate monitoring.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await vm.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 34)
                    .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            .disabled(vm.loading)
        }
        .padding(.top, 4)
    }

    // ── KPI strip (web's 4 KpiCards, labels verbatim) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("Recipients", vm.totals.map { "\($0.recipients)" } ?? "—")
                kpiCard("Delivered", vm.totals.map { "\($0.delivered)" } ?? "—")
                kpiCard("Open rate", vm.totals.map { "\($0.openRate)%" } ?? "—")
                kpiCard("Ack rate", vm.totals.map { "\($0.ackRate)%" } ?? "—")
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    /// Light bento pass (owner spec 2026-07-08): tile skin with a soft coral wash —
    /// same values, presentation only.
    private func kpiCard(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary)
            Text(value).font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(SettingsNotifPalette.accentText(colorScheme))
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background {
            LinearGradient(colors: [SettingsNotifPalette.coral.opacity(colorScheme == .dark ? 0.14 : 0.10), .clear],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
        .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── App Lock (Face ID) — web BiometricLockToggle parity ──
    // The web toggle is a Capacitor/webview-local preference (localStorage), invisible
    // to native code — so natively it is an info row that opens the web settings page.

    private var appLockRow: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            openWeb("/settings/notifications", "Notifications")
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "faceid")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(SettingsNotifPalette.accentText(colorScheme))
                    .frame(width: 34, height: 34)
                    .background(SettingsNotifPalette.coral.opacity(0.14),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("অ্যাপ লক (Face ID)").font(.footnote.weight(.semibold))
                    Text("অ্যাপ খুললে বা কিছুক্ষণ পর ফিরে এলে Face ID / Touch ID দিয়ে আনলক করতে হবে।")
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("এই সুইচটি ওয়েব সেটিংসে আছে — খুলতে ট্যাপ করুন")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(SettingsNotifPalette.accentText(colorScheme))
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
        .buttonStyle(.plain)
    }

    // ── Admin broadcast composer (web card parity) ──

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Admin broadcast").font(.footnote.weight(.semibold))
                Text("Send persistent in-app notifications and OneSignal push alerts when configured.")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            TextField("Notification title", text: $vm.title)
                .font(.footnote)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

            TextField("Message", text: $vm.message, axis: .vertical)
                .font(.footnote)
                .lineLimit(4...6)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

            // Priority + target — the web's two Selects as native Menus.
            HStack(spacing: 8) {
                pickerMenu(value: vm.priority,
                           options: SettingsNotifOptions.priorities.map { .init(id: $0, label: $0) },
                           tint: SettingsNotifPalette.priority(vm.priority)) { vm.priority = $0 }
                pickerMenu(value: vm.target,
                           options: SettingsNotifOptions.targets.map { .init(id: $0, label: $0) },
                           tint: .secondary) { vm.target = $0 }
            }

            // Conditional target pickers (web parity: ROLE / BUSINESS / USER).
            if vm.target == "ROLE" {
                pickerMenu(value: roleLabel,
                           options: SettingsNotifOptions.roles,
                           tint: .secondary) { vm.targetRole = $0 }
            }
            if vm.target == "BUSINESS" {
                pickerMenu(value: businessLabel,
                           options: SettingsNotifOptions.businesses,
                           tint: .secondary) { vm.targetBusinessId = $0 }
            }
            if vm.target == "USER" {
                if vm.users.isEmpty {
                    Text("ইউজার তালিকা লোড হয়নি — নিচে টেনে রিফ্রেশ করুন")
                        .font(.caption2).foregroundStyle(SettingsNotifPalette.amber600)
                } else {
                    pickerMenu(value: userLabel,
                               options: vm.users.map { .init(id: $0.id, label: $0.label) },
                               tint: .secondary) { vm.targetUserId = $0 }
                }
            }

            TextField("Action URL, e.g. /payroll", text: $vm.actionUrl)
                .font(.footnote)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 12).padding(.vertical, 10)
                .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

            Toggle(isOn: $vm.pinned) {
                Text("Pin this notification").font(.caption).foregroundStyle(.secondary)
            }
            .tint(SettingsNotifPalette.coral)

            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                Task { await vm.send() }
            } label: {
                HStack(spacing: 8) {
                    if vm.sending { ProgressView().controlSize(.small) }
                    Text(vm.sending ? "Sending…" : "Send broadcast")
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(SettingsNotifPalette.accentText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(SettingsNotifPalette.coral.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(SettingsNotifPalette.coral.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(!vm.canSend)
            .opacity(vm.canSend ? 1 : 0.5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var roleLabel: String {
        SettingsNotifOptions.roles.first { $0.id == vm.targetRole }?.label ?? vm.targetRole
    }
    private var businessLabel: String {
        SettingsNotifOptions.businesses.first { $0.id == vm.targetBusinessId }?.label ?? vm.targetBusinessId
    }
    private var userLabel: String {
        vm.users.first { $0.id == vm.targetUserId }?.label ?? "Choose user"
    }

    /// One web <Select> as a native capsule Menu.
    private func pickerMenu(value: String, options: [SettingsNotifOption], tint: Color,
                            onPick: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(options) { opt in
                Button(opt.label) {
                    UISelectionFeedbackGenerator().selectionChanged()
                    onPick(opt.id)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(value)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint == .secondary ? Color.primary.opacity(0.8) : tint)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
        .buttonStyle(.plain)
    }

    // ── Delivery dashboard (web table re-set as cards for phone) ──

    private var dashboardCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Delivery dashboard").font(.footnote.weight(.semibold))
            if vm.loading && vm.broadcasts.isEmpty {
                Color.clear.frame(height: 90)
                    .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    .settingsNotifShimmer()
            } else if vm.broadcasts.isEmpty {
                Text("No broadcasts sent yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.broadcasts) { b in
                    SettingsNotifBroadcastRow(broadcast: b)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SettingsNotifPalette.red500)
        case .success: ("checkmark.circle", SettingsNotifPalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 76)
                .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsNotifShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/settings/notifications", "Notifications")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Broadcast row (one web table row as a card)

@available(iOS 17.0, *)
private struct SettingsNotifBroadcastRow: View {
    let broadcast: SettingsNotifBroadcast
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(broadcast.title ?? "—")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 6)
                if let p = broadcast.priority {
                    Text(p).font(.caption2.weight(.heavy))
                        .foregroundStyle(SettingsNotifPalette.priority(p))
                }
            }
            Text(metaLine).font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                stat("Delivered", "\(broadcast.delivered)/\(broadcast.recipients)")
                stat("Seen", "\(broadcast.seen)")
                stat("Ack", "\(broadcast.acknowledged)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .settingsNotifGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var metaLine: String {
        var bits: [String] = []
        if let t = broadcast.target { bits.append(t) }
        if let d = SettingsNotifFormat.dateTime(broadcast.createdAt) { bits.append(d) }
        return bits.joined(separator: " · ")
    }

    private func stat(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(SettingsNotifPalette.accentText(colorScheme))
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum SettingsNotifFormat {
    /// createdAt → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
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

// MARK: - Aurora background + glass (SettingsNotif-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsNotifAurora: View {
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
    func settingsNotifGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsNotifShimmer: ViewModifier {
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
    func settingsNotifShimmer() -> some View { modifier(SettingsNotifShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Settings ▸ Notifications — Light") {
    SettingsNotifScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
