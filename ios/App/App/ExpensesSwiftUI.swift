//
//  ExpensesSwiftUI.swift
//  ALMA ERP — the Expenses page as a native SwiftUI screen (web parity).
//
//  Mirrors the web /expenses page 1:1 — same endpoint, same colours, same blocks:
//    GET  /api/finance?business_id=ALMA_LIFESTYLE&startDate=…&endDate=…
//         → { total_expenses, cash_balance, by_category, expenses[], recent_expenses[] }
//    POST /api/finance {title, category, amount, payment_status, payment_method,
//         notes, recurring, date, business_id}
//         → SUPER_ADMIN: saved directly · anyone else: routed to the approval
//           center ({ pending_approval: true, message } — Bangla message verbatim).
//  Web-parity blocks: 4 KPI cards (Total expenses (range) / Ledger cash readout /
//  Line items / Active categories) · Expense mix donut (web PALETTE hexes) ·
//  Highest categories · Ledger lines list (date/title/category/৳/receipt/status) ·
//  native add-expense sheet (receipt upload stays on the web — escape hatch).
//  Carried lessons: pull-to-refresh cancellation is never an error; ONE notice
//  line, per-screen spinner only while the list is empty.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum ExpensePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web page's donut PALETTE, verbatim:
    /// ['#E07A5F','#C45A3C','#F4A28C','#B84A30','#8B3A24','#D4694F','#6B2A18']
    static let donut: [Color] = [
        coral,                                                    // #E07A5F
        goldDim,                                                  // #C45A3C
        goldLt,                                                   // #F4A28C
        Color(red: 0.722, green: 0.290, blue: 0.188),             // #B84A30
        Color(red: 0.545, green: 0.227, blue: 0.141),             // #8B3A24
        Color(red: 0.831, green: 0.412, blue: 0.310),             // #D4694F
        Color(red: 0.420, green: 0.165, blue: 0.094),             // #6B2A18
    ]

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Categories (src/lib/expense-categories.ts verbatim — same order)

enum ExpenseCategories {
    static let all: [String] = [
        "office rent", "internet", "electricity", "salary", "marketing",
        "Facebook ads", "software", "courier", "transport", "equipment",
        "miscellaneous",
    ]

    /// One SF symbol per category for the native icon badge squircles.
    static func icon(_ category: String) -> String {
        switch category.lowercased() {
        case "office rent": return "house.fill"
        case "internet": return "wifi"
        case "electricity": return "bolt.fill"
        case "salary": return "banknote.fill"
        case "marketing": return "megaphone.fill"
        case "facebook ads": return "hand.thumbsup.fill"
        case "software": return "laptopcomputer"
        case "courier": return "shippingbox.fill"
        case "transport": return "car.fill"
        case "equipment": return "wrench.and.screwdriver.fill"
        default: return "creditcard.fill"
        }
    }
}

// MARK: - Models (same field names ERPFinanceExpense declares)

struct ExpenseLedgerRow: Decodable, Identifiable, Equatable {
    let id: String                 // web row key: exp_id + date + amount
    let expId: String
    let date: String
    let month: String?
    let category: String
    let businessId: String?
    let subCat: String?
    let expType: String?
    let title: String
    let desc: String?
    let vendor: String?
    let amount: Int
    let paymentMethod: String?
    let paymentStatus: String?
    let receiptRef: String?
    let recurring: Bool?
    let notes: String?

