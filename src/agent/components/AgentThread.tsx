'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import AgentConfirmCard, { type PendingAction } from './AgentConfirmCard'
import AgentAskCard, { type AskCard } from './AgentAskCard'
import type { Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import AgentEmptyState from './AgentEmptyState'
import { AgentTodoDock } from './AgentTodoDock'
import { useAgentTodosOptional } from './AgentTodoContext'
import { OfficeShiftThreadRenderer } from './OfficeShiftThreadBlocks'
import { AgentThinkingIndicator } from './AgentThinkingIndicator'
import { toolDisplay, toolDetail } from '@/agent/lib/tool-labels'
import { ScrollAffordances } from './ScrollAffordances'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: Array<{ previewUrl: string; mediaType: string }>
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean; input?: unknown }>
  /** Specialist sub-agent delegations spawned by the head agent (Cursor-style cards). */
  delegations?: Array<{
    id: string
    role: string
    roleLabel: string
    task: string
    done: boolean
    success?: boolean
    summary?: string
    toolsUsed?: string[]
  }>
  /** Live extended-thinking stream — how the agent reasoned before answering. */
  thinking?: string
  /** Seconds spent thinking (set once the reply text begins). */
  thinkingMs?: number
  pendingAction?: PendingAction
  askCard?: AskCard
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  streaming?: boolean
}

interface AgentThreadProps {
  messages: ChatMessage[]
  onArtifactSave: (artifact: Omit<Artifact, 'id' | 'createdAt'>) => void
  conversationId: string | null
  onArtifactOpen: () => void
  onActionApproved?: () => void
  onQuickSend?: (text: string) => void
  onStartVoiceSession?: () => void
  streamStatus?: string | null
  streamMode?: 'fetching' | 'writing' | 'settled'
  compacting?: boolean
}

function detectArtifact(text: string): { type: 'code' | 'markdown'; content: string; title: string } | null {
  const codeBlockRe = /```(?:\w+)?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = codeBlockRe.exec(text)) !== null) {
    const lines = match[1].split('\n').length
    if (lines >= 15) {
      const lang = text.slice(match.index + 3, match.index + 3 + 30).split('\n')[0].trim()
      return { type: 'code', content: match[1], title: lang ? `${lang} কোড` : 'কোড' }
    }
  }
  if (text.length >= 800 && (text.includes('##') || text.includes('**'))) {
    const firstHeading = text.match(/#{1,3} (.+)/)?.[1] ?? 'ডকুমেন্ট'
    return { type: 'markdown', content: text, title: firstHeading }
  }
  return null
}

/**
 * Cursor-style "Thought for Ns" block. While the agent is still reasoning (no reply
 * text yet) it stays expanded and streams the thinking live; once the reply begins it
 * collapses to a one-line summary that the owner can tap to re-expand.
 */
function ThoughtBlock({ thinking, thinkingMs, live }: { thinking: string; thinkingMs?: number; live: boolean }) {
  const [open, setOpen] = useState(live)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Keep expanded while thinking is live; collapse once the reply starts.
  useEffect(() => {
    setOpen(live)
  }, [live])

  // Autoscroll the thinking body as new text streams in.
  useEffect(() => {
    if (live && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [thinking, live, open])

  const seconds = thinkingMs != null ? Math.max(1, Math.round(thinkingMs / 1000)) : null
  const label = live ? 'Thinking…' : seconds != null ? `Thought for ${seconds}s` : 'Thought'

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-[#94a3b8] transition-colors hover:text-[#64748b]"
      >
        {live ? (
          <motion.span
            className="inline-block h-3 w-3 rounded-full border-[1.5px] border-[#E07A5F]/40 border-t-[#E07A5F]"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
            aria-hidden
          />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2a7 7 0 00-4 12.74V17a2 2 0 002 2h4a2 2 0 002-2v-2.26A7 7 0 0012 2z" />
            <path d="M9 21h6" />
          </svg>
        )}
        <span>{label}</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              ref={bodyRef}
              className="mt-2 max-h-[240px] overflow-y-auto border-l-2 border-black/[0.07] pl-3 text-[13px] leading-relaxed text-[#64748b] whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            >
              {thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const ROLE_ICON: Record<string, string> = {
  researcher: '🔎',
  analyst: '📊',
  marketer: '📣',
  content: '✍️',
  ops: '🗂️',
}

/**
 * Cursor-style delegation card — shows the head agent handing a sub-task to a
 * specialist sub-agent, with live status (running → done/failed) and an expandable
 * result summary once the specialist returns.
 */
function DelegationCard({ d }: { d: NonNullable<ChatMessage['delegations']>[number] }) {
  const [open, setOpen] = useState(false)
  const hasSummary = Boolean(d.summary)
  return (
    <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white/70 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => hasSummary && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left ${hasSummary ? 'cursor-pointer hover:bg-black/[0.02]' : 'cursor-default'}`}
      >
        <span className="mt-0.5 text-[15px] leading-none">{ROLE_ICON[d.role] ?? '🤝'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[#1a1a2e]">{d.roleLabel}</span>
            <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">সাব-এজেন্ট</span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-snug text-[#64748b]">{d.task}</span>
          {d.toolsUsed && d.toolsUsed.length > 0 && (
            <span className="mt-1 block truncate text-[10px] text-gray-400">
              {d.toolsUsed.map((t) => toolDisplay(t).label).join(' · ')}
            </span>
          )}
        </span>
        <span className="mt-0.5 shrink-0">
          {!d.done ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
          ) : d.success !== false ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && hasSummary && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-black/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-[#334155] whitespace-pre-wrap break-words">
              {d.summary}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="rounded-lg p-1.5 text-gray-400 transition-all hover:bg-black/[0.05] hover:text-gray-600"
      title={copied ? 'কপি হয়েছে' : 'কপি করুন'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      )}
    </button>
  )
}

