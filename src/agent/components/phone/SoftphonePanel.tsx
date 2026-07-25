'use client'

/**
 * The staff-facing phone. Answers real customer calls in the browser and dials out, so a
 * staff member needs nothing but the ERP tab they already have open.
 *
 * Screen-pop lives here too: the moment a call arrives we look the caller up and show their
 * orders and dues, because "who is this and what do they want" is the whole reason a support
 * call is stressful.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSoftphone } from './useSoftphone'

interface CallerContext {
  found: boolean
  name?: string
  totalOrders?: number
  dueAmount?: number
  lastOrder?: { number?: string; status?: string; date?: string }
  recentCalls?: number
}

function mmss(total: number): string {
  const m = Math.floor(total / 60), s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function SoftphonePanel() {
  const { state, connect, disconnect, answer, hangup, dial, audioElement } = useSoftphone()
  const [number, setNumber] = useState('')
  const [caller, setCaller] = useState<CallerContext | null>(null)

  // Screen-pop: as soon as we know who is calling, fetch their history.
  useEffect(() => {
    if (!state.peer || !state.incoming) { setCaller(null); return }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/assistant/phone/caller?number=${encodeURIComponent(state.peer!)}`)
        const data = (await res.json()) as CallerContext
        if (!cancelled) setCaller(data)
      } catch { /* the call matters more than the sidebar */ }
    })()
    return () => { cancelled = true }
  }, [state.peer, state.incoming])

  const onDial = useCallback(() => { if (number.trim()) void dial(number.trim()) }, [dial, number])

  const statusLabel = {
    idle: 'বন্ধ', connecting: 'সংযোগ হচ্ছে…', registered: 'তৈরি',
    ringing: state.incoming ? 'কল আসছে' : 'রিং হচ্ছে', 'in-call': 'কথা চলছে', error: 'সমস্যা',
  }[state.status]

  const live = state.status === 'ringing' || state.status === 'in-call'

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur">
      {/* Remote audio sink — hidden, but it is what makes the call audible. */}
      <audio ref={audioElement.ref} autoPlay playsInline className="hidden" />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              state.status === 'in-call' ? 'bg-emerald-400'
                : state.status === 'ringing' ? 'animate-pulse bg-amber-400'
                  : state.status === 'registered' ? 'bg-emerald-500/60'
                    : state.status === 'error' ? 'bg-red-500' : 'bg-white/25'
            }`}
          />
          <span className="text-sm text-white/80">
            {statusLabel}
            {state.extension ? <span className="ml-2 text-white/40">এক্সটেনশন {state.extension}</span> : null}
          </span>
        </div>
        {state.status === 'idle' || state.status === 'error' ? (
          <button
            onClick={() => void connect()}
            className="rounded-lg bg-[#E07A5F] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
          >
            ফোন চালু করো
          </button>
        ) : (
          <button
            onClick={() => void disconnect()}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
          >
            বন্ধ করো
          </button>
        )}
      </div>

      {state.error ? (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{state.error}</p>
      ) : null}

      {live ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-white/40">
                {state.incoming ? 'ইনকামিং কল' : 'কল যাচ্ছে'}
              </p>
              <p className="mt-0.5 text-lg font-semibold text-white">
                {caller?.name || state.peer}
              </p>
              {caller?.name ? <p className="text-sm text-white/50">{state.peer}</p> : null}
            </div>
            {state.status === 'in-call' ? (
              <span className="font-mono text-sm text-emerald-300">{mmss(state.seconds)}</span>
            ) : null}
          </div>

          {/* Screen-pop: what this customer already means to the business. */}
          {caller?.found ? (
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-white/5 px-2 py-2">
                <p className="text-xs text-white/40">অর্ডার</p>
                <p className="text-sm font-semibold text-white">{caller.totalOrders ?? 0}</p>
              </div>
              <div className="rounded-lg bg-white/5 px-2 py-2">
                <p className="text-xs text-white/40">বাকি</p>
                <p className="text-sm font-semibold text-white">৳{caller.dueAmount ?? 0}</p>
              </div>
              <div className="rounded-lg bg-white/5 px-2 py-2">
                <p className="text-xs text-white/40">আগের কল</p>
                <p className="text-sm font-semibold text-white">{caller.recentCalls ?? 0}</p>
              </div>
            </div>
          ) : caller && !caller.found ? (
            <p className="mt-3 text-sm text-white/45">নতুন নম্বর — আগের কোনো রেকর্ড নেই।</p>
          ) : null}

          {caller?.lastOrder?.number ? (
            <p className="mt-2 text-sm text-white/60">
              শেষ অর্ডার {caller.lastOrder.number} — {caller.lastOrder.status}
              {caller.lastOrder.date ? ` (${caller.lastOrder.date})` : ''}
            </p>
          ) : null}

          <div className="mt-4 flex gap-2">
            {state.incoming && state.status === 'ringing' ? (
              <button
                onClick={() => void answer()}
                className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                ধরো
              </button>
            ) : null}
            <button
              onClick={() => void hangup()}
              className="flex-1 rounded-lg bg-red-500/90 px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              {state.status === 'in-call' ? 'কল শেষ' : 'কেটে দাও'}
            </button>
          </div>
        </div>
      ) : state.status === 'registered' ? (
        <div className="mt-4 flex gap-2">
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onDial() }}
            inputMode="tel"
            placeholder="01XXXXXXXXX বা সহকর্মীর ৪ ডিজিট"
            className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[#E07A5F]/60 focus:outline-none"
          />
          <button
            onClick={onDial}
            className="rounded-lg bg-[#E07A5F] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            কল
          </button>
        </div>
      ) : null}
    </div>
  )
}
