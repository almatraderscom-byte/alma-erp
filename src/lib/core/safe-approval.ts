import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { classifyApprovalTxError } from '@/lib/safe-api-response'

const PENDING_SELECT = {
  id: true,
  module: true,
  type: true,
  businessId: true,
  entityId: true,
  requestedBy: true,
  status: true,
  reason: true,
  payloadSnapshot: true,
  priority: true,
  actionUrl: true,
  auditHistory: true,
  createdAt: true,
  approvedAt: true,
  rejectedAt: true,
} as const

/** Load pending approval by id — returns null if missing or not pending (not an error). */
export async function safeApprovalFetchPending(approvalId: string) {
  try {
    return await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      select: PENDING_SELECT,
    })
  } catch (err) {
    logEvent('error', 'approval.api.failed', {
      approvalId,
      phase: 'fetch',
      message: (err as Error).message,
    })
    throw err
  }
}

export function approvalNotFoundResponse() {
  const classified = classifyApprovalTxError(new Error('Pending approval not found'))
  return {
    ok: false as const,
    error: {
      code: 'approval_not_found',
      message: 'Pending approval not found. Refresh the list — it may already be processed.',
    },
    code: 'approval_not_found',
    message: classified.message,
    rolledBack: false,
  }
}
