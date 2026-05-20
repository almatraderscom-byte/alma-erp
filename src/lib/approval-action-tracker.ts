export type ApprovalActionKind = 'APPROVE' | 'REJECT'

export type ApprovalOpState = 'idle' | 'processing' | 'committed' | 'failed' | 'rolled_back'

export type PendingApprovalOp = {
  operationId: string
  approvalId: string
  action: ApprovalActionKind
  startedAt: number
}

export type ApprovalRowUiState = {
  state: ApprovalOpState
  action?: ApprovalActionKind
  operationId?: string
  message?: string
  startedAt?: number
}

const STORAGE_KEY = 'alma:approval-pending-ops'

export function createApprovalOperationId() {
  return crypto.randomUUID()
}

export function readPendingApprovalOps(): PendingApprovalOp[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PendingApprovalOp[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writePendingApprovalOps(ops: PendingApprovalOp[]) {
  if (typeof window === 'undefined') return
  try {
    if (!ops.length) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ops))
  } catch {
    // ignore quota errors
  }
}

export function addPendingApprovalOp(op: PendingApprovalOp) {
  const existing = readPendingApprovalOps().filter(row => row.approvalId !== op.approvalId)
  writePendingApprovalOps([...existing, op])
}

export function removePendingApprovalOp(approvalId: string) {
  writePendingApprovalOps(readPendingApprovalOps().filter(row => row.approvalId !== approvalId))
}

export function processingLabel(action: ApprovalActionKind) {
  return action === 'APPROVE' ? 'Processing approval…' : 'Processing rejection…'
}

export function committedLabel(action: ApprovalActionKind) {
  return action === 'APPROVE' ? 'Approval committed' : 'Rejection committed'
}

export function failedLabel(action: ApprovalActionKind, reason: string) {
  const short = reason.length > 120 ? `${reason.slice(0, 117)}…` : reason
  return action === 'APPROVE' ? `Approval failed: ${short}` : `Rejection failed: ${short}`
}
