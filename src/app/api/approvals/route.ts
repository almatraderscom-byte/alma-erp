import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { parseBusinessAccess } from '@/lib/business-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { BUSINESSES, type BusinessId } from '@/lib/businesses'
import { resolveProfileImageForUser } from '@/lib/user-display'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  const url = new URL(req.url)
  const status = url.searchParams.get('status') || 'PENDING'
  const module = url.searchParams.get('module') || ''
  const summary = url.searchParams.get('summary') === '1'
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)))

  const allowedBusinesses = parseBusinessAccess(token.businessAccess as string)
  const businessScope = role === 'SUPER_ADMIN'
    ? {}
    : { OR: [{ businessId: null }, { businessId: { in: allowedBusinesses } }] }
  const where = {
    ...businessScope,
    ...(status === 'ALL' ? {} : { status: status as never }),
    ...(module ? { module } : {}),
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
        select: { id: true, name: true, email: true, role: true, profileImageUrl: true, updatedAt: true },
      })
    : []
  const requesterMap = new Map(requesters.map(user => [user.id, user]))
  const approvals = approvalsRaw.map(row => ({
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
    entityLabel: entityLabel(row.payloadSnapshot, row.entityId),
    executable: isExecutable(row.module, row.type),
  }))

  return NextResponse.json({
    approvals,
    totalPending,
    byModule: byModule.map(row => ({ module: row.module, count: row._count._all })),
    byPriority: byPriority.map(row => ({ priority: row.priority, count: row._count._all })),
  }, { headers: { 'Cache-Control': summary ? 'private, max-age=10, stale-while-revalidate=30' : 'private, no-store' } })
}

function entityLabel(snapshot: unknown, fallback: string) {
  if (!snapshot || typeof snapshot !== 'object') return fallback
  const data = snapshot as Record<string, unknown>
  const accountTitle = typeof data.accountTitle === 'string' ? data.accountTitle : null
  const employeeId = typeof data.employeeId === 'string' ? data.employeeId : null
  const employeeName = typeof data.employeeName === 'string' ? data.employeeName : null
  const amount = typeof data.amount === 'number' ? data.amount : null
  const requestedReduction = typeof data.requestedReductionAmount === 'number' ? data.requestedReductionAmount : null
  if (accountTitle) return accountTitle
  if (employeeName && employeeId) return `${employeeName} (${employeeId})`
  if (employeeId && requestedReduction != null) {
    return `${employeeId} · ৳${requestedReduction.toLocaleString('en-BD')} penalty appeal`
  }
  if (employeeId && amount) return `${employeeId} · ৳${amount.toLocaleString('en-BD')}`
  if (employeeId) return employeeId
  return fallback
}

function isExecutable(module: string, type: string) {
  return (
    (module === 'ALMA_TRADING' && type === 'TRADE_DELETE') ||
    (module === 'PAYROLL' && ['SALARY_ADVANCE', 'WALLET_ADVANCE', 'WALLET_WITHDRAWAL', 'PENALTY_APPEAL'].includes(type))
  )
}
