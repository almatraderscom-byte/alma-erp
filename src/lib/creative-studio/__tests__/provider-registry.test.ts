import { describe, expect, it } from 'vitest'
import {
  ALLOWED_FAL_ENDPOINTS,
  FAL_VTON_ENGINE_IDS,
  isFalVtonEngine,
  isVtonClothType,
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  FAMILY_CHAIN_LABEL_BN,
  SINGLE_VTON_ENGINE_IDS,
  STUDIO_ENGINES,
  describeEngineAvailability,
  enginesForMode,
  getEngine,
  isAllowedFalEndpoint,
  normalizeSingleVtonDefault,
  resolveLegacyProvider,
} from '../provider-registry'

describe('provider registry — identity and commercial metadata', () => {
  it('declares the exact owner-locked Fal endpoints', () => {
    expect(getEngine('fal_idm_vton').falEndpointId).toBe('fal-ai/cat-vton')
    expect(getEngine('fal_fashn_v16').falEndpointId).toBe('fal-ai/fashn/tryon/v1.6')
    expect(getEngine('fal_flux_fill').falEndpointId).toBe('fal-ai/flux-pro/v1/fill')
  })

  it('marks IDM-VTON research-only with a visible Bangla warning', () => {
    const idm = getEngine('fal_idm_vton')
    expect(idm.status).toBe('research_only')
    expect(idm.warningBn).toBeTruthy()
    expect(idm.labelBn).toContain('পরীক্ষামূলক')
  })

  it('marks Fal FASHN v1.6 commercial and direct FASHN/Gemini production', () => {
    expect(getEngine('fal_fashn_v16').status).toBe('commercial')
    expect(getEngine('fashn').status).toBe('production')
    expect(getEngine('gemini').status).toBe('production')
  })

  it('keeps every Fal engine behind an owner flag and FAL_KEY', () => {
    for (const e of STUDIO_ENGINES.filter((x) => x.vendor === 'fal')) {
      expect(e.requiresEnv).toBe('FAL_KEY')
      expect(e.settingsFlag).toBeTruthy()
    }
  })
})

describe('provider registry — capability rules', () => {
  it('VTON engines are single-person only and never offered for multi-person family', () => {
    const familyEngines = enginesForMode('try_on', { multiPerson: true })
    expect(familyEngines.map((e) => e.id)).not.toContain('fal_idm_vton')
    expect(familyEngines.map((e) => e.id)).not.toContain('fal_fashn_v16')
    expect(familyEngines.map((e) => e.id)).not.toContain('fashn')
    expect(familyEngines.map((e) => e.id)).toContain('gemini')
  })

  it('single try-on offers all VTON engines', () => {
    const ids = enginesForMode('try_on').map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['fashn', 'fal_fashn_v16', 'fal_idm_vton']))
  })

  it('FLUX Fill serves edit mode only', () => {
    expect(getEngine('fal_flux_fill').modes).toEqual(['edit'])
  })

  it('CS6: fal VTON engines runnable; FLUX Fill still foundation-only', () => {
    expect(getEngine('fal_fashn_v16').runnable).toBe(true)
    expect(getEngine('fal_idm_vton').runnable).toBe(true)
    expect(getEngine('fal_flux_fill').runnable).toBe(false) // CS7 wires it
    expect(getEngine('fashn').runnable).toBe(true)
    expect(getEngine('gemini').runnable).toBe(true)
  })
})

describe('provider registry — compatibility and defaults', () => {
  it('legacy StudioProvider values map onto registry entries', () => {
    expect(resolveLegacyProvider('fashn').id).toBe('fashn')
    expect(resolveLegacyProvider('gemini').id).toBe('gemini')
  })

  it('single-VTON default only accepts single-person try-on engines', () => {
    expect([...SINGLE_VTON_ENGINE_IDS].sort()).toEqual(['fal_fashn_v16', 'fal_idm_vton', 'fashn'])
    expect(normalizeSingleVtonDefault('fal_idm_vton')).toBe('fal_idm_vton')
    expect(normalizeSingleVtonDefault('gemini')).toBe('fashn')
    expect(normalizeSingleVtonDefault('bogus')).toBe('fashn')
    expect(normalizeSingleVtonDefault(null)).toBe('fashn')
  })

  it('family chain label names both engines honestly', () => {
    expect(FAMILY_CHAIN_LABEL_BN).toContain('FASHN')
    expect(FAMILY_CHAIN_LABEL_BN).toContain('Gemini')
  })
})

describe('provider registry — fal endpoint allowlist', () => {
  it('allowlists exactly the declared endpoints', () => {
    expect([...ALLOWED_FAL_ENDPOINTS].sort()).toEqual([
      'fal-ai/cat-vton',
      'fal-ai/fashn/tryon/v1.6',
      'fal-ai/flux-pro/v1/fill',
    ])
  })

  it('rejects injected endpoint ids', () => {
    expect(isAllowedFalEndpoint('fal-ai/cat-vton')).toBe(true)
    expect(isAllowedFalEndpoint('fal-ai/anything-else')).toBe(false)
    expect(isAllowedFalEndpoint('')).toBe(false)
  })
})

describe('CS6 — fal VTON helpers', () => {
  it('exactly the two fal VTON engines', () => {
    expect([...FAL_VTON_ENGINE_IDS].sort()).toEqual(['fal_fashn_v16', 'fal_idm_vton'])
    expect(isFalVtonEngine('fal_idm_vton')).toBe(true)
    expect(isFalVtonEngine('fashn')).toBe(false)
    expect(isFalVtonEngine('fal_flux_fill')).toBe(false)
  })

  it('cloth types match the owner-locked cat-vton mapping set', () => {
    for (const t of ['overall', 'upper', 'lower', 'outer']) expect(isVtonClothType(t)).toBe(true)
    expect(isVtonClothType('dress')).toBe(false)
    expect(isVtonClothType(null)).toBe(false)
  })
})

describe('provider registry — availability snapshot', () => {
  it('missing FAL_KEY yields configured:false without throwing', () => {
    const list = describeEngineAvailability({
      fashnConfigured: true,
      geminiConfigured: true,
      falConfigured: false,
      flags: {},
    })
    const idm = list.find((e) => e.id === 'fal_idm_vton')!
    expect(idm.configured).toBe(false)
    expect(idm.enabled).toBe(false)
    const fashn = list.find((e) => e.id === 'fashn')!
    expect(fashn.configured).toBe(true)
    expect(fashn.enabled).toBe(true)
  })

  it('owner flags gate each Fal engine independently', () => {
    const list = describeEngineAvailability({
      fashnConfigured: true,
      geminiConfigured: true,
      falConfigured: true,
      flags: {
        [CS_FAL_ENABLED_KEY]: true,
        [CS_IDM_VTON_ENABLED_KEY]: false,
        [CS_FLUX_FILL_ENABLED_KEY]: true,
      },
    })
    expect(list.find((e) => e.id === 'fal_fashn_v16')!.enabled).toBe(true)
    expect(list.find((e) => e.id === 'fal_idm_vton')!.enabled).toBe(false)
    expect(list.find((e) => e.id === 'fal_flux_fill')!.enabled).toBe(true)
  })
})
