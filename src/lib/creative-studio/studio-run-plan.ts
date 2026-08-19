import { isFashnConfigured } from '@/lib/fashn/client'
import type { CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import {
  estimateDirectFashnCostUsd,
  genericImageProvider,
  normalizeGenericImageModels,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'
import { estimateFluxFillCostUsd } from '@/lib/creative-studio/mask-contract'
import {
  CS_ENGINE_KILL_PREFIX,
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  CS_SINGLE_VTON_DEFAULT_KEY,
  CS_XAI_ENABLED_KEY,
  getEngine,
  isFamilyChainVtonEngine,
  normalizeSingleVtonDefault,
  type StudioEngineId,
} from '@/lib/creative-studio/provider-registry'
import { readPipelineMode } from '@/lib/creative-studio/single-pipeline'
import { readKv } from '@/lib/creative-studio/taste'
import {
  STUDIO_RUN_USD_TO_BDT,
  type StudioRunResolvedSelection,
} from '@/lib/creative-studio/studio-run-authorization'
import { estimateXaiImageCostUsd, toXaiResolution } from '@/lib/creative-studio/xai-imagine'
import { resolveModel } from '@/lib/tryon/model-library'
import { autoProductReferenceError, getOrClassifyGarment } from '@/lib/tryon/art-director'
import { STUDIO_MODES } from '@/lib/creative-studio/constants'
import { roundMoney } from '@/lib/money'
import { exactDimensionsFor } from '@/lib/creative-studio/resolution-contract'
import { gptImage2OutputCostUsd } from '@/lib/creative-studio/gpt-image-2-pricing'

type StudioRunRequest = CreativeStudioRunInput & {
  auto?: boolean
  includeFamily?: boolean
  includeReel?: boolean
}

export type StudioRunPlan = {
  estimateBdt: number
  estimateUsd: number
  selection: StudioRunResolvedSelection
  pinned: {
    autoEngine?: StudioEngineId
    genericImageModel?: GenericImageModel
    chainVtonEngine?: 'fashn' | 'fal_fashn_v16'
  }
}

const GENERIC_PRICING = {
  gemini: {
    standard: { '1k': 0.067, '2k': 0.101, '4k': 0.151 },
    pro: { '1k': 0.134, '2k': 0.134, '4k': 0.24 },
  },
  fal: { '1k': 0.0675, '2k': 0.135, '4k': 0.135 },
} as const

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function toBdt(usd: number): number {
  return Math.max(0, roundMoney(Math.max(0, usd) * STUDIO_RUN_USD_TO_BDT))
}

function count(input: StudioRunRequest): number {
  return Math.min(4, Math.max(1, Math.trunc(Number(input.numImages) || 1)))
}

function resolution(input: StudioRunRequest): '1k' | '2k' | '4k' {
  return input.resolution === '1k' || input.resolution === '4k' ? input.resolution : '2k'
}

function quality(input: StudioRunRequest): 'standard' | 'pro' {
  return input.generationMode === 'fast' ? 'standard' : 'pro'
}

function genericCost(
  model: GenericImageModel,
  input: StudioRunRequest,
  attempts: number,
): number {
  const provider = genericImageProvider(model)
  const tier = resolution(input)
  const q = quality(input)
  const openaiDimensions = provider === 'openai'
    ? exactDimensionsFor('gpt', tier, input.aspectRatio ?? '4:5')
    : null
  if (provider === 'openai' && !openaiDimensions) {
    throw new Error(`resolution_unsupported:gpt:${tier}:${input.aspectRatio ?? '4:5'}`)
  }
  const perGeneration = provider === 'openai' && openaiDimensions
    ? gptImage2OutputCostUsd(
        openaiDimensions.width,
        openaiDimensions.height,
        q === 'standard' ? 'medium' : 'high',
      )
    : provider === 'fal'
      ? GENERIC_PRICING.fal[tier]
      : GENERIC_PRICING.gemini[q][tier]
  return perGeneration * attempts
}

async function genericSelection(input: StudioRunRequest): Promise<{
  model: GenericImageModel
  provider: 'gemini' | 'openai' | 'fal'
}> {
  const models = normalizeGenericImageModels(await readKv('cs_image_models'))
  const model = models[quality(input)]
  return { model, provider: genericImageProvider(model) }
}

async function assertEngineAvailable(engine: StudioEngineId): Promise<void> {
  const killed = (await readKv(`${CS_ENGINE_KILL_PREFIX}${engine}`)) === '1'
  if (killed) throw new Error(`explicit_engine_killed:${engine}`)
  const definition = getEngine(engine)
  if (!definition.runnable) throw new Error(`explicit_engine_unavailable:${engine}`)

  if (engine === 'fashn' && !isFashnConfigured()) {
    throw new Error('explicit_engine_unavailable:fashn')
  }
  if (engine === 'xai_imagine') {
    if (!process.env.XAI_API_KEY?.trim() || (await readKv(CS_XAI_ENABLED_KEY)) !== '1') {
      throw new Error('explicit_engine_unavailable:xai_imagine')
    }
  }
  if (engine === 'fal_fashn_v16') {
    if (!process.env.FAL_KEY?.trim() || (await readKv(CS_FAL_ENABLED_KEY)) !== '1') {
      throw new Error('explicit_engine_unavailable:fal_fashn_v16')
    }
  }
  if (engine === 'fal_idm_vton') {
    if (!process.env.FAL_KEY?.trim() || (await readKv(CS_IDM_VTON_ENABLED_KEY)) !== '1') {
      throw new Error('explicit_engine_unavailable:fal_idm_vton')
    }
  }
  if (engine === 'fal_flux_fill') {
    if (!process.env.FAL_KEY?.trim() || (await readKv(CS_FLUX_FILL_ENABLED_KEY)) !== '1') {
      throw new Error('explicit_engine_unavailable:fal_flux_fill')
    }
  }
  if (engine === 'gemini' && !process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('explicit_engine_unavailable:gemini')
  }
}

async function assertGenericSelectionAvailable(
  selection: Awaited<ReturnType<typeof genericSelection>>,
): Promise<void> {
  if (selection.provider === 'gemini' && !process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('explicit_model_unavailable:gemini')
  }
  if (selection.provider === 'openai' && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('explicit_model_unavailable:openai')
  }
  if (selection.provider === 'fal' && !process.env.FAL_KEY?.trim()) {
    throw new Error('explicit_model_unavailable:fal')
  }
  if ((await readKv(`${CS_ENGINE_KILL_PREFIX}gemini`)) === '1') {
    throw new Error('explicit_engine_killed:gemini')
  }
}

async function resolveChainEngine(
  requested: StudioEngineId | undefined,
): Promise<'fashn' | 'fal_fashn_v16'> {
  if (requested === 'fashn') {
    await assertEngineAvailable('fashn')
    return 'fashn'
  }
  if (requested === 'fal_fashn_v16') {
    await assertEngineAvailable('fal_fashn_v16')
    return 'fal_fashn_v16'
  }
  if (requested === 'fal_idm_vton') {
    throw new Error('explicit_engine_mode_unsupported:fal_idm_vton:family')
  }
  if (isFashnConfigured() && (await readKv(`${CS_ENGINE_KILL_PREFIX}fashn`)) !== '1') {
    return 'fashn'
  }
  await assertEngineAvailable('fal_fashn_v16')
  return 'fal_fashn_v16'
}

function chainVtonUnit(engine: 'fashn' | 'fal_fashn_v16'): number {
  return engine === 'fashn' ? 0.25 : 0.075
}

function familyChainCost(input: {
  variant: string
  vtonEngine: 'fashn' | 'fal_fashn_v16'
  genericUnit: number
  attempts: number
  protectedComposite: boolean
}): { usd: number; plan: string[] } {
  const vton = chainVtonUnit(input.vtonEngine) * input.attempts
  const merge = input.protectedComposite ? 0.15 : input.genericUnit
  if (input.variant === 'full_family') {
    const groupMerge = input.protectedComposite ? 0.2 : input.genericUnit
    return {
      usd: (vton * 4) + (merge * 2) + groupMerge,
      plan: [
        'father_son:garment_prep+2_vton+pair_merge',
        'mother_daughter:garment_prep+2_vton+pair_merge',
        'group_merge',
      ],
    }
  }
  return {
    usd: (vton * 2) + merge,
    plan: ['garment_prep', 'adult_vton', 'child_vton', 'pair_merge'],
  }
}

async function planAdvanced(
  input: StudioRunRequest,
  attempts: number,
): Promise<Omit<StudioRunPlan, 'estimateBdt'>> {
  if (input.mode === 'image_to_video') {
    if (input.provider && input.provider !== 'gemini') {
      throw new Error(`explicit_engine_mode_unsupported:${input.provider}:image_to_video`)
    }
    await assertEngineAvailable('gemini')
    const requestedDuration = Number(input.durationSec ?? 6)
    const clips = requestedDuration >= 24 ? 3 : requestedDuration >= 16 ? 2 : 1
    const clipSeconds = clips > 1 ? 8 : Math.min(8, Math.max(4, requestedDuration))
    const usd = clips * clipSeconds * 0.15 * 2
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: 'gemini',
        model: 'veo-3.1-generate-preview',
        providers: ['google'],
        models: ['veo-3.1-generate-preview'],
        plan: clips > 1
          ? [`${clips}x${clipSeconds}s_veo_clip`, 'local_crossfade']
          : [`${clipSeconds}s_veo_clip`],
        paidAttemptLimit: 2,
      },
      pinned: {},
    }
  }

  const generic = await genericSelection(input)
  const genericUnit = genericCost(generic.model, input, attempts)
  const requestedEngine = input.vtonEngine
    ?? (input.provider === 'gemini' || input.provider === 'fashn' ? input.provider : undefined)
  if (!requestedEngine) throw new Error('explicit_engine_required')
  const multiPerson = Boolean(input.familyPreset && input.familyPreset !== 'single')

  if (requestedEngine === 'xai_imagine') {
    await assertEngineAvailable('xai_imagine')
    if (input.familyPreset === 'full_family') {
      throw new Error('explicit_engine_mode_unsupported:xai_imagine:full_family')
    }
    const perGeneration = estimateXaiImageCostUsd(toXaiResolution(input.resolution))
    const usd = perGeneration * count(input) * attempts
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: 'xai',
        model: 'grok-imagine-image-quality',
        providers: ['xai'],
        models: ['grok-imagine-image-quality'],
        plan: [`${count(input)}x_xai_image`],
        paidAttemptLimit: attempts,
      },
      pinned: {},
    }
  }

  if (requestedEngine === 'fal_flux_fill') {
    if (multiPerson) {
      throw new Error('explicit_engine_mode_unsupported:fal_flux_fill:family')
    }
    await assertEngineAvailable('fal_flux_fill')
    const usd = estimateFluxFillCostUsd(input.baseWidth ?? 0, input.baseHeight ?? 0) * attempts
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: 'fal',
        model: 'fal-ai/flux-pro/v1/fill',
        providers: ['fal'],
        models: ['fal-ai/flux-pro/v1/fill'],
        plan: ['masked_fill'],
        paidAttemptLimit: attempts,
      },
      pinned: {},
    }
  }

  if (multiPerson && requestedEngine !== 'gemini') {
    if (!isFamilyChainVtonEngine(requestedEngine)) {
      throw new Error(`explicit_engine_mode_unsupported:${requestedEngine}:family`)
    }
    const chainEngine = await resolveChainEngine(requestedEngine)
    await assertGenericSelectionAvailable(generic)
    const chain = familyChainCost({
      variant: input.familyPreset!,
      vtonEngine: chainEngine,
      genericUnit,
      attempts,
      protectedComposite: Boolean(input.protectedComposite),
    })
    return {
      estimateUsd: chain.usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: chainEngine,
        model: chainEngine === 'fashn' ? 'tryon-max' : 'fal-ai/fashn/tryon/v1.6',
        providers: unique([
          chainEngine === 'fashn' ? 'fashn' : 'fal',
          input.protectedComposite ? 'fal' : generic.provider,
        ]),
        models: unique([
          chainEngine === 'fashn' ? 'tryon-max' : 'fal-ai/fashn/tryon/v1.6',
          input.protectedComposite ? 'fal-ai/flux-pro/v1/fill' : generic.model,
        ]),
        plan: chain.plan,
        paidAttemptLimit: attempts,
      },
      pinned: {
        chainVtonEngine: chainEngine,
        genericImageModel: generic.model,
      },
    }
  }

  if (requestedEngine === 'gemini') {
    // `gemini` is the historical ID of the owner-selected guided-image lane.
    // Its configured model may be Gemini, GPT Image, or Seedream, so validate
    // the resolved provider instead of requiring a Gemini key/model pair.
    await assertGenericSelectionAvailable(generic)
    const usd = genericUnit * count(input)
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: generic.provider,
        model: generic.model,
        providers: [generic.provider],
        models: [generic.model],
        plan: [`${count(input)}x_guided_image`],
        paidAttemptLimit: attempts,
      },
      pinned: { genericImageModel: generic.model },
    }
  }

  if (requestedEngine === 'fal_fashn_v16' || requestedEngine === 'fal_idm_vton') {
    await assertEngineAvailable(requestedEngine)
    const unit = requestedEngine === 'fal_fashn_v16' ? 0.075 : 0.05
    const usd = unit * count(input) * attempts
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: 'fal',
        model: getEngine(requestedEngine).falEndpointId ?? requestedEngine,
        providers: ['fal'],
        models: [getEngine(requestedEngine).falEndpointId ?? requestedEngine],
        plan: [`${count(input)}x_virtual_try_on`],
        paidAttemptLimit: attempts,
      },
      pinned: {},
    }
  }

  await assertEngineAvailable('fashn')
  if (input.mode === 'try_on' && input.productImagePath && (input.modelImagePath || input.sourceImagePath)) {
    await assertGenericSelectionAvailable(generic)
    const chainEngine = await resolveChainEngine('fashn')
    const usd = count(input) * (
      chainVtonUnit(chainEngine) * attempts
      + genericUnit
    )
    return {
      estimateUsd: usd,
      selection: {
        architecture: 'advanced',
        mode: input.mode,
        provider: 'fashn',
        model: 'tryon-max',
        providers: unique(['fashn', generic.provider]),
        models: ['tryon-max', generic.model],
        plan: [`${count(input)}x_vton_plus_rescene`],
        paidAttemptLimit: attempts,
      },
      pinned: {
        chainVtonEngine: chainEngine,
        genericImageModel: generic.model,
      },
    }
  }
  const usd = estimateDirectFashnCostUsd({
    resolution: resolution(input),
    generationMode: input.generationMode,
    hasFaceReference: Boolean(input.faceReferencePath),
  }) * count(input) * attempts
  const directModel = STUDIO_MODES.find((mode) => mode.id === input.mode)?.fashnModel
  if (!directModel) throw new Error(`explicit_engine_mode_unsupported:fashn:${input.mode}`)
  return {
    estimateUsd: usd,
    selection: {
      architecture: 'advanced',
      mode: input.mode,
      provider: 'fashn',
      model: directModel,
      providers: ['fashn'],
      models: [directModel],
      plan: [`${count(input)}x_direct_fashn`],
      paidAttemptLimit: attempts,
    },
    pinned: {},
  }
}

