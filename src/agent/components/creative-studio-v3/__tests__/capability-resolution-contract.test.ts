import { describe, expect, it } from 'vitest'
import { STUDIO_MODES } from '@/lib/creative-studio/constants'
import {
  ADVANCED_ENGINE_CAPABILITIES,
  getAdvancedModeCapability,
} from '@/lib/creative-studio/advanced-image-capabilities'
import { buildStudioResolutionUiState } from '@/agent/components/creative-studio/resolution-ui'

describe('Creative Studio V3 A+B capability truth', () => {
  it('presents exactly seven Advanced modes backed by a declared engine capability', () => {
    expect(STUDIO_MODES.map((mode) => mode.id)).toEqual([
      'generate',
      'product_to_model',
      'try_on',
      'model_swap',
      'face_to_model',
      'edit',
      'image_to_video',
    ])
    for (const mode of STUDIO_MODES) {
      expect(
        ADVANCED_ENGINE_CAPABILITIES.some((engine) =>
          Boolean(getAdvancedModeCapability(engine.engine, mode.id))),
        `missing capability for ${mode.id}`,
      ).toBe(true)
    }
  })

  it('normalizes xAI away from unsupported 4:5 and 4K requests', () => {
    const state = buildStudioResolutionUiState({
      mode: 'generate',
      provider: 'xai_imagine',
      vtonEngine: 'xai_imagine',
      familyPreset: 'single',
      protectedComposite: false,
      imageEngine: 'gemini',
      xaiWillRun: true,
    }, { aspectRatio: '4:5', resolution: '4k' })

    expect(state.engine).toBe('xai_imagine')
    expect(state.supportedAspects).not.toContain('4:5')
    expect(state.supportedTiers).not.toContain('4k')
    expect(state.resolution).toBe('2k')
  })

  it('does not claim GPT Image 4K for a 4:5 request', () => {
    const state = buildStudioResolutionUiState({
      mode: 'product_to_model',
      provider: 'gemini',
      vtonEngine: 'gemini',
      familyPreset: 'single',
      protectedComposite: false,
      imageEngine: 'gpt',
    }, { aspectRatio: '4:5', resolution: '4k' })

    expect(state.contractEngine).toBe('gpt')
    expect(state.aspectRatio).toBe('4:5')
    expect(state.supportedTiers).toEqual(['1k', '2k'])
    expect(state.resolution).toBe('2k')
  })
})
