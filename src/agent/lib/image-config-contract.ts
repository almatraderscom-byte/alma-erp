import { createHash } from 'crypto'
import {
  GENERIC_IMAGE_MODELS,
  genericImageProvider,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'
import {
  IMAGE_ACTION_QUOTE_VERSION,
  buildImageActionQuote,
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
} from '@/agent/lib/image-action-contract'

/**
 * Build 103 Issue 2 — canonical, revisioned image render configuration.
 *
 * The v1 contract (image-action-contract.ts) pins only the model + a quote
 * keyed on model/quality/size/count. This v2 contract adds the composition
 * shape (preset/aspect), the exact server-resolved generation dimensions, the
 * provider-specific quality mapping, and a fingerprint that binds the whole
 * selection, so a multi-field editor can compare-and-set atomically and the
 * worker can verify it received exactly what the owner approved.
 *
 * v1 stays fully operable: a card with `imageConfig == null` follows the
 * legacy path, and every v2 card also projects the v1 `imageModelSelection`
 * so an installed Build 102 keeps rendering/editing/approving.
 */

export const IMAGE_RENDER_CONTRACT_VERSION = 2 as const
export const IMAGE_RENDER_CONFIG_VERSION = 1 as const
export const IMAGE_RENDER_QUOTE_VERSION = 2 as const
export const AGENT_IMAGE_CONTROLS_V2_KV_KEY = 'agent_image_controls_v2'

export type ImagePresetId = 'square' | 'social_post' | 'reel_story' | 'landscape' | 'poster'

export const IMAGE_PRESETS: ReadonlyArray<{
  id: ImagePresetId
  label: string
  aspectRatio: string
}> = [
  { id: 'square', label: 'Square', aspectRatio: '1:1' },
  { id: 'social_post', label: 'Facebook / Instagram post', aspectRatio: '4:5' },
  { id: 'reel_story', label: 'Reel / Story', aspectRatio: '9:16' },
  { id: 'landscape', label: 'Landscape / banner', aspectRatio: '16:9' },
  { id: 'poster', label: 'Portrait poster', aspectRatio: '2:3' },
]

export function presetForAspect(aspectRatio: unknown): ImagePresetId | null {
  const preset = IMAGE_PRESETS.find((p) => p.aspectRatio === aspectRatio)
  return preset?.id ?? null
}

export function aspectForPreset(presetId: unknown): string | null {
  const preset = IMAGE_PRESETS.find((p) => p.id === presetId)
  return preset?.aspectRatio ?? null
}

/**
 * Server mirror of the worker's audited exact-dimension tables
 * (worker/src/image-resolution-contract.mjs). A parity test keeps both sides
 * identical; the worker re-derives and verifies before any provider spend, so
 * a drifted server value fails closed instead of rendering the wrong size.
 */
const GEMINI_DIMENSIONS: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  '1K': {
    '1:1': [1024, 1024], '4:5': [928, 1152], '9:16': [768, 1376], '16:9': [1376, 768],
    '2:3': [832, 1248],
  },
  '2K': {
    '1:1': [2048, 2048], '4:5': [1856, 2304], '9:16': [1536, 2752], '16:9': [2752, 1536],
    '2:3': [1664, 2496],
  },
  '4K': {
    '1:1': [4096, 4096], '4:5': [3712, 4608], '9:16': [3072, 5504], '16:9': [5504, 3072],
    '2:3': [3328, 4992],
  },
}

const GPT_IMAGE_DIMENSIONS: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  '1K': GEMINI_DIMENSIONS['1K'],
  '2K': GEMINI_DIMENSIONS['2K'],
  '4K': { '9:16': [2160, 3840], '16:9': [3840, 2160] },
}

const SEEDREAM_DIMENSIONS: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  '1K': GEMINI_DIMENSIONS['1K'],
  '2K': {
    '1:1': [2048, 2048], '4:5': [1824, 2272], '9:16': [1536, 2720], '16:9': [2720, 1536],
    '2:3': [1664, 2496],
  },
}

function dimensionTableFor(model: GenericImageModel) {
  if (model === 'gpt-image-2') return GPT_IMAGE_DIMENSIONS
  if (model === 'seedream-5.0-pro') return SEEDREAM_DIMENSIONS
  return GEMINI_DIMENSIONS
}

/**
 * Exact generation dimensions for model × tier × aspect, or a reason string.
 * The server — never Swift — derives these; the mobile app only displays them.
 */
