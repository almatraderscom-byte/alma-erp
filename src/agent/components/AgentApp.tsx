'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import AgentSidebar, { type Conversation } from './AgentSidebar'
import AgentThread, { type ChatMessage } from './AgentThread'
import AgentComposer, { type PendingFile } from './AgentComposer'
import AgentModelSelector from './AgentModelSelector'
import AgentArtifactsPanel, { type Artifact } from './AgentArtifactsPanel'
const VoiceSessionOverlay = dynamic(() => import('./voice/VoiceSessionOverlay'), { ssr: false })
import toast from 'react-hot-toast'
import { useMediaQuery } from '@/agent/hooks/useMediaQuery'
import { AgentConversationSkeleton } from '@/agent/components/AgentThinkingIndicator'
import { toolDisplay } from '@/agent/lib/tool-labels'
import { useVoiceRecorder, type VoicePhase } from '@/agent/hooks/useVoiceRecorder'
import { useMicLevel } from '@/agent/hooks/useMicLevel'
import { usePlaybackLevel } from '@/agent/hooks/usePlaybackLevel'
import { speakAgentText } from '@/agent/lib/voice-tts-client'
import type { AgentOrbState, VoiceMode } from '@/agent/lib/voice-types'

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
  }>
  tokensIn: number | null
  tokensOut: number | null
  costUsd: string | null
}

