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
import { runAutoQc } from '@/agent/lib/auto-qc'

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * Auto-QC gate for in-app proof submissions. A photo proof is first inspected by
 * Gemini; only HIGH-confidence passes are auto-approved (so they never reach the
 * owner's approval queue). Anything uncertain stays `proof_submitted` for the
 * owner to review by hand. Score must clear this bar AND the verdict be "pass".
 */
const QC_AUTO_ACCEPT_SCORE = 85

/** Fetch a (signed) image URL and return base64 + mime for the vision call. */
async function fetchImageForQc(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const mime = res.headers.get('content-type') || 'image/jpeg'
    if (!mime.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null
    return { base64: buf.toString('base64'), mime }
  } catch {
    return null
  }
}

type QcOutcome = { autoAccept: boolean; qc: Record<string, unknown> | null }

/** Run auto-QC on a proof image; decide whether it clears the auto-accept bar. */
async function evaluateProofQc(imageUrl: string | undefined): Promise<QcOutcome> {
  if (!imageUrl) return { autoAccept: false, qc: null }
  const img = await fetchImageForQc(imageUrl)
  if (!img) return { autoAccept: false, qc: null }
  const result = await runAutoQc(img.base64, img.mime)
  if (!result.ran || typeof result.score !== 'number') return { autoAccept: false, qc: null }
  const qc = { qcScore: result.score, qcVerdict: result.verdict, qcIssues: result.issues ?? [] }
  const autoAccept = result.score >= QC_AUTO_ACCEPT_SCORE && result.verdict === 'pass'
  return { autoAccept, qc }
}

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
  args: { proofType?: ProofType; imageUrl?: string; imageUrls?: string[]; text?: string },
): Promise<StaffResult> {
  const task = await loadOwnedTask(taskId, staff)
  if (!task) return { ok: false, error: 'task_not_found', code: 404 }

  // Accept up to 5 images. `imageUrls` is the new multi-image field; a lone
  // `imageUrl` (older client) is folded in. `imageUrl` stays set to the FIRST
  // image so existing single-image readers keep working.
  const urls = [
    ...(args.imageUrl ? [args.imageUrl] : []),
    ...(Array.isArray(args.imageUrls) ? args.imageUrls : []),
  ]
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, 5)
  const imageUrl = urls[0]
  const text = args.text?.trim()
  if (!imageUrl && !text) return { ok: false, error: 'empty_proof', code: 400 }

  const now = new Date()
  const proofType: ProofType = args.proofType ?? (imageUrl ? 'photo' : 'text')

  // Auto-QC first: a high-confidence pass is auto-approved and never enters the
  // owner's queue; otherwise it stays pending for manual review. Best-effort —
  // any QC failure simply falls back to manual review. QC runs on the first image.
  const { autoAccept, qc } = await evaluateProofQc(imageUrl)

  const proofData = {
    ...((task.proofData as object) ?? {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(urls.length > 0 ? { imageUrls: urls } : {}),
    ...(text ? { text } : {}),
    ...(qc ?? {}),
    submittedAt: now.toISOString(),
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentStaffTask.update({
      where: { id: taskId },
      data: autoAccept
        ? {
            status: 'done',
            verificationStatus: 'owner_approved',
            proofType,
            completedAt: now,
            proofData: { ...proofData, autoApprovedAt: now.toISOString() },
          }
        : {
            status: task.status === 'done' ? task.status : 'awaiting_proof',
            verificationStatus: 'proof_submitted',
            proofType,
            proofData,
          },
    })
    if (text) {
      await tx.officeComment.create({
        data: { taskId, authorType: 'staff', authorStaffId: staff.id, kind: 'submission', body: text, businessId: staff.businessId, seenByStaff: true, attachments: urls.length > 0 ? urls.map((url) => ({ type: 'image', url })) : undefined },
      })
    }
    await logEvent(tx, { taskId, kind: 'submitted', summary: `${staff.name} প্রমাণ জমা দিয়েছেন 📷`, businessId: staff.businessId })
    if (autoAccept) {
      const score = (qc?.qcScore as number) ?? 0
      await logEvent(tx, { taskId, kind: 'approved', summary: `🤖 AI যাচাই করে কাজটি অনুমোদন করেছে (QC ${score}/১০০) ✅`, businessId: staff.businessId })
      await tx.officeNotification.create({
        data: { recipientStaffId: staff.id, taskId, kind: 'approved', title: 'কাজ অনুমোদিত ✅ (AI যাচাই)', body: task.title, businessId: staff.businessId },
      })
    } else {
      await notifyOwnerBucket(tx, { taskId, kind: 'comment', title: `${staff.name}: প্রমাণ জমা 📷`, body: task.title, businessId: staff.businessId })
    }
  })

  if (autoAccept) {
    // Staff is informed via the in-app notification row above; the owner is
    // intentionally NOT pinged since QC already cleared the work.
    return { ok: true, status: 'owner_approved' }
  }

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

/** Dhaka-local YYYY-MM-DD (matches StaffLunch.lunchDate / the worker cron). */
function dhakaLunchDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export type LunchState = { active: boolean; startedAt: string | null; durationMin: number | null }

/** Current open lunch for a staff member today (drives the in-app timer). */
export async function getStaffLunchState(staff: SessionStaff): Promise<LunchState> {
  const open = await prisma.staffLunch.findFirst({
    where: { staffId: staff.id, lunchDate: dhakaLunchDate(), endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (!open) return { active: false, startedAt: null, durationMin: null }
  return { active: true, startedAt: open.startedAt.toISOString(), durationMin: null }
}

/**
 * Staff starts lunch → opens a StaffLunch row (45-min allowance). The VPS worker
 * cron (`lunch-watch`) owns the >45 / ≥60-min overrun alerts to staff + owner,
 * so we only record the start here. Idempotent: a second start while one is open
 * just returns the existing one.
 */
export async function staffStartLunch(staff: SessionStaff): Promise<StaffResult & { startedAt?: string }> {
  const lunchDate = dhakaLunchDate()
  const open = await prisma.staffLunch.findFirst({
    where: { staffId: staff.id, lunchDate, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) return { ok: true, status: 'lunch', startedAt: open.startedAt.toISOString() }

  const now = new Date()
  await prisma.staffLunch.create({
    data: { staffId: staff.id, staffName: staff.name, lunchDate, startedAt: now, businessId: staff.businessId },
  })
  await pushOwnerPing(`${staff.name}: লাঞ্চে গেলেন 🍽️`, '৪৫ মিনিট সময়')
  return { ok: true, status: 'lunch', startedAt: now.toISOString() }
}

/** Staff ends lunch → closes the open row with duration + overage flag. */
export async function staffEndLunch(staff: SessionStaff): Promise<StaffResult & { durationMin?: number }> {
  const lunchDate = dhakaLunchDate()
  const open = await prisma.staffLunch.findFirst({
    where: { staffId: staff.id, lunchDate, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true },
  })
  if (!open) return { ok: false, error: 'no_open_lunch', code: 404 }

  const now = new Date()
  const durationMin = Math.round((now.getTime() - open.startedAt.getTime()) / 60_000)
  await prisma.staffLunch.update({
    where: { id: open.id },
    data: { endedAt: now, durationMin, overage: durationMin > 45 },
  })
  if (durationMin > 45) await pushOwnerPing(`${staff.name}: লাঞ্চ থেকে ফিরেছেন (${durationMin} মিনিট)`, 'একটু বেশি হয়ে গেছে')
  return { ok: true, status: 'back', durationMin }
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
