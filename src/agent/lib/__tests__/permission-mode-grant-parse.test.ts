/**
 * PM-1 — reading an elevation grant off the conversation row.
 *
 * A permission this system cannot fully verify is one it does not hand out, so
 * every malformed shape resolves to "no grant" rather than to a partial one.
 */
import { describe, it, expect } from 'vitest'
import { parseElevationGrant, modeVerdict } from '@/agent/lib/permission-mode'

describe('parseElevationGrant', () => {
  it('accepts a complete grant', () => {
    expect(parseElevationGrant({ families: ['public-publish'], expiresAt: '2026-07-27T12:30:00.000Z' }))
      .toEqual({ families: ['public-publish'], expiresAt: '2026-07-27T12:30:00.000Z' })
  })

  it('rejects anything without a real expiry', () => {
    expect(parseElevationGrant({ families: ['public-publish'] })).toBeNull()
    expect(parseElevationGrant({ families: ['public-publish'], expiresAt: '' })).toBeNull()
    expect(parseElevationGrant({ families: ['public-publish'], expiresAt: 'soon' })).toBeNull()
  })

  it('rejects anything without a named family', () => {
    expect(parseElevationGrant({ families: [], expiresAt: '2099-01-01T00:00:00Z' })).toBeNull()
    expect(parseElevationGrant({ expiresAt: '2099-01-01T00:00:00Z' })).toBeNull()
    expect(parseElevationGrant({ families: [''], expiresAt: '2099-01-01T00:00:00Z' })).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseElevationGrant(null)).toBeNull()
    expect(parseElevationGrant('elevated')).toBeNull()
    expect(parseElevationGrant(42)).toBeNull()
  })

  it('a rejected grant leaves elevated mode carding R3 — the safe direction', () => {
    const grant = parseElevationGrant({ families: ['public-publish'] }) // no expiry
    expect(modeVerdict({
      mode: 'elevated',
      tier: 'R3',
      taskClass: 'public-publish',
      grant,
      now: Date.parse('2026-07-27T12:00:00Z'),
    })).toBe('card')
  })
})