export function resolveImageDimensions(
  model: GenericImageModel,
  imageSize: ImageActionSize,
  aspectRatio: string,
): { width: number; height: number } | { unavailableReason: string } {
  const table = dimensionTableFor(model)
  const dims = table[imageSize]?.[aspectRatio]
  if (!dims) {
    return {
      unavailableReason:
        `${imageModelLabel(model)} does not support ${imageSize} at ${aspectRatio}.`,
    }
  }
  return { width: dims[0], height: dims[1] }
}

/** Provider-specific meaning of ALMA's owner-facing standard/pro switch. */
export function providerQualityFor(
  model: GenericImageModel,
  quality: ImageActionQuality,
): { providerQuality: string | null; description: string } {
  if (model === 'gpt-image-2') {
    return {
      providerQuality: quality === 'pro' ? 'high' : 'medium',
      description: quality === 'pro'
        ? 'OpenAI quality high — বেশি output token, বেশি খরচ'
        : 'OpenAI quality medium — দ্রুত ও সাশ্রয়ী',
    }
  }
  // Gemini and Seedream have no separate vendor quality switch on this lane —
  // the tier/dimensions decide the output. Never imply a knob that isn't sent.
  return {
    providerQuality: null,
    description: 'এই মডেলে আলাদা quality switch নেই — resolution tier-ই মান নির্ধারণ করে',
  }
}

export type ImageRenderConfig = {
  version: typeof IMAGE_RENDER_CONFIG_VERSION
  presetId: ImagePresetId
  sizeMode: 'tier'
  aspectRatio: string
  imageSize: ImageActionSize
  width: number
  height: number
  quality: ImageActionQuality
  providerQuality: string | null
  variationCount: number
  pipelineMode: ImageActionPipelineMode
}

