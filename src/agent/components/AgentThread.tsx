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
import { PlanDriveInlineTurn } from './monitor/PlanDriveInlineTurn'
import type { PlanDrivePanelData, PlanDriveAction } from './monitor/PlanDriveTimeline'
import { AgentThinkingIndicator, ModelSpinner, type ModelVariant, type ThinkingMode } from './AgentThinkingIndicator'
import { toolDisplay, toolDetail } from '@/agent/lib/tool-labels'
import { agentReplyHaptic } from '@/agent/lib/haptics'

/** Compact token formatter: 36100 → "36.1k", 681 → "681". */
function fmtTok(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString()
}

/** One entry in the unified activity timeline — a reasoning segment or a tool call. */
export type TimelineEntry =
  | { t: 'think'; text: string }
  | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; live?: boolean; id?: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: Array<{ previewUrl: string; mediaType: string; path?: string }>
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean; stopped?: boolean; input?: unknown; result?: string }>
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
  /**
   * Ordered, unified activity timeline — reasoning segments interleaved with tool
   * calls in true execution order. Drives the single Claude.ai-style "working"
   * stream (one connected card) instead of scattered thought + tool + todo boxes.
   * Built live from SSE events and persisted (usage.timeline) so it survives reload.
   */
  timeline?: TimelineEntry[]
  pendingAction?: PendingAction
  askCard?: AskCard
  /**
   * Set when the head router wants to upgrade this thread to a premium model
   * (Sonnet/Opus) and the owner asked to approve such jumps. The turn paused; the
   * owner picks "চালাও" (rerun on the premium model) or "না, সস্তায়" (rerun on the
   * cheap fallback). Optional "এই চ্যাটে আর জিজ্ঞেস কোরো না" remembers approval.
   */
  modelSwitch?: {
    toLabel: string
    fromLabel: string
    fallbackModelId: string
  }
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
  /** Owner answered a model-upgrade approval card → rerun the paused turn. */
  onModelSwitchResolve?: (opts: { approve: boolean; rememberChoice?: boolean; fallbackModelId?: string }) => void
  onStartVoiceSession?: () => void
  streamMode?: ThinkingMode
  streamVariant?: ModelVariant
  compacting?: boolean
  /** Plan-Drive "Live Desk" panel — shown on the home/empty screen above the greeting. */
  homePanel?: ReactNode
  /** Plan-Drive data — drives render INLINE inside the relevant conversation turn. */
  planDrive?: PlanDrivePanelData | null
  onPlanDriveAction?: (planId: string, action: PlanDriveAction) => void | Promise<void>
  onPlanDriveOpen?: (conversationId: string) => void
}

function detectArtifact(text: string): { type: 'code' | 'markdown' | 'html' | 'svg'; content: string; title: string } | null {
  const codeBlockRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = codeBlockRe.exec(text)) !== null) {
    const lang = (match[1] || '').trim().toLowerCase()
    const content = match[2]
    const lines = content.split('\n').length
    if (lines >= 15) {
      // html / svg fences (or html-looking content) become LIVE-renderable artifacts.
      const looksSvg = lang === 'svg' || /^\s*<svg[\s>]/i.test(content)
      const looksHtml = lang === 'html' || /^\s*(<!doctype html|<html[\s>])/i.test(content)
      if (looksSvg) return { type: 'svg', content, title: 'SVG ছবি' }
      if (looksHtml) return { type: 'html', content, title: 'HTML প্রিভিউ' }
      return { type: 'code', content, title: lang ? `${lang} কোড` : 'কোড' }
    }
  }
  if (text.length >= 800 && (text.includes('##') || text.includes('**'))) {
    const firstHeading = text.match(/#{1,3} (.+)/)?.[1] ?? 'ডকুমেন্ট'
    return { type: 'markdown', content: text, title: firstHeading }
  }
  return null
}

/**
 * Chat image thumbnail that ALWAYS resolves a real source — Claude.ai-style.
 * Live sends pass a local blob `previewUrl`; persisted/reloaded messages carry only
 * the storage `path`, so we fetch a short-lived signed URL on mount (the old code
 * left `src=""`, so reloaded images — and live ones once the poll replaced the
 * optimistic message — went blank). Click opens a full-size lightbox; shows a
 * shimmer while loading and a placeholder if the image can't be fetched.
 */
