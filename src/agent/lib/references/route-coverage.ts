import type { InternalSectionId } from './internal-registry'

export type RouteReferenceClassification = 'exact' | 'section' | 'none'

export interface RouteReferenceCoverageEntry {
  route: string
  classification: RouteReferenceClassification
  reason: string
  fallbackSection?: InternalSectionId
}

/** Explicit reviewed route groups. There is no prefix/default rule: adding a
 * page.tsx makes the equality gate fail until that exact route is classified. */
const SECTION_ROUTE_GROUPS: Readonly<Partial<Record<InternalSectionId, readonly string[]>>> = {
  activity: ['/activity'],
  agent_browser_live: ['/agent/browser-live'],
  catalog_images: ['/agent/catalog-images'],
  agent_costs: ['/agent/costs'],
  creative_studio: ['/agent/creative-studio-demo', '/agent/creative-studio'],
  agent_growth: ['/agent/growth'],
  known_people: ['/agent/known-people'],
  agent_live_watch: ['/agent/live-watch'],
  agent_mac: ['/agent/mac'],
  agent_media: ['/agent/media'],
  agent_home: ['/agent'],
  phone_calls: ['/agent/phone-console/calls'],
  phone_console: [
    '/agent/phone-console/extensions',
    '/agent/phone-console/line',
    '/agent/phone-console',
    '/agent/phone-console/settings/blocklist',
    '/agent/phone-console/settings/history',
    '/agent/phone-console/settings/hold',
    '/agent/phone-console/settings/hours',
    '/agent/phone-console/settings/limits',
    '/agent/phone-console/settings',
    '/agent/phone-console/settings/provider',
  ],
  phone_live: ['/agent/phone-console/live'],
  phone_quality: ['/agent/phone-console/quality'],
  phone_recordings: ['/agent/phone-console/recordings'],
  phone_routing: [
    '/agent/phone-console/routing/outbound',
    '/agent/phone-console/routing',
    '/agent/phone-console/routing/preview',
  ],
  agent_phone: ['/agent/phone'],
  agent_staff_monitor: ['/agent/staff-monitor'],
  agent_trading_staff: ['/agent/trading-staff'],
  agent_whatsapp: ['/agent/whatsapp'],
  analytics: ['/analytics'],
  approvals: ['/approvals'],
  attendance: ['/attendance'],
  audit: ['/audit'],
  briefing: ['/briefing'],
  crm: ['/crm'],
  digital_clients: ['/digital/clients'],
  digital_finance: ['/digital/finance'],
  digital_invoices: ['/digital/invoices'],
  digital_home: ['/digital'],
  digital_projects: ['/digital/projects'],
  employees: ['/employees'],
  expenses: ['/expenses'],
  office_fund: ['/finance/office-fund'],
  finance: ['/finance'],
  personal_ledger: ['/finance/personal-ledger'],
  insights: ['/insights'],
  inventory: ['/inventory'],
  supplier_import: ['/inventory/supplier-import'],
  invoices: ['/invoice'],
  business_archive: ['/operations/business-archive'],
  system_diagnostics: ['/operations/system-diagnostics'],
  task_spotlight: ['/operations/task-spotlight'],
  orders: ['/orders/new', '/orders'],
  dashboard: ['/'],
  payroll: ['/payroll'],
  portal_expense: ['/portal/expense'],
  portal_office: ['/portal/office'],
  portal: ['/portal'],
  portal_payment_accounts: ['/portal/payment-accounts'],
  portal_wallet: ['/portal/wallet'],
  settings_branding: ['/settings/branding'],
  settings_database: ['/settings/database'],
  settings_notifications: ['/settings/notifications'],
  settings_session: ['/settings/session'],
  settings_sms: ['/settings/sms'],
  settings_telegram: ['/settings/telegram-ops'],
  settings_users: ['/settings/users'],
  trading_accounts: ['/trading/accounts'],
  trading_analytics: ['/trading/analytics'],
  trading_hr: ['/trading/hr'],
  trading_home: ['/trading'],
  trading_target_control: ['/trading/target-control'],
  trading_telegram: ['/trading/telegram'],
}

const EXACT_ROUTES: Readonly<Record<string, string>> = {
  '/agent/references/[namespace]/[id]': 'Provider-neutral exact entity focus; namespace/id are registry-validated and fetched read-only.',
  '/digital/clients/[id]': 'Proven exact CDIT client detail route backed by a returned client id.',
  '/employees/[id]': 'Proven exact employee detail route backed by a returned employee id.',
  '/orders/[id]': 'Proven exact Lifestyle order detail route backed by a returned order id.',
  '/trading/accounts/[id]': 'Proven exact trading-account detail route backed by a returned account id.',
}

const NONE_ROUTES: Readonly<Record<string, string>> = {
  '/agent/report-preview': 'Preview-only report rendering fixture carrying no live ERP data; never a mintable business destination.',
  '/app/download': 'Public app-download handoff is not an ERP record or authenticated operational section reference.',
  '/forgot-password': 'Authentication recovery input must never be minted from agent output.',
  '/invoice/share/[slug]': 'Capability-style public invoice share slugs are not trusted internal entity references.',
  '/login': 'Authentication entry is not a business-object destination.',
  '/privacy-policy': 'Public policy content is not an operational ERP reference.',
  '/reset-password': 'Secret-bearing password reset routes must never be minted from agent output.',
}

function buildRouteCoverage(): RouteReferenceCoverageEntry[] {
  const entries: RouteReferenceCoverageEntry[] = []
  const seen = new Set<string>()
  const add = (entry: RouteReferenceCoverageEntry) => {
    if (seen.has(entry.route)) throw new Error(`Duplicate route reference classification: ${entry.route}`)
    seen.add(entry.route)
    entries.push(entry)
  }
  for (const [fallbackSection, routes] of Object.entries(SECTION_ROUTE_GROUPS)) {
    for (const route of routes ?? []) {
      add({
        route,
        classification: 'section',
        fallbackSection: fallbackSection as InternalSectionId,
        reason: `Reviewed operational route; its verified fallback is the ${fallbackSection} registry section.`,
      })
    }
  }
  for (const [route, reason] of Object.entries(EXACT_ROUTES)) {
    add({ route, classification: 'exact', reason })
  }
  for (const [route, reason] of Object.entries(NONE_ROUTES)) {
    add({ route, classification: 'none', reason })
  }
  return entries.sort((a, b) => a.route.localeCompare(b.route))
}

export const ROUTE_REFERENCE_COVERAGE: readonly RouteReferenceCoverageEntry[] = buildRouteCoverage()
export const ROUTE_REFERENCE_COVERAGE_COUNTS = ROUTE_REFERENCE_COVERAGE.reduce(
  (counts, entry) => ({ ...counts, [entry.classification]: counts[entry.classification] + 1 }),
  { exact: 0, section: 0, none: 0 } as Record<RouteReferenceClassification, number>,
)
