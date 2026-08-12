import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown> & {
  id: string
  dedupeKey?: string | null
  conversationId: string | null
  type: string
  status: string
  createdAt: Date
}

const mocks = vi.hoisted(() => ({
  rows: [] as Row[],
  create: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
  messageUpsert: vi.fn(),
  conversationUpdate: vi.fn(),
  readKv: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/creative-studio/taste', () => ({ readKv: mocks.readKv }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      create: mocks.create,
    },
    agentMessage: { upsert: mocks.messageUpsert },
    agentConversation: { update: mocks.conversationUpdate },
    $transaction: mocks.transaction,
  },
}))

import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  IMAGE_WORKER_CAPABILITY_SOURCE,
  IMAGE_WORKER_CAPABILITY_VERSION,
} from '@/agent/lib/image-action-contract'
import { POST } from '../route'

const oldEnv = {
  token: process.env.AGENT_INTERNAL_TOKEN,
  gemini: process.env.GEMINI_API_KEY,
}
let transactionTail: Promise<unknown> = Promise.resolve()

function source(overrides: Partial<Row> = {}): Row {
  return {
    id: 'failed-source',
    conversationId: 'conversation-1',
    dedupeKey: null,
    type: 'image_gen',
    payload: {
      prompt: 'A product portrait',
      quality: 'pro',
      imageSize: '2K',
      variationCount: 4,
      aspectRatio: '4:5',
      pipelineMode: 'preview',
      progressTurnId: 'old-failed-turn',
    },
    summary: 'Image generation request (pro quality, 4 variations)',
    costEstimate: 0.54,
    status: 'failed',
    businessId: 'ALMA_LIFESTYLE',
    imageModel: 'gemini-3.1-flash-image',
    imageQuote: {
      version: 1,
      currency: 'USD',
      kind: 'provider_render_estimate',
      model: 'gemini-3.1-flash-image',
      provider: 'gemini',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 4,
      unitPriceUsd: 0.101,
      minCostUsd: 0.404,
      maxCostUsd: 0.404,
      maxPaidGenerationsPerImage: 1,
      pricingBasis: 'internal_list_estimate',
      pricingLastVerifiedAt: '2026-06-15',
      excludes: ['qc_vision', 'taxes', 'provider_credits'],
    },
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  }
}

function request() {
  return new NextRequest('https://alma.test/api/assistant/actions/failed-source/retry', {
    method: 'POST',
    headers: { authorization: 'Bearer internal-test-token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionTail = Promise.resolve()
  mocks.rows.splice(0, mocks.rows.length, source())
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  process.env.GEMINI_API_KEY = 'configured'
  mocks.messageUpsert.mockResolvedValue({ id: 'retry-card-message' })
  mocks.conversationUpdate.mockResolvedValue({})
  mocks.readKv.mockImplementation(async (key: string) => {
    if (key !== IMAGE_WORKER_CAPABILITY_KV_KEY) return null
    return JSON.stringify({
      version: IMAGE_WORKER_CAPABILITY_VERSION,
      source: IMAGE_WORKER_CAPABILITY_SOURCE,
      updatedAt: new Date().toISOString(),
      models: ['gemini-3.1-flash-image', 'gemini-3-pro-image'],
    })
  })

  mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string; dedupeKey?: string } }) => {
    if (where.id) return mocks.rows.find((row) => row.id === where.id) ?? null
    return mocks.rows.find((row) => row.dedupeKey === where.dedupeKey) ?? null
  })
  mocks.findFirst.mockImplementation(async ({ where }: { where: { conversationId: string; status: string } }) => (
    mocks.rows.find((row) => row.conversationId === where.conversationId && row.status === where.status) ?? null
  ))
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    // Force concurrent callers across the same scheduling boundary; the unique
    // dedupe key then elects exactly one new pending card.
    await Promise.resolve()
    if (mocks.rows.some((row) => row.dedupeKey === data.dedupeKey)) {
      throw Object.assign(new Error('unique'), { code: 'P2002' })
    }
    const row = {
      ...data,
      id: 'retry-action',
      createdAt: new Date('2026-08-11T00:01:00.000Z'),
    } as Row
    mocks.rows.push(row)
    return row
  })
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
    const run = transactionTail.then(() => fn({
      $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      agentPendingAction: {
        findUnique: mocks.findUnique,
        findFirst: mocks.findFirst,
        create: mocks.create,
      },
    }))
    transactionTail = run.then(() => undefined, () => undefined)
    return run
  })
})