export type ImageRenderQuote = {
  version: typeof IMAGE_RENDER_QUOTE_VERSION
  currency: 'USD'
  kind: 'provider_render_estimate'
  model: GenericImageModel
  provider: 'gemini' | 'openai' | 'fal'
  presetId: ImagePresetId
  aspectRatio: string
  imageSize: ImageActionSize
  width: number
  height: number
  quality: ImageActionQuality
  providerQuality: string | null
  requestedImages: number
  unitPriceUsd: number
  minCostUsd: number
  maxCostUsd: number
  maxPaidGenerationsPerImage: number
  configFingerprint: string
  pricingBasis: 'internal_list_estimate'
  pricingLastVerifiedAt: string
  /** What the estimate actually prices — nothing more is claimed. */
  pricedComponents: readonly ['provider_output_render']
  /** Explicitly not priced; the settled receipt labels provenance instead. */
  excludes: readonly string[]
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

const QUOTE_V2_VERIFIED_AT: Readonly<Record<GenericImageModel, string>> = {
  'gemini-3.1-flash-image': '2026-06-15',
  'gemini-3-pro-image': '2026-06-15',
  'gpt-image-2': '2026-07-12',
  'seedream-5.0-pro': '2026-07-12',
}

/**
 * Stable fingerprint binding model + the complete canonical config. The edit
 * endpoint stores it, approval re-verifies it, and the worker independently
 * re-derives it before provider spend — three checkpoints, one truth.
 */
export function imageConfigFingerprint(model: GenericImageModel, config: ImageRenderConfig): string {
  const canonical = JSON.stringify([
    'alma-image-config-v1',
    model,
    config.version,
    config.presetId,
    config.sizeMode,
    config.aspectRatio,
    config.imageSize,
    config.width,
    config.height,
    config.quality,
    config.providerQuality,
    config.variationCount,
    config.pipelineMode,
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function imageConfigCompatibility(
  model: GenericImageModel,
  presetId: ImagePresetId,
  imageSize: ImageActionSize,
): { enabled: true; width: number; height: number; aspectRatio: string }
  | { enabled: false; reason: string } {
  const aspectRatio = aspectForPreset(presetId)
  if (!aspectRatio) return { enabled: false, reason: `Unknown preset: ${presetId}` }
  const dims = resolveImageDimensions(model, imageSize, aspectRatio)
  if ('unavailableReason' in dims) return { enabled: false, reason: dims.unavailableReason }
  return { enabled: true, width: dims.width, height: dims.height, aspectRatio }
}

/** Derive the full canonical config server-side. Throws on incompatibility. */
export function buildImageRenderConfig(input: {
  model: GenericImageModel
  presetId: ImagePresetId
  imageSize: ImageActionSize
  quality: ImageActionQuality
  variationCount: number
  pipelineMode: ImageActionPipelineMode
}): ImageRenderConfig {
  const compat = imageConfigCompatibility(input.model, input.presetId, input.imageSize)
  if (!compat.enabled) throw new Error(`image_config_incompatible:${compat.reason}`)
  const { providerQuality } = providerQualityFor(input.model, input.quality)
  return {
    version: IMAGE_RENDER_CONFIG_VERSION,
    presetId: input.presetId,
    sizeMode: 'tier',
    aspectRatio: compat.aspectRatio,
    imageSize: input.imageSize,
    width: compat.width,
    height: compat.height,
    quality: input.quality,
    providerQuality,
    variationCount: normalizeImageActionCount(input.variationCount),
    pipelineMode: normalizeImageActionPipelineMode(input.pipelineMode),
  }
}

export function buildImageRenderQuote(
  model: GenericImageModel,
  config: ImageRenderConfig,
): ImageRenderQuote {
  const unitPriceUsd = imageUnitPriceUsd(model, config.quality, config.imageSize)
  const maxPaidGenerationsPerImage = config.pipelineMode === 'production' ? 3 : 1
  const excludes: string[] = ['qc_vision', 'taxes', 'provider_credits']
  if (model === 'gpt-image-2') {
    // OpenAI bills prompt-text and reference-image input tokens separately.
    // The worker cannot pre-price them, so they are excluded AND labeled —
    // never silently folded into an output-only number.
    excludes.push('prompt_text_input_tokens', 'reference_image_input_tokens')
  }
  return {
    version: IMAGE_RENDER_QUOTE_VERSION,
    currency: 'USD',
    kind: 'provider_render_estimate',
    model,
    provider: genericImageProvider(model),
    presetId: config.presetId,
    aspectRatio: config.aspectRatio,
    imageSize: config.imageSize,
    width: config.width,
    height: config.height,
    quality: config.quality,
    providerQuality: config.providerQuality,
    requestedImages: config.variationCount,
    unitPriceUsd,
    minCostUsd: roundUsd(unitPriceUsd * config.variationCount),
    maxCostUsd: roundUsd(unitPriceUsd * config.variationCount * maxPaidGenerationsPerImage),
    maxPaidGenerationsPerImage,
    configFingerprint: imageConfigFingerprint(model, config),
    pricingBasis: 'internal_list_estimate',
    pricingLastVerifiedAt: QUOTE_V2_VERIFIED_AT[model],
    pricedComponents: ['provider_output_render'],
    excludes,
  }
}

/** Parse + validate a stored canonical config. Null = not a valid v2 config. */
export function parseImageRenderConfig(value: unknown): ImageRenderConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== IMAGE_RENDER_CONFIG_VERSION) return null
  if (raw.sizeMode !== 'tier') return null
  const presetId = raw.presetId
  if (typeof presetId !== 'string' || !IMAGE_PRESETS.some((p) => p.id === presetId)) return null
  const imageSize = raw.imageSize
  if (imageSize !== '1K' && imageSize !== '2K' && imageSize !== '4K') return null
  const quality = raw.quality
  if (quality !== 'standard' && quality !== 'pro') return null
  const aspectRatio = aspectForPreset(presetId)
  if (typeof raw.aspectRatio !== 'string' || raw.aspectRatio !== aspectRatio) return null
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return null
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)) return null
  const variationCount = raw.variationCount
  if (typeof variationCount !== 'number' || variationCount < 1 || variationCount > 4
    || !Number.isInteger(variationCount)) return null
  const pipelineMode = raw.pipelineMode === 'production' ? 'production' : 'preview'
  if (raw.pipelineMode !== pipelineMode) return null
  const providerQuality = raw.providerQuality
  if (providerQuality !== null && typeof providerQuality !== 'string') return null
  return {
    version: IMAGE_RENDER_CONFIG_VERSION,
    presetId: presetId as ImagePresetId,
    sizeMode: 'tier',
    aspectRatio: raw.aspectRatio,
    imageSize,
    width: raw.width,
    height: raw.height,
    quality,
    providerQuality,
    variationCount,
    pipelineMode,
  }
}

// ── Worker capability receipt v2 ────────────────────────────────────────────

