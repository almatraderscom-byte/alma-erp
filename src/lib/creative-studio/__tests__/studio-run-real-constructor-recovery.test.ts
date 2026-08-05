import { beforeEach, describe, expect, it, vi } from 'vitest'

type PendingRow = {
  id: string
  dedupeKey: string
  type: 'image_gen' | 'video_gen'
  payload: Record<string, unknown>
  summary: string
  status: string
  createdAt: Date
}

const harness = vi.hoisted(() => {
  const pending = new Map<string, PendingRow>()
  const settings = new Map<string, {
    key: string
    value: string
    updatedAt: Date
  }>()
  return {
    pending,
    settings,
    nowMs: Date.parse('2026-07-26T10:00:00.000Z'),
    nextId: 0,
    gateCalls: 0,
    sceneCalls: 0,
  }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: async ({ where }: {
        where: { dedupeKey?: string; id?: string }
      }) => {
        if (where.dedupeKey) return harness.pending.get(where.dedupeKey) ?? null
        return [...harness.pending.values()].find((row) => row.id === where.id) ?? null
      },
      findMany: async ({ where }: {
        where: {
          id?: { in: string[] }
          dedupeKey?: { startsWith: string }
        }
      }) => [...harness.pending.values()].filter((row) =>
        where.id
          ? where.id.in.includes(row.id)
          : row.dedupeKey.startsWith(where.dedupeKey?.startsWith ?? '')),
      upsert: async ({ where, create }: {
        where: { dedupeKey: string }
        create: Omit<PendingRow, 'id' | 'createdAt'>
      }) => {
        const existing = harness.pending.get(where.dedupeKey)
        if (existing) return existing
        const row: PendingRow = {
          ...create,
          id: `real-job-${++harness.nextId}`,
          createdAt: new Date(harness.nowMs + harness.nextId),
        }
        harness.pending.set(where.dedupeKey, row)
        return row
      },
      update: async ({ where, data }: {
        where: { id: string }
        data: Partial<PendingRow>
      }) => {
        const entry = [...harness.pending.entries()]
          .find(([, row]) => row.id === where.id)
        if (!entry) throw new Error('missing_pending_action')
        const row = { ...entry[1], ...data }
        harness.pending.set(entry[0], row)
        return row
      },
    },
    agentKvSetting: {
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (harness.settings.has(data.key)) throw new Error('unique_violation')
        const row = {
          ...data,
          updatedAt: new Date(harness.nowMs),
        }
        harness.settings.set(data.key, row)
        return row
      },
      findUnique: async ({ where }: { where: { key: string } }) =>
        harness.settings.get(where.key) ?? null,
      update: async ({ where, data }: {
        where: { key: string }
        data: { value: string }
      }) => {
        const existing = harness.settings.get(where.key)
        if (!existing) throw new Error('missing_confirmation')
        const row = {
          ...existing,
          value: data.value,
          updatedAt: new Date(harness.nowMs),
        }
        harness.settings.set(where.key, row)
        return row
      },
    },
  },
}))

vi.mock('@/lib/creative-studio/studio-run-execution-gate', () => ({
  assertStudioRunExecutionGate: async () => {
    harness.gateCalls += 1
  },
}))

vi.mock('@/lib/fashn/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fashn/client')>()
  return { ...actual, isFashnConfigured: () => true }
})

vi.mock('@/lib/creative-studio/taste', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/creative-studio/taste')
  >()
  return {
    ...actual,
    readKv: async (key: string) => key === 'cs_xai_enabled' ? '1' : null,
    readSceneWeights: async () => ({}),
  }
})

vi.mock('@/lib/creative-studio/single-pipeline', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/creative-studio/single-pipeline')
  >()
  return {
    ...actual,
    checkSingleInputReadiness: async () => ({ ok: true, errors: [] }),
    readPipelineMode: async () => 'production',
    readRecentSceneIds: async () => [],
    recordSceneUse: async () => undefined,
  }
})

vi.mock('@/lib/tryon/art-director', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/tryon/art-director')
  >()
  return {
    ...actual,
    getOrClassifyGarment: async () => ({
      garmentType: 'panjabi',
      dominantColors: ['maroon'],
      fabricGuess: 'cotton',
      embroideryZones: [],
      hasContrastBottom: false,
      suggestedRole: 'father',
      notes: '',
    }),
  }
})

