/**
 * P0 checkpoint standard — the terminal-state contract's failure half.
 *
 * Every long/agentic task must end success-WITH-proof or failure-WITH-checkpoint
 * (docs/agent-computer-use-roadmap.md §0.1, §2). A checkpoint is a SELF-CONTAINED
 * resume brief: the owner's next reply (or a Continue tap) resumes the work from
 * `currentStep` without re-reading the full chat history — the head gets only
 * this note. `waiting_for_owner` uses the same shape for questions / logins /
 * 2FA / CAPTCHAs / budget stops, so every interruption class shares ONE flow.
 *
 * Storage rides the existing AgentOpenTask row (chip, nudges, Continue/Cancel
 * all come for free) with the structured state in the new `checkpoint` Json
 * column and kind = checkpoint_failed | checkpoint_waiting.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CheckpointState = 'failed' | 'waiting_for_owner'

export type TaskCheckpoint = {
  /** stable id for dedupe/updates — usually the pendingActionId or plan id */
  taskRef: string
  taskType: string // 'browser' | 'plan' | 'image_gen' | 'video_gen' | 'long_agent_task' | …
  state: CheckpointState
  goal: string
  /** owner-readable ২-৩ বাক্যের Bangla summary — shown in chat/chip */
  summaryBn: string
  doneSteps: string[]
  currentStep: string
  artifacts: string[]
  error?: string
  /** what the agent should do on resume */
  nextActions: string[]
  /** everything a FRESH context needs to continue — self-contained */
  resumeHint: string
  /** waiting_for_owner only: the question the owner must answer */
  question?: string
  savedAt: string
}

export type WriteCheckpointInput = Omit<TaskCheckpoint, 'savedAt' | 'state'> & {
  state?: CheckpointState
  conversationId?: string | null
  businessId?: string
}

const KIND_BY_STATE: Record<CheckpointState, string> = {
  failed: 'checkpoint_failed',
  waiting_for_owner: 'checkpoint_waiting',
}

function titleFor(cp: TaskCheckpoint): string {
  const prefix = cp.state === 'failed' ? '⛔ আটকে গেছে' : '⏸️ আপনার উত্তর দরকার'
  return `${prefix}: ${cp.goal}`.slice(0, 120)
}

function resumeNoteFor(cp: TaskCheckpoint): string {
  return [
    cp.summaryBn,
    cp.error ? `কারণ: ${cp.error}` : '',
    cp.question ? `প্রশ্ন: ${cp.question}` : '',
    `Resume: ${cp.resumeHint}`,
  ].filter(Boolean).join('\n')
}

/**
 * Write (or refresh) a checkpoint. One open row per taskRef — a retry that
 * fails again UPDATES the same checkpoint instead of stacking chips.
 * Best-effort by contract: callers sit in failure paths that must never throw.
 */
export async function writeCheckpoint(input: WriteCheckpointInput): Promise<string | null> {
  try {
    const cp: TaskCheckpoint = {
      taskRef: input.taskRef,
      taskType: input.taskType,
      state: input.state ?? 'failed',
      goal: input.goal,
      summaryBn: input.summaryBn,
      doneSteps: input.doneSteps ?? [],
      currentStep: input.currentStep,
      artifacts: input.artifacts ?? [],
      error: input.error,
      nextActions: input.nextActions ?? [],
      resumeHint: input.resumeHint,
      question: input.question,
      savedAt: new Date().toISOString(),
    }
    const kind = KIND_BY_STATE[cp.state]
    const data = {
      businessId: input.businessId ?? 'ALMA_LIFESTYLE',
      conversationId: input.conversationId ?? null,
      title: titleFor(cp),
      kind,
      status: 'open', // a refreshed checkpoint re-opens even if previously touched
      resumeNote: resumeNoteFor(cp),
      checkpoint: cp,
      pendingActionId: input.taskRef,
    }

    const existing = await db.agentOpenTask.findFirst({
      where: { pendingActionId: input.taskRef, status: { in: ['open', 'running'] } },
      select: { id: true },
    })
    if (existing) {
      await db.agentOpenTask.update({ where: { id: existing.id }, data })
      return existing.id as string
    }
    const row = await db.agentOpenTask.create({ data })

    // P3 step 1 — the owner supervises from his PHONE: a brand-NEW checkpoint
    // (never a refresh — the dedupe above returns early) lights up the native
    // app with a tap-through to the agent. Fail-open; Telegram/chat channels
    // are separate and unaffected.
    try {
      const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
      await pushNativeToOwner({
        tier: 2,
        title: cp.state === 'failed' ? '⛔ কাজ আটকে গেছে' : '⏸️ আপনার উত্তর দরকার',
        message: `${cp.goal}\n${cp.summaryBn}`.slice(0, 400),
        category: 'task',
        actionUrl: '/agent',
      })
    } catch { /* best-effort — the checkpoint row is already durable */ }

    return row.id as string
  } catch (err) {
    console.error('[checkpoint] write failed (task state may be lost!):', err instanceof Error ? err.message : err)
    return null
  }
}

/** Mark a checkpoint resolved once its task resumed/completed. Best-effort. */
export async function resolveCheckpointByTaskRef(taskRef: string): Promise<void> {
  try {
    await db.agentOpenTask.updateMany({
      where: {
        pendingActionId: taskRef,
        kind: { in: ['checkpoint_failed', 'checkpoint_waiting'] },
        status: { in: ['open', 'running'] },
      },
      data: { status: 'done', completedAt: new Date() },
    })
  } catch { /* best-effort */ }
}

