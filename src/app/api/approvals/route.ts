import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { parseBusinessAccess } from '@/lib/business-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { BUSINESSES, type BusinessId } from '@/lib/businesses'
import { resolveProfileImageForUser } from '@/lib/user-display'
import {
  isPenaltyApprovalType,
  isWalletApprovalType,
  penaltyLinkageStatus,
  walletLinkageStatus,
} from '@/lib/approval-integrity'
import { parseArchiveVisibility, resolveArchiveVisibilityWhere } from '@/lib/business-archive/query'
import { apiFailure, apiDataSuccess } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { logEvent } from '@/lib/logger'
import { resolvePayoutSummariesForUsers } from '@/lib/employee-payment-method'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import type { SalaryCorrectionPayload } from '@/types/salary-correction'

export const GET = withApiRoute('approvals.list', async (req: NextRequest) => {
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  const url = new URL(req.url)
  const status = url.searchParams.get('status') || 'PENDING'
  const moduleFilter = url.searchParams.get('module') || ''
  const summary = url.searchParams.get('summary') === '1'
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)))

  const allowedBusinesses = parseBusinessAccess(token.businessAccess as string)
  const businessScope = role === 'SUPER_ADMIN'
    ? {}
    : { OR: [{ businessId: null }, { businessId: { in: allowedBusinesses } }] }
  const archiveVisibility = parseArchiveVisibility(url.searchParams.get('archive_visibility'))
  const archiveWhere = await resolveArchiveVisibilityWhere(archiveVisibility)
  const where = {
    ...businessScope,
    ...archiveWhere,
    ...(status === 'ALL' ? {} : { status: status as never }),
    ...(moduleFilter ? { module: moduleFilter } : {}),
    ...(role === 'SUPER_ADMIN' ? {} : { requestedBy: token.sub }),
  }

  const approvalSelect = {
    id: true,
    module: true,
    type: true,
    businessId: true,
    entityId: true,
    requestedBy: true,
    approvedBy: true,
    rejectedBy: true,
    reason: true,
    payloadSnapshot: true,
    status: true,
    priority: true,
    actionUrl: true,
    auditHistory: true,
    createdAt: true,
    approvedAt: true,
    rejectedAt: true,
  } as const

  const [approvalsRaw, totalPending, byModule, byPriority] = await Promise.all([
    summary ? Promise.resolve([]) : prisma.approvalRequest.findMany({ where, select: approvalSelect, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.approvalRequest.count({ where: { ...businessScope, status: 'PENDING', ...(role === 'SUPER_ADMIN' ? {} : { requestedBy: token.sub }) } }),
    prisma.approvalRequest.groupBy({
      by: ['module'],
      where: { ...businessScope, status: 'PENDING', ...(role === 'SUPER_ADMIN' ? {} : { requestedBy: token.sub }) },
      _count: { _all: true },
    }),
    prisma.approvalRequest.groupBy({
      by: ['priority'],
      where: { ...businessScope, status: 'PENDING', ...(role === 'SUPER_ADMIN' ? {} : { requestedBy: token.sub }) },
      _count: { _all: true },
    }),
  ])
  const requesterIds = [...new Set(approvalsRaw.map(row => row.requestedBy).filter(Boolean))]
  const requesters = requesterIds.length
    ? await prisma.user.findMany({
        where: { id: { in: requesterIds } },
        select: { id: true, name: true, email: true, role: true, profileImageUrl: true, updatedAt: true, employeeIdGas: true },
      })
    : []
  const requesterMap = new Map(requesters.map(user => [user.id, user]))
  const walletEntityIds = approvalsRaw
    .filter(row => isWalletApprovalType(row.module, row.type))
    .map(row => row.entityId)
  const penaltyEntityIds = approvalsRaw
    .filter(row => isPenaltyApprovalType(row.module, row.type))
    .map(row => row.entityId)
  const [walletRows, penaltyRows] = await Promise.all([
    walletEntityIds.length
      ? prisma.walletRequest.findMany({
          where: { id: { in: walletEntityIds } },
          select: { id: true, status: true },
        })
      : [],
    penaltyEntityIds.length
      ? prisma.attendanceWaiverRequest.findMany({
          where: { id: { in: penaltyEntityIds } },
          select: { id: true, status: true },
        })
      : [],
  ])
  const walletStatusMap = new Map(walletRows.map(w => [w.id, w.status]))
  const penaltyStatusMap = new Map(penaltyRows.map(w => [w.id, w.status]))

  const payoutByUser = new Map<string, Awaited<ReturnType<typeof resolvePayoutSummariesForUsers>> extends Map<string, infer V> ? V : never>()
  if (role === 'SUPER_ADMIN') {
    const byBusiness = new Map<string, string[]>()
    for (const r of approvalsRaw) {
      if (!isWalletApprovalType(r.module, r.type) && r.type !== 'SALARY_ADVANCE') continue
      const bid = r.businessId || 'ALMA_LIFESTYLE'
      const list = byBusiness.get(bid) || []
      if (!list.includes(r.requestedBy)) list.push(r.requestedBy)
      byBusiness.set(bid, list)
    }
    for (const [bid, userIds] of byBusiness) {
      const chunk = await resolvePayoutSummariesForUsers(userIds, bid, true).catch(() => new Map())
      for (const [uid, summary] of chunk) payoutByUser.set(`${bid}:${uid}`, summary)
    }
  }

  const approvals = approvalsRaw.map(row => {
    const walletStatus = isWalletApprovalType(row.module, row.type)
      ? walletStatusMap.get(row.entityId) ?? null
      : null
    const penaltyStatus = isPenaltyApprovalType(row.module, row.type)
      ? penaltyStatusMap.get(row.entityId) ?? null
      : null
    const linkageStatus = isWalletApprovalType(row.module, row.type)
      ? walletLinkageStatus(row, {
          exists: walletStatus != null,
          status: walletStatus,
          id: row.entityId,
        })
      : isPenaltyApprovalType(row.module, row.type)
        ? penaltyLinkageStatus(row, {
            exists: penaltyStatus != null,
            status: penaltyStatus,
            id: row.entityId,
          })
        : 'linked_pending'
    return {
      ...row,
      requester: (() => {
        const requester = requesterMap.get(row.requestedBy)
        if (!requester) return null
        return {
          ...requester,
          profileImageUrl: resolveProfileImageForUser(requester),
        }
      })(),
      businessName: row.businessId && BUSINESSES[row.businessId as BusinessId] ? BUSINESSES[row.businessId as BusinessId].name : 'Global',
      entityLabel: entityLabel(row.payloadSnapshot, row.entityId, row.type),
      executable: isExecutable(row.module, row.type),
      linkageStatus,
      sourceStatus: walletStatus ?? penaltyStatus,
      payoutSummary:
        isWalletApprovalType(row.module, row.type) || row.type === 'SALARY_ADVANCE'
          ? payoutByUser.get(`${row.businessId || 'ALMA_LIFESTYLE'}:${row.requestedBy}`)
            ?? (row.payloadSnapshot && typeof row.payloadSnapshot === 'object'
              ? (row.payloadSnapshot as { payout?: unknown }).payout
              : undefined)
          : undefined,
    }
  })

  return apiDataSuccess(
    {
      approvals,
      totalPending,
      byModule: byModule.map(row => ({ module: row.module, count: row._count._all })),
      byPriority: byPriority.map(row => ({ priority: row.priority, count: row._count._all })),
    },
    { headers: { 'Cache-Control': summary ? 'private, max-age=10, stale-while-revalidate=30' : 'private, no-store' } },
  )
})

