//
//  PaymentAccountsSwiftUI.swift
//  ALMA ERP — staff payout methods (bKash / Nagad / Rocket / bank) as a native screen.
//
//  Mirrors the web /portal/payment-accounts page (PaymentAccountsPanel):
//    GET /api/employee/payment-methods?business_id=…   → { ok, data: { methods } }
//  READ-ONLY BY DESIGN (security): the server already masks account numbers on this
//  GET (reveal:false) and adding/editing/deleting payout NUMBERS is sensitive, so the
//  native screen never POSTs/PATCHes/DELETEs — all mutations (add mobile/bank account,
//  set default, remove, reveal full number) go through the web escape hatch.
//  iOS feel: Wallet-app provider-tinted cards (bKash pink · Nagad orange · bank blue),
//  masked numbers in monospace, Verified / Pending-verify badges (green / amber).
//  Carried lessons: lenient decoding, ONE screen-level shimmer, no global overlays.
//

import SwiftUI
import LocalAuthentication

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum PaymentAccountPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    // Provider tints (Wallet-card look)
    static let bkashPink = Color(red: 0.925, green: 0.286, blue: 0.600)      // #EC4899
    static let nagadOrange = Color(red: 0.976, green: 0.451, blue: 0.086)    // #F97316
    static let bankBlue = Color(red: 0.231, green: 0.510, blue: 0.965)       // #3B82F6
    static let rocketViolet = AlmaSwiftTheme.violet

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// One tint per payout method — drives the Wallet-style card gradient.
    static func tint(_ m: PaymentAccountMethod) -> Color {
        if m.type == "BANK_ACCOUNT" { return bankBlue }
        switch m.provider {
        case "BKASH": return bkashPink
        case "NAGAD": return nagadOrange
        case "ROCKET": return rocketViolet
        default: return coral
        }
    }
}

// MARK: - Models (same field names the web MethodRow type declares)

struct PaymentAccountMethod: Decodable, Identifiable, Equatable {
    let id: String
    let type: String?               // MOBILE_BANKING | BANK_ACCOUNT
    let provider: String?           // BKASH | NAGAD | ROCKET | OTHER
    let usageType: String?          // PERSONAL | BUSINESS
    let accountHolderName: String?
    let accountNumber: String?      // server masks this on list (reveal:false)
    let accountNumberMasked: String?
    let bankName: String?
    let branchName: String?
    let routingNumber: String?
    let hasQr: Bool?
    let isPrimary: Bool?
    let isVerified: Bool?
    let status: String?
    let suspiciousNote: String?
    let displayLabel: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, type, provider, usageType, accountHolderName, accountNumber
        case accountNumberMasked, bankName, branchName, routingNumber, hasQr
        case isPrimary, isVerified, status, suspiciousNote, displayLabel, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        provider = try? c.decodeIfPresent(String.self, forKey: .provider)
        usageType = try? c.decodeIfPresent(String.self, forKey: .usageType)
        accountHolderName = try? c.decodeIfPresent(String.self, forKey: .accountHolderName)
        accountNumber = try? c.decodeIfPresent(String.self, forKey: .accountNumber)
        accountNumberMasked = try? c.decodeIfPresent(String.self, forKey: .accountNumberMasked)
        bankName = try? c.decodeIfPresent(String.self, forKey: .bankName)
        branchName = try? c.decodeIfPresent(String.self, forKey: .branchName)
        routingNumber = try? c.decodeIfPresent(String.self, forKey: .routingNumber)
        hasQr = Self.flexBool(c, .hasQr)
        isPrimary = Self.flexBool(c, .isPrimary)
        isVerified = Self.flexBool(c, .isVerified)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        suspiciousNote = try? c.decodeIfPresent(String.self, forKey: .suspiciousNote)
        displayLabel = try? c.decodeIfPresent(String.self, forKey: .displayLabel)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    private static func flexBool(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Bool? {
        if let b = try? c.decodeIfPresent(Bool.self, forKey: k) { return b }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i != 0 }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s == "true" || s == "1" }
        return nil
    }

    /// Always show the MASKED number natively — never the full one (security rule).
    var maskedNumber: String { accountNumberMasked ?? accountNumber ?? "—" }

    /// Web methodDisplayLabel fallback when displayLabel is absent.
    var label: String {
        if let l = displayLabel, !l.isEmpty { return l }
        if type == "BANK_ACCOUNT" { return bankName ?? "Bank" }
        return (provider ?? "Mobile").capitalized
    }

    static func == (a: PaymentAccountMethod, b: PaymentAccountMethod) -> Bool {
        a.id == b.id && a.isPrimary == b.isPrimary && a.isVerified == b.isVerified
    }
}

