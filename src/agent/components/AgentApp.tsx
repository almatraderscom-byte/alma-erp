'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import AgentSidebar, { type Conversation } from './AgentSidebar'
import AgentThread, { type ChatMessage } from './AgentThread'
import AgentComposer, { type PendingFile } from './AgentComposer'
import AgentArtifactsPanel, { type Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import { useMediaQuery } from '@/agent/hooks/useMediaQuery'
import { AgentConversationSkeleton } from '@/agent/components/AgentThinkingIndicator'
import { toolDisplay } from '@/agent/lib/tool-labels'

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
  content: Array<{ type: string; text?: string; bucket?: string; path?: string; mediaType?: string }>
  tokensIn: number | null
  tokensOut: number | null
  costUsd: string | null
}

function mapMessageRows(rows: MessageRow[]): ChatMessage[] {
  return rows.map((r) => {
    const textBlocks = r.content.filter((b) => b.type === 'text')
    const fileBlocks = r.content.filter((b) => b.type === 'file_ref')
    return {
      id: r.id,
      role: r.role as 'user' | 'assistant',
      text: textBlocks.map((b) => b.text ?? '').join(''),
      files: fileBlocks.map((b) => ({
        previewUrl: '',
        mediaType: b.mediaType ?? 'image/jpeg',
      })),
      tokensIn: r.tokensIn ?? undefined,
      tokensOut: r.tokensOut ?? undefined,
      costUsd: r.costUsd != null ? parseFloat(r.costUsd) : undefined,
    }
  })
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
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamMode, setStreamMode] = useState<'fetching' | 'writing'>('writing')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [convLoading, setConvLoading] = useState(false)
  const [convLoadError, setConvLoadError] = useState<string | null>(null)
  const [personalProjectId, setPersonalProjectId] = useState<string | null>(null)
  const [activePersonalMode, setActivePersonalMode] = useState(false)
  const [activeConvProjectId, setActiveConvProjectId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Close sidebar by default on mobile
  useEffect(() => { setSidebarOpen(!isMobile) }, [isMobile])

  // Surface real server config issues (not the old misleading client guess).
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
    if (personalProjectId && activeConvProjectId) {
      setActivePersonalMode(activeConvProjectId === personalProjectId)
    }
  }, [personalProjectId, activeConvProjectId])

  // Load messages when conversation changes
  async function loadConversation(conv: Conversation) {
    setActiveConvId(conv.id)
    setActiveConvProjectId(conv.projectId)
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
  }

  function newConversation(projectId?: string) {
    setActiveConvId(null)
    setMessages([])
    setArtifacts([])
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

  const handleSend = useCallback(async (text: string, pendingFiles: PendingFile[]) => {
    if (streaming) return
    abortRef.current = new AbortController()
    setStreaming(true)
    setStreamStatus('প্রসেস করা হচ্ছে…')

    // Ensure conversation exists before upload so files land under <convId>/ not general/.
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

    // Upload files first, collect file refs.
    const fileRefs: Array<{ bucket: string; path: string; mediaType: string }> = []
    for (const pf of pendingFiles) {
      try {
        const fd = new FormData()
        fd.append('file', pf.file)
        if (convIdForUpload) fd.append('conversationId', convIdForUpload)
        const res = await fetch('/api/assistant/upload', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
        fileRefs.push(await res.json())
      } catch (err) {
        toast.error(`ফাইল আপলোড ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
        setStreaming(false)
        setStreamStatus(null)
        return
      }
    }

    // Optimistic user message
    const userMsgId = nextId('user')
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text,
      files: pendingFiles.map((pf) => ({ previewUrl: pf.previewUrl, mediaType: pf.file.type })),
    }
    setMessages((prev) => [
      ...prev.map((m) => (m.askCard ? { ...m, askCard: undefined } : m)),
      userMsg,
    ])

    // Streaming assistant placeholder
    const assistantMsgId = nextId('streaming')
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true, toolActivity: [] },
    ])

    let finalConvId = convIdForUpload ?? activeConvId

    try {
      const body: Record<string, unknown> = { message: text }
      if (finalConvId) body.conversationId = finalConvId
      else if (pendingProjectIdRef.current) body.projectId = pendingProjectIdRef.current
      if (fileRefs.length > 0) body.files = fileRefs

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

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let gotStreamDone = false
      let toolInFlight = false

      const applySseEvent = (evt: Record<string, unknown>) => {
        if (evt.type === 'conversation_id') {
          finalConvId = evt.id as string
          setActiveConvId(finalConvId)
        } else if (evt.type === 'personal_mode') {
          setActivePersonalMode(evt.active === true)
        } else if (evt.type === 'text_delta') {
          if (!toolInFlight) {
            setStreamMode('writing')
            setStreamStatus('✍️ উত্তর লিখছি…')
          }
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId ? { ...m, text: m.text + (evt.delta as string) } : m
          ))
        } else if (evt.type === 'tool_start') {
          toolInFlight = true
          const d = toolDisplay(String(evt.name))
          setStreamMode('fetching')
          setStreamStatus(`${d.icon} ${d.label}`)
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, toolActivity: [...(m.toolActivity ?? []), { id: evt.id as string, name: evt.name as string, done: false }] }
              : m
          ))
        } else if (evt.type === 'tool_end') {
          toolInFlight = false
          setStreamMode('writing')
          setStreamStatus('✍️ উত্তর লিখছি…')
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  toolActivity: (m.toolActivity ?? []).map((t) =>
                    t.id === evt.id ? { ...t, done: true, success: evt.success as boolean } : t
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
        } else if (evt.type === 'done') {
          gotStreamDone = true
          setStreamStatus(null)
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  id: evt.messageId as string,
                  streaming: false,
                  askCard: undefined,
                  tokensIn: evt.tokensIn as number,
                  tokensOut: evt.tokensOut as number,
                  costUsd: evt.costUsd as number,
                }
              : m
          ))
        } else if (evt.type === 'error') {
          gotStreamDone = true
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

      while (true) {
        const { done, value } = await reader.read()
        if (value) buf += decoder.decode(value, { stream: true })

        const { remaining, events } = parseSseChunks(buf)
        buf = remaining
        for (const evt of events) applySseEvent(evt)

        if (done) {
          buf += decoder.decode()
          const trailing = parseTrailingSseEvent(buf)
          if (trailing) applySseEvent(trailing)
          break
        }
      }

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
      if ((err as Error).name === 'AbortError') {
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, streaming: false, text: m.text || '(বাতিল করা হয়েছে)' } : m
        ))
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, streaming: false, text: `⚠️ ${msg}` } : m
        ))
      }
    } finally {
      setStreaming(false)
      setStreamStatus(null)
      abortRef.current = null
      // Clean up file preview URLs
      pendingFiles.forEach((pf) => URL.revokeObjectURL(pf.previewUrl))
    }
  }, [streaming, activeConvId])

  function stopGeneration() {
    abortRef.current?.abort()
  }

  // Poll for new messages after a confirm-card action is approved.
  // Checks immediately (catches fb_post inline result) then every 8s for up to 96s
  // (covers the worker's 30s poll cycle + image generation time).
  function startResultPolling(convId: string) {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    let attempts = 0
    const initialCount = messages.length

    async function fetchAndUpdate() {
      try {
        const res = await fetch(`/api/assistant/conversations/${convId}/messages`)
        if (!res.ok) return
        const rows: MessageRow[] = await res.json()

        if (rows.length > initialCount) {
          setMessages(mapMessageRows(rows))
          clearInterval(pollTimerRef.current!)
          pollTimerRef.current = null
        }
      } catch { /* ignore */ }
    }

    void fetchAndUpdate() // immediate check
    pollTimerRef.current = setInterval(() => {
      attempts++
      if (attempts >= 12) { // ~96s max
        clearInterval(pollTimerRef.current!)
        pollTimerRef.current = null
        return
      }
      void fetchAndUpdate()
    }, 8000)
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
    <div className="flex h-full min-h-0 overflow-hidden bg-black">
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

      {/* Main area */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="safe-top safe-x flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-black/80 px-3 py-2 backdrop-blur-md md:gap-3 md:px-4 md:py-2.5">
          <Link
            href="/"
            className="flex h-11 shrink-0 items-center justify-center gap-1 rounded-xl border border-white/[0.08] px-2.5 text-[11px] font-medium text-muted transition-colors hover:border-gold-dim/30 hover:text-cream active:scale-[0.98] md:h-9 md:px-3"
            title="ALMA ERP হোম"
            aria-label="ALMA ERP হোমে ফিরে যান"
          >
            <span aria-hidden>←</span>
            <span className="hidden sm:inline">হোম</span>
          </Link>
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg text-muted transition-colors hover:bg-white/[0.04] hover:text-cream active:scale-[0.98] md:h-9 md:w-9"
            title="সাইডবার"
            aria-label="সাইডবার খুলুন"
          >
            ☰
          </button>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-cream md:text-sm">
            {activePersonalMode ? '🤲 ব্যক্তিগত মোড' : (activeConvId ? 'কথোপকথন' : 'নতুন কথোপকথন')}
          </span>
          {activePersonalMode && (
            <span className="hidden shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-200 sm:inline">
              ব্যক্তিগত
            </span>
          )}
          <a
            href="/agent/costs"
            className="flex h-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] px-3 text-[11px] font-medium text-muted transition-colors hover:border-gold-dim/30 hover:text-gold-lt active:scale-[0.98] md:px-2.5"
          >
            খরচ
          </a>
          <a
            href="/agent/staff-monitor"
            className="flex h-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] px-3 text-[11px] font-medium text-muted transition-colors hover:border-gold-dim/30 hover:text-gold-lt active:scale-[0.98] md:px-2.5"
          >
            স্টাফ
          </a>
          {artifacts.length > 0 && (
            <button
              type="button"
              onClick={() => setArtifactsOpen((v) => !v)}
              className="hidden h-9 shrink-0 items-center rounded-xl border border-white/[0.08] px-3 text-[11px] font-semibold text-muted-hi transition-colors hover:border-gold-dim/30 hover:text-cream sm:flex"
            >
              ✦ {artifacts.length}
            </button>
          )}
        </header>

        {activePersonalMode && (
          <div className="shrink-0 border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-2 text-center text-[11px] text-emerald-200/90">
            আপনি এখন ব্যক্তিগত মোডে আছেন — শুধু ব্যক্তিগত ও পারিবারিক বিষয়
          </div>
        )}

        {/* Thread + artifacts */}
        <div className="flex flex-1 overflow-hidden">
          {convLoading ? (
            <div className="flex flex-1 overflow-y-auto">
              <AgentConversationSkeleton />
            </div>
          ) : convLoadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-red-400">⚠️ {convLoadError}</p>
              <button
                onClick={() => activeConvId && loadConversation({ id: activeConvId, title: null, projectId: null, archived: false, updatedAt: '' })}
                className="rounded-xl border border-border px-4 py-2 text-xs text-muted-hi hover:text-cream"
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
            streamStatus={streamStatus}
            streamMode={streamMode}
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
          conversationId={activeConvId}
          isMobile={isMobile}
        />
      </div>
    </div>
  )
}
