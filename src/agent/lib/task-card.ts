/**
 * The task card — P1-6 (audit §E), and the cure for the 18.5 seconds.
 *
 * MEASURED, on a real approval on production (P0-2's stage trace):
 *
 *   approve → ack            0.2s
 *          → continuation   17.1s   (the Mac action itself, awaited)
 *          → route           2.0s   (Redis + VPS worker — not the villain)
 *          → head            0.2s
 *          → first token    18.5s   ← THIS
 *
 * That 18.5s is a continuation rebuilding the ENTIRE conversation and
 * re-deciding everything from scratch, to answer "the thing you approved is
 * done, carry on". Boss put it plainly on 2026-07-26, about the self-continue
 * hop that already got this treatment:
 *
 *   "তুমি নিজেও তো এভাবে কাজ করো না — একটি session শেষ হওয়ার পর পুরো history
 *    নতুন করে পড়ো না, আগের notes/progress/checkpoint থেকে শুরু করো"
 *
 * So a continuation gets what a person resuming their own work gets: the goal,
 * the newest correction, what was just approved, and where the job stands —
 * compiled from records that ALREADY exist (conversation focus, WorkflowRun,
 * corrections, the pinned head). Nothing here is a new source of truth; it is
 * the existing truth, assembled once, at the top.
 *
 * The transcript is not discarded — the last few turns still ride verbatim. The
 * card replaces the *re-derivation*, not the recent context.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Owner kill switch: off restores full-history continuations exactly. */
export const taskCardEnabled = (): boolean => process.env.AGENT_TASK_CARD !== 'off'

export interface TaskCardInput {
  goal?: string | null
  currentStep?: string | null
  status?: string | null
  blocker?: string | null
  nextActions?: string[]
  corrections?: string[]
  pinnedHead?: string | null
  approvedJustNow?: string | null
}

/**
 * Assemble the card. Pure, so the ordering rules are testable without a
 * database: the correction leads (owner rule — it outranks everything,
 * including the goal), then the goal, then where the work stands.
 */
export function buildTaskCard(input: TaskCardInput): string {
  const lines: string[] = []
  const corrections = (input.corrections ?? []).filter(Boolean)
  if (corrections.length > 0) {
    lines.push(`⚠️ Boss-এর সংশোধন (সবার উপরে): "${corrections[0]}"`)
    if (corrections.length > 1) {
      lines.push(`   আগেরগুলোও প্রযোজ্য: ${corrections.slice(1).map((c) => `"${c}"`).join(' · ')}`)
    }
  }
  if (input.goal) lines.push(`🎯 কাজ: ${input.goal}`)
  if (input.approvedJustNow) lines.push(`✅ এইমাত্র approve হয়েছে: ${input.approvedJustNow}`)
  if (input.currentStep) lines.push(`📍 যেখানে আছি: ${input.currentStep}`)
  if (input.blocker) lines.push(`⛔ আটকে আছে: ${input.blocker}`)
  const next = (input.nextActions ?? []).filter(Boolean)
  if (next.length > 0) lines.push(`➡️ পরের বৈধ ধাপ: ${next.slice(0, 5).join(' · ')}`)
  if (lines.length === 0) return ''
  return [
    '[TASK CARD — এই কাজটার সংক্ষিপ্ত সত্য। পুরো history আবার পড়ার দরকার নেই;',
    'নিচের সাম্প্রতিক কয়েকটা বার্তা আর এই কার্ডটাই যথেষ্ট। ঠিক পরের ধাপ থেকে এগোও।]',
    ...lines,
  ].join('\n')
}

/**
 * Compile the card for a conversation from the records that already hold this
 * state. Fail-open: no card is a slower turn, never a wrong one.
 */
export async function compileTaskCard(
  conversationId: string,
  opts: { approvedJustNow?: string | null } = {},
): Promise<string> {
  if (!taskCardEnabled()) return ''
  try {
    const [focus, run, conv] = await Promise.all([
      db.agentConversationFocus.findFirst({
        where: { conversationId, status: { in: ['active', 'awaiting_owner', 'parked'] } },
        orderBy: { updatedAt: 'desc' },
        select: { goal: true, currentStep: true, status: true, blocker: true, nextActions: true },
      }).catch(() => null),
      db.workflowRun.findFirst({
        where: { conversationId, status: { in: ['active', 'waiting_owner', 'waiting_worker'] } },
        orderBy: { updatedAt: 'desc' },
        select: { goal: true, state: true, status: true, nextAllowedTools: true },
      }).catch(() => null),
      db.agentConversation.findUnique({
        where: { id: conversationId },
        select: { corrections: true, pinnedHeadModel: true, title: true },
      }).catch(() => null),
    ])

    const { readCorrections } = await import('@/agent/lib/owner-corrections')
    const corrections = readCorrections(conv?.corrections).map((c) => c.text)

    const nextFromFocus = Array.isArray(focus?.nextActions) ? focus!.nextActions.map(String) : []
    const nextFromRun = Array.isArray(run?.nextAllowedTools) ? run!.nextAllowedTools.map(String) : []

    return buildTaskCard({
      // The focus is the owner's own words for the job; the workflow run's goal
      // is the templated one. Prefer his.
      goal: focus?.goal ?? run?.goal ?? conv?.title ?? null,
      currentStep: focus?.currentStep ?? run?.state ?? null,
      status: focus?.status ?? run?.status ?? null,
      blocker: focus?.blocker ?? null,
      nextActions: nextFromFocus.length > 0 ? nextFromFocus : nextFromRun,
      corrections,
      pinnedHead: conv?.pinnedHeadModel ?? null,
      approvedJustNow: opts.approvedJustNow ?? null,
    })
  } catch (err) {
    console.warn('[task-card] compile failed open:', err instanceof Error ? err.message : err)
    return ''
  }
}

/**
 * How much transcript a CONTINUATION replays once it has a card.
 *
 * Same reasoning (and the same owner ruling) as SELF_CONTINUE_KEEP_MESSAGES,
 * one notch wider: a self-continue hop wrote its own resume directive, while an
 * approval continuation resumes work Boss touched, so the turns around his tap
 * are worth keeping verbatim.
 */
export const CONTINUATION_KEEP_MESSAGES = 8
