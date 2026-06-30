'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { BUSINESSES, getNavForBusiness, type NavItem } from '@/lib/businesses'
import { filterNavByRole } from '@/lib/roles'
import { BusinessSwitcher } from '@/components/layout/BusinessSwitcher'
import { BusinessLogo } from '@/components/branding/BusinessLogo'
import { UserAccountMenu } from '@/components/layout/UserAccountMenu'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useMyProfileImage } from '@/hooks/useMyProfileImage'
import { cn } from '@/lib/utils'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useApprovalCount } from '@/contexts/ApprovalCountContext'
import { AgentSidebarLink } from '@/components/layout/AgentAccess'
import { ThemeToggle, ThemePanel } from '@/components/layout/ThemeToggle'
import { useSheetDragDismiss } from '@/hooks/useSheetDragDismiss'

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
    <Link prefetch href={href} className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl mx-2 transition-all duration-200 ${active ? 'bg-gradient-to-r from-gold/25 via-gold/10 to-transparent border border-gold/40 shadow-[0_0_18px_rgba(224,122,95,0.32),inset_0_0_14px_rgba(224,122,95,0.10)]' : 'border border-transparent hover:bg-white/[0.05] hover:border-white/10 hover:shadow-[0_0_14px_rgba(255,255,255,0.04)]'}`}>
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 bg-gold rounded-r-full shadow-[0_0_10px_2px_rgba(224,122,95,0.7)]" />}
      <span className={`relative text-base shrink-0 transition-all ${active ? 'text-gold drop-shadow-[0_0_6px_rgba(224,122,95,0.55)]' : 'text-muted group-hover:text-cream'}`}>
        {icon}
        {badge && collapsed && (
          <span className="alert-pulse absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 shadow-lg shadow-red-200/40" aria-hidden />
        )}
      </span>
      <AnimatePresence>
        {!collapsed && (
          <motion.span initial={{ opacity:0, width:0 }} animate={{ opacity:1, width:'auto' }} exit={{ opacity:0, width:0 }}
            className={`text-sm font-medium whitespace-nowrap overflow-hidden transition-colors ${active ? 'text-gold font-semibold drop-shadow-[0_0_6px_rgba(224,122,95,0.4)]' : 'text-muted-hi group-hover:text-cream'}`}>
            {label}
          </motion.span>
        )}
      </AnimatePresence>
      {badge && !collapsed && (
        <span className="alert-pulse ml-auto text-[10px] font-bold bg-red-500 text-white px-1.5 py-0.5 rounded-full">{badge}</span>
      )}
    </Link>
  )
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const { business } = useBusiness()
  const { role } = useActor()
  const { count: approvalCount } = useApprovalCount()
  const nav = filterNavByRole(getNavForBusiness(business.id), role, business.id).map(item => (
    item.href === '/approvals' ? { ...item, badge: approvalCount ? String(approvalCount) : null } : item
  ))
  const mainNav = nav.filter(n => n.href !== '/agent')
  const showAgentPin = role === 'SUPER_ADMIN' && nav.some(n => n.href === '/agent')
  const path = usePathname()
  const agentActive = path.startsWith('/agent')

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 220 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="hidden md:flex flex-col bg-card/55 backdrop-blur-2xl border-r border-border-subtle shrink-0 overflow-hidden"
    >
      <motion.div layout className={`flex items-center px-4 py-5 border-b border-border-subtle gap-2 ${collapsed ? 'justify-center' : ''}`}>
        <div className={`flex items-center min-w-0 ${collapsed ? 'justify-center' : 'flex-1 gap-3'}`}>
          <BusinessLogo size={32} />
          <AnimatePresence>
            {!collapsed && (
              <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} className="min-w-0 flex-1">
                <p className="text-[11px] font-black tracking-[0.14em] text-gold leading-none">{business.shortName.toUpperCase()}</p>
                <p className="text-[9px] tracking-[0.16em] text-muted leading-none mt-0.5">{business.tagline}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <BusinessSwitcher collapsed={collapsed} />

      <nav className="flex-1 space-y-0.5 overflow-y-auto py-3 scrollbar-hide">
        {mainNav.map(n => <NavItem key={n.href} {...n} badge={n.badge ?? null} collapsed={collapsed} />)}
      </nav>

      {showAgentPin && (
        <div className="shrink-0 border-t border-border-subtle bg-gold/[0.03] py-2">
          <AgentSidebarLink collapsed={collapsed} active={agentActive} />
        </div>
      )}

      <div className="border-t border-border-subtle p-3 space-y-3">
        {!collapsed && (
          <div className="mx-2 flex items-center justify-between">
            <span className="text-[9px] font-black uppercase tracking-[0.18em] text-muted">Account</span>
            <span className="flex items-center gap-1 text-[9px] font-semibold text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Online
            </span>
          </div>
        )}
        <UserAccountMenu collapsed={collapsed} />
        <ThemeToggle collapsed={collapsed} />
        <button onClick={() => setCollapsed(c => !c)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-border-subtle hover:bg-gold/[0.05] transition-colors text-muted hover:text-muted-hi">
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
    active ? 'text-gold' : 'text-muted',
  )
  const content = (
    <>
      {active && <motion.span layoutId="mobile-nav-glow" className="absolute inset-1 rounded-2xl border border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5 shadow-[0_0_22px_rgba(224,122,95,0.3),inset_0_0_12px_rgba(224,122,95,0.1)]" />}
      <span className={cn('relative text-[19px] leading-none transition-all', active && 'drop-shadow-[0_0_7px_rgba(224,122,95,0.55)]')}>{icon}</span>
      <span className="relative truncate text-[9px] font-black tracking-[0.08em]">{label}</span>
      {!!badge && (
        <span className="absolute right-2 top-1 min-w-4 rounded-full bg-red-500 px-1 text-center text-[9px] font-black leading-4 text-white shadow-lg shadow-red-200/40">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </>
  )
  if (href) return <Link prefetch href={href} className={cls}>{content}</Link>
  return <button type="button" onClick={onClick} className={cls}>{content}</button>
}

function DrawerLink({ item, onClose }: { item: NavItem; onClose: () => void }) {
  const path = usePathname()
  const active = activePath(path, item.href)
  return (
    <Link
      prefetch
      href={item.href}
      onClick={onClose}
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all duration-200',
        active
          ? 'border-gold/40 bg-gradient-to-r from-gold/20 via-gold/8 to-transparent text-gold shadow-[0_0_18px_rgba(224,122,95,0.22),inset_0_0_12px_rgba(224,122,95,0.08)]'
          : 'border-border-subtle bg-white/[0.04] text-muted-hi hover:border-gold/25 hover:bg-gold/[0.07] hover:text-cream',
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle bg-card text-base">{item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold">{item.label}</span>
        <span className="block truncate text-[10px] text-muted">{item.href}</span>
      </span>
      {active && <span className="h-2 w-2 rounded-full bg-gold" />}
    </Link>
  )
}

// ── Rotating phone nav (phone only) ──────────────────────────────────────────
// Cycles through ALL role-allowed destinations a few at a time. A progress light
// runs across the top; when it fills, the window rotates and the departed button
// slides up-left into a collapsible "আগে দেখা" dock (default hidden). Active =
// current route. Theme-faithful: uses existing tokens, works in light + dark.
type Dest = { key: string; label: string; icon: string; href: string; badge?: number }

const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, d => BN[+d])

function RotTab({ item, active }: { item: Dest; active: boolean }) {
  return (
    <Link
      prefetch
      href={item.href}
      className={cn(
        'relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2.5 transition-colors active:scale-[0.96]',
        active ? 'text-gold' : 'text-muted',
      )}
    >
      {active && (
        <span className="absolute inset-1 rounded-2xl border border-gold/40 bg-gradient-to-b from-gold/20 to-gold/5 shadow-[0_0_22px_rgba(224,122,95,0.3),inset_0_0_12px_rgba(224,122,95,0.1)]" />
      )}
      <span className={cn('relative text-[19px] leading-none', active && 'drop-shadow-[0_0_7px_rgba(224,122,95,0.55)]')}>{item.icon}</span>
      <span className="relative w-full truncate text-center text-[9px] font-black tracking-[0.06em]">{item.label}</span>
      {!!item.badge && (
        <span className="absolute right-1.5 top-1 min-w-4 rounded-full bg-red-500 px-1 text-center text-[9px] font-black leading-4 text-white shadow-lg shadow-red-200/40">
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      )}
    </Link>
  )
}

function DockChip({ item, active }: { item: Dest; active: boolean }) {
  return (
    <Link
      prefetch
      href={item.href}
      title={item.label}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-xl border text-[16px] transition-colors',
        active ? 'border-gold/40 bg-gold/15 text-gold' : 'border-border-subtle bg-white/[0.04] text-muted-hi',
      )}
    >
      {item.icon}
      {!!item.badge && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />}
    </Link>
  )
}

const ROT_BIG = 5
const ROT_DWELL = 3600

// Only the MAIN front-office pages rotate through the bar — keeps a full round short.
// Everything else (HR/finance details, settings, admin) lives in the Account drawer.
// Matched by the nav label so it stays correct across all three businesses.
const CORE_ROTATION_LABELS = new Set([
  'Dashboard', 'Briefing', 'Insights', 'Trading', 'Orders', 'CRM', 'Clients', 'Inventory',
  'Invoice', 'Invoices', 'Projects', 'Finance', 'Analytics', 'ALMA Agent',
])

function RotatingDockNav({ items, activeHref, trailing }: { items: Dest[]; activeHref: string; trailing: React.ReactNode }) {
  const N = items.length
  const [head, setHead] = useState(0)
  const [dockOpen, setDockOpen] = useState(false)
  const rotates = N > ROT_BIG

  // Lead with the current page whenever the route changes.
  useEffect(() => {
    const idx = items.findIndex(it => activePath(activeHref, it.href))
    if (idx >= 0) setHead(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref])

  // Auto-rotate; pause while the owner is browsing the dock.
  useEffect(() => {
    if (!rotates || dockOpen) return
    const t = window.setInterval(() => setHead(h => (h + 1) % N), ROT_DWELL)
    return () => window.clearInterval(t)
  }, [N, rotates, dockOpen])

  const visN = Math.min(ROT_BIG, N)
  const barItems = Array.from({ length: visN }, (_, i) => items[(head + i) % N])
  // Everything not currently on the bar lives in the dock (all of them, newest-departed first),
  // so the "আগে দেখা" count matches what the owner actually finds when it opens.
  const dockItems = rotates
    ? Array.from({ length: N - visN }, (_, i) => items[(head - 1 - i + N) % N])
    : []

  return (
    <div className="relative mx-auto max-w-lg">
      {rotates && (
        <>
          <AnimatePresence>
            {dockOpen && (
              <motion.div
                key="rot-dock"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="absolute bottom-[calc(100%+44px)] left-0 right-0 flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-border-subtle bg-card/85 px-2.5 py-2.5 shadow-lg shadow-black/10 backdrop-blur-2xl"
              >
                <AnimatePresence mode="popLayout">
                  {[...dockItems].reverse().map(it => (
                    <motion.div
                      key={it.key}
                      layout
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      transition={{ duration: 0.28 }}
                    >
                      <DockChip item={it} active={activePath(activeHref, it.href)} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            type="button"
            onClick={() => setDockOpen(o => !o)}
            className="absolute -top-[26px] left-2 z-[2] flex items-center gap-1 rounded-full border border-border-subtle bg-card/85 px-2.5 py-1 text-[10px] font-bold text-muted backdrop-blur-2xl"
          >
            <span className={cn('inline-block transition-transform', dockOpen && 'rotate-180')}>⌃</span>
            {dockOpen ? 'লুকাও' : 'আগে দেখা'}
            {!dockOpen && <span className="rounded-full bg-gold/15 px-1 text-gold">{bn(N - visN)}</span>}
          </button>
        </>
      )}

      <div className="relative">
        {/* Rotating coral/blue light that traces around the bar — the "ঘুরন্ত box".
            Sits on a non-clipped wrapper so the wide ring can sweep above the bar. */}
        {rotates && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[26px]"
            style={{
              padding: '1.4px',
              background:
                'conic-gradient(from 0deg, transparent 0%, rgba(224,122,95,.55) 12%, transparent 32%, transparent 55%, rgba(56,128,255,.30) 68%, transparent 88%)',
              WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              WebkitMaskComposite: 'xor',
              mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              maskComposite: 'exclude',
              opacity: 0.85,
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 7, ease: 'linear', repeat: Infinity }}
          />
        )}
      <div className="relative overflow-hidden rounded-[26px] border border-border-subtle bg-card/80 p-1.5 shadow-lg shadow-black/8 backdrop-blur-2xl">
        {rotates && (
          <div className="pointer-events-none absolute inset-x-4 top-[3px] z-[6] h-[3px] rounded-full bg-white/[0.05]">
            <motion.div
              key={head}
              className="relative h-full rounded-full"
              style={{
                background: 'linear-gradient(90deg, rgba(224,122,95,.15), rgb(var(--c-accent-lt)), rgb(var(--c-accent)))',
                boxShadow: '0 0 10px rgba(224,122,95,.7)',
              }}
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: ROT_DWELL / 1000, ease: 'linear' }}
            >
              <span
                className="absolute right-0 top-1/2 h-[10px] w-[10px] -translate-y-1/2 translate-x-1/2 rounded-full"
                style={{
                  background: 'radial-gradient(circle, #fff 30%, rgb(var(--c-accent-lt)) 55%, rgb(var(--c-accent)) 70%, transparent 78%)',
                  boxShadow: '0 0 14px 4px rgba(224,122,95,.85)',
                }}
              />
            </motion.div>
          </div>
        )}

        <div className="flex items-stretch gap-1">
          <div className="flex min-w-0 flex-1 items-stretch gap-1">
            <AnimatePresence mode="popLayout" initial={false}>
              {barItems.map(it => (
                <motion.div
                  key={it.key}
                  layout
                  initial={{ opacity: 0, y: 10, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -14, x: -10, scale: 0.5 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="min-w-0 flex-1"
                >
                  <RotTab item={it} active={activePath(activeHref, it.href)} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-stretch gap-1 border-l border-border-subtle pl-1">{trailing}</div>
        </div>
      </div>
      </div>
    </div>
  )
}

export function MobileNav() {
  const path = usePathname()
  const { data: session, status: sessionStatus } = useSession()
  const { profileImageUrl } = useMyProfileImage()
  const { business, businessId, allowedBusinessIds, setBusinessId } = useBusiness()
  const { role } = useActor()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { motionProps: sheetDrag, startDrag } = useSheetDragDismiss(() => setDrawerOpen(false))
  const [unread, setUnread] = useState(0)
  const { count: approvalCount } = useApprovalCount()
  const nav = useMemo(() => filterNavByRole(getNavForBusiness(business.id), role, business.id), [business.id, role])

  // Only the MAIN front-office pages feed the rotating bar (kept short so a full round
  // is quick). Approvals is pinned in the trailing slot, so it's excluded here.
  const rotationItems = useMemo<Dest[]>(
    () =>
      nav
        .filter(n => n.href !== '/approvals' && CORE_ROTATION_LABELS.has(n.label))
        .map(n => ({ key: n.href, label: n.label, icon: n.icon, href: n.href })),
    [nav],
  )
  const rotationHrefs = useMemo(() => new Set(rotationItems.map(d => d.href)), [rotationItems])

  // Everything that isn't pinned (Approvals) and isn't in the rotating bar — shown in
  // the Account drawer so no page is lost (HR/finance details, settings, admin, etc.).
  const drawerModules = useMemo(
    () => nav.filter(n => n.href !== '/approvals' && !rotationHrefs.has(n.href)),
    [nav, rotationHrefs],
  )

  const unreadPausedRef = useRef(false)
  const unreadBackoffRef = useRef(0)

  const loadUnread = useCallback(async (): Promise<'ok' | 'paused' | 'retry'> => {
    if (sessionStatus !== 'authenticated') return 'retry'
    if (unreadPausedRef.current) return 'paused'
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'retry'
    try {
      const res = await fetch(`/api/notifications?business_id=${business.id}&summary=1`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.status === 401) {
        unreadPausedRef.current = true
        window.dispatchEvent(new Event('alma:auth-failure'))
        return 'paused'
      }
      if (!res.ok) {
        if (res.status >= 500) return 'retry'
        return 'retry'
      }
      setUnread(Number(json.unread || json.criticalUnacked || 0))
      return 'ok'
    } catch {
      return 'retry'
    }
  }, [business.id, sessionStatus])

  useEffect(() => {
    unreadPausedRef.current = false
    unreadBackoffRef.current = 0

    if (sessionStatus !== 'authenticated') return

    let cancelled = false
    let timer: number | undefined
    const UNREAD_POLL_MS = 30_000
    const UNREAD_BACKOFF_MS = [5_000, 10_000, 20_000, 60_000]

    const schedule = (delayMs: number) => {
      if (cancelled) return
      timer = window.setTimeout(() => {
        void (async () => {
          if (cancelled || unreadPausedRef.current) return
          if (document.hidden) {
            schedule(UNREAD_POLL_MS)
            return
          }
          const outcome = await loadUnread()
          if (cancelled || unreadPausedRef.current) return
          if (outcome === 'paused') return
          let nextDelay = UNREAD_POLL_MS
          if (outcome === 'retry') {
            nextDelay = UNREAD_BACKOFF_MS[Math.min(unreadBackoffRef.current, UNREAD_BACKOFF_MS.length - 1)]
            unreadBackoffRef.current = Math.min(unreadBackoffRef.current + 1, UNREAD_BACKOFF_MS.length - 1)
          } else if (outcome === 'ok') {
            unreadBackoffRef.current = 0
          }
          schedule(nextDelay)
        })()
      }, delayMs)
    }

    function syncNotifications(event: Event) {
      const detail = (event as CustomEvent<{ unread?: number; criticalUnacked?: number }>).detail
      setUnread(Number(detail?.unread || detail?.criticalUnacked || 0))
    }

    void loadUnread()
    schedule(UNREAD_POLL_MS)
    window.addEventListener('alma:notifications-updated', syncNotifications)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('alma:notifications-updated', syncNotifications)
    }
  }, [loadUnread, sessionStatus])

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
        <RotatingDockNav
          items={rotationItems}
          activeHref={path}
          trailing={
            <>
              <div className="w-[56px]">
                <MobileTab icon="✅" label="Approvals" href="/approvals" active={activePath(path, '/approvals')} badge={approvalCount} />
              </div>
              <div className="w-[56px]">
                <MobileTab icon="◎" label="Account" active={drawerOpen} onClick={() => setDrawerOpen(true)} />
              </div>
            </>
          }
        />
      </nav>

      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.button
              type="button"
              aria-label="Close mobile menu"
              className="fixed inset-0 z-[130] bg-black/20 backdrop-blur-sm md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="fixed inset-x-0 bottom-0 z-[140] max-h-[86dvh] rounded-t-[30px] border-t border-border-subtle bg-card/85 backdrop-blur-2xl shadow-xl shadow-black/10 md:hidden mobile-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
              {...sheetDrag}
            >
              {/* Grabber — drag it down with your finger to dismiss (follows 1:1). */}
              <div
                onPointerDown={startDrag}
                className="flex cursor-grab touch-none justify-center pb-1 pt-3 active:cursor-grabbing"
                role="button"
                aria-label="টেনে বন্ধ করুন"
              >
                <div className="h-1.5 w-12 rounded-full bg-border-strong" />
              </div>
              <div className="border-b border-border-subtle px-5 pb-4 pt-4">
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
                    <p className="mt-0.5 truncate text-[11px] text-muted">{role.replace(/_/g, ' ')} · {business.name}</p>
                  </div>
                  <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-2xl border border-border-subtle px-3 py-2 text-xs font-bold text-muted">Close</button>
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
                          id === businessId ? 'border-gold/30 bg-gold/10 text-gold' : 'border-border-subtle bg-bg-2 text-muted-hi',
                        )}
                      >
                        <span className="block text-[11px] font-bold">{BUSINESSES[id].shortName}</span>
                        <span className="block text-[9px] text-muted">{BUSINESSES[id].tagline}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="max-h-[calc(86dvh-160px)] overflow-y-auto px-4 py-4">
                <ThemePanel className="mb-4" />
                <button
                  type="button"
                  onClick={() => { setDrawerOpen(false); openNotifications() }}
                  className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-border-subtle bg-white/[0.04] px-3 py-3 text-left text-muted-hi transition-colors hover:border-gold/25 hover:bg-gold/[0.07] hover:text-cream"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle bg-card text-base">◌</span>
                  <span className="min-w-0 flex-1 text-[13px] font-bold">Alerts</span>
                  {!!unread && (
                    <span className="min-w-5 rounded-full bg-red-500 px-1.5 text-center text-[11px] font-black leading-5 text-white">{unread > 99 ? '99+' : unread}</span>
                  )}
                </button>
                <p className="mb-3 px-1 text-[10px] font-black uppercase tracking-[0.16em] text-muted">Workspace modules</p>
                <div className="grid gap-2">
                  {drawerModules.map(item => <DrawerLink key={item.href} item={item} onClose={() => setDrawerOpen(false)} />)}
                  <button
                    type="button"
                    onClick={() => void signOut({ callbackUrl: '/login' })}
                    className="mt-2 flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-3 py-3 text-left text-danger"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-danger/30 bg-danger/15">↗</span>
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
