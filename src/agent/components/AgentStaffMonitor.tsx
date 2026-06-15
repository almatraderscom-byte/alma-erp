'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type {
  StaffMonitorData,
  StaffSummary,
  StaffMonitorRow,
  AgentDutyRow,
  SalahDutyRow,
} from '@/agent/lib/staff-monitor-types'

const AgentSalahTimesSettings = dynamic(
  () => import('@/agent/components/AgentSalahTimesSettings'),
  { ssr: false, loading: () => null },
)

const FEED_PREVIEW_LEN = 120

const TYPE_LABELS: Record<string, string> = {
  task_dispatch: 'টাস্ক',
  announcement: 'ঘোষণা',
  reminder: 'রিমাইন্ডার',
  presence: 'প্রেজেন্স',
  coaching: 'কোচিং',
  feedback_ack: 'ফিডব্যাক',
  task_redo: 'রিডু',
  proof_reminder: 'প্রমাণ',
}

function typeLabel(type: string) {
  return TYPE_LABELS[type] ?? type
}

function FeedMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = content ?? ''
  const needsMore = text.length > FEED_PREVIEW_LEN

  return (
    <div className="mt-1.5">
      <div className={cn(!expanded && needsMore && 'line-clamp-2')}>
        {expanded || !needsMore ? (
          <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-white/80">{text}</pre>
        ) : (
          <span className="text-[11px] text-white/80">{text.slice(0, FEED_PREVIEW_LEN)}…</span>
        )}
      </div>
      {needsMore && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-1 text-[10px] font-semibold text-[#C9A84C] hover:text-[#E8C96A] transition-colors"
        >
          {expanded ? '▴ কম' : '▾ আরও'}
        </button>
      )}
    </div>
  )
}

function statusColor(summary: StaffSummary): { dot: string; ring: string; bg: string } {
  if (summary.failed > 0) return { dot: 'bg-red-400', ring: 'shadow-[0_0_8px_rgba(248,113,113,0.6)]', bg: 'border-red-500/25' }
  if (summary.dispatched > 0 && summary.delivered < summary.dispatched) return { dot: 'bg-amber-400', ring: 'shadow-[0_0_8px_rgba(251,191,36,0.6)]', bg: 'border-amber-500/20' }
  if (summary.tasksTotal > 0 && summary.completionPct >= 100) return { dot: 'bg-emerald-400', ring: 'shadow-[0_0_8px_rgba(52,211,153,0.6)]', bg: 'border-emerald-500/20' }
  if (summary.started) return { dot: 'bg-amber-400', ring: 'shadow-[0_0_8px_rgba(251,191,36,0.6)]', bg: 'border-amber-500/15' }
  return { dot: 'bg-zinc-500', ring: '', bg: 'border-white/[0.06]' }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const ACK_TRACKED_TYPES = new Set([
  'task_dispatch', 'announcement', 'reminder', 'coaching',
  'proof_reminder', 'task_redo', 'presence',
])

function tracksAck(m: StaffMonitorRow): boolean {
  if (m.requiresAck) return true
  return ACK_TRACKED_TYPES.has(m.type) && (m.status === 'delivered' || m.status === 'sent' || !!m.acknowledgedAt)
}

function AckBadge({ m }: { m: StaffMonitorRow }) {
  if (!tracksAck(m)) return null
  if (m.acknowledgedAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
        ✓ {fmtTime(m.acknowledgedAt)}
      </span>
    )
  }
  if (m.status === 'delivered' || m.status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">
        ⏳ unseen
      </span>
    )
  }
  if (m.status === 'queued' || m.status === 'pending') {
    return (
      <span className="inline-flex items-center rounded-md border border-zinc-600/30 bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400">
        sending…
      </span>
    )
  }
  return null
}

function dutyIcon(status: AgentDutyRow['status']) {
  if (status === 'done') return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
  if (status === 'failed') return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
  if (status === 'missed') return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
  if (status === 'skipped') return <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse" />
}

function dutyRightText(d: AgentDutyRow): string {
  if (d.status === 'done' && d.ranAt) return fmtTime(d.ranAt)
  if (d.status === 'skipped' || d.status === 'missed') return d.detail || (d.status === 'missed' ? 'missed' : '')
  if (d.time) return d.time
  return ''
}

function salahRightText(s: SalahDutyRow): string {
  if (s.status === 'done' && s.doneTime) return s.doneTime
  return s.scheduledTime
}

function salahIcon(status: SalahDutyRow['status']) {
  if (status === 'done') return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
  if (status === 'missed') return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse" />
}

