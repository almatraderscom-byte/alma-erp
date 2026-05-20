import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'

export type ApprovalActionMeta = {
  approvalId: string
  adminId: string
  operationId: string
  action: 'APPROVE' | 'REJECT'
  startedAt: number
}

export function buildApprovalActionMeta(input: {
  approvalId: string
  adminId: string
  action: 'APPROVE' | 'REJECT'
  operationId?: string
}) {
  const startedAt = Date.now()
  const operationId = input.operationId?.trim() || `${input.approvalId}-${startedAt}`
  return {
    approvalId: input.approvalId,
    adminId: input.adminId,
    operationId,
    action: input.action,
    startedAt,
  } satisfies ApprovalActionMeta
}

export function logApprovalActionPhase(
  phase: 'started' | 'processing' | 'committed' | 'failed' | 'rolled_back',
  meta: ApprovalActionMeta,
  extra?: Record<string, unknown>,
) {
  const level = phase === 'failed' || phase === 'rolled_back' ? 'error' : 'info'
  const durationMs = Date.now() - meta.startedAt
  logEvent(level, `approval.action.${phase}`, {
    approvalId: meta.approvalId,
    adminId: meta.adminId,
    operationId: meta.operationId,
    action: meta.action,
    durationMs,
    ...extra,
  })
}

export async function stampApprovalActionResponse(
  response: NextResponse,
  meta: ApprovalActionMeta,
) {
  const durationMs = Date.now() - meta.startedAt
  let data: Record<string, unknown> = {}
  try {
    data = (await response.clone().json()) as Record<string, unknown>
  } catch {
    data = {}
  }

  if (response.ok && data.ok) {
    logApprovalActionPhase('committed', meta, { durationMs })
  } else {
    logApprovalActionPhase('failed', meta, {
      durationMs,
      error: String(data.error || response.statusText || 'unknown'),
      code: data.code,
    })
  }

  return NextResponse.json(
    { ...data, operationId: meta.operationId, durationMs },
    { status: response.status },
  )
}
