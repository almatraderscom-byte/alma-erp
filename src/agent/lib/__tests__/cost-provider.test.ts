import { describe, expect, it } from 'vitest'
import {
  effectiveCostProvider,
  modelProviderToCostProvider,
} from '@/agent/lib/cost-provider'

describe('cost provider attribution', () => {
  it('records new direct xAI model spend in its own provider bucket', () => {
    expect(modelProviderToCostProvider('xai')).toBe('xai')
  })

  it('repairs historical xAI rows that were stored under OpenAI', () => {
    expect(effectiveCostProvider('xai', 'openai')).toBe('xai')
  })

  it('keeps legacy fallback behavior when units do not identify a provider', () => {
    expect(effectiveCostProvider(undefined, 'twilio')).toBe('twilio')
  })
})
