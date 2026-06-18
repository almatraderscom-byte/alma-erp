'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { StaffSummary } from '@/agent/lib/staff-monitor-types'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const slideUp = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } } }

function statusInfo(s: StaffSummary): { dot: string; glow: string; border: string; label: string } {
  if (s.failed > 0) return { dot: 'bg-red-500', glow: 'shadow-[0_0_10px_rgba(239,68,68,0.5)]', border: 'border-red-500/30', label: 'Issues' }
  if (s.completionPct >= 100) return { dot: 'bg-emerald-500', glow: 'shadow-[0_0_10px_rgba(16,185,129,0.5)]', border: 'border-emerald-500/25', label: 'Complete' }
  if (s.started && s.completionPct >= 50) return { dot: 'bg-amber-500', glow: 'shadow-[0_0_10px_rgba(245,158,11,0.5)]', border: 'border-amber-500/20', label: 'Working' }
  if (s.started) return { dot: 'bg-amber-500', glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]', border: 'border-amber-500/15', label: 'Started' }
  return { dot: 'bg-zinc-400', glow: '', border: 'border-border-subtle', label: 'Idle' }
}

function ProgressRing({ percent, size = 36 }: { percent: number; size?: number }) {
  const stroke = 3
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(0,0,0,0.06)"
        strokeWidth={stroke}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="url(#coral-teal-gradient)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1, ease: 'easeOut' }}
      />
      <defs>
        <linearGradient id="coral-teal-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E07A5F" />
          <stop offset="50%" stopColor="#81B29A" />
          <stop offset="100%" stopColor="#81B29A" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function StaffInitial({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase()
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#E07A5F]/20 to-[#81B29A]/10 text-sm font-black text-[#E07A5F]">
      {initial}
    </div>
  )
}

export function MonitorStaffCards({ staffSummaries }: { staffSummaries: StaffSummary[] }) {
  if (!staffSummaries?.length) return null

  return (
    <motion.div variants={stagger} initial="hidden" animate="show">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">👥</span>
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Staff Overview</h3>
        <span className="rounded-md bg-[#E07A5F]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#E07A5F]">
          {staffSummaries.length} active
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {staffSummaries.map(s => {
          const info = statusInfo(s)
          return (
            <motion.div
              key={s.staffId}
              variants={slideUp}
              className={cn(
                'group relative overflow-hidden rounded-2xl border bg-card/60 backdrop-blur-2xl shadow-sm p-3.5',
                'transition-all duration-300 hover:shadow-md',
                info.border,
              )}
            >
              <div className="flex items-start gap-3">
                <div className="relative">
                  <StaffInitial name={s.staffName} />
                  <span className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white',
                    info.dot, info.glow,
                  )} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="truncate text-[13px] font-semibold text-cream">{s.staffName}</h4>
                    <span className={cn(
                      'shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider',
                      s.completionPct >= 100 ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600' :
                      s.completionPct >= 50 ? 'border-amber-500/25 bg-amber-500/10 text-amber-600' :
                      'border-border-subtle bg-transparent text-muted',
                    )}>
                      {info.label}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-[#E07A5F] via-[#81B29A] to-[#81B29A]"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(s.completionPct, 100)}%` }}
                        transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
                      />
                    </div>
                    <span className="text-[11px] font-bold tabular-nums text-muted">{s.completionPct}%</span>
                  </div>

                  <div className="mt-2 flex items-center gap-3 text-[10px] text-muted">
                    <span className="flex items-center gap-1">📤 {s.dispatched}</span>
                    <span className="flex items-center gap-1">✓ {s.delivered}</span>
                    {s.failed > 0 && <span className="text-red-500">✗ {s.failed}</span>}
                    <span className="ml-auto font-medium">🎯 {s.tasksDone}/{s.tasksTotal}</span>
                  </div>
                </div>

                <div className="shrink-0 opacity-80 transition-opacity group-hover:opacity-100">
                  <ProgressRing percent={s.completionPct} size={32} />
                </div>
              </div>
            </motion.div>
          )
        })}
      </div>
    </motion.div>
  )
}
