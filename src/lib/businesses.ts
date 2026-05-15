/**
 * Multi-business registry — extend BUSINESSES to add tenants later.
 */
export type BusinessId = 'ALMA_LIFESTYLE' | 'CREATIVE_DIGITAL_IT'

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
  { href: '/finance', icon: '◆', label: 'Finance' },
  { href: '/expenses', icon: '◫', label: 'Expenses' },
  { href: '/employees', icon: '☷', label: 'Employees' },
  { href: '/payroll', icon: '⌁', label: 'Payroll' },
]

const SETTINGS_NAV: NavItem[] = [
  { href: '/settings/session', icon: '⚙', label: 'Session' },
  { href: '/audit', icon: '◇', label: 'Audit' },
  { href: '/settings/branding', icon: '◉', label: 'Branding' },
]

const ALMA_NAV: NavItem[] = [
  { href: '/', icon: '⬡', label: 'Dashboard' },
  { href: '/orders', icon: '◫', label: 'Orders' },
  { href: '/crm', icon: '◎', label: 'CRM' },
  { href: '/inventory', icon: '◧', label: 'Inventory' },
  { href: '/invoice', icon: '◈', label: 'Invoice' },
  ...FINANCE_SUITE,
  { href: '/analytics', icon: '◩', label: 'Analytics' },
  ...SETTINGS_NAV,
]

const CDIT_NAV: NavItem[] = [
  { href: '/digital', icon: '⬡', label: 'Dashboard' },
  { href: '/digital/clients', icon: '◎', label: 'Clients' },
  { href: '/digital/projects', icon: '◰', label: 'Projects' },
  { href: '/digital/invoices', icon: '◈', label: 'Invoices' },
  ...FINANCE_SUITE,
  ...SETTINGS_NAV,
]

export function getNavForBusiness(businessId: BusinessId): NavItem[] {
  return businessId === 'CREATIVE_DIGITAL_IT' ? CDIT_NAV : ALMA_NAV
}

/** Routes exclusive to one business — used to redirect on switch */
export function isRouteAllowed(path: string, businessId: BusinessId): boolean {
  const digitalOnly = path.startsWith('/digital')
  const sharedOps =
    path.startsWith('/finance') ||
    path.startsWith('/expenses') ||
    path.startsWith('/employees') ||
    path.startsWith('/payroll')

  if (path.startsWith('/settings') || path.startsWith('/invoice/share') || path.startsWith('/audit')) return true

  if (businessId === 'CREATIVE_DIGITAL_IT') {
    return digitalOnly || sharedOps || path === '/'
  }
  return (!digitalOnly && !path.startsWith('/digital')) || sharedOps
}

export function resolveBusinessId(raw: string | null | undefined): BusinessId {
  if (raw === 'CREATIVE_DIGITAL_IT') return 'CREATIVE_DIGITAL_IT'
  return 'ALMA_LIFESTYLE'
}
