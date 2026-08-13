/**
 * CSE8 worker-side provider resolution contract.
 *
 * This module intentionally contains no network or storage code. Callers must
 * resolve a request here before making a paid provider call, then pass the
 * returned validationContract to the decoded-byte artifact inspector.
 */

// Build 103 Issue 2 adds the 2:3 portrait-poster column. Every value stays a
// multiple of 16 inside each provider's audited pixel budget, and the exact
// validation contract still rejects any provider that delivers something else
// — an unproven combination fails closed before delivery, never silently.
export const STUDIO_ASPECT_RATIOS = Object.freeze(['1:1', '4:5', '9:16', '16:9', '2:3'])
export const STUDIO_TIERS = Object.freeze(['1k', '2k', '4k'])

const GEMINI_DIMENSIONS = Object.freeze({
  '1k': Object.freeze({
    '1:1': [1024, 1024],
    '4:5': [928, 1152],
    '9:16': [768, 1376],
    '16:9': [1376, 768],
    '2:3': [832, 1248],
  }),
  '2k': Object.freeze({
    '1:1': [2048, 2048],
    '4:5': [1856, 2304],
    '9:16': [1536, 2752],
    '16:9': [2752, 1536],
    '2:3': [1664, 2496],
  }),
  '4k': Object.freeze({
    '1:1': [4096, 4096],
    '4:5': [3712, 4608],
    '9:16': [3072, 5504],
    '16:9': [5504, 3072],
    '2:3': [3328, 4992],
  }),
})

const GPT_IMAGE_DIMENSIONS = Object.freeze({
  '1k': GEMINI_DIMENSIONS['1k'],
  '2k': GEMINI_DIMENSIONS['2k'],
  '4k': Object.freeze({
    '9:16': [2160, 3840],
    '16:9': [3840, 2160],
  }),
})

const SEEDREAM_DIMENSIONS = Object.freeze({
  '1k': GEMINI_DIMENSIONS['1k'],
  '2k': Object.freeze({
    '1:1': [2048, 2048],
    '4:5': [1824, 2272],
    '9:16': [1536, 2720],
    '16:9': [2720, 1536],
    '2:3': [1664, 2496],
  }),
})

/**
 * Preset → aspect mapping shared with the server's v2 image-config contract
 * (src/agent/lib/image-config-contract.ts — parity-tested). The capability
 * receipt publishes, per model, which preset/tier pairs THIS worker process
 * can actually execute, so the server never advertises from source code.
 */
export const IMAGE_PRESET_ASPECTS = Object.freeze({
  square: '1:1',
  social_post: '4:5',
  reel_story: '9:16',
  landscape: '16:9',
  poster: '2:3',
})

export function supportedPresetTiersForModel(modelName) {
  const result = {}
  for (const [presetId, aspectRatio] of Object.entries(IMAGE_PRESET_ASPECTS)) {
    const tiers = []
    for (const tier of STUDIO_TIERS) {
      try {
        resolveGenericImageRequest({ modelName, imageSize: tier, aspectRatio })
        tiers.push(tier.toUpperCase())
      } catch {
        // Unsupported combination — simply not advertised.
      }
    }
    if (tiers.length > 0) result[presetId] = tiers
  }
  return result
}

export const XAI_ASPECT_RATIOS = Object.freeze([
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  'auto',
])

export function normalizeImageTier(value, fallback = null) {
  const normalized = value == null || value === ''
    ? fallback
    : String(value).trim().toLowerCase()
  if (!STUDIO_TIERS.includes(normalized)) {
    throw new Error(`unsupported image resolution tier: ${value}`)
  }
  return normalized
}

function assertStudioAspectRatio(value) {
  const aspectRatio = value ?? '4:5'
  if (!STUDIO_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`unsupported Studio image aspect ratio: ${aspectRatio}`)
  }
  return aspectRatio
}

function exactContract(dimensions, { tolerance = 0 } = {}) {
  const [width, height] = dimensions
  return Object.freeze({ mode: 'exact', width, height, tolerance })
}

function dimensionsFor(table, tier, aspectRatio, providerLabel) {
  const dimensions = table[tier]?.[aspectRatio]
  if (!dimensions) {
    throw new Error(`${providerLabel} does not support ${tier.toUpperCase()} at ${aspectRatio}`)
  }
  return dimensions
}

/**
 * Resolve the owner-switchable generic image engine before any provider call.
 * The returned dimensions are the exact payload and exact decoded-byte target.
 */
