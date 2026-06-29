'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type {
  StaffSummary,
  GeoStaffStatus,
  ProductivityAlert,
} from '@/agent/lib/staff-monitor-types'

/** Capability profile row as served by /api/agent/staff-capabilities. */
export interface StaffCapRow {
  staffId: string
  staffName: string
  overallCompletionRate: number
  strongTypes: string[]
  weakTypes: string[]
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const slideUp = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } } }

function statusInfo(s: StaffSummary): { dot: string; glow: string; border: string; label: string } {
  if (s.checkedIn === false) return { dot: 'bg-zinc-300', glow: '', border: 'border-border-subtle', label: 'Awaiting' }
  if (s.failed > 0) return { dot: 'bg-red-500', glow: 'shadow-[0_0_10px_rgba(239,68,68,0.5)]', border: 'border-red-500/30', label: 'Issues' }
  if (s.completionPct >= 100) return { dot: 'bg-emerald-500', glow: 'shadow-[0_0_10px_rgba(16,185,129,0.5)]', border: 'border-emerald-500/25', label: 'Complete' }
  if (s.started && s.completionPct >= 50) return { dot: 'bg-amber-500', glow: 'shadow-[0_0_10px_rgba(245,158,11,0.5)]', border: 'border-amber-500/20', label: 'Working' }
  if (s.started) return { dot: 'bg-amber-500', glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]', border: 'border-amber-500/15', label: 'Started' }
  return { dot: 'bg-zinc-400', glow: '', border: 'border-border-subtle', label: 'Idle' }
}

