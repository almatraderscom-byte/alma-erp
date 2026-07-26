import { describe, expect, it } from 'vitest'
import { resolveCreativeStudioV3Rollout } from '@/agent/components/creative-studio-v3/rollout-policy'

const scope = {
  ownerId: 'owner-1',
  brandId: 'brand-1',
  projectId: 'project-1',
}

describe('Creative Studio V3 server rollout policy', () => {
  it('is default-off even when a scope appears in an allowlist', () => {
    expect(resolveCreativeStudioV3Rollout({
      CREATIVE_STUDIO_V3_OWNER_IDS: 'owner-1',
    }, scope)).toBe(false)
  })

  it('requires a matching owner, brand, or project after the master gate', () => {
    expect(resolveCreativeStudioV3Rollout({
      CREATIVE_STUDIO_V3_UI_ENABLED: '1',
      CREATIVE_STUDIO_V3_OWNER_IDS: 'someone-else',
      CREATIVE_STUDIO_V3_BRAND_IDS: 'another-brand',
      CREATIVE_STUDIO_V3_PROJECT_IDS: 'another-project',
    }, scope)).toBe(false)

    expect(resolveCreativeStudioV3Rollout({
      CREATIVE_STUDIO_V3_UI_ENABLED: '1',
      CREATIVE_STUDIO_V3_BRAND_IDS: 'brand-1',
    }, scope)).toBe(true)
  })

  it('supports an explicit server wildcard without trusting a client scope', () => {
    expect(resolveCreativeStudioV3Rollout({
      CREATIVE_STUDIO_V3_UI_ENABLED: '1',
      CREATIVE_STUDIO_V3_OWNER_IDS: '*',
    }, { ...scope, ownerId: null })).toBe(true)
  })

  it('always honors the instant legacy fallback', () => {
    expect(resolveCreativeStudioV3Rollout({
      CREATIVE_STUDIO_V3_UI_ENABLED: '1',
      CREATIVE_STUDIO_V3_OWNER_IDS: '*',
    }, { ...scope, forceLegacy: true })).toBe(false)
  })
})
