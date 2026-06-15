'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { AgentDutyRow, SalahDutyRow, StaffMonitorData } from '@/agent/lib/staff-monitor-types'
import { DUTY_TO_JOB } from '@/agent/lib/staff-monitor-types'

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

function dutyTimeSlot(d: AgentDutyRow): 'morning' | 'afternoon' | 'evening' | 'night' {
  const time = d.time ?? d.ranAt ?? ''
  if (!time) return 'morning'
  const h = parseInt(time.slice(0, 2), 10)
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 21) return 'evening'
  return 'night'
}

const slotConfig = {
  morning: { label: 'সকাল', icon: '🌅', color: 'text-amber-300/60' },
  afternoon: { label: 'দুপুর', icon: '☀️', color: 'text-yellow-300/60' },
  evening: { label: 'সন্ধ্যা', icon: '🌆', color: 'text-orange-300/60' },
  night: { label: 'রাত', icon: '🌙', color: 'text-blue-300/60' },
}

function DutyDot({ duty, isExpanded, onClick }: {
  duty: AgentDutyRow; isExpanded: boolean; onClick: () => void
}) {
  const statusClasses = {
    done: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    failed: 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]',
    missed: 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]',
    skipped: 'bg-zinc-500',
    pending: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse',
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group/dot relative flex flex-col items-center gap-1',
        isExpanded && 'z-10',
      )}
    >
      <div className={cn(
        'h-3.5 w-3.5 rounded-full transition-transform duration-200',
        statusClasses[duty.status] ?? statusClasses.pending,
        'group-hover/dot:scale-150',
        isExpanded && 'scale-150 ring-2 ring-white/20',
      )} />
      <span className={cn(
        'absolute -bottom-5 whitespace-nowrap text-[8px] text-white/0 transition-all',
        'group-hover/dot:text-white/40',
        isExpanded && 'text-white/50',
      )}>
        {duty.time ?? '—'}
      </span>
    </button>
  )
}

