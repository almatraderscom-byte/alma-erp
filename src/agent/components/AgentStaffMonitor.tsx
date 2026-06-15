'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { motion } from 'framer-motion'
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
  task_dispatch: 'টাস্ক ডিসপ্যাচ',
  announcement: 'ঘোষণা',
  reminder: 'রিমাইন্ডার',
  presence: 'প্রেজেন্স',
  coaching: 'অ্যাটেনড্যান্স কোচিং',
  feedback_ack: 'ফিডব্যাক রিপ্লাই',
  task_redo: 'আবার করো',
  proof_reminder: 'প্রমাণ রিমাইন্ডার',
}

function typeLabel(type: string) {
  return TYPE_LABELS[type] ?? type
}

function FeedMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = content ?? ''
  const needsMore = text.length > FEED_PREVIEW_LEN

  return (
    <div className="mt-1 text-[#FAFAF8]/90">
      <div className={cn(!expanded && needsMore && 'line-clamp-2')}>
        {expanded || !needsMore ? (
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{text}</pre>
        ) : (
          <span className="text-xs">{text.slice(0, FEED_PREVIEW_LEN)}…</span>
        )}
      </div>
      {needsMore && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-1 text-[10px] font-semibold text-[#C9A84C] hover:text-[#E8C96A] transition-colors"
        >
          {expanded ? 'কম দেখুন' : 'আরও'}
        </button>
      )}
    </div>
  )
}

function statusDot(summary: StaffSummary) {
  if (summary.failed > 0) return '🔴'
  if (summary.dispatched > 0 && summary.delivered < summary.dispatched) return '🟡'
  if (summary.tasksTotal > 0 && summary.completionPct >= 100) return '🟢'
  if (summary.started) return '🟡'
  return '⚪'
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const ACK_TRACKED_TYPES = new Set([
  'task_dispatch',
  'announcement',
  'reminder',
  'coaching',
  'proof_reminder',
  'task_redo',
  'presence',
])

function tracksAck(m: StaffMonitorRow): boolean {
  if (m.requiresAck) return true
  return ACK_TRACKED_TYPES.has(m.type) && (m.status === 'delivered' || m.status === 'sent' || !!m.acknowledgedAt)
}

function AckStatus({ m }: { m: StaffMonitorRow }) {
  if (!tracksAck(m)) return null
  if (m.acknowledgedAt) {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center rounded-lg border border-emerald-400/30 bg-emerald-500/10 backdrop-blur-sm px-2.5 py-1 text-[10px] font-semibold text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.1)]">
          ✅ দেখেছেন · {fmtTime(m.acknowledgedAt)}
        </span>
      </div>
    )
  }
  if (m.status === 'delivered' || m.status === 'sent') {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center rounded-lg border border-amber-400/30 bg-amber-500/10 backdrop-blur-sm px-2.5 py-1 text-[10px] font-semibold text-amber-200 shadow-[0_0_8px_rgba(245,158,11,0.1)]">
          ⏳ এখনো দেখেননি
        </span>
      </div>
    )
  }
  if (m.status === 'queued' || m.status === 'pending') {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center rounded-lg border border-[#1E1E24] bg-white/5 backdrop-blur-sm px-2.5 py-1 text-[10px] text-[#9B9BA4]">
          📤 পাঠানো হচ্ছে…
        </span>
      </div>
    )
  }
  return null
}

function dutyIcon(status: AgentDutyRow['status']) {
  if (status === 'done') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'missed') return '🔴'
  if (status === 'skipped') return '⏭️'
  return '⏳'
}

function dutyRightText(d: AgentDutyRow): string {
  if (d.status === 'done' && d.ranAt) return fmtTime(d.ranAt)
  if (d.status === 'skipped' || d.status === 'missed') {
    return d.detail || (d.status === 'missed' ? 'মিস হয়েছে' : '')
  }
  if (d.time) return `🕒 ${d.time}`
  return ''
}

function salahRightText(s: SalahDutyRow): string {
  if (s.status === 'done' && s.doneTime) return `✓ ${s.doneTime}`
  return `🕒 ${s.scheduledTime}`
}

function salahIcon(status: SalahDutyRow['status']) {
  if (status === 'done') return '✅'
  if (status === 'missed') return '🔴'
  return '⏳'
}

const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
}

const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
}

