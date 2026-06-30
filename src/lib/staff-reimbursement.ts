import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { createApprovalRequest, dispatchApprovalsUpdated, resolveApprovalRequestById } from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { persistExpenseFromPayload } from '@/lib/finance-expense'
import { apiDataSuccess, apiFailure } from '@/lib/safe-api-response'

/**
 * Staff own-pocket expense → reimbursement (ALMA_LIFESTYLE, owner decision 2026-06-30).
 *
 * Any logged-in staff member who paid for something out of their own pocket can
 * file a claim. It lands in the owner's approval center. On approval BOTH happen,
 * atomically from the staffer's view:
 *   1. the cost is recorded as a real company expense (LifestyleExpense), and
 *   2. the same amount is credited to that staffer's wallet (REIMBURSEMENT).
 * On rejection nothing is created. The owner is the only approver.
 */

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'
const REIMBURSEMENT_SOURCE = 'office_reimbursement'

export interface ReimbursementClaimInput {
  businessId?: string
  /** Staff GAS employee id — the wallet that gets credited on approval. */
  employeeId: string
  /** User.id of the requester. */
  userId: string
  actorName: string
  amount: number
  category: string
  note?: string | null
  vendor?: string | null
  receiptRef?: string | null
  receiptAttachmentId?: string | null
}

/** File a reimbursement claim → PENDING approval for the owner. */
export async function enqueueReimbursementClaim(input: ReimbursementClaimInput) {
  const businessId = input.businessId || LIFESTYLE_BUSINESS_ID
  const amount = roundMoney(input.amount)
  const category = (input.category || 'Reimbursement').trim() || 'Reimbursement'
  const note = input.note ? String(input.note).slice(0, 500) : null

  // The snapshot doubles as the expense-create payload (snake_case keys that
  // createLifestyleExpenseInPostgres reads) plus reimbursement routing fields.
  const payload: Record<string, unknown> = {
    business_id: businessId,
    category,
    amount,
    title: `${input.actorName} · নিজ খরচ ফেরত`,
    desc: note,
    note,
    vendor: input.vendor ? String(input.vendor).slice(0, 160) : null,
    payment_method: 'Own pocket',
    payment_status: 'Reimbursed',
    receipt_ref: input.receiptRef ? String(input.receiptRef).slice(0, 600) : null,
    receipt_attachment_id: input.receiptAttachmentId || null,
    actor: input.actorName,
    actor_role: 'STAFF',
    actor_user_id: input.userId,
    reimburse_employee_id: input.employeeId,
    reimburse_user_id: input.userId,
    reimburse_amount: amount,
  }

  return createApprovalRequest({
    module: APPROVAL_MODULES.FINANCE,
    type: APPROVAL_TYPES.EXPENSE_REIMBURSEMENT,
    businessId,
    entityId: `reimbursement:${randomUUID()}`,
    requestedBy: input.userId,
    reason: `${category} · ৳${amount.toLocaleString('en-BD')} (নিজ খরচ)`,
    payloadSnapshot: payload,
    priority: amount >= 10000 ? 'HIGH' : 'NORMAL',
    actionUrl: '/approvals',
    title: 'Reimbursement needs approval',
    message: `${input.actorName} · ${category} · ৳${amount.toLocaleString('en-BD')} — নিজ পকেট থেকে`,
  })
}

/**
 * Owner approves/rejects a reimbursement claim from the central approval center.
 * Mirrors processExpenseAdd's return shape (NextResponse via apiDataSuccess).
 */
export async function processReimbursementApproval(
  approval: { id: string; payloadSnapshot: unknown; businessId: string | null },
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  note?: string,
) {
  if (action === 'REJECT') {
    const updated = await resolveApprovalRequestById({
      id: approval.id,
      status: 'REJECTED',
      actorUserId,
      reason: note || 'Rejected',
    })
    dispatchApprovalsUpdated()
    return apiDataSuccess({ approval: updated, moduleResult: { created: false, reimbursed: false, rejected: true } })
  }

  const snapshot = approval.payloadSnapshot && typeof approval.payloadSnapshot === 'object'
    ? (approval.payloadSnapshot as Record<string, unknown>)
    : null
  if (!snapshot) {
    return apiFailure('missing_snapshot', 'Reimbursement approval has no saved data to create from.', { status: 400 })
  }

  // 1) Record the company expense (verbatim replay, like a normal expense add).
  const { result, expenseId } = await persistExpenseFromPayload(snapshot)
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    return apiFailure('expense_create_failed', String(result.error), { status: 400 })
  }

  // 2) Credit the staffer's wallet (REIMBURSEMENT). Idempotent via (source, sourceRef).
  const businessId = String(snapshot.business_id || approval.businessId || LIFESTYLE_BUSINESS_ID)
  const employeeId = String(snapshot.reimburse_employee_id || '').trim()
  const userId = String(snapshot.reimburse_user_id || '').trim() || null
  const amount = roundMoney(Number(snapshot.reimburse_amount || snapshot.amount || 0))
  const category = String(snapshot.category || 'Reimbursement')

  let reimbursed = false
  let ledgerEntryId: string | null = null
  if (employeeId && amount > 0) {
    try {
      const entry = await prisma.employeeLedgerEntry.create({
        data: {
          employeeId,
          userId,
          businessId,
          date: new Date(),
          periodYm: null, // null avoids the one-entry-per-period-per-type unique constraint
          type: 'REIMBURSEMENT',
          amount: moneyDecimal(amount),
          note: `নিজ খরচ ফেরত · ${category}${expenseId ? ` · exp:${expenseId}` : ''}`,
          createdById: actorUserId || null,
          approvedById: actorUserId || null,
          source: REIMBURSEMENT_SOURCE,
          sourceRef: approval.id,
        },
        select: { id: true },
      })
      ledgerEntryId = entry.id
      reimbursed = true
    } catch (e) {
      // Already credited for this approval (retry) → treat as success, do not double-pay.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        reimbursed = true
      } else {
        throw e
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
    moduleResult: { created: true, expenseId, reimbursed, ledgerEntryId, amount },
  })
}
