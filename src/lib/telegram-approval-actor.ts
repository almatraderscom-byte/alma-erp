import { prisma } from '@/lib/prisma'
import { normalizeAlmaRole } from '@/lib/roles'
import type { AlmaRole } from '@/lib/roles'

const REVIEWER_ROLES: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN']

/** Map Telegram clicker → ERP user for audit trail (penalty appeals, ops callbacks). */
export async function resolveTelegramApprovalActor(
  telegramUserId: string,
  businessId?: string | null,
): Promise<{ userId: string; role: AlmaRole } | null> {
  const link = await prisma.tradingTelegramUser.findFirst({
    where: {
      telegramUserId: String(telegramUserId),
      approved: true,
      userId: { not: null },
      ...(businessId ? { businessId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: { userId: true },
  })

  if (link?.userId) {
    const user = await prisma.user.findFirst({
      where: { id: link.userId, active: true },
      select: { id: true, role: true },
    })
    if (user) {
      const role = normalizeAlmaRole(user.role)
      if (REVIEWER_ROLES.includes(role)) return { userId: user.id, role }
    }
  }

  const superAdmin = await prisma.user.findFirst({
    where: {
      active: true,
      role: 'SUPER_ADMIN',
      ...(businessId
        ? {
            OR: [
              { businessAccess: { contains: businessId } },
              { businessAccess: 'ALL' },
              { businessAccess: { contains: 'ALL' } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, role: true },
  })
  if (superAdmin) {
    return { userId: superAdmin.id, role: normalizeAlmaRole(superAdmin.role) }
  }

  return null
}
