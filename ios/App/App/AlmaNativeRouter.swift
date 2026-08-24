//
//  AlmaNativeRouter.swift
//  ALMA ERP — S6: route-path → native SwiftUI screen map.
//
//  The More menu (and any other web push) consults this router first: if a page has
//  been migrated, the SAME row opens the native screen instead of a WKWebView — no
//  per-row wiring, one additive case per migrated page. Screens receive a FORCED-web
//  escape closure (never routed back through here), so a screen's "ওয়েবে খুলুন"
//  button can never recurse into itself.
//
//  Parallel-session note: this file is owned by the integration owner. Page sessions
//  do NOT edit it — they ship their <Page>SwiftUI.swift and the owner adds one case.
//

import SwiftUI
import UIKit

@available(iOS 17.0, *)
enum AlmaNativeRouter {

    /// Native screen for an ERP route path, or nil → open the web view as before.
    /// `openWebForced` must push a real WKWebView (never consult this router).
    @MainActor
    static func screen(for path: String,
                       openWebForced: @escaping (_ path: String, _ title: String) -> Void)
        -> UIViewController? {
        // Strip query/fragment — the map is keyed on bare route paths.
        let clean = path.split(separator: "?").first.map(String.init) ?? path

        func host<V: View>(_ view: V, _ title: String, takeover: Bool = false) -> UIViewController {
            let h = AlmaHostingController(rootView: view)
            h.title = title
            h.hidesBottomBarWhenPushed = false
            // Full-takeover screens draw their own header; the shell's nav
            // controller hides the bar for them and restores it for everything
            // else (see AlmaNavigationController).
            h.almaHidesNavigationBar = takeover
            // The More tab's nav has prefersLargeTitles=true; a pushed SwiftUI host in
            // large-title mode renders an EMPTY expanded bar (big gap, no visible page
            // name — owner-reported 2026-07-06). Force the compact INLINE title so every
            // pushed native screen shows its name centred in the bar, no gap.
            h.navigationItem.largeTitleDisplayMode = .never
            return h
        }

        // NP-4 (AU-02): the reset link is the ONE route whose query must survive —
        // the token rides ?token=… and lives only in view state (never logged).
        if clean == "/reset-password" {
            let token = path.split(separator: "?").dropFirst().first.flatMap {
                URLComponents(string: "https://x/?\($0)")?.queryItems?
                    .first { $0.name == "token" }?.value
            }
            return host(ResetPasswordScreen(token: token, openWeb: openWebForced), "Reset password")
        }

        switch clean {
        // Cases are appended batch-by-batch as pages migrate (S6 marathon).
        case "/", "/dashboard": return host(DashboardScreen(openWeb: openWebForced), "Dashboard")
        // Owner 2026-07-11: login goes NATIVE — every authCard's "লগইন খুলুন" push lands
        // here via pushSmart; the screen's own "ওয়েবে লগইন" fallback stays forced-web.
        case "/login": return host(NativeLoginScreen(onSuccess: {}, openWeb: openWebForced), "Sign in", takeover: true)
        // S8 audit fix: the three tab pages were reachable natively ONLY as tab roots —
        // any cross-page link (Dashboard "সব দেখুন" → /orders, briefing → /approvals)
        // fell through to the web view. One case each closes that hole.
        case "/orders":
            let focusOrderId = queryValue(path, name: "focus")
            guard let businessId = scopedBusinessId(path, expected: "ALMA_LIFESTYLE") else {
                return nil
            }
            // Preserve existing query behaviour such as /orders?q=…: only the
            // typed `focus` query belongs to the native detail contract.
            if path.dropFirst(clean.count).count > 1,
               focusOrderId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                return nil
            }
            return host(OrdersScreen(
                openWeb: openWebForced,
                focusOrderId: focusOrderId,
                businessId: businessId), "Orders")
        case "/orders/new": return host(OrderCreateSheet(onCreated: {}, openWeb: openWebForced), "নতুন অর্ডার")
        case "/approvals": return host(ApprovalsScreen(openWeb: openWebForced), "Approvals")
        case "/finance": return host(FinanceScreen(openWeb: openWebForced), "Finance")
        case "/invoice": return host(InvoicesScreen(openWeb: openWebForced), "Invoices")
        case "/expenses": return host(ExpensesScreen(openWeb: openWebForced), "Expenses")
        case "/payroll": return host(PayrollScreen(openWeb: openWebForced), "Payroll")
        case "/finance/office-fund": return host(OfficeFundScreen(openWeb: openWebForced), "Office fund")
        case "/finance/personal-ledger": return host(PersonalLedgerScreen(), "পাওনা-দেনা")
        case "/activity": return host(ActivityScreen(openWeb: openWebForced), "Activity")
        case "/inventory": return host(InventoryScreen(openWeb: openWebForced), "Inventory")
        case "/employees": return host(EmployeesScreen(openWeb: openWebForced), "Employees")
        case "/attendance": return host(AttendanceScreen(openWeb: openWebForced), "Attendance")
        case "/crm": return host(CrmScreen(openWeb: openWebForced), "CRM")
        case "/audit": return host(AuditScreen(openWeb: openWebForced), "Audit")
        case "/analytics": return host(AnalyticsScreen(openWeb: openWebForced), "Analytics")
        case "/insights": return host(InsightsScreen(openWeb: openWebForced), "Insights")
        case "/briefing": return host(BriefingScreen(openWeb: openWebForced), "Briefing")
        case "/operations/task-spotlight": return host(TaskSpotlightScreen(openWeb: openWebForced), "Task Spotlight")
        case "/operations/business-archive": return host(BusinessArchiveScreen(openWeb: openWebForced), "Business archive")
        case "/operations/system-diagnostics": return host(SystemDiagnosticsScreen(openWeb: openWebForced), "System diagnostics")
        case "/portal/payment-accounts": return host(PaymentAccountsScreen(openWeb: openWebForced), "Payment accounts")
        case "/portal/expense": return host(PortalExpenseScreen(openWeb: openWebForced), "Portal expense")
        case "/settings/notifications": return host(SettingsNotifScreen(openWeb: openWebForced), "Notifications")
        case "/settings/users": return host(SettingsUsersScreen(openWeb: openWebForced), "Users")
        case "/inventory/supplier-import": return host(SupplierImportScreen(openWeb: openWebForced), "Supplier import")
        case "/portal/office": return host(PortalOfficeScreen(openWeb: openWebForced), "Office")
        case "/portal": return host(PortalScreen(openWeb: openWebForced), "My Desk")
        case "/settings/database": return host(SettingsDatabaseScreen(openWeb: openWebForced), "Database")
        case "/settings/sms": return host(SettingsSmsScreen(openWeb: openWebForced), "SMS")
        case "/settings/branding": return host(SettingsBrandingScreen(openWeb: openWebForced), "Branding")
        case "/settings/session": return host(SettingsSessionScreen(openWeb: openWebForced), "Session")
        case "/settings/telegram-ops": return host(SettingsTelegramScreen(openWeb: openWebForced), "Telegram Ops")
        case "/agent/costs", "/agent/credit-usage": return host(CreditUsageScreen(openWeb: openWebForced), "Credit Usage")
        case "/agent/subscriptions": return host(SubscriptionsScreen(openWeb: openWebForced), "Subscriptions")
        case "/agent/whatsapp": return host(AgentWhatsappScreen(openWeb: openWebForced), "WhatsApp inbox")
        case "/agent/catalog-images": return host(CatalogImagesScreen(openWeb: openWebForced), "Product Images")
        case "/agent/creative-studio": return host(CreativeStudioScreen(openWeb: openWebForced), "Creative Studio", takeover: true)
        // The VPS browser, live. Distinct from /agent/live-watch, which watches the
        // companion inside the owner's OWN Chrome — different machine, different feed.
        case "/agent/browser-live": return host(BrowserLiveScreen(), "Live Browser")
        case "/agent/trading-staff": return host(TradingStaffScreen(openWeb: openWebForced), "Trading staff")
        case "/agent/known-people": return host(KnownPeopleScreen(openWeb: openWebForced), "Known people")
        // A Meta Ads push lands as /agent/growth?rec=<id> — the query normally dies
        // at `clean`, so the tapped recommendation would open to nothing. Carry the
        // id through and the native inbox opens ON that event.
        case "/agent/growth":
            return host(AgentGrowthScreen(focusRecId: queryValue(path, name: "rec"),
                                          openWeb: openWebForced), "Growth")
        case "/agent/staff-monitor":
            #if DEBUG
            // Headless sim self-test hook: SIMCTL_CHILD_ALMA_SM_TAB=agents|system|…
            // lands the Monitor on that tab so each tab can be screenshot-verified
            // without driving the UI. DEBUG builds only — never ships.
            if let raw = ProcessInfo.processInfo.environment["ALMA_SM_TAB"],
               let t = StaffMonitorTab(rawValue: raw) {
                return host(StaffMonitorScreen(openWeb: openWebForced, initialTab: t), "LIVE Business")
            }
            #endif
            return host(StaffMonitorScreen(openWeb: openWebForced), "LIVE Business")
        // Owner feedback 2026-07-17: Live Watch is its OWN focused screen (live
        // browser hero) — visually distinct from the Monitor; same data source.
        case "/agent/live-watch":
            return host(LiveWatchScreen(openWeb: openWebForced), "Live Watch")
        // NP-1 (AG-09): canonical Agent Hub — every Agent surface in one visible menu.
        case "/agent/hub": return host(AgentHubScreen(openWeb: openWebForced), "Agent Hub")
        // NP-4 (AU-01 / FN-01): native auth recovery + wallet deep link.
        case "/forgot-password": return host(ForgotPasswordScreen(openWeb: openWebForced), "Password reset")
        case "/portal/wallet": return host(PortalWalletRouteScreen(openWeb: openWebForced), "ওয়ালেট")
        // Trading business (S7 batch — Trading + Digital go native, 2026-07-10)
        case "/trading": return host(TradingHomeScreen(openWeb: openWebForced), "Trading")
        case "/trading/accounts": return host(TradingAccountsScreen(openWeb: openWebForced), "Trading accounts")
        case "/trading/analytics": return host(TradingAnalyticsScreen(openWeb: openWebForced), "Trading analytics")
        case "/trading/hr": return host(TradingHrScreen(openWeb: openWebForced), "Trading HR")
        case "/trading/target-control": return host(TargetControlScreen(openWeb: openWebForced), "Target control")
        case "/trading/telegram": return host(TradingTelegramScreen(openWeb: openWebForced), "Telegram Quick Entry")
        // Digital (CDIT) business
        case "/digital": return host(DigitalHomeScreen(openWeb: openWebForced), "CDIT")
        case "/digital/clients": return host(DigitalClientsScreen(openWeb: openWebForced), "CDIT clients")
        case "/digital/invoices": return host(DigitalInvoicesScreen(openWeb: openWebForced), "CDIT invoices")
        case "/digital/projects": return host(DigitalProjectsScreen(openWeb: openWebForced), "CDIT projects")
        // /digital/finance is a server redirect to /finance — serve the native Finance screen directly.
        case "/digital/finance": return host(FinanceScreen(openWeb: openWebForced), "Finance")
        default:
            // Parameterized routes — exact cases above can't match /page/{id} paths,
            // so entity links (approvals/payroll name taps → /employees/{empId},
            // project rows → /digital/clients/{id}) used to fall through to the WEB
            // view (owner report 2026-07-15: "native app must never jump to web").
            // The native list screen opens with that entity's detail sheet focused.
            if let orderId = pathParam(clean, after: "/orders/") {
                guard let businessId = scopedBusinessId(path, expected: "ALMA_LIFESTYLE") else {
                    return nil
                }
                return host(OrdersScreen(
                    openWeb: openWebForced,
                    focusOrderId: orderId,
                    businessId: businessId), "Order")
            }
            if let empId = pathParam(clean, after: "/employees/") {
                // Employees is a SHARED route: a legacy queryless link (Payroll /
                // Approvals name taps) keeps the business the shell is in, so a
                // Trading roster tap opens the Trading employee (Codex P1, round 3).
                // A stamped selector must still match the canonical Lifestyle link.
                guard let businessId = scopedBusinessId(
                    path, expected: "ALMA_LIFESTYLE", legacyDefault: AlmaAccess.Context.currentId) else {
                    return nil
                }
                return host(EmployeesScreen(
                    openWeb: openWebForced,
                    focusEmpId: empId,
                    businessId: businessId), "Employee")
            }
            if let clientId = pathParam(clean, after: "/digital/clients/") {
                return host(DigitalClientsScreen(openWeb: openWebForced, focusClientId: clientId), "Client")
            }
            // IOSP-1: trading account detail links (/trading/accounts/{id}) were the
            // last audited dynamic route still falling to web — the native list
            // opens with that account's detail sheet focused.
            if let accountId = pathParam(clean, after: "/trading/accounts/") {
                guard scopedBusinessId(path, expected: "ALMA_TRADING") != nil else {
                    return nil
                }
                return host(TradingAccountsScreen(openWeb: openWebForced, focusAccountId: accountId), "Trading account")
            }
            if let reference = referenceParams(clean, after: "/agent/references/") {
                let businessId = queryValue(path, name: "business_id")
                if let businessId,
                   !["ALMA_LIFESTYLE", "CREATIVE_DIGITAL_IT", "ALMA_TRADING"].contains(businessId) {
                    return nil
                }
                return host(AgentReferenceFocusScreen(
                    namespace: reference.namespace,
                    entityId: reference.id,
                    businessId: businessId), "Reference")
            }
            return nil
        }
    }

    /// One query value off a route path ("/agent/growth?rec=abc" + "rec" → "abc").
    /// Returns nil when the path carries no query or the name isn't present.
    private static func queryValue(_ path: String, name: String) -> String? {
        guard let query = path.split(separator: "?").dropFirst().first else { return nil }
        return URLComponents(string: "https://x/?\(query)")?
            .queryItems?.first { $0.name == name }?.value
    }

    /// Canonical entity links may carry a business selector. Missing selectors
    /// remain valid for legacy internal links; present selectors must match the
    /// route's fixed business before any native model can fetch.
    private static func scopedBusinessId(_ path: String, expected: String,
                                         legacyDefault: String? = nil) -> String? {
        guard let selected = queryValue(path, name: "business_id") else { return legacyDefault ?? expected }
        return selected == expected ? selected : nil
    }

    /// "/employees/EMP-51" after "/employees/" → "EMP-51"; nil when the prefix
    /// doesn't match or the remainder is empty / has more path segments.
    private static func pathParam(_ path: String, after prefix: String) -> String? {
        guard path.hasPrefix(prefix) else { return nil }
        let rest = String(path.dropFirst(prefix.count))
        guard !rest.isEmpty, !rest.contains("/") else { return nil }
        return rest.removingPercentEncoding ?? rest
    }

    /// Closed two-segment parser for the provider-neutral reference focus route.
    /// Both values use the same identifier alphabet as the server registry; a
    /// crafted URL cannot smuggle a slash/query into the authenticated API path.
    private static func referenceParams(
        _ path: String, after prefix: String
    ) -> (namespace: String, id: String)? {
        guard path.hasPrefix(prefix) else { return nil }
        let parts = path.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let namespace = String(parts[0]).removingPercentEncoding ?? String(parts[0])
        let id = String(parts[1]).removingPercentEncoding ?? String(parts[1])
        let safe = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
        guard namespace.range(of: safe, options: .regularExpression) != nil,
              id.range(of: safe, options: .regularExpression) != nil else { return nil }
        return (namespace, id)
    }
}

