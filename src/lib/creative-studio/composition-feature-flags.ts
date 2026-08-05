export const CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV = 'CREATIVE_STUDIO_V3_FOUNDATION_MODE'
export const CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV =
  'CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENABLED'

export const CREATIVE_STUDIO_V3_FOUNDATION_MODES = [
  'off',
  'shadow',
  'enforce',
  'rollback',
] as const

export type CreativeStudioV3FoundationMode =
  (typeof CREATIVE_STUDIO_V3_FOUNDATION_MODES)[number]

export type CreativeStudioV3FoundationFlags = {
  mode: CreativeStudioV3FoundationMode
  readEnabled: boolean
  commandPlanningEnabled: boolean
  writesEnabled: boolean
  legacyDefault: true
  legacyFallback: true
  rollbackActive: boolean
}

export type CreativeStudioV4PreviewContext = {
  actorIsSystemOwner: boolean
  requestedStudio: string | null
}

function normalizeMode(value: unknown): CreativeStudioV3FoundationMode {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (
    normalized === 'shadow'
    || normalized === 'enforce'
    || normalized === 'rollback'
  ) return normalized
  return 'off'
}

function explicitTrue(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true'
}

/**
 * Phase 1 never changes Studio routing. The legacy Studio is always the default
 * and fallback; these flags only expose the additive composition APIs.
 */
export function getCreativeStudioV3FoundationFlags(
  env: Record<string, string | undefined> = process.env,
): CreativeStudioV3FoundationFlags {
  const mode = normalizeMode(env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV])
  const active = mode === 'shadow' || mode === 'enforce'
  return {
    mode,
    readEnabled: active,
    commandPlanningEnabled: active,
    writesEnabled: mode === 'enforce'
      && explicitTrue(env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]),
    legacyDefault: true,
    legacyFallback: true,
    rollbackActive: mode === 'rollback',
  }
}

/**
 * The owner-approved V4 implementation is exercised on an isolated Vercel
 * preview before any production rollout. This override makes that exact
 * owner-only preview testable end-to-end without changing the default-off
 * production flags.
 */
export function getCreativeStudioV4PreviewFoundationFlags(
  context: CreativeStudioV4PreviewContext,
  env: Record<string, string | undefined> = process.env,
): CreativeStudioV3FoundationFlags {
  const flags = getCreativeStudioV3FoundationFlags(env)
  if (
    env.VERCEL_ENV !== 'preview'
    || !context.actorIsSystemOwner
    || context.requestedStudio !== 'v4'
  ) return flags
  return {
    ...flags,
    mode: 'enforce',
    readEnabled: true,
    commandPlanningEnabled: true,
    writesEnabled: true,
    rollbackActive: false,
  }
}

export function creativeStudioV3FeatureResponse(
  capability: 'read' | 'plan' | 'write',
  env: Record<string, string | undefined> = process.env,
  previewContext?: CreativeStudioV4PreviewContext,
): Response | null {
  const flags = previewContext
    ? getCreativeStudioV4PreviewFoundationFlags(previewContext, env)
    : getCreativeStudioV3FoundationFlags(env)
  const enabled = capability === 'read'
    ? flags.readEnabled
    : capability === 'plan'
      ? flags.commandPlanningEnabled
      : flags.writesEnabled
  if (enabled) return null
  return Response.json({
    error: capability === 'write'
      ? 'creative_studio_v3_writes_disabled'
      : 'creative_studio_v3_foundation_disabled',
    mode: flags.mode,
    legacyDefault: flags.legacyDefault,
    legacyFallback: flags.legacyFallback,
  }, { status: capability === 'write' ? 409 : 404 })
}