    private enum Keys: String, CodingKey {
        case exp_id, date, month, category, business_id, sub_cat, exp_type
        case title, desc, vendor, amount, payment_method, payment_status
        case receipt_ref, recurring, notes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        expId = (try? c.decode(String.self, forKey: .exp_id)) ?? ""
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        month = try? c.decodeIfPresent(String.self, forKey: .month)
        category = (try? c.decode(String.self, forKey: .category)) ?? "—"
        businessId = try? c.decodeIfPresent(String.self, forKey: .business_id)
        subCat = try? c.decodeIfPresent(String.self, forKey: .sub_cat)
        expType = try? c.decodeIfPresent(String.self, forKey: .exp_type)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        desc = try? c.decodeIfPresent(String.self, forKey: .desc)
        vendor = try? c.decodeIfPresent(String.self, forKey: .vendor)
        amount = Self.flexInt(c, .amount) ?? 0
        paymentMethod = try? c.decodeIfPresent(String.self, forKey: .payment_method)
        paymentStatus = try? c.decodeIfPresent(String.self, forKey: .payment_status)
        receiptRef = try? c.decodeIfPresent(String.self, forKey: .receipt_ref)
        recurring = Self.flexBool(c, .recurring)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        id = "\(expId)|\(date)|\(amount)"
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s).map { Int($0.rounded()) } }
        return nil
    }
    private static func flexBool(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Bool? {
        if let b = try? c.decodeIfPresent(Bool.self, forKey: k) { return b }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) {
            return ["true", "yes", "1", "on"].contains(s.lowercased())
        }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i != 0 }
        return nil
    }

    static func == (a: ExpenseLedgerRow, b: ExpenseLedgerRow) -> Bool { a.id == b.id }
}

struct ExpenseCategoryAmount: Identifiable, Equatable {
    let name: String
    let amount: Int
    var id: String { name }
}

/// GET /api/finance answers flat (no {ok,data} wrap on the lifestyle/GAS paths) —
/// but decode both shapes like the approvals screen does, so a future wrap is safe.
struct ExpensesFinanceResponse: Decodable {
    let totalExpenses: Int
    let cashBalance: Int
    let byCategory: [String: Int]
    let expenses: [ExpenseLedgerRow]

    private enum Keys: String, CodingKey {
        case ok, data, total_expenses, cash_balance, by_category, expenses
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        totalExpenses = Self.flexInt(c, .total_expenses) ?? 0
        cashBalance = Self.flexInt(c, .cash_balance) ?? 0
        let raw = (try? c.decode([String: Double].self, forKey: .by_category)) ?? [:]
        byCategory = raw.mapValues { Int($0.rounded()) }
        expenses = (try? c.decode([ExpenseLedgerRow].self, forKey: .expenses)) ?? []
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s).map { Int($0.rounded()) } }
        return nil
    }
}

/// POST /api/finance verdicts: direct save (SUPER_ADMIN) or approval routing.
struct ExpenseAddResponse: Decodable {
    let ok: Bool?
    let pendingApproval: Bool?
    let message: String?
    let expenseId: String?

    private enum Keys: String, CodingKey { case ok, pending_approval, message, expense_id }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        pendingApproval = try? c.decodeIfPresent(Bool.self, forKey: .pending_approval)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        expenseId = try? c.decodeIfPresent(String.self, forKey: .expense_id)
    }
}

/// The exact JSON body the web form submits (receipt fields omitted — receipt
/// upload is multipart and stays on the web escape hatch).
struct ExpenseCreateBody: Encodable {
    let title: String
    let category: String
    let amount: Int
    let paymentStatus: String
    let paymentMethod: String
    let notes: String
    let recurring: Bool
    let date: String
    let businessId: String

    private enum CodingKeys: String, CodingKey {
        case title, category, amount, notes, recurring, date
        case paymentStatus = "payment_status"
        case paymentMethod = "payment_method"
        case businessId = "business_id"
    }
}

/// Native add-expense form state (web modal fields, minus the receipt drop zone).
struct ExpenseDraft {
    var title = ""
    var category = ""
    var amountText = ""
    var date = Date()
    var paymentStatus = "Paid"       // web options: Paid | Pending | Partial
    var paymentMethod = ""
    var notes = ""
    var recurring = false

