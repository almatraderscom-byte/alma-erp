/**
 * Resume brief (owner ask 2026-07-16: "কয়েক দিন পরে reply দিলেও ঠিক ওই জায়গা
 * থেকে" — Claude-Code-grade continuity).
 *
 * Raw history + tail summary already survive a gap; what the model lacked was
 * the STRUCTURED state a returning human assistant reconstructs first: what
 * was I doing, what is waiting on whom, what did I promise last. This builds
 * that brief DETERMINISTICALLY from the state stores that already exist —
 * active WorkflowRuns (with their template step labels), pending approval
 * cards, unanswered ask cards, open tasks, and the tail of the last assistant
 * message (the standing promise). No model call, fail-open everywhere.
 *
 * Injected as a volatile block (never persisted into history) only when the
 * conversation has been quiet for RESUME_GAP_HOURS+ — a rapid back-and-forth
 * never pays the tokens.
 */
import { prisma } from '@/lib/prisma'
import { getTemplateStep } from '@/agent/lib/workflow-templates'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const RESUME_GAP_HOURS = 6

function agoBn(from: Date, now: Date): string {
  const mins = Math.max(1, Math.round((now.getTime() - from.getTime()) / 60_000))
  if (mins < 60) return `${mins} মিনিট আগে`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ঘণ্টা আগে`
  return `${Math.round(hours / 24)} দিন আগে`
}

/**
 * Should this turn carry a resume brief? True when the previous message in
 * the conversation is older than the gap threshold.
 */
export function shouldInjectResumeBrief(lastMessageAt: Date | null, now: Date): boolean {
  if (!lastMessageAt) return false
  return now.getTime() - lastMessageAt.getTime() >= RESUME_GAP_HOURS * 3_600_000
}

/**
 * Build the Bangla resume brief. Returns null when there is nothing worth
 * saying (no open state at all) — silence beats noise.
 */
export async function buildResumeBrief(
  conversationId: string,
  lastMessageAt: Date,
  now = new Date(),
): Promise<string | null> {
  try {
    const [runs, pendingCards, askCards, openTasks, lastAssistant] = await Promise.all([
      db.workflowRun.findMany({
        where: { conversationId, status: { in: ['active', 'waiting_owner', 'waiting_worker'] } },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: { kind: true, goal: true, status: true, state: true },
      }),
      db.agentPendingAction.findMany({
        where: { conversationId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { type: true, summary: true },
      }),
      db.agentAskCard.findMany({
        where: { conversationId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 2,
        select: { question: true },
      }),
      db.agentOpenTask.findMany({
        where: { conversationId, status: { in: ['open', 'running'] } },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: { title: true, status: true },
      }),
      db.agentMessage.findFirst({
        where: { conversationId, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        select: { content: true },
      }),
    ])

    const lines: string[] = []

    // Phase 32: the FOCUS STACK leads the brief — it is the canonical
    // continuation contract (goal, step, verified-done, blocker, exact next
    // actions), not a reconstruction. Runs/cards/tasks below stay as detail.
    try {
      const { getFocusStack } = await import('@/agent/lib/conversation-focus')
      const stack = await getFocusStack(conversationId)
      if (stack.active) {
        const f = stack.active
        lines.push(
          `• ফোকাস (সক্রিয়): "${f.goal.slice(0, 80)}" → ধাপ: ${f.currentStep ?? 'শুরু'}` +
          (f.nextActions.length ? ` → পরের ধাপ: ${f.nextActions.slice(0, 3).join(', ')}` : '') +
          (f.completedSteps.length ? ` (সম্পন্ন: ${f.completedSteps.slice(-3).join(', ')} — আবার নয়)` : ''),
        )
        if (f.blocker) lines.push(`• ফোকাস আটকে: ${f.blocker === 'owner' ? 'Boss-এর সিদ্ধান্তের অপেক্ষায়' : f.blocker}${f.lastErrorClass ? ` (${f.lastErrorClass})` : ''}`)
      }
      for (const f of stack.awaitingOwner.slice(0, 2)) {
        lines.push(`• ফোকাস (Boss-এর অপেক্ষায়): "${f.goal.slice(0, 70)}"`)
      }
      for (const f of stack.parked.slice(0, 2)) {
        lines.push(`• ফোকাস (পার্ক করা): "${f.goal.slice(0, 70)}"`)
      }
    } catch { /* focus lines are an upgrade, never a dependency */ }

    for (const r of runs as Array<{ kind: string; goal: string; status: string; state: string }>) {
      const label = getTemplateStep(r.kind, r.state)?.labelBn ?? r.state
      const waiting =
        r.status === 'waiting_owner' ? ' — Boss-এর সিদ্ধান্তের অপেক্ষায়'
        : r.status === 'waiting_worker' ? ' — worker কাজ করছে'
        : ''
      lines.push(`• চলমান কাজ: ${r.goal.slice(0, 90)} → ধাপ: ${label}${waiting}`)
    }
    for (const c of pendingCards as Array<{ type: string; summary: string | null }>) {
      lines.push(`• অনুমোদনের অপেক্ষায় card: ${c.type}${c.summary ? ` — ${c.summary.slice(0, 70)}` : ''}`)
    }
    for (const a of askCards as Array<{ question: string }>) {
      lines.push(`• Boss-কে করা প্রশ্ন এখনো উত্তরহীন: "${a.question.slice(0, 80)}"`)
    }
    for (const t of openTasks as Array<{ title: string; status: string }>) {
      lines.push(`• খোলা task: ${t.title.slice(0, 80)}${t.status === 'running' ? ' (চলছিল)' : ''}`)
    }

    // The standing promise: the tail of what the assistant last said it would do.
    try {
      const content = (lastAssistant as { content?: unknown } | null)?.content
      const blocks = Array.isArray(content) ? content : []
      const text = blocks
        .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
        .join(' ')
        .trim()
      if (text) lines.push(`• তোমার শেষ কথা ছিল: "…${text.slice(-160)}"`)
    } catch { /* promise line is optional */ }

    if (lines.length === 0) return null

    return (
      `[RESUME BRIEF — নীরবতার পরে ফেরা]\n` +
      `শেষ কথোপকথন ${agoBn(lastMessageAt, now)}। Boss হয়তো মাঝের সময়ের কথা মনে করিয়ে দেবেন না — ` +
      `নিচের অবস্থাটাই সত্য, এখান থেকেই ঠিক আগের মতো চালিয়ে যাও (নতুন করে শুরু কোরো না, আগের প্রসঙ্গ ভুলো না):\n` +
      lines.join('\n')
    )
  } catch (err) {
    console.warn('[resume-brief] failed open:', err instanceof Error ? err.message : err)
    return null
  }
}
