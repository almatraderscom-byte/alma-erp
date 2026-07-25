import { describe, expect, it } from 'vitest'
import {
  buildStudioResolutionUiState,
  resolutionFieldsForRun,
  resolveFinalStudioImageEngine,
  type StudioResolutionContext,
} from '@/agent/components/creative-studio/resolution-ui'

const base: StudioResolutionContext = {
  mode: 'product_to_model',
  provider: 'fashn',
  vtonEngine: 'fashn',
  familyPreset: 'single',
  protectedComposite: false,
  imageEngine: 'gemini',
  xaiWillRun: false,
}

describe('Creative Studio final-output resolution UI', () => {
  it('never offers xAI 4K or silently keeps the unsupported 4:5 aspect', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'generate',
        provider: 'xai_imagine',
        vtonEngine: 'xai_imagine',
        xaiWillRun: true,
      },
      { aspectRatio: '4:5', resolution: '4k' },
    )

    expect(state.engine).toBe('xai_imagine')
    expect(state.kind).toBe('tiered')
    expect(state.supportedAspects).toEqual(['3:4', '1:1', '9:16', '16:9'])
    expect(state.supportedAspects).not.toContain('4:5')
    expect(state.supportedTiers).toEqual(['1k', '2k'])
    expect(state.aspectRatio).toBe('3:4')
    expect(state.resolution).toBe('2k')
    expect(resolutionFieldsForRun(state)).toEqual({
      aspectRatio: '3:4',
      resolution: '2k',
    })
  })

  it('omits named resolution and aspect for fixed Fal VTON output', () => {
    for (const vtonEngine of ['fal_fashn_v16', 'fal_idm_vton'] as const) {
      const state = buildStudioResolutionUiState(
        {
          ...base,
          mode: 'try_on',
          vtonEngine,
        },
        { aspectRatio: '4:5', resolution: '4k' },
      )

      expect(state.engine).toBe(vtonEngine)
      expect(state.kind).toBe('fixed')
      expect(state.supportedAspects).toEqual([])
      expect(state.supportedTiers).toEqual([])
      expect(resolutionFieldsForRun(state)).toEqual({})
    }
  })

  it('uses the configured generic engine for the final FASHN Try-On rescene', () => {
    const context: StudioResolutionContext = {
      ...base,
      mode: 'try_on',
      vtonEngine: 'fashn',
      imageEngine: 'gpt',
    }
    const state = buildStudioResolutionUiState(
      context,
      { aspectRatio: '4:5', resolution: '4k' },
    )

    expect(resolveFinalStudioImageEngine(context)).toBe('gpt')
    expect(state.kind).toBe('tiered')
    expect(state.resolution).toBe('2k')
    expect(state.resolutionOptions.map((option) => option.value)).toEqual(['1k', '2k'])
    expect(state.resolutionOptions.at(-1)?.label).toBe('2K · 1856×2304')
  })

  it('keeps direct Product-to-Model on the truthful direct FASHN contract', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        imageEngine: 'seedream',
      },
      { aspectRatio: '16:9', resolution: '4k' },
    )

    expect(state.engine).toBe('fashn')
    expect(state.resolution).toBe('4k')
    expect(state.resolutionOptions.at(-1)?.label).toBe('4K')
  })

  it('keeps source-derived FASHN edit aspect out of the request while preserving the tier', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'edit',
        provider: 'fashn',
      },
      { aspectRatio: '16:9', resolution: '4k' },
    )

    expect(state.engine).toBe('fashn')
    expect(state.supportedAspects).toEqual([])
    expect(state.aspectRatio).toBeNull()
    expect(resolutionFieldsForRun(state)).toEqual({ resolution: '4k' })
  })

  it('does not offer unsupported landscape aspect for direct FASHN Face-to-Model', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'face_to_model',
        provider: 'fashn',
      },
      { aspectRatio: '16:9', resolution: '2k' },
    )

    expect(state.supportedAspects).toEqual(['4:5', '1:1', '9:16', '3:4'])
    expect(state.supportedAspects).not.toContain('16:9')
    expect(state.aspectRatio).toBe('4:5')
  })

  it('uses the configured image engine for generative family output', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'try_on',
        familyPreset: 'father_son',
        imageEngine: 'seedream',
      },
      { aspectRatio: '9:16', resolution: '4k' },
    )

    expect(state.engine).toBe('seedream')
    expect(state.resolution).toBe('2k')
    expect(state.resolutionOptions.at(-1)?.label).toBe('2K · 1536×2720')
  })

  it('uses the chain final engine for role-based full family even when xAI remains selected', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'try_on',
        familyPreset: 'full_family',
        vtonEngine: 'xai_imagine',
        imageEngine: 'seedream',
        xaiWillRun: false,
      },
      { aspectRatio: '1:1', resolution: '4k' },
    )

    expect(state.engine).toBe('seedream')
    expect(state.resolution).toBe('2k')
  })

  it('uses the direct-FASHN tier for protected family composite dimensions', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'try_on',
        familyPreset: 'mother_daughter',
        protectedComposite: true,
      },
      { aspectRatio: '1:1', resolution: '4k' },
    )

    expect(state.engine).toBe('family_composite')
    expect(state.contractEngine).toBe('fashn')
    expect(state.kind).toBe('tiered')
    expect(state.resolution).toBe('4k')
    expect(resolutionFieldsForRun(state)).toEqual({
      aspectRatio: '1:1',
      resolution: '4k',
    })
  })

  it('shows fixed output and omits fields for a protected Fal family composite', () => {
    const state = buildStudioResolutionUiState(
      {
        ...base,
        mode: 'try_on',
        vtonEngine: 'fal_fashn_v16',
        familyPreset: 'father_son',
        protectedComposite: true,
      },
      { aspectRatio: '4:5', resolution: '4k' },
    )

    expect(state.engine).toBe('family_composite')
    expect(state.contractEngine).toBe('fal_fashn_v16')
    expect(state.kind).toBe('fixed')
    expect(state.labelBn).toContain('864×1296')
    expect(resolutionFieldsForRun(state)).toEqual({})
  })

  it('keeps image-to-video free of image resolution fields', () => {
    const state = buildStudioResolutionUiState(
      { ...base, mode: 'image_to_video' },
      { aspectRatio: '4:5', resolution: '2k' },
    )

    expect(state.kind).toBe('video')
    expect(state.engine).toBeNull()
    expect(resolutionFieldsForRun(state)).toEqual({})
  })
})