function mapMessageRows(rows: MessageRow[]): ChatMessage[] {
  return rows.map((r) => {
    const textBlocks = r.content.filter((b) => b.type === 'text')
    const fileBlocks = r.content.filter((b) => b.type === 'file_ref')
    const confirmBlock = r.content.find((b) => b.type === 'confirm_card' && b.pendingActionId)
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
      pendingAction: confirmBlock?.pendingActionId
        ? {
            id: confirmBlock.pendingActionId,
            summary: confirmBlock.summary ?? '',
            costEstimate: confirmBlock.costEstimate,
            actionType: confirmBlock.actionType,
          }
        : undefined,
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
  const [streamMode, setStreamMode] = useState<'fetching' | 'writing' | 'settled'>('writing')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [convLoading, setConvLoading] = useState(false)
  const [convLoadError, setConvLoadError] = useState<string | null>(null)
  const [personalProjectId, setPersonalProjectId] = useState<string | null>(null)
  const [activePersonalMode, setActivePersonalMode] = useState(false)
  const [activeConvProjectId, setActiveConvProjectId] = useState<string | null>(null)
  const [activeModelId, setActiveModelId] = useState('claude-sonnet-4-6')
  const [compacting, setCompacting] = useState(false)
  const [dayShift, setDayShift] = useState<{
    conversationId: string | null
    active: boolean
    title: string | null
  } | null>(null)

  const [voiceMode, setVoiceMode] = useState<VoiceMode>('off')
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle')
  const [ttsAudio, setTtsAudio] = useState<HTMLAudioElement | null>(null)
  const [ttsPlaying, setTtsPlaying] = useState(false)

  const voiceModeRef = useRef(voiceMode)
  const voiceOverlayRef = useRef(voiceOverlayOpen)
  const handleSendRef = useRef<(text: string, files: PendingFile[]) => Promise<void>>(async () => {})
  const playVoiceReplyRef = useRef<(text: string) => Promise<void>>(async () => {})

  useEffect(() => { voiceModeRef.current = voiceMode }, [voiceMode])
  useEffect(() => { voiceOverlayRef.current = voiceOverlayOpen }, [voiceOverlayOpen])

  const abortRef = useRef<AbortController | null>(null)
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

  const voiceRecorder = useVoiceRecorder({
    onPhaseChange: setVoicePhase,
    onTranscribed: (text) => {
      if (voiceModeRef.current !== 'off') void handleSendRef.current(text, [])
    },
  })

  const micLevel = useMicLevel(voiceRecorder.stream, voiceRecorder.recording)
  const playbackLevel = usePlaybackLevel(ttsAudio, ttsPlaying)

  const agentOrbState: AgentOrbState =
    voicePhase === 'listening' || voiceRecorder.recording
      ? 'listening'
      : voicePhase === 'talking' || ttsPlaying
        ? 'talking'
        : voicePhase === 'thinking' || voicePhase === 'transcribing' || streaming
          ? 'thinking'
          : null

  const playVoiceReply = useCallback(async (text: string) => {
    if (voiceModeRef.current !== 'conversation' || !text.trim() || text.startsWith('⚠️')) return
    setVoicePhase('talking')
    setTtsPlaying(true)
    try {
      const audio = await speakAgentText(text)
      setTtsAudio(audio)
      audio.onended = () => {
        setTtsPlaying(false)
        setVoicePhase('idle')
        setTtsAudio(null)
        if (voiceOverlayRef.current) {
          window.setTimeout(() => { void voiceRecorder.startRecording() }, 500)
        }
      }
    } catch {
      setTtsPlaying(false)
      setVoicePhase('idle')
      toast.error('ভয়েস উত্তর ব্যর্থ')
    }
  }, [voiceRecorder])

  useEffect(() => { playVoiceReplyRef.current = playVoiceReply }, [playVoiceReply])

  const startVoiceSession = useCallback(() => {
    setVoiceMode('conversation')
    setVoiceOverlayOpen(true)
    window.setTimeout(() => { void voiceRecorder.startRecording() }, 320)
  }, [voiceRecorder])

  const startDictation = useCallback(() => {
    if (voiceModeRef.current === 'off') setVoiceMode('dictation')
    setVoiceOverlayOpen(true)
    void voiceRecorder.startRecording()
  }, [voiceRecorder])

  const closeVoiceOverlay = useCallback(() => {
    voiceRecorder.cancelRecording()
    setVoiceOverlayOpen(false)
    setVoiceMode('off')
    setVoicePhase('idle')
    if (ttsAudio) {
      ttsAudio.pause()
      setTtsPlaying(false)
    }
  }, [voiceRecorder, ttsAudio])

  const cycleVoiceMode = useCallback(() => {
    setVoiceMode((m) => (m === 'off' ? 'dictation' : m === 'dictation' ? 'conversation' : 'off'))
  }, [])

  useEffect(() => { setSidebarOpen(!isMobile) }, [isMobile])

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
    setActiveModelId(conv.modelId ?? 'claude-sonnet-4-6')
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

  const handleSend = useCallback(async (text: string, pendingFiles: PendingFile[]) => {
    if (streaming) return
    abortRef.current = new AbortController()
    if (voiceOverlayRef.current) setVoicePhase('thinking')
    setStreaming(true)
    setStreamStatus('প্রসেস করা হচ্ছে…')

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

    const assistantMsgId = nextId('streaming')
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true, toolActivity: [] },
    ])

    let finalConvId = convIdForUpload ?? activeConvId
    let compactAfterStream: string | null = null
    let serverCompacted = false

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
          m.id === buf.msgId ? { ...m, thinking: (m.thinking ?? '') + chunk } : m,
        ))
      }

      const applySseEvent = (evt: Record<string, unknown>) => {
        if (evt.type === 'conversation_id') {
          finalConvId = evt.id as string
          setActiveConvId(finalConvId)
        } else if (evt.type === 'personal_mode') {
          setActivePersonalMode(evt.active === true)
        } else if (evt.type === 'thinking_delta') {
          setStreamMode('fetching')
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
        } else if (evt.type === 'subagent_start') {
          setStreamMode('fetching')
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
          setStreamMode('fetching')
          setStreamStatus('🔁 verify করছি…')
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, text: '', toolActivity: [] }
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
                  askCard: undefined,
                  tokensIn: evt.tokensIn as number,
                  tokensOut: evt.tokensOut as number,
                  costUsd: evt.costUsd as number,
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
      pendingFiles.forEach((pf) => URL.revokeObjectURL(pf.previewUrl))

      if (voiceModeRef.current === 'conversation' && voiceOverlayRef.current) {
        setMessages((prev) => {
          const last = [...prev].reverse().find(
            (m) => m.role === 'assistant' && !m.streaming && m.text?.trim() && !m.text.startsWith('⚠️'),
          )
          if (last?.text) void playVoiceReplyRef.current(last.text)
          return prev
        })
      } else if (voiceOverlayRef.current && voiceModeRef.current === 'dictation') {
        setVoicePhase('idle')
      }

      if (compactAfterStream) {
        void runCompaction(compactAfterStream)
      } else if (serverCompacted) {
        await new Promise((r) => setTimeout(r, 1200))
        setMessages([])
        setArtifacts([])
        setCompacting(false)
      }
    }
  }, [streaming, activeConvId])

  useEffect(() => { handleSendRef.current = handleSend }, [handleSend])

  function stopGeneration() {
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

    void fetchAndUpdate()
    pollTimerRef.current = setInterval(() => {
      attempts++
      if (attempts >= 12) {
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

      {/* Main area */}
      <div className="flex min-h-0 flex-1 flex-col">
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
        {/* Header — light theme */}
        <header className="safe-top safe-x relative flex shrink-0 items-center gap-1 border-b border-black/[0.06] bg-white px-3 py-2 md:px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600 active:scale-95 md:h-9 md:w-9"
            aria-label="সাইডবার"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>

          {/* Center — title + personal badge */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
            <span className="truncate text-[14px] font-semibold text-gray-700">ALMA Agent</span>
            {activePersonalMode && (
              <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                ব্যক্তিগত
              </span>
            )}
            {dayShift?.active && activeConvId === dayShift.conversationId && (
              <span className="shrink-0 rounded-full border border-emerald-400/40 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 animate-pulse">
                অফিস লাইভ
              </span>
            )}
          </div>

          {/* Right — refresh + new chat */}
          <button
            type="button"
            onClick={() => {
              if (activeConvId) {
                void loadConversation({ id: activeConvId, title: null, projectId: activeConvProjectId, archived: false, updatedAt: '' })
              } else {
                window.location.reload()
              }
            }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600 active:scale-95 md:h-9 md:w-9"
            aria-label="রিফ্রেশ"
            title="রিফ্রেশ"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          </button>
          <button
            type="button"
            onClick={() => newConversation()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600 active:scale-95 md:h-9 md:w-9"
            aria-label="নতুন চ্যাট"
            title="নতুন কথোপকথন"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>

          {/* Desktop-only nav links */}
          <div className="hidden items-center gap-1.5 md:flex">
            <Link
              href="/"
              className="flex h-8 items-center rounded-lg px-2.5 text-[11px] text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600"
            >
              ERP
            </Link>
            {artifacts.length > 0 && (
              <button
                type="button"
                onClick={() => setArtifactsOpen((v) => !v)}
                className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16.4l-6.4 4.8L8 14 2 9.2h7.6z"/></svg>
                {artifacts.length}
              </button>
            )}
          </div>

          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
        </header>

        {activePersonalMode && (
          <div className="shrink-0 border-b border-emerald-200/50 bg-emerald-50/60 px-4 py-1.5 text-center text-[11px] text-emerald-700 backdrop-blur-md">
            ব্যক্তিগত মোড — শুধু ব্যক্তিগত ও পারিবারিক বিষয়
          </div>
        )}

        {/* Thread + artifacts */}
        <div className="relative flex flex-1 overflow-hidden">
          {voiceOverlayOpen && (
            <VoiceSessionOverlay
              open={voiceOverlayOpen}
              agentState={agentOrbState}
              inputLevel={micLevel}
              outputLevel={playbackLevel}
              voiceMode={voiceMode}
              phase={voiceRecorder.recording ? 'listening' : voicePhase}
              onClose={closeVoiceOverlay}
              onTapOrb={() => {
                if (voiceRecorder.recording) voiceRecorder.stopRecording()
                else void voiceRecorder.startRecording()
              }}
            />
          )}
          {convLoading ? (
            <div className="flex flex-1 overflow-y-auto">
              <AgentConversationSkeleton />
            </div>
          ) : convLoadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-red-500/90">{convLoadError}</p>
              <button
                onClick={() => activeConvId && loadConversation({ id: activeConvId, title: null, projectId: null, archived: false, updatedAt: '' })}
                className="rounded-xl border border-black/[0.08] px-4 py-2 text-xs text-gray-500 transition-all hover:bg-black/[0.03] hover:text-gray-700"
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
            onStartVoiceSession={startVoiceSession}
            streamStatus={streamStatus}
            streamMode={streamMode}
            compacting={compacting}
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
          activeModelId={activeModelId}
          onModelChange={setActiveModelId}
          voiceMode={voiceMode}
          voiceRecording={voiceRecorder.recording}
          voiceRecordSecs={voiceRecorder.recordSecs}
          onVoiceStart={startDictation}
          onVoiceStop={() => voiceRecorder.stopRecording()}
          onVoiceCancel={() => voiceRecorder.cancelRecording()}
          onVoiceModeCycle={cycleVoiceMode}
        />
      </div>
    </div>
  )
}
