/**
 * Multi-business registry — extend BUSINESSES to add tenants later.
 */
export type BusinessId = 'ALMA_LIFESTYLE' | 'CREATIVE_DIGITAL_IT' | 'ALMA_TRADING'

export interface BusinessConfig {
  id: BusinessId
  name: string
  shortName: string
  tagline: string
  brandInitial: string
  /** Default route when switching to this business */
  homePath: string
}

export const BUSINESSES: Record<BusinessId, BusinessConfig> = {
  ALMA_LIFESTYLE: {
    id: 'ALMA_LIFESTYLE',
    name: 'Alma Lifestyle',
    shortName: 'Alma',
    tagline: 'LIFESTYLE',
    brandInitial: 'A',
    homePath: '/',
  },
  CREATIVE_DIGITAL_IT: {
    id: 'CREATIVE_DIGITAL_IT',
    name: 'Creative Digital IT',
    shortName: 'CDIT',
    tagline: 'DIGITAL AGENCY',
    brandInitial: 'C',
    homePath: '/digital',
  },
  ALMA_TRADING: {
    id: 'ALMA_TRADING',
    name: 'Alma Trading',
    shortName: 'Trading',
    tagline: 'P2P OPERATIONS',
    brandInitial: 'T',
    homePath: '/trading',
  },
}

export const BUSINESS_LIST = Object.values(BUSINESSES)

export const DEFAULT_BUSINESS_ID: BusinessId = 'ALMA_LIFESTYLE'

export const STORAGE_KEY = 'alma-business-id'

export interface NavItem {
  href: string
  icon: string
  label: string
  badge?: string | null
}

const FINANCE_SUITE: NavItem[] = [
  { href: '/finance', icon: '💰', label: 'Finance' },
  { href: '/expenses', icon: '💳', label: 'Expenses' },
  { href: '/employees', icon: '👤', label: 'Employees' },
  { href: '/attendance', icon: '⏱', label: 'Attendance' },
  { href: '/payroll', icon: '💵', label: 'Payroll' },
]

/** Super Admin only — filtered in filterNavByRole; requires AGENT_ENABLED=true on server. */
export const AGENT_NAV_ITEM: NavItem = { href: '/agent', icon: '✨', label: 'ALMA Agent' }
// Shared with Admins (not owner-only like the rest of /agent) — product photos.
export const CATALOG_IMAGES_NAV_ITEM: NavItem = { href: '/agent/catalog-images', icon: '📷', label: 'Product Images' }
export const OFFICE_NAV_ITEM: NavItem = { href: '/portal/office', icon: '🏢', label: 'Office' }

const SETTINGS_NAV: NavItem[] = [
  { href: '/operations/task-spotlight', icon: '🎯', label: 'Task Spotlight' },
  { href: '/operations/business-archive', icon: '📦', label: 'Archive Control' },
  { href: '/settings/session', icon: '⚙️', label: 'Session' },
  { href: '/settings/database', icon: '🗄', label: 'Database' },
  { href: '/settings/users', icon: '👥', label: 'Users' },
  { href: '/settings/notifications', icon: '🔔', label: 'Notifications' },
  { href: '/settings/sms', icon: '✉️', label: 'SMS' },
  { href: '/settings/telegram-ops', icon: '📡', label: 'Telegram Ops' },
  { href: '/audit', icon: '📋', label: 'Audit' },
  { href: '/settings/branding', icon: '🎨', label: 'Branding' },
]

const ALMA_NAV: NavItem[] = [
  { href: '/', icon: '🏠', label: 'Dashboard' },
  { href: '/briefing', icon: '☀️', label: 'Briefing' },
  { href: '/insights', icon: '🔮', label: 'Insights' },
  { href: '/activity', icon: '🕓', label: 'Activity' },
  { href: '/approvals', icon: '✅', label: 'Approvals' },
  { href: '/portal', icon: '🪪', label: 'My desk' },
  OFFICE_NAV_ITEM,
  { href: '/orders', icon: '📦', label: 'Orders' },
  { href: '/crm', icon: '👥', label: 'CRM' },
  { href: '/inventory', icon: '📊', label: 'Inventory' },
  CATALOG_IMAGES_NAV_ITEM,
  { href: '/invoice', icon: '🧾', label: 'Invoice' },
  ...FINANCE_SUITE,
  { href: '/analytics', icon: '📈', label: 'Analytics' },
  AGENT_NAV_ITEM,
  ...SETTINGS_NAV,
]

