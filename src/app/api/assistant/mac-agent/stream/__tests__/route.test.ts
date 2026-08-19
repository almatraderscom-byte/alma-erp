import { describe, expect, it } from 'vitest'
import { computerUseStartDecision } from '../route'

describe('computer-use Mac stream ownership', () => {
  const now = Date.parse('2026-08-19T10:00:00.000Z')
  const auto = { mode: 'start', reason: 'computer_use' }
  const manual = { mode: 'start', reason: 'owner_manual' }

  it('reuses a pending auto start but never steals a pending/fresh manual stream', () => {
    expect(computerUseStartDecision({ status: 'queued', params: auto, now })).toBe('reuse_auto')
    expect(computerUseStartDecision({ status: 'delivered', params: manual, now })).toBe('respect_manual')
    expect(computerUseStartDecision({
      status: 'done', params: manual, frameAt: new Date(now - 1_000), now,
    })).toBe('respect_manual')
  })

  it('restarts a stale done auto stream and renews a live one after 60 seconds', () => {
    expect(computerUseStartDecision({
      status: 'done', params: auto, createdAt: new Date(now - 5_000),
      frameAt: new Date(now - 11_000), now,
    })).toBe('enqueue_auto')
    expect(computerUseStartDecision({
      status: 'done', params: auto, createdAt: new Date(now - 60_000),
      frameAt: new Date(now - 1_000), now,
    })).toBe('enqueue_auto')
    expect(computerUseStartDecision({
      status: 'done', params: auto, createdAt: new Date(now - 5_000),
      frameAt: new Date(now - 1_000), now,
    })).toBe('reuse_auto')
  })

  it('enqueues a same-owner display switch even while its stream is fresh', () => {
    expect(computerUseStartDecision({
      status: 'done', params: auto, createdAt: new Date(now - 5_000),
      frameAt: new Date(now - 1_000), forceRenew: true, now,
    })).toBe('enqueue_auto')
  })
})
