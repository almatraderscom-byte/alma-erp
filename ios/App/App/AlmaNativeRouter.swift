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
            return h
        }

        switch clean {
        // Cases are appended batch-by-batch as pages migrate (S6 marathon).
        case "/finance": return host(FinanceScreen(openWeb: openWebForced), "Finance")
        case "/invoice": return host(InvoicesScreen(openWeb: openWebForced), "Invoices")
        case "/expenses": return host(ExpensesScreen(openWeb: openWebForced), "Expenses")
        case "/payroll": return host(PayrollScreen(openWeb: openWebForced), "Payroll")
        case "/finance/office-fund": return host(OfficeFundScreen(openWeb: openWebForced), "Office fund")
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
        default:
            return nil
        }
    }
}
