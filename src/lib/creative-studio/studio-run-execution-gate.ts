import { prisma } from '@/lib/prisma'
import {
  assertStudioSpendAllowed,
  requireStudioBrandAccess,
  StudioAccessError,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  assertStudioRunJobPayload,
  fingerprintStudioRunValue,
  StudioRunAuthorizationError,
  verifyStudioRunEstimateReceipt,
  type StudioRunEstimateReceiptClaims,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  assertStudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'
import {
  CS_ENGINE_KILL_PREFIX,
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  CS_XAI_ENABLED_KEY,
} from '@/lib/creative-studio/provider-registry'
import { readKv } from '@/lib/creative-studio/taste'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const FAMILY_VARIANT_ROLES: Record<string, string[]> = {
  father_son: ['father', 'son'],
  mother_son: ['mother', 'son'],
  mother_daughter: ['mother', 'daughter'],
  father_daughter: ['father', 'daughter'],
  couple: ['father', 'mother'],
  full_family: ['father', 'mother', 'son', 'daughter'],
}

/**
 * Verify every family identity reference against the immutable receipt pins.
 * The signed payload may use a canonical avatar path, the original saved-model
 * path, or the signed identity sheet, but never a fresh role lookup.
 */
export function assertStudioRunFamilyPayloadReferences(
  claims: StudioRunEstimateReceiptClaims,
  payload: Record<string, unknown>,
): void {
  const pins = claims.scope.familyModelPins ?? []
  const pinByRole = new Map<string, (typeof pins)[number]>(
    pins.map((pin) => [pin.role, pin]),
  )
  const pinById = new Map<string, (typeof pins)[number]>(
    pins.map((pin) => [pin.modelId, pin]),
  )
  const allowedPaths = (pin: (typeof pins)[number]) => new Set([
    pin.modelImagePath,
    pin.sourceImagePath,
    ...(pin.avatarSheetPath ? [pin.avatarSheetPath] : []),
  ])
  const familyChain = asRecord(payload.familyChain)
  const variant = String(
    familyChain.variant
    ?? payload.familyPreset
    ?? payload.tryOnVariant
    ?? '',
  )
  const requiredRoles = FAMILY_VARIANT_ROLES[variant] ?? []
  const explicitFamilyMerge = payload.familyMerge === true
    && variant === 'full_family'
  if (
    requiredRoles.length
    && !explicitFamilyMerge
    && requiredRoles.some((role) => !pinByRole.has(role))
  ) {
    throw new StudioRunAuthorizationError('run_family_model_pin_missing', 409)
  }

  if (Object.keys(familyChain).length && variant !== 'single') {
    for (const [roleField, pathField] of [
      ['adultRole', 'adultModelPath'],
      ['childRole', 'childModelPath'],
    ] as const) {
      const role = String(familyChain[roleField] ?? '')
      const path = String(familyChain[pathField] ?? '')
      if (!role || !path) continue
      const pin = pinByRole.get(role)
      if (!pin || !allowedPaths(pin).has(path)) {
        throw new StudioRunAuthorizationError(
          'run_family_model_reference_tampered',
          409,
        )
      }
    }
  }

  if (requiredRoles.length && !explicitFamilyMerge) {
    const referenceContract = asRecord(payload.referenceContract)
    const bindings = Array.isArray(referenceContract.bindings)
      ? referenceContract.bindings
      : []
    for (const rawBinding of bindings) {
      const binding = asRecord(rawBinding)
      if (binding.source !== 'saved_model') continue
      const sourceId = String(binding.sourceId ?? '')
      const path = String(binding.path ?? '')
      const pin = pinById.get(sourceId)
      if (!pin || !allowedPaths(pin).has(path)) {
        throw new StudioRunAuthorizationError(
          'run_family_model_reference_tampered',
          409,
        )
      }
    }
  }

  if (requiredRoles.length && !explicitFamilyMerge) {
    const modelPath = String(payload.modelImagePath ?? '')
    if (
      modelPath
      && !requiredRoles.some((role) => {
        const pin = pinByRole.get(role)
        return pin ? allowedPaths(pin).has(modelPath) : false
      })
    ) {
      throw new StudioRunAuthorizationError(
        'run_family_model_reference_tampered',
        409,
      )
    }
  }
}

async function assertCurrentProviderAvailability(
  payload: Record<string, unknown>,
  providers: string[],
  models: string[],
): Promise<void> {
  const provider = String(payload.provider ?? '')
  const engine = String(payload.falEngine ?? payload.xaiEngine ?? provider)
  const killedEngine = engine === 'generic_image' ? 'gemini' : engine
  if (
    killedEngine
    && (await readKv(`${CS_ENGINE_KILL_PREFIX}${killedEngine}`)) === '1'
  ) {
    throw new StudioRunAuthorizationError(`run_engine_killed:${killedEngine}`, 409)
  }
  if ((provider === 'fashn' || providers.includes('fashn')) && !process.env.FASHN_API_KEY?.trim()) {
    throw new StudioRunAuthorizationError('run_provider_unavailable:fashn', 409)
  }
  if ((provider === 'xai' || providers.includes('xai')) && (
    !process.env.XAI_API_KEY?.trim()
    || (await readKv(CS_XAI_ENABLED_KEY)) !== '1'
  )) {
    throw new StudioRunAuthorizationError('run_provider_unavailable:xai', 409)
  }
  if ((provider === 'fal' || providers.includes('fal')) && !process.env.FAL_KEY?.trim()) {
    throw new StudioRunAuthorizationError('run_provider_unavailable:fal', 409)
  }
  if (providers.includes('openai') && !process.env.OPENAI_API_KEY?.trim()) {
    throw new StudioRunAuthorizationError('run_provider_unavailable:openai', 409)
  }
  if (engine === 'fal_fashn_v16' && (await readKv(CS_FAL_ENABLED_KEY)) !== '1') {
    throw new StudioRunAuthorizationError('run_engine_disabled:fal_fashn_v16', 409)
  }
  if (engine === 'fal_idm_vton' && (await readKv(CS_IDM_VTON_ENABLED_KEY)) !== '1') {
    throw new StudioRunAuthorizationError('run_engine_disabled:fal_idm_vton', 409)
  }
  if (engine === 'fal_flux_fill' && (await readKv(CS_FLUX_FILL_ENABLED_KEY)) !== '1') {
    throw new StudioRunAuthorizationError('run_engine_disabled:fal_flux_fill', 409)
  }
  if (
    (provider === 'generic_image'
      || provider === 'gemini'
      || providers.includes('gemini')
      || providers.includes('google'))
    && !process.env.GEMINI_API_KEY?.trim()
    && !providers.includes('openai')
    && !providers.includes('fal')
  ) {
    throw new StudioRunAuthorizationError('run_provider_unavailable:google', 409)
  }
  const pinnedModel = String(
    payload.imageModel
    ?? payload.xaiModel
    ?? payload.falEndpointId
    ?? payload.fashnModel
    ?? (payload.studioMode === 'image_to_video' ? 'veo-3.1-generate-preview' : ''),
  )
  if (
    pinnedModel
    && !['garment_prep', 'family_composite', 'ffmpeg'].includes(provider)
    && !models.includes(pinnedModel)
  ) {
    throw new StudioRunAuthorizationError('run_model_selection_tampered', 409)
  }
}

export async function assertStudioRunExecutionGate(input: {
  receipt: unknown
  payload: unknown
  expectedClaims?: StudioRunEstimateReceiptClaims
  checkProviderAvailability?: boolean
}): Promise<StudioRunEstimateReceiptClaims> {
  const payload = asRecord(input.payload)
  const authorization = asRecord(payload.studioRunAuthorization)
  const claims = verifyStudioRunEstimateReceipt(input.receipt, { phase: 'execute' })
  if (
    input.expectedClaims
    && fingerprintStudioRunValue(input.expectedClaims) !== fingerprintStudioRunValue(claims)
  ) {
    throw new StudioRunAuthorizationError('run_job_authorization_tampered', 409)
  }
  if (
    authorization.receiptId !== claims.receiptId
    || authorization.requestFingerprint !== claims.requestFingerprint
    || authorization.selectionFingerprint !== claims.selectionFingerprint
    || Number(authorization.estimateBdt) !== claims.estimateBdt
    || Number(authorization.maxCostBdt) !== claims.maxCostBdt
  ) {
    throw new StudioRunAuthorizationError('run_job_authorization_tampered', 409)
  }
  const { studioRunAuthorization: _authorization, ...boundedPayload } = payload
  assertStudioRunJobPayload({
    receiptId: claims.receiptId,
    payload: boundedPayload,
    jobFingerprint: authorization.jobFingerprint,
    providedSignature: authorization.jobSignature,
  })
  if (
    fingerprintStudioRunValue(payload.studioRunScope)
    !== fingerprintStudioRunValue(claims.scope)
  ) {
    throw new StudioRunAuthorizationError('run_job_scope_tampered', 409)
  }
  if (claims.estimateBdt > claims.maxCostBdt) {
    throw new StudioRunAuthorizationError('run_cost_cap_exceeded', 409)
  }
  const attemptLimit = Number(payload.studioPaidAttemptLimit)
  if (
    !Number.isInteger(attemptLimit)
    || attemptLimit < 1
    || attemptLimit > 3
    || attemptLimit !== claims.selection.paidAttemptLimit
  ) {
    throw new StudioRunAuthorizationError('run_attempt_limit_tampered', 409)
  }

  const user = await db.user.findUnique({
    where: { id: claims.scope.actorUserId },
    select: { id: true, name: true, email: true, role: true },
  })
  if (!user) throw new StudioAccessError('studio_actor_not_found', 403)
  const actor: StudioActor = {
    userId: String(user.id),
    name: String(user.name ?? user.email ?? 'Studio user'),
    email: typeof user.email === 'string' ? user.email : null,
    erpRole: String(user.role),
  }
  const access = await requireStudioBrandAccess(actor, claims.scope.brandProfileId)
  if (access.ownerId !== claims.scope.ownerId || access.role !== claims.scope.role) {
    throw new StudioAccessError('studio_run_access_changed', 403)
  }
  const project = await db.creativeProject.findFirst({
    where: {
      id: claims.scope.projectId,
      ownerId: access.ownerId,
      brandProfileId: claims.scope.brandProfileId,
      archivedAt: null,
    },
    select: { id: true },
  })
  if (!project) throw new StudioAccessError('studio_run_project_access_changed', 403)
  for (const pin of claims.scope.familyModelPins ?? []) {
    await assertStudioResourceScope('model', pin.modelId, {
      ownerId: access.ownerId,
      brandProfileId: claims.scope.brandProfileId,
      projectId: claims.scope.projectId,
    })
    const model = await db.agentBrandModel.findUnique({
      where: { id: pin.modelId },
      select: { imagePath: true, role: true },
    })
    if (
      !model
      || String(model.imagePath) !== pin.modelImagePath
      || String(model.role ?? '') !== pin.role
    ) {
      throw new StudioAccessError('studio_run_family_model_changed', 409)
    }
  }
  assertStudioRunFamilyPayloadReferences(claims, payload)
  assertStudioSpendAllowed(
    access.role,
    claims.estimateBdt,
    access.approvalSpendThresholdBdt,
  )
  if (input.checkProviderAvailability !== false) {
    await assertCurrentProviderAvailability(
      payload,
      claims.selection.providers,
      claims.selection.models,
    )
  }
  return claims
}