/// The route wraps via apiSuccess → `{ ok, data: { methods } }` — decode both shapes.
struct PaymentAccountsListResponse: Decodable {
    let methods: [PaymentAccountMethod]

    private enum Keys: String, CodingKey { case ok, data, methods }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        methods = (try? c.decode([PaymentAccountMethod].self, forKey: .methods)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PaymentAccountsVM {
    var methods: [PaymentAccountMethod] = []
    /// Same default business the other native tabs scope to (web _businessId default).
    var businessId = "ALMA_LIFESTYLE"
    var loading = false
    var error: String? = nil
    var notice: String? = nil       // transient "Copied" line
    var authExpired = false

    static let businesses: [(id: String, label: String)] = [
        ("ALMA_LIFESTYLE", "ALMA Lifestyle"),
        ("ALMA_TRADING", "ALMA Trading"),
        ("CREATIVE_DIGITAL_IT", "CDIT"),
    ]

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: PaymentAccountsListResponse = try await AlmaAPI.shared.get(
                "/api/employee/payment-methods", query: ["business_id": businessId])
            methods = resp.methods
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch AlmaAPIError.http(let status, _) where status == 401 {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "Could not load payment accounts"
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// Copies the MASKED number only — the full number never reaches this screen.
    // ── NP-5 (AD-05): full secure management — the web PaymentAccountsPanel's
    //    exact payloads. Reveal + delete are gated behind LocalAuthentication
    //    (Face ID / passcode) IN ADDITION to server authorization. ──

    var saving = false
    var revealBusy: String? = nil
    var revealedNumbers: [String: String] = [:]   // method id → full number (session-only)

    private struct WriteResp: Decodable { let ok: Bool?; let error: String? }

    struct MobileForm {
        var provider = "BKASH"       // BKASH | NAGAD | ROCKET | OTHER
        var usageType = "PERSONAL"   // PERSONAL | BUSINESS
        var holder = ""
        var number = ""
    }
    struct BankForm {
        var bankName = ""
        var branchName = ""
        var holder = ""
        var number = ""
        var routing = ""
    }

    /// POST /api/employee/payment-methods — MOBILE_BANKING (web submitMobile body).
    func addMobile(_ f: MobileForm) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        struct Body: Encodable {
            let business_id: String, type: String, provider: String, usage_type: String
            let account_holder_name: String, account_number: String, is_primary: Bool
        }
        do {
            let _: WriteResp = try await AlmaAPI.shared.send(
                "POST", "/api/employee/payment-methods",
                body: Body(business_id: businessId, type: "MOBILE_BANKING", provider: f.provider,
                           usage_type: f.usageType, account_holder_name: f.holder,
                           account_number: f.number, is_primary: true))
            notice = "Mobile account saved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            self.error = "Save ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }

    /// POST — BANK_ACCOUNT (web submitBank body; primary only when list empty).
    func addBank(_ f: BankForm) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        struct Body: Encodable {
            let business_id: String, type: String, bank_name: String, branch_name: String
            let account_holder_name: String, account_number: String, routing_number: String
            let is_primary: Bool
        }
        do {
            let _: WriteResp = try await AlmaAPI.shared.send(
                "POST", "/api/employee/payment-methods",
                body: Body(business_id: businessId, type: "BANK_ACCOUNT", bank_name: f.bankName,
                           branch_name: f.branchName, account_holder_name: f.holder,
                           account_number: f.number, routing_number: f.routing,
                           is_primary: methods.isEmpty))
            notice = "Bank account saved"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            self.error = "Save ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }

    /// PATCH /{id} {is_primary:true} — set default payout.
    func setPrimary(_ id: String) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        struct Body: Encodable { let is_primary: Bool }
        do {
            let _: WriteResp = try await AlmaAPI.shared.send(
                "PATCH", "/api/employee/payment-methods/\(id)", body: Body(is_primary: true))
            notice = "Default payout updated"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = "পরিবর্তন ব্যর্থ: \(error.localizedDescription)"
        }
        await load()
    }

    /// DELETE /{id} — device-auth + confirm handled by the UI before calling.
    func remove(_ id: String) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        struct Empty: Decodable { let ok: Bool? }
        do {
            let _: Empty = try await AlmaAPI.shared.send("DELETE", "/api/employee/payment-methods/\(id)")
            notice = "Account removed"
            revealedNumbers[id] = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = "Remove ব্যর্থ: \(error.localizedDescription)"
        }
        await load()
    }

    /// Reveal the full number: Face ID / passcode FIRST, then a reveal fetch
    /// (server authorization — GET with reveal=1 falls back to the list value).
    @MainActor
    func reveal(_ m: PaymentAccountMethod) async {
        guard revealBusy == nil else { return }
        if revealedNumbers[m.id] != nil {
            revealedNumbers[m.id] = nil    // hide again
            return
        }
        revealBusy = m.id
        defer { revealBusy = nil }
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Passcode"
        do {
            let ok = try await ctx.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "অ্যাকাউন্ট নম্বর দেখতে পরিচয় নিশ্চিত করুন")
            guard ok else { return }
        } catch { return }
        struct Resp: Decodable {
            let methods: [PaymentAccountMethod]
            private enum Keys: String, CodingKey { case ok, data, methods }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                methods = (try? c.decode([PaymentAccountMethod].self, forKey: .methods)) ?? []
            }
        }
        if let r: Resp = try? await AlmaAPI.shared.get(
            "/api/employee/payment-methods",
            query: ["business_id": businessId, "reveal": "1"]),
           let full = r.methods.first(where: { $0.id == m.id })?.accountNumber, !full.isEmpty {
            revealedNumbers[m.id] = full
        } else if let n = m.accountNumber, !n.isEmpty {
            revealedNumbers[m.id] = n
        } else {
            self.error = "পুরো নম্বর আনা যায়নি"
        }
    }

