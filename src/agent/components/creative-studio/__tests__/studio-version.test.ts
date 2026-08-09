import { describe, expect, it } from 'vitest'
import {
  canSwitchToStudioV4,
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

  it('admits every project under a server-approved brand target', () => {
    expect(canSwitchToStudioV4(
      [{ brandProfileId: 'brand-a', projectId: null }],
      'brand-a',
      'project-any',
    )).toBe(true)
  })

  it('admits only the matching project for a project-scoped target', () => {
    const targets = [{ brandProfileId: 'brand-a', projectId: 'project-a' }]
    expect(canSwitchToStudioV4(targets, 'brand-a', 'project-a')).toBe(true)
    expect(canSwitchToStudioV4(targets, 'brand-a', 'project-b')).toBe(false)
    expect(canSwitchToStudioV4(targets, 'brand-b', 'project-a')).toBe(false)
    expect(canSwitchToStudioV4(targets, null, 'project-a')).toBe(false)
  })
})
