import { prisma } from '@/lib/prisma'
import { moneyDecimal } from '@/lib/payroll-wallet'

export async function migrateLegacyApprovedAdvances() {
  const approved = await prisma.salaryAdvanceRequest.findMany({
    where: { status: 'APPROVED' },
    include: { user: { select: { id: true, employeeIdGas: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  })

  let created = 0
  let skipped = 0
  const errors: string[] = []

  for (const adv of approved) {
    const employeeId = adv.user.employeeIdGas?.trim()
    if (!employeeId) {
      skipped += 1
      continue
    }

    try {
      const existing = await prisma.employeeLedgerEntry.findUnique({
        where: { source_sourceRef: { source: 'legacy_advance_request', sourceRef: adv.id } },
      })
      if (existing) {
        skipped += 1
        continue
      }

      await prisma.employeeLedgerEntry.create({
        data: {
          employeeId,
          userId: adv.userId,
          businessId: adv.businessId,
          date: adv.reviewedAt || adv.createdAt,
          type: 'ADVANCE',
          amount: moneyDecimal(adv.amount),
          note: `Migrated approved advance: ${adv.reason}`,
          createdById: adv.userId,
          approvedById: adv.reviewedById || null,
          source: 'legacy_advance_request',
          sourceRef: adv.id,
        },
      })
      created += 1
    } catch (e) {
      errors.push(`${adv.id}: ${(e as Error).message}`)
    }
  }

  return { ok: errors.length === 0, total: approved.length, created, skipped, errors }
}
