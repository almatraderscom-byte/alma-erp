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
  /** Stable card/cache identity; old servers fall back to the surface. */
  contextId?: string | null
  screenshot: string | null
  screenshotAt: string | null
  labelBn: string
  active: boolean
  videoDeviceId?: string | null
}

function previewId(preview: ActivityPreview): string {
  return preview.contextId || preview.surface
}

export function selectedPreviewPicture(
  selected: Pick<ActivityPreview, 'screenshot'> | null,
  aggregate: string | null,
): string | null {
  return selected ? selected.screenshot : aggregate
}

export function activityVisibilityKey(feed: ActivityFeed): string {
  if (feed.current) return `step:${feed.current.id}`
  const cards = (feed.previews ?? [])
    .map((preview) => `${previewId(preview)}@${preview.screenshotAt ?? (preview.active ? 'active' : 'idle')}`)
    .sort()
    .join('|')
  if (cards) return `cards:${cards}`
  return `frame:${feed.screenshotSurface ?? 'none'}@${feed.screenshotAt ?? (feed.active ? 'active' : 'idle')}`
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
const STALE_FEED_MS = 20_000
const POLL_STREAMING_MS = 1_000
const POLL_ACTIVE_MS = 1_500
const POLL_IDLE_MS = 15_000
const FLOAT_MARGIN = 12
const FLOAT_STORAGE_KEY = 'alma-agent-live-pip-position-v1'

export function shouldExpireLiveActivity(
  lastSuccessfulAt: number,
  now = Date.now(),
  force = false,
): boolean {
  return force || lastSuccessfulAt <= 0 || now - lastSuccessfulAt >= STALE_FEED_MS
}

export interface FloatingPosition {
  x: number
  y: number
}

export interface FloatingPlacement {
  edge: 'left' | 'right'
  verticalFraction: number
}

interface FloatingViewport {
  width: number
  height: number
  /** Measured top edge of the real composer/bottom chrome. */
  bottomObstacleMinY?: number | null
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: FloatingViewport,
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPosition {
  const usableBottom = Math.min(
    viewport.height,
    Number.isFinite(viewport.bottomObstacleMinY) ? Number(viewport.bottomObstacleMinY) : viewport.height,
  )
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, viewport.width - player.width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, usableBottom - player.height - margin)),
  }
}

