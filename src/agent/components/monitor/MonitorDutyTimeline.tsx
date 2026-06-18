'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { AgentDutyRow, SalahDutyRow, StaffMonitorData } from '@/agent/lib/staff-monitor-types'
import { DUTY_TO_JOB } from '@/agent/lib/staff-monitor-types'
import { DUTY_CATEGORY_META, dutyCategory } from '@/agent/lib/agent-duties'

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

const LOCKED_DUTIES = new Set(['salah_init'])

function DutyToggleSwitch({ dutyKey, enabled, toggling, onToggle }: {
  dutyKey: string
  enabled: boolean
  toggling: boolean
  onToggle: (dutyKey: string, enabled: boolean) => void
}) {
  if (LOCKED_DUTIES.has(dutyKey)) return null

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? 'Duty enabled' : 'Duty disabled'}
      disabled={toggling}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(dutyKey, !enabled)
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        enabled ? 'bg-emerald-500' : 'bg-zinc-400',
        toggling && 'opacity-60 cursor-wait',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-card/80 shadow transition-transform ml-0.5',
          enabled ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

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
  morning: { label: 'সকাল', icon: '🌅', color: 'text-amber-600' },
  afternoon: { label: 'দুপুর', icon: '☀️', color: 'text-[#D4A84B]' },
  evening: { label: 'সন্ধ্যা', icon: '🌆', color: 'text-[#E07A5F]' },
  night: { label: 'রাত', icon: '🌙', color: 'text-blue-500' },
}

function DutyDot({ duty, isExpanded, onClick }: {
  duty: AgentDutyRow; isExpanded: boolean; onClick: () => void
}) {
  const statusClasses = {
    done: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]',
    failed: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]',
    missed: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]',
    skipped: 'bg-zinc-400',
    pending: 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)] animate-pulse',
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
        isExpanded && 'scale-150 ring-2 ring-black/10',
      )} />
      <span className={cn(
        'absolute -bottom-5 whitespace-nowrap text-[8px] text-transparent transition-all',
        'group-hover/dot:text-muted',
        isExpanded && 'text-muted',
      )}>
        {duty.time ?? '—'}
      </span>
    </button>
  )
}

