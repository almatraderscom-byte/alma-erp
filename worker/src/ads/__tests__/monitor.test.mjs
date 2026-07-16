/**
 * Phase 45 — pure anomaly detectors in the ads monitor.
 * Run: node --test worker/src/ads/__tests__/monitor.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCtrAnomaly, detectSpendAnomaly, detectFrequencyFatigue } from '../monitor.mjs'

test('CTR anomaly: fires below 60% of the 7-day average, silent otherwise', () => {
  const hit = detectCtrAnomaly({ todayCtr: 0.01, weekCtr: 0.02, spend: 300 })
  assert.equal(hit.kind, 'ctr_drop')
  assert.equal(hit.dropPct, 50)

  assert.equal(detectCtrAnomaly({ todayCtr: 0.015, weekCtr: 0.02, spend: 300 }), null)
  // no spend or no baseline → no verdict (thin data stays silent)
  assert.equal(detectCtrAnomaly({ todayCtr: 0.01, weekCtr: 0, spend: 300 }), null)
  assert.equal(detectCtrAnomaly({ todayCtr: 0.01, weekCtr: 0.02, spend: 0 }), null)
})

test('spend anomaly: >175% of daily budget = high, >125% = medium pacing note, inside = silent', () => {
  const high = detectSpendAnomaly({ todaySpendBdt: 1800, dailyBudgetBdt: 1000 })
  assert.equal(high.kind, 'overspend')
  assert.equal(high.severity, 'high')

  const med = detectSpendAnomaly({ todaySpendBdt: 1300, dailyBudgetBdt: 1000 })
  assert.equal(med.kind, 'pacing_high')
  assert.equal(med.severity, 'medium')

  assert.equal(detectSpendAnomaly({ todaySpendBdt: 900, dailyBudgetBdt: 1000 }), null)
  // no budget known → silent (never alert on missing data)
  assert.equal(detectSpendAnomaly({ todaySpendBdt: 900, dailyBudgetBdt: 0 }), null)
})

test('frequency fatigue: >4 flags with rotation advice, ≤4 silent', () => {
  const hit = detectFrequencyFatigue({ frequency: 5.3 })
  assert.equal(hit.kind, 'frequency_fatigue')
  assert.ok(hit.detail.includes('creative'))

  assert.equal(detectFrequencyFatigue({ frequency: 3.9 }), null)
  assert.equal(detectFrequencyFatigue({ frequency: 0 }), null)
})
