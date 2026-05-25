export interface SalaryCorrectionReversal {
  ledgerEntryId: string
  amount: number
  reason: string
}

export interface SalaryCorrectionPayload {
  /** Target accrual to update */
  accrualEntryId: string
  employeeId: string
  businessId: string
  /** YYYY-MM */
  periodYm: string

  /** Amount change */
  currentAmount: number
  proposedAmount: number

  /** Optional reversals (e.g. wrong WITHDRAWAL or wrong ADJUSTMENT) */
  reversals?: SalaryCorrectionReversal[]

  /** Audit context */
  requestedReason: string
  requestedByName?: string
}

export interface SalaryCorrectionApprovalResult {
  ok: boolean
  updatedAccrualId?: string
  beforeAmount?: number
  afterAmount?: number
  reversalEntries?: Array<{ id: string; amount: number; ledgerEntryId: string }>
  error?: string
}

/** Client-safe parser for ApprovalRequest.payloadSnapshot. */
export function parseSalaryCorrectionPayload(snapshot: unknown): SalaryCorrectionPayload | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const data = snapshot as Partial<SalaryCorrectionPayload>
  if (
    !data.accrualEntryId
    || !data.employeeId
    || !data.businessId
    || !data.periodYm
    || data.currentAmount == null
    || data.proposedAmount == null
  ) {
    return null
  }
  return data as SalaryCorrectionPayload
}
