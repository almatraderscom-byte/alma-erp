import { describe, expect, it } from 'vitest'
import { contractToolFailureText, findContractToolFailure } from '@/agent/lib/contract-tool-failure'

describe('required tool failure turn stop', () => {
  const records = [
    { toolName: 'live_browser_act', status: 'success' as const, error: null },
    { toolName: 'live_browser_look', status: 'error' as const, error: 'Frame is showing error page' },
  ]

  it('recognizes only the required failed tool', () => {
    expect(findContractToolFailure('live_browser_look', records)).toBe(records[1])
    expect(findContractToolFailure('live_browser_act', records)).toBeUndefined()
    expect(findContractToolFailure(null, records)).toBeUndefined()
  })

  it('builds a deterministic honest final reply without another model round', () => {
    const failed = findContractToolFailure('live_browser_look', records)!
    const text = contractToolFailureText(failed)
    expect(text).toContain('live_browser_look')
    expect(text).toContain('Frame is showing error page')
    expect(text).toContain('কাজ সম্পন্ন বলছি না')
  })
})
