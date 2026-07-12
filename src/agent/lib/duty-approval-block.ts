/**
 * Phase C — day-shift duty blocked on owner approval: mark todo pending, notify, escalate.
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

export const DUTY_PENDING_APPROVAL_DESCRIPTION =
  '⏳ Boss, এটা হয়নি — আপনার approval লাগবে। approve দিলে শেষ করবো।'

export interface DutyApprovalBlock {
  dutyKey: string
  label: string
  title: string
  pendingActionId?: string
  linkedActionType?: string
}

function tomorrowYmdFrom(dateYmd: string): string {
  const d = new Date(`${dateYmd}T12:00:00+06:00`)
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function dateRangeYmd(ymd: string): { start: Date; end: Date } {
  return {
    start: new Date(`${ymd}T00:00:00+06:00`),
    end: new Date(`${ymd}T23:59:59.999+06:00`),
  }
}

async function pendingDispatchForDate(targetDate: string) {
  const rows = await prisma.agentPendingAction.findMany({
    where: { type: 'dispatch_staff_tasks', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, summary: true, payload: true },
  })
  return rows.find((r) => {
    const payload = r.payload && typeof r.payload === 'object'
      ? (r.payload as Record<string, unknown>)
      : {}
    const d = String(payload.date ?? '').slice(0, 10)
    return d === targetDate
  }) ?? null
}

async function hasProposedUnapprovedForDate(targetDate: string): Promise<boolean> {
  const { start, end } = dateRangeYmd(targetDate)
  const proposed = await prisma.agentStaffTask.count({
    where: { proposedFor: { gte: start, lte: end }, status: 'proposed' },
  })
  if (proposed === 0) return false
  const approvedOrSent = await prisma.agentStaffTask.count({
    where: {
      proposedFor: { gte: start, lte: end },
      status: { in: ['approved', 'sent', 'done', 'completed'] },
    },
  })
  return approvedOrSent === 0
}

async function pendingAdsOptimizerBatch(since: Date) {
  return prisma.agentPendingAction.findFirst({
    where: {
      type: 'ads_optimizer_batch',
      status: 'pending',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true },
  })
}

async function getDutyLogRow(dutyKey: string, date: string) {
  return prisma.agentDutyLog.findUnique({
    where: { duty_dutyDate: { duty: dutyKey, dutyDate: date } },
  })
}

/** True when this duty cannot finish until owner approves something. */
export async function checkDutyApprovalBlock(
  dutyKey: string,
  date: string,
  label: string,
): Promise<DutyApprovalBlock | null> {
  const log = await getDutyLogRow(dutyKey, date)
  const logDetail = (log?.detail ?? '').toLowerCase()

  if (dutyKey === 'morning_dispatch') {
    const dispatch = await pendingDispatchForDate(date)
    if (dispatch) {
      return {
        dutyKey,
        label,
        title: label,
        pendingActionId: dispatch.id,
        linkedActionType: 'dispatch_staff_tasks',
      }
    }
    if (await hasProposedUnapprovedForDate(date)) {
      return { dutyKey, label, title: label, linkedActionType: 'dispatch_staff_tasks' }
    }
  }

  if (dutyKey === 'evening_proposal' || dutyKey === 'approval_chase') {
    const tomorrow = tomorrowYmdFrom(date)
    const dispatch = await pendingDispatchForDate(tomorrow)
    if (dispatch) {
      return {
        dutyKey,
        label,
        title: label,
        pendingActionId: dispatch.id,
        linkedActionType: 'dispatch_staff_tasks',
      }
    }
    if (dutyKey === 'approval_chase' && (await hasProposedUnapprovedForDate(tomorrow))) {
      return { dutyKey, label, title: label, linkedActionType: 'dispatch_staff_tasks' }
    }
  }

  if (dutyKey === 'ads_optimizer') {
    const { start } = dateRangeYmd(date)
    const batch = await pendingAdsOptimizerBatch(start)
    if (batch) {
      return {
        dutyKey,
        label,
        title: label,
        pendingActionId: batch.id,
        linkedActionType: 'ads_optimizer_batch',
      }
    }
  }

  if (log?.status === 'skipped' && /approve|approval|gate|pending|অনুমোদন/.test(logDetail)) {
    return { dutyKey, label, title: label }
  }

  return null
}

/** Idempotent duty_approval_block row for escalation poller + get_pending_approvals. */
export async function recordDutyApprovalBlock(
  block: DutyApprovalBlock,
  date: string,
  conversationId?: string,
): Promise<string> {
  const rows = await prisma.agentPendingAction.findMany({
    where: { type: 'duty_approval_block', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, payload: true },
  })

  const existing = rows.find((r) => {
    const p = r.payload && typeof r.payload === 'object'
      ? (r.payload as Record<string, unknown>)
      : {}
    return p.dutyKey === block.dutyKey && p.dutyDate === date
  })

  if (existing) return existing.id

  const now = new Date().toISOString()
  const created = await prisma.agentPendingAction.create({
    data: {
      conversationId: conversationId ?? null,
      type: 'duty_approval_block',
      payload: {
        dutyKey: block.dutyKey,
        dutyLabel: block.label,
        dutyDate: date,
        linkedActionId: block.pendingActionId ?? null,
        linkedActionType: block.linkedActionType ?? null,
        escalationLevel: 0,
        blockedAt: now,
        notifiedAt: now,
      },
      summary: `⏳ "${block.label}" — office duty approval লাগবে`,
      status: 'pending',
    },
  })
  return created.id
}

export async function notifyDutyApprovalBlocked(
  label: string,
  appendNarrative: (text: string) => Promise<void>,
): Promise<void> {
  const msg = `⏳ Boss, "${label}" আপনার approval ছাড়া আটকে আছে।`
  await appendNarrative(msg)
  void sendOwnerText(msg).catch(() => {})
}

/** Resolve duty blocks when linked approval is granted. */
export async function resolveDutyBlocksForLinkedAction(linkedActionId: string): Promise<void> {
  const rows = await prisma.agentPendingAction.findMany({
    where: { type: 'duty_approval_block', status: 'pending' },
    take: 50,
    select: { id: true, payload: true },
  })
  const toResolve = rows.filter((r) => {
    const p = r.payload && typeof r.payload === 'object'
      ? (r.payload as Record<string, unknown>)
      : {}
    return p.linkedActionId === linkedActionId
  })
  if (toResolve.length === 0) return
  await prisma.agentPendingAction.updateMany({
    where: { id: { in: toResolve.map((r) => r.id) } },
    data: { status: 'approved', resolvedAt: new Date() },
  })
}