function MonitorBody({ data, isLive }: { data: StaffMonitorData; isLive: boolean }) {
  return (
    <>
      {(data.warnings?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-red-300">⚠️ সতর্কতা</h2>
          {data.warnings.map((w, i) => (
            <div
              key={`${w.kind}-${i}`}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-xs backdrop-blur-md',
                w.severity === 'critical'
                  ? 'border-red-500/40 bg-red-500/10 text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.15)]'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-100 shadow-[0_0_16px_rgba(245,158,11,0.1)]',
              )}
            >
              {w.message}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[#C9A84C]">
          🤖 এজেন্টের কাজ {isLive ? '(লাইভ)' : '(আর্কাইভ)'}
        </h2>
        {(data.agentDuties ?? []).map((d) => (
          <div
            key={d.id}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2.5 backdrop-blur-md transition-all',
              d.status === 'failed' || d.status === 'missed'
                ? 'border-red-500/30 bg-red-500/[0.08] shadow-[inset_-2px_0_0_rgba(239,68,68,0.5),0_0_12px_rgba(239,68,68,0.08)]'
                : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05]',
            )}
          >
            <span className="shrink-0 text-base leading-none">{dutyIcon(d.status)}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-[#FAFAF8]/90">{d.label}</span>
            <span className="shrink-0 text-[11px] text-[#6B6B72] tabular-nums">{dutyRightText(d)}</span>
          </div>
        ))}

        {isLive && (data.salahDuties?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] backdrop-blur-md p-2.5 shadow-[0_0_16px_rgba(16,185,129,0.05)]">
            <div className="mb-1.5 text-xs font-bold text-emerald-300/90">🕌 আজকের সালাহ রিমাইন্ডার</div>
            {data.salahDuties.map((s) => (
              <div key={s.waqt} className="flex items-center gap-2 px-1 py-1 text-[12px]">
                <span className="shrink-0">{salahIcon(s.status)}</span>
                <span className="min-w-0 flex-1 truncate text-[#FAFAF8]/80">
                  {s.label}
                  {s.reminders ? ` · ${s.reminders} রিমাইন্ডার` : ''}
                </span>
                <span className="shrink-0 text-[11px] text-[#6B6B72] tabular-nums">{salahRightText(s)}</span>
              </div>
            ))}
          </div>
        )}

        {isLive && (data.continuousServices?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md px-3 py-2.5 text-[11px] text-[#9B9BA4]">
            🔄 চলমান সেবা:{' '}
            {data.continuousServices.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1">
                {s.label}{' '}
                <span className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  s.healthy
                    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                    : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]'
                )} />
                {' · '}
              </span>
            ))}
            {data.schedulerHealth?.ackEscalationLastRun && (
              <> ack check {fmtTime(data.schedulerHealth.ackEscalationLastRun)}</>
            )}
          </div>
        )}
      </div>

      {Object.keys(data.typeCounts ?? {}).length > 0 && (
        <p className="text-[10px] text-[#9B9BA4]">
          মেসেজ:{' '}
          {Object.entries(data.typeCounts)
            .map(([t, n]) => `${typeLabel(t)} ${n}`)
            .join(' · ')}
        </p>
      )}

      {isLive && (data.unackedMessages?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] backdrop-blur-md p-3 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
          <h2 className="text-sm font-bold text-amber-200">⏳ দেখেননি ({data.unackedMessages.length})</h2>
          <div className="mt-2 space-y-2">
            {data.unackedMessages.map((m) => (
              <div key={m.id} className="rounded-lg border border-amber-500/15 bg-white/[0.03] backdrop-blur-sm p-2.5 text-xs">
                <div className="flex justify-between text-amber-100/80">
                  <span>{m.staffName ?? '—'} · {typeLabel(m.type)}</span>
                  <span className="text-amber-200/70 font-medium tabular-nums">{m.sentAt ? fmtTime(m.sentAt) : fmtTime(m.createdAt)}</span>
                </div>
                <FeedMessage content={m.content ?? ''} />
                <AckStatus m={m} />
              </div>
            ))}
          </div>
        </div>
      )}

      {(data.failures?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.08] backdrop-blur-md p-3 text-sm text-red-200 shadow-[0_0_20px_rgba(239,68,68,0.1)]">
          🔴 {data.failures?.length ?? 0}টি মেসেজ পৌঁছায়নি
        </div>
      )}

      {(data.staffSummaries?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#C9A84C]">স্টাফ</h2>
          <motion.div
            className="grid gap-2 sm:grid-cols-2"
            variants={staggerContainer}
            initial="hidden"
            animate="show"
          >
            {data.staffSummaries.map((s) => (
              <motion.div
                key={s.staffId}
                variants={staggerItem}
                className={cn(
                  'rounded-xl border bg-white/[0.03] backdrop-blur-md p-3 text-xs transition-all',
                  s.failed > 0
                    ? 'border-red-500/25 shadow-[0_0_12px_rgba(239,68,68,0.08)]'
                    : s.completionPct >= 100
                      ? 'border-emerald-500/20 shadow-[0_0_12px_rgba(16,185,129,0.06)]'
                      : 'border-white/[0.08] hover:border-[#C9A84C]/20',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#FAFAF8]">{statusDot(s)} {s.staffName}</span>
                  <span className="text-[#9B9BA4] font-medium">{s.completionPct}%</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#8B6914] to-[#E8C96A] transition-all duration-500"
                    style={{ width: `${Math.min(s.completionPct, 100)}%` }}
                  />
                </div>
                <div className="mt-2 space-y-0.5 text-[#9B9BA4]">
                  <div>পাঠানো {s.dispatched} / পৌঁছেছে {s.delivered} / ব্যর্থ {s.failed}</div>
                  <div>কাজ {s.tasksDone}/{s.tasksTotal}</div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[#C9A84C]">মেসেজ ফিড</h2>
        {(data.feed?.length ?? 0) === 0 ? (
          <p className="text-xs text-[#6B6B72]">কোনো মেসেজ লগ নেই।</p>
        ) : (
          <motion.div
            className="space-y-2"
            variants={staggerContainer}
            initial="hidden"
            animate="show"
          >
            {data.feed?.map((m) => {
              const dot = m.status === 'delivered' ? '🟢' : m.status === 'failed' ? '🔴' : '🟡'
              return (
                <motion.div
                  key={m.id}
                  variants={staggerItem}
                  className={cn(
                    'rounded-xl border p-2.5 text-xs backdrop-blur-md transition-all',
                    m.status === 'failed'
                      ? 'border-red-500/25 bg-red-500/[0.06] shadow-[inset_3px_0_0_rgba(239,68,68,0.5)]'
                      : m.status === 'delivered'
                        ? 'border-white/[0.08] bg-white/[0.03] shadow-[inset_3px_0_0_rgba(16,185,129,0.4)]'
                        : 'border-white/[0.08] bg-white/[0.03] shadow-[inset_3px_0_0_rgba(234,179,8,0.4)]',
                  )}
                >
                  <div className="flex justify-between text-[#9B9BA4]">
                    <span>{dot} {m.staffName ?? '—'} · {typeLabel(m.type)}</span>
                    <span className="font-medium tabular-nums text-[#FAFAF8]/60">{fmtTime(m.createdAt)}</span>
                  </div>
                  <FeedMessage content={m.content ?? ''} />
                  <AckStatus m={m} />
                  {m.errorReason && <div className="mt-1 text-red-300">⚠️ {m.errorReason}</div>}
                </motion.div>
              )
            })}
          </motion.div>
        )}
      </div>
    </>
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
      <div className="p-4 text-red-400">
        লোড করা যায়নি: {err}
        <button type="button" onClick={() => void loadLive()} className="ml-2 text-[#C9A84C] underline hover:text-[#E8C96A]">আবার</button>
      </div>
    )
  }

  if (!liveData) {
    return <div className="p-4 text-[#6B6B72]">লোড হচ্ছে…</div>
  }

  return (
    <div className="mx-auto flex max-w-5xl gap-0 p-0 pb-8 lg:gap-4 lg:p-4">
      <div className="min-w-0 flex-1 space-y-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-black text-[#FAFAF8]">
              {viewingHistory ? (
                <>স্টাফ মনিটর — <span className="text-[#C9A84C]">{selectedDate}</span></>
              ) : (
                <>স্টাফ মনিটর <span className="text-[#C9A84C]">(লাইভ)</span></>
              )}
            </h1>
            <p className="text-[11px] text-[#6B6B72]">
              {viewingHistory
                ? 'আর্কাইভ দেখা · লাইভে ফিরতে "আজ" চাপুন'
                : `আজ (${liveData.today}) · প্রতি ১০ সেকেন্ডে আপডেট`}
              {!viewingHistory && liveData.generatedAt && (
                <> · সর্বশেষ {fmtTime(liveData.generatedAt)}</>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-0.5 text-[11px]">
              {(['ALL', 'ALMA_LIFESTYLE', 'ALMA_TRADING'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBusinessFilter(b)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 font-medium transition-all',
                    businessFilter === b
                      ? 'bg-[rgba(201,168,76,0.15)] border border-[rgba(201,168,76,0.3)] text-[#E8C96A] shadow-[0_0_12px_rgba(201,168,76,0.1)]'
                      : 'border border-transparent text-[#6B6B72] hover:text-[#FAFAF8]',
                  )}
                >
                  {b === 'ALL' ? 'All' : b === 'ALMA_LIFESTYLE' ? 'Lifestyle' : 'Trading'}
                </button>
              ))}
            </div>
            {viewingHistory ? (
              <button
                type="button"
                onClick={() => { setSelectedDate(null); setHistoryData(null) }}
                className="rounded-xl border border-[#C9A84C]/30 bg-[#C9A84C]/[0.06] backdrop-blur-sm px-3 py-1.5 text-[11px] font-semibold text-[#C9A84C] hover:bg-[#C9A84C]/10 hover:shadow-[0_0_12px_rgba(201,168,76,0.1)] transition-all"
              >
                ← আজ (লাইভ)
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loadLive(true)}
                disabled={syncing}
                className={cn(
                  'rounded-xl border backdrop-blur-sm px-3 py-1.5 text-[11px] font-semibold transition-all',
                  syncing
                    ? 'border-white/[0.08] text-[#6B6B72]'
                    : 'border-[#C9A84C]/30 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10 hover:shadow-[0_0_12px_rgba(201,168,76,0.1)]',
                )}
              >
                {syncing ? 'সিঙ্ক…' : '↻ সিঙ্ক'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm px-3 py-1.5 text-[11px] text-[#6B6B72] hover:text-[#FAFAF8] hover:border-[#C9A84C]/20 transition-all lg:hidden"
            >
              📅 ইতিহাস
            </button>
            <Link
              href="/agent"
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm px-3 py-1.5 text-[11px] text-[#6B6B72] hover:text-[#FAFAF8] hover:border-[#C9A84C]/20 transition-all"
            >
              ← Agent
            </Link>
          </div>
        </div>

        {displayData && <MonitorBody data={displayData} isLive={!viewingHistory} />}

        {!viewingHistory && (
          <div className="mt-4">
            <AgentSalahTimesSettings />
          </div>
        )}
      </div>

      <aside
        className={cn(
          'shrink-0 border-white/[0.08] backdrop-blur-xl bg-white/[0.02] lg:block lg:w-56 lg:rounded-2xl lg:border',
          historyOpen ? 'fixed inset-y-0 right-0 z-40 w-72 border-l bg-[#08080A]/90 backdrop-blur-xl p-3 shadow-[0_0_40px_rgba(0,0,0,0.5)]' : 'hidden',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#FAFAF8]">📅 ইতিহাস</h2>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            className="text-xs text-[#6B6B72] hover:text-[#FAFAF8] lg:hidden"
          >
            ✕
          </button>
        </div>
        <p className="mb-2 text-[10px] text-[#6B6B72]">গত {liveData.feedDays ?? 7} দিন — ক্লিক করলে সেই দিন</p>
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => { setSelectedDate(null); setHistoryData(null); setHistoryOpen(false) }}
            className={cn(
              'w-full rounded-lg px-2 py-2 text-left text-xs transition-all',
              !viewingHistory
                ? 'bg-[rgba(201,168,76,0.12)] border border-[rgba(201,168,76,0.25)] text-[#E8C96A] shadow-[0_0_10px_rgba(201,168,76,0.08)]'
                : 'border border-transparent text-[#9B9BA4] hover:bg-white/[0.04]',
            )}
          >
            আজ (লাইভ)
          </button>
          {(liveData.historyDates ?? []).map((date) => (
            <button
              key={date}
              type="button"
              onClick={() => { void loadHistoryDay(date); setHistoryOpen(false) }}
              className={cn(
                'w-full rounded-lg px-2 py-2 text-left text-xs transition-all',
                selectedDate === date
                  ? 'bg-white/[0.06] border border-white/[0.1] text-[#FAFAF8]'
                  : 'border border-transparent text-[#6B6B72] hover:bg-white/[0.04] hover:text-[#9B9BA4]',
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
