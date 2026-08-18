import { describe, it, expect } from 'vitest'
import { detectRoutineIntent } from '@/agent/lib/graph/routine-turn-graph'

describe('routine graph declines work it cannot serve', () => {
  it('still claims a single fixed lookup', () => {
    expect(detectRoutineIntent('aj koto sale holo')).toBe('sales_today')
  })

  it('declines a request naming two lookups', () => {
    // Answered with stock alone before this — the owner asked for three things.
    expect(detectRoutineIntent('check today orders then stock status then expense summary')).toBeNull()
  })

  it('declines a Bangla "তারপর" chain', () => {
    expect(detectRoutineIntent('আজকের খরচ দেখাও তারপর হাজিরা')).toBeNull()
  })

  it('declines two intents even without a joiner', () => {
    expect(detectRoutineIntent('aj koto sale holo, আজকের খরচ কত')).toBeNull()
  })

  it('declines a compact list joined by আর', () => {
    expect(detectRoutineIntent('stock আর হাজিরা')).toBeNull()
  })

  it('declines a compact comma list', () => {
    expect(detectRoutineIntent('stock, attendance')).toBeNull()
  })
})
