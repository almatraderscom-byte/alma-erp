import type { Prisma, UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { parseBusinessAccess } from '@/lib/business-access'
import { serverGet, serverPost } from '@/lib/server-api'
import { errorMeta, logEvent } from '@/lib/logger'

const TERMINAL_STAFF_TASK_STATUSES = ['completed', 'done', 'cancelled', 'rejected']
const LIVE_ASSIGNMENT_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const
const LIVE_CALL_STATES = ['CREATED', 'RINGING', 'ANSWERED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'] as const

export class StaffOffboardingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'StaffOffboardingError'
  }
}

export type StaffOffboardingActor = {
  id: string
  name: string
  role: UserRole
  businessAccess: string
}

export type StaffOffboardingResult = {
  ok: true
  alreadyInactive: boolean
  userId: string
  employeeId: string | null
  access: {
    agentStaffDisabled: number
    telegramLinksRevoked: number
    pushSubscriptionsDisabled: number
    callDevicesDisabled: number
    creativeStudioRolesRevoked: number
    tradingAccountsUnassigned: number
    pendingActionsCancelled: number
    scheduledCallsCancelled: number
    openTasksArchived: number
  }
  hrRoster: Array<{ businessId: string; status: 'inactive' | 'failed'; error?: string }>
}

type OffboardingTarget = {
  id: string
  name: string
  phone: string | null
  role: UserRole
  active: boolean
  businessAccess: string
  employeeIdGas: string | null
}

function normalizePhone(value: string | null | undefined) {
  return String(value || '').replace(/\D/g, '')
}

function payloadTargetsStaff(
  value: Prisma.JsonValue,
  strongIds: Set<string>,
  targetName: string,
  key = '',
): boolean {
  if (typeof value === 'string') {
    if (strongIds.has(value) || strongIds.has(normalizePhone(value))) return true
    return ['staffName', 'recipientName'].includes(key) && value.trim().toLowerCase() === targetName.trim().toLowerCase()
  }
  if (Array.isArray(value)) return value.some(item => payloadTargetsStaff(item, strongIds, targetName, key))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) =>
      payloadTargetsStaff(child as Prisma.JsonValue, strongIds, targetName, childKey),
    )
  }
  return false
}

function assertActorCanOffboard(actor: StaffOffboardingActor, target: OffboardingTarget) {
  if (actor.id === target.id) throw new StaffOffboardingError('You cannot offboard your own account.', 400)
  if (target.role === 'SUPER_ADMIN') throw new StaffOffboardingError('The system owner account cannot be offboarded.', 403)
  if (actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
    throw new StaffOffboardingError('Only an administrator can offboard staff.', 403)
  }
  if (actor.role === 'ADMIN' && target.role === 'ADMIN') {
    throw new StaffOffboardingError('Only the system owner can offboard another administrator.', 403)
  }

  if (actor.role !== 'SUPER_ADMIN') {
    const allowed = new Set(parseBusinessAccess(actor.businessAccess))
    const outsideScope = parseBusinessAccess(target.businessAccess).some(id => !allowed.has(id))
    if (outsideScope) throw new StaffOffboardingError('This staff account is outside your business scope.', 403)
  }
}

async function syncHrRoster(target: OffboardingTarget, actor: StaffOffboardingActor) {
  if (!target.employeeIdGas) return []
  const results: StaffOffboardingResult['hrRoster'] = []
  const businessIds = parseBusinessAccess(target.businessAccess)
  if (businessIds.length === 0) {
    results.push({ businessId: 'UNKNOWN', status: 'failed', error: 'No business scope is available for HR sync.' })
    return results
  }

  for (const businessId of businessIds) {
    try {
      // GAS hr_employee_save is a full-row upsert, not a patch. Read the row
      // first and preserve every existing field so offboarding changes only
      // its status and never blanks salary, role, phone, or joining date.
      const roster = await serverGet<{ employees?: Array<Record<string, unknown>> }>(
        'hr_employees',
        { business_id: businessId },
        0,
      )
      const employee = roster.employees?.find(row => String(row.emp_id || '') === target.employeeIdGas)
      if (!employee) throw new Error(`Employee ${target.employeeIdGas} was not found in ${businessId}.`)

      await serverPost('hr_employee_save', {
        business_id: businessId,
        emp_id: target.employeeIdGas,
        name: employee.name || target.name,
        phone: employee.phone || target.phone || '',
        email: employee.email || '',
        address: employee.address || '',
        role: employee.role || '',
        joining_date: employee.joining_date || '',
        monthly_salary: employee.monthly_salary || 0,
        status: 'Inactive',
        notes: employee.notes || '',
        actor_user_id: actor.id,
        actor_name: actor.name,
        updated_by: actor.id,
      })
      results.push({ businessId, status: 'inactive' })
    } catch (error) {
      results.push({ businessId, status: 'failed', error: (error as Error).message })
      logEvent('error', 'staff.offboarding.hr_sync_failed', {
        actorUserId: actor.id,
        targetUserId: target.id,
        employeeId: target.employeeIdGas,
        businessId,
        ...errorMeta(error),
      })
    }
  }
  return results
}

