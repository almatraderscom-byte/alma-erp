/**
 * Phase 3 (order lifecycle autonomy) — the ORDER LIFECYCLE engine.
 *
 * The ERP already DETECTS order problems (`detectOrderIssues`: stuck pending,
 * pile-ups, high cancel/return, payment-method gaps). What it never did was decide
 * — under the owner's autonomy policy — whether the agent should HANDLE each one
 * itself, propose-and-wait, or just flag it. This module is that decision layer for
 * the order lifecycle, built on the same Phase-1 foundation the CS pipeline now uses.
 *
 * It maps each detected problem (plus a fresh fake-order scan) to a typed lifecycle
 * ACTION with an autonomy category, then runs every action through `decideAutonomy`.
 *
 * Safety — conservative by construction, mirrors Phases 1-2:
 *   • Pure classification (`detectFakeOrderSignals`, `buildLifecycleActions`,
 *     `planLifecycleActions`) so it unit-tests cleanly.
 *   • NO order writes and NO customer charges happen here. Confirming an order
 *     commits money/inventory and messages a customer, so it is category
 *     `order_confirm` (defaults to 'ask') and can never silently auto-fire.
 *   • The autonomous sweep is a no-op until the master switch is on; even then it
 *     only RECORDS fraud flags + SURFACES the plan to the owner. Doing the actual
 *     staff-push / confirm stays an owner-approved step.
 */
import type { AgentOrder } from '@/lib/agent-api/orders.schema'
import type { OrderIssue } from '@/lib/order-monitor'
import {
  decideAutonomy,
  getAutonomyPolicy,
  type AutonomyCategory,
  type AutonomyMode,
  type AutonomyPolicy,
} from '@/agent/lib/autonomy-policy'

export type LifecycleActionKind = 'staff_push' | 'fraud_flag' | 'risk_alert' | 'order_confirm'

export interface LifecycleAction {
  kind: LifecycleActionKind
  category: AutonomyCategory
  /** Can this be cleanly undone? Drives the irreversible-cap in decideAutonomy. */
  reversible: boolean
  severity: 'high' | 'normal'
  /** Bangla one-liner for the owner. */
  summary: string
  /** Order refs involved (order number / id). */
  orders?: string[]
  /** Agent confidence 0..1 for this action (fraud heuristics are not certain). */
  confidence?: number
}

export interface FakeOrderSignal {
  ref: string
  customerName: string | null
  reasons: string[]
}

// ── Fraud / fake-order heuristics (pure) ────────────────────────────────────
// NOTE: JS `\b` word boundaries are ASCII-only — they never match around Bangla
// glyphs — so Latin and Bangla signals are tested separately: Latin words are
// boundary-guarded (avoid matching inside e.g. "contest"), Bangla is substring.
const TEST_NAME_LATIN = /\b(test|asdf|abcd|fake|demo)\b/i
const TEST_NAME_BANGLA = /(টেস্ট|ভুয়া)/
function looksLikeTestName(name: string): boolean {
  return TEST_NAME_LATIN.test(name) || TEST_NAME_BANGLA.test(name)
}

/** A deliverable BD mobile normalizes to 880 + 10 digits (the 1XXXXXXXXX part). */
function isDeliverablePhone(phone: string | null | undefined): boolean {
  if (!phone) return false
  const digits = phone.replace(/\D/g, '')
  const local = digits.startsWith('880') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits
  return local.length === 10 && local.startsWith('1')
}

/**
 * Scan orders for fake/fraud signals. Pure + deterministic. Conservative — only
 * flags concrete, defensible signals so the owner trusts the flag.
 */
export function detectFakeOrderSignals(orders: AgentOrder[]): FakeOrderSignal[] {
  const out: FakeOrderSignal[] = []
  for (const o of orders) {
    const reasons: string[] = []
    if (looksLikeTestName(o.customerName ?? '')) reasons.push('নাম টেস্ট/ভুয়া মনে হচ্ছে')
    if (!isDeliverablePhone(o.customerPhone)) reasons.push('ফোন নম্বর নেই/ভুল — ডেলিভারি করা যাবে না')
    if ((o.itemCount ?? 0) === 0 || o.totalAmount === 0) reasons.push('আইটেম/টাকা শূন্য')
    if (reasons.length) {
      out.push({ ref: o.orderNumber?.trim() || o.id, customerName: o.customerName, reasons })
    }
  }
  return out
}

