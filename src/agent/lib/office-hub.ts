/**
 * Office Owner Hub — server-side data for the owner's centralized office view.
 *
 * Reads from `staff_tasks` (the existing task engine) plus the Phase-A office
 * tables (`office_comments`, `office_task_events`, `office_weekly_awards`). No
 * mutations here — actions go through /api/assistant/office/action.
 */
import { prisma } from '@/lib/prisma'
import { buildStaffFriendlyDetail } from '@/agent/lib/staff-task-format'

const ACTIVE_STATUSES = ['sent', 'approved', 'carried'] as const

/** Verification states that put a task in the owner's approval queue. */
const PENDING_REVIEW_VS = ['proof_submitted', 'auto_verified'] as const

/** Minutes before an unanswered update request is escalated to the owner. */
export const UPDATE_ESCALATE_MINUTES = 10

export type OfficeAuthor = 'owner' | 'staff' | 'agent' | 'system'

export type HubTaskCard = {
  id: string
  title: string
  detail: string | null
  type: string
  productRef: string | null
  status: string
  verificationStatus: string
  proofType: string | null
  proofData: Record<string, unknown> | null
  reviewerNote: string | null
  redoCount: number
  source: string
  staffId: string
  staffName: string
  createdAt: string
}

export type OverdueUpdateCard = {
  id: string
  title: string
  staffId: string
  staffName: string
  requestedAt: string
  requestedBy: string | null
  note: string | null
  /** Seconds left before owner escalation (negative = already overdue). */
  secondsLeft: number
  escalated: boolean
}

export type ActivityItem = {
  id: string
  taskId: string
  kind: string
  summary: string
  actorType: string
  createdAt: string
}

export type HubAward = {
  staffId: string
  staffName: string
  score: number
  auto: boolean
  pinnedByOwner: boolean
  note: string | null
  weekStart: string
} | null

export type OwnerHubData = {
  businessId: string
  kpis: { pending: number; active: number; overdue: number; doneToday: number }
  pendingApproval: HubTaskCard[]
  selfInitiated: HubTaskCard[]
  overdueUpdates: OverdueUpdateCard[]
  activity: ActivityItem[]
  award: HubAward
}

/** Dhaka-local YYYY-MM-DD. */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function toCard(t: {
  id: string
  title: string
  detail: string | null
  type: string
  productRef: string | null
  status: string
  verificationStatus: string
  proofType: string | null
  proofData: unknown
  reviewerNote: string | null
  redoCount: number
  source: string
  staffId: string
  createdAt: Date
  staff: { name: string } | null
}): HubTaskCard {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    type: t.type,
    productRef: t.productRef,
    status: t.status,
    verificationStatus: t.verificationStatus,
    proofType: t.proofType,
    proofData: asRecord(t.proofData),
    reviewerNote: t.reviewerNote,
    redoCount: t.redoCount ?? 0,
    source: t.source,
    staffId: t.staffId,
    staffName: t.staff?.name ?? 'অজানা',
    createdAt: t.createdAt.toISOString(),
  }
}

const CARD_SELECT = {
  id: true,
  title: true,
  detail: true,
  type: true,
  productRef: true,
  status: true,
  verificationStatus: true,
  proofType: true,
  proofData: true,
  reviewerNote: true,
  redoCount: true,
  source: true,
  staffId: true,
  createdAt: true,
  staff: { select: { name: true } },
} as const

export async function getOwnerHubData(businessId = 'ALMA_LIFESTYLE'): Promise<OwnerHubData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()

  const [pendingRows, selfRows, activeCount, doneToday, updateRows, events, awardRow] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { businessId, verificationStatus: { in: [...PENDING_REVIEW_VS] } },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, status: 'proposed', source: 'staff_initiated' },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.count({
      where: { businessId, proposedFor: todayDate, status: { in: [...ACTIVE_STATUSES] } },
    }),
    prisma.agentStaffTask.count({
      where: { businessId, proposedFor: todayDate, status: 'done' },
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, updateRequestedAt: { not: null } },
      orderBy: { updateRequestedAt: 'asc' },
      select: {
        id: true,
        title: true,
        staffId: true,
        updateRequestedAt: true,
        updateRequestedBy: true,
        updateRequestNote: true,
        lastStaffUpdateAt: true,
        escalatedAt: true,
        status: true,
        staff: { select: { name: true } },
      },
    }),
    prisma.officeTaskEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, taskId: true, kind: true, summary: true, actorType: true, createdAt: true },
    }),
    prisma.officeWeeklyAward.findFirst({
      where: { businessId },
      orderBy: { weekStart: 'desc' },
      select: {
        staffId: true,
        score: true,
        auto: true,
        pinnedByOwner: true,
        note: true,
        weekStart: true,
        staff: { select: { name: true } },
      },
    }),
  ])

  // Overdue updates: a request is open until the staff answers it (a later
  // lastStaffUpdateAt) or it's resolved. Still-open ones drive the countdown.
  const overdueUpdates: OverdueUpdateCard[] = updateRows
    .filter((t) => {
      if (t.status === 'done') return false
      if (!t.updateRequestedAt) return false
      const answered = t.lastStaffUpdateAt && t.lastStaffUpdateAt.getTime() >= t.updateRequestedAt.getTime()
      return !answered
    })
    .map((t) => {
      const reqMs = t.updateRequestedAt!.getTime()
      const deadline = reqMs + UPDATE_ESCALATE_MINUTES * 60_000
      return {
        id: t.id,
        title: t.title,
        staffId: t.staffId,
        staffName: t.staff?.name ?? 'অজানা',
        requestedAt: t.updateRequestedAt!.toISOString(),
        requestedBy: t.updateRequestedBy,
        note: t.updateRequestNote,
        secondsLeft: Math.round((deadline - now) / 1000),
        escalated: Boolean(t.escalatedAt),
      }
    })

  let award: HubAward = null
  if (awardRow) {
    award = {
      staffId: awardRow.staffId,
      staffName: awardRow.staff?.name ?? 'অজানা',
      score: awardRow.score,
      auto: awardRow.auto,
      pinnedByOwner: awardRow.pinnedByOwner,
      note: awardRow.note,
      weekStart: awardRow.weekStart.toISOString().slice(0, 10),
    }
  }

  return {
    businessId,
    kpis: {
      pending: pendingRows.length,
      active: activeCount,
      overdue: overdueUpdates.length,
      doneToday,
    },
    pendingApproval: pendingRows.map(toCard),
    selfInitiated: selfRows.map(toCard),
    overdueUpdates,
    activity: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      summary: e.summary,
      actorType: e.actorType,
      createdAt: e.createdAt.toISOString(),
    })),
    award,
  }
}

