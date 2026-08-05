export type StudioArtifactDescriptor = {
  kind: string
  storagePath: string
  width: number | null
  height: number | null
  pixelCount: number | null
  format: string | null
  mimeType: string | null
  byteSize: number | null
  sha256: string | null
  requestedTier: string | null
  requestedAspectRatio: string | null
  actualTier: string | null
  validation: string | null
  validationErrors: string[]
  expected: Record<string, unknown> | null
  provider: string | null
  model: string | null
  sourceKind: string | null
  transformVersion: string | null
  transform: Record<string, unknown> | null
}

type AnyRecord = Record<string, unknown>

function object(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Normalize callback descriptors for API/UI consumers while keeping the raw
 * callback JSON untouched in CreativeAssetVersion.metadata.
 */
export function normalizeArtifactDescriptor(
  value: unknown,
  fallbackKind?: string,
): StudioArtifactDescriptor | null {
  const row = object(value)
  if (!row) return null
  const storagePath = text(row.storagePath ?? row.path)
  if (!storagePath) return null

  const width = positiveInteger(row.width ?? row.widthPx)
  const height = positiveInteger(row.height ?? row.heightPx)
  const pixelCount =
    positiveInteger(row.pixelCount)
    ?? (width && height ? width * height : null)

  return {
    kind: text(row.kind) ?? fallbackKind ?? 'unknown',
    storagePath,
    width,
    height,
    pixelCount,
    format: text(row.format),
    mimeType: text(row.mimeType ?? row.contentType),
    byteSize: positiveInteger(row.byteSize ?? row.sizeBytes),
    sha256: text(row.sha256),
    requestedTier: text(row.requestedTier),
    requestedAspectRatio: text(row.requestedAspectRatio ?? row.aspectRatio),
    actualTier: text(row.actualTier),
    validation: text(row.validation),
    validationErrors: Array.isArray(row.validationErrors)
      ? row.validationErrors.filter((entry): entry is string => typeof entry === 'string')
      : [],
    expected: object(row.expected),
    provider: text(row.provider),
    model: text(row.model),
    sourceKind: text(row.sourceKind),
    transformVersion: text(row.transformVersion),
    transform: object(row.transform),
  }
}

/**
 * Worker callbacks may use either an ordered array or a keyed collection.
 * Accept both so rolling deployments do not hide already-created artifacts.
 */
export function normalizeArtifactVariants(value: unknown): StudioArtifactDescriptor[] {
  const variants: StudioArtifactDescriptor[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      const descriptor = normalizeArtifactDescriptor(entry)
      if (descriptor) variants.push(descriptor)
    }
  } else {
    const keyed = object(value)
    if (keyed) {
      for (const [kind, entry] of Object.entries(keyed)) {
        const descriptor = normalizeArtifactDescriptor(entry, kind)
        if (descriptor) variants.push(descriptor)
      }
    }
  }

  const seen = new Set<string>()
  return variants.filter((variant) => {
    const identity = `${variant.kind}:${variant.storagePath}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function artifactFieldsFromResult(resultValue: unknown): {
  resolutionIntegrity: Record<string, unknown> | null
  variants: StudioArtifactDescriptor[]
  original: StudioArtifactDescriptor | null
  branded: StudioArtifactDescriptor | null
} {
  const result = object(resultValue) ?? {}
  const resolutionIntegrity = object(result.resolutionIntegrity)
  const variants = normalizeArtifactVariants(result.variants)

  const integrityOriginal =
    normalizeArtifactDescriptor(resolutionIntegrity?.artifact, 'original')
    ?? normalizeArtifactDescriptor(resolutionIntegrity?.original, 'original')
    ?? normalizeArtifactDescriptor(resolutionIntegrity, 'original')

  const original =
    variants.find((variant) => variant.kind === 'original')
    ?? integrityOriginal
    ?? null
  const branded =
    variants.find((variant) => variant.kind === 'branded')
    ?? normalizeArtifactDescriptor(result.brandedVariant, 'branded')
    ?? null

  return { resolutionIntegrity, variants, original, branded }
}

/**
 * Preserve the callback's immutable resolution evidence in CSE3 JSON metadata.
 * Values stay raw so future descriptor fields survive older app deployments.
 */
export function artifactVersionMetadata(resultValue: unknown): {
  resolutionIntegrity: Record<string, unknown> | null
  variants: unknown[] | Record<string, unknown> | null
} {
  const result = object(resultValue) ?? {}
  const rawVariants =
    Array.isArray(result.variants)
      ? result.variants
      : object(result.variants)
  return {
    resolutionIntegrity: object(result.resolutionIntegrity),
    variants: rawVariants,
  }
}

export function mergeArtifactVersionMetadata(
  metadataValue: unknown,
  resultValue: unknown,
): Record<string, unknown> {
  return {
    ...(object(metadataValue) ?? {}),
    ...artifactVersionMetadata(resultValue),
  }
}

/** Add/replace only the branded derivative and leave all other callback data intact. */
export function mergeBrandedVariant(
  resultValue: unknown,
  branded: StudioArtifactDescriptor,
): Record<string, unknown> {
  const result = object(resultValue) ?? {}
  const existing = result.variants
  let variants: unknown[] | Record<string, unknown>

  if (Array.isArray(existing)) {
    variants = [
      ...existing.filter((entry) => object(entry)?.kind !== 'branded'),
      branded,
    ]
  } else {
    variants = {
      ...(object(existing) ?? {}),
      branded,
    }
  }

  return {
    ...result,
    brandedPath: branded.storagePath,
    brandedVariant: branded,
    variants,
  }
}

const FORMAT_EXTENSIONS: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  heif: 'heif',
}

export function artifactFileExtension(
  descriptor: StudioArtifactDescriptor | null | undefined,
  storagePath?: string | null,
): string {
  const format = descriptor?.format?.toLowerCase()
  if (format && FORMAT_EXTENSIONS[format]) return FORMAT_EXTENSIONS[format]

  const cleanPath = storagePath?.split(/[?#]/, 1)[0] ?? ''
  const suffix = cleanPath.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
  return suffix && /^[a-z0-9]+$/.test(suffix) ? suffix : 'img'
}

export function artifactDimensionLabel(
  descriptor: StudioArtifactDescriptor | null | undefined,
): string | null {
  if (!descriptor?.width || !descriptor.height) return null
  const format = descriptor.format ? ` · ${descriptor.format.toUpperCase()}` : ''
  return `${descriptor.width}×${descriptor.height}${format}`
}
