import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { moneyDecimal } from '@/lib/payroll-wallet'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  resolveApprovalRequestById,
} from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { recordFundEntry, OFFICE_FUND_BUSINESS_ID } from '@/lib/office-fund'
import { persistExpenseFromPayload } from '@/lib/finance-expense'
import { apiDataSuccess, apiFailure } from '@/lib/safe-api-response'

/** How leftover (unspent) advance money is returned at reconciliation. */
export type LeftoverMethod = 'CASH_RETURN' | 'WALLET_DEDUCT'
const RECONCILE_WALLET_SOURCE = 'office_advance_reconcile'

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

// ── Phase D: reconciliation (spent vs leftover) ──────────────────────────────

export interface OfficeAdvanceReconcileInput {
  /** The OUTSTANDING advance being accounted for. */
  advanceId: string
  /** The user filing the reconcile (must own the advance). */
  userId: string
  actorName: string
  /** Whole taka actually spent on office work. */
  spent: number
  /** How any leftover is returned: cash back to fund, or deducted from wallet. */
  leftoverMethod: LeftoverMethod
  category?: string | null
  note?: string | null
}

/**
 * Admin files a reconciliation for an OUTSTANDING advance → PENDING approval.
 * Anti-scam: BOTH leftover routes (cash return / wallet deduct) require the
 * owner to approve. Nothing is created until approval. The advance stays
 * OUTSTANDING until the owner approves the reconcile.
 */
export async function enqueueOfficeAdvanceReconcile(input: OfficeAdvanceReconcileInput) {
  const advance = await db().findFirst({
    where: { id: input.advanceId, userId: input.userId },
    select: {
      id: true, businessId: true, employeeId: true, userId: true, amount: true,
      status: true, purpose: true, requestedByName: true,
    },
  })
  if (!advance) throw new Error('advance_not_found')
  if (advance.status !== 'OUTSTANDING') throw new Error('advance_not_outstanding')

  const total = roundMoney(advance.amount)
  const spent = roundMoney(input.spent)
  if (spent < 0 || spent > total) throw new Error('spent_out_of_range')
  const leftover = roundMoney(total - spent)
  const leftoverMethod: LeftoverMethod = input.leftoverMethod === 'WALLET_DEDUCT' ? 'WALLET_DEDUCT' : 'CASH_RETURN'
  const businessId = advance.businessId || OFFICE_FUND_BUSINESS_ID
  const category = (input.category || 'Office expense').trim() || 'Office expense'
  const note = input.note ? String(input.note).slice(0, 500) : null

  // The snapshot doubles as the spent-expense create payload (snake_case keys
  // persistExpenseFromPayload reads) plus reconcile-routing fields.
  const payload: Record<string, unknown> = {
    office_advance_id: advance.id,
    business_id: businessId,
    employee_id: advance.employeeId,
    user_id: advance.userId,
    actor: input.actorName,
    actor_role: 'ADMIN',
    actor_user_id: advance.userId,
    advance_amount: total,
    spent_amount: spent,
    leftover_amount: leftover,
    leftover_method: leftoverMethod,
    // Expense-create fields (only persisted when spent > 0):
    category,
    amount: spent,
    title: `${input.actorName} · অফিস অ্যাডভান্স খরচ`,
    desc: note || advance.purpose || null,
    note: note || advance.purpose || null,
    payment_method: 'Office fund',
    payment_status: 'Paid',
  }

  const leftoverLine =
    leftover > 0
      ? ` · বাকি ৳${leftover.toLocaleString('en-BD')} ${leftoverMethod === 'WALLET_DEDUCT' ? '(ওয়ালেট থেকে কাটা)' : '(ক্যাশ ফেরত)'}`
      : ''
  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.FINANCE,
    type: APPROVAL_TYPES.OFFICE_FUND_RECONCILE,
    businessId,
    entityId: advance.id,
    requestedBy: advance.userId || input.userId,
    reason: `অফিস অ্যাডভান্স হিসাব · খরচ ৳${spent.toLocaleString('en-BD')}${leftoverLine}`,
    payloadSnapshot: payload,
    priority: leftover > 0 ? 'HIGH' : 'NORMAL',
    actionUrl: '/approvals',
    title: 'Office advance reconcile needs approval',
    message: `${input.actorName} · খরচ ৳${spent.toLocaleString('en-BD')} / মোট ৳${total.toLocaleString('en-BD')}${leftoverLine}`,
  })

  await db().update({ where: { id: advance.id }, data: { reconcileApprovalId: approval.id } })
  return { advanceId: advance.id, approval, spent, leftover, leftoverMethod }
}

