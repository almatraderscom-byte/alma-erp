'use client'

/**
 * The staff phone. Answers real customer calls in the browser and dials out, so a staff
 * member needs nothing but the ERP tab they already have open.
 *
 * Two things make it more than a dialler: screen-pop, so whoever answers already knows who
 * is calling and what they are likely calling about, and a keypad that doubles as DTMF
 * during a call — otherwise the automated menus couriers and banks use are a dead end.
 *
 * One responsive layout serves web, iOS and Android: the ERP runs inside a WebView on both
 * mobile platforms and WebRTC works there, so a native rewrite would buy nothing.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSoftphone } from './useSoftphone'
import Dialpad from './Dialpad'

interface CallerContext {
  found: boolean
  name?: string
  totalOrders?: number
  dueAmount?: number
  segment?: string | null
  lastOrder?: { number?: string; status?: string; date?: string }
  recentCalls?: number
}

function mmss(total: number): string {
  const m = Math.floor(total / 60), s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function SoftphonePanel() {
  const {
    state, connect, disconnect, answer, hangup, dial, toggleMute, toggleSpeaker, sendDtmf, audioElement,
  } = useSoftphone()
  const [number, setNumber] = useState('')
  const [caller, setCaller] = useState<CallerContext | null>(null)
  const [colleagues, setColleagues] = useState<Array<{ ext: string; name: string }>>([])
  const [padOpen, setPadOpen] = useState(false)

  const live = state.status === 'ringing' || state.status === 'in-call'

  // Screen-pop: the moment we know who is calling, pull their history.
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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/assistant/phone/dial')
        const data = (await res.json()) as { staff?: Array<{ ext: string; name: string }> }
        setColleagues((data.staff ?? []).filter((s) => s.ext !== state.extension))
      } catch { /* typing a number still works */ }
    })()
  }, [state.extension])

  // A keypad press means "compose" before a call and "send a tone" during one.
  const onKey = useCallback((digit: string) => {
    if (state.status === 'in-call') sendDtmf(digit)
    else setNumber((n) => (n + digit).slice(0, 15))
  }, [sendDtmf, state.status])

  const onDial = useCallback(() => { if (number.trim()) void dial(number.trim()) }, [dial, number])

  const statusLabel = {
    idle: 'বন্ধ', connecting: 'সংযোগ হচ্ছে…', registered: 'তৈরি',
    ringing: state.incoming ? 'কল আসছে' : 'রিং হচ্ছে', 'in-call': 'কথা চলছে', error: 'সমস্যা',
  }[state.status]

  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-card/80 shadow-float backdrop-blur">
      <audio ref={audioElement.ref} autoPlay playsInline className="hidden" />

      {/* Header: state at a glance, plus the on/off switch */}
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              state.status === 'in-call' ? 'bg-emerald-400'
                : state.status === 'ringing' ? 'animate-pulse bg-amber-400'
                  : state.status === 'registered' ? 'bg-emerald-500/60'
                    : state.status === 'error' ? 'bg-danger' : 'bg-muted/60'
            }`}
          />
          <span className="text-sm text-cream">{statusLabel}</span>
          {state.extension ? (
            <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[11px] text-muted-hi">
              আপনার নম্বর {state.extension}
            </span>
          ) : null}
        </div>
        {state.status === 'idle' || state.status === 'error' ? (
          <button
            onClick={() => void connect()}
            className="rounded-lg bg-gold px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
          >
            ফোন চালু করো
          </button>
        ) : (
          <button
            onClick={() => void disconnect()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-hi transition hover:bg-bg-2"
          >
            বন্ধ
          </button>
        )}
      </div>

      {state.error ? (
        <p className="mx-4 mt-3 rounded-lg px-3 py-2 text-sm tone-red">{state.error}</p>
      ) : null}

      <div className="p-4">
        {live ? (
          <>
            {/* Who is on the line */}
            <div className="text-center">
              <p className="text-xs uppercase tracking-widest text-muted">
                {state.incoming ? 'ইনকামিং কল' : 'কল যাচ্ছে'}
              </p>
              <p className="mt-1 text-2xl font-semibold text-cream">{caller?.name || state.peer}</p>
              {caller?.name ? <p className="text-sm text-muted">{state.peer}</p> : null}
              <p className="txt-pos mt-1 font-mono text-sm">
                {state.status === 'in-call' ? mmss(state.seconds) : 'সংযোগ হচ্ছে…'}
              </p>
            </div>

            {/* Screen-pop: what this customer already means to the business */}
            {caller?.found ? (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-bg-2 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted">অর্ডার</p>
                  <p className="text-base font-semibold text-cream">{caller.totalOrders ?? 0}</p>
                </div>
                <div className="rounded-xl bg-bg-2 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted">বাকি</p>
                  <p className="text-base font-semibold text-cream">৳{caller.dueAmount ?? 0}</p>
                </div>
                <div className="rounded-xl bg-bg-2 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted">আগের কল</p>
                  <p className="text-base font-semibold text-cream">{caller.recentCalls ?? 0}</p>
                </div>
              </div>
            ) : caller && !caller.found ? (
              <p className="mt-4 text-center text-sm text-muted">নতুন নম্বর — আগের রেকর্ড নেই</p>
            ) : null}

            {caller?.lastOrder?.number ? (
              <p className="mt-2 text-center text-sm text-muted-hi">
                শেষ অর্ডার {caller.lastOrder.number} — {caller.lastOrder.status}
                {caller.lastOrder.date ? ` (${caller.lastOrder.date})` : ''}
              </p>
            ) : null}

            {/* In-call controls */}
            {state.status === 'in-call' ? (
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  onClick={toggleMute}
                  className={`flex h-12 w-12 items-center justify-center rounded-full border text-lg transition ${
                    state.muted
                      ? 'tone-amber'
                      : 'border-border-subtle bg-bg-2 text-cream hover:bg-bg-3'
                  }`}
                  title={state.muted ? 'মাইক চালু করুন' : 'মাইক বন্ধ করুন'}
                >
                  {state.muted ? '🔇' : '🎤'}
                </button>
                <button
                  onClick={() => setPadOpen((v) => !v)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full border text-lg transition ${
                    padOpen
                      ? 'tone-gold'
                      : 'border-border-subtle bg-bg-2 text-cream hover:bg-bg-3'
                  }`}
                  title="কিপ্যাড"
                >
                  ⌨
                </button>
                {/* Shown only where the browser can actually switch output device. */}
                {state.canSwitchSpeaker ? (
                  <button
                    onClick={() => void toggleSpeaker()}
                    className={`flex h-12 w-12 items-center justify-center rounded-full border text-lg transition ${
                      state.speakerOn
                        ? 'tone-green'
                        : 'border-border-subtle bg-bg-2 text-cream hover:bg-bg-3'
                    }`}
                    title="স্পিকার"
                  >
                    🔊
                  </button>
                ) : null}
              </div>
            ) : null}

            {padOpen && state.status === 'in-call' ? (
              <div className="mt-4"><Dialpad onPress={onKey} /></div>
            ) : null}

            <div className="mt-5 flex gap-3">
              {state.incoming && state.status === 'ringing' ? (
                <button
                  onClick={() => void answer()}
                  className="flex-1 rounded-xl bg-success py-3 text-base font-semibold text-white transition hover:brightness-110"
                >
                  ধরো
                </button>
              ) : null}
              <button
                onClick={() => void hangup()}
                className="flex-1 rounded-xl bg-danger py-3 text-base font-semibold text-white transition hover:brightness-110"
              >
                {state.status === 'in-call' ? 'কল শেষ' : 'কেটে দাও'}
              </button>
            </div>
          </>
        ) : state.status === 'registered' ? (
          <>
            <div className="flex items-center gap-2">
              <input
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onDial() }}
                inputMode="tel"
                placeholder="01XXXXXXXXX"
                className="flex-1 rounded-xl border border-border bg-bg-1 px-4 py-3 text-center text-lg tracking-wide text-cream placeholder:text-muted/70 focus:border-gold/60 focus:outline-none"
              />
              {number ? (
                <button
                  onClick={() => setNumber((n) => n.slice(0, -1))}
                  className="rounded-xl border border-border-subtle px-3 py-3 text-muted-hi transition hover:bg-bg-2"
                  title="মুছুন"
                >
                  ⌫
                </button>
              ) : null}
            </div>

            <div className="mt-3"><Dialpad onPress={onKey} /></div>

            <button
              onClick={onDial}
              disabled={!number.trim()}
              className="mt-3 w-full rounded-xl bg-gold py-3 text-base font-semibold text-white transition hover:brightness-110 disabled:opacity-30"
            >
              কল করুন
            </button>

            {colleagues.length ? (
              <div className="mt-5">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-muted">সহকর্মী — ফ্রি কল</p>
                <div className="flex flex-wrap gap-2">
                  {colleagues.map((c) => (
                    <button
                      key={c.ext}
                      onClick={() => void dial(c.ext)}
                      className="rounded-full border border-border-subtle bg-bg-2 px-3 py-1.5 text-sm text-cream transition hover:border-gold/50 hover:bg-gold/10"
                    >
                      {c.name || `এক্সটেনশন ${c.ext}`}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="py-6 text-center text-sm text-muted">
            {state.status === 'connecting' ? 'ফোনের সাথে যুক্ত হচ্ছে…' : 'কল ধরতে বা করতে ফোনটি চালু করুন।'}
          </p>
        )}
      </div>
    </div>
  )
}
