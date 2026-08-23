import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  serverGet: vi.fn(),
  prisma: {
    agentStaff: { findUnique: vi.fn() },
    agentBill: { findUnique: vi.fn() },
    lifestyleProduct: { findUnique: vi.fn() },
    creativeProject: { findFirst: vi.fn() },
    notification: { findUnique: vi.fn() },
    tradingEmployeeProfile: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/server-api', () => ({ serverGet: mocks.serverGet }))

import { resolveReferenceEntity } from '../entity-resolver'

const owner = 'owner-1'

describe('reference entity resolver ownership boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires a context row to prove the requested business', async () => {
    mocks.prisma.agentStaff.findUnique.mockResolvedValueOnce({
      id: 'staff-1', businessId: 'ALMA_TRADING', name: 'Wrong business',
    })
    await expect(resolveReferenceEntity({
      namespace: 'agent_staff', id: 'staff-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toBeNull()

    mocks.prisma.agentStaff.findUnique.mockResolvedValueOnce({ id: 'staff-1', name: 'Unscoped' })
    await expect(resolveReferenceEntity({
      namespace: 'agent_staff', id: 'staff-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toBeNull()

    mocks.prisma.agentStaff.findUnique.mockResolvedValueOnce({
      id: 'staff-1', businessId: 'ALMA_LIFESTYLE', name: 'Scoped',
    })
    await expect(resolveReferenceEntity({
      namespace: 'agent_staff', id: 'staff-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toMatchObject({ businessId: 'ALMA_LIFESTYLE', fields: { id: 'staff-1' } })
  })

  it('allows only reviewed fixed-business tables to omit a business column', async () => {
    mocks.prisma.lifestyleProduct.findUnique.mockResolvedValue({ sku: 'SKU-1', name: 'Dress' })
    await expect(resolveReferenceEntity({
      namespace: 'product', id: 'SKU-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toMatchObject({ namespace: 'product', businessId: 'ALMA_LIFESTYLE' })

    await expect(resolveReferenceEntity({
      namespace: 'product', id: 'SKU-1', businessId: 'ALMA_TRADING', userId: owner,
    })).resolves.toBeNull()
  })

  it('keeps legacy personal rows in the authenticated owner-global scope', async () => {
    mocks.prisma.agentBill.findUnique.mockResolvedValueOnce({ id: 'bill-1', name: 'Internet' })
    await expect(resolveReferenceEntity({
      namespace: 'bill', id: 'bill-1', businessId: null, userId: owner,
    })).resolves.toMatchObject({ namespace: 'bill', businessId: null, fields: { id: 'bill-1' } })
    expect(mocks.prisma.agentBill.findUnique).toHaveBeenCalledWith({ where: { id: 'bill-1' } })
  })

  it('scopes creative projects to the authenticated owner', async () => {
    mocks.prisma.creativeProject.findFirst.mockResolvedValueOnce({
      id: 'creative-1', ownerId: owner, name: 'Launch',
    })
    await expect(resolveReferenceEntity({
      namespace: 'creative_project', id: 'creative-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toMatchObject({ namespace: 'creative_project', businessId: 'ALMA_LIFESTYLE' })
    expect(mocks.prisma.creativeProject.findFirst).toHaveBeenCalledWith({
      where: { id: 'creative-1', ownerId: owner },
    })

    mocks.prisma.creativeProject.findFirst.mockResolvedValueOnce(null)
    await expect(resolveReferenceEntity({
      namespace: 'creative_project', id: 'creative-1', businessId: 'ALMA_LIFESTYLE', userId: 'other-user',
    })).resolves.toBeNull()
  })

  it('does not treat a User id or an ambiguous GAS key as a trading profile identity', async () => {
    mocks.prisma.tradingEmployeeProfile.findUnique.mockResolvedValue(null)
    mocks.prisma.tradingEmployeeProfile.findMany.mockResolvedValueOnce([])
    await expect(resolveReferenceEntity({
      namespace: 'trading_employee', id: 'user-1', businessId: 'ALMA_TRADING', userId: owner,
    })).resolves.toBeNull()
    expect(mocks.prisma.tradingEmployeeProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId: 'ALMA_TRADING', employeeIdGas: 'user-1' },
    }))

    mocks.prisma.tradingEmployeeProfile.findMany.mockResolvedValueOnce([
      { id: 'profile-1', businessId: 'ALMA_TRADING', employeeIdGas: 'EMP-1' },
      { id: 'profile-2', businessId: 'ALMA_TRADING', employeeIdGas: 'EMP-1' },
    ])
    await expect(resolveReferenceEntity({
      namespace: 'trading_employee', id: 'EMP-1', businessId: 'ALMA_TRADING', userId: owner,
    })).resolves.toBeNull()
  })

  it('requires a notification to be explicitly owned by the authenticated user', async () => {
    mocks.prisma.notification.findUnique.mockResolvedValueOnce({
      id: 'notice-1', businessId: 'ALMA_LIFESTYLE', userId: 'other-user', title: 'Private',
    })
    await expect(resolveReferenceEntity({
      namespace: 'notification', id: 'notice-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toBeNull()

    mocks.prisma.notification.findUnique.mockResolvedValueOnce({
      id: 'notice-1', businessId: 'ALMA_LIFESTYLE', userId: owner, title: 'Mine',
    })
    await expect(resolveReferenceEntity({
      namespace: 'notification', id: 'notice-1', businessId: 'ALMA_LIFESTYLE', userId: owner,
    })).resolves.toMatchObject({ namespace: 'notification', businessId: 'ALMA_LIFESTYLE' })
  })
})
