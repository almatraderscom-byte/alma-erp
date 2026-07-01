'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import AgentSidebar, { type Conversation } from './AgentSidebar'
import AgentThread, { type ChatMessage, type TimelineEntry } from './AgentThread'
import AgentComposer, { type PendingFile } from './AgentComposer'
import AgentArtifactsPanel, { type Artifact } from './AgentArtifactsPanel'
import { notifyTodosChanged } from './AgentTodoContext'
const VoiceSession = dynamic(() => import('./voice/VoiceSession'), { ssr: false })
import toast from 'react-hot-toast'
import { useMediaQuery } from '@/agent/hooks/useMediaQuery'
import { AgentConversationSkeleton } from '@/agent/components/AgentThinkingIndicator'
import { toolDisplay } from '@/agent/lib/tool-labels'
import { cn } from '@/lib/utils'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { type PlanDrivePanelData, type PlanDriveAction } from '@/agent/components/monitor/PlanDriveTimeline'

interface AgentAppProps {
  userName: string
}

let _msgCounter = 0
function nextId(prefix = 'msg') { return `${prefix}-${++_msgCounter}` }

async function readAssistantError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: string; message?: string }
    if (data.error === 'anthropic_key_missing') {
      return 'ANTHROPIC_API_KEY Production-এ set নেই। Vercel → Environment Variables → Production চেক করে redeploy করুন।'
    }
    if (data.error === 'agent_db_not_migrated') {
      return 'Agent database migration apply করা হয়নি। Production DB-তে prisma migrate deploy চালান।'
    }
    if (data.error === 'agent_disabled') {
      return 'Agent বন্ধ আছে (AGENT_ENABLED=false)'
    }
    if (data.message) return data.message
    if (data.error) return data.error
  } catch {
    /* non-JSON body */
  }
  return fallback
}

type MessageRow = {
  id: string
  role: string
  content: Array<{
    type: string
    text?: string
    bucket?: string
    path?: string
    mediaType?: string
    pendingActionId?: string
    summary?: string
    actionType?: string
    costEstimate?: number
    status?: string
    durationMs?: number
  }>
  toolCalls?: Array<{
    id: string
    name: string
    success?: boolean
    input?: unknown
    result?: string
  }>
  tokensIn: number | null
  tokensOut: number | null
  cacheCreation: number | null
  cacheRead: number | null
  costUsd: string | null
  /** Persisted reasoning trace — restores the "Thought for Ns" block after reload. */
  thinking?: string
  /** Reasoning wall-clock (ms) — restores the "Thought for Ns" duration after reload. */
  thinkingMs?: number
  /** Ordered reasoning↔tool timeline — drives the unified stream after reload. */
  timeline?: TimelineEntry[]
}

function mapMessageRows(rows: MessageRow[]): ChatMessage[] {
  return rows.map((r) => {
    const textBlocks = r.content.filter((b) => b.type === 'text')
    const fileBlocks = r.content.filter((b) => b.type === 'file_ref')
    const confirmBlock = r.content.find((b) => b.type === 'confirm_card' && b.pendingActionId)
    // Persisted extended-thinking trace (usage.reasoning) + tool cards, reconstructed
    // so they survive the message poll / reload instead of only living in the stream.
    const toolActivity = (r.toolCalls ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      done: true,
      success: t.success,
      input: t.input,
      result: t.result,
    }))
    return {
      id: r.id,
      role: r.role as 'user' | 'assistant',
      text: textBlocks.map((b) => b.text ?? '').join(''),
      thinking: r.thinking,
      thinkingMs: r.thinkingMs,
      timeline: Array.isArray(r.timeline) && r.timeline.length > 0 ? r.timeline : undefined,
      toolActivity: toolActivity.length > 0 ? toolActivity : undefined,
      files: fileBlocks.map((b) => ({
        // Persisted file_ref blocks carry no local blob — the thumbnail resolves a
        // short-lived signed URL from `path` at render time (see ChatImage).
        previewUrl: '',
        mediaType: b.mediaType ?? 'image/jpeg',
        path: b.path,
      })),
      tokensIn: r.tokensIn ?? undefined,
      tokensOut: r.tokensOut ?? undefined,
      cacheCreation: r.cacheCreation ?? undefined,
      cacheRead: r.cacheRead ?? undefined,
      costUsd: r.costUsd != null ? parseFloat(r.costUsd) : undefined,
      pendingAction: confirmBlock?.pendingActionId
        ? {
            id: confirmBlock.pendingActionId,
            summary: confirmBlock.summary ?? '',
            costEstimate: confirmBlock.costEstimate,
            actionType: confirmBlock.actionType,
            // Persisted/reloaded cards carry their resolved status so the card
            // renders as a settled breadcrumb (✅/❌) instead of a fresh prompt.
            resolvedStatus: confirmBlock.status,
          }
        : undefined,
    }
  })
}

// ── Live activity-timeline builders ─────────────────────────────────────────
// Build the unified ordered timeline (reasoning ↔ tool) on the client as SSE
// events arrive, mirroring what the server persists in usage.timeline so the live
// stream and the reloaded view render the SAME single Claude-style card.
function appendThinkToTimeline(tl: TimelineEntry[] | undefined, chunk: string): TimelineEntry[] {
  const next = tl ? tl.slice() : []
  const last = next[next.length - 1]
  if (last && last.t === 'think') {
    next[next.length - 1] = { t: 'think', text: last.text + chunk }
  } else {
    next.push({ t: 'think', text: chunk })
  }
  return next
}

function pushOrUpdateTool(
  tl: TimelineEntry[] | undefined,
  id: string,
  name: string,
  input: unknown,
): TimelineEntry[] {
  const next = tl ? tl.slice() : []
  const idx = next.findIndex((e) => e.t === 'tool' && e.id === id)
  if (idx >= 0) {
    const cur = next[idx] as Extract<TimelineEntry, { t: 'tool' }>
    next[idx] = { ...cur, input: input ?? cur.input }
  } else {
    next.push({ t: 'tool', id, name, ok: true, live: true, input })
  }
  return next
}

function finalizeTool(
  tl: TimelineEntry[] | undefined,
  id: string,
  ok: boolean,
  result?: string,
): TimelineEntry[] | undefined {
  if (!tl) return tl
  return tl.map((e) =>
    e.t === 'tool' && e.id === id
      ? { ...e, ok, live: false, result: result ?? e.result }
      : e,
  )
}

function parseSseChunks(buf: string): { remaining: string; events: Array<Record<string, unknown>> } {
  const parts = buf.split('\n\n')
  const remaining = parts.pop() ?? ''
  const events: Array<Record<string, unknown>> = []
  for (const chunk of parts) {
    if (!chunk.startsWith('data: ')) continue
    try {
      events.push(JSON.parse(chunk.slice(6)) as Record<string, unknown>)
    } catch { /* skip malformed */ }
  }
  return { remaining, events }
}

function parseTrailingSseEvent(buf: string): Record<string, unknown> | null {
  const trimmed = buf.trim()
  if (!trimmed.startsWith('data: ')) return null
  try {
    return JSON.parse(trimmed.slice(6)) as Record<string, unknown>
  } catch {
    return null
  }
}

