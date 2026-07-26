import { describe, expect, it } from 'vitest'
import {
  isPendingActionExpired,
  isLifecycleBoundAction,
  pendingActionAgeMs,
} from '@/agent/lib/pending-action'
import { PENDING_ACTION_EXPIRY_MS } from '@/agent/lib/constants'

const HOUR = 60 * 60 * 1000

describe('pending-action expiry policy', () => {
  it('expires a transient confirm card past the 30-min TTL', () => {
    const old = new Date(Date.now() - (PENDING_ACTION_EXPIRY_MS + 60_000))
    expect(isPendingActionExpired(old, 'log_expense')).toBe(true)
  })

  it('keeps a transient confirm card alive within the TTL', () => {
    const fresh = new Date(Date.now() - 60_000)
    expect(isPendingActionExpired(fresh, 'log_expense')).toBe(false)
  })

  it('NEVER expires a dispatch_staff_tasks card — even hours old', () => {
    // The owner's bug: a card created at the 21:05 evening proposal, approved the
    // next morning (or after intra-day edits), was wrongly 410-expired so nothing
    // dispatched. Lifecycle cards must survive the clock.
    const eveningProposal = new Date(Date.now() - 14 * HOUR)
    expect(isPendingActionExpired(eveningProposal, 'dispatch_staff_tasks')).toBe(false)
  })

  it('treats dispatch_staff_tasks as lifecycle-bound', () => {
    expect(isLifecycleBoundAction('dispatch_staff_tasks')).toBe(true)
    expect(isLifecycleBoundAction('log_expense')).toBe(false)
    expect(isLifecycleBoundAction(undefined)).toBe(false)
    expect(isLifecycleBoundAction(null)).toBe(false)
  })

  it('falls back to the transient TTL when type is omitted (back-compat)', () => {
    const old = new Date(Date.now() - (PENDING_ACTION_EXPIRY_MS + 60_000))
    expect(isPendingActionExpired(old)).toBe(true)
  })

  // OWNER INCIDENT 2026-07-26 — the loop that wasted his evening. A ten-product
  // SEO copy batch expired on the 30-minute clock while he was reading it. He
  // asked for it again; the agent re-DRAFTED from scratch; that expired too.
  // Four rounds, four different texts, four approvals, and only some of them
  // landed — leaving the site patchily updated. His verdict: "erta ki kono kaj?"
  it('never expires a drafted SEO batch out from under the owner', () => {
    const anHourAgo = new Date(Date.now() - HOUR)
    const yesterday = new Date(Date.now() - 26 * HOUR)

    expect(isPendingActionExpired(anHourAgo, 'seo_fix_batch')).toBe(false)
    expect(isPendingActionExpired(yesterday, 'seo_fix_batch')).toBe(false)
    expect(isLifecycleBoundAction('seo_fix_batch')).toBe(true)
  })

  it('leaves genuinely time-sensitive cards on the clock', () => {
    // Deliberately NOT widened: sending a customer a message or spending money an
    // hour late is a real hazard, unlike applying copy the owner already read.
    const old = new Date(Date.now() - (PENDING_ACTION_EXPIRY_MS + 60_000))
    for (const type of ['send_customer_message', 'ad_budget', 'launch_campaign', 'outbound_call']) {
      expect(isPendingActionExpired(old, type)).toBe(true)
    }
  })

  it('computes age in ms from a Date or ISO string', () => {
    const t = new Date(Date.now() - 5_000)
    expect(pendingActionAgeMs(t)).toBeGreaterThanOrEqual(5_000)
    expect(pendingActionAgeMs(t.toISOString())).toBeGreaterThanOrEqual(5_000)
  })
})
