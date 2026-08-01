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
  /** L4: present on session-event steps — the session a reply would go to. */
  sessionId?: string | null
  /** claude | codex — codex is one-shot, so no reply composer for it. */
  sessionTool?: string | null
  /** Raw event kind — 'ended'/'error' means the session cannot take a reply. */
  sessionKind?: string | null
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
  /**
   * The frame we already hold, keyed by `screenshotAt`. The poll tells the
   * server, and an unchanged frame comes back as metadata only — without this
   * every 3s poll re-downloaded the same multi-MB base64 payload (Codex P1).
   */
  const screenshotRef = useRef<{ uri: string; at: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const held = screenshotRef.current
      const qs = held ? `?screenshotAfter=${encodeURIComponent(held.at)}` : ''
      const res = await fetch(`/api/assistant/live-activity${qs}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as ActivityFeed
      if (data.active) lastActiveRef.current = Date.now()
      if (data.screenshot && data.screenshotAt) {
        screenshotRef.current = { uri: data.screenshot, at: data.screenshotAt }
      } else if (!data.screenshotAt) {
        screenshotRef.current = null
      } else if (held && data.screenshotAt === held.at) {
        // Unchanged — server omitted the payload; render the copy we hold.
        data.screenshot = held.uri
      }
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

  // L4 tap-to-reply: the composer belongs to the NEWEST session, and only when
  // that session can actually take a reply. Searching for "any Claude event"
  // paired the composer with session B's activity while sending to older
  // session A (Codex round 5); a Codex or ended/errored newest session simply
  // gets no composer.
  const newestSessionStep = feed?.steps.find((s) => s.surface === 'session' && s.sessionId) ?? null
  const replySessionId =
    newestSessionStep &&
    newestSessionStep.sessionTool !== 'codex' &&
    newestSessionStep.sessionKind !== 'ended' &&
    newestSessionStep.sessionKind !== 'error'
      ? newestSessionStep.sessionId ?? null
      : null
  const [replyText, setReplyText] = useState('')
  const [replyState, setReplyState] = useState<'idle' | 'sending' | 'sent' | 'queued' | 'failed'>('idle')
  /**
   * Where this composition is going, locked at the FIRST keystroke. Recomputing
   * the target on every poll meant that if session B spoke while the owner was
   * typing an answer for session A, the text silently went to B (Codex round 4).
   */
  const pinnedSessionRef = useRef<string | null>(null)

  const onReplyTextChange = useCallback(
    (next: string) => {
      if (next.trim() && !pinnedSessionRef.current) pinnedSessionRef.current = replySessionId
      if (!next.trim()) pinnedSessionRef.current = null
      setReplyText(next)
    },
    [replySessionId],
  )

  const sendReply = useCallback(async () => {
    const text = replyText.trim()
    const target = pinnedSessionRef.current ?? replySessionId
    if (!text || !target || replyState === 'sending') return
    setReplyState('sending')
    try {
      const res = await fetch('/api/assistant/mac-agent/session-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: target, text }),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { delivered?: boolean } | null
        setReplyText('')
        pinnedSessionRef.current = null
        // delivered:false = accepted into the queue but the Mac has not
        // confirmed yet — saying "reached" would invite a duplicate send.
        setReplyState(data?.delivered === false ? 'queued' : 'sent')
        // Only step DOWN from a terminal state. An unconditional reset could
        // fire while a SECOND reply is mid-flight and re-enable the button
        // with that text still present — one tap away from a duplicate
        // instruction (Codex round 5).
        setTimeout(
          () => setReplyState((prev) => (prev === 'sent' || prev === 'queued' ? 'idle' : prev)),
          4_000,
        )
      } else {
        setReplyState('failed')
      }
    } catch {
      setReplyState('failed')
    }
  }, [replyText, replySessionId, replyState])

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

            {replySessionId && (
              <div className="mt-4 flex items-center gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => onReplyTextChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendReply()
                  }}
                  placeholder="সেশনকে উত্তর দিন…"
                  className="min-w-0 flex-1 rounded-xl border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-black/30"
                />
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={replyState === 'sending' || !replyText.trim()}
                  className="shrink-0 rounded-xl bg-black px-3.5 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {replyState === 'sending' ? 'পাঠাচ্ছি…' : 'পাঠান'}
                </button>
              </div>
            )}
            {replyState === 'sent' && (
              <p className="mt-1.5 text-xs text-emerald-600">সেশনে পৌঁছে গেছে ✓</p>
            )}
            {replyState === 'queued' && (
              <p className="mt-1.5 text-xs text-amber-600">কিউতে আছে — Mac নিশ্চিত করলেই পৌঁছাবে</p>
            )}
            {replyState === 'failed' && (
              <p className="mt-1.5 text-xs text-red-600">পাঠানো যায়নি — সেশনটা কি শেষ হয়ে গেছে?</p>
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