    func copyMasked(_ m: PaymentAccountMethod) {
        UIPasteboard.general.string = m.maskedNumber
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        notice = "Copied"
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if self?.notice == "Copied" { self?.notice = nil }
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PaymentAccountsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PaymentAccountsVM()
    @State private var showMobileForm = false
    @State private var showBankForm = false
    @State private var deleteTarget: PaymentAccountMethod? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                businessChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                if vm.loading && vm.methods.isEmpty { loadingRows }
                ForEach(vm.methods) { m in
                    VStack(spacing: 6) {
                        PaymentAccountCard(method: m) { vm.copyMasked(m) }
                        // NP-5 (AD-05): reveal (Face ID) · set default · remove (Face ID + confirm).
                        HStack(spacing: 8) {
                            Button {
                                UISelectionFeedbackGenerator().selectionChanged()
                                Task { await vm.reveal(m) }
                            } label: {
                                Text(vm.revealBusy == m.id ? "⏳" :
                                     (vm.revealedNumbers[m.id] != nil ? "🙈 লুকান" : "👁️ দেখুন"))
                                    .font(.caption2.weight(.bold))
                            }
                            .buttonStyle(.bordered)
                            if let full = vm.revealedNumbers[m.id] {
                                Text(full).font(.caption.monospaced().weight(.bold))
                                    .textSelection(.enabled)
                            }
                            Spacer()
                            if m.isPrimary != true {
                                Button {
                                    UISelectionFeedbackGenerator().selectionChanged()
                                    Task { await vm.setPrimary(m.id) }
                                } label: {
                                    Text("⭐️ Default").font(.caption2.weight(.bold))
                                }
                                .buttonStyle(.bordered)
                            }
                            Button(role: .destructive) {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                deleteTarget = m
                            } label: {
                                Text("🗑️").font(.caption2)
                            }
                            .buttonStyle(.bordered)
                        }
                        .disabled(vm.saving)
                        .padding(.horizontal, 4)
                    }
                }
                if !vm.loading && vm.methods.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                readOnlyStrip
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PaymentAccountsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(isPresented: $showMobileForm) {
            PaymentMobileFormSheet(vm: vm) { showMobileForm = false }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showBankForm) {
            PaymentBankFormSheet(vm: vm) { showBankForm = false }
                .presentationDetents([.medium, .large])
        }
        // Delete: device auth + Bangla confirm (AD-05 high-risk action).
        .confirmationDialog(
            deleteTarget.map { "\($0.label) — মুছে ফেলবেন?" } ?? "",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            titleVisibility: .visible,
            presenting: deleteTarget
        ) { m in
            Button("মুছুন", role: .destructive) {
                Task {
                    let ctx = LAContext()
                    if (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication,
                                                      localizedReason: "অ্যাকাউন্ট মুছতে পরিচয় নিশ্চিত করুন")) == true {
                        await vm.remove(m.id)
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { m in
            Text("\(m.maskedNumber) — এই payout অ্যাকাউন্টটি মুছে যাবে।")
        }
    }

    /// Web panel header as the bento dark hero (owner spec 2026-07-08) — COUNTS ONLY
    /// (this screen has no balances): accounts on file + verified/pending split, all
    /// derived from the same list the cards below render. Explainer line kept verbatim.
    private var header: some View {
        PayBentoHeroCard(total: vm.methods.count,
                         verified: vm.methods.filter { $0.isVerified == true }.count,
                         pending: vm.methods.filter { $0.isVerified != true }.count)
    }

    /// Business scope chips — the web page reads it from BusinessContext; natively
    /// the owner flips it here (same three businesses).
    private var businessChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(PaymentAccountsVM.businesses, id: \.id) { biz in
                    paymentChip(biz.label, active: vm.businessId == biz.id) {
                        vm.businessId = biz.id
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "creditcard").font(.largeTitle).foregroundStyle(.secondary)
            Text("No payout accounts yet. Add bKash, Nagad, Rocket, or a bank account.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                openWeb("/portal/payment-accounts", "Payment accounts")
            } label: {
                Text("ওয়েবে অ্যাকাউন্ট যোগ করুন")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(PaymentAccountPalette.coral)
        }
        .padding(.top, 50)
        .padding(.bottom, 20)
    }

    /// NP-5 (AD-05): full native management — reveal/delete are Face ID-gated.
    private var readOnlyStrip: some View {
        Label("নম্বর দেখা ও ডিলিট — Face ID/পাসকোড দিয়ে সুরক্ষিত। সার্ভারের অনুমতিও লাগে।", systemImage: "lock.shield")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .paymentAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var webEscape: some View {
        HStack(spacing: 8) {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showMobileForm = true
            } label: {
                Text("📱 Mobile account").font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(PaymentAccountPalette.coral.opacity(0.12), in: Capsule())
                    .foregroundStyle(PaymentAccountPalette.coral)
            }
            .buttonStyle(.plain)
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showBankForm = true
            } label: {
                Text("🏦 Bank account").font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(PaymentAccountPalette.emerald600.opacity(0.12), in: Capsule())
                    .foregroundStyle(PaymentAccountPalette.emerald600)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }

    // ── Shared bits (pattern parity) ──

    private func paymentChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? PaymentAccountPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? PaymentAccountPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? PaymentAccountPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", PaymentAccountPalette.red500)
        case .success: ("checkmark.circle", PaymentAccountPalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).paymentAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .paymentAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 150)
                .paymentAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .paymentAccountsShimmer()
        }
    }
}

// MARK: - Wallet-style account card (provider-tinted, masked monospace number)

@available(iOS 17.0, *)
private struct PaymentAccountCard: View {
    let method: PaymentAccountMethod
    let onCopy: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var tint: Color { PaymentAccountPalette.tint(method) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                providerBadge
                Text(method.label)
                    .font(.subheadline.weight(.bold))
                Spacer()
                if method.isPrimary == true {
                    tagPill("Primary",
                            text: PaymentAccountPalette.accentText(colorScheme),
                            bg: PaymentAccountPalette.coral.opacity(0.15))
                }
            }

