import type { StudioModeId } from './constants'
import type { StudioEngineId } from './provider-registry'

export type StudioReferenceRole = 'product' | 'person' | 'source' | 'identity_sheet' | 'mask'
export type StudioReferenceSource = 'uploaded' | 'saved_model' | 'derived'
export type StudioFidelityClass = 'purpose_built' | 'identity_guided' | 'unsupported'

export type StudioReferenceBinding = {
  role: StudioReferenceRole
  path: string
  source: StudioReferenceSource
  sourceId?: string
  required: boolean
}

export type StudioReferenceContract = {
  version: 1
  mode: StudioModeId
  requestedEngine: StudioEngineId
  actualModel: string
  bindings: StudioReferenceBinding[]
}

export type AdvancedModeCapability = {
  fidelity: StudioFidelityClass
  required: StudioReferenceRole[]
  optional?: StudioReferenceRole[]
  maxReferences: number
  limitationBn?: string
}

export type AdvancedEngineCapability = {
  engine: StudioEngineId
  actualModels: readonly string[]
  modes: Partial<Record<StudioModeId, AdvancedModeCapability>>
}

const PURPOSE_BUILT_TRY_ON: AdvancedModeCapability = {
  fidelity: 'purpose_built',
  required: ['person', 'product'],
  maxReferences: 2,
}

const GENERAL_TWO_REF: AdvancedModeCapability = {
  fidelity: 'identity_guided',
  required: ['product'],
  optional: ['person'],
  maxReferences: 2,
  limitationBn: 'সাধারণ multi-image edit — রেফারেন্স পাঠানো হবে, তবে pixel-exact পরিচয়/পোশাক গ্যারান্টি নয়।',
}

export const GENERIC_IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gpt-image-2',
  'seedream-5.0-pro',
] as const

export type GenericImageModel = (typeof GENERIC_IMAGE_MODELS)[number]

export const DEFAULT_GENERIC_IMAGE_MODELS: Readonly<Record<'standard' | 'pro', GenericImageModel>> = {
  standard: 'gemini-3.1-flash-image',
  pro: 'gemini-3-pro-image',
}

export const ADVANCED_ENGINE_CAPABILITIES: readonly AdvancedEngineCapability[] = [
  {
    engine: 'fashn',
    actualModels: ['product-to-model', 'tryon-max', 'model-swap', 'face-to-model', 'edit'],
    modes: {
      product_to_model: {
        fidelity: 'purpose_built',
        required: ['product'],
        optional: ['person'],
        maxReferences: 2,
        limitationBn: 'নতুন pose/background তৈরি হবে; বাছাই করা ব্যক্তির পরিচয় face reference হিসেবে ব্যবহৃত হবে। একই pose রাখতে Try-On নিন।',
      },
      try_on: PURPOSE_BUILT_TRY_ON,
      model_swap: {
        fidelity: 'purpose_built',
        required: ['source', 'person'],
        maxReferences: 2,
      },
      face_to_model: {
        fidelity: 'purpose_built',
        required: ['person'],
        maxReferences: 1,
      },
      edit: {
        fidelity: 'purpose_built',
        required: ['source'],
        optional: ['product'],
        maxReferences: 2,
      },
    },
  },
  {
    engine: 'gemini',
    actualModels: GENERIC_IMAGE_MODELS,
    // Keep the owner-selected Gemini/GPT Image/Seedream lane narrower than
    // upstream model capability: Advanced exposes it only for the two
    // reference-guided modes below; Generate/swap/face/edit stay on their
    // explicitly modelled xAI/FASHN lanes instead of being inferred here.
    modes: {
      product_to_model: GENERAL_TWO_REF,
      try_on: { ...GENERAL_TWO_REF, required: ['person', 'product'], optional: undefined },
      image_to_video: {
        fidelity: 'identity_guided',
        required: ['source'],
        maxReferences: 1,
        limitationBn: 'Veo একটি source still গ্রহণ করে; আলাদা product/person pair গ্রহণ করে না।',
      },
    },
  },
  {
    engine: 'fal_fashn_v16',
    actualModels: ['fal-ai/fashn/tryon/v1.6'],
    modes: { try_on: PURPOSE_BUILT_TRY_ON },
  },
  {
    engine: 'fal_idm_vton',
    actualModels: ['fal-ai/cat-vton'],
    modes: { try_on: PURPOSE_BUILT_TRY_ON },
  },
  {
    engine: 'fal_flux_fill',
    actualModels: ['fal-ai/flux-pro/v1/fill'],
    modes: {
      edit: {
        fidelity: 'purpose_built',
        required: ['source', 'mask'],
        maxReferences: 2,
      },
    },
  },
  {
    engine: 'xai_imagine',
    actualModels: ['grok-imagine-image-quality', 'grok-imagine-image'],
    modes: {
      generate: { fidelity: 'identity_guided', required: [], maxReferences: 0 },
      product_to_model: {
        fidelity: 'identity_guided',
        required: ['product'],
        optional: ['person', 'identity_sheet'],
        maxReferences: 3,
        limitationBn: 'নির্বাচিত product/person ordered reference হিসেবে যাবে; Grok একটি general editor, dedicated Try-On নয়।',
      },
      try_on: {
        fidelity: 'identity_guided',
        required: ['person', 'product'],
        optional: ['identity_sheet'],
        maxReferences: 3,
        limitationBn: 'দুই reference স্পষ্টভাবে বাঁধা থাকবে; pixel-exact VTON গ্যারান্টি নয়।',
      },
      model_swap: {
        fidelity: 'identity_guided',
        required: ['source', 'person'],
        optional: ['identity_sheet'],
        maxReferences: 3,
      },
      face_to_model: {
        fidelity: 'identity_guided',
        required: ['person'],
        optional: ['identity_sheet'],
        maxReferences: 2,
      },
      edit: {
        fidelity: 'identity_guided',
        required: ['source'],
        optional: ['product'],
        maxReferences: 2,
      },
    },
  },
] as const

