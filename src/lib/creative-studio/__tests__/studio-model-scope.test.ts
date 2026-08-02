import { describe, expect, it } from 'vitest'
import {
  studioModelScopeMatches,
  type StudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'

const expected = {
  ownerId: 'owner-1',
  brandProfileId: 'brand-1',
  projectId: 'project-1',
}

const scoped: StudioResourceScope = {
  version: 1,
  ...expected,
  createdById: 'owner-1',
  createdAt: '2026-08-02T00:00:00.000Z',
}

describe('Creative Studio legacy production model compatibility', () => {
  it('accepts the exact canonical model scope for any admitted actor', () => {
    expect(studioModelScopeMatches(scoped, expected, {
      userId: 'creator-1',
      erpRole: 'STAFF',
    })).toBe(true)
  })

  it('lets only the owning system owner reuse an unscoped production model', () => {
    expect(studioModelScopeMatches(null, expected, {
      userId: 'owner-1',
      erpRole: 'SUPER_ADMIN',
    })).toBe(true)
    expect(studioModelScopeMatches(null, expected, {
      userId: 'creator-1',
      erpRole: 'SUPER_ADMIN',
    })).toBe(false)
    expect(studioModelScopeMatches(null, expected, {
      userId: 'owner-1',
      erpRole: 'STAFF',
    })).toBe(false)
  })

  it('never treats a differently scoped model as legacy', () => {
    expect(studioModelScopeMatches({
      ...scoped,
      brandProfileId: 'brand-2',
      projectId: 'project-2',
    }, expected, {
      userId: 'owner-1',
      erpRole: 'SUPER_ADMIN',
    })).toBe(false)
  })
})
