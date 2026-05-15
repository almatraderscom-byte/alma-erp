'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { getNavForBusiness } from '@/lib/businesses'
import { filterNavByRole } from '@/lib/roles'
import { BusinessSwitcher } from '@/components/layout/BusinessSwitcher'
import { BusinessLogo } from '@/components/branding/BusinessLogo'

function NavItem({ href, icon, label, badge, collapsed }: { href: string; icon: string; label: string; badge: string | null; collapsed: boolean }) {
  const path = usePathname()
  const active = href === '/' || href === '/digital'
    ? path === href
    : path.startsWith(href)
  return (
    <Link href={href} className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl mx-2 transition-all duration-200 ${active ? 'bg-gold/10 border border-gold-dim/40' : 'border border-transparent hover:bg-white/[0.04] hover:border-white/[0.06]'}`}>
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-gold rounded-r-full" />}
      <span className={`text-base shrink-0 transition-colors ${active ? 'text-gold-lt' : 'text-muted group-hover:text-muted-hi'}`}>{icon}</span>
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
  const nav = filterNavByRole(getNavForBusiness(business.id), role, business.id)

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 220 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="hidden md:flex flex-col bg-surface border-r border-border shrink-0 overflow-hidden"
    >
      <motion.div layout className={`flex items-center px-4 py-5 border-b border-border ${collapsed ? 'justify-center' : 'gap-3'}`}>
        <BusinessLogo size={32} />
        <AnimatePresence>
          {!collapsed && (
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}>
              <p className="text-[11px] font-black tracking-[0.14em] text-gold leading-none">{business.shortName.toUpperCase()}</p>
              <p className="text-[9px] tracking-[0.16em] text-gold-dim leading-none mt-0.5">{business.tagline}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <BusinessSwitcher collapsed={collapsed} />

      <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto scrollbar-hide">
        {nav.map(n => <NavItem key={n.href} {...n} badge={n.badge ?? null} collapsed={collapsed} />)}
      </nav>

      <div className="border-t border-border p-3 space-y-2">
        {!collapsed && (
          <div className="mx-2 px-3 py-2 rounded-lg bg-green-400/5 border border-green-400/15">
            <motion.div layout className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              <span className="text-[10px] text-green-400 font-semibold">Multi-business ERP</span>
            </motion.div>
            <p className="text-[9px] text-zinc-600 mt-0.5 leading-tight">{business.name}</p>
          </div>
        )}
        <button onClick={() => setCollapsed(c => !c)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-border hover:bg-white/[0.04] transition-colors text-zinc-600 hover:text-zinc-400">
          <span className="text-sm">{collapsed ? '→' : '←'}</span>
          {!collapsed && <span className="text-[11px]">Collapse</span>}
        </button>
      </div>
    </motion.aside>
  )
}

export function MobileNav() {
  const path = usePathname()
  const { business } = useBusiness()
  const { role } = useActor()
  const items = filterNavByRole(getNavForBusiness(business.id), role, business.id).slice(0, 5)
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface/95 backdrop-blur border-t border-border safe-bottom">
      <div className="flex items-center">
        {items.map(n => {
          const active = n.href === '/' || n.href === '/digital'
            ? path === n.href
            : path.startsWith(n.href)
          return (
            <Link key={n.href} href={n.href} className={`flex-1 flex flex-col items-center gap-1 py-3 transition-colors ${active ? 'text-gold-lt' : 'text-zinc-600'}`}>
              <span className="text-xl">{n.icon}</span>
              <span className="text-[9px] font-semibold tracking-wide">{n.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