export function getAdvancedModeCapability(
  engine: StudioEngineId,
  mode: StudioModeId,
): AdvancedModeCapability | null {
  return ADVANCED_ENGINE_CAPABILITIES.find((item) => item.engine === engine)?.modes[mode] ?? null
}

export function assertAdvancedEngineMode(engine: StudioEngineId, mode: StudioModeId): AdvancedModeCapability {
  const capability = getAdvancedModeCapability(engine, mode)
  if (!capability) throw new Error(`engine_mode_unsupported:${engine}:${mode}`)
  return capability
}

export function normalizeGenericImageModels(raw: string | null | undefined): Record<'standard' | 'pro', GenericImageModel> {
  let parsed: { standard?: unknown; pro?: unknown } = {}
  try {
    parsed = raw ? JSON.parse(raw) as { standard?: unknown; pro?: unknown } : {}
  } catch {
    parsed = {}
  }
  const normalize = (value: unknown, fallback: GenericImageModel): GenericImageModel =>
    typeof value === 'string' && GENERIC_IMAGE_MODELS.includes(value as GenericImageModel)
      ? value as GenericImageModel
      : fallback
  return {
    standard: normalize(parsed.standard, DEFAULT_GENERIC_IMAGE_MODELS.standard),
    pro: normalize(parsed.pro, DEFAULT_GENERIC_IMAGE_MODELS.pro),
  }
}

export function genericImageProvider(model: string): 'gemini' | 'openai' | 'fal' {
  if (model.startsWith('gpt-image')) return 'openai'
  if (model.startsWith('seedream')) return 'fal'
  return 'gemini'
}

export function makeReferenceContract(input: {
  mode: StudioModeId
  requestedEngine: StudioEngineId
  actualModel: string
  bindings: StudioReferenceBinding[]
}): StudioReferenceContract {
  const capability = assertAdvancedEngineMode(input.requestedEngine, input.mode)
  const required = new Set(capability.required)
  const present = new Set(input.bindings.map((binding) => binding.role))
  for (const role of required) {
    if (!present.has(role)) throw new Error(`${role}_image_required`)
  }
  if (input.bindings.length > capability.maxReferences) {
    throw new Error(`reference_limit_exceeded:${input.requestedEngine}:${capability.maxReferences}`)
  }
  if (new Set(input.bindings.map((binding) => `${binding.role}:${binding.path}`)).size !== input.bindings.length) {
    throw new Error('duplicate_reference_binding')
  }
  return {
    version: 1,
    mode: input.mode,
    requestedEngine: input.requestedEngine,
    actualModel: input.actualModel,
    bindings: input.bindings.map((binding) => ({ ...binding, required: required.has(binding.role) || binding.required })),
  }
}

