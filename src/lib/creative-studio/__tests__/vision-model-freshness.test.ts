import { describe, expect, it } from 'vitest'
import { READINESS_VISION_MODEL } from '@/lib/creative-studio/single-pipeline'
import { GARMENT_VISION_MODEL } from '@/lib/tryon/art-director'

describe('Creative Studio preflight vision model freshness', () => {
  it('does not call the retired Gemini 2.0 endpoint', () => {
    expect(new Set([GARMENT_VISION_MODEL, READINESS_VISION_MODEL])).toEqual(
      new Set(['gemini-3.6-flash']),
    )
  })
})
