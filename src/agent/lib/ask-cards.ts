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
  selectedOption: true, options: true, questions: true, workflowRunId: true,
} as const

function toView(row: Record<string, unknown>): AskCardView {
  return {
    ...(row as unknown as AskCardView),
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
  }
}

async function settleLinkedPlanSteps(cardId: string): Promise<void> {
  try {
    const { completePlanStepsLinkedToAskCard } = await import('@/agent/lib/planner')
    await completePlanStepsLinkedToAskCard(cardId)
  } catch (err) {
    // The owner's answer is authoritative even if tracker bookkeeping is
    // temporarily unavailable. A same-answer retry runs this idempotently.
    console.warn('[ask-cards] linked plan-step settle failed open:', err instanceof Error ? err.message : err)
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
    // Idempotent success is limited to a still-valid answered card. A direct
    // lane supersedes its card when authority ends; accepting the same option
    // from that closed card would resurrect a stale browser continuation.
    if (card.status === 'answered' && (card.selectedOption ?? '').trim() === option.trim()) {
      await settleLinkedPlanSteps(cardId)
      return { ok: true, alreadyAnswered: true, card }
    }
    return { ok: false, alreadyAnswered: true, reason: 'different_answer_recorded', card }
  }

  // Atomic claim: only the FIRST writer flips pending → answered.
  const claimed = await db.agentAskCard.updateMany({
    where: { id: cardId, status: 'pending' },
    // 1200 matches the answer route: a multi-question card submits every
    // answer as one combined text (Codex P1 #754 — 500 silently truncated it).
    data: { status: 'answered', selectedOption: option.slice(0, 1200) },
  })
  if (claimed.count === 0) {
    // Raced: someone answered between the read and the claim — re-read and
    // apply the same idempotency rule.
    const again = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
    const c2 = again ? toView(again) : card
    if ((c2.selectedOption ?? '').trim() === option.trim()) {
      await settleLinkedPlanSteps(cardId)
      return { ok: true, alreadyAnswered: true, card: c2 }
    }
    return { ok: false, alreadyAnswered: true, reason: 'different_answer_recorded', card: c2 }
  }

  // A grind-campaign gate (family approval / "I've logged in") is resolved right
  // here, so one tap in the app is the whole interaction: the grant is written
  // and the parked plan starts driving again on the next tick. Fail-open — a
  // gate bookkeeping problem must never break answering a question.
  try {
    const { resolveGrindGate } = await import('@/agent/lib/grind/owner-gate')
    await resolveGrindGate(cardId, option)
  } catch (err) {
    console.warn('[ask-cards] grind gate resolve failed open:', err instanceof Error ? err.message : err)
  }

  // The answer resumes the EXACT bound run (version-guarded inside; a repeat
  // call is a no-op there). Fail-open: run advance is an accelerator — the
  // turn-level advance uses the same idempotent helper.
  if (card.workflowRunId) {
    try {
      const { advanceWorkflowOnAskAnswer } = await import('@/agent/lib/workflow-run')
      // Multi-question card: the run binds to the PRIMARY (first) question, so
      // only its answer line drives the state machine — a "না"/"change" in an
      // unrelated later answer must not flip it (Codex P1 #754).
      const isMulti = typeof (row as { questions?: unknown }).questions === 'string'
        && String((row as { questions?: unknown }).questions).trim().length > 0
      // The first line is "১. <question> — <answer>": strip the question label
      // before the state machine sees it, or a negative word in the QUESTION
      // itself ("বদল দরকার?") outweighs an affirmative answer (Codex P1 #754).
      const firstLine = option.split('\n')[0] ?? option
      const sepIndex = firstLine.lastIndexOf(' — ')
      const workflowAnswer = isMulti
        ? (sepIndex >= 0 ? firstLine.slice(sepIndex + 3).trim() : firstLine)
        : option
      await advanceWorkflowOnAskAnswer(card.workflowRunId, workflowAnswer, cause)
    } catch (err) {
      console.warn('[ask-cards] run advance failed open:', err instanceof Error ? err.message : err)
    }
  }
  await settleLinkedPlanSteps(cardId)
  const after = await db.agentAskCard.findUnique({ where: { id: cardId }, select: SELECT })
  return { ok: true, alreadyAnswered: false, card: after ? toView(after) : { ...card, status: 'answered', selectedOption: option } }
}