export async function offboardStaffUser(
  userId: string,
  actor: StaffOffboardingActor,
  options: { reason?: string } = {},
): Promise<StaffOffboardingResult> {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      active: true,
      businessAccess: true,
      employeeIdGas: true,
    },
  })
  if (!target) throw new StaffOffboardingError('User not found.', 404)
  assertActorCanOffboard(actor, target)

  const now = new Date()
  const alreadyInactive = !target.active
  const access = await prisma.$transaction(async tx => {
    const linkedStaff = await tx.agentStaff.findMany({
      where: {
        OR: [
          { userId: target.id },
          {
            userId: null,
            name: { equals: target.name, mode: 'insensitive' },
            businessId: { in: parseBusinessAccess(target.businessAccess) },
          },
        ],
      },
      select: { id: true, telegramChatId: true },
    })
    const staffIds = linkedStaff.map(row => row.id)
    const telegramChatIds = linkedStaff.map(row => row.telegramChatId).filter((id): id is string => Boolean(id))

    const telegramLinks = await tx.tradingTelegramUser.findMany({
      where: { userId: target.id },
      select: { telegramUserId: true },
    })
    const strongIds = new Set([
      target.id,
      target.employeeIdGas || '',
      target.phone || '',
      normalizePhone(target.phone),
      ...staffIds,
      ...telegramChatIds,
      ...telegramLinks.map(row => row.telegramUserId),
    ].filter(Boolean))

    const pendingActions = await tx.agentPendingAction.findMany({
      where: { status: { in: ['pending', 'approved', 'waiting_list'] } },
      select: { id: true, payload: true },
    })
    const pendingActionIds = pendingActions
      .filter(row => payloadTargetsStaff(row.payload, strongIds, target.name))
      .map(row => row.id)

    const activeCalls = await tx.officeCallSession.findMany({
      where: {
        state: { in: [...LIVE_CALL_STATES] },
        OR: [{ callerUserId: target.id }, { calleeUserId: target.id }],
      },
      select: { id: true },
    })
    const activeCallIds = activeCalls.map(row => row.id)

    const [
      agentStaffDisabled,
      telegramLinksRevoked,
      pushSubscriptionsDisabled,
      callDevicesDisabled,
      creativeStudioRolesRevoked,
      tradingAccountsUnassigned,
      pendingActionsCancelled,
      scheduledCallsCancelled,
      openTasksArchived,
    ] = await Promise.all([
      tx.agentStaff.updateMany({
        where: { id: { in: staffIds } },
        data: { active: false, telegramChatId: null, ntfyTopic: null },
      }),
      tx.tradingTelegramUser.updateMany({
        where: { userId: target.id },
        data: { approved: false, defaultAccountAlias: null, defaultTradingAccountId: null },
      }),
      tx.pushSubscription.updateMany({ where: { userId: target.id, enabled: true }, data: { enabled: false } }),
      tx.officeCallDevice.updateMany({
        where: { userId: target.id, active: true },
        data: { active: false, invalidatedAt: now, providerTokenEnc: null },
      }),
      tx.creativeStudioRoleAssignment.deleteMany({ where: { userId: target.id } }),
      tx.tradingAccount.updateMany({ where: { assignedUserId: target.id }, data: { assignedUserId: null } }),
      tx.agentPendingAction.updateMany({
        where: { id: { in: pendingActionIds } },
        data: {
          status: 'cancelled',
          resolvedAt: now,
          result: { error: 'staff_offboarded', targetUserId: target.id },
        },
      }),
      tx.scheduledCall.updateMany({
        where: {
          status: 'scheduled',
          OR: [
            ...(target.phone ? [{ toNumber: target.phone }] : []),
            { recipientName: { equals: target.name, mode: 'insensitive' }, callType: 'staff' },
          ],
        },
        data: { status: 'cancelled', error: 'staff_offboarded' },
      }),
      tx.operationalTaskAssignment.updateMany({
        where: { userId: target.id, status: { in: [...LIVE_ASSIGNMENT_STATUSES] } },
        data: { status: 'ARCHIVED', archivedAt: now },
      }),
    ])

    if (staffIds.length) {
      await Promise.all([
        tx.agentStaffTask.updateMany({
          where: { staffId: { in: staffIds }, status: { notIn: TERMINAL_STAFF_TASK_STATUSES } },
          data: { status: 'cancelled', completedAt: now },
        }),
        tx.agentOutbox.updateMany({
          where: { staffId: { in: staffIds }, status: { in: ['queued', 'approved', 'pending'] } },
          data: { status: 'cancelled', errorReason: 'staff_offboarded' },
        }),
        tx.officeStaffProposal.updateMany({
          where: { staffId: { in: staffIds }, status: 'pending' },
          data: { status: 'dismissed', decidedBy: actor.id, decidedAt: now },
        }),
      ])
    }

    if (telegramLinks.length) {
      const telegramUserIds = telegramLinks.map(row => row.telegramUserId)
      await Promise.all([
        tx.tradingTelegramPendingDuplicate.deleteMany({ where: { telegramUserId: { in: telegramUserIds } } }),
        tx.tradingTelegramDraft.updateMany({
          where: { telegramUserId: { in: telegramUserIds }, status: { in: ['PENDING', 'LOCKED'] } },
          data: { status: 'REJECTED' },
        }),
      ])
    }

    if (activeCallIds.length) {
      await Promise.all([
        tx.officeCallSession.updateMany({
          where: { id: { in: activeCallIds } },
          data: { state: 'ENDED', terminalReason: 'CANCELLED', endedAt: now },
        }),
        tx.officeCallLeg.updateMany({
          where: { callId: { in: activeCallIds } },
          data: { state: 'ENDED', leftAt: now },
        }),
        tx.officeCallOutbox.updateMany({
          where: { callId: { in: activeCallIds }, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { status: 'DEAD', processedAt: now, lastErrorCode: 'staff_offboarded' },
        }),
        tx.officeCallParticipantLock.deleteMany({ where: { callId: { in: activeCallIds } } }),
      ])
    }

    await Promise.all([
      tx.user.update({
        where: { id: target.id },
        data: {
          active: false,
          offboardedAt: now,
          offboardedBy: actor.id,
          offboardingReason: options.reason?.trim() || 'Employment ended',
        },
      }),
      tx.passwordResetToken.deleteMany({ where: { userId: target.id } }),
      tx.notificationPreference.updateMany({ where: { userId: target.id }, data: { enabled: false } }),
      tx.tradingEmployeeProfile.updateMany({ where: { userId: target.id }, data: { status: 'INACTIVE' } }),
      tx.agentVoiceCall.updateMany({
        where: {
          toNumber: target.phone || '__no_phone__',
          status: { in: ['initiated', 'queued', 'ringing'] },
        },
        data: { status: 'cancelled', endedAt: now },
      }),
    ])

    return {
      agentStaffDisabled: agentStaffDisabled.count,
      telegramLinksRevoked: telegramLinksRevoked.count,
      pushSubscriptionsDisabled: pushSubscriptionsDisabled.count,
      callDevicesDisabled: callDevicesDisabled.count,
      creativeStudioRolesRevoked: creativeStudioRolesRevoked.count,
      tradingAccountsUnassigned: tradingAccountsUnassigned.count,
      pendingActionsCancelled: pendingActionsCancelled.count,
      scheduledCallsCancelled: scheduledCallsCancelled.count,
      openTasksArchived: openTasksArchived.count,
    }
  })

  const hrRoster = await syncHrRoster(target, actor)
  const hrRosterComplete = !target.employeeIdGas
    || (hrRoster.length > 0 && hrRoster.every(item => item.status === 'inactive'))
  if (hrRosterComplete) {
    await prisma.user.update({ where: { id: target.id }, data: { hrOffboardedAt: new Date() } })
  }
  const result: StaffOffboardingResult = {
    ok: true,
    alreadyInactive,
    userId: target.id,
    employeeId: target.employeeIdGas,
    access,
    hrRoster,
  }

  await prisma.agentAuditLog.create({
    data: {
      actionType: 'staff.offboarded',
      resourceId: target.id,
      actor: actor.id,
      payload: {
        targetName: target.name,
        reason: options.reason?.trim() || 'Employment ended',
        employeeId: target.employeeIdGas,
        alreadyInactive,
        access,
        hrRoster,
      },
    },
  }).catch(() => undefined)

  logEvent('warn', 'staff.offboarded', {
    actorUserId: actor.id,
    targetUserId: target.id,
    employeeId: target.employeeIdGas,
    reason: options.reason?.trim() || 'Employment ended',
    alreadyInactive,
    access,
    hrRoster,
  })
  return result
}
