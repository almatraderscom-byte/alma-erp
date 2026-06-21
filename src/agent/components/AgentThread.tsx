'use client'

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import AgentConfirmCard, { type PendingAction } from './AgentConfirmCard'
import AgentAskCard, { type AskCard } from './AgentAskCard'
import type { Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import AgentEmptyState from './AgentEmptyState'
import { AgentTodoDock } from './AgentTodoDock'
import { useAgentTodosOptional } from './AgentTodoContext'
import { isFailedStatus, isInProgressStatus } from './todo-panel-utils'
import { OfficeShiftThreadRenderer } from './OfficeShiftThreadBlocks'
import { AgentThinkingIndicator, ModelSpinner, type ModelVariant, type ThinkingMode } from './AgentThinkingIndicator'
import { toolDisplay, toolDetail } from '@/agent/lib/tool-labels'
import { ScrollAffordances } from './ScrollAffordances'
import { agentReplyHaptic } from '@/agent/lib/haptics'

/** Compact token formatter: 36100 → "36.1k", 681 → "681". */
function fmtTok(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString()
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: Array<{ previewUrl: string; mediaType: string }>
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean; stopped?: boolean; input?: unknown }>
  /** Specialist sub-agent delegations spawned by the head agent (Cursor-style cards). */
  delegations?: Array<{
    id: string
    role: string
    roleLabel: string
    task: string
    done: boolean
    success?: boolean
    stopped?: boolean
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
  cacheCreation?: number
  cacheRead?: number
  costUsd?: number
  streaming?: boolean
  /** True when the honesty guard caught a false completion claim and the agent rewrote its answer. */
  selfCorrected?: boolean
}

interface AgentThreadProps {
  messages: ChatMessage[]
  onArtifactSave: (artifact: Omit<Artifact, 'id' | 'createdAt'>) => void
  conversationId: string | null
  onArtifactOpen: () => void
  onActionApproved?: () => void
  onQuickSend?: (text: string) => void
  onStartVoiceSession?: () => void
  streamMode?: ThinkingMode
  streamVariant?: ModelVariant
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
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-muted"
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
              className="mt-2 max-h-[240px] overflow-y-auto border-l-2 border-white/[0.07] pl-3 text-[13px] leading-relaxed text-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
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
  cs: '💬',
}

// Per-role loading identity. Critical roles run on Claude (rotating star); the
// cheap non-critical workers (cs/marketer/content/researcher) run on Qwen (orb
// glow). The 'deepseek' variant exists for when a role is routed to DeepSeek.
const ROLE_VARIANT: Record<string, ModelVariant> = {
  analyst: 'claude',
  ops: 'claude',
  cs: 'qwen',
  marketer: 'qwen',
  content: 'qwen',
  researcher: 'qwen',
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
    <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-card/80 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => hasSummary && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left ${hasSummary ? 'cursor-pointer hover:bg-white/[0.02]' : 'cursor-default'}`}
      >
        <span className="mt-0.5 text-[15px] leading-none">{ROLE_ICON[d.role] ?? '🤝'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-cream">{d.roleLabel}</span>
            <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">সাব-এজেন্ট</span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-snug text-muted">{d.task}</span>
          {d.toolsUsed && d.toolsUsed.length > 0 && (
            <span className="mt-1 block truncate text-[10px] text-muted">
              {d.toolsUsed.map((t) => toolDisplay(t).label).join(' · ')}
            </span>
          )}
        </span>
        <span className="mt-0.5 shrink-0">
          {!d.done && !d.stopped ? (
            <ModelSpinner variant={ROLE_VARIANT[d.role] ?? 'default'} size={14} />
          ) : d.stopped ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="text-muted opacity-60"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
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
            <div className="border-t border-border-subtle px-3 py-2.5 text-[13px] leading-relaxed text-muted-hi whitespace-pre-wrap break-words">
              {d.summary}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Inline Cursor-/Claude-style worklist. When the head agent breaks a multi-step
 * job into its own short todolist (manage_work_todos action=add source=agent), the
 * owner should SEE that list live inside the chat — not buried in the collapsed
 * top dock. This renders the agent's recent self-todos as a small checklist with
 * live status ticks, attached to the active (last) assistant turn. Kept short on
 * purpose: a recent window + a hard cap, so it stays a glanceable few lines.
 */
function InlineAgentTodos() {
  const ctx = useAgentTodosOptional()
  const steps = useMemo(() => {
    const all = ctx?.todos ?? []
    const cutoff = Date.now() - 3 * 60 * 60 * 1000 // last 3h → this task, not all day
    const agent = all.filter((t) => t.source === 'agent' && new Date(t.createdAt).getTime() >= cutoff)
    // Take the most-recent batch (cap 6), then show oldest → newest like a plan.
    return [...agent]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 6)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [ctx?.todos])

  if (steps.length === 0) return null
  const done = steps.filter((t) => t.status === 'completed').length

  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-card/70 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-muted">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <span>কাজের ধাপ</span>
        <span className="ml-auto font-normal tabular-nums text-muted">{done}/{steps.length}</span>
      </div>
      <ul className="flex flex-col px-2 pb-2">
        {steps.map((t) => {
          const completed = t.status === 'completed'
          const failed = isFailedStatus(t.status)
          const running = isInProgressStatus(t.status)
          return (
            <li key={t.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
              <span className="mt-[1px] shrink-0">
                {running ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                ) : completed ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                ) : failed ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted opacity-50"><circle cx="12" cy="12" r="9"/></svg>
                )}
              </span>
              <span className={`text-[12.5px] leading-snug break-words [overflow-wrap:anywhere] ${completed ? 'text-muted line-through' : failed ? 'text-red-500/80' : 'text-cream'}`}>
                {t.title}
              </span>
            </li>
          )
        })}
      </ul>
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
      className="rounded-lg p-1.5 text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi"
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
      className={`rounded-lg p-1.5 transition-all disabled:opacity-50 ${playing ? 'bg-[#E07A5F]/10 text-[#E07A5F]' : 'text-muted hover:bg-white/[0.05] hover:text-muted-hi'}`}
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
    byName.set(t.name, prev ? { ...t, done: t.done || prev.done, stopped: t.stopped || prev.stopped } : t)
  }
  return [...byName.values()]
}

/**
 * Collapses an overly long message to a few screens of height with a soft mask
 * fade + an expand toggle ("বিস্তারিত দেখুন"), so the chat never shows one giant
 * SMS — the owner taps to read the full thing. The mask fade is background-
 * agnostic (CSS mask, not a colored gradient) so it works equally on the coral
 * user pill and the page background behind an assistant reply.
 */
function CollapsibleMessage({
  children,
  collapsedMaxPx = 340,
}: {
  children: ReactNode
  collapsedMaxPx?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // scrollHeight ignores the maxHeight clamp, so this stays correct even while
    // the block is collapsed. ResizeObserver re-checks when content reflows.
    const check = () => setOverflowing(el.scrollHeight > collapsedMaxPx + 28)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsedMaxPx])

  const collapsed = overflowing && !expanded
  const fade = 'linear-gradient(to bottom, black calc(100% - 56px), transparent)'

  return (
    <div>
      <div
        ref={ref}
        className="overflow-hidden transition-[max-height] duration-300 ease-out"
        style={collapsed ? { maxHeight: collapsedMaxPx, maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-[#E07A5F]/80 transition-colors hover:text-[#E07A5F]"
        >
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          {expanded ? 'কম দেখুন' : 'বিস্তারিত দেখুন'}
        </button>
      )}
    </div>
  )
}

function ToolActivityChip({ name, done, success, stopped, input }: { name: string; done: boolean; success?: boolean; stopped?: boolean; input?: unknown }) {
  const d = toolDisplay(name)
  const detail = toolDetail(name, input)
  // When the owner hits Stop mid-flight, the chip is frozen (done=true, stopped=true)
  // so the spinner halts — "stop hole animation taw stop e thake".
  const spinning = !done && !stopped
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
      stopped
        ? 'border-border bg-white/[0.02] text-muted opacity-60'
        : done
          ? success !== false
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-red-200 bg-red-50 text-red-600'
          : 'border-border bg-white/[0.02] text-muted'
    }`}>
      {spinning && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
      )}
      {stopped && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      )}
      {!stopped && done && success !== false && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
      )}
      {!stopped && done && success === false && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      )}
      <span>{d.label}{detail && <span className="font-normal opacity-60"> · {detail}</span>}</span>
    </span>
  )
}

