import { describe, expect, it } from 'vitest'
import {
  defaultFundingPolicy,
  defaultFundingPolicies,
  mergeFundingPolicy,
  runwayThresholdsFor,
  effectiveMonthlyCapUsd,
} from '@/agent/lib/billing/funding-policy'
import { computeLowBalanceAlerts, type BalanceProviderRow } from '@/agent/lib/api-balances'

describe('defaultFundingPolicy', () => {
  it('assigns the critical preset to head/telephony providers', () => {
    const or = defaultFundingPolicy('openrouter')
    expect(or.criticality).toBe('critical')
    expect(or.warningDays).toBe(14)
    expect(or.actionDays).toBe(7)
    expect(or.emergencyDays).toBe(3)
    expect(or.targetDays).toBe(30)
  })

  it('treats xAI as critical (agent head runs on Grok)', () => {
    expect(defaultFundingPolicy('xai').criticality).toBe('critical')
  })

  it('keeps Twilio on its historical $5 wallet floor', () => {
    expect(defaultFundingPolicy('twilio').minBalanceUsd).toBe(5)
  })

  it('marks creative/research providers variable + approval-gated', () => {
    for (const id of ['fal', 'fashn', 'oxylabs'] as const) {
      const p = defaultFundingPolicy(id)
      expect(p.criticality).toBe('variable')
      expect(p.requiresApproval).toBe(true)
    }
  })

  it('disables funding monitoring for free providers', () => {
    const meta = defaultFundingPolicy('meta_free')
    expect(meta.criticality).toBe('free')
    expect(meta.enabled).toBe(false)
  })

  it('builds a full map for every known provider', () => {
    const all = defaultFundingPolicies()
    expect(all.anthropic.providerId).toBe('anthropic')
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(15)
  })
})

describe('mergeFundingPolicy', () => {
  const base = defaultFundingPolicy('openrouter')

  it('applies valid numeric + enum + boolean overrides', () => {
    const merged = mergeFundingPolicy(base, {
      warningDays: 21,
      criticality: 'important',
      requiresApproval: true,
      enabled: false,
    })
    expect(merged.warningDays).toBe(21)
    expect(merged.criticality).toBe('important')
    expect(merged.requiresApproval).toBe(true)
    expect(merged.enabled).toBe(false)
  })

  it('ignores negative / non-finite numeric overrides', () => {
    const merged = mergeFundingPolicy(base, {
      warningDays: -5,
      actionDays: Number.NaN,
      targetDays: Number.POSITIVE_INFINITY,
    })
    expect(merged.warningDays).toBe(base.warningDays)
    expect(merged.actionDays).toBe(base.actionDays)
    expect(merged.targetDays).toBe(base.targetDays)
  })

  it('distinguishes an explicit null cap from an unset cap', () => {
    expect(mergeFundingPolicy(base, { monthlyCapUsd: null }).monthlyCapUsd).toBeNull()
    expect(mergeFundingPolicy(base, { monthlyCapUsd: 200 }).monthlyCapUsd).toBe(200)
    expect(mergeFundingPolicy(base, {}).monthlyCapUsd).toBe(base.monthlyCapUsd)
  })

  it('returns the base unchanged when no override is given', () => {
    expect(mergeFundingPolicy(base)).toEqual(base)
  })
})

describe('runwayThresholdsFor', () => {
  it('extracts the three runway bands', () => {
    expect(runwayThresholdsFor(defaultFundingPolicy('twilio'))).toEqual({
      warningDays: 14, actionDays: 7, emergencyDays: 3,
    })
  })
})

describe('effectiveMonthlyCapUsd', () => {
  const base = defaultFundingPolicy('fal') // monthlyCapUsd null by default

  it('prefers an explicit owner cap', () => {
    const p = mergeFundingPolicy(base, { monthlyCapUsd: 120 })
    expect(effectiveMonthlyCapUsd(p, 999)).toBe(120)
  })

  it('derives 1.5x trailing spend, rounded up, when no cap is set', () => {
    expect(effectiveMonthlyCapUsd(base, 100)).toBe(150)
    expect(effectiveMonthlyCapUsd(base, 101)).toBe(152) // ceil(151.5)
  })

  it('is null when neither a cap nor trailing spend is known', () => {
    expect(effectiveMonthlyCapUsd(base, null)).toBeNull()
    expect(effectiveMonthlyCapUsd(base, 0)).toBeNull()
  })
})

// ---- computeLowBalanceAlerts wiring (Phase B) ----