export function referenceSummary(contract: StudioReferenceContract): {
  expectedCount: number
  requiredRoles: StudioReferenceRole[]
} {
  return {
    expectedCount: contract.bindings.length,
    requiredRoles: contract.bindings.filter((binding) => binding.required).map((binding) => binding.role),
  }
}

/** Exact FASHN named inputs. Keeping this pure makes every Advanced mode
 * contract-testable without a provider call. */
export function buildDirectFashnInputs(input: {
  mode: StudioModeId
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
  faceReferencePath?: string
}): Record<string, string> {
  const person = input.faceReferencePath ?? input.modelImagePath
  switch (input.mode) {
    case 'product_to_model':
      if (!input.productImagePath) throw new Error('product_image_required')
      return {
        product_image: input.productImagePath,
        ...(person ? { face_reference: person, face_reference_mode: 'match_reference' } : {}),
      }
    case 'try_on':
      if (!input.productImagePath) throw new Error('product_image_required')
      if (!input.modelImagePath) throw new Error('model_image_required')
      return { product_image: input.productImagePath, model_image: input.modelImagePath }
    case 'model_swap':
      if (!input.sourceImagePath) throw new Error('source_image_required')
      if (!person) throw new Error('model_image_required')
      return {
        model_image: input.sourceImagePath,
        face_reference: person,
        face_reference_mode: 'match_reference',
      }
    case 'face_to_model':
      if (!person) throw new Error('model_image_required')
      return { face_image: person }
    case 'edit':
      if (!input.sourceImagePath) throw new Error('source_image_required')
      return {
        image: input.sourceImagePath,
        ...(input.productImagePath ? { image_context: input.productImagePath } : {}),
      }
    default:
      throw new Error(`engine_mode_unsupported:fashn:${input.mode}`)
  }
}

export function estimateDirectFashnCostUsd(input: {
  resolution?: '1k' | '2k' | '4k'
  generationMode?: 'fast' | 'balanced' | 'quality'
  hasFaceReference?: boolean
}): number {
  const resolution = input.resolution ?? '2k'
  const generationMode = input.generationMode ?? 'balanced'
  const baseCredits = {
    fast: { '1k': 1, '2k': 2, '4k': 3 },
    balanced: { '1k': 2, '2k': 3, '4k': 4 },
    quality: { '1k': 3, '2k': 4, '4k': 5 },
  }[generationMode][resolution]
  return (baseCredits + (input.hasFaceReference ? 3 : 0)) * 0.075
}

export function validateAdvancedControlValues(input: {
  mode: StudioModeId
  engine?: StudioEngineId
  aspectRatio?: string
  resolution?: string
  generationMode?: string
  numImages?: number
}): void {
  if (input.aspectRatio && !['4:5', '3:4', '1:1', '9:16', '16:9'].includes(input.aspectRatio)) {
    throw new Error(`aspect_ratio_unsupported:${input.aspectRatio}`)
  }
  if (input.resolution && !['1k', '2k', '4k'].includes(input.resolution)) {
    throw new Error(`resolution_unsupported:${input.resolution}`)
  }
  if (input.generationMode && !['fast', 'balanced', 'quality'].includes(input.generationMode)) {
    throw new Error(`generation_mode_unsupported:${input.generationMode}`)
  }
  if (input.numImages !== undefined && (!Number.isInteger(input.numImages) || input.numImages < 1 || input.numImages > 4)) {
    throw new Error(`num_images_unsupported:${input.numImages}`)
  }
  if (
    input.engine === 'fashn'
    && input.mode === 'face_to_model'
    && input.aspectRatio === '16:9'
  ) {
    throw new Error('aspect_ratio_unsupported:fashn:face_to_model:16:9')
  }
}
