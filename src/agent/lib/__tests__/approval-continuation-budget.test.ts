import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  kvFind: vi.fn(),
  actionFind: vi.fn(),
  actionCount: vi.fn(),
  createTurn: vi.fn(),
  finalizeTurn: vi.fn(),
  enqueueTurnJob: vi.fn(),
  runOwnerTurn: vi.fn(),
  trace: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: { findUnique: mocks.kvFind },
    agentPendingAction: {
      findUnique: mocks.actionFind,
      count: mocks.actionCount,
    },
  },
}))
vi.mock('@/agent/lib/turn-status', () => ({
  createTurn: mocks.createTurn,
  finalizeTurnIfRunning: mocks.finalizeTurn,
}))
vi.mock('@/agent/lib/turn-queue', () => ({
  buildTurnJobData: vi.fn(),
  enqueueTurnJob: mocks.enqueueTurnJob,
  isTurnHandoffConfigured: () => false,
}))
vi.mock('@/agent/lib/turn-stage-trace', () => ({ traceTurnStage: mocks.trace }))
vi.mock('@/agent/lib/models/run-owner-turn', () => ({ runOwnerTurn: mocks.runOwnerTurn }))

import {
  enqueueApprovedActionContinuation,
  hasSafeInlineContinuationBudget,
} from '../approval-continuation'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.kvFind.mockResolvedValue({ value: 'on' })
  mocks.createTurn.mockResolvedValue('created-turn')
  mocks.finalizeTurn.mockResolvedValue(undefined)
  mocks.actionFind.mockResolvedValue({
    conversationId: 'conversation-1',
    status: 'executed',
    summary: 'Run approved Mac command',
    type: 'mac_command',
    result: { ok: true },
  })
  mocks.actionCount.mockResolvedValue(0)
})

describe('approval continuation route budget', () => {
  it('terminalizes a long-Mac progress turn with durable continuation eligibility when worker is unavailable', async () => {
    const now = Date.now()
    await enqueueApprovedActionContinuation('mac-action', 'progress-turn', {
      inlineDeadlineAtMs: now + 12_000,
    })

    expect(mocks.runOwnerTurn).not.toHaveBeenCalled()
    expect(mocks.enqueueTurnJob).not.toHaveBeenCalled()
    expect(mocks.trace).toHaveBeenCalledWith(
      'progress-turn', 'continuation_enqueued', 'client_budget',
    )
    expect(mocks.finalizeTurn).toHaveBeenCalledWith(
      'progress-turn', 'done', { continuationNeeded: true },
    )
  })

  it('requires the whole inline execution and terminal-write budget', () => {
    const now = 1_000_000
    expect(hasSafeInlineContinuationBudget(now + 95_000, now)).toBe(true)
    expect(hasSafeInlineContinuationBudget(now + 94_999, now)).toBe(false)
    expect(hasSafeInlineContinuationBudget(undefined, now)).toBe(true)
  })

  it('passes an absolute safe deadline from the 120s approval route', () => {
    const route = readFileSync(join(process.cwd(),
      'src/app/api/assistant/actions/[id]/approve/route.ts'), 'utf8')
    expect(route).toContain(
      'inlineDeadlineAtMs: approveReceivedAt.getTime() + maxDuration * 1000 - 10_000',
    )
  })
})
