'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import AgentConfirmCard, { type PendingAction } from './AgentConfirmCard'
import AgentAskCard, { type AskCard } from './AgentAskCard'
import type { Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import AgentEmptyState from './AgentEmptyState'
import { AgentThinkingIndicator } from './AgentThinkingIndicator'
import { toolDisplay } from '@/agent/lib/tool-labels'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: Array<{ previewUrl: string; mediaType: string }>
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean }>
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
      className="rounded-lg p-1.5 text-white/30 transition-all hover:bg-white/[0.06] hover:text-white/60"
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
      className={`rounded-lg p-1.5 transition-all disabled:opacity-50 ${playing ? 'bg-gold/10 text-gold' : 'text-white/30 hover:bg-white/[0.06] hover:text-white/60'}`}
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

function ToolActivityChip({ name, done, success }: { name: string; done: boolean; success?: boolean }) {
  const d = toolDisplay(name)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
      done
        ? success !== false
          ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300/80'
          : 'border-red-400/20 bg-red-400/[0.06] text-red-300/80'
        : 'border-white/[0.08] bg-white/[0.03] text-white/50'
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
      <span>{d.label}</span>
    </span>
  )
}

export default function AgentThread({ messages, onArtifactSave, conversationId, onArtifactOpen, onActionApproved, onQuickSend, streamStatus, streamMode, compacting }: AgentThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const [artifactSaved, setArtifactSaved] = useState<Set<string>>(new Set())

  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    setShowJumpBtn(scrollHeight - scrollTop - clientHeight > 80)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('scroll', checkScrollPosition, { passive: true })
    checkScrollPosition()
    return () => container.removeEventListener('scroll', checkScrollPosition)
  }, [checkScrollPosition])

  useEffect(() => {
    checkScrollPosition()
    const last = messages[messages.length - 1]
    if (last?.streaming || last?.role === 'user') {
      bottomRef.current?.scrollIntoView({
        behavior: last?.role === 'user' ? 'auto' : 'smooth',
        block: 'end',
      })
    }
  }, [messages, checkScrollPosition])

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
      <div className="mx-auto max-w-2xl px-4 py-4 pb-6 md:px-6 md:py-6">
        {messages.length === 0 && (
          <AgentEmptyState onSuggestion={onQuickSend} />
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg, index) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: index < 10 ? index * 0.02 : 0 }}
              className={msg.role === 'user' ? 'mb-6' : 'mb-8'}
            >
              {msg.role === 'user' ? (
                /* User message — subtle right-aligned pill */
                <div className="flex justify-end">
                  <div className="max-w-[85%] min-w-0">
                    {msg.files && msg.files.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2 justify-end">
                        {msg.files.map((f, i) => (
                          f.mediaType.startsWith('image/') ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={i} src={f.previewUrl} alt="" className="h-20 w-20 rounded-2xl object-cover border border-white/[0.08]" />
                          ) : (
                            <div key={i} className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] text-[10px] text-white/50">
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              <span className="mt-0.5">PDF</span>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <div className="rounded-2xl rounded-br-sm bg-[rgba(201,168,76,0.1)] px-4 py-3 text-[15px] leading-relaxed text-white/90 whitespace-pre-wrap break-words select-text">
                        {msg.text}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant message — full-width document flow (Claude-style) */
                <div className="min-w-0">
                  {/* Thinking indicator — only during active streaming */}
                  {msg.streaming && streamStatus && msg.id === messages[messages.length - 1]?.id && (
                    <AgentThinkingIndicator
                      label={streamStatus}
                      mode={streamMode ?? 'writing'}
                      className="mb-3"
                    />
                  )}

                  {/* Tool activity chips */}
                  {msg.toolActivity && msg.toolActivity.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {msg.toolActivity.map((t) => (
                        <ToolActivityChip key={t.id} name={t.name} done={t.done} success={t.success} />
                      ))}
                    </div>
                  )}

                  {/* Message content — full-width, no bubble */}
                  {(!msg.streaming || msg.text) && (
                    <div className="text-[15px] leading-[1.7] text-white/90 select-text">
                      {msg.streaming && msg.text ? (
                        <div className="relative">
                          <AgentMarkdown content={msg.text} />
                          <motion.span
                            className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] rounded-full bg-gold/60"
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

                  {/* Confirm card */}
                  {msg.pendingAction && (
                    <AgentConfirmCard
                      action={msg.pendingAction}
                      onResolved={(status) => {
                        if (status === 'approved') onActionApproved?.()
                      }}
                    />
                  )}

                  {/* Ask card */}
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

                  {/* Message actions row */}
                  {!msg.streaming && msg.text && (
                    <div className="mt-2 flex items-center gap-0.5">
                      <CopyButton text={msg.text} />
                      <TtsButton text={msg.text} messageId={msg.id} />
                      {detectArtifact(msg.text) && !artifactSaved.has(msg.id) && (
                        <button
                          onClick={() => saveArtifact(msg)}
                          className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-white/30 transition-all hover:bg-white/[0.06] hover:text-white/60"
                        >
                          সংরক্ষণ
                        </button>
                      )}
                      {artifactSaved.has(msg.id) && (
                        <span className="px-2 text-[11px] text-emerald-400/70">সংরক্ষিত</span>
                      )}
                      {msg.tokensIn != null && (
                        <span className="ml-auto text-[10px] tabular-nums text-white/20">
                          {msg.tokensIn != null && `↑${msg.tokensIn.toLocaleString()}`}{' '}
                          {msg.tokensOut != null && `↓${msg.tokensOut.toLocaleString()}`}{' '}
                          {msg.costUsd != null && <span className="text-gold/40">${msg.costUsd.toFixed(4)}</span>}
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
            className="mx-auto my-4 max-w-sm rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4"
          >
            <div className="mb-2 text-[13px] font-medium text-white/60">
              কথোপকথন কম্প্যাক্ট হচ্ছে…
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-gold/40 to-gold/20"
                initial={{ width: '0%' }}
                animate={{ width: '100%' }}
                transition={{ duration: 2.2, ease: 'easeInOut' }}
              />
            </div>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      <AnimatePresence>
        {showJumpBtn && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => {
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
              setTimeout(checkScrollPosition, 400)
            }}
            className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/[0.1] bg-[rgba(12,12,16,0.9)] px-4 py-2 text-xs font-medium text-white/60 shadow-lg backdrop-blur-2xl transition-all hover:text-white/80"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            নিচে যান
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
