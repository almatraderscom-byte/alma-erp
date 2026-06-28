/**
 * Open-loop task tracking — so unfinished work isn't lost when a new task starts.
 *
 * Two kinds of "incomplete" are tracked per chat:
 *   • chat_followup    — an owner request the agent started but hasn't finished
 *   • approval_pending — a confirm card still awaiting the owner's decision
 *
 * Each row carries a self-contained Bangla `resumeNote` so the head can pick the
 * work back up from the note alone — no full system prompt re-read, no tool search.
 * `nudgeDueAt` drives a 30-then-60-minute "still pending?" escalation (Telegram).
 *
 * This module is the ONLY writer of the agent_open_tasks table. It is additive and
 * isolated from the existing AgentTodo dock (zero regression risk).
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

export type OpenTaskKind = 'chat_followup' | 'approval_pending'
export type OpenTaskStatus = 'open' | 'running' | 'done' | 'cancelled'

export type OpenTaskView = {
  id: string
  title: string
  kind: OpenTaskKind
  status: OpenTaskStatus
  resumeNote: string
  pendingActionId: string | null
  ageMinutes: number
  createdAt: string
}

/** First nudge fires 30 min after the task is created; the second at 60 min. */
const FIRST_NUDGE_MIN = 30
const SECOND_NUDGE_MIN = 60

function nudgeAt(fromMs: number, minutes: number): Date {
  return new Date(fromMs + minutes * 60 * 1000)
}

/**
 * Record a piece of unfinished work. If `pendingActionId` is given and an open
 * row already exists for it, the existing row is returned (no duplicates) so an
 * approval card is only ever tracked once.
 */
export async function createOpenTask(input: {
  businessId?: string
  conversationId?: string | null
  title: string
  kind?: OpenTaskKind
  resumeNote: string
  pendingActionId?: string | null
}): Promise<OpenTaskView> {
  const businessId = input.businessId ?? 'ALMA_LIFESTYLE'
  const kind = input.kind ?? 'chat_followup'

  if (input.pendingActionId) {
    const existing = await prisma.agentOpenTask.findFirst({
      where: { pendingActionId: input.pendingActionId, status: { in: ['open', 'running'] } },
    })
    if (existing) return toView(existing)
  }

  const now = Date.now()
  const row = await prisma.agentOpenTask.create({
    data: {
      businessId,
      conversationId: input.conversationId ?? null,
      title: input.title.trim().slice(0, 200),
      kind,
      status: 'open',
      resumeNote: input.resumeNote.trim(),
      pendingActionId: input.pendingActionId ?? null,
      nudgeDueAt: nudgeAt(now, FIRST_NUDGE_MIN),
      nudgedCount: 0,
    },
  })
  return toView(row)
}

/** Open / running tasks for a chat, newest first. Drives the inline chip. */
export async function listOpenTasks(conversationId: string, businessId = 'ALMA_LIFESTYLE'): Promise<OpenTaskView[]> {
  // Reconcile against the source of truth for approval cards: if the linked
  // pending action was already resolved elsewhere, auto-close the open task so
  // the chip never shows a stale "pending approval".
  const rows = await prisma.agentOpenTask.findMany({
    where: { conversationId, businessId, status: { in: ['open', 'running'] } },
    orderBy: { createdAt: 'desc' },
  })

  const pendingIds = rows.map((r) => r.pendingActionId).filter((x): x is string => !!x)
  if (pendingIds.length) {
    const actions = await prisma.agentPendingAction.findMany({
      where: { id: { in: pendingIds } },
      select: { id: true, status: true },
    })
    const resolved = new Set(actions.filter((a) => a.status !== 'pending').map((a) => a.id))
    const stale = rows.filter((r) => r.pendingActionId && resolved.has(r.pendingActionId))
    if (stale.length) {
      await prisma.agentOpenTask.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { status: 'done', completedAt: new Date(), nudgeDueAt: null },
      })
      return rows.filter((r) => !(r.pendingActionId && resolved.has(r.pendingActionId))).map(toView)
    }
  }
  return rows.map(toView)
}

