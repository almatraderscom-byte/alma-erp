import { describe, expect, it } from 'vitest'
import {
  gptImage2OutputCostUsd,
  gptImage2OutputTokens,
} from '@/lib/creative-studio/gpt-image-2-pricing'

describe('GPT Image 2 pricing', () => {
  it('matches the official calculator examples', () => {
    expect(gptImage2OutputTokens(1024, 1024, 'low')).toBe(196)
    expect(gptImage2OutputCostUsd(1024, 1024, 'medium')).toBeCloseTo(0.05268, 8)
    expect(gptImage2OutputCostUsd(1024, 1536, 'high')).toBeCloseTo(0.16464, 8)
  })

  it('prices ALMA exact 4:5 dimensions rather than a flat per-image guess', () => {
    expect(gptImage2OutputCostUsd(928, 1152, 'medium')).toBeCloseTo(0.04311, 8)
    expect(gptImage2OutputCostUsd(1856, 2304, 'high')).toBeCloseTo(0.34797, 8)
  })
})
