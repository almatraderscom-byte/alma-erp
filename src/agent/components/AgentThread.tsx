'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import AgentConfirmCard, { type PendingAction } from './AgentConfirmCard'
import AgentAskCard, { type AskCard } from './AgentAskCard'
import type { Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import AgentEmptyState from './AgentEmptyState'
import { AgentThinkingIndicator } from './AgentThinkingIndicator'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  // For user messages with file attachments
  files?: Array<{ previewUrl: string; mediaType: string }>
  // Tool activity (for streaming assistant messages)
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean }>
  // Pending action confirm card (image gen, FB post, etc.)
  pendingAction?: PendingAction
  // Clarifying question card (ask_user)
  askCard?: AskCard
  // Usage stats (final)
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
}

// Detect artifact-worthy content: code block ≥ 15 lines OR markdown doc ≥ 800 chars
function detectArtifact(text: string): { type: 'code' | 'markdown'; content: string; title: string } | null {
  // Find fenced code blocks ≥ 15 lines
  const codeBlockRe = /```(?:\w+)?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = codeBlockRe.exec(text)) !== null) {
    const lines = match[1].split('\n').length
    if (lines >= 15) {
      const lang = text.slice(match.index + 3, match.index + 3 + 30).split('\n')[0].trim()
      return { type: 'code', content: match[1], title: lang ? `${lang} কোড` : 'কোড' }
    }
  }
  // Markdown doc ≥ 800 chars
  if (text.length >= 800 && (text.includes('##') || text.includes('**'))) {
    const firstHeading = text.match(/#{1,3} (.+)/)?.[1] ?? 'ডকুমেন্ট'
    return { type: 'markdown', content: text, title: firstHeading }
  }
  return null
}

function TtsButton({ text, messageId }: { text: string; messageId: string }) {
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  async function speak() {
    // If already playing, pause
    if (playing && audioRef.current) {
      audioRef.current.pause()
      setPlaying(false)
      return
    }

    // Replay from cache if available
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
      blobUrlRef.current = url // cache per message

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

  // Cleanup blob URL on unmount
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
      className={`rounded-md p-1 transition-colors disabled:opacity-50 ${playing ? 'text-gold-lt' : 'text-zinc-600 hover:text-muted-hi'}`}
      title={playing ? 'থামান' : 'শুনুন'}
    >
      {loading ? '⏳' : playing ? '⏸' : '🔊'}
    </button>
  )
}

export default function AgentThread({ messages, onArtifactSave, conversationId, onArtifactOpen, onActionApproved, onQuickSend }: AgentThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const [artifactSaved, setArtifactSaved] = useState<Set<string>>(new Set())

  // Auto-scroll with jump-to-bottom awareness
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      setShowJumpBtn(scrollHeight - scrollTop - clientHeight > 100)
    }
    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const last = messages[messages.length - 1]
    if (last?.streaming || last?.role === 'user') {
      bottomRef.current?.scrollIntoView({
        behavior: last?.role === 'user' ? 'auto' : 'smooth',
        block: 'end',
      })
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

  const activeTool = messages
    .filter((m) => m.streaming)
    .flatMap((m) => m.toolActivity ?? [])
    .find((t) => !t.done)

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-4 pb-6 md:py-6">
        {messages.length === 0 && (
          <AgentEmptyState onSuggestion={onQuickSend} />
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'user' ? (
                <div className="max-w-[80%] min-w-0">
                  {/* File thumbnails */}
                  {msg.files && msg.files.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2 justify-end">
                      {msg.files.map((f, i) => (
                        f.mediaType.startsWith('image/') ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={f.previewUrl} alt="" className="h-24 w-24 rounded-xl object-cover border border-border" />
                        ) : (
                          <div key={i} className="flex h-16 w-16 flex-col items-center justify-center rounded-xl border border-border bg-card text-[10px] text-muted-hi">
                            <span className="text-xl">📄</span>
                            <span>PDF</span>
                          </div>
                        )
                      ))}
                    </div>
                  )}
                  {msg.text && (
                    <div className="rounded-2xl rounded-br-md bg-gold/10 border border-gold-dim/30 px-4 py-3 text-sm text-cream whitespace-pre-wrap break-words">
                      {msg.text}
                    </div>
                  )}
                </div>
              ) : (
                <div className="min-w-0 max-w-[85%]">
                  {/* Tool activity chips */}
                  {msg.toolActivity && msg.toolActivity.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {msg.toolActivity.map((t) => (
                        <span
                          key={t.id}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold border ${
                            t.done
                              ? t.success
                                ? 'border-green-400/20 bg-green-400/10 text-green-400'
                                : 'border-red-400/20 bg-red-400/10 text-red-400'
                              : 'border-gold-dim/30 bg-gold/10 text-gold'
                          }`}
                        >
                          {t.done ? (t.success ? '✅' : '❌') : '🔧'}
                          {' '}{t.name}
                          {!t.done && <span className="ml-1 animate-pulse">…</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Message body */}
                  {msg.streaming && !msg.text ? (
                    <AgentThinkingIndicator
                      label="উত্তর তৈরি হচ্ছে"
                      toolName={activeTool?.name}
                    />
                  ) : (
                    <div className="rounded-2xl rounded-bl-md border border-white/[0.08] bg-card/90 px-4 py-3 text-sm text-muted-hi">
                      {msg.streaming && msg.text ? (
                        <div className="relative">
                          <AgentMarkdown content={msg.text} />
                          <motion.span
                            className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-gold/70"
                            animate={{ opacity: [1, 0.2, 1] }}
                            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                            aria-hidden
                          />
                        </div>
                      ) : (
                        <AgentMarkdown content={msg.text} />
                      )}
                    </div>
                  )}

                  {msg.streaming && msg.text && activeTool && (
                    <div className="mt-2">
                      <AgentThinkingIndicator
                        label="কাজ চলছে"
                        toolName={activeTool.name}
                      />
                    </div>
                  )}

                  {/* Confirm card for pending actions */}
                  {msg.pendingAction && (
                    <AgentConfirmCard
                      action={msg.pendingAction}
                      onResolved={(status) => {
                        if (status === 'approved') onActionApproved?.()
                      }}
                    />
                  )}

                  {/* Ask card — tap sends option as next message */}
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

                  {/* Footer actions */}
                  {!msg.streaming && msg.text && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <TtsButton text={msg.text} messageId={msg.id} />
                      {/* Artifact offer */}
                      {detectArtifact(msg.text) && !artifactSaved.has(msg.id) && (
                        <button
                          onClick={() => saveArtifact(msg)}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold text-gold hover:text-gold-lt transition-colors border border-gold-dim/20 hover:border-gold-dim/50"
                        >
                          ✦ আর্টিফ্যাক্ট
                        </button>
                      )}
                      {artifactSaved.has(msg.id) && (
                        <span className="text-[10px] text-green-400">✅ সংরক্ষিত</span>
                      )}
                      {/* Usage info */}
                      {msg.tokensIn != null && (
                        <details className="ml-auto">
                          <summary className="cursor-pointer text-[10px] text-zinc-700 hover:text-zinc-500 select-none">ⓘ</summary>
                          <div className="mt-1 rounded-lg border border-border bg-surface px-3 py-2 text-[10px] text-muted-hi">
                            <span>↑{msg.tokensIn?.toLocaleString()} ↓{msg.tokensOut?.toLocaleString()}</span>
                            <span className="ml-3 text-gold">${msg.costUsd?.toFixed(6)}</span>
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      <AnimatePresence>
        {showJumpBtn && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/[0.1] bg-zinc-900/95 px-4 py-2 text-xs font-semibold text-muted-hi shadow-xl backdrop-blur-md transition-colors hover:text-cream"
          >
            ↓ নিচে যান
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
