import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown> & { id: string; payload: Record<string, unknown> }

const mocks = vi.hoisted(() => ({
  actions: new Map<string, Row>(),
  kv: new Map<string, string>(),
  pendingFindUnique: vi.fn(),
  pendingUpdate: vi.fn(),
  pendingUpsert: vi.fn(),
  kvFindUnique: vi.fn(),
  kvCreate: vi.fn(),
  kvUpdateMany: vi.fn(),
  productFindFirst: vi.fn(),
  applyBrandFrame: vi.fn(),
  sendOwnerApprovalCard: vi.fn(),
  signedUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: mocks.pendingFindUnique,
      update: mocks.pendingUpdate,
      upsert: mocks.pendingUpsert,
    },
    agentKvSetting: {
      findUnique: mocks.kvFindUnique,
      create: mocks.kvCreate,
      updateMany: mocks.kvUpdateMany,
    },
    productContentAsset: { findFirst: mocks.productFindFirst },
  },
}))
vi.mock('@/agent/lib/storage', () => ({ agentStorageSignedUrl: mocks.signedUrl }))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({
  sendOwnerApprovalCard: mocks.sendOwnerApprovalCard,
}))
vi.mock('@/agent/lib/meta', () => ({ resolvePageId: () => 'page-1' }))
vi.mock('@/lib/content-intelligence', () => ({ trackPublishedContent: vi.fn() }))
vi.mock('@/lib/content-engine/brand-frame', () => ({ applyBrandFrame: mocks.applyBrandFrame }))
vi.mock('@/lib/content-engine/caption', () => ({ generateCaption: vi.fn() }))
vi.mock('@/lib/content-engine/theme', () => ({ resolveTheme: vi.fn() }))
vi.mock('@/lib/content-engine/config', () => ({
  getContentEngineConfig: vi.fn(),
  variantsForProduct: vi.fn(),
}))
vi.mock('@/lib/content-engine/generate-variants', () => ({
  generateProductVariants: vi.fn(),
  PHASE1_VARIANTS: ['single'],
  PHASE2_FULL_VARIANTS: ['single'],
  variantLabel: (value: string) => value,
}))

import { onPipelineRenderComplete } from '@/lib/content-engine/pipeline'

function installRows(qualityPass: 'draft' | 'pro') {
  const gate1: Row = {
    id: 'gate-1',
    type: 'content_gate1',
    status: 'pending',
    payload: {
      pipelineId: 'pipeline-1',
      productCode: 'ALMA-101',
      variants: [{
        key: 'single',
        rawImagePath: null,
        framedImagePath: null,
        renderActionId: 'render-1',
        keep: false,
      }],
      theme: 'default',
      hook: 'New collection',
      stage: qualityPass === 'draft' ? 'draft_rendering' : 'pro_rendering',
      qualityPass,
      page: 'lifestyle',
      conversationId: 'conversation-1',
      caption: 'Premium collection',
    },
  }
  const render: Row = {
    id: 'render-1',
    type: 'image_gen',
    status: 'executed',
    payload: {
      contentPipeline: {
        gate1Id: 'gate-1',
        variant: 'single',
        quality: qualityPass,
        productCode: 'ALMA-101',
        theme: 'default',
      },
    },
  }
  mocks.actions.set(gate1.id, gate1)
  mocks.actions.set(render.id, render)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actions.clear()
  mocks.kv.clear()
  mocks.pendingFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (
    where.id ? mocks.actions.get(where.id) ?? null : null
  ))
  mocks.pendingUpdate.mockImplementation(async ({ where, data }: {
    where: { id: string }
    data: Record<string, unknown>
  }) => {
    const row = mocks.actions.get(where.id)
    if (!row) throw new Error('missing action')
    Object.assign(row, data)
    return row
  })
  mocks.pendingUpsert.mockImplementation(async ({ where, create }: {
    where: { dedupeKey: string }
    create: Record<string, unknown>
  }) => {
    const existing = [...mocks.actions.values()].find((row) => row.dedupeKey === where.dedupeKey)
    if (existing) return existing
    const row = {
      id: 'gate-2',
      ...create,
      payload: create.payload as Record<string, unknown>,
    } as Row
    mocks.actions.set(row.id, row)
    return row
  })
  mocks.kvFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const value = mocks.kv.get(where.key)
    return value === undefined ? null : { key: where.key, value }
  })
  mocks.kvCreate.mockImplementation(async ({ data }: { data: { key: string; value: string } }) => {
    if (mocks.kv.has(data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' })
    mocks.kv.set(data.key, data.value)
    return data
  })
  mocks.kvUpdateMany.mockImplementation(async ({ where, data }: {
    where: { key: string; value: string }
    data: { value: string }
  }) => {
    if (mocks.kv.get(where.key) !== where.value) return { count: 0 }
    mocks.kv.set(where.key, data.value)
    return { count: 1 }
  })
  mocks.productFindFirst.mockResolvedValue({
    productCode: 'ALMA-101',
    name: 'Premium set',
    category: 'Family',
    fabric: 'Cotton',
    imagePath: 'products/alma-101.jpg',
    familyMatch: false,
  })
  mocks.applyBrandFrame.mockResolvedValue('content/framed/alma-101.jpg')
  mocks.sendOwnerApprovalCard.mockResolvedValue({ ok: true })
  mocks.signedUrl.mockImplementation(async (path: string) => `https://signed.test/${path}`)
})

