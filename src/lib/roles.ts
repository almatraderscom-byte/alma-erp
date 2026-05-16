import type { BusinessId } from '@/lib/businesses'
import { BUSINESSES, isRouteAllowed, type NavItem } from '@/lib/businesses'

export type AlmaRole = 'SUPER_ADMIN' | 'ADMIN' | 'HR' | 'STAFF' | 'VIEWER'

export const ALMA_ROLE_OPTIONS: { id: AlmaRole; label: string; hint: string }[] = [
  { id: 'SUPER_ADMIN', label: 'Super Admin', hint: 'Full access · manage users · branding · audit · delete-capable ops' },
  { id: 'ADMIN', label: 'Admin', hint: 'Orders, CRM, inventory, invoices, analytics, finance/expenses · manage staff accounts' },
  { id: 'HR', label: 'HR', hint: 'Employees, payroll, advances approval, finance hub & expense ledger' },
  { id: 'STAFF', label: 'Staff', hint: 'Create/track orders · invoice tools · CDIT ops (scoped) · employee portal' },
  { id: 'VIEWER', label: 'Viewer', hint: 'Read-only dashboards and lists — cannot edit data' },
]

export function normalizeAlmaRole(raw: string | null | undefined): AlmaRole {
  const u = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
  if (
    u === 'SUPER_ADMIN'
    || u === 'ADMIN'
    || u === 'HR'
    || u === 'STAFF'
    || u === 'VIEWER'
  ) return u as AlmaRole
  return 'VIEWER'
}

export function roleHomePath(role: AlmaRole, businessId: BusinessId): string {
  if (role === 'HR') return '/employees'
  if (role === 'VIEWER') return BUSINESSES[businessId].homePath
  return BUSINESSES[businessId].homePath
}

export function isPathAllowedForRole(pathname: string, role: AlmaRole, businessId: BusinessId): boolean {
  if (!isRouteAllowed(pathname, businessId)) return false

  if (
    pathname.startsWith('/login')
    || pathname.startsWith('/forgot-password')
    || pathname.startsWith('/reset-password')
  ) return true

  if (pathname.startsWith('/invoice/share')) return true

  if (pathname.startsWith('/portal')) return true

  if (pathname.startsWith('/settings/session')) return true

  if (pathname.startsWith('/settings/database')) {
    return role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'HR'
  }

  if (pathname.startsWith('/settings/notifications')) {
    return role === 'SUPER_ADMIN' || role === 'ADMIN'
  }

  if (role === 'SUPER_ADMIN') return true

  if (pathname.startsWith('/settings/users')) {
    return role === 'ADMIN'
  }

  if (pathname.startsWith('/audit') || pathname.startsWith('/settings/branding')) return false

  if (role === 'VIEWER') {
    const deny = ['/settings/users', '/settings/branding', '/settings/database', '/audit']
    if (deny.some(p => pathname === p || pathname.startsWith(`${p}/`))) return false
    return true
  }

  if (role === 'ADMIN') {
    if (pathname.startsWith('/employees')) return false
    return true
  }

  if (role === 'HR') {
    const hrRoots = ['/finance', '/expenses', '/employees', '/payroll', '/portal']
    return hrRoots.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  if (role === 'STAFF') {
    if (businessId === 'ALMA_LIFESTYLE') {
      const ok = ['/', '/orders', '/invoice', '/portal']
      return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
    }
    const ok = ['/digital', '/invoice', '/portal']
    return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  return false
}

export function filterNavByRole(items: NavItem[], role: AlmaRole, businessId: BusinessId): NavItem[] {
  return items.filter(item => isPathAllowedForRole(item.href, role, businessId))
}

/** Fine-grained UI gates — server APIs enforce separately. */
export function can(role: AlmaRole, capability: keyof typeof CAPABILITIES): boolean {
  const allowed = CAPABILITIES[capability]
  return (allowed as readonly AlmaRole[]).includes(role)
}

const CAPABILITIES = {
  ordersAdvanceStatus: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersEditTracking: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersEditField: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersGenerateInvoice: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  ordersDeleteOrCancel: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  crmWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  inventoryWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  expenseWrite: ['SUPER_ADMIN', 'ADMIN', 'HR'] as AlmaRole[],
  payrollWrite: ['SUPER_ADMIN', 'HR'] as AlmaRole[],
  employeeWrite: ['SUPER_ADMIN', 'HR'] as AlmaRole[],
  brandingWrite: ['SUPER_ADMIN'] as AlmaRole[],
  analyticsView: ['SUPER_ADMIN', 'ADMIN', 'HR', 'STAFF', 'VIEWER'] as AlmaRole[],
  cditAdminWrite: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  userManage: ['SUPER_ADMIN', 'ADMIN'] as AlmaRole[],
  advanceApprove: ['SUPER_ADMIN', 'ADMIN', 'HR'] as AlmaRole[],
} as const
