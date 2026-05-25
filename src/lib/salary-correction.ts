import type { ApprovalRequest } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import {
  createApprovalRequest,
  dispatchApprovalsUpdated,
  resolveApprovalRequest,
  resolveApprovalRequestById,
} from '@/lib/approvals'
import { roundMoney } from '@/lib/money'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { runApprovalTransaction, type ApprovalTx } from '@/lib/prisma-transaction'
import { logEvent } from '@/lib/logger'
import type {
  SalaryCorrectionApprovalResult,
  SalaryCorrectionPayload,
  SalaryCorrectionReversal,
} from '@/types/salary-correction'
import { parseSalaryCorrectionPayload } from '@/types/salary-correction'

export { parseSalaryCorrectionPayload } from '@/types/salary-correction'

export const SALARY_CORRECTION_REVERSAL_SOURCE = 'salary_correction_reversal'

const PERIOD_YM_RE = /^\d{4}-\d{2}$/

export class SalaryCorrectionError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
  }
}

export type CreateSalaryCorrectionInput = {
  accrualEntryId: string
  employeeId: string
  businessId: string
  periodYm: string
  proposedAmount: number
  reversals?: Array<{ ledgerEntryId: string; amount: number; reason: string }>
  requestedReason: string
  requestedById: string
  requestedByName?: string
}

type ApprovalLike = Pick<ApprovalRequest, 'id' | 'entityId' | 'businessId' | 'status' | 'payloadSnapshot'>

function parsePeriodYm(raw: string): string {
  const periodYm = String(raw || '').trim()
  if (!PERIOD_YM_RE.test(periodYm)) {
    throw new SalaryCorrectionError('periodYm must be YYYY-MM.', 400, 'invalid_period')
  }
  return periodYm
}

function normalizeReversals(
  reversals: CreateSalaryCorrectionInput['reversals'],
): SalaryCorrectionReversal[] | undefined {
  if (!reversals?.length) return undefined
  return reversals.map((row, index) => {
    const ledgerEntryId = String(row.ledgerEntryId || '').trim()
    const reason = String(row.reason || '').trim()
    const amount = roundMoney(Number(row.amount))
    if (!ledgerEntryId) {
      throw new SalaryCorrectionError(`reversals[${index}].ledgerEntryId is required.`, 400, 'invalid_reversal')
    }
    if (!reason) {
      throw new SalaryCorrectionError(`reversals[${index}].reason is required.`, 400, 'invalid_reversal')
    }
    if (!Number.isFinite(amount) || amount === 0) {
      throw new SalaryCorrectionError(`reversals[${index}].amount must be non-zero.`, 400, 'invalid_reversal')
    }
    return { ledgerEntryId, amount, reason }
  })
}

async function validateReversalTargets(
  reversals: SalaryCorrectionReversal[],
  employeeId: string,
  businessId: string,
) {
  const ids = [...new Set(reversals.map(r => r.ledgerEntryId))]
  const rows = await prisma.employeeLedgerEntry.findMany({
    where: {
      id: { in: ids },
      employeeId,
      businessId,
      isArchived: false,
    },
    select: { id: true },
  })
  if (rows.length !== ids.length) {
    throw new SalaryCorrectionError('One or more reversal ledger entries were not found for this employee.', 404, 'reversal_not_found')
  }
}

