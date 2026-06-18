'use client'
import { motion, AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import { useBusiness } from '@/contexts/BusinessContext'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { cn } from '@/lib/utils'

export function BusinessSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { businessId, setBusinessId, allowedBusinessIds } = useBusiness()
  const [open, setOpen] = useState(false)

  return (
    <motion.div layout className="px-2 pb-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-2 px-2.5 py-2 transition-colors hover:bg-gold/[0.06]',
          collapsed && 'justify-center px-2',
        )}
      >
        <span className="w-7 h-7 rounded-lg bg-gold/10 border border-gold/25 flex items-center justify-center shrink-0 text-[10px] font-black text-gold">
          {BUSINESS_LIST.find(b => b.id === businessId)?.brandInitial ?? 'A'}
        </span>
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              className="flex-1 min-w-0 text-left overflow-hidden"
            >
              <p className="text-[10px] font-bold text-cream truncate leading-tight">
                {BUSINESS_LIST.find(b => b.id === businessId)?.name}
              </p>
              <p className="text-[9px] text-muted">Switch business ▾</p>
            </motion.div>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1 space-y-1 overflow-hidden"
          >
            {BUSINESS_LIST.filter(b => allowedBusinessIds.includes(b.id)).map(b => {
              const active = b.id === businessId
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => {
                    setBusinessId(b.id as BusinessId)
                    setOpen(false)
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'bg-gold/10 border border-gold/25'
                      : 'hover:bg-bg-2 border border-transparent',
                  )}
                >
                  <span className="w-6 h-6 rounded-md bg-card border border-border-subtle flex items-center justify-center text-[9px] font-bold text-gold">
                    {b.brandInitial}
                  </span>
                  {!collapsed && (
                    <span className="text-[11px] font-semibold text-cream truncate">{b.name}</span>
                  )}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** Compact switcher for mobile top bar */
export function BusinessSwitcherCompact() {
  const { businessId, setBusinessId, allowedBusinessIds } = useBusiness()
  const list = BUSINESS_LIST.filter(b => allowedBusinessIds.includes(b.id))
  return (
    <select
      value={businessId}
      onChange={e => setBusinessId(e.target.value as BusinessId)}
      className="bg-card border border-border-subtle rounded-lg px-2 py-1 text-[10px] font-bold text-gold max-w-[140px] truncate"
      aria-label="Select business"
    >
      {list.map(b => (
        <option key={b.id} value={b.id}>{b.shortName}</option>
      ))}
    </select>
  )
}
