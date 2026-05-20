import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { userHasBusinessAccess } from '@/lib/attendance-business'
import type { BusinessId } from '@/lib/businesses'
import { BUSINESSES } from '@/lib/businesses'

const ASSIGNABLE_ROLES = new Set(['ADMIN', 'HR', 'STAFF'])

export type TaskSpotlightAssignee = {
  id: string
  name: string
  email: string | null
  role: string
  employeeIdGas: string | null
  businessAccess: string
}

function hideDemoUsersWhere() {
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEMO_USERS === 'true') {
    return {}
  }
  return {
    AND: [
      { OR: [{ email: null }, { NOT: { email: { endsWith: '@alma-erp.demo' } } }] },
      { OR: [{ phone: null }, { NOT: { phone: { startsWith: '+880170000000' } } }] },
    ],
  }
}

/** Employees eligible for Task Spotlight in the current business scope only. */
export async function loadTaskSpotlightAssignees(
  businessId: string,
  actorUserId: string,
): Promise<TaskSpotlightAssignee[]> {
  if (!BUSINESSES[businessId as BusinessId]) {
    logEvent('warn', 'taskSpotlight.businessScope', {
      businessId,
      userId: actorUserId,
      error: 'invalid_business_id',
    })
    return []
  }

  logEvent('info', 'taskSpotlight.employeeQuery', {
    businessId,
    userId: actorUserId,
  })

  const candidates = await prisma.user.findMany({
    where: {
      active: true,
      role: { not: 'SUPER_ADMIN' },
      employeeIdGas: { not: null },
      ...hideDemoUsersWhere(),
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      employeeIdGas: true,
      businessAccess: true,
    },
    orderBy: { name: 'asc' },
  })

  logEvent('info', 'taskSpotlight.businessScope', {
    businessId,
    userId: actorUserId,
    candidateCount: candidates.length,
  })

  const filtered = candidates.filter(
    u => ASSIGNABLE_ROLES.has(u.role) && userHasBusinessAccess(u.businessAccess, businessId),
  )

  logEvent('info', 'taskSpotlight.filteredEmployees', {
    businessId,
    userId: actorUserId,
    matchedCount: filtered.length,
    employeeUserIds: filtered.map(u => u.id),
  })

  return filtered
}

export async function assertAssigneesInBusinessScope(
  businessId: string,
  assigneeUserIds: string[],
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!assigneeUserIds.length) {
    return { ok: false, error: 'Select at least one employee.' }
  }

  const users = await prisma.user.findMany({
    where: { id: { in: assigneeUserIds }, active: true },
    select: { id: true, role: true, businessAccess: true, employeeIdGas: true },
  })

  if (users.length !== assigneeUserIds.length) {
    logEvent('warn', 'taskSpotlight.assigneeValidation', {
      businessId,
      userId: actorUserId,
      reason: 'unknown_user_ids',
      requested: assigneeUserIds.length,
      found: users.length,
    })
    return { ok: false, error: 'One or more selected employees are invalid.' }
  }

  const outOfScope = users.filter(
    u =>
      !ASSIGNABLE_ROLES.has(u.role)
      || !u.employeeIdGas
      || !userHasBusinessAccess(u.businessAccess, businessId),
  )

  if (outOfScope.length) {
    logEvent('warn', 'taskSpotlight.assigneeValidation', {
      businessId,
      userId: actorUserId,
      reason: 'cross_business_or_ineligible',
      rejectedIds: outOfScope.map(u => u.id),
    })
    return {
      ok: false,
      error: 'One or more employees are not in the current business scope.',
    }
  }

  return { ok: true }
}
