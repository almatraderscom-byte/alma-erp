import type { BusinessId } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { isSystemOwner } from '@/lib/roles'
import { resolveProfileImageForUser } from '@/lib/user-display'

const PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  active: true,
  businessAccess: true,
  employeeIdGas: true,
  joiningDate: true,
  salaryHint: true,
  profileImageUrl: true,
  updatedAt: true,
  createdAt: true,
  tradingEmployeeProfile: true,
} as const

export async function resolveMyDeskProfile(userId: string, businessId?: BusinessId | string | null) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PROFILE_SELECT,
  })
  if (!user) return null

  if (isSystemOwner(user.role)) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      active: user.active,
      businessAccess: user.businessAccess,
      employeeIdGas: null,
      joiningDate: null,
      salaryHint: null,
      profileImageUrl: resolveProfileImageForUser(user),
      createdAt: user.createdAt,
      isSystemOwner: true,
      profile: {
        source: 'SYSTEM_OWNER',
        roleTitle: 'System Owner',
        shift: null,
        status: user.active ? 'ACTIVE' : 'INACTIVE',
        salary: null,
      },
    }
  }

  const tradingProfile = businessId === 'ALMA_TRADING' ? user.tradingEmployeeProfile : null
  const resolvedEmployeeId = tradingProfile?.employeeIdGas || user.employeeIdGas || null
  const resolvedSalary = tradingProfile?.salary ?? user.salaryHint ?? null

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    active: user.active,
    businessAccess: user.businessAccess,
    employeeIdGas: resolvedEmployeeId,
    joiningDate: user.joiningDate,
    salaryHint: resolvedSalary,
    profileImageUrl: resolveProfileImageForUser(user),
    createdAt: user.createdAt,
    isSystemOwner: false,
    profile: tradingProfile
      ? {
          source: 'TRADING_EMPLOYEE_PROFILE',
          roleTitle: tradingProfile.roleTitle,
          shift: tradingProfile.shift,
          status: tradingProfile.status,
          salary: Number(tradingProfile.salary || 0),
        }
      : {
          source: 'USER_PROFILE',
          roleTitle: null,
          shift: null,
          status: user.active ? 'ACTIVE' : 'INACTIVE',
          salary: user.salaryHint == null ? null : Number(user.salaryHint),
        },
  }
}
