/**
 * Owner 2026-07-26: "non-stop kaj ekhono hoy na" — he asked for a job that runs
 * for minutes and it kept stopping early.
 *
 * The arithmetic behind it: a deep-work turn is allowed 60 rounds (plan-drive
 * 120), but the standard head's tool budget stripped its tools after 8 — and on
 * Vercel PREVIEW, where he tests, AGENT_UNIVERSAL_TOOL_PIPELINE defaults ON, so
 * that 8 was live. The head did not choose to stop; the server disarmed it.
 */
import { describe, it, expect } from 'vitest'
import {
  headToolBudgetFor,
  maxIntentNudgesFor,
  STANDARD_HEAD_TOOL_BUDGET,
  DEEP_TURN_MAX_ITERATIONS,
  LONG_RUN_TURN_MAX_ITERATIONS,
  MAX_TOOL_ITERATIONS,
  universalToolPipelineEnabled,
} from '@/agent/config'

describe('head tool budget follows the turn class', () => {
  it('leaves a chat reply exactly as it was', () => {
    expect(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'chat')).toBe(STANDARD_HEAD_TOOL_BUDGET)
    expect(headToolBudgetFor(2, 'chat')).toBe(2)
  })

  it('widens a work turn, never narrows it', () => {
    expect(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'deep')).toBeGreaterThan(STANDARD_HEAD_TOOL_BUDGET)
    expect(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'long_run'))
      .toBeGreaterThan(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'deep'))
    // A caller with an already-generous budget keeps it.
    expect(headToolBudgetFor(500, 'deep')).toBe(500)
  })

  it('no longer disarms the head before its rounds run out', () => {
    // This is the regression itself: budget must not be the binding limit on a
    // work turn — the iteration cap is.
    expect(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'deep')).toBeGreaterThanOrEqual(DEEP_TURN_MAX_ITERATIONS / 2)
    expect(headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, 'long_run')).toBeGreaterThanOrEqual(LONG_RUN_TURN_MAX_ITERATIONS / 2)
    expect(STANDARD_HEAD_TOOL_BUDGET).toBeLessThan(DEEP_TURN_MAX_ITERATIONS)
  })

  it('the preview default is what made this live', () => {
    expect(universalToolPipelineEnabled(undefined, 'preview')).toBe(true)
    expect(universalToolPipelineEnabled('off', 'preview')).toBe(false)
    expect(MAX_TOOL_ITERATIONS).toBeLessThan(DEEP_TURN_MAX_ITERATIONS)
  })
})

describe('announced-but-stopped pushes', () => {
  it('stays at one for a chat reply', () => {
    expect(maxIntentNudgesFor('chat')).toBe(1)
  })

  it('lets a work session be pushed more than once', () => {
    expect(maxIntentNudgesFor('deep')).toBeGreaterThan(1)
    expect(maxIntentNudgesFor('long_run')).toBeGreaterThan(maxIntentNudgesFor('deep'))
  })
})