function SectionCard({ title, icon, children, className, accent }: {
  title: string; icon?: string; children: React.ReactNode; className?: string
  accent?: 'gold' | 'emerald' | 'amber' | 'red' | 'blue'
}) {
  const accentColors = {
    gold: 'border-[#C9A84C]/20 shadow-[0_0_24px_rgba(201,168,76,0.04)]',
    emerald: 'border-emerald-500/20 shadow-[0_0_24px_rgba(16,185,129,0.04)]',
    amber: 'border-amber-500/20 shadow-[0_0_24px_rgba(245,158,11,0.04)]',
    red: 'border-red-500/20 shadow-[0_0_24px_rgba(239,68,68,0.04)]',
    blue: 'border-blue-500/20 shadow-[0_0_24px_rgba(59,130,246,0.04)]',
  }
  return (
    <div className={cn(
      'rounded-2xl border bg-white/[0.02] backdrop-blur-xl overflow-hidden',
      accent ? accentColors[accent] : 'border-white/[0.06]',
      className,
    )}>
      <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
        {icon && <span className="text-sm">{icon}</span>}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function LivePulse() {
  return (
    <span className="relative inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
      </span>
      Live
    </span>
  )
}

function ArchiveBadge({ date }: { date: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-600/30 bg-zinc-800/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
      <span className="inline-flex h-2 w-2 rounded-full bg-zinc-500" />
      {date}
    </span>
  )
}

const fadeIn = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}

function MonitorBody({ data, isLive }: { data: StaffMonitorData; isLive: boolean }) {
  const [feedExpanded, setFeedExpanded] = useState(false)
  const feedItems = data.feed ?? []
  const visibleFeed = feedExpanded ? feedItems : feedItems.slice(0, 6)

  const totalDuties = (data.agentDuties ?? []).length
  const doneDuties = (data.agentDuties ?? []).filter(d => d.status === 'done').length
  const failedDuties = (data.agentDuties ?? []).filter(d => d.status === 'failed' || d.status === 'missed').length

  return (
    <motion.div
      className="space-y-4"
      variants={staggerContainer}
      initial="hidden"
      animate="show"
    >
      {/* Warnings banner */}
      {(data.warnings?.length ?? 0) > 0 && (
        <motion.div variants={fadeIn} className="space-y-2">
          {data.warnings.map((w, i) => (
            <div
              key={`${w.kind}-${i}`}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-4 py-3 text-[12px] backdrop-blur-md',
                w.severity === 'critical'
                  ? 'border-red-500/30 bg-red-500/[0.06] text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.1)]'
                  : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-100',
              )}
            >
              <span className="mt-0.5 text-lg">{w.severity === 'critical' ? '🚨' : '⚠️'}</span>
              <span className="flex-1">{w.message}</span>
            </div>
          ))}
        </motion.div>
      )}

      {/* KPI row — quick stats */}
      <motion.div variants={fadeIn} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Agent Duties', value: `${doneDuties}/${totalDuties}`, sub: failedDuties > 0 ? `${failedDuties} failed` : 'on track', color: failedDuties > 0 ? 'text-red-400' : 'text-emerald-400' },
          { label: 'Staff Active', value: String(data.staffSummaries?.length ?? 0), sub: 'tracked today', color: 'text-[#E8C96A]' },
          { label: 'Unacked', value: String(data.unackedMessages?.length ?? 0), sub: 'pending', color: (data.unackedMessages?.length ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400' },
          { label: 'Failures', value: String(data.failures?.length ?? 0), sub: 'delivery', color: (data.failures?.length ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400' },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md px-3 py-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-white/30">{kpi.label}</p>
            <p className={cn('mt-0.5 text-xl font-black tabular-nums', kpi.color)}>{kpi.value}</p>
            <p className="text-[10px] text-white/30">{kpi.sub}</p>
          </div>
        ))}
      </motion.div>

      {/* Main 2-col grid: Duties + Salah | Staff cards */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        {/* Left column — duties & salah (3/5) */}
        <div className="space-y-3 lg:col-span-3">
          <motion.div variants={fadeIn}>
            <SectionCard title="Agent Duties" icon="🤖" accent="gold">
              <div className="space-y-1">
                {(data.agentDuties ?? []).map((d) => (
                  <div
                    key={d.id}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] transition-all',
                      (d.status === 'failed' || d.status === 'missed')
                        ? 'bg-red-500/[0.06] border-l-2 border-l-red-400/60'
                        : d.status === 'done'
                          ? 'bg-white/[0.01] border-l-2 border-l-emerald-400/40'
                          : 'bg-white/[0.01] border-l-2 border-l-amber-400/30',
                    )}
                  >
                    <span className="shrink-0">{dutyIcon(d.status)}</span>
                    <span className="min-w-0 flex-1 truncate text-white/80">{d.label}</span>
                    <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/30">{dutyRightText(d)}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </motion.div>

          {isLive && (data.salahDuties?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title="Salah Reminders" icon="🕌" accent="emerald">
                <div className="space-y-1">
                  {data.salahDuties.map((s) => (
                    <div key={s.waqt} className="flex items-center gap-2.5 rounded-lg bg-white/[0.01] px-2.5 py-2 text-[12px]">
                      <span className="shrink-0">{salahIcon(s.status)}</span>
                      <span className="min-w-0 flex-1 truncate text-white/80">
                        {s.label}
                        {s.reminders ? <span className="ml-1 text-[10px] text-white/30">({s.reminders}×)</span> : null}
                      </span>
                      <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/30">{salahRightText(s)}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </motion.div>
          )}

          {isLive && (data.continuousServices?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md px-4 py-2.5 text-[11px] text-white/40">
                <span className="font-bold uppercase tracking-wider text-white/25">Services</span>
                {data.continuousServices.map((s) => (
                  <span key={s.label} className="inline-flex items-center gap-1.5">
                    <span className={cn(
                      'inline-block h-1.5 w-1.5 rounded-full',
                      s.healthy ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
                    )} />
                    {s.label}
                  </span>
                ))}
                {data.schedulerHealth?.ackEscalationLastRun && (
                  <span className="text-white/20">ack {fmtTime(data.schedulerHealth.ackEscalationLastRun)}</span>
                )}
              </div>
            </motion.div>
          )}
        </div>

        {/* Right column — staff cards (2/5) */}
        <div className="space-y-3 lg:col-span-2">
          {(data.staffSummaries?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title="Staff Overview" icon="👥" accent="gold">
                <div className="space-y-2">
                  {data.staffSummaries.map((s) => {
                    const sc = statusColor(s)
                    return (
                      <div key={s.staffId} className={cn('rounded-xl border bg-white/[0.02] p-3', sc.bg)}>
                        <div className="flex items-center gap-2">
                          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', sc.dot, sc.ring)} />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white/90">{s.staffName}</span>
                          <span className="text-[12px] font-bold tabular-nums text-white/50">{s.completionPct}%</span>
                        </div>
                        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                          <motion.div
                            className="h-full rounded-full bg-gradient-to-r from-[#8B6914] via-[#C9A84C] to-[#E8C96A]"
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(s.completionPct, 100)}%` }}
                            transition={{ duration: 0.8, ease: 'easeOut' }}
                          />
                        </div>
                        <div className="mt-2 flex gap-3 text-[10px] text-white/30">
                          <span>📤 {s.dispatched}</span>
                          <span>✓ {s.delivered}</span>
                          {s.failed > 0 && <span className="text-red-400">✗ {s.failed}</span>}
                          <span className="ml-auto">🎯 {s.tasksDone}/{s.tasksTotal}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </SectionCard>
            </motion.div>
          )}

          {/* Unacked messages — attention panel */}
          {isLive && (data.unackedMessages?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title={`Pending Ack (${data.unackedMessages.length})`} icon="⏳" accent="amber">
                <div className="space-y-1.5">
                  {data.unackedMessages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-amber-500/10 bg-amber-500/[0.03] p-2 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-amber-100/80">{m.staffName ?? '—'}</span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-300">{typeLabel(m.type)}</span>
                          <span className="tabular-nums text-[10px] text-white/25">{m.sentAt ? fmtTime(m.sentAt) : fmtTime(m.createdAt)}</span>
                        </div>
                      </div>
                      <FeedMessage content={m.content ?? ''} />
                    </div>
                  ))}
                </div>
              </SectionCard>
            </motion.div>
          )}
        </div>
      </div>

      {/* Failures banner */}
      {(data.failures?.length ?? 0) > 0 && (
        <motion.div variants={fadeIn} className="rounded-xl border border-red-500/25 bg-red-500/[0.04] backdrop-blur-md px-4 py-3 text-[13px] font-semibold text-red-300 shadow-[0_0_20px_rgba(239,68,68,0.06)]">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
          {data.failures?.length ?? 0} delivery failure{(data.failures?.length ?? 0) > 1 ? 's' : ''}
        </motion.div>
      )}

      {/* Type counts summary */}
      {Object.keys(data.typeCounts ?? {}).length > 0 && (
        <motion.div variants={fadeIn} className="flex flex-wrap gap-2 px-1">
          {Object.entries(data.typeCounts).map(([t, n]) => (
            <span key={t} className="rounded-md border border-white/[0.04] bg-white/[0.02] px-2 py-1 text-[10px] font-medium text-white/25">
              {typeLabel(t)} <span className="text-white/50">{n}</span>
            </span>
          ))}
        </motion.div>
      )}

      {/* Message feed — collapsible */}
      <motion.div variants={fadeIn}>
        <SectionCard title="Message Feed" icon="📨" accent="blue">
          {feedItems.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-white/20">কোনো মেসেজ লগ নেই</p>
          ) : (
            <>
              <div className="space-y-1.5">
                {visibleFeed.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[11px] transition-all',
                      m.status === 'failed'
                        ? 'bg-red-500/[0.04] border-l-2 border-l-red-400/50'
                        : m.status === 'delivered'
                          ? 'bg-white/[0.01] border-l-2 border-l-emerald-400/30'
                          : 'bg-white/[0.01] border-l-2 border-l-amber-400/25',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white/60">{m.staffName ?? '—'}</span>
                        <span className="rounded bg-white/[0.04] px-1 py-0.5 text-[9px] font-semibold text-white/30">{typeLabel(m.type)}</span>
                        <AckBadge m={m} />
                        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-white/20">{fmtTime(m.createdAt)}</span>
                      </div>
                      <FeedMessage content={m.content ?? ''} />
                      {m.errorReason && <div className="mt-1 text-[10px] text-red-300">⚠ {m.errorReason}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {feedItems.length > 6 && (
                <button
                  type="button"
                  onClick={() => setFeedExpanded(v => !v)}
                  className="mt-2 w-full rounded-lg border border-white/[0.04] bg-white/[0.02] py-2 text-[10px] font-semibold text-white/30 transition-all hover:text-white/50 hover:border-[#C9A84C]/15"
                >
                  {feedExpanded ? `▴ Show less` : `▾ Show all ${feedItems.length} messages`}
                </button>
              )}
            </>
          )}
        </SectionCard>
      </motion.div>
    </motion.div>
  )
}

export default function AgentStaffMonitor() {
  const [liveData, setLiveData] = useState<StaffMonitorData | null>(null)
  const [historyData, setHistoryData] = useState<StaffMonitorData | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [businessFilter, setBusinessFilter] = useState<'ALL' | 'ALMA_LIFESTYLE' | 'ALMA_TRADING'>('ALL')

  const loadLive = useCallback(async (manual = false) => {
    if (manual) setSyncing(true)
    try {
      const res = await fetch('/api/agent/staff-monitor', { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      setLiveData(await res.json() as StaffMonitorData)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed')
    } finally {
      if (manual) setSyncing(false)
    }
  }, [])

  const loadHistoryDay = useCallback(async (date: string) => {
    setHistoryLoading(true)
    setSelectedDate(date)
    try {
      const res = await fetch(`/api/agent/staff-monitor?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('history load failed')
      setHistoryData(await res.json() as StaffMonitorData)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'history load failed')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void loadLive().then(() => { if (!alive) return })
    const t = setInterval(() => { if (alive) void loadLive() }, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [loadLive])

  const viewingHistory = Boolean(selectedDate && historyData)
  const rawDisplay = viewingHistory ? historyData : liveData

  const displayData = (() => {
    if (!rawDisplay) return null
    if (businessFilter === 'ALL') return rawDisplay
    const keep = (b: string | null | undefined) => (b ?? 'ALMA_LIFESTYLE') === businessFilter
    const feed = (rawDisplay.feed ?? []).filter((r) => keep(r.businessId))
    const unacked = (rawDisplay.unackedMessages ?? []).filter((r) => keep(r.businessId))
    const failures = (rawDisplay.failures ?? []).filter((r) => keep(r.businessId))
    const stafffeedIds = new Set([...feed, ...unacked].map((r) => r.staffId).filter(Boolean))
    const summaries = (rawDisplay.staffSummaries ?? []).filter((s) => stafffeedIds.has(s.staffId))
    return { ...rawDisplay, feed, unackedMessages: unacked, failures, staffSummaries: summaries }
  })()

  if (err && !displayData) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-6">
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] px-6 py-4 text-center text-sm text-red-300">
          লোড করা যায়নি: {err}
        </div>
        <button type="button" onClick={() => void loadLive()} className="rounded-xl border border-[#C9A84C]/30 bg-[#C9A84C]/[0.06] px-4 py-2 text-xs font-semibold text-[#C9A84C] hover:bg-[#C9A84C]/10 transition-all">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  if (!liveData) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="flex items-center gap-3 text-white/30">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#C9A84C]/30 border-t-[#C9A84C]" />
          <span className="text-sm">Loading monitor…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl gap-0 pb-8 lg:gap-4 lg:p-4">
      {/* Main content */}
      <div className="min-w-0 flex-1 space-y-4 p-3 sm:p-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-black tracking-tight text-white/90">Staff Monitor</h1>
              {viewingHistory ? <ArchiveBadge date={selectedDate!} /> : <LivePulse />}
            </div>
            <p className="mt-1 text-[11px] text-white/25">
              {viewingHistory
                ? 'Viewing archive · press "Today" to return'
                : (
                  <>
                    {liveData.today} · auto-refresh 10s
                    {liveData.generatedAt && <> · last {fmtTime(liveData.generatedAt)}</>}
                  </>
                )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* Business filter */}
            <div className="inline-flex rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-0.5">
              {(['ALL', 'ALMA_LIFESTYLE', 'ALMA_TRADING'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBusinessFilter(b)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-all',
                    businessFilter === b
                      ? 'bg-[rgba(201,168,76,0.12)] text-[#E8C96A] shadow-[0_0_10px_rgba(201,168,76,0.08)]'
                      : 'text-white/20 hover:text-white/40',
                  )}
                >
                  {b === 'ALL' ? 'All' : b === 'ALMA_LIFESTYLE' ? 'Life' : 'Trade'}
                </button>
              ))}
            </div>

            {viewingHistory ? (
              <button
                type="button"
                onClick={() => { setSelectedDate(null); setHistoryData(null) }}
                className="rounded-xl border border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] px-3 py-1.5 text-[10px] font-bold text-[#C9A84C] transition-all hover:bg-[#C9A84C]/10"
              >
                ← Today
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loadLive(true)}
                disabled={syncing}
                className={cn(
                  'rounded-xl border px-3 py-1.5 text-[10px] font-bold transition-all',
                  syncing
                    ? 'border-white/[0.06] text-white/15'
                    : 'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10',
                )}
              >
                {syncing ? '…' : '↻ Sync'}
              </button>
            )}

            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40 lg:hidden"
            >
              📅
            </button>

            <Link
              href="/agent"
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40"
            >
              ← Chat
            </Link>
          </div>
        </div>

        {/* Dashboard body */}
        {displayData && <MonitorBody data={displayData} isLive={!viewingHistory} />}

        {/* Salah settings */}
        {!viewingHistory && (
          <div className="mt-4">
            <AgentSalahTimesSettings />
          </div>
        )}
      </div>

      {/* History sidebar */}
      <aside
        className={cn(
          'shrink-0 lg:block lg:w-52 lg:rounded-2xl lg:border lg:border-white/[0.06] lg:bg-white/[0.02] lg:backdrop-blur-xl lg:p-3',
          historyOpen ? 'fixed inset-y-0 right-0 z-40 w-64 border-l border-white/[0.06] bg-[#08080A]/95 backdrop-blur-2xl p-4 shadow-[0_0_40px_rgba(0,0,0,0.6)]' : 'hidden',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/40">History</h2>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            className="text-xs text-white/20 hover:text-white/50 lg:hidden"
          >
            ✕
          </button>
        </div>
        <p className="mb-3 text-[10px] text-white/15">Last {liveData.feedDays ?? 7} days</p>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => { setSelectedDate(null); setHistoryData(null); setHistoryOpen(false) }}
            className={cn(
              'w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium transition-all',
              !viewingHistory
                ? 'bg-[rgba(201,168,76,0.1)] text-[#E8C96A]'
                : 'text-white/25 hover:bg-white/[0.03] hover:text-white/40',
            )}
          >
            Today (live)
          </button>
          {(liveData.historyDates ?? []).map((date) => (
            <button
              key={date}
              type="button"
              onClick={() => { void loadHistoryDay(date); setHistoryOpen(false) }}
              className={cn(
                'w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium tabular-nums transition-all',
                selectedDate === date
                  ? 'bg-white/[0.05] text-white/70'
                  : 'text-white/20 hover:bg-white/[0.03] hover:text-white/35',
              )}
            >
              {date}
              {historyLoading && selectedDate === date ? ' …' : ''}
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
