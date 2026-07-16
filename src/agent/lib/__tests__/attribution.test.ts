import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { computeProfitAttribution, reconcileCounts, labelled } from '@/agent/lib/marketing/attribution'

describe('computeProfitAttribution — observed / modelled / unknown labels', () => {
  it('full data: spend observed, profit modelled from margin, math correct in whole taka', () => {
    const p = computeProfitAttribution({
      spendBdt: 8000,
      revenueDeliveredBdt: 40000,
      revenueConfirmedBdt: 52000,
      deliveredCount: 20,
      fallbackMarginPct: 35,
    })
    expect(p.spend).toMatchObject({ value: 8000, basis: 'observed' })
    expect(p.deliveredRevenue).toMatchObject({ value: 40000, basis: 'observed' })
    expect(p.grossProfit).toMatchObject({ value: 14000, basis: 'modelled' }) // 35% of 40000
    expect(p.profitAfterSpend).toMatchObject({ value: 6000, basis: 'modelled' })
    expect(p.costPerDelivered.value).toBe(400)
    expect(p.costPerDelivered.basis).toBe('modelled') // blended CAC assumption stated
    expect(p.costPerDelivered.note).toContain('overstates')
  })

  it('delivered revenue missing → confirmed proxy is labelled modelled, never observed', () => {
    const p = computeProfitAttribution({
      spendBdt: 5000, revenueDeliveredBdt: null, revenueConfirmedBdt: 30000, deliveredCount: null, fallbackMarginPct: 30,
    })
    expect(p.deliveredRevenue.basis).toBe('modelled')
    expect(p.deliveredRevenue.note).toContain('proxy')
    expect(p.costPerDelivered.basis).toBe('unknown')
  })

  it('no margin data → profit is unknown, not silently zero', () => {
    const p = computeProfitAttribution({
      spendBdt: 5000, revenueDeliveredBdt: 20000, revenueConfirmedBdt: null, deliveredCount: 10, fallbackMarginPct: null,
    })
    expect(p.grossProfit).toMatchObject({ value: null, basis: 'unknown' })
    expect(p.profitAfterSpend.basis).toBe('unknown')
  })

  it('nothing readable → everything unknown', () => {
    const p = computeProfitAttribution({
      spendBdt: null, revenueDeliveredBdt: null, revenueConfirmedBdt: null, deliveredCount: null, fallbackMarginPct: null,
    })
    for (const v of [p.spend, p.deliveredRevenue, p.grossProfit, p.profitAfterSpend, p.costPerDelivered]) {
      expect(v.basis).toBe('unknown')
      expect(v.value).toBeNull()
    }
  })

  it('labelled() rounds money to whole taka', () => {
    expect(labelled(99.7, 'observed', 'x').value).toBe(100)
  })
})

describe('reconcileCounts — cross-source truth check', () => {
  const base = { windowDays: 7, ga4KeyEvents: 40, metaPurchases: 18 }

  it('healthy: ledger ≈ ERP → no issues, high confidence', () => {
    const r = reconcileCounts({ ...base, erp: { confirmed: 20, delivered: 15 }, ledger: { order_confirmed: 19 } })
    expect(r.issues).toEqual([])
    expect(r.confidence).toBe(1)
  })

  it('ERP orders but empty ledger → missing pipeline (high)', () => {
    const r = reconcileCounts({ ...base, erp: { confirmed: 20, delivered: 15 }, ledger: {} })
    expect(r.issues[0]).toMatchObject({ kind: 'missing_pipeline', severity: 'high' })
    expect(r.confidence).toBeLessThan(1)
  })

  it('ledger has MORE events than ERP orders → duplicate emission flagged high', () => {
    const r = reconcileCounts({ ...base, erp: { confirmed: 10, delivered: 8 }, ledger: { order_confirmed: 14 } })
    expect(r.issues.some((i) => i.kind === 'count_mismatch' && i.severity === 'high' && /duplicate/i.test(i.detail))).toBe(true)
  })

  it('partial capture (<80%) flagged medium', () => {
    const r = reconcileCounts({ ...base, erp: { confirmed: 20, delivered: 15 }, ledger: { order_confirmed: 12 } })
    expect(r.issues.some((i) => i.kind === 'count_mismatch' && i.severity === 'medium')).toBe(true)
  })

  it('unreadable GA4/Meta are labelled missing pipelines, confidence floors at 0', () => {
    const r = reconcileCounts({ windowDays: 7, erp: { confirmed: 20, delivered: 0 }, ledger: {}, ga4KeyEvents: null, metaPurchases: null })
    const kinds = r.issues.map((i) => i.kind)
    expect(kinds.filter((k) => k === 'missing_pipeline').length).toBeGreaterThanOrEqual(3)
    expect(r.confidence).toBeGreaterThanOrEqual(0)
    expect(r.counts.find((c) => c.source === 'ga4')!.value).toBeNull()
  })
})