export default function AgentApp({ userName: _userName }: AgentAppProps) {
  const isMobile = useMediaQuery('(max-width: 767px)')

  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [artifactsOpen, setArtifactsOpen] = useState(false)

  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  // Brief "সংযোগ হচ্ছে…" glass pill on cold open / return-from-background (Claude-app
  // feel — confirms the session reconnected). Auto-hides after a short confirmation.
  const [reconnecting, setReconnecting] = useState(false)
  // streamStatus is still computed (telemetry / future use) but the live
  // indicator now shows the Claude-style rotating verb + model name instead.
  const [, setStreamStatus] = useState<string | null>(null)
  const [streamMode, setStreamMode] = useState<'thinking' | 'searching' | 'writing' | 'settled'>('thinking')
  // Which model is answering the live turn → drives the loading animation identity.
  const [streamVariant, setStreamVariant] = useState<'claude' | 'qwen' | 'deepseek' | 'default'>('claude')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [convLoading, setConvLoading] = useState(false)
  const [convLoadError, setConvLoadError] = useState<string | null>(null)
  const [personalProjectId, setPersonalProjectId] = useState<string | null>(null)
  const [activePersonalMode, setActivePersonalMode] = useState(false)
  const [activeConvProjectId, setActiveConvProjectId] = useState<string | null>(null)
  // 'auto' = let the per-turn router pick the head model (current cost-optimized
  // routing); a concrete id pins that exact model for the conversation.
  const [activeModelId, setActiveModelId] = useState('auto')
  const [compacting, setCompacting] = useState(false)
  const [dayShift, setDayShift] = useState<{
    conversationId: string | null
    active: boolean
    title: string | null
  } | null>(null)

  const [voiceOpen, setVoiceOpen] = useState(false)
  const [planDrive, setPlanDrive] = useState<PlanDrivePanelData | null>(null)
  const [composerSeed, setComposerSeed] = useState('')

  // Staff-hub (and other) deep-links land here as ?draft=<command>. Seed the
  // composer once, then strip the param so a refresh doesn't re-seed it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const draft = params.get('draft')
    if (!draft) return
    setComposerSeed(draft)
    params.delete('draft')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }, [])

  const abortRef = useRef<AbortController | null>(null)
  // Durable server-side turn id (from the chat stream) — used by the Stop button to
  // issue a real cross-instance cancel, and to poll a backgrounded turn to completion.
  const activeTurnIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dayShiftPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /**
   * Streaming text-delta batcher: Anthropic emits a `text_delta` per token. Calling
   * setMessages() on every event was the root cause of streaming jank. We now
   * accumulate the streamed text in a ref and flush to React state at most once
   * per animation frame (~60fps), matching how Claude.ai / Cursor render.
   */
  const streamBufferRef = useRef<{ msgId: string; pending: string; flushScheduled: boolean } | null>(null)

  /** Same rAF-batching for the extended-thinking stream (Cursor-style "Thought" block),
   *  plus a start timestamp so we can show "Thought for Ns" once the reply begins. */
  const thinkingBufferRef = useRef<{ msgId: string; pending: string; flushScheduled: boolean; startedAt: number } | null>(null)

  // iPhone fix (backgrounded turn): mirror streaming + active conversation into
  // refs so the visibility listener (registered once) always reads current values.
  const streamingRef = useRef(streaming)
  useEffect(() => { streamingRef.current = streaming }, [streaming])
  const activeConvIdRef = useRef(activeConvId)
  useEffect(() => { activeConvIdRef.current = activeConvId }, [activeConvId])

  /**
   * Pull the authoritative server state for a conversation and replace local
   * messages with it. Used when the stream is lost — the native app was
   * backgrounded (iOS suspends the WebView and drops the fetch) or the owner hit
   * stop. The server turn now always runs to completion and saves the reply, so
   * if the latest row is still the owner's question we poll briefly until the
   * assistant reply lands. Bails out the moment a new stream starts.
   */
  const resyncActiveConversation = useCallback(async (convId: string | null) => {
    if (!convId) return

    const fetchMessages = async (): Promise<MessageRow[] | null> => {
      try {
        const res = await fetch(`/api/assistant/conversations/${convId}/messages`)
        if (res.ok) {
          const rows: MessageRow[] = await res.json()
          if (!streamingRef.current) setMessages(mapMessageRows(rows))
          return rows
        }
      } catch { /* offline / transient */ }
      return null
    }

    // Sync whatever is already persisted first.
    const rows = await fetchMessages()
    if (streamingRef.current) return
    const last = rows?.[rows.length - 1]
    if (last && last.role !== 'user') return // assistant reply already landed

    // The last persisted row is still the owner's message — a turn may be running
    // server-side (the app was backgrounded mid-turn). Poll the durable turn status
    // until it leaves 'running', then render the reply. Budget covers the 280s
    // server hard-cap plus slack (100 × 3s = 300s).
    for (let attempt = 0; attempt < 100; attempt++) {
      if (streamingRef.current) return
      await new Promise((r) => setTimeout(r, 3000))
      if (streamingRef.current) return
      let status = 'idle'
      try {
        const sres = await fetch(`/api/assistant/conversations/${convId}/turn-status`)
        if (sres.ok) status = ((await sres.json()) as { status?: string }).status ?? 'idle'
      } catch { /* transient — keep polling */ }
      if (status === 'running') continue
      // Terminal (done / error / canceled / idle) → pull the final reply and stop.
      await fetchMessages()
      return
    }
  }, [])

  const hiddenSinceRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const flashReconnecting = useCallback((ms: number) => {
    setReconnecting(true)
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = window.setTimeout(() => setReconnecting(false), ms)
  }, [])

  // Cold open — brief connecting confirmation so the session feels "live" on entry.
  useEffect(() => {
    flashReconnecting(1200)
    return () => { if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current) }
  }, [flashReconnecting])

  useEffect(() => {
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = performance.now()
        return
      }
      // Became visible — show the "সংযোগ হচ্ছে…" pill only after a real absence
      // (not a quick tab flick), then resync the conversation.
      const away = hiddenSinceRef.current != null ? performance.now() - hiddenSinceRef.current : 0
      hiddenSinceRef.current = null
      if (streamingRef.current) return
      if (away > 2500) flashReconnecting(1400)
      void resyncActiveConversation(activeConvIdRef.current)
    }
    document.addEventListener('visibilitychange', onVisChange)
    return () => document.removeEventListener('visibilitychange', onVisChange)
  }, [resyncActiveConversation, flashReconnecting])

  // App-presence heartbeat: while the agent app is foreground, ping the server so
  // it knows the owner is here and suppresses agent push (ntfy). When he leaves
  // (backgrounded/closed) the pings stop, presence goes stale, and agent replies/
  // approvals are delivered as ntfy notifications instead.
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== 'visible') return
      void fetch('/api/assistant/presence', { method: 'POST' }).catch(() => {})
    }
    ping()
    const iv = setInterval(ping, 20_000)
    const onVis = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  useEffect(() => { setSidebarOpen(!isMobile) }, [isMobile])

  // Unified persistent session: on load, resume the conversation the owner was
  // last in (the same thread shared with Telegram), so a refresh stays put
  // instead of dropping to a blank chat. Runs once; skips if the owner is mid-
  // stream or already deep-linked into a specific conversation.
  const didResumeRef = useRef(false)
  useEffect(() => {
    if (didResumeRef.current) return
    didResumeRef.current = true
    void (async () => {
      try {
        const res = await fetch('/api/assistant/active-conversation')
        if (!res.ok) return
        const data = (await res.json()) as {
          conversationId: string | null
          projectId: string | null
          modelId: string | null
        }
        if (!data.conversationId) return
        if (streamingRef.current || activeConvIdRef.current) return
        await loadConversation({
          id: data.conversationId,
          title: null,
          projectId: data.projectId,
          modelId: data.modelId ?? undefined,
          archived: false,
          updatedAt: '',
        })
      } catch { /* offline / transient — start blank */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the active main thread live: poll its messages on a slow cadence so
  // agent task-replies and Telegram-side turns appear in the app chat without a
  // manual refresh. Office day-shift threads have their own faster poll, and we
  // never poll while a local stream is in flight (the stream is authoritative).
  useEffect(() => {
    if (!activeConvId) return
    if (dayShift?.active && activeConvId === dayShift.conversationId) return
    let stopped = false
    const poll = async () => {
      if (stopped || streamingRef.current) return
      try {
        const res = await fetch(`/api/assistant/conversations/${activeConvId}/messages`)
        if (!res.ok) return
        const rows: MessageRow[] = await res.json()
        if (!stopped && !streamingRef.current) {
          setMessages((prev) => {
            const next = mapMessageRows(rows)
            // Avoid clobbering an optimistic in-flight render: only replace when
            // the server has at least as many rows as we're showing.
            return next.length >= prev.length ? next : prev
          })
        }
      } catch { /* transient */ }
    }
    const iv = setInterval(() => void poll(), 12_000)
    return () => { stopped = true; clearInterval(iv) }
  }, [activeConvId, dayShift?.active, dayShift?.conversationId])

  useEffect(() => {
    void fetch('/api/assistant/health')
      .then(async (res) => (res.ok ? res.json() as Promise<{ db?: boolean; anthropic?: boolean }> : null))
      .then((data) => {
        if (!data) return
        if (!data.db) toast.error('Agent DB tables নেই — production-এ migration apply করুন')
        else if (!data.anthropic) toast.error('ANTHROPIC_API_KEY server-এ পাওয়া যায়নি — Vercel Production env + redeploy')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void fetch('/api/assistant/personal-space')
      .then(async (res) => (res.ok ? res.json() as Promise<{ projectId: string }> : null))
      .then((data) => { if (data?.projectId) setPersonalProjectId(data.projectId) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    async function refreshShift() {
      try {
        const res = await fetch('/api/assistant/day-shift')
        if (!res.ok) return
        const data = await res.json() as {
          conversationId: string | null
          active: boolean
          title: string | null
        }
        setDayShift(data)
      } catch { /* ignore */ }
    }
    void refreshShift()
    const id = setInterval(() => void refreshShift(), 30_000)
    return () => clearInterval(id)
  }, [])

  // Plan-Drive "Live Desk" — poll the in-flight autonomous plans so the owner can
  // watch them advance step-by-step on the home screen, and see at a glance what is
  // parked on his approval/decision. Self-contained; safe to poll.
  useEffect(() => {
    async function refreshPlanDrive() {
      try {
        const res = await fetch('/api/assistant/plan-driver')
        if (!res.ok) return
        setPlanDrive((await res.json()) as PlanDrivePanelData)
      } catch { /* ignore */ }
    }
    void refreshPlanDrive()
    const id = setInterval(() => void refreshPlanDrive(), 30_000)
    return () => clearInterval(id)
  }, [])

  // One owner-action handler for the Plan-Drive in-chat list (resume / add-budget /
  // abandon), reused on both the home screen and inside the office-shift thread.
  const handlePlanDriveAction = useCallback(async (planId: string, action: PlanDriveAction) => {
    try {
      const res = await fetch('/api/assistant/plan-driver/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, action }),
      })
      if (!res.ok) { toast.error('কাজটি করা গেল না'); return }
      toast.success(
        action === 'abandon' ? 'প্ল্যান বাদ দেওয়া হলো' :
        action === 'add-budget' ? 'বাজেট বাড়িয়ে আবার চালু করা হলো' :
        'আবার চালু করা হলো',
      )
      const r = await fetch('/api/assistant/plan-driver')
      if (r.ok) setPlanDrive((await r.json()) as PlanDrivePanelData)
    } catch { toast.error('নেটওয়ার্ক সমস্যা') }
  }, [])

  useEffect(() => {
    if (!dayShift?.active || !dayShift.conversationId || activeConvId !== dayShift.conversationId) {
      if (dayShiftPollRef.current) {
        clearInterval(dayShiftPollRef.current)
        dayShiftPollRef.current = null
      }
      return
    }
    async function pollMessages() {
      try {
        const res = await fetch(`/api/assistant/conversations/${dayShift!.conversationId}/messages`)
        if (!res.ok) return
        const rows: MessageRow[] = await res.json()
        setMessages(mapMessageRows(rows))
      } catch { /* ignore */ }
    }
    void pollMessages()
    dayShiftPollRef.current = setInterval(() => void pollMessages(), 15_000)
    return () => {
      if (dayShiftPollRef.current) clearInterval(dayShiftPollRef.current)
    }
  }, [dayShift?.active, dayShift?.conversationId, activeConvId])

  useEffect(() => {
    if (personalProjectId && activeConvProjectId) {
      setActivePersonalMode(activeConvProjectId === personalProjectId)
    }
  }, [personalProjectId, activeConvProjectId])

  async function loadConversation(conv: Conversation) {
    setActiveConvId(conv.id)
    setActiveConvProjectId(conv.projectId)
    setActiveModelId(conv.modelId ?? 'auto')
    setActivePersonalMode(
      !!personalProjectId && conv.projectId === personalProjectId,
    )
    setMessages([])
    setArtifacts([])
    setConvLoading(true)
    setConvLoadError(null)

    try {
    const [msgRes, artRes] = await Promise.all([
      fetch(`/api/assistant/conversations/${conv.id}/messages`),
      fetch(`/api/assistant/conversations/${conv.id}/artifacts`),
    ])

    if (!msgRes.ok) throw new Error(`মেসেজ লোড ব্যর্থ (HTTP ${msgRes.status})`)

    if (msgRes.ok) {
      const rows: MessageRow[] = await msgRes.json()
      setMessages(mapMessageRows(rows))
    }

    if (artRes.ok) setArtifacts(await artRes.json())
    } catch (err) {
      setConvLoadError(err instanceof Error ? err.message : 'লোড ব্যর্থ')
    } finally {
      setConvLoading(false)
    }

    // Unified session: aim the shared pointer at this thread so Telegram follows
    // the owner's app selection. Skip the office day-shift thread — it has its own
    // lifecycle and must not hijack the main/personal pointer.
    if (conv.id !== dayShift?.conversationId) {
      const personalMode = !!personalProjectId && conv.projectId === personalProjectId
      void fetch('/api/assistant/active-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conv.id, personalMode }),
      }).catch(() => {})
    }
  }

  function newConversation(projectId?: string) {
    setActiveConvId(null)
    setMessages([])
    setArtifacts([])
    setActiveModelId('claude-sonnet-4-6')
    pendingProjectIdRef.current = projectId ?? null
    setActiveConvProjectId(projectId ?? null)
    setActivePersonalMode(!!personalProjectId && projectId === personalProjectId)
  }

  async function enterPersonalMode() {
    try {
      const res = await fetch('/api/assistant/personal-space')
      if (!res.ok) throw new Error('ব্যক্তিগত স্পেস লোড ব্যর্থ')
      const data = await res.json() as { projectId: string }
      setPersonalProjectId(data.projectId)
      newConversation(data.projectId)
      if (isMobile) setSidebarOpen(false)
      toast.success('ব্যক্তিগত মোড — নতুন কথোপকথন')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ব্যক্তিগত মোড খুলতে ব্যর্থ')
    }
  }
  const pendingProjectIdRef = useRef<string | null>(null)

  const handleSend = useCallback(async (
    text: string,
    pendingFiles: PendingFile[],
    resumeOpts?: { approve: boolean; rememberChoice?: boolean; fallbackModelId?: string },
  ) => {
    if (streaming) return
    abortRef.current = new AbortController()
    setStreaming(true)
    setStreamStatus('প্রসেস করা হচ্ছে…')
    setStreamMode('thinking') // start in the thinking state until tools/text arrive
    setStreamVariant('claude') // reset until model_info arrives (fail-safe = head)

    let convIdForUpload = activeConvId
    if (!convIdForUpload && pendingFiles.length > 0) {
      try {
        const convRes = await fetch('/api/assistant/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: text.slice(0, 60) || null,
            projectId: pendingProjectIdRef.current ?? undefined,
          }),
        })
        if (convRes.ok) {
          const conv = await convRes.json() as { id: string; projectId?: string | null }
          convIdForUpload = conv.id
          setActiveConvId(conv.id)
          if (personalProjectId && conv.projectId === personalProjectId) {
            setActivePersonalMode(true)
          }
        }
      } catch {
        // fall back to general/ prefix in upload route
      }
    }

    // Uploads run in PARALLEL with a per-file timeout. Sequentially awaiting each
    // upload (and with no timeout) used to freeze the composer for seconds on big
    // iPhone screenshots, and a single stalled request left the UI stuck in the
    // "streaming" state forever. Promise.all keeps it snappy; AbortSignal.timeout
    // guarantees a hung upload fails fast and the catch resets the UI.
    let fileRefs: Array<{ bucket: string; path: string; mediaType: string }> = []
    if (pendingFiles.length > 0) {
      try {
        fileRefs = await Promise.all(pendingFiles.map(async (pf) => {
          // Claude-app flow: the file already pre-uploaded in the background when it
          // was attached, so reuse that result — send is then instant and never races
          // an unfinished upload. Only fall back to uploading here if it's missing.
          if (pf.remote?.path) return pf.remote
          const fd = new FormData()
          fd.append('file', pf.file)
          if (convIdForUpload) fd.append('conversationId', convIdForUpload)
          const res = await fetch('/api/assistant/upload', {
            method: 'POST',
            body: fd,
            signal: AbortSignal.timeout(60_000),
          })
          if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
          return res.json() as Promise<{ bucket: string; path: string; mediaType: string }>
        }))
      } catch (err) {
        toast.error(`ফাইল আপলোড ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
        setStreaming(false)
        setStreamStatus(null)
        return
      }
    }

    if (resumeOpts) {
      // Model-upgrade resume: no new user message — clear the approval card off the
      // paused reply and stream a fresh answer beneath it.
      setMessages((prev) => prev.map((m) => (m.modelSwitch ? { ...m, modelSwitch: undefined } : m)))
    } else {
      const userMsgId = nextId('user')
      const userMsg: ChatMessage = {
        id: userMsgId,
        role: 'user',
        text,
        // Carry the uploaded storage `path` (same order as the upload results) so the
        // live image can recover via a signed URL if its local blob is revoked before
        // the background poll swaps in the persisted message.
        files: pendingFiles.map((pf, idx) => ({
          previewUrl: pf.previewUrl,
          mediaType: pf.file.type,
          path: fileRefs[idx]?.path,
        })),
      }
      setMessages((prev) => [
        ...prev.map((m) => (m.askCard ? { ...m, askCard: undefined } : m)),
        userMsg,
      ])
    }

    const assistantMsgId = nextId('streaming')
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true, toolActivity: [] },
    ])

    let finalConvId = convIdForUpload ?? activeConvId
    let compactAfterStream: string | null = null
    let serverCompacted = false

    // A2 — VPS handoff: if the direct chat stream produces no event within ~15s
    // (function never responded), switch to running the turn on the worker queue
    // and tail it via /api/assistant/turn/:id/stream. Only possible for an
    // existing conversation (the enqueue route needs a conversationId).
    const LONG_TURN_SWITCH_MS = 15_000
    let goLong = false
    let gotAnyEvent = false
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined

    try {
      const body: Record<string, unknown> = {}
      if (resumeOpts) {
        // Resume the paused turn — no new message; rerun on the premium model
        // (approve) or the cheap fallback (decline).
        body.conversationId = finalConvId
        body.resume = resumeOpts
      } else {
        body.message = text
        if (finalConvId) body.conversationId = finalConvId
        else {
          if (pendingProjectIdRef.current) body.projectId = pendingProjectIdRef.current
          // New conversation: persist the owner's model choice ('auto' or a pinned model).
          body.modelId = activeModelId
        }
        if (fileRefs.length > 0) body.files = fileRefs
      }

      // Arm the going-long guard: aborts a hung request so we can re-run on the
      // worker. Disarmed as soon as the first SSE event arrives (direct path OK).
      // Resume turns are short (just model selection) — skip the worker fallback.
      if (finalConvId && !resumeOpts) {
        firstByteTimer = setTimeout(() => {
          if (!gotAnyEvent) {
            goLong = true
            abortRef.current?.abort()
          }
        }, LONG_TURN_SWITCH_MS)
      }

      const decoder = new TextDecoder()
      let gotStreamDone = false
      let toolInFlight = false

      const flushStreamBuffer = () => {
        const buf = streamBufferRef.current
        if (!buf || !buf.pending) {
          if (buf) buf.flushScheduled = false
          return
        }
        const chunk = buf.pending
        buf.pending = ''
        buf.flushScheduled = false
        setMessages((prev) => prev.map((m) =>
          m.id === buf.msgId ? { ...m, text: m.text + chunk } : m,
        ))
      }

      const flushThinkingBuffer = () => {
        const buf = thinkingBufferRef.current
        if (!buf || !buf.pending) {
          if (buf) buf.flushScheduled = false
          return
        }
        const chunk = buf.pending
        buf.pending = ''
        buf.flushScheduled = false
        setMessages((prev) => prev.map((m) =>
          m.id === buf.msgId
            ? { ...m, thinking: (m.thinking ?? '') + chunk, timeline: appendThinkToTimeline(m.timeline, chunk) }
            : m,
        ))
      }

      const applySseEvent = (evt: Record<string, unknown>) => {
        if (!gotAnyEvent) {
          gotAnyEvent = true
          if (firstByteTimer) clearTimeout(firstByteTimer)
        }
        if (evt.type === 'conversation_id') {
          finalConvId = evt.id as string
          setActiveConvId(finalConvId)
        } else if (evt.type === 'turn_id') {
          activeTurnIdRef.current = evt.id as string
        } else if (evt.type === 'personal_mode') {
          setActivePersonalMode(evt.active === true)
        } else if (evt.type === 'model_info') {
          const variant = (evt.variant as 'claude' | 'qwen' | 'deepseek' | 'default') ?? 'claude'
          setStreamVariant(variant)
          const label = typeof evt.label === 'string' ? evt.label : ''
          // Cheap models don't stream a thinking trace, so seed a model-specific
          // status line — that (plus the animation) is how the owner tells who is working.
          setStreamStatus(variant === 'claude' ? `🧠 ${label || 'Sonnet'} ভাবছে…` : `⚡ ${label || 'Worker'} উত্তর দিচ্ছে…`)
        } else if (evt.type === 'thinking_delta') {
          setStreamMode('thinking')
          setStreamStatus('🤔 ভাবছি…')
          if (!thinkingBufferRef.current || thinkingBufferRef.current.msgId !== assistantMsgId) {
            thinkingBufferRef.current = { msgId: assistantMsgId, pending: '', flushScheduled: false, startedAt: Date.now() }
          }
          thinkingBufferRef.current.pending += evt.delta as string
          if (!thinkingBufferRef.current.flushScheduled) {
            thinkingBufferRef.current.flushScheduled = true
            requestAnimationFrame(flushThinkingBuffer)
          }
        } else if (evt.type === 'text_delta') {
          // First reply token after thinking: stamp the elapsed thinking time so the
          // block collapses to "Thought for Ns".
          const tb = thinkingBufferRef.current
          if (tb && tb.msgId === assistantMsgId && tb.startedAt) {
            flushThinkingBuffer()
            const elapsed = Date.now() - tb.startedAt
            tb.startedAt = 0
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId && m.thinkingMs == null ? { ...m, thinkingMs: elapsed } : m,
            ))
          }
          if (!toolInFlight) {
            setStreamMode('writing')
            setStreamStatus('✍️ উত্তর লিখছি…')
          }
          if (!streamBufferRef.current || streamBufferRef.current.msgId !== assistantMsgId) {
            streamBufferRef.current = { msgId: assistantMsgId, pending: '', flushScheduled: false }
          }
          streamBufferRef.current.pending += evt.delta as string
          if (!streamBufferRef.current.flushScheduled) {
            streamBufferRef.current.flushScheduled = true
            requestAnimationFrame(flushStreamBuffer)
          }
        } else if (evt.type === 'tool_start') {
          toolInFlight = true
          const d = toolDisplay(String(evt.name))
          setStreamMode('searching')
          setStreamStatus(`${d.icon} ${d.label}`)
          // Upsert by id: tool_start fires twice (once at stream start, once with
          // the parsed input) — merge so the chip gains its real target, no dupes.
          setMessages((prev) => prev.map((m) => {
            if (m.id !== assistantMsgId) return m
            const timeline = pushOrUpdateTool(m.timeline, evt.id as string, evt.name as string, evt.input)
            const existing = m.toolActivity ?? []
            const idx = existing.findIndex((t) => t.id === evt.id)
            if (idx >= 0) {
              const next = existing.slice()
              next[idx] = { ...next[idx], input: evt.input ?? next[idx].input }
              return { ...m, toolActivity: next, timeline }
            }
            return { ...m, toolActivity: [...existing, { id: evt.id as string, name: evt.name as string, done: false, input: evt.input }], timeline }
          }))
        } else if (evt.type === 'tool_end') {
          toolInFlight = false
          setStreamMode('writing')
          setStreamStatus('✍️ উত্তর লিখছি…')
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  toolActivity: (m.toolActivity ?? []).map((t) =>
                    t.id === evt.id
                      ? {
                          ...t,
                          done: true,
                          success: evt.success as boolean,
                          result: typeof evt.resultPreview === 'string' ? evt.resultPreview : t.result,
                        }
                      : t
                  ),
                  timeline: finalizeTool(
                    m.timeline,
                    evt.id as string,
                    evt.success as boolean,
                    typeof evt.resultPreview === 'string' ? evt.resultPreview : undefined,
                  ),
                }
              : m
          ))
        } else if (evt.type === 'subagent_start') {
          setStreamMode('searching')
          setStreamStatus(`🤝 ${evt.roleLabel as string} কাজ করছে…`)
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  delegations: [
                    ...(m.delegations ?? []),
                    {
                      id: evt.id as string,
                      role: evt.role as string,
                      roleLabel: evt.roleLabel as string,
                      task: evt.task as string,
                      done: false,
                    },
                  ],
                }
              : m
          ))
        } else if (evt.type === 'subagent_end') {
          setStreamMode('writing')
          setStreamStatus('✍️ উত্তর লিখছি…')
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  delegations: (m.delegations ?? []).map((d) =>
                    d.id === evt.id
                      ? {
                          ...d,
                          done: true,
                          success: evt.success as boolean,
                          summary: evt.summary as string | undefined,
                          toolsUsed: evt.toolsUsed as string[] | undefined,
                        }
                      : d
                  ),
                }
              : m
          ))
        } else if (evt.type === 'confirm_card') {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  pendingAction: {
                    id: evt.pendingActionId as string,
                    summary: evt.summary as string,
                    costEstimate: evt.costEstimate as number | undefined,
                    actionType: evt.actionType as string | undefined,
                    entryCount: evt.entryCount as number | undefined,
                    isFinance: evt.isFinance as boolean | undefined,
                    isBatch: evt.isBatch as boolean | undefined,
                  },
                }
              : m
          ))
        } else if (evt.type === 'ask_card') {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  askCard: {
                    id: evt.askCardId as string,
                    question: evt.question as string,
                    options: evt.options as string[],
                  },
                }
              : m
          ))
        } else if (evt.type === 'verification_retry') {
          // The honesty guard caught a completion claim that wasn't backed by a
          // real tool call this turn, so the draft is being rewritten. Make this
          // understandable instead of a confusing blank-then-reappear.
          setStreamMode('searching')
          setStreamStatus('🔁 নিজের উত্তর যাচাই করে ঠিক করে নিচ্ছি…')
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, text: '', toolActivity: [], selfCorrected: true }
              : m
          ))
        } else if (evt.type === 'done') {
          gotStreamDone = true
          setStreamStatus(null)
          setStreamMode('writing')
          flushThinkingBuffer()
          flushStreamBuffer()
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  id: evt.messageId as string,
                  streaming: false,
                  // Keep askCard: the agent asked a question and is waiting for
                  // the owner to pick an option. Clearing it here made the card
                  // vanish the instant streaming finished. It's cleared instead
                  // when the owner sends the next message (see handleSend).
                  tokensIn: evt.tokensIn as number,
                  tokensOut: evt.tokensOut as number,
                  cacheCreation: evt.cacheCreation as number,
                  cacheRead: evt.cacheRead as number,
                  costUsd: evt.costUsd as number,
                }
              : m
          ))
        } else if (evt.type === 'model_switch_required') {
          // The turn paused for owner approval before upgrading to a premium model.
          // Attach the approval card to this reply; mark the stream done so the
          // post-stream resync doesn't wipe the (unsaved) streaming bubble.
          gotStreamDone = true
          setStreamStatus(null)
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  streaming: false,
                  modelSwitch: {
                    toLabel: (evt.toLabel as string) ?? 'Sonnet',
                    fromLabel: (evt.fromLabel as string) ?? 'Worker',
                    fallbackModelId: (evt.fallbackModelId as string) ?? '',
                  },
                }
              : m
          ))
        } else if (evt.type === 'compact_suggested') {
          compactAfterStream = evt.conversationId as string
        } else if (evt.type === 'conversation_compacted') {
          finalConvId = evt.conversationId as string
          setActiveConvId(finalConvId)
          compactAfterStream = null
          serverCompacted = true
          setCompacting(true)
        } else if (evt.type === 'error') {
          gotStreamDone = true
          flushThinkingBuffer()
          flushStreamBuffer()
          const errText = evt.message as string
          let banglaMsg = errText
          if (errText.includes('কোটা') || /quota|credit|billing/i.test(errText)) {
            banglaMsg = 'Anthropic API কোটা শেষ — মালিককে জানানো হয়েছে। পরে আবার চেষ্টা করুন।'
          } else if (errText.includes('ANTHROPIC_API_KEY') || errText.includes('api_key')) {
            banglaMsg = 'API Key সেট করা নেই। Vercel-এ ANTHROPIC_API_KEY যোগ করুন।'
          } else if (errText.includes('overloaded')) {
            banglaMsg = 'সার্ভার ব্যস্ত। কিছুক্ষণ পরে আবার চেষ্টা করুন।'
          } else if (/rate_limited|অনেক দ্রুত/i.test(errText)) {
            banglaMsg = 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।'
          }
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, streaming: false, text: `⚠️ ${banglaMsg}` }
              : m
          ))
        }
      }

      const consumeSseReader = async (rdr: ReadableStreamDefaultReader<Uint8Array>) => {
        let lbuf = ''
        while (true) {
          const { done, value } = await rdr.read()
          if (value) lbuf += decoder.decode(value, { stream: true })

          const { remaining, events } = parseSseChunks(lbuf)
          lbuf = remaining
          for (const evt of events) applySseEvent(evt)

          if (done) {
            lbuf += decoder.decode()
            const trailing = parseTrailingSseEvent(lbuf)
            if (trailing) applySseEvent(trailing)
            break
          }
        }
      }

      // A2 fallback: re-run the turn on the VPS worker and tail its event stream.
      // Used when the direct chat function never produced an event within 15s.
      const runWorkerFallback = async () => {
        if (!finalConvId) return false
        setStreamStatus('দীর্ঘ কাজ — সার্ভারে চালানো হচ্ছে…')
        // The direct turn keeps running server-side (it's decoupled from the
        // client connection); cancel it if we know its id so it can't also persist
        // a reply. When no event arrived its turn_id is unknown, but in that case
        // the direct function never started the turn, so there's nothing to clobber.
        const directTurnId = activeTurnIdRef.current
        if (directTurnId) {
          await fetch(`/api/assistant/turn/${directTurnId}/cancel`, { method: 'POST' }).catch(() => {})
        }
        const enqRes = await fetch('/api/assistant/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: finalConvId,
            message: text,
            files: fileRefs.length > 0 ? fileRefs : undefined,
          }),
        })
        if (!enqRes.ok) return false
        const { turnId: workerTurnId } = await enqRes.json() as { turnId: string | null }
        if (!workerTurnId) return false
        activeTurnIdRef.current = workerTurnId
        const streamCtrl = new AbortController()
        abortRef.current = streamCtrl
        const sres = await fetch(`/api/assistant/turn/${workerTurnId}/stream`, { signal: streamCtrl.signal })
        if (!sres.ok || !sres.body) return false
        await consumeSseReader(sres.body.getReader())
        return true
      }

      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        })

        if (!res.ok || !res.body) {
          let errMsg = `HTTP ${res.status}`
          if (res.status === 401) errMsg = 'অননুমোদিত'
          else errMsg = await readAssistantError(res, errMsg)
          throw new Error(errMsg)
        }

        await consumeSseReader(res.body.getReader())
      } catch (innerErr) {
        // First-byte timeout tripped the guard → run it on the worker instead.
        if ((innerErr as Error).name === 'AbortError' && goLong) {
          await runWorkerFallback()
        } else {
          throw innerErr
        }
      }
      // Final flush in case stream ended without 'done' event
      flushThinkingBuffer()
      flushStreamBuffer()
      streamBufferRef.current = null
      thinkingBufferRef.current = null

      if (finalConvId && !gotStreamDone) {
        try {
          const msgRes = await fetch(`/api/assistant/conversations/${finalConvId}/messages`)
          if (msgRes.ok) {
            const rows: MessageRow[] = await msgRes.json()
            setMessages(mapMessageRows(rows))
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      const buf = streamBufferRef.current
      if (buf) {
        const pending = buf.pending
        streamBufferRef.current = null
        if (pending) {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId ? { ...m, text: m.text + pending } : m,
          ))
        }
      }
      const tbuf = thinkingBufferRef.current
      if (tbuf) {
        const pending = tbuf.pending
        thinkingBufferRef.current = null
        if (pending) {
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId ? { ...m, thinking: (m.thinking ?? '') + pending } : m,
          ))
        }
      }
      // A stream cut AFTER the turn started is NOT a failure: the server turn is
      // decoupled from this connection and runs to completion, saving the full
      // reply. This happens on a plain AbortError (iOS suspended the backgrounded
      // WebView / the owner hit stop) AND on a raw network drop (e.g. iOS "Load
      // failed", which is a TypeError, not an AbortError) — the latter used to
      // strand a scary "⚠️ failed" even though the answer was safely saved and a
      // refresh would show it. Recover both the same way: freeze in-flight chips
      // and re-sync from the durable turn status. Only a genuine pre-turn error
      // (no turn ever started — bad key, 401, enqueue failed) is surfaced.
      const streamCutAfterStart = (err as Error).name === 'AbortError' || Boolean(activeTurnIdRef.current)
      if (streamCutAfterStart) {
        // "stop hole animation taw stop e thake" — halt spinners.
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                streaming: false,
                toolActivity: (m.toolActivity ?? []).map((t) =>
                  t.done ? t : { ...t, done: true, stopped: true },
                ),
                delegations: (m.delegations ?? []).map((d) =>
                  d.done ? d : { ...d, done: true, stopped: true },
                ),
              }
            : m
        ))
        void resyncActiveConversation(finalConvId)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, streaming: false, text: `⚠️ ${msg}` } : m
        ))
      }
    } finally {
      if (firstByteTimer) clearTimeout(firstByteTimer)
      setStreaming(false)
      setStreamStatus(null)
      abortRef.current = null
      activeTurnIdRef.current = null
      pendingFiles.forEach((pf) => URL.revokeObjectURL(pf.previewUrl))
      // The turn may have created/completed/cancelled a todo via tools — refresh
      // the dock now so the list stays in sync without the 30s poll lag.
      notifyTodosChanged()

      if (compactAfterStream) {
        void runCompaction(compactAfterStream)
      } else if (serverCompacted) {
        await new Promise((r) => setTimeout(r, 1200))
        setMessages([])
        setArtifacts([])
        setCompacting(false)
      }
    }
  }, [streaming, activeConvId, activeModelId, resyncActiveConversation])

  const handleVoiceMessage = useCallback(async (text: string): Promise<string | null> => {
    const body: Record<string, unknown> = { message: text, voice: true }
    if (activeConvId) body.conversationId = activeConvId
    else body.modelId = activeModelId // new conv: persist the owner's model choice
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let reply = ''
    let convId = activeConvId
    while (true) {
      const { done, value } = await reader.read()
      if (value) buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const chunk of parts) {
        if (!chunk.startsWith('data: ')) continue
        try {
          const evt = JSON.parse(chunk.slice(6)) as Record<string, unknown>
          if (evt.type === 'conversation_id') {
            convId = evt.id as string
            setActiveConvId(convId)
          } else if (evt.type === 'text_delta') {
            reply += evt.delta as string
          }
        } catch { /* skip */ }
      }
      if (done) break
    }
    return reply || null
  }, [activeConvId, activeModelId])

  async function stopGeneration() {
    const turnId = activeTurnIdRef.current
    // No durable turn id yet (turn hasn't registered) → fall back to the old
    // client-only abort; the server turn will still finish + persist in the bg.
    if (!turnId) {
      abortRef.current?.abort()
      return
    }
    // The turn keeps running server-side after the app backgrounds, so "stop" must
    // actually cancel it on the server (it wastes tokens otherwise). Confirm first —
    // the owner may prefer to let it finish in the background instead.
    const ok = await confirmDialog({
      title: 'কাজ থামাবেন?',
      message: 'server-side কাজ থামালে এ পর্যন্ত খরচ হওয়া টোকেন wasted হবে। চাইলে ব্যাকগ্রাউন্ডে শেষ হতে দিন।',
      confirmLabel: 'থামান',
      cancelLabel: 'চলতে দিন',
      danger: true,
    })
    if (!ok) return
    try {
      await fetch(`/api/assistant/turn/${turnId}/cancel`, { method: 'POST' })
    } catch { /* best-effort — the local abort below still stops the UI */ }
    abortRef.current?.abort()
  }

  async function runCompaction(convId: string) {
    setCompacting(true)
    try {
      const res = await fetch('/api/assistant/internal/compact-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId }),
      })
      if (res.ok) {
        const data = await res.json() as { newConversationId: string }
        await new Promise((r) => setTimeout(r, 2400))
        setActiveConvId(data.newConversationId)
        setMessages([])
        setArtifacts([])
      }
    } catch { /* non-critical */ } finally {
      setCompacting(false)
    }
  }

  function startResultPolling(convId: string) {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    let attempts = 0
    let sawRunning = false
    const loaderId = nextId('streaming')
    const loader = { id: loaderId, role: 'assistant' as const, text: '', streaming: true }

    // Show the working animation the INSTANT the owner approves, so it's visually
    // obvious the agent picked the task back up. The continuation runs server-side
    // (on the worker), so there's no client stream to drive the usual indicator —
    // we pin a streaming placeholder at the bottom and keep it until the turn ends.
    setStreamMode('thinking')
    setStreamVariant('claude')
    setMessages((prev) => [...prev.filter((m) => !m.streaming), loader])

    async function poll() {
      let running = false
      try {
        const sres = await fetch(`/api/assistant/conversations/${convId}/turn-status`)
        if (sres.ok) running = ((await sres.json()) as { status?: string }).status === 'running'
      } catch {
        running = sawRunning // transient status error → keep the loader as-is
      }
      if (running) sawRunning = true

      try {
        const res = await fetch(`/api/assistant/conversations/${convId}/messages`)
        if (res.ok) {
          const mapped = mapMessageRows(await res.json())
          // Keep the loader pinned below whatever messages have arrived until the
          // continuation turn has been SEEN running and then finished — so the
          // approval note shows while the agent is still working, then the spinner
          // drops as the continuation reply lands. (!sawRunning guards the brief
          // race before the freshly-created turn registers as running.)
          setMessages(running || !sawRunning ? [...mapped, loader] : mapped)
        }
      } catch { /* ignore a transient fetch error */ }

      if (sawRunning && !running) {
        clearInterval(pollTimerRef.current!)
        pollTimerRef.current = null
      }
    }

    void poll()
    pollTimerRef.current = setInterval(() => {
      attempts++
      if (attempts >= 30) {
        // ~2 min safety cap — stop the spinner even if the worker never picked it up.
        clearInterval(pollTimerRef.current!)
        pollTimerRef.current = null
        setMessages((prev) => prev.filter((m) => !m.streaming))
        return
      }
      void poll()
    }, 4000)
  }

  async function saveArtifact(art: Omit<Artifact, 'id' | 'createdAt'>) {
    const res = await fetch('/api/assistant/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(art),
    })
    if (res.ok) {
      const saved: Artifact = await res.json()
      setArtifacts((prev) => [...prev, saved])
      toast.success('আর্টিফ্যাক্ট সংরক্ষিত')
    }
  }

  return (
    <div className="agent-chat-root flex h-full min-h-0 overflow-hidden bg-transparent select-text">
      {/* Sidebar */}
      <AgentSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeConvId={activeConvId}
        onSelectConv={loadConversation}
        onNewConv={newConversation}
        onEnterPersonal={enterPersonalMode}
        personalActive={activePersonalMode && !activeConvId}
        onConvUpdated={() => {}}
        isMobile={isMobile}
      />

      {/* Main area — safe-top reserves the iOS status-bar strip so neither the
          green "অফিস লাইভ" banner nor the header renders under the clock/battery. */}
      {/* min-w-0 is REQUIRED: this is a flex-1 child of the flex-row chat root.
          Without it the flex item keeps min-width:auto (its content width,
          max-w-2xl = 672px) and refuses to shrink to a narrow phone (≈440px),
          so it overflows and WKWebView widens the layout viewport → the whole
          page shifts/cuts on iPhone. (Diagnosed on-device via the overflow probe:
          <div.safe-top.flex.min-h-0.flex-1> w=672 vw=440.) */}
      <div className="safe-top flex min-h-0 min-w-0 flex-1 flex-col">
        {dayShift?.conversationId && dayShift.active && activeConvId !== dayShift.conversationId && (
          <button
            type="button"
            onClick={() => void loadConversation({
              id: dayShift.conversationId!,
              title: dayShift.title,
              projectId: null,
              source: 'day_shift',
              archived: false,
              updatedAt: new Date().toISOString(),
            })}
            className="safe-x shrink-0 border-b border-emerald-200/60 bg-emerald-50/90 px-4 py-2 text-left text-[11px] font-medium text-emerald-800 hover:bg-emerald-100/90 transition-colors"
          >
            🏢 <span className="font-semibold">Agent অফিস লাইভ</span> — কাজ চলছে। এখানে চাপুন live দেখতে (Cursor-style updates)
          </button>
        )}
        {/* Plan-Drive attention strip — surfaces decisions/approvals waiting on the
            owner from ANY screen, so urgent autonomous-plan blocks never hide. Opens
            the most urgent plan's conversation. */}
        {(() => {
          const attention = (planDrive?.drives ?? []).filter(
            (d) => d.phase === 'needs-decision' || d.phase === 'waiting-approval',
          )
          if (attention.length === 0) return null
          const top = attention[0]
          const decisions = attention.filter((d) => d.phase === 'needs-decision').length
          return (
            <button
              type="button"
              onClick={() => top.conversationId && void loadConversation({
                id: top.conversationId, title: null, projectId: null, archived: false, updatedAt: new Date().toISOString(),
              })}
              className={cn(
                'safe-x shrink-0 border-b px-4 py-2 text-left text-[11px] font-medium transition-colors',
                decisions > 0
                  ? 'border-red-200/60 bg-red-50/90 text-red-800 hover:bg-red-100/90'
                  : 'border-amber-200/60 bg-amber-50/90 text-amber-800 hover:bg-amber-100/90',
              )}
            >
              {decisions > 0 ? '🛑' : '✋'}{' '}
              <span className="font-semibold">
                {attention.length}টি কাজ আপনার {decisions > 0 ? 'সিদ্ধান্তের' : 'অনুমোদনের'} অপেক্ষায়
              </span>{' '}
              — “{top.goal}”। দেখতে চাপুন →
            </button>
          )
        })()}
        {/* Header — floating translucent pods (FOUND-1B "Claude-app feel").
            Top inset now lives on the parent column (safe-top), so the header
            keeps only safe-x to avoid double-padding below the status bar. */}
        <header className="safe-x relative z-20 flex shrink-0 items-center gap-2 bg-transparent px-3 py-2 md:px-4">
          {/* Left — ☰ menu in a circular frosted pod */}
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="alma-frost alma-pod flex h-10 w-10 shrink-0 items-center justify-center text-muted transition-all hover:text-cream active:scale-95 md:h-9 md:w-9"
            aria-label="সাইডবার"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>

          {/* Center — title + personal badge */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
            <span className="alma-ai-wordmark truncate text-[15px] font-bold tracking-wide">ALMA AI</span>
            {activePersonalMode && (
              <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                ব্যক্তিগত
              </span>
            )}
            {dayShift?.active && activeConvId === dayShift.conversationId && (
              <span className="shrink-0 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 animate-pulse">
                অফিস লাইভ
              </span>
            )}
          </div>

          {/* Right — frosted pod group: refresh · new chat · (desktop: ERP · artifacts) */}
          <div className="alma-frost alma-pod flex shrink-0 items-center gap-0.5 px-1">
            <button
              type="button"
              onClick={() => {
                if (activeConvId) {
                  void loadConversation({ id: activeConvId, title: null, projectId: activeConvProjectId, archived: false, updatedAt: '' })
                } else {
                  window.location.reload()
                }
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-all hover:bg-white/[0.05] hover:text-cream active:scale-95"
              aria-label="রিফ্রেশ"
              title="রিফ্রেশ"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            </button>
            <button
              type="button"
              onClick={() => newConversation()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-all hover:bg-white/[0.05] hover:text-cream active:scale-95"
              aria-label="নতুন চ্যাট"
              title="নতুন কথোপকথন"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>

            {/* Desktop-only nav links */}
            <Link
              href="/"
              className="hidden h-8 items-center rounded-full px-2.5 text-[11px] text-muted transition-all hover:bg-white/[0.05] hover:text-cream md:flex"
            >
              ERP
            </Link>
            {artifacts.length > 0 && (
              <button
                type="button"
                onClick={() => setArtifactsOpen((v) => !v)}
                className="hidden h-8 items-center gap-1 rounded-full px-2.5 text-[11px] text-muted transition-all hover:bg-white/[0.05] hover:text-cream md:flex"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16.4l-6.4 4.8L8 14 2 9.2h7.6z"/></svg>
                {artifacts.length}
              </button>
            )}
          </div>
        </header>

        {activePersonalMode && (
          <div className="shrink-0 border-b border-emerald-200/50 bg-emerald-50/60 px-4 py-1.5 text-center text-[11px] text-emerald-700 backdrop-blur-md">
            ব্যক্তিগত মোড — শুধু ব্যক্তিগত ও পারিবারিক বিষয়
          </div>
        )}

        {/* Thread + artifacts */}
        <div className="relative flex flex-1 overflow-hidden">
          {convLoading ? (
            <div className="flex flex-1 overflow-y-auto">
              <AgentConversationSkeleton />
            </div>
          ) : convLoadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-red-500/90">{convLoadError}</p>
              <button
                onClick={() => activeConvId && loadConversation({ id: activeConvId, title: null, projectId: null, archived: false, updatedAt: '' })}
                className="rounded-xl border border-border px-4 py-2 text-xs text-muted transition-all hover:bg-white/[0.03] hover:text-cream"
              >
                আবার চেষ্টা
              </button>
            </div>
          ) : (
          <AgentThread
            messages={messages}
            onArtifactSave={saveArtifact}
            conversationId={activeConvId}
            onArtifactOpen={() => setArtifactsOpen(true)}
            onActionApproved={() => { if (activeConvId) startResultPolling(activeConvId) }}
            onQuickSend={(text) => { if (!streaming) void handleSend(text, []) }}
            onModelSwitchResolve={(opts) => { if (!streaming) void handleSend('', [], opts) }}
            onStartVoiceSession={() => setVoiceOpen(true)}
            streamMode={streamMode}
            streamVariant={streamVariant}
            compacting={compacting}
            planDrive={planDrive}
            onPlanDriveAction={handlePlanDriveAction}
            onPlanDriveOpen={(cid) => void loadConversation({
              id: cid, title: null, projectId: null, archived: false, updatedAt: new Date().toISOString(),
            })}
          />
          )}
          <AgentArtifactsPanel
            artifacts={artifacts}
            open={artifactsOpen}
            onClose={() => setArtifactsOpen(false)}
            isMobile={isMobile}
          />
        </div>

        {/* Composer */}
        <AgentComposer
          onSend={handleSend}
          disabled={false}
          onStop={stopGeneration}
          streaming={streaming}
          reconnecting={reconnecting}
          conversationId={activeConvId}
          isMobile={isMobile}
          activeModelId={activeModelId}
          onModelChange={setActiveModelId}
          onVoiceStart={() => setVoiceOpen(true)}
          seedText={composerSeed}
        />
      </div>

      {/* Voice Session — fullscreen overlay, outside normal flow */}
      <VoiceSession
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onSendMessage={handleVoiceMessage}
      />
    </div>
  )
}
