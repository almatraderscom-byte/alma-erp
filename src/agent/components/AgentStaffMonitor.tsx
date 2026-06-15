'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { StaffMonitorData, StaffSummary, StaffMonitorRow } from '@/agent/lib/staff-monitor-data'
import type { AgentDutyRow, SalahDutyRow } from '@/agent/lib/agent-duties'
import AgentSalahTimesSettings from '@/agent/components/AgentSalahTimesSettings'

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
    <div className="mt-1 text-zinc-200">
      <div className={cn(!expanded && needsMore && 'line-clamp-2')}>
        {expanded || !needsMore ? (
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{text}</pre>
        ) : (
          <span>{text.slice(0, FEED_PREVIEW_LEN)}…</span>
        )}
      </div>
      {needsMore && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-1 text-[10px] font-semibold text-gold hover:text-gold-lt"
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
        <span className="inline-flex items-center rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
          ✅ দেখেছেন · {fmtTime(m.acknowledgedAt)}
        </span>
      </div>
    )
  }
  if (m.status === 'delivered' || m.status === 'sent') {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold text-amber-200">
          ⏳ এখনো দেখেননি
        </span>
      </div>
    )
  }
  if (m.status === 'queued' || m.status === 'pending') {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center rounded-lg border border-zinc-500/30 bg-zinc-500/10 px-2.5 py-1 text-[10px] text-zinc-400">
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
                'rounded-xl border px-3 py-2 text-xs',
                w.severity === 'critical'
                  ? 'border-red-500/40 bg-red-500/10 text-red-100'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-100',
              )}
            >
              {w.message}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <h2 className="text-sm font-bold text-zinc-300">
          🤖 এজেন্টের কাজ {isLive ? '(লাইভ)' : '(আর্কাইভ)'}
        </h2>
        {(data.agentDuties ?? []).map((d) => (
          <div
            key={d.id}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2.5',
              d.status === 'failed' || d.status === 'missed'
                ? 'border-red-500/30 bg-red-500/[0.06]'
                : 'border-white/10 bg-white/[0.02]',
            )}
          >
            <span className="shrink-0 text-base leading-none">{dutyIcon(d.status)}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{d.label}</span>
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{dutyRightText(d)}</span>
          </div>
        ))}

        {isLive && (data.salahDuties?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 text-xs font-bold text-zinc-300">🕌 আজকের সালাহ রিমাইন্ডার</div>
            {data.salahDuties.map((s) => (
              <div key={s.waqt} className="flex items-center gap-2 px-1 py-1 text-[12px]">
                <span className="shrink-0">{salahIcon(s.status)}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">
                  {s.label}
                  {s.reminders ? ` · ${s.reminders} রিমাইন্ডার` : ''}
                </span>
                <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{salahRightText(s)}</span>
              </div>
            ))}
          </div>
        )}

        {isLive && (data.continuousServices?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-zinc-500">
            🔄 চলমান সেবা:{' '}
            {data.continuousServices.map((s) => `${s.label} ${s.healthy ? '🟢' : '🔴'}`).join(' · ')}
            {data.schedulerHealth?.ackEscalationLastRun && (
              <> · ack check {fmtTime(data.schedulerHealth.ackEscalationLastRun)}</>
            )}
          </div>
        )}
      </div>

      {Object.keys(data.typeCounts ?? {}).length > 0 && (
        <p className="text-[10px] text-muted-hi">
          মেসেজ:{' '}
          {Object.entries(data.typeCounts)
            .map(([t, n]) => `${typeLabel(t)} ${n}`)
            .join(' · ')}
        </p>
      )}

      {isLive && (data.unackedMessages?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <h2 className="text-sm font-bold text-amber-200">⏳ দেখেননি ({data.unackedMessages.length})</h2>
          <div className="mt-2 space-y-2">
            {data.unackedMessages.map((m) => (
              <div key={m.id} className="rounded-lg border border-amber-500/20 bg-black/20 p-2 text-xs">
                <div className="flex justify-between text-amber-100/80">
                  <span>{m.staffName ?? '—'} · {typeLabel(m.type)}</span>
                  <span>{m.sentAt ? fmtTime(m.sentAt) : fmtTime(m.createdAt)}</span>
                </div>
                <FeedMessage content={m.content ?? ''} />
                <AckStatus m={m} />
              </div>
            ))}
          </div>
        </div>
      )}

      {data.failures.length > 0 && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          🔴 {data.failures.length}টি মেসেজ পৌঁছায়নি
        </div>
      )}

      {data.staffSummaries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-zinc-300">স্টাফ</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.staffSummaries.map((s) => (
              <div key={s.staffId} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-cream">{statusDot(s)} {s.staffName}</span>
                  <span className="text-muted">{s.completionPct}%</span>
                </div>
                <div className="mt-2 space-y-0.5 text-muted-hi">
                  <div>পাঠানো {s.dispatched} / পৌঁছেছে {s.delivered} / ব্যর্থ {s.failed}</div>
                  <div>কাজ {s.tasksDone}/{s.tasksTotal}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-300">মেসেজ ফিড</h2>
        {data.feed.length === 0 ? (
          <p className="text-xs text-muted">কোনো মেসেজ লগ নেই।</p>
        ) : (
          data.feed.map((m) => {
            const dot = m.status === 'delivered' ? '🟢' : m.status === 'failed' ? '🔴' : '🟡'
            return (
              <div
                key={m.id}
                className={cn(
                  'rounded-lg border p-2 text-xs',
                  m.status === 'failed' ? 'border-red-500/30 bg-red-500/5' : 'border-white/10 bg-white/[0.02]',
                )}
              >
                <div className="flex justify-between text-zinc-400">
                  <span>{dot} {m.staffName ?? '—'} · {typeLabel(m.type)}</span>
                  <span>{fmtTime(m.createdAt)}</span>
                </div>
                <FeedMessage content={m.content ?? ''} />
                <AckStatus m={m} />
                {m.errorReason && <div className="mt-1 text-red-300">⚠️ {m.errorReason}</div>}
              </div>
            )
          })
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
  const displayData = viewingHistory ? historyData : liveData

  if (err && !displayData) {
    return (
      <div className="p-4 text-red-400">
        লোড করা যায়নি: {err}
        <button type="button" onClick={() => void loadLive()} className="ml-2 underline">আবার</button>
      </div>
    )
  }

  if (!liveData) {
    return <div className="p-4 text-zinc-400">লোড হচ্ছে…</div>
  }

  return (
    <div className="mx-auto flex max-w-5xl gap-0 p-0 pb-8 lg:gap-4 lg:p-4">
      <div className="min-w-0 flex-1 space-y-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-black text-cream">
              {viewingHistory ? `স্টাফ মনিটর — ${selectedDate}` : 'স্টাফ মনিটর (লাইভ)'}
            </h1>
            <p className="text-[11px] text-muted">
              {viewingHistory
                ? 'আর্কাইভ দেখা · লাইভে ফিরতে "আজ" চাপুন'
                : `আজ (${liveData.today}) · প্রতি ১০ সেকেন্ডে আপডেট`}
              {!viewingHistory && liveData.generatedAt && (
                <> · সর্বশেষ {fmtTime(liveData.generatedAt)}</>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {viewingHistory ? (
              <button
                type="button"
                onClick={() => { setSelectedDate(null); setHistoryData(null) }}
                className="rounded-xl border border-gold/40 px-3 py-1.5 text-[11px] font-semibold text-gold hover:bg-gold/10"
              >
                ← আজ (লাইভ)
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loadLive(true)}
                disabled={syncing}
                className={cn(
                  'rounded-xl border px-3 py-1.5 text-[11px] font-semibold transition-colors',
                  syncing ? 'border-white/10 text-muted' : 'border-gold/40 text-gold hover:bg-gold/10',
                )}
              >
                {syncing ? 'সিঙ্ক…' : '↻ সিঙ্ক'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="rounded-xl border border-white/[0.08] px-3 py-1.5 text-[11px] text-muted hover:text-cream lg:hidden"
            >
              📅 ইতিহাস
            </button>
            <Link
              href="/agent"
              className="rounded-xl border border-white/[0.08] px-3 py-1.5 text-[11px] text-muted hover:text-cream"
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
          'shrink-0 border-white/10 bg-black/40 lg:block lg:w-56 lg:rounded-2xl lg:border',
          historyOpen ? 'fixed inset-y-0 right-0 z-40 w-72 border-l p-3 shadow-2xl' : 'hidden',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-zinc-300">📅 ইতিহাস</h2>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            className="text-xs text-muted lg:hidden"
          >
            ✕
          </button>
        </div>
        <p className="mb-2 text-[10px] text-muted">গত {liveData.feedDays ?? 7} দিন — ক্লিক করলে সেই দিন</p>
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => { setSelectedDate(null); setHistoryData(null); setHistoryOpen(false) }}
            className={cn(
              'w-full rounded-lg px-2 py-2 text-left text-xs',
              !viewingHistory ? 'bg-gold/15 text-gold-lt' : 'text-zinc-400 hover:bg-white/5',
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
                'w-full rounded-lg px-2 py-2 text-left text-xs',
                selectedDate === date ? 'bg-white/10 text-cream' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300',
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