            Text(method.accountHolderName ?? "—")
                .font(.footnote.weight(.semibold))

            // Masked number — the Wallet-card centrepiece. Server masks on list;
            // reveal lives on the web only.
            HStack(spacing: 8) {
                Text(method.maskedNumber)
                    .font(.title3.monospaced().weight(.semibold))
                    .kerning(1.2)
                    .foregroundStyle(PaymentAccountPalette.accentText(colorScheme))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    onCopy()
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .background(Color.primary.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain)
            }

            if method.type == "BANK_ACCOUNT", let bank = method.bankName {
                Text(method.branchName.map { "\(bank) · \($0)" } ?? bank)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 6) {
                // Web badge parity: Verified (green) / Pending verify (amber).
                tagPill(method.isVerified == true ? "Verified" : "Pending verify",
                        text: method.isVerified == true ? PaymentAccountPalette.green400
                                                        : PaymentAccountPalette.amber600,
                        bg: (method.isVerified == true ? PaymentAccountPalette.green400
                                                       : PaymentAccountPalette.amber500).opacity(0.13))
                if method.usageType == "BUSINESS" {
                    tagPill("Business", text: .secondary, bg: Color.primary.opacity(0.06))
                }
                if method.hasQr == true {
                    tagPill("QR", text: .secondary, bg: Color.primary.opacity(0.06))
                }
                Spacer()
            }

