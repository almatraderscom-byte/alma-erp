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

        func host<V: View>(_ view: V, _ title: String) -> UIViewController {
            let h = AlmaHostingController(rootView: view)
            h.title = title
            h.hidesBottomBarWhenPushed = false
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
        case "/login": return host(NativeLoginScreen(onSuccess: {}, openWeb: openWebForced), "Sign in")
        // S8 audit fix: the three tab pages were reachable natively ONLY as tab roots —
        // any cross-page link (Dashboard "সব দেখুন" → /orders, briefing → /approvals)
        // fell through to the web view. One case each closes that hole.
        case "/orders": return host(OrdersScreen(openWeb: openWebForced), "Orders")
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
        case "/agent/creative-studio": return host(CreativeStudioScreen(openWeb: openWebForced), "Creative Studio")
        case "/agent/trading-staff": return host(TradingStaffScreen(openWeb: openWebForced), "Trading staff")
        case "/agent/known-people": return host(KnownPeopleScreen(openWeb: openWebForced), "Known people")
        case "/agent/growth": return host(AgentGrowthScreen(openWeb: openWebForced), "Growth")
        case "/agent/staff-monitor": return host(StaffMonitorScreen(openWeb: openWebForced), "LIVE Business")
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
            if let empId = pathParam(clean, after: "/employees/") {
                return host(EmployeesScreen(openWeb: openWebForced, focusEmpId: empId), "Employee")
            }
            if let clientId = pathParam(clean, after: "/digital/clients/") {
                return host(DigitalClientsScreen(openWeb: openWebForced, focusClientId: clientId), "Client")
            }
            // IOSP-1: trading account detail links (/trading/accounts/{id}) were the
            // last audited dynamic route still falling to web — the native list
            // opens with that account's detail sheet focused.
            if let accountId = pathParam(clean, after: "/trading/accounts/") {
                return host(TradingAccountsScreen(openWeb: openWebForced, focusAccountId: accountId), "Trading account")
            }
            return nil
        }
    }

    /// "/employees/EMP-51" after "/employees/" → "EMP-51"; nil when the prefix
    /// doesn't match or the remainder is empty / has more path segments.
    private static func pathParam(_ path: String, after prefix: String) -> String? {
        guard path.hasPrefix(prefix) else { return nil }
        let rest = String(path.dropFirst(prefix.count))
        guard !rest.isEmpty, !rest.contains("/") else { return nil }
        return rest.removingPercentEncoding ?? rest
    }
}