// ── Map detected problems → lifecycle actions (pure) ────────────────────────
export function buildLifecycleActions(input: {
  issues: OrderIssue[]
  fakeSignals: FakeOrderSignal[]
}): LifecycleAction[] {
  const actions: LifecycleAction[] = []

  for (const issue of input.issues) {
    switch (issue.type) {
      case 'stuck_pending':
      case 'pile_up':
        // Push a follow-up to staff (confirm/deliver). Reversible (a staff task can be cancelled).
        actions.push({
          kind: 'staff_push',
          category: 'order_followup',
          reversible: true,
          severity: issue.severity,
          summary: `স্টাফকে ফলো-আপ দরকার: ${issue.detail}`,
          orders: issue.orders,
          confidence: 0.9,
        })
        break
      case 'mismatch':
        // Payment-method gap on pending → confirm path (touches money) → stays 'ask'.
        actions.push({
          kind: 'order_confirm',
          category: 'order_confirm',
          reversible: false,
          severity: issue.severity,
          summary: `কনফার্ম করার আগে যাচাই দরকার: ${issue.detail}`,
          orders: issue.orders,
          confidence: 0.7,
        })
        break
      case 'high_cancel':
      case 'high_return':
        actions.push({
          kind: 'risk_alert',
          category: 'other',
          reversible: true,
          severity: issue.severity,
          summary: issue.detail,
          confidence: 0.8,
        })
        break
    }
  }

  if (input.fakeSignals.length) {
    actions.push({
      kind: 'fraud_flag',
      category: 'other',
      reversible: true,
      severity: 'high',
      summary: `${input.fakeSignals.length}টি সম্ভাব্য ভুয়া/সমস্যাযুক্ত অর্ডার — যাচাই করা দরকার`,
      orders: input.fakeSignals.map((s) => s.ref),
      confidence: 0.75,
    })
  }

  return actions
}

// ── Attach an autonomy decision to each action (pure) ───────────────────────
export interface PlannedAction extends LifecycleAction {
  mode: AutonomyMode
  willAuto: boolean
  /** Owner-facing Bangla reason for the chosen mode. */
  reason: string
}

export function planLifecycleActions(actions: LifecycleAction[], policy: AutonomyPolicy): PlannedAction[] {
  return actions.map((a) => {
    const decision = decideAutonomy(
      { category: a.category, reversible: a.reversible, confidence: a.confidence },
      policy,
    )
    return { ...a, mode: decision.mode, willAuto: decision.mode === 'auto', reason: decision.reason }
  })
}

// ── Async orchestration ─────────────────────────────────────────────────────
export async function scanOrderLifecycle(): Promise<{ actions: LifecycleAction[]; fakeSignals: FakeOrderSignal[] }> {
  const [{ detectOrderIssues }, { listAgentOrders }] = await Promise.all([
    import('@/lib/order-monitor'),
    import('@/lib/agent-api/orders.service'),
  ])
  const [issues, pending] = await Promise.all([
    detectOrderIssues(),
    listAgentOrders({ status: 'pending', limit: 100 }),
  ])
  const fakeSignals = detectFakeOrderSignals(pending.orders ?? [])
  const actions = buildLifecycleActions({ issues, fakeSignals })
  return { actions, fakeSignals }
}

export async function planOrderLifecycleAutonomy(): Promise<{
  planned: PlannedAction[]
  policyEnabled: boolean
  fakeSignals: FakeOrderSignal[]
}> {
  const [policy, scan] = await Promise.all([getAutonomyPolicy(), scanOrderLifecycle()])
  const planned = planLifecycleActions(scan.actions, policy)
  return { planned, policyEnabled: policy.enabled, fakeSignals: scan.fakeSignals }
}

export interface OrderSweepResult {
  ran: boolean
  autoCount: number
  flagCount: number
  detail: string
}

/**
 * Autonomous day-start sweep. Gated by the master switch (no-op until the owner
 * opts in). SAFE: it never writes orders or charges customers — it RECORDS fraud
 * flags to the autonomy ledger (genuine autonomous detections) and SURFACES the
 * lifecycle plan to the owner as one batched notice. Best-effort — never throws.
 */
export async function runOrderLifecycleSweep(): Promise<OrderSweepResult> {
  try {
    const { planned, policyEnabled, fakeSignals } = await planOrderLifecycleAutonomy()
    if (!policyEnabled) return { ran: false, autoCount: 0, flagCount: 0, detail: 'autonomy_disabled' }
    if (planned.length === 0) return { ran: false, autoCount: 0, flagCount: 0, detail: 'nothing_to_do' }

    const { recordAutonomousAction } = await import('@/agent/lib/autonomy-ledger')
    let autoCount = 0
    const fraud = planned.filter((p) => p.kind === 'fraud_flag')
    for (const f of fraud) {
      await recordAutonomousAction({ category: 'order_followup', summary: f.summary, mode: 'auto' })
      autoCount++
    }

    const lines = planned.map((p) => {
      const tag = p.mode === 'auto' ? '🤖' : p.mode === 'propose' ? '📝' : '❓'
      return `${tag} ${p.summary}`
    })
    const { notifyOwner } = await import('@/agent/lib/notify-owner')
    await notifyOwner({
      tier: 1,
      title: '📦 অর্ডার লাইফসাইকেল — আজকের পর্যালোচনা',
      message: `${lines.join('\n')}\n\n(🤖 = আমি দেখছি · 📝 = প্রস্তাব · ❓ = আপনার সিদ্ধান্ত লাগবে)`,
      category: 'report',
    }).catch(() => {})

    return { ran: true, autoCount, flagCount: fakeSignals.length, detail: 'swept' }
  } catch (err) {
    return { ran: false, autoCount: 0, flagCount: 0, detail: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
