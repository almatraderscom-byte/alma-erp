import { describe, it, expect, vi, beforeEach } from 'vitest'

// Control the Phase-1 policy decision the bridge consults.
const mockPolicy = vi.hoisted(() => ({ evaluateAction: vi.fn() }))
vi.mock('@/agent/lib/autonomy-policy', () => mockPolicy)

import { decideCsAutoSend } from '@/agent/lib/cs/autonomy-bridge'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('decideCsAutoSend', () => {
  it('escalates low-confidence replies to a human without consulting policy', async () => {
    const d = await decideCsAutoSend({ confidenceScore: 0.3, confidenceEscalate: true })
    expect(d.action).toBe('escalate')
    expect(d.record).toBe(false)
    expect(mockPolicy.evaluateAction).not.toHaveBeenCalled()
  })

  it('passes through (send, no ledger) when the master switch is OFF — current behaviour preserved', async () => {
    mockPolicy.evaluateAction.mockResolvedValue({ mode: 'ask', reason: 'off', riskTier: 'medium', policyEnabled: false })
    const d = await decideCsAutoSend({ confidenceScore: 0.9, confidenceEscalate: false })
    expect(d.action).toBe('send')
    expect(d.record).toBe(false)
    expect(d.autonomyMode).toBeNull()
  })

  it('consults cs_reply as a REVERSIBLE action', async () => {
    mockPolicy.evaluateAction.mockResolvedValue({ mode: 'auto', reason: 'ok', riskTier: 'low', policyEnabled: true })
    await decideCsAutoSend({ confidenceScore: 0.95, confidenceEscalate: false, summary: 's' })
    expect(mockPolicy.evaluateAction).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'cs_reply', reversible: true, confidence: 0.95 }),
    )
  })

  it('auto-sends AND records to the ledger when policy returns auto', async () => {
    mockPolicy.evaluateAction.mockResolvedValue({ mode: 'auto', reason: 'নিজে করব', riskTier: 'low', policyEnabled: true })
    const d = await decideCsAutoSend({ confidenceScore: 0.95, confidenceEscalate: false })
    expect(d.action).toBe('send')
    expect(d.record).toBe(true)
    expect(d.autonomyMode).toBe('auto')
  })

  it('holds for owner approval when policy returns propose', async () => {
    mockPolicy.evaluateAction.mockResolvedValue({ mode: 'propose', reason: 'প্রস্তাব', riskTier: 'medium', policyEnabled: true })
    const d = await decideCsAutoSend({ confidenceScore: 0.85, confidenceEscalate: false })
    expect(d.action).toBe('hold')
    expect(d.record).toBe(false)
    expect(d.autonomyMode).toBe('propose')
  })

  it('holds for owner approval when policy returns ask', async () => {
    mockPolicy.evaluateAction.mockResolvedValue({ mode: 'ask', reason: 'অনুমতি', riskTier: 'medium', policyEnabled: true })
    const d = await decideCsAutoSend({ confidenceScore: 0.85, confidenceEscalate: false })
    expect(d.action).toBe('hold')
    expect(d.autonomyMode).toBe('ask')
  })

  it('fails safe to send if the policy read throws — never breaks the live pipeline', async () => {
    mockPolicy.evaluateAction.mockRejectedValue(new Error('kv down'))
    const d = await decideCsAutoSend({ confidenceScore: 0.9, confidenceEscalate: false })
    expect(d.action).toBe('send')
    expect(d.record).toBe(false)
  })
})
