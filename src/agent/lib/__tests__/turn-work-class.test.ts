/**
 * Owner, live 2026-07-27: "almatraders.com এর পুরো … ঠিক করে দাও" earned 60
 * rounds; tapping "হ্যাঁ, এখনই শুরু করুন" on the agent's own card earned 8. Same
 * job, two sizes, and the small one landed exactly when the work began.
 */
import { describe, it, expect } from 'vitest'
import {
  widerWorkClass,
  readRememberedWorkClass,
  effectiveWorkClass,
  isTurnWorkClass,
  WORK_CLASS_TTL_MS,
} from '@/agent/lib/turn-work-class'

const NOW = Date.parse('2026-07-27T12:00:00Z')
const live = new Date(NOW + 10 * 60_000)
const stale = new Date(NOW - 60_000)

describe('inheritance may only widen', () => {
  it('picks the wider of two classes', () => {
    expect(widerWorkClass('chat', 'deep')).toBe('deep')
    expect(widerWorkClass('long_run', 'deep')).toBe('long_run')
    expect(widerWorkClass('chat', 'chat')).toBe('chat')
  })

  it('a two-word answer inside a deep job runs deep', () => {
    const remembered = readRememberedWorkClass({ workClass: 'deep', workClassUntil: live }, NOW)
    expect(effectiveWorkClass('chat', remembered)).toBe('deep')
  })

  it('never shrinks a turn that asked for more than the job remembered', () => {
    const remembered = readRememberedWorkClass({ workClass: 'deep', workClassUntil: live }, NOW)
    expect(effectiveWorkClass('long_run', remembered)).toBe('long_run')
  })

  it('with nothing remembered the turn is exactly what it derived', () => {
    expect(effectiveWorkClass('chat', null)).toBe('chat')
    expect(effectiveWorkClass('deep', null)).toBe('deep')
  })
})

describe('the memory expires', () => {
  it('an expired class is not inherited', () => {
    expect(readRememberedWorkClass({ workClass: 'deep', workClassUntil: stale }, NOW)).toBeNull()
    expect(effectiveWorkClass('chat', readRememberedWorkClass({ workClass: 'deep', workClassUntil: stale }, NOW)))
      .toBe('chat')
  })

  it('accepts an ISO string as well as a Date', () => {
    expect(readRememberedWorkClass({ workClass: 'deep', workClassUntil: live.toISOString() }, NOW)?.workClass)
      .toBe('deep')
  })

  it('ignores junk rather than guessing', () => {
    expect(readRememberedWorkClass(null, NOW)).toBeNull()
    expect(readRememberedWorkClass({ workClass: 'enormous', workClassUntil: live }, NOW)).toBeNull()
    expect(readRememberedWorkClass({ workClass: 'deep' }, NOW)).toBeNull()
    expect(readRememberedWorkClass({ workClass: 'deep', workClassUntil: 'never' }, NOW)).toBeNull()
  })

  it('is long enough for an approval round-trip, short enough not to leak into tomorrow', () => {
    expect(WORK_CLASS_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000)
    expect(WORK_CLASS_TTL_MS).toBeLessThan(4 * 60 * 60_000)
  })

  it('validates the class names', () => {
    expect(isTurnWorkClass('deep')).toBe(true)
    expect(isTurnWorkClass('long_run')).toBe(true)
    expect(isTurnWorkClass('chat')).toBe(true)
    expect(isTurnWorkClass('huge')).toBe(false)
  })
})
