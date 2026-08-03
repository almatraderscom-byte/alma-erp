/**
 * P0-4 — the same mistake, twice (foundation audit §I).
 *
 * Boss's complaint was never "it failed", it was that he corrected it and it
 * did the same thing again. These tests pin the two properties that make a
 * deterministic block safe to put in front of every tool call: identical calls
 * are recognised as identical (whatever order the model writes the arguments
 * in), and honest work is never blocked — a retryable failure, a changed
 * argument, or a first retry all pass straight through.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Row = { detail: Record<string, unknown> }
let rows: Row[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentToolEvent: {
      findMany: vi.fn(async () => rows),
    },
  },
}))

import { actionKey, checkRepeatGuard, repeatGuardMessage, REPEAT_GUARD_LIMIT } from '@/agent/lib/repeat-guard'

const CONV = 'conv-repeat-1'

describe('actionKey', () => {
  it('is the same call however the arguments are ordered', () => {
    expect(actionKey('drive_mac_app', { app: 'chatgpt', action: 'type', text: 'salam' }))
      .toBe(actionKey('drive_mac_app', { text: 'salam', action: 'type', app: 'chatgpt' }))
  })

  it('ignores plumbing and prose — the same attempt with a reworded reason is the same attempt', () => {
    const a = actionKey('drive_mac_app', { app: 'chatgpt', action: 'type', reason: 'Boss chailen', conversationId: 'x' })
    const b = actionKey('drive_mac_app', { app: 'chatgpt', action: 'type', reason: 'onar nirdeshe', conversationId: 'y' })
    expect(a).toBe(b)
  })

  it('a changed argument is a DIFFERENT attempt — trying something else is never blocked', () => {
    expect(actionKey('drive_mac_app', { app: 'chatgpt', text: 'salam' }))
      .not.toBe(actionKey('drive_mac_app', { app: 'chatgpt', text: 'salam koro' }))
    expect(actionKey('drive_mac_app', { app: 'chatgpt' }))
      .not.toBe(actionKey('look_mac_app', { app: 'chatgpt' }))
  })
})

describe('checkRepeatGuard', () => {
  const key = actionKey('drive_mac_app', { app: 'chatgpt', action: 'type', text: 'salam' })

  beforeEach(() => { rows = [] })

  it('allows the first retry — one failure can always be "maybe it works this time"', async () => {
    rows = [{ detail: { argsKey: key } }]
    const v = await checkRepeatGuard({ toolName: 'drive_mac_app', argsKey: key, conversationId: CONV })
    expect(v.blocked).toBe(false)
    expect(v.priorFailures).toBe(1)
  })

  it('BLOCKS the third identical attempt', async () => {
    rows = [{ detail: { argsKey: key, lastError: 'element_not_found' } }, { detail: { argsKey: key } }]
    const v = await checkRepeatGuard({ toolName: 'drive_mac_app', argsKey: key, conversationId: CONV })
    expect(v.blocked).toBe(true)
    expect(v.priorFailures).toBe(REPEAT_GUARD_LIMIT)
    expect(repeatGuardMessage('drive_mac_app', v)).toContain('element_not_found')
  })

  it('exempts retryable failures — a timeout is the network\'s fault, not a mistake', async () => {
    rows = [{ detail: { argsKey: key, repeatable: true } }, { detail: { argsKey: key, repeatable: true } }]
    const v = await checkRepeatGuard({ toolName: 'drive_mac_app', argsKey: key, conversationId: CONV })
    expect(v.blocked).toBe(false)
  })

  it('does not count failures of a DIFFERENT call', async () => {
    rows = [{ detail: { argsKey: 'someotherkey' } }, { detail: { argsKey: 'someotherkey' } }]
    const v = await checkRepeatGuard({ toolName: 'drive_mac_app', argsKey: key, conversationId: CONV })
    expect(v.blocked).toBe(false)
    expect(v.priorFailures).toBe(0)
  })

  it('fails OPEN with no conversation to reason about', async () => {
    rows = [{ detail: { argsKey: key } }, { detail: { argsKey: key } }]
    const v = await checkRepeatGuard({ toolName: 'drive_mac_app', argsKey: key, conversationId: null })
    expect(v.blocked).toBe(false)
  })
})