export default function AgentThread({ messages, onArtifactSave, conversationId, onArtifactOpen, onActionApproved, onQuickSend, onStartVoiceSession, streamMode, streamVariant, compacting }: AgentThreadProps) {
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

  // Light haptic when the agent finishes a reply (Claude-app style on phone).
  // Fires on the streaming→done transition for a finalized assistant message.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const isStreaming = Boolean(streamingMessage)
    if (wasStreamingRef.current && !isStreaming) {
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && last.text) agentReplyHaptic()
    }
    wasStreamingRef.current = isStreaming
  }, [streamingMessage, messages])

  // When user manually scrolls up during streaming, stop force-tailing them.
  const stickToBottomRef = useRef(true)
  // Show a floating "jump to latest" button once the user scrolls up a bit.
  const [showScrollDown, setShowScrollDown] = useState(false)

  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    stickToBottomRef.current = distanceFromBottom < 60
    // Reveal the button only when there's meaningfully more below the fold.
    setShowScrollDown(distanceFromBottom > 160)
  }, [])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    stickToBottomRef.current = true
    setShowScrollDown(false)
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
    // Content grew without a scroll event — refresh the button visibility.
    checkScrollPosition()
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
    // Non-scrolling positioned wrapper. The scroll-down button is an `absolute`
    // child of THIS (not a `fixed` or `sticky` child of the scroller): on the
    // iPhone app the agent route locks <body> to `position:fixed; overflow:hidden`
    // for the keyboard fix, and WKWebView then refuses to paint position:fixed
    // children — which is why the old button was invisible on-device. `absolute`
    // anchors to this relative wrapper instead of the viewport, so it's immune.
    <div className="relative flex min-h-0 flex-1 flex-col">
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
                  <div className="max-w-[85%] min-w-0 rounded-2xl rounded-br-sm bg-[#E07A5F]/10 px-4 py-3 text-[15px] leading-relaxed text-cream whitespace-pre-wrap break-words select-text">
                    <CollapsibleMessage collapsedMaxPx={260}>{msg.text}</CollapsibleMessage>
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
                            <img key={i} src={f.previewUrl} alt="" className="h-20 w-20 rounded-2xl object-cover border border-border-subtle" />
                          ) : (
                            <div key={i} className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl border border-border-subtle bg-white/[0.04] text-[10px] text-muted">
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              <span className="mt-0.5">PDF</span>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                    {msg.text && (
                      <div className="rounded-2xl rounded-br-sm bg-[#E07A5F]/10 px-4 py-3 text-[15px] leading-relaxed text-cream whitespace-pre-wrap break-words select-text">
                        <CollapsibleMessage collapsedMaxPx={260}>{msg.text}</CollapsibleMessage>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant message — full-width, dark text on light bg */
                <div className="min-w-0">
                  {msg.thinking && (
                    <ThoughtBlock
                      thinking={msg.thinking}
                      thinkingMs={msg.thinkingMs}
                      live={Boolean(msg.streaming) && !msg.text}
                    />
                  )}

                  {msg.toolActivity && msg.toolActivity.length > 0 && (
                    <div className="mb-3">
                      <div className="mb-1 text-[10px] font-medium text-muted">
                        🔧 {msg.toolActivity.length} tool ব্যবহার
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {dedupeToolActivity(msg.toolActivity).map((t) => (
                          <ToolActivityChip key={t.name} name={t.name} done={t.done} success={t.success} stopped={t.stopped} input={t.input} />
                        ))}
                      </div>
                    </div>
                  )}

                  {msg.delegations && msg.delegations.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {msg.delegations.map((d) => (
                        <DelegationCard key={d.id} d={d} />
                      ))}
                    </div>
                  )}

                  {!isOfficeShift && msg.id === messages[messages.length - 1]?.id && (
                    <InlineAgentTodos />
                  )}

                  {(!msg.streaming || msg.text) && (
                    <div className="text-[15px] leading-[1.7] text-cream select-text break-words [overflow-wrap:anywhere]">
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
                        <CollapsibleMessage collapsedMaxPx={360}>
                          <AgentMarkdown content={msg.text} />
                        </CollapsibleMessage>
                      )}
                    </div>
                  )}

                  {/* Persistent working indicator — sits at the BOTTOM of the
                      live message and trails the streaming content, so it never
                      vanishes mid-turn (like Claude's). Gated only on `streaming`
                      (NOT on streamStatus) so a momentary empty label can't make
                      it flicker out; it disappears only when the turn is `done`. */}
                  {msg.streaming && msg.id === messages[messages.length - 1]?.id && (
                    <AgentThinkingIndicator
                      mode={streamMode ?? 'thinking'}
                      variant={streamVariant ?? 'claude'}
                      className="mt-3"
                    />
                  )}

                  {msg.pendingAction && (
                    <AgentConfirmCard
                      action={msg.pendingAction}
                      onResolved={(status) => {
                        // Approve always posts a result note. For a delegation,
                        // Reject ALSO posts one (Sonnet's own answer), so poll then too.
                        if (status === 'approved' || msg.pendingAction?.actionType === 'delegation') {
                          onActionApproved?.()
                        }
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
                      {/* Persistent ALMA byline — stays under every finished reply
                          (the owner wants the ALMA name to REMAIN after the turn,
                          like the model name in the Claude app, not vanish with the
                          working spinner). */}
                      <span className="mr-1.5 inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide text-[#E07A5F]/80">
                        <span aria-hidden style={{ fontVariantEmoji: 'text' as const }}>✦</span>
                        ALMA
                      </span>
                      <CopyButton text={msg.text} />
                      <TtsButton text={msg.text} messageId={msg.id} />
                      {detectArtifact(msg.text) && !artifactSaved.has(msg.id) && (
                        <button
                          onClick={() => saveArtifact(msg)}
                          className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi"
                        >
                          সংরক্ষণ
                        </button>
                      )}
                      {artifactSaved.has(msg.id) && (
                        <span className="px-2 text-[11px] text-emerald-600">সংরক্ষিত</span>
                      )}
                      {msg.selfCorrected && (
                        <span
                          className="px-2 text-[10px] text-amber-600/80"
                          title="এজেন্ট নিজের একটা ভুল দাবি ধরে উত্তরটা যাচাই করে ঠিক করে নিয়েছে — মিথ্যা 'করে দিলাম' আটকানো হয়েছে"
                        >
                          🔁 নিজে যাচাই করে ঠিক করেছে
                        </span>
                      )}
                      {msg.tokensIn != null && (() => {
                        const tin = msg.tokensIn ?? 0
                        const tout = msg.tokensOut ?? 0
                        const cw = msg.cacheCreation ?? 0
                        const cr = msg.cacheRead ?? 0
                        const total = tin + tout + cw + cr
                        return (
                          <span
                            className="ml-auto text-[10px] tabular-nums text-muted"
                            title="Σ মোট টোকেন · ↑ইনপুট ⚡cache লেখা (দামি) ♻cache পড়া (সস্তা) ↓আউটপুট"
                          >
                            {`Σ${fmtTok(total)} · ↑${fmtTok(tin)}`}
                            {cw > 0 && ` ⚡${fmtTok(cw)}`}
                            {cr > 0 && ` ♻${fmtTok(cr)}`}
                            {` ↓${fmtTok(tout)}`}{' '}
                            {msg.costUsd != null && <span className="text-[#E07A5F]/60">${msg.costUsd.toFixed(4)}</span>}
                          </span>
                        )
                      })()}
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
            className="mx-auto my-4 max-w-sm rounded-2xl border border-border-subtle bg-card/80 p-4 shadow-sm"
          >
            <div className="mb-2 text-[13px] font-medium text-muted-hi">
              কথোপকথন কম্প্যাক্ট হচ্ছে…
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
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
    </div>

      {/* Scroll-to-bottom, Claude-style. `absolute` inside the relative wrapper
          (see top of return) — NOT fixed/sticky — so it paints reliably inside
          the iPhone app's fixed-body agent route and floats just above the
          composer, centered like the Claude app. */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2">
        <AnimatePresence>
          {showScrollDown && (
            <motion.button
              key="scroll-down"
              type="button"
              initial={{ opacity: 0, scale: 0.6, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.6, y: 6 }}
              transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 }}
              onClick={scrollToBottom}
              aria-label="নিচে যান"
              className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-muted ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-[#E07A5F] active:scale-90"
            >
              <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Scroll-to-TOP only — the bottom button is handled by the absolute button
          above (fixed-positioned children are unreliable on the iPhone app). */}
      <ScrollAffordances
        containerRef={containerRef}
        topThreshold={400}
        bottom={false}
      />
    </div>
  )
}
