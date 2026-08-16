/**
 * Fixtures are the owner's "Ok audit koro" turn (2026-08-15). The round-0 force
 * was discharged by a clock read, the requirement lapsed, and the reply closed
 * with "Ads-এর live tool result পাওয়া যায়নি".
 */
import { describe, it, expect } from 'vitest'
import {
  isGroundingSatisfied,
  groundingEvidence,
  hasSubstantiveToolAttempt,
  SHALLOW_GROUNDING_TOOLS,
  BOOKKEEPING_TOOLS,
  MAX_GROUNDING_FORCE_ROUNDS,
} from '../grounding'

const ok = (toolName: string) => ({ toolName, status: 'success' })
const failed = (toolName: string) => ({ toolName, status: 'error' })

describe('isGroundingSatisfied', () => {
  it('is NOT satisfied by the clock read that discharged the real force', () => {
    expect(isGroundingSatisfied([ok('get_current_datetime')])).toBe(false)
  })

  it('is not satisfied by any other shallow tool either', () => {
    for (const name of ['find_tool', 'search_memory', 'save_memory', 'track_open_task']) {
      expect(isGroundingSatisfied([ok(name)]), name).toBe(false)
    }
  })

  it('is satisfied by a read that could actually answer the question', () => {
    expect(isGroundingSatisfied([ok('get_current_datetime'), ok('get_sales_summary')])).toBe(true)
  })

  it('does not count a read that FAILED — a failed call grounds nothing', () => {
    expect(isGroundingSatisfied([failed('get_sales_summary')])).toBe(false)
  })

  it('is not satisfied by an empty turn', () => {
    expect(isGroundingSatisfied([])).toBe(false)
  })
})

describe('groundingEvidence', () => {
  it('names only the reads that did the grounding', () => {
    expect(groundingEvidence([
      ok('get_current_datetime'),
      ok('get_sales_summary'),
      failed('marketing_report'),
      ok('save_memory'),
      ok('get_ga4_report'),
    ])).toEqual(['get_sales_summary', 'get_ga4_report'])
  })

  it('is empty on the turn that looked grounded and was not', () => {
    expect(groundingEvidence([ok('get_current_datetime')])).toEqual([])
  })
})

describe('always-on core tools cannot discharge the requirement (Codex P2)', () => {
  // These ship on EVERY turn regardless of the question, so a forced round could
  // call one and permanently satisfy grounding without reading anything.
  // `ask_user` is the worst: staging a card strips tools from the next round.
  for (const name of ['ask_user', 'get_pending_approvals', 'delegate_to_specialist', 'request_standing_permission']) {
    it(`${name} is not grounding`, () => {
      expect(isGroundingSatisfied([ok(name)])).toBe(false)
      expect(hasSubstantiveToolAttempt([ok(name)])).toBe(false)
    })
  }
})

describe('hasSubstantiveToolAttempt', () => {
  it('is NOT satisfied by a clock read before an incapacity plea', () => {
    // The reproduction Codex gave: `get_current_datetime` succeeds on "Mac live
    // dekhaw", then the reply says no browser tool is connected. The clock sits
    // outside BOOKKEEPING_TOOLS, so the old check went quiet here.
    expect(hasSubstantiveToolAttempt([ok('get_current_datetime')])).toBe(false)
  })

  it('counts a FAILED real call — an attempt that errored is still evidence', () => {
    expect(hasSubstantiveToolAttempt([failed('mac_desk_control')])).toBe(true)
  })

  it('counts a successful real call', () => {
    expect(hasSubstantiveToolAttempt([ok('get_current_datetime'), ok('mac_desk_control')])).toBe(true)
  })

  it('is not satisfied by an empty turn', () => {
    expect(hasSubstantiveToolAttempt([])).toBe(false)
  })
})

describe('the sets themselves', () => {
  it('treats every bookkeeping tool as shallow', () => {
    for (const name of BOOKKEEPING_TOOLS) expect(SHALLOW_GROUNDING_TOOLS.has(name), name).toBe(true)
  })

  it('leaves real business reads out of the shallow set', () => {
    for (const name of ['get_sales_summary', 'get_orders', 'marketing_report', 'mac_desk_control']) {
      expect(SHALLOW_GROUNDING_TOOLS.has(name), name).toBe(false)
    }
  })

  it('caps the forced rounds so a repeat clock read cannot spin the loop', () => {
    expect(MAX_GROUNDING_FORCE_ROUNDS).toBeGreaterThan(0)
    expect(MAX_GROUNDING_FORCE_ROUNDS).toBeLessThanOrEqual(3)
  })
})