export async function createSalaryCorrectionRequest(input: CreateSalaryCorrectionInput) {
  const accrualEntryId = String(input.accrualEntryId || '').trim()
  const employeeId = String(input.employeeId || '').trim()
  const businessId = String(input.businessId || '').trim()
  const periodYm = parsePeriodYm(input.periodYm)
  const proposedAmount = roundMoney(Number(input.proposedAmount))
  const requestedReason = String(input.requestedReason || '').trim()
  const reversals = normalizeReversals(input.reversals)

  if (!accrualEntryId || !employeeId || !businessId) {
    throw new SalaryCorrectionError('accrualEntryId, employeeId, and businessId are required.', 400, 'invalid_request')
  }
  if (requestedReason.length < 5) {
    throw new SalaryCorrectionError('requestedReason must be at least 5 characters.', 400, 'invalid_request')
  }
  if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) {
    throw new SalaryCorrectionError('proposedAmount must be greater than zero.', 400, 'invalid_request')
  }

  const accrual = await prisma.employeeLedgerEntry.findFirst({
    where: {
      id: accrualEntryId,
      employeeId,
      businessId,
      periodYm,
      type: 'SALARY_ACCRUAL',
      isArchived: false,
    },
  })
  if (!accrual) {
    throw new SalaryCorrectionError('Salary accrual entry not found for this employee and period.', 404, 'accrual_not_found')
  }

  const currentAmount = roundMoney(Number(accrual.amount))
  if (proposedAmount === currentAmount) {
    throw new SalaryCorrectionError('proposedAmount must differ from the current accrual amount.', 400, 'same_amount')
  }

  if (reversals?.length) {
    await validateReversalTargets(reversals, employeeId, businessId)
  }

  const pending = await prisma.approvalRequest.findFirst({
    where: {
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.SALARY_CORRECTION,
      entityId: accrualEntryId,
      status: 'PENDING',
    },
  })
  if (pending) {
    throw new SalaryCorrectionError(
      'A pending salary correction already exists for this accrual.',
      409,
      'duplicate_pending',
    )
  }

  const payload: SalaryCorrectionPayload = {
    accrualEntryId,
    employeeId,
    businessId,
    periodYm,
    currentAmount,
    proposedAmount,
    reversals,
    requestedReason,
    requestedByName: input.requestedByName || undefined,
  }

  const delta = proposedAmount - currentAmount
  const sign = delta >= 0 ? '+' : ''
  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.PAYROLL,
    type: APPROVAL_TYPES.SALARY_CORRECTION,
    businessId,
    entityId: accrualEntryId,
    requestedBy: input.requestedById,
    reason: requestedReason,
    priority: 'HIGH',
    skipNotify: false,
    actionUrl: '/approvals',
    title: 'Salary correction approval required',
    message: `${input.requestedByName || employeeId} · ${sign}৳${Math.abs(delta).toLocaleString('en-BD')} · ${periodYm}`,
    payloadSnapshot: payload as unknown as Record<string, unknown>,
  })

  dispatchApprovalsUpdated()
  logEvent('info', 'salary_correction.request.created', {
    approvalId: approval.id,
    accrualEntryId,
    employeeId,
    businessId,
    periodYm,
  })

  return { approval, payload }
}

