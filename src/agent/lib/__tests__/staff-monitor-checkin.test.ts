import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the module under test. vi.hoisted keeps the mock
// object available to the hoisted vi.mock factory (static import triggers it at load).
const mockPrisma = vi.hoisted(() => ({
  agentStaff: { findMany: vi.fn(), update: vi.fn() },
  user: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { getCheckedInStaffIds } from '@/agent/lib/staff-monitor-data'

beforeEach(() => vi.clearAllMocks())

describe('getCheckedInStaffIds — active detection', () => {
  it('joins on AttendanceRecord.userId, NOT employeeId (the historic AWAITING bug)', async () => {
    mockPrisma.agentStaff.findMany.mockResolvedValue([
      { id: 's1', userId: 'u1', name: 'Mohammad Eyafi' },
    ])
    mockPrisma.attendanceRecord.findMany.mockResolvedValue([{ userId: 'u1' }])

    const result = await getCheckedInStaffIds(['s1'], '2026-06-24')
    expect(result.has('s1')).toBe(true)

    // Lock the column: must filter by userId and must NOT use employeeId.
    const whereArg = mockPrisma.attendanceRecord.findMany.mock.calls[0][0].where
    expect(whereArg).toHaveProperty('userId')
    expect(whereArg).not.toHaveProperty('employeeId')
  })

  it('self-heals a null user_id by matching name to User and backfills the link', async () => {
    mockPrisma.agentStaff.findMany.mockResolvedValue([
      { id: 's2', userId: null, name: 'Mustahid' },
    ])
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u2', name: 'Mustahid' }])
    mockPrisma.attendanceRecord.findMany.mockResolvedValue([{ userId: 'u2' }])
    mockPrisma.agentStaff.update.mockResolvedValue({})

    const result = await getCheckedInStaffIds(['s2'], '2026-06-24')
    expect(result.has('s2')).toBe(true)
    // Link repaired and persisted so it never silently regresses again.
    expect(mockPrisma.agentStaff.update).toHaveBeenCalledWith({
      where: { id: 's2' },
      data: { userId: 'u2' },
    })
  })

  it('does NOT mark a staff active when there is no check-in today', async () => {
    mockPrisma.agentStaff.findMany.mockResolvedValue([
      { id: 's1', userId: 'u1', name: 'Eyafi' },
    ])
    mockPrisma.attendanceRecord.findMany.mockResolvedValue([])
    const result = await getCheckedInStaffIds(['s1'], '2026-06-24')
    expect(result.has('s1')).toBe(false)
  })

  it('returns empty (no DB hit) when no staff ids are given', async () => {
    const result = await getCheckedInStaffIds([], '2026-06-24')
    expect(result.size).toBe(0)
    expect(mockPrisma.agentStaff.findMany).not.toHaveBeenCalled()
  })
})
