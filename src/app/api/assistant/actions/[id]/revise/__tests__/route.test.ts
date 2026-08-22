import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lockAuthority: vi.fn(),
  transaction: vi.fn(),
  createMessage: vi.fn(),
  findPendingAction: vi.fn(),
  updatePendingAction: vi.fn(),
  runOwnerTurn: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    agentMessage: { create: mocks.createMessage },
    agentPendingAction: {
      findUnique: mocks.findPendingAction,
      update: mocks.updatePendingAction,
    },
  },
}))

vi.mock('@/agent/lib/live-browser/turn-lane', () => ({
  lockDirectYouTubeLaneAuthority: mocks.lockAuthority,
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: vi.fn(() => true) }))
vi.mock('@/agent/lib/pending-action', () => ({ isPendingActionExpired: vi.fn(() => false) }))
vi.mock('@/agent/lib/planner', () => ({ settlePlanStepsLinkedToPendingAction: vi.fn() }))
vi.mock('@/agent/lib/revise-pending', () => ({
  isRevisableAction: vi.fn(() => true),
  buildReviseDirective: vi.fn(() => 'OWNER_REVISION_DIRECTIVE'),
}))
vi.mock('@/agent/lib/models/run-owner-turn', () => ({ runOwnerTurn: mocks.runOwnerTurn }))
vi.mock('@/agent/lib/tool-telemetry', () => ({ logToolEvent: vi.fn() }))

import { POST } from '../route'

describe('pending-action revision owner authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AGENT_INTERNAL_TOKEN = 'test-owner-token'
    mocks.findPendingAction
      .mockResolvedValueOnce({
        id: 'action-1',
        status: 'pending',
        type: 'owner_task',
        summary: 'Original card',
        payload: {},
        conversationId: 'conv-1',
        businessId: 'ALMA_LIFESTYLE',
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'action-1',
        status: 'pending',
        type: 'owner_task',
        summary: 'Revised card',
      })
    mocks.runOwnerTurn.mockImplementation(async function* () {
      yield { type: 'done', costUsd: 0 }
    })
  })

  it('does not accept the newer owner message until the browser authority lock is held', async () => {
    let releaseLock!: () => void
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve })
    mocks.lockAuthority.mockImplementation(async () => lockHeld)
    const tx = {
      agentMessage: { create: mocks.createMessage.mockResolvedValue({ id: 'message-1' }) },
    }
    mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))

    const request = new Request('http://localhost/api/assistant/actions/action-1/revise', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-owner-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ feedback: 'Use the corrected owner instruction' }),
    })
    const responsePromise = POST(request as never, {
      params: Promise.resolve({ id: 'action-1' }),
    })

    await vi.waitFor(() => expect(mocks.lockAuthority).toHaveBeenCalledWith(tx, 'conv-1'))
    expect(mocks.createMessage).not.toHaveBeenCalled()

    releaseLock()
    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: 'conv-1',
        role: 'user',
      }),
    }))
    expect(mocks.lockAuthority.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createMessage.mock.invocationCallOrder[0])
  })
})