function StaffInitial({ name }: { name: string }) {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#E07A5F]/20 to-[#81B29A]/10 text-sm font-black text-[#E07A5F]">
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

const GEO_LABEL: Record<GeoStaffStatus['status'], { icon: string; text: string; cls: string }> = {
  in_zone: { icon: '✅', text: 'অফিসে', cls: 'text-emerald-600' },
  outside: { icon: '🚨', text: 'বাইরে', cls: 'text-red-600' },
  stale: { icon: '⏸️', text: 'পুরোনো লোকেশন', cls: 'text-amber-600' },
  no_data: { icon: '❓', text: 'লোকেশন নেই', cls: 'text-muted' },
}

/** One staff member's quick-action set. Each action returns a ready Bangla
 *  command that the parent deep-links into the chat composer — so every action
 *  still flows through the agent + confirm-card safety layer (no raw mutation). */
function quickActions(name: string): Array<{ key: string; label: string; icon: string; command: string }> {
  return [
    { key: 'task', label: 'টাস্ক দাও', icon: '📋', command: `${name}কে নতুন টাস্ক দাও: ` },
    { key: 'msg', label: 'মেসেজ', icon: '💬', command: `${name}কে একটা মেসেজ পাঠাও: ` },
    { key: 'verify', label: 'প্রুফ যাচাই', icon: '✅', command: `${name} আজকে যেসব কাজের প্রুফ দিয়েছে সেগুলো যাচাই করো।` },
    { key: 'perf', label: 'পারফরম্যান্স', icon: '📈', command: `${name}-এর এই সপ্তাহের পারফরম্যান্স রিভিউ দাও।` },
    { key: 'loc', label: 'লোকেশন', icon: '📍', command: `${name} এখন কোথায় আছে?` },
  ]
}

export function MonitorStaffHub({
  staffSummaries,
  staffCaps,
  geoStatus,
  productivityAlerts,
  onAction,
}: {
  staffSummaries: StaffSummary[]
  staffCaps?: StaffCapRow[]
  geoStatus?: GeoStaffStatus[]
  productivityAlerts?: ProductivityAlert[]
  onAction: (command: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!staffSummaries?.length) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-card/60 px-4 py-6 text-center">
        <p className="text-2xl">👥</p>
        <p className="mt-1 text-[12px] font-medium text-muted">আজকে কোনো স্টাফ অ্যাক্টিভ নেই।</p>
        <button
          type="button"
          onClick={() => onAction('স্টাফদের আজকের টাস্ক প্রপোজাল বানাও।')}
          className="mt-3 rounded-full border border-[#E07A5F]/30 bg-[#E07A5F]/10 px-3 py-1.5 text-[11px] font-semibold text-[#E07A5F] transition-colors hover:bg-[#E07A5F]/15"
        >
          ➕ আজকের টাস্ক প্ল্যান করো
        </button>
      </div>
    )
  }

  const activeCount = staffSummaries.filter(s => s.checkedIn !== false).length
  const capById = new Map((staffCaps ?? []).map(c => [c.staffId, c]))
  const geoById = new Map((geoStatus ?? []).map(g => [g.staffId, g]))
  const alertsById = new Map<string, ProductivityAlert[]>()
  for (const a of productivityAlerts ?? []) {
    const arr = alertsById.get(a.staffId) ?? []
    arr.push(a)
    alertsById.set(a.staffId, arr)
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">👥</span>
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Staff Hub</h3>
        <span className="rounded-md bg-[#E07A5F]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#E07A5F]">
          {activeCount} active
        </span>
        <span className="ml-auto text-[9px] text-muted">ট্যাপ করে অ্যাকশন</span>
      </div>

      <div className="space-y-2">
        {staffSummaries.map(s => {
          const info = statusInfo(s)
          const cap = capById.get(s.staffId)
          const geo = geoById.get(s.staffId)
          const alerts = alertsById.get(s.staffId) ?? []
          const isOpen = expanded === s.staffId

          return (
            <motion.div
              key={s.staffId}
              variants={slideUp}
              className={cn(
                'overflow-hidden rounded-2xl border bg-card/80 shadow-sm transition-all duration-300',
                info.border,
                isOpen && 'shadow-md ring-1 ring-[#E07A5F]/15',
              )}
            >
              {/* Header row — tap to expand */}
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : s.staffId)}
                className="flex w-full items-start gap-3 p-3.5 text-left"
                aria-expanded={isOpen}
              >
                <div className="relative">
                  <StaffInitial name={s.staffName} />
                  <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white', info.dot, info.glow)} />
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
                    <span>📤 {s.dispatched}</span>
                    <span>✓ {s.delivered}</span>
                    {s.failed > 0 && <span className="text-red-500">✗ {s.failed}</span>}
                    <span className="font-medium">🎯 {s.tasksDone}/{s.tasksTotal}</span>
                    {geo && <span className={cn('ml-auto', GEO_LABEL[geo.status].cls)}>{GEO_LABEL[geo.status].icon}</span>}
                    <span className={cn('text-muted transition-transform', geo ? '' : 'ml-auto', isOpen && 'rotate-180')}>⌄</span>
                  </div>
                </div>
              </button>

              {/* Expanded detail + actions */}
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-border-subtle px-3.5 pb-3.5 pt-3">
                      {/* Capability + geo facts */}
                      <div className="mb-3 space-y-1.5 text-[11px]">
                        {cap && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-semibold text-cream/80">দক্ষতা {cap.overallCompletionRate}%</span>
                            {cap.strongTypes.length > 0 && <span className="text-emerald-600/80">💪 {cap.strongTypes.join(', ')}</span>}
                            {cap.weakTypes.length > 0 && <span className="text-red-500/70">📈 {cap.weakTypes.join(', ')}</span>}
                          </div>
                        )}
                        {geo && (
                          <div className="flex items-center gap-2">
                            <span className={cn('font-medium', GEO_LABEL[geo.status].cls)}>
                              {GEO_LABEL[geo.status].icon} {GEO_LABEL[geo.status].text}
                              {geo.status === 'outside' && geo.distanceM ? ` (${geo.distanceM}m)` : ''}
                            </span>
                            {geo.mapsLink && (
                              <a href={geo.mapsLink} target="_blank" rel="noopener noreferrer" className="text-[10px] underline text-muted">📍 ম্যাপ</a>
                            )}
                          </div>
                        )}
                        {alerts.map((a, i) => (
                          <div key={i} className="text-amber-600/90">⚡ {a.message}</div>
                        ))}
                        {!cap && !geo && alerts.length === 0 && (
                          <p className="text-muted">এই স্টাফের অতিরিক্ত ডেটা এখনও নেই।</p>
                        )}
                      </div>

                      {/* Quick actions */}
                      <div className="flex flex-wrap gap-1.5">
                        {quickActions(s.staffName).map(a => (
                          <button
                            key={a.key}
                            type="button"
                            onClick={() => onAction(a.command)}
                            className="flex items-center gap-1 rounded-full border border-border-subtle bg-transparent px-2.5 py-1.5 text-[11px] font-semibold text-cream/80 transition-colors hover:border-[#E07A5F]/30 hover:bg-[#E07A5F]/10 hover:text-[#E07A5F]"
                          >
                            <span>{a.icon}</span>{a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}
      </div>
    </motion.div>
  )
}
