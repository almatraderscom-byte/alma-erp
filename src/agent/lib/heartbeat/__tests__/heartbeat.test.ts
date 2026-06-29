import { describe, it, expect } from 'vitest'
import { pulseFingerprint, type HeartbeatPulse } from '@/agent/lib/heartbeat/heartbeat-log'
import { pulseIsActionable } from '@/agent/lib/heartbeat/brain'

function pulse(over: Partial<HeartbeatPulse> = {}): HeartbeatPulse {
  return { pendingApprovals: 0, ownerEscalations: 0, openTodos: 0, ...over }
}

describe('pulseFingerprint (change-detection — the head-wake cost gate)', () => {
  it('two identical pulses share a fingerprint (head will NOT re-wake)', () => {
    expect(pulseFingerprint(pulse({ pendingApprovals: 2, openTodos: 3 }))).toBe(
      pulseFingerprint(pulse({ pendingApprovals: 2, openTodos: 3 })),
    )
  })

  it('any count change yields a different fingerprint (head MAY wake)', () => {
    const a = pulseFingerprint(pulse({ pendingApprovals: 1 }))
    expect(pulseFingerprint(pulse({ pendingApprovals: 2 }))).not.toBe(a)
    expect(pulseFingerprint(pulse({ ownerEscalations: 1 }))).not.toBe(a)
    expect(pulseFingerprint(pulse({ openTodos: 1 }))).not.toBe(a)
  })
})

describe('pulseIsActionable (only act when something is going on)', () => {
  it('an all-zero pulse is NOT actionable (quiet → idle heartbeat)', () => {
    expect(pulseIsActionable(pulse())).toBe(false)
  })

  it('any non-zero signal makes the pulse actionable', () => {
    expect(pulseIsActionable(pulse({ pendingApprovals: 1 }))).toBe(true)
    expect(pulseIsActionable(pulse({ ownerEscalations: 1 }))).toBe(true)
    expect(pulseIsActionable(pulse({ openTodos: 1 }))).toBe(true)
  })

  it('a change from N→0 is detectable yet not actionable (records idle, no wake)', () => {
    const before = pulse({ pendingApprovals: 3 })
    const after = pulse({ pendingApprovals: 0 })
    expect(pulseFingerprint(before)).not.toBe(pulseFingerprint(after)) // changed
    expect(pulseIsActionable(after)).toBe(false) // but nothing to act on
  })
})
