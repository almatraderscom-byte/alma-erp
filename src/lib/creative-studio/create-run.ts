import { prisma } from '@/lib/prisma'
import { isFashnConfigured } from '@/lib/fashn/client'
import { buildVideoBrief, estimateReelCostUsd } from '@/lib/content-engine/video-brief'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import { STUDIO_MODES } from '@/lib/creative-studio/constants'
import { queueTryOnBatch, type ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import { resolveModel } from '@/lib/tryon/model-library'
import {
  startFamilyChain,
  startSingleRescueChain,
  FamilyChainModelError,
  type FamilyChainVariant,
} from '@/lib/tryon/family-chain'
import {
  getOrClassifyGarment,
  mapGarmentToVtonClothType,
  mapGarmentToFashnCategory,
} from '@/lib/tryon/art-director'
import {
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  CS_XAI_ENABLED_KEY,
  getEngine,
  isFalVtonEngine,
  isVtonClothType,
  type StudioEngineId,
  type VtonClothType,
} from '@/lib/creative-studio/provider-registry'
import {
  XAI_FAMILY_PAIR_ROLES,
  XAI_IMAGE_MODEL_QUALITY,
  buildXaiFamilyPairBrief,
  buildXaiRunBrief,
  estimateXaiImageCostUsd,
  toXaiAspectRatio,
  toXaiResolution,
  type XaiRunBrief,
} from '@/lib/creative-studio/xai-imagine'
import { buildFillPrompt, estimateFluxFillCostUsd, type MaskPresetId } from '@/lib/creative-studio/mask-contract'
import {
  buildRunPlan,
  checkSingleInputReadiness,
  readPipelineMode,
  readRecentSceneIds,
  recordSceneUse,
} from '@/lib/creative-studio/single-pipeline'
import { pickSceneDiverse, toSceneRef } from '@/lib/tryon/scene-pool'
import { readKv, readSceneWeights } from '@/lib/creative-studio/taste'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import {
  assertAdvancedEngineMode,
  buildDirectFashnInputs,
  estimateDirectFashnCostUsd,
  genericImageProvider,
  makeReferenceContract,
  normalizeGenericImageModels,
  type GenericImageModel,
  type StudioReferenceBinding,
  type StudioReferenceContract,
  type StudioReferenceRole,
  validateAdvancedControlValues,
} from '@/lib/creative-studio/advanced-image-capabilities'
import {
  assertResolutionRequest,
  type StudioImageEngine,
} from '@/lib/creative-studio/resolution-contract'
import {
  currentStudioRunExecutionContext,
  recoveredStudioRunJobId,
  requireStudioRunExecutionContext,
  studioRunAuthorizedJobFields,
} from '@/lib/creative-studio/studio-run-context'
import { assertStudioRunExecutionGate } from '@/lib/creative-studio/studio-run-execution-gate'
import type {
  StudioRunFamilyModelPin,
  StudioRunFamilyRole,
} from '@/lib/creative-studio/studio-run-authorization'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type GenericImageQuality = 'standard' | 'pro'
type GenericResolutionEngine = Extract<StudioImageEngine, 'gemini' | 'gpt' | 'seedream'>

export function genericResolutionEngineForModel(model: GenericImageModel): GenericResolutionEngine {
  const provider = genericImageProvider(model)
  if (provider === 'openai') return 'gpt'
  if (provider === 'fal') return 'seedream'
  return 'gemini'
}

async function configuredGenericImageSelection(
  quality: GenericImageQuality = 'pro',
  pinnedModel?: GenericImageModel,
): Promise<{ model: GenericImageModel; engine: GenericResolutionEngine; quality: GenericImageQuality }> {
  const models = normalizeGenericImageModels(await readKv('cs_image_models'))
  const model = pinnedModel ?? models[quality]
  if (pinnedModel && !Object.values(models).includes(pinnedModel)) {
    throw new Error('pinned_model_unavailable')
  }
  return {
    model,
    engine: genericResolutionEngineForModel(model),
    quality,
  }
}

function genericQualityForRun(input: CreativeStudioRunInput): GenericImageQuality {
  return input.generationMode === 'fast' ? 'standard' : 'pro'
}

function assertTieredResolution(
  engine: StudioImageEngine,
  input: CreativeStudioRunInput,
  defaults: { aspectRatio?: string; resolution?: FashnResolution } = {},
): { aspectRatio: string; resolution: FashnResolution } {
  const aspectRatio = input.aspectRatio ?? defaults.aspectRatio ?? '4:5'
  const resolution = input.resolution ?? defaults.resolution ?? '2k'
  assertResolutionRequest({ engine, aspectRatio, resolution })
  return { aspectRatio, resolution }
}

export type CreativeStudioRunInput = {
  mode: StudioModeId
  provider?: StudioProvider
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
  secondSourceImagePath?: string
  faceReferencePath?: string
  modelId?: string
  familyPreset?: FamilyPresetId
  prompt?: string
  backgroundPrompt?: string
  aspectRatio?: string
  resolution?: FashnResolution
  generationMode?: FashnGenerationMode
  numImages?: number
  /** CS6 — single Try-On engine choice (fal_fashn_v16 / fal_idm_vton route to Fal; fashn/gemini keep legacy paths) */
  vtonEngine?: StudioEngineId
  /** CS6 — owner override for cat-vton garment placement when auto classification is uncertain */
  clothType?: VtonClothType | 'auto'
  /** CS6 — optional fixed seed for reproducible benchmark runs */
  seed?: number
  /** CS9 — family protected compositing (no face/garment regen in the merge) */
  protectedComposite?: boolean
  /** CS14 — avatar identity sheet (extra xAI reference when a slot is free) */
  avatarSheetPath?: string
  /** CS7 — FLUX Fill precision edit: mask object path (white=edit, black=keep) */
  maskPath?: string
  /** CS7 — mask preset id (replace_background / remove_object / …) */
  maskPreset?: MaskPresetId
  /** CS7 — base image dimensions from mask-upload (for the cost estimate) */
  baseWidth?: number
  baseHeight?: number
  /** Video only */
  durationSec?: number
  vibe?: 'premium' | 'festival' | 'offer' | 'lifestyle'
  /** Server-only values copied from the signed, revalidated estimate. */
  pinnedGenericImageModel?: GenericImageModel
  pinnedChainVtonEngine?: 'fashn' | 'fal_fashn_v16'
  /** Server-derived only; callers cannot supply implicit family identities. */
  familyModelPins?: StudioRunFamilyModelPin[]
}

export type CreativeStudioJobRef = {
  pendingActionId: string
  label: string
  type: 'image_gen' | 'video_gen'
}

function resolveProvider(
  requested: StudioProvider | undefined,
  mode: StudioModeId,
  _familyPreset?: FamilyPresetId,
  requestedEngine?: StudioEngineId,
): StudioProvider {
  if (mode === 'image_to_video') {
    if (requested && requested !== 'gemini') {
      throw new Error(`explicit_engine_mode_unsupported:${requested}:image_to_video`)
    }
    return 'gemini'
  }
  // The legacy provider field is only a routing compatibility value when an
  // exact Advanced engine is present. Do not require FASHN merely because Fal
  // or xAI is represented by the historical `provider: "fashn"` envelope.
  if (
    requestedEngine
    && requestedEngine !== 'fashn'
    && requestedEngine !== 'gemini'
  ) {
    return requested ?? 'fashn'
  }
  if (requested === 'gemini') return 'gemini'
  if (requested === 'fashn') {
    if (!isFashnConfigured()) throw new Error('explicit_engine_unavailable:fashn')
    return 'fashn'
  }
  throw new Error('explicit_engine_required')
}

function familyPrompt(preset: FamilyPresetId): string {
  const map: Record<FamilyPresetId, string> = {
    single: '',
    father_son: 'Bangladeshi father and son (age 5-12) wearing matching outfits from product, one cohesive family photoshoot.',
    mother_son: 'Bangladeshi mother and son (age 5-12) wearing matching outfits, family fashion shoot.',
    mother_daughter: 'Bangladeshi mother and daughter (age 5-10) wearing matching outfits, family fashion shoot.',
    father_daughter: 'Bangladeshi father and daughter (age 5-10) wearing matching outfits, family fashion shoot.',
    couple: 'Bangladeshi husband and wife wearing matching couple outfits, modest natural couple pose, fashion shoot.',
    full_family: 'Full Bangladeshi family father mother son daughter in matching coordinated outfits, one scene.',
  }
  return map[preset] ?? ''
}

async function mergeGenericApprovedPayload(input: {
  pendingActionId: string
  run: CreativeStudioRunInput
  imageModel: GenericImageModel
  quality: GenericImageQuality
  aspectRatio: string
  resolution: FashnResolution
  familyPreset?: FamilyPresetId
  extraPayload?: Record<string, unknown>
  dedupePart: string
}): Promise<void> {
  const existing = await db.agentPendingAction.findUnique({
    where: { id: input.pendingActionId },
    select: {
      id: true,
      status: true,
      dedupeKey: true,
      payload: true,
    },
  })
  const previousPayload = (existing?.payload ?? {}) as Record<string, unknown>
  // Crash recovery may revisit a row already signed in the first constructor
  // pass. Never nest its prior authorization inside the newly signed payload.
  const { studioRunAuthorization: _priorAuthorization, ...prev } =
    previousPayload
  const personPath = typeof prev.referenceImageId === 'string' ? prev.referenceImageId : null
  const productPath = typeof prev.secondReferenceImageId === 'string' ? prev.secondReferenceImageId : null
  const bindings: StudioReferenceBinding[] = []
  if (personPath) bindings.push(referenceBinding('person', personPath, input.run, true))
  if (productPath) bindings.push(referenceBinding('product', productPath, input.run, true))
  const referenceContract = makeReferenceContract({
    mode: input.run.mode,
    requestedEngine: 'gemini',
    actualModel: input.imageModel,
    bindings,
  })
  const authorized = studioRunAuthorizedJobFields({
    ...prev,
    studioMode: input.run.mode,
    provider: 'generic_image',
    imageModel: input.imageModel,
    quality: input.quality,
    imageSize: input.resolution.toUpperCase(),
    aspectRatio: input.aspectRatio,
    requestedResolution: input.resolution,
    requestedAspectRatio: input.aspectRatio,
    ...input.extraPayload,
    familyPreset: input.familyPreset,
    referenceContract,
    controlContract: controlContract(input.run, {
      model: input.imageModel,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      generationMode: input.quality,
      numImagesPerAction: 1,
    }, ['generic_generation_mode_mapped_to_quality_tier']),
    creativeStudio: true,
    skipTelegramCard: true,
  }, { dedupePart: input.dedupePart })
  if (existing?.dedupeKey !== authorized.dedupeKey) {
    throw new Error('studio_run_initial_dedupe_mismatch')
  }
  const execution = requireStudioRunExecutionContext()
  if (recoveredStudioRunJobId({
    existing,
    dedupeKey: authorized.dedupeKey,
    payload: authorized.payload,
  })) {
    return
  }
  await assertStudioRunExecutionGate({
    receipt: execution.receipt,
    payload: authorized.payload,
    expectedClaims: execution.claims,
  })
  await db.agentPendingAction.update({
    where: { id: input.pendingActionId },
    data: {
      status: 'approved',
      dedupeKey: authorized.dedupeKey,
      payload: authorized.payload,
    },
  })
}

async function createApprovedAction(data: {
  type: 'image_gen' | 'video_gen'
  payload: Record<string, unknown>
  summary: string
  costEstimate: number
}): Promise<string> {
  const execution = requireStudioRunExecutionContext()
  const authorized = studioRunAuthorizedJobFields({
    ...data.payload,
    creativeStudio: true,
    skipTelegramCard: true,
  })
  const existing = await db.agentPendingAction.findUnique({
    where: { dedupeKey: authorized.dedupeKey },
    select: {
      id: true,
      status: true,
      dedupeKey: true,
      payload: true,
    },
  })
  const recoveredId = recoveredStudioRunJobId({
    existing,
    dedupeKey: authorized.dedupeKey,
    payload: authorized.payload,
  })
  if (recoveredId) return recoveredId
  await assertStudioRunExecutionGate({
    receipt: execution.receipt,
    payload: authorized.payload,
    expectedClaims: execution.claims,
  })
  const row = await db.agentPendingAction.upsert({
    where: { dedupeKey: authorized.dedupeKey },
    create: {
      conversationId: null,
      dedupeKey: authorized.dedupeKey,
      type: data.type,
      payload: authorized.payload,
      summary: data.summary,
      costEstimate: data.costEstimate,
      status: 'approved',
    },
    update: {},
  })
  return row.id as string
}

function referenceBinding(
  role: StudioReferenceRole,
  path: string,
  input: CreativeStudioRunInput,
  required: boolean,
): StudioReferenceBinding {
  const execution = currentStudioRunExecutionContext()
  const familyPin = execution?.claims.scope.familyModelPins?.find((pin) =>
    pin.sourceImagePath === path
    || pin.modelImagePath === path
    || pin.avatarSheetPath === path)
  const savedPerson = role === 'person' && (
    (Boolean(input.modelId) && path === input.modelImagePath)
    || Boolean(familyPin)
  )
  return {
    role,
    path,
    source: role === 'identity_sheet' ? 'derived' : savedPerson ? 'saved_model' : 'uploaded',
    ...(savedPerson
      ? { sourceId: input.modelId ?? familyPin?.modelId }
      : {}),
    required,
  }
}

function signedFamilyModelPin(role: StudioRunFamilyRole): StudioRunFamilyModelPin | null {
  return requireStudioRunExecutionContext().claims.scope.familyModelPins
    ?.find((pin) => pin.role === role) ?? null
}

function xaiReferenceContract(input: CreativeStudioRunInput, brief: XaiRunBrief) {
  return makeReferenceContract({
    mode: input.mode,
    requestedEngine: 'xai_imagine',
    actualModel: XAI_IMAGE_MODEL_QUALITY,
    bindings: brief.referenceImagePaths.map((path, index) => {
      const xaiRole = brief.referenceRoles[index]
      const role: StudioReferenceRole =
        path === input.avatarSheetPath
          ? 'identity_sheet'
          : xaiRole === 'garment'
            ? 'product'
            : xaiRole === 'person'
              ? 'person'
              : 'source'
      return referenceBinding(role, path, input, role !== 'identity_sheet')
    }),
  })
}

function orderedSourceReferenceContract(input: {
  run: CreativeStudioRunInput
  mode: StudioModeId
  requestedEngine: StudioEngineId
  actualModel: string
  paths: string[]
}): StudioReferenceContract {
  return {
    version: 1,
    mode: input.mode,
    requestedEngine: input.requestedEngine,
    actualModel: input.actualModel,
    bindings: input.paths.map((path) => referenceBinding('source', path, input.run, true)),
  }
}

function directFashnReferenceContract(input: CreativeStudioRunInput, actualModel: string) {
  const person = input.faceReferencePath ?? input.modelImagePath
  const bindings: StudioReferenceBinding[] = []
  if (input.mode === 'product_to_model' || input.mode === 'try_on') {
    if (input.productImagePath) bindings.push(referenceBinding('product', input.productImagePath, input, true))
  }
  if (input.mode === 'try_on' && input.modelImagePath) {
    bindings.unshift(referenceBinding('person', input.modelImagePath, input, true))
  } else if (input.mode === 'product_to_model' && person) {
    bindings.push(referenceBinding('person', person, input, true))
  } else if (input.mode === 'model_swap') {
    if (input.sourceImagePath) bindings.push(referenceBinding('source', input.sourceImagePath, input, true))
    if (person) bindings.push(referenceBinding('person', person, input, true))
  } else if (input.mode === 'face_to_model' && person) {
    bindings.push(referenceBinding('person', person, input, true))
  } else if (input.mode === 'edit') {
    if (input.sourceImagePath) bindings.push(referenceBinding('source', input.sourceImagePath, input, true))
    if (input.productImagePath) bindings.push(referenceBinding('product', input.productImagePath, input, false))
  }
  return makeReferenceContract({
    mode: input.mode,
    requestedEngine: 'fashn',
    actualModel,
    bindings,
  })
}

function controlContract(
  input: CreativeStudioRunInput,
  applied: Record<string, unknown>,
  notes: string[] = [],
) {
  return {
    version: 1,
    requested: {
      prompt: input.prompt?.trim() || null,
      backgroundPrompt: input.backgroundPrompt?.trim() || null,
      aspectRatio: input.aspectRatio ?? null,
      resolution: input.resolution ?? null,
      generationMode: input.generationMode ?? null,
      numImages: input.numImages ?? 1,
      clothType: input.clothType ?? null,
      seed: Number.isFinite(input.seed) ? Math.trunc(input.seed as number) : null,
    },
    applied,
    notes,
  }
}


/**
 * Owner directive 2026-07-17: family/rescue chains follow the owner's single
 * Try-On default. A Fal default (v1.6 or IDM) routes chain VTON steps to the
 * COMMERCIAL Fal FASHN v1.6 (IDM never runs in family). With no usable direct
 * FASHN key, fal is used whenever it is enabled.
 */
async function resolveChainVtonEngine(): Promise<'fashn' | 'fal_fashn_v16'> {
  const falOk = Boolean(process.env.FAL_KEY?.trim()) && (await readKv(CS_FAL_ENABLED_KEY)) === '1'
  if (!falOk) return 'fashn'
  const { CS_SINGLE_VTON_DEFAULT_KEY } = await import('@/lib/creative-studio/provider-registry')
  const { normalizeSingleVtonDefault } = await import('@/lib/creative-studio/provider-registry')
  const def = normalizeSingleVtonDefault(await readKv(CS_SINGLE_VTON_DEFAULT_KEY))
  if (def === 'fal_fashn_v16' || def === 'fal_idm_vton') return 'fal_fashn_v16'
  if (!isFashnConfigured()) return 'fal_fashn_v16'
  return 'fashn'
}

export async function runCreativeStudio(input: CreativeStudioRunInput): Promise<{
  jobs: CreativeStudioJobRef[]
  /** engine that will actually run — legacy 'fashn'/'gemini' or a CS6 fal VTON engine id */
  provider: StudioProvider | StudioEngineId
  /** Exact queued model when a legacy provider id fronts an owner-switchable adapter. */
  actualModel?: string
  fashnReady: boolean
}> {
  const modeDef = STUDIO_MODES.find((m) => m.id === input.mode)
  if (!modeDef) throw new Error('invalid_mode')
  validateAdvancedControlValues(input)
  const multiPersonFamily = Boolean(
    input.familyPreset
    && input.familyPreset !== 'single'
    && (input.mode === 'try_on' || input.mode === 'product_to_model'),
  )
  if (
    multiPersonFamily
    && input.vtonEngine
    && getEngine(input.vtonEngine).singlePersonOnly
  ) {
    throw new Error(`explicit_engine_mode_unsupported:${input.vtonEngine}:family`)
  }
  if (input.vtonEngine && !multiPersonFamily) {
    assertAdvancedEngineMode(input.vtonEngine, input.mode)
    validateAdvancedControlValues({ ...input, engine: input.vtonEngine })
  }

  const provider = resolveProvider(
    input.provider,
    input.mode,
    input.familyPreset,
    input.vtonEngine,
  )
  const fashnReady = isFashnConfigured()
  const jobs: CreativeStudioJobRef[] = []

  // FAMILY MERGE: combine two already-generated images (e.g. father+son and mother+daughter)
  // into ONE four-person family photoshoot. Worker composites both reference images via Gemini.
  // CS13.3 — the owner's engine pick WINS: Grok selected ⇒ the merge runs as a
  // 2-reference xAI edit (owner hit a silent Gemini override here live 2026-07-24).
  if (input.familyPreset === 'full_family' && input.sourceImagePath && input.secondSourceImagePath) {
    if (input.vtonEngine === 'xai_imagine') {
      if (!process.env.XAI_API_KEY?.trim()) throw new Error('xai_not_configured')
      if ((await readKv(CS_XAI_ENABLED_KEY)) !== '1') throw new Error('xai_engine_disabled')
      const truthful = assertTieredResolution('xai_imagine', input, { aspectRatio: '3:4' })
      const { buildXaiFamilyMergeBrief } = await import('@/lib/creative-studio/xai-imagine')
      const brief = buildXaiFamilyMergeBrief({
        sourceImagePath: input.sourceImagePath,
        secondSourceImagePath: input.secondSourceImagePath,
        prompt: input.prompt,
        backgroundPrompt: input.backgroundPrompt,
      })
      const xaiResolution = toXaiResolution(truthful.resolution)
      const referenceContract = orderedSourceReferenceContract({
        run: input,
        mode: 'edit',
        requestedEngine: 'xai_imagine',
        actualModel: XAI_IMAGE_MODEL_QUALITY,
        paths: brief.referenceImagePaths,
      })
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'xai',
          xaiEngine: 'xai_imagine',
          xaiModel: XAI_IMAGE_MODEL_QUALITY,
          xaiOp: brief.op,
          referenceImagePaths: brief.referenceImagePaths,
          referenceRoles: brief.referenceRoles,
          referenceContract,
          controlContract: controlContract(input, {
            model: XAI_IMAGE_MODEL_QUALITY,
            operation: brief.op,
            aspectRatio: toXaiAspectRatio(truthful.aspectRatio),
            resolution: xaiResolution,
            generationMode: null,
            numImagesPerAction: 1,
          }, input.generationMode ? ['xai_generation_mode_not_supported'] : []),
          prompt: brief.prompt,
          aspectRatio: toXaiAspectRatio(truthful.aspectRatio),
          resolution: xaiResolution,
          requestedResolution: truthful.resolution,
          requestedAspectRatio: truthful.aspectRatio,
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: 'full_family',
          familyMerge: true,
        },
        summary: '🎨 Studio Family Merge (Grok Imagine · xAI)',
        costEstimate: estimateXaiImageCostUsd(xaiResolution),
      })
      jobs.push({ pendingActionId: id, label: 'Family Merge · Grok Imagine (xAI)', type: 'image_gen' })
      return { jobs, provider: 'xai_imagine', actualModel: XAI_IMAGE_MODEL_QUALITY, fashnReady }
    }
    const mergePrompt = [
      'Combine the people from BOTH reference images into ONE cohesive Bangladeshi family photoshoot.',
      'Reference image 1 shows some family members; reference image 2 shows the others.',
      'Place ALL of them together in a single natural scene — full family (father, mother, son, daughter)',
      'standing/posed together as one group. Preserve each person\'s face, outfit and identity exactly',
      'as shown in their source image. One consistent lighting, background and photographic style.',
      input.prompt,
      input.backgroundPrompt,
    ].filter(Boolean).join(' ')

    const generic = await configuredGenericImageSelection(
      genericQualityForRun(input),
      input.pinnedGenericImageModel,
    )
    const truthful = assertTieredResolution(generic.engine, input)
    const referenceContract = orderedSourceReferenceContract({
      run: input,
      // The owner-facing mode is Product→Model/Try-On, but this job is an
      // edit of two already-rendered source images. Snapshot the operation the
      // worker actually performs so the role contract remains truthful.
      mode: 'edit',
      requestedEngine: 'gemini',
      actualModel: generic.model,
      paths: [input.sourceImagePath, input.secondSourceImagePath],
    })
    const id = await createApprovedAction({
      type: 'image_gen',
      payload: {
        provider: 'generic_image',
        imageModel: generic.model,
        prompt: mergePrompt,
        quality: generic.quality,
        referenceImageId: input.sourceImagePath,
        secondReferenceImageId: input.secondSourceImagePath,
        referenceContract,
        controlContract: controlContract(input, {
          model: generic.model,
          aspectRatio: truthful.aspectRatio,
          resolution: truthful.resolution,
          generationMode: generic.quality,
          numImagesPerAction: 1,
        }, ['generic_generation_mode_mapped_to_quality_tier']),
        aspectRatio: truthful.aspectRatio,
        imageSize: truthful.resolution.toUpperCase(),
        requestedResolution: truthful.resolution,
        requestedAspectRatio: truthful.aspectRatio,
        creativeStudio: true,
        studioMode: input.mode,
        familyPreset: 'full_family',
        familyMerge: true,
      },
      summary: '🎨 Studio Family Merge (Gemini)',
      costEstimate: 0.25,
    })
    jobs.push({ pendingActionId: id, label: 'Family Merge', type: 'image_gen' })
    return { jobs, provider: 'gemini', actualModel: generic.model, fashnReady: isFashnConfigured() }
  }

  // ── CS13: xAI Grok Imagine — one engine for every image mode ───────────────
  // `generate` is text-to-image (xAI is its only server); every other mode is
  // a natural-language edit with 1–3 ordered references. 2-person family
  // presets send BOTH saved role-model photos + the product as references
  // (identity match); full_family (4 জন) exceeds xAI's 3-reference cap and
  // falls through to the FASHN accuracy chain below. The masked-edit flow
  // (maskPath) stays on FLUX Fill — xAI edits are maskless by design.
  const xaiFamilyPair = input.familyPreset && XAI_FAMILY_PAIR_ROLES[input.familyPreset]
  if (
    (input.vtonEngine === 'xai_imagine' || input.mode === 'generate')
    && !input.maskPath
    && input.mode !== 'image_to_video'
    && !(input.familyPreset === 'full_family')
  ) {
    if (!process.env.XAI_API_KEY?.trim()) throw new Error('xai_not_configured')
    if ((await readKv(CS_XAI_ENABLED_KEY)) !== '1') throw new Error('xai_engine_disabled')

    let brief: XaiRunBrief
    let familyReferenceBindings: StudioReferenceBinding[] | undefined
    if (xaiFamilyPair && (input.mode === 'try_on' || input.mode === 'product_to_model')) {
      if (!input.productImagePath) throw new Error('product_image_required')
      const [roleA, roleB] = xaiFamilyPair
      const modelA = signedFamilyModelPin(roleA as StudioRunFamilyRole)
      const modelB = signedFamilyModelPin(roleB as StudioRunFamilyRole)
      if (!modelA || !modelB) {
        const missing = [
          ...(!modelA ? [roleA] : []),
          ...(!modelB ? [roleB] : []),
        ]
        throw new Error(`missing_models:${missing.join(',')}`)
      }
      familyReferenceBindings = [
        {
          role: 'person',
          path: modelA.sourceImagePath,
          source: 'saved_model',
          sourceId: modelA.modelId,
          required: true,
        },
        {
          role: 'person',
          path: modelB.sourceImagePath,
          source: 'saved_model',
          sourceId: modelB.modelId,
          required: true,
        },
        {
          role: 'product',
          path: input.productImagePath,
          source: 'uploaded',
          required: true,
        },
      ]
      brief = buildXaiFamilyPairBrief({
        preset: input.familyPreset as string,
        personPaths: [modelA.sourceImagePath, modelB.sourceImagePath],
        personLabels: [roleA, roleB],
        productImagePath: input.productImagePath,
        prompt: input.prompt,
        backgroundPrompt: input.backgroundPrompt,
      })
    } else {
      brief = buildXaiRunBrief({
        mode: input.mode,
        prompt: input.prompt,
        backgroundPrompt: input.backgroundPrompt,
        familyPrompt: input.familyPreset && input.familyPreset !== 'single' ? familyPrompt(input.familyPreset) : undefined,
        productImagePath: input.productImagePath,
        modelImagePath: input.modelImagePath,
        sourceImagePath: input.sourceImagePath,
        faceReferencePath: input.faceReferencePath,
        identitySheetPath: input.avatarSheetPath,
      })
      // CS13.3 — same free readiness gate as the FASHN/Fal single try-on:
      // stop unusable inputs BEFORE any paid xAI call.
      if (input.mode === 'try_on' && (!input.familyPreset || input.familyPreset === 'single')) {
        const person = input.modelImagePath ?? input.sourceImagePath
        if (person && input.productImagePath) {
          const readiness = await checkSingleInputReadiness({
            modelImagePath: person,
            productImagePath: input.productImagePath,
          })
          if (!readiness.ok) throw new Error(`input_not_ready:${readiness.errors.join(',')}`)
        }
      }
    }

    // Zero-prompt accuracy parity with the FASHN path: garment placement hint
    // (cached classifier) + per-image scene/pose variety from the same pool.
    let clothHint = ''
    if (input.productImagePath && (input.mode === 'try_on' || input.mode === 'product_to_model')) {
      try {
        const attrs = await getOrClassifyGarment(input.productImagePath)
        const auto = mapGarmentToVtonClothType(attrs)
        clothHint = ` Garment placement: ${auto.clothType} (${mapGarmentToFashnCategory(attrs)}).`
      } catch { /* hint only — classification failure must not block the run */ }
    }
    const injectScene = !xaiFamilyPair
      && (input.mode === 'product_to_model' || input.mode === 'try_on')
      && !input.backgroundPrompt?.trim()
    const [sceneWeights, recentScenes] = injectScene
      ? await Promise.all([readSceneWeights(), readRecentSceneIds()])
      : [{}, [] as string[]]

    const engine = getEngine('xai_imagine')
    const referenceContract = familyReferenceBindings
      ? makeReferenceContract({
          mode: input.mode,
          requestedEngine: 'xai_imagine',
          actualModel: XAI_IMAGE_MODEL_QUALITY,
          bindings: familyReferenceBindings,
        })
      : xaiReferenceContract(input, brief)
    const truthful = assertTieredResolution('xai_imagine', input, { aspectRatio: '3:4' })
    const xaiResolution = toXaiResolution(truthful.resolution)
    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)
    for (let i = 0; i < count; i++) {
      const picked = injectScene ? pickSceneDiverse(sceneWeights, recentScenes) : null
      if (picked) {
        recentScenes.unshift(picked.scene.id)
        await recordSceneUse(picked.scene.id)
      }
      const sceneLine = picked ? ` Pose: ${picked.adultPose}. ${picked.scene.prompt}` : ''
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'xai',
          xaiEngine: 'xai_imagine',
          xaiModel: XAI_IMAGE_MODEL_QUALITY,
          xaiOp: brief.op,
          referenceImagePaths: brief.referenceImagePaths,
          referenceRoles: brief.referenceRoles,
          referenceContract,
          controlContract: controlContract(input, {
            model: XAI_IMAGE_MODEL_QUALITY,
            operation: brief.op,
            aspectRatio: toXaiAspectRatio(truthful.aspectRatio),
            resolution: xaiResolution,
            generationMode: null,
            numImagesPerAction: 1,
          }, input.generationMode ? ['xai_generation_mode_not_supported'] : []),
          prompt: `${brief.prompt}${clothHint}${sceneLine}`,
          aspectRatio: toXaiAspectRatio(truthful.aspectRatio),
          resolution: xaiResolution,
          requestedResolution: truthful.resolution,
          requestedAspectRatio: truthful.aspectRatio,
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: input.familyPreset ?? 'single',
          productImagePath: input.productImagePath,
          modelImagePath: input.modelImagePath,
          ...(picked ? { sceneRef: toSceneRef(picked) } : {}),
        },
        summary: `🎨 Studio ${modeDef.label}${count > 1 ? ` #${i + 1}` : ''} (${engine.label})`,
        costEstimate: estimateXaiImageCostUsd(xaiResolution),
      })
      jobs.push({ pendingActionId: id, label: `${modeDef.label} · ${engine.label}`, type: 'image_gen' })
    }
    return { jobs, provider: 'xai_imagine', actualModel: XAI_IMAGE_MODEL_QUALITY, fashnReady }
  }

  // FAMILY ACCURACY CHAIN — the assembly line (adult FASHN shot → child garment →
  // child FASHN shot → Gemini merge). Replaces the one-shot Gemini invention whenever
  // FASHN is configured; each person's garment is rendered by the accurate engine and
  // the saved child models keep the same face on every run. Missing role models throw
  // FamilyChainModelError so the owner gets a clear "add the model" message instead of
  // a silent adult-for-child substitution.
  // Chains run when EITHER VTON path is usable (direct FASHN key, or the Fal
  // engine per the owner's 2026-07-17 directive).
  // UI engine picker override (owner 2026-07-18: engine choice visible on
  // every VTON mode); IDM never runs family — mapped to Fal upstream.
  const explicitGenericFamily = input.vtonEngine === 'gemini'
    || (!input.vtonEngine && input.provider === 'gemini')
  const chainVtonEngine = explicitGenericFamily
    ? null
    : input.vtonEngine === 'fashn' || input.vtonEngine === 'fal_fashn_v16'
      ? input.vtonEngine
      : input.pinnedChainVtonEngine ?? await resolveChainVtonEngine()
  const chainReady = chainVtonEngine !== null
    && (fashnReady || chainVtonEngine === 'fal_fashn_v16')
  if (
    chainReady
    && input.productImagePath
    && input.familyPreset
    && input.familyPreset !== 'single'
    && (input.mode === 'try_on' || input.mode === 'product_to_model')
  ) {
    let chainAspect = input.aspectRatio ?? '4:5'
    let chainResolution: string = input.resolution ?? '2k'
    let chainImageModel: GenericImageModel | undefined
    if (input.protectedComposite && chainVtonEngine === 'fal_fashn_v16') {
      assertResolutionRequest({
        engine: 'fal_fashn_v16',
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
      })
      chainAspect = 'source'
      chainResolution = 'native'
    } else if (input.protectedComposite) {
      const truthful = assertTieredResolution('fashn', input)
      chainAspect = truthful.aspectRatio
      chainResolution = truthful.resolution
    } else {
      const generic = await configuredGenericImageSelection('pro', input.pinnedGenericImageModel)
      const truthful = assertTieredResolution(generic.engine, input)
      chainAspect = truthful.aspectRatio
      chainResolution = truthful.resolution
      chainImageModel = generic.model
    }
    const chain = await startFamilyChain({
      variant: input.familyPreset as FamilyChainVariant,
      productImagePath: input.productImagePath,
      aspectRatio: chainAspect,
      resolution: chainResolution,
      generationMode: input.generationMode,
      extraPrompt: [input.prompt, input.backgroundPrompt].filter(Boolean).join('. ') || undefined,
      // CS9 — owner opt-in: deterministic protected composite instead of the
      // generative pair/group merge (no face/garment regeneration).
      protectedComposite: input.protectedComposite,
      vtonEngine: chainVtonEngine!,
      imageModel: chainImageModel,
      conversationId: null,
    })
    for (const j of chain.jobs) jobs.push(j)
    return { jobs, provider: 'fashn', fashnReady }
  }

  const extraPrompt = [input.prompt, input.backgroundPrompt, input.familyPreset ? familyPrompt(input.familyPreset) : '']
    .filter(Boolean)
    .join('. ')

  if (input.mode === 'image_to_video') {
    const imagePath = input.sourceImagePath ?? input.productImagePath ?? input.modelImagePath
    if (!imagePath) throw new Error('source_image_required')

    const vibe = input.vibe ?? 'premium'

    // V4: 16s+ reels = a multi-clip Veo chain (2–3 × 8s, per-clip scene-pool
    // variety, crossfade-stitched by the worker). Owner-initiated only; the UI
    // shows the cost before this ever runs.
    if (Number(input.durationSec) >= 16) {
      const { startVeoReelChain } = await import('@/lib/creative-studio/veo-chain')
      const chain = await startVeoReelChain({
        productImagePath: imagePath,
        totalClips: Number(input.durationSec) >= 24 ? 3 : 2,
        aspect: input.aspectRatio === '16:9' ? '16:9' : '9:16',
        vibe,
      })
      jobs.push({ pendingActionId: chain.pendingActionId, label: 'লম্বা রিল (Veo multi-clip)', type: 'video_gen' })
      return { jobs, provider: 'gemini', fashnReady }
    }
    const durationSec = Math.min(Math.max(Number(input.durationSec ?? 6), 4), 8)
    const aspect = input.aspectRatio === '16:9' ? '16:9' : '9:16'
    const { prompt } = buildVideoBrief(
      {
        productCode: 'studio-reel',
        name: null,
        category: null,
        fabric: null,
        imagePath,
        familyMatch: false,
      },
      { vibe, aspect: aspect as '9:16' | '16:9', durationSec },
    )

    const id = await createApprovedAction({
      type: 'video_gen',
      payload: {
        prompt,
        referenceImageId: imagePath,
        durationSec,
        aspect,
        creativeStudio: true,
        studioMode: input.mode,
        provider: 'gemini',
      },
      summary: `🎬 Creative Studio Reel (${durationSec}s ${aspect})`,
      costEstimate: estimateReelCostUsd(durationSec),
    })
    jobs.push({ pendingActionId: id, label: 'Product Reel (Veo 3.1)', type: 'video_gen' })
    return { jobs, provider: 'gemini', actualModel: 'veo-3.1', fashnReady }
  }

  // ── CS7: FLUX Fill masked precision edit (Edit mode + a painted mask) ──────
  // Edits ONLY the masked region; the worker composites the fill back onto the
  // protected base so unmasked pixels survive by construction. Durable Fal
  // queue — never a Vercel request waiting on the model.
  if (input.mode === 'edit' && input.maskPath) {
    const basePath = input.sourceImagePath
    if (!basePath) throw new Error('source_image_required')
    if (!process.env.FAL_KEY?.trim()) throw new Error('fal_not_configured')
    if ((await readKv(CS_FLUX_FILL_ENABLED_KEY)) !== '1') throw new Error('flux_fill_disabled')
    assertResolutionRequest({
      engine: 'fal_flux_fill',
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
    })

    const engine = getEngine('fal_flux_fill')
    // Throws custom_prompt_required when the custom preset has no text.
    const fillPrompt = buildFillPrompt(input.maskPreset, input.prompt ?? '')
    const costEstimate = estimateFluxFillCostUsd(input.baseWidth ?? 0, input.baseHeight ?? 0)
    const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed as number) : undefined
    const referenceContract = makeReferenceContract({
      mode: 'edit',
      requestedEngine: 'fal_flux_fill',
      actualModel: engine.falEndpointId ?? 'fal-ai/flux-pro/v1/fill',
      bindings: [
        referenceBinding('source', basePath, input, true),
        referenceBinding('mask', input.maskPath, input, true),
      ],
    })

    const id = await createApprovedAction({
      type: 'image_gen',
      payload: {
        provider: 'fal',
        falEngine: 'fal_flux_fill',
        falEndpointId: engine.falEndpointId,
        baseImagePath: basePath,
        maskPath: input.maskPath,
        fillPrompt,
        maskPreset: input.maskPreset ?? 'custom',
        referenceContract,
        controlContract: controlContract(input, {
          maskPreset: input.maskPreset ?? 'custom',
          sourceDimensions: { width: input.baseWidth ?? null, height: input.baseHeight ?? null },
          seed: seed ?? null,
        }),
        ...(seed !== undefined ? { seed } : {}),
        creativeStudio: true,
        studioMode: 'edit',
        familyPreset: input.familyPreset,
      },
      summary: `🎯 Precision Edit (FLUX Fill · ${input.maskPreset ?? 'custom'})`,
      costEstimate,
    })
    jobs.push({ pendingActionId: id, label: 'Precision Edit · FLUX Fill', type: 'image_gen' })
    return { jobs, provider: 'fal_flux_fill', fashnReady }
  }

  // ── CS6: Fal-backed single-person VTON (owner-selected engine) ─────────────
  // Single Try-On ONLY — multi-person family presets never reach here (they're
  // handled by the accuracy chain above), and the UI hides these engines for
  // family/swap/face/edit/video. The worker runs the durable Fal queue client.
  if (
    isFalVtonEngine(input.vtonEngine)
    && (!input.familyPreset || input.familyPreset === 'single')
    && input.mode !== 'try_on'
  ) {
    // CSE-A: this used to fall through to direct FASHN Product→Model while the
    // owner had selected a Fal Try-On endpoint. Refuse the mismatch pre-queue.
    assertAdvancedEngineMode(input.vtonEngine, input.mode)
  }
  if (
    isFalVtonEngine(input.vtonEngine)
    && input.mode === 'try_on'
    && (!input.familyPreset || input.familyPreset === 'single')
  ) {
    if (!input.productImagePath) throw new Error('product_image_required')
    const vtonModelPath = input.modelImagePath ?? input.sourceImagePath
    if (!vtonModelPath) throw new Error('model_image_required')
    if (!process.env.FAL_KEY?.trim()) throw new Error('fal_not_configured')
    assertResolutionRequest({
      engine: input.vtonEngine,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
    })

    // CS8 — readiness gate: stop unusable inputs BEFORE any paid call.
    const readiness = await checkSingleInputReadiness({
      modelImagePath: vtonModelPath,
      productImagePath: input.productImagePath,
    })
    if (!readiness.ok) throw new Error(`input_not_ready:${readiness.errors.join(',')}`)

    // CS8 — owner-tunable Preview/Production plan (bounded paid generations).
    const plan = buildRunPlan(await readPipelineMode())

    const engine = getEngine(input.vtonEngine)
    const referenceContract = makeReferenceContract({
      mode: input.mode,
      requestedEngine: input.vtonEngine,
      actualModel: engine.falEndpointId ?? input.vtonEngine,
      bindings: [
        referenceBinding('person', vtonModelPath, input, true),
        referenceBinding('product', input.productImagePath, input, true),
      ],
    })
    // Owner flag gates: fal master switch for the commercial engine, the
    // dedicated experimental switch for IDM.
    if (input.vtonEngine === 'fal_fashn_v16' && (await readKv(CS_FAL_ENABLED_KEY)) !== '1') {
      throw new Error('fal_engine_disabled')
    }
    if (input.vtonEngine === 'fal_idm_vton' && (await readKv(CS_IDM_VTON_ENABLED_KEY)) !== '1') {
      throw new Error('idm_vton_disabled')
    }

    // Garment placement: honour the owner's manual override; otherwise classify
    // (cached per product) and map via the owner-locked table.
    const attrs = await getOrClassifyGarment(input.productImagePath)
    const auto = mapGarmentToVtonClothType(attrs)
    const clothType: VtonClothType = isVtonClothType(input.clothType) ? input.clothType : auto.clothType

    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)
    const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed as number) : undefined
    for (let i = 0; i < count; i++) {
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'fal',
          falEngine: input.vtonEngine,
          falEndpointId: engine.falEndpointId,
          productImagePath: input.productImagePath,
          modelImagePath: vtonModelPath,
          referenceContract,
          controlContract: controlContract(input, {
            clothType,
            generationMode: plan.economical ? 'performance' : (input.generationMode ?? 'balanced'),
            aspectRatio: input.aspectRatio ?? '4:5',
            seed: seed !== undefined ? seed + i : null,
            numImagesPerAction: 1,
          }),
          clothType,
          clothTypeSource: isVtonClothType(input.clothType) ? 'owner' : 'auto',
          clothTypeUncertain: auto.uncertain,
          fashnCategory: mapGarmentToFashnCategory(attrs),
          // CS6 defaults (roadmap): 30 steps, guidance 2.5, fixed seed when supplied.
          numInferenceSteps: 30,
          guidanceScale: 2.5,
          ...(seed !== undefined ? { seed: seed + i } : {}),
          prompt: extraPrompt || undefined,
          // CS8 — preview mode renders economical; production keeps owner choice
          generationMode: plan.economical ? 'performance' : (input.generationMode ?? 'balanced'),
          resolutionContract: input.vtonEngine === 'fal_fashn_v16'
            ? { kind: 'fixed', width: 864, height: 1296 }
            : { kind: 'provider_native' },
          // CS8 — bounded-spend plan travels with the job (worker QC honours it)
          pipelineMode: plan.mode,
          maxPaidGenerations: plan.maxPaidGenerations,
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: 'single',
        },
        summary: `🎨 Studio Try-On${count > 1 ? ` #${i + 1}` : ''} (${engine.label} · ${plan.mode === 'production' ? 'প্রোডাকশন' : 'প্রিভিউ'})`,
        costEstimate: (input.vtonEngine === 'fal_fashn_v16' ? 0.075 : 0.05) * plan.maxPaidGenerations,
      })
      jobs.push({ pendingActionId: id, label: `Try-On · ${engine.label}`, type: 'image_gen' })
    }
    return { jobs, provider: input.vtonEngine, fashnReady }
  }

  if (provider === 'fashn' && modeDef.fashnModel) {
    if (!chainVtonEngine) throw new Error('explicit_engine_selection_mismatch')
    assertAdvancedEngineMode('fashn', input.mode)
    validateAdvancedControlValues({ ...input, engine: 'fashn' })
    if (!input.productImagePath && modeDef.needsProduct) throw new Error('product_image_required')
    if (!input.modelImagePath && modeDef.needsModel) throw new Error('model_image_required')
    if (!input.sourceImagePath && modeDef.needsSource) throw new Error('source_image_required')

    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)
    let truthful: { resolution: FashnResolution; aspectRatio?: string }
    let rescueImageModel: GenericImageModel | undefined
    if (input.mode === 'try_on') {
      const generic = await configuredGenericImageSelection('pro', input.pinnedGenericImageModel)
      truthful = assertTieredResolution(generic.engine, input)
      rescueImageModel = generic.model
    } else {
      const resolution = input.resolution ?? '2k'
      const sourceDerivedAspect = input.mode === 'model_swap' || input.mode === 'edit'
      const aspectRatio = sourceDerivedAspect ? undefined : input.aspectRatio ?? '4:5'
      assertResolutionRequest({ engine: 'fashn', resolution, aspectRatio })
      if (input.mode === 'face_to_model'
        && aspectRatio
        && !['1:1', '4:5', '3:4', '9:16'].includes(aspectRatio)) {
        throw new Error(`aspect_ratio_unsupported:fashn:${aspectRatio}`)
      }
      truthful = { resolution, aspectRatio }
    }

    // Try-on with a model photo: run the 2-step chain (FASHN garment accuracy →
    // Bangladeshi background swap). Each image picks its own random scene + pose,
    // so no two outputs share the same look — a raw FASHN render would otherwise
    // reuse the model photo's background every single time.
    const tryOnModelPath = input.modelImagePath ?? input.sourceImagePath
    if (input.mode === 'try_on' && input.productImagePath && tryOnModelPath) {
      // CS8 — same readiness gate as the Fal engines (single-person only).
      if (!input.familyPreset || input.familyPreset === 'single') {
        const readiness = await checkSingleInputReadiness({
          modelImagePath: tryOnModelPath,
          productImagePath: input.productImagePath,
        })
        if (!readiness.ok) throw new Error(`input_not_ready:${readiness.errors.join(',')}`)
      }
      for (let i = 0; i < count; i++) {
        const job = await startSingleRescueChain({
          productImagePath: input.productImagePath,
          modelImagePath: tryOnModelPath,
          aspectRatio: truthful.aspectRatio ?? '4:5',
          resolution: truthful.resolution,
          generationMode: input.generationMode,
          extraPrompt: extraPrompt || undefined,
          vtonEngine: chainVtonEngine,
          imageModel: rescueImageModel,
          conversationId: null,
        })
        jobs.push({ pendingActionId: job.pendingActionId, label: modeDef.label, type: 'image_gen' })
      }
      return { jobs, provider: 'fashn', fashnReady }
    }

    if (input.mode === 'edit' && !extraPrompt.trim()) throw new Error('prompt_required')
    const fashnInputs = buildDirectFashnInputs({
      mode: input.mode,
      productImagePath: input.productImagePath,
      modelImagePath: input.modelImagePath,
      sourceImagePath: input.sourceImagePath,
      faceReferencePath: input.faceReferencePath,
    })
    const referenceContract = directFashnReferenceContract(input, modeDef.fashnModel)

    // product_to_model has no model photo to inherit a background from — vary the
    // look per image with a random pose + fully-Bangladeshi scene in the prompt.
    // Owner-driven modes (edit / model_swap / face_to_model) keep the prompt as-is.
    const injectScene = input.mode === 'product_to_model'
    // CS8 — controlled diversity: skip recently used scenes so a batch never
    // returns near-identical compositions; every pick is recorded.
    const [sceneWeights, recentScenes] = injectScene
      ? await Promise.all([readSceneWeights(), readRecentSceneIds()])
      : [{}, [] as string[]]
    for (let i = 0; i < count; i++) {
      const picked = injectScene ? pickSceneDiverse(sceneWeights, recentScenes) : null
      if (picked) {
        recentScenes.unshift(picked.scene.id)
        await recordSceneUse(picked.scene.id)
      }
      const sceneLine = picked ? `Pose: ${picked.adultPose}. ${picked.scene.prompt}` : ''
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'fashn',
          fashnModel: modeDef.fashnModel,
          fashnInputs,
          fashnOptions: {
            prompt: [extraPrompt, sceneLine].filter(Boolean).join(' ') || undefined,
            resolution: truthful.resolution,
            ...(truthful.aspectRatio ? { aspectRatio: truthful.aspectRatio } : {}),
            generationMode: input.generationMode ?? 'balanced',
            ...(Number.isFinite(input.seed) ? { seed: Math.trunc(input.seed as number) + i } : {}),
            numImages: 1,
            outputFormat: 'png',
          },
          aspectRatio: truthful.aspectRatio,
          requestedResolution: truthful.resolution,
          requestedAspectRatio: truthful.aspectRatio,
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: input.familyPreset,
          productImagePath: input.productImagePath,
          modelImagePath: input.modelImagePath,
          referenceContract,
          controlContract: controlContract(input, {
            model: modeDef.fashnModel,
            aspectRatio: truthful.aspectRatio ?? 'source_inherited',
            resolution: truthful.resolution,
            generationMode: input.generationMode ?? 'balanced',
            seed: Number.isFinite(input.seed) ? Math.trunc(input.seed as number) + i : null,
            numImagesPerAction: 1,
          }, input.mode === 'model_swap' || input.mode === 'edit'
            ? ['fashn_aspect_ratio_inherited_from_source']
            : []),
          // CS8 — scene/pose lineage for diversity control
          sceneRef: picked ? toSceneRef(picked) : undefined,
        },
        summary: `🎨 Studio ${modeDef.label}${count > 1 ? ` #${i + 1}` : ''} (FASHN)`,
        costEstimate: estimateDirectFashnCostUsd({
          resolution: truthful.resolution,
          generationMode: input.generationMode,
          hasFaceReference: Boolean(fashnInputs.face_reference),
        }),
      })
      jobs.push({ pendingActionId: id, label: modeDef.label, type: 'image_gen' })
    }
    return { jobs, provider: 'fashn', fashnReady }
  }

  // Gemini fallback single/batch
  assertAdvancedEngineMode('gemini', input.mode)
  if (!input.productImagePath) throw new Error('product_image_required')
  const generic = await configuredGenericImageSelection(
    genericQualityForRun(input),
    input.pinnedGenericImageModel,
  )
  const truthful = assertTieredResolution(generic.engine, input)

  if (input.familyPreset && input.familyPreset !== 'single') {
    const execution = requireStudioRunExecutionContext()
    const dedupePart = `gemini:${input.familyPreset}`
    const batch = await queueTryOnBatch({
      productImagePath: input.productImagePath,
      modelId: input.modelId,
      variants: [input.familyPreset],
      extra: extraPrompt,
      conversationId: null,
      aspectRatio: truthful.aspectRatio,
      resolution: truthful.resolution,
      dedupePrefix: `studio-run:${execution.claims.receiptId}:gemini`,
    })
    for (const item of batch.items) {
      await mergeGenericApprovedPayload({
        pendingActionId: item.pendingActionId,
        run: input,
        imageModel: generic.model,
        quality: generic.quality,
        aspectRatio: truthful.aspectRatio,
        resolution: truthful.resolution,
        familyPreset: input.familyPreset,
        dedupePart,
      })
      jobs.push({ pendingActionId: item.pendingActionId, label: item.label, type: 'image_gen' })
    }
    return { jobs, provider: 'gemini', actualModel: generic.model, fashnReady }
  }

  const execution = requireStudioRunExecutionContext()
  const batch = await queueTryOnBatch({
    productImagePath: input.productImagePath,
    modelId: input.modelId,
    variants: ['single'],
    extra: extraPrompt,
    conversationId: null,
    aspectRatio: truthful.aspectRatio,
    resolution: truthful.resolution,
    dedupePrefix: `studio-run:${execution.claims.receiptId}:gemini`,
  })
  await mergeGenericApprovedPayload({
    pendingActionId: batch.items[0].pendingActionId,
    run: input,
    imageModel: generic.model,
    quality: generic.quality,
    aspectRatio: truthful.aspectRatio,
    resolution: truthful.resolution,
    dedupePart: 'gemini:single',
  })
  jobs.push({
    pendingActionId: batch.items[0].pendingActionId,
    label: modeDef.label,
    type: 'image_gen',
  })
  return { jobs, provider: 'gemini', actualModel: generic.model, fashnReady }
}