    var amount: Int? {
        let trimmed = amountText.trimmingCharacters(in: .whitespaces)
        if let i = Int(trimmed) { return i }
        if let d = Double(trimmed) { return Int(d.rounded()) }   // whole-taka rule
        return nil
    }
    var valid: Bool { !category.isEmpty && (amount ?? 0) > 0 }   // web: category+amount required
}

// MARK: - Date window (the web's global date-range context, as native chips)

enum ExpensesDateFilter: String, CaseIterable {
    case thisMonth, today, last7, last30, lastMonth

    var label: String {
        switch self {
        case .thisMonth: return "This month"
        case .today: return "Today"
        case .last7: return "Last 7 days"
        case .last30: return "Last 30 days"
        case .lastMonth: return "Last month"
        }
    }

    /// (startDate, endDate) as YYYY-MM-DD in Asia/Dhaka — same params the web sends.
    var range: (String, String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = cal.timeZone
        let today = cal.startOfDay(for: Date())
        func d(_ x: Date) -> String { fmt.string(from: x) }
        switch self {
        case .today: return (d(today), d(today))
        case .last7: return (d(cal.date(byAdding: .day, value: -6, to: today)!), d(today))
        case .last30: return (d(cal.date(byAdding: .day, value: -29, to: today)!), d(today))
        case .thisMonth:
            let first = cal.date(from: cal.dateComponents([.year, .month], from: today))!
            return (d(first), d(today))
        case .lastMonth:
            let firstThis = cal.date(from: cal.dateComponents([.year, .month], from: today))!
            let firstLast = cal.date(byAdding: .month, value: -1, to: firstThis)!
            let endLast = cal.date(byAdding: .day, value: -1, to: firstThis)!
            return (d(firstLast), d(endLast))
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class ExpensesVM {
    var expenses: [ExpenseLedgerRow] = []
    var totalExpenses = 0
    var cashBalance = 0
    var byCategory: [ExpenseCategoryAmount] = []   // sorted high → low (web sort)
    var dateFilter: ExpensesDateFilter = .thisMonth
    var categoryFilter = "ALL"
    var loading = false
    var saving = false
    var error: String? = nil
    var notice: String? = nil
    var authExpired = false

    var filtered: [ExpenseLedgerRow] {
        categoryFilter == "ALL" ? expenses : expenses.filter { $0.category == categoryFilter }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let (start, end) = dateFilter.range
            let resp: ExpensesFinanceResponse = try await AlmaAPI.shared.get(
                "/api/finance",
                query: ["business_id": "ALMA_LIFESTYLE", "startDate": start, "endDate": end])
            expenses = resp.expenses
            totalExpenses = resp.totalExpenses
            cashBalance = resp.cashBalance
            byCategory = resp.byCategory
                .map { ExpenseCategoryAmount(name: $0.key, amount: $0.value) }
                .sorted { $0.amount > $1.amount }
            if categoryFilter != "ALL" && !byCategory.contains(where: { $0.name == categoryFilter }) {
                categoryFilter = "ALL"   // the window changed and the filter vanished
            }
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

    /// POST the same body the web form submits. SUPER_ADMIN saves directly;
    /// everyone else is routed to the approval center — surface the server's
    /// Bangla message verbatim in that case.
    func add(_ draft: ExpenseDraft) async -> Bool {
        guard let amount = draft.amount, draft.valid else {
            error = "Category and amount are required"   // web toast, verbatim
            return false
        }
        saving = true
        notice = nil
        error = nil
        defer { saving = false }
        do {
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
            let body = ExpenseCreateBody(
                title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                category: draft.category,
                amount: amount,
                paymentStatus: draft.paymentStatus,
                paymentMethod: draft.paymentMethod.trimmingCharacters(in: .whitespacesAndNewlines),
                notes: draft.notes.trimmingCharacters(in: .whitespacesAndNewlines),
                recurring: draft.recurring,
                date: fmt.string(from: draft.date),
                businessId: "ALMA_LIFESTYLE")
            let resp: ExpenseAddResponse = try await AlmaAPI.shared.send("POST", "/api/finance", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            if resp.pendingApproval == true {
                notice = resp.message ?? "খরচটি অনুমোদনের জন্য পাঠানো হয়েছে। অনুমোদন হলে যোগ হবে।"
            } else {
                notice = "Expense recorded"              // web toast, verbatim
            }
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = "Could not record expense. Please try again."   // web toast, verbatim
            return false
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct ExpensesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = ExpensesVM()
    @State private var selected: ExpenseLedgerRow? = nil
    @State private var adding = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                headerRow
                dateChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                kpiStrip
                if vm.loading && vm.expenses.isEmpty {
                    loadingRows
                } else {
                    if !vm.byCategory.isEmpty {
                        mixCard
                        highestCategoriesCard
                    }
                    ledgerHeader
                    categoryChips
                    ForEach(vm.filtered) { row in
                        ExpenseRowCard(row: row) {
                            selected = row
                        }
                    }
                    if vm.filtered.isEmpty && !vm.authExpired && vm.error == nil {
                        emptyState
                    }
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(ExpensesAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { row in
            ExpenseDetailSheet(row: row, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $adding) {
            ExpenseAddSheet(vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header: title line + "+ Add expense" (web header action) ──

    private var headerRow: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Expenses").font(.headline.weight(.bold))
                // Web subtitle, verbatim.
                Text("Operational spend · approvals · attachments")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                adding = true
            } label: {
                Label("Add expense", systemImage: "plus")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ExpensePalette.accentText(colorScheme))
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(ExpensePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14),
                                in: Capsule())
                    .overlay(Capsule().strokeBorder(ExpensePalette.coral.opacity(0.55), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 4)
    }

    // ── Date-window chips (the web's global range picker) ──

    private var dateChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ExpensesDateFilter.allCases, id: \.self) { f in
                    expenseChip(f.label, active: vm.dateFilter == f) {
                        vm.dateFilter = f
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // ── KPI strip (web's 4 KpiCards, exact labels) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("TOTAL EXPENSES (RANGE)",
                        vm.loading && vm.expenses.isEmpty ? "—" : AlmaSwiftTheme.takaShort(vm.totalExpenses),
                        ExpensePalette.goldLt)
                kpiCard("LEDGER CASH READOUT",
                        vm.loading && vm.expenses.isEmpty ? "—" : AlmaSwiftTheme.takaShort(vm.cashBalance),
                        .primary)
                kpiCard("LINE ITEMS", "\(vm.expenses.count)", .primary)
                kpiCard("ACTIVE CATEGORIES", "\(vm.byCategory.count)", .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold).monospacedDigit()).foregroundStyle(tint)
        }
        .frame(minWidth: 96, alignment: .leading)
        .padding(12)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Expense mix (web donut card, same palette) ──

    private var mixCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Expense mix").font(.footnote.weight(.bold))
            ExpensesDonut(slices: vm.byCategory, total: vm.totalExpenses)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Web "Highest categories": top 12, category left, ৳ amount right (gold mono).
    private var highestCategoriesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Highest categories").font(.footnote.weight(.bold))
            ForEach(Array(vm.byCategory.prefix(12).enumerated()), id: \.element.id) { i, cat in
                HStack(spacing: 8) {
                    Circle()
                        .fill(ExpensePalette.donut[i % ExpensePalette.donut.count])
                        .frame(width: 8, height: 8)
                    Text(cat.name).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("৳ \(cat.amount.formatted())")
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(ExpensePalette.accentText(colorScheme))
                }
                .padding(.bottom, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Ledger lines ──

    private var ledgerHeader: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Ledger lines").font(.footnote.weight(.bold))
            Spacer()
            Text(vm.dateFilter.label).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }

    /// Native extra: filter the ledger by category (client-side, like tapping a
    /// donut slice) — All + the categories present in this window.
    @ViewBuilder private var categoryChips: some View {
        if !vm.byCategory.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    expenseChip("All", active: vm.categoryFilter == "ALL") {
                        withAnimation(.snappy) { vm.categoryFilter = "ALL" }
                    }
                    ForEach(vm.byCategory) { cat in
                        expenseChip(cat.name, active: vm.categoryFilter == cat.name) {
                            withAnimation(.snappy) {
                                vm.categoryFilter = vm.categoryFilter == cat.name ? "ALL" : cat.name
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            // Web Empty copy, verbatim.
            Text("No expenses").foregroundStyle(.secondary)
            Text("Relax filters or capture your first receipt")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 50)
        .padding(.bottom, 30)
    }

    // ── Shared bits ──

    private func expenseChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? ExpensePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? ExpensePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? ExpensePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", ExpensePalette.red500)
        case .success: ("checkmark.circle", ExpensePalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).expensesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 84)
                .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .expensesShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/expenses", "Expenses")
        } label: {
            Label("সব অপশন (PDF/CSV/রিসিট আপলোড সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Donut (web DonutChart parity, drawn natively with trimmed circles)

@available(iOS 17.0, *)
private struct ExpenseDonutSlice: Identifiable {
    let id: String
    let start: CGFloat
    let end: CGFloat
    let color: Color
}

@available(iOS 17.0, *)
private struct ExpensesDonut: View {
    let slices: [ExpenseCategoryAmount]
    let total: Int
    @Environment(\.colorScheme) private var colorScheme
    @State private var appeared = false

    private var arcs: [ExpenseDonutSlice] {
        let sum = max(1, slices.reduce(0) { $0 + $1.amount })
        var cursor: CGFloat = 0
        return slices.enumerated().map { i, s in
            let frac = CGFloat(s.amount) / CGFloat(sum)
            defer { cursor += frac }
            return ExpenseDonutSlice(id: s.name, start: cursor, end: cursor + frac,
                                     color: ExpensePalette.donut[i % ExpensePalette.donut.count])
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            ZStack {
                Circle()
                    .stroke(Color.primary.opacity(0.06), lineWidth: 18)
                ForEach(arcs) { arc in
                    Circle()
                        .trim(from: arc.start, to: appeared ? arc.end : arc.start)
                        .stroke(arc.color, style: StrokeStyle(lineWidth: 18, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
                VStack(spacing: 1) {
                    Text(AlmaSwiftTheme.takaShort(total))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(ExpensePalette.accentText(colorScheme))
                    Text("total").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(width: 124, height: 124)
            .onAppear {
                withAnimation(.spring(duration: 0.7, bounce: 0.12)) { appeared = true }
            }

            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(slices.prefix(5).enumerated()), id: \.element.id) { i, s in
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(ExpensePalette.donut[i % ExpensePalette.donut.count])
                            .frame(width: 9, height: 9)
                        Text(s.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(AlmaSwiftTheme.takaShort(s.amount))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                    }
                }
                if slices.count > 5 {
                    Text("+ \(slices.count - 5) more").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

// MARK: - Row card (mirrors one web table row / mobile card)

@available(iOS 17.0, *)
private struct ExpenseRowCard: View {
    let row: ExpenseLedgerRow
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            iconBadge
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title.isEmpty ? row.category : row.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(ExpensesFormat.day(row.date))
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    Text(row.category).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    if row.recurring == true {
                        Image(systemName: "repeat")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    if let ref = row.receiptRef, !ref.isEmpty {
                        // Web: green "Attachment" pill.
                        Text("Attachment")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(ExpensePalette.green400)
                            .padding(.horizontal, 6).padding(.vertical, 1.5)
                            .background(ExpensePalette.green400.opacity(0.10), in: Capsule())
                            .overlay(Capsule().strokeBorder(ExpensePalette.green400.opacity(0.25), lineWidth: 0.8))
                    }
                    if let status = row.paymentStatus, !status.isEmpty {
                        Text(status)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(status == "Paid" ? Color.secondary : ExpensePalette.amber600)
                    }
                }
            }
            Spacer(minLength: 6)
            Text("৳\(row.amount.formatted())")
                .font(.footnote.weight(.bold).monospacedDigit())
                .foregroundStyle(ExpensePalette.goldLt)
        }
        .padding(12)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Squircle icon badge — coral→violet gradient, one SF symbol per category.
    private var iconBadge: some View {
        Image(systemName: ExpenseCategories.icon(row.category))
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(colors: [ExpensePalette.coral, AlmaSwiftTheme.violet],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: ExpensePalette.coral.opacity(0.35), radius: 5, y: 2)
    }
}

// MARK: - Detail sheet

@available(iOS 17.0, *)
private struct ExpenseDetailSheet: View {
    let row: ExpenseLedgerRow
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoCard
                receiptBlock
                webLink
            }
            .padding(18)
        }
        .presentationBackground { ExpensesAurora() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: ExpenseCategories.icon(row.category))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(
                    LinearGradient(colors: [ExpensePalette.coral, AlmaSwiftTheme.violet],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title.isEmpty ? row.category : row.title).font(.headline)
                Text("\(row.category) · \(ExpensesFormat.day(row.date))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var infoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Amount", "৳\(row.amount.formatted())",
                    color: ExpensePalette.accentText(colorScheme))
            infoRow("Status", row.paymentStatus ?? "—")
            infoRow("Payment method", row.paymentMethod ?? "—")
            if let vendor = row.vendor, !vendor.isEmpty { infoRow("Vendor", vendor) }
            if let type = row.expType, !type.isEmpty { infoRow("Type", type) }
            if let sub = row.subCat, !sub.isEmpty { infoRow("Sub-category", sub) }
            if row.recurring == true { infoRow("Recurring", "Yes") }
            if let notes = row.notes, !notes.isEmpty { infoRow("Notes", notes) }
            if let desc = row.desc, !desc.isEmpty, desc != row.notes { infoRow("Description", desc) }
            if !row.expId.isEmpty { infoRow("Entry ID", row.expId) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }

    /// Web: the Attachment button opens the receipt URL in a new tab.
    @ViewBuilder private var receiptBlock: some View {
        if let ref = row.receiptRef, !ref.isEmpty {
            if ref.hasPrefix("http"), let url = URL(string: ref) {
                Link(destination: url) {
                    Label("রিসিট দেখুন (Attachment)", systemImage: "paperclip")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ExpensePalette.green400)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(ExpensePalette.green400.opacity(0.10), in: Capsule())
                        .overlay(Capsule().strokeBorder(ExpensePalette.green400.opacity(0.30), lineWidth: 1))
                }
            } else {
                Button {
                    dismiss()
                    openWeb(ref.hasPrefix("/") ? ref : "/expenses", "Receipt")
                } label: {
                    Label("রিসিট দেখুন (Attachment)", systemImage: "paperclip")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ExpensePalette.green400)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(ExpensePalette.green400.opacity(0.10), in: Capsule())
                        .overlay(Capsule().strokeBorder(ExpensePalette.green400.opacity(0.30), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/expenses", "Expenses")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Add-expense sheet (web "Add expense" modal, minus the receipt drop zone —
// receipt upload is multipart + camera capture, kept on the web escape hatch)

@available(iOS 17.0, *)
private struct ExpenseAddSheet: View {
    let vm: ExpensesVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var draft = ExpenseDraft()
    @State private var confirming = false
    @FocusState private var focusedField: Field?

    private enum Field { case title, amount, method, notes }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Add expense").font(.headline)

                fieldBlock("Title") {
                    TextField("e.g. Office internet bill", text: $draft.title)
                        .focused($focusedField, equals: .title)
                }

                categoryPicker

                HStack(spacing: 10) {
                    fieldBlock("Amount (৳)") {
                        TextField("0", text: $draft.amountText)
                            .keyboardType(.numberPad)
                            .focused($focusedField, equals: .amount)
                            .font(.body.monospacedDigit())
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text("PAYMENT DATE").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        DatePicker("", selection: $draft.date, in: ...Date(), displayedComponents: .date)
                            .labelsHidden()
                            .datePickerStyle(.compact)
                    }
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("PAYMENT STATUS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    Picker("Payment status", selection: $draft.paymentStatus) {
                        Text("Paid").tag("Paid")
                        Text("Pending").tag("Pending")
                        Text("Partial").tag("Partial")
                    }
                    .pickerStyle(.segmented)
                }

                fieldBlock("Payment method") {
                    TextField("bKash, bank…", text: $draft.paymentMethod)
                        .focused($focusedField, equals: .method)
                }

                Toggle(isOn: $draft.recurring) {
                    Text("Recurring").font(.footnote.weight(.semibold))
                }
                .tint(ExpensePalette.coral)

                fieldBlock("Notes") {
                    TextField("Notes", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...4)
                        .focused($focusedField, equals: .notes)
                }

                receiptHint

                saveRow
                Spacer(minLength: 10)
            }
            .padding(18)
        }
        .presentationBackground { ExpensesAurora() }
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog(confirmText, isPresented: $confirming, titleVisibility: .visible) {
            Button("Save expense") {
                let d = draft
                dismiss()
                Task { _ = await vm.add(d) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var confirmText: String {
        "৳\((draft.amount ?? 0).formatted()) · \(draft.category) — সেভ করবেন?"
    }

    private func fieldBlock<Content: View>(_ label: String,
                                           @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased()).font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            content()
                .padding(11)
                .expensesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private var categoryPicker: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("CATEGORY").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ExpenseCategories.all, id: \.self) { cat in
                        let active = draft.category == cat
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            withAnimation(.snappy) { draft.category = active ? "" : cat }
                        } label: {
                            Label(cat, systemImage: ExpenseCategories.icon(cat))
                                .font(.caption.weight(active ? .semibold : .regular))
                                .foregroundStyle(active ? ExpensePalette.accentText(colorScheme) : .secondary)
                                .padding(.horizontal, 10).padding(.vertical, 7)
                                .background(active ? ExpensePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                                            in: Capsule())
                                .overlay(Capsule().strokeBorder(
                                    active ? ExpensePalette.coral.opacity(0.55)
                                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                                    lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private var receiptHint: some View {
        Button {
            dismiss()
            openWeb("/expenses", "Expenses")
        } label: {
            Label("রিসিট/ছবি যুক্ত করতে হলে — ওয়েবে খুলুন", systemImage: "paperclip")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    private var saveRow: some View {
        VStack(spacing: 6) {
            if !draft.valid {
                // Web toast, verbatim — shown inline before the button enables.
                Text("Category and amount are required")
                    .font(.caption2).foregroundStyle(ExpensePalette.amber600)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    confirming = true
                } label: {
                    Text(vm.saving ? "Saving…" : "Save expense")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(ExpensePalette.coral)
                .disabled(!draft.valid || vm.saving)

                Button {
                    dismiss()
                } label: {
                    Text("Cancel")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.top, 4)
    }
}

// MARK: - Formatting helpers

private enum ExpensesFormat {
    /// Web ledger column: er.date.slice(0, 10).
    static func day(_ date: String) -> String {
        String(date.prefix(10))
    }
}

// MARK: - Aurora background + glass (Expenses-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct ExpensesAurora: View {
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
    func expensesGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct ExpensesShimmer: ViewModifier {
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
    func expensesShimmer() -> some View { modifier(ExpensesShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Expenses — Light") {
    ExpensesScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
