/**
 * Office penalty / reward proposals.
 *
 * The supervisor can *propose* a penalty or a reward for a staff member, but it
 * NEVER touches payroll, the wallet, or any ledger — money decisions stay with
 * the owner. A proposal is just a suggestion row the owner approves or dismisses
 * from the office section. Approving a reward congratulates the staff; approving
 * a penalty only records the owner's decision (he applies the actual deduction
 * in the ERP himself). This keeps the live financial code untouched.
 */
import { prisma } from '@/lib/prisma'
import { pushOwnerPing, pushStaffPing } from '@/agent/lib/office-notify'

export type ProposalKind = 'penalty' | 'reward'

export type ProposalCard = {
  id: string
  staffId: string
  staffName: string
  taskId: string | null
  taskTitle: string | null
  kind: ProposalKind
  amount: number | null
  reason: string
  createdAt: string
}

/**
 * Raise a penalty/reward proposal for the owner. Idempotent per (taskId, kind):
 * if a pending proposal for the same task + kind already exists, it's a no-op.
 * Returns the proposal id, or null when skipped/failed (best-effort).
 */
export async function raiseProposal(args: {
  businessId: string
  staffId: string
  kind: ProposalKind
  reason: string
  taskId?: string | null
  amount?: number | null
  meta?: Record<string, unknown>
}): Promise<string | null> {
  const reason = args.reason?.trim()
  if (!reason) return null

  try {
    if (args.taskId) {
      const existing = await prisma.officeStaffProposal.findFirst({
        where: { businessId: args.businessId, taskId: args.taskId, kind: args.kind, status: 'pending' },
        select: { id: true },
      })
      if (existing) return existing.id
    }

    const proposal = await prisma.officeStaffProposal.create({
      data: {
        businessId: args.businessId,
        staffId: args.staffId,
        taskId: args.taskId ?? null,
        kind: args.kind,
        amount: typeof args.amount === 'number' ? Math.round(args.amount) : null,
        reason,
        meta: args.meta ? (args.meta as object) : undefined,
      },
      select: { id: true },
    })

    const staff = await prisma.agentStaff.findUnique({ where: { id: args.staffId }, select: { name: true } })
    const who = staff?.name ?? 'একজন স্টাফ'
    const head = args.kind === 'penalty' ? '⚠️ জরিমানার প্রস্তাব' : '🎁 পুরস্কারের প্রস্তাব'
    await pushOwnerPing(head, `${who} — ${reason}\n(অফিস সেকশনে অনুমোদন/বাতিল করুন)`)
    return proposal.id
  } catch {
    // Best-effort: a proposal failure must never break the supervisor tick.
    return null
  }
}

/** Pending proposals for the owner's office section, newest first. */
export async function listPendingProposals(businessId = 'ALMA_LIFESTYLE'): Promise<ProposalCard[]> {
  const rows = await prisma.officeStaffProposal.findMany({
    where: { businessId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, staffId: true, taskId: true, kind: true, amount: true, reason: true, createdAt: true },
  })
  if (rows.length === 0) return []

  const staffIds = [...new Set(rows.map((r) => r.staffId))]
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((v): v is string => Boolean(v)))]
  const [staff, tasks] = await Promise.all([
    prisma.agentStaff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }),
    taskIds.length
      ? prisma.agentStaffTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } })
      : Promise.resolve([] as { id: string; title: string }[]),
  ])
  const nameById = new Map(staff.map((s) => [s.id, s.name]))
  const titleById = new Map(tasks.map((t) => [t.id, t.title]))

  return rows.map((r) => ({
    id: r.id,
    staffId: r.staffId,
    staffName: nameById.get(r.staffId) ?? 'অজানা',
    taskId: r.taskId,
    taskTitle: r.taskId ? (titleById.get(r.taskId) ?? null) : null,
    kind: r.kind as ProposalKind,
    amount: r.amount,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }))
}

export type ProposalDecisionResult = { ok: true } | { ok: false; error: string; code: number }

/**
 * Owner approves or dismisses a proposal. Approving a REWARD congratulates the
 * staff; approving a PENALTY only records the decision (no payroll write — the
 * owner applies the actual deduction in the ERP). Never mutates any ledger here.
 */
export async function decideProposal(
  id: string,
  businessId: string,
  decision: 'approve' | 'dismiss',
  ownerUserId?: string | null,
): Promise<ProposalDecisionResult> {
  const proposal = await prisma.officeStaffProposal.findFirst({
    where: { id, businessId },
    select: { id: true, staffId: true, taskId: true, kind: true, amount: true, reason: true, status: true },
  })
  if (!proposal) return { ok: false, error: 'proposal_not_found', code: 404 }
  if (proposal.status !== 'pending') return { ok: false, error: 'already_decided', code: 409 }

  const now = new Date()
  await prisma.officeStaffProposal.update({
    where: { id },
    data: { status: decision === 'approve' ? 'approved' : 'dismissed', decidedBy: ownerUserId ?? null, decidedAt: now },
  })

  if (decision === 'approve') {
    // Audit on the task timeline when the proposal is tied to a task.
    if (proposal.taskId) {
      try {
        await prisma.officeTaskEvent.create({
          data: {
            taskId: proposal.taskId,
            kind: proposal.kind === 'penalty' ? 'penalty_approved' : 'reward_approved',
            summary:
              proposal.kind === 'penalty'
                ? `মালিক জরিমানা অনুমোদন করেছেন — ${proposal.reason}`
                : `মালিক পুরস্কার অনুমোদন করেছেন 🎁 — ${proposal.reason}`,
            actorType: 'owner',
            businessId,
          },
        })
      } catch {
        /* best-effort audit */
      }
    }
    // Only rewards are surfaced to the staff (positive). Penalties stay between
    // the owner and the ERP — the agent doesn't message the staff about money.
    if (proposal.kind === 'reward') {
      const staff = await prisma.agentStaff.findUnique({
        where: { id: proposal.staffId },
        select: { id: true, name: true, telegramChatId: true, ntfyTopic: true },
      })
      if (staff) {
        try {
          await prisma.officeNotification.create({
            data: {
              recipientStaffId: staff.id,
              taskId: proposal.taskId ?? null,
              kind: 'award',
              title: 'ভালো কাজের স্বীকৃতি 🎁',
              body: proposal.reason,
              businessId,
            },
          })
        } catch {
          /* best-effort */
        }
        await pushStaffPing(staff, 'ভালো কাজের স্বীকৃতি 🎁', proposal.reason)
      }
    }
  }

  return { ok: true }
}
