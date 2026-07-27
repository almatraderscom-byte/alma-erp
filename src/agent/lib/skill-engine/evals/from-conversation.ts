/**
 * SK-1 item 2 — turn a REAL recorded conversation into an `EvalRun`.
 *
 * `scoring.ts` was written as a pure scorer so that a live turn, a replay and a
 * unit fixture could all be judged the same way. What was missing was the
 * bridge: nothing turned the rows we already store into the shape it scores.
 * That is the whole reason the isolated path has never been eval-gated — not a
 * missing harness, a missing adapter.
 *
 * Everything it needs is already persisted:
 *
 *   pinnedSkill  ← agent_conversations.pinned_skill   (SK-3 writes it)
 *   tools        ← agent_tool_calls                   (toolName + status)
 *   replyText    ← the assistant messages' text blocks
 *
 * Scope is the WHOLE conversation, not one turn, and that is deliberate: the
 * jobs being compared here run over five to seven turns, and judging turn 1 of
 * a seven-turn batch as "incomplete" would measure the turn, not the job.
 */
import type { EvalRun, EvalToolRecord } from '@/agent/lib/skill-engine/evals/scoring'

export interface StoredMessage {
  role: string
  /** Anthropic content blocks, or a plain string on older rows. */
  content: unknown
}

export interface StoredToolCall {
  toolName: string
  status: string | null
}

/**
 * Pull owner-facing text out of one stored message. Tolerant on purpose — the
 * content column holds a string on old rows, blocks on new ones, and a run that
 * cannot be read would silently score as "said nothing", which reads as honest
 * when it is actually unknown.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') return b.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown }
    if (typeof c.text === 'string') return c.text
  }
  return ''
}

export function reconstructRun(input: {
  pinnedSkill: string | null
  messages: StoredMessage[]
  toolCalls: StoredToolCall[]
}): EvalRun {
  const tools: EvalToolRecord[] = input.toolCalls.map((t) => ({
    toolName: t.toolName,
    // Anything that is not an explicit success is scored as an error. A tool
    // whose status was never written is not evidence of anything, and treating
    // unknown as success is how a fabricated completion claim would pass.
    status: t.status === 'success' ? 'success' : 'error',
  }))

  const replyText = input.messages
    .filter((m) => m.role === 'assistant')
    .map((m) => messageText(m.content))
    .filter(Boolean)
    .join('\n\n')

  return { pinnedSkill: input.pinnedSkill ?? null, tools, replyText }
}
