/**
 * B3 — tail compaction (primary, cheap replacement for the $25 cost valve).
 *
 * A long conversation keeps the most recent turns verbatim and folds everything
 * older into a single running summary. The summary rides the STABLE/cached system
 * block, so it is written to the prompt cache ONCE per fold and stays byte-stable
 * between folds (hysteresis: trigger > keep). Old turns remain recallable via B2
 * (`retrieveRelevantOldTurns`), so folding loses precision, not the facts.
 *
 * Scope: applied on BOTH head paths — the native Claude path (core.ts) and the
 * alternate multi-provider path (run-owner-turn.ts). The alternate path used to
 * ship full history "because it has no cache-write cost", but OpenRouter heads
 * whose provider ignores our cache breakpoint (Qwen/Alibaba) re-bill the whole
 * prefix as uncached input EVERY turn — folding is the primary cost lever there.
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL } from '@/agent/config'
import { estimateTokens } from '@/agent/lib/pricing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type TailCompactConfig = {
  /** Fold when the unfolded tail exceeds this many turns (1 turn ≈ 2 messages). */
  triggerTurns: number
  /** …or when the unfolded tail is estimated to exceed this many tokens. */
  triggerTokens: number
  /** After a fold, keep this many recent turns verbatim (must be < triggerTurns). */
  keepTurns: number
}

export const TAIL_COMPACT_DEFAULTS: TailCompactConfig = {
  // Now that the owner lives in ONE long-lived unified thread (web + Telegram),
  // the verbatim tail is the dominant per-turn input cost. A tighter window folds
  // older turns into the cached summary sooner, roughly halving the worst-case
  // history shipped each turn while B2 recall keeps the older facts retrievable.
  // Hysteresis invariant preserved: keepTurns < triggerTurns.
  // Tightened 16/32k/10 → 10/20k/6 (owner cost complaint 2026-07): with NO
  // provider cache on the Qwen head and Gemini at $2/M input, even 10 verbatim
  // turns of the owner's table-heavy ads replies kept turns at ~$0.15. Six
  // recent turns is plenty for continuity; older context lives in the summary
  // and B2 recall. All three knobs stay owner-tunable via agent_kv_settings.
  triggerTurns: 10,
  triggerTokens: 20_000,
  keepTurns: 6,
}

const KEYS = {
  triggerTurns: 'agent.compact.tail.triggerTurns',
  triggerTokens: 'agent.compact.tail.triggerTokens',
  keepTurns: 'agent.compact.tail.keepTurns',
} as const

export async function getTailCompactConfig(): Promise<TailCompactConfig> {
  try {
    const rows = await prisma.agentKvSetting.findMany({ where: { key: { in: Object.values(KEYS) } } })
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const num = (k: string, fallback: number) => {
      const raw = map.get(k)
      if (raw == null) return fallback
      const v = parseInt(raw, 10)
      return Number.isFinite(v) && v > 0 ? v : fallback
    }
    const triggerTurns = num(KEYS.triggerTurns, TAIL_COMPACT_DEFAULTS.triggerTurns)
    const triggerTokens = num(KEYS.triggerTokens, TAIL_COMPACT_DEFAULTS.triggerTokens)
    let keepTurns = num(KEYS.keepTurns, TAIL_COMPACT_DEFAULTS.keepTurns)
    // Guard the hysteresis invariant: keep must stay below the trigger, else we
    // would re-fold every turn and re-write the cache each time.
    if (keepTurns >= triggerTurns) keepTurns = Math.max(1, triggerTurns - 1)
    return { triggerTurns, triggerTokens, keepTurns }
  } catch {
    return { ...TAIL_COMPACT_DEFAULTS }
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()
}

export function estimateMessagesTokens(rows: Array<{ role: string; content: unknown }>): number {
  let total = 0
  for (const r of rows) total += estimateTokens(extractText(r.content))
  return total
}

/**
 * Pure decision core (no DB / no LLM) — exported for testing. Given the message
 * count, the unfolded-tail token estimate, the current watermark, and config,
 * decides whether to fold and to what new watermark.
 */
export function decideTailFold(args: {
  total: number
  compactedCount: number
  unfoldedTokens: number
  cfg: TailCompactConfig
}): { shouldFold: boolean; foldUpTo: number } {
  const { total, compactedCount, unfoldedTokens, cfg } = args
  const keepMsgs = cfg.keepTurns * 2
  const triggerMsgs = cfg.triggerTurns * 2
  const unfolded = total - compactedCount

  const overCount = unfolded > triggerMsgs
  const overTokens = unfoldedTokens > cfg.triggerTokens
  const foldUpTo = total - keepMsgs

  // Only fold if a trigger fired AND there is genuinely older material to fold
  // beyond the keep window (foldUpTo must advance past the current watermark).
  const shouldFold = (overCount || overTokens) && foldUpTo > compactedCount
  return { shouldFold, foldUpTo: Math.max(compactedCount, foldUpTo) }
}

async function summarizeTail(
  previousSummary: string | null,
  rows: Array<{ role: string; content: unknown }>,
): Promise<string> {
  const transcript = rows
    .map((m) => `${m.role === 'user' ? 'Owner' : 'Agent'}: ${extractText(m.content)}`)
    .filter((line) => line.length > 8)
    .join('\n')
    .slice(0, 16000)
  if (!transcript.trim() && !previousSummary) return ''

  const instruction =
    'You maintain a rolling memory summary of an owner↔agent conversation so the agent keeps continuity after old turns scroll out of the live window. ' +
    'Merge the PRIOR SUMMARY with the NEW older turns into ONE updated summary. Keep: the owner\'s goals/topics, decisions made, standing rules/instructions the owner gave (NEVER drop a standing rule — G9 governance-decay guard), important facts/numbers, and open action items. ' +
    'Drop chit-chat. Output a tight Bangla summary (max ~10 bullets). Do not invent anything.'
  const body =
    `PRIOR SUMMARY (may be empty):\n${previousSummary || '(none)'}\n\n` +
    `NEW OLDER TURNS to fold in:\n${transcript}`

  // Anthropic first (when it has credits), Gemini as the always-available
  // fallback. This summarizer is now the PRIMARY cost lever for the OpenRouter
  // heads too (run-owner-turn applies tail compaction) — with Anthropic credits
  // out, an Anthropic-only summarizer failed every time, compaction never ran,
  // and every Qwen turn re-shipped the full history at full price.
  const { isAnthropicAllowed } = await import('@/agent/lib/models/model-enabled')
  const anthropicAllowed = await isAnthropicAllowed(AGENT_MODEL || 'claude-sonnet-4-6').catch(() => false)
  if (anthropicAllowed) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
      const res = await client.messages.create({
        model: AGENT_MODEL || 'claude-sonnet-4-6',
        max_tokens: 500,
        system: instruction,
        messages: [{ role: 'user', content: body }],
      })
      const block = res.content.find((b) => b.type === 'text')
      const text = block && block.type === 'text' ? block.text.trim() : ''
      if (text) return text
    } catch (err) {
      console.warn('[tail-compact] anthropic summarize failed, falling back to gemini:', err instanceof Error ? err.message : err)
    }
  }
  const { geminiGenerateText } = await import('@/agent/lib/gemini-text')
  const text = await geminiGenerateText({
    prompt: `${instruction}\n\n${body}`,
    costLabel: 'tail_compact_summary',
    maxTokens: 600,
    temperature: 0.2,
  })
  return text.trim()
}

