import { describe, expect, it } from 'vitest'
import {
  CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV,
  CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV,
  getCreativeStudioV3FoundationFlags,
  getCreativeStudioV4PreviewFoundationFlags,
} from '@/lib/creative-studio/composition-feature-flags'

describe('Creative Studio V3 foundation feature flags', () => {
  it('defaults to legacy-only and fail-closed', () => {
    expect(getCreativeStudioV3FoundationFlags({})).toEqual({
      mode: 'off',
      readEnabled: false,
      commandPlanningEnabled: false,
      writesEnabled: false,
      legacyDefault: true,
      legacyFallback: true,
      rollbackActive: false,
    })
  })

  it('allows read/plan shadowing without writes', () => {
    expect(getCreativeStudioV3FoundationFlags({
      [CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]: 'shadow',
      [CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]: 'true',
    })).toMatchObject({
      mode: 'shadow',
      readEnabled: true,
      commandPlanningEnabled: true,
      writesEnabled: false,
      legacyDefault: true,
      legacyFallback: true,
    })
  })

  it('requires both enforce mode and the independent write switch', () => {
    expect(getCreativeStudioV3FoundationFlags({
      [CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]: 'enforce',
    }).writesEnabled).toBe(false)
    expect(getCreativeStudioV3FoundationFlags({
      [CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]: 'enforce',
      [CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]: 'true',
    }).writesEnabled).toBe(true)
  })

  it('makes rollback an explicit legacy-only state', () => {
    expect(getCreativeStudioV3FoundationFlags({
      [CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]: 'rollback',
      [CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]: 'true',
    })).toMatchObject({
      mode: 'rollback',
      readEnabled: false,
      writesEnabled: false,
      rollbackActive: true,
      legacyDefault: true,
      legacyFallback: true,
    })
  })

  it('enables the complete foundation only for the system-owner V4 preview', () => {
    expect(getCreativeStudioV4PreviewFoundationFlags({
      actorIsSystemOwner: true,
      requestedStudio: 'v4',
    }, {
      VERCEL_ENV: 'preview',
    })).toMatchObject({
      mode: 'enforce',
      readEnabled: true,
      commandPlanningEnabled: true,
      writesEnabled: true,
      rollbackActive: false,
    })

    for (const input of [
      {
        context: { actorIsSystemOwner: false, requestedStudio: 'v4' },
        env: { VERCEL_ENV: 'preview' },
      },
      {
        context: { actorIsSystemOwner: true, requestedStudio: 'legacy' },
        env: { VERCEL_ENV: 'preview' },
      },
      {
        context: { actorIsSystemOwner: true, requestedStudio: 'v4' },
        env: { VERCEL_ENV: 'production' },
      },
    ]) {
      expect(getCreativeStudioV4PreviewFoundationFlags(
        input.context,
        input.env,
      )).toMatchObject({
        mode: 'off',
        readEnabled: false,
        writesEnabled: false,
      })
    }
  })
})