export const IMAGE_WORKER_CAPABILITY_V2_KV_KEY = 'image_worker_capabilities_v2'
export const IMAGE_WORKER_CAPABILITY_V2_VERSION = 2 as const
export const IMAGE_WORKER_CAPABILITY_V2_SOURCE = 'alma-agent-worker' as const
export const IMAGE_WORKER_CAPABILITY_V2_MAX_AGE_MS = 3 * 60_000
export const IMAGE_WORKER_CAPABILITY_V2_MAX_FUTURE_SKEW_MS = 60_000

export type ImageWorkerCapabilityV2 = {
  version: typeof IMAGE_WORKER_CAPABILITY_V2_VERSION
  source: typeof IMAGE_WORKER_CAPABILITY_V2_SOURCE
  updatedAt: string
  configContractVersion: typeof IMAGE_RENDER_CONFIG_VERSION
  models: GenericImageModel[]
  /** modelId → presetId → tiers the live worker proves it can execute. */
  presets: Record<string, Record<string, ImageActionSize[]>>
}

/**
 * Only a fresh v2 receipt from the live worker may enable v2 staging or a
 * preset/tier option. Missing, stale, v1-only, or mismatched receipts fail
 * closed to the v1 path — never guess capability from source code.
 */
export function readImageWorkerCapabilityV2(
  raw: string | null | undefined,
  nowMs: number,
): { receipt: ImageWorkerCapabilityV2 | null; reason: string } {
  if (!raw) return { receipt: null, reason: 'Image worker v2 capability receipt is missing.' }
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    parsed = value as Record<string, unknown>
  } catch {
    return { receipt: null, reason: 'Image worker v2 capability receipt is invalid.' }
  }
  if (
    parsed.version !== IMAGE_WORKER_CAPABILITY_V2_VERSION
    || parsed.source !== IMAGE_WORKER_CAPABILITY_V2_SOURCE
    || parsed.configContractVersion !== IMAGE_RENDER_CONFIG_VERSION
  ) {
    return { receipt: null, reason: 'Image worker v2 capability receipt does not match this server contract.' }
  }
  const updatedAt = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : Number.NaN
  const ageMs = nowMs - updatedAt
  if (
    !Number.isFinite(updatedAt)
    || ageMs > IMAGE_WORKER_CAPABILITY_V2_MAX_AGE_MS
    || ageMs < -IMAGE_WORKER_CAPABILITY_V2_MAX_FUTURE_SKEW_MS
  ) {
    return { receipt: null, reason: 'Image worker v2 capability receipt is stale.' }
  }
  if (!Array.isArray(parsed.models) || parsed.models.some((m) => (
    typeof m !== 'string' || !GENERIC_IMAGE_MODELS.includes(m as GenericImageModel)
  ))) {
    return { receipt: null, reason: 'Image worker v2 capability receipt does not match this server contract.' }
  }
  const presets = parsed.presets
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) {
    return { receipt: null, reason: 'Image worker v2 capability receipt does not match this server contract.' }
  }
  return {
    receipt: {
      version: IMAGE_WORKER_CAPABILITY_V2_VERSION,
      source: IMAGE_WORKER_CAPABILITY_V2_SOURCE,
      updatedAt: parsed.updatedAt as string,
      configContractVersion: IMAGE_RENDER_CONFIG_VERSION,
      models: parsed.models as GenericImageModel[],
      presets: presets as Record<string, Record<string, ImageActionSize[]>>,
    },
    reason: '',
  }
}

/** True only when the live worker proved this exact model×preset×tier. */
export function receiptSupports(
  receipt: ImageWorkerCapabilityV2 | null,
  model: GenericImageModel,
  presetId: ImagePresetId,
  imageSize: ImageActionSize,
): boolean {
  if (!receipt) return false
  if (!receipt.models.includes(model)) return false
  const tiers = receipt.presets[model]?.[presetId]
  return Array.isArray(tiers) && tiers.includes(imageSize)
}

// ── v2 wire projection ──────────────────────────────────────────────────────

export type ImageRenderSelection = {
  contractVersion: typeof IMAGE_RENDER_CONTRACT_VERSION
  revision: number
  selectedModel: GenericImageModel
  config: ImageRenderConfig
  configFingerprint: string
  modelOptions: Array<{
    id: string
    label: string
    provider: 'gemini' | 'openai' | 'fal' | 'xai'
    enabled: boolean
    unavailableReason?: string
  }>
  presetOptions: Array<{
    id: ImagePresetId
    label: string
    aspectRatio: string
    enabled: boolean
    unavailableReason?: string
  }>
  sizeOptions: Array<{
    id: ImageActionSize
    enabled: boolean
    width?: number
    height?: number
    unavailableReason?: string
  }>
  qualityOptions: Array<{
    id: ImageActionQuality
    providerQuality: string | null
    description: string
  }>
  countOptions: number[]
  quote: ImageRenderQuote
}

