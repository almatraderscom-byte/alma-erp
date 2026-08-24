import { describe, expect, it } from 'vitest'
import { liveVoiceToolInput, liveVoiceToolResult } from '../route'

describe('live voice read-only tool input', () => {
  it('supplies an explicit Dhaka today/today window for sales', () => {
    // 18:30 UTC is already the next day in Bangladesh.
    expect(liveVoiceToolInput(
      'get_sales_summary',
      undefined,
      new Date('2026-08-11T18:30:00.000Z'),
    )).toEqual({ from: '2026-08-12', to: '2026-08-12' })
  })

  it('does not let the narrow today fast lane widen the sales window', () => {
    expect(liveVoiceToolInput(
      'get_sales_summary',
      { from: '2020-01-01', to: '2030-01-01' },
      new Date('2026-08-11T10:00:00.000Z'),
    )).toEqual({ from: '2026-08-11', to: '2026-08-11' })
  })

  it('preserves ordinary read-only inputs without aliasing the caller object', () => {
    const input = { status: 'pending' }
    const result = liveVoiceToolInput('get_orders', input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })
})

describe('live voice reference rollout boundary', () => {
  it('never falls back to a successful top-level envelope when data is absent', () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    expect(liveVoiceToolResult({
      success: true,
      references: [{ refId: 'must-not-reach-provider' }],
    })).toBeNull()
  })

  it('keeps ordinary data but strips hidden refs from failure envelopes', () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'off'
    expect(liveVoiceToolResult({ success: true, data: { count: 2 }, references: [{}] }))
      .toEqual({ count: 2 })
    expect(liveVoiceToolResult({ success: false, error: 'nope', references: [{}] }))
      .toEqual({ success: false, error: 'nope' })
  })
})
