import { describe, expect, it } from 'vitest'
import {
  normalizeStudioWebVersion,
  resolveStudioWebVersionPreference,
} from '@/agent/components/creative-studio/studio-version'

describe('Creative Studio web version preference', () => {
  it('accepts only the two production web surfaces', () => {
    expect(normalizeStudioWebVersion('v4')).toBe('v4')
    expect(normalizeStudioWebVersion('legacy')).toBe('legacy')
    expect(normalizeStudioWebVersion('preview')).toBeNull()
    expect(normalizeStudioWebVersion(null)).toBeNull()
  })

  it('gives an explicit URL choice priority over the stored fallback', () => {
    expect(resolveStudioWebVersionPreference('legacy', 'v4')).toBe('legacy')
    expect(resolveStudioWebVersionPreference('v4', 'legacy')).toBe('v4')
  })

  it('uses the stored choice only when the URL has no valid version', () => {
    expect(resolveStudioWebVersionPreference(null, 'legacy')).toBe('legacy')
    expect(resolveStudioWebVersionPreference('unknown', 'v4')).toBe('v4')
    expect(resolveStudioWebVersionPreference(undefined, undefined)).toBeNull()
  })
})
