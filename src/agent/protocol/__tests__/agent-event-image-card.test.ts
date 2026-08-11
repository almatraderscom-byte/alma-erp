import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import agentEventSchema from '../agent-event.schema.json'

describe('canonical image confirm-card SSE contract', () => {
  it('validates the additive model picker and truthful USD quote', () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(agentEventSchema)
    const valid = validate({
      type: 'confirm_card',
      pendingActionId: 'image-action-1',
      summary: 'Generate four product images',
      actionType: 'image_gen',
      imageModelSelection: {
        selectedModel: 'gemini-3.1-flash-image',
        options: [
          {
            id: 'gemini-3.1-flash-image',
            label: 'Nano Banana 2',
            provider: 'gemini',
            enabled: true,
            quote: {
              version: 1,
              currency: 'USD',
              kind: 'provider_render_estimate',
              model: 'gemini-3.1-flash-image',
              provider: 'gemini',
              quality: 'pro',
              imageSize: '2K',
              requestedImages: 4,
              unitPriceUsd: 0.101,
              minCostUsd: 0.404,
              maxCostUsd: 0.404,
              maxPaidGenerationsPerImage: 1,
              pricingBasis: 'internal_list_estimate',
              pricingLastVerifiedAt: '2026-06-15',
              excludes: ['qc_vision', 'taxes', 'provider_credits'],
            },
          },
          {
            id: 'grok-imagine-image-quality',
            label: 'Grok Imagine',
            provider: 'xai',
            enabled: false,
            unavailableReason: 'This chat contract cannot safely route it yet.',
          },
        ],
        quote: {
          version: 1,
          currency: 'USD',
          kind: 'provider_render_estimate',
          model: 'gemini-3.1-flash-image',
          provider: 'gemini',
          quality: 'pro',
          imageSize: '2K',
          requestedImages: 4,
          unitPriceUsd: 0.101,
          minCostUsd: 0.404,
          maxCostUsd: 0.404,
          maxPaidGenerationsPerImage: 1,
          pricingBasis: 'internal_list_estimate',
          pricingLastVerifiedAt: '2026-06-15',
          excludes: ['qc_vision', 'taxes', 'provider_credits'],
        },
      },
    })
    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)
  })
})
