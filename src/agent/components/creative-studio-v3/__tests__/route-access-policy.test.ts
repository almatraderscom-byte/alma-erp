import { describe, expect, it } from 'vitest'
import type { StudioBrandSummary } from '@/lib/creative-studio/studio-access'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import { resolveCreativeStudioV3RouteDecision } from '@/agent/components/creative-studio-v3/route-access-policy'

function brand(
  id: string,
  role: StudioBrandSummary['role'],
  ownerId = 'owner-1',
): StudioBrandSummary {
  return {
    brandProfileId: id,
    ownerId,
    role,
    approvalSpendThresholdBdt: 100,
    name: id,
    organization: null,
    notes: null,
    projectCount: 1,
    recipeCount: 0,
    assetCount: 0,
  }
}

function project(id: string, brandProfileId: string): StudioProjectSummary {
  return {
    id,
    brandProfileId,
    name: id,
    description: null,
    readonly: false,
    assetCount: 0,
    currentRecipeId: null,
    currentRecipe: null,
    product: null,
    defaultFolder: 'Campaign',
    updatedAt: null,
  }
}

const enabled = {
  CREATIVE_STUDIO_V3_UI_ENABLED: '1',
  CREATIVE_STUDIO_V3_BRAND_IDS: 'brand-a',
}

describe('Creative Studio V3 route admission', () => {
  it('admits an owner through an owner-scoped rollout', () => {
    const decision = resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: true,
      accessibleBrands: [brand('brand-a', 'owner')],
      accessibleProjects: [],
      requestedBrandId: null,
      requestedProjectId: null,
      forceLegacy: false,
      environment: {
        CREATIVE_STUDIO_V3_UI_ENABLED: '1',
        CREATIVE_STUDIO_V3_OWNER_IDS: 'owner-1',
      },
    })
    expect(decision).toMatchObject({ kind: 'v3', brand: { role: 'owner' } })
  })

  it('admits an explicitly assigned creator for an enabled accessible brand', () => {
    const decision = resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [brand('brand-a', 'creator')],
      accessibleProjects: [],
      requestedBrandId: 'brand-a',
      requestedProjectId: null,
      forceLegacy: false,
      environment: enabled,
    })
    expect(decision).toMatchObject({ kind: 'v3', brand: { role: 'creator' } })
  })

  it('admits an explicitly assigned reviewer without granting creator powers', () => {
    const decision = resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [brand('brand-a', 'reviewer')],
      accessibleProjects: [],
      requestedBrandId: 'brand-a',
      requestedProjectId: null,
      forceLegacy: false,
      environment: enabled,
    })
    expect(decision).toMatchObject({ kind: 'v3', brand: { role: 'reviewer' } })
  })

  it('fails closed for an unassigned authenticated actor', () => {
    expect(resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [],
      accessibleProjects: [],
      requestedBrandId: null,
      requestedProjectId: null,
      forceLegacy: false,
      environment: {
        CREATIVE_STUDIO_V3_UI_ENABLED: '1',
        CREATIVE_STUDIO_V3_OWNER_IDS: '*',
      },
    })).toEqual({ kind: 'denied', reason: 'no_accessible_brand' })
  })

  it('rejects an inaccessible query brand even under a wildcard rollout', () => {
    expect(resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [brand('brand-a', 'creator')],
      accessibleProjects: [],
      requestedBrandId: 'brand-secret',
      requestedProjectId: null,
      forceLegacy: false,
      environment: {
        CREATIVE_STUDIO_V3_UI_ENABLED: '1',
        CREATIVE_STUDIO_V3_BRAND_IDS: '*',
      },
    })).toEqual({ kind: 'denied', reason: 'brand_access_forbidden' })
  })

  it('keeps force-legacy owner-only', () => {
    const common = {
      accessibleBrands: [brand('brand-a', 'creator')],
      accessibleProjects: [],
      requestedBrandId: 'brand-a',
      requestedProjectId: null,
      forceLegacy: true,
      environment: enabled,
    }
    expect(resolveCreativeStudioV3RouteDecision({
      ...common,
      actorIsSystemOwner: false,
    })).toEqual({ kind: 'denied', reason: 'legacy_owner_only' })
    expect(resolveCreativeStudioV3RouteDecision({
      ...common,
      actorIsSystemOwner: true,
    })).toEqual({ kind: 'legacy' })
  })

  it('accepts a project query only when its canonical brand is accessible', () => {
    const allowed = resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [brand('brand-a', 'creator')],
      accessibleProjects: [project('project-a', 'brand-a')],
      requestedBrandId: 'brand-a',
      requestedProjectId: 'project-a',
      forceLegacy: false,
      environment: {
        CREATIVE_STUDIO_V3_UI_ENABLED: '1',
        CREATIVE_STUDIO_V3_PROJECT_IDS: 'project-a',
      },
    })
    expect(allowed).toMatchObject({ kind: 'v3', projectId: 'project-a' })

    expect(resolveCreativeStudioV3RouteDecision({
      actorIsSystemOwner: false,
      accessibleBrands: [brand('brand-a', 'creator')],
      accessibleProjects: [project('project-secret', 'brand-secret')],
      requestedBrandId: 'brand-a',
      requestedProjectId: 'project-secret',
      forceLegacy: false,
      environment: {
        CREATIVE_STUDIO_V3_UI_ENABLED: '1',
        CREATIVE_STUDIO_V3_PROJECT_IDS: '*',
      },
    })).toEqual({ kind: 'denied', reason: 'project_access_forbidden' })
  })
})
