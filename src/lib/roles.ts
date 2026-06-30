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

export function isSystemOwner(subject: unknown): boolean {
  const role = typeof subject === 'string'
    ? subject
    : (subject as { user?: { role?: string | null }; role?: string | null } | null | undefined)?.user?.role
      ?? (subject as { role?: string | null } | null | undefined)?.role
  return normalizeAlmaRole(role) === 'SUPER_ADMIN'
}

/**
 * Product-image screen access. SUPER_ADMIN has full control (view/upload/delete);
 * ADMIN can view + upload (delete stays SUPER_ADMIN-only, enforced in the route).
 * This is the ONLY part of /agent/* shared beyond the owner — see the carve-out in
 * isPathAllowedForRole.
 */
export function canManageCatalogImages(subject: unknown): boolean {
  const role = typeof subject === 'string'
    ? subject
    : (subject as { user?: { role?: string | null }; role?: string | null } | null | undefined)?.user?.role
      ?? (subject as { role?: string | null } | null | undefined)?.role
  const r = normalizeAlmaRole(role)
  return r === 'SUPER_ADMIN' || r === 'ADMIN'
}

export function roleHomePath(role: AlmaRole, businessId: BusinessId): string {
  if (role === 'HR') return businessId === 'ALMA_TRADING' ? '/trading/hr' : '/employees'
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

  if (pathname.startsWith('/trading/target-control')) {
    return role === 'SUPER_ADMIN' || role === 'ADMIN'
  }

  if (pathname.startsWith('/trading/telegram')) {
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') return true
    if (role === 'STAFF' && businessId === 'ALMA_TRADING') return true
    return false
  }

  if (pathname.startsWith('/operations')) return role === 'SUPER_ADMIN'

  // Product-image screen is shared with Admins (view/upload); everything else
  // under /agent stays owner-only.
  if (pathname.startsWith('/agent/catalog-images')) {
    return role === 'SUPER_ADMIN' || role === 'ADMIN'
  }

  if (pathname.startsWith('/agent')) return role === 'SUPER_ADMIN'

  if (pathname.startsWith('/api/business-archive')) return role === 'SUPER_ADMIN'

  // Owner Morning Briefing + Business Insights — owner/admin only (business-wide intelligence).
  if (pathname.startsWith('/briefing')) return role === 'SUPER_ADMIN' || role === 'ADMIN'
  if (pathname.startsWith('/insights')) return role === 'SUPER_ADMIN' || role === 'ADMIN'

  if (role === 'SUPER_ADMIN') return true

  // Finance hub, expense ledger and CDIT (digital) are owner/admin only
  // (owner decision 2026-06). SUPER_ADMIN already returned above, so this allows
  // ADMIN and blocks HR / STAFF / VIEWER from these pages and their nav links.
  if (
    pathname.startsWith('/finance')
    || pathname.startsWith('/expenses')
    || pathname.startsWith('/digital')
  ) return role === 'ADMIN'

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
    if (businessId === 'ALMA_TRADING') {
      const hrRoots = ['/trading/hr', '/attendance', '/payroll', '/portal']
      return hrRoots.some(r => pathname === r || pathname.startsWith(`${r}/`))
    }
    const hrRoots = ['/finance', '/expenses', '/employees', '/attendance', '/payroll', '/portal']
    return hrRoots.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  if (role === 'STAFF') {
    if (businessId === 'ALMA_TRADING') {
      const ok = ['/trading', '/portal']
      return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
    }
    if (businessId === 'ALMA_LIFESTYLE') {
      const ok = ['/', '/orders', '/invoice', '/portal']
      return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
    }
    const ok = ['/digital', '/invoice', '/portal']
    return ok.some(r => pathname === r || pathname.startsWith(`${r}/`))
  }

  return false
}

const TRADING_STAFF_NAV_HIDE = new Set([
  '/trading/target-control',
  '/trading/analytics',
  '/trading/hr',
  '/approvals',
  '/attendance',
  '/settings/database',
  '/settings/users',
  '/settings/notifications',
  '/settings/sms',
  '/audit',
  '/settings/branding',
])

export function filterNavByRole(items: NavItem[], role: AlmaRole, businessId: BusinessId): NavItem[] {
  return items.filter(item => {
    if (item.href === '/agent' && role !== 'SUPER_ADMIN') return false
    if (item.href.startsWith('/operations/') && role !== 'SUPER_ADMIN') return false
    if (!isPathAllowedForRole(item.href, role, businessId)) return false
    if (businessId === 'ALMA_TRADING' && item.href === '/trading/target-control' && role !== 'SUPER_ADMIN') {
      return false
    }
    if (businessId === 'ALMA_TRADING' && role === 'STAFF') {
      if (TRADING_STAFF_NAV_HIDE.has(item.href)) return false
      if (item.href.startsWith('/trading/analytics')) return false
    }
    return true
  })
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
