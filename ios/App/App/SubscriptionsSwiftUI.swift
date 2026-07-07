//
//  SubscriptionsSwiftUI.swift
//  ALMA ERP — the owner's personal subscription tracker as a native SwiftUI screen.
//
//  This is a MANUAL ledger (not a live API): the owner records his own recurring
//  services — Gemini, ChatGPT, Claude, Vercel, Supabase, OpenRouter, GitHub,
//  Cloudflare, and anything added later — one card each, fully editable from the
//  phone. The agent can also mutate it in words ("Vercel-এর খরচ $20 করো") because
//  it writes the SAME table through the same endpoints.
//
//  CRUD (owner-only, cookie-bridged via AlmaAPI):
//    GET    /api/assistant/costs/subscriptions        → all rows
//    POST   /api/assistant/costs/subscriptions        → add
//    PATCH  /api/assistant/costs/subscriptions/{id}   → edit
//    DELETE /api/assistant/costs/subscriptions/{id}   → remove
//
//  Status (Active / Expiring / Expired / Free) is DERIVED from amount + nextRenewalAt,
//  so it stays correct without a stored column. `plan` and `paymentMethod` are decoded
//  optionally — they light up when the backend adds those (additive) columns.
//
//  Parallel-session rule: page-owned aurora + glass helpers (no cross-page imports).
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

    static func accentText(_ s: ColorScheme) -> Color {
        s == .dark ? goldLt : Color(red: 0.706, green: 0.333, blue: 0.184)
    }
    /// A stable brand tint from the service name (known brands first, else hashed).
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
        default:
            let h = abs(name.hashValue)
            let hue = Double(h % 360) / 360
            return Color(hue: hue, saturation: 0.5, brightness: 0.85)
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
    let billingCycle: String        // "monthly" | "yearly"
    let nextRenewalAt: Date?
    let category: String?
    let notes: String?
    let active: Bool
    let plan: String?               // optional (backend additive)
    let paymentMethod: String?      // optional (backend additive)

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
    /// Whole-month cost for the summary (yearly ÷ 12).
    var monthlyEquiv: Double { billingCycle == "yearly" ? amount / 12 : amount }
    var symbol: String { currency == "USD" ? "$" : (currency + " ") }
    var priceLabel: String { symbol + String(format: "%.2f", amount) }
    var cycleLabel: String { billingCycle == "yearly" ? "বার্ষিক" : "মাসিক" }
    var planLine: String { plan ?? category ?? billingCycle.capitalized }
}

// MARK: - Editor payload