async function planAuto(
  input: StudioRunRequest,
  attempts: number,
): Promise<Omit<StudioRunPlan, 'estimateBdt'>> {
  const defaultModel = input.modelId ? await resolveModel(input.modelId) : null
  if (!defaultModel) throw new Error('no_default_model')
  if (!input.productImagePath) throw new Error('product_image_required')
  const attrs = await getOrClassifyGarment(input.productImagePath)
  const productReferenceError = autoProductReferenceError(attrs, Boolean(input.includeFamily))
  if (productReferenceError) throw new Error(productReferenceError)
  if (
    /\b(kids?|boy|girl|child)\b/i.test(input.productName ?? '')
    && defaultModel.role !== 'son'
    && defaultModel.role !== 'daughter'
  ) {
    throw new Error(defaultModel.role
      ? 'kids_product_requires_child_model'
      : 'kids_product_requires_labeled_child_model')
  }
  const generic = await genericSelection({ ...input, generationMode: 'quality', resolution: '2k' })
  await assertGenericSelectionAvailable(generic)
  const genericUnit = genericCost(
    generic.model,
    { ...input, generationMode: 'quality', resolution: '2k' },
    attempts,
  )
  const configuredDefault = normalizeSingleVtonDefault(await readKv(CS_SINGLE_VTON_DEFAULT_KEY))
  let autoEngine: StudioEngineId
  try {
    await assertEngineAvailable(configuredDefault)
    autoEngine = configuredDefault
  } catch {
    if (isFashnConfigured()) autoEngine = 'fashn'
    else if (process.env.FAL_KEY?.trim() && (await readKv(CS_FAL_ENABLED_KEY)) === '1') {
      autoEngine = 'fal_fashn_v16'
    } else {
      autoEngine = 'gemini'
      await assertEngineAvailable('gemini')
      if (generic.provider !== 'gemini') {
        throw new Error(`auto_provider_unavailable:${generic.provider}`)
      }
    }
  }
  // Auto is the only lane allowed to resolve a different engine. Resolve any
  // single-person-only default to the exact chain engine now, then expose and
  // pin that result in the signed selection.
  if (autoEngine === 'fal_idm_vton') {
    autoEngine = await resolveChainEngine(undefined)
  }

  const providers: string[] = []
  const models: string[] = []
  const plan: string[] = []
  let usd = 0
  let chainEngine: 'fashn' | 'fal_fashn_v16' | undefined
  let resolvedProvider: string

  if (autoEngine === 'xai_imagine') {
    usd += estimateXaiImageCostUsd('2k') * attempts
    providers.push('xai')
    models.push('grok-imagine-image-quality')
    plan.push('auto_solo_xai')
    resolvedProvider = 'xai'
  } else if (autoEngine === 'fashn' || autoEngine === 'fal_fashn_v16') {
    chainEngine = await resolveChainEngine(autoEngine)
    usd += chainVtonUnit(chainEngine) * attempts + genericUnit
    providers.push(chainEngine === 'fashn' ? 'fashn' : 'fal', generic.provider)
    models.push(
      chainEngine === 'fashn' ? 'tryon-max' : 'fal-ai/fashn/tryon/v1.6',
      generic.model,
    )
    plan.push('auto_solo_vton_plus_rescene')
    resolvedProvider = chainEngine === 'fashn' ? 'fashn' : 'fal'
  } else {
    usd += genericUnit
    providers.push(generic.provider)
    models.push(generic.model)
    plan.push('auto_solo_guided_image')
    resolvedProvider = generic.provider
  }

  if (input.includeFamily) {
    const pins = input.familyModelPins ?? []
    const hasRole = (role: string) => pins.some((pin) => pin.role === role)
    const pairCount = Number(hasRole('father') && hasRole('son'))
      + Number(hasRole('mother') && hasRole('son'))
      + Number(hasRole('mother') && hasRole('daughter'))
    if (autoEngine === 'xai_imagine') {
      usd += pairCount * estimateXaiImageCostUsd('2k') * attempts
      plan.push(`${pairCount}x_auto_family_xai`)
    } else if (chainEngine) {
      for (let index = 0; index < pairCount; index++) {
        const chain = familyChainCost({
          variant: 'pair',
          vtonEngine: chainEngine,
          genericUnit,
          attempts,
          protectedComposite: false,
        })
        usd += chain.usd
      }
      plan.push(`${pairCount}x_auto_family_chain`)
    } else {
      usd += pairCount * genericUnit
      plan.push(`${pairCount}x_auto_family_guided_image`)
    }
  }

  if (input.includeReel) {
    await assertEngineAvailable('gemini')
    usd += 6 * 0.15 * attempts
    providers.push('google')
    models.push('veo-3.1-generate-preview')
    plan.push('6s_veo_reel')
  }

  return {
    estimateUsd: usd,
    selection: {
      architecture: 'auto',
      mode: 'auto',
      provider: resolvedProvider,
      model: models[0] ?? autoEngine,
      providers: unique(providers),
      models: unique(models),
      plan,
      paidAttemptLimit: attempts,
    },
    pinned: {
      autoEngine,
      chainVtonEngine: chainEngine,
      genericImageModel: generic.model,
    },
  }
}

export async function buildStudioRunPlan(input: StudioRunRequest): Promise<StudioRunPlan> {
  const pipelineMode = input.pipelineMode ?? await readPipelineMode()
  const attempts = pipelineMode === 'production' ? 3 : 1
  const plan = input.auto
    ? await planAuto(input, attempts)
    : await planAdvanced(input, attempts)
  return {
    ...plan,
    estimateBdt: toBdt(plan.estimateUsd),
  }
}
