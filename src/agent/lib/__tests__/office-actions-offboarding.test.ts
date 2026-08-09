import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findTask: vi.fn(),
  transaction: vi.fn(),
  updateTask: vi.fn(),
  createEvent: vi.fn(),
  findActiveStaff: vi.fn(),
  createNotification: vi.fn(),
  pushStaffPing: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentStaffTask: { findFirst: h.findTask },
    $transaction: h.transaction,
  },
}))
vi.mock('@/agent/lib/office-notify', () => ({
  pushStaffPing: h.pushStaffPing,
  pushOwnerPing: vi.fn(),
}))

import { approveTask, requestUpdate } from '@/agent/lib/office-actions'

function task(active: boolean, status = 'sent', userActive = true) {
  return {
    id: 'task-1',
    title: 'Old task',
    status,
    staff: {
      id: 'staff-1',
      name: 'Former Staff',
      active,
      userId: 'user-1',
      user: { active: userActive },
      telegramChatId: '12345',
      ntfyTopic: 'former-staff',
    },
  }
}

describe('Office actions after staff offboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updateTask.mockResolvedValue({})
    h.createEvent.mockResolvedValue({})
    h.findActiveStaff.mockResolvedValue(null)
    h.createNotification.mockResolvedValue({})
    h.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
      agentStaffTask: { update: h.updateTask },
      officeTaskEvent: { create: h.createEvent },
      agentStaff: { findFirst: h.findActiveStaff },
      officeNotification: { create: h.createNotification },
    }))
  })

  it('rejects update reminders for inactive staff before creating any work', async () => {
    h.findTask.mockResolvedValue(task(false))

    await expect(requestUpdate('task-1', 'ALMA_LIFESTYLE', {})).resolves.toEqual({
      ok: false,
      error: 'staff_inactive_or_task_closed',
      code: 409,
    })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.pushStaffPing).not.toHaveBeenCalled()
  })

  it('can close historical work without notifying the former employee', async () => {
    h.findTask.mockResolvedValue(task(false, 'submitted'))

    await expect(approveTask('task-1', 'ALMA_LIFESTYLE')).resolves.toEqual({ ok: true, status: 'done' })
    expect(h.updateTask).toHaveBeenCalled()
    expect(h.findActiveStaff).toHaveBeenCalledWith({
      where: {
        id: 'staff-1',
        active: true,
        OR: [{ userId: null }, { user: { active: true } }],
      },
      select: { id: true },
    })
    expect(h.createNotification).not.toHaveBeenCalled()
    expect(h.pushStaffPing).not.toHaveBeenCalled()
  })

  it('also rejects a stale active AgentStaff link when its ERP user is inactive', async () => {
    h.findTask.mockResolvedValue(task(true, 'sent', false))

    await expect(requestUpdate('task-1', 'ALMA_LIFESTYLE', {})).resolves.toMatchObject({
      ok: false,
      error: 'staff_inactive_or_task_closed',
      code: 409,
    })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.pushStaffPing).not.toHaveBeenCalled()
  })
})
