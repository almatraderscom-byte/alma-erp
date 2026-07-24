import { describe, expect, it } from 'vitest'
import { enrichProviderRunway, type BalanceProviderRow, type ProviderBurnWindowRow } from '@/agent/lib/api-balances'
import { defaultFundingPolicies } from '@/agent/lib/billing/funding-policy'

function row(partial: Partial<BalanceProviderRow> & Pick<BalanceProviderRow, 'id'>): BalanceProviderRow {
  return {
    label: partial.id,
    balanceUsd: null,
    balanceKind: 'none',
    balanceAmount: null,
    balanceCurrency: null,
    balanceUnit: null,
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
    capabilities: [],
    ...partial,
  } as BalanceProviderRow
}

const policies = defaultFundingPolicies()

describe('enrichProviderRunway (Phase C server enrichment)', () => {
  it('computes a wallet runway + attaches tier/funding mode', () => {
    const twilio = row({ id: 'twilio', balanceKind: 'wallet', balanceUsd: 30 })
    const burn: Record<string, ProviderBurnWindowRow> = {
      twilio: { totalUsd: 35, activeDays: 7 }, // $5/day
    }
    enrichProviderRunway([twilio], burn, { twilio: 100 }, policies)

    expect(twilio.burnUsdPerDay).toBe(5)
    expect(twilio.runwayDays).toBe(6) // 30 / 5
    expect(twilio.runwayStatus).toBe('action') // <= 7-day action band
    expect(twilio.runwayConfident).toBe(true)
    expect(twilio.criticality).toBe('critical')
    expect(twilio.fundingMode).toBe('provider_auto_recharge')
  })

  it('leaves runway unknown for a quota/postpaid provider (no wallet)', () => {
    const eleven = row({ id: 'elevenlabs', balanceKind: 'quota', balanceUsd: null })
    enrichProviderRunway([eleven], { elevenlabs: { totalUsd: 10, activeDays: 5 } }, {}, policies)

    expect(eleven.runwayDays).toBeNull()
    expect(eleven.runwayStatus).toBe('unknown')
    expect(eleven.suggestedTopUpUsd).toBeNull()
    expect(eleven.criticality).toBe('important')
  })

  it('suggests a top-up when a wallet is below its target runway', () => {
    const openrouter = row({ id: 'openrouter', balanceKind: 'wallet', balanceUsd: 20 })
    // $10/day burn, target 30 days → $300 target; needs ~$280
    enrichProviderRunway([openrouter], { openrouter: { totalUsd: 70, activeDays: 7 } }, { openrouter: 200 }, policies)

    expect(openrouter.burnUsdPerDay).toBe(10)
    expect(openrouter.runwayDays).toBe(2)
    expect(openrouter.runwayStatus).toBe('emergency')
    expect(openrouter.suggestedTopUpUsd).not.toBeNull()
    expect(openrouter.suggestedTopUpUsd!).toBeGreaterThan(0)
  })

  it('marks a healthy wallet ok with no top-up suggestion', () => {
    const xai = row({ id: 'xai', balanceKind: 'wallet', balanceUsd: 500 })
    enrichProviderRunway([xai], { xai: { totalUsd: 35, activeDays: 7 } }, { xai: 100 }, policies) // $5/day → 100 days
    expect(xai.runwayStatus).toBe('ok')
    expect(xai.suggestedTopUpUsd).toBeNull()
  })

  it('flags low confidence when only one active spend-day backs the burn', () => {
    const fal = row({ id: 'fal', balanceKind: 'wallet', balanceUsd: 50 })
    enrichProviderRunway([fal], { fal: { totalUsd: 10, activeDays: 1 } }, { fal: 30 }, policies)
    expect(fal.runwayConfident).toBe(false)
    expect(fal.runwayDays).toBe(5) // 50 / 10
  })

  it('leaves free providers untouched', () => {
    const meta = row({ id: 'meta_free', free: true })
    enrichProviderRunway([meta], {}, {}, policies)
    expect(meta.runwayStatus).toBeUndefined()
    expect(meta.criticality).toBeUndefined()
  })

  it('handles an idle wallet (no recent spend) as unknown runway, not infinite', () => {
    const fashn = row({ id: 'fashn', balanceKind: 'wallet', balanceUsd: 40 })
    enrichProviderRunway([fashn], {}, {}, policies) // no burn window entry
    expect(fashn.burnUsdPerDay).toBeNull()
    expect(fashn.runwayDays).toBeNull()
    expect(fashn.runwayStatus).toBe('unknown')
  })
})
