import { createHash } from 'node:crypto'
import sharp from 'sharp'

const MIME_BY_FORMAT = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
})

const EXTENSION_BY_FORMAT = Object.freeze({
  avif: 'avif',
  gif: 'gif',
  heif: 'heif',
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  tiff: 'tiff',
  webp: 'webp',
})

const TIER_GATES = Object.freeze({
  '1k': Object.freeze({ minLongEdge: 1024, minPixelCount: 0 }),
  '2k': Object.freeze({ minLongEdge: 2048, minPixelCount: 0 }),
  '4k': Object.freeze({ minLongEdge: 3840, minPixelCount: 8_294_400 }),
})

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function orientedDimensions(metadata) {
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation)
  return swapsAxes ? { width: height, height: width } : { width, height }
}

function actualTierFor(width, height) {
  const longEdge = Math.max(width, height)
  const pixelCount = width * height
  if (longEdge >= TIER_GATES['4k'].minLongEdge && pixelCount >= TIER_GATES['4k'].minPixelCount) return '4k'
  if (longEdge >= TIER_GATES['2k'].minLongEdge) return '2k'
  if (longEdge >= TIER_GATES['1k'].minLongEdge) return '1k'
  return 'sub-1k'
}

function validateContract({ width, height, requestedTier, contract }) {
  const errors = []
  if (contract?.mode === 'exact') {
    const tolerance = Number.isFinite(contract.tolerance) ? contract.tolerance : 0
    if (Math.abs(width - contract.width) > tolerance || Math.abs(height - contract.height) > tolerance) {
      errors.push(`expected ${contract.width}x${contract.height}, decoded ${width}x${height}`)
    }
  } else if (contract?.mode === 'maximum-long-edge') {
    const longEdge = Math.max(width, height)
    if (longEdge > contract.maxLongEdge) {
      errors.push(`expected long edge <= ${contract.maxLongEdge}, decoded ${longEdge}`)
    }
  } else if (contract?.mode === 'tier-long-edge') {
    const tier = contract.tier ?? requestedTier
    const gate = TIER_GATES[tier]
    if (!gate) {
      errors.push(`unknown tier gate ${tier}`)
    } else {
      const longEdge = Math.max(width, height)
      const pixelCount = width * height
      const minLongEdge = contract.minLongEdge ?? gate.minLongEdge
      const minPixelCount = contract.minPixelCount ?? gate.minPixelCount
      if (longEdge < minLongEdge) {
        errors.push(`${tier.toUpperCase()} requires long edge >= ${minLongEdge}, decoded ${longEdge}`)
      }
      if (pixelCount < minPixelCount) {
        errors.push(`${tier.toUpperCase()} requires >= ${minPixelCount} pixels, decoded ${pixelCount}`)
      }
    }
  }
  return errors
}

function expectedFromContract(contract) {
  if (contract?.mode === 'exact') {
    return {
      width: contract.width,
      height: contract.height,
      tolerance: contract.tolerance ?? 0,
    }
  }
  if (contract?.mode === 'tier-long-edge') {
    const gate = TIER_GATES[contract.tier]
    return gate
      ? {
          tier: contract.tier,
          minLongEdge: contract.minLongEdge ?? gate.minLongEdge,
          minPixelCount: contract.minPixelCount ?? gate.minPixelCount,
        }
      : { tier: contract.tier }
  }
  if (contract?.mode === 'maximum-long-edge') {
    return { maxLongEdge: contract.maxLongEdge }
  }
  return undefined
}

/**
 * Decode an image once for immutable artifact evidence. The returned descriptor
 * contains no bytes or signed URLs and is safe to persist in job/version JSON.
 */
