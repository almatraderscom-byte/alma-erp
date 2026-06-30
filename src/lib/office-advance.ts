import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  resolveApprovalRequestById,
} from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { recordFundEntry, OFFICE_FUND_BUSINESS_ID } from '@/lib/office-fund'
import { apiDataSuccess, apiFailure } from '@/lib/safe-api-response'

/**
 * Office-fund advances (ALMA_LIFESTYLE, owner decision 2026-06-30).
 *
 * An admin draws office cash for office work. The request lands in the owner's
 * approval center carrying the amount, purpose, and the bKash/wallet number the
 * owner should send to. On approval the owner sends the money MANUALLY (no
 * finance API exists), the fund is debited (OfficeFundEntry ADVANCE_OUT), and
 * the advance becomes OUTSTANDING — it shows on the admin's My Desk until it is
 * reconciled (Phase D: spent + leftover). It is the company's money throughout,
 * never the admin's salary/wallet.
 *
 * Admin-only: regular staff use the own-pocket reimbursement flow instead.
 */

const ADVANCE_REF_TYPE = 'office_advance'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  // Cast keeps this resilient to Prisma client-generation timing in CI.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).officeAdvance
}

export interface OfficeAdvanceRequestInput {
  businessId?: string
  /** Admin's HR employee id. */
  employeeId: string
  userId: string
  requestedByName: string
  amount: number
  purpose?: string | null
  payoutMethod?: string | null
  payoutNumber?: string | null
}

/** Admin files an office-advance request → PENDING approval for the owner. */
export async function enqueueOfficeAdvanceRequest(input: OfficeAdvanceRequestInput) {
  const businessId = input.businessId || OFFICE_FUND_BUSINESS_ID
  const amount = roundMoney(input.amount)
  if (!(amount > 0)) throw new Error('advance_amount_must_be_positive')

  const purpose = input.purpose ? String(input.purpose).slice(0, 500) : null
  const payoutMethod = input.payoutMethod ? String(input.payoutMethod).slice(0, 60) : null
  const payoutNumber = input.payoutNumber ? String(input.payoutNumber).slice(0, 60) : null

  // 1) Create the OfficeAdvance row (PENDING) — the source of truth for My Desk.
  const advance = await db().create({
    data: {
      businessId,
      employeeId: input.employeeId,
      userId: input.userId,
      requestedByName: input.requestedByName,
      amount,
      purpose,
      payoutMethod,
      payoutNumber,
      status: 'PENDING',
      createdById: input.userId,
    },
    select: { id: true },
  })

  // 2) Route it through the central approval center (owner approves).
  const payoutLine = payoutNumber ? ` · ${payoutMethod || 'পেমেন্ট'}: ${payoutNumber}` : ''
  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.FINANCE,
    type: APPROVAL_TYPES.OFFICE_FUND_ADVANCE,
    businessId,
    entityId: advance.id,
    requestedBy: input.userId,
    reason: `অফিস অ্যাডভান্স · ৳${amount.toLocaleString('en-BD')}${purpose ? ` · ${purpose}` : ''}`,
    payloadSnapshot: {
      office_advance_id: advance.id,
      business_id: businessId,
      employee_id: input.employeeId,
      user_id: input.userId,
      actor: input.requestedByName,
      amount,
      purpose,
      payout_method: payoutMethod,
      payout_number: payoutNumber,
    },
    priority: amount >= 10000 ? 'HIGH' : 'NORMAL',
    actionUrl: '/approvals',
    title: 'Office advance needs approval',
    message: `${input.requestedByName} · অফিস অ্যাডভান্স · ৳${amount.toLocaleString('en-BD')}${payoutLine}`,
  })

  // Link the approval back onto the advance row.
  await db().update({ where: { id: advance.id }, data: { approvalId: approval.id } })

  return { advance, approval }
}

/**
 * Owner approves/rejects an office-advance request from the approval center.
 * On approval: debit the fund (ADVANCE_OUT) and mark the advance OUTSTANDING
 * (owner then sends the money manually). On rejection: mark REJECTED.
 * Mirrors the apiDataSuccess return shape used by the other approval handlers.
 */
