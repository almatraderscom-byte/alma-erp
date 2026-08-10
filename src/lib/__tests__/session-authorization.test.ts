import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.hoisted(() => vi.fn())
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique } } }))

import { resolveActiveSessionToken } from '@/lib/session-authorization'

describe('active JWT authorization', () => {
  beforeEach(() => findUnique.mockReset())

  it('rejects a previously issued JWT as soon as the user becomes inactive', async () => {
    findUnique.mockResolvedValue({
      id: 'staff-1',
      active: false,
      role: 'STAFF',
      businessAccess: 'ALMA_LIFESTYLE',
      employeeIdGas: 'EMP-1',
      name: 'Former Staff',
      email: null,
      phone: '+8801700000001',
    })
    await expect(resolveActiveSessionToken({ sub: 'staff-1', role: 'STAFF' })).resolves.toBeNull()
  })

  it('refreshes role and business scope from the database instead of trusting stale JWT claims', async () => {
    findUnique.mockResolvedValue({
      id: 'staff-1',
      active: true,
      role: 'VIEWER',
      businessAccess: 'ALMA_TRADING',
      employeeIdGas: 'EMP-1',
      name: 'Current Staff',
      email: null,
      phone: '+8801700000001',
    })
    await expect(resolveActiveSessionToken({ sub: 'staff-1', role: 'ADMIN', businessAccess: 'ALMA_LIFESTYLE' }))
      .resolves.toMatchObject({ role: 'VIEWER', businessAccess: 'ALMA_TRADING' })
  })
})