vi.mock('@/lib/tryon/scene-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tryon/scene-pool')>()
  const nextScene = () => {
    const call = ++harness.sceneCalls
    return {
      scene: {
        id: `scene-${call}`,
        label: `Scene ${call}`,
        prompt: `Bangladesh scene ${call}`,
      },
      adultPose: `pose-${call}`,
      childPose: 'child',
      pairPose: 'pair',
      groupPose: 'group',
    }
  }
  return {
    ...actual,
    pickScene: nextScene,
    pickSceneDiverse: nextScene,
    pickSceneWeighted: nextScene,
  }
})

import { runCreativeStudio } from '@/lib/creative-studio/create-run'
import { startVeoReelChain } from '@/lib/creative-studio/veo-chain'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
  type StudioRunFamilyModelPin,
  type StudioRunResolvedSelection,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  executeStudioRunConfirmation,
  STUDIO_RUN_CONFIRMATION_LEASE_MS,
} from '@/lib/creative-studio/studio-run-confirmation'
import {
  withStudioRunExecutionContext,
} from '@/lib/creative-studio/studio-run-context'

const FIXED_NOW = new Date('2026-07-26T10:00:00.000Z')

type ConstructorResult = {
  jobs: Array<{
    pendingActionId: string
    label: string
    type?: string
  }>
}

async function crashThenRecoverConstructor(input: {
  request: unknown
  selection: StudioRunResolvedSelection,
  familyModelPins?: StudioRunFamilyModelPin[]
  createResult: () => Promise<ConstructorResult>
}) {
  const estimate = issueStudioRunEstimate({
    scope: {
      actorUserId: 'owner-1',
      ownerId: 'owner-1',
      role: 'owner',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'product-1',
      sourceAssetIds: ['asset-1'],
      familyModelPins: input.familyModelPins,
    },
    request: input.request,
    selection: input.selection,
    estimateBdt: 200,
    requestedCapBdt: 200,
    now: FIXED_NOW,
  })
  const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
    phase: 'execute',
    now: FIXED_NOW,
  })
  const reservation = {
    receiptId: claims.receiptId,
    actorUserId: claims.scope.actorUserId,
    idempotencyKey: `real-constructor:${claims.receiptId}`,
    requestFingerprint: claims.requestFingerprint,
    selectionFingerprint: claims.selectionFingerprint,
    estimateBdt: claims.estimateBdt,
    maxCostBdt: claims.maxCostBdt,
  }
  let crash = true
  const createJobs = () => withStudioRunExecutionContext({
    claims,
    receipt: estimate.receipt,
    idempotencyKey: reservation.idempotencyKey,
  }, async () => {
    const result = await input.createResult()
    if (crash) {
      crash = false
      throw new Error('crash_after_real_constructor')
    }
    return result
  })

  await expect(executeStudioRunConfirmation({
    db: (await import('@/lib/prisma')).prisma,
    reservation,
    createJobs,
    now: FIXED_NOW,
  })).rejects.toThrow('crash_after_real_constructor')
  const original = [...harness.pending.values()][0]
  const originalPayload = structuredClone(original.payload)

  harness.nowMs = FIXED_NOW.getTime() + STUDIO_RUN_CONFIRMATION_LEASE_MS + 1
  const recovered = await executeStudioRunConfirmation({
    db: (await import('@/lib/prisma')).prisma,
    reservation,
    createJobs,
    now: new Date(harness.nowMs),
  })
  return { original, originalPayload, recovered }
}

async function crashThenRecover(
  request: Parameters<typeof runCreativeStudio>[0],
  selection: StudioRunResolvedSelection,
) {
  return crashThenRecoverConstructor({
    request,
    selection,
    createResult: () => runCreativeStudio(request),
  })
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
  process.env.XAI_API_KEY = 'test-xai-key'
  process.env.FASHN_API_KEY = 'test-fashn-key'
  harness.pending.clear()
  harness.settings.clear()
  harness.nowMs = FIXED_NOW.getTime()
  harness.nextId = 0
  harness.gateCalls = 0
  harness.sceneCalls = 0
})

