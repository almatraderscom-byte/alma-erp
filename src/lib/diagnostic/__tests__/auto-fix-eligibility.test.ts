import { describe, it, expect } from 'vitest'
import { isAutoFixEligible } from '@/lib/diagnostic/auto-fix-eligibility'

describe('isAutoFixEligible', () => {
  it('blocks all website/inventory health issues', () => {
    expect(isAutoFixEligible({ area: 'website', signal: 'website:live_out_of_stock' })).toBe(false)
    expect(isAutoFixEligible({ area: 'website', signal: 'website:price_mismatch' })).toBe(false)
    expect(isAutoFixEligible({ signal: 'website:not_configured' })).toBe(false)
  })

  it('allows production infra/code issues', () => {
    expect(isAutoFixEligible({ area: 'heartbeat', signal: 'AgentHeartbeat service=agent-worker' })).toBe(true)
    expect(isAutoFixEligible({ area: 'scheduler', signal: 'AgentDutyLog duty=night-report' })).toBe(true)
    expect(isAutoFixEligible({ area: 'vercel', signal: 'vercel_alert key=x' })).toBe(true)
  })

  it('blocks informational cost/approval backlog', () => {
    expect(isAutoFixEligible({ area: 'cost', signal: 'AgentCostEvent provider=anthropic' })).toBe(false)
    expect(isAutoFixEligible({ area: 'approvals', signal: 'AgentPendingAction status=pending' })).toBe(false)
  })
})
