'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { StaffMonitorData, StaffSummary } from '@/agent/lib/staff-monitor-data'
import type { AgentDutyRow } from '@/agent/lib/agent-duties'

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

export default function AgentStaffMonitor() {
  const [data, setData] = useState<StaffMonitorData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

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
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-8">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-black text-cream">স্টাফ মনিটর (লাইভ)</h1>
          <p className="text-[11px] text-muted">
            আজ ({data.today}) · প্রতি ১০ সেকেন্ডে আপডেট
            {data.generatedAt && (
              <> · সর্বশেষ {fmtTime(data.generatedAt)}</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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

      <div className="space-y-1">
        <h2 className="text-sm font-bold text-zinc-300">🤖 এজেন্টের আজকের কাজ (লাইভ)</h2>
        {(data.agentDuties ?? []).map((d) => {
          const icon = dutyIcon(d.status)
          const time = d.ranAt
            ? fmtTime(d.ranAt)
            : ''
          return (
            <div
              key={d.id}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2 text-xs',
                d.status === 'failed'
                  ? 'border-red-500/30 bg-red-500/5'
                  : d.status === 'missed'
                    ? 'border-orange-500/40 bg-orange-500/10'
                    : 'border-white/10 bg-white/[0.02]',
              )}
            >
              <span className="text-zinc-200">{icon} {d.label}</span>
              <span className="max-w-[45%] truncate text-right text-zinc-500">
                {d.status === 'missed'
                  ? (d.detail ?? 'মিস হয়েছে')
                  : d.status === 'skipped' && d.detail
                    ? d.detail
                    : time}
              </span>
            </div>
          )
        })}
      </div>

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
        <h2 className="text-sm font-bold text-zinc-300">লাইভ মেসেজ ফিড (সব ধরন)</h2>
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
    </div>
  )
}