private struct SubPayload: Encodable {
    var name: String
    var amount: Double
    var currency: String
    var billingCycle: String
    var nextRenewalAt: String?      // yyyy-MM-dd
    var category: String?
    var notes: String?
    var plan: String?
    var paymentMethod: String?
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SubscriptionsVM {
    var subs: [Subscription] = []
    var loading = false
    var saving = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            // The API soft-deletes (active:false); show only live rows so a removed
            // subscription disappears. "Expired" status is derived from the renewal date
            // on rows that are still active.
            let all: [Subscription] = try await AlmaAPI.shared.get("/api/assistant/costs/subscriptions")
            subs = all.filter { $0.active }
            authExpired = false
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
            if let id {
                let _: Subscription = try await AlmaAPI.shared.send("PATCH", "/api/assistant/costs/subscriptions/\(id)", body: payload)
            } else {
                let _: Subscription = try await AlmaAPI.shared.send("POST", "/api/assistant/costs/subscriptions", body: payload)
            }
            await load()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func delete(_ id: String) async {
        struct Ack: Decodable {}
        _ = try? await AlmaAPI.shared.send("DELETE", "/api/assistant/costs/subscriptions/\(id)") as Ack
        await load()
    }

    // ── Derived summary ──
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
                    heroGrid
                    if !vm.upcoming.isEmpty { upcomingStrip }
                    assistantHint
                    statTrio
                    sectionHeader
                    ForEach(vm.subs) { s in subCard(s) }
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editing = nil; showEditor = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showEditor) {
            SubEditor(existing: editing, vm: vm)
        }
    }

    // ── Hero ──
    private var heroGrid: some View {
        HStack(spacing: 11) {
            VStack(alignment: .leading, spacing: 0) {
                Text("মাসিক মোট").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                Text(fmt(vm.monthlyTotal)).font(.system(size: 29, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(SubPalette.accentText(scheme)).lineLimit(1).minimumScaleFactor(0.6).padding(.top, 7)
                Text("\(vm.activeSubs.count)টি সক্রিয় · বছরে ≈ \(fmt(vm.yearlyTotal))")
                    .font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).subGlass(scheme, corner: 19)

            VStack(alignment: .leading, spacing: 0) {
                Text("পরের রিনিউ").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                Text(nextRenewalCountdown).font(.system(size: 26, weight: .bold, design: .rounded))
                    .lineLimit(1).minimumScaleFactor(0.6).padding(.top, 7)
                Text(vm.nextRenewal.map { "\($0.name) · \($0.priceLabel)" } ?? "—")
                    .font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 6).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).subGlass(scheme, corner: 19)
        }
    }
    private var nextRenewalCountdown: String {
        guard let r = vm.nextRenewal?.nextRenewalAt else { return "—" }
        let days = Calendar.current.dateComponents([.day], from: Date(), to: r).day ?? 0
        return days <= 0 ? "আজ" : "\(days) দিন"
    }

    private var upcomingStrip: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("আসন্ন রিনিউ").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5)
                .foregroundStyle(.secondary).padding(.horizontal, 3)
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
                        .padding(.leading, 9).padding(.trailing, 13).padding(.vertical, 9)
                        .subGlass(scheme, corner: 13)
                    }
                }
                .padding(.horizontal, 1)
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
            Image(systemName: "mic.fill").font(.system(size: 15)).foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(LinearGradient(colors: [SubPalette.coral, SubPalette.violet], startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: 10))
            Text("Assistant-কে বলুন — **\"Vercel-এর খরচ $20 করো\"** বা **\"Gemini Pro Plan-এ আপডেট করো\"**। সরাসরি এই হিসাব আপডেট হবে।")
                .font(.system(size: 11.5)).foregroundStyle(.primary)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).subGlass(scheme, corner: 17)
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
        }
        .frame(maxWidth: .infinity).padding(12).subGlass(scheme, corner: 15)
    }

    private var sectionHeader: some View {
        HStack {
            Text("সব সাবস্ক্রিপশন").font(.system(size: 13, weight: .bold))
            Spacer()
            Text("ম্যানুয়াল · \(vm.subs.count)টি").font(.system(size: 10.5)).foregroundStyle(.secondary)
        }.padding(.horizontal, 3).padding(.top, 2)
    }

    // ── Card ──
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
                Label(s.status.label, systemImage: "circle.fill")
                    .font(.system(size: 10, weight: .bold)).foregroundStyle(s.status.color)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(s.status.color.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(s.status.color.opacity(0.28), lineWidth: 1))
                Spacer()
                Button { editing = s; showEditor = true } label: {
                    Image(systemName: "pencil").font(.system(size: 13)).foregroundStyle(.secondary)
                        .frame(width: 29, height: 29).background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(.plain)
            }
            .padding(.top, 12)
            metaGrid(s)
        }
        .padding(16).subGlass(scheme, corner: 20)
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
        }
        .padding(.top, 8)
    }

    private func monogram(_ s: Subscription, size: CGFloat, radius: CGFloat) -> some View {
        let c = SubPalette.brand(s.name)
        return Text(String(s.name.prefix(1)).uppercased())
            .font(.system(size: size * 0.44, weight: .bold, design: .rounded))
            .foregroundStyle(c)
            .frame(width: size, height: size)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(c.opacity(0.4), lineWidth: 1))
    }

    private var addButton: some View {
        Button { editing = nil; showEditor = true } label: {
            Label("নতুন সাবস্ক্রিপশন যোগ করুন", systemImage: "plus")
                .font(.system(size: 13.5, weight: .semibold)).frame(maxWidth: .infinity).padding(15)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5]))
                    .foregroundStyle(.secondary.opacity(0.5)))
        }.buttonStyle(.plain).foregroundStyle(.secondary)
    }

    // ── Shared ──
    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }.frame(maxWidth: .infinity).padding(20).subGlass(scheme, corner: 16)
    }
    private func errorCard(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(SubPalette.red)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).subGlass(scheme, corner: 12)
    }
    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in Color.clear.frame(height: 108).subGlass(scheme, corner: 20) }
    }
    private func fmt(_ n: Double) -> String { "$" + String(format: "%.2f", n) }
}

