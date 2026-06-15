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
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-xl overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
          <span className="text-sm">⚡</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">Quick Actions</h3>
        </div>
        <div className="p-3">
          <div className="flex flex-wrap gap-2">
            {/* Deploy Worker */}
            <button
              type="button"
              disabled={deploying}
              onClick={onDeploy}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[11px] font-bold transition-all',
                deploying
                  ? 'border-white/[0.06] text-white/15 cursor-wait'
                  : 'border-purple-500/25 bg-purple-500/[0.06] text-purple-300 hover:bg-purple-500/10 hover:shadow-[0_0_20px_rgba(168,85,247,0.08)]',
              )}
            >
              {deploying ? (
                <>
                  <span className="inline-block h-2 w-2 animate-spin rounded-full border border-purple-300/30 border-t-purple-300" />
                  Deploying…
                </>
              ) : (
                <>🚀 Deploy Worker</>
              )}
            </button>

            {/* Retrigger Duty */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setRetriggerOpen(v => !v)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[11px] font-bold transition-all',
                  'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#E8C96A] hover:bg-[#C9A84C]/10 hover:shadow-[0_0_20px_rgba(201,168,76,0.08)]',
                )}
              >
                ⟳ Retrigger Duty
                {failedDuties.length > 0 && (
                  <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[8px] font-bold text-red-300">{failedDuties.length}</span>
                )}
              </button>
              {retriggerOpen && (
                <div className="absolute top-full left-0 z-30 mt-1 w-64 rounded-xl border border-white/[0.08] bg-[#0A0A0C]/95 p-2 shadow-2xl backdrop-blur-xl">
                  <input
                    type="text"
                    placeholder="Search duty…"
                    value={retriggerSearch}
                    onChange={e => setRetriggerSearch(e.target.value)}
                    className="mb-2 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[10px] text-white/70 outline-none placeholder:text-white/20"
                  />
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {filteredDuties.map(key => (
                      <button
                        key={key}
                        type="button"
                        disabled={retriggering}
                        onClick={() => { onRetrigger(key); setRetriggerOpen(false); setRetriggerSearch('') }}
                        className="w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] text-white/50 transition-all hover:bg-white/[0.04] hover:text-white/70"
                      >
                        {key.replace(/_/g, ' ')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Escalate All */}
            {unackedCount > 0 && (
              <button
                type="button"
                onClick={onEscalateAll}
                className="inline-flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-3.5 py-2 text-[11px] font-bold text-red-300 transition-all hover:bg-red-500/10 hover:shadow-[0_0_20px_rgba(239,68,68,0.08)]"
              >
                🔔 NTFY All ({unackedCount})
              </button>
            )}

            {/* Pending Approvals */}
            {pendingApprovals > 0 && (
              <span className="inline-flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-3.5 py-2 text-[11px] font-bold text-amber-300 animate-pulse">
                ⏳ {pendingApprovals} Pending
              </span>
            )}
          </div>

          {lastDeploy && (
            <p className="mt-2 text-[9px] text-white/15">Last deploy: {fmtTime(lastDeploy)}</p>
          )}
        </div>
      </div>
    </motion.div>
  )
}