export async function processOfficeAdvanceApproval(
  approval: { id: string; entityId: string; payloadSnapshot: unknown; businessId: string | null },
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  note?: string,
) {
  const snapshot = approval.payloadSnapshot && typeof approval.payloadSnapshot === 'object'
    ? (approval.payloadSnapshot as Record<string, unknown>)
    : {}
  const advanceId = String(snapshot.office_advance_id || approval.entityId || '').trim()
  const businessId = String(snapshot.business_id || approval.businessId || OFFICE_FUND_BUSINESS_ID)
  const amount = roundMoney(Number(snapshot.amount || 0))

  if (action === 'REJECT') {
    if (advanceId) {
      await db().updateMany({
        where: { id: advanceId, status: 'PENDING' },
        data: { status: 'REJECTED', approvedById: actorUserId },
      })
    }
    const updated = await resolveApprovalRequestById({
      id: approval.id,
      status: 'REJECTED',
      actorUserId,
      reason: note || 'Rejected',
    })
    dispatchApprovalsUpdated()
    return apiDataSuccess({ approval: updated, moduleResult: { advanceId, approved: false, rejected: true } })
  }

  if (!advanceId || !(amount > 0)) {
    return apiFailure('missing_advance', 'Office advance approval has no saved data to disburse.', { status: 400 })
  }

  // Guard against double-disbursing on retry: only debit the fund the first time
  // the advance leaves PENDING. updateMany returns the affected count.
  const moved = await db().updateMany({
    where: { id: advanceId, status: 'PENDING' },
    data: { status: 'OUTSTANDING', approvedById: actorUserId, approvedAt: new Date() },
  })

  let fundBalance: number | null = null
  if (moved.count > 0) {
    const entry = await recordFundEntry({
      businessId,
      type: 'ADVANCE_OUT',
      amount,
      note: `অফিস অ্যাডভান্স · ${String(snapshot.actor || '')}`.trim(),
      refType: ADVANCE_REF_TYPE,
      refId: advanceId,
      createdById: actorUserId,
      createdByName: String(snapshot.actor || '') || null,
    })
    fundBalance = entry.balance
  }

  const updated = await resolveApprovalRequestById({
    id: approval.id,
    status: 'APPROVED',
    actorUserId,
    reason: note || 'Approved',
  })
  dispatchApprovalsUpdated()
  return apiDataSuccess({
    approval: updated,
    moduleResult: { advanceId, approved: true, amount, fundBalance, disbursed: moved.count > 0 },
  })
}

export interface OfficeAdvanceRow {
  id: string
  amount: number
  purpose: string | null
  payoutMethod: string | null
  payoutNumber: string | null
  status: string
  spentAmount: number | null
  leftoverAmount: number | null
  approvedAt: string | null
  settledAt: string | null
  createdAt: string
}

type RawAdvance = {
  id: string
  amount: number
  purpose: string | null
  payoutMethod: string | null
  payoutNumber: string | null
  status: string
  spentAmount: number | null
  leftoverAmount: number | null
  approvedAt: Date | null
  settledAt: Date | null
  createdAt: Date
}

function toRow(a: RawAdvance): OfficeAdvanceRow {
  return {
    id: a.id,
    amount: roundMoney(a.amount),
    purpose: a.purpose,
    payoutMethod: a.payoutMethod,
    payoutNumber: a.payoutNumber,
    status: a.status,
    spentAmount: a.spentAmount == null ? null : roundMoney(a.spentAmount),
    leftoverAmount: a.leftoverAmount == null ? null : roundMoney(a.leftoverAmount),
    approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
    settledAt: a.settledAt ? a.settledAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  }
}

/** The signed-in admin's own office advances (newest first). */
export async function listOfficeAdvancesForUser(
  userId: string,
  businessId: string = OFFICE_FUND_BUSINESS_ID,
  limit = 50,
): Promise<OfficeAdvanceRow[]> {
  const rows: RawAdvance[] = await db().findMany({
    where: { userId, businessId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(100, limit)),
    select: {
      id: true, amount: true, purpose: true, payoutMethod: true, payoutNumber: true,
      status: true, spentAmount: true, leftoverAmount: true, approvedAt: true,
      settledAt: true, createdAt: true,
    },
  })
  return rows.map(toRow)
}

/** Outstanding (approved, not yet reconciled) advances for a user — drives My Desk. */
export async function getOutstandingAdvancesForUser(
  userId: string,
  businessId: string = OFFICE_FUND_BUSINESS_ID,
): Promise<{ count: number; total: number; rows: OfficeAdvanceRow[] }> {
  const rows: RawAdvance[] = await db().findMany({
    where: { userId, businessId, status: 'OUTSTANDING' },
    orderBy: { approvedAt: 'desc' },
    select: {
      id: true, amount: true, purpose: true, payoutMethod: true, payoutNumber: true,
      status: true, spentAmount: true, leftoverAmount: true, approvedAt: true,
      settledAt: true, createdAt: true,
    },
  })
  const mapped = rows.map(toRow)
  const total = roundMoney(mapped.reduce((s, r) => s + r.amount, 0))
  return { count: mapped.length, total, rows: mapped }
}
