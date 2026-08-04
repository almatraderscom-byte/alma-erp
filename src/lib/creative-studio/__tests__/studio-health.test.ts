import { describe, expect, it } from 'vitest'
import { classifyWorkerHeartbeat, formatHeartbeatAgeBn } from '../studio-health'

describe('Studio worker health states', () => {
  const now = Date.parse('2026-07-24T12:00:00.000Z')

  it('distinguishes healthy, delayed, offline and unknown', () => {
    expect(classifyWorkerHeartbeat('2026-07-24T11:59:00.000Z', now).state).toBe('healthy')
    expect(classifyWorkerHeartbeat('2026-07-24T11:55:00.000Z', now).state).toBe('delayed')
    expect(classifyWorkerHeartbeat('2026-07-24T11:40:00.000Z', now).state).toBe('offline')
    expect(classifyWorkerHeartbeat(null, now).state).toBe('unknown')
    expect(classifyWorkerHeartbeat('invalid', now).state).toBe('unknown')
  })

  it('formats a useful Bangla last-seen age', () => {
    expect(formatHeartbeatAgeBn(null)).toContain('পাওয়া যায়নি')
    expect(formatHeartbeatAgeBn(75)).toBe('1 মিনিট আগে')
    expect(formatHeartbeatAgeBn(7200)).toBe('2 ঘণ্টা আগে')
  })
})
