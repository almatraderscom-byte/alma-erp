//
//  SubscriptionsSwiftUI.swift
//  ALMA ERP — the owner's personal subscription tracker as a native SwiftUI screen (v4).
//
//  A MANUAL ledger (not a live API): the owner records his own recurring services —
//  Gemini, ChatGPT, Claude, Vercel, Supabase, OpenRouter, GitHub, Cloudflare, anything
//  added later — one card each, fully editable from the phone. The agent can also mutate
//  it in words ("Vercel-এর খরচ $20 করো") through the same endpoints/table.
//
//  v4 (owner design 2026-07, market-researched · iOS 26 Liquid-Glass + spatial HIG):
//    • SOLID opaque surfaces for the data (subscription cards, status tiles, hero).
//    • GLASS floating controls (renewal chips, the assistant hint, add/edit buttons).
//    • iOS effects: selection/impact haptics, pressable rows, spring status transitions.
//
//  CRUD (owner-only, cookie-bridged via AlmaAPI):
//    GET/POST /api/assistant/costs/subscriptions · PATCH/DELETE /{id}
//  Status (Active/Expiring/Expired/Free) is DERIVED from amount + nextRenewalAt.
//  `plan` + `paymentMethod` are backed by additive columns (native editor fields).
//  Parallel-session rule: page-owned material/aurora helpers (no cross-page imports).
//

import SwiftUI

// MARK: - Palette

private enum SubPalette {
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.980)
    static let gold = Color(red: 0.831, green: 0.659, blue: 0.294)
    static let goldLt = Color(red: 0.933, green: 0.706, blue: 0.561)
    static let emerald = Color(red: 0.239, green: 0.745, blue: 0.545)
    static let amber = Color(red: 0.878, green: 0.663, blue: 0.294)
    static let red = Color(red: 0.894, green: 0.459, blue: 0.420)
    static let sage = Color(red: 0.506, green: 0.698, blue: 0.604)
    static func accentText(_ s: ColorScheme) -> Color { s == .dark ? goldLt : Color(red: 0.706, green: 0.333, blue: 0.184) }
    static func brand(_ name: String) -> Color {
        switch name.lowercased() {
        case let n where n.contains("gemini"): return Color(red: 0.357, green: 0.553, blue: 0.937)
        case let n where n.contains("claude") || n.contains("anthropic"): return coral
        case let n where n.contains("chatgpt") || n.contains("openai"): return emerald
        case let n where n.contains("vercel"): return Color(red: 0.79, green: 0.78, blue: 0.84)
        case let n where n.contains("supabase"): return Color(red: 0.243, green: 0.812, blue: 0.557)
        case let n where n.contains("openrouter"): return violet
        case let n where n.contains("github"): return Color(red: 0.72, green: 0.71, blue: 0.77)
        case let n where n.contains("cloudflare"): return amber
        default: return Color(hue: Double(abs(name.hashValue) % 360) / 360, saturation: 0.5, brightness: 0.85)
        }
    }
}

// MARK: - Model

enum SubStatus: String { case active, expiring, expired, free
    var label: String {
        switch self { case .active: return "সক্রিয়"; case .expiring: return "শীঘ্রই রিনিউ"
        case .expired: return "মেয়াদোত্তীর্ণ"; case .free: return "ফ্রি" }
    }
    var color: Color {
        switch self { case .active: return SubPalette.emerald; case .expiring: return SubPalette.amber
        case .expired: return SubPalette.red; case .free: return SubPalette.sage }
    }
}

