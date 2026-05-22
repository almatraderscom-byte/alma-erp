'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { BUSINESSES, getNavForBusiness, type NavItem } from '@/lib/businesses'
import { filterNavByRole, isPathAllowedForRole, roleHomePath } from '@/lib/roles'
import { BusinessSwitcher } from '@/components/layout/BusinessSwitcher'
import { BusinessLogo } from '@/components/branding/BusinessLogo'
import { UserAccountMenu } from '@/components/layout/UserAccountMenu'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useMyProfileImage } from '@/hooks/useMyProfileImage'
import { cn } from '@/lib/utils'
import { safeFetchJson } from '@/lib/safe-fetch'
import useApprovalPendingCount from '@/hooks/useApprovalPendingCount'

function updateAppBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  if (count > 0) void nav.setAppBadge?.(count).catch(() => {})
  else void nav.clearAppBadge?.().catch(() => {})
}

function NavItem({ href, icon, label, badge, collapsed }: { href: string; icon: string; label: string; badge: string | null; collapsed: boolean }) {
  const path = usePathname()
  const active = href === '/' || href === '/digital'
    ? path === href
    : path.startsWith(href)
  return (
    <Link href={href} className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl mx-2 transition-all duration-200 ${active ? 'bg-gold/10 border border-gold-dim/40' : 'border border-transparent hover:bg-white/[0.04] hover:border-white/[0.06]'}`}>
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-gold rounded-r-full" />}
      <span className={`relative text-base shrink-0 transition-colors ${active ? 'text-gold-lt' : 'text-muted group-hover:text-muted-hi'}`}>
        {icon}
        {badge && collapsed && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 shadow-lg shadow-red-950/40" aria-hidden />
        )}
      </span>
      <AnimatePresence>
        {!collapsed && (
          <motion.span initial={{ opacity:0, width:0 }} animate={{ opacity:1, width:'auto' }} exit={{ opacity:0, width:0 }}
            className={`text-sm font-medium whitespace-nowrap overflow-hidden transition-colors ${active ? 'text-gold-lt' : 'text-muted-hi group-hover:text-cream'}`}>
            {label}
          </motion.span>
        )}
      </AnimatePresence>
      {badge && !collapsed && (
        <span className="ml-auto text-[10px] font-bold bg-gold/15 text-gold-lt px-1.5 py-0.5 rounded-full">{badge}</span>
      )}
    </Link>
  )
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const { business } = useBusiness()
  const { role } = useActor()
  const { count: approvalCount } = useApprovalPendingCount()
  const nav = filterNavByRole(getNavForBusiness(business.id), role, business.id).map(item => (
    item.href === '/approvals' ? { ...item, badge: approvalCount ? String(approvalCount) : null } : item
  ))

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 220 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="hidden md:flex flex-col bg-surface border-r border-border shrink-0 overflow-hidden"
    >
      <motion.div layout className={`flex items-center px-4 py-5 border-b border-border gap-2 ${collapsed ? 'justify-center' : ''}`}>
        <div className={`flex items-center min-w-0 ${collapsed ? 'justify-center' : 'flex-1 gap-3'}`}>
          <BusinessLogo size={32} />
          <AnimatePresence>
            {!collapsed && (
              <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} className="min-w-0 flex-1">
                <p className="text-[11px] font-black tracking-[0.14em] text-gold leading-none">{business.shortName.toUpperCase()}</p>
                <p className="text-[9px] tracking-[0.16em] text-gold-dim leading-none mt-0.5">{business.tagline}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <BusinessSwitcher collapsed={collapsed} />

      <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto scrollbar-hide">
        {nav.map(n => <NavItem key={n.href} {...n} badge={n.badge ?? null} collapsed={collapsed} />)}
      </nav>

      <div className="border-t border-border p-3 space-y-3">
        {!collapsed && (
          <div className="mx-2 flex items-center justify-between">
            <span className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-600">Account</span>
            <span className="flex items-center gap-1 text-[9px] font-semibold text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              Online
            </span>
          </div>
        )}
        <UserAccountMenu collapsed={collapsed} />
        <button onClick={() => setCollapsed(c => !c)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-border hover:bg-white/[0.04] transition-colors text-zinc-600 hover:text-zinc-400">
          <span className="text-sm">{collapsed ? '→' : '←'}</span>
          {!collapsed && <span className="text-[11px]">Collapse</span>}
        </button>
      </div>
    </motion.aside>
  )
}

function activePath(path: string, href: string) {
  return href === '/' || href === '/digital' ? path === href : path.startsWith(href)
}

function MobileTab({
  icon,
  label,
  active,
  badge,
  onClick,
  href,
}: {
  icon: string
  label: string
  active?: boolean
  badge?: number
  onClick?: () => void
  href?: string
}) {
  const cls = cn(
    'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2.5 transition-all duration-200 active:scale-[0.96]',
    active ? 'text-gold-lt' : 'text-zinc-500',
  )
  const content = (
    <>
      {active && <motion.span layoutId="mobile-nav-glow" className="absolute inset-1 rounded-2xl border border-gold-dim/40 bg-gold/10 shadow-[0_0_26px_rgba(214,169,74,.18)]" />}
      <span className="relative text-[19px] leading-none">{icon}</span>
      <span className="relative truncate text-[9px] font-black tracking-[0.08em]">{label}</span>
      {!!badge && (
        <span className="absolute right-2 top-1 min-w-4 rounded-full bg-red-500 px-1 text-center text-[9px] font-black leading-4 text-white shadow-lg shadow-red-950/40">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </>
  )
  if (href) return <Link href={href} className={cls}>{content}</Link>
  return <button type="button" onClick={onClick} className={cls}>{content}</button>
}

function DrawerLink({ item, onClose }: { item: NavItem; onClose: () => void }) {
  const path = usePathname()
  const active = activePath(path, item.href)
  return (
    <Link
      href={item.href}
      onClick={onClose}
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all duration-200',
        active
          ? 'border-gold-dim/50 bg-gold/10 text-gold-lt shadow-[0_0_24px_rgba(214,169,74,.10)]'
          : 'border-border bg-white/[0.025] text-zinc-300 hover:border-gold-dim/30 hover:bg-white/[0.05]',
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-black/25 text-base">{item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold">{item.label}</span>
        <span className="block truncate text-[10px] text-zinc-600">{item.href}</span>
      </span>
      {active && <span className="h-2 w-2 rounded-full bg-gold" />}
    </Link>
  )
}

export function MobileNav() {
  const path = usePathname()
  const { data: session } = useSession()
  const { profileImageUrl } = useMyProfileImage()
  const { business, businessId, allowedBusinessIds, setBusinessId } = useBusiness()
  const { role } = useActor()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const { count: approvalCount } = useApprovalPendingCount()
  const nav = useMemo(() => filterNavByRole(getNavForBusiness(business.id), role, business.id), [business.id, role])

  const dashboardHref = roleHomePath(role, business.id)
  const primary = useMemo(() => {
    const wanted = [
      { key: 'dashboard', label: 'Dashboard', icon: '⬡', href: dashboardHref },
      { key: 'orders', label: 'Orders', icon: '◫', href: '/orders' },
      { key: 'crm', label: 'CRM', icon: '◎', href: business.id === 'CREATIVE_DIGITAL_IT' ? '/digital/clients' : '/crm' },
    ]
    return wanted.filter(item => nav.some(n => n.href === item.href) || item.href === dashboardHref)
  }, [business.id, dashboardHref, nav])

  const secondary = useMemo(() => {
    const primaryHrefs = new Set(primary.map(p => p.href))
    const preferred = ['Finance', 'Expenses', 'Payroll', 'Employees', 'Analytics', 'Branding', 'Audit', 'Database', 'Users', 'Notifications', 'Session', 'Inventory', 'Invoice', 'Clients', 'Projects', 'Invoices', 'My desk']
    return [...nav]
      .filter(n => !primaryHrefs.has(n.href))
      .sort((a, b) => {
        const ia = preferred.indexOf(a.label)
        const ib = preferred.indexOf(b.label)
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
      })
  }, [nav, primary])

  const canApprovals = isPathAllowedForRole('/approvals', role, business.id)
  const mobileTabCount = Math.min(6, primary.slice(0, 3).length + (canApprovals ? 1 : 0) + 2)

  const loadUnread = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    try {
      const res = await fetch(`/api/notifications?business_id=${business.id}&summary=1`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) setUnread(Number(json.unread || json.criticalUnacked || 0))
    } catch {
      setUnread(0)
    }
  }, [business.id])

  useEffect(() => {
    void loadUnread()
    function syncNotifications(event: Event) {
      const detail = (event as CustomEvent<{ unread?: number; criticalUnacked?: number }>).detail
      setUnread(Number(detail?.unread || detail?.criticalUnacked || 0))
    }
    window.addEventListener('alma:notifications-updated', syncNotifications)
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadUnread()
    }, 30_000)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('alma:notifications-updated', syncNotifications)
    }
  }, [loadUnread])

  useEffect(() => {
    updateAppBadge(unread + approvalCount)
  }, [unread, approvalCount])

  useEffect(() => {
    if (!drawerOpen) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [drawerOpen])

  function openNotifications() {
    window.dispatchEvent(new Event('alma-open-notifications'))
    void loadUnread()
  }

  return (
    <>
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 safe-bottom px-3 pb-2 mobile-app-chrome">
        <div className="mx-auto max-w-lg rounded-[26px] border border-gold-dim/20 bg-[#09090d]/92 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-2xl">
          <div className="grid items-center gap-1" style={{ gridTemplateColumns: `repeat(${mobileTabCount}, minmax(0, 1fr))` }}>
            {primary.slice(0, 3).map(item => (
              <MobileTab key={item.key} icon={item.icon} label={item.label} href={item.href} active={activePath(path, item.href)} />
            ))}
            {canApprovals && (
              <MobileTab icon="◆" label="Approvals" badge={approvalCount} href="/approvals" active={activePath(path, '/approvals')} />
            )}
            <MobileTab icon="◌" label="Alerts" badge={unread} onClick={openNotifications} />
            <MobileTab icon="◎" label="Account" active={drawerOpen} onClick={() => setDrawerOpen(true)} />
          </div>
        </div>
      </nav>

      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.button
              type="button"
              aria-label="Close mobile menu"
              className="fixed inset-0 z-[130] bg-black/65 backdrop-blur-sm md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="fixed inset-x-0 bottom-0 z-[140] max-h-[86dvh] rounded-t-[30px] border-t border-gold-dim/30 bg-[#09090d] shadow-2xl shadow-black md:hidden mobile-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
            >
              <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-zinc-700" />
              <div className="border-b border-border px-5 pb-4 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <EmployeeAvatar
                    userId={session?.user?.id}
                    name={session?.user?.name}
                    email={session?.user?.email}
                    imageUrl={profileImageUrl}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-cream">{session?.user?.name || 'Account'}</p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">{role.replace(/_/g, ' ')} · {business.name}</p>
                  </div>
                  <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-2xl border border-border px-3 py-2 text-xs font-bold text-zinc-400">Close</button>
                </div>
                {allowedBusinessIds.length > 1 && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    {allowedBusinessIds.map(id => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setBusinessId(id)}
                        className={cn(
                          'rounded-2xl border px-3 py-2 text-left transition-colors',
                          id === businessId ? 'border-gold-dim/50 bg-gold/10 text-gold-lt' : 'border-border bg-white/[0.03] text-zinc-400',
                        )}
                      >
                        <span className="block text-[11px] font-bold">{BUSINESSES[id].shortName}</span>
                        <span className="block text-[9px] text-zinc-600">{BUSINESSES[id].tagline}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="max-h-[calc(86dvh-160px)] overflow-y-auto px-4 py-4">
                <p className="mb-3 px-1 text-[10px] font-black uppercase tracking-[0.16em] text-zinc-600">Workspace modules</p>
                <div className="grid gap-2">
                  {secondary.map(item => <DrawerLink key={item.href} item={item} onClose={() => setDrawerOpen(false)} />)}
                  <button
                    type="button"
                    onClick={() => void signOut({ callbackUrl: '/login' })}
                    className="mt-2 flex items-center gap-3 rounded-2xl border border-red-400/25 bg-red-500/10 px-3 py-3 text-left text-red-300"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-red-400/20 bg-red-500/10">↗</span>
                    <span className="text-[13px] font-bold">Logout</span>
                  </button>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
