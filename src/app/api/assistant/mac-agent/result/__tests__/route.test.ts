import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getAction: vi.fn(),
  getContext: vi.fn(),
  resolve: vi.fn(),
  deliver: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/agent/lib/mac-agent/bus', () => ({
  authenticateDevice: mocks.authenticate,
  getCommandAction: mocks.getAction,
  getCommandContext: mocks.getContext,
  resolveCommand: mocks.resolve,
}))
vi.mock('@/agent/lib/mac-agent/policy', () => ({ capOutput: (value: string) => value }))
vi.mock('@/agent/lib/mac-agent/ui-visual-proof', () => ({
  deliverDeferredUiAfterProof: mocks.deliver,
}))

import { POST } from '../route'

function request() {
  return new NextRequest('https://alma.test/api/assistant/mac-agent/result', {
    method: 'POST',
    headers: { authorization: 'Bearer device-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'after-command',
      ok: true,
      stdout: 'data:image/jpeg;base64,BBBB',
    }),
  })
}

describe('POST /api/assistant/mac-agent/result deferred visual proof', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticate.mockResolvedValue({ id: 'mac-1', ownerUserId: 'owner-1' })
    mocks.getAction.mockResolvedValue('ui_screenshot')
    mocks.getContext.mockResolvedValue({
      action: 'ui_screenshot',
      params: { proofPhase: 'after', proofPendingActionId: 'card-1' },
    })
    mocks.resolve.mockResolvedValue({ ok: true })
    mocks.deliver.mockResolvedValue(true)
  })

  it('does not resolve the command when deferred proof delivery fails', async () => {
    mocks.deliver.mockResolvedValue(false)
    const response = await POST(request())
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ retryable: true })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('resolves only after proof delivery succeeds', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.deliver.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolve.mock.invocationCallOrder[0],
    )
    expect(mocks.resolve).toHaveBeenCalledWith('mac-1', 'after-command', expect.objectContaining({
      ok: true,
    }))
  })
})