struct Subscription: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let amount: Double
    let currency: String
    let billingCycle: String
    let nextRenewalAt: Date?
    let category: String?
    let notes: String?
    let active: Bool
    let plan: String?
    let paymentMethod: String?

    private enum K: String, CodingKey {
        case id, name, amount, currency, billingCycle, nextRenewalAt, category, notes, active, plan, paymentMethod
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        if let dbl = try? c.decodeIfPresent(Double.self, forKey: .amount) { amount = dbl }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .amount), let dbl = Double(s) { amount = dbl }
        else { amount = 0 }
        currency = (try? c.decodeIfPresent(String.self, forKey: .currency)) ?? "USD"
        billingCycle = (try? c.decodeIfPresent(String.self, forKey: .billingCycle)) ?? "monthly"
        nextRenewalAt = try? c.decodeIfPresent(Date.self, forKey: .nextRenewalAt)
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? true
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        paymentMethod = try? c.decodeIfPresent(String.self, forKey: .paymentMethod)
    }
    var status: SubStatus {
        if amount <= 0 { return .free }
        guard let r = nextRenewalAt else { return active ? .active : .expired }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: r).day ?? 0
        if days < 0 { return .expired }
        if days <= 7 { return .expiring }
        return .active
    }
    var monthlyEquiv: Double { billingCycle == "yearly" ? amount / 12 : amount }
    var symbol: String { currency == "USD" ? "$" : (currency + " ") }
    var priceLabel: String { symbol + String(format: "%.2f", amount) }
    var cycleLabel: String { billingCycle == "yearly" ? "বার্ষিক" : "মাসিক" }
    var planLine: String { plan ?? category ?? billingCycle.capitalized }
}

private struct SubPayload: Encodable {
    var name: String; var amount: Double; var currency: String; var billingCycle: String
    var nextRenewalAt: String?; var category: String?; var notes: String?; var plan: String?; var paymentMethod: String?
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SubscriptionsVM {
    var subs: [Subscription] = []
    /// Live API credit balances (owner 2026-07-12: fal.ai balance must be visible
    /// here too, not only on Credit Usage). Same cache the costs page reads.
    var apiBalances: [SubApiBalance] = []
    var loading = false
    var saving = false
    var error: String? = nil
    var authExpired = false
    var changeTick = 0   // bumped on any successful mutation → drives a success haptic

    func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            let all: [Subscription] = try await AlmaAPI.shared.get("/api/assistant/costs/subscriptions")
            subs = all.filter { $0.active }
            authExpired = false
            if let b: SubBalancesResponse = try? await AlmaAPI.shared.get("/api/assistant/costs/balances") {
                apiBalances = b.rows.filter { $0.balanceUsd != nil }
            }
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? URLError)?.code == .cancelled
    }
    fileprivate func save(_ payload: SubPayload, editing id: String?) async -> Bool {
        saving = true; defer { saving = false }
        do {
            if let id { let _: Subscription = try await AlmaAPI.shared.send("PATCH", "/api/assistant/costs/subscriptions/\(id)", body: payload) }
            else { let _: Subscription = try await AlmaAPI.shared.send("POST", "/api/assistant/costs/subscriptions", body: payload) }
            await load(); changeTick += 1; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func delete(_ id: String) async {
        struct Ack: Decodable {}
        _ = try? await AlmaAPI.shared.send("DELETE", "/api/assistant/costs/subscriptions/\(id)") as Ack
        await load(); changeTick += 1
    }

    var activeSubs: [Subscription] { subs.filter { $0.status != .expired && $0.status != .free } }
    var monthlyTotal: Double { activeSubs.reduce(0) { $0 + $1.monthlyEquiv } }
    var yearlyTotal: Double { monthlyTotal * 12 }
    var upcoming: [Subscription] {
        subs.filter { $0.nextRenewalAt != nil && $0.status != .expired && $0.status != .free }
            .sorted { ($0.nextRenewalAt ?? .distantFuture) < ($1.nextRenewalAt ?? .distantFuture) }
    }
    var nextRenewal: Subscription? { upcoming.first }
    func count(_ s: SubStatus) -> Int { subs.filter { $0.status == s }.count }
}

/// One provider row from the balance cache (lenient decode, flat or {cache:{…}}).
struct SubApiBalance: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let balanceUsd: Double?
    private enum K: String, CodingKey { case id, label, balanceUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        label = (try? c.decode(String.self, forKey: .label)) ?? id
        balanceUsd = try? c.decodeIfPresent(Double.self, forKey: .balanceUsd)
    }
}

