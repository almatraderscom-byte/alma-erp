'use client'

/**
 * Watching the agent work, from his phone.
 *
 * The owner asked for what Codex and the ChatGPT app do: while the agent is
 * working on his Mac or in Chrome, a small live view sits inside the chat — and
 * when he wants a proper look he expands it, like a YouTube mini-player, without
 * losing his place in the conversation.
 *
 * Shape:
 *   idle       → renders nothing at all. A player parked on an idle chat is
 *                clutter, and he has said so about other panels.
 *   collapsed  → one line above the composer: what it is doing right now, plus a
 *                thumbnail when there is a screenshot to show.
 *   expanded   → a sheet with the screenshot large and the step list under it;
 *                collapsing puts it straight back to the line.
 *
 * Polling, not a socket: the surfaces it reports on already write their state to
 * Postgres, and a 3s poll while work is live costs less than keeping a stream
 * open on a phone that may be on mobile data.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type Surface = 'mac' | 'session' | 'browser'

interface ActivityStep {
  id: string
  surface: Surface
  labelBn: string
  detail: string | null
  status: string
  policy: string | null
  at: string
}

interface ActivityFeed {
  active: boolean
  current: ActivityStep | null
  steps: ActivityStep[]
  screenshot: string | null
  screenshotAt: string | null
}

const SURFACE_BN: Record<Surface, string> = {
  mac: 'আপনার Mac',
  session: 'Claude সেশন',
  browser: 'ব্রাউজার',
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  queued: 'bg-amber-500',
  done: 'bg-black/25',
  failed: 'bg-red-500',
}

/** Keep polling a little after work stops, so the last frame does not vanish mid-glance. */
const LINGER_MS = 20_000
const POLL_ACTIVE_MS = 3_000
const POLL_IDLE_MS = 15_000

export default function AgentLiveDock() {
  const [feed, setFeed] = useState<ActivityFeed | null>(null)
  const [expanded, setExpanded] = useState(false)
  /** He closed it by hand — respect that until genuinely NEW work starts. */
  const [dismissedStepId, setDismissedStepId] = useState<string | null>(null)
  const lastActiveRef = useRef<number>(0)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/live-activity', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as ActivityFeed
      if (data.active) lastActiveRef.current = Date.now()
      setFeed(data)
      // Only a DIFFERENT step brings the dock back. Clearing the dismiss on
      // every active poll meant closing it during a running job re-opened it
      // three seconds later (Codex review).
      setDismissedStepId((prev) => (prev && data.current && data.current.id !== prev ? null : prev))
    } catch {
      /* a dropped poll is not worth telling him about */
    }
  }, [])

  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const wasActive = Date.now() - lastActiveRef.current < LINGER_MS
      timer = setTimeout(async () => {
        await load()
        tick()
      }, wasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }
    tick()
    return () => clearTimeout(timer)
  }, [load])

  const recentlyActive = Date.now() - lastActiveRef.current < LINGER_MS
  const dismissed = dismissedStepId !== null && dismissedStepId === (feed?.current?.id ?? null)
  const show = Boolean(feed && (feed.active || recentlyActive) && !dismissed)

  // Collapse the sheet when the work finishes, so it never traps his screen.
  useEffect(() => {
    if (!show) setExpanded(false)
  }, [show])

  if (!show || !feed) return null

  const current = feed.current
  const dot = STATUS_DOT[current?.status ?? 'done'] ?? 'bg-black/25'

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-black/60 backdrop-blur-sm">
        <div
          className="mt-auto flex max-h-[85vh] flex-col rounded-t-3xl bg-white shadow-2xl"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="flex items-center justify-between gap-3 border-b border-black/10 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${feed.active ? 'animate-pulse' : ''}`} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{current?.labelBn ?? 'কাজ চলছে'}</p>
                <p className="text-xs text-black/50">
                  {current ? SURFACE_BN[current.surface] : ''}
                  {feed.active ? ' · এখন চলছে' : ' · শেষ'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="ছোট করুন"
              className="shrink-0 rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium text-black/70"
            >
              ছোট করুন
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {feed.screenshot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={feed.screenshot}
                alt="এজেন্ট যা দেখছে"
                className="w-full rounded-xl border border-black/10"
              />
            ) : (
              <div className="rounded-xl border border-dashed border-black/15 p-6 text-center text-sm text-black/45">
                এখনো কোনো ছবি নেই — কাজের ধাপগুলো নিচে দেখুন।
              </div>
            )}

            <div className="mt-4 space-y-1.5">
              {feed.steps.map((s) => (
                <div key={s.id} className="flex items-start gap-2 rounded-lg bg-black/[0.03] px-3 py-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[s.status] ?? 'bg-black/25'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{s.labelBn}</p>
                    {s.detail && <code className="block truncate text-[11px] text-black/50">{s.detail}</code>}
                  </div>
                  {s.policy === 'amber' && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700">
                      আপনি অনুমতি দিয়েছেন
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none sticky bottom-0 z-30 flex justify-center px-3 pb-1">
      <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-black/10 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${feed.active ? 'animate-pulse' : ''}`} />

        {feed.screenshot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={feed.screenshot}
            alt=""
            className="h-9 w-14 shrink-0 rounded-md border border-black/10 object-cover"
          />
        )}

        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-sm font-medium">{current?.labelBn ?? 'কাজ চলছে'}</p>
          <p className="truncate text-[11px] text-black/50">
            {current ? SURFACE_BN[current.surface] : ''} · দেখতে ট্যাপ করুন
          </p>
        </button>

        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="বড় করে দেখুন"
          className="shrink-0 rounded-full bg-black/5 p-2 text-black/60"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => setDismissedStepId(current?.id ?? 'none')}
          aria-label="বন্ধ করুন"
          className="shrink-0 rounded-full p-1.5 text-black/35"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