function ChatImage({ previewUrl, path }: { previewUrl?: string; path?: string }) {
  const [src, setSrc] = useState<string | null>(previewUrl || null)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    if (previewUrl) { setSrc(previewUrl); return }
    if (!path) { setFailed(true); return }
    let active = true
    setFailed(false)
    fetch(`/api/assistant/files?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { url?: string }) => { if (active && j.url) setSrc(j.url) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [previewUrl, path])

  if (failed) {
    return (
      <div className="flex h-20 w-20 flex-col items-center justify-center rounded-2xl border border-border-subtle bg-white/[0.04] text-[9px] text-muted">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
        <span className="mt-0.5">ছবি নেই</span>
      </div>
    )
  }
  if (!src) {
    return <div className="h-20 w-20 animate-pulse rounded-2xl border border-border-subtle bg-white/[0.06]" aria-hidden />
  }
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src} alt="" decoding="async" loading="lazy"
        onClick={() => setZoom(true)}
        className="h-20 w-20 cursor-zoom-in rounded-2xl border border-border-subtle object-cover transition-opacity hover:opacity-90"
      />
      <AnimatePresence>
        {zoom && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setZoom(false)}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <motion.img
              src={src} alt=""
              initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.94 }}
              transition={{ duration: 0.15 }}
              className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** Strip lightweight markdown markers so a headline reads as plain prose. */
function stripThoughtMd(s: string): string {
  return s
    .replace(/^#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/^[-*•]\s+/, '')
    .trim()
}

type ThoughtStep = { headline: string; detail: string }

/**
 * Parse Claude's extended-thinking trace into a sequence of collapsible steps,
 * mirroring Claude.ai's "thinking" timeline (a vertical list of short headlines,
 * each expandable to its full detail). Heuristic: prefer markdown headers / bold
 * leads as step boundaries, otherwise fall back to blank-line paragraphs, then to
 * single lines so a header-less blob still breaks into a few readable steps.
 */
function parseThoughtSteps(thinking: string): ThoughtStep[] {
  const text = thinking.trim()
  if (!text) return []

  let blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  // One long paragraph with no blank lines → split on single newlines instead.
  if (blocks.length <= 1) {
    const byLine = text.split(/\n/).map((b) => b.trim()).filter(Boolean)
    if (byLine.length > 1) blocks = byLine
  }

  return blocks.map((block) => {
    const headerMatch = block.match(/^#{1,6}\s+(.+)/)
    if (headerMatch) {
      const rest = block.slice(headerMatch[0].length).trim()
      return { headline: stripThoughtMd(headerMatch[1]), detail: rest }
    }
    const boldMatch = block.match(/^\*\*(.+?)\*\*[:.।]?\s*([\s\S]*)$/)
    if (boldMatch) {
      return { headline: stripThoughtMd(boldMatch[1]), detail: (boldMatch[2] ?? '').trim() }
    }
    // First sentence (Bangla danda ।, or . ! ?) becomes the headline.
    const firstSentence = block.match(/^[\s\S]*?[।.!?](\s|$)/)?.[0]?.trim() ?? block
    const headline = firstSentence.length > 96 ? `${firstSentence.slice(0, 94).trimEnd()}…` : firstSentence
    const detail = block.length > headline.length ? block : ''
    return { headline: stripThoughtMd(headline), detail }
  })
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

/** Pretty-print a tool input object for the expandable "ইনপুট" panel. */
function formatToolInput(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'string') return input.trim() || null
  if (typeof input !== 'object') return String(input)
  try {
    const s = JSON.stringify(input, null, 2)
    return s && s !== '{}' ? s : null
  } catch {
    return null
  }
}


/**
 * Premium expandable input/result panel — shared by the unified timeline's tool
 * rows. Renders the tool's input and result in tidy, capped mono blocks (labelled
 * "ইনপুট" / "ফলাফল"), not a raw JSON dump.
 */
function ToolIODetail({ input, result, failed }: { input?: unknown; result?: string; failed: boolean }) {
  const inputStr = formatToolInput(input)
  const resultStr = result && result.trim() ? result : null
  if (!inputStr && !resultStr) return null
  return (
    <div className="mt-1.5 space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-2.5">
      {inputStr && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted/70">ইনপুট</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[11px] leading-relaxed text-cream/80 [overflow-wrap:anywhere]">{inputStr}</pre>
        </div>
      )}
      {resultStr && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted/70">
            <span>ফলাফল</span>
            <span className="font-normal lowercase opacity-50">· result</span>
          </div>
          <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[11px] leading-relaxed [overflow-wrap:anywhere] ${failed ? 'text-red-300/90' : 'text-cream/80'}`}>{resultStr}</pre>
        </div>
      )}
    </div>
  )
}

