import { describe, it, expect } from 'vitest'
import {
  detectFakeOrderSignals,
  buildLifecycleActions,
  planLifecycleActions,
} from '@/agent/lib/orders/lifecycle-autonomy'
import type { AutonomyPolicy } from '@/agent/lib/autonomy-policy'
import type { AgentOrder } from '@/lib/agent-api/orders.schema'
import type { OrderIssue } from '@/lib/order-monitor'

// A real (DB-free) policy with the master switch ON and every category set to 'auto',
// so we can prove the engine's OWN safety caps (irreversible never auto, etc.) — not
// the policy defaults — are what hold the line.
function permissivePolicy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    enabled: true,
    moneyCapTaka: 100000,
    confidenceMin: 0.5,
    categoryModes: {
      cs_reply: 'auto',
      order_confirm: 'auto',
      order_followup: 'auto',
      reorder: 'auto',
      finance: 'auto',
      marketing: 'auto',
      staff_task: 'auto',
      other: 'auto',
    },
    ...overrides,
  }
}

function order(o: Partial<AgentOrder>): AgentOrder {
  return {
    id: 'id-1',
    orderNumber: 'A-1',
    customerName: 'Karim',
    customerPhone: '01712345678',
    totalAmount: 1200,
    currency: 'BDT',
    status: 'pending',
    placedAt: '2026-06-29T00:00:00.000Z',
    itemCount: 2,
    ...o,
  } as AgentOrder
}

describe('detectFakeOrderSignals', () => {
  it('passes a clean, deliverable order', () => {
    expect(detectFakeOrderSignals([order({})])).toHaveLength(0)
  })

  it('flags a test/fake customer name', () => {
    const out = detectFakeOrderSignals([order({ customerName: 'test order' })])
    expect(out).toHaveLength(1)
    expect(out[0].reasons.some((r) => r.includes('টেস্ট'))).toBe(true)
  })

  it('flags a Bangla টেস্ট / ভুয়া name', () => {
    expect(detectFakeOrderSignals([order({ customerName: 'ভুয়া কাস্টমার' })])).toHaveLength(1)
  })

  it('flags an undeliverable phone (wrong length / not 1XXXXXXXXX)', () => {
    const bad = detectFakeOrderSignals([order({ customerName: 'Karim', customerPhone: '12345' })])
    expect(bad).toHaveLength(1)
    expect(bad[0].reasons.some((r) => r.includes('ফোন'))).toBe(true)
  })

  it('accepts an 880-prefixed deliverable phone', () => {
    expect(detectFakeOrderSignals([order({ customerPhone: '8801712345678' })])).toHaveLength(0)
  })

  it('flags zero items / zero amount', () => {
    const out = detectFakeOrderSignals([order({ itemCount: 0, totalAmount: 0 })])
    expect(out[0].reasons.some((r) => r.includes('শূন্য'))).toBe(true)
  })

  it('uses orderNumber as ref, falling back to id', () => {
    const out = detectFakeOrderSignals([
      order({ orderNumber: '   ', id: 'raw-id', customerName: 'fake' }),
    ])
    expect(out[0].ref).toBe('raw-id')
  })
})

describe('buildLifecycleActions', () => {
  const issue = (o: Partial<OrderIssue>): OrderIssue =>
    ({ type: 'stuck_pending', severity: 'normal', detail: 'd', ...o }) as OrderIssue

  it('maps stuck_pending / pile_up to a reversible staff_push (order_followup)', () => {
    const actions = buildLifecycleActions({
      issues: [issue({ type: 'stuck_pending' }), issue({ type: 'pile_up' })],
      fakeSignals: [],
    })
    expect(actions).toHaveLength(2)
    for (const a of actions) {
      expect(a.kind).toBe('staff_push')
      expect(a.category).toBe('order_followup')
      expect(a.reversible).toBe(true)
    }
  })

  it('maps mismatch to an IRREVERSIBLE order_confirm (money path)', () => {
    const [a] = buildLifecycleActions({ issues: [issue({ type: 'mismatch' })], fakeSignals: [] })
    expect(a.kind).toBe('order_confirm')
    expect(a.category).toBe('order_confirm')
    expect(a.reversible).toBe(false)
  })

  it('maps high_cancel / high_return to a risk_alert', () => {
    const actions = buildLifecycleActions({
      issues: [issue({ type: 'high_cancel' }), issue({ type: 'high_return' })],
      fakeSignals: [],
    })
    expect(actions.every((a) => a.kind === 'risk_alert')).toBe(true)
  })

  it('emits a single fraud_flag covering all fake signals', () => {
    const actions = buildLifecycleActions({
      issues: [],
      fakeSignals: [
        { ref: 'A-1', customerName: 'fake', reasons: ['x'] },
        { ref: 'A-2', customerName: null, reasons: ['y'] },
      ],
    })
    const fraud = actions.filter((a) => a.kind === 'fraud_flag')
    expect(fraud).toHaveLength(1)
    expect(fraud[0].orders).toEqual(['A-1', 'A-2'])
    expect(fraud[0].severity).toBe('high')
  })

  it('emits no fraud_flag when there are no fake signals', () => {
    const actions = buildLifecycleActions({ issues: [], fakeSignals: [] })
    expect(actions.some((a) => a.kind === 'fraud_flag')).toBe(false)
  })
})

describe('planLifecycleActions', () => {
  it('NEVER auto-fires an order confirm even under a fully-permissive policy (irreversible cap holds)', () => {
    const [confirm] = buildLifecycleActions({
      issues: [{ type: 'mismatch', severity: 'normal', detail: 'd' } as OrderIssue],
      fakeSignals: [],
    })
    const [planned] = planLifecycleActions([confirm], permissivePolicy())
    // Irreversible actions can never silently auto-fire — they cap at 'propose' at most.
    expect(planned.willAuto).toBe(false)
    expect(planned.mode).not.toBe('auto')
  })

  it('can auto a reversible staff_push when the owner has opted fully in', () => {
    const [push] = buildLifecycleActions({
      issues: [{ type: 'stuck_pending', severity: 'normal', detail: 'd' } as OrderIssue],
      fakeSignals: [],
    })
    const [planned] = planLifecycleActions([push], permissivePolicy())
    expect(planned.mode).toBe('auto')
    expect(planned.willAuto).toBe(true)
  })

  it('forces everything to ask when the master switch is OFF', () => {
    const actions = buildLifecycleActions({
      issues: [{ type: 'stuck_pending', severity: 'normal', detail: 'd' } as OrderIssue],
      fakeSignals: [{ ref: 'A-1', customerName: 'fake', reasons: ['x'] }],
    })
    const planned = planLifecycleActions(actions, permissivePolicy({ enabled: false }))
    expect(planned.every((p) => p.mode === 'ask')).toBe(true)
    expect(planned.every((p) => !p.willAuto)).toBe(true)
  })
})