/**
 * The one authoritative v2 projection — identical through live confirm_card
 * SSE, cold history, action list/detail, and the edit-endpoint echo.
 * Options are enabled ONLY when the fresh worker receipt proves them.
 */
export function buildImageRenderSelection(input: {
  model: GenericImageModel
  config: ImageRenderConfig
  revision: number
  receipt: ImageWorkerCapabilityV2 | null
  receiptUnavailableReason?: string
  availability?: ImageModelAvailability
  pinnedQuote?: unknown
}): ImageRenderSelection {
  const { model, config, revision, receipt } = input
  const receiptReason = input.receiptUnavailableReason
    ?? 'Live image worker has not proven this option.'
  const modelOptions = GENERIC_IMAGE_MODELS.map((candidate) => {
    const killReason = input.availability?.[candidate]
    if (typeof killReason === 'string' && killReason) {
      return {
        id: candidate,
        label: imageModelLabel(candidate),
        provider: genericImageProvider(candidate),
        enabled: false,
        unavailableReason: killReason,
      }
    }
    if (!receiptSupports(receipt, candidate, config.presetId, config.imageSize)) {
      const compat = imageConfigCompatibility(candidate, config.presetId, config.imageSize)
      return {
        id: candidate,
        label: imageModelLabel(candidate),
        provider: genericImageProvider(candidate),
        enabled: false,
        unavailableReason: compat.enabled ? receiptReason : compat.reason,
      }
    }
    return {
      id: candidate,
      label: imageModelLabel(candidate),
      provider: genericImageProvider(candidate),
      enabled: true,
    }
  })
  const presetOptions = IMAGE_PRESETS.map((preset) => {
    if (!receiptSupports(receipt, model, preset.id, config.imageSize)) {
      const compat = imageConfigCompatibility(model, preset.id, config.imageSize)
      return {
        id: preset.id,
        label: preset.label,
        aspectRatio: preset.aspectRatio,
        enabled: false,
        unavailableReason: compat.enabled ? receiptReason : compat.reason,
      }
    }
    return { id: preset.id, label: preset.label, aspectRatio: preset.aspectRatio, enabled: true }
  })
  const sizeOptions = (['1K', '2K', '4K'] as const).map((size) => {
    const compat = imageConfigCompatibility(model, config.presetId, size)
    if (!compat.enabled) {
      return { id: size, enabled: false, unavailableReason: compat.reason }
    }
    if (!receiptSupports(receipt, model, config.presetId, size)) {
      return { id: size, enabled: false, unavailableReason: receiptReason }
    }
    return { id: size, enabled: true, width: compat.width, height: compat.height }
  })
  const qualityOptions = (['standard', 'pro'] as const).map((q) => {
    const mapped = providerQualityFor(model, q)
    return { id: q, providerQuality: mapped.providerQuality, description: mapped.description }
  })
  const quote = isImageRenderQuoteForConfig(input.pinnedQuote, model, config)
    ? input.pinnedQuote
    : buildImageRenderQuote(model, config)
  return {
    contractVersion: IMAGE_RENDER_CONTRACT_VERSION,
    revision,
    selectedModel: model,
    config,
    configFingerprint: imageConfigFingerprint(model, config),
    modelOptions,
    presetOptions,
    sizeOptions,
    qualityOptions,
    countOptions: [1, 2, 3, 4],
    quote,
  }
}

/** A stored v2 quote is presentable only if it binds this exact selection. */
export function isImageRenderQuoteForConfig(
  value: unknown,
  model: GenericImageModel,
  config: ImageRenderConfig,
): value is ImageRenderQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const quote = value as Partial<ImageRenderQuote>
  return quote.version === IMAGE_RENDER_QUOTE_VERSION
    && quote.configFingerprint === imageConfigFingerprint(model, config)
    && quote.model === model
    && quote.currency === 'USD'
    && typeof quote.minCostUsd === 'number'
    && typeof quote.maxCostUsd === 'number'
}

/**
 * v1 projection of a v2 card — an installed Build 102 keeps a valid read-only
 * card + model picker. The v1 quote is derived from the same pinned numbers.
 */
export function v1QuoteFromConfig(model: GenericImageModel, config: ImageRenderConfig): ImageActionQuote {
  return buildImageActionQuote({
    model,
    quality: config.quality,
    imageSize: config.imageSize,
    requestedImages: config.variationCount,
    pipelineMode: config.pipelineMode,
    aspectRatio: config.aspectRatio,
  })
}

