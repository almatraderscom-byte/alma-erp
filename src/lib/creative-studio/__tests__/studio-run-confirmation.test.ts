import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
  type StudioRunResolvedSelection,
  type StudioRunScope,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  executeStudioRunConfirmation,
  STUDIO_RUN_CONFIRMATION_LEASE_MS,
  type StudioQueuedJobRef,
} from '@/lib/creative-studio/studio-run-confirmation'
import {
  recoveredStudioRunJobId,
  studioRunAuthorizedJobFields,
  withStudioRunExecutionContext,
} from '@/lib/creative-studio/studio-run-context'

const scope: StudioRunScope = {
  actorUserId: 'owner-1',
  ownerId: 'owner-1',
  role: 'owner',
  brandProfileId: 'brand-1',
  projectId: 'project-1',
  productId: 'product-1',
  sourceAssetIds: ['asset-1'],
}

const selection: StudioRunResolvedSelection = {
  mode: 'product_to_model',
  architecture: 'advanced',
  provider: 'gemini',
  model: 'gemini-2.5-flash-image',
  providers: ['google'],
  models: ['gemini-2.5-flash-image'],
  plan: ['3x_guided_image'],
  paidAttemptLimit: 3,
}

type PendingRow = {
  id: string
  status: string
  dedupeKey: string
  payload: Record<string, unknown>
  summary: string
  type: 'image_gen'
  createdAt: Date
}

