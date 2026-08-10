import { describe, expect, it } from 'vitest'
import {
  imageResultPaths,
  imageResultQcWarnings,
  signImageResultPreviews,
} from '@/agent/lib/image-result-contract'

describe('image result delivery contract', () => {
  it('keeps legacy single-image callbacks working', () => {
    expect(imageResultPaths({ storagePath: 'generated/one.png' })).toEqual(['generated/one.png'])
  })

  it('returns one ordered deduplicated gallery from a variation callback', () => {
    expect(imageResultPaths({
      storagePath: 'generated/one.png',
      storagePaths: ['generated/one.png', 'generated/two.png', 'generated/three.png'],
      images: [
        { storagePath: 'generated/one.png' },
        { storagePath: 'generated/two.png' },
        { storagePath: 'generated/three.png' },
      ],
    })).toEqual(['generated/one.png', 'generated/two.png', 'generated/three.png'])
  })

  it('surfaces a QC warning from every flagged variation', () => {
    expect(imageResultQcWarnings({
      qc: { flagged: 'first warning' },
      variationQc: [
        { pass: true },
        { pass: false, flagged: 'reference mismatch' },
        { pass: false, flagged: 'text unreadable' },
      ],
    })).toEqual([
      'Image 2: reference mismatch',
      'Image 3: text unreadable',
    ])
    expect(imageResultQcWarnings({ qc: { flagged: 'legacy warning' } }))
      .toEqual(['legacy warning'])
  })

  it('surfaces a partial-batch warning without hiding completed images', () => {
    expect(imageResultQcWarnings({
      partialWarning: '1 of 3 images completed; variation 2 failed.',
      variationQc: [{ pass: true }],
    })).toEqual(['1 of 3 images completed; variation 2 failed.'])
  })

  it('keeps every durable path when one preview URL cannot be signed', async () => {
    const paths = ['generated/one.png', 'generated/two.png', 'generated/three.png']
    const delivery = await signImageResultPreviews(paths, async (path) => {
      if (path.endsWith('two.png')) throw new Error('signing timeout')
      return `https://signed.example/${path}`
    })

    expect(delivery.previews.map((preview) => [preview.path, preview.index])).toEqual([
      ['generated/one.png', 0],
      ['generated/three.png', 2],
    ])
    expect(delivery.failedPaths).toEqual(['generated/two.png'])
    expect(paths).toHaveLength(3)
  })
})