export type TailCompactResult = {
  /** Summary to inject into the STABLE system block (null = nothing folded yet). */
  tailSummary: string | null
  /** How many of the oldest loaded messages to drop (already folded). */
  dropOldest: number
}

/**
 * Reads the conversation's messages, folds the oldest batch into the running
 * summary when a trigger fires, persists the new watermark, and returns what the
 * caller should ship: drop `dropOldest` oldest messages and inject `tailSummary`.
 *
 * Row order here (createdAt asc) matches core.ts loadHistory 1:1, so `dropOldest`
 * lines up with `messages.slice(dropOldest)`. Fail-open: on any error returns the
 * existing watermark (or 0) so a glitch never drops live context.
 */
/**
 * Phase 32 contract: compaction is a COST lever over chat text only. It may
 * fold messages into the rolling summary but must NEVER touch the canonical
 * continuation state (agent_conversation_focuses / agent_focus_events /
 * workflow runs / checkpoints / cards) — a summary is not an executable
 * checkpoint, and folding history can never delete "where we are".
 * Enforced by tail-compact.test.ts (no focus-table access, no deletes).
 */
export async function applyTailCompaction(conversationId: string): Promise<TailCompactResult> {
  try {
    const cfg = await getTailCompactConfig()
    const conv = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { tailSummary: true, tailCompactedCount: true },
    })
    let tailSummary: string | null = conv?.tailSummary ?? null
    let compactedCount: number = Math.max(0, conv?.tailCompactedCount ?? 0)

    const rows: Array<{ role: string; content: unknown }> = await db.agentMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    })
    const total = rows.length
    // A stale watermark (history shrank / was reset) must never exceed total.
    if (compactedCount > total) compactedCount = total

    const unfoldedTokens = estimateMessagesTokens(rows.slice(compactedCount))
    const { shouldFold, foldUpTo } = decideTailFold({ total, compactedCount, unfoldedTokens, cfg })

    if (shouldFold) {
      const toFold = rows.slice(compactedCount, foldUpTo)
      const newSummary = await summarizeTail(tailSummary, toFold)
      if (newSummary) {
        tailSummary = newSummary
        compactedCount = foldUpTo
        await db.agentConversation.update({
          where: { id: conversationId },
          data: { tailSummary, tailCompactedCount: compactedCount },
        })
      }
    }

    return { tailSummary, dropOldest: compactedCount }
  } catch (err) {
    console.warn('[tail-compact] applyTailCompaction failed:', err instanceof Error ? err.message : err)
    return { tailSummary: null, dropOldest: 0 }
  }
}
