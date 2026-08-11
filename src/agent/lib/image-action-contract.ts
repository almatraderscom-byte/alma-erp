import {
  DEFAULT_GENERIC_IMAGE_MODELS,
  GENERIC_IMAGE_MODELS,
  genericImageProvider,
  normalizeGenericImageModels,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'

export const IMAGE_ACTION_QUOTE_VERSION = 1 as const

export type ImageActionQuality = 'standard' | 'pro'
export type ImageActionSize = '1K' | '2K' | '4K'
export type ImageActionPipelineMode = 'preview' | 'production'

export type ImageActionQuote = {
  version: typeof IMAGE_ACTION_QUOTE_VERSION
  currency: 'USD'
  kind: 'provider_render_estimate'
  model: GenericImageModel
  provider: 'gemini' | 'openai' | 'fal'
  quality: ImageActionQuality
  imageSize: ImageActionSize
  requestedImages: number
  unitPriceUsd: number
  minCostUsd: number
  maxCostUsd: number
  maxPaidGenerationsPerImage: number
  pricingBasis: 'internal_list_estimate'
  pricingLastVerifiedAt: string
  excludes: readonly ['qc_vision', 'taxes', 'provider_credits']
}

export type ImageModelOption = {
  id: string
  label: string
  provider: 'gemini' | 'openai' | 'fal' | 'xai'
  enabled: boolean
  unavailableReason?: string
  quote?: ImageActionQuote
}

export type ImageModelSelection = {
  selectedModel: GenericImageModel
  options: ImageModelOption[]
  quote: ImageActionQuote
}

export type ImageModelAvailability = Partial<Record<string, string | null>>
export const IMAGE_WORKER_CAPABILITY_KV_KEY = 'image_worker_capabilities_v1'
export const IMAGE_WORKER_CAPABILITY_VERSION = 1 as const
export const IMAGE_WORKER_CAPABILITY_SOURCE = 'alma-agent-worker' as const
export const IMAGE_WORKER_CAPABILITY_MAX_AGE_MS = 3 * 60_000
export const IMAGE_WORKER_CAPABILITY_MAX_FUTURE_SKEW_MS = 60_000

export type ImageWorkerCapabilityReceipt = {
  version: typeof IMAGE_WORKER_CAPABILITY_VERSION
  source: typeof IMAGE_WORKER_CAPABILITY_SOURCE
  updatedAt: string
  models: GenericImageModel[]
}

const MODEL_LABELS: Readonly<Record<GenericImageModel, string>> = {
  'gemini-3.1-flash-image': 'Nano Banana 2',
  'gemini-3-pro-image': 'Nano Banana Pro',
  'gpt-image-2': 'GPT Image 2',
  'seedream-5.0-pro': 'Seedream 5 Pro',
}

const VERIFIED_AT: Readonly<Record<GenericImageModel, string>> = {
  'gemini-3.1-flash-image': '2026-06-15',
  'gemini-3-pro-image': '2026-06-15',
  'gpt-image-2': '2026-07-12',
  'seedream-5.0-pro': '2026-07-12',
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function normalizeImageActionQuality(value: unknown): ImageActionQuality {
  return value === 'standard' ? 'standard' : 'pro'
}

export function normalizeImageActionSize(value: unknown): ImageActionSize {
  return value === '1K' || value === '4K' ? value : '2K'
}

export function normalizeImageActionCount(value: unknown): number {
  return Math.min(4, Math.max(1, Math.floor(Number(value) || 1)))
}

export function normalizeImageActionPipelineMode(value: unknown): ImageActionPipelineMode {
  return value === 'production' ? 'production' : 'preview'
}

export function normalizeImageActionModel(
  value: unknown,
  quality: ImageActionQuality,
  configuredModels?: string | null,
): GenericImageModel {
  if (typeof value === 'string' && GENERIC_IMAGE_MODELS.includes(value as GenericImageModel)) {
    return value as GenericImageModel
  }
  const configured = normalizeGenericImageModels(configuredModels)
  return configured[quality] ?? DEFAULT_GENERIC_IMAGE_MODELS[quality]
}

export function imageModelLabel(model: GenericImageModel): string {
  return MODEL_LABELS[model]
}

/**
 * Mirrors the worker's audited provider request constraints. Unsupported
 * combinations fail before an owner can select them; no silent size/aspect
 * downgrade is allowed.
 */
export function imageModelCompatibility(
  model: GenericImageModel,
  imageSize: ImageActionSize,
  aspectRatio: unknown,
): { enabled: true } | { enabled: false; reason: string } {
  const aspect = typeof aspectRatio === 'string' && aspectRatio ? aspectRatio : '4:5'
  if (!['1:1', '4:5', '9:16', '16:9'].includes(aspect)) {
    return { enabled: false, reason: `Unsupported aspect ratio: ${aspect}` }
  }
  if (model === 'seedream-5.0-pro' && imageSize === '4K') {
    return { enabled: false, reason: 'Seedream 5 Pro supports this chat lane up to 2K.' }
  }
  if (model === 'gpt-image-2' && imageSize === '4K' && aspect !== '9:16' && aspect !== '16:9') {
    return { enabled: false, reason: 'GPT Image 2 supports 4K here only at 9:16 or 16:9.' }
  }
  return { enabled: true }
}

export function imageUnitPriceUsd(
  model: GenericImageModel,
  quality: ImageActionQuality,
  imageSize: ImageActionSize,
): number {
  if (model === 'gemini-3.1-flash-image') {
    return imageSize === '1K' ? 0.067 : imageSize === '4K' ? 0.151 : 0.101
  }
  if (model === 'gemini-3-pro-image') {
    return imageSize === '4K' ? 0.24 : 0.134
  }
  if (model === 'gpt-image-2') {
    return quality === 'standard' ? 0.05 : 0.19
  }
  return imageSize === '1K' ? 0.0675 : 0.135
}

export function buildImageActionQuote(input: {
  model: GenericImageModel
  quality: ImageActionQuality
  imageSize: ImageActionSize
  requestedImages: number
  pipelineMode: ImageActionPipelineMode
  aspectRatio?: unknown
}): ImageActionQuote {
  const compatibility = imageModelCompatibility(input.model, input.imageSize, input.aspectRatio)
  if (!compatibility.enabled) throw new Error(`image_model_incompatible:${compatibility.reason}`)
  const requestedImages = normalizeImageActionCount(input.requestedImages)
  const maxPaidGenerationsPerImage = input.pipelineMode === 'production' ? 3 : 1
  const unitPriceUsd = imageUnitPriceUsd(input.model, input.quality, input.imageSize)
  return {
    version: IMAGE_ACTION_QUOTE_VERSION,
    currency: 'USD',
    kind: 'provider_render_estimate',
    model: input.model,
    provider: genericImageProvider(input.model),
    quality: input.quality,
    imageSize: input.imageSize,
    requestedImages,
    unitPriceUsd,
    minCostUsd: roundUsd(unitPriceUsd * requestedImages),
    maxCostUsd: roundUsd(unitPriceUsd * requestedImages * maxPaidGenerationsPerImage),
    maxPaidGenerationsPerImage,
    pricingBasis: 'internal_list_estimate',
    pricingLastVerifiedAt: VERIFIED_AT[input.model],
    excludes: ['qc_vision', 'taxes', 'provider_credits'],
  }
}

export function buildImageModelSelection(input: {
  selectedModel: GenericImageModel
  quality: ImageActionQuality
  imageSize: ImageActionSize
  requestedImages: number
  pipelineMode: ImageActionPipelineMode
  aspectRatio?: unknown
  availability?: ImageModelAvailability
  requireSelectedEnabled?: boolean
}): ImageModelSelection {
  const options: ImageModelOption[] = GENERIC_IMAGE_MODELS.map((model): ImageModelOption => {
    const compatibility = imageModelCompatibility(model, input.imageSize, input.aspectRatio)
    if (!compatibility.enabled) {
      return {
        id: model,
        label: imageModelLabel(model),
        provider: genericImageProvider(model),
        enabled: false,
        unavailableReason: compatibility.reason,
      }
    }
    const unavailableReason = input.availability?.[model]
    if (typeof unavailableReason === 'string' && unavailableReason) {
      return {
        id: model,
        label: imageModelLabel(model),
        provider: genericImageProvider(model),
        enabled: false,
        unavailableReason,
      }
    }
    return {
      id: model,
      label: imageModelLabel(model),
      provider: genericImageProvider(model),
      enabled: true,
      quote: buildImageActionQuote({ ...input, model }),
    }
  })
  if (Object.prototype.hasOwnProperty.call(input.availability ?? {}, 'grok-imagine-image-quality')) {
    options.push({
      id: 'grok-imagine-image-quality',
      label: 'Grok Imagine',
      provider: 'xai',
      enabled: false,
      unavailableReason: input.availability?.['grok-imagine-image-quality']
        ?? 'Grok is configured for Creative Studio, but this adjacent multi-image chat contract cannot safely route it yet.',
    })
  }
  const selected = options.find((option) => option.id === input.selectedModel)
  if (!selected?.enabled || !selected.quote) {
    if (input.requireSelectedEnabled !== false) {
      throw new Error(`image_model_incompatible:${selected?.unavailableReason ?? input.selectedModel}`)
    }
    // Read-only history must retain the pinned model/quote even if an owner kill
    // switch or missing credential makes that same model unavailable *now*.
    return {
      selectedModel: input.selectedModel,
      options,
      quote: buildImageActionQuote({ ...input, model: input.selectedModel }),
    }
  }
  return { selectedModel: input.selectedModel, options, quote: selected.quote }
}

export function chooseAvailableImageModel(input: {
  preferredModel: GenericImageModel
  quality: ImageActionQuality
  imageSize: ImageActionSize
  requestedImages: number
  pipelineMode: ImageActionPipelineMode
  aspectRatio?: unknown
  availability?: ImageModelAvailability
}): ImageModelSelection {
  const candidates = [
    input.preferredModel,
    ...GENERIC_IMAGE_MODELS.filter((model) => model !== input.preferredModel),
  ]
  for (const selectedModel of candidates) {
    try {
      return buildImageModelSelection({ ...input, selectedModel })
    } catch {
      // Try the next audited model; the returned selection still shows why
      // unavailable/incompatible choices are disabled.
    }
  }
  throw new Error('no_runnable_image_model')
}

export function imageActionInputs(payload: unknown): {
  quality: ImageActionQuality
  imageSize: ImageActionSize
  requestedImages: number
  pipelineMode: ImageActionPipelineMode
  aspectRatio?: unknown
} {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  return {
    quality: normalizeImageActionQuality(value.quality),
    imageSize: normalizeImageActionSize(value.imageSize),
    requestedImages: normalizeImageActionCount(value.variationCount),
    pipelineMode: normalizeImageActionPipelineMode(value.pipelineMode),
    aspectRatio: value.aspectRatio,
  }
}

/**
 * A persisted estimate is safe to show/approve only when it describes the
 * exact immutable render inputs that will be queued.  Checking just `model`
 * is insufficient: an old quote can otherwise survive a variation-count,
 * quality, or resolution edit and understate the owner-visible ceiling.
 */
export function isImageActionQuoteForInputs(
  value: unknown,
  input: {
    model: GenericImageModel
    quality: ImageActionQuality
    imageSize: ImageActionSize
    requestedImages: number
    pipelineMode: ImageActionPipelineMode
  },
): value is ImageActionQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const quote = value as Partial<ImageActionQuote>
  const expectedMaxPaidGenerations = input.pipelineMode === 'production' ? 3 : 1
  const expectedUnitPrice = imageUnitPriceUsd(input.model, input.quality, input.imageSize)
  const requestedImages = normalizeImageActionCount(input.requestedImages)
  return quote.version === IMAGE_ACTION_QUOTE_VERSION
    && quote.currency === 'USD'
    && quote.kind === 'provider_render_estimate'
    && quote.model === input.model
    && quote.provider === genericImageProvider(input.model)
    && quote.quality === input.quality
    && quote.imageSize === input.imageSize
    && quote.requestedImages === requestedImages
    && quote.maxPaidGenerationsPerImage === expectedMaxPaidGenerations
    && quote.unitPriceUsd === expectedUnitPrice
    && quote.minCostUsd === roundUsd(expectedUnitPrice * requestedImages)
    && quote.maxCostUsd === roundUsd(
      expectedUnitPrice * requestedImages * expectedMaxPaidGenerations,
    )
    && quote.pricingBasis === 'internal_list_estimate'
}

export function selectionForImageAction(action: {
  type: string
  payload: unknown
  imageModel?: string | null
  imageQuote?: unknown
  availability?: ImageModelAvailability
}): ImageModelSelection | null {
  if (action.type !== 'image_gen') return null
  // Null means this is a legacy/unpinned card. Do not synthesize a committed
  // picker/quote from mutable configuration: approve atomically pins it before
  // queueing, while historical cards remain honest about lacking that receipt.
  if (typeof action.imageModel !== 'string' || !action.imageModel) return null
  const inputs = imageActionInputs(action.payload)
  const model = normalizeImageActionModel(action.imageModel, inputs.quality)
  try {
    const selection = buildImageModelSelection({
      selectedModel: model,
      ...inputs,
      availability: action.availability,
      requireSelectedEnabled: false,
    })
    if (isImageActionQuoteForInputs(action.imageQuote, { model, ...inputs })) {
      const quote = action.imageQuote
      selection.quote = quote
      const selected = selection.options.find((option) => option.id === model)
      if (selected?.enabled) selected.quote = quote
    }
    return selection
  } catch {
    return null
  }
}

function readImageWorkerCapabilityModels(
  raw: string | null | undefined,
  nowMs: number,
): { models: Set<GenericImageModel> | null; reason: string } {
  if (!raw) {
    return {
      models: null,
      reason: 'Image worker capability receipt is missing.',
    }
  }
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    parsed = value as Record<string, unknown>
  } catch {
    return {
      models: null,
      reason: 'Image worker capability receipt is invalid.',
    }
  }
  if (
    parsed.version !== IMAGE_WORKER_CAPABILITY_VERSION
    || parsed.source !== IMAGE_WORKER_CAPABILITY_SOURCE
  ) {
    return {
      models: null,
      reason: 'Image worker capability receipt does not match this server contract.',
    }
  }
  const updatedAt = typeof parsed.updatedAt === 'string'
    ? Date.parse(parsed.updatedAt)
    : Number.NaN
  const ageMs = nowMs - updatedAt
  if (
    !Number.isFinite(updatedAt)
    || ageMs > IMAGE_WORKER_CAPABILITY_MAX_AGE_MS
    || ageMs < -IMAGE_WORKER_CAPABILITY_MAX_FUTURE_SKEW_MS
  ) {
    return {
      models: null,
      reason: 'Image worker capability receipt is stale.',
    }
  }
  if (!Array.isArray(parsed.models)) {
    return {
      models: null,
      reason: 'Image worker capability receipt does not match this server contract.',
    }
  }
  const models = parsed.models
  if (
    models.some((model) => (
      typeof model !== 'string'
      || !GENERIC_IMAGE_MODELS.includes(model as GenericImageModel)
    ))
    || new Set(models).size !== models.length
  ) {
    return {
      models: null,
      reason: 'Image worker capability receipt does not match this server contract.',
    }
  }
  return {
    models: new Set(models as GenericImageModel[]),
    reason: 'This model is not configured on the active image worker.',
  }
}

