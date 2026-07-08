//
//  PortalExpenseSwiftUI.swift
//  ALMA ERP — the staff /portal/expense page ("নিজ খরচ ফেরত") as a native SwiftUI screen.
//
//  Mirrors the web page 1:1 — same endpoints, same colours, same blocks:
//    GET  /api/finance/reimbursement?business_id=…   → own claims + pendingTotal
//    POST /api/finance/reimbursement                 {business_id, amount, category, vendor?, note?}
//  Web-parity blocks: 2 summary cards (অপেক্ষমাণ amber / অনুমোদিত emerald + wallet link) ·
//  native submit sheet (amount / category chips / vendor / note, confirm step) ·
//  "আমার আবেদনসমূহ" history with Bangla status pills (PENDING amber · APPROVED emerald ·
//  REJECTED red) · add-only footnote · web escape hatch.
//  Receipt/photo attachment stays on the web page — the escape hatch links it.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum PortalExpensePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web StatusPill: PENDING amber · APPROVED emerald · REJECTED red.
    static func status(_ s: String) -> Color {
        switch s {
        case "PENDING": return amber500
        case "APPROVED": return emerald600
        default: return red500
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page's ClaimRow declares)

struct PortalExpenseClaim: Decodable, Identifiable, Equatable {
    let id: String
    let amount: Int
    let category: String
    let note: String?
    let status: String
    let createdAt: String?
    let resolvedAt: String?

    private enum Keys: String, CodingKey {
        case id, amount, category, note, status, createdAt, resolvedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        amount = Self.flexInt(c, .amount) ?? 0
        category = (try? c.decode(String.self, forKey: .category)) ?? "Reimbursement"
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        status = (try? c.decode(String.self, forKey: .status)) ?? "PENDING"
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        resolvedAt = try? c.decodeIfPresent(String.self, forKey: .resolvedAt)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    /// Web StatusPill labels, verbatim.
    var statusLabel: String {
        switch status {
        case "PENDING": return "অপেক্ষমাণ"
        case "APPROVED": return "অনুমোদিত"
        case "REJECTED": return "প্রত্যাখ্যাত"
        default: return status
        }
    }
}

/// The route answers flat `{ ok, businessId, claims, pendingTotal }` — decode both the
/// flat shape and a `{ ok, data: {…} }` wrapper defensively (pattern shared app-wide).
struct PortalExpenseListResponse: Decodable {
    let claims: [PortalExpenseClaim]
    let pendingTotal: Int?

    private enum Keys: String, CodingKey { case ok, data, claims, pendingTotal }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        claims = (try? c.decode([PortalExpenseClaim].self, forKey: .claims)) ?? []
        if let i = try? c.decodeIfPresent(Int.self, forKey: .pendingTotal) { pendingTotal = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .pendingTotal) { pendingTotal = Int(d.rounded()) }
        else { pendingTotal = nil }
    }
}

struct PortalExpenseSubmitResponse: Decodable {
    let ok: Bool?
    let message: String?
    let approvalId: String?

    private enum Keys: String, CodingKey { case ok, data, message, approvalId }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        ok = try? root.decodeIfPresent(Bool.self, forKey: .ok)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        approvalId = try? c.decodeIfPresent(String.self, forKey: .approvalId)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PortalExpenseVM {
    /// Same default the API route falls back to (LIFESTYLE_BUSINESS_ID).
    static let defaultBusinessId = "ALMA_LIFESTYLE"

    var claims: [PortalExpenseClaim] = []
    var pendingTotal = 0
    var loading = false
    var submitting = false
    var error: String? = nil
    var notice: String? = nil       // success line (the web's toast)
    var authExpired = false

    /// Web: approvedTotal = sum of APPROVED claim amounts (already in the wallet).
    var approvedTotal: Int {
        claims.filter { $0.status == "APPROVED" }.reduce(0) { $0 + $1.amount }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: PortalExpenseListResponse = try await AlmaAPI.shared.get(
                "/api/finance/reimbursement",
                query: ["business_id": Self.defaultBusinessId])
            claims = resp.claims
            pendingTotal = resp.pendingTotal ?? 0
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "আপনার আবেদনগুলো লোড করা যায়নি।"
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// POST one claim — same body the web submit() sends. Returns true on success so
    /// the sheet knows when to dismiss.
    func submit(amount: Int, category: String, vendor: String, note: String) async -> Bool {
        guard !submitting else { return false }
        submitting = true
        notice = nil
        defer { submitting = false }
        do {
            var body: [String: AnyEncodable] = [
                "business_id": AnyEncodable(Self.defaultBusinessId),
                "amount": AnyEncodable(amount),
                "category": AnyEncodable(category),
            ]
            let v = vendor.trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty { body["vendor"] = AnyEncodable(v) }
            let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
            if !n.isEmpty { body["note"] = AnyEncodable(n) }

            let resp: PortalExpenseSubmitResponse = try await AlmaAPI.shared.send(
                "POST", "/api/finance/reimbursement", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = resp.message ?? "ফেরতের আবেদন পাঠানো হয়েছে।"
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch AlmaAPIError.http(_, let bodyText) {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.serverMessage(bodyText) ?? "আবেদন পাঠানো যায়নি।"
            return false
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = "আবেদন পাঠানো যায়নি।"
            return false
        }
    }

    /// Pull the Bangla `error.message` out of an apiFailure body (or the legacy flat
    /// `message`) so server guidance like the no-employee-link hint reaches the staffer.
    static func serverMessage(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if let err = obj["error"] as? [String: Any], let m = err["message"] as? String, !m.isEmpty {
            return m
        }
        if let m = obj["message"] as? String, !m.isEmpty { return m }
        return nil
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PortalExpenseScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PortalExpenseVM()
    @State private var showingSubmit = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                summaryCards
                newClaimButton
                historyCard
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PortalExpenseAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(isPresented: $showingSubmit) {
            PortalExpenseSubmitSheet(vm: vm)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header (web FinancePageChrome title/subtitle) ──

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("নিজ খরচ ফেরত").font(.title3.weight(.bold))
            Text("নিজের পকেট থেকে অফিসের খরচ করেছেন? এখানে ফেরতের আবেদন করুন")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // ── Summary cards (web: অপেক্ষমাণ / অনুমোদিত + wallet link) ──

    private var summaryCards: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("অপেক্ষমাণ")
                    .font(.caption2.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Text(PortalExpenseFormat.money(vm.pendingTotal))
                    .font(.headline.weight(.bold).monospacedDigit())
                    .foregroundStyle(PortalExpensePalette.amber500)
                Text("মালিকের অনুমোদনের অপেক্ষায়")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

            VStack(alignment: .leading, spacing: 3) {
                Text("অনুমোদিত (ওয়ালেটে যুক্ত)")
                    .font(.caption2.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
                Text(PortalExpenseFormat.money(vm.approvedTotal))
                    .font(.headline.weight(.bold).monospacedDigit())
                    .foregroundStyle(PortalExpensePalette.emerald600)
                Button {
                    openWeb("/portal", "My Desk")
                } label: {
                    Text("আমার ওয়ালেট দেখুন →")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(PortalExpensePalette.accentText(colorScheme))
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── New claim entry point (opens the native submit sheet) ──

    private var newClaimButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showingSubmit = true
        } label: {
            Label("নতুন আবেদন", systemImage: "plus.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PortalExpensePalette.accentText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(PortalExpensePalette.coral.opacity(colorScheme == .dark ? 0.22 : 0.12),
                            in: Capsule())
                .overlay(Capsule()
                    .strokeBorder(PortalExpensePalette.coral.opacity(0.45), lineWidth: 1))
        }
        .buttonStyle(AlmaCapsuleButtonStyle())
    }

    // ── History ("আমার আবেদনসমূহ") ──

    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আমার আবেদনসমূহ").font(.subheadline.weight(.bold))
            if vm.loading && vm.claims.isEmpty {
                loadingRows
            } else if vm.claims.isEmpty && !vm.authExpired {
                VStack(spacing: 6) {
                    Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
                    Text("কোনো আবেদন নেই").font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("আপনি এখনো কোনো ফেরতের আবেদন করেননি।")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 26)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(vm.claims.enumerated()), id: \.element.id) { index, claim in
                        PortalExpenseClaimRow(claim: claim)
                        if index < vm.claims.count - 1 { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
                    }
                }
            }
            Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
            Text("শুধু যোগ করা যায় — পাঠানো আবেদন সম্পাদনা বা মুছে ফেলা যায় না (নিরাপত্তার জন্য)।")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        VStack(spacing: 8) {
            ForEach(0..<3, id: \.self) { _ in
                Color.clear.frame(height: 56)
                    .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    .portalExpenseShimmer()
            }
        }
    }

    // ── Shared bits ──

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", PortalExpensePalette.red500)
        case .success: ("checkmark.circle", PortalExpensePalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var webEscape: some View {
        Button {
            openWeb("/portal/expense", "Portal expense")
        } label: {
            Label("সব অপশন (রসিদ/ছবি সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - History row (one web claim row: category · note · date | amount · pill)

@available(iOS 17.0, *)
private struct PortalExpenseClaimRow: View {
    let claim: PortalExpenseClaim

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(claim.category)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                if let note = claim.note, !note.isEmpty {
                    Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                if let d = PortalExpenseFormat.dateTime(claim.createdAt) {
                    Text(d).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(PortalExpenseFormat.money(claim.amount))
                    .font(.footnote.weight(.bold).monospacedDigit())
                statusPill
            }
        }
        .padding(.vertical, 10)
    }

    /// Web StatusPill parity — tinted capsule, Bangla label.
    private var statusPill: some View {
        let color = PortalExpensePalette.status(claim.status)
        return Text(claim.statusLabel)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(color.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.25), lineWidth: 1))
    }
}

// MARK: - Submit sheet (web "নতুন আবেদন" card → native form + confirm step)

@available(iOS 17.0, *)
private struct PortalExpenseSubmitSheet: View {
    let vm: PortalExpenseVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var amountFocused: Bool

    /// Web CATEGORY_OPTIONS, verbatim.
    private static let categories = [
        "যাতায়াত / কুরিয়ার",
        "অফিস সামগ্রী",
        "খাবার / আপ্যায়ন",
        "মেরামত",
        "অন্যান্য",
    ]

    @State private var amount = ""
    @State private var category = Self.categories[0]
    @State private var vendor = ""
    @State private var note = ""
    @State private var confirming = false
    @State private var localError: String? = nil

    /// Web submit(): strip non-numerics, must be > 0.
    private var parsedAmount: Int {
        Int(amount.filter { $0.isNumber }) ?? 0
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("নতুন আবেদন").font(.headline)

                if let err = localError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(PortalExpensePalette.red500)
                }

                fieldLabel("টাকার অঙ্ক *")
                TextField("যেমন: 500", text: $amount)
                    .keyboardType(.numberPad)
                    .focused($amountFocused)
                    .padding(12)
                    .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                fieldLabel("খরচের ধরন")
                categoryChips

                fieldLabel("কোথায় খরচ (ঐচ্ছিক)")
                TextField("দোকান / প্রতিষ্ঠানের নাম", text: $vendor)
                    .padding(12)
                    .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                fieldLabel("নোট (ঐচ্ছিক)")
                TextField("সংক্ষিপ্ত বিবরণ", text: $note, axis: .vertical)
                    .lineLimit(2...4)
                    .padding(12)
                    .portalExpenseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                Text("মালিক অনুমোদন করলে টাকা আপনার ওয়ালেটে যোগ হবে।")
                    .font(.caption2).foregroundStyle(.secondary)

                submitButton
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { PortalExpenseAurora() }
        .onAppear { amountFocused = true }
        .confirmationDialog(
            "৳\(parsedAmount.formatted()) — \(category)",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("হ্যাঁ, আবেদন পাঠান") {
                Task {
                    if await vm.submit(amount: parsedAmount, category: category,
                                       vendor: vendor, note: note) {
                        dismiss()
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("ফেরতের আবেদনটি মালিকের অনুমোদনের জন্য পাঠানো হবে। পাঠানোর পর সম্পাদনা করা যাবে না।")
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.caption.weight(.bold)).foregroundStyle(.secondary)
    }

    /// Web <select> re-set as native capsule chips — one tap, no dropdown.
    private var categoryChips: some View {
        PortalExpenseFlowChips(items: Self.categories, selected: category) { picked in
            UISelectionFeedbackGenerator().selectionChanged()
            category = picked
        }
    }

    private var submitButton: some View {
        Button {
            let n = parsedAmount
            guard n > 0 else {
                localError = "সঠিক একটি টাকার অঙ্ক দিন।"
                return
            }
            localError = nil
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            confirming = true
        } label: {
            HStack(spacing: 8) {
                if vm.submitting { ProgressView().controlSize(.small) }
                Text("আবেদন পাঠান").font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(PortalExpensePalette.coral)
        .disabled(vm.submitting)
    }
}

/// Two-row wrapping capsule chip picker for the 5 Bangla categories.
@available(iOS 17.0, *)
private struct PortalExpenseFlowChips: View {
    let items: [String]
    let selected: String
    let onPick: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(row, id: \.self) { item in
                        chip(item)
                    }
                }
            }
        }
    }

    /// Fixed 2-per-row split keeps the Bangla labels readable without measuring text.
    private var rows: [[String]] {
        stride(from: 0, to: items.count, by: 2).map { i in
            Array(items[i..<min(i + 2, items.count)])
        }
    }

    private func chip(_ label: String) -> some View {
        let active = label == selected
        return Button {
            onPick(label)
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? PortalExpensePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? PortalExpensePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? PortalExpensePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum PortalExpenseFormat {
    /// Web <Money>: whole-taka with ৳ sign and thousand separators.
    static func money(_ amount: Int) -> String {
        "৳\(amount.formatted())"
    }

    /// Web fmtDate: bn-BD, Asia/Dhaka, "৫ জুলাই, ৮:৫০ PM" style.
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.setLocalizedDateFormatFromTemplate("d MMM jm")
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

// MARK: - Aurora background + glass (PortalExpense-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct PortalExpenseAurora: View {
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
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear { updateDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func portalExpenseGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PortalExpenseShimmer: ViewModifier {
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
    func portalExpenseShimmer() -> some View { modifier(PortalExpenseShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Portal expense — Light") {
    PortalExpenseScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
