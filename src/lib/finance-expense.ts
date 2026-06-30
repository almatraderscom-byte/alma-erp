import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { serverPost } from '@/lib/server-api'
import { createLifestyleExpenseInPostgres } from '@/lib/lifestyle/write'
import { createApprovalRequest } from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'

/** Run the real expense create (Postgres for Lifestyle, GAS otherwise) and link any receipt. */
export async function persistExpenseFromPayload(payload: Record<string, unknown>) {
  const businessId = String(payload.business_id || LIFESTYLE_BUSINESS_ID)
  const result = businessId === LIFESTYLE_BUSINESS_ID
    ? await createLifestyleExpenseInPostgres(payload)
    : await serverPost('add_expense', payload)
  const attachmentId = String(payload.receipt_attachment_id || '').trim()
  const expenseId = String(
    (result as { expense_id?: string; exp_id?: string }).expense_id
    || (result as { exp_id?: string }).exp_id
    || '',
  )
  if (attachmentId && expenseId) {
    await prisma.expenseAttachment.updateMany({
      where: { id: attachmentId, deletedAt: null },
      data: { expenseId },
    })
  }
  return { result, expenseId, businessId }
}

/**
 * Owner directive (2026-06-30): an expense added by anyone other than the Super
 * Admin must first land in the approval center; it is only created once the
 * owner approves (or never, if rejected). The full add payload is stored in the
 * approval snapshot so the create can be replayed verbatim on approval.
 */
export async function enqueueExpenseApproval(payload: Record<string, unknown>) {
  const businessId = String(payload.business_id || LIFESTYLE_BUSINESS_ID)
  const amount = Number(payload.amount || 0)
  const category = String(payload.category || 'Expense')
  const actor = String(payload.actor || 'Staff')
  return createApprovalRequest({
    module: APPROVAL_MODULES.FINANCE,
    type: APPROVAL_TYPES.EXPENSE_ADD,
    businessId,
    entityId: `expense:${randomUUID()}`,
    requestedBy: String(payload.actor_user_id || ''),
    reason: `${category} · ৳${amount.toLocaleString('en-BD')}`,
    payloadSnapshot: payload,
    priority: amount >= 10000 ? 'HIGH' : 'NORMAL',
    actionUrl: '/approvals',
    title: 'Expense needs approval',
    message: `${actor} · ${category} · ৳${amount.toLocaleString('en-BD')}`,
  })
}