// MARK: - Editor sheet

@available(iOS 17.0, *)
private struct SubEditor: View {
    let existing: Subscription?
    let vm: SubscriptionsVM
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var plan = ""
    @State private var amount = ""
    @State private var currency = "USD"
    @State private var cycle = "monthly"
    @State private var renewal = Date()
    @State private var payment = ""
    @State private var category = ""
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("সার্ভিস") {
                    TextField("নাম (যেমন Gemini)", text: $name)
                    TextField("প্ল্যান (যেমন Google AI Pro)", text: $plan)
                }
                Section("খরচ") {
                    HStack {
                        Text(currency == "USD" ? "$" : currency)
                        TextField("0.00", text: $amount).keyboardType(.decimalPad)
                    }
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
                    Section {
                        Button(role: .destructive) {
                            Task { await vm.delete(existing.id); dismiss() }
                        } label: { Label("এই সাবস্ক্রিপশন মুছুন", systemImage: "trash") }
                    }
                }
            }
            .navigationTitle(existing == nil ? "নতুন সাবস্ক্রিপশন" : "এডিট")
            .navigationBarTitleDisplayMode(.inline)
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
        let payload = SubPayload(
            name: name.trimmingCharacters(in: .whitespaces),
            amount: Double(amount) ?? 0,
            currency: currency,
            billingCycle: cycle,
            nextRenewalAt: SubFormat.ymd(renewal),
            category: category.isEmpty ? nil : category,
            notes: notes.isEmpty ? nil : notes,
            plan: plan.isEmpty ? nil : plan,
            paymentMethod: payment.isEmpty ? nil : payment)
        if await vm.save(payload, editing: existing?.id) { dismiss() }
    }
}

// MARK: - Formatting

private enum SubFormat {
    static func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func dayMonth(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
}

// MARK: - Aurora + glass (page-owned)

@available(iOS 17.0, *)
private struct SubAurora: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.067, green: 0.067, blue: 0.169), location: 0.0),
                    .init(color: Color(red: 0.141, green: 0.102, blue: 0.271), location: 0.30),
                    .init(color: Color(red: 0.247, green: 0.137, blue: 0.322), location: 0.58),
                    .init(color: Color(red: 0.416, green: 0.184, blue: 0.251), location: 1.0),
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [SubPalette.violet.opacity(0.26), .clear],
                               center: .init(x: 0.14, y: 0.10), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [SubPalette.coral.opacity(0.18), .clear],
                               center: .init(x: 0.9, y: 0.92), startRadius: 20, endRadius: 460)
            } else {
                Color(red: 0.945, green: 0.937, blue: 0.969)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.914, green: 0.894, blue: 0.961), location: 0.0),
                    .init(color: Color(red: 0.945, green: 0.937, blue: 0.969), location: 0.48),
                    .init(color: Color(red: 0.973, green: 0.925, blue: 0.933), location: 1.0),
                ], startPoint: .top, endPoint: .bottom)
            }
        }.ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func subGlass(_ s: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.03 : 0.4),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.08 : 0.5), lineWidth: 1))
    }
}

// MARK: - Preview

@available(iOS 17.0, *)
#Preview("Subscriptions — Dark") {
    SubscriptionsScreen(openWeb: { _, _ in }).preferredColorScheme(.dark)
}
