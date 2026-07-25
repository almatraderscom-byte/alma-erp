import { describe, expect, it } from 'vitest'
import { getUsageThreshold } from '@/agent/lib/usage-threshold'

describe('usage intelligence warning thresholds', () => {
  it('stays normal below 70 percent', () => {
    expect(getUsageThreshold(69.9)).toBe('normal')
  })

  it('turns warning yellow from 70 percent', () => {
    expect(getUsageThreshold(70)).toBe('warning')
    expect(getUsageThreshold(89.9)).toBe('warning')
  })

  it('turns critical red from 90 percent', () => {
    expect(getUsageThreshold(90)).toBe('critical')
    expect(getUsageThreshold(100)).toBe('critical')
  })
})