function walletRow(
  id: BalanceProviderRow['id'],
  balanceUsd: number,
  runway?: { runwayStatus: BalanceProviderRow['runwayStatus']; runwayDays: number },
): BalanceProviderRow {
  return {
    id,
    label: id,
    balanceUsd,
    runwayStatus: runway?.runwayStatus,
    runwayDays: runway?.runwayDays,
    balanceKind: 'wallet',
    balanceAmount: balanceUsd,
    balanceCurrency: 'USD',
    balanceUnit: 'USD',
    todayUsd: 0,
    monthUsd: 0,
    source: 'test',
    sourceType: 'provider_api',
    costSourceType: 'provider_api',
    status: 'live',
    balanceAuthoritative: true,
    costAuthoritative: true,
    planAuthoritative: true,
    authoritative: true,
    fetchedAt: '2026-07-24T00:00:00.000Z',
    staleAfter: null,
    capabilities: ['wallet'],
  } as BalanceProviderRow
}

const CONFIGURED = {
  anthropic: true, openai: true, twilio: true, openrouter: true,
  fal: true, fashn: true, elevenlabs: true,
}

describe('computeLowBalanceAlerts — legacy floors (no policy)', () => {
  it('keeps the $3 general and $5 Twilio floors when no policy is passed', () => {
    const rows = [walletRow('openrouter', 2.5), walletRow('twilio', 4)]
    const alerts = computeLowBalanceAlerts(rows, {
      anthropicAdmin: false, openaiAdmin: false, twilioConfigured: true, creditSet: CONFIGURED,
    })
    expect(alerts.map((a) => a.provider).sort()).toEqual(['openrouter', 'twilio'])
    expect(alerts.find((a) => a.provider === 'twilio')?.thresholdUsd).toBe(5)
    expect(alerts.find((a) => a.provider === 'openrouter')?.thresholdUsd).toBe(3)
  })

  it('does not alert a wallet above the floor', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 10)], {
      anthropicAdmin: false, openaiAdmin: false, twilioConfigured: true, creditSet: CONFIGURED,
    })
    expect(alerts).toHaveLength(0)
  })
})

describe('computeLowBalanceAlerts — policy-driven floors', () => {
  it('uses the policy minBalanceUsd instead of the flat floor', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 8)], {
      anthropicAdmin: false, openaiAdmin: false, twilioConfigured: true, creditSet: CONFIGURED,
      policies: { openrouter: { minBalanceUsd: 10, enabled: true } },
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0].thresholdUsd).toBe(10)
  })

  it('skips a provider whose policy is disabled', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 1)], {
      anthropicAdmin: false, openaiAdmin: false, twilioConfigured: true, creditSet: CONFIGURED,
      policies: { openrouter: { minBalanceUsd: 10, enabled: false } },
    })
    expect(alerts).toHaveLength(0)
  })
})

describe('computeLowBalanceAlerts — runway-aware (Phase D)', () => {
  const base = { anthropicAdmin: false, openaiAdmin: false, twilioConfigured: true, creditSet: CONFIGURED }

  it('alerts on an emergency runway even when the balance is above the flat floor', () => {
    // $100 balance (well above $3 floor) but only 2 days of runway
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 100, { runwayStatus: 'emergency', runwayDays: 2 })], base)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('emergency')
    expect(alerts[0].reason).toBe('low_runway')
    expect(alerts[0].runwayDays).toBe(2)
  })

  it('alerts at action severity for an action-band runway', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 100, { runwayStatus: 'action', runwayDays: 6 })], base)
    expect(alerts[0].severity).toBe('action')
    expect(alerts[0].reason).toBe('low_runway')
  })

  it('does not alert a healthy runway with a healthy balance', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 100, { runwayStatus: 'ok', runwayDays: 60 })], base)
    expect(alerts).toHaveLength(0)
  })

  it('still fires a low_balance alert when runway is ok but the wallet is under the floor', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 1, { runwayStatus: 'ok', runwayDays: 40 })], base)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].reason).toBe('low_balance')
    expect(alerts[0].severity).toBe('action')
  })

  it('respects a disabled policy even under an emergency runway', () => {
    const alerts = computeLowBalanceAlerts([walletRow('openrouter', 100, { runwayStatus: 'emergency', runwayDays: 1 })], {
      ...base,
      policies: { openrouter: { minBalanceUsd: 3, enabled: false } },
    })
    expect(alerts).toHaveLength(0)
  })
})