// MARK: - Exact, read-only provider-neutral reference focus

private struct AgentReferenceFocusPayload: Decodable {
    let state: String
    let entity: AgentReferenceFocusEntity?
}

private struct AgentReferenceFocusEntity: Decodable {
    let id: String
    let title: String
    let label: String
    let status: String
    let fallbackPath: String
    let fields: [String: AgentJSONValue]
}

@available(iOS 17.0, *)
private struct AgentReferenceFocusScreen: View {
    let namespace: String
    let entityId: String
    let businessId: String?

    private enum LoadState {
        case loading
        case found(AgentReferenceFocusEntity)
        case deleted
        case forbidden
        case notFound
        case failed
    }

    @Environment(\.colorScheme) private var scheme
    @State private var loadState: LoadState = .loading

    var body: some View {
        let pal = AgentPalette(scheme)
        Group {
            switch loadState {
            case .loading:
                ProgressView("নির্দিষ্ট রেকর্ড যাচাই করা হচ্ছে…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .found(let entity):
                found(entity, pal: pal)
            case .deleted:
                stateView(
                    title: "রেকর্ডটি মুছে/আর্কাইভ করা হয়েছে",
                    detail: "পুরোনো reference রাখা হয়েছে; কোনো পরিবর্তন করা হয়নি।",
                    icon: "archivebox")
            case .forbidden:
                stateView(
                    title: "এই রেকর্ড দেখার অনুমতি নেই",
                    detail: "বর্তমান role বা business scope এই reference খুলতে দেয় না।",
                    icon: "lock.shield")
            case .notFound:
                stateView(
                    title: "রেকর্ড পাওয়া যায়নি",
                    detail: "ID বা source record আর বর্তমান store-এ নেই।",
                    icon: "questionmark.folder")
            case .failed:
                stateView(
                    title: "রেকর্ড লোড করা যায়নি",
                    detail: "সাময়িক সমস্যা হয়েছে—পরে আবার চেষ্টা করুন।",
                    icon: "exclamationmark.triangle",
                    retry: true)
            }
        }
        .background(pal.bg0.ignoresSafeArea())
        .task(id: "\(namespace):\(entityId):\(businessId ?? "personal")") { await load() }
        .accessibilityIdentifier("agent.reference.focus")
    }

    private func found(_ entity: AgentReferenceFocusEntity, pal: AgentPalette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(entity.label.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1.2)
                        .foregroundStyle(AgentPalette.coral)
                    Text(entity.title)
                        .font(.system(.title2, design: .rounded, weight: .semibold))
                        .foregroundStyle(pal.ink)
                    Text(entity.id)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(pal.muted)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 10)], spacing: 10) {
                    ForEach(entity.fields.keys.filter { $0 != "id" }.sorted(), id: \.self) { key in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(key.uppercased())
                                .font(.system(size: 9.5, weight: .semibold))
                                .tracking(0.6)
                                .foregroundStyle(pal.muted)
                            Text(entity.fields[key]?.pretty() ?? "—")
                                .font(.system(size: 13))
                                .foregroundStyle(pal.ink)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(12)
                        .background(pal.card, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(pal.borderSubtle))
                    }
                }
                if Self.safeFallbackPath(entity.fallbackPath) {
                    Button {
                        NotificationCenter.default.post(
                            name: .almaOpenPath, object: nil,
                            userInfo: ["path": entity.fallbackPath])
                    } label: {
                        Label("তালিকা/সেকশনে ফিরে যান", systemImage: "arrow.backward")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(AgentPalette.coral)
                            .frame(minHeight: 44)
                    }
                }
            }
            .padding(20)
        }
        .accessibilityIdentifier("agent.reference.found")
    }

    @ViewBuilder
    private func stateView(
        title: String, detail: String, icon: String, retry: Bool = false
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            Text(detail)
        } actions: {
            if retry {
                Button("আবার চেষ্টা করুন") {
                    loadState = .loading
                    Task { await load() }
                }
            }
        }
        .accessibilityIdentifier("agent.reference.state")
    }

    @MainActor
    private func load() async {
        loadState = .loading
        do {
            let payload: AgentReferenceFocusPayload = try await AlmaAPI.shared.getQuietAuth(
                "/api/assistant/references/\(namespace)/\(entityId)",
                query: ["business_id": businessId])
            switch payload.state {
            case "found":
                loadState = payload.entity.map(LoadState.found) ?? .failed
            case "deleted": loadState = .deleted
            case "forbidden", "unauthorized": loadState = .forbidden
            case "not_found": loadState = .notFound
            default: loadState = .failed
            }
        } catch let error as AlmaAPIError {
            switch error {
            case .notAuthenticated: loadState = .forbidden
            case .http(let status, _):
                if status == 404 { loadState = .notFound }
                else if status == 410 { loadState = .deleted }
                else if status == 401 || status == 403 { loadState = .forbidden }
                else { loadState = .failed }
            default: loadState = .failed
            }
        } catch {
            loadState = .failed
        }
    }

    private static func safeFallbackPath(_ value: String) -> Bool {
        value.hasPrefix("/") && !value.hasPrefix("//") && !value.contains("\\")
            && !value.contains("\n") && !value.contains("\r") && !value.contains("\0")
    }
}
