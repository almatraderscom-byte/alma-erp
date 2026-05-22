'use client'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Card } from '@/components/ui'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DATE_PRESETS, type DatePreset } from '@/lib/order-analytics'
import { useMdUp } from '@/hooks/useMdUp'
import { cn } from '@/lib/utils'

export function DateRangeFilter({ className }: { className?: string }) {
  const mdUp = useMdUp()
  const { preset, customStart, customEnd, label, setPreset, setCustomRange } = useDateRange()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftStart, setDraftStart] = useState(customStart)
  const [draftEnd, setDraftEnd] = useState(customEnd)

  function selectPreset(id: DatePreset) {
    setPreset(id)
    if (id !== 'custom') setSheetOpen(false)
    else if (!mdUp) {
      setDraftStart(customStart || '')
      setDraftEnd(customEnd || '')
      setSheetOpen(true)
    }
  }

  function applyCustom() {
    if (draftStart && draftEnd) {
      setCustomRange(draftStart, draftEnd)
      setSheetOpen(false)
    }
  }

  return (
    <motion.div
      layout
      className={cn('space-y-2', className)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* Preset pills — horizontal scroll on mobile */}
      <motion.div layout className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 -mx-1 px-1">
        {DATE_PRESETS.map(p => {
          const active = preset === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPreset(p.id)}
              className={cn(
                'shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold border transition-all duration-200',
                active
                  ? 'bg-gold/15 border-gold-dim/60 text-gold-lt shadow-sm shadow-gold/10'
                  : 'border-border text-zinc-500 hover:text-zinc-300 hover:border-zinc-600',
              )}
            >
              {p.label}
            </button>
          )
        })}
      </motion.div>

      {/* Desktop custom range + label */}
      {mdUp && (
        <div className="flex flex-wrap items-center gap-2">
          {preset === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customStart}
                onChange={e => setCustomRange(e.target.value, customEnd || e.target.value)}
                className="bg-card border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-cream font-mono focus:outline-none focus:border-gold-dim/50"
              />
              <span className="text-zinc-600 text-xs">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomRange(customStart || e.target.value, e.target.value)}
                className="bg-card border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-cream font-mono focus:outline-none focus:border-gold-dim/50"
              />
            </div>
          )}
          <span className="text-[10px] text-zinc-500 font-mono ml-auto">{label}</span>
        </div>
      )}

      {/* Mobile: tap custom opens bottom sheet */}
      {!mdUp && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-500 font-mono">{label}</span>
            {preset === 'custom' && (
              <button
                type="button"
                onClick={() => {
                  setDraftStart(customStart)
                  setDraftEnd(customEnd)
                  setSheetOpen(true)
                }}
                className="text-[11px] text-gold-lt font-semibold"
              >
                Edit dates
              </button>
            )}
          </div>

          {sheetOpen && (
            <MobileModalPortal open zIndex={200} onBackdropClick={() => setSheetOpen(false)} aria-label="Custom date range">
              <Card className="mobile-modal-shell mobile-sheet mx-auto w-full max-w-lg rounded-t-[28px] border border-border bg-surface shadow-2xl sm:rounded-2xl">
                <div className="mobile-modal-header px-5 pb-3 pt-4">
                  <div className="mb-4 h-1 w-10 rounded-full bg-border mx-auto" />
                  <p className="text-sm font-bold text-cream">Custom date range</p>
                </div>
                <div className="mobile-modal-body space-y-3 px-5 pb-4">
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">From</span>
                    <input
                      type="date"
                      value={draftStart}
                      onChange={e => setDraftStart(e.target.value)}
                      className="w-full bg-card border border-border rounded-xl px-3 py-3 text-sm text-cream font-mono"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">To</span>
                    <input
                      type="date"
                      value={draftEnd}
                      onChange={e => setDraftEnd(e.target.value)}
                      className="w-full bg-card border border-border rounded-xl px-3 py-3 text-sm text-cream font-mono"
                    />
                  </label>
                </div>
                <div className="mobile-modal-footer px-5 pt-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSheetOpen(false)}
                      className="flex-1 py-3 rounded-xl border border-border text-sm text-zinc-400 font-semibold"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={applyCustom}
                      disabled={!draftStart || !draftEnd}
                      className="flex-1 py-3 rounded-xl bg-gold/20 border border-gold-dim/50 text-sm text-gold-lt font-bold disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </Card>
            </MobileModalPortal>
          )}
        </>
      )}
    </motion.div>
  )
}
