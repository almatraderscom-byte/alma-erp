'use client'

/**
 * Watching the agent work, from his phone.
 *
 * The owner asked for what Codex and the ChatGPT app do: while the agent is
 * working on his Mac or in Chrome, a movable live PiP floats over the chat —
 * and when he wants a proper look he expands it without losing his place.
 *
 * Shape:
 *   idle       → renders nothing at all. A player parked on an idle chat is
 *                clutter, and he has said so about other panels.
 *   collapsed  → a draggable, edge-snapping mini-player over the chat; Browser
 *                and Mac remain separate cards when both are available.
 *   expanded   → a sheet with the screenshot large and the step list under it;
 *                collapsing puts it straight back to the line.
 *
 * Polling, not a socket: the surfaces it reports on already write their state to
 * Postgres. Browser work polls at 1.5s while active; true Mac streaming polls
 * at 1s. Unchanged frames are metadata-only, so this stays light on mobile data.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

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

/** L5: one row per CLI session in the window — its own status and cost. */
interface ActivitySession {
  sessionId: string
  tool: string
  lastBn: string
  status: string
  costUsd: number
  at: string
}

interface ActivityFeed {
  active: boolean
  current: ActivityStep | null
  steps: ActivityStep[]
  sessions?: ActivitySession[]
  /** L7 — server truth: frames are flowing right now. */
  streaming?: boolean
  screenshot: string | null
  screenshotAt: string | null
  /** The picture's source; `current` may be a newer, unrelated session event. */
  screenshotSurface?: Extract<Surface, 'mac' | 'browser'> | null
  /** Browser and Mac stay independently addressable when both are live. */
  previews?: ActivityPreview[]
  videoDeviceId?: string | null
}

interface ActivityPreview {
  surface: Extract<Surface, 'mac' | 'browser'>
  screenshot: string | null
  screenshotAt: string | null
  labelBn: string
  active: boolean
  videoDeviceId?: string | null
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
const POLL_STREAMING_MS = 1_000
const POLL_ACTIVE_MS = 1_500
const POLL_IDLE_MS = 15_000
const FLOAT_MARGIN = 12
const FLOAT_STORAGE_KEY = 'alma-agent-live-pip-position-v1'

export interface FloatingPosition {
  x: number
  y: number
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: { width: number; height: number },
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPosition {
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, viewport.width - player.width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, viewport.height - player.height - margin)),
  }
}

