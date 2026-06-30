'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { getNavForBusiness } from '@/lib/businesses'
import { filterNavByRole } from '@/lib/roles'
import { tapHaptic } from '@/lib/ui-haptics'
import { cn } from '@/lib/utils'

/**
 * Cmd/Ctrl-K command palette — fast cross-ERP navigation for the owner.
 *
 * v1 indexes every role-allowed destination (the same nav the sidebar builds)
 * plus a couple of utility actions, with bilingual (Bangla/English) matching so
 * "অর্ডার" finds Orders. Opens on ⌘K / Ctrl-K, or on the global
 * `alma-open-command` event (so a header/search button can trigger it on phones).
 * Keyboard-first: ↑/↓ to move, Enter to go, Esc to close.
 *
 * Pure client navigation — no new data sources. (Phase 2 could pipe the query to
 * the agent for natural-language answers; this v1 is the fast front door.)
 */

// Bangla search aliases so the owner can type in either script.
const KEYWORDS: Record<string, string> = {
  '/': 'dashboard হোম ড্যাশবোর্ড',
  '/digital': 'dashboard হোম ড্যাশবোর্ড',
  '/briefing': 'briefing ব্রিফিং সকাল morning',
  '/insights': 'insights বিশ্লেষণ ইনসাইট reorder churn finance',
  '/approvals': 'approvals অনুমোদন approve',
  '/orders': 'orders অর্ডার',
  '/crm': 'crm কাস্টমার customer গ্রাহক',
  '/inventory': 'inventory স্টক stock প্রোডাক্ট product',
  '/invoice': 'invoice ইনভয়েস বিল',
  '/finance': 'finance ফিনান্স হিসাব money টাকা',
  '/expenses': 'expenses খরচ expense',
  '/employees': 'employees স্টাফ staff কর্মী',
  '/attendance': 'attendance হাজিরা উপস্থিতি',
  '/payroll': 'payroll বেতন salary স্যালারি',
  '/analytics': 'analytics অ্যানালিটিক্স রিপোর্ট report',
  '/trading': 'trading ট্রেডিং',
  '/portal': 'portal my desk আমার ডেস্ক',
}

type Cmd = { id: string; label: string; icon: string; hint?: string; keywords: string; run: () => void }

export function CommandPalette() {
  const router = useRouter()
  const pathname = usePathname()
  const { business } = useBusiness()
  const { role } = useActor()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => { setOpen(false); setQuery(''); setActive(0) }, [])

  const commands = useMemo<Cmd[]>(() => {
    const nav = filterNavByRole(getNavForBusiness(business.id), role, business.id)
    const navCmds: Cmd[] = nav.map(n => ({
      id: `nav:${n.href}`,
      label: n.label,
      icon: n.icon,
      hint: n.href,
      keywords: `${n.label} ${KEYWORDS[n.href] ?? ''}`.toLowerCase(),
      run: () => router.push(n.href),
    }))
    const actions: Cmd[] = [
      { id: 'act:refresh', label: 'এই পেজ রিফ্রেশ করুন', icon: '↻', keywords: 'refresh reload রিফ্রেশ', run: () => window.location.reload() },
    ]
    return [...navCmds, ...actions]
  }, [business.id, role, router])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    const terms = q.split(/\s+/)
    return commands.filter(c => terms.every(t => c.keywords.includes(t)))
  }, [commands, query])

  // Global open shortcut + custom event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('alma-open-command', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('alma-open-command', onOpen)
    }
  }, [])

  // Focus input + reset selection when opening; reset selection as results change.
  useEffect(() => { if (open) { setActive(0); setTimeout(() => inputRef.current?.focus(), 30) } }, [open])
  useEffect(() => { setActive(0) }, [query])
  // Close on route change.
  useEffect(() => { close() }, [pathname, close])

  const select = useCallback((cmd: Cmd | undefined) => {
    if (!cmd) return
    tapHaptic()
    close()
    cmd.run()
  }, [close])

  const onListKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); select(results[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }, [results, active, select, close])

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[20050] flex items-start justify-center px-4 pt-[12vh] sm:pt-[16vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={close}
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
          <motion.div
            role="dialog"
            aria-label="Command palette"
            className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border-strong bg-card/95 shadow-2xl backdrop-blur-2xl"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onMouseDown={e => e.stopPropagation()}
            onKeyDown={onListKey}
          >
            <div className="flex items-center gap-2 border-b border-border-subtle px-4">
              <span className="text-muted">⌕</span>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="কোথায় যেতে চান? (পেজ / কাজ খুঁজুন)"
                className="w-full bg-transparent py-3.5 text-sm text-cream placeholder:text-muted focus:outline-none"
              />
              <kbd className="hidden shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-muted sm:block">esc</kbd>
            </div>
            <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5 scrollbar-hide">
              {results.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12px] text-muted">কিছু পাওয়া যায়নি</p>
              ) : (
                results.map((c, i) => {
                  const isActive = i === active
                  const here = c.id.startsWith('nav:') && c.hint && (c.hint === '/' ? pathname === '/' : pathname.startsWith(c.hint))
                  return (
                    <button
                      key={c.id}
                      data-idx={i}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => select(c)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
                        isActive ? 'bg-gold/12' : 'hover:bg-white/[0.03]',
                      )}
                    >
                      <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-base',
                        isActive ? 'border-gold/40 bg-gold/10' : 'border-border-subtle bg-bg-2')}>{c.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-[13px] font-semibold', isActive ? 'text-cream' : 'text-muted-hi')}>{c.label}</span>
                        {c.hint && <span className="block truncate text-[10px] text-muted">{c.hint}</span>}
                      </span>
                      {here && <span className="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold text-gold-lt">এখানে</span>}
                      {isActive && <span className="shrink-0 text-[11px] text-muted">↵</span>}
                    </button>
                  )
                })
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[10px] text-muted">
              <span>↑↓ চলাচল · ↵ যান</span>
              <span className="hidden sm:block">⌘K / Ctrl-K</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
