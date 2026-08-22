import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const cancelLiveBrowserTurn = vi.hoisted(() => vi.fn())

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => ({ sub: 'owner-1', role: 'OWNER' })),
}))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/agent/lib/live-browser/companion', () => ({ cancelLiveBrowserTurn }))

import { POST } from '../route'

function request() {
  return new NextRequest('https://alma.test/api/assistant/turn/turn-direct/cancel', {
    method: 'POST',
  })
}

describe('POST /api/assistant/turn/:id/cancel', () => {
  it('does not return 200 until durable browser cancellation finishes', async () => {
    let release!: () => void
    const durableCancel = new Promise<{ found: true; canceledCommands: number }>((resolve) => {
      release = () => resolve({ found: true, canceledCommands: 2 })
    })
    cancelLiveBrowserTurn.mockReturnValueOnce(durableCancel)

    let routeReturned = false
    const responsePromise = POST(request(), { params: Promise.resolve({ id: 'turn-direct' }) })
      .then((response) => {
        routeReturned = true
        return response
      })
    await Promise.resolve()
    expect(routeReturned).toBe(false)

    release()
    const response = await responsePromise
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, canceledCommands: 2 })
    expect(cancelLiveBrowserTurn).toHaveBeenCalledWith('turn-direct')
  })
})
