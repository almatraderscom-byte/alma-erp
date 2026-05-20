/**
 * Repair pending approvals whose wallet source is already resolved.
 * Run: node --env-file=.env scripts/repair-approval-orphans.mjs
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const ACTOR = 'system-repair-script'

async function resolveApproval(id, status, actorUserId, reason) {
  const approval = await p.approvalRequest.findUnique({ where: { id } })
  if (!approval || approval.status !== 'PENDING') return null
  const now = new Date()
  const history = Array.isArray(approval.auditHistory) ? approval.auditHistory : []
  return p.approvalRequest.update({
    where: { id },
    data: {
      status,
      ...(status === 'APPROVED'
        ? { approvedBy: actorUserId, approvedAt: now }
        : { rejectedBy: actorUserId, rejectedAt: now }),
      auditHistory: [
        ...history,
        { action: status, actorUserId, reason, source: 'erp', timestamp: now.toISOString() },
      ],
    },
  })
}

async function main() {
  const pending = await p.approvalRequest.findMany({
    where: {
      status: 'PENDING',
      module: 'PAYROLL',
      type: { in: ['WALLET_ADVANCE', 'WALLET_WITHDRAWAL'] },
    },
  })
  const repaired = []
  for (const row of pending) {
    const wallet = await p.walletRequest.findUnique({ where: { id: row.entityId } })
    if (!wallet) {
      await resolveApproval(row.id, 'REJECTED', ACTOR, 'Auto-closed: wallet missing')
      repaired.push({ id: row.id, action: 'closed_missing' })
      continue
    }
    if (wallet.status === 'PENDING') continue
    const status = wallet.status === 'REJECTED' ? 'REJECTED' : 'APPROVED'
    await resolveApproval(row.id, status, ACTOR, wallet.reviewNote || `Reconciled with wallet ${wallet.status}`)
    repaired.push({ id: row.id, walletStatus: wallet.status, approvalStatus: status })
  }
  console.log(JSON.stringify({ pending: pending.length, repaired }, null, 2))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => p.$disconnect())