function TtsButton({ text, messageId }: { text: string; messageId: string }) {
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  async function speak() {
    if (playing && audioRef.current) {
      audioRef.current.pause()
      setPlaying(false)
      return
    }
    if (blobUrlRef.current) {
      const audio = new Audio(blobUrlRef.current)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      audio.onerror = () => { setPlaying(false); toast.error('অডিও প্লে ব্যর্থ।') }
      setPlaying(true)
      void audio.play()
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/assistant/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        toast.error(data.error ?? 'TTS ব্যর্থ হয়েছে।')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      audio.onerror = () => { setPlaying(false); toast.error('অডিও প্লে ব্যর্থ।') }
      setPlaying(true)
      void audio.play()
    } catch {
      toast.error('TTS ব্যর্থ হয়েছে।')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [])

  return (
    <button
      onClick={speak}
      disabled={loading}
      data-message-id={messageId}
      className={`rounded-lg p-1.5 transition-all disabled:opacity-50 ${playing ? 'bg-[#E07A5F]/10 text-[#E07A5F]' : 'text-gray-400 hover:bg-black/[0.05] hover:text-gray-600'}`}
      title={playing ? 'থামান' : 'শুনুন'}
    >
      {loading ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
      ) : playing ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/></svg>
      )}
    </button>
  )
}

/**
 * Collapse the self-verification loop's repeated tool runs into one chip per
 * tool (first-appearance order, latest status wins) — Claude-style, no clutter.
 */
function dedupeToolActivity(
  items: NonNullable<ChatMessage['toolActivity']>,
): NonNullable<ChatMessage['toolActivity']> {
  const byName = new Map<string, NonNullable<ChatMessage['toolActivity']>[number]>()
  for (const t of items) {
    const prev = byName.get(t.name)
    byName.set(t.name, prev ? { ...t, done: t.done || prev.done } : t)
  }
  return [...byName.values()]
}

