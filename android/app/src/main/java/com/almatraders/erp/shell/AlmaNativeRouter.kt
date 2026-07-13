//
//  AlmaNativeRouter.kt
//  ALMA ERP — route-path → native Compose screen map (twin of AlmaNativeRouter.swift, build 66).
//
//  The More menu (and any other push) consults this router first: a migrated page
//  opens its native screen; everything else falls back to a WebView — one additive
//  entry per migrated page. Screens receive the PushCtx whose openWebForced NEVER
//  routes back through here (recursion guard, same as iOS).
//

package com.almatraders.erp.shell

import androidx.compose.runtime.Composable
import com.almatraders.erp.pages.ActivityScreen
import com.almatraders.erp.pages.AgentCostsScreen
import com.almatraders.erp.pages.AgentGrowthScreen
import com.almatraders.erp.pages.AgentWhatsappScreen
import com.almatraders.erp.pages.AnalyticsScreen
import com.almatraders.erp.pages.ApprovalsScreen
import com.almatraders.erp.pages.AttendanceScreen
import com.almatraders.erp.pages.AuditScreen
import com.almatraders.erp.pages.BriefingScreen
import com.almatraders.erp.pages.BusinessArchiveScreen
import com.almatraders.erp.pages.CatalogImagesScreen
import com.almatraders.erp.pages.CreativeStudioScreen
import com.almatraders.erp.pages.CreditUsageScreen
import com.almatraders.erp.pages.CrmScreen
import com.almatraders.erp.pages.DashboardScreen
import com.almatraders.erp.pages.DigitalClientsScreen
import com.almatraders.erp.pages.DigitalHomeScreen
import com.almatraders.erp.pages.DigitalInvoicesScreen
import com.almatraders.erp.pages.DigitalProjectsScreen
import com.almatraders.erp.pages.EmployeesScreen
import com.almatraders.erp.pages.ExpensesScreen
import com.almatraders.erp.pages.FinanceScreen
import com.almatraders.erp.pages.InsightsScreen
import com.almatraders.erp.pages.InventoryScreen
import com.almatraders.erp.pages.InvoicesScreen
import com.almatraders.erp.pages.KnownPeopleScreen
import com.almatraders.erp.pages.NativeLoginScreen
import com.almatraders.erp.pages.OfficeFundScreen
import com.almatraders.erp.pages.OrderCreateScreen
import com.almatraders.erp.pages.OrdersScreen
import com.almatraders.erp.pages.PaymentAccountsScreen
import com.almatraders.erp.pages.PayrollScreen
import com.almatraders.erp.pages.PortalExpenseScreen
import com.almatraders.erp.pages.PortalOfficeScreen
import com.almatraders.erp.pages.PortalScreen
import com.almatraders.erp.pages.SettingsBrandingScreen
import com.almatraders.erp.pages.SettingsDatabaseScreen
import com.almatraders.erp.pages.SettingsNotificationsScreen
import com.almatraders.erp.pages.SettingsSessionScreen
import com.almatraders.erp.pages.SettingsSmsScreen
import com.almatraders.erp.pages.SettingsTelegramScreen
import com.almatraders.erp.pages.SettingsUsersScreen
import com.almatraders.erp.pages.StaffMonitorScreen
import com.almatraders.erp.pages.SubscriptionsScreen
import com.almatraders.erp.pages.SupplierImportScreen
import com.almatraders.erp.pages.SystemDiagnosticsScreen
import com.almatraders.erp.pages.TargetControlScreen
import com.almatraders.erp.pages.TaskSpotlightScreen
import com.almatraders.erp.pages.TradingAccountsScreen
import com.almatraders.erp.pages.TradingAnalyticsScreen
import com.almatraders.erp.pages.TradingHomeScreen
import com.almatraders.erp.pages.TradingHrScreen
import com.almatraders.erp.pages.TradingStaffScreen
import com.almatraders.erp.pages.TradingTelegramScreen
import com.almatraders.erp.pages.WalletStatementScreen

class NativeDestination(
    val title: String,
    val content: @Composable (PushCtx) -> Unit,
)

object AlmaNativeRouter {

