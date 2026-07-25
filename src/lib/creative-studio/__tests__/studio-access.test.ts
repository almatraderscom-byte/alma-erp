import { beforeEach, describe, expect, it, vi } from 'vitest'

const accessHarness = vi.hoisted(() => ({
  brand: {
    id: 'brand-alma',
    ownerId: 'owner-1',
    approvalSpendThresholdBdt: 100,
  },
  assignment: null as null | {
    ownerId: string
    role: 'CREATOR' | 'REVIEWER'
  },
  prisma: {
    creativeBrandProfile: {
      findUnique: vi.fn(),
    },
    creativeStudioRoleAssignment: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: accessHarness.prisma }))

import {
  assertStudioBrandScope,
  assertStudioCapability,
  assertStudioSpendAllowed,
  normalizeAssignableStudioRole,
  requireStudioBrandAccess,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'

const owner: StudioActor = {
  userId: 'owner-1',
  name: 'Owner',
  email: 'owner@example.com',
  erpRole: 'SUPER_ADMIN',
}
const creator: StudioActor = {
  userId: 'creator-1',
  name: 'Creator',
  email: 'creator@example.com',
  erpRole: 'STAFF',
}

beforeEach(() => {
  accessHarness.assignment = null
  accessHarness.prisma.creativeBrandProfile.findUnique.mockReset()
  accessHarness.prisma.creativeStudioRoleAssignment.findUnique.mockReset()
  accessHarness.prisma.creativeBrandProfile.findUnique.mockResolvedValue(accessHarness.brand)
  accessHarness.prisma.creativeStudioRoleAssignment.findUnique.mockImplementation(async () =>
    accessHarness.assignment)
})

describe('Creative Studio role matrix', () => {
  it('keeps owner access implicit and gives the owner every review capability', async () => {
    const access = await requireStudioBrandAccess(owner, 'brand-alma')
    expect(access).toMatchObject({ role: 'owner', ownerId: 'owner-1' })
    expect(() => assertStudioCapability('owner', 'approve')).not.toThrow()
    expect(() => assertStudioCapability('owner', 'manage_roles')).not.toThrow()
  })

  it('requires an explicit assignment for non-owner access', async () => {
    await expect(requireStudioBrandAccess(creator, 'brand-alma')).rejects.toMatchObject({
      code: 'brand_access_forbidden',
      status: 403,
    })

    accessHarness.assignment = { ownerId: 'owner-1', role: 'CREATOR' }
    await expect(requireStudioBrandAccess(creator, 'brand-alma')).resolves.toMatchObject({
      role: 'creator',
      ownerId: 'owner-1',
    })
  })

  it('separates Creator and Reviewer powers server-side', () => {
    expect(() => assertStudioCapability('creator', 'draft')).not.toThrow()
    expect(() => assertStudioCapability('creator', 'revise')).not.toThrow()
    expect(() => assertStudioCapability('creator', 'comment')).toThrowError(
      expect.objectContaining({ code: 'studio_comment_forbidden' }),
    )
    expect(() => assertStudioCapability('reviewer', 'comment')).not.toThrow()
    expect(() => assertStudioCapability('reviewer', 'request_changes')).not.toThrow()
    expect(() => assertStudioCapability('reviewer', 'approve')).toThrowError(
      expect.objectContaining({ code: 'studio_approve_forbidden' }),
    )
    expect(() => normalizeAssignableStudioRole('owner')).toThrowError(
      expect.objectContaining({ code: 'invalid_studio_role' }),
    )
  })

  it('requires Owner for spend above threshold and blocks Reviewer spend entirely', () => {
    expect(() => assertStudioSpendAllowed('creator', 100, 100)).not.toThrow()
    expect(() => assertStudioSpendAllowed('creator', 101, 100)).toThrowError(
      expect.objectContaining({ code: 'owner_spend_approval_required' }),
    )
    expect(() => assertStudioSpendAllowed('reviewer', 0, 100)).toThrowError(
      expect.objectContaining({ code: 'studio_spend_forbidden' }),
    )
    expect(() => assertStudioSpendAllowed('owner', 1_000_000, 0)).not.toThrow()
  })

  it('fails closed when an asset is addressed through another brand', () => {
    expect(() => assertStudioBrandScope('brand-alma', 'brand-trading')).toThrowError(
      expect.objectContaining({ code: 'brand_scope_mismatch', status: 403 }),
    )
    expect(() => assertStudioBrandScope(null, 'brand-alma')).toThrowError(
      expect.objectContaining({ code: 'asset_brand_missing' }),
    )
  })
})
