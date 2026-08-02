import { describe, expect, it } from 'vitest'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import type { StudioV3LibraryItem } from '@/agent/components/creative-studio-v3/gallery-model'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import {
  STUDIO_V3_CAPABILITY_DESKS,
  STUDIO_V3_GALLERY_CATEGORIES,
  STUDIO_V3_GALLERY_DENSITIES,
  STUDIO_V3_LIFECYCLES,
  exactReviewLibraryItem,
  galleryViewForReviewItem,
  scopeProjectsToBrand,
  selectAccessibleStudioBrand,
} from '@/agent/components/creative-studio-v3/ui-contract'
import { STUDIO_V3_SCOPE_BOUNDARY } from '@/agent/components/creative-studio-v3/ports'

function brand(id: string, role: StudioBrandProfile['role']): StudioBrandProfile {
  return {
    brandProfileId: id,
    ownerId: `owner-${id}`,
    name: id,
    organization: null,
    notes: null,
    role,
    approvalSpendThresholdBdt: 0,
    projectCount: 0,
    recipeCount: 0,
    assetCount: 0,
  }
}

function project(id: string, brandProfileId: string | null): StudioProjectSummary {
  return {
    id,
    name: id,
    description: null,
    readonly: brandProfileId === null,
    assetCount: 0,
    brandProfileId,
    currentRecipeId: null,
    currentRecipe: null,
    product: null,
    defaultFolder: 'Campaign',
    updatedAt: null,
  }
}

describe('Creative Studio V3 accessible-brand contract', () => {
  const brands = [brand('brand-a', 'creator'), brand('brand-b', 'reviewer')]

  it('accepts remembered/query IDs only when the server returned them', () => {
    expect(selectAccessibleStudioBrand(brands, 'unknown', 'brand-b')?.brandProfileId).toBe('brand-a')
    expect(selectAccessibleStudioBrand(brands, null, 'brand-b')?.brandProfileId).toBe('brand-b')
    expect(selectAccessibleStudioBrand([], 'brand-a', 'brand-a')).toBeNull()
  })

  it('re-scopes projects to the exact selected brand and excludes Legacy', () => {
    const rows = [
      project('a', 'brand-a'),
      project('b', 'brand-b'),
      project('legacy', null),
    ]
    expect(scopeProjectsToBrand(rows, 'brand-b').map((row) => row.id)).toEqual(['b'])
    expect(scopeProjectsToBrand(rows, null)).toEqual(rows)
  })

  it('documents canonical scope and the owner-only production model exception', () => {
    expect(STUDIO_V3_SCOPE_BOUNDARY.gallery).toContain('server brand/project access')
    expect(STUDIO_V3_SCOPE_BOUNDARY.models).toContain('collaborators exclude unscoped legacy identities')
    expect(STUDIO_V3_SCOPE_BOUNDARY.models).toContain('system owner can reuse the existing production model library')
    expect(STUDIO_V3_SCOPE_BOUNDARY.recipes).toContain('Server-enforced brand recipe filter')
  })

  it('hands Review Inspect the exact canonical asset/version/sequence tuple', () => {
    const target = galleryViewForReviewItem({
      projectAssetId: 'asset-17',
      projectId: 'project-2',
      brandProfileId: 'brand-b',
      currentVersionId: 'version-9',
      expectedSequence: 4,
      state: 'revised',
      title: 'Campaign still',
      previewUrl: null,
    })
    expect(target).toEqual({
      id: 'gallery',
      reviewTarget: {
        brandProfileId: 'brand-b',
        projectId: 'project-2',
        projectAssetId: 'asset-17',
        currentVersionId: 'version-9',
        expectedSequence: 4,
      },
    })

    if (target.id !== 'gallery' || !target.reviewTarget) {
      throw new Error('expected_review_target')
    }
    const generic = {
      id: 'generic-current',
      galleryItem: {
        projectAssetId: 'asset-17',
        assetVersionId: 'version-10',
        reviewSequence: 5,
      },
    } as StudioV3LibraryItem
    const exact = {
      id: 'exact-version',
      galleryItem: {
        projectAssetId: 'asset-17',
        assetVersionId: 'version-9',
        reviewSequence: 4,
      },
    } as StudioV3LibraryItem
    expect(exactReviewLibraryItem([generic], target.reviewTarget)).toBeNull()
    expect(exactReviewLibraryItem(
      [generic, exact],
      target.reviewTarget,
    )?.id).toBe('exact-version')
  })
})

describe('Creative Studio V3 parity lists', () => {
  it('exposes every approved Gallery category, lifecycle, and density', () => {
    expect(STUDIO_V3_GALLERY_CATEGORIES.map((item) => item.id)).toEqual([
      'all', 'image', 'video', 'audio', 'voice', 'avatar', 'project',
    ])
    expect(STUDIO_V3_LIFECYCLES.map((item) => item.id)).toEqual([
      'recent', 'approved', 'review', 'archived',
    ])
    expect(STUDIO_V3_GALLERY_DENSITIES.map((item) => item.id)).toEqual([
      'large', 'comfortable', 'compact', 'list',
    ])
  })

  it('keeps all seven meaningful capability desks', () => {
    expect(STUDIO_V3_CAPABILITY_DESKS).toEqual([
      'projects', 'systems', 'review', 'operations', 'voice', 'audio', 'campaign',
    ])
  })
})