export type AutoStudioResult = {
  jobs: CreativeStudioJobRef[]
  provider: StudioProvider | 'xai_imagine'
  modelName: string
  variants: ChatTryOnVariant[]
  reelQueued: boolean
}

/**
 * One-tap Auto: owner uploads only a product image. We auto-pick the default
 * brand model, auto-classify the garment + auto-write the prompt (inside
 * queueTryOnBatch), and queue a curated on-model set. Family variants are
 * added only when the required role models exist, so it never fails for a
 * missing model. No prompt / no manual settings required.
 *
 * Phase 3 (best realism): when FASHN_API_KEY is set, the solo on-model shot is
 * rendered through FASHN tryon-max (purpose-built virtual try-on, best realism)
 * instead of Gemini. Family variants stay on Gemini (multi-person). Without the
 * key everything gracefully falls back to Gemini.
 *
 * Phase 4 (video): includeReel queues a short product reel (Veo 3.1) from the
 * same product image — owner-initiated, so spend stays under the owner's tap.
 */
export async function runAutoStudio(input: {
  productImagePath: string
  modelId: string
  includeFamily?: boolean
  includeReel?: boolean
  pinnedAutoEngine?: StudioEngineId
  pinnedGenericImageModel?: GenericImageModel
  pinnedChainVtonEngine?: 'fashn' | 'fal_fashn_v16'
}): Promise<AutoStudioResult> {
  const execution = requireStudioRunExecutionContext()
  const productImagePath = input.productImagePath?.trim()
  if (!productImagePath) throw new Error('product_image_required')

  const defaultModel = await resolveModel(input.modelId)
  if (!defaultModel) throw new Error('no_default_model')

  // CS13.2 — owner default engine = Grok Imagine: the Auto solo shot runs the
  // xAI try-on brief (person + prepped garment refs). Family variants keep the
  // proven FASHN accuracy chain regardless.
  const { CS_SINGLE_VTON_DEFAULT_KEY: DEF_KEY, normalizeSingleVtonDefault: normDef } = await import('@/lib/creative-studio/provider-registry')
  const ownerDefault = input.pinnedAutoEngine ?? normDef(await readKv(DEF_KEY))
  const xaiConfigured = Boolean(process.env.XAI_API_KEY?.trim())
    && (await readKv(CS_XAI_ENABLED_KEY)) === '1'
  if (input.pinnedAutoEngine === 'xai_imagine' && !xaiConfigured) {
    throw new Error('explicit_engine_unavailable:xai_imagine')
  }
  const xaiAutoReady = ownerDefault === 'xai_imagine' && xaiConfigured

  const autoChainEngine = input.pinnedChainVtonEngine ?? await resolveChainVtonEngine()
  const useFashn = ownerDefault === 'fashn'
    || ownerDefault === 'fal_fashn_v16'
    || ownerDefault === 'fal_idm_vton'
  const jobs: CreativeStudioJobRef[] = []
  /** variants rendered via the legacy Gemini batch (no-FASHN fallback) */
  const variants: ChatTryOnVariant[] = []
  /** variants rendered via the accuracy chain (reported to the UI alongside `variants`) */
  const chainedVariants: ChatTryOnVariant[] = []

  // Solo on-model shot: FASHN accuracy + a Bangladeshi background swap (2-step
  // chain) so every Auto run comes back with a different pose/scene. Falls back
  // to the Gemini try-on batch without a FASHN key.
  // CS14 — a built avatar (canonical portrait) is the best person reference
  const { resolvePersonRef } = await import('@/lib/tryon/model-avatar')
  const defaultRef = await resolvePersonRef(defaultModel)
  const autoGeneric = await configuredGenericImageSelection('pro', input.pinnedGenericImageModel)
  assertResolutionRequest({
    engine: autoGeneric.engine,
    resolution: '2k',
    aspectRatio: '4:5',
  })

  if (xaiAutoReady) {
    const solo = await runCreativeStudio({
      mode: 'try_on',
      vtonEngine: 'xai_imagine',
      productImagePath,
      modelId: defaultModel.id,
      modelImagePath: defaultRef.path,
      avatarSheetPath: defaultRef.sheetPath,
      resolution: '2k',
      pinnedGenericImageModel: input.pinnedGenericImageModel,
      pinnedChainVtonEngine: input.pinnedChainVtonEngine,
    })
    for (const j of solo.jobs) jobs.push(j)
  } else if (useFashn) {
    const job = await startSingleRescueChain({
      productImagePath,
      modelImagePath: defaultRef.path,
      generationMode: 'quality',
      vtonEngine: autoChainEngine,
      imageModel: autoGeneric.model,
      conversationId: null,
    })
    jobs.push({ pendingActionId: job.pendingActionId, label: 'On-model (best realism)', type: 'image_gen' })
  } else {
    variants.push('single')
  }

  if (input.includeFamily) {
    const familyPins = execution.claims.scope.familyModelPins ?? []
    const father = familyPins.find((pin) => pin.role === 'father')
    const mother = familyPins.find((pin) => pin.role === 'mother')
    const son = familyPins.find((pin) => pin.role === 'son')
    const daughter = familyPins.find((pin) => pin.role === 'daughter')
    const pairs: FamilyChainVariant[] = []
    if (father && son) pairs.push('father_son')
    if (mother && son) pairs.push('mother_son')
    if (mother && daughter) pairs.push('mother_daughter')

    if (xaiAutoReady) {
      // CS13.3 — default engine is Grok: family pairs run the 3-reference
      // multi-image brief (both role models + product) instead of the chain.
      for (const v of pairs) {
        try {
          const pair = await runCreativeStudio({
            mode: 'try_on',
            vtonEngine: 'xai_imagine',
            familyPreset: v as FamilyPresetId,
            productImagePath,
            resolution: '2k',
          })
          for (const j of pair.jobs) jobs.push(j)
          chainedVariants.push(v as ChatTryOnVariant)
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (!msg.startsWith('missing_models:')) throw err
        }
      }
    } else if (useFashn) {
      // Accuracy chain per pair — saved child models keep the same face every run.
      for (const v of pairs) {
        try {
          const chain = await startFamilyChain({
            variant: v,
            productImagePath,
            generationMode: 'quality',
            vtonEngine: autoChainEngine,
            imageModel: autoGeneric.model,
            conversationId: null,
          })
          for (const j of chain.jobs) jobs.push(j)
          chainedVariants.push(v as ChatTryOnVariant)
        } catch (err) {
          if (!(err instanceof FamilyChainModelError)) throw err
        }
      }
    } else {
      for (const v of pairs) variants.push(v as ChatTryOnVariant)
    }
  }

  if (variants.length > 0) {
    const batch = await queueTryOnBatch({
      productImagePath,
      modelId: defaultModel.id,
      variants,
      conversationId: null,
      dedupePrefix: `studio-run:${execution.claims.receiptId}:auto`,
    })
    for (const item of batch.items) {
      await mergeGenericApprovedPayload({
        pendingActionId: item.pendingActionId,
        run: {
          mode: 'product_to_model',
          productImagePath,
          modelImagePath: item.variant === 'single' ? defaultRef.path : undefined,
          modelId: item.variant === 'single' ? defaultModel.id : undefined,
          familyPreset: item.variant as FamilyPresetId,
          aspectRatio: '4:5',
          resolution: '2k',
          generationMode: 'quality',
        },
        imageModel: autoGeneric.model,
        quality: 'pro',
        aspectRatio: '4:5',
        resolution: '2k',
        extraPayload: { auto: true },
        familyPreset: item.variant,
        dedupePart: `auto:${item.variant}`,
      })
      jobs.push({ pendingActionId: item.pendingActionId, label: item.label, type: 'image_gen' })
    }
  }

  let reelQueued = false
  if (input.includeReel) {
    const durationSec = 6
    const aspect = '9:16' as const
    const { prompt } = buildVideoBrief(
      { productCode: 'studio-reel', name: null, category: null, fabric: null, imagePath: productImagePath, familyMatch: false },
      { vibe: 'premium', aspect, durationSec },
    )
    const reelId = await createApprovedAction({
      type: 'video_gen',
      payload: {
        prompt,
        referenceImageId: productImagePath,
        durationSec,
        aspect,
        studioMode: 'image_to_video',
        provider: 'gemini',
        auto: true,
      },
      summary: `🎬 Auto Studio Reel (${durationSec}s ${aspect})`,
      costEstimate: estimateReelCostUsd(durationSec),
    })
    jobs.push({ pendingActionId: reelId, label: 'Product Reel (Veo 3.1)', type: 'video_gen' })
    reelQueued = true
  }

  return {
    jobs,
    provider: xaiAutoReady ? 'xai_imagine' : useFashn ? 'fashn' : 'gemini',
    modelName: defaultModel.name,
    variants: [...chainedVariants, ...variants],
    reelQueued,
  }
}
