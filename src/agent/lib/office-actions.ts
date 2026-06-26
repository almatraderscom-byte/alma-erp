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
import { pushStaffPing, pushOwnerPing } from '@/agent/lib/office-notify'

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
    // The question/nudge lives in the task's own thread (not a flat group chat),
    // so the staff reply lands against the right task and the supervisor can read
    // it back on its next tick.
    if (note) {
      await tx.officeComment.create({
        data: { taskId, authorType: by, kind: 'comment', body: note, businessId },
      })
    }
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

/** Bangla Asia/Dhaka label for a deadline, e.g. "২৪ জুন ৫:০০ PM". */
function bnDueLabel(d: Date): string {
  const date = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' }).format(d)
  const time = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
  return `${date} ${time}`
}

/**
 * Owner sets (or clears) the deadline for a task. Pass a valid ISO string to set
 * it, or null to clear. Records a timeline event and pings the staff so they
 * know the deadline. Used by the office board's deadline picker.
 */
export async function setTaskDue(taskId: string, businessId: string, dueAtIso: string | null): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  let dueAt: Date | null = null
  if (dueAtIso) {
    const parsed = new Date(dueAtIso)
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: 'invalid_due', code: 400 }
    dueAt = parsed
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({ where: { id: taskId }, data: { dueAt } })
    await logEvent(tx, {
      taskId,
      kind: 'due_set',
      summary: dueAt ? `সময়সীমা নির্ধারণ: ${bnDueLabel(dueAt)} ⏳` : 'সময়সীমা সরানো হয়েছে',
      actorType: 'owner',
      businessId,
      meta: dueAt ? { dueAt: dueAt.toISOString() } : undefined,
    })
    if (dueAt) {
      await notifyStaff(tx, {
        staffId: task.staff.id,
        taskId,
        kind: 'due_set',
        title: 'কাজের সময়সীমা ⏳',
        body: `"${task.title}" — ${bnDueLabel(dueAt)} এর মধ্যে শেষ করুন`,
        businessId,
      })
    }
  })
  if (dueAt) await pushStaffPing(task.staff, 'কাজের সময়সীমা ⏳', `"${task.title}" — ${bnDueLabel(dueAt)} এর মধ্যে শেষ করুন`)
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

// ── Phase-2 supervisor actions (agent acting autonomously on ~90% of tasks) ──

/**
 * Supervisor auto-verifies a task and closes it (done). This is the agent
 * standing in for the owner on the ~90% it can confirm. Records an agent
 * timeline event and notifies the staff. `evidence` is a short Bangla note on
 * how it was verified (e.g. "ছবি যাচাই হয়েছে — QC 88/100").
 */
export async function agentAutoVerify(
  taskId: string,
  businessId: string,
  args: { evidence?: string; method?: string } = {},
): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const now = new Date()
  const evidence = args.evidence?.trim() || 'এজেন্ট স্বয়ংক্রিয়ভাবে যাচাই করেছে'
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'done',
        verificationStatus: 'auto_verified',
        completedAt: now,
        supervisorNeedsOwner: false,
        supervisorLastTickAt: now,
        proofData: {
          ...((task.proofData as object) ?? {}),
          agentVerifiedAt: now.toISOString(),
          agentEvidence: evidence,
          agentMethod: args.method ?? 'supervisor',
        },
      },
    })
    await logEvent(tx, {
      taskId,
      kind: 'agent_verified',
      summary: `এজেন্ট যাচাই করে কাজটি সম্পন্ন করেছে ✅ — ${evidence}`,
      actorType: 'agent',
      businessId,
      meta: { method: args.method ?? 'supervisor' },
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'approved',
      title: 'কাজ যাচাই হয়েছে ✅',
      body: task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'কাজ যাচাই হয়েছে ✅', task.title)
  return { ok: true, status: 'done' }
}