type TimelineRow =
  | { kind: 'think'; headline: string; detail: string; live: boolean }
  | { kind: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; live: boolean }

/**
 * Unified, premium Claude.ai-style activity stream. Replaces the old scattered
 * "Thought" block + separate tool chips with ONE connected card: reasoning steps
 * interleaved with tool calls in true order, each a tappable headline that expands
 * to its detail (reasoning prose, or tool input+result). Header keeps the
 * "X সেকেন্ড ধরে ভেবেছে · ~N টোকেন · M ধাপ" summary; collapses after the reply
 * begins (re-expandable), exactly like Claude's thinking panel.
 */
function ActivityTimeline({
  timeline,
  thinking,
  thinkingMs,
  toolActivity,
  live,
}: {
  timeline?: TimelineEntry[]
  thinking?: string
  thinkingMs?: number
  toolActivity?: ChatMessage['toolActivity']
  live: boolean
}) {
  const [open, setOpen] = useState(live)
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({})
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setOpen(live) }, [live])

  // Effective timeline: the persisted/live ordered stream, or — for older messages
  // that predate the timeline — a fallback assembled from thinking + tool activity.
  const entries: TimelineEntry[] = useMemo(() => {
    if (timeline && timeline.length > 0) return timeline
    const fb: TimelineEntry[] = []
    if (thinking && thinking.trim()) fb.push({ t: 'think', text: thinking })
    for (const t of toolActivity ?? []) {
      fb.push({ t: 'tool', name: t.name, ok: t.success !== false, input: t.input, result: t.result, live: !t.done })
    }
    return fb
  }, [timeline, thinking, toolActivity])

  // Flatten into display rows: each reasoning segment expands into its own headline
  // sub-steps (Claude's multi-headline feel); each tool call is one row.
  const rows: TimelineRow[] = useMemo(() => {
    const out: TimelineRow[] = []
    entries.forEach((e, i) => {
      const lastEntry = i === entries.length - 1
      if (e.t === 'think') {
        const steps = parseThoughtSteps(e.text)
        steps.forEach((s, j) =>
          out.push({ kind: 'think', headline: s.headline, detail: s.detail, live: live && lastEntry && j === steps.length - 1 }),
        )
      } else {
        out.push({ kind: 'tool', name: e.name, ok: e.ok, input: e.input, result: e.result, live: Boolean(e.live) })
      }
    })
    return out
  }, [entries, live])

  useEffect(() => {
    if (live && open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [rows.length, thinking, live, open])

  if (rows.length === 0) return null

  const seconds = thinkingMs != null ? Math.max(1, Math.round(thinkingMs / 1000)) : null
  const baseSrc = (thinking ?? entries.filter((e) => e.t === 'think').map((e) => (e as { text: string }).text).join('\n')).trim()
  const tokenEst = baseSrc ? Math.max(1, Math.round(baseSrc.length / 4)) : 0
  const timeLabel = live ? 'কাজ করছি…' : seconds != null ? `${seconds} সেকেন্ড ধরে ভেবেছে` : 'কাজের ধাপ'
  const header = tokenEst > 0 ? `${timeLabel} · ~${fmtTok(tokenEst)} টোকেন` : timeLabel

  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-card/50 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium text-muted transition-colors hover:text-muted-hi"
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
        <span>{header}</span>
        <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[10px] tabular-nums text-muted">{rows.length} ধাপ</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
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
            <div ref={bodyRef} className="max-h-[420px] overflow-y-auto px-3 pb-3 pt-0.5">
              <div className="flex flex-col">
                {rows.map((row, i) => {
                  const isOpen = openRows[i] ?? false
                  const isLast = i === rows.length - 1
                  const d = row.kind === 'tool' ? toolDisplay(row.name) : null
                  const target = row.kind === 'tool' ? toolDetail(row.name, row.input) : null
                  const hasDetail =
                    row.kind === 'think'
                      ? row.detail.trim().length > 0
                      : Boolean(formatToolInput(row.input) || (row.result && row.result.trim()))
                  const failed = row.kind === 'tool' && row.ok === false
                  return (
                    <div key={i} className="relative pl-6">
                      {/* connector down to next node */}
                      {!isLast && <span className="absolute left-[7px] top-[20px] bottom-0 w-px bg-white/[0.08]" aria-hidden />}
                      {/* node */}
                      <span className="absolute left-0 top-[7px] flex h-[15px] w-[15px] items-center justify-center" aria-hidden>
                        {row.live ? (
                          <motion.span
                            className="h-[10px] w-[10px] rounded-full border-[1.5px] border-[#E07A5F]/40 border-t-[#E07A5F]"
                            animate={{ rotate: 360 }}
                            transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                          />
                        ) : row.kind === 'tool' ? (
                          failed ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                          )
                        ) : (
                          <span className="h-[7px] w-[7px] rounded-full bg-[#E07A5F]/60" />
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => hasDetail && setOpenRows((s) => ({ ...s, [i]: !s[i] }))}
                        className={`group flex w-full items-start gap-1.5 py-1.5 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        <span className="min-w-0 flex-1 text-[12.5px] leading-snug break-words [overflow-wrap:anywhere]">
                          {row.kind === 'tool' ? (
                            <span className="text-muted-hi group-hover:text-cream">
                              <span className="mr-1">{d?.icon}</span>
                              {d?.label}
                              {target && <span className="text-muted"> · {target}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-hi group-hover:text-cream">{row.headline}</span>
                          )}
                        </span>
                        {hasDetail && (
                          <svg
                            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            strokeLinecap="round" strokeLinejoin="round"
                            className={`mt-[4px] shrink-0 text-muted transition-transform ${isOpen ? 'rotate-90' : ''}`}
                            aria-hidden
                          >
                            <path d="M9 6l6 6-6 6" />
                          </svg>
                        )}
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && hasDetail && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="overflow-hidden"
                          >
                            {row.kind === 'think' ? (
                              <div className="pb-2 pr-1 text-[12.5px] leading-relaxed text-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                                {row.detail}
                              </div>
                            ) : (
                              <div className="pb-2">
                                <ToolIODetail input={row.input} result={row.result} failed={failed} />
                              </div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Model-upgrade approval card. The router wants a stronger (paid) model for this
 * question; the owner approves or keeps the cheap one. Bangla, "Sir" tone.
 */
function AgentModelSwitchCard({
  card,
  onResolve,
}: {
  card: { toLabel: string; fromLabel: string; fallbackModelId: string }
  onResolve: (opts: { approve: boolean; rememberChoice?: boolean; fallbackModelId?: string }) => void
}) {
  const [remember, setRemember] = useState(false)
  const [resolved, setResolved] = useState<null | 'yes' | 'no'>(null)

  return (
    <div className="mt-3 rounded-xl border border-[#E07A5F]/30 bg-[#E07A5F]/[0.06] p-3">
      <div className="flex items-start gap-2">
        <span aria-hidden className="text-base leading-none">🧠</span>
        <div className="text-[13px] leading-snug text-muted-hi">
          এই প্রশ্নটার জন্য শক্তিশালী মডেল <b>{card.toLabel}</b> দরকার (এখন চলছে{' '}
          <b>{card.fromLabel}</b>)। এটা একটু বেশি খরচ — চালাবো, স্যার?
        </div>
      </div>

      {resolved ? (
        <div className="mt-2 text-[12px] text-muted">
          {resolved === 'yes' ? `✅ ${card.toLabel}-এ চালানো হচ্ছে…` : `⚡ ${card.fromLabel}-এ রাখা হলো।`}
        </div>
      ) : (
        <>
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#E07A5F]"
            />
            এই চ্যাটে আর জিজ্ঞেস কোরো না
          </label>
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => {
                setResolved('yes')
                onResolve({ approve: true, rememberChoice: remember })
              }}
              className="rounded-lg bg-[#E07A5F] px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:bg-[#d36a4f]"
            >
              হ্যাঁ, চালাও
            </button>
            <button
              onClick={() => {
                setResolved('no')
                onResolve({ approve: false, fallbackModelId: card.fallbackModelId })
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi"
            >
              না, সস্তাতেই থাক
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function AgentThread({ messages, onArtifactSave, conversationId, onArtifactOpen, onActionApproved, onQuickSend, onModelSwitchResolve, onStartVoiceSession, streamMode, streamVariant, compacting, homePanel, planDrive, onPlanDriveAction, onPlanDriveOpen }: AgentThreadProps) {
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
  // Plan-Drive rows that belong to THIS conversation render inline in its turn.
  // In the office-shift thread we also surface autonomous follow-ups (plans with
  // no owner conversation — e.g. promoted stuck todos), so they never hide.
  const inlineDrives = useMemo(() => {
    const all = planDrive?.drives ?? []
    return all.filter((d) =>
      d.conversationId === conversationId || (isOfficeShift && d.conversationId == null),
    )
  }, [planDrive, conversationId, isOfficeShift])
  const streamingMessage = messages.find((m) => m.streaming)

  // Two light haptics per turn (Claude-app style on phone), NOT a continuous buzz:
  //   • one when the agent STARTS working  (not-streaming → streaming)
  //   • one when the agent FINISHES a reply (streaming → done)
  // The "working" phase itself is silent — the animation conveys progress.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const isStreaming = Boolean(streamingMessage)
    if (!wasStreamingRef.current && isStreaming) {
      // Agent just picked up the message and began working → single start tap.
      agentReplyHaptic()
    } else if (wasStreamingRef.current && !isStreaming) {
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
        {/* Plan-Drive autonomous follow-ups in the office thread — inline accordions
            (separate from the daily dock above), same Claude-Code step style. */}
        {isOfficeShift && (
          <PlanDriveInlineTurn
            drives={inlineDrives}
            onAction={onPlanDriveAction}
            onOpenConversation={onPlanDriveOpen}
          />
        )}

        {messages.length === 0 && (
          <>
            {homePanel && <div className="mb-6">{homePanel}</div>}
            <AgentEmptyState onSuggestion={onQuickSend} onStartVoiceSession={onStartVoiceSession} />
          </>
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
                            <ChatImage key={i} previewUrl={f.previewUrl} path={f.path} />
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
                      <div className="rounded-2xl rounded-br-sm bg-gradient-to-br from-[#E07A5F] to-[#C45A3C] px-4 py-3 text-[15px] leading-relaxed text-white shadow-sm shadow-[#E07A5F]/20 whitespace-pre-wrap break-words select-text">
                        <CollapsibleMessage collapsedMaxPx={260}>{msg.text}</CollapsibleMessage>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant message — full-width, dark text on light bg */
                <div className="min-w-0">
                  {(msg.timeline?.length || msg.thinking || (msg.toolActivity && msg.toolActivity.length > 0)) && (
                    <ActivityTimeline
                      timeline={msg.timeline}
                      thinking={msg.thinking}
                      thinkingMs={msg.thinkingMs}
                      toolActivity={msg.toolActivity}
                      live={Boolean(msg.streaming) && !msg.text}
                    />
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

                  {/* Plan-Drive — inline accordion(s) for this conversation, attached
                      to the last assistant turn (Claude-Code "headline → expand" feel). */}
                  {!isOfficeShift && msg.role === 'assistant' && msg.id === messages[messages.length - 1]?.id && (
                    <PlanDriveInlineTurn
                      drives={inlineDrives}
                      onAction={onPlanDriveAction}
                      onOpenConversation={onPlanDriveOpen}
                    />
                  )}

                  {(!msg.streaming || msg.text) && (
                    <div className="text-[15px] leading-[1.7] text-cream select-text break-words [overflow-wrap:anywhere]">
                      {msg.streaming && msg.text ? (
                        <div className="relative alma-stream-reveal">
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

                  {msg.modelSwitch && onModelSwitchResolve && (
                    <AgentModelSwitchCard
                      card={msg.modelSwitch}
                      onResolve={onModelSwitchResolve}
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

    </div>
  )
}
