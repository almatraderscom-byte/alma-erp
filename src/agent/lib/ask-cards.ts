/**
 * Ask-card store helpers (Roadmap 1 Phase 34).
 *
 * One durable, idempotent path for answering an ask card:
 *  - the SAME answer repeated (double tap / reconnect / retry) is a success
 *    that changes nothing,
 *  - a DIFFERENT answer after one is recorded is refused (the first answer
 *    already advanced the bound run — silently swapping it would desync),
 *  - a card bound to a WorkflowRun advances that exact run's template step
 *    (idempotent inside advanceWorkflowOnAskAnswer via optimistic version),
 *  - the answer is BOUND state, never re-interpreted as a fresh instruction —
 *    run-owner-turn's anchoring note reads the durable row this module writes.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface AskCardView {
  id: string
  conversationId: string | null
  question: string
  status: string
  selectedOption: string | null
  options: string[]
  workflowRunId: string | null
}

export interface AnswerAskCardResult {
  ok: boolean
  /** True when this call recorded nothing new (same answer repeated). */
  alreadyAnswered: boolean
  reason?: 'not_found' | 'different_answer_recorded'
  card?: AskCardView
}

const SELECT = {
  id: true, conversationId: true, question: true, status: true,
  selectedOption: true, options: true, workflowRunId: true,
} as const

function toView(row: Record<string, unknown>): AskCardView {
  return {
    ...(row as unknown as AskCardView),
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
  }
}

export async function getAskCard(cardId: string): Promise<AskCardView | null> {
  const row = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
  return row ? toView(row) : null
}

/**
 * Record the owner's answer idempotently and advance the bound run once.
 * Free-text answers are first-class (the card always offers "Other").
 */
export async function answerAskCard(cardId: string, option: string, cause = 'answer_route'): Promise<AnswerAskCardResult> {
  const row = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
  if (!row) return { ok: false, alreadyAnswered: false, reason: 'not_found' }
  const card = toView(row)

  if (card.status !== 'pending') {
    // Idempotent success only for the SAME answer; a different one is refused.
    if ((card.selectedOption ?? '').trim() === option.trim()) {
      return { ok: true, alreadyAnswered: true, card }
    }
    return { ok: false, alreadyAnswered: true, reason: 'different_answer_recorded', card }
  }

  // Atomic claim: only the FIRST writer flips pending → answered.
  const claimed = await db.agentAskCard.updateMany({
    where: { id: cardId, status: 'pending' },
    data: { status: 'answered', selectedOption: option.slice(0, 500) },
  })
  if (claimed.count === 0) {
    // Raced: someone answered between the read and the claim — re-read and
    // apply the same idempotency rule.
    const again = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
    const c2 = again ? toView(again) : card
    if ((c2.selectedOption ?? '').trim() === option.trim()) return { ok: true, alreadyAnswered: true, card: c2 }
    return { ok: false, alreadyAnswered: true, reason: 'different_answer_recorded', card: c2 }
  }

  // The answer resumes the EXACT bound run (version-guarded inside; a repeat
  // call is a no-op there). Fail-open: run advance is an accelerator — the
  // turn-level advance uses the same idempotent helper.
  if (card.workflowRunId) {
    try {
      const { advanceWorkflowOnAskAnswer } = await import('@/agent/lib/workflow-run')
      await advanceWorkflowOnAskAnswer(card.workflowRunId, option, cause)
    } catch (err) {
      console.warn('[ask-cards] run advance failed open:', err instanceof Error ? err.message : err)
    }
  }
  const after = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
  return { ok: true, alreadyAnswered: false, card: after ? toView(after) : { ...card, status: 'answered', selectedOption: option } }
}