struct SubBalancesResponse: Decodable {
    let rows: [SubApiBalance]
    private enum K: String, CodingKey { case providers, cache }
    init(from d: Decoder) throws {
        let root = try d.container(keyedBy: K.self)
        if let direct = try? root.decode([SubApiBalance].self, forKey: .providers) {
            rows = direct
        } else if let nested = try? root.nestedContainer(keyedBy: K.self, forKey: .cache),
                  let inner = try? nested.decode([SubApiBalance].self, forKey: .providers) {
            rows = inner
        } else {
            rows = []
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SubscriptionsScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = SubscriptionsVM()
    @State private var editing: Subscription? = nil
    @State private var showEditor = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.subs.isEmpty { loadingRows }
                if !vm.subs.isEmpty || (!vm.loading && !vm.authExpired) {
                    heroGrid.subAppear(0)
                    if !vm.apiBalances.isEmpty { apiBalanceStrip.subAppear(1) }
                    if !vm.upcoming.isEmpty { upcomingStrip.subAppear(1) }
                    assistantHint.subAppear(2)
                    statTrio.subAppear(3)
                    sectionHeader
                    ForEach(Array(vm.subs.enumerated()), id: \.element.id) { i, s in subCard(s).subAppear(min(i + 4, 8)) }
                    addButton
                }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14).padding(.top, 6)
        }
        .background(SubAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .toolbar { ToolbarItem(placement: .topBarTrailing) {
            Button { editing = nil; showEditor = true } label: { Image(systemName: "plus") }
                .accessibilityLabel("নতুন সাবস্ক্রিপশন") } }
        .sheet(isPresented: $showEditor) { SubEditor(existing: editing, vm: vm) }
        .sensoryFeedback(.success, trigger: vm.changeTick)
        .sensoryFeedback(.impact(weight: .light), trigger: showEditor)
    }

