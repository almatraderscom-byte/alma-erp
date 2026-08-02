/**
 * P1-6 — the task card (audit §E).
 *
 * The card is what a continuation reads INSTEAD of the whole transcript, so its
 * ordering is not cosmetic: the newest correction has to lead, above the goal
 * and above anything the agent itself decided earlier, or the trimmed history
 * would have thrown away the one line that outranks the rest.
 */
import { describe, it, expect } from 'vitest'
import { buildTaskCard, CONTINUATION_KEEP_MESSAGES } from '@/agent/lib/task-card'

describe('buildTaskCard', () => {
  it('leads with the newest correction, above the goal', () => {
    const card = buildTaskCard({
      goal: 'ChatGPT app e notun chat khule message pathano',
      corrections: ['na, oi puran chat e na — notun chat e'],
      currentStep: 'composer e likhchi',
    })
    expect(card.indexOf('na, oi puran chat e na')).toBeLessThan(card.indexOf('ChatGPT app e notun chat'))
    expect(card).toContain('সবার উপরে')
  })

  it('carries older corrections too, but behind the newest', () => {
    const card = buildTaskCard({ goal: 'kaj', corrections: ['notun ta', 'age bolechilam puran ta na'] })
    expect(card.indexOf('notun ta')).toBeLessThan(card.indexOf('age bolechilam'))
  })

  it('states what was just approved, so the turn does not redo it', () => {
    const card = buildTaskCard({ goal: 'kaj', approvedJustNow: 'ChatGPT-তে লেখা' })
    expect(card).toContain('এইমাত্র approve হয়েছে')
    expect(card).toContain('ChatGPT-তে লেখা')
  })

  it('names the blocker and the legal next steps', () => {
    const card = buildTaskCard({
      goal: 'kaj',
      blocker: 'Mac offline',
      nextActions: ['look_mac_app', 'drive_mac_app', 'a', 'b', 'c', 'dropped'],
    })
    expect(card).toContain('Mac offline')
    expect(card).toContain('look_mac_app')
    // Bounded — a card that runs long stops being a card.
    expect(card).not.toContain('dropped')
  })

  it('is empty when there is genuinely nothing to say', () => {
    // An empty card must be falsy: the continuation trim is gated on it, and
    // trimming history with nothing to replace it would only make the turn dumber.
    expect(buildTaskCard({})).toBe('')
    expect(buildTaskCard({ goal: null, corrections: [], nextActions: [] })).toBe('')
  })

  it('tells the head it may skip the transcript — that is the whole point', () => {
    const card = buildTaskCard({ goal: 'kaj' })
    expect(card).toContain('পুরো history আবার পড়ার দরকার নেই')
  })

  it('keeps enough turns around the tap to stay coherent', () => {
    expect(CONTINUATION_KEEP_MESSAGES).toBeGreaterThan(4)
  })
})
