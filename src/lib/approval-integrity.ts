import type { ApprovalRequest, WalletRequest } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import { resolveApprovalRequestById } from '@/lib/approvals'

export type ApprovalLinkageStatus =
  | 'linked_pending'
  | 'linked_resolved'
  | 'orphan_missing_source'
  | 'orphan_source_already_resolved'

export type WalletSourceSnapshot = {
  exists: boolean
  status: string | null
  id: string
}

export async function loadWalletRequestSource(entityId: string): Promise<WalletSourceSnapshot> {
  const row = await prisma.walletRequest.findUnique({
    where: { id: entityId },
    select: { id: true, status: true },
  })
  return { exists: Boolean(row), status: row?.status ?? null, id: entityId }
}

export function walletLinkageStatus(
  approval: Pick<ApprovalRequest, 'status' | 'module' | 'type'>,
  source: WalletSourceSnapshot | null,
): ApprovalLinkageStatus {
  if (!source) return 'linked_pending'
  if (!source.exists) return 'orphan_missing_source'
  if (approval.status === 'PENDING' && source.status && source.status !== 'PENDING') {
    return 'orphan_source_already_resolved'
  }
  if (approval.status !== 'PENDING') return 'linked_resolved'
  return 'linked_pending'
}

export function approvalMatchesResolvedWalletAction(
  action: 'APPROVE' | 'REJECT',
  walletStatus: string,
): boolean {
  if (action === 'REJECT' && walletStatus === 'REJECTED') return true
  if (action === 'APPROVE' && (walletStatus === 'APPROVED' || walletStatus === 'PARTIALLY_APPROVED')) return true
  return false
}

/** Close a pending approval when the wallet row was already finalized elsewhere (e.g. Payroll page). */
export async function reconcileWalletApprovalWithSource(input: {
  approvalId: string
  wallet: WalletRequest
  action: 'APPROVE' | 'REJECT'
  actorUserId: string
  note?: string
}) {
  const targetStatus =
    input.wallet.status === 'REJECTED'
      ? 'REJECTED'
      : input.wallet.status === 'APPROVED' || input.wallet.status === 'PARTIALLY_APPROVED'
        ? 'APPROVED'
        : null

  if (!targetStatus) {
    return { ok: false as const, error: `Wallet request is ${input.wallet.status} — cannot reconcile from approvals.` }
  }

  if (input.action === 'REJECT' && targetStatus !== 'REJECTED') {
    return {
      ok: false as const,
      error: `Wallet request is already ${input.wallet.status}. Refresh and use Payroll if you need to change it.`,
    }
  }
  if (input.action === 'APPROVE' && targetStatus !== 'APPROVED') {
    return {
      ok: false as const,
      error: `Wallet request is ${input.wallet.status}, not approved. Refresh approvals.`,
    }
  }

  const reason =
    input.note?.trim()
    || (targetStatus === 'REJECTED'
      ? input.wallet.reviewNote || 'Reconciled with payroll wallet decision'
      : 'Reconciled with payroll wallet approval')

  const approval = await resolveApprovalRequestById({
    id: input.approvalId,
    status: targetStatus,
    actorUserId: input.actorUserId,
    reason: reason.slice(0, 500),
  })

  if (!approval) {
    logEvent('error', 'approval.reconcile.failed', {
      approvalId: input.approvalId,
      walletId: input.wallet.id,
      walletStatus: input.wallet.status,
    })
    return { ok: false as const, error: 'Could not reconcile approval state' }
  }

  logEvent('info', 'approval.reconcile.success', {
    approvalId: input.approvalId,
    walletId: input.wallet.id,
    walletStatus: input.wallet.status,
    approvalStatus: targetStatus,
  })

  return { ok: true as const, approval, moduleResult: { request: input.wallet }, reconciled: true }
}

export async function scanApprovalIntegrity(limit = 100) {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  const walletEntityIds = pending
    .filter(row => row.module === 'PAYROLL' && (row.type === APPROVAL_TYPES.WALLET_ADVANCE || row.type === APPROVAL_TYPES.WALLET_WITHDRAWAL))
    .map(row => row.entityId)

  const wallets = walletEntityIds.length
    ? await prisma.walletRequest.findMany({
        where: { id: { in: walletEntityIds } },
        select: { id: true, status: true },
      })
    : []
  const walletMap = new Map(wallets.map(w => [w.id, w.status]))

  const orphans = pending
    .map(row => {
      if (row.module !== 'PAYROLL' || (row.type !== APPROVAL_TYPES.WALLET_ADVANCE && row.type !== APPROVAL_TYPES.WALLET_WITHDRAWAL)) {
        return null
      }
      const walletStatus = walletMap.get(row.entityId)
      if (walletStatus === undefined) {
        return { approvalId: row.id, kind: 'missing_source' as const, entityId: row.entityId, type: row.type }
      }
      if (walletStatus !== 'PENDING') {
        return {
          approvalId: row.id,
          kind: 'source_already_resolved' as const,
          entityId: row.entityId,
          type: row.type,
          walletStatus,
        }
      }
      return null
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))

  if (orphans.length) {
    logEvent('warn', 'approval.orphan.detected', { count: orphans.length, sample: orphans.slice(0, 5) })
  }

  return { scanned: pending.length, orphans }
}

export async function repairWalletApprovalOrphans(actorUserId: string, limit = 50) {
  const { orphans } = await scanApprovalIntegrity(limit)
  const repaired: string[] = []
  const failed: Array<{ approvalId: string; error: string }> = []

  for (const orphan of orphans) {
    if (orphan.kind === 'missing_source') {
      const approval = await resolveApprovalRequestById({
        id: orphan.approvalId,
        status: 'REJECTED',
        actorUserId,
        reason: 'Auto-closed: linked wallet request no longer exists',
      })
      if (approval) repaired.push(orphan.approvalId)
      else failed.push({ approvalId: orphan.approvalId, error: 'resolve failed' })
      continue
    }

    const wallet = await prisma.walletRequest.findUnique({ where: { id: orphan.entityId } })
    if (!wallet) continue
    const action = wallet.status === 'REJECTED' ? 'REJECT' : 'APPROVE'
    const result = await reconcileWalletApprovalWithSource({
      approvalId: orphan.approvalId,
      wallet,
      action,
      actorUserId,
      note: 'Auto-repaired orphan approval linkage',
    })
    if (result.ok) repaired.push(orphan.approvalId)
    else failed.push({ approvalId: orphan.approvalId, error: result.error })
  }

  return { repaired, failed, orphans: orphans.length }
}

export function isWalletApprovalType(module: string, type: string) {
  return module === 'PAYROLL' && (type === APPROVAL_TYPES.WALLET_ADVANCE || type === APPROVAL_TYPES.WALLET_WITHDRAWAL)
}