function DutyDetailInline({ duty, onRetrigger, retriggering }: {
  duty: AgentDutyRow
  onRetrigger: (key: string) => void
  retriggering: boolean
}) {
  const isFailed = duty.status === 'failed' || duty.status === 'missed'
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className={cn(
        'mt-2 rounded-xl border px-3 py-2.5 text-[11px]',
        isFailed ? 'border-red-500/20 bg-red-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02]',
      )}>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white/70">{duty.label}</span>
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase',
            duty.status === 'done' ? 'bg-emerald-500/15 text-emerald-300' :
            isFailed ? 'bg-red-500/15 text-red-300' :
            duty.status === 'skipped' ? 'bg-zinc-500/15 text-zinc-300' :
            'bg-amber-500/15 text-amber-300',
          )}>
            {duty.status}
          </span>
          {duty.ranAt && <span className="text-[10px] text-white/25">at {fmtTime(duty.ranAt)}</span>}
        </div>
        {duty.detail && (
          <p className={cn('mt-1.5 text-[10px]', isFailed ? 'text-red-300/70' : 'text-white/40')}>{duty.detail}</p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={retriggering || !DUTY_TO_JOB[duty.duty]}
            onClick={() => onRetrigger(duty.duty)}
            className={cn(
              'rounded-lg border px-2.5 py-1 text-[9px] font-bold transition-all',
              retriggering
                ? 'border-white/[0.06] text-white/20 cursor-wait'
                : isFailed
                  ? 'border-red-400/30 bg-red-500/[0.08] text-red-300 hover:bg-red-500/15'
                  : 'border-[#C9A84C]/30 bg-[#C9A84C]/[0.08] text-[#E8C96A] hover:bg-[#C9A84C]/15',
            )}
          >
            {retriggering ? '⏳ Running…' : '⟳ Retrigger'}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export function MonitorDutyTimeline({ data, onRetrigger, retriggering, isLive, dutyTimeOverrides, onEditDutyTime }: {
  data: AgentDutyRow[]
  onRetrigger: (dutyKey: string) => void
  retriggering: boolean
  isLive: boolean
  dutyTimeOverrides?: Record<string, string>
  onEditDutyTime?: (dutyKey: string, time: string) => void
}) {
  const [expandedDuty, setExpandedDuty] = useState<string | null>(null)

  const duties = data ?? []
  const totalDuties = duties.length
  const doneDuties = duties.filter(d => d.status === 'done').length
  const failedDuties = duties.filter(d => d.status === 'failed' || d.status === 'missed').length

  const grouped = {
    morning: duties.filter(d => dutyTimeSlot(d) === 'morning'),
    afternoon: duties.filter(d => dutyTimeSlot(d) === 'afternoon'),
    evening: duties.filter(d => dutyTimeSlot(d) === 'evening'),
    night: duties.filter(d => dutyTimeSlot(d) === 'night'),
  }

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-[#C9A84C]/20 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-[0_0_24px_rgba(201,168,76,0.04)]">
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">Agent Duties</h3>
          <span className="rounded-md bg-[#C9A84C]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#C9A84C]">
            {doneDuties}/{totalDuties} done
          </span>
          {failedDuties > 0 && (
            <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-300">
              {failedDuties} failed
            </span>
          )}
        </div>

        <div className="p-3">
          {/* Timeline dots view */}
          <div className="mb-4 overflow-x-auto pb-2">
            <div className="flex min-w-[600px] items-end gap-1 px-2">
              {(['morning', 'afternoon', 'evening', 'night'] as const).map(slot => {
                const cfg = slotConfig[slot]
                const slotDuties = grouped[slot]
                if (slotDuties.length === 0) return null
                return (
                  <div key={slot} className="flex flex-1 flex-col items-center gap-2">
                    <span className={cn('text-[9px] font-bold uppercase tracking-wider', cfg.color)}>
                      {cfg.icon} {cfg.label}
                    </span>
                    <div className="flex items-center gap-1.5 rounded-xl border border-white/[0.04] bg-white/[0.01] px-2 py-2">
                      {slotDuties.map(d => (
                        <DutyDot
                          key={d.id}
                          duty={d}
                          isExpanded={expandedDuty === d.duty}
                          onClick={() => setExpandedDuty(expandedDuty === d.duty ? null : d.duty)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Expanded duty detail */}
          <AnimatePresence>
            {expandedDuty && duties.find(d => d.duty === expandedDuty) && (
              <DutyDetailInline
                duty={duties.find(d => d.duty === expandedDuty)!}
                onRetrigger={onRetrigger}
                retriggering={retriggering}
              />
            )}
          </AnimatePresence>

          {/* List view */}
          <div className="mt-2 space-y-0.5">
            {duties.map(d => {
              const isFailed = d.status === 'failed' || d.status === 'missed'
              const isActive = expandedDuty === d.duty
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setExpandedDuty(isActive ? null : d.duty)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all hover:bg-white/[0.03]',
                    isFailed ? 'border-l-2 border-l-red-400/60' :
                    d.status === 'done' ? 'border-l-2 border-l-emerald-400/40' :
                    'border-l-2 border-l-amber-400/30',
                    isActive && 'bg-white/[0.03]',
                  )}
                >
                  <span className={cn(
                    'inline-block h-2 w-2 shrink-0 rounded-full',
                    d.status === 'done' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' :
                    isFailed ? 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]' :
                    d.status === 'skipped' ? 'bg-zinc-500' :
                    'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse',
                  )} />
                  <span className="min-w-0 flex-1 truncate text-white/70">{d.label}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-white/25">
                    {(dutyTimeOverrides ?? {})[d.duty] ?? (d.ranAt ? fmtTime(d.ranAt) : d.time ?? '')}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export function MonitorSalahTimeline({ salahDuties }: { salahDuties: SalahDutyRow[] }) {
  if (!salahDuties?.length) return null

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-emerald-500/20 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-[0_0_24px_rgba(16,185,129,0.04)]">
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
          <span className="text-sm">🕌</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">Salah Reminders</h3>
        </div>
        <div className="p-3 space-y-1">
          {salahDuties.map(s => (
            <div key={s.waqt} className="flex items-center gap-2.5 rounded-lg bg-white/[0.01] px-2.5 py-2 text-[12px]">
              <span className={cn(
                'inline-block h-2 w-2 shrink-0 rounded-full',
                s.status === 'done' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' :
                s.status === 'missed' ? 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]' :
                'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse',
              )} />
              <span className="min-w-0 flex-1 truncate text-white/80">
                {s.label}
                {s.reminders ? <span className="ml-1 text-[10px] text-white/30">({s.reminders}×)</span> : null}
              </span>
              <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/30">
                {s.status === 'done' && s.doneTime ? s.doneTime : s.scheduledTime}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
