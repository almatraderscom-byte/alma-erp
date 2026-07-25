/**
 * AgentPresentationV1 — ONE canonical, versioned owner-facing projection of a
 * settled agent message (iOS presentation-parity roadmap §5).
 *
 * Both clients (web + native iOS) must render THIS block sequence faithfully, so
 * live, settled, polled, foreground-recovered and cold-launched views converge to
 * the same visible composition. The projection is:
 *   - PURE: same input → byte-identical output (deterministic ids by ordinal);
 *   - ADDITIVE: legacy response fields stay untouched next to it;
 *   - TRUTHFUL: verification/progress history remains available as activity
 *     metadata, while only one settled prose answer is owner-visible.
 *
 * Read-time only — nothing here writes to the database or changes model/tool
 * behaviour.
 */

export type AgentPresentationBlockV1 =
  | { id: string; type: 'prose'; text: string; state: 'final' | 'progress' | 'superseded' }
  | {
      id: string
      type: 'activity'
      activityType: 'thinking' | 'tool' | 'verification'
      label: string
      detail?: string
      status: 'done' | 'failed'
      toolName?: string
      input?: unknown
      result?: string
      screenshot?: string
    }
  | { id: string; type: 'file'; artifactId: string; title: string; kind?: string }
  | { id: string; type: 'confirm_card'; pendingActionId: string }
  | { id: string; type: 'ask_card'; askCardId: string }

export type AgentPresentationUsageV1 = {
  tokensIn: number
  tokensOut: number
  cacheCreation: number
  cacheRead: number
  totalTokens: number
  costUsd?: number
  /** Actual provider API rounds (billing rows) — NOT UI activity phases. */
  apiRounds: number
  roundCostsUsd?: number[]
}

export type AgentPresentationV1 = {
  version: 1
  messageId: string
  blocks: AgentPresentationBlockV1[]
  usage?: AgentPresentationUsageV1
  /** The honesty guard superseded a draft and rewrote the answer this turn —
   *  clients render the "🔁 নিজে যাচাই করে ঠিক করেছে" badge from this. */
  selfCorrected?: true
}

/** Raw persisted timeline entry (usage.timeline) — lenient by design. */
type TimelineEntryIn = {
  t?: unknown
  text?: unknown
  /** Speak-first: this text entry is the spoken FIRST line, not progress prose. */
  lead?: unknown
  state?: unknown
  attempt?: unknown
  max?: unknown
  id?: unknown
  name?: unknown
  ok?: unknown
  input?: unknown
  result?: unknown
  shot?: unknown
  kind?: unknown
}

export type BuildPresentationInput = {
  messageId: string
  /** Persisted content blocks (already status-injected/synthetic-card-enriched by the route). */
  content?: unknown
  /** usage.timeline as persisted (may be absent on legacy messages). */
  timeline?: unknown
  /** Durable tool-call rows fallback for legacy messages without a timeline. */
  toolCalls?: Array<{ id?: string; name?: string; success?: boolean; result?: string }>
  tokensIn?: number | null
  tokensOut?: number | null
  cacheCreation?: number | null
  cacheRead?: number | null
  costUsd?: number | null
  apiRounds?: number | null
  roundCostsUsd?: number[] | null
}

/** Live-parity verification row label (same string the clients show mid-stream). */
export function verificationLabel(attempt: number, max: number): string {
  return `নিজের উত্তর যাচাই করে ঠিক করে নিচ্ছি (${attempt}/${max})…`
}

const THINK_HEADLINE_MAX = 140

/** First non-empty line of a reasoning block, capped — the row headline. */
function thinkHeadline(text: string): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? 'Thinking'
  return firstLine.length > THINK_HEADLINE_MAX
    ? `${firstLine.slice(0, THINK_HEADLINE_MAX - 1)}…`
    : firstLine
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Choose the ONE settled owner-facing answer without destroying the raw audit
 * timeline. Model/tool rounds may emit several prose drafts and the verifier may
 * supersede one; those entries remain in usage.timeline for diagnostics, but
 * they must never look like several assistant replies.
 *
 * Normally the last non-superseded timeline text is the settled answer. A
 * deadline/continuation footer can be appended only to persisted content after
 * the last timeline text; preserve that richer content instead of dropping it.
 */
export function selectSettledProse(content: unknown, timelineInput: unknown): string {
  const contentBlocks = Array.isArray(content)
    ? (content as Array<Record<string, unknown>>)
    : []
  const contentText = contentBlocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()

  const timeline = Array.isArray(timelineInput)
    ? (timelineInput as TimelineEntryIn[]).filter((e) => e && typeof e === 'object')
    : []
  const settledTimelineText = [...timeline]
    .reverse()
    .find((e) => e.t === 'text' && e.state !== 'superseded' && typeof e.text === 'string' && e.text.trim())
  const lastText = typeof settledTimelineText?.text === 'string'
    ? settledTimelineText.text.trim()
    : ''

  if (!lastText) return contentText
  if (!contentText) return lastText
  // Accumulated tool-round narration ends with the actual final round. Collapse
  // it to that last answer. If persisted content has a distinct suffix (deadline
  // progress / continuation note), keep the complete stored message.
  return contentText.endsWith(lastText) ? lastText : contentText
}

