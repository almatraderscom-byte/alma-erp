'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  addPendingApprovalOp,
  committedLabel,
  createApprovalOperationId,
  failedLabel,
  processingLabel,
  readPendingApprovalOps,
  removePendingApprovalOp,
  type ApprovalActionKind,
  type ApprovalOpState,
  type ApprovalRowUiState,
  type PendingApprovalOp,
} from '@/lib/approval-action-tracker'

type ExecuteInput = {
  approvalId: string
  action: ApprovalActionKind
  note?: string
  rowLabel?: string
}

type ExecuteResult =
  | { ok: true; reconciled?: boolean }
  | { ok: false; error: string; rolledBack?: boolean }

export function useApprovalActions(onRefresh: () => Promise<void>) {
  const [rowStates, setRowStates] = useState<Record<string, ApprovalRowUiState>>({})
  const inflightRef = useRef<Set<string>>(new Set())

  const processingOps = useMemo(
    () => Object.entries(rowStates).filter(([, s]) => s.state === 'processing'),
    [rowStates],
  )

  const hasProcessing = processingOps.length > 0

  const setRowState = useCallback((approvalId: string, patch: ApprovalRowUiState) => {
    setRowStates(prev => ({ ...prev, [approvalId]: patch }))
  }, [])

  const clearRowState = useCallback((approvalId: string) => {
    setRowStates(prev => {
      const next = { ...prev }
      delete next[approvalId]
      return next
    })
  }, [])

  const recoverPendingOps = useCallback(async () => {
    const pending = readPendingApprovalOps()
    if (!pending.length) return

    await Promise.all(
      pending.map(async op => {
        setRowState(op.approvalId, {
          state: 'processing',
          action: op.action,
          operationId: op.operationId,
          message: 'Recovering approval status…',
          startedAt: op.startedAt,
        })
        try {
          const res = await fetch(`/api/approvals/${encodeURIComponent(op.approvalId)}`, {
            cache: 'no-store',
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok) {
            removePendingApprovalOp(op.approvalId)
            clearRowState(op.approvalId)
            return
          }
          const status = String(json.approval?.status || '')
          if (status === 'PENDING') {
            setRowState(op.approvalId, {
              state: 'processing',
              action: op.action,
              operationId: op.operationId,
              message: processingLabel(op.action),
              startedAt: op.startedAt,
            })
            return
          }
          removePendingApprovalOp(op.approvalId)
          setRowState(op.approvalId, {
            state: 'committed',
            action: op.action,
            message: committedLabel(op.action),
          })
          window.setTimeout(() => clearRowState(op.approvalId), 2_500)
        } catch {
          removePendingApprovalOp(op.approvalId)
          clearRowState(op.approvalId)
        }
      }),
    )
    await onRefresh()
  }, [clearRowState, onRefresh, setRowState])

  useEffect(() => {
    void recoverPendingOps()
  }, [recoverPendingOps])

  useEffect(() => {
    if (!hasProcessing) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = 'An approval is still processing. Leave anyway?'
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasProcessing])

  const executeApproval = useCallback(
    async (input: ExecuteInput): Promise<ExecuteResult> => {
      const { approvalId, action, note = '', rowLabel } = input

      if (action === 'REJECT' && note.trim().length < 5) {
        toast.error('Rejection reason must be at least 5 characters')
        return { ok: false, error: 'Rejection reason required' }
      }

      if (inflightRef.current.has(approvalId)) {
        toast.error('This approval is already being processed')
        return { ok: false, error: 'Already processing' }
      }

      const operationId = createApprovalOperationId()
      const startedAt = Date.now()
      const pending: PendingApprovalOp = { operationId, approvalId, action, startedAt }

      inflightRef.current.add(approvalId)
      addPendingApprovalOp(pending)
      setRowState(approvalId, {
        state: 'processing',
        action,
        operationId,
        message: processingLabel(action),
        startedAt,
      })

      const toastId = toast.loading(
        rowLabel
          ? `${processingLabel(action)} · ${rowLabel}`
          : processingLabel(action),
        { duration: Infinity },
      )

      try {
        const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, note, operation_id: operationId }),
          cache: 'no-store',
        })
        const json = await res.json().catch(() => ({}))

        if (!res.ok || !json.ok) {
          const err = String(json.error || 'Approval action failed')
          const code = String(json.code || '')
          const rolledBack = Boolean(json.rolledBack) || res.status >= 500
          setRowState(approvalId, {
            state: rolledBack ? 'rolled_back' : 'failed',
            action,
            operationId,
            message: rolledBack
              ? `No changes applied — ${err}`
              : failedLabel(action, err),
          })
          logClient(rolledBack ? 'approval.action.rolled_back' : 'approval.action.failed', {
            approvalId,
            operationId,
            action,
            code,
            error: err,
          })
          toast.error(err, { id: toastId })
          window.setTimeout(() => clearRowState(approvalId), 8_000)
          return { ok: false, error: err, rolledBack: Boolean(json.rolledBack) }
        }

        removePendingApprovalOp(approvalId)
        setRowState(approvalId, {
          state: 'committed',
          action,
          operationId,
          message: committedLabel(action),
        })

        if (json.reconciled) {
          toast.success(
            action === 'REJECT'
              ? 'Approval synced (already handled elsewhere)'
              : 'Approval synced with existing decision',
            { id: toastId },
          )
        } else {
          toast.success(action === 'APPROVE' ? 'Approval committed' : 'Rejection committed', {
            id: toastId,
          })
        }

        logClient('approval.action.committed', {
          approvalId,
          operationId: json.operationId || operationId,
          action,
          durationMs: json.durationMs ?? Date.now() - startedAt,
        })

        window.setTimeout(() => clearRowState(approvalId), 2_000)
        await onRefresh()
        window.dispatchEvent(new Event('alma:approvals-updated'))
        return { ok: true, reconciled: Boolean(json.reconciled) }
      } catch (e) {
        const err = (e as Error).message || 'Network error'
        removePendingApprovalOp(approvalId)
        setRowState(approvalId, {
          state: 'rolled_back',
          action,
          operationId,
          message: `No changes applied — ${err}`,
        })
        toast.error(err, { id: toastId })
        logClient('approval.action.rolled_back', { approvalId, operationId, action, error: err })
        window.setTimeout(() => clearRowState(approvalId), 8_000)
        return { ok: false, error: err, rolledBack: true }
      } finally {
        inflightRef.current.delete(approvalId)
      }
    },
    [clearRowState, onRefresh, setRowState],
  )

  const isRowProcessing = useCallback(
    (approvalId: string) => {
      const ui = rowStates[approvalId]
      return ui?.state === 'processing' || inflightRef.current.has(approvalId)
    },
    [rowStates],
  )

  const getRowUi = useCallback(
    (approvalId: string): ApprovalRowUiState => rowStates[approvalId] ?? { state: 'idle' },
    [rowStates],
  )

  return {
    hasProcessing,
    processingOps,
    executeApproval,
    isRowProcessing,
    getRowUi,
    recoverPendingOps,
  }
}

function logClient(event: string, meta: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'development') {
    console.info(JSON.stringify({ event, ...meta }))
  }
}
