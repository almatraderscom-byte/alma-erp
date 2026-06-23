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

  it('computes age in ms from a Date or ISO string', () => {
    const t = new Date(Date.now() - 5_000)
    expect(pendingActionAgeMs(t)).toBeGreaterThanOrEqual(5_000)
    expect(pendingActionAgeMs(t.toISOString())).toBeGreaterThanOrEqual(5_000)
  })
})
