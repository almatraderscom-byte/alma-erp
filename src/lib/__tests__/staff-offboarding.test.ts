import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const updateMany = () => vi.fn().mockResolvedValue({ count: 1 })
  const deleteMany = () => vi.fn().mockResolvedValue({ count: 1 })
  const tx = {
    agentStaff: { findMany: vi.fn(), updateMany: updateMany() },
    tradingTelegramUser: { findMany: vi.fn(), updateMany: updateMany() },
    pushSubscription: { updateMany: updateMany() },
    officeCallDevice: { updateMany: updateMany() },
    creativeStudioRoleAssignment: { deleteMany: deleteMany() },
    tradingAccount: { updateMany: updateMany() },
    agentPendingAction: { findMany: vi.fn(), updateMany: updateMany() },
    scheduledCall: { updateMany: updateMany() },
    operationalTaskAssignment: { updateMany: updateMany() },
    officeCallSession: { findMany: vi.fn(), updateMany: updateMany() },
    agentStaffTask: { updateMany: updateMany() },
    agentOutbox: { updateMany: updateMany() },
    officeStaffProposal: { updateMany: updateMany() },
    tradingTelegramPendingDuplicate: { deleteMany: deleteMany() },
    tradingTelegramDraft: { updateMany: updateMany() },
    officeCallLeg: { updateMany: updateMany() },
    officeCallOutbox: { updateMany: updateMany() },
    officeCallParticipantLock: { deleteMany: deleteMany() },
    user: { update: vi.fn().mockResolvedValue({}) },
    passwordResetToken: { deleteMany: deleteMany() },
    notificationPreference: { updateMany: updateMany() },
    tradingEmployeeProfile: { updateMany: updateMany() },
    agentVoiceCall: { updateMany: updateMany() },
  }
  return {
    tx,
    userFindUnique: vi.fn(),
    userUpdate: vi.fn().mockResolvedValue({}),
    transaction: vi.fn(),
    auditCreate: vi.fn().mockResolvedValue({}),
    serverGet: vi.fn(),
    serverPost: vi.fn().mockResolvedValue({ ok: true }),
  }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: h.userFindUnique, update: h.userUpdate },
    $transaction: h.transaction,
    agentAuditLog: { create: h.auditCreate },
  },
}))
vi.mock('@/lib/server-api', () => ({ serverGet: h.serverGet, serverPost: h.serverPost }))
vi.mock('@/lib/logger', () => ({ logEvent: vi.fn(), errorMeta: vi.fn(() => ({})) }))

import { offboardStaffUser, StaffOffboardingError } from '@/lib/staff-offboarding'

const actor = {
  id: 'owner-1',
  name: 'Owner',
  role: 'SUPER_ADMIN' as const,
  businessAccess: 'ALMA_LIFESTYLE,ALMA_TRADING',
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-user-1',
    name: 'Staff One',
    phone: '+8801711111111',
    role: 'STAFF',
    active: true,
    businessAccess: 'ALMA_LIFESTYLE',
    employeeIdGas: 'EMP-1',
    ...overrides,
  }
}

describe('atomic staff offboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const model of Object.values(h.tx)) {
      for (const fn of Object.values(model)) {
        if (typeof fn === 'function' && 'mockResolvedValue' in fn && !['findMany'].some(() => false)) {
          // Keep the default one-row result on mutation mocks after clearAllMocks.
        }
      }
    }
    h.userFindUnique.mockResolvedValue(target())
    h.tx.agentStaff.findMany.mockResolvedValue([{ id: 'agent-staff-1', telegramChatId: '10001' }])
    h.tx.tradingTelegramUser.findMany.mockResolvedValue([{ telegramUserId: '20002' }])
    h.tx.agentPendingAction.findMany.mockResolvedValue([
      { id: 'targeted-card', payload: { staffId: 'agent-staff-1' } },
      { id: 'other-card', payload: { staffId: 'someone-else' } },
    ])
    h.tx.officeCallSession.findMany.mockResolvedValue([])
    h.transaction.mockImplementation((callback: (tx: typeof h.tx) => unknown) => callback(h.tx))
    h.serverGet.mockResolvedValue({
      employees: [{
        emp_id: 'EMP-1',
        name: 'Staff One',
        phone: '+8801711111111',
        role: 'Operations',
        joining_date: '2025-01-01',
        monthly_salary: 22000,
        status: 'Active',
        notes: 'Keep this note',
      }],
    })
    h.serverPost.mockResolvedValue({ ok: true })
  })

  it('revokes every live channel and cancels only pending work targeting that staff member', async () => {
    const result = await offboardStaffUser('staff-user-1', actor, { reason: 'Employment ended' })

    expect(result.ok).toBe(true)
    expect(h.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'staff-user-1' },
      data: expect.objectContaining({
        active: false,
        offboardedBy: 'owner-1',
        offboardingReason: 'Employment ended',
      }),
    })
    expect(h.tx.agentStaff.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['agent-staff-1'] } },
      data: { active: false, telegramChatId: null, ntfyTopic: null },
    })
    expect(h.tx.tradingTelegramUser.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'staff-user-1' },
      data: expect.objectContaining({ approved: false }),
    }))
    expect(h.tx.agentPendingAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['targeted-card'] } },
    }))
    expect(h.serverPost).toHaveBeenCalledWith('hr_employee_save', expect.objectContaining({
      business_id: 'ALMA_LIFESTYLE',
      emp_id: 'EMP-1',
      name: 'Staff One',
      monthly_salary: 22000,
      notes: 'Keep this note',
      status: 'Inactive',
    }))
    expect(h.userUpdate).toHaveBeenCalledWith({
      where: { id: 'staff-user-1' },
      data: { hrOffboardedAt: expect.any(Date) },
    })
  })

  it('keeps HR completion unmarked when roster sync fails so the UI offers a retry', async () => {
    h.serverPost.mockRejectedValue(new Error('GAS unavailable'))
    const result = await offboardStaffUser('staff-user-1', actor)
    expect(result.hrRoster).toEqual([
      expect.objectContaining({ businessId: 'ALMA_LIFESTYLE', status: 'failed' }),
    ])
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it('is safe to retry for an account that was already inactive', async () => {
    h.userFindUnique.mockResolvedValue(target({ active: false }))
    await expect(offboardStaffUser('staff-user-1', actor)).resolves.toMatchObject({
      ok: true,
      alreadyInactive: true,
    })
  })

  it('blocks self-offboarding and system-owner offboarding before any mutation', async () => {
    h.userFindUnique.mockResolvedValue(target({ id: 'owner-1' }))
    await expect(offboardStaffUser('owner-1', actor)).rejects.toBeInstanceOf(StaffOffboardingError)
    expect(h.transaction).not.toHaveBeenCalled()

    h.userFindUnique.mockResolvedValue(target({ role: 'SUPER_ADMIN' }))
    await expect(offboardStaffUser('staff-user-1', actor)).rejects.toMatchObject({ status: 403 })
    expect(h.transaction).not.toHaveBeenCalled()
  })
})