function entityLabel(snapshot: unknown, fallback: string, type?: string) {
  if (!snapshot || typeof snapshot !== 'object') return fallback
  const data = snapshot as Record<string, unknown>
  if (type === APPROVAL_TYPES.SALARY_CORRECTION) {
    const payload = data as Partial<SalaryCorrectionPayload>
    const empName = payload.requestedByName || payload.employeeId || fallback
    const current = Number(payload.currentAmount ?? 0)
    const proposed = Number(payload.proposedAmount ?? 0)
    const delta = proposed - current
    const sign = delta >= 0 ? '+' : ''
    return `${empName} · ${sign}৳${Math.abs(delta).toLocaleString('en-BD')} salary correction`
  }
  const accountTitle = typeof data.accountTitle === 'string' ? data.accountTitle : null
  const employeeId = typeof data.employeeId === 'string' ? data.employeeId : null
  const employeeName = typeof data.employeeName === 'string' ? data.employeeName : null
  const userName = typeof data.userName === 'string' ? data.userName : null
  const amount = typeof data.amount === 'number' ? data.amount : null
  const amountBdt = typeof data.amountBdt === 'number' ? data.amountBdt : null
  const requestedReduction = typeof data.requestedReductionAmount === 'number' ? data.requestedReductionAmount : null
  if (accountTitle) return accountTitle
  if (userName && employeeId && amountBdt != null) {
    return `${userName} (${employeeId}) · ৳${amountBdt.toLocaleString('en-BD')} meal allowance`
  }
  if (employeeName && employeeId) return `${employeeName} (${employeeId})`
  if (employeeId && requestedReduction != null) {
    return `${employeeId} · ৳${requestedReduction.toLocaleString('en-BD')} penalty appeal`
  }
  if (employeeId && amount) return `${employeeId} · ৳${amount.toLocaleString('en-BD')}`
  if (employeeId) return employeeId
  const order = data.order as { orderId?: string; customer?: string; sell_price?: number } | undefined
  if (order?.orderId) {
    return order.customer
      ? `${order.orderId} · ${order.customer}`
      : order.orderId
  }
  return fallback
}

function isExecutable(module: string, type: string) {
  return (
    (module === 'ALMA_TRADING' && type === 'TRADE_DELETE') ||
    (module === 'ORDERS_CRM' && type === 'ORDER_DELETE') ||
    (module === 'PAYROLL' && [
      'SALARY_ADVANCE',
      'WALLET_ADVANCE',
      'WALLET_WITHDRAWAL',
      'PENALTY_APPEAL',
      'MEAL_ALLOWANCE',
      APPROVAL_TYPES.SALARY_CORRECTION,
      APPROVAL_TYPES.ATTENDANCE_LEAVE,
      // Both have full approve+reject execution branches in [id]/route.ts but were
      // missing here, so the owner only saw "Manual review" (no Approve button).
      APPROVAL_TYPES.ATTENDANCE_EXCEPTION,
      APPROVAL_TYPES.NO_CHECKOUT_FINE,
    ].includes(type))
  )
}
