import { createHash } from 'crypto'
import {
  buildImageActionQuote,
  imageModelCompatibility,
  imageModelLabel,
  imageUnitPriceUsd,
  normalizeImageActionCount,
  normalizeImageActionPipelineMode,
  normalizeImageActionQuality,
  normalizeImageActionSize,
  type ImageActionPipelineMode,
  type ImageActionQuality,
  type ImageActionQuote,
  type ImageActionSize,
  type ImageModelAvailability,
  type ImageModelOption,
} from '@/agent/lib/image-action-contract'
import {
  GENERIC_IMAGE_MODELS,
  genericImageProvider,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'

/**
 * v2 professional image setup for the approval card.
 *
 * The owner edits a semantic selection — preset (composition shape), tier
 * (1K/2K/4K), quality, count, model — and the SERVER resolves it into the
 * exact pixels the worker will demand from the provider. The dimension tables
 * below are a byte-for-byte mirror of the worker's audited
 * `image-resolution-contract.mjs`; the card may only promise what the worker
 * will actually verify against decoded bytes.
 */

export const IMAGE_RENDER_CONTRACT_VERSION = 2 as const
export const IMAGE_CONTROLS_V2_KV_KEY = 'agent_image_controls_v2'

export const IMAGE_PRESETS = [
  { id: 'square', label: 'Square', aspectRatio: '1:1' },
  { id: 'social_post', label: 'Facebook / Instagram post', aspectRatio: '4:5' },
  { id: 'reel_story', label: 'Reel / Story', aspectRatio: '9:16' },
  { id: 'landscape', label: 'Landscape / banner', aspectRatio: '16:9' },
] as const

export type ImagePresetId = typeof IMAGE_PRESETS[number]['id']
export type ImageAspectRatio = typeof IMAGE_PRESETS[number]['aspectRatio']

const PRESET_BY_ID = new Map(IMAGE_PRESETS.map((preset) => [preset.id, preset]))
const PRESET_BY_ASPECT = new Map(IMAGE_PRESETS.map((preset) => [preset.aspectRatio, preset]))

type DimensionTable = Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>>

// Mirror of worker/src/image-resolution-contract.mjs — the worker's exact
// request AND decoded-byte validation target. Change these only together.
const GEMINI_DIMENSIONS: DimensionTable = {
  '1K': { '1:1': [1024, 1024], '4:5': [928, 1152], '9:16': [768, 1376], '16:9': [1376, 768] },
  '2K': { '1:1': [2048, 2048], '4:5': [1856, 2304], '9:16': [1536, 2752], '16:9': [2752, 1536] },
  '4K': { '1:1': [4096, 4096], '4:5': [3712, 4608], '9:16': [3072, 5504], '16:9': [5504, 3072] },
}

const GPT_IMAGE_DIMENSIONS: DimensionTable = {
  '1K': GEMINI_DIMENSIONS['1K'],
  '2K': GEMINI_DIMENSIONS['2K'],
  '4K': { '9:16': [2160, 3840], '16:9': [3840, 2160] },
}

const SEEDREAM_DIMENSIONS: DimensionTable = {
  '1K': GEMINI_DIMENSIONS['1K'],
  '2K': { '1:1': [2048, 2048], '4:5': [1824, 2272], '9:16': [1536, 2720], '16:9': [2720, 1536] },
}

function dimensionTable(model: GenericImageModel): DimensionTable {
  if (model === 'gpt-image-2') return GPT_IMAGE_DIMENSIONS
  if (model === 'seedream-5.0-pro') return SEEDREAM_DIMENSIONS
  return GEMINI_DIMENSIONS
}

/** GPT Image 2's vendor quality ladder differs from ALMA's two-step one. */
function providerQuality(model: GenericImageModel, quality: ImageActionQuality): string {
  if (model === 'gpt-image-2') return quality === 'standard' ? 'medium' : 'high'
  return quality
}

export type ImageRenderConfig = {
  version: 1
  presetId: ImagePresetId
  sizeMode: 'tier'
  aspectRatio: ImageAspectRatio
  imageSize: ImageActionSize
  width: number
  height: number
  quality: ImageActionQuality
  providerQuality: string
  variationCount: number
  pipelineMode: ImageActionPipelineMode
  model: GenericImageModel
}

export function normalizeImagePresetId(value: unknown, fallbackAspect?: unknown): ImagePresetId {
  if (typeof value === 'string' && PRESET_BY_ID.has(value as ImagePresetId)) {
    return value as ImagePresetId
  }
  if (typeof fallbackAspect === 'string' && PRESET_BY_ASPECT.has(fallbackAspect as ImageAspectRatio)) {
    return PRESET_BY_ASPECT.get(fallbackAspect as ImageAspectRatio)!.id
  }
  return 'social_post'
}

export function resolveImageRenderConfig(input: {
  model: GenericImageModel
  presetId: ImagePresetId
  imageSize: ImageActionSize
  quality: ImageActionQuality
  variationCount: number
  pipelineMode: ImageActionPipelineMode
}): ImageRenderConfig {
  const preset = PRESET_BY_ID.get(input.presetId)
  if (!preset) throw new Error(`image_config_invalid:unknown preset ${input.presetId}`)
  const compatibility = imageModelCompatibility(input.model, input.imageSize, preset.aspectRatio)
  if (!compatibility.enabled) throw new Error(`image_config_invalid:${compatibility.reason}`)
  const dimensions = dimensionTable(input.model)[input.imageSize]?.[preset.aspectRatio]
  if (!dimensions) {
    throw new Error(
      `image_config_invalid:${imageModelLabel(input.model)} does not render ${input.imageSize} at ${preset.aspectRatio}`,
    )
  }
  return {
    version: 1,
    presetId: preset.id,
    sizeMode: 'tier',
    aspectRatio: preset.aspectRatio,
    imageSize: input.imageSize,
    width: dimensions[0],
    height: dimensions[1],
    quality: input.quality,
    providerQuality: providerQuality(input.model, input.quality),
    variationCount: normalizeImageActionCount(input.variationCount),
    pipelineMode: input.pipelineMode,
    model: input.model,
  }
}

/**
 * Stable identity of the complete render selection. Key order is fixed here,
 * never by the caller, so equal configs always hash equal.
 */
export function imageRenderConfigFingerprint(config: ImageRenderConfig): string {
  const canonical = [
    config.version, config.model, config.presetId, config.aspectRatio,
    config.imageSize, config.width, config.height, config.quality,
    config.providerQuality, config.variationCount, config.pipelineMode,
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export type ImageRenderQuoteV2 = ImageActionQuote & {
  renderVersion: typeof IMAGE_RENDER_CONTRACT_VERSION
  presetId: ImagePresetId
  aspectRatio: ImageAspectRatio
  width: number
  height: number
  providerQuality: string
  configFingerprint: string
}

export function buildImageRenderQuote(config: ImageRenderConfig): ImageRenderQuoteV2 {
  const base = buildImageActionQuote({
    model: config.model,
    quality: config.quality,
    imageSize: config.imageSize,
    requestedImages: config.variationCount,
    pipelineMode: config.pipelineMode,
    aspectRatio: config.aspectRatio,
  })
  return {
    ...base,
    renderVersion: IMAGE_RENDER_CONTRACT_VERSION,
    presetId: config.presetId,
    aspectRatio: config.aspectRatio,
    width: config.width,
    height: config.height,
    providerQuality: config.providerQuality,
    configFingerprint: imageRenderConfigFingerprint(config),
  }
}

export type ImageRenderPresetOption = {
  id: ImagePresetId
  label: string
  aspectRatio: ImageAspectRatio
  enabled: boolean
  unavailableReason?: string
}

export type ImageRenderSizeOption = {
  id: ImageActionSize
  enabled: boolean
  width?: number
  height?: number
  unavailableReason?: string
}

export type ImageRenderSelection = {
  contractVersion: typeof IMAGE_RENDER_CONTRACT_VERSION
  revision: number
  selectedModel: GenericImageModel
  config: ImageRenderConfig
  modelOptions: ImageModelOption[]
  presetOptions: ImageRenderPresetOption[]
  sizeOptions: ImageRenderSizeOption[]
  qualityOptions: ImageActionQuality[]
  countOptions: number[]
  quote: ImageRenderQuoteV2
}

/**
 * The authoritative v2 projection: identical through live SSE, cold history,
 * list/detail and the edit echo. Every option is computed against the SAME
 * pending config so a disabled combination shows its reason instead of
 * disappearing.
 */
export function buildImageRenderSelection(input: {
  config: ImageRenderConfig
  revision: number
  availability?: ImageModelAvailability
}): ImageRenderSelection {
  const { config } = input
  const modelOptions: ImageModelOption[] = GENERIC_IMAGE_MODELS.map((model) => {
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
    try {
      const candidate = resolveImageRenderConfig({ ...config, model, presetId: config.presetId })
      return {
        id: model,
        label: imageModelLabel(model),
        provider: genericImageProvider(model),
        enabled: true,
        quote: buildImageRenderQuote(candidate),
      }
    } catch (error) {
      return {
        id: model,
        label: imageModelLabel(model),
        provider: genericImageProvider(model),
        enabled: false,
        unavailableReason: reasonOf(error),
      }
    }
  })
  const presetOptions: ImageRenderPresetOption[] = IMAGE_PRESETS.map((preset) => {
    try {
      resolveImageRenderConfig({ ...config, presetId: preset.id })
      return { id: preset.id, label: preset.label, aspectRatio: preset.aspectRatio, enabled: true }
    } catch (error) {
      return {
        id: preset.id,
        label: preset.label,
        aspectRatio: preset.aspectRatio,
        enabled: false,
        unavailableReason: reasonOf(error),
      }
    }
  })
  const sizeOptions: ImageRenderSizeOption[] = (['1K', '2K', '4K'] as const).map((size) => {
    try {
      const candidate = resolveImageRenderConfig({ ...config, imageSize: size })
      return { id: size, enabled: true, width: candidate.width, height: candidate.height }
    } catch (error) {
      return { id: size, enabled: false, unavailableReason: reasonOf(error) }
    }
  })
  return {
    contractVersion: IMAGE_RENDER_CONTRACT_VERSION,
    revision: input.revision,
    selectedModel: config.model,
    config,
    modelOptions,
    presetOptions,
    sizeOptions,
    qualityOptions: ['standard', 'pro'],
    countOptions: [1, 2, 3, 4],
    quote: buildImageRenderQuote(config),
  }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^image_(config_invalid|model_incompatible):/, '')
}

/**
 * Read the canonical config off a persisted action row, falling back to the
 * v1 payload mirror for rows staged before this contract existed. Returns
 * null only when the payload cannot describe a renderable selection at all.
 */
export function imageRenderConfigForAction(action: {
  imageModel?: string | null
  imageConfig?: unknown
  payload: unknown
}): ImageRenderConfig | null {
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload as Record<string, unknown>
    : {}
  const model = typeof action.imageModel === 'string'
    && GENERIC_IMAGE_MODELS.includes(action.imageModel as GenericImageModel)
    ? action.imageModel as GenericImageModel
    : null
  if (!model) return null
  const stored = action.imageConfig
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const candidate = stored as Partial<ImageRenderConfig>
    try {
      const resolved = resolveImageRenderConfig({
        model,
        presetId: normalizeImagePresetId(candidate.presetId, candidate.aspectRatio),
        imageSize: normalizeImageActionSize(candidate.imageSize),
        quality: normalizeImageActionQuality(candidate.quality),
        variationCount: normalizeImageActionCount(candidate.variationCount),
        pipelineMode: normalizeImageActionPipelineMode(candidate.pipelineMode),
      })
      return resolved
    } catch { return null }
  }
  try {
    return resolveImageRenderConfig({
      model,
      presetId: normalizeImagePresetId(undefined, payload.aspectRatio),
      imageSize: normalizeImageActionSize(payload.imageSize),
      quality: normalizeImageActionQuality(payload.quality),
      variationCount: normalizeImageActionCount(payload.variationCount),
      pipelineMode: normalizeImageActionPipelineMode(payload.pipelineMode),
    })
  } catch { return null }
}

/**
 * The payload mirror the worker renders from. Written in the SAME row update
 * as the canonical config — one write, one truth, no second mutable source.
 */
export function imageRenderPayloadMirror(
  payload: Record<string, unknown>,
  config: ImageRenderConfig,
): Record<string, unknown> {
  return {
    ...payload,
    quality: config.quality,
    imageSize: config.imageSize,
    aspectRatio: config.aspectRatio,
    variationCount: config.variationCount,
    pipelineMode: config.pipelineMode,
  }
}

/** Approval must refuse a row whose mirror and canonical config diverge. */
export function imageRenderMirrorMatches(
  payload: unknown,
  config: ImageRenderConfig,
): boolean {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  return normalizeImageActionQuality(value.quality) === config.quality
    && normalizeImageActionSize(value.imageSize) === config.imageSize
    && (value.aspectRatio ?? '4:5') === config.aspectRatio
    && normalizeImageActionCount(value.variationCount) === config.variationCount
    && normalizeImageActionPipelineMode(value.pipelineMode) === config.pipelineMode
}

/** Quote drift guard for v2 rows, the aspect-aware sibling of the v1 check. */
export function isImageRenderQuoteForConfig(value: unknown, config: ImageRenderConfig): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const quote = value as Partial<ImageRenderQuoteV2>
  return quote.renderVersion === IMAGE_RENDER_CONTRACT_VERSION
    && quote.configFingerprint === imageRenderConfigFingerprint(config)
    && quote.model === config.model
    && quote.aspectRatio === config.aspectRatio
    && quote.width === config.width
    && quote.height === config.height
    && quote.requestedImages === config.variationCount
    && quote.unitPriceUsd === imageUnitPriceUsd(config.model, config.quality, config.imageSize)
}
