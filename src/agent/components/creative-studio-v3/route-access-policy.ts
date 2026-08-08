import type { StudioBrandSummary } from '@/lib/creative-studio/studio-access'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import {
  resolveCreativeStudioV3Rollout,
  type CreativeStudioV3RolloutEnvironment,
} from '@/agent/components/creative-studio-v3/rollout-policy'

export type CreativeStudioV3RouteDecision =
  | {
      kind: 'v3'
      brand: StudioBrandSummary
      projectId: string | null
    }
  | { kind: 'legacy' }
  | {
      kind: 'denied'
      reason:
        | 'legacy_owner_only'
        | 'no_accessible_brand'
        | 'brand_access_forbidden'
        | 'project_access_forbidden'
        | 'rollout_not_admitted'
    }

export function selectCreativeStudioV3InitialProjectId(input: {
  accessibleProjects: StudioProjectSummary[]
  brandProfileId: string
  requestedProjectId: string | null
}): string | null {
  const scoped = input.accessibleProjects.filter((project) =>
    project.brandProfileId === input.brandProfileId)
  if (input.requestedProjectId) {
    return scoped.find((project) => project.id === input.requestedProjectId)?.id
      ?? null
  }
  return scoped.find((project) => !project.readonly)?.id
    ?? scoped[0]?.id
    ?? null
}

/**
 * Pure route admission boundary. `accessibleBrands` and `accessibleProjects`
 * must be produced server-side; query values can select from those rows but
 * can never add authority.
 */
export function resolveCreativeStudioV3RouteDecision(input: {
  actorIsSystemOwner: boolean
  accessibleBrands: StudioBrandSummary[]
  accessibleProjects: StudioProjectSummary[]
  requestedBrandId: string | null
  requestedProjectId: string | null
  forceLegacy: boolean
  environment: CreativeStudioV3RolloutEnvironment
}): CreativeStudioV3RouteDecision {
  if (input.forceLegacy) {
    return input.actorIsSystemOwner
      ? { kind: 'legacy' }
      : { kind: 'denied', reason: 'legacy_owner_only' }
  }

  if (input.accessibleBrands.length === 0) {
    return input.actorIsSystemOwner
      ? { kind: 'legacy' }
      : { kind: 'denied', reason: 'no_accessible_brand' }
  }

  const brandById = new Map(
    input.accessibleBrands.map((brand) => [brand.brandProfileId, brand]),
  )
  const requestedBrand = input.requestedBrandId
    ? brandById.get(input.requestedBrandId) ?? null
    : null
  if (input.requestedBrandId && !requestedBrand) {
    return { kind: 'denied', reason: 'brand_access_forbidden' }
  }

  let requestedProject: StudioProjectSummary | null = null
  if (input.requestedProjectId) {
    requestedProject = input.accessibleProjects.find((project) =>
      project.id === input.requestedProjectId
      && Boolean(project.brandProfileId)
      && brandById.has(project.brandProfileId as string)) ?? null
    if (
      !requestedProject
      || (requestedBrand && requestedProject.brandProfileId !== requestedBrand.brandProfileId)
    ) {
      return { kind: 'denied', reason: 'project_access_forbidden' }
    }
  }

  const projectBrand = requestedProject?.brandProfileId
    ? brandById.get(requestedProject.brandProfileId) ?? null
    : null
  const candidates = projectBrand
    ? [projectBrand]
    : requestedBrand
      ? [requestedBrand]
      : input.accessibleBrands

  const admitted = candidates
    .map((brand) => ({
      brand,
      projectId: selectCreativeStudioV3InitialProjectId({
        accessibleProjects: input.accessibleProjects,
        brandProfileId: brand.brandProfileId,
        requestedProjectId: requestedProject?.id ?? null,
      }),
    }))
    .find((candidate) =>
      resolveCreativeStudioV3Rollout(input.environment, {
        ownerId: candidate.brand.ownerId,
        brandId: candidate.brand.brandProfileId,
        projectId: candidate.projectId,
      }))

  if (admitted) {
    return {
      kind: 'v3',
      brand: admitted.brand,
      projectId: admitted.projectId,
    }
  }

  return input.actorIsSystemOwner
    ? { kind: 'legacy' }
    : { kind: 'denied', reason: 'rollout_not_admitted' }
}