export function snapFloatingPosition(
  position: FloatingPosition,
  viewport: { width: number; height: number },
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPosition {
  const clamped = clampFloatingPosition(position, viewport, player, margin)
  const right = Math.max(margin, viewport.width - player.width - margin)
  return { x: clamped.x + player.width / 2 < viewport.width / 2 ? margin : right, y: clamped.y }
}

interface AgentLiveMiniPlayerProps {
  active: boolean
  dotClass: string
  label: string
  screenshot: string | null
  surfaceLabel: string
  onExpand: () => void
  onDismiss: () => void
  availableSurfaces?: Array<Extract<Surface, 'mac' | 'browser'>>
  selectedSurface?: Extract<Surface, 'mac' | 'browser'>
  onSelectSurface?: (surface: Extract<Surface, 'mac' | 'browser'>) => void
}

/**
 * The Codex-style collapsed state: the frame itself is the product, not a
 * postage-stamp hint that only becomes useful after opening a sheet.
 */
export function AgentLiveMiniPlayer({
  active,
  dotClass,
  label,
  screenshot,
  surfaceLabel,
  onExpand,
  onDismiss,
  availableSurfaces = [],
  selectedSurface,
  onSelectSurface,
}: AgentLiveMiniPlayerProps) {
  const stacked = availableSurfaces.length > 1
  return (
    <div
      data-testid="agent-live-mini-player"
      data-stack-count={availableSurfaces.length || 1}
      className="pointer-events-auto relative w-full"
    >
      {stacked && (
        <div
          aria-hidden="true"
          className="absolute inset-0 -translate-x-2 -translate-y-2 rounded-2xl border border-white/15 bg-[#202227] shadow-xl"
        />
      )}
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#101114] shadow-2xl ring-1 ring-black/20">
      <button type="button" onClick={onExpand} aria-label="লাইভ ভিউ বড় করে দেখুন" className="block w-full text-left">
        <div className="relative aspect-video overflow-hidden bg-black">
          {screenshot ? (
            // Preserve the whole desktop/browser viewport — cropping it made
            // the old thumbnail useless for understanding where the agent was.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={screenshot}
              alt="এজেন্ট এখন যে স্ক্রিন দেখছে"
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,_#26303a,_#0b0c0e_72%)] text-xs text-white/55">
              প্রথম ফ্রেম আসছে…
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center bg-gradient-to-b from-black/75 to-transparent px-2.5 pb-5 pt-2">
            <span className={`h-2 w-2 rounded-full ${dotClass} ${active ? 'animate-pulse' : ''}`} />
            <span className="ml-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white/90 backdrop-blur">
              {active ? 'লাইভ' : 'শেষ ফ্রেম'} · {surfaceLabel}
            </span>
          </div>

          {stacked && (
            <div className="absolute left-2.5 top-9 flex gap-1" data-pip-control>
              {availableSurfaces.map((surface) => (
                <button
                  key={surface}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelectSurface?.(surface)
                  }}
                  aria-label={`${SURFACE_BN[surface]} লাইভ ভিউ দেখুন`}
                  className={`grid h-6 min-w-6 place-items-center rounded-full border px-1.5 text-[10px] backdrop-blur ${
                    surface === selectedSurface
                      ? 'border-white/45 bg-white/20 text-white'
                      : 'border-white/15 bg-black/45 text-white/65'
                  }`}
                >
                  {surface === 'browser' ? '🌐' : '⌘'}
                </button>
              ))}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2.5 pt-8">
            <p className="truncate text-xs font-medium text-white">{label}</p>
            <p className="mt-0.5 text-[10px] text-white/65">বড় করে দেখতে ট্যাপ করুন</p>
          </div>
        </div>
      </button>

      <div className="absolute right-2 top-2 flex items-center gap-1.5" data-pip-control>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onExpand}
          aria-label="বড় করে দেখুন"
          className="grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white/85 backdrop-blur transition hover:bg-black/75"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDismiss}
          aria-label="বন্ধ করুন"
          className="grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white/70 backdrop-blur transition hover:bg-black/75"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      </div>
    </div>
  )
}

export default function AgentLiveDock() {
  const [feed, setFeed] = useState<ActivityFeed | null>(null)
  const [expanded, setExpanded] = useState(false)
  /** He closed it by hand — respect that until genuinely NEW work starts. */
  const [dismissedStepId, setDismissedStepId] = useState<string | null>(null)
  const lastActiveRef = useRef<number>(0)
  const streamingRef = useRef(false)
  /**
   * The frame we already hold, keyed by `screenshotAt`. The poll tells the
   * server, and an unchanged frame comes back as metadata only — without this
   * every 3s poll re-downloaded the same multi-MB base64 payload (Codex P1).
   */
  const screenshotRef = useRef<{ uri: string; at: string } | null>(null)
  const previewRefs = useRef<Partial<Record<'mac' | 'browser', { uri: string; at: string }>>>({})
  const previewKeysRef = useRef(new Set<string>())
  const [selectedSurface, setSelectedSurface] = useState<'mac' | 'browser' | null>(null)

  const playerRef = useRef<HTMLDivElement>(null)
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null)
  const dragRef = useRef<{
    pointerId: number
    origin: FloatingPosition
    start: FloatingPosition
    moved: boolean
  } | null>(null)
  const suppressExpandRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const held = screenshotRef.current
      const query = new URLSearchParams()
      query.set('previewDeck', '1')
      if (held) query.set('screenshotAfter', held.at)
      const browserHeld = previewRefs.current.browser
      const macHeld = previewRefs.current.mac
      if (browserHeld) query.set('browserScreenshotAfter', browserHeld.at)
      if (macHeld) query.set('macScreenshotAfter', macHeld.at)
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const res = await fetch(`/api/assistant/live-activity${qs}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as ActivityFeed
      streamingRef.current = Boolean(data.streaming)
      if (data.active) lastActiveRef.current = Date.now()
      if (data.screenshot && data.screenshotAt) {
        screenshotRef.current = { uri: data.screenshot, at: data.screenshotAt }
      } else if (!data.screenshotAt) {
        screenshotRef.current = null
      } else if (held && data.screenshotAt === held.at) {
        // Unchanged — server omitted the payload; render the copy we hold.
        data.screenshot = held.uri
      }

      const previews = data.previews ?? (
        data.screenshotSurface
          ? [{
              surface: data.screenshotSurface,
              screenshot: data.screenshot,
              screenshotAt: data.screenshotAt,
              labelBn: data.current?.labelBn ?? 'কাজ চলছে',
              active: data.active,
              videoDeviceId: data.screenshotSurface === 'mac' ? data.videoDeviceId : null,
            }]
          : []
      )
      for (const preview of previews) {
        const cached = previewRefs.current[preview.surface]
        if (preview.screenshot && preview.screenshotAt) {
          previewRefs.current[preview.surface] = { uri: preview.screenshot, at: preview.screenshotAt }
        } else if (cached && preview.screenshotAt === cached.at) {
          preview.screenshot = cached.uri
        } else if (!preview.screenshotAt) {
          delete previewRefs.current[preview.surface]
        }
      }
      data.previews = previews

      const nextKeys = new Set(previews.map((preview) => preview.surface))
      const newlyVisible = previews.find((preview) => !previewKeysRef.current.has(preview.surface))
      previewKeysRef.current = nextKeys
      setSelectedSurface((previous) => {
        if (newlyVisible) return newlyVisible.surface
        if (previous && nextKeys.has(previous)) return previous
        return previews[0]?.surface ?? data.screenshotSurface ?? null
      })
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
      }, streamingRef.current ? POLL_STREAMING_MS : wasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS)
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

  // L7 — live screen streaming: an explicit owner start (privacy + cost). The
  // SERVER is the source of truth (fresh frames = streaming) so a remounted
  // page mid-stream shows STOP, not a second start (Codex on the L7 PR); a
  // short optimistic override bridges the seconds until frames appear.
  const [streamOptimistic, setStreamOptimistic] = useState<boolean | null>(null)
  const [streamBusy, setStreamBusy] = useState(false)
  const streamOn = streamOptimistic ?? Boolean(feed?.streaming)
  useEffect(() => {
    // Server state has caught up with the optimistic value — release it.
    if (streamOptimistic !== null && Boolean(feed?.streaming) === streamOptimistic) {
      setStreamOptimistic(null)
    }
  }, [feed?.streaming, streamOptimistic])
  const toggleStream = useCallback(async () => {
    if (streamBusy) return
    setStreamBusy(true)
    try {
      const res = await fetch('/api/assistant/mac-agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !streamOn }),
      })
      if (res.ok) setStreamOptimistic(!streamOn)
    } catch {
      /* the button simply stays where it was */
    } finally {
      setStreamBusy(false)
    }
  }, [streamOn, streamBusy])

  // Collapse the sheet when the work finishes, so it never traps his screen.
  useEffect(() => {
    if (!show) setExpanded(false)
  }, [show])

  const playerSize = useCallback(() => {
    const rect = playerRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 304, height: rect?.height ?? 171 }
  }, [])

  const settlePosition = useCallback((position: FloatingPosition, snap: boolean) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next = snap
      ? snapFloatingPosition(position, viewport, playerSize())
      : clampFloatingPosition(position, viewport, playerSize())
    setFloatingPosition(next)
    try {
      window.localStorage.setItem(FLOAT_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* private browsing can reject persistence; movement still works */
    }
    return next
  }, [playerSize])

  useEffect(() => {
    if (!show) return
    const frame = window.requestAnimationFrame(() => {
      let restored: FloatingPosition | null = null
      try {
        const raw = window.localStorage.getItem(FLOAT_STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<FloatingPosition>
          if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            restored = { x: Number(parsed.x), y: Number(parsed.y) }
          }
        }
      } catch {
        /* use the lower-right default */
      }
      const size = playerSize()
      settlePosition(
        restored ?? {
          x: window.innerWidth - size.width - FLOAT_MARGIN,
          y: window.innerHeight - size.height - 112,
        },
        Boolean(restored),
      )
    })
    const onResize = () => {
      setFloatingPosition((position) => position
        ? clampFloatingPosition(
            position,
            { width: window.innerWidth, height: window.innerHeight },
            playerSize(),
          )
        : position)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [playerSize, settlePosition, show])

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-pip-control]')) return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      origin: { x: rect.left, y: rect.top },
      start: { x: event.clientX, y: event.clientY },
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.start.x
    const dy = event.clientY - drag.start.y
    if (Math.hypot(dx, dy) > 5) drag.moved = true
    setFloatingPosition(clampFloatingPosition(
      { x: drag.origin.x + dx, y: drag.origin.y + dy },
      { width: window.innerWidth, height: window.innerHeight },
      playerSize(),
    ))
  }, [playerSize])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.start.x
    const dy = event.clientY - drag.start.y
    const finalPosition = { x: drag.origin.x + dx, y: drag.origin.y + dy }
    if (drag.moved) {
      suppressExpandRef.current = true
      window.requestAnimationFrame(() => { suppressExpandRef.current = false })
      settlePosition(finalPosition, true)
    }
    dragRef.current = null
  }, [settlePosition])

  const expandUnlessDragged = useCallback(() => {
    if (!suppressExpandRef.current) setExpanded(true)
  }, [])

  if (!show || !feed) return null

  const current = feed.current
  const dot = STATUS_DOT[current?.status ?? 'done'] ?? 'bg-black/25'
  const previews = feed.previews ?? []
  const selectedPreview =
    previews.find((preview) => preview.surface === selectedSurface) ?? previews[0] ?? null
  const pictureSurface: Surface = selectedPreview?.surface ?? feed.screenshotSurface ?? current?.surface ?? 'mac'
  const picture = selectedPreview?.screenshot ?? feed.screenshot
  const pictureLabel = selectedPreview?.labelBn ?? current?.labelBn ?? 'কাজ চলছে'

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
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={picture}
                alt="এজেন্ট যা দেখছে"
                className="w-full rounded-xl border border-black/10"
              />
            ) : (
              <div className="rounded-xl border border-dashed border-black/15 p-6 text-center text-sm text-black/45">
                এখনো কোনো ছবি নেই — কাজের ধাপগুলো নিচে দেখুন।
              </div>
            )}

            {(feed.streaming || pictureSurface === 'mac') && (
              <button
                type="button"
                onClick={() => void toggleStream()}
                disabled={streamBusy}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${
                  streamOn
                    ? 'border-red-300 bg-red-50 text-red-700'
                    : 'border-black/15 bg-black/[0.03] text-black/70'
                } disabled:opacity-50`}
              >
                {streamOn ? '⏹️ লাইভ ভিউ বন্ধ করুন' : '🎥 Mac-এর লাইভ ভিউ দেখুন'}
              </button>
            )}

            {(feed.sessions?.length ?? 0) > 0 && (
              <div className="mt-4 space-y-1.5">
                {feed.sessions!.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center gap-2 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        s.status === 'working'
                          ? 'animate-pulse bg-emerald-500'
                          : s.status === 'failed'
                            ? 'bg-red-500'
                            : 'bg-black/25'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {s.tool === 'codex' ? 'Codex' : 'Claude'} সেশন
                      </p>
                      <p className="truncate text-[11px] text-black/50">{s.lastBn}</p>
                    </div>
                    {s.costUsd > 0 && (
                      <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-black/60">
                        ${s.costUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                ))}
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
    <div
      ref={playerRef}
      data-testid="agent-live-floating-layer"
      className="fixed z-40 w-[min(76vw,19rem)] touch-none select-none cursor-grab active:cursor-grabbing sm:w-80"
      style={floatingPosition
        ? { left: floatingPosition.x, top: floatingPosition.y }
        : { right: FLOAT_MARGIN, bottom: 'calc(7rem + env(safe-area-inset-bottom))' }}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <AgentLiveMiniPlayer
        active={selectedPreview?.active ?? feed.active}
        dotClass={dot}
        label={pictureLabel}
        screenshot={picture}
        surfaceLabel={SURFACE_BN[pictureSurface]}
        onExpand={expandUnlessDragged}
        onDismiss={() => setDismissedStepId(current?.id ?? 'none')}
        availableSurfaces={previews.map((preview) => preview.surface)}
        selectedSurface={selectedPreview?.surface}
        onSelectSurface={setSelectedSurface}
      />
    </div>
  )
}
