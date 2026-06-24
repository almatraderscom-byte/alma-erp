/**
 * Office staff actions — the in-app counterpart to the Telegram task flow.
 * A logged-in staff member can mark done, submit proof, reply in a task thread,
 * answer an update request, and propose self-initiated work. Each action writes
 * the office timeline + an owner-bucket notification and pings the owner.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { shouldVerifyTaskType, proofPromptForType, type ProofType } from '@/agent/lib/task-verification'
import { pushOwnerPing } from '@/agent/lib/office-notify'

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export type StaffResult =
  | { ok: true; status: string; needsProof?: boolean; proofMessage?: string }
  | { ok: false; error: string; code: number }

export type SessionStaff = { id: string; name: string; businessId: string }

/** Resolve the active staff record linked to a logged-in user, or null. */
export async function resolveSessionStaff(userId: string | undefined | null): Promise<SessionStaff | null> {
  if (!userId) return null
  const staff = await prisma.agentStaff.findFirst({
    where: { userId, active: true },
    select: { id: true, name: true, businessId: true },
  })
  return staff
}

async function logEvent(
  tx: Tx,
  args: { taskId: string; kind: string; summary: string; businessId: string; meta?: Record<string, unknown> },
) {
  await tx.officeTaskEvent.create({
    data: {
      taskId: args.taskId,
      kind: args.kind,
      summary: args.summary,
      actorType: 'staff',
      businessId: args.businessId,
      meta: args.meta === undefined ? undefined : (args.meta as Prisma.InputJsonValue),
    },
  })
}

/** Owner-bucket notification: recipientStaffId + recipientUserId both null. */
async function notifyOwnerBucket(
  tx: Tx,
  args: { taskId: string; kind: string; title: string; body?: string; businessId: string },
) {
  await tx.officeNotification.create({
    data: {
      taskId: args.taskId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      businessId: args.businessId,
    },
  })
}

/** Load a task and assert it belongs to this staff member. */
async function loadOwnedTask(taskId: string, staff: SessionStaff) {
  const task = await prisma.agentStaffTask.findFirst({
    where: { id: taskId, staffId: staff.id, businessId: staff.businessId },
  })
  return task
}

/** Staff marks a task done → instant done, or awaiting_proof if the type needs proof. */
export async function staffMarkDone(taskId: string, staff: SessionStaff): Promise<StaffResult> {
  const task = await loadOwnedTask(taskId, staff)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }
  if (task.status === 'done') return { ok: true, status: 'done' }

  const now = new Date()
  const needProof = await shouldVerifyTaskType(task.type)

  if (!needProof) {
    await prisma.$transaction(async (tx) => {
      await tx.agentStaffTask.update({
        where: { id: taskId },
        data: { status: 'done', verificationStatus: 'not_required', completedAt: now, proofType: 'none' },
      })
      await logEvent(tx, { taskId, kind: 'completed', summary: `${staff.name} কাজটি সম্পন্ন করেছেন ✅`, businessId: staff.businessId })
      await notifyOwnerBucket(tx, { taskId, kind: 'completed', title: `${staff.name}: কাজ সম্পন্ন ✅`, body: task.title, businessId: staff.businessId })
    })
    await pushOwnerPing(`${staff.name}: কাজ সম্পন্ন ✅`, task.title)
    return { ok: true, status: 'done' }
  }

  const prompt = proofPromptForType(task.type)
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'awaiting_proof',
        verificationStatus: 'awaiting_proof',
        proofData: { proofRequestedAt: now.toISOString() },
      },
    })
    await logEvent(tx, { taskId, kind: 'awaiting_proof', summary: 'কাজ শেষ — প্রমাণের অপেক্ষায়', businessId: staff.businessId })
  })
  return { ok: true, status: 'awaiting_proof', needsProof: true, proofMessage: prompt.message }
}

