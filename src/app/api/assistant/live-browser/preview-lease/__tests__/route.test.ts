import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const {
  deviceFindMany,
  stopBrowserPreviewLeases,
  cancelLiveBrowserTurn,
} = vi.hoisted(() => ({
  deviceFindMany: vi.fn(),
  stopBrowserPreviewLeases: vi.fn(),
  cancelLiveBrowserTurn: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: vi.fn(() => null) }))
vi.mock('@/lib/api-guards', () => ({ getJwt: vi.fn(async () => ({ sub: 'owner-1', role: 'owner' })) }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: vi.fn(() => true) }))
vi.mock('@/agent/lib/native-owner-push', () => ({ resolveOwnerUserIds: vi.fn(async () => ['owner-1']) }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    liveBrowserDevice: { findMany: deviceFindMany },
    agentTurn: { findFirst: vi.fn() },
    liveBrowserCommand: { findMany: vi.fn() },
  },
}))
vi.mock('@/agent/lib/live-browser/companion', () => ({
  stopBrowserPreviewLeases,
  cancelLiveBrowserTurn,
  renewBrowserPreviewLease: vi.fn(),
}))

import { POST } from '../route'

function request(body: unknown): NextRequest {
  return new Request('https://alma.test/api/assistant/live-browser/preview-lease', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest
}

describe('browser preview lease cleanup', () => {
  beforeEach(() => {
    deviceFindMany.mockReset().mockResolvedValue([{ id: 'device-owner-1' }])
    stopBrowserPreviewLeases.mockReset().mockResolvedValue(1)
    cancelLiveBrowserTurn.mockReset()
  })

  it('releases only the exact owner preview lease without canceling browser work', async () => {
    const response = await POST(request({
      conversationId: 'conversation-a',
      turnId: 'turn-a',
      on: false,
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, stoppedLeases: 1 })
    expect(stopBrowserPreviewLeases).toHaveBeenCalledWith({
      deviceIds: ['device-owner-1'],
      turnId: 'turn-a',
      conversationId: 'conversation-a',
    })
    expect(cancelLiveBrowserTurn).not.toHaveBeenCalled()
  })
})
