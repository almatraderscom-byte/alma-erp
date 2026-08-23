/**
 * AgentPresentationV2 — the settled owner-facing projection of a message whose
 * turn tracked a typed prose lifecycle (usage.presentationV2 document).
 *
 * Differences from v1:
 *   - prose blocks keep the SERVER block ids from the live stream, so live,
 *     polled and cold views are byte-comparable by id (the parity fingerprint);
 *   - every committed lead / progress / final block is owner-visible, in true
 *     chronology with the activity rows (anchored by timeline index);
 *   - only explicitly superseded blocks are hidden;
 *   - a truncated raw timeline can never drop committed prose — unanchored
 *     blocks are appended from the document in order.
 *
 * Read-time only. The v1 projection for legacy clients is DERIVED from this
 * (see build-presentation.ts), never re-guessed from `content`.
 */
import {
  thinkHeadline,
  verificationLabel,
  type AgentPresentationBlockV1,
  type AgentPresentationUsageV1,
  type BuildPresentationInput,
} from './build-presentation'
import {
  proseFingerprint,
  visibleDocumentBlocks,
  type PresentationV2Document,
  type ProseProtocol,
} from './prose-lifecycle'

export type AgentPresentationProseBlockV2 = {
  id: string
  type: 'prose'
  kind: 'lead' | 'progress' | 'final'
  state: 'committed'
  revision: number
  text: string
}

export type AgentPresentationBlockV2 =
  | AgentPresentationProseBlockV2
  | Exclude<AgentPresentationBlockV1, { type: 'prose' }>

export type AgentPresentationV2 = {
  version: 2
  messageId: string
  /** Wire protocol the turn streamed with. */
  protocol: ProseProtocol
  blocks: AgentPresentationBlockV2[]
  /** Ordered visible prose `id:kind`, hashed — compare with the live reducer. */
  fingerprint: string
  usage?: AgentPresentationUsageV1
  selfCorrected?: true
}

type TimelineEntryIn = {
  t?: unknown
  text?: unknown
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function buildUsageV1(input: BuildPresentationInput): AgentPresentationUsageV1 | undefined {
  const tokensIn = input.tokensIn ?? 0
  const tokensOut = input.tokensOut ?? 0
  const cacheCreation = input.cacheCreation ?? 0
  const cacheRead = input.cacheRead ?? 0
  const roundCostsUsd = input.roundCostsUsd ?? undefined
  const hasUsage =
    input.tokensIn != null || input.tokensOut != null || input.costUsd != null || input.apiRounds != null
  if (!hasUsage) return undefined
  return {
    tokensIn,
    tokensOut,
    cacheCreation,
    cacheRead,
    totalTokens: tokensIn + tokensOut + cacheCreation + cacheRead,
    ...(input.costUsd != null ? { costUsd: input.costUsd } : {}),
    apiRounds: input.apiRounds ?? (roundCostsUsd?.length || 1),
    ...(roundCostsUsd && roundCostsUsd.length > 0 ? { roundCostsUsd } : {}),
  }
}

export function buildAgentPresentationV2(
  input: BuildPresentationInput & { document: PresentationV2Document },
): AgentPresentationV2 {
  const blocks: AgentPresentationBlockV2[] = []
  let ordinal = 0
  const nextId = () => `${input.messageId}:b${ordinal++}`

  const timeline: TimelineEntryIn[] = Array.isArray(input.timeline)
    ? (input.timeline as TimelineEntryIn[]).filter((e) => e && typeof e === 'object')
    : []

  const visible = visibleDocumentBlocks(input.document.blocks)
  const emitted = new Set<string>()
  const prose = (b: (typeof visible)[number]): AgentPresentationProseBlockV2 => ({
    id: b.id,
    type: 'prose',
    kind: b.kind === 'draft' ? 'final' : b.kind,
    state: 'committed',
    revision: b.revision,
    text: b.text.trim(),
  })
  const emitProse = (b: (typeof visible)[number]) => {
    if (emitted.has(b.id)) return
    emitted.add(b.id)
    blocks.push(prose(b))
  }

  // Owner rule 2026-07-26: the spoken line renders AFTER the head's first
  // thinking row. A lead anchored before that row is deferred until after it.
  const firstThinkIndex = timeline.findIndex((e) => e.t === 'think' && typeof e.text === 'string' && e.text.trim())
  const lead = visible.find((b) => b.kind === 'lead')
  const deferLeadUntil =
    lead && firstThinkIndex >= 0 && (lead.timelineIndex == null || lead.timelineIndex < firstThinkIndex)
      ? firstThinkIndex
      : -1

  const anchored = new Map<number, typeof visible>()
  const unanchored: typeof visible = []
  for (const b of visible) {
    if (b === lead && deferLeadUntil >= 0) continue
    if (b.timelineIndex != null && b.timelineIndex < timeline.length) {
      const list = anchored.get(b.timelineIndex) ?? []
      list.push(b)
      anchored.set(b.timelineIndex, list)
    } else {
      unanchored.push(b)
    }
  }

  if (timeline.length > 0) {
    timeline.forEach((e, i) => {
      for (const b of anchored.get(i) ?? []) emitProse(b)
      if (e.t === 'think' && typeof e.text === 'string' && e.text.trim()) {
        blocks.push({
          id: nextId(),
          type: 'activity',
          activityType: 'thinking',
          label: thinkHeadline(e.text),
          detail: e.text,
          status: 'done',
        })
        if (i === deferLeadUntil && lead) emitProse(lead)
      } else if (e.t === 'verify') {
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
      // `text` entries are audit data here: the document is the prose authority.
    })
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
  if (lead) emitProse(lead)
  // Blocks whose anchor fell past the persisted timeline window (or never had
  // one) keep their place at the end, in document order — never dropped.
  for (const b of unanchored) emitProse(b)
  for (const b of visible) emitProse(b)

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

  const selfCorrected =
    input.document.blocks.some((b) => b.state === 'superseded' && b.reason !== 'empty')
    || timeline.some((e) => e.t === 'verify')

  const usage = buildUsageV1(input)
  return {
    version: 2,
    messageId: input.messageId,
    protocol: input.document.protocol,
    blocks,
    fingerprint: proseFingerprint(blocks.filter((b): b is AgentPresentationProseBlockV2 => b.type === 'prose')),
    ...(selfCorrected ? { selfCorrected: true as const } : {}),
    ...(usage ? { usage } : {}),
  }
}

/**
 * Legacy (v1) projection DERIVED from the v2 one — old clients keep working:
 * lead/final → `state: 'final'` (rendered), committed progress → `state:
 * 'progress'` (older iOS builds drop it, the legacy web ignores the
 * projection), superseded prose omitted as before.
 */
export function presentationV1FromV2(v2: AgentPresentationV2): {
  blocks: AgentPresentationBlockV1[]
  selfCorrected?: true
  usage?: AgentPresentationUsageV1
} {
  const blocks: AgentPresentationBlockV1[] = v2.blocks.map((b) => {
    if (b.type !== 'prose') return b
    return {
      id: b.id,
      type: 'prose',
      text: b.text,
      state: b.kind === 'progress' ? 'progress' : 'final',
    }
  })
  return {
    blocks,
    ...(v2.selfCorrected ? { selfCorrected: true as const } : {}),
    ...(v2.usage ? { usage: v2.usage } : {}),
  }
}