function createPrismaDouble(initialNow: Date) {
  let currentTime = initialNow.getTime()
  const settings = new Map<
    string,
    { key: string; value: string; updatedAt: Date }
  >()
  const pending = new Map<string, PendingRow>()
  let nextPendingId = 0

  const db = {
    agentKvSetting: {
      createMany: async ({
        data,
      }: {
        data: Array<{ key: string; value: string }>
        skipDuplicates: boolean
      }) => {
        const candidate = data[0]
        if (!candidate || settings.has(candidate.key)) return { count: 0 }
        const row = {
          ...candidate,
          updatedAt: new Date(currentTime),
        }
        settings.set(candidate.key, row)
        return { count: 1 }
      },
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.get(where.key) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { key: string }
        data: { value: string }
      }) => {
        const existing = settings.get(where.key)
        if (!existing) throw new Error('missing_confirmation')
        const row = {
          ...existing,
          value: data.value,
          updatedAt: new Date(currentTime),
        }
        settings.set(where.key, row)
        return row
      },
    },
    agentPendingAction: {
      findMany: async ({
        where,
      }: {
        where: {
          dedupeKey?: { startsWith: string }
          id?: { in: string[] }
        }
      }) => [...pending.values()]
        .filter((row) =>
          where.id
            ? where.id.in.includes(row.id)
            : row.dedupeKey.startsWith(where.dedupeKey?.startsWith ?? ''))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
      findUnique: async ({
        where,
      }: {
        where: { dedupeKey: string }
      }) => pending.get(where.dedupeKey) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { dedupeKey: string }
        create: Omit<PendingRow, 'id' | 'createdAt'>
        update: Record<string, never>
      }) => {
        const existing = pending.get(where.dedupeKey)
        if (existing) return existing
        const row: PendingRow = {
          ...create,
          id: `pending-${++nextPendingId}`,
          createdAt: new Date(currentTime + nextPendingId),
        }
        pending.set(where.dedupeKey, row)
        return row
      },
    },
  }

  return {
    db,
    pending,
    settings,
    setNow(now: Date) {
      currentTime = now.getTime()
    },
  }
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('Studio run durable confirmation recovery', () => {
  it('recovers a partial receipt exactly once after a stale lease', async () => {
    const firstNow = new Date('2026-07-26T06:00:00.000Z')
    const estimate = issueStudioRunEstimate({
      scope,
      request: { mode: 'product_to_model' },
      selection,
      estimateBdt: 90,
      requestedCapBdt: 90,
      now: firstNow,
    })
    const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
      phase: 'execute',
      now: new Date(firstNow.getTime() + 1_000),
    })
    const prisma = createPrismaDouble(firstNow)
    const reservation = {
      receiptId: claims.receiptId,
      actorUserId: claims.scope.actorUserId,
      idempotencyKey: 'studio:crash-recovery',
      requestFingerprint: claims.requestFingerprint,
      selectionFingerprint: claims.selectionFingerprint,
      estimateBdt: claims.estimateBdt,
      maxCostBdt: claims.maxCostBdt,
    }
    let constructorCalls = 0
    let authorizationCalls = 0
    let crashAfterFirstInsert = true

    const createJobs = () => withStudioRunExecutionContext({
      claims,
      receipt: estimate.receipt,
      idempotencyKey: reservation.idempotencyKey,
    }, async () => {
      constructorCalls += 1
      const jobs: StudioQueuedJobRef[] = []
      for (let index = 0; index < 3; index += 1) {
        const authorized = studioRunAuthorizedJobFields({
          provider: 'generic_image',
          prompt: `constructor-${constructorCalls}-variant-${index}`,
        })
        const existing = await prisma.db.agentPendingAction.findUnique({
          where: { dedupeKey: authorized.dedupeKey },
        })
        const recoveredId = recoveredStudioRunJobId({
          existing,
          dedupeKey: authorized.dedupeKey,
          payload: authorized.payload,
        })
        if (recoveredId) {
          jobs.push({
            pendingActionId: recoveredId,
            label: `Variant ${index + 1}`,
            type: 'image_gen',
          })
          continue
        }

        // This counter represents the authoritative execution gate. It must
        // run once per unique job, never once per HTTP retry.
        authorizationCalls += 1
        const row = await prisma.db.agentPendingAction.upsert({
          where: { dedupeKey: authorized.dedupeKey },
          create: {
            status: 'approved',
            dedupeKey: authorized.dedupeKey,
            payload: authorized.payload,
            summary: `Variant ${index + 1}`,
            type: 'image_gen',
          },
          update: {},
        })
        jobs.push({
          pendingActionId: row.id,
          label: row.summary,
          type: 'image_gen',
        })
        if (crashAfterFirstInsert) {
          crashAfterFirstInsert = false
          throw new Error('simulated_process_crash')
        }
      }
      return { jobs }
    })

    await expect(executeStudioRunConfirmation({
      db: prisma.db,
      reservation,
      createJobs,
      now: firstNow,
    })).rejects.toThrow('simulated_process_crash')
    expect(prisma.pending.size).toBe(1)
    expect(authorizationCalls).toBe(1)

    const retryNow = new Date(
      firstNow.getTime() + STUDIO_RUN_CONFIRMATION_LEASE_MS + 1,
    )
    prisma.setNow(retryNow)
    const recovered = await executeStudioRunConfirmation({
      db: prisma.db,
      reservation,
      createJobs,
      now: retryNow,
    })

    expect(recovered.idempotent).toBe(false)
    expect(recovered.jobs.map((job) => job.pendingActionId)).toEqual([
      'pending-1',
      'pending-2',
      'pending-3',
    ])
    expect(prisma.pending.size).toBe(3)
    expect(new Set(prisma.pending.keys()).size).toBe(3)
    expect(authorizationCalls).toBe(3)
    const confirmation = prisma.settings.get(
      `studio_run_confirmation:${claims.receiptId}`,
    )
    expect(JSON.parse(confirmation?.value ?? '{}')).toMatchObject({
      status: 'queued',
      jobIds: ['pending-1', 'pending-2', 'pending-3'],
    })
    prisma.pending.set(`studio-run:${claims.receiptId}:family:later`, {
      id: 'pending-chain-later',
      status: 'approved',
      dedupeKey: `studio-run:${claims.receiptId}:family:later`,
      payload: {},
      summary: 'Later family chain step',
      type: 'image_gen',
      createdAt: new Date(retryNow.getTime() + 1),
    })

    const replay = await executeStudioRunConfirmation({
      db: prisma.db,
      reservation,
      createJobs,
      now: new Date(retryNow.getTime() + 1),
    })
    expect(replay.idempotent).toBe(true)
    expect(replay.jobs.map((job) => job.pendingActionId)).toEqual([
      'pending-1',
      'pending-2',
      'pending-3',
    ])
    expect(constructorCalls).toBe(2)
    expect(authorizationCalls).toBe(3)
    expect(prisma.pending.size).toBe(4)
  })
})
