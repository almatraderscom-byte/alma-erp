import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const {
  pendingFind,
  runBrowserTaskOnCompanion,
  claimTurnForRequest,
  finalizeTurnIfRunning,
} = vi.hoisted(() => ({
  pendingFind: vi.fn(),
  runBrowserTaskOnCompanion: vi.fn(),
  claimTurnForRequest: vi.fn(),
  finalizeTurnIfRunning: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { agentPendingAction: { findUnique: pendingFind } },
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/agent/lib/browser/companion-bridge', () => ({ runBrowserTaskOnCompanion }))
vi.mock('@/agent/lib/turn-status', () => ({ claimTurnForRequest, finalizeTurnIfRunning }))

import { POST } from '../route'

function request(body: unknown): NextRequest {
  return new Request('https://alma.test/api/assistant/internal/browser-companion', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer internal-secret',
    },
    body: JSON.stringify(body),
  }) as NextRequest
}

describe('worker-backed browser Companion route', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_INTERNAL_TOKEN', 'internal-secret')
    pendingFind.mockReset().mockResolvedValue({
      type: 'browser_action',
      status: 'approved',
      conversationId: 'conversation-1',
      payload: {
        goal: 'Approved canonical task',
        driver: 'companion',
        steps: [{ action: 'goto', url: 'https://example.com' }],
      },
    })
    claimTurnForRequest.mockReset().mockResolvedValue({
      claimed: true,
      turnId: 'turn-browser-action-1',
      status: 'running',
    })
    finalizeTurnIfRunning.mockReset().mockResolvedValue(undefined)
    runBrowserTaskOnCompanion.mockReset().mockResolvedValue({
      ok: true,
      goal: 'Approved canonical task',
      log: [],
      extracted: [],
      screenshots: [],
    })
  })

  it('executes only the approved stored payload under a durable turn context', async () => {
    const response = await POST(request({
      pendingActionId: 'action-1',
      payload: { goal: 'worker-tampered', steps: [] },
    }))

    expect(response.status).toBe(200)
    expect(claimTurnForRequest).toHaveBeenCalledWith(
      'conversation-1',
      'browser-action:action-1',
      'worker',
    )
    expect(runBrowserTaskOnCompanion).toHaveBeenCalledWith(
      expect.objectContaining({ goal: 'Approved canonical task' }),
      { turnId: 'turn-browser-action-1', conversationId: 'conversation-1' },
    )
    expect(finalizeTurnIfRunning).toHaveBeenCalledWith('turn-browser-action-1', 'done')
  })

  it('fails closed when the approved action has no conversation authority', async () => {
    pendingFind.mockResolvedValueOnce({
      type: 'browser_action',
      status: 'approved',
      conversationId: null,
      payload: { goal: 'orphan', steps: [{ action: 'goto', url: 'https://example.com' }] },
    })

    const response = await POST(request({ pendingActionId: 'action-orphan' }))
    expect(response.status).toBe(409)
    expect(claimTurnForRequest).not.toHaveBeenCalled()
    expect(runBrowserTaskOnCompanion).not.toHaveBeenCalled()
  })
})