function DutyDetailInline({ duty, enabled, onRetrigger, retriggering, onToggleDuty, dutyToggling }: {
  duty: AgentDutyRow
  enabled: boolean
  onRetrigger: (key: string) => void
  retriggering: boolean
  onToggleDuty?: (dutyKey: string, enabled: boolean) => void
  dutyToggling?: string | null
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
        isFailed ? 'border-red-500/20 bg-red-50' : 'border-border-subtle bg-transparent',
      )}>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-cream/80">{duty.label}</span>
          {!enabled && (
            <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase bg-zinc-200 text-muted">
              OFF
            </span>
          )}
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase',
            duty.status === 'done' ? 'bg-emerald-500/15 text-emerald-600' :
            isFailed ? 'bg-red-500/15 text-red-600' :
            duty.status === 'skipped' ? 'bg-zinc-200 text-muted' :
            'bg-amber-500/15 text-amber-600',
          )}>
            {duty.status}
          </span>
          {duty.ranAt && <span className="text-[10px] text-muted">at {fmtTime(duty.ranAt)}</span>}
        </div>
        {duty.detail && (
          <p className={cn('mt-1.5 text-[10px]', isFailed ? 'text-red-600/70' : 'text-muted')}>{duty.detail}</p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {onToggleDuty && (
            <DutyToggleSwitch
              dutyKey={duty.duty}
              enabled={enabled}
              toggling={dutyToggling === duty.duty}
              onToggle={onToggleDuty}
            />
          )}
          <button
            type="button"
            disabled={retriggering || !DUTY_TO_JOB[duty.duty]}
            onClick={() => onRetrigger(duty.duty)}
            className={cn(
              'rounded-lg border px-2.5 py-1 text-[9px] font-bold transition-all',
              retriggering
                ? 'border-border-subtle text-muted cursor-wait'
                : isFailed
                  ? 'border-red-400/30 bg-red-50 text-red-600 hover:bg-red-100'
                  : 'border-[#E07A5F]/30 bg-[#E07A5F]/[0.08] text-[#E07A5F] hover:bg-[#E07A5F]/15',
            )}
          >
            {retriggering ? '⏳ Running…' : '⟳ Retrigger'}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export function MonitorDutyTimeline({ data, onRetrigger, retriggering, isLive, dutyTimeOverrides, onEditDutyTime, dutyEnabled, onToggleDuty, dutyToggling }: {
  data: AgentDutyRow[]
  onRetrigger: (dutyKey: string) => void
  retriggering: boolean
  isLive: boolean
  dutyTimeOverrides?: Record<string, string>
  onEditDutyTime?: (dutyKey: string, time: string) => void
  dutyEnabled?: Record<string, boolean>
  onToggleDuty?: (dutyKey: string, enabled: boolean) => void
  dutyToggling?: string | null
}) {
  const [expandedDuty, setExpandedDuty] = useState<string | null>(null)

  const duties = data ?? []
  const doneDuties = duties.filter(d => d.status === 'done').length
  const failedDuties = duties.filter(d => d.status === 'failed' || d.status === 'missed').length
  const enabledCount = duties.filter((d) => (dutyEnabled ?? {})[d.duty] !== false).length

  const grouped = {
    morning: duties.filter(d => dutyTimeSlot(d) === 'morning'),
    afternoon: duties.filter(d => dutyTimeSlot(d) === 'afternoon'),
    evening: duties.filter(d => dutyTimeSlot(d) === 'evening'),
    night: duties.filter(d => dutyTimeSlot(d) === 'night'),
  }

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-[#E07A5F]/20 bg-card/80 overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Agent Duties</h3>
          <span className="rounded-md bg-[#E07A5F]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#E07A5F]">
            {doneDuties}/{enabledCount} done
          </span>
          {failedDuties > 0 && (
            <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-600">
              {failedDuties} failed
            </span>
          )}
        </div>

        <div className="p-3">
          <div className="mb-4 overflow-x-auto pb-2">
            <div className="flex min-w-[520px] items-end gap-1 px-2">
              {(['morning', 'afternoon', 'evening', 'night'] as const).map(slot => {
                const cfg = slotConfig[slot]
                const slotDuties = grouped[slot]
                if (slotDuties.length === 0) return null
                return (
                  <div key={slot} className="flex flex-1 flex-col items-center gap-2">
                    <span className={cn('text-[9px] font-bold uppercase tracking-wider', cfg.color)}>
                      {cfg.icon} {cfg.label}
                    </span>
                    <div className="flex items-center gap-1.5 rounded-xl border border-border-subtle bg-transparent px-2 py-2">
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

          <AnimatePresence>
            {expandedDuty && duties.find(d => d.duty === expandedDuty) && (
              <DutyDetailInline
                duty={duties.find(d => d.duty === expandedDuty)!}
                enabled={(dutyEnabled ?? {})[expandedDuty] !== false}
                onRetrigger={onRetrigger}
                retriggering={retriggering}
                onToggleDuty={onToggleDuty}
                dutyToggling={dutyToggling}
              />
            )}
          </AnimatePresence>

          {/* Category-grouped duty toggles — easier to find what to switch off/on. */}
          <div className="mt-3 space-y-3">
            {DUTY_CATEGORY_META.map((cat) => {
              const catDuties = duties.filter((d) => dutyCategory(d.duty) === cat.key)
              if (catDuties.length === 0) return null
              const catEnabled = catDuties.filter((d) => (dutyEnabled ?? {})[d.duty] !== false).length
              return (
                <div key={cat.key}>
                  <div className="mb-1 flex items-center gap-1.5 px-1">
                    <span className="text-[12px]">{cat.icon}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted">{cat.label}</span>
                    <span className="text-[9px] tabular-nums text-muted">{catEnabled}/{catDuties.length} চালু</span>
                  </div>
                  <div className="space-y-0.5">
                    {catDuties.map(d => {
                      const isFailed = d.status === 'failed' || d.status === 'missed'
                      const isActive = expandedDuty === d.duty
                      const enabled = (dutyEnabled ?? {})[d.duty] !== false
                      return (
                        <div
                          key={d.id}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all',
                            !enabled && 'opacity-50',
                            isFailed ? 'border-l-2 border-l-red-500/60' :
                            d.status === 'done' ? 'border-l-2 border-l-emerald-500/40' :
                            'border-l-2 border-l-amber-500/30',
                            isActive && 'bg-white/[0.02]',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedDuty(isActive ? null : d.duty)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <span className={cn(
                              'inline-block h-2 w-2 shrink-0 rounded-full',
                              !enabled ? 'bg-zinc-400' :
                              d.status === 'done' ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' :
                              isFailed ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]' :
                              d.status === 'skipped' ? 'bg-zinc-400' :
                              'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)] animate-pulse',
                            )} />
                            <span className="min-w-0 flex-1 truncate text-cream/80">
                              {d.label}
                              {!enabled && <span className="ml-1 text-[9px] font-bold text-muted">OFF</span>}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-muted">
                              {(dutyTimeOverrides ?? {})[d.duty] ?? (d.ranAt ? fmtTime(d.ranAt) : d.time ?? '')}
                            </span>
                          </button>
                          {isLive && onToggleDuty && (
                            <DutyToggleSwitch
                              dutyKey={d.duty}
                              enabled={enabled}
                              toggling={dutyToggling === d.duty}
                              onToggle={onToggleDuty}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
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
      <div className="rounded-2xl border border-emerald-500/20 bg-card/80 overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <span className="text-sm">🕌</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Salah Reminders</h3>
        </div>
        <div className="p-3 space-y-1">
          {salahDuties.map(s => (
            <div key={s.waqt} className="flex items-center gap-2.5 rounded-lg bg-transparent px-2.5 py-2 text-[12px]">
              <span className={cn(
                'inline-block h-2 w-2 shrink-0 rounded-full',
                s.status === 'done' ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' :
                s.status === 'missed' ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]' :
                'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)] animate-pulse',
              )} />
              <span className="min-w-0 flex-1 truncate text-cream/90">
                {s.label}
                {s.reminders ? <span className="ml-1 text-[10px] text-muted">({s.reminders}×)</span> : null}
              </span>
              <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted">
                {s.status === 'done' && s.doneTime ? s.doneTime : s.scheduledTime}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
