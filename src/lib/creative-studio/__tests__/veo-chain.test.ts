/** Phase V4 — multi-clip Veo chain against a mocked DB (family-chain pattern). */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = {
  id: string
  dedupeKey?: string
  type: string
  payload: Record<string, unknown>
  status: string
}
const rows: Row[] = []
let n = 0
const recoveryState = vi.hoisted(() => ({
  gateCalls: 0,
  sceneCalls: 0,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: async ({
        where,
      }: {
        where: { dedupeKey: string }
      }) => rows.find((row) => row.dedupeKey === where.dedupeKey) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { dedupeKey: string }
        create: Omit<Row, 'id'>
      }) => {
        const existing = rows.find((row) => row.dedupeKey === where.dedupeKey)
        if (existing) return existing
        const row = { id: `act-${++n}`, ...create } as Row
        rows.push(row)
        return row
      },
    },
  },
}))
vi.mock('@/lib/creative-studio/studio-run-execution-gate', () => ({
  assertStudioRunExecutionGate: async () => {
    recoveryState.gateCalls += 1
  },
}))
vi.mock('@/lib/content-engine/video-brief', () => ({
  buildVideoBrief: () => ({ prompt: 'brief', aspect: '9:16', durationSec: 8 }),
  estimateReelCostUsd: (s: number) => s * 0.15,
}))
vi.mock('@/lib/tryon/scene-pool', () => ({
  pickScene: () => ({
    adultPose: 'p',
    childPose: 'c',
    scene: { prompt: `BD scene ${++recoveryState.sceneCalls}` },
  }),
}))

import {
  advanceVeoChain,
  multiReelCostUsd,
  startVeoReelChain as startVeoReelChainAuthorized,
} from '@/lib/creative-studio/veo-chain'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
} from '@/lib/creative-studio/studio-run-authorization'
import { withStudioRunExecutionContext } from '@/lib/creative-studio/studio-run-context'

function createVeoAuthorization() {
  const estimate = issueStudioRunEstimate({
    scope: {
      actorUserId: 'owner-1',
      ownerId: 'owner-1',
      role: 'owner',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'product-1',
      sourceAssetIds: ['asset-1'],
    },
    request: { mode: 'image_to_video' },
    selection: {
      mode: 'image_to_video',
      architecture: 'auto',
      provider: 'gemini',
      model: 'veo-3.1-generate-preview',
      providers: ['google'],
      models: ['veo-3.1-generate-preview'],
      plan: ['veo_reel'],
      paidAttemptLimit: 3,
    },
    estimateBdt: 500,
    requestedCapBdt: 500,
  })
  const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
    phase: 'execute',
  })
  return { claims, receipt: estimate.receipt }
}

const startVeoReelChain = (
  input: Parameters<typeof startVeoReelChainAuthorized>[0],
) => {
  const authorized = createVeoAuthorization()
  return withStudioRunExecutionContext({
    claims: authorized.claims,
    receipt: authorized.receipt,
    idempotencyKey: `veo-chain-test:${authorized.claims.receiptId}`,
  }, () => startVeoReelChainAuthorized(input))
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
  rows.length = 0
  n = 0
  recoveryState.gateCalls = 0
  recoveryState.sceneCalls = 0
})

describe('veo multi-clip chain', () => {
  it('walks clip1 → clip2 → concat with accumulated paths', async () => {
    const start = await startVeoReelChain({ productImagePath: 'p.jpg', totalClips: 2, aspect: '9:16' })
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('video_gen')
    expect(rows[0].payload.veoChain).toBe(true)
    expect(start.costUsd).toBe(multiReelCostUsd(2))

    const next = await advanceVeoChain(rows[0], 'generated/c1.mp4')
    expect(next).toBe(rows[1].id)
    expect(rows[1].type).toBe('video_gen')
    expect((rows[1].payload as { index: number }).index).toBe(1)

    const concat = await advanceVeoChain(rows[1], 'generated/c2.mp4')
    expect(concat).toBe(rows[2].id)
    expect(rows[2].type).toBe('video_edit')
    expect(rows[2].payload.veoConcat).toBe(true)
    expect(rows[2].payload.concatPaths).toEqual(['generated/c1.mp4', 'generated/c2.mp4'])
    expect(rows[2].payload.videoEdit).toBe(true)
  })

  it('ignores non-chain actions and missing storagePath', async () => {
    expect(await advanceVeoChain({ payload: {} }, 'x.mp4')).toBeNull()
    const start = await startVeoReelChain({ productImagePath: 'p.jpg', totalClips: 3, aspect: '16:9' })
    expect(start.costUsd).toBe(multiReelCostUsd(3))
    expect(await advanceVeoChain(rows[0], undefined)).toBeNull()
  })

  it('reuses the exact signed first-clip manifest after a crash despite a new scene pick', async () => {
    const authorized = createVeoAuthorization()
    const input = {
      productImagePath: 'p.jpg',
      totalClips: 2,
      aspect: '9:16' as const,
    }
    const run = () => withStudioRunExecutionContext({
      claims: authorized.claims,
      receipt: authorized.receipt,
      idempotencyKey: `veo-recovery:${authorized.claims.receiptId}`,
    }, () => startVeoReelChainAuthorized(input))

    const first = await run()
    const originalPrompt = rows[0].payload.prompt
    const recovered = await run()

    expect(recoveryState.sceneCalls).toBe(2)
    expect(recovered.pendingActionId).toBe(first.pendingActionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.prompt).toBe(originalPrompt)
    expect(recoveryState.gateCalls).toBe(1)
  })
})