    /// Live API credit balances (fal.ai highlighted) — horizontal chips, synced
    /// from the same cache the Credit Usage page shows.
    private var apiBalanceStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("API ব্যালেন্স (লাইভ)").font(.system(size: 10, weight: .bold))
                .textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.apiBalances) { b in
                        HStack(spacing: 6) {
                            Text(b.label).font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                            Text(String(format: "$%.2f", b.balanceUsd ?? 0))
                                .font(.system(size: 12.5, weight: .bold, design: .rounded).monospacedDigit())
                                .foregroundStyle((b.balanceUsd ?? 0) < 3
                                                 ? Color(red: 0.94, green: 0.35, blue: 0.35)
                                                 : SubPalette.accentText(scheme))
                        }
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .background(Color.primary.opacity(0.05),
                                    in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            b.id == "fal" ? SubPalette.accentText(scheme).opacity(0.45) : Color.primary.opacity(0.08),
                            lineWidth: 1))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(Color.primary.opacity(0.03),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var heroGrid: some View {
        HStack(spacing: 11) {
            VStack(alignment: .leading, spacing: 0) {
                Text("মাসিক মোট").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                Text(fmt(vm.monthlyTotal)).font(.system(size: 29, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(SubPalette.accentText(scheme)).lineLimit(1).minimumScaleFactor(0.6).padding(.top, 7)
                    .contentTransition(.numericText()).animation(.spring, value: vm.monthlyTotal)
                Text("\(vm.activeSubs.count)টি সক্রিয় · বছরে ≈ \(fmt(vm.yearlyTotal))").font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).subRaised(scheme, corner: AlmaSwiftTheme.rCard)
            VStack(alignment: .leading, spacing: 0) {
                Text("পরের রিনিউ").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                Text(nextRenewalCountdown).font(.system(size: 26, weight: .bold, design: .rounded)).lineLimit(1).minimumScaleFactor(0.6).padding(.top, 7)
                Text(vm.nextRenewal.map { "\($0.name) · \($0.priceLabel)" } ?? "—").font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 6).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).subRaised(scheme, corner: AlmaSwiftTheme.rCard)
        }
    }
    private var nextRenewalCountdown: String {
        guard let r = vm.nextRenewal?.nextRenewalAt else { return "—" }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: r).day ?? 0
        return days <= 0 ? "আজ" : "\(days) দিন"
    }

    private var upcomingStrip: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("আসন্ন রিনিউ").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary).padding(.horizontal, 3)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 9) {
                    ForEach(vm.upcoming.prefix(6)) { s in
                        HStack(spacing: 9) {
                            monogram(s, size: 28, radius: 9)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.name).font(.system(size: 11.5, weight: .bold)).lineLimit(1)
                                Text(renewShort(s)).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.leading, 9).padding(.trailing, 13).padding(.vertical, 9).subGlass(scheme, corner: AlmaSwiftTheme.rControl)
                    }
                }.padding(.horizontal, 1)
            }
        }
    }
    private func renewShort(_ s: Subscription) -> String {
        guard let r = s.nextRenewalAt else { return "—" }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: r).day ?? 0
        return "\(SubFormat.dayMonth(r)) · \(days <= 0 ? "আজ" : "\(days) দিন")"
    }

    private var assistantHint: some View {
        HStack(spacing: 12) {
            Image(systemName: "mic.fill").font(.system(size: 15)).foregroundStyle(.white).frame(width: 34, height: 34)
                .background(LinearGradient(colors: [SubPalette.coral, SubPalette.violet], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 10))
            Text("Assistant-কে বলুন — **\"Vercel-এর খরচ $20 করো\"** বা **\"Gemini Pro Plan-এ আপডেট করো\"**। সরাসরি এই হিসাব আপডেট হবে।")
                .font(.system(size: 11.5)).foregroundStyle(.primary)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).subGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }

    private var statTrio: some View {
        HStack(spacing: 9) {
            stat("\(vm.count(.active))", "সক্রিয়", SubPalette.emerald)
            stat("\(vm.count(.expiring))", "শীঘ্রই শেষ", SubPalette.amber)
            stat("\(vm.count(.expired))", "মেয়াদোত্তীর্ণ", SubPalette.red)
        }
    }
    private func stat(_ v: String, _ k: String, _ c: Color) -> some View {
        VStack(spacing: 5) {
            Text(v).font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(c)
            Text(k).font(.system(size: 9)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity).padding(12).subSolid(scheme, corner: AlmaSwiftTheme.rControl)
    }

    private var sectionHeader: some View {
        HStack {
            Text("সব সাবস্ক্রিপশন").font(.system(size: 13, weight: .bold)); Spacer()
            Text("ম্যানুয়াল · \(vm.subs.count)টি").font(.system(size: 10.5)).foregroundStyle(.secondary)
        }.padding(.horizontal, 3).padding(.top, 2)
    }

    private func subCard(_ s: Subscription) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                monogram(s, size: 42, radius: 13)
                VStack(alignment: .leading, spacing: 1) {
                    Text(s.name).font(.system(size: 15.5, weight: .bold))
                    Text(s.planLine).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(s.priceLabel).font(.system(size: 19, weight: .bold, design: .rounded).monospacedDigit())
                    Text(s.status == .free ? "ফ্রি" : "/\(s.cycleLabel)").font(.system(size: 9.5)).foregroundStyle(.secondary)
                }
            }
            HStack {
                Label(s.status.label, systemImage: "circle.fill").font(.system(size: 10, weight: .bold)).foregroundStyle(s.status.color)
                    .padding(.horizontal, 9).padding(.vertical, 4).background(s.status.color.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(s.status.color.opacity(0.28), lineWidth: 1))
                Spacer()
                Button { editing = s; showEditor = true } label: {
                    Image(systemName: "pencil")
                        .accessibilityLabel("সম্পাদনা করুন").font(.system(size: 13)).foregroundStyle(.secondary)
                        .frame(width: 29, height: 29).subGlass(scheme, corner: 9)
                }.buttonStyle(SubPress())
            }.padding(.top, 12)
            metaGrid(s)
        }
        .padding(16).subSolid(scheme, corner: AlmaSwiftTheme.rCard)
        .contextMenu {
            Button { editing = s; showEditor = true } label: { Label("এডিট", systemImage: "pencil") }
            Button(role: .destructive) { Task { await vm.delete(s.id) } } label: { Label("মুছুন", systemImage: "trash") }
        }
    }
    private func metaGrid(_ s: Subscription) -> some View {
        let cols = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        return LazyVGrid(columns: cols, alignment: .leading, spacing: 9) {
            meta("Billing", s.cycleLabel)
            meta("Next Renewal", s.nextRenewalAt == nil ? "—" : renewShort(s))
            meta("Payment", s.paymentMethod ?? "—")
            meta("Cycle Cost", s.priceLabel)
        }
        .padding(.top, 13).overlay(alignment: .top) { Divider().opacity(0.5) }
    }
    private func meta(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.system(size: 9, weight: .semibold)).textCase(.uppercase).kerning(0.4).foregroundStyle(.tertiary)
            Text(v).font(.system(size: 12.5, weight: .semibold).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
        }.padding(.top, 8)
    }
    private func monogram(_ s: Subscription, size: CGFloat, radius: CGFloat) -> some View {
        let c = SubPalette.brand(s.name)
        return Text(String(s.name.prefix(1)).uppercased())
            .font(.system(size: size * 0.44, weight: .bold, design: .rounded)).foregroundStyle(c)
            .frame(width: size, height: size)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(c.opacity(0.4), lineWidth: 1))
    }

    private var addButton: some View {
        Button { editing = nil; showEditor = true } label: {
            Label("নতুন সাবস্ক্রিপশন যোগ করুন", systemImage: "plus").font(.system(size: 13.5, weight: .semibold))
                .frame(maxWidth: .infinity).padding(15).subGlass(scheme, corner: 16)
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5])).foregroundStyle(.secondary.opacity(0.4)))
        }.buttonStyle(SubPress()).foregroundStyle(.secondary)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }.frame(maxWidth: .infinity).padding(20).subSolid(scheme, corner: 16)
    }
    private func errorCard(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(SubPalette.red)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).subSolid(scheme, corner: 12)
    }
    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in Color.clear.frame(height: 108).subSolid(scheme, corner: AlmaSwiftTheme.rCard) }
    }
    private func fmt(_ n: Double) -> String { "$" + String(format: "%.2f", n) }
}

