import type { JWT } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { normalizeBusinessAccessForRole } from '@/lib/business-access'

/**
 * JWT sessions are otherwise valid until their 30-day expiry. Re-read the small
 * indexed authorization projection so deactivation and role/scope changes take
 * effect on the very next protected request.
 */
export async function resolveActiveSessionToken(token: JWT | null): Promise<JWT | null> {
  const userId = String(token?.sub || token?.id || '').trim()
  if (!userId) return null

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      active: true,
      role: true,
      businessAccess: true,
      employeeIdGas: true,
      name: true,
      email: true,
      phone: true,
    },
  })
  if (!user?.active) return null

  return {
    ...token,
    sub: user.id,
    id: user.id,
    name: user.name,
    email: user.email || user.phone || undefined,
    phone: user.phone || '',
    role: user.role,
    businessAccess: normalizeBusinessAccessForRole(user.businessAccess, user.role),
    employeeIdGas: user.employeeIdGas || '',
  }
}