/**
 * Owner approves/rejects an office-advance reconcile. On approval:
 *   1. record the spent portion as a real company expense (LifestyleExpense),
 *   2. credit the leftover back to the fund (RETURN_IN) so the fund only ever
 *      loses what was truly spent, and
 *   3. if the leftover is settled by WALLET_DEDUCT, debit the admin's wallet by
 *      the leftover (ADJUSTMENT, negative — idempotent), recovering the cash.
 * Then the advance is marked SETTLED (clears My Desk). On rejection the advance
 * stays OUTSTANDING so it can be re-filed.
 */
export async function processOfficeAdvanceReconcileApproval(
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
  const employeeId = String(snapshot.employee_id || '').trim()
  const userId = String(snapshot.user_id || '').trim() || null
  const spent = roundMoney(Number(snapshot.spent_amount || 0))
  const leftover = roundMoney(Number(snapshot.leftover_amount || 0))
  const leftoverMethod: LeftoverMethod = snapshot.leftover_method === 'WALLET_DEDUCT' ? 'WALLET_DEDUCT' : 'CASH_RETURN'
  const category = String(snapshot.category || 'Office expense')

  if (action === 'REJECT') {
    if (advanceId) {
      await db().updateMany({
        where: { id: advanceId, status: 'OUTSTANDING' },
        data: { reconcileApprovalId: null },
      })
    }
    const updated = await resolveApprovalRequestById({
      id: approval.id,
      status: 'REJECTED',
      actorUserId,
      reason: note || 'Rejected',
    })
    dispatchApprovalsUpdated()
    return apiDataSuccess({ approval: updated, moduleResult: { advanceId, settled: false, rejected: true } })
  }

  if (!advanceId) {
    return apiFailure('missing_advance', 'Reconcile approval has no saved advance to settle.', { status: 400 })
  }

  // Guard against re-running side effects on retry: settle the advance first and
  // only proceed when this call is the one that transitioned it.
  const moved = await db().updateMany({
    where: { id: advanceId, status: 'OUTSTANDING' },
    data: {
      status: 'SETTLED',
      spentAmount: spent,
      leftoverAmount: leftover,
      leftoverMethod,
      settledAt: new Date(),
    },
  })

  let expenseId: string | null = null
  let fundBalance: number | null = null
  let walletDeducted = false
  let walletEntryId: string | null = null

  if (moved.count > 0) {
    // 1) Spent portion → company expense (verbatim replay).
    if (spent > 0) {
      const { result, expenseId: eid } = await persistExpenseFromPayload(snapshot)
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        return apiFailure('expense_create_failed', String(result.error), { status: 400 })
      }
      expenseId = eid || null
    }

    // 2) Leftover → fund made whole.
    if (leftover > 0) {
      const entry = await recordFundEntry({
        businessId,
        type: 'RETURN_IN',
        amount: leftover,
        note: `অফিস অ্যাডভান্স ফেরত · ${category}${leftoverMethod === 'WALLET_DEDUCT' ? ' (ওয়ালেট থেকে)' : ' (ক্যাশ)'}`,
        refType: 'office_advance_reconcile',
        refId: advanceId,
        createdById: actorUserId,
        createdByName: String(snapshot.actor || '') || null,
      })
      fundBalance = entry.balance

      // 3) WALLET_DEDUCT → recover the leftover from the admin's wallet.
      if (leftoverMethod === 'WALLET_DEDUCT' && employeeId) {
        try {
          const led = await prisma.employeeLedgerEntry.create({
            data: {
              employeeId,
              userId,
              businessId,
              date: new Date(),
              periodYm: null,
              type: 'ADJUSTMENT',
              amount: moneyDecimal(-leftover), // negative → reduces wallet balance
              note: `অফিস অ্যাডভান্স উদ্বৃত্ত ফেরত · ${category}`,
              createdById: actorUserId || null,
              approvedById: actorUserId || null,
              source: RECONCILE_WALLET_SOURCE,
              sourceRef: approval.id,
            },
            select: { id: true },
          })
          walletEntryId = led.id
          walletDeducted = true
        } catch (e) {
          // Already deducted for this approval (retry) → not a double-charge.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            walletDeducted = true
          } else {
            throw e
          }
        }
      }
    }
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
    moduleResult: {
      advanceId,
      settled: moved.count > 0,
      spent,
      leftover,
      leftoverMethod,
      expenseId,
      fundBalance,
      walletDeducted,
      walletEntryId,
    },
  })
}
