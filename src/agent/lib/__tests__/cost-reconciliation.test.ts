import { describe, it, expect } from 'vitest'
import { buildReconciliation } from '@/agent/lib/cost-reconciliation'
import type { BalanceProviderRow } from '@/agent/lib/api-balances'

/**
 * Monthly reconciliation — local estimate vs provider-published bill.
 * The canonical case is the 2026-07-24 incident itself: a provider whose local
 * estimate ran far above the real published bill must be FLAGGED (LOCAL_HIGH),
 * not silently trusted.
 */
function row(p: Partial<BalanceProviderRow> & { id: string; label: string }): BalanceProviderRow {
  return {
    balanceUsd: null, balanceKind: 'none', balanceAmount: null, balanceCurrency: null,
    balanceUnit: null, todayUsd: null, monthUsd: null, source: 't', sourceType: 'provider_api',
    costSourceType: 'provider_api', status: 'live', balanceAuthoritative: false,
    costAuthoritative: false, planAuthoritative: false, authoritative: true,
    fetchedAt: '2026-07-25T00:00:00Z', staleAfter: null, capabilities: ['cost'],
    ...p,
  } as BalanceProviderRow
}

describe('monthly reconciliation', () => {
  const balances = [
    // The incident: OpenAI bucket local estimate $6.07 vs real published $2.71.
    row({ id: 'openai', label: 'OpenAI', costAuthoritative: true, providerMonthUsd: 2.71, monthUsd: 6.07, syncedThrough: '2026-07-23' }),
    // Healthy: local matches provider within tolerance.
    row({ id: 'anthropic', label: 'Anthropic', costAuthoritative: true, providerMonthUsd: 5.39, monthUsd: 5.41, syncedThrough: '2026-07-23' }),
    // Infra: published cost, no local metering (never reconciled, just shown).
    row({ id: 'vercel', label: 'Vercel', costAuthoritative: true, providerMonthUsd: 128.05, monthUsd: 128.05, syncedThrough: '2026-07-23' }),
    // Metered but provider publishes no authoritative cost → estimate only.
    row({ id: 'gemini', label: 'Gemini', costAuthoritative: false, providerMonthUsd: null, monthUsd: 28 }),
  ]

  // Local sums for the same window as each provider's published figure.
  const local: Record<string, number> = { openai: 6.02, anthropic: 5.4, xai: 4.3 }
  const lookup = (id: string) => local[id] ?? 0

  it('flags the provider whose local estimate exceeds the real bill', () => {
    const r = buildReconciliation(balances, lookup)
    const openai = r.providers.find((p) => p.id === 'openai')!
    expect(openai.status).toBe('LOCAL_HIGH')
    expect(openai.driftUsd).toBeGreaterThan(3) // ~6.02 - 2.71
    expect(r.flagged[0]?.id).toBe('openai') // worst drift first
  })

  it('reconciles a provider whose local matches the bill', () => {
    const r = buildReconciliation(balances, lookup)
    expect(r.providers.find((p) => p.id === 'anthropic')!.status).toBe('RECONCILED')
  })

  it('marks infra cost (no local counterpart) as INFRA, not drift', () => {
    const r = buildReconciliation(balances, lookup)
    const vercel = r.providers.find((p) => p.id === 'vercel')!
    expect(vercel.status).toBe('INFRA')
    expect(vercel.localEstimateUsd).toBeNull()
    expect(r.flagged.some((p) => p.id === 'vercel')).toBe(false)
  })

  it('marks an unverifiable (estimate-only) provider as UNVERIFIED', () => {
    const r = buildReconciliation(balances, lookup)
    expect(r.providers.find((p) => p.id === 'gemini')!.status).toBe('UNVERIFIED')
  })

  it('totals only the like-for-like reconcilable providers', () => {
    const r = buildReconciliation(balances, lookup)
    // openai (2.71) + anthropic (5.39) published; vercel/gemini excluded.
    expect(r.totals.providerActualUsd).toBeCloseTo(8.1, 2)
    expect(r.totals.localEstimateUsd).toBeCloseTo(11.42, 2) // 6.02 + 5.4
  })

  it('respects tolerance — a tiny absolute gap never flags', () => {
    const r = buildReconciliation(balances, lookup, { tolerancePct: 20, toleranceUsd: 1 })
    // anthropic gap is $0.01 → under the $1 floor, stays RECONCILED even though
    // percent-wise it is small anyway.
    expect(r.providers.find((p) => p.id === 'anthropic')!.status).toBe('RECONCILED')
  })
})
