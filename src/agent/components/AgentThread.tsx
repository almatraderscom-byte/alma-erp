'use client'

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import { type PendingAction } from './AgentConfirmCard'
import AgentConfirmCardGroup from './AgentConfirmCardGroup'
import AgentAskCard, { type AskCard } from './AgentAskCard'
import { JamaatQuickReply } from './JamaatQuickReply'
import AgentOpenTasksChip from './AgentOpenTasksChip'
import type { Artifact } from './AgentArtifactsPanel'
import toast from 'react-hot-toast'
import AgentEmptyState from './AgentEmptyState'
import { RelativeTime } from './RelativeTime'
import { useAgentTodosOptional } from './AgentTodoContext'
import { OfficeShiftThreadRenderer } from './OfficeShiftThreadBlocks'
import { PlanDriveInlineTurn } from './monitor/PlanDriveInlineTurn'
import type { PlanDrivePanelData, PlanDriveAction } from './monitor/PlanDriveTimeline'
import { AgentThinkingIndicator, ModelSpinner, type ModelVariant, type ThinkingMode } from './AgentThinkingIndicator'
import { toolDisplay, toolDetail } from '@/agent/lib/tool-labels'
import { GlassSheet, GlassSheetGrip } from '@/components/ui/GlassSheet'
import { agentReplyHaptic } from '@/agent/lib/haptics'
import { impactLight, selection } from '@/lib/haptics'
import { isHeartbeatWakeText } from '@/agent/lib/heartbeat/wake-marker'

/**
 * Inline "ALMA woke on its own" divider — the Claude-Code ScheduleWakeup look.
 * The autonomous heartbeat seeds a hidden directive (a user-role message) into the
 * owner's open chat so the head has something to react to; we never want that to
 * render as a fake owner pill, so it collapses to this small centered marker and
 * the head's real turn renders normally right below it.
 */
function HeartbeatWakeDivider() {
  return (
    <div className="my-1 flex items-center justify-center gap-2.5">
      <span className="h-px flex-1 bg-border-subtle" aria-hidden />
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#E07A5F]/25 bg-[#E07A5F]/[0.06] px-3 py-1 text-[11px] font-medium text-[#E07A5F]/90">
        <span aria-hidden style={{ fontVariantEmoji: 'text' as const }}>💓</span>
        ALMA নিজে থেকে জাগল
      </span>
      <span className="h-px flex-1 bg-border-subtle" aria-hidden />
    </div>
  )
}

/** Compact token formatter: 36100 → "36.1k", 681 → "681". */
function fmtTok(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString()
}

/** One entry in the unified activity timeline — a reasoning segment or a tool call. */
export type TimelineEntry =
  | { t: 'think'; text: string }
  /** `superseded`: verification rewrote this draft. It remains audit data and is
   *  never rendered as a separate owner-facing reply. */
  | { t: 'text'; text: string; state?: 'superseded' }
  /** The honesty guard re-checked the draft — rendered as activity, not prose. */
  | { t: 'verify'; attempt?: number; max?: number }
  | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; live?: boolean; id?: string; shot?: string }
  | { t: 'file'; id: string; name: string; kind?: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: Array<{ previewUrl: string; mediaType: string; path?: string }>
  toolActivity?: Array<{ id: string; name: string; done: boolean; success?: boolean; stopped?: boolean; input?: unknown; result?: string; screenshot?: string }>
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
  pendingActions?: PendingAction[]
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
  /** Provider API calls in this reply — one per tool round (= rows on the OpenRouter Logs page). */
  apiRounds?: number
  /** Per-round billed cost (USD) when the provider reported actuals. */
  roundCostsUsd?: number[]
  streaming?: boolean
  /** True when the honesty guard caught a false completion claim and the agent rewrote its answer. */
  selfCorrected?: boolean
  /** ISO timestamp — drives the Claude-app-style "৬ মিনিট আগে" label under each message. */
  createdAt?: string
}

interface AgentThreadProps {
  messages: ChatMessage[]
  onArtifactSave: (artifact: Omit<Artifact, 'id' | 'createdAt'>) => void
  conversationId: string | null
  /** Open the artifacts panel; pass an artifact id to focus that file. */
  onArtifactOpen: (id?: string) => void
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
  // A local blob preview is instant but dies when the composer revokes it; the
  // durable fallback is a signed URL from `path`. Resolve it lazily — on mount
  // when there's no blob, or via the <img> onError when a blob goes stale — and
  // only once, so a genuinely missing object settles on the placeholder.
  const triedPath = useRef(false)

