import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeHarness = vi.hoisted(() => ({
  disabled: null as Response | null,
  actor: {
    userId: 'owner-1',
    name: 'Owner',
    email: null,
    erpRole: 'SUPER_ADMIN',
  },
  list: vi.fn(),
  configure: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({
  requireAgentEnabled: vi.fn(() => routeHarness.disabled),
}))
vi.mock('@/lib/creative-studio/studio-access', () => ({
  authenticateStudioRequest: vi.fn(async () => routeHarness.actor),
  studioAccessErrorResponse: vi.fn(() => Response.json({ error: 'access_error' }, { status: 403 })),
}))
vi.mock('@/lib/creative-studio/lifecycle-service', () => ({
  listLifecycleFeatureFlags: routeHarness.list,
  configureLifecycleFeatureFlag: routeHarness.configure,
  lifecycleServiceErrorResponse: vi.fn(() => Response.json({ error: 'service_error' }, { status: 422 })),
}))

import {
  GET,
  PUT,
} from '@/app/api/assistant/creative-studio/lifecycle/flags/route'

beforeEach(() => {
  routeHarness.disabled = null
  routeHarness.list.mockReset().mockResolvedValue([])
  routeHarness.configure.mockReset().mockResolvedValue({
    idempotent: false,
    flag: { id: 'flag-1', enabled: true },
  })
})

describe('lifecycle owner feature-flag API', () => {
  it('passes the exact owner-operated scope to the list service', async () => {
    const request = new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle/flags'
      + '?brandProfileId=brand-1&projectId=project-1&role=creator&capability=preview',
    )
    const response = await GET(request)
    expect(response.status).toBe(200)
    expect(routeHarness.list).toHaveBeenCalledWith(routeHarness.actor, {
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      role: 'creator',
      capability: 'preview',
    })
    await expect(response.json()).resolves.toMatchObject({
      flags: [],
      execution: {
        configOnly: true,
        paidRenderAllowed: false,
        voiceProviderAllowed: false,
        externalPublishAllowed: false,
      },
    })
  })

  it('uses authenticated server identity for a direct idempotent upsert', async () => {
    const body = {
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      role: 'creator',
      capability: 'preview',
      enabled: true,
      canaryPercent: 10,
      idempotencyKey: 'lifecycle:flag:direct-1',
    }
    const response = await PUT(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle/flags',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ))
    expect(response.status).toBe(201)
    expect(routeHarness.configure).toHaveBeenCalledWith(routeHarness.actor, body)
  })

  it('fails closed before authentication or service access when AGENT_ENABLED is off', async () => {
    routeHarness.disabled = Response.json({ error: 'agent_disabled' }, { status: 503 })
    const response = await GET(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle/flags',
    ))
    expect(response.status).toBe(503)
    expect(routeHarness.list).not.toHaveBeenCalled()
  })
})
