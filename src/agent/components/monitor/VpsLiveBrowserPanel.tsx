'use client'

/**
 * The owner's window into the VPS live browser: watch it work, and reach in when
 * it gets stuck on a login or a captcha.
 *
 * Frames arrive as SSE events carrying base64 JPEG and are painted into an <img>.
 * Clicks, scrolls and keystrokes are scaled back into the session's own viewport
 * and POSTed one at a time. The session lives on the VPS, so a dropped stream is
 * not a lost session — the component simply reconnects and keeps painting.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Must match VIEWPORT in worker/src/browser/live-session.mjs. */
const VIEW_W = 1280
const VIEW_H = 800

type Status = {
  running: boolean
  sessionId?: string
  goal?: string
  paused?: boolean
  pauseReason?: string | null
  viewers?: number
  startedAt?: string
  url?: string
}

type InputEvent =
  | { type: 'click'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'navigate'; url: string }

export default function VpsLiveBrowserPanel() {
  const [status, setStatus] = useState<Status>({ running: false })
  const [frame, setFrame] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [startUrl, setStartUrl] = useState('')
  const [interactive, setInteractive] = useState(true)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/browser-live', { cache: 'no-store' })
      const body = await res.json()
      if (res.ok) setStatus(body)
      else setError(body?.message ?? body?.error ?? 'অবস্থা জানা গেল না')
    } catch {
      setError('সার্ভারের সাথে যোগাযোগ করা গেল না')
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => void refreshStatus(), 5000)
    return () => clearInterval(timer)
  }, [refreshStatus])

  // Frame stream. A relayed SSE connection is time-boxed by the platform, so a
  // clean close is expected — reconnect rather than treating it as a failure.
  useEffect(() => {
    if (!status.running) {
      setFrame(null)
      return
    }
    const source = new EventSource('/api/assistant/browser-live/stream')
    source.addEventListener('frame', (ev) => {
      try {
        const { data } = JSON.parse((ev as MessageEvent).data)
        if (data) setFrame(`data:image/jpeg;base64,${data}`)
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    })
    source.addEventListener('paused', () => void refreshStatus())
    source.addEventListener('resumed', () => void refreshStatus())
    source.addEventListener('ended', () => {
      setFrame(null)
      void refreshStatus()
    })
    return () => source.close()
  }, [status.running, status.sessionId, refreshStatus])

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/assistant/browser-live', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? 'কাজটি করা গেল না')
      return body
    },
    [],
  )

  /**
   * Input events are sent ONE AT A TIME, in order.
   *
   * Each keystroke is its own HTTP request, and fired in parallel they arrive in
   * whatever order the network settles on — typing "backlink" landed on the page
   * as "kbclanki". Ordering is the whole point of a keyboard, so every event
   * queues behind the previous one rather than racing it.
   */
  const inputQueue = useRef<Promise<void>>(Promise.resolve())

  const sendInput = useCallback(
    (event: InputEvent) => {
      if (!interactive) return inputQueue.current
      inputQueue.current = inputQueue.current
        .catch(() => {}) // one failed keystroke must not stop the ones after it
        .then(async () => {
          try {
            await post({ action: 'input', event })
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        })
      return inputQueue.current
    },
    [interactive, post],
  )

  /** Screen pixels → the session's own viewport, so what he clicks is what the page gets. */
  const toViewport = (clientX: number, clientY: number) => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * VIEW_W),
      y: Math.round(((clientY - rect.top) / rect.height) * VIEW_H),
    }
  }

  const onStart = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = startUrl.trim()
      await post({ action: 'start', startUrl: url || undefined, goal: 'owner live session' })
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onStop = async () => {
    setBusy(true)
    try {
      await post({ action: 'stop' })
      setFrame(null)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (!status.running || !interactive) return
    // A single printable character types; everything else is a named key.
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault()
      void sendInput({ type: 'text', text: ev.key })
      return
    }
    const named = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    if (named.includes(ev.key)) {
      ev.preventDefault()
      void sendInput({ type: 'key', key: ev.key })
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      {/* Controls */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="url"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
            placeholder="https://… (ঐচ্ছিক — কোন পেজ দিয়ে শুরু হবে)"
            className="min-w-[240px] flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-[#E07A5F]"
            disabled={status.running || busy}
          />
          {status.running ? (
            <button
              onClick={() => void onStop()}
              disabled={busy}
              className="rounded-xl bg-red-500/80 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              বন্ধ করুন
            </button>
          ) : (
            <button
              onClick={() => void onStart()}
              disabled={busy}
              className="rounded-xl bg-[#E07A5F] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'খুলছে…' : 'ব্রাউজার খুলুন'}
            </button>
          )}
          <label className="flex items-center gap-2 text-xs opacity-80">
            <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
            আমি হাত দিতে পারব
          </label>
        </div>

        <p className="mt-2 text-xs opacity-70">
          {status.running
            ? status.paused
              ? `⏸ থেমে আছে — ${status.pauseReason === 'a call is in progress' ? 'একটা কল চলছে, কল শেষ হলে নিজেই চালু হবে' : 'কিছুক্ষণ কোনো কাজ হয়নি; ক্লিক করলেই আবার চলবে'}`
              : `▶ চলছে — ${status.url ?? ''}`
            : 'কোনো লাইভ সেশন চালু নেই। কল চলাকালে সেশন খুলবে না — কলের আওয়াজ পরিষ্কার রাখতে।'}
        </p>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      {/* Screen */}
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/40 outline-none focus:border-[#E07A5F]"
      >
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frame}
            alt="লাইভ ব্রাউজার"
            className="block w-full select-none"
            draggable={false}
            onClick={(e) => {
              const p = toViewport(e.clientX, e.clientY)
              if (p) void sendInput({ type: 'click', ...p })
            }}
            onWheel={(e) => {
              const p = toViewport(e.clientX, e.clientY)
              if (p) void sendInput({ type: 'scroll', ...p, deltaY: e.deltaY })
            }}
          />
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center text-sm opacity-60">
            {status.running ? 'ছবি আসছে…' : 'ব্রাউজার খুললে এখানে লাইভ দেখতে পাবেন'}
          </div>
        )}
      </div>

      <p className="mt-2 text-xs opacity-60">
        টাইপ করতে আগে উপরের পর্দায় একবার ক্লিক করুন। লগইন/ক্যাপচা আপনি নিজে পার করে দিলে এজেন্ট বাকিটা শেষ করবে।
      </p>
    </div>
  )
}