describe('real paid-run constructor crash recovery', () => {
  it.each([
    {
      label: 'direct xAI',
      request: {
        mode: 'product_to_model' as const,
        provider: 'fashn' as const,
        vtonEngine: 'xai_imagine' as const,
        productImagePath: 'products/product-1.jpg',
        resolution: '2k' as const,
        aspectRatio: '3:4',
      },
      selection: {
        mode: 'product_to_model',
        architecture: 'advanced' as const,
        provider: 'xai',
        model: 'grok-imagine-image-quality',
        providers: ['xai'],
        models: ['grok-imagine-image-quality'],
        plan: ['1x_xai_image'],
        paidAttemptLimit: 3,
      },
    },
    {
      label: 'direct FASHN',
      request: {
        mode: 'product_to_model' as const,
        provider: 'fashn' as const,
        vtonEngine: 'fashn' as const,
        productImagePath: 'products/product-1.jpg',
        resolution: '2k' as const,
        aspectRatio: '4:5',
      },
      selection: {
        mode: 'product_to_model',
        architecture: 'advanced' as const,
        provider: 'fashn',
        model: 'product-to-model',
        providers: ['fashn'],
        models: ['product-to-model'],
        plan: ['1x_direct_fashn'],
        paidAttemptLimit: 3,
      },
    },
  ])('reuses the exact $label manifest after a stale creating lease', async ({
    request,
    selection,
  }) => {
    const result = await crashThenRecover(request, selection)

    expect(harness.sceneCalls).toBe(2)
    expect(harness.pending.size).toBe(1)
    expect(result.recovered.jobs.map((job) => ({
      pendingActionId: job.pendingActionId,
      type: job.type,
    }))).toEqual([{
      pendingActionId: result.original.id,
      type: 'image_gen',
    }])
    expect(result.original.payload).toEqual(result.originalPayload)
    expect(harness.gateCalls).toBe(1)
  })

  it('reuses the exact signed family manifest after a stale creating lease', async () => {
    const familyModelPins: StudioRunFamilyModelPin[] = [
      {
        role: 'father',
        modelId: 'model-father',
        modelImagePath: 'models/father-original.png',
        sourceImagePath: 'avatars/father-canonical.png',
        avatarSheetPath: 'avatars/father-sheet.png',
        modelName: 'Father',
      },
      {
        role: 'son',
        modelId: 'model-son',
        modelImagePath: 'models/son-original.png',
        sourceImagePath: 'avatars/son-canonical.png',
        avatarSheetPath: 'avatars/son-sheet.png',
        modelName: 'Son',
      },
    ]
    const familyRequest = {
      mode: 'product_to_model' as const,
      provider: 'fashn' as const,
      vtonEngine: 'fashn' as const,
      familyPreset: 'father_son' as const,
      productImagePath: 'products/product-1.jpg',
      aspectRatio: '4:5',
      resolution: '2k' as const,
      generationMode: 'quality' as const,
      pipelineMode: 'production' as const,
      pinnedChainVtonEngine: 'fashn' as const,
      pinnedGenericImageModel: 'gemini-3-pro-image' as const,
    }
    const result = await crashThenRecoverConstructor({
      request: familyRequest,
      selection: {
        mode: 'product_to_model',
        architecture: 'advanced',
        provider: 'fashn',
        model: 'tryon-max',
        providers: ['fashn', 'gemini'],
        models: ['tryon-max', 'gemini-3-pro-image'],
        plan: ['garment_prep', 'adult_vton', 'child_vton', 'pair_merge'],
        paidAttemptLimit: 3,
      },
      familyModelPins,
      createResult: () => runCreativeStudio(familyRequest),
    })

    expect(harness.sceneCalls).toBe(2)
    expect(harness.pending.size).toBe(1)
    expect(result.recovered.jobs.map((job) => ({
      pendingActionId: job.pendingActionId,
      type: job.type,
    }))).toEqual([{
      pendingActionId: result.original.id,
      type: 'image_gen',
    }])
    expect(result.original.payload).toEqual(result.originalPayload)
    expect(harness.gateCalls).toBe(1)
  })

  it('reuses the exact signed Veo manifest after a stale creating lease', async () => {
    const result = await crashThenRecoverConstructor({
      request: {
        mode: 'auto',
        includeReel: true,
        productImagePath: 'products/product-1.jpg',
      },
      selection: {
        mode: 'auto',
        architecture: 'auto',
        provider: 'gemini',
        model: 'veo-3.1-generate-preview',
        providers: ['gemini'],
        models: ['veo-3.1-generate-preview'],
        plan: ['2x_veo_clip'],
        paidAttemptLimit: 3,
      },
      createResult: async () => {
        const job = await startVeoReelChain({
          productImagePath: 'products/product-1.jpg',
          totalClips: 2,
          aspect: '9:16',
        })
        return {
          jobs: [{
            pendingActionId: job.pendingActionId,
            label: 'Veo reel',
            type: 'video_gen',
          }],
        }
      },
    })

    expect(harness.sceneCalls).toBe(2)
    expect(harness.pending.size).toBe(1)
    expect(result.recovered.jobs.map((job) => ({
      pendingActionId: job.pendingActionId,
      type: job.type,
    }))).toEqual([{
      pendingActionId: result.original.id,
      type: 'video_gen',
    }])
    expect(result.original.payload).toEqual(result.originalPayload)
    expect(harness.gateCalls).toBe(1)
  })
})
