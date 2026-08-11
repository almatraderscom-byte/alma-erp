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
  vi.useRealTimers()
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
      { id: 'signed', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3', studioRunAuthorization: { receipt: 'receipt' } } },
      { id: 'internal', type: 'image_gen', payload: { creativeStudio: false, studioSurface: 'v3', studioRunAuthorization: { receipt: 'receipt' } } },
      { id: 'unsigned', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3' } },
    ])

    const response = await GET(request(true))
    await expect(response.json()).resolves.toEqual({
      jobs: [
        { id: 'signed', type: 'image_gen', payload: { creativeStudio: true, studioSurface: 'v3', studioRunAuthorization: { receipt: 'receipt' } } },
        { id: 'internal', type: 'image_gen', payload: { creativeStudio: false, studioSurface: 'v3', studioRunAuthorization: { receipt: 'receipt' } } },
      ],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        type: 'image_gen',
        AND: [
          {
            AND: [
              { payload: { path: ['studioSurface'], equals: 'v3' } },
              { payload: { path: ['studioRunAuthorization', 'receipt'], not: expect.anything() } },
            ],
          },
          {
            OR: [
              { status: 'preview_approved' },
              { jobResultPending: true },
            ],
          },
        ],
      },
      orderBy: [
        { jobResultPending: 'desc' },
        { createdAt: 'asc' },
      ],
    }))
  })

  it('does not expose the preview lane without a valid preview runtime', async () => {
    process.env.VERCEL_ENV = 'production'
    mocks.findMany.mockResolvedValue([])

    await GET(request(true))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.any(Array) }),
    }))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: 'image_gen',
        jobResultPending: true,
        NOT: expect.objectContaining({ AND: expect.any(Array) }),
      }),
      take: 10,
    }))
  })

  it('skips 10 active claims so an 11th unclaimed receipt runs, while expired claims reappear', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-11T06:00:00.000Z')
    vi.setSystemTime(now)
    const activeClaim = new Date(now.getTime() - 60_000)
    const expiredClaim = new Date(now.getTime() - 3 * 60_000 - 1)
    const receiptRows = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `claimed-${index + 1}`,
        type: 'image_gen',
        status: 'executed',
        jobResultPending: true,
        jobResultClaimedAt: activeClaim,
        createdAt: new Date(`2026-08-11T05:${String(index).padStart(2, '0')}:00.000Z`),
      })),
      {
        id: 'unclaimed-11',
        type: 'image_gen',
        status: 'executed',
        jobResultPending: true,
        jobResultClaimedAt: null,
        createdAt: new Date('2026-08-11T05:10:00.000Z'),
      },
      {
        id: 'expired-12',
        type: 'image_gen',
        status: 'failed',
        jobResultPending: true,
        jobResultClaimedAt: expiredClaim,
        createdAt: new Date('2026-08-11T05:11:00.000Z'),
      },
    ]
    mocks.findMany.mockImplementation(async (query: {
      where?: {
        jobResultPending?: boolean
        OR?: Array<{ jobResultClaimedAt: null | { lt: Date } }>
      }
      take?: number
    }) => {
      if (query.where?.jobResultPending !== true) return []
      const staleBefore = (
        query.where.OR?.find((condition) => (
          typeof condition.jobResultClaimedAt === 'object'
          && condition.jobResultClaimedAt !== null
        ))?.jobResultClaimedAt as { lt: Date } | undefined
      )?.lt
      if (!staleBefore) return receiptRows.slice(0, query.take)
      return receiptRows
        .filter((row) => (
          row.jobResultClaimedAt === null
          || row.jobResultClaimedAt < staleBefore
        ))
        .slice(0, query.take)
    })

    const response = await GET(request())
    await expect(response.json()).resolves.toEqual({
      jobs: [
        expect.objectContaining({ id: 'unclaimed-11' }),
        expect.objectContaining({ id: 'expired-12' }),
      ],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: 'image_gen',
        jobResultPending: true,
        OR: [
          { jobResultClaimedAt: null },
          { jobResultClaimedAt: { lt: new Date('2026-08-11T05:57:00.000Z') } },
        ],
      }),
      orderBy: { createdAt: 'asc' },
      take: 10,
    }))
  })
})
