import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  buildGalleryCursorWhere,
  buildGalleryWhere,
  decodeGalleryCursor,
  encodeGalleryCursor,
  mergeGalleryPage,
  normalizeGalleryFilters,
  normalizeGalleryLimit,
} from '../gallery-query'

function params(values: Record<string, string>) {
  return { get: (key: string) => values[key] ?? null }
}

describe('Creative Studio Gallery query', () => {
  it('normalizes filters and clamps unsafe inputs', () => {
    expect(normalizeGalleryFilters(params({
      media: 'video',
      state: 'qc_failed',
      qc: 'fail',
      q: `  ${'x'.repeat(100)}  `,
      includeTest: '1',
    }))).toEqual({
      media: 'video',
      state: 'qc_failed',
      qc: 'fail',
      query: 'x'.repeat(80),
      includeTest: true,
    })
    expect(normalizeGalleryLimit('999')).toBe(48)
    expect(normalizeGalleryLimit('bad')).toBe(24)
  })

  it('builds server-side media/search/QC filters and hides tests by default', () => {
    const where = buildGalleryWhere({
      media: 'image',
      state: 'ready',
      qc: 'pass',
      query: 'AL-101',
      includeTest: false,
    })
    const json = JSON.stringify(where)
    expect(json).toContain('creativeStudio')
    expect(json).toContain('image_gen')
    expect(json).toContain('AL-101')
    expect(json).toContain('e2e-')
    expect(where).toMatchObject({
      AND: expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            { payload: { path: ['testArtifact'], equals: Prisma.AnyNull } },
          ]),
        },
      ]),
    })
    expect(json).toContain('"path":["testArtifact"],"not":true')
    expect(json).toContain('"path":["e2e"],"not":true')
    expect(json).toContain('"path":["qc","pass"],"equals":false')
    expect(json).toContain('"path":["qc","pass"],"equals":true')
  })

  it('round-trips an opaque cursor and rejects malformed cursors', () => {
    const source = { createdAt: '2026-07-24T12:00:00.000Z', id: '018f0011-aaaa-bbbb-cccc-123456789012' }
    expect(decodeGalleryCursor(encodeGalleryCursor(source))).toEqual(source)
    expect(decodeGalleryCursor('not-a-cursor')).toBeNull()
    expect(JSON.stringify(buildGalleryCursorWhere(source))).toContain(source.id)
  })

  it('merges a refreshed first page without duplicates or losing loaded pages', () => {
    const existing = [{ id: 'b', n: 1 }, { id: 'c', n: 1 }]
    const fresh = [{ id: 'a', n: 2 }, { id: 'b', n: 2 }]
    expect(mergeGalleryPage(fresh, existing)).toEqual([
      { id: 'a', n: 2 },
      { id: 'b', n: 2 },
      { id: 'c', n: 1 },
    ])
  })
})
