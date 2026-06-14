'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { StaffMonitorData, StaffSummary } from '@/agent/lib/staff-monitor-data'
import type { AgentDutyRow, SalahDutyRow } from '@/agent/lib/agent-duties'

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

export default function AgentStaffMonitor() {
  const [data, setData] = useState<StaffMonitorData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async (manual = false) => {
    if (manual) setSyncing(true)
    try {
      const res = await fetch('/api/agent/staff-monitor', {
        cache: 'no-store',
        headers: manual ? { 'Cache-Control': 'no-cache' } : undefined,
      })
      if (!res.ok) throw new Error('load failed')
      const json = (await res.json()) as StaffMonitorData
      setData(json)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed')
    } finally {
      if (manual) setSyncing(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void load().then(() => { if (!alive) return })
    const t = setInterval(() => { if (alive) void load() }, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [load])

  if (err) {
    return (
      <div className="p-4 text-red-400">
        লোড করা যায়নি: {err}
        <button type="button" onClick={() => void load()} className="ml-2 underline">আবার</button>
      </div>
    )
  }

  if (!data) {
    return <div className="p-4 text-zinc-400">লোড হচ্ছে…</div>
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 pb-8 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-black text-cream">স্টাফ মনিটর (লাইভ)</h1>
          <p className="text-[11px] text-muted">
            আজ ({data.today}) · প্রতি ১০ সেকেন্ডে আপডেট · ইতিহাস {data.feedDays ?? 7} দিন
            {data.generatedAt && (
              <> · সর্বশেষ {fmtTime(data.generatedAt)}</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={syncing}
            className={cn(
              'rounded-xl border px-3 py-1.5 text-[11px] font-semibold transition-colors',
              syncing
                ? 'border-white/10 text-muted'
                : 'border-gold/40 text-gold hover:bg-gold/10',
            )}
          >
            {syncing ? 'সিঙ্ক…' : '↻ সিঙ্ক'}
          </button>
          <Link
            href="/agent"
            className="rounded-xl border border-white/[0.08] px-3 py-1.5 text-[11px] text-muted hover:text-cream"
          >
            ← Agent
          </Link>
        </div>
      </div>

      {(data.warnings?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-red-300">⚠️ সতর্কতা / silent issues</h2>
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
        <h2 className="text-sm font-bold text-zinc-300">🤖 এজেন্টের আজকের কাজ (লাইভ)</h2>
        {(data.agentDuties ?? []).map((d) => {
          const icon = dutyIcon(d.status)
          const rightText = dutyRightText(d)
          return (
            <div
              key={d.id}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-3 py-2.5',
                d.status === 'failed' || d.status === 'missed'
                  ? 'border-red-500/30 bg-red-500/[0.06]'
                  : 'border-white/10 bg-white/[0.02]',
              )}
            >
              <span className="shrink-0 text-base leading-none">{icon}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{d.label}</span>
              <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{rightText}</span>
            </div>
          )
        })}

        {(data.salahDuties?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1 text-xs font-bold text-zinc-300">🕌 আজকের সালাহ রিমাইন্ডার</div>
            {data.salahDuties.map((s) => {
              const ic = salahIcon(s.status)
              const right = salahRightText(s)
              return (
                <div key={s.waqt} className="flex items-center gap-2 px-1 py-1 text-[12px]">
                  <span className="shrink-0">{ic}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-200">
                    {s.label}
                    {s.reminders ? ` · ${s.reminders} রিমাইন্ডার` : ''}
                  </span>
                  <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{right}</span>
                </div>
              )
            })}
          </div>
        )}

        {(data.continuousServices?.length ?? 0) > 0 && (
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-zinc-500">
            🔄 চলমান সেবা:{' '}
            {data.continuousServices
              .map((s) => `${s.label} ${s.healthy ? '🟢' : '🔴'}`)
              .join(' · ')}
            {data.schedulerHealth?.ackEscalationLastRun && (
              <> · ack check {fmtTime(data.schedulerHealth.ackEscalationLastRun)}</>
            )}
          </div>
        )}
      </div>

      {(data.dutyHistory?.length ?? 0) > 1 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="text-sm font-bold text-zinc-300 hover:text-cream"
          >
            📅 গত {data.feedDays ?? 7} দিনের duty ইতিহাস {showHistory ? '▲' : '▼'}
          </button>
          {showHistory && data.dutyHistory.filter((d) => d.date !== data.today).map((day) => {
            const issues = day.duties.filter((d) => d.status === 'missed' || d.status === 'failed' || d.status === 'skipped')
            if (!issues.length && day.duties.length === 0) return null
            return (
              <div key={day.date} className="rounded-xl border border-white/10 bg-white/[0.02] p-2">
                <div className="mb-1 text-xs font-bold text-zinc-400">{day.date}</div>
                {(issues.length ? issues : day.duties).slice(0, 8).map((d) => (
                  <div key={d.id} className="flex gap-2 py-0.5 text-[11px] text-zinc-400">
                    <span>{dutyIcon(d.status)}</span>
                    <span className="flex-1 truncate">{d.label}</span>
                    <span>{d.detail ?? d.status}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {Object.keys(data.typeCounts ?? {}).length > 0 && (
        <p className="text-[10px] text-muted-hi">
          আজকের মেসেজ:{' '}
          {Object.entries(data.typeCounts)
            .map(([t, n]) => `${typeLabel(t)} ${n}`)
            .join(' · ')}
        </p>
      )}

      {data.failures.length > 0 && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          🔴 {data.failures.length}টি মেসেজ পৌঁছায়নি
          <ul className="mt-2 space-y-1 text-xs">
            {data.failures.slice(0, 8).map((f) => (
              <li key={f.id}>
                • {f.staffName ?? 'স্টাফ'} — {f.type}: {f.errorReason ?? 'unknown'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.mismatches.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
          ⚠️ টাস্ক DB-তে sent কিন্তু Telegram পাঠানো ব্যর্থ:{' '}
          {data.mismatches.map((m) => m.staffName).join(', ')}
        </div>
      )}

      {data.staffSummaries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-zinc-300">আজকের স্টাফ</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.staffSummaries.map((s) => (
              <div
                key={s.staffId}
                className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-cream">
                    {statusDot(s)} {s.staffName}
                  </span>
                  <span className="text-muted">{s.completionPct}%</span>
                </div>
                <div className="mt-2 space-y-0.5 text-muted-hi">
                  <div>পাঠানো {s.dispatched} / পৌঁছেছে {s.delivered} / ব্যর্থ {s.failed}</div>
                  <div>কাজ {s.tasksDone}/{s.tasksTotal} · শুরু: {s.started ? 'হ্যাঁ' : 'না'}</div>
                  {s.lastActivityAt && (
                    <div>শেষ অ্যাক্টিভিটি: {fmtTime(s.lastActivityAt)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-300">লাইভ মেসেজ ফিড (আজ)</h2>
        {data.feed.length === 0 ? (
          <p className="text-xs text-muted">এখনো কোনো মেসেজ লগ নেই।</p>
        ) : (
          data.feed.map((m) => {
            const dot = m.status === 'delivered' ? '🟢' : m.status === 'failed' ? '🔴' : '🟡'
            return (
              <div
                key={m.id}
                className={cn(
                  'rounded-lg border p-2 text-xs',
                  m.status === 'failed'
                    ? 'border-red-500/30 bg-red-500/5'
                    : 'border-white/10 bg-white/[0.02]',
                )}
              >
                <div className="flex justify-between text-zinc-400">
                  <span>{dot} {m.staffName ?? '—'} · {typeLabel(m.type)}</span>
                  <span>{fmtTime(m.createdAt)}</span>
                </div>
                <div className="mt-1 text-zinc-200">
                  <FeedMessage content={m.content ?? ''} />
                </div>
                {m.errorReason && (
                  <div className="mt-1 text-red-300">⚠️ {m.errorReason}</div>
                )}
                {m.requiresAck && (
                  m.acknowledgedAt
                    ? (
                      <div className="mt-1 text-green-400">
                        ✅ দেখেছে · {fmtTime(m.acknowledgedAt)}
                      </div>
                    )
                    : (
                      <div className="mt-1 text-yellow-400">⏳ এখনো দেখেনি</div>
                    )
                )}
              </div>
            )
          })
        )}
      </div>

      {(data.historyFeed?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-zinc-300">গত দিনের মেসেজ ইতিহাস ({data.feedDays ?? 7} দিন)</h2>
          {data.historyFeed.slice(0, 80).map((m) => (
            <div key={m.id} className="rounded-lg border border-white/5 bg-black/20 p-2 text-xs text-zinc-500">
              <div className="flex justify-between">
                <span>{m.staffName ?? '—'} · {typeLabel(m.type)} · {m.status}</span>
                <span>{new Date(m.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })} {fmtTime(m.createdAt)}</span>
              </div>
              {m.errorReason && <div className="mt-1 text-red-400">{m.errorReason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
