import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import { serverPost } from '@/lib/server-api'
import { agentActorPayload } from '@/lib/agent-api/route-handler'

/** Fines from EmployeeLedgerEntry (type=PENALTY) + TradingVolumeTargetPenalty (status=PENDING). */
export async function listFines(input: { status?: string; limit?: number }) {
  const limit = input.limit ?? 50
  const status = input.status ?? 'all'

  const ledgerRows = await prisma.employeeLedgerEntry.findMany({
    where: {
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      type: 'PENALTY',
      isArchived: false,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  const penaltyRows = await prisma.tradingVolumeTargetPenalty.findMany({
    where: {
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  const empNames = new Map<string, string>()
  const users = await prisma.user.findMany({
    where: { employeeIdGas: { not: null } },
    select: { employeeIdGas: true, name: true },
  })
  for (const u of users) {
    if (u.employeeIdGas) empNames.set(u.employeeIdGas, u.name)
  }

  const fromLedger = ledgerRows.map(r => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeName: empNames.get(r.employeeId) ?? r.employeeId,
    amount: Number(r.amount),
    reason: r.note ?? 'Penalty',
    taskId: null as string | null,
    createdAt: r.createdAt.toISOString(),
    awaitingApproval: !r.approvedById,
    status: r.approvedById ? 'approved' : 'pending',
  }))

  const fromTrading = penaltyRows.map(r => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeName: empNames.get(r.employeeId) ?? r.employeeId,
    amount: Number(r.originalAmountBdt),
    reason: 'Trading volume target missed',
    taskId: null as string | null,
    createdAt: r.createdAt.toISOString(),
    awaitingApproval: r.status === 'PENDING',
    status: r.status.toLowerCase(),
  }))

  let fines = [...fromLedger, ...fromTrading]
  if (status === 'pending') fines = fines.filter(f => f.awaitingApproval)
  if (status === 'approved') fines = fines.filter(f => f.status === 'approved')
  if (status === 'waived') fines = fines.filter(f => f.status === 'waived')

  fines = fines.slice(0, limit)
  return { fines, meta: { count: fines.length } }
}

export async function listPendingFines() {
  return listFines({ status: 'pending', limit: 100 })
}

export async function createFine(body: {
  employeeId: string
  amount: number
  reason: string
  taskId?: string
}) {
  const row = await prisma.employeeLedgerEntry.create({
    data: {
      employeeId: body.employeeId,
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      date: new Date(),
      periodYm: new Date().toISOString().slice(0, 7),
      type: 'PENALTY',
      amount: body.amount,
      note: body.reason,
      source: 'agent_api',
      sourceRef: body.taskId ?? `fine_${Date.now()}`,
      createdById: null,
    },
  })
  return { id: row.id, status: 'created', createdAt: row.createdAt.toISOString() }
}

export async function approveFine(id: string, note?: string) {
  const ledger = await prisma.employeeLedgerEntry.findUnique({ where: { id } })
  if (ledger) {
    await prisma.employeeLedgerEntry.update({
      where: { id },
      data: { approvedById: 'agent_via_sir', note: note ?? ledger.note },
    })
    return { id, status: 'approved' as const }
  }

  const trading = await prisma.tradingVolumeTargetPenalty.findUnique({ where: { id } })
  if (trading) {
    await prisma.tradingVolumeTargetPenalty.update({
      where: { id },
      data: {
        status: 'APPLIED',
        appliedById: 'agent_via_sir',
        appliedAt: new Date(),
        adminNote: note,
      },
    })
    return { id, status: 'approved' as const }
  }

  return null
}

export async function waiveFine(id: string, reason: string) {
  const ledger = await prisma.employeeLedgerEntry.findUnique({ where: { id } })
  if (ledger) {
    await prisma.employeeLedgerEntry.update({
      where: { id },
      data: { isArchived: true, archivedAt: new Date(), note: `${ledger.note ?? ''} [waived: ${reason}]` },
    })
    return { id, status: 'waived' as const }
  }

  const trading = await prisma.tradingVolumeTargetPenalty.findUnique({ where: { id } })
  if (trading) {
    await prisma.tradingVolumeTargetPenalty.update({
      where: { id },
      data: {
        status: 'WAIVED',
        waivedById: 'agent_via_sir',
        waivedAt: new Date(),
        adminNote: reason,
      },
    })
    return { id, status: 'waived' as const }
  }

  return null
}

export async function deleteFine(id: string) {
  const ledger = await prisma.employeeLedgerEntry.findUnique({ where: { id } })
  if (!ledger) return null
  if (ledger.approvedById) throw new Error('Cannot delete approved fine')
  await prisma.employeeLedgerEntry.delete({ where: { id } })
  return { id, status: 'deleted' }
}