/** Staff submits proof (image + optional note) → proof_submitted for owner review. */
export async function staffSubmitProof(
  taskId: string,
  staff: SessionStaff,
  args: { proofType?: ProofType; imageUrl?: string; text?: string },
): Promise<StaffResult> {
  const task = await loadOwnedTask(taskId, staff)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const imageUrl = args.imageUrl?.trim()
  const text = args.text?.trim()
  if (!imageUrl && !text) return { ok: false, error: 'empty_proof', code: 400 }

  const now = new Date()
  const proofType: ProofType = args.proofType ?? (imageUrl ? 'photo' : 'text')

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: task.status === 'done' ? task.status : 'awaiting_proof',
        verificationStatus: 'proof_submitted',
        proofType,
        proofData: {
          ...(task.proofData as object ?? {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(text ? { text } : {}),
          submittedAt: now.toISOString(),
        },
      },
    })
    if (text) {
      await tx.officeComment.create({
        data: { taskId, authorType: 'staff', authorStaffId: staff.id, kind: 'submission', body: text, businessId: staff.businessId, seenByStaff: true, attachments: imageUrl ? [{ type: 'image', url: imageUrl }] : undefined },
      })
    }
    await logEvent(tx, { taskId, kind: 'submitted', summary: `${staff.name} প্রমাণ জমা দিয়েছেন 📷`, businessId: staff.businessId })
    await notifyOwnerBucket(tx, { taskId, kind: 'comment', title: `${staff.name}: প্রমাণ জমা 📷`, body: task.title, businessId: staff.businessId })
  })
  await pushOwnerPing(`${staff.name}: প্রমাণ জমা — অনুমোদন দিন`, task.title)
  return { ok: true, status: 'proof_submitted' }
}

/** Staff posts a reply in a task thread → notifies owner. */
export async function staffComment(taskId: string, staff: SessionStaff, body: string): Promise<StaffResult> {
  const text = body?.trim()
  if (!text) return { ok: false, error: 'empty_body', code: 400 }
  const task = await loadOwnedTask(taskId, staff)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  await prisma.$transaction(async (tx) => {
    await tx.officeComment.create({
      data: { taskId, authorType: 'staff', authorStaffId: staff.id, kind: 'comment', body: text, businessId: staff.businessId, seenByStaff: true },
    })
    await logEvent(tx, { taskId, kind: 'comment', summary: `${staff.name} মন্তব্য করেছেন`, businessId: staff.businessId })
    await notifyOwnerBucket(tx, { taskId, kind: 'comment', title: `${staff.name}: মন্তব্য 💬`, body: text, businessId: staff.businessId })
  })
  await pushOwnerPing(`${staff.name}: মন্তব্য 💬`, text)
  return { ok: true, status: task.status }
}

/** Staff answers an update request → clears the escalation countdown + notifies owner. */
export async function staffUpdate(taskId: string, staff: SessionStaff, body: string): Promise<StaffResult> {
  const text = body?.trim()
  if (!text) return { ok: false, error: 'empty_body', code: 400 }
  const task = await loadOwnedTask(taskId, staff)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: { lastStaffUpdateAt: now },
    })
    await tx.officeComment.create({
      data: { taskId, authorType: 'staff', authorStaffId: staff.id, kind: 'comment', body: text, businessId: staff.businessId, seenByStaff: true },
    })
    await logEvent(tx, { taskId, kind: 'update_given', summary: `${staff.name} আপডেট দিয়েছেন`, businessId: staff.businessId })
    await notifyOwnerBucket(tx, { taskId, kind: 'comment', title: `${staff.name}: আপডেট দিয়েছেন ✅`, body: text, businessId: staff.businessId })
  })
  await pushOwnerPing(`${staff.name}: আপডেট দিয়েছেন ✅`, text)
  return { ok: true, status: task.status }
}

/** Staff proposes self-initiated work → status proposed, awaits owner approval. */
export async function staffCreateSelfInitiated(
  staff: SessionStaff,
  args: { title: string; detail?: string; type?: string },
): Promise<StaffResult> {
  const title = args.title?.trim()
  if (!title) return { ok: false, error: 'empty_title', code: 400 }

  // Dhaka-local today for proposedFor.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const created = await prisma.$transaction(async (tx) => {
    const task = await tx.agentStaffTask.create({
      data: {
        staffId: staff.id,
        title,
        detail: args.detail?.trim() || null,
        type: args.type?.trim() || 'misc',
        status: 'proposed',
        source: 'staff_initiated',
        proposedFor: new Date(`${today}T00:00:00Z`),
        businessId: staff.businessId,
      },
    })
    await logEvent(tx, { taskId: task.id, kind: 'self_initiated', summary: `${staff.name} নিজ উদ্যোগে একটি কাজ প্রস্তাব করেছেন ✨`, businessId: staff.businessId })
    await notifyOwnerBucket(tx, { taskId: task.id, kind: 'self_initiated', title: `${staff.name}: নিজ উদ্যোগের কাজ ✨`, body: title, businessId: staff.businessId })
    return task
  })
  await pushOwnerPing(`${staff.name}: নিজ উদ্যোগের কাজ — অনুমোদন দিন ✨`, title)
  return { ok: true, status: created.status }
}