afterEach(() => {
  if (oldEnv.token === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = oldEnv.token
  if (oldEnv.gemini === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = oldEnv.gemini
})

describe('POST /api/assistant/actions/:id/retry', () => {
  it('clones the pinned image inputs/model/quote into a new pending card without auto-approval', async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      pendingActionId: 'retry-action',
      sourceActionId: 'failed-source',
      idempotent: false,
      action: {
        id: 'retry-action',
        type: 'image_gen',
        status: 'pending',
        imageModelSelection: {
          selectedModel: 'gemini-3.1-flash-image',
          quote: { currency: 'USD', minCostUsd: 0.404, maxCostUsd: 0.404 },
        },
      },
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: 'image-retry:failed-source',
        status: 'pending',
        ownerDecided: null,
        imageModel: 'gemini-3.1-flash-image',
        imageQuote: expect.objectContaining({ minCostUsd: 0.404 }),
      }),
    })
    expect(mocks.create.mock.calls[0][0].data.payload).not.toHaveProperty('progressTurnId')
    expect(mocks.messageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientRequestId: 'image-retry-card:retry-action' },
      create: expect.objectContaining({
        clientRequestId: 'image-retry-card:retry-action',
        conversationId: 'conversation-1',
        content: [expect.objectContaining({
          type: 'confirm_card',
          pendingActionId: 'retry-action',
          imageModelSelection: expect.any(Object),
        })],
      }),
    }))
    expect(mocks.rows.find((row) => row.id === 'failed-source')?.status).toBe('failed')
  })

  it('dedupes concurrent retry taps to one new pending card', async () => {
    const [first, second] = await Promise.all([
      POST(request(), { params: Promise.resolve({ id: 'failed-source' }) }),
      POST(request(), { params: Promise.resolve({ id: 'failed-source' }) }),
    ])
    const bodies = await Promise.all([first.json(), second.json()])
    expect(bodies.map((body) => body.pendingActionId)).toEqual(['retry-action', 'retry-action'])
    expect(bodies.map((body) => body.idempotent).sort()).toEqual([false, true])
    expect(mocks.rows.filter((row) => row.dedupeKey === 'image-retry:failed-source')).toHaveLength(1)
  })

  it('serializes different failed sources so one conversation gets only one open card', async () => {
    mocks.rows.push(source({ id: 'failed-source-2' }))
    const [first, second] = await Promise.all([
      POST(request(), { params: Promise.resolve({ id: 'failed-source' }) }),
      POST(request(), { params: Promise.resolve({ id: 'failed-source-2' }) }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const bodies = await Promise.all([first.json(), second.json()])
    expect(bodies.some((body) => body.error === 'open_card_exists')).toBe(true)
    expect(mocks.rows.filter((row) => row.status === 'pending')).toHaveLength(1)
  })

  it('blocks a second open approval card in the same conversation', async () => {
    mocks.rows.push(source({ id: 'already-open', status: 'pending' }))
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'open_card_exists',
      openActionId: 'already-open',
      openActionType: 'image_gen',
      status: 'pending',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('refuses non-terminal sources', async () => {
    mocks.rows[0].status = 'executed'
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'retry_requires_failed', status: 'executed' })
  })

  it('does not create a retry card when the active worker receipt is missing', async () => {
    mocks.readKv.mockResolvedValue(null)
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: 'image_model_unavailable',
      message: expect.stringContaining('missing'),
      retryable: true,
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('does not resurrect the cold card after the deduped retry has settled', async () => {
    mocks.rows.push(source({
      id: 'retry-action',
      dedupeKey: 'image-retry:failed-source',
      status: 'executed',
    }))
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'retry_already_resolved',
      pendingActionId: 'retry-action',
      status: 'executed',
    })
    expect(mocks.messageUpsert).not.toHaveBeenCalled()
  })

  it('rejects signed Creative Studio payloads instead of cloning one-time authorization', async () => {
    mocks.rows[0].payload = {
      creativeStudio: true,
      studioRunAuthorization: { receipt: 'one-time' },
    }
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'image_retry_not_supported' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps the deduped action and returns retryable 503 if cold-history card persistence fails', async () => {
    mocks.messageUpsert.mockRejectedValueOnce(new Error('message store unavailable'))
    const response = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'retry_card_persist_failed',
      pendingActionId: 'retry-action',
      retryable: true,
    })
    expect(mocks.rows.filter((row) => row.dedupeKey === 'image-retry:failed-source')).toHaveLength(1)

    const replay = await POST(request(), { params: Promise.resolve({ id: 'failed-source' }) })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ pendingActionId: 'retry-action', idempotent: true })
  })
})