/** Payload mirror written alongside the canonical config on every v2 write. */
export function payloadMirrorFromConfig(
  model: GenericImageModel,
  config: ImageRenderConfig,
): Record<string, unknown> {
  return {
    imageModel: model,
    quality: config.quality,
    aspectRatio: config.aspectRatio,
    imageSize: config.imageSize,
    variationCount: config.variationCount,
    pipelineMode: config.pipelineMode,
    imageConfigFingerprint: imageConfigFingerprint(model, config),
  }
}

/**
 * Divergence check used by approval: the mirror must agree with the canonical
 * config, else the card was half-written and approval must fail closed.
 */
export function payloadMirrorMatchesConfig(
  payload: unknown,
  model: GenericImageModel,
  config: ImageRenderConfig,
): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const raw = payload as Record<string, unknown>
  return raw.imageModel === model
    && normalizeImageActionQuality(raw.quality) === config.quality
    && raw.aspectRatio === config.aspectRatio
    && normalizeImageActionSize(raw.imageSize) === config.imageSize
    && normalizeImageActionCount(raw.variationCount) === config.variationCount
    && raw.imageConfigFingerprint === imageConfigFingerprint(model, config)
}

/** Keep TS narrowing convenient for quote v1 version checks in shared paths. */
export const IMAGE_ACTION_QUOTE_V1_VERSION = IMAGE_ACTION_QUOTE_VERSION

// ── Canonical DB envelope (agent_pending_actions.image_config) ─────────────

export const IMAGE_CONFIG_ENVELOPE_VERSION = 1 as const

/**
 * The single atomic value stored in the `image_config` column: the canonical
 * selection, the quote the owner saw, and the fingerprint binding both. The
 * loose payload fields are a mirror only; this envelope is the truth.
 */
export type ImageConfigEnvelope = {
  version: typeof IMAGE_CONFIG_ENVELOPE_VERSION
  config: ImageRenderConfig
  quote: ImageRenderQuote
  fingerprint: string
}

export function buildImageConfigEnvelope(
  model: GenericImageModel,
  config: ImageRenderConfig,
): ImageConfigEnvelope {
  return {
    version: IMAGE_CONFIG_ENVELOPE_VERSION,
    config,
    quote: buildImageRenderQuote(model, config),
    fingerprint: imageConfigFingerprint(model, config),
  }
}

/** Null unless the stored value is a complete, internally-consistent envelope. */
export function parseImageConfigEnvelope(
  value: unknown,
  model: GenericImageModel | null,
): ImageConfigEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !model) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== IMAGE_CONFIG_ENVELOPE_VERSION) return null
  const config = parseImageRenderConfig(raw.config)
  if (!config) return null
  if (raw.fingerprint !== imageConfigFingerprint(model, config)) return null
  if (!isImageRenderQuoteForConfig(raw.quote, model, config)) return null
  return {
    version: IMAGE_CONFIG_ENVELOPE_VERSION,
    config,
    quote: raw.quote,
    fingerprint: raw.fingerprint as string,
  }
}

/**
 * One authoritative v2 projection for an action row — used identically by the
 * live confirm_card event, cold history, list/detail, edit echo, and retry.
 * Returns null for legacy v1 cards (imageConfig null/invalid): those continue
 * through selectionForImageAction unchanged.
 */
export function renderSelectionForAction(action: {
  type: string
  imageModel?: string | null
  imageConfig?: unknown
  imageConfigRevision?: number | null
  availability?: ImageModelAvailability
  receipt: ImageWorkerCapabilityV2 | null
  receiptUnavailableReason?: string
}): ImageRenderSelection | null {
  if (action.type !== 'image_gen') return null
  const model = typeof action.imageModel === 'string'
    && GENERIC_IMAGE_MODELS.includes(action.imageModel as GenericImageModel)
    ? action.imageModel as GenericImageModel
    : null
  const envelope = parseImageConfigEnvelope(action.imageConfig, model)
  if (!envelope || !model) return null
  return buildImageRenderSelection({
    model,
    config: envelope.config,
    revision: typeof action.imageConfigRevision === 'number' ? action.imageConfigRevision : 0,
    receipt: action.receipt,
    receiptUnavailableReason: action.receiptUnavailableReason,
    availability: action.availability,
    pinnedQuote: envelope.quote,
  })
}
