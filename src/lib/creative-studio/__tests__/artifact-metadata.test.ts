import { describe, expect, it } from 'vitest'
import {
  artifactDimensionLabel,
  artifactFieldsFromResult,
  artifactFileExtension,
  artifactVersionMetadata,
  mergeArtifactVersionMetadata,
  mergeBrandedVariant,
  normalizeArtifactVariants,
  type StudioArtifactDescriptor,
} from '@/lib/creative-studio/artifact-metadata'
import { buildStudioVersionMetadata } from '@/lib/creative-studio/project-service'
import { brandFrameDimensions } from '@/lib/content-engine/brand-frame'

const original = {
  kind: 'original',
  storagePath: 'generated/asset.webp',
  width: 2048,
  height: 1536,
  pixelCount: 3_145_728,
  format: 'webp',
  mimeType: 'image/webp',
  byteSize: 456_789,
  sha256: 'a'.repeat(64),
  requestedTier: '2k',
  requestedAspectRatio: '4:3',
  actualTier: '2k',
  validation: 'verified',
  provider: 'xai',
  model: 'grok-imagine-image',
} as const

const branded: StudioArtifactDescriptor = {
  kind: 'branded',
  storagePath: 'content/framed/asset.jpg',
  width: 1080,
  height: 1350,
  pixelCount: 1_458_000,
  format: 'jpeg',
  mimeType: 'image/jpeg',
  byteSize: 234_567,
  sha256: 'b'.repeat(64),
  requestedTier: null,
  requestedAspectRatio: '4:5',
  actualTier: 'social-1080',
  validation: 'verified',
  validationErrors: [],
  expected: { width: 1080, height: 1350 },
  provider: 'alma_brand_frame',
  model: 'deterministic-v1',
  sourceKind: 'original',
  transformVersion: 'cse8-brand-frame-v1',
  transform: { name: 'brand-frame', version: '1' },
}

describe('Creative Studio artifact metadata', () => {
  it('normalizes the worker keyed collection without losing decoded-byte evidence', () => {
    const variants = normalizeArtifactVariants({
      original,
      thumbnail: {
        kind: 'thumbnail',
        storagePath: 'generated/thumbs/asset.webp',
        width: 480,
        height: 360,
        format: 'webp',
        mimeType: 'image/webp',
        transformVersion: 'cse8-thumbnail-v1',
      },
    })

    expect(variants).toHaveLength(2)
    expect(variants[0]).toMatchObject({
      kind: 'original',
      storagePath: original.storagePath,
      width: 2048,
      height: 1536,
      pixelCount: 3_145_728,
      format: 'webp',
      mimeType: 'image/webp',
      sha256: original.sha256,
      validation: 'verified',
    })
    expect(variants[1]).toMatchObject({
      kind: 'thumbnail',
      width: 480,
      height: 360,
      transformVersion: 'cse8-thumbnail-v1',
    })
  })

  it('preserves raw resolutionIntegrity and variants for CSE3 version metadata', () => {
    const resolutionIntegrity = {
      status: 'verified',
      publishable: true,
      width: 2048,
      height: 1536,
      sha256: original.sha256,
    }
    const variants = { original }

    expect(artifactVersionMetadata({ resolutionIntegrity, variants })).toEqual({
      resolutionIntegrity,
      variants,
    })
    expect(artifactFieldsFromResult({ resolutionIntegrity, variants })).toMatchObject({
      resolutionIntegrity,
      original: {
        storagePath: original.storagePath,
        width: 2048,
        height: 1536,
      },
    })
    expect(buildStudioVersionMetadata({
      status: 'executed',
      summary: 'verified image',
      payload: { studioMode: 'scene' },
      result: { requestId: 'req-1', resolutionIntegrity, variants },
    })).toMatchObject({
      status: 'executed',
      studioMode: 'scene',
      requestId: 'req-1',
      resolutionIntegrity,
      variants,
    })
    expect(mergeArtifactVersionMetadata(
      { recipe: { id: 'recipe-1' }, status: 'executed' },
      { resolutionIntegrity, variants },
    )).toEqual({
      recipe: { id: 'recipe-1' },
      status: 'executed',
      resolutionIntegrity,
      variants,
    })
  })

  it('adds a branded derivative without replacing original evidence or other result fields', () => {
    const result = {
      storagePath: original.storagePath,
      requestId: 'req-1',
      qc: { pass: true },
      resolutionIntegrity: { status: 'verified', sha256: original.sha256 },
      variants: { original, thumbnail: { kind: 'thumbnail', storagePath: 'thumb.webp' } },
    }

    const merged = mergeBrandedVariant(result, branded)

    expect(merged).toMatchObject({
      storagePath: original.storagePath,
      requestId: 'req-1',
      qc: { pass: true },
      resolutionIntegrity: { status: 'verified', sha256: original.sha256 },
      brandedPath: branded.storagePath,
      brandedVariant: branded,
      variants: {
        original,
        thumbnail: { kind: 'thumbnail', storagePath: 'thumb.webp' },
        branded,
      },
    })
    expect(result.variants).not.toHaveProperty('branded')
  })

  it('replaces only the branded entry when rolling callbacks still use an array', () => {
    const oldBranded = { ...branded, storagePath: 'content/framed/old.jpg' }
    const merged = mergeBrandedVariant(
      { variants: [original, oldBranded], marker: 'keep' },
      branded,
    )

    expect(merged.marker).toBe('keep')
    expect(merged.variants).toEqual([original, branded])
  })

  it('shows exact dimensions and uses the decoded format for download names', () => {
    expect(artifactDimensionLabel(branded)).toBe('1080×1350 · JPEG')
    expect(artifactFileExtension(branded, 'misleading-output.png')).toBe('jpg')
    expect(artifactFileExtension(null, 'generated/original.avif?token=secret')).toBe('avif')
    expect(brandFrameDimensions('model_overlay')).toEqual({ width: 1080, height: 1350 })
    expect(brandFrameDimensions('product_card')).toEqual({ width: 1080, height: 1080 })
    expect(brandFrameDimensions('lifestyle')).toEqual({ width: 1080, height: 1080 })
  })
})