function ToolActivityChip({ name, done, success, input }: { name: string; done: boolean; success?: boolean; input?: unknown }) {
  const d = toolDisplay(name)
  const detail = toolDetail(name, input)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
      done
        ? success !== false
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-red-200 bg-red-50 text-red-600'
        : 'border-black/[0.08] bg-black/[0.02] text-gray-500'
    }`}>
      {!done && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
      )}
      {done && success !== false && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
      )}
      {done && success === false && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      )}
      <span>{d.label}{detail && <span className="font-normal opacity-60"> · {detail}</span>}</span>
    </span>
  )
}

export default function AgentThread({ messages, onArtifactSave, conversationId, onArtifactOpen, onActionApproved, onQuickSend, onStartVoiceSession, streamStatus, streamMode, compacting }: AgentThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const [artifactSaved, setArtifactSaved] = useState<Set<string>>(new Set())
  const todoCtx = useAgentTodosOptional()
  const isOfficeShift = Boolean(
    conversationId &&
    todoCtx?.dayShiftConversationId &&
    conversationId === todoCtx.dayShiftConversationId,
  )
  const staticMessages = useMemo(
    () => messages.filter((m) => !m.streaming),
    [messages],
  )
  const streamingMessage = messages.find((m) => m.streaming)

  // When user manually scrolls up during streaming, stop force-tailing them.
  const stickToBottomRef = useRef(true)

  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    stickToBottomRef.current = distanceFromBottom < 60
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('scroll', checkScrollPosition, { passive: true })
    checkScrollPosition()
    return () => container.removeEventListener('scroll', checkScrollPosition)
  }, [checkScrollPosition])

  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    // Always scroll on the user's own send (block:end, instant).
    if (last.role === 'user') {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      stickToBottomRef.current = true
      return
    }
    // During streaming, only auto-scroll if the user is already near bottom.
    if (last.streaming && stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [messages])

  function saveArtifact(msg: ChatMessage) {
    const detected = detectArtifact(msg.text)
    if (!detected || !conversationId) return
    onArtifactSave({
      messageId: msg.id.startsWith('streaming-') ? null : msg.id,
      conversationId,
      type: detected.type,
      title: detected.title,
      content: detected.content,
      version: 1,
    })
    setArtifactSaved((prev) => new Set(prev).add(msg.id))
    onArtifactOpen()
  }

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <AgentTodoDock containerRef={containerRef} />
      <div className="mx-auto max-w-2xl overflow-x-hidden px-4 py-4 pb-6 md:px-6 md:py-6">
        {messages.length === 0 && (
          <AgentEmptyState onSuggestion={onQuickSend} onStartVoiceSession={onStartVoiceSession} />
        )}

        {isOfficeShift && staticMessages.length > 0 && (
          <div className="mb-6">
            <OfficeShiftThreadRenderer
              messages={staticMessages.map((m) => ({
                id: m.id,
                role: m.role,
                text: m.text,
                costUsd: m.costUsd,
              }))}
              renderUserMessage={(msg) => (
                <div className="mb-4 flex justify-end">
                  <div className="max-w-[85%] min-w-0 rounded-2xl rounded-br-sm bg-[#E07A5F]/10 px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e] whitespace-pre-wrap break-words select-text">
                    {msg.text}
                  </div>
                </div>
              )}
            />
          </div>
        )}

        <AnimatePresence initial={false}>
          {(isOfficeShift ? messages.filter((m) => m.streaming) : messages).map((msg, index) => (
            <motion.div
              key={msg.id}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut', delay: index < 10 ? index * 0.02 : 0 }}
              className={msg.role === 'user' ? 'mb-6' : 'mb-8'}
            >
              {msg.role === 'user' ? (
                /* User message — coral-tinted pill */
                <div className="flex justify-end">
                  <div className="max-w-[85%] min-w-0">
                    {msg.files && msg.files.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2 justify-end">
                        {msg.files.map((f, i) => (
                          f.mediaType.startsWith('image/') ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={i} src={f.previewUrl} alt="" className="h-20 w-20 rounded-2xl object-cover border border-black/[0.06]" />
                          ) : (
                            <div key={i} className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl border border-black/[0.06] bg-gray-50 text-[10px] text-gray-500">
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              <span className="mt-0.5">PDF</span>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <div className="rounded-2xl rounded-br-sm bg-[#E07A5F]/10 px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e] whitespace-pre-wrap break-words select-text">
                        {msg.text}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant message — full-width, dark text on light bg */
                <div className="min-w-0">
                  {msg.thinking && msg.streaming && (
                    <ThoughtBlock
                      thinking={msg.thinking}
                      thinkingMs={msg.thinkingMs}
                      live={Boolean(msg.streaming) && !msg.text}
                    />
                  )}

                  {msg.streaming && streamStatus && msg.id === messages[messages.length - 1]?.id && (
                    <AgentThinkingIndicator
                      label={streamStatus}
                      mode={streamMode ?? 'writing'}
                      className="mb-3"
                    />
                  )}

                  {msg.toolActivity && msg.toolActivity.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {dedupeToolActivity(msg.toolActivity).map((t) => (
                        <ToolActivityChip key={t.name} name={t.name} done={t.done} success={t.success} input={t.input} />
                      ))}
                    </div>
                  )}

                  {msg.delegations && msg.delegations.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {msg.delegations.map((d) => (
                        <DelegationCard key={d.id} d={d} />
                      ))}
                    </div>
                  )}

                  {(!msg.streaming || msg.text) && (
                    <div className="text-[15px] leading-[1.7] text-[#1a1a2e] select-text break-words [overflow-wrap:anywhere]">
                      {msg.streaming && msg.text ? (
                        <div className="relative">
                          <AgentMarkdown content={msg.text} />
                          <motion.span
                            className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] rounded-full bg-[#E07A5F]/60"
                            animate={{ opacity: [1, 0, 1] }}
                            transition={{ duration: 0.8, repeat: Infinity, ease: 'steps(2)' }}
                            aria-hidden
                          />
                        </div>
                      ) : (
                        <AgentMarkdown content={msg.text} />
                      )}
                    </div>
                  )}

                  {msg.pendingAction && (
                    <AgentConfirmCard
                      action={msg.pendingAction}
                      onResolved={(status) => {
                        if (status === 'approved') onActionApproved?.()
                      }}
                    />
                  )}

                  {msg.askCard && onQuickSend && (
                    <AgentAskCard
                      card={msg.askCard}
                      onSelect={(opt) => {
                        void fetch(`/api/assistant/ask-cards/${msg.askCard!.id}/answer`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ option: opt }),
                        }).catch(() => {})
                        onQuickSend(opt)
                      }}
                    />
                  )}

                  {!msg.streaming && msg.text && (
                    <div className="mt-2 flex items-center gap-0.5">
                      <CopyButton text={msg.text} />
                      <TtsButton text={msg.text} messageId={msg.id} />
                      {detectArtifact(msg.text) && !artifactSaved.has(msg.id) && (
                        <button
                          onClick={() => saveArtifact(msg)}
                          className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-gray-400 transition-all hover:bg-black/[0.05] hover:text-gray-600"
                        >
                          সংরক্ষণ
                        </button>
                      )}
                      {artifactSaved.has(msg.id) && (
                        <span className="px-2 text-[11px] text-emerald-600">সংরক্ষিত</span>
                      )}
                      {msg.tokensIn != null && (
                        <span className="ml-auto text-[10px] tabular-nums text-gray-400">
                          {msg.tokensIn != null && `↑${msg.tokensIn.toLocaleString()}`}{' '}
                          {msg.tokensOut != null && `↓${msg.tokensOut.toLocaleString()}`}{' '}
                          {msg.costUsd != null && <span className="text-[#E07A5F]/60">${msg.costUsd.toFixed(4)}</span>}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {compacting && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto my-4 max-w-sm rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm"
          >
            <div className="mb-2 text-[13px] font-medium text-gray-600">
              কথোপকথন কম্প্যাক্ট হচ্ছে…
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-black/[0.06]">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-[#E07A5F]/40 to-[#81B29A]/30"
                initial={{ width: '0%' }}
                animate={{ width: '100%' }}
                transition={{ duration: 2.2, ease: 'easeInOut' }}
              />
            </div>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      <ScrollAffordances
        containerRef={containerRef}
        bottomThreshold={isOfficeShift ? 80 : 120}
        bottomOffsetClass={
          isOfficeShift
            ? 'bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-8'
            : undefined
        }
      />
    </div>
  )
}
