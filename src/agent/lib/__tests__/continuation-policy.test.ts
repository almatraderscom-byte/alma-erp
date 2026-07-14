import { describe, expect, it } from 'vitest'
import { shouldAutoContinueTurn, shouldPersistIncomingMessage } from '@/agent/lib/continuation-policy'

describe('shouldAutoContinueTurn', () => {
  it('does not continue the production incident after the skill-pack terminal gate', () => {
    // The incident's final Bangla prose ended in “করব কি?”; prose is deliberately
    // absent from this API and can never turn a completed task back on.
    expect(shouldAutoContinueTurn({
      deadlineHit: false,
      hasAskCard: false,
      tools: [
        { toolName: 'live_browser_look', status: 'error' },
        { toolName: 'complete_skill_pack_run', status: 'success' },
      ],
    })).toBe(false)
  })

  it('never stores a structured continuation as an owner-authored message', () => {
    expect(shouldPersistIncomingMessage({
      isResume: false,
      autoContinueFromTurnId: 'completed-turn-id',
    })).toBe(false)
    expect(shouldPersistIncomingMessage({ isResume: false, autoContinueFromTurnId: null })).toBe(true)
  })

  it('does not treat a failed browser probe as unfinished browser work', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true,
      hasAskCard: false,
      tools: [{ toolName: 'live_browser_look', status: 'error' }],
    })).toBe(false)
  })

  it('continues a genuinely deadline-stopped browser turn', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true,
      hasAskCard: false,
      tools: [{ toolName: 'live_browser_act', status: 'success' }],
    })).toBe(true)
  })

  it('stops when the owner must answer an ask card', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true,
      hasAskCard: true,
      tools: [{ toolName: 'live_browser_act', status: 'success' }],
    })).toBe(false)
  })
})