export type CheckpointView = { id: string; kind: string; checkpoint: TaskCheckpoint }

/** Unresolved checkpoints for a conversation (newest first, capped). */
export async function listUnresolvedCheckpoints(
  conversationId: string,
  limit = 3,
): Promise<CheckpointView[]> {
  try {
    const rows = await db.agentOpenTask.findMany({
      where: {
        conversationId,
        kind: { in: ['checkpoint_failed', 'checkpoint_waiting'] },
        status: { in: ['open', 'running'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    type Row = { id: string; kind: string; checkpoint: unknown }
    return (rows as Row[])
      .filter((r) => r.checkpoint && typeof r.checkpoint === 'object')
      .map((r) => ({ id: r.id, kind: r.kind, checkpoint: r.checkpoint as TaskCheckpoint }))
  } catch {
    return []
  }
}

/** Approved actions older than this with no resolution are considered STUCK. */
const STUCK_AFTER_MIN = 30
/** Job types the watchdog covers — long worker jobs (chat-approval cards excluded via status). */
const WATCHDOG_TYPES = ['image_gen', 'video_gen', 'long_agent_task', 'browser_action', 'workbench_run', 'seo_audit']

/**
 * P0 watchdog — silence becomes impossible by construction. Scans for worker
 * jobs that were approved but never resolved within STUCK_AFTER_MIN and turns
 * each into a checkpoint + one owner ping (dedupe: an existing open checkpoint
 * for the same taskRef only refreshes; no ping spam). Called from the same
 * internal cron as the open-task nudge tick.
 */
export async function runStuckTaskWatchdogTick(): Promise<{ stuck: number; pinged: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MIN * 60 * 1000)
  const rows = await db.agentPendingAction.findMany({
    where: {
      status: 'approved',
      resolvedAt: null,
      createdAt: { lt: cutoff },
      type: { in: WATCHDOG_TYPES },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  type Row = { id: string; type: string; summary: string | null; conversationId: string | null; payload: unknown; createdAt: Date }

  let pinged = 0
  for (const row of rows as Row[]) {
    const existing = await db.agentOpenTask.findFirst({
      where: { pendingActionId: row.id, kind: { in: ['checkpoint_failed', 'checkpoint_waiting'] }, status: { in: ['open', 'running'] } },
      select: { id: true },
    })
    const goal = row.summary?.split('\n')[0]?.slice(0, 160) || `${row.type} job`
    const ageMin = Math.round((Date.now() - row.createdAt.getTime()) / 60000)
    const payload = (row.payload ?? {}) as Record<string, unknown>
    await writeCheckpoint({
      taskRef: row.id,
      taskType: row.type,
      goal,
      summaryBn: `"${goal}" কাজটা ${ageMin} মিনিট ধরে আটকে আছে — worker এখনো শেষ করেনি।`,
      doneSteps: [],
      currentStep: `worker queue (${row.type})`,
      artifacts: [],
      error: `stuck: no result after ${ageMin} min`,
      nextActions: ['worker/queue-এর অবস্থা দেখো; দরকারে action-টা আবার queue করো'],
      resumeHint: `pendingAction ${row.id} (type ${row.type}) approved ${ageMin} min ago, never resolved. Payload intact — re-queue or diagnose the worker.`,
      conversationId: row.conversationId ?? (typeof payload.conversationId === 'string' ? payload.conversationId : null),
    })
    if (!existing) {
      pinged++
      try {
        const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')
        await sendOwnerText(`⚠️ Sir, একটা কাজ আটকে গেছে (${ageMin} মিনিট): ${goal}\nআমি checkpoint রেখেছি — chat-এ reply দিলেই ওখান থেকে ধরবো।`)
      } catch { /* best-effort */ }
    }
  }
  return { stuck: rows.length, pinged }
}

/**
 * Compact system note injected into the head's turn when the owner replies in a
 * conversation with unresolved checkpoints — THE resume fast-path. Self-contained:
 * the head continues from `currentStep` without re-deriving anything from history.
 */
export function buildCheckpointSystemNote(cps: CheckpointView[]): string {
  if (!cps.length) return ''
  const blocks = cps.map((c, i) => {
    const cp = c.checkpoint
    return [
      `${i + 1}. [${cp.state === 'failed' ? 'FAILED' : 'WAITING'}] ${cp.goal}`,
      `   হয়েছে: ${cp.doneSteps.join('; ') || '—'}`,
      `   আটকেছে: ${cp.currentStep}${cp.error ? ` (${cp.error})` : ''}`,
      cp.question ? `   প্রশ্ন ছিল: ${cp.question}` : '',
      cp.artifacts.length ? `   artifacts: ${cp.artifacts.join(', ')}` : '',
      `   Resume: ${cp.resumeHint}`,
    ].filter(Boolean).join('\n')
  })
  return (
    '[চেকপয়েন্ট নোট — অসমাপ্ত কাজ] এই কথোপকথনে আগের কাজ মাঝপথে থেমেছিল। ' +
    'নিচের চেকপয়েন্ট থেকে ঠিক সেখান থেকেই চালিয়ে যাও — আগের ইতিহাস আবার পড়া বা কাজ নতুন করে শুরু করার দরকার নেই। ' +
    'Sir-এর নতুন বার্তা যদি ভিন্ন বিষয়ে হয়, আগে সেটার উত্তর দাও, তারপর জিজ্ঞেস করো থেমে থাকা কাজটা চালাবে কি না।\n' +
    blocks.join('\n')
  )
}