export function resolveGenericImageRequest({ modelName, imageSize, aspectRatio }) {
  const requestedTier = normalizeImageTier(imageSize, '2k')
  const requestedAspectRatio = assertStudioAspectRatio(aspectRatio)

  if (modelName.startsWith('gpt-image')) {
    const dimensions = dimensionsFor(
      GPT_IMAGE_DIMENSIONS,
      requestedTier,
      requestedAspectRatio,
      'GPT Image',
    )
    return {
      provider: 'openai',
      model: modelName,
      requestedTier,
      requestedAspectRatio,
      providerImageSize: `${dimensions[0]}x${dimensions[1]}`,
      dimensions: { width: dimensions[0], height: dimensions[1] },
      validationContract: exactContract(dimensions),
    }
  }

  if (modelName.startsWith('seedream')) {
    const dimensions = dimensionsFor(
      SEEDREAM_DIMENSIONS,
      requestedTier,
      requestedAspectRatio,
      'Seedream',
    )
    return {
      provider: 'fal',
      model: modelName,
      requestedTier,
      requestedAspectRatio,
      providerImageSize: { width: dimensions[0], height: dimensions[1] },
      dimensions: { width: dimensions[0], height: dimensions[1] },
      validationContract: exactContract(dimensions),
    }
  }

  if (modelName.startsWith('gemini-2.5-flash-image')) {
    if (requestedTier !== '1k') {
      throw new Error(`${modelName} is fixed at approximately 1K; ${requestedTier.toUpperCase()} is unsupported`)
    }
    return {
      provider: 'gemini',
      model: modelName,
      requestedTier,
      requestedAspectRatio,
      providerImageSize: '1K',
      dimensions: null,
      validationContract: { mode: 'tier-long-edge', tier: '1k' },
    }
  }

  if (!modelName.startsWith('gemini-3')) {
    throw new Error(`image model has no audited resolution contract: ${modelName}`)
  }

  const dimensions = dimensionsFor(
    GEMINI_DIMENSIONS,
    requestedTier,
    requestedAspectRatio,
    'Gemini',
  )
  return {
    provider: 'gemini',
    model: modelName,
    requestedTier,
    requestedAspectRatio,
    providerImageSize: requestedTier.toUpperCase(),
    dimensions: { width: dimensions[0], height: dimensions[1] },
    validationContract: exactContract(dimensions),
  }
}

/** Reject xAI combinations that the API cannot truthfully render. */
export function resolveXaiImageRequest({ resolution, aspectRatio }) {
  const requestedTier = normalizeImageTier(resolution, '2k')
  if (requestedTier === '4k') {
    throw new Error('xAI Grok Imagine does not support 4K output')
  }
  const requestedAspectRatio = aspectRatio ?? 'auto'
  if (!XAI_ASPECT_RATIOS.includes(requestedAspectRatio)) {
    throw new Error(`xAI Grok Imagine does not support aspect ratio ${requestedAspectRatio}`)
  }
  return {
    requestedTier,
    requestedAspectRatio,
    providerImageSize: requestedTier,
    validationContract: { mode: 'tier-long-edge', tier: requestedTier },
  }
}

const FASHN_EXPLICIT_ASPECTS = Object.freeze({
  'product-to-model': Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4']),
  'face-to-model': Object.freeze(['1:1', '4:5', '3:4', '2:3', '9:16']),
})

/** Direct FASHN exposes all tiers; only two models accept explicit aspect. */
export function resolveDirectFashnImageRequest(resolution, {
  model,
  aspectRatio,
} = {}) {
  const requestedTier = normalizeImageTier(resolution, '2k')
  const allowedAspects = FASHN_EXPLICIT_ASPECTS[model]
  if (allowedAspects && !aspectRatio) {
    throw new Error(`${model} requires an explicit aspect ratio`)
  }
  if (allowedAspects && !allowedAspects.includes(aspectRatio)) {
    throw new Error(`${model} does not support aspect ratio ${aspectRatio}`)
  }
  return {
    requestedTier,
    requestedAspectRatio: allowedAspects ? aspectRatio : null,
    providerImageSize: requestedTier,
    providerAspectRatio: allowedAspects ? aspectRatio : null,
    validationContract: {
      mode: 'tier-long-edge',
      tier: requestedTier,
      minPixelCount: requestedTier === '1k'
        ? 1_000_000
        : requestedTier === '2k'
          ? 4_000_000
          : 8_294_400,
    },
  }
}

export const FAL_FASHN_V16_CONTRACT = Object.freeze({
  mode: 'exact',
  width: 864,
  height: 1296,
  tolerance: 0,
})

export function sourceDimensionsContract(width, height) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('source dimensions contract requires positive integer dimensions')
  }
  return { mode: 'exact', width, height, tolerance: 0 }
}