// MARK: - Editor sheet

@available(iOS 17.0, *)
private struct SubEditor: View {
    let existing: Subscription?
    let vm: SubscriptionsVM
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var plan = ""; @State private var amount = ""
    @State private var currency = "USD"; @State private var cycle = "monthly"; @State private var renewal = Date()
    @State private var payment = ""; @State private var category = ""; @State private var notes = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("সার্ভিস") {
                    TextField("নাম (যেমন Gemini)", text: $name)
                    TextField("প্ল্যান (যেমন Google AI Pro)", text: $plan)
                }
                Section("খরচ") {
                    HStack { Text(currency == "USD" ? "$" : currency); TextField("0.00", text: $amount).keyboardType(.decimalPad) }
                    Picker("Currency", selection: $currency) { Text("USD").tag("USD"); Text("BDT").tag("BDT") }
                    Picker("Billing", selection: $cycle) { Text("মাসিক").tag("monthly"); Text("বার্ষিক").tag("yearly") }
                    DatePicker("পরের রিনিউ", selection: $renewal, displayedComponents: .date)
                }
                Section("অতিরিক্ত") {
                    TextField("Payment (যেমন Visa •••• 4242)", text: $payment)
                    TextField("Category", text: $category)
                    TextField("নোট", text: $notes, axis: .vertical)
                }
                if let existing {
                    Section { Button(role: .destructive) { Task { await vm.delete(existing.id); dismiss() } } label: { Label("এই সাবস্ক্রিপশন মুছুন", systemImage: "trash") } }
                }
            }
            .navigationTitle(existing == nil ? "নতুন সাবস্ক্রিপশন" : "এডিট").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(vm.saving ? "সেভ হচ্ছে…" : "সেভ") { Task { await commit() } }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || vm.saving)
                }
            }
            .onAppear(perform: seed)
        }
        .presentationDetents([.large])
    }
    private func seed() {
        guard let e = existing else { return }
        name = e.name; plan = e.plan ?? ""; amount = String(format: "%.2f", e.amount)
        currency = e.currency; cycle = e.billingCycle; renewal = e.nextRenewalAt ?? Date()
        payment = e.paymentMethod ?? ""; category = e.category ?? ""; notes = e.notes ?? ""
    }
    private func commit() async {
        let payload = SubPayload(name: name.trimmingCharacters(in: .whitespaces), amount: Double(amount) ?? 0, currency: currency,
            billingCycle: cycle, nextRenewalAt: SubFormat.ymd(renewal), category: category.isEmpty ? nil : category,
            notes: notes.isEmpty ? nil : notes, plan: plan.isEmpty ? nil : plan, paymentMethod: payment.isEmpty ? nil : payment)
        if await vm.save(payload, editing: existing?.id) { dismiss() }
    }
}