describe('content pipeline render callback idempotency', () => {
  it('serializes concurrent PRO callbacks and creates one Gate-2/card', async () => {
    installRows('pro')
    let releaseFrame: (path: string) => void = () => {}
    let frameStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { frameStarted = resolve })
    mocks.applyBrandFrame.mockImplementationOnce(() => new Promise<string>((resolve) => {
      releaseFrame = resolve
      frameStarted()
    }))

    const winner = onPipelineRenderComplete('render-1', 'generated/final.png')
    await started
    await expect(onPipelineRenderComplete('render-1', 'generated/final.png'))
      .rejects.toThrow('pipeline_render_reconciliation_in_progress')
    releaseFrame('content/framed/alma-101.jpg')
    await winner

    // A later HTTP/BullMQ replay observes the applied receipt and is a no-op.
    await onPipelineRenderComplete('render-1', 'generated/final.png')
    expect(mocks.applyBrandFrame).toHaveBeenCalledTimes(1)
    expect(mocks.pendingUpsert).toHaveBeenCalledTimes(1)
    expect(mocks.pendingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: 'content-pipeline-gate2:gate-1' },
    }))
    expect(mocks.sendOwnerApprovalCard).toHaveBeenCalledTimes(1)
    expect([...mocks.actions.values()].filter((row) => row.type === 'content_gate2')).toHaveLength(1)
    expect(JSON.parse(mocks.kv.get('content_pipeline_render_receipt:render-1') ?? '{}'))
      .toMatchObject({ state: 'applied', gate2Id: 'gate-2' })
  })

  it('does not re-frame or resend the Gate-1 card on an identical draft replay', async () => {
    installRows('draft')

    await onPipelineRenderComplete('render-1', 'generated/draft.png')
    await onPipelineRenderComplete('render-1', 'generated/draft.png')

    expect(mocks.applyBrandFrame).toHaveBeenCalledTimes(1)
    expect(mocks.pendingUpsert).not.toHaveBeenCalled()
    expect(mocks.sendOwnerApprovalCard).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.kv.get('content_pipeline_render_receipt:render-1') ?? '{}'))
      .toMatchObject({ state: 'applied', framedImagePath: 'content/framed/alma-101.jpg' })
  })

  it('retries a failed card delivery without re-framing or creating another Gate-2', async () => {
    installRows('pro')
    mocks.sendOwnerApprovalCard
      .mockResolvedValueOnce({ ok: false, error: 'telegram unavailable' })
      .mockResolvedValueOnce({ ok: true })

    await expect(onPipelineRenderComplete('render-1', 'generated/retry.png'))
      .rejects.toThrow('pipeline_gate2_card_failed')
    expect(JSON.parse(mocks.kv.get('content_pipeline_render_receipt:render-1') ?? '{}'))
      .toMatchObject({ state: 'pending', gate2Id: 'gate-2' })

    await onPipelineRenderComplete('render-1', 'generated/retry.png')
    expect(mocks.applyBrandFrame).toHaveBeenCalledTimes(1)
    expect(mocks.pendingUpsert).toHaveBeenCalledTimes(1)
    expect([...mocks.actions.values()].filter((row) => row.type === 'content_gate2')).toHaveLength(1)
    expect(mocks.sendOwnerApprovalCard).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mocks.kv.get('content_pipeline_render_receipt:render-1') ?? '{}'))
      .toMatchObject({ state: 'applied', gate2Id: 'gate-2' })
  })
})