/** Count of open/running tasks for a chat — cheap, for the footer indicator. */
export async function countOpenTasks(conversationId: string, businessId = 'ALMA_LIFESTYLE'): Promise<number> {
  return prisma.agentOpenTask.count({
    where: { conversationId, businessId, status: { in: ['open', 'running'] } },
  })
}

/** Fetch a single task (for the continue flow — returns the resumeNote). */
export async function getOpenTask(id: string): Promise<OpenTaskView | null> {
  const row = await prisma.agentOpenTask.findUnique({ where: { id } })
  return row ? toView(row) : null
}

/** Owner clicked Continue: mark running, stop nudging, hand back the resumeNote. */
export async function markRunning(id: string): Promise<OpenTaskView | null> {
  const row = await prisma.agentOpenTask.update({
    where: { id },
    data: { status: 'running', nudgeDueAt: null },
  }).catch(() => null)
  return row ? toView(row) : null
}

/** Resolve a task as finished or cancelled. */
export async function resolveOpenTask(id: string, status: 'done' | 'cancelled'): Promise<OpenTaskView | null> {
  const row = await prisma.agentOpenTask.update({
    where: { id },
    data: { status, completedAt: new Date(), nudgeDueAt: null },
  }).catch(() => null)
  return row ? toView(row) : null
}

/**
 * Tasks whose nudge is due now (worker/cron polls this). Returns the rows and
 * advances each one's schedule: first due → reschedule to 60 min; second due →
 * stop nudging. Caller is responsible for actually sending the Telegram ping.
 */
export async function dueNudges(businessId = 'ALMA_LIFESTYLE'): Promise<OpenTaskView[]> {
  const now = new Date()
  const rows = await prisma.agentOpenTask.findMany({
    where: { businessId, status: 'open', nudgeDueAt: { lte: now } },
    orderBy: { nudgeDueAt: 'asc' },
  })
  for (const r of rows) {
    const nextCount = (r.nudgedCount ?? 0) + 1
    await prisma.agentOpenTask.update({
      where: { id: r.id },
      data: {
        nudgedCount: nextCount,
        // After the first nudge, schedule the 60-min one; after the second, stop.
        nudgeDueAt: nextCount >= 2 ? null : nudgeAt(r.createdAt.getTime(), SECOND_NUDGE_MIN),
      },
    })
  }
  return rows.map(toView)
}

/**
 * Cron tick: notify the owner about still-open tasks whose nudge is due (the
 * 30-then-60-minute "এই কাজটি এখনো শেষ হয়নি" reminder). Sends ONE consolidated
 * Telegram message and advances each task's schedule. Safe no-op when nothing
 * is due. Returns how many were nudged.
 */
export async function runOpenTaskNudgeTick(businessId = 'ALMA_LIFESTYLE'): Promise<{ nudged: number }> {
  const due = await dueNudges(businessId)
  if (due.length === 0) return { nudged: 0 }

  const lines = due.map((t) => `• ${t.title}`).join('\n')
  const head =
    due.length === 1
      ? '🔔 একটি কাজ এখনো বাকি আছে, স্যার —'
      : `🔔 ${due.length}টি কাজ এখনো বাকি আছে, স্যার —`
  await sendOwnerText(`${head}\n${lines}\n\nএগুলো চালিয়ে যেতে চান? চ্যাটে "বাকি কাজ" থেকে চালিয়ে যাও চাপুন।`).catch(
    () => ({ ok: false }),
  )
  return { nudged: due.length }
}

type Row = {
  id: string
  title: string
  kind: string
  status: string
  resumeNote: string
  pendingActionId: string | null
  createdAt: Date
}

function toView(r: Row): OpenTaskView {
  return {
    id: r.id,
    title: r.title,
    kind: (r.kind as OpenTaskKind) ?? 'chat_followup',
    status: (r.status as OpenTaskStatus) ?? 'open',
    resumeNote: r.resumeNote,
    pendingActionId: r.pendingActionId,
    ageMinutes: Math.max(0, Math.round((Date.now() - r.createdAt.getTime()) / 60000)),
    createdAt: r.createdAt.toISOString(),
  }
}
