import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/prisma', () => ({
  prisma: { agentPendingAction: { findMany: mocks.findMany } },
}))

import { GET } from '@/app/api/assistant/internal/pending-jobs/route'

const oldEnv = {
  token: process.env.AGENT_INTERNAL_TOKEN,
  vercel: process.env.VERCEL_ENV,
  leases: process.env.AGENT_WORKFLOW_LEASES,
}

function request(scoped = false) {
  return new NextRequest('https://preview.example.test/api/assistant/internal/pending-jobs', {
    headers: {
      authorization: 'Bearer internal-test-token',
      ...(scoped ? { 'x-alma-worker-scope': 'creative-studio-preview' } : {}),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  process.env.AGENT_WORKFLOW_LEASES = 'false'
})

afterEach(() => {
  if (oldEnv.token === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = oldEnv.token
  if (oldEnv.vercel === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = oldEnv.vercel
  if (oldEnv.leases === undefined) delete process.env.AGENT_WORKFLOW_LEASES
  else process.env.AGENT_WORKFLOW_LEASES = oldEnv.leases
})

describe('GET /api/assistant/internal/pending-jobs preview isolation', () => {
  it('returns only signed Creative Studio images from the preview lane', async () => {
    process.env.VERCEL_ENV = 'preview'
    mocks.findMany.mockResolvedValue([
      { id: 'signed', type: 'image_gen', payload: { creativeStudio: true, studioRunAuthorization: { receipt: 'receipt' } } },
      { id: 'unsigned', type: 'image_gen', payload: { creativeStudio: true } },
    ])

    const response = await GET(request(true))
    await expect(response.json()).resolves.toEqual({
      jobs: [{ id: 'signed', type: 'image_gen', payload: { creativeStudio: true, studioRunAuthorization: { receipt: 'receipt' } } }],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'preview_approved', type: 'image_gen' },
    }))
  })

  it('does not expose the preview lane without a valid preview runtime', async () => {
    process.env.VERCEL_ENV = 'production'
    mocks.findMany.mockResolvedValue([])

    await GET(request(true))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.any(Array) }),
    }))
  })
})
