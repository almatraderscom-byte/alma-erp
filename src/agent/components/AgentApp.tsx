'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import AgentSidebar, { type Conversation } from './AgentSidebar'
import AgentThread, { type ChatMessage } from './AgentThread'
import AgentComposer, { type PendingFile } from './AgentComposer'
import AgentArtifactsPanel, { type Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import { useMediaQuery } from '@/agent/hooks/useMediaQuery'

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

export default function AgentApp({ userName: _userName }: AgentAppProps) {
  const isMobile = useMediaQuery('(max-width: 767px)')

  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [artifactsOpen, setArtifactsOpen] = useState(false)

  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])

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

  // Load messages when conversation changes
  async function loadConversation(conv: Conversation) {
    setActiveConvId(conv.id)
    setMessages([])
    setArtifacts([])

    const [msgRes, artRes] = await Promise.all([
      fetch(`/api/assistant/conversations/${conv.id}/messages`),
      fetch(`/api/assistant/conversations/${conv.id}/artifacts`),
    ])

    if (msgRes.ok) {
      const rows: Array<{
        id: string; role: string
        content: Array<{ type: string; text?: string; bucket?: string; path?: string; mediaType?: string }>
        tokensIn: number | null; tokensOut: number | null; costUsd: string | null
      }> = await msgRes.json()

      setMessages(rows.map((r) => {
        const textBlocks = r.content.filter((b) => b.type === 'text')
        const fileBlocks = r.content.filter((b) => b.type === 'file_ref')
        return {
          id: r.id,
          role: r.role as 'user' | 'assistant',
          text: textBlocks.map((b) => b.text ?? '').join(''),
          files: fileBlocks.map((b) => ({
            previewUrl: '',   // no preview for historical files (path only stored)
            mediaType: b.mediaType ?? 'image/jpeg',
          })),
          tokensIn: r.tokensIn ?? undefined,
          tokensOut: r.tokensOut ?? undefined,
          costUsd: r.costUsd != null ? parseFloat(r.costUsd) : undefined,
        }
      }))
    }

    if (artRes.ok) setArtifacts(await artRes.json())
  }

  function newConversation(projectId?: string) {
    setActiveConvId(null)
    setMessages([])
    setArtifacts([])
    // The conversation will be auto-created on first send, optionally with projectId.
    // Store desired projectId in a ref for the send handler.
    pendingProjectIdRef.current = projectId ?? null
  }
  const pendingProjectIdRef = useRef<string | null>(null)

  const handleSend = useCallback(async (text: string, pendingFiles: PendingFile[]) => {
    if (streaming) return
    abortRef.current = new AbortController()
    setStreaming(true)

    // Upload files first, collect file refs.
    const fileRefs: Array<{ bucket: string; path: string; mediaType: string }> = []
    for (const pf of pendingFiles) {
      try {
        const fd = new FormData()
        fd.append('file', pf.file)
        if (activeConvId) fd.append('conversationId', activeConvId)
        const res = await fetch('/api/assistant/upload', { method: 'POST', body: fd })
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
        fileRefs.push(await res.json())
      } catch (err) {
        toast.error(`ফাইল আপলোড ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
        setStreaming(false)
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
    setMessages((prev) => [...prev, userMsg])

    // Streaming assistant placeholder
    const assistantMsgId = nextId('streaming')
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true, toolActivity: [] },
    ])

    let finalConvId = activeConvId

    try {
      const body: Record<string, unknown> = { message: text }
      if (finalConvId) body.conversationId = finalConvId
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

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() ?? ''

        for (const chunk of lines) {
          if (!chunk.startsWith('data: ')) continue
          let evt: Record<string, unknown>
          try { evt = JSON.parse(chunk.slice(6)) } catch { continue }

          if (evt.type === 'conversation_id') {
            finalConvId = evt.id as string
            setActiveConvId(finalConvId)
          } else if (evt.type === 'text_delta') {
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: m.text + (evt.delta as string) } : m
            ))
          } else if (evt.type === 'tool_start') {
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, toolActivity: [...(m.toolActivity ?? []), { id: evt.id as string, name: evt.name as string, done: false }] }
                : m
            ))
          } else if (evt.type === 'tool_end') {
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
                    },
                  }
                : m
            ))
          } else if (evt.type === 'done') {
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    id: evt.messageId as string,
                    streaming: false,
                    tokensIn: evt.tokensIn as number,
                    tokensOut: evt.tokensOut as number,
                    costUsd: evt.costUsd as number,
                  }
                : m
            ))
          } else if (evt.type === 'error') {
            const errText = evt.message as string
            let banglaMsg = errText
            if (errText.includes('ANTHROPIC_API_KEY') || errText.includes('api_key')) {
              banglaMsg = 'API Key সেট করা নেই। Vercel-এ ANTHROPIC_API_KEY যোগ করুন।'
            } else if (errText.includes('overloaded')) {
              banglaMsg = 'সার্ভার ব্যস্ত। কিছুক্ষণ পরে আবার চেষ্টা করুন।'
            }
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, streaming: false, text: `⚠️ ${banglaMsg}` }
                : m
            ))
          }
        }
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
        const rows: Array<{
          id: string; role: string
          content: Array<{ type: string; text?: string; mediaType?: string }>
          tokensIn: number | null; tokensOut: number | null; costUsd: string | null
        }> = await res.json()

        if (rows.length > initialCount) {
          setMessages(rows.map((r) => {
            const textBlocks = r.content.filter((b) => b.type === 'text')
            const fileBlocks = r.content.filter((b) => b.type === 'file_ref')
            return {
              id: r.id,
              role: r.role as 'user' | 'assistant',
              text: textBlocks.map((b) => b.text ?? '').join(''),
              files: fileBlocks.map((b) => ({ previewUrl: '', mediaType: b.mediaType ?? 'image/jpeg' })),
              tokensIn: r.tokensIn ?? undefined,
              tokensOut: r.tokensOut ?? undefined,
              costUsd: r.costUsd != null ? parseFloat(r.costUsd) : undefined,
            }
          }))
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
    <div className="flex h-[calc(100dvh-56px)] overflow-hidden bg-black">
      {/* Sidebar */}
      <AgentSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeConvId={activeConvId}
        onSelectConv={loadConversation}
        onNewConv={newConversation}
        onConvUpdated={() => {}} // sidebar refreshes itself
        isMobile={isMobile}
      />

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-lg p-1.5 text-muted hover:text-cream transition-colors"
            title="সাইডবার"
          >
            ☰
          </button>
          <span className="flex-1 truncate text-sm font-semibold text-cream">
            {activeConvId ? 'কথোপকথন' : 'নতুন কথোপকথন'}
          </span>
          {artifacts.length > 0 && (
            <button
              onClick={() => setArtifactsOpen((v) => !v)}
              className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold text-muted-hi hover:text-cream hover:border-gold-dim/30 transition-colors"
            >
              ✦ {artifacts.length} আর্টিফ্যাক্ট
            </button>
          )}
        </div>

        {/* Thread + artifacts */}
        <div className="flex flex-1 overflow-hidden">
          <AgentThread
            messages={messages}
            onArtifactSave={saveArtifact}
            conversationId={activeConvId}
            onArtifactOpen={() => setArtifactsOpen(true)}
            onActionApproved={() => { if (activeConvId) startResultPolling(activeConvId) }}
          />
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
        />
      </div>
    </div>
  )
}