    /** Native screen for a bare route path, or null → open the web view as before.
     *  Same map as the iOS router (build 66) — every migrated ERP route. */
    fun screen(path: String): NativeDestination? = when (path) {
        "/", "/dashboard" -> NativeDestination("Dashboard") { DashboardScreen(it) }
        "/login" -> NativeDestination("Sign in") { NativeLoginScreen(it) }
        "/orders" -> NativeDestination("Orders") { OrdersScreen(it) }
        "/orders/new" -> NativeDestination("নতুন অর্ডার") { OrderCreateScreen(it) }
        "/approvals" -> NativeDestination("Approvals") { ApprovalsScreen(it) }
        "/finance" -> NativeDestination("Finance") { FinanceScreen(it) }
        "/invoice" -> NativeDestination("Invoices") { InvoicesScreen(it) }
        "/expenses" -> NativeDestination("Expenses") { ExpensesScreen(it) }
        "/payroll" -> NativeDestination("Payroll") { PayrollScreen(it) }
        "/finance/office-fund" -> NativeDestination("Office fund") { OfficeFundScreen(it) }
        "/wallet-statement", "/portal/wallet" -> NativeDestination("সম্পূর্ণ হিসাব") { WalletStatementScreen(it) }
        "/activity" -> NativeDestination("Activity") { ActivityScreen(it) }
        "/inventory" -> NativeDestination("Inventory") { InventoryScreen(it) }
        "/inventory/supplier-import" -> NativeDestination("Supplier import") { SupplierImportScreen(it) }
        "/employees" -> NativeDestination("Employees") { EmployeesScreen(it) }
        "/attendance" -> NativeDestination("Attendance") { AttendanceScreen(it) }
        "/crm" -> NativeDestination("CRM") { CrmScreen(it) }
        "/audit" -> NativeDestination("Audit") { AuditScreen(it) }
        "/analytics" -> NativeDestination("Analytics") { AnalyticsScreen(it) }
        "/insights" -> NativeDestination("Insights") { InsightsScreen(it) }
        "/briefing" -> NativeDestination("Briefing") { BriefingScreen(it) }
        "/operations/task-spotlight" -> NativeDestination("Task Spotlight") { TaskSpotlightScreen(it) }
        "/operations/business-archive" -> NativeDestination("Business archive") { BusinessArchiveScreen(it) }
        "/operations/system-diagnostics" -> NativeDestination("System diagnostics") { SystemDiagnosticsScreen(it) }
        "/portal" -> NativeDestination("My Desk") { PortalScreen(it) }
        "/portal/office" -> NativeDestination("Office") { PortalOfficeScreen(it) }
        "/portal/expense" -> NativeDestination("Portal expense") { PortalExpenseScreen(it) }
        "/portal/payment-accounts" -> NativeDestination("Payment accounts") { PaymentAccountsScreen(it) }
        "/settings/users" -> NativeDestination("Users") { SettingsUsersScreen(it) }
        "/settings/notifications" -> NativeDestination("Notifications") { SettingsNotificationsScreen(it) }
        "/settings/branding" -> NativeDestination("Branding") { SettingsBrandingScreen(it) }
        "/settings/sms" -> NativeDestination("SMS") { SettingsSmsScreen(it) }
        "/settings/telegram-ops" -> NativeDestination("Telegram Ops") { SettingsTelegramScreen(it) }
        "/settings/database" -> NativeDestination("Database") { SettingsDatabaseScreen(it) }
        "/settings/session" -> NativeDestination("Session") { SettingsSessionScreen(it) }
        "/agent/costs", "/agent/credit-usage" -> NativeDestination("Credit Usage") { CreditUsageScreen(it) }
        "/agent/subscriptions" -> NativeDestination("Subscriptions") { SubscriptionsScreen(it) }
        "/agent/whatsapp" -> NativeDestination("WhatsApp inbox") { AgentWhatsappScreen(it) }
        "/agent/catalog-images" -> NativeDestination("Product Images") { CatalogImagesScreen(it) }
        "/agent/creative-studio" -> NativeDestination("Creative Studio") { CreativeStudioScreen(it) }
        "/agent/trading-staff" -> NativeDestination("Trading staff") { TradingStaffScreen(it) }
        "/agent/known-people" -> NativeDestination("Known people") { KnownPeopleScreen(it) }
        "/agent/growth" -> NativeDestination("Growth") { AgentGrowthScreen(it) }
        "/agent/staff-monitor" -> NativeDestination("Staff monitor") { StaffMonitorScreen(it) }
        "/agent/agent-costs" -> NativeDestination("Agent costs") { AgentCostsScreen(it) }
        // Trading business
        "/trading" -> NativeDestination("Trading") { TradingHomeScreen(it) }
        "/trading/accounts" -> NativeDestination("Trading accounts") { TradingAccountsScreen(it) }
        "/trading/analytics" -> NativeDestination("Trading analytics") { TradingAnalyticsScreen(it) }
        "/trading/hr" -> NativeDestination("Trading HR") { TradingHrScreen(it) }
        "/trading/target-control" -> NativeDestination("Target control") { TargetControlScreen(it) }
        "/trading/telegram" -> NativeDestination("Telegram Quick Entry") { TradingTelegramScreen(it) }
        // Digital (CDIT) business
        "/digital" -> NativeDestination("CDIT") { DigitalHomeScreen(it) }
        "/digital/clients" -> NativeDestination("CDIT clients") { DigitalClientsScreen(it) }
        "/digital/invoices" -> NativeDestination("CDIT invoices") { DigitalInvoicesScreen(it) }
        "/digital/projects" -> NativeDestination("CDIT projects") { DigitalProjectsScreen(it) }
        // /digital/finance is a server redirect to /finance — serve native Finance directly.
        "/digital/finance" -> NativeDestination("Finance") { FinanceScreen(it) }
        else -> null
    }
}
