import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 62 — binding-outcome scoring + the prose-free completion rule.
 * Pure functions are exercised directly; the recorder/summary use a mocked
 * telemetry store so we assert the real-evidence stream shape.
 */

const h = vi.hoisted(() => {
  const events: Array<Record<string, unknown>> = []
  const logToolEvent = vi.fn(async (e: Record<string, unknown>) => {
    events.push(e)
  })
  const state: { rows: Array<{ detail: unknown }> } = { rows: [] }
  const prisma = {
    agentToolEvent: { findMany: vi.fn(async () => state.rows) },
  }
  return { events, logToolEvent, state, prisma }
})

vi.mock('@/agent/lib/tool-telemetry', () => ({ logToolEvent: h.logToolEvent }))
vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }))

import {
  scoreBindingOutcome,
  isBindingCorrect,
  canCompleteFocus,
  wouldDuplicateStep,
  recordBindingOutcome,
  summarizeBindingOutcomes,
} from '../continuity-outcome'

beforeEach(() => {
  h.events.length = 0
  h.state.rows = []
})

describe('scoreBindingOutcome — priority-ordered', () => {
  it('owner correction dominates every other signal', () => {
    expect(
      scoreBindingOutcome({
        binding: 'active_focus',
        action: 'resume',
        ownerCorrectedPrior: true,
        duplicateStepDetected: true,
      }),
    ).toBe('owner_correction')
  })

  it('classifies wrong task, duplicate, restart, clarification, and clean bind', () => {
    expect(scoreBindingOutcome({ binding: 'active_focus', action: 'resume', wrongTaskDetected: true })).toBe('wrong_task')
    expect(scoreBindingOutcome({ binding: 'active_focus', action: 'resume', duplicateStepDetected: true })).toBe('duplicate_step')
    expect(scoreBindingOutcome({ binding: 'new_task', action: 'park_and_start', restartedCompletedWork: true })).toBe('unnecessary_restart')
    expect(scoreBindingOutcome({ binding: 'none', action: 'clarify' })).toBe('asked_clarification')
    expect(scoreBindingOutcome({ binding: 'active_focus', action: 'resume' })).toBe('continued_correct')
  })
})

describe('isBindingCorrect', () => {
  it('treats only the four negative outcomes as incorrect', () => {
    expect(isBindingCorrect('continued_correct')).toBe(true)
    expect(isBindingCorrect('asked_clarification')).toBe(true)
    for (const bad of ['wrong_task', 'unnecessary_restart', 'duplicate_step', 'owner_correction'] as const) {
      expect(isBindingCorrect(bad)).toBe(false)
    }
  })
})

describe('canCompleteFocus — never from prose', () => {
  it('requires BOTH claim verified and postcondition met', () => {
    expect(canCompleteFocus({ claimVerified: true, postconditionMet: true })).toBe(true)
    expect(canCompleteFocus({ claimVerified: true, postconditionMet: false })).toBe(false)
    expect(canCompleteFocus({ claimVerified: false, postconditionMet: true })).toBe(false)
    expect(canCompleteFocus({ claimVerified: false, postconditionMet: false })).toBe(false)
  })
})

describe('wouldDuplicateStep', () => {
  it('detects a repeat of a verified-complete step, case/space-insensitively', () => {
    expect(wouldDuplicateStep(['generate_image', 'post_stage'], 'Generate_Image ')).toBe(true)
    expect(wouldDuplicateStep(['post_stage'], 'send_post')).toBe(false)
    expect(wouldDuplicateStep(null, 'anything')).toBe(false)
    expect(wouldDuplicateStep([], '')).toBe(false)
  })
})

describe('recordBindingOutcome — durable evidence', () => {
  it('writes a __continuity__ event whose success reflects correctness', async () => {
    const out = await recordBindingOutcome({
      conversationId: 'c1',
      observation: { binding: 'active_focus', action: 'resume' },
      reason: 'continuation_binds_active_focus',
    })
    expect(out).toBe('continued_correct')
    expect(h.events).toHaveLength(1)
    expect(h.events[0].toolName).toBe('__continuity__')
    expect(h.events[0].success).toBe(true)
    expect((h.events[0].detail as { outcome: string }).outcome).toBe('continued_correct')
  })

  it('records a negative outcome with success=false', async () => {
    await recordBindingOutcome({
      conversationId: 'c1',
      observation: { binding: 'active_focus', action: 'resume', ownerCorrectedPrior: true },
    })
    expect(h.events[0].success).toBe(false)
  })
})

describe('summarizeBindingOutcomes — the ≥98% gate', () => {
  it('excludes clarification from the denominator and computes the rate', async () => {
    h.state.rows = [
      ...Array.from({ length: 98 }, () => ({ detail: { outcome: 'continued_correct' } })),
      { detail: { outcome: 'owner_correction' } },
      { detail: { outcome: 'wrong_task' } },
      { detail: { outcome: 'asked_clarification' } },
    ]
    const s = await summarizeBindingOutcomes(7)
    expect(s.scored).toBe(101)
    expect(s.denominator).toBe(100) // clarification excluded
    expect(s.correct).toBe(98)
    expect(s.correctRate).toBeCloseTo(0.98, 5)
    expect(s.meetsGate).toBe(true)
  })

  it('does not meet the gate below 100 scored', async () => {
    h.state.rows = Array.from({ length: 50 }, () => ({ detail: { outcome: 'continued_correct' } }))
    const s = await summarizeBindingOutcomes(7)
    expect(s.meetsGate).toBe(false)
  })

  it('fails open to an empty summary when the store throws', async () => {
    h.prisma.agentToolEvent.findMany.mockRejectedValueOnce(new Error('db down'))
    const s = await summarizeBindingOutcomes(7)
    expect(s.scored).toBe(0)
    expect(s.meetsGate).toBe(false)
  })
})
