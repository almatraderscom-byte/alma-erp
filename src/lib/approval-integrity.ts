import type { ApprovalRequest, WalletRequest } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import { resolveApprovalRequestById } from '@/lib/approvals'
import {
  PENALTY_APPEAL_MODULE,
  PENALTY_APPEAL_TYPE,
  ensurePenaltyAppealApproval,
} from '@/lib/penalty-appeal'

export type ApprovalLinkageStatus =
  | 'linked_pending'
  | 'linked_resolved'
  | 'orphan_missing_source'
  | 'orphan_source_already_resolved'
  | 'orphan_missing_approval'

export type WalletSourceSnapshot = {
  exists: boolean
  status: string | null
  id: string
}

export type PenaltySourceSnapshot = {
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

export async function loadPenaltyWaiverSource(entityId: string): Promise<PenaltySourceSnapshot> {
  const row = await prisma.attendanceWaiverRequest.findUnique({
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

export function penaltyLinkageStatus(
  approval: Pick<ApprovalRequest, 'status' | 'module' | 'type'>,
  source: PenaltySourceSnapshot | null,
): ApprovalLinkageStatus {
  if (!source) return 'linked_pending'
  if (!source.exists) return 'orphan_missing_source'
  if (approval.status === 'PENDING' && source.status === 'PENDING') return 'linked_pending'
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

export async function reconcilePenaltyApprovalWithSource(input: {
  approvalId: string
  waiverStatus: string
  actorUserId: string
  note?: string
}) {
  const targetStatus =
    input.waiverStatus === 'REJECTED' || input.waiverStatus === 'CANCELLED'
      ? 'REJECTED'
      : input.waiverStatus === 'APPROVED' || input.waiverStatus === 'PARTIALLY_APPROVED'
        ? 'APPROVED'
        : null

  if (!targetStatus) {
    return { ok: false as const, error: `Waiver is ${input.waiverStatus} — cannot reconcile from approvals.` }
  }

  const approval = await resolveApprovalRequestById({
    id: input.approvalId,
    status: targetStatus,
    actorUserId: input.actorUserId,
    reason: input.note?.slice(0, 500) || 'Reconciled with attendance waiver decision',
  })

  if (!approval) {
    return { ok: false as const, error: 'Could not reconcile approval state' }
  }

  logEvent('info', 'penalty_appeal.reconcile.success', {
    approvalId: input.approvalId,
    waiverStatus: input.waiverStatus,
    approvalStatus: targetStatus,
  })

  return { ok: true as const, approval, reconciled: true }
}

export type IntegrityOrphan =
  | { approvalId: string; kind: 'missing_source'; entityId: string; type: string; module: string }
  | { approvalId: string; kind: 'source_already_resolved'; entityId: string; type: string; module: string; sourceStatus: string }
  | { waiverId: string; kind: 'waiver_missing_approval'; employeeId: string; businessId: string }

export async function scanApprovalIntegrity(limit = 100) {
  const pendingApprovals = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  const pendingWaivers = await prisma.attendanceWaiverRequest.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  const walletEntityIds = pendingApprovals
    .filter(row => isWalletApprovalType(row.module, row.type))
    .map(row => row.entityId)

  const penaltyApprovalEntityIds = pendingApprovals
    .filter(row => isPenaltyApprovalType(row.module, row.type))
    .map(row => row.entityId)

  const [wallets, penaltyWaivers] = await Promise.all([
    walletEntityIds.length
      ? prisma.walletRequest.findMany({
          where: { id: { in: walletEntityIds } },
          select: { id: true, status: true },
        })
      : [],
    penaltyApprovalEntityIds.length
      ? prisma.attendanceWaiverRequest.findMany({
          where: { id: { in: penaltyApprovalEntityIds } },
          select: { id: true, status: true },
        })
      : [],
  ])

  const walletMap = new Map(wallets.map(w => [w.id, w.status]))
  const penaltyMap = new Map(penaltyWaivers.map(w => [w.id, w.status]))

  const walletOrphans: IntegrityOrphan[] = pendingApprovals
    .map(row => {
      if (!isWalletApprovalType(row.module, row.type)) return null
      const walletStatus = walletMap.get(row.entityId)
      if (walletStatus === undefined) {
        return { approvalId: row.id, kind: 'missing_source' as const, entityId: row.entityId, type: row.type, module: row.module }
      }
      if (walletStatus !== 'PENDING') {
        return {
          approvalId: row.id,
          kind: 'source_already_resolved' as const,
          entityId: row.entityId,
          type: row.type,
          module: row.module,
          sourceStatus: walletStatus,
        }
      }
      return null
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))

  const penaltyApprovalOrphans: IntegrityOrphan[] = pendingApprovals
    .map(row => {
      if (!isPenaltyApprovalType(row.module, row.type)) return null
      const waiverStatus = penaltyMap.get(row.entityId)
      if (waiverStatus === undefined) {
        return { approvalId: row.id, kind: 'missing_source' as const, entityId: row.entityId, type: row.type, module: row.module }
      }
      if (waiverStatus !== 'PENDING') {
        return {
          approvalId: row.id,
          kind: 'source_already_resolved' as const,
          entityId: row.entityId,
          type: row.type,
          module: row.module,
          sourceStatus: waiverStatus,
        }
      }
      return null
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))

  const waiverIdsWithPendingApproval = new Set(
    pendingApprovals
      .filter(row => isPenaltyApprovalType(row.module, row.type))
      .map(row => row.entityId),
  )

  const penaltyWaiverOrphans: IntegrityOrphan[] = pendingWaivers
    .filter(w => !waiverIdsWithPendingApproval.has(w.id))
    .map(w => ({
      waiverId: w.id,
      kind: 'waiver_missing_approval' as const,
      employeeId: w.employeeId,
      businessId: w.businessId,
    }))

  const orphans = [...walletOrphans, ...penaltyApprovalOrphans, ...penaltyWaiverOrphans]

  if (orphans.length) {
    logEvent('warn', 'approval.orphan.detected', {
      count: orphans.length,
      wallet: walletOrphans.length,
      penaltyApproval: penaltyApprovalOrphans.length,
      penaltyWaiver: penaltyWaiverOrphans.length,
      sample: orphans.slice(0, 5),
    })
  }

  return {
    scanned: pendingApprovals.length,
    pendingWaivers: pendingWaivers.length,
    walletOrphans,
    penaltyApprovalOrphans,
    penaltyWaiverOrphans,
    orphans,
  }
}

export async function repairWalletApprovalOrphans(actorUserId: string, limit = 50) {
  const { walletOrphans } = await scanApprovalIntegrity(limit)
  const repaired: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const orphan of walletOrphans) {
    if (orphan.kind === 'waiver_missing_approval') continue
    if (orphan.kind === 'missing_source') {
      const approval = await resolveApprovalRequestById({
        id: orphan.approvalId,
        status: 'REJECTED',
        actorUserId,
        reason: 'Auto-closed: linked wallet request no longer exists',
      })
      if (approval) repaired.push(orphan.approvalId)
      else failed.push({ id: orphan.approvalId, error: 'resolve failed' })
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
    else failed.push({ id: orphan.approvalId, error: result.error })
  }

  return { repaired, failed, orphans: walletOrphans.length }
}

export async function repairPenaltyAppealOrphans(actorUserId: string, limit = 50) {
  const { penaltyApprovalOrphans, penaltyWaiverOrphans } = await scanApprovalIntegrity(limit)
  const repaired: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const orphan of penaltyWaiverOrphans) {
    if (orphan.kind !== 'waiver_missing_approval') continue
    const waiver = await prisma.attendanceWaiverRequest.findUnique({
      where: { id: orphan.waiverId },
      include: { requester: { select: { name: true } } },
    })
    if (!waiver || waiver.status !== 'PENDING') continue
    const result = await ensurePenaltyAppealApproval(waiver, {
      employeeId: waiver.employeeId,
      userId: waiver.userId,
      userName: waiver.requester?.name,
    })
    if (result.ok) repaired.push(orphan.waiverId)
    else failed.push({ id: orphan.waiverId, error: result.error })
  }

  for (const orphan of penaltyApprovalOrphans) {
    if (orphan.kind === 'waiver_missing_approval') continue
    if (orphan.kind === 'missing_source') {
      const approval = await resolveApprovalRequestById({
        id: orphan.approvalId,
        status: 'REJECTED',
        actorUserId,
        reason: 'Auto-closed: linked waiver request no longer exists',
      })
      if (approval) repaired.push(orphan.approvalId)
      else failed.push({ id: orphan.approvalId, error: 'resolve failed' })
      continue
    }

    const waiver = await prisma.attendanceWaiverRequest.findUnique({ where: { id: orphan.entityId } })
    if (!waiver) continue
    const result = await reconcilePenaltyApprovalWithSource({
      approvalId: orphan.approvalId,
      waiverStatus: waiver.status,
      actorUserId,
      note: 'Auto-repaired orphan penalty appeal linkage',
    })
    if (result.ok) repaired.push(orphan.approvalId)
    else failed.push({ id: orphan.approvalId, error: result.error })
  }

  return { repaired, failed, orphans: penaltyApprovalOrphans.length + penaltyWaiverOrphans.length }
}

export async function repairAllApprovalOrphans(actorUserId: string, limit = 50) {
  const wallet = await repairWalletApprovalOrphans(actorUserId, limit)
  const penalty = await repairPenaltyAppealOrphans(actorUserId, limit)
  return {
    repaired: [...wallet.repaired, ...penalty.repaired],
    failed: [...wallet.failed, ...penalty.failed],
    walletOrphans: wallet.orphans,
    penaltyOrphans: penalty.orphans,
  }
}

export function isWalletApprovalType(module: string, type: string) {
  return module === 'PAYROLL' && (type === APPROVAL_TYPES.WALLET_ADVANCE || type === APPROVAL_TYPES.WALLET_WITHDRAWAL)
}

export function isPenaltyApprovalType(module: string, type: string) {
  return module === PENALTY_APPEAL_MODULE && type === PENALTY_APPEAL_TYPE
}
