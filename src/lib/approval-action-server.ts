import { NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'

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
  let bodyEmpty = false
  try {
    const raw = await response.clone().text()
    if (!raw.trim()) {
      bodyEmpty = true
      data = {}
    } else {
      data = JSON.parse(raw) as Record<string, unknown>
    }
  } catch {
    bodyEmpty = true
    data = {}
  }

  const ok = Boolean(data.ok) && response.ok && !bodyEmpty
  const error = String(data.error || data.message || (bodyEmpty ? 'empty_response' : '') || response.statusText || 'approval_failed')
  const message = String(
    data.message || data.error || (bodyEmpty ? 'Server returned an empty response. Refresh and check approval status.' : 'Approval action failed'),
  )

  if (ok) {
    logApprovalActionPhase('committed', meta, { durationMs })
  } else {
    logApprovalActionPhase(bodyEmpty || response.status >= 500 ? 'rolled_back' : 'failed', meta, {
      durationMs,
      error,
      code: data.code,
      bodyEmpty,
    })
    if (bodyEmpty) {
      logEvent('warn', 'approval.response.invalid', { approvalId: meta.approvalId, status: response.status })
    }
  }

  const status = response.status >= 200 && response.status < 600 ? response.status : 500
  return NextResponse.json(
    {
      ...data,
      ok,
      error: ok ? undefined : error,
      message: ok ? data.message : message,
      operationId: meta.operationId,
      durationMs,
      ...(bodyEmpty || response.status >= 500 ? { rolledBack: true } : {}),
    },
    { status: bodyEmpty && status < 400 ? 502 : status },
  )
}

export function approvalRouteFailure(
  err: unknown,
  meta?: ApprovalActionMeta,
  extra?: { status?: number; code?: string },
) {
  const message = (err as Error).message || String(err)
  logEvent('error', 'approval.api.failed', {
    approvalId: meta?.approvalId,
    operationId: meta?.operationId,
    message,
    code: extra?.code,
  })
  if (meta) logApprovalActionPhase('rolled_back', meta, { error: message })
  return apiFailure(extra?.code || 'approval_failed', message, {
    status: extra?.status ?? 500,
    rolledBack: true,
    extra: {
      ...(meta
        ? { operationId: meta.operationId, durationMs: Date.now() - meta.startedAt }
        : {}),
    },
  })
}
