import { describe, expect, it, vi } from 'vitest'
import {
  buildCampaignPackManifest,
  campaignPackDedupeKey,
  campaignStageDedupeKey,
  campaignStagesMissingForResume,
  latestCampaignStageAttempts,
  type CampaignPackStageSnapshot,
} from '@/lib/creative-studio/campaign-pack'

const serviceHarness = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const rows: Row[] = []
  const attachedActionIds = new Set<string>()
  let sequence = 0
  const now = () => new Date('2026-07-25T00:00:00.000Z')
  const attachProjectAsset = vi.fn(async (
    _ownerId: string,
    _projectId: string,
    value: { pendingActionId: string },
  ) => {
    attachedActionIds.add(value.pendingActionId)
    return {}
  })
  const action = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; dedupeKey?: string } }) =>
      rows.find((row) => where.id ? row.id === where.id : row.dedupeKey === where.dedupeKey) ?? null),
    findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
      rows.find((row) => !where.id || row.id === where.id) ?? null),
    findMany: vi.fn(async ({ where }: { where: { dedupeKey?: { startsWith?: string } } }) =>
      rows.filter((row) => {
        const prefix = where.dedupeKey?.startsWith
        return !prefix || String(row.dedupeKey ?? '').startsWith(prefix)
      })),
    upsert: vi.fn(async ({ where, create }: { where: { dedupeKey: string }; create: Row }) => {
      const existing = rows.find((row) => row.dedupeKey === where.dedupeKey)
      if (existing) return existing
      const row = {
        id: `action-${++sequence}`,
        result: null,
        resolvedAt: null,
        createdAt: now(),
        updatedAt: now(),
        ...create,
      }
      rows.push(row)
      return row
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rows.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error('missing_mock_row')
      Object.assign(row, data, { updatedAt: now() })
      return row
    }),
  }
  return {
    rows,
    attachProjectAsset,
    reset() {
      rows.splice(0)
      attachedActionIds.clear()
      sequence = 0
      for (const method of Object.values(action)) method.mockClear()
      attachProjectAsset.mockClear()
    },
    prisma: {
      creativeProject: {
        findFirst: vi.fn(async () => ({
          id: 'project-1',
          ownerId: 'owner-1',
          productCode: 'ALMA-101',
          productName: 'Premium Panjabi',
          productPriceBdt: 3_490,
          productSourceImage: 'products/alma-101.jpg',
          currentRecipe: {
            id: 'recipe-1',
            ownerId: 'owner-1',
            name: 'ALMA Premium',
            version: 3,
            lockedAt: now(),
            captionTone: 'premium',
            finishTheme: 'warm',
            musicVibe: 'premium',
            qcLevel: 'strict',
            spendCeilingBdt: 0,
          },
        })),
      },
      creativeProjectAsset: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async ({ where }: {
          where: { pendingActionId?: { in?: string[] } }
        }) => (where.pendingActionId?.in ?? [])
          .filter((id) => attachedActionIds.has(id))
          .map((pendingActionId) => ({ pendingActionId }))),
      },
      agentPendingAction: action,
    },
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: serviceHarness.prisma }))
vi.mock('@/lib/creative-studio/project-service', () => ({
  attachProjectAsset: serviceHarness.attachProjectAsset,
}))

import { createCampaignPack, getCampaignPack } from '@/lib/creative-studio/campaign-pack-service'

const manifest = buildCampaignPackManifest({
  projectId: 'project-1',
  product: {
    code: 'ALMA-101',
    name: 'Premium Panjabi',
    priceBdt: 3_490,
    sourceImage: 'products/alma-101.jpg',
  },
  recipe: {
    id: 'recipe-1',
    name: 'ALMA Premium',
    version: 3,
    lockedAt: '2026-07-25T00:00:00.000Z',
    captionTone: 'premium',
    finishTheme: 'warm',
    musicVibe: 'premium',
    qcLevel: 'strict',
    spendCeilingBdt: 125,
  },
  options: { includeFamily: true, includeReel: true },
})