export function buildAgentPresentationV1(input: BuildPresentationInput): AgentPresentationV1 {
  const blocks: AgentPresentationBlockV1[] = []
  let ordinal = 0
  const nextId = () => `${input.messageId}:b${ordinal++}`

  const timeline: TimelineEntryIn[] = Array.isArray(input.timeline)
    ? (input.timeline as TimelineEntryIn[]).filter((e) => e && typeof e === 'object')
    : []
  // Speak-first (owner rule 2026-07-25): when the head spoke BEFORE doing
  // anything — "বস, … বুঝেছি — … দেখছি" — that line is the FIRST timeline entry
  // and it leads the reply. Every other prose entry stays audit/progress data
  // (the settled answer is chosen below). Without this the canonical projection
  // dropped the line, so a finished or reloaded turn lost the sentence Boss had
  // already read live — caught in the simulator after two verify retries.
  const leadEntry = timeline.find((e) => e.t === 'text' && e.lead === true)
  const leadText =
    leadEntry && typeof leadEntry.text === 'string' ? leadEntry.text.trim() : ''
  // Placement (owner rule 2026-07-26): the line goes AFTER the head's first
  // thinking row, not above it. The agent did not answer without thinking —
  // showing the reply first and the reasoning under it reads backwards. So:
  // thought → the spoken line → the rest of the flow. Inserted below, once the
  // first thinking block exists (or at the front when the turn had none).
  let leadInserted = false
  const insertLead = () => {
    if (leadInserted || !leadText) return
    leadInserted = true
    blocks.push({ id: nextId(), type: 'prose', text: leadText, state: 'final' })
  }
  if (timeline.length > 0) {
    for (const e of timeline) {
      // Timeline prose is audit/progress data. The single settled prose block is
      // selected below after all activity/file rows have been projected.
      if (e.t === 'think' && typeof e.text === 'string' && e.text.trim()) {
        blocks.push({
          id: nextId(),
          type: 'activity',
          activityType: 'thinking',
          label: thinkHeadline(e.text),
          detail: e.text,
          status: 'done',
        })
        insertLead()
      } else if (e.t === 'tool' || e.t === 'file' || e.t === 'verify') {
        // A turn that jumped straight to work without a thinking row still shows
        // the line before that work.
        insertLead()
      }
      if (e.t === 'verify') {
        const attempt = num(e.attempt) ?? 1
        const max = num(e.max) ?? attempt
        blocks.push({
          id: nextId(),
          type: 'activity',
          activityType: 'verification',
          label: verificationLabel(attempt, max),
          status: 'done',
        })
      } else if (e.t === 'tool') {
        blocks.push({
          id: nextId(),
          type: 'activity',
          activityType: 'tool',
          label: str(e.name) ?? 'টুল',
          status: e.ok === false ? 'failed' : 'done',
          toolName: str(e.name),
          input: e.input,
          result: str(e.result),
          screenshot: str(e.shot),
        })
      } else if (e.t === 'file' && typeof e.id === 'string') {
        blocks.push({
          id: nextId(),
          type: 'file',
          artifactId: e.id,
          title: str(e.name) ?? 'ডকুমেন্ট',
          kind: str(e.kind),
        })
      }
      // Unknown entry types are skipped (non-fatal, forward-compatible).
    }
    // A turn with no thinking/tool/file rows at all still shows the line.
    insertLead()
  } else {
    for (const t of input.toolCalls ?? []) {
      blocks.push({
        id: nextId(),
        type: 'activity',
        activityType: 'tool',
        label: t.name ?? 'টুল',
        status: t.success === false ? 'failed' : 'done',
        toolName: t.name,
        result: t.result,
      })
    }
  }

  insertLead()
  const settled = selectSettledProse(input.content, timeline)
  // The server keeps the opening line as a floor inside the stored text, so
  // strip it here rather than printing the same sentence twice.
  const finalText = leadText && settled.startsWith(leadText)
    ? settled.slice(leadText.length).trim()
    : settled
  if (finalText && finalText !== leadText) {
    blocks.push({ id: nextId(), type: 'prose', text: finalText, state: 'final' })
  }

  // Cards live in persisted content (breadcrumbs + route-synthesized) — append in
  // content order after the flow, exactly where both clients pin them today.
  const contentBlocks = Array.isArray(input.content)
    ? (input.content as Array<Record<string, unknown>>)
    : []
  for (const b of contentBlocks) {
    if (b?.type === 'confirm_card' && typeof b.pendingActionId === 'string') {
      blocks.push({ id: nextId(), type: 'confirm_card', pendingActionId: b.pendingActionId })
    } else if (b?.type === 'ask_card' && typeof b.askCardId === 'string') {
      blocks.push({ id: nextId(), type: 'ask_card', askCardId: b.askCardId })
    }
  }

  // Self-correction marker: the verification guard ran (verify entry) or a draft
  // was superseded — either one means the visible answer was rewritten mid-turn.
  const selfCorrected = timeline.some(
    (e) => e.t === 'verify' || (e.t === 'text' && e.state === 'superseded'),
  )

  const tokensIn = input.tokensIn ?? 0
  const tokensOut = input.tokensOut ?? 0
  const cacheCreation = input.cacheCreation ?? 0
  const cacheRead = input.cacheRead ?? 0
  const roundCostsUsd = input.roundCostsUsd ?? undefined
  const hasUsage =
    input.tokensIn != null || input.tokensOut != null || input.costUsd != null || input.apiRounds != null

  return {
    version: 1,
    messageId: input.messageId,
    blocks,
    ...(selfCorrected ? { selfCorrected: true as const } : {}),
    ...(hasUsage
      ? {
          usage: {
            tokensIn,
            tokensOut,
            cacheCreation,
            cacheRead,
            totalTokens: tokensIn + tokensOut + cacheCreation + cacheRead,
            ...(input.costUsd != null ? { costUsd: input.costUsd } : {}),
            apiRounds: input.apiRounds ?? (roundCostsUsd?.length || 1),
            ...(roundCostsUsd && roundCostsUsd.length > 0 ? { roundCostsUsd } : {}),
          },
        }
      : {}),
  }
}
