import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
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
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
  },
}))

import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
} from '@/agent/lib/image-action-contract'
import {
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY,
  buildImageConfigEnvelope,
  buildImageRenderConfig,
  payloadMirrorFromConfig,
} from '@/agent/lib/image-config-contract'
import {
  supportedPresetTiersForModel as workerPresetTiers,
} from '../../../../../../../worker/src/image-resolution-contract.mjs'
import { POST } from '../route'

const NOW = new Date()

function v1Receipt(): string {
  return JSON.stringify({
    version: 1,
    source: 'alma-agent-worker',
    updatedAt: NOW.toISOString(),
    models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gpt-image-2', 'seedream-5.0-pro'],
  })
}

function v2Receipt(): string {
  const models = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gpt-image-2', 'seedream-5.0-pro']
  return JSON.stringify({
    version: 2,
    source: 'alma-agent-worker',
    updatedAt: NOW.toISOString(),
    configContractVersion: 1,
    models,
    presets: Object.fromEntries(models.map((m) => [m, workerPresetTiers(m)])),
  })
}

function kvStub(overrides: Record<string, string | null> = {}) {
  mocks.readKv.mockImplementation(async (key: string) => {
    if (key in overrides) return overrides[key]
    if (key === IMAGE_WORKER_CAPABILITY_KV_KEY) return v1Receipt()
    if (key === IMAGE_WORKER_CAPABILITY_V2_KV_KEY) return v2Receipt()
    return null
  })
}

function v2Action(overrides: Record<string, unknown> = {}) {
  const config = buildImageRenderConfig({
    model: 'gpt-image-2',
    presetId: 'social_post',
    imageSize: '2K',
    quality: 'standard',
    variationCount: 4,
    pipelineMode: 'preview',
  })
  const envelope = buildImageConfigEnvelope('gpt-image-2', config)
  return {
    id: 'action-1',
    conversationId: 'conversation-1',
    type: 'image_gen',
    status: 'pending',
    approvalClaimedAt: null,
    summary: 'Image generation request',
    payload: {
      prompt: 'A studio product portrait',
      ...payloadMirrorFromConfig('gpt-image-2', config),
    },
    imageModel: 'gpt-image-2',
    imageQuote: null,
    imageConfig: envelope,
    imageConfigRevision: 3,
    ...overrides,
  }
}

function editRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assistant/actions/action-1', {
    method: 'POST',
    headers: { authorization: 'Bearer internal-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 'action-1' }) }

beforeEach(() => {
  process.env.AGENT_INTERNAL_TOKEN = 'internal-token'
  kvStub()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/assistant/actions/[id] — v2 image config edit', () => {
  it('accepts a compatible edit through the revisioned CAS and echoes revision+1', async () => {
    const action = v2Action()
    mocks.findUnique.mockResolvedValue(action)
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const res = await POST(editRequest({
      imageConfig: {
        expectedRevision: 3,
        imageModel: 'gemini-3-pro-image',
        presetId: 'poster',
        imageSize: '2K',
        quality: 'standard',
        variationCount: 2,
      },
    }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.imageRenderSelection.revision).toBe(4)
    expect(body.imageRenderSelection.selectedModel).toBe('gemini-3-pro-image')
    expect(body.imageRenderSelection.config.presetId).toBe('poster')
    expect(body.imageRenderSelection.config.aspectRatio).toBe('2:3')
    expect(body.imageRenderSelection.config.width).toBe(1664)
    expect(body.imageRenderSelection.config.height).toBe(2496)
    // CAS predicate carried status/claim/revision together.
    const where = mocks.updateMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      id: 'action-1',
      status: 'pending',
      approvalClaimedAt: null,
      imageConfigRevision: 3,
    })
    const data = mocks.updateMany.mock.calls[0][0].data
    expect(data.imageConfigRevision).toBe(4)
    expect(data.payload.imageConfigFingerprint).toBe(data.imageConfig.fingerprint)
  })

  it('returns 409 with the current projection when the revision moved', async () => {
    const action = v2Action()
    mocks.findUnique
      .mockResolvedValueOnce(action)                                  // initial read
      .mockResolvedValueOnce(v2Action({ imageConfigRevision: 5 }))    // reconcile read
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const res = await POST(editRequest({
      imageConfig: {
        expectedRevision: 3,
        imageModel: 'gpt-image-2',
        presetId: 'square',
        imageSize: '1K',
        quality: 'standard',
        variationCount: 1,
      },
    }), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('image_config_conflict')
    expect(body.imageRenderSelection.revision).toBe(5)
  })

  it('rejects unsupported input with a field-specific 422 and no mutation', async () => {
    mocks.findUnique.mockResolvedValue(v2Action())
    const res = await POST(editRequest({
      imageConfig: {
        expectedRevision: 3,
        imageModel: 'gpt-image-2',
        presetId: 'poster',
        imageSize: '8K',
        quality: 'standard',
        variationCount: 1,
      },
    }), params)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.field).toBe('imageSize')
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a combination the provider tables cannot render', async () => {
    mocks.findUnique.mockResolvedValue(v2Action())
    const res = await POST(editRequest({
      imageConfig: {
        expectedRevision: 3,
        imageModel: 'gpt-image-2',
        presetId: 'poster',
        imageSize: '4K',        // GPT 4K exists only for 9:16/16:9
        quality: 'standard',
        variationCount: 1,
      },
    }), params)
    expect(res.status).toBe(422)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('fails closed when the v2 worker receipt is missing', async () => {
    kvStub({ [IMAGE_WORKER_CAPABILITY_V2_KV_KEY]: null })
    mocks.findUnique.mockResolvedValue(v2Action())
    const res = await POST(editRequest({
      imageConfig: {
        expectedRevision: 3,
        imageModel: 'gpt-image-2',
        presetId: 'social_post',
        imageSize: '2K',
        quality: 'standard',
        variationCount: 4,
      },
    }), params)
    expect(res.status).toBe(422)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('routes a legacy Build 102 model-only edit through the same v2 CAS', async () => {
    const action = v2Action()
    mocks.findUnique.mockResolvedValue(action)
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const res = await POST(editRequest({ imageModel: 'gemini-3-pro-image' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The v2 CAS carried the snapshot revision — a concurrent v2 edit wins or
    // loses atomically, never partially.
    const where = mocks.updateMany.mock.calls[0][0].where
    expect(where.imageConfigRevision).toBe(3)
    // Preserved preset/size/count from the current canonical config.
    expect(body.imageRenderSelection.config.presetId).toBe('social_post')
    expect(body.imageRenderSelection.config.variationCount).toBe(4)
    expect(body.imageRenderSelection.selectedModel).toBe('gemini-3-pro-image')
    // Build 102 still gets its v1 echo.
    expect(body.imageModelSelection.selectedModel).toBe('gemini-3-pro-image')
  })

  it('keeps the pure-v1 legacy path for cards without a canonical config', async () => {
    const action = v2Action({ imageConfig: null, imageConfigRevision: 0 })
    mocks.findUnique.mockResolvedValue(action)
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const res = await POST(editRequest({ imageModel: 'gemini-3-pro-image' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.imageModelSelection.selectedModel).toBe('gemini-3-pro-image')
    // v1 CAS shape unchanged: prior-model + claim guards, no revision key.
    const where = mocks.updateMany.mock.calls[0][0].where
    expect(where.imageModel).toBe('gpt-image-2')
    expect(where.imageConfigRevision).toBeUndefined()
  })
})