  const resolveFromPath = useCallback(() => {
    if (!path || triedPath.current) { setFailed(true); return }
    triedPath.current = true
    fetch(`/api/assistant/files?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { url?: string }) => {
        if (j.url) { setSrc(j.url); setFailed(false) } else setFailed(true)
      })
      .catch(() => setFailed(true))
  }, [path])

  useEffect(() => {
    if (previewUrl) { setSrc(previewUrl); return }
    resolveFromPath()
  }, [previewUrl, resolveFromPath])

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
        onError={() => { setSrc(null); resolveFromPath() }}
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
        onClick={() => { if (hasSummary) { selection(); setOpen((o) => !o) } }}
        className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-all ${hasSummary ? 'cursor-pointer hover:bg-white/[0.02] active:bg-white/[0.04] active:scale-[0.99]' : 'cursor-default'}`}
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        impactLight()
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="rounded-lg p-1.5 text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi active:scale-90"
      title={copied ? 'কপি হয়েছে' : 'কপি করুন'}
    >
      {copied ? (
        <motion.span
          initial={{ scale: 0.5 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 22 }}
          className="block"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </motion.span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      )}
    </button>
  )
}

// Roadmap Phase 1 — one-tap owner corrections. Each tap files a row in
// agent_owner_feedback linked to this conversation/message (the server resolves
// the producing turn + its behavior-artifact versions), so "ভুল টুল" reports
// become traceable incidents instead of chat lore.
const FEEDBACK_OPTIONS: { kind: string; label: string }[] = [
  { kind: 'wrong_tool', label: 'ভুল টুল' },
  { kind: 'lost_progress', label: 'কাজ হারিয়ে ফেলেছে' },
  { kind: 'unnecessary_navigation', label: 'অকারণ ঘোরাঘুরি' },
  { kind: 'wrong_answer', label: 'ভুল উত্তর' },
  { kind: 'too_many_questions', label: 'বেশি প্রশ্ন' },
]

function FeedbackButtons({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)

  function send(kind: string) {
    impactLight()
    setSent(true)
    setOpen(false)
    void fetch('/api/assistant/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, conversationId, messageId }),
    }).catch(() => {
      // best-effort — feedback must never break the chat
    })
  }