/**
 * Server processes do not own the VPS provider secrets, so mutable tier config
 * and Vercel env can never prove executability. Only a fresh worker receipt can
 * enable a new selection/approval; missing, stale, or mismatched receipts fail
 * closed. Read-only pinned history passes this availability to
 * selectionForImageAction, which deliberately retains the pinned quote/model.
 */
export function imageModelAvailability(input: {
  workerCapabilities: string | null | undefined
  nowMs?: number
  genericLaneKilled?: boolean
  xaiConfigured?: boolean
}): ImageModelAvailability {
  const receipt = readImageWorkerCapabilityModels(
    input.workerCapabilities,
    input.nowMs ?? Date.now(),
  )
  const availability = Object.fromEntries(GENERIC_IMAGE_MODELS.map((model) => [
    model,
    receipt.models?.has(model) ? null : receipt.reason,
  ])) as ImageModelAvailability
  if (input.genericLaneKilled) {
    for (const model of GENERIC_IMAGE_MODELS) {
      availability[model] = 'Image generation is disabled by the owner kill switch.'
    }
  }
  if (input.xaiConfigured) {
    availability['grok-imagine-image-quality'] =
      'Grok is configured for Creative Studio, but this chat card cannot preserve its multi-variation/reference contract yet.'
  }
  return availability
}

export function buildImageActionSummary(input: {
  prompt: unknown
  quality: ImageActionQuality
  count: number
  model: GenericImageModel
}): string {
  return (
    `Image generation request (${input.quality} quality${input.count > 1 ? `, ${input.count} variations` : ''})\n` +
    `Model: ${imageModelLabel(input.model)}\n` +
    `Prompt: ${String(input.prompt).slice(0, 200)}`
  )
}
