export type CreativeStudioV3RolloutEnvironment = {
  CREATIVE_STUDIO_V3_UI_ENABLED?: string
  CREATIVE_STUDIO_V3_OWNER_IDS?: string
  CREATIVE_STUDIO_V3_BRAND_IDS?: string
  CREATIVE_STUDIO_V3_PROJECT_IDS?: string
}
export type CreativeStudioV3RolloutScope = {
  ownerId: string | null
  brandId: string | null
  projectId: string | null
  forceLegacy?: boolean
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function matches(allowlist: Set<string>, value: string | null): boolean {
  if (allowlist.has('*')) return true
  return Boolean(value && allowlist.has(value))
}

/**
 * Default-off, server-evaluated rollout policy. A master switch and at least
 * one matching owner/brand/project scope are both required. The query string
 * can only nominate a scope; it cannot enable a scope absent from server env.
 */
export function resolveCreativeStudioV3Rollout(
  environment: CreativeStudioV3RolloutEnvironment,
  scope: CreativeStudioV3RolloutScope,
): boolean {
  if (scope.forceLegacy) return false
  if (environment.CREATIVE_STUDIO_V3_UI_ENABLED !== '1') return false

  return matches(csvSet(environment.CREATIVE_STUDIO_V3_OWNER_IDS), scope.ownerId)
    || matches(csvSet(environment.CREATIVE_STUDIO_V3_BRAND_IDS), scope.brandId)
    || matches(csvSet(environment.CREATIVE_STUDIO_V3_PROJECT_IDS), scope.projectId)
}