const CDIT_NAV: NavItem[] = [
  { href: '/digital', icon: '🏠', label: 'Dashboard' },
  { href: '/approvals', icon: '✅', label: 'Approvals' },
  { href: '/portal', icon: '🪪', label: 'My desk' },
  OFFICE_NAV_ITEM,
  { href: '/digital/clients', icon: '👥', label: 'Clients' },
  { href: '/digital/projects', icon: '📂', label: 'Projects' },
  { href: '/digital/invoices', icon: '🧾', label: 'Invoices' },
  ...FINANCE_SUITE,
  AGENT_NAV_ITEM,
  ...SETTINGS_NAV,
]

export function getNavForBusiness(businessId: BusinessId): NavItem[] {
  if (businessId === 'CREATIVE_DIGITAL_IT') return CDIT_NAV
  if (businessId === 'ALMA_TRADING') return [
    { href: '/trading', icon: '💹', label: 'Trading' },
    { href: '/approvals', icon: '✅', label: 'Approvals' },
    { href: '/trading/accounts', icon: '🏦', label: 'Accounts' },
    { href: '/trading/target-control', icon: '🎯', label: 'Target Control' },
    { href: '/trading/telegram', icon: '✉️', label: 'Telegram' },
    { href: '/trading/hr', icon: '👤', label: 'Trading HR' },
    { href: '/employees', icon: '👤', label: 'Employees' },
    { href: '/attendance', icon: '⏱', label: 'Attendance' },
    { href: '/payroll', icon: '💵', label: 'Payroll' },
    { href: '/trading/analytics', icon: '📈', label: 'Analytics' },
    { href: '/trading/analytics?view=reports', icon: '📊', label: 'Reports' },
    { href: '/portal', icon: '🪪', label: 'My desk' },
    OFFICE_NAV_ITEM,
    AGENT_NAV_ITEM,
    ...SETTINGS_NAV,
  ]
  return ALMA_NAV
}

/** Routes exclusive to one business — used to redirect on switch */
export function isRouteAllowed(path: string, businessId: BusinessId): boolean {
  const digitalOnly = path.startsWith('/digital')
  const sharedOps =
    path.startsWith('/finance') ||
    path.startsWith('/expenses') ||
    path.startsWith('/employees') ||
    path.startsWith('/attendance') ||
    path.startsWith('/payroll')

  if (
    path.startsWith('/settings')
    || path.startsWith('/operations')
    || path.startsWith('/agent')
    || path.startsWith('/invoice/share')
    || path.startsWith('/audit')
    || path.startsWith('/approvals')
  ) return true

  if (businessId === 'CREATIVE_DIGITAL_IT') {
    return digitalOnly || sharedOps || path === '/'
  }
  if (businessId === 'ALMA_TRADING') {
    return path === '/'
      || path.startsWith('/trading')
      || path.startsWith('/attendance')
      || path.startsWith('/payroll')
      || path.startsWith('/employees')
      || path.startsWith('/portal')
      || path.startsWith('/settings')
      || path.startsWith('/audit')
  }
  return (!digitalOnly && !path.startsWith('/digital') && !path.startsWith('/trading')) || sharedOps
}

export function resolveBusinessId(raw: string | null | undefined): BusinessId {
  if (raw === 'CREATIVE_DIGITAL_IT') return 'CREATIVE_DIGITAL_IT'
  if (raw === 'ALMA_TRADING') return 'ALMA_TRADING'
  return 'ALMA_LIFESTYLE'
}