            if let note = method.suspiciousNote, !note.isEmpty {
                Label(note, systemImage: "exclamationmark.triangle")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(PaymentAccountPalette.red500)
            }
        }
        .padding(16)
        .background(
            // Provider-tinted wash over the glass — the Wallet-card feel.
            LinearGradient(colors: [tint.opacity(colorScheme == .dark ? 0.22 : 0.12),
                                    tint.opacity(colorScheme == .dark ? 0.06 : 0.03)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .paymentAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(tint.opacity(method.isPrimary == true ? 0.45 : 0.25), lineWidth: 1))
    }

    private var providerBadge: some View {
        Image(systemName: method.type == "BANK_ACCOUNT" ? "building.columns.fill" : "iphone.gen3")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(
                LinearGradient(colors: [tint, tint.opacity(0.7)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .shadow(color: tint.opacity(0.35), radius: 5, y: 2)
    }

    private func tagPill(_ label: String, text: Color, bg: Color) -> some View {
        Text(label)
            .font(.system(size: 10, weight: .heavy))
            .foregroundStyle(text)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(bg, in: Capsule())
    }
}

// MARK: - Aurora background + glass (PaymentAccounts-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct PaymentAccountsAurora: View {
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
    func paymentAccountsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PaymentAccountsShimmer: ViewModifier {
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
    func paymentAccountsShimmer() -> some View { modifier(PaymentAccountsShimmer()) }
}

// MARK: - Bento components (PaymentAccounts-owned copies of the Dashboard board
// language — per-file copies are this repo's parallel-session convention)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func payMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct PayCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        PayCountUpText(value: shown)
            .animation(payMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if payMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct PayCountUpText: View, Animatable {
    var value: Double
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text("\(Int(value.rounded()))")
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Accounts-on-file count-up
/// plus the Verified / Pending-verify split; the web explainer line kept verbatim.
@available(iOS 17.0, *)
private struct PayBentoHeroCard: View {
    let total: Int
    let verified: Int
    let pending: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("পেমেন্ট অ্যাকাউন্ট · PAYMENT ACCOUNTS")
                .font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(PaymentAccountPalette.goldLt)
            PayCountUp(target: total)
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("Used for salary payouts, wallet advances, and withdrawals. Numbers are masked on shared screens.")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Verified", value: verified,
                         tint: PaymentAccountPalette.green400, sub: "যাচাই হয়েছে")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Pending verify", value: pending,
                         tint: pending > 0 ? PaymentAccountPalette.amber500 : .white,
                         sub: "যাচাই বাকি")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            PayCountUp(target: value)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Payment accounts — Light") {
    PaymentAccountsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - NP-5 (AD-05): add-account form sheets (web submitMobile/submitBank parity)

@available(iOS 17.0, *)
private struct PaymentMobileFormSheet: View {
    let vm: PaymentAccountsVM
    let onDone: () -> Void
    @State private var f = PaymentAccountsVM.MobileForm()

    var body: some View {
        NavigationStack {
            Form {
                Section("Mobile banking") {
                    Picker("Provider", selection: $f.provider) {
                        Text("bKash").tag("BKASH")
                        Text("Nagad").tag("NAGAD")
                        Text("Rocket").tag("ROCKET")
                        Text("Other").tag("OTHER")
                    }
                    Picker("ব্যবহার", selection: $f.usageType) {
                        Text("Personal").tag("PERSONAL")
                        Text("Business").tag("BUSINESS")
                    }
                    TextField("Account holder name", text: $f.holder)
                    TextField("Account number", text: $f.number).keyboardType(.phonePad)
                }
            }
            .navigationTitle("Mobile account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বাতিল") { onDone() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(vm.saving ? "…" : "সেভ") {
                        Task { if await vm.addMobile(f) { onDone() } }
                    }
                    .disabled(vm.saving || f.holder.isEmpty || f.number.isEmpty)
                }
            }
        }
    }
}

@available(iOS 17.0, *)
private struct PaymentBankFormSheet: View {
    let vm: PaymentAccountsVM
    let onDone: () -> Void
    @State private var f = PaymentAccountsVM.BankForm()

    var body: some View {
        NavigationStack {
            Form {
                Section("Bank account") {
                    TextField("Bank name", text: $f.bankName)
                    TextField("Branch name", text: $f.branchName)
                    TextField("Account holder name", text: $f.holder)
                    TextField("Account number", text: $f.number).keyboardType(.numberPad)
                    TextField("Routing number", text: $f.routing).keyboardType(.numberPad)
                }
            }
            .navigationTitle("Bank account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বাতিল") { onDone() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(vm.saving ? "…" : "সেভ") {
                        Task { if await vm.addBank(f) { onDone() } }
                    }
                    .disabled(vm.saving || f.bankName.isEmpty || f.holder.isEmpty || f.number.isEmpty)
                }
            }
        }
    }
}