export type ThreadMessage = {
  id: string
  authorType: string
  authorStaffId: string | null
  kind: string
  body: string
  attachments: unknown
  createdAt: string
}

export type TaskThread = {
  task: HubTaskCard | null
  comments: ThreadMessage[]
  events: ActivityItem[]
}

// ── Staff-side office data ──────────────────────────────────────────────────

export type StaffTaskCard = HubTaskCard & {
  needsUpdate: boolean
  updateNote: string | null
  updateSecondsLeft: number
  proofImageUrl: string | null
  friendlyDetail: string
}

export type StaffOfficeData = {
  staffId: string
  staffName: string
  businessId: string
  today: string
  active: StaffTaskCard[]
  done: StaffTaskCard[]
  proposals: StaffTaskCard[]
  isWinner: boolean
  award: HubAward
}

function pickImage(data: Record<string, unknown> | null): string | null {
  if (!data) return null
  for (const k of ['imageUrl', 'image', 'photo', 'url', 'fileUrl']) {
    const v = data[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  return null
}

const VISIBLE_STAFF_STATUSES = ['sent', 'approved', 'carried', 'awaiting_proof', 'done'] as const

export async function getStaffOfficeData(
  staff: { id: string; name: string; businessId: string },
): Promise<StaffOfficeData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()

  const [rows, proposalRows, awardRow] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, proposedFor: todayDate, status: { in: [...VISIBLE_STAFF_STATUSES] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, status: 'proposed', source: 'staff_initiated' },
      orderBy: { createdAt: 'desc' },
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.officeWeeklyAward.findFirst({
      where: { businessId: staff.businessId },
      orderBy: { weekStart: 'desc' },
      select: { staffId: true, score: true, auto: true, pinnedByOwner: true, note: true, weekStart: true, staff: { select: { name: true } } },
    }),
  ])

  const toStaffCard = (t: (typeof rows)[number]): StaffTaskCard => {
    const base = toCard(t)
    const reqAt = t.updateRequestedAt
    const answered = reqAt && t.lastStaffUpdateAt && t.lastStaffUpdateAt.getTime() >= reqAt.getTime()
    const needsUpdate = Boolean(reqAt) && !answered && t.status !== 'done'
    const deadline = reqAt ? reqAt.getTime() + UPDATE_ESCALATE_MINUTES * 60_000 : 0
    return {
      ...base,
      needsUpdate,
      updateNote: t.updateRequestNote ?? null,
      updateSecondsLeft: reqAt ? Math.round((deadline - now) / 1000) : 0,
      proofImageUrl: pickImage(base.proofData),
      friendlyDetail: buildStaffFriendlyDetail({
        title: t.title,
        type: t.type,
        productRef: t.productRef,
        detail: t.detail,
      }),
    }
  }

  const cards = rows.map(toStaffCard)
  const active = cards.filter((c) => c.status !== 'done')
  const done = cards.filter((c) => c.status === 'done')

  let award: HubAward = null
  if (awardRow) {
    award = {
      staffId: awardRow.staffId,
      staffName: awardRow.staff?.name ?? 'অজানা',
      score: awardRow.score,
      auto: awardRow.auto,
      pinnedByOwner: awardRow.pinnedByOwner,
      note: awardRow.note,
      weekStart: awardRow.weekStart.toISOString().slice(0, 10),
    }
  }

  return {
    staffId: staff.id,
    staffName: staff.name,
    businessId: staff.businessId,
    today,
    active,
    done,
    proposals: proposalRows.map(toStaffCard),
    isWinner: Boolean(awardRow && awardRow.staffId === staff.id),
    award,
  }
}

export async function getTaskThread(taskId: string, businessId = 'ALMA_LIFESTYLE'): Promise<TaskThread> {
  const [task, comments, events] = await Promise.all([
    prisma.agentStaffTask.findFirst({
      where: { id: taskId, businessId },
      select: CARD_SELECT,
    }),
    prisma.officeComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        authorType: true,
        authorStaffId: true,
        kind: true,
        body: true,
        attachments: true,
        createdAt: true,
      },
    }),
    prisma.officeTaskEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, taskId: true, kind: true, summary: true, actorType: true, createdAt: true },
    }),
  ])

  return {
    task: task ? toCard(task) : null,
    comments: comments.map((c) => ({
      id: c.id,
      authorType: c.authorType,
      authorStaffId: c.authorStaffId,
      kind: c.kind,
      body: c.body,
      attachments: c.attachments,
      createdAt: c.createdAt.toISOString(),
    })),
    events: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      summary: e.summary,
      actorType: e.actorType,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}
