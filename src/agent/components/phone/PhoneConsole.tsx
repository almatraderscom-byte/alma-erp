'use client'

/**
 * PBX console, step 1 — see the line. Read-only by design: there is not one button here that
 * changes anything, because this is a live business line and every write path needs its own
 * dry-run, backup and rollback (step 2).
 *
 * Four things the owner could not do from the ERP before this page: see whether the line is
 * registered, see who is on a call right now, read the call log and hear the recording, and
 * see why a call failed and how the audio held up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { CallRow, LineView, TodayTally } from '@/agent/lib/phone-console'

const CORAL = '#E07A5F'
const LIVE_POLL_MS = 5_000

type OverviewResponse = { ok: boolean; line: LineView; today: TodayTally | null; fetchedAt: string }

const STATE_BN: Record<string, string> = {
  ringing: 'রিং হচ্ছে',
  talking: 'কথা হচ্ছে',
  hold: 'হোল্ডে',
  transferring: 'ট্রান্সফার হচ্ছে',
  voicemail: 'ভয়েসমেইল',
  message: 'বার্তা শোনানো হচ্ছে',
}

function secs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const s = Math.max(0, Math.round(n))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}মি ${s % 60}সে` : `${s}সে`
}

function clockBn(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('bn-BD', {
    timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
}

export default function PhoneConsole() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Poll the line, and tick a clock separately so a live call's elapsed time counts up
  // smoothly between polls instead of jumping every five seconds.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/assistant/phone-console/overview', { cache: 'no-store' })
        const data = (await res.json()) as OverviewResponse & { error?: string }
        if (!alive) return
        if (!res.ok || !data.ok) { setOverviewError(data.error ?? `HTTP ${res.status}`); return }
        setOverviewError(null)
        setOverview(data)
      } catch (err) {
        if (alive) setOverviewError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const poll = setInterval(() => void load(), LIVE_POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => { alive = false; clearInterval(poll); clearInterval(tick) }
  }, [])

  const line = overview?.line
  const today = overview?.today ?? null

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 pb-28 pt-4">
      <LineCard line={line} error={overviewError} />
      <LiveCard line={line} now={now} />
      <TodayCard today={today} />
      <CallLog />
    </div>
  )
}

// ── the line ─────────────────────────────────────────────────────────────────

function LineCard({ line, error }: { line: LineView | undefined; error: string | null }) {
  const reg = line?.registration
  const ok = reg?.registered === true
  const unknown = !line || reg?.registered == null

  return (
    <section className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-cream">লাইন</h2>
        {/* .tone-* rather than raw Tailwind colour steps: the ERP runs a light AND a dark
            theme off `data-theme`, which Tailwind's `dark:` variant does not follow here, so
            a hand-picked emerald-300 is legible in one theme and invisible in the other. */}
        <span
          className={cn(
            'rounded-full border px-2.5 py-1 text-[11px] font-semibold',
            unknown ? 'tone-slate' : ok ? 'tone-green' : 'tone-red',
          )}
        >
          {unknown ? 'জানা যায়নি' : ok ? 'রেজিস্টার্ড' : 'রেজিস্ট্রেশন নেই'}
        </span>
      </header>

      {!line?.configured && (
        <p className="rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-[12px] text-muted-hi">
          এই এনভায়রনমেন্টে ফোন গেটওয়ে সেট করা নেই (<code className="text-muted">SIP_GATEWAY_BASE</code>)।
        </p>
      )}
      {error && (
        <p className="tone-red mb-3 rounded-xl border px-3 py-2 text-[12px]">
          গেটওয়ে থেকে উত্তর আসেনি: {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="অবস্থা" value={reg?.status ?? '—'} />
        <Stat
          label="বাইন্ডিং বাকি"
          value={reg?.expiresIn != null ? `${reg.expiresIn}সে` : '—'}
          hint={reg?.expiresIn != null && reg.expiresIn > 120 ? 'বেশি লম্বা' : undefined}
        />
        <Stat
          label="চলমান কল"
          value={`${line?.counts.active ?? 0}${line?.counts.maxConcurrent ? ` / ${line.counts.maxConcurrent}` : ''}`}
        />
        <Stat
          label="স্টাফ ফোন"
          value={line?.softphone.healthy == null ? '—' : line.softphone.healthy ? 'ঠিক আছে' : 'সমস্যা'}
          bad={line?.softphone.healthy === false}
        />
      </div>

      {line?.hourly && (
        <p className="mt-2 text-[11px] text-muted">
          এই ঘণ্টায় দেওয়া কল: {line.hourly.placed} / {line.hourly.cap}
        </p>
      )}

      {/* The lesson that cost two sessions and roughly half of all outbound calls for days:
          our own "Registered" is a claim, not evidence. Say so on the screen, every time. */}
      <p className="tone-amber mt-3 rounded-xl border px-3 py-2 text-[11px] leading-relaxed">
        উপরের অবস্থা <strong>আমাদের সার্ভারের দাবি</strong> — প্রমাণ নয়। প্রোভাইডার এক অ্যাকাউন্টে
        একটাই রেজিস্ট্রেশন রাখে, শেষ যে রেজিস্টার করে লাইনটা তার। কে আসলে লাইন ধরে আছে সেটা একমাত্র
        তাদের নিজের টেবিলেই দেখা যায়:{' '}
        <a href="https://amarip.net" target="_blank" rel="noreferrer" className="underline decoration-dotted" style={{ color: CORAL }}>
          amarip.net → SIP Users
        </a>
        । ওটা কনসোলে আনা ধাপ ২-এর কাজ।
      </p>
    </section>
  )
}

function Stat({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-card/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-0.5 truncate text-sm font-semibold', bad ? 'text-danger' : 'text-cream')}>{value}</p>
      {hint && <p className="tone-amber mt-1 inline-block rounded border px-1.5 text-[10px]">{hint}</p>}
    </div>
  )
}

// ── live ─────────────────────────────────────────────────────────────────────

function LiveCard({ line, now }: { line: LineView | undefined; now: number }) {
  const active = line?.active ?? []
  const count = line?.counts.active ?? 0

  return (
    <section className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-bold text-cream">এখন লাইভ</h2>
        {count > 0 && (
          <motion.span
            animate={{ opacity: [1, 0.35, 1] }}
            transition={{ duration: 1.6, repeat: Infinity }}
            className="h-2 w-2 rounded-full"
            style={{ background: CORAL }}
          />
        )}
      </header>

      {count === 0 && <p className="text-[12px] text-muted">এখন কোনো কল চলছে না।</p>}

      {count > 0 && !line?.liveDetail && (
        <p className="text-[12px] text-muted-hi">
          {count}টি কল চলছে। বিস্তারিত দেখাতে VPS-এর গেটওয়েতে নতুন কোডটা এখনো ওঠেনি।
        </p>
      )}

      <div className="space-y-2">
        {active.map((c) => {
          const started = c.answeredAt ?? c.startedAt
          const elapsed = started ? Math.round((now - started) / 1000) : null
          return (
            <div key={c.id} className="rounded-xl border border-border-subtle bg-card/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-cream">
                    <span className="mr-1.5 text-muted">{c.direction === 'inbound' ? '↙' : '↗'}</span>
                    {c.name || c.from || c.to || c.id.slice(0, 12)}
                  </p>
                  <p className="truncate text-[11px] text-muted">
                    {c.direction === 'inbound' ? c.from : c.to}
                    {c.did ? ` • DID ${c.did}` : ''}
                    {c.transferredTo ? ` • → ${c.transferredTo}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="rounded-full border border-border-subtle bg-card/80 px-2 py-0.5 text-[11px] text-cream">
                    {STATE_BN[c.state] ?? c.state}
                  </span>
                  <p className="mt-0.5 text-[11px] tabular-nums text-muted">{secs(elapsed)}</p>
                </div>
              </div>
              {c.audio && (c.audio.underruns > 0 || c.audio.dropped > 0) && (
                <p className="tone-amber mt-1.5 inline-block rounded border px-1.5 py-0.5 text-[10px]">
                  অডিও: {c.audio.underruns} বার কেটেছে • {c.audio.dropped} ফ্রেম বাদ
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── today ────────────────────────────────────────────────────────────────────

function TodayCard({ today }: { today: TodayTally | null }) {
  return (
    <section className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-cream">আজ</h2>
        {today && <span className="text-[11px] text-muted">{today.date}</span>}
      </header>
      {!today && <p className="text-[12px] text-muted">হিসাব আনা যায়নি।</p>}
      {today && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="মোট" value={String(today.total)} />
          <Stat label="ইনকামিং" value={String(today.inbound)} />
          <Stat label="আউটগোয়িং" value={String(today.outbound)} />
          <Stat label="ধরা হয়েছে" value={String(today.answered)} />
          <Stat label="পৌঁছায়নি" value={String(today.unreached)} bad={today.unreached > 0} />
          <Stat label="গড় দৈর্ঘ্য" value={secs(today.avgTalkSecs)} />
        </div>
      )}
      {today && today.withUnderruns > 0 && (
        <p className="tone-amber mt-2 inline-block rounded-lg border px-2 py-1 text-[11px]">
          {today.withUnderruns}টি কলে অডিও অন্তত একবার কেটেছে।
        </p>
      )}
    </section>
  )
}

// ── call log ─────────────────────────────────────────────────────────────────

const DAY_CHIPS = [
  { days: 1, label: 'আজ' },
  { days: 7, label: '৭ দিন' },
  { days: 30, label: '৩০ দিন' },
]
const DIR_CHIPS = [
  { value: 'all', label: 'সব' },
  { value: 'inbound', label: 'ইনকামিং' },
  { value: 'outbound', label: 'আউটগোয়িং' },
] as const
const STATUS_CHIPS = [
  { value: 'all', label: 'সব' },
  { value: 'answered', label: 'ধরা হয়েছে' },
  { value: 'unreached', label: 'পৌঁছায়নি' },
  { value: 'recorded', label: 'রেকর্ডিং আছে' },
] as const

function CallLog() {
  const [days, setDays] = useState(7)
  const [direction, setDirection] = useState<(typeof DIR_CHIPS)[number]['value']>('all')
  const [status, setStatus] = useState<(typeof STATUS_CHIPS)[number]['value']>('all')
  const [number, setNumber] = useState('')
  const [calls, setCalls] = useState<CallRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = new URLSearchParams({ days: String(days), direction, status, limit: '50' })
      if (number.replace(/\D/g, '').length >= 6) q.set('number', number)
      const res = await fetch(`/api/assistant/phone-console/calls?${q}`, { cache: 'no-store' })
      const data = (await res.json()) as { ok: boolean; calls?: CallRow[]; error?: string }
      if (!res.ok || !data.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setError(null)
      setCalls(data.calls ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days, direction, status, number])

  // Typing a number should not fire a query per keystroke.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void load(), 300)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [load])

  return (
    <section className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-cream">কল লগ</h2>
        {loading && <span className="text-[11px] text-muted">আনা হচ্ছে…</span>}
      </header>

      <div className="mb-3 space-y-2">
        <ChipRow
          items={DAY_CHIPS.map((d) => ({ value: String(d.days), label: d.label }))}
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
        />
        <ChipRow items={DIR_CHIPS} value={direction} onChange={(v) => setDirection(v as typeof direction)} />
        <ChipRow items={STATUS_CHIPS} value={status} onChange={(v) => setStatus(v as typeof status)} />
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          inputMode="tel"
          placeholder="নম্বর দিয়ে খুঁজুন"
          className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
        />
      </div>

      {error && (
        <p className="tone-red rounded-xl border px-3 py-2 text-[12px]">
          কল লগ আনা যায়নি: {error}
        </p>
      )}
      {!error && calls?.length === 0 && (
        <p className="py-6 text-center text-[12px] text-muted">এই ছাঁকনিতে কোনো কল নেই।</p>
      )}

      <div className="space-y-2">
        {calls?.map((c) => (
          <CallCard key={c.id} call={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} />
        ))}
      </div>
    </section>
  )
}

function ChipRow({
  items, value, onChange,
}: {
  items: ReadonlyArray<{ value: string; label: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          onClick={() => onChange(i.value)}
          className={cn(
            'rounded-full border px-3 py-1 text-[11px] transition-colors',
            value === i.value
              ? 'border-[#E07A5F]/50 bg-[#E07A5F]/[0.12] text-cream'
              : 'border-border-subtle bg-card/60 text-muted hover:text-cream',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}

function CallCard({ call, open, onToggle }: { call: CallRow; open: boolean; onToggle: () => void }) {
  const bad = !call.reached
  const audioNote = useMemo(() => {
    if (!call.audio) return null
    const { underruns, dropped, cushionFrames, bargeIns } = call.audio
    return `কেটেছে ${underruns} বার • বাদ ${dropped} ফ্রেম • কুশন ${cushionFrames}f • বাধা ${bargeIns}`
  }, [call.audio])

  return (
    <article className="rounded-xl border border-border-subtle bg-card/60">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        <span className="text-muted">{call.direction === 'inbound' ? '↙' : call.direction === 'outbound' ? '↗' : '•'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-cream">{call.name || call.number}</span>
          <span className="block truncate text-[11px] text-muted">
            {call.number} • {clockBn(call.startedAt)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={cn('inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium', bad ? 'tone-red' : 'tone-green')}>
            {call.statusLabel}
          </span>
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted">{secs(call.durationSecs)}</span>
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-border-subtle px-3 py-3">
          {call.recordingUrl ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio controls preload="none" src={call.recordingUrl} className="w-full" />
          ) : (
            <p className="text-[11px] text-muted">এই কলের রেকর্ডিং নেই।</p>
          )}

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <Row k="কেন কাটল" v={call.hangupCauseLabel ?? call.hangupCauseTxt ?? '—'} />
            <Row k="কোড" v={call.hangupCause != null ? String(call.hangupCause) : '—'} />
            <Row k="ধরেছে" v={call.answeredAt ? clockBn(call.answeredAt) : '—'} />
            <Row k="শেষ" v={call.endedAt ? clockBn(call.endedAt) : '—'} />
            {call.transferredTo && <Row k="ট্রান্সফার" v={`${call.transferredTo} • ${secs(call.transferTalkSecs)}`} />}
            {call.did && <Row k="DID" v={call.did} />}
          </dl>

          {audioNote ? (
            <p className="rounded-lg border border-border-subtle bg-card/60 px-2.5 py-1.5 text-[11px] text-muted-hi">
              অডিও: {audioNote}
            </p>
          ) : (
            <p className="text-[10px] text-muted">
              অডিওর হিসাব নেই — এই কলটা গেটওয়ের নতুন কোডের আগের।
            </p>
          )}

          {call.summary && (
            <p className="rounded-lg border border-border-subtle bg-card/60 px-2.5 py-2 text-[12px] leading-relaxed text-cream">
              {call.summary}
            </p>
          )}

          {call.transcript && (
            <details className="rounded-lg border border-border-subtle bg-card/60 px-2.5 py-2">
              <summary className="cursor-pointer text-[11px] text-muted">কথোপকথন ({call.transcript.length})</summary>
              <div className="mt-2 space-y-1.5">
                {call.transcript.map((t, i) => (
                  <p key={i} className="text-[12px] leading-relaxed">
                    <span className="text-muted">{t.role === 'user' ? 'কলার: ' : 'এজেন্ট: '}</span>
                    <span className="text-cream">{t.message}</span>
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="truncate text-cream">{v}</dd>
    </>
  )
}