// MARK: - Press style

@available(iOS 17.0, *)
private struct SubPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.95 : 1).opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}

// MARK: - Formatting

private enum SubFormat {
    static func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func dayMonth(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD"); f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
}

// MARK: - Aurora + materials (page-owned)

@available(iOS 17.0, *)
private struct SubAurora: View {
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
    func subSolid(_ s: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background((s == .dark ? Color(red: 0.078, green: 0.071, blue: 0.114) : .white), in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Color.white.opacity(s == .dark ? 0.055 : 0.6), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.4 : 0.08), radius: 14, y: 8)
    }
    func subRaised(_ s: ColorScheme, corner: CGFloat = 20) -> some View {
        self
            .background(
                (s == .dark
                 ? LinearGradient(colors: [Color(red: 0.106, green: 0.094, blue: 0.149), Color(red: 0.078, green: 0.063, blue: 0.098)], startPoint: .top, endPoint: .bottom)
                 : LinearGradient(colors: [.white, .white], startPoint: .top, endPoint: .bottom)),
                in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Color.white.opacity(s == .dark ? 0.07 : 0.7), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.5 : 0.12), radius: 22, y: 12)
    }
    func subGlass(_ s: ColorScheme, corner: CGFloat = 14) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.06 : 0.35), in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(LinearGradient(colors: [.white.opacity(s == .dark ? 0.3 : 0.85), .white.opacity(s == .dark ? 0.06 : 0.3)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
    }
    func subAppear(_ i: Int) -> some View { modifier(SubAppear(index: i)) }
}

@available(iOS 17.0, *)
private struct SubAppear: ViewModifier {
    let index: Int
    @State private var shown = false
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).offset(y: shown ? 0 : 14)
            .onAppear { withAnimation(.spring(duration: 0.5).delay(Double(min(index, 8)) * 0.05)) { shown = true } }
    }
}

// MARK: - Preview

@available(iOS 17.0, *)
#Preview("Subscriptions — Dark") {
    SubscriptionsScreen(openWeb: { _, _ in }).preferredColorScheme(.dark)
}
