/**
 * The loop, 2026-07-27.
 *
 * Work turns were given more than one act-now push so a job would not be
 * abandoned after the first. Within hours the owner watched a turn burn 14 tool
 * calls on save_memory while the head said, in its own thinking, *"the system is
 * repeating the note every time, creating a loop"*.
 *
 * Two things were wrong and both are fixed here: the same sentence arrived again
 * (a repeated instruction is not a stronger one), and it arrived without the
 * head having moved an inch since the last one.
 */
import { describe, it, expect } from 'vitest'
import { maxIntentNudgesFor } from '@/agent/config'

/** The gate the turn loop applies before sending another push. */
function mayPushAgain(input: {
  intentNudges: number
  workClass: 'chat' | 'deep' | 'long_run'
  successfulToolCount: number
  successCountAtLastIntentNudge: number
}): boolean {
  return input.intentNudges < maxIntentNudgesFor(input.workClass)
    && (input.intentNudges === 0 || input.successfulToolCount > input.successCountAtLastIntentNudge)
}

const BOOKKEEPING = new Set([
  'save_memory', 'update_memory', 'delete_memory', 'graph_remember',
  'save_task_checkpoint', 'track_open_task', 'add_owner_todo', 'manage_work_todos',
])

/** Mirrors the loop's count: bookkeeping is not movement. */
function progressCount(records: Array<{ status: 'success' | 'error'; toolName: string }>): number {
  return records.filter((r) => r.status === 'success' && !BOOKKEEPING.has(r.toolName)).length
}

describe('saving memory is not moving', () => {
  it('a round of nothing but save_memory earns no push', () => {
    const records = Array.from({ length: 6 }, () => ({ status: 'success' as const, toolName: 'save_memory' }))
    expect(progressCount(records)).toBe(0)
    expect(mayPushAgain({ intentNudges: 1, workClass: 'deep', successfulToolCount: 0, successCountAtLastIntentNudge: 0 }))
      .toBe(false)
  })

  it('a real tool does earn one', () => {
    const records = [
      { status: 'success' as const, toolName: 'save_memory' },
      { status: 'success' as const, toolName: 'audit_product_seo' },
    ]
    expect(progressCount(records)).toBe(1)
  })
})

describe('a push must be earned by progress', () => {
  it('the first push is always allowed', () => {
    expect(mayPushAgain({ intentNudges: 0, workClass: 'deep', successfulToolCount: 0, successCountAtLastIntentNudge: -1 }))
      .toBe(true)
  })

  it('refuses a second push when nothing succeeded since the first — the loop', () => {
    expect(mayPushAgain({ intentNudges: 1, workClass: 'deep', successfulToolCount: 3, successCountAtLastIntentNudge: 3 }))
      .toBe(false)
  })

  it('allows a second push once the head has actually moved', () => {
    expect(mayPushAgain({ intentNudges: 1, workClass: 'deep', successfulToolCount: 5, successCountAtLastIntentNudge: 3 }))
      .toBe(true)
  })

  it('still stops at the per-class ceiling even with progress', () => {
    expect(mayPushAgain({
      intentNudges: maxIntentNudgesFor('deep'),
      workClass: 'deep',
      successfulToolCount: 99,
      successCountAtLastIntentNudge: 3,
    })).toBe(false)
  })

  it('a chat reply is still pushed at most once', () => {
    expect(mayPushAgain({ intentNudges: 1, workClass: 'chat', successfulToolCount: 9, successCountAtLastIntentNudge: 1 }))
      .toBe(false)
  })
})
