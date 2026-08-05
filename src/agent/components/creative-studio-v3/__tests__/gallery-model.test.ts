import { describe, expect, it } from 'vitest'
import type { GalleryItem } from '@/agent/components/creative-studio/studio-api'
import {
  libraryItemFromGallery,
  sortStudioV3Library,
} from '@/agent/components/creative-studio-v3/gallery-model'

function gallery(overrides: Partial<GalleryItem>): GalleryItem {
  return {
    id: 'asset-1',
    type: 'image_gen',
    status: 'complete',
    assetState: 'ready',
    publishable: true,
    summary: 'Campaign still',
    createdAt: '2026-07-25T12:00:00.000Z',
    mode: 'product_to_model',
    provider: 'fashn',
    familyPreset: null,
    previewUrl: '/preview',
    storagePath: 'fallback/path.webp',
    error: null,
    ...overrides,
  }
}

describe('Creative Studio V3 Gallery presentation model', () => {
  it('uses verified delivered dimensions and original storage lineage', () => {
    const item = libraryItemFromGallery(gallery({
      costUsd: 0.12,
      engine: 'fal_fashn_v16',
      resolutionIntegrity: {
        requestedTier: '4k',
        requestedAspectRatio: '4:5',
      },
      originalVariant: {
        kind: 'original',
        storagePath: 'verified/original.webp',
        width: 1856,
        height: 2304,
        pixelCount: 4_276_224,
        format: 'webp',
        mimeType: 'image/webp',
        byteSize: 100,
        sha256: 'abc',
        requestedTier: '4k',
        requestedAspectRatio: '4:5',
        actualTier: '2k',
        validation: 'downgraded',
        validationErrors: [],
        expected: null,
        provider: 'fal',
        model: 'fashn-v1.6',
        sourceKind: 'provider',
        transformVersion: null,
        transform: null,
      },
    }))

    expect(item.dimensions).toBe('1856×2304')
    expect(item.storagePath).toBe('verified/original.webp')
    expect(item.aspect).toBe('4:5')
    expect(item.provider).toBe('fal_fashn_v16')
    expect(item.lifecycle).toBe('approved')
  })

  it('maps failed/QC records to review and sorts without mutating input', () => {
    const older = libraryItemFromGallery(gallery({
      id: 'older',
      createdAt: '2026-01-01T00:00:00.000Z',
      assetState: 'qc_failed',
      publishable: false,
    }))
    const newer = libraryItemFromGallery(gallery({
      id: 'newer',
      createdAt: '2026-07-01T00:00:00.000Z',
    }))
    const input = [older, newer]

    expect(older.lifecycle).toBe('review')
    expect(sortStudioV3Library(input, 'newest').map((item) => item.id)).toEqual(['newer', 'older'])
    expect(input.map((item) => item.id)).toEqual(['older', 'newer'])
  })
})