export async function inspectImageArtifact(buffer, {
  kind = 'original',
  storagePath,
  requestedTier = null,
  requestedAspectRatio = null,
  provider = null,
  model = null,
  contract = null,
  sourceKind,
  transformVersion,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('image artifact is empty')
  }

  let metadata
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  } catch (error) {
    throw new Error(`image artifact is not decodable: ${error.message}`)
  }

  const format = metadata.format
  const mimeType = MIME_BY_FORMAT[format]
  if (!format || !mimeType) {
    throw new Error(`image artifact format is unsupported: ${format ?? 'unknown'}`)
  }

  const { width, height } = orientedDimensions(metadata)
  if (!width || !height) throw new Error('image artifact has no decoded dimensions')

  const validationErrors = validateContract({ width, height, requestedTier, contract })
  return {
    kind,
    ...(storagePath ? { storagePath } : {}),
    width,
    height,
    pixelCount: width * height,
    format,
    mimeType,
    byteSize: buffer.length,
    sha256: sha256(buffer),
    requestedTier,
    requestedAspectRatio,
    actualTier: actualTierFor(width, height),
    validation: validationErrors.length ? 'failed' : 'verified',
    ...(validationErrors.length ? { validationErrors } : {}),
    ...(expectedFromContract(contract) ? { expected: expectedFromContract(contract) } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(transformVersion ? { transformVersion } : {}),
  }
}

export function imageExtensionForFormat(format) {
  const extension = EXTENSION_BY_FORMAT[format]
  if (!extension) throw new Error(`no file extension for image format: ${format}`)
  return extension
}

function withoutImageExtension(path) {
  return path.replace(/\.(?:avif|gif|heif|jpe?g|png|tiff?|webp)$/i, '')
}

/**
 * Inspect and upload the exact same provider bytes. The upload content type and
 * extension are derived from decoded bytes, never provider headers or suffixes.
 */
export async function uploadImageArtifact({
  supabase,
  buffer,
  storageBasePath,
  bucket = 'agent-files',
  ...inspectOptions
}) {
  const inspected = await inspectImageArtifact(buffer, inspectOptions)
  const storagePath = `${withoutImageExtension(storageBasePath)}.${imageExtensionForFormat(inspected.format)}`
  const { error } = await supabase.storage.from(bucket).upload(storagePath, buffer, {
    contentType: inspected.mimeType,
    upsert: true,
  })
  if (error) throw new Error(`upload failed: ${error.message}`)
  return { ...inspected, storagePath }
}

/** Fetch a temporary provider URL and land its untouched, sniffed bytes. */
export async function downloadImageArtifactToStorage({
  supabase,
  outputUrl,
  storageBasePath,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  ...inspectOptions
}) {
  const response = await fetchImpl(outputUrl, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`image output download HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return uploadImageArtifact({
    supabase,
    buffer,
    storageBasePath,
    ...inspectOptions,
  })
}

/** Re-inspect a stored artifact when a QC loop promotes a previously uploaded path. */
export async function inspectStoredImageArtifact(supabase, storagePath, inspectOptions = {}) {
  const { data, error } = await supabase.storage.from('agent-files').download(storagePath)
  if (error || !data) throw new Error(`download failed: ${storagePath}`)
  const buffer = Buffer.from(await data.arrayBuffer())
  return inspectImageArtifact(buffer, { ...inspectOptions, storagePath })
}

export function resolutionIntegrityFromArtifact(artifact) {
  if (!artifact) {
    return {
      status: 'failed',
      publishable: false,
      errors: ['original artifact descriptor missing'],
    }
  }
  return {
    status: artifact.validation,
    publishable: artifact.validation === 'verified',
    requestedTier: artifact.requestedTier ?? null,
    requestedAspectRatio: artifact.requestedAspectRatio ?? null,
    actualTier: artifact.actualTier,
    width: artifact.width,
    height: artifact.height,
    pixelCount: artifact.pixelCount,
    format: artifact.format,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    ...(artifact.expected ? { expected: artifact.expected } : {}),
    ...(artifact.validationErrors ? { errors: artifact.validationErrors } : {}),
  }
}
