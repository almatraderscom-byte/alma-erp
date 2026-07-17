import { describe, it, expect } from 'vitest'
import {
  isBlockingOutboundDuplicate,
  outboundWasDialed,
  OUTBOUND_RINGING_WINDOW_MS,
} from '@/agent/lib/outbound-call-tracking'

const NOW = Date.parse('2026-07-18T10:00:00.000Z')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (over: any) => ({ status: 'executed', createdAt: new Date(NOW), result: {}, ...over })

describe('isBlockingOutboundDuplicate — a dialed call is not a delivered one', () => {
  it('blocks a card still awaiting approval (would double-dial)', () => {
    expect(isBlockingOutboundDuplicate(row({ status: 'pending' }), NOW)).toBe(true)
  })

  it('blocks an approved-and-queued card (worker is about to dial)', () => {
    expect(isBlockingOutboundDuplicate(row({ status: 'approved' }), NOW)).toBe(true)
  })

  it('blocks an answered call (message was delivered — do not repeat)', () => {
    expect(
      isBlockingOutboundDuplicate(
        row({ result: { ok: true, callSid: 'CA1', answeredNotified: true } }),
        NOW,
      ),
    ).toBe(true)
  })

  it('DOES NOT block a no-answer call — "abar call koro" must place a real new call', () => {
    // The exact production shape that caused the 2026-07-18 false-success incident.
    const missed = row({
      createdAt: new Date(NOW - 30 * 60_000), // half an hour ago, well inside the old 2h window
      result: { ok: true, callSid: 'CA764', missedNotified: true, missedStatus: 'no-answer' },
    })
    expect(isBlockingOutboundDuplicate(missed, NOW)).toBe(false)
  })

  it('DOES NOT block a busy/failed missed row', () => {
    expect(
      isBlockingOutboundDuplicate(row({ result: { missedStatus: 'busy', missedNotified: true } }), NOW),
    ).toBe(false)
  })

  it('holds a just-placed call while it may still be ringing, then releases it', () => {
    const justPlaced = row({ createdAt: new Date(NOW - 10_000), result: { ok: true, callSid: 'CA9' } })
    expect(isBlockingOutboundDuplicate(justPlaced, NOW)).toBe(true)
    const rungOut = row({
      createdAt: new Date(NOW - OUTBOUND_RINGING_WINDOW_MS - 1_000),
      result: { ok: true, callSid: 'CA9' },
    })
    expect(isBlockingOutboundDuplicate(rungOut, NOW)).toBe(false)
  })

  it('does not block a rejected or expired card', () => {
    expect(isBlockingOutboundDuplicate(row({ status: 'rejected', result: null }), NOW)).toBe(false)
    expect(isBlockingOutboundDuplicate(row({ status: 'expired', result: null }), NOW)).toBe(false)
  })
})

describe('outboundWasDialed', () => {
  it('counts executed and legacy failed+ok rows as dialed', () => {
    expect(outboundWasDialed(row({ status: 'executed' }))).toBe(true)
    expect(outboundWasDialed(row({ status: 'failed', result: { ok: true, callSid: 'CA1' } }))).toBe(true)
    expect(outboundWasDialed(row({ status: 'failed', result: { ok: false } }))).toBe(false)
    expect(outboundWasDialed(row({ status: 'pending', result: null }))).toBe(false)
  })
})
