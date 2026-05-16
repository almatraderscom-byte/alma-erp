import { prisma } from '@/lib/prisma'

export type AuditEntry = {
  timestamp: string
  route: string
  actor: string
  actor_role: string
  business_id: string
  entity_type: string
  entity_id: string
  summary: string
  detail_json: string
  status_flag: string
}

type UserLookup = Map<string, { name: string; role: string; email?: string | null }>

function actorName(users: UserLookup, id?: string | null) {
  if (!id) return 'System'
  const user = users.get(id)
  return user ? `${user.name}${user.email ? ` <${user.email}>` : ''}` : id
}

function actorRole(users: UserLookup, id?: string | null) {
  return (id && users.get(id)?.role) || 'SYSTEM'
}

function safeLimit(raw?: string | null) {
  const parsed = Number(raw || 100)
  if (!Number.isFinite(parsed)) return 100
  return Math.min(Math.max(Math.trunc(parsed), 1), 400)
}

export async function listPostgresAuditFallback(params: Record<string, string | undefined>) {
  const limit = safeLimit(params.limit)
  const businessId = params.business_id || undefined

  const [users, ledgerEntries, walletRequests, advances, notifications, createdUsers] = await Promise.all([
    prisma.user.findMany({ select: { id: true, name: true, email: true, role: true } }),
    prisma.employeeLedgerEntry.findMany({
      where: businessId ? { businessId } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.walletRequest.findMany({
      where: businessId ? { businessId } : {},
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
    prisma.salaryAdvanceRequest.findMany({
      where: businessId ? { businessId } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.findMany({
      where: businessId ? { businessId } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
  ])

  const userLookup: UserLookup = new Map(users.map(u => [u.id, { name: u.name, email: u.email, role: u.role }]))
  const rows: AuditEntry[] = []

  for (const e of ledgerEntries) {
    const actorId = e.approvedById || e.createdById || e.userId
    rows.push({
      timestamp: e.createdAt.toISOString(),
      route: `wallet_${e.type.toLowerCase()}`,
      actor: actorName(userLookup, actorId),
      actor_role: actorRole(userLookup, actorId),
      business_id: e.businessId,
      entity_type: 'employee_ledger',
      entity_id: e.id,
      summary: `${e.type.replace(/_/g, ' ')} ৳${Number(e.amount).toLocaleString('en-BD')} for employee ${e.employeeId}`,
      detail_json: JSON.stringify({ employeeId: e.employeeId, periodYm: e.periodYm, source: e.source }),
      status_flag: 'OK',
    })
  }

  for (const r of walletRequests) {
    const actorId = r.reviewedById || r.userId
    rows.push({
      timestamp: (r.reviewedAt || r.updatedAt || r.createdAt).toISOString(),
      route: `wallet_request_${r.status.toLowerCase()}`,
      actor: actorName(userLookup, actorId),
      actor_role: actorRole(userLookup, actorId),
      business_id: r.businessId,
      entity_type: 'wallet_request',
      entity_id: r.id,
      summary: `${r.type} request ${r.status} ৳${Number(r.approvedAmount || r.requestedAmount).toLocaleString('en-BD')} for ${r.employeeId}`,
      detail_json: JSON.stringify({ requestedAmount: String(r.requestedAmount), approvedAmount: r.approvedAmount ? String(r.approvedAmount) : null }),
      status_flag: r.status === 'REJECTED' ? 'FAIL' : 'OK',
    })
  }

  for (const a of advances) {
    rows.push({
      timestamp: (a.reviewedAt || a.createdAt).toISOString(),
      route: `salary_advance_${a.status.toLowerCase()}`,
      actor: actorName(userLookup, a.reviewedById || a.userId),
      actor_role: actorRole(userLookup, a.reviewedById || a.userId),
      business_id: a.businessId,
      entity_type: 'salary_advance',
      entity_id: a.id,
      summary: `Salary advance ${a.status} ৳${Number(a.amount).toLocaleString('en-BD')}`,
      detail_json: JSON.stringify({ reason: a.reason.slice(0, 240) }),
      status_flag: a.status === 'REJECTED' ? 'FAIL' : 'OK',
    })
  }

  for (const n of notifications) {
    rows.push({
      timestamp: n.createdAt.toISOString(),
      route: `notification_${n.type.toLowerCase()}`,
      actor: 'System',
      actor_role: 'SYSTEM',
      business_id: n.businessId || businessId || 'ALMA_LIFESTYLE',
      entity_type: 'notification',
      entity_id: n.id,
      summary: n.title,
      detail_json: JSON.stringify({ message: n.message.slice(0, 500), roleTarget: n.roleTarget }),
      status_flag: n.type === 'ACCRUAL_FAILED' ? 'FAIL' : 'OK',
    })
  }

  for (const u of createdUsers) {
    if (businessId && !u.businessAccess.includes(businessId)) continue
    rows.push({
      timestamp: u.createdAt.toISOString(),
      route: 'user_created',
      actor: 'System',
      actor_role: 'SYSTEM',
      business_id: businessId || u.businessAccess.split(',')[0] || 'ALMA_LIFESTYLE',
      entity_type: 'user',
      entity_id: u.id,
      summary: `User ${u.email} created with ${u.role} role`,
      detail_json: JSON.stringify({ email: u.email, role: u.role, active: u.active }),
      status_flag: 'OK',
    })
  }

  rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  return { audit: rows.slice(0, limit), total: Math.min(rows.length, limit), source: 'postgres_fallback' }
}