async function createReversalEntryInTx(
  tx: ApprovalTx,
  input: {
    approvalId: string
    reviewerId: string
    payload: SalaryCorrectionPayload
    reversal: SalaryCorrectionReversal
  },
) {
  const sourceRef = `salary_correction:${input.approvalId}:reversal:${input.reversal.ledgerEntryId}`
  try {
    return await tx.employeeLedgerEntry.create({
      data: {
        employeeId: input.payload.employeeId,
        businessId: input.payload.businessId,
        date: new Date(),
        periodYm: input.payload.periodYm,
        type: 'ADJUSTMENT',
        amount: moneyDecimal(input.reversal.amount),
        note: `Reverse ${input.reversal.ledgerEntryId}: ${input.reversal.reason}`.slice(0, 800),
        createdById: input.reviewerId,
        approvedById: input.reviewerId,
        source: SALARY_CORRECTION_REVERSAL_SOURCE,
        sourceRef,
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await tx.employeeLedgerEntry.findUnique({
        where: { source_sourceRef: { source: SALARY_CORRECTION_REVERSAL_SOURCE, sourceRef } },
      })
      if (existing) return existing
    }
    throw e
  }
}

export async function processSalaryCorrectionApproval(
  approval: ApprovalLike,
  action: 'APPROVE' | 'REJECT',
  reviewerId: string,
  note?: string,
): Promise<
  | {
      ok: true
      approval: ApprovalRequest | null
      result: SalaryCorrectionApprovalResult
      rejected?: boolean
      alreadyApplied?: boolean
    }
  | { error: string; status: number; code?: string }
> {
  if (!approval.businessId) {
    return { error: 'Salary correction approval is missing business scope.', status: 400, code: 'missing_business' }
  }

  const payload = parseSalaryCorrectionPayload(approval.payloadSnapshot)
  if (!payload) {
    return { error: 'Salary correction payload is invalid or incomplete.', status: 400, code: 'invalid_payload' }
  }

  if (action === 'REJECT') {
    const updated = await resolveApprovalRequestById({
      id: approval.id,
      status: 'REJECTED',
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || 'Rejected',
    })
    dispatchApprovalsUpdated()
    return {
      ok: true,
      approval: updated,
      rejected: true,
      result: { ok: true },
    }
  }

  if (approval.status !== 'PENDING') {
    const row = await prisma.approvalRequest.findUnique({ where: { id: approval.id } })
    return {
      ok: true,
      approval: row,
      alreadyApplied: true,
      result: {
        ok: true,
        updatedAccrualId: payload.accrualEntryId,
        beforeAmount: payload.currentAmount,
        afterAmount: payload.proposedAmount,
      },
    }
  }

  try {
    const txResult = await runApprovalTransaction('salary_correction.approve', async tx => {
      const accrual = await tx.employeeLedgerEntry.findFirst({
        where: {
          id: payload.accrualEntryId,
          employeeId: payload.employeeId,
          businessId: payload.businessId,
          periodYm: payload.periodYm,
          type: 'SALARY_ACCRUAL',
          isArchived: false,
        },
      })
      if (!accrual) throw new Error('ACCRUAL_NOT_FOUND')

      const beforeAmount = roundMoney(Number(accrual.amount))
      const afterAmount = roundMoney(payload.proposedAmount)
      const correctionNote =
        ` [Corrected via approval ${approval.id}: ৳${beforeAmount.toLocaleString('en-BD')} → ৳${afterAmount.toLocaleString('en-BD')}]`
      const baseNote = String(accrual.note || '').trim()
      const newNote = (baseNote + correctionNote).slice(0, 800)

      const updatedAccrual = await tx.employeeLedgerEntry.update({
        where: { id: accrual.id },
        data: {
          amount: moneyDecimal(afterAmount),
          note: newNote || null,
          approvedById: reviewerId,
        },
      })

      const reversalEntries: Array<{ id: string; amount: number; ledgerEntryId: string }> = []
      for (const reversal of payload.reversals || []) {
        const entry = await createReversalEntryInTx(tx, {
          approvalId: approval.id,
          reviewerId,
          payload,
          reversal,
        })
        reversalEntries.push({
          id: entry.id,
          amount: Number(entry.amount),
          ledgerEntryId: reversal.ledgerEntryId,
        })
      }

      const resolved = await resolveApprovalRequest({
        module: APPROVAL_MODULES.PAYROLL,
        type: APPROVAL_TYPES.SALARY_CORRECTION,
        entityId: approval.entityId,
        status: 'APPROVED',
        actorUserId: reviewerId,
        reason: note?.slice(0, 500) || payload.requestedReason,
        tx,
      })
      if (!resolved) throw new Error('LINKAGE_BROKEN')

      return {
        updatedAccrual,
        beforeAmount,
        afterAmount,
        reversalEntries,
        approval: resolved,
      }
    })

    dispatchApprovalsUpdated()
    logEvent('info', 'salary_correction.approved', {
      approvalId: approval.id,
      accrualEntryId: payload.accrualEntryId,
      beforeAmount: txResult.beforeAmount,
      afterAmount: txResult.afterAmount,
      reversalCount: txResult.reversalEntries.length,
    })

    return {
      ok: true,
      approval: txResult.approval,
      result: {
        ok: true,
        updatedAccrualId: txResult.updatedAccrual.id,
        beforeAmount: txResult.beforeAmount,
        afterAmount: txResult.afterAmount,
        reversalEntries: txResult.reversalEntries,
      },
    }
  } catch (e) {
    const message = (e as Error).message || ''
    if (message === 'ACCRUAL_NOT_FOUND') {
      const closed = await resolveApprovalRequestById({
        id: approval.id,
        status: 'REJECTED',
        actorUserId: reviewerId,
        reason: note?.slice(0, 500) || 'Target accrual missing — approval auto-closed',
      })
      dispatchApprovalsUpdated()
      return {
        ok: true,
        approval: closed,
        result: { ok: false, error: 'Target accrual was not found; approval closed.' },
        alreadyApplied: false,
      }
    }
    if (message === 'LINKAGE_BROKEN') {
      return { error: 'Pending approval row missing for salary correction.', status: 409, code: 'linkage_broken' }
    }
    if (message.includes('Unable to start a transaction')) {
      return { error: 'Database is busy — please wait a moment and try again.', status: 503, code: 'db_busy' }
    }
    throw e
  }
}