describe('campaign-pack restart and retry planning', () => {
  it('creates one durable pack for repeated submits with the same idempotency key', async () => {
    serviceHarness.reset()
    const input = {
      intent: 'queue',
      projectId: 'project-1',
      idempotencyKey: 'request-12345678',
      options: { includeFamily: false, includeReel: false },
      confirmedCostUsd: 0,
    }

    const first = await createCampaignPack('owner-1', input)
    const replay = await createCampaignPack('owner-1', input)

    expect(first.pack.id).toBe(replay.pack.id)
    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    expect(serviceHarness.rows.filter((row) => row.type === 'campaign_pack')).toHaveLength(1)
    const stages = serviceHarness.rows.filter((row) => String(row.dedupeKey).startsWith('campaign-pack-stage:'))
    expect(stages).toHaveLength(2)
    expect(stages.every((row) => row.type === 'image_gen')).toBe(true)
    expect(stages.every((row) => row.status === 'campaign_approved')).toBe(true)
  })

  it('uses stable pack/stage idempotency keys', () => {
    expect(campaignPackDedupeKey('owner-1', 'request-1'))
      .toBe(campaignPackDedupeKey('owner-1', 'request-1'))
    expect(campaignStageDedupeKey('pack-1', 'reel-6s', 1))
      .toBe('campaign-pack-stage:pack-1:reel-6s:attempt:1')
  })

  it('repairs a completed stage asset once when reconciliation resumes', async () => {
    serviceHarness.reset()
    const created = await createCampaignPack('owner-1', {
      projectId: 'project-1',
      idempotencyKey: 'request-reconcile-1',
      options: { includeFamily: false, includeReel: false },
      confirmedCostUsd: 0,
    })
    const draft = serviceHarness.rows.find((row) =>
      String(row.dedupeKey).includes(':draft-a:attempt:1'))
    expect(draft).toBeTruthy()
    Object.assign(draft!, {
      status: 'executed',
      result: { storagePath: 'campaign-packs/pack/draft-a-attempt-1.jpg', costUsd: 0 },
    })

    await getCampaignPack('owner-1', created.pack.id)
    await getCampaignPack('owner-1', created.pack.id)

    expect(serviceHarness.attachProjectAsset).toHaveBeenCalledTimes(1)
    expect(serviceHarness.attachProjectAsset).toHaveBeenCalledWith(
      'owner-1',
      'project-1',
      expect.objectContaining({ pendingActionId: draft!.id }),
    )
  })

  it('restarts by creating only absent stages and never repeats completed paid stages', () => {
    const beforeSelection: CampaignPackStageSnapshot[] = [
      { stageId: 'draft-a', attempt: 1, status: 'executed' },
    ]
    expect(campaignStagesMissingForResume({
      manifest,
      snapshots: beforeSelection,
      selectedDraftStageId: null,
    }).map((stage) => stage.id)).toEqual(['draft-b'])

    const afterSelection: CampaignPackStageSnapshot[] = manifest.stages.map((stage) => ({
      stageId: stage.id,
      attempt: 1,
      status: 'executed',
    }))
    expect(campaignStagesMissingForResume({
      manifest,
      snapshots: afterSelection,
      selectedDraftStageId: 'draft-a',
    })).toEqual([])
  })

  it('makes one rejected stage addressable without invalidating siblings', () => {
    const snapshots: CampaignPackStageSnapshot[] = [
      { stageId: 'hero-4x5', attempt: 1, status: 'rejected' },
      { stageId: 'hero-4x5', attempt: 2, status: 'approved' },
      { stageId: 'post-1x1', attempt: 1, status: 'executed' },
      { stageId: 'reel-6s', attempt: 1, status: 'executed' },
    ]
    const latest = latestCampaignStageAttempts(snapshots)

    expect(latest.get('hero-4x5')).toMatchObject({ attempt: 2, status: 'approved' })
    expect(latest.get('post-1x1')).toMatchObject({ attempt: 1, status: 'executed' })
    expect(latest.get('reel-6s')).toMatchObject({ attempt: 1, status: 'executed' })
  })
})
