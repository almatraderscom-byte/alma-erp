'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { useActor } from '@/contexts/ActorContext'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'

/** Same gate as /agent page: SUPER_ADMIN only (server enforces + AGENT_ENABLED). */
export function useCanAccessAgent(): boolean {
  const { role } = useActor()
  return role === 'SUPER_ADMIN'
}

export function AgentLauncherButton({ className }: { className?: string }) {
  const can = useCanAccessAgent()
  if (!can) return null

  return (
    <Link
      href="/agent"
      prefetch
      className={cn(
        'inline-flex h-9 min-h-[44px] items-center gap-1.5 rounded-xl border border-gold-dim/40 bg-gold/10 px-3 text-[11px] font-semibold text-gold-lt transition-all hover:border-gold-dim/60 hover:bg-gold/15 active:scale-[0.98]',
        className,
      )}
      aria-label="ALMA Agent খুলুন"
    >
      <span className="text-sm leading-none" aria-hidden>✦</span>
      <span className="hidden sm:inline">Ask ALMA</span>
    </Link>
  )
}

const FAB_HIDE_PREFIXES = ['/agent', '/orders/new']

export function AgentFab() {
  const can = useCanAccessAgent()
  const path = usePathname() ?? ''
  const reduceMotion = useReducedMotion()

  if (!can) return null
  if (FAB_HIDE_PREFIXES.some((p) => path.startsWith(p))) return null

  return (
    <motion.div
      className="fixed z-[60] md:hidden"
      style={{
        right: 'max(1rem, env(safe-area-inset-right))',
        bottom: 'calc(6.25rem + env(safe-area-inset-bottom))',
      }}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <Link
        href="/agent"
        prefetch
        aria-label="ALMA Agent"
        className="flex h-14 w-14 items-center justify-center rounded-full border border-gold-dim/50 bg-gradient-to-br from-gold/25 to-gold-dim/20 text-xl text-gold-lt shadow-lg shadow-gold/20 backdrop-blur-md transition-transform active:scale-[0.96]"
      >
        ✦
      </Link>
    </motion.div>
  )
}

export function AgentSidebarLink({
  collapsed,
  active,
}: {
  collapsed: boolean
  active: boolean
}) {
  return (
    <Link
      href="/agent"
      prefetch
      className={cn(
        'group relative mx-2 flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all duration-200 active:scale-[0.98]',
        active
          ? 'border-gold-dim/60 bg-gold/15 shadow-[0_0_24px_rgba(201,168,76,0.12)]'
          : 'border-gold-dim/30 bg-gold/5 hover:border-gold-dim/50 hover:bg-gold/10',
        collapsed && 'justify-center px-2',
      )}
      title="ALMA Agent"
    >
      <span className={cn('shrink-0 text-base', active ? 'text-gold-lt' : 'text-gold')}>✦</span>
      {!collapsed && (
        <span className={cn('text-sm font-semibold', active ? 'text-gold-lt' : 'text-gold-lt/90')}>
          ALMA Agent
        </span>
      )}
    </Link>
  )
}

export function PageEnter({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion()
  if (reduceMotion) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={MOTION.page.initial}
      animate={MOTION.page.animate}
      transition={MOTION.page.transition}
    >
      {children}
    </motion.div>
  )
}