  if (sent) return <span className="px-1.5 text-[10px] text-emerald-600/80">✓ নোট করেছি</span>

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        onClick={() => send('good')}
        className="rounded-lg p-1.5 text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi active:scale-90"
        title="ভালো উত্তর"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>
      </button>
      <button
        onClick={() => { impactLight(); setOpen((v) => !v) }}
        className={`rounded-lg p-1.5 transition-all hover:bg-white/[0.05] hover:text-muted-hi active:scale-90 ${open ? 'text-[#E07A5F]' : 'text-muted'}`}
        title="সমস্যা জানাও"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3zm7-13h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>
      </button>
      {open && (
        <span className="ml-1 inline-flex flex-wrap items-center gap-1">
          {FEEDBACK_OPTIONS.map((o) => (
            <button
              key={o.kind}
              onClick={() => send(o.kind)}
              className="rounded-full border border-border-subtle bg-card/60 px-2 py-0.5 text-[10px] text-muted transition-all hover:border-[#E07A5F]/40 hover:text-muted-hi active:scale-95"
            >
              {o.label}
            </button>
          ))}
        </span>
      )}
    </span>
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
      onClick={() => { impactLight(); void speak() }}
      disabled={loading}
      data-message-id={messageId}
      className={`rounded-lg p-1.5 transition-all active:scale-90 disabled:opacity-50 ${playing ? 'bg-[#E07A5F]/10 text-[#E07A5F]' : 'text-muted hover:bg-white/[0.05] hover:text-muted-hi'}`}
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
          onClick={() => { selection(); setExpanded((e) => !e) }}
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-[#E07A5F]/80 transition-all hover:text-[#E07A5F] active:scale-95"
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


/** Multi-pointed sparkle (4-point star) — the icon that shimmers/pulses on the
 *  live "Running" tool row and grows on the completed "Ran …" status line. */
function SparkleGlyph({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 0c.4 5.7 2.3 9.6 12 12-9.7 2.4-11.6 6.3-12 12-.4-5.7-2.3-9.6-12-12C9.7 9.6 11.6 5.7 12 0z" />
    </svg>
  )
}

/**
 * Claude-Code "Bash"-style floating I/O sheet. Tapping a tool row (or its
 * trigger icon) lifts the shared Floating Liquid Glass panel with the tool's
 * Input (Command) and Output — spring-risen (stiffness 300 / damping 30),
 * frosted blur(20px), instead of an inline accordion.
 */
function ToolIOSheet({ tool, onClose }: { tool: ToolRow | null; onClose: () => void }) {
  // Retain the last tool so the content stays intact through the exit glide.
  const [shown, setShown] = useState<ToolRow | null>(tool)
  useEffect(() => {
    if (tool) setShown(tool)
  }, [tool])
  const t = tool ?? shown
  const d = t ? toolDisplay(t.name) : null
  const inputStr = t ? formatToolInput(t.input) : null
  const resultStr = t && t.result && t.result.trim() ? t.result : null
  const failed = t ? t.ok === false : false
  return (
    <GlassSheet open={!!tool} onClose={onClose} ariaLabel="টুল বিস্তারিত">
      <GlassSheetGrip />
        <div className="mobile-modal-header flex items-center gap-2 px-5 pb-2.5 pt-1">
          <span className="text-base" aria-hidden>{d?.icon ?? '🔧'}</span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-cream">{d?.label ?? t?.name}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${failed ? 'tone-red' : 'tone-green'}`}>
            {failed ? 'ব্যর্থ' : 'সম্পন্ন'}
          </span>
          <button type="button" onClick={onClose} aria-label="বন্ধ করুন"
            className="rounded-full p-1.5 text-muted transition-colors hover:bg-white/[0.06] hover:text-cream">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="mobile-modal-body space-y-3 px-5 pb-5 pt-1">
          {t?.shot && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted/70">স্ক্রিনশট · screenshot</div>
              <a href={t.shot} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-white/[0.08]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.shot} alt="ব্রাউজার স্ক্রিনশট" className="w-full" />
              </a>
            </div>
          )}
          {inputStr && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted/70">ইনপুট · input</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-black/25 p-3 text-[12px] leading-relaxed text-cream/85 [overflow-wrap:anywhere]">{inputStr}</pre>
            </div>
          )}
          {resultStr && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted/70">ফলাফল · output</div>
              <pre className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-black/25 p-3 text-[12px] leading-relaxed [overflow-wrap:anywhere] ${failed ? 'text-red-300/90' : 'text-cream/85'}`}>{resultStr}</pre>
            </div>
          )}
          {!inputStr && !resultStr && !t?.shot && (
            <p className="py-6 text-center text-[12px] text-muted">এই টুলের কোনো ইনপুট/ফলাফল নেই।</p>
          )}
        </div>
    </GlassSheet>
  )
}

type ToolRow = { name: string; ok: boolean; input?: unknown; result?: string; live: boolean; shot?: string }

/**
 * A work "phase": a clear headline (what the agent is doing, in its own words —
 * drawn from the reasoning that leads into the step) plus the batch of tool calls
 * that carried it out. Reasoning prose sits behind the headline; the tools fold
 * into one collapsed pill. This is the Claude-Code shape the owner asked for.
 */
type Phase = { headline: string; detail: string; tools: ToolRow[]; live: boolean }

/**
 * Chronological turn flow — reply text and step-groups interleaved in TRUE
 * execution order (owner ask 2026-07-11: the "shuru korchi" message first, the
 * steps it triggered BELOW it — native-app parity). Used whenever the timeline
 * carries text segments; older messages keep the classic steps-then-text card.
 */
/** Claude-style FILE CARD — a tool filed a document as an artifact; tap to open it. */
function ArtifactFileCard({ entry, onOpen }: { entry: Extract<TimelineEntry, { t: 'file' }>; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.id)}
      className="mb-3 flex w-full max-w-md items-center gap-3 rounded-2xl border border-white/[0.08] bg-card/80 px-4 py-3 text-left backdrop-blur-md transition-all hover:border-gold-dim/40 hover:bg-gold/5 hover:shadow-[0_0_14px_rgba(201,168,76,0.12)]"
    >
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-gold-dim/30 bg-gold/10 text-base">📄</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-cream">{entry.name}</span>
        <span className="block text-[11px] text-muted">
          {(entry.kind ?? 'markdown') === 'markdown' ? 'ডকুমেন্ট' : entry.kind} · খুলতে চাপুন
        </span>
      </span>
      <span className="flex-shrink-0 text-[11px] font-semibold text-gold-lt">খুলুন ›</span>
    </button>
  )
}

function ChronoFlow({ msg, onOpenFile }: { msg: ChatMessage; onOpenFile: (id: string) => void }) {
  type Seg =
    | { kind: 'steps'; entries: TimelineEntry[] }
    | { kind: 'text'; text: string }
    | { kind: 'file'; entry: Extract<TimelineEntry, { t: 'file' }> }
  const segments = useMemo(() => {
    const segs: Seg[] = []
    for (const e of msg.timeline ?? []) {
      // Timeline prose is retained for audit/debug only. Rendering every model
      // round here made one turn look like several assistant replies.
      if (e.t === 'text') continue
      if (e.t === 'file') {
        segs.push({ kind: 'file', entry: e })
      } else {
        const last = segs[segs.length - 1]
        if (last && last.kind === 'steps') last.entries.push(e)
        else segs.push({ kind: 'steps', entries: [e] })
      }
    }
    if (msg.text.trim()) segs.push({ kind: 'text', text: msg.text })
    return segs
  }, [msg.text, msg.timeline])

  if (segments.length === 0) return null
  const lastIdx = segments.length - 1
  return (
    <div className="flex flex-col">
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <div
            key={i}
            className="mb-3 text-[15px] leading-[1.7] text-cream select-text break-words [overflow-wrap:anywhere]"
          >
            <AgentMarkdown content={seg.text} />
            {msg.streaming && i === lastIdx && (
              <motion.span
                className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] rounded-full bg-[#E07A5F]/60"
                animate={{ opacity: [1, 0, 1] }}
                transition={{ duration: 0.8, repeat: Infinity, ease: 'steps(2)' }}
                aria-hidden
              />
            )}
          </div>
        ) : seg.kind === 'file' ? (
          <ArtifactFileCard key={i} entry={seg.entry} onOpen={onOpenFile} />
        ) : (
          <ActivityTimeline
            key={i}
            timeline={seg.entries}
            thinkingMs={i === 0 ? msg.thinkingMs : undefined}
            live={Boolean(msg.streaming) && i === lastIdx}
          />
        ),
      )}
    </div>
  )
}

/**
 * Claude-Code-style activity stream (3-level, theme-aware).
 *
 * Top: a slim pinned summary (thinking time + ~token estimate + phase count).
 * Body: a vertical list of PHASES. Each phase shows —
 *   1. a bold, high-contrast HEADLINE (text-cream = dark ink in light mode,
 *      near-white in dark mode) — the actual work being done; tap to reveal the
 *      full reasoning prose (muted, secondary);
 *   2. beneath it, one collapsed "Nটি টুল ব্যবহার হয়েছে ›" pill — even 5–10 tools
 *      stay folded behind this single pill;
 *   3. expand the pill → each tool as its own row → expand a row → its input/output.
 * The headline reads loud and clear; everything below it is deliberately quieter.
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
  // Independent collapse state, keyed by role+index (h=headline detail,
  // g=tools pill, t=individual tool). Everything starts collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (k: string) => setOpen((s) => ({ ...s, [k]: !s[k] }))
  // Tapped tool → its I/O opens in the floating liquid-glass sheet (not inline).
  const [ioSheet, setIoSheet] = useState<ToolRow | null>(null)

  // Effective timeline: the persisted/live ordered stream, or — for older messages
  // that predate the timeline — a fallback assembled from thinking + tool activity.
  const entries: TimelineEntry[] = useMemo(() => {
    if (timeline && timeline.length > 0) return timeline.filter((e) => e.t !== 'text' && e.t !== 'file')
    const fb: TimelineEntry[] = []
    if (thinking && thinking.trim()) fb.push({ t: 'think', text: thinking })
    for (const t of toolActivity ?? []) {
      fb.push({ t: 'tool', name: t.name, ok: t.success !== false, input: t.input, result: t.result, live: !t.done, shot: t.screenshot })
    }
    return fb
  }, [timeline, thinking, toolActivity])

  // Fold the ordered stream into phases: the reasoning that precedes a tool batch
  // becomes that batch's headline; a fresh reasoning block after tools opens a new
  // phase. Consecutive reasoning blocks (before any tool) merge, keeping the latest
  // intent line as the headline.
  const phases: Phase[] = useMemo(() => {
    const out: Phase[] = []
    let cur: Phase | null = null
    entries.forEach((e, i) => {
      const lastEntry = i === entries.length - 1
      if (e.t === 'think' || e.t === 'verify') {
        // A persisted verification event renders as a truthful activity row with
        // the same label the live stream showed. Superseded prose remains only in
        // raw audit data and is not rendered as another reply.
        const raw = e.t === 'verify'
          ? `নিজের উত্তর যাচাই করে ঠিক করে নিচ্ছি (${e.attempt ?? 1}/${e.max ?? e.attempt ?? 1})…`
          : e.text
        const steps = e.t === 'verify' ? [] : parseThoughtSteps(raw)
        const headline = steps.length ? steps[steps.length - 1].headline : raw.trim().slice(0, 140)
        const detail = raw.trim()
        if (cur && cur.tools.length > 0) { out.push(cur); cur = null }
        if (!cur) cur = { headline, detail, tools: [], live: live && lastEntry }
        else {
          cur.detail = cur.detail ? `${cur.detail}\n\n${detail}` : detail
          cur.headline = headline
          if (live && lastEntry) cur.live = true
        }
      } else if (e.t === 'tool') {
        if (!cur) cur = { headline: '', detail: '', tools: [], live: false }
        const tool: ToolRow = { name: e.name, ok: e.ok, input: e.input, result: e.result, live: Boolean(e.live), shot: e.shot }
        cur.tools.push(tool)
        if (tool.live) cur.live = true
      }
    })
    if (cur) out.push(cur)
    return out
  }, [entries, live])

  if (phases.length === 0) return null

  const seconds = thinkingMs != null ? Math.max(1, Math.round(thinkingMs / 1000)) : null
  const baseSrc = (thinking ?? entries.filter((e) => e.t === 'think').map((e) => (e as { text: string }).text).join('\n')).trim()
  const tokenEst = baseSrc ? Math.max(1, Math.round(baseSrc.length / 4)) : 0
  const timeLabel = live ? 'কাজ করছি…' : seconds != null ? `${seconds} সেকেন্ড ধরে ভেবেছে` : 'কাজের ধাপ'
  const summary = tokenEst > 0 ? `${timeLabel} · ~${fmtTok(tokenEst)} টোকেন` : timeLabel

  return (
    <div className="mb-3">
      {/* Pinned summary line — stays on top (owner keeps this). */}
      <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[11.5px] font-medium text-muted">
        {live ? (
          <motion.span
            className="inline-block h-3 w-3 rounded-full border-[1.5px] border-gold/40 border-t-gold"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
            aria-hidden
          />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2a7 7 0 00-4 12.74V17a2 2 0 002 2h4a2 2 0 002-2v-2.26A7 7 0 0012 2z" />
            <path d="M9 21h6" />
          </svg>
        )}
        <span>{summary}</span>
        <span className="rounded-full bg-muted/10 px-1.5 py-px text-[10px] tabular-nums text-muted/80">{phases.length} ধাপ</span>
      </div>

      {/* Phases: bold headline → collapsed tool pill → tool → input/output. */}
      <div className="flex flex-col">
        {phases.map((p, i) => {
          const isLast = i === phases.length - 1
          const headline = p.headline || (p.tools[0] ? toolDisplay(p.tools[0].name).label : 'কাজ করছি')
          const hasDetail = p.detail.trim().length > 0 && p.detail.trim() !== p.headline.trim()
          const headOpen = open[`h${i}`] ?? false
          const toolsOpen = open[`g${i}`] ?? (p.live && isLast) // show live activity; collapse when done
          const anyFailed = p.tools.some((t) => t.ok === false)
          return (
            <div key={i} className="relative pl-6">
              {/* left rail connecting phases */}
              {!isLast && <span className="absolute left-[8px] top-6 bottom-0 w-px bg-muted/15" aria-hidden />}
              {/* phase node */}
              <span className="absolute left-[3px] top-[6px] flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
                {p.live ? (
                  <motion.span
                    className="h-[9px] w-[9px] rounded-full border-[1.5px] border-gold/40 border-t-gold"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                  />
                ) : anyFailed ? (
                  <span className="h-[8px] w-[8px] rounded-full bg-danger" />
                ) : (
                  <span className="h-[8px] w-[8px] rounded-full bg-gold shadow-[0_0_0_3px_rgb(var(--c-accent)/0.12)]" />
                )}
              </span>

              {/* 1 — HEADLINE (loud, theme-aware). Tap to reveal reasoning. */}
              <button
                type="button"
                onClick={() => { if (hasDetail) { selection(); toggle(`h${i}`) } }}
                className={`group flex w-full items-start gap-1.5 py-1 text-left transition-transform ${hasDetail ? 'cursor-pointer active:scale-[0.99]' : 'cursor-default'}`}
              >
                <span className="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-cream break-words [overflow-wrap:anywhere]">
                  {headline}
                </span>
                {hasDetail && (
                  <svg
                    width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round"
                    className={`mt-[5px] shrink-0 text-muted/60 transition-transform ${headOpen ? 'rotate-90' : ''}`}
                    aria-hidden
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                )}
              </button>
              <AnimatePresence initial={false}>
                {headOpen && hasDetail && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="mb-1 mt-0.5 border-l-2 border-muted/15 pb-1 pl-2.5 pr-1 text-[12px] leading-relaxed text-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {p.detail}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Part-3 "Ran …" beat: while this phase is still live but its last
                  tool just finished, show a bright sweeping "সম্পন্ন · <tool>" line
                  with a BIGGER pulsing sparkle — the owner's completed-state accent. */}
              {p.live && isLast && !p.tools.some((t) => t.live) && p.tools.length > 0 && (
                <div className="mb-1.5 mt-0.5 flex items-center gap-1.5">
                  <SparkleGlyph className="alma-sparkle-pulse text-gold" size={17} />
                  <span className="alma-run-shimmer text-[12.5px] font-semibold tracking-[-0.01em]">
                    সম্পন্ন · {toolDisplay(p.tools[p.tools.length - 1].name).label}
                  </span>
                </div>
              )}

              {/* 2 — TOOL PILL (quiet, secondary). One pill for the whole batch. */}
              {p.tools.length > 0 && (
                <div className="mb-1.5 mt-0.5">
                  <button
                    type="button"
                    onClick={() => { selection(); toggle(`g${i}`) }}
                    className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle bg-card/60 px-2.5 py-1 text-[11.5px] text-muted transition-all hover:text-muted-hi active:scale-[0.97] active:bg-white/[0.04]"
                  >
                    <span aria-hidden className="text-[11px]">🔧</span>
                    <span className="truncate tabular-nums">
                      {p.tools.length}টি টুল ব্যবহার হয়েছে
                    </span>
                    {anyFailed && !p.live && <span className="text-danger" aria-hidden>· ব্যর্থ</span>}
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round"
                      className={`shrink-0 text-muted/60 transition-transform ${toolsOpen ? 'rotate-90' : ''}`}
                      aria-hidden
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                  <AnimatePresence initial={false}>
                    {toolsOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-1.5 flex flex-col gap-1">
                          {p.tools.map((t, j) => {
                            const d = toolDisplay(t.name)
                            const target = toolDetail(t.name, t.input)
                            const failed = t.ok === false
                            const hasIO = Boolean(formatToolInput(t.input) || (t.result && t.result.trim()) || t.shot)
                            return (
                              <div key={j} className="rounded-lg border border-border-subtle bg-card/40">
                                {/* 3 — tool row; tap opens the floating I/O sheet */}
                                <button
                                  type="button"
                                  onClick={() => { if (hasIO) { selection(); setIoSheet(t) } }}
                                  className={`group/tool flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12px] leading-snug transition-all ${hasIO ? 'cursor-pointer active:bg-white/[0.04]' : 'cursor-default'}`}
                                >
                                  {t.live ? (
                                    <SparkleGlyph className="alma-sparkle-pulse shrink-0 text-gold" size={13} />
                                  ) : failed ? (
                                    <svg className="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12"/></svg>
                                  ) : (
                                    <svg className="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5"/></svg>
                                  )}
                                  <span className={`min-w-0 flex-1 break-words [overflow-wrap:anywhere] ${t.live ? 'alma-run-shimmer font-medium' : 'text-muted-hi'}`}>
                                    <span className="mr-1" aria-hidden>{d.icon}</span>
                                    {t.live ? 'চলছে · ' : ''}{d.label}
                                    {target && !t.live && <span className="text-muted"> · {target}</span>}
                                  </span>
                                  {/* Trigger icon — every command row carries its glass-panel
                                      trigger (expand glyph); dimmed when there's no I/O yet. */}
                                  <span
                                    className={`shrink-0 rounded-md p-1 transition-colors ${
                                      hasIO
                                        ? 'text-muted/70 group-hover/tool:bg-white/[0.06] group-hover/tool:text-cream'
                                        : 'text-muted/25'
                                    }`}
                                    aria-hidden
                                  >
                                    <svg
                                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                                      strokeLinecap="round" strokeLinejoin="round"
                                    >
                                      <path d="M15 3h6v6" />
                                      <path d="M9 21H3v-6" />
                                      <path d="M21 3l-7 7" />
                                      <path d="M3 21l7-7" />
                                    </svg>
                                  </span>
                                </button>
                                {/* NO SILENT FAILURE (owner ask 2026-07-12): a failed
                                    step shows its reason right here in the flow — not
                                    hidden behind a tap. */}
                                {failed && t.result && t.result.trim() && (
                                  <div className="mx-2 mb-1.5 rounded-md border border-danger/25 bg-danger/[0.07] px-2 py-1.5 text-[11.5px] leading-relaxed text-red-300/95 break-words [overflow-wrap:anywhere]">
                                    <span className="mr-1 font-semibold">কারণ:</span>
                                    {t.result.trim().slice(0, 260)}
                                    {t.result.trim().length > 260 ? '…' : ''}
                                  </div>
                                )}
                                {/* Live-browser screenshot INLINE — the owner sees what
                                    the agent saw, Claude-Code style, without opening
                                    the I/O sheet. Tap the image for the full view. */}
                                {t.shot && (
                                  <button
                                    type="button"
                                    onClick={() => { selection(); setIoSheet(t) }}
                                    className="mx-2 mb-2 block overflow-hidden rounded-lg border border-white/[0.08] transition-all hover:border-gold-dim/40 active:scale-[0.99]"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={t.shot}
                                      alt="ব্রাউজার স্ক্রিনশট"
                                      loading="lazy"
                                      className="max-h-56 w-full object-cover object-top"
                                    />
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Floating liquid-glass I/O sheet — opened by tapping any tool row. */}
      <ToolIOSheet tool={ioSheet} onClose={() => setIoSheet(null)} />
    </div>
  )
}

/**
 * Model-upgrade approval card. The router wants a stronger (paid) model for this
 * question; the owner approves or keeps the cheap one. Bangla, "Boss" tone.
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
          <b>{card.fromLabel}</b>)। এটা একটু বেশি খরচ — চালাবো, বস?
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
                impactLight()
                setResolved('yes')
                onResolve({ approve: true, rememberChoice: remember })
              }}
              className="rounded-lg bg-[#E07A5F] px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:bg-[#d36a4f] active:scale-95"
            >
              হ্যাঁ, চালাও
            </button>
            <button
              onClick={() => {
                impactLight()
                setResolved('no')
                onResolve({ approve: false, fallbackModelId: card.fallbackModelId })
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi active:scale-95"
            >
              না, সস্তাতেই থাক
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** The conscience-nudge jamaat/alone question — detected so we can offer the two
 *  deterministic quick-reply buttons under it (জামাত + একা + a question mark). */
function isJamaatQuestion(text?: string): boolean {
  if (!text) return false
  return /জামাত/.test(text) && /একা/.test(text) && text.includes('?')
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

  // The owner's send must ALWAYS jump the view to the bottom — even from high up
  // in a long thread. The old check looked only at the LAST message, but the send
  // path appends the user message AND the assistant streaming placeholder in the
  // same React batch, so the last message was never role='user' and the jump never
  // fired unless he was already near the bottom. Track the newest user-message id
  // instead: whenever a fresh one appears, force the jump and re-pin to bottom.
  const lastUserIdRef = useRef<string | null>(null)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    let newestUser: ChatMessage | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { newestUser = messages[i]; break }
    }
    if (newestUser && newestUser.id !== lastUserIdRef.current) {
      lastUserIdRef.current = newestUser.id
      // Only a FRESH send jumps (guard: the post-turn poll swaps optimistic ids
      // for DB ids — that must not yank the owner down if he scrolled up while
      // a long turn ran). Missing createdAt is treated as fresh.
      const sentMs = newestUser.createdAt ? Date.parse(newestUser.createdAt) : Date.now()
      if (Date.now() - sentMs < 15_000) {
        bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
        stickToBottomRef.current = true
        return
      }
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
      <div className="agent-thread-content mx-auto max-w-2xl overflow-x-hidden px-4 py-4 pb-6 md:px-6 md:py-6">
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
              initial={reduceMotion ? false : { opacity: 0, y: 12, scale: msg.role === 'user' ? 0.96 : 1 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 380, damping: 30, mass: 0.8, delay: index < 10 ? index * 0.02 : 0 }
              }
              className={msg.role === 'user' ? 'mb-6' : 'mb-8'}
            >
              {msg.role === 'user' && isHeartbeatWakeText(msg.text) ? (
                /* Autonomous heartbeat self-wake — render as an inline divider, NOT
                   a fake owner message (the directive is the head's own cue). */
                <HeartbeatWakeDivider />
              ) : msg.role === 'user' ? (
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
                      <div className="agent-bubble-press rounded-2xl rounded-br-sm bg-gradient-to-br from-[#E07A5F] to-[#C45A3C] px-4 py-3 text-[15px] leading-relaxed text-white shadow-sm shadow-[#E07A5F]/20 whitespace-pre-wrap break-words select-text">
                        <CollapsibleMessage collapsedMaxPx={260}>{msg.text}</CollapsibleMessage>
                      </div>
                    )}
                    {msg.createdAt && (
                      <div className="mt-1 text-right">
                        <RelativeTime iso={msg.createdAt} className="text-[10px] text-muted" />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Assistant message — full-width, dark text on light bg */
                <div className="min-w-0">
                  {(() => {
                    // Chronological mode: the timeline carries the reply text too, so
                    // render ONE interleaved flow (text → steps → text) and skip the
                    // separate steps-card + body blocks below.
                    const chrono = (msg.timeline ?? []).some((e) => e.t === 'text')
                    if (chrono) return <ChronoFlow msg={msg} onOpenFile={(id) => onArtifactOpen(id)} />
                    if (msg.timeline?.length || msg.thinking || (msg.toolActivity && msg.toolActivity.length > 0)) {
                      return (
                        <ActivityTimeline
                          timeline={msg.timeline}
                          thinking={msg.thinking}
                          thinkingMs={msg.thinkingMs}
                          toolActivity={msg.toolActivity}
                          live={Boolean(msg.streaming) && !msg.text}
                        />
                      )
                    }
                    return null
                  })()}

                  {/* File cards for non-chrono messages (chrono renders them in-flow). */}
                  {!(msg.timeline ?? []).some((e) => e.t === 'text') &&
                    (msg.timeline ?? []).filter((e): e is Extract<TimelineEntry, { t: 'file' }> => e.t === 'file').map((e) => (
                      <ArtifactFileCard key={e.id} entry={e} onOpen={(id) => onArtifactOpen(id)} />
                    ))}

                  {msg.delegations && msg.delegations.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {msg.delegations.map((d) => (
                        <DelegationCard key={d.id} d={d} />
                      ))}
                    </div>
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

                  {(!msg.streaming || msg.text) && !(msg.timeline ?? []).some((e) => e.t === 'text') && (
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

                  {msg.pendingActions && msg.pendingActions.length > 0 && (
                    <AgentConfirmCardGroup
                      actions={msg.pendingActions}
                      onQuickSend={onQuickSend}
                      onResolved={(status) => {
                        // Approve always posts a result note. For a delegation,
                        // Reject ALSO posts one (Sonnet's own answer), so poll then too.
                        if (status === 'approved' || msg.pendingActions?.some((a) => a.actionType === 'delegation')) {
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
                        }).then((res) => {
                          // Non-silent failure: the answer still reaches the agent via
                          // onQuickSend below, but a failed record means the durable
                          // card row stays 'pending' — log it so it's diagnosable.
                          if (!res.ok) {
                            console.warn(`[ask-card] answer POST failed (HTTP ${res.status}) for card ${msg.askCard!.id}`)
                          }
                        }).catch((err) => {
                          console.warn('[ask-card] answer POST failed:', err)
                        })
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

                  {/* Salah jamaat/alone — two deterministic (no-LLM) quick-reply
                      buttons under the conscience-nudge question, so a tap always
                      saves the answer (a free-typed reply was sometimes missed). */}
                  {!isOfficeShift && !msg.streaming && msg.role === 'assistant' &&
                    conversationId && msg.id === messages[messages.length - 1]?.id &&
                    isJamaatQuestion(msg.text) && (
                      <JamaatQuickReply conversationId={conversationId} onAnswered={onActionApproved} />
                    )}

                  {/* "বাকি কাজ" — open-loop tracker at the end of the last reply.
                      Surfaces unfinished chat tasks + pending approvals; Continue
                      resumes that exact work in this same chat from its note. */}
                  {!isOfficeShift && !msg.streaming && onQuickSend &&
                    msg.id === messages[messages.length - 1]?.id && (
                      <AgentOpenTasksChip
                        conversationId={conversationId}
                        onContinue={(note) => onQuickSend(note)}
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
                      {msg.createdAt && (
                        <RelativeTime iso={msg.createdAt} className="mr-1 text-[10px] text-muted" />
                      )}
                      <CopyButton text={msg.text} />
                      <TtsButton text={msg.text} messageId={msg.id} />
                      {conversationId && (
                        <FeedbackButtons conversationId={conversationId} messageId={msg.id} />
                      )}
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
                            {msg.costUsd != null && (
                              <span
                                className="text-[#E07A5F]/60"
                                title={
                                  msg.roundCostsUsd && msg.roundCostsUsd.length > 1
                                    ? `OpenRouter-এ ${msg.roundCostsUsd.length}টা আলাদা সারি — ধাপে ধাপে: ${msg.roundCostsUsd.map((c) => `$${c.toFixed(4)}`).join(' + ')} = $${msg.costUsd.toFixed(4)}`
                                    : undefined
                                }
                              >
                                ${msg.costUsd.toFixed(4)}
                                {(msg.apiRounds ?? 0) > 1 && ` · ${msg.apiRounds} ধাপ`}
                              </span>
                            )}
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
