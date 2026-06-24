/**
 * Office owner actions — task mutations that also write the office timeline,
 * comment thread, and in-app notifications (Phase-A tables).
 *
 * These mirror the Telegram task-callback verification flow (approve / redo)
 * but for the in-app Owner Hub, and add comment + update-request actions that
 * Telegram never had. In-app notification rows are created here; the actual
 * Telegram/ntfy push is layered on in Phase D.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { pushStaffPing } from '@/agent/lib/office-notify'

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function logEvent(
  tx: Tx,
  args: {
    taskId: string
    kind: string
    summary: string
    actorType: string
    businessId: string
    meta?: Record<string, unknown>
  },
) {
  await tx.officeTaskEvent.create({
    data: {
      taskId: args.taskId,
      kind: args.kind,
      summary: args.summary,
      actorType: args.actorType,
      businessId: args.businessId,
      meta: args.meta === undefined ? undefined : (args.meta as Prisma.InputJsonValue),
    },
  })
}

async function notifyStaff(
  tx: Tx,
  args: { staffId: string; taskId: string; kind: string; title: string; body?: string; businessId: string },
) {
  await tx.officeNotification.create({
    data: {
      recipientStaffId: args.staffId,
      taskId: args.taskId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      businessId: args.businessId,
    },
  })
}

async function loadTask(taskId: string, businessId: string) {
  return prisma.agentStaffTask.findFirst({
    where: { id: taskId, businessId },
    include: { staff: { select: { id: true, name: true, telegramChatId: true, ntfyTopic: true } } },
  })
}

export type ActionResult = { ok: true; status: string } | { ok: false; error: string; code: number }

/** Owner approves a submitted task → done / owner_approved. */
export async function approveTask(taskId: string, businessId: string): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: { status: 'done', verificationStatus: 'owner_approved', completedAt: now },
    })
    await logEvent(tx, {
      taskId,
      kind: 'approved',
      summary: 'মালিক কাজটি অনুমোদন করেছেন ✅',
      actorType: 'owner',
      businessId,
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'approved',
      title: 'কাজ অনুমোদিত ✅',
      body: task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'কাজ অনুমোদিত ✅', task.title)
  return { ok: true, status: 'done' }
}

/** Owner requests a redo with a revision note → back to sent / redo_requested. */
export async function redoTask(taskId: string, businessId: string, note?: string): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const trimmed = note?.trim() || null
  const redoCount = (task.redoCount ?? 0) + 1
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'sent',
        verificationStatus: 'redo_requested',
        reviewerNote: trimmed,
        redoCount,
        proofType: null,
        completedAt: null,
        proofData: { redoAt: now.toISOString(), redoCount },
      },
    })
    if (trimmed) {
      await tx.officeComment.create({
        data: {
          taskId,
          authorType: 'owner',
          kind: 'revision_request',
          body: trimmed,
          businessId,
        },
      })
    }
    await logEvent(tx, {
      taskId,
      kind: 'redo_requested',
      summary: trimmed ? `সংশোধন চাওয়া হয়েছে: ${trimmed}` : 'সংশোধন চাওয়া হয়েছে 🔄',
      actorType: 'owner',
      businessId,
      meta: { redoCount },
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'redo',
      title: 'সংশোধন দরকার 🔄',
      body: trimmed ?? task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'সংশোধন দরকার 🔄', trimmed ?? task.title)
  return { ok: true, status: 'sent' }
}

/** Owner (or agent) posts a comment on a task thread → notifies the staff. */
export async function addComment(
  taskId: string,
  businessId: string,
  args: { body: string; authorType?: 'owner' | 'agent'; authorUserId?: string | null },
): Promise<ActionResult> {
  const body = args.body?.trim()
  if (!body) return { ok: false, error: 'empty_body', code: 400 }

  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const authorType = args.authorType ?? 'owner'
  await prisma.$transaction(async (tx) => {
    await tx.officeComment.create({
      data: {
        taskId,
        authorType,
        authorUserId: args.authorUserId ?? null,
        kind: 'comment',
        body,
        businessId,
        seenByOwner: authorType === 'owner',
      },
    })
    await logEvent(tx, {
      taskId,
      kind: 'comment',
      summary: authorType === 'owner' ? 'মালিক একটি মন্তব্য করেছেন' : 'এজেন্ট একটি মন্তব্য করেছে',
      actorType: authorType,
      businessId,
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'comment',
      title: 'নতুন মন্তব্য 💬',
      body,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'নতুন মন্তব্য 💬', body)
  return { ok: true, status: task.status }
}

/** Owner/agent asks the staff for a progress update → starts the escalation clock. */
export async function requestUpdate(
  taskId: string,
  businessId: string,
  args: { note?: string; by?: 'owner' | 'agent' },
): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const note = args.note?.trim() || null
  const by = args.by ?? 'owner'
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        updateRequestedAt: now,
        updateRequestedBy: by,
        updateRequestNote: note,
        escalatedAt: null,
      },
    })
    await logEvent(tx, {
      taskId,
      kind: 'update_requested',
      summary: note ? `আপডেট চাওয়া হয়েছে: ${note}` : 'কাজের আপডেট চাওয়া হয়েছে',
      actorType: by,
      businessId,
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'update_request',
      title: 'আপডেট দিন ⏰',
      body: note ?? task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'কাজের আপডেট দিন ⏰', note ?? task.title)
  return { ok: true, status: task.status }
}

/** Owner approves or rejects a staff-initiated task. */
export async function decideSelfInitiated(
  taskId: string,
  businessId: string,
  decision: 'approve' | 'reject',
): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }
  if (task.status !== 'proposed') return { ok: false, error: 'not_proposed', code: 409 }

  const approve = decision === 'approve'
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: { status: approve ? 'sent' : 'cancelled' },
    })
    await logEvent(tx, {
      taskId,
      kind: approve ? 'self_initiated_approved' : 'self_initiated_rejected',
      summary: approve
        ? 'নিজ উদ্যোগের কাজ অনুমোদিত — পারফরম্যান্সে যোগ হবে ✨'
        : 'নিজ উদ্যোগের কাজ বাতিল',
      actorType: 'owner',
      businessId,
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: approve ? 'approved' : 'redo',
      title: approve ? 'আপনার কাজ অনুমোদিত ✨' : 'কাজ অনুমোদন হয়নি',
      body: task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, approve ? 'আপনার কাজ অনুমোদিত ✨' : 'কাজ অনুমোদন হয়নি', task.title)
  return { ok: true, status: approve ? 'sent' : 'cancelled' }
}