/** Supervisor sends a task back for redo (failed verification) — actorType agent. */
export async function agentRequestRedo(taskId: string, businessId: string, note: string): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const trimmed = note?.trim() || 'কাজটি আবার ঠিক করে পাঠান'
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
        supervisorLastTickAt: now,
        proofData: { redoAt: now.toISOString(), redoCount, by: 'agent' },
      },
    })
    await tx.officeComment.create({
      data: { taskId, authorType: 'agent', kind: 'revision_request', body: trimmed, businessId },
    })
    await logEvent(tx, {
      taskId,
      kind: 'redo_requested',
      summary: `এজেন্ট সংশোধন চেয়েছে: ${trimmed}`,
      actorType: 'agent',
      businessId,
      meta: { redoCount },
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'redo',
      title: 'সংশোধন দরকার 🔄',
      body: trimmed,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'সংশোধন দরকার 🔄', trimmed)
  return { ok: true, status: 'sent' }
}

/**
 * Supervisor gives up on a task it cannot auto-verify or understand and hands it
 * to the owner (the ~10%). Sets `supervisorNeedsOwner`, records the reason, and
 * pings the owner. Staff are NOT notified (nothing for them to do yet).
 */
export async function escalateToOwner(taskId: string, businessId: string, reason: string): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }
  if (task.supervisorNeedsOwner) return { ok: true, status: task.status }

  const trimmed = reason?.trim() || 'এজেন্ট নিশ্চিত হতে পারেনি'
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        supervisorNeedsOwner: true,
        supervisorLastTickAt: now,
        escalatedAt: now,
        supervisorCriticality: 'critical',
      },
    })
    await logEvent(tx, {
      taskId,
      kind: 'supervisor_escalated',
      summary: `এজেন্ট নিশ্চিত হতে পারেনি — Boss যাচাই করবেন: ${trimmed}`,
      actorType: 'agent',
      businessId,
    })
  })
  await pushOwnerPing('যাচাই দরকার 🔎', `"${task.title}" — ${trimmed}`)
  return { ok: true, status: task.status }
}

/**
 * Phase-3 90/10 gate, non-critical branch: the supervisor couldn't fully verify
 * a LOW-stakes task, but the staff did submit work — so rather than bother the
 * owner, the agent accepts it as done (clearly logged as unverified-accept) and
 * gently tells the staff. Distinct from agentAutoVerify (a confident pass) so
 * the audit trail and scorecard can tell them apart.
 */
export async function agentAcceptUnverified(
  taskId: string,
  businessId: string,
  note?: string,
): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  const now = new Date()
  const reason = note?.trim() || 'কম-ঝুঁকির কাজ — ধরে নেওয়া হলো সম্পন্ন'
  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: {
        status: 'done',
        verificationStatus: 'auto_verified',
        completedAt: now,
        supervisorNeedsOwner: false,
        supervisorLastTickAt: now,
        supervisorCriticality: 'normal',
        proofData: {
          ...((task.proofData as object) ?? {}),
          agentVerifiedAt: now.toISOString(),
          agentEvidence: reason,
          agentMethod: 'accepted_unverified',
        },
      },
    })
    await logEvent(tx, {
      taskId,
      kind: 'agent_accepted',
      summary: `এজেন্ট কম-ঝুঁকির কাজটি সম্পন্ন ধরে নিয়েছে ✅ — ${reason}`,
      actorType: 'agent',
      businessId,
      meta: { method: 'accepted_unverified' },
    })
    await notifyStaff(tx, {
      staffId: task.staff.id,
      taskId,
      kind: 'approved',
      title: 'কাজ গ্রহণ করা হয়েছে ✅',
      body: task.title,
      businessId,
    })
  })
  await pushStaffPing(task.staff, 'কাজ গ্রহণ করা হয়েছে ✅', task.title)
  return { ok: true, status: 'done' }
}

/** Owner toggles "always escalate this task to me", overriding the criticality gate. */
export async function setAlwaysEscalate(
  taskId: string,
  businessId: string,
  on: boolean,
): Promise<ActionResult> {
  const task = await loadTask(taskId, businessId)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: { supervisorAlwaysEscalate: on },
    })
    await logEvent(tx, {
      taskId,
      kind: 'always_escalate_set',
      summary: on ? 'মালিক এই কাজটি সবসময় দেখতে চেয়েছেন 🔔' : 'সবসময়-জানানো বন্ধ করা হয়েছে',
      actorType: 'owner',
      businessId,
    })
  })
  return { ok: true, status: task.status }
}
