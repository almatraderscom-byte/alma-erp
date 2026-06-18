'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { StaffMonitorData, StaffMonitorRow } from '@/agent/lib/staff-monitor-types'
import { DUTY_TO_JOB } from '@/agent/lib/staff-monitor-types'

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

export function MonitorQuickActions({ data, isLive, onDeploy, deploying, lastDeploy, onRetrigger, retriggering, onApprove, onEscalateAll }: {
  data: StaffMonitorData
  isLive: boolean
  onDeploy: () => void
  deploying: boolean
  lastDeploy: string | null
  onRetrigger: (dutyKey: string) => void
  retriggering: boolean
  onApprove: (actionId: string, decision: 'approve' | 'reject') => void
  onEscalateAll: () => void
}) {
  const [retriggerOpen, setRetriggerOpen] = useState(false)
  const [retriggerSearch, setRetriggerSearch] = useState('')

  const pendingApprovals = data.pendingApprovals?.length ?? 0
  const unackedCount = data.unackedMessages?.length ?? 0
  const failedDuties = (data.agentDuties ?? []).filter(d => d.status === 'failed' || d.status === 'missed')

  const allDutyKeys = Object.keys(DUTY_TO_JOB)
  const filteredDuties = retriggerSearch
    ? allDutyKeys.filter(k => k.toLowerCase().includes(retriggerSearch.toLowerCase()))
    : allDutyKeys

  if (!isLive) return null

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-border-subtle bg-card/80 shadow-sm">
        <div className="flex items-center gap-2 rounded-t-2xl border-b border-border-subtle px-4 py-2.5">
          <span className="text-sm">⚡</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Quick Actions</h3>
        </div>
        <div className="p-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={deploying}
              onClick={onDeploy}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[11px] font-bold transition-all',
                deploying
                  ? 'border-border-subtle text-muted cursor-wait'
                  : 'border-[#81B29A]/30 bg-[#81B29A]/[0.08] text-[#81B29A] hover:bg-[#81B29A]/15 hover:shadow-sm',
              )}
            >
              {deploying ? (
                <>
                  <span className="inline-block h-2 w-2 animate-spin rounded-full border border-[#81B29A]/30 border-t-[#81B29A]" />
                  Deploying…
                </>
              ) : (
                <>🚀 Deploy Worker</>
              )}
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setRetriggerOpen(v => !v)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[11px] font-bold transition-all',
                  'border-[#E07A5F]/25 bg-[#E07A5F]/[0.08] text-[#E07A5F] hover:bg-[#E07A5F]/15 hover:shadow-sm',
                )}
              >
                ⟳ Retrigger Duty
                {failedDuties.length > 0 && (
                  <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[8px] font-bold text-red-600">{failedDuties.length}</span>
                )}
              </button>
              {retriggerOpen && (
                <div className="absolute top-full left-0 z-30 mt-1 w-64 rounded-xl border border-border bg-card/80 p-2 shadow-xl">
                  <input
                    type="text"
                    placeholder="Search duty…"
                    value={retriggerSearch}
                    onChange={e => setRetriggerSearch(e.target.value)}
                    className="mb-2 w-full rounded-lg border border-border-subtle bg-transparent px-2.5 py-2 text-[13px] text-cream outline-none placeholder:text-muted"
                  />
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {filteredDuties.map(key => (
                      <button
                        key={key}
                        type="button"
                        disabled={retriggering}
                        onClick={() => { onRetrigger(key); setRetriggerOpen(false); setRetriggerSearch('') }}
                        className="w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] text-muted transition-all hover:bg-white/[0.04] hover:text-cream"
                      >
                        {key.replace(/_/g, ' ')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {unackedCount > 0 && (
              <button
                type="button"
                onClick={onEscalateAll}
                className="inline-flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-50 px-3.5 py-2 text-[11px] font-bold text-red-600 transition-all hover:bg-red-100 hover:shadow-sm"
              >
                🔔 NTFY All ({unackedCount})
              </button>
            )}

            {pendingApprovals > 0 && (
              <span className="inline-flex items-center gap-2 rounded-xl border border-[#D4A84B]/20 bg-[#D4A84B]/[0.06] px-3.5 py-2 text-[11px] font-bold text-[#D4A84B] animate-pulse">
                ⏳ {pendingApprovals} Pending
              </span>
            )}
          </div>

          {lastDeploy && (
            <p className="mt-2 text-[9px] text-muted">Last deploy: {fmtTime(lastDeploy)}</p>
          )}
        </div>
      </div>
    </motion.div>
  )
}