export function snapFloatingPosition(
  position: FloatingPosition,
  viewport: FloatingViewport,
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPosition {
  const clamped = clampFloatingPosition(position, viewport, player, margin)
  const right = Math.max(margin, viewport.width - player.width - margin)
  return { x: clamped.x + player.width / 2 < viewport.width / 2 ? margin : right, y: clamped.y }
}

export function placementFromPosition(
  position: FloatingPosition,
  viewport: FloatingViewport,
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPlacement {
  const clamped = clampFloatingPosition(position, viewport, player, margin)
  const usableBottom = Math.min(
    viewport.height,
    Number.isFinite(viewport.bottomObstacleMinY) ? Number(viewport.bottomObstacleMinY) : viewport.height,
  )
  const maxY = Math.max(margin, usableBottom - player.height - margin)
  const span = Math.max(0, maxY - margin)
  return {
    edge: clamped.x + player.width / 2 < viewport.width / 2 ? 'left' : 'right',
    verticalFraction: span > 0 ? Math.min(1, Math.max(0, (clamped.y - margin) / span)) : 0,
  }
}

export function positionFromPlacement(
  placement: FloatingPlacement,
  viewport: FloatingViewport,
  player: { width: number; height: number },
  margin = FLOAT_MARGIN,
): FloatingPosition {
  const usableBottom = Math.min(
    viewport.height,
    Number.isFinite(viewport.bottomObstacleMinY) ? Number(viewport.bottomObstacleMinY) : viewport.height,
  )
  const maxY = Math.max(margin, usableBottom - player.height - margin)
  const fraction = Math.min(1, Math.max(0, placement.verticalFraction))
  return {
    x: placement.edge === 'right'
      ? Math.max(margin, viewport.width - player.width - margin)
      : margin,
    y: margin + (maxY - margin) * fraction,
  }
}

interface AgentLiveMiniPlayerProps {
  active: boolean
  dotClass: string
  label: string
  screenshot: string | null
  surfaceLabel: string
  onExpand: () => void
  onDismiss: () => void
  availablePreviews?: Array<Pick<ActivityPreview, 'surface' | 'contextId' | 'labelBn'>>
  selectedPreviewId?: string
  onSelectPreview?: (id: string) => void
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
  availablePreviews = [],
  selectedPreviewId,
  onSelectPreview,
}: AgentLiveMiniPlayerProps) {
  const stacked = availablePreviews.length > 1
  return (
    <div
      data-testid="agent-live-mini-player"
      data-stack-count={availablePreviews.length || 1}
      className="pointer-events-auto relative w-full"
    >
      {stacked && (
        <div
          aria-hidden="true"
          className="absolute inset-0 -translate-x-2 -translate-y-2 rounded-2xl border border-white/15 bg-[#202227] shadow-xl"
        />
      )}
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#101114] shadow-2xl ring-1 ring-black/20">
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

          <button
            type="button"
            onClick={onExpand}
            aria-label="লাইভ ভিউ বড় করে দেখুন"
            className="absolute inset-0 z-10 block h-full w-full"
          >
            <span className="sr-only">লাইভ ভিউ বড় করে দেখুন</span>
          </button>

          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center bg-gradient-to-b from-black/75 to-transparent px-2.5 pb-5 pt-2">
            <span className={`h-2 w-2 rounded-full ${dotClass} ${active ? 'animate-pulse' : ''}`} />
            <span className="ml-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white/90 backdrop-blur">
              {active ? 'লাইভ' : 'শেষ ফ্রেম'} · {surfaceLabel}
            </span>
          </div>

          {stacked && (
            <div className="absolute left-2.5 top-9 z-30 flex gap-1" data-pip-control>
              {availablePreviews.map((preview) => {
                const id = preview.contextId || preview.surface
                return (
                <button
                  key={id}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelectPreview?.(id)
                  }}
                  aria-label={`${preview.labelBn || SURFACE_BN[preview.surface]} লাইভ ভিউ দেখুন`}
                  className={`grid h-6 min-w-6 place-items-center rounded-full border px-1.5 text-[10px] backdrop-blur ${
                    id === selectedPreviewId
                      ? 'border-white/45 bg-white/20 text-white'
                      : 'border-white/15 bg-black/45 text-white/65'
                  }`}
                >
                  {preview.surface === 'browser' ? '🌐' : '⌘'}
                </button>
              )})}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2.5 pt-8">
            <p className="truncate text-xs font-medium text-white">{label}</p>
            <p className="mt-0.5 text-[10px] text-white/65">বড় করে দেখতে ট্যাপ করুন</p>
          </div>
        </div>

      <div className="absolute right-2 top-2 z-30 flex items-center gap-1.5" data-pip-control>
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
  const [dismissedActivityKey, setDismissedActivityKey] = useState<string | null>(null)
  const lastActiveRef = useRef<number>(0)
  const lastSuccessfulRefreshRef = useRef<number>(0)
  const streamingRef = useRef(false)
  const loadPromiseRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)
  /**
   * The frame we already hold, keyed by `screenshotAt`. The poll tells the
   * server, and an unchanged frame comes back as metadata only — without this
   * every 3s poll re-downloaded the same multi-MB base64 payload (Codex P1).
   */
  const screenshotRef = useRef<{ uri: string; at: string } | null>(null)
  const previewRefs = useRef<Record<string, { uri: string; at: string }>>({})
  const previewKeysRef = useRef(new Set<string>())
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null)

  const playerRef = useRef<HTMLDivElement>(null)
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null)
  const placementRef = useRef<FloatingPlacement>({ edge: 'right', verticalFraction: 0.76 })
  const dragRef = useRef<{
    pointerId: number
    origin: FloatingPosition
    start: FloatingPosition
    moved: boolean
  } | null>(null)
  const suppressExpandRef = useRef(false)

  const clearExpiredFeed = useCallback((force = false) => {
    if (!shouldExpireLiveActivity(lastSuccessfulRefreshRef.current, Date.now(), force)) return
    lastActiveRef.current = 0
    lastSuccessfulRefreshRef.current = 0
    screenshotRef.current = null
    previewRefs.current = {}
    previewKeysRef.current = new Set()
    streamingRef.current = false
    if (!mountedRef.current) return
    setFeed(null)
    setExpanded(false)
    setSelectedPreviewId(null)
  }, [])

  const load = useCallback((): Promise<void> => {
    // Foreground events and the poll timer can fire together. Coalesce them so
    // an older response can never overwrite a newer source selection/frame.
    if (loadPromiseRef.current) return loadPromiseRef.current
    const task = (async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), STALE_FEED_MS)
      try {
        const held = screenshotRef.current
        const query = new URLSearchParams()
        query.set('previewDeck', '1')
        if (held) query.set('screenshotAfter', held.at)
        const previewAfter = Object.fromEntries(
          Object.entries(previewRefs.current).map(([id, frame]) => [id, frame.at]),
        )
        if (Object.keys(previewAfter).length) query.set('previewAfter', JSON.stringify(previewAfter))
        const browserHeldAt = Object.entries(previewRefs.current)
          .filter(([id]) => id === 'browser' || id.startsWith('browser:'))
          .map(([, frame]) => frame.at).sort().at(-1)
        const macHeldAt = Object.entries(previewRefs.current)
          .filter(([id]) => id === 'mac' || id.startsWith('mac:'))
          .map(([, frame]) => frame.at).sort().at(-1)
        if (browserHeldAt) query.set('browserScreenshotAfter', browserHeldAt)
        if (macHeldAt) query.set('macScreenshotAfter', macHeldAt)
        const qs = query.size > 0 ? `?${query.toString()}` : ''
        const res = await fetch(`/api/assistant/live-activity${qs}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!res.ok) {
          clearExpiredFeed(res.status === 401 || res.status === 403)
          return
        }
        const data = (await res.json()) as ActivityFeed
        if (!mountedRef.current) return
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
          const id = previewId(preview)
          const cached = previewRefs.current[id]
          if (preview.screenshot && preview.screenshotAt) {
            previewRefs.current[id] = { uri: preview.screenshot, at: preview.screenshotAt }
          } else if (cached && preview.screenshotAt === cached.at) {
            preview.screenshot = cached.uri
          } else if (!preview.screenshotAt) {
            delete previewRefs.current[id]
          }
        }
        data.previews = previews

        const nextKeys = new Set(previews.map(previewId))
        for (const id of Object.keys(previewRefs.current)) {
          if (!nextKeys.has(id)) delete previewRefs.current[id]
        }
        const newlyVisible = previews.find((preview) => !previewKeysRef.current.has(previewId(preview)))
        previewKeysRef.current = nextKeys
        setSelectedPreviewId((previous) => {
          if (newlyVisible) return previewId(newlyVisible)
          if (previous && nextKeys.has(previous)) return previous
          return previews[0] ? previewId(previews[0]) : null
        })
        setFeed(data)
        // Only a DIFFERENT step brings the dock back. Clearing the dismiss on
        // every active poll meant closing it during a running job re-opened it
        // three seconds later (Codex review).
        const nextVisibilityKey = activityVisibilityKey(data)
        setDismissedActivityKey((previous) => (
          previous && nextVisibilityKey !== previous ? null : previous
        ))
        // Only a completely reconciled response refreshes truthfulness. A
        // malformed rolling-schema 200 must not keep stale active pixels alive.
        lastSuccessfulRefreshRef.current = Date.now()
      } catch {
        clearExpiredFeed()
      } finally {
        clearTimeout(timeout)
      }
    })()
    loadPromiseRef.current = task
    void task.finally(() => {
      if (loadPromiseRef.current === task) loadPromiseRef.current = null
    })
    return task
  }, [clearExpiredFeed])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    const tick = () => {
      const wasActive = Date.now() - lastActiveRef.current < LINGER_MS
      timer = setTimeout(async () => {
        await load()
        if (!cancelled) tick()
      }, streamingRef.current ? POLL_STREAMING_MS : wasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [load])

  useEffect(() => {
    const refreshOnForeground = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', refreshOnForeground)
    return () => document.removeEventListener('visibilitychange', refreshOnForeground)
  }, [load])

  const recentlyActive = Date.now() - lastActiveRef.current < LINGER_MS
  const dismissed = Boolean(feed && dismissedActivityKey === activityVisibilityKey(feed))
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

  const floatingViewport = useCallback((): FloatingViewport => {
    const obstacle = document.querySelector<HTMLElement>('[data-agent-bottom-obstacle]')
    const obstacleTop = obstacle?.getBoundingClientRect().top
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      bottomObstacleMinY: Number.isFinite(obstacleTop) ? obstacleTop : null,
    }
  }, [])

  const settlePosition = useCallback((position: FloatingPosition, snap: boolean) => {
    const viewport = floatingViewport()
    const size = playerSize()
    const next = snap
      ? snapFloatingPosition(position, viewport, size)
      : clampFloatingPosition(position, viewport, size)
    const placement = placementFromPosition(next, viewport, size)
    placementRef.current = placement
    setFloatingPosition(next)
    try {
      window.localStorage.setItem(FLOAT_STORAGE_KEY, JSON.stringify(placement))
    } catch {
      /* private browsing can reject persistence; movement still works */
    }
    return next
  }, [floatingViewport, playerSize])

  useEffect(() => {
    if (!show) return
    const frame = window.requestAnimationFrame(() => {
      let restoredPlacement: FloatingPlacement | null = null
      let legacyPosition: FloatingPosition | null = null
      try {
        const raw = window.localStorage.getItem(FLOAT_STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<FloatingPosition & FloatingPlacement>
          if ((parsed.edge === 'left' || parsed.edge === 'right') && Number.isFinite(parsed.verticalFraction)) {
            restoredPlacement = {
              edge: parsed.edge,
              verticalFraction: Number(parsed.verticalFraction),
            }
          } else if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            legacyPosition = { x: Number(parsed.x), y: Number(parsed.y) }
          }
        }
      } catch {
        /* use the lower-right default */
      }
      const size = playerSize()
      const viewport = floatingViewport()
      const placement = restoredPlacement
        ?? (legacyPosition ? placementFromPosition(legacyPosition, viewport, size) : placementRef.current)
      placementRef.current = placement
      setFloatingPosition(positionFromPlacement(placement, viewport, size))
    })
    const onResize = () => {
      setFloatingPosition((position) => position
        ? positionFromPlacement(placementRef.current, floatingViewport(), playerSize())
        : position)
    }
    const obstacle = document.querySelector<HTMLElement>('[data-agent-bottom-obstacle]')
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)
    if (obstacle) resizeObserver?.observe(obstacle)
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [floatingViewport, playerSize, show])

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
      floatingViewport(),
      playerSize(),
    ))
  }, [floatingViewport, playerSize])

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
    previews.find((preview) => previewId(preview) === selectedPreviewId) ?? previews[0] ?? null
  const pictureSurface: Surface = selectedPreview?.surface ?? feed.screenshotSurface ?? current?.surface ?? 'mac'
  // A selected card without its first frame owns the placeholder. Falling back
  // to the aggregate image would label Chrome A/Mac pixels as Chrome B.
  const picture = selectedPreviewPicture(selectedPreview, feed.screenshot)
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
            {previews.length > 1 && (
              <div className="mb-3 flex gap-2 overflow-x-auto" data-testid="agent-live-sheet-sources">
                {previews.map((preview) => {
                  const id = previewId(preview)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelectedPreviewId(id)}
                      aria-label={`${preview.labelBn} লাইভ ভিউ দেখুন`}
                      className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
                        id === selectedPreviewId
                          ? 'border-orange-300 bg-orange-50 text-orange-800'
                          : 'border-black/10 bg-black/[0.03] text-black/60'
                      }`}
                    >
                      {preview.surface === 'browser' ? '🌐' : '⌘'} {preview.labelBn}
                    </button>
                  )
                })}
              </div>
            )}
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

            {pictureSurface === 'mac' && (
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
        onDismiss={() => setDismissedActivityKey(activityVisibilityKey(feed))}
        availablePreviews={previews}
        selectedPreviewId={selectedPreview ? previewId(selectedPreview) : undefined}
        onSelectPreview={setSelectedPreviewId}
      />
    </div>
  )
}
