import type { BusinessId } from '@/lib/businesses'
import { BUSINESSES, isRouteAllowed, type NavItem } from '@/lib/businesses'

export type AlmaRole = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'STAFF'

export const ALMA_ROLE_OPTIONS: { id: AlmaRole; label: string; hint: string }[] = [
  { id: 'SUPER_ADMIN', label: 'Super Admin', hint: 'Full access + branding + audit log' },
  { id: 'ADMIN', label: 'Admin', hint: 'Orders, CRM, inventory, invoices, analytics, finance/expenses' },
  { id: 'HR', label: 'HR', hint: 'Employees, payroll, finance hub & expense ledger' },
  { id: 'STAFF', label: 'Staff', hint: 'Create/track orders · invoice tools · CDIT ops (scoped)' },
]

export function normalizeAlmaRole(raw: string | null | undefined): AlmaRole {
  const u = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
  if (u === 'SUPER_ADMIN' || u === 'ADMIN' || u === 'HR' || u === 'STAFF') return u
  return 'SUPER_ADMIN'
}

export function roleHomePath(role: AlmaRole, businessId: BusinessId): string {
  if (role === 'HR') return '/employees'
  return BUSINESSES[businessId].homePath
}

export function isPathAllowedForRole(pathname: string, role: AlmaRole, businessId: BusinessId): boolean {
  if (!isRouteAllowed(pathname, businessId)) return false
  if (pathname.startsWith('/settings/session') || pathname.startsWith('/invoice/share')) return true
  if (role === 'SUPER_ADMIN') return true

  if (pathname.startsWith('/audit') || pathname.startsWith('/settings/branding')) return false

  if (role === 'ADMIN') {
    if (pathname.startsWith('/employees') || pathname.startsWith('/payroll')) return false
    return true
  }

  if (role === 'HR') {
    const hrRoots = ['/finance', '/expenses', '/employees', '/payroll']
    return hrRoots.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  if (role === 'STAFF') {
    if (businessId === 'ALMA_LIFESTYLE') {
      const ok = ['/', '/orders', '/invoice']
      return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
    }
    const ok = ['/digital', '/invoice']
    return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  return false
}

export function filterNavByRole(items: NavItem[], role: AlmaRole, businessId: BusinessId): NavItem[] {
  return items.filter(item => isPathAllowedForRole(item.href, role, businessId))
}

/** Fine-grained UI gates (client-side — pair with audit log discipline). */
export function can(role: AlmaRole, capability: keyof typeof CAPABILITIES): boolean {
  const allowed = CAPABILITIES[capability]
  return allowed.includes(role)
}

const CAPABILITIES = {
  ordersAdvanceStatus: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersEditTracking: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersEditField: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersGenerateInvoice: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  crmWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  inventoryWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  expenseWrite: ['SUPER_ADMIN', 'ADMIN', 'HR'] as AlmaRole[],
  payrollWrite: ['SUPER_ADMIN', 'HR'] as AlmaRole[],
  employeeWrite: ['SUPER_ADMIN', 'HR'] as AlmaRole[],
  brandingWrite: ['SUPER_ADMIN'] as AlmaRole[],
  analyticsView: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  cditAdminWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
} as const
