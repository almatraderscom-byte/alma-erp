import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
  type StudioRunResolvedSelection,
  type StudioRunScope,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  studioRunAuthorizedJobFields,
  withStudioRunExecutionContext,
} from '@/lib/creative-studio/studio-run-context'

const scope: StudioRunScope = {
  actorUserId: 'user-1',
  ownerId: 'owner-1',
  role: 'owner',
  brandProfileId: 'brand-1',
  projectId: 'project-1',
  productId: null,
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
  paidAttemptLimit: 2,
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('Studio run crash recovery', () => {
  it('replays receipt/job indexes after a partial creation crash without duplicates', async () => {
    const estimate = issueStudioRunEstimate({
      scope,
      request: { mode: 'product_to_model' },
      selection,
      estimateBdt: 30,
      requestedCapBdt: 30,
      now: new Date('2026-07-26T06:00:00.000Z'),
    })
    const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
      phase: 'execute',
      now: new Date('2026-07-26T06:01:00.000Z'),
    })
    const persisted = new Map<string, string>()
    const construct = async (crashAfter: number | null) =>
      withStudioRunExecutionContext({
        claims,
        receipt: estimate.receipt,
        idempotencyKey: 'studio:partial-crash-recovery',
      }, async () => {
        const keys: string[] = []
        for (let index = 0; index < 3; index++) {
          const authorized = studioRunAuthorizedJobFields({
            provider: 'generic_image',
            prompt: `variant-${index}`,
          })
          persisted.set(authorized.dedupeKey, authorized.payload.studioRunAuthorization.jobFingerprint)
          keys.push(authorized.dedupeKey)
          if (crashAfter === index) throw new Error('simulated_process_crash')
        }
        return keys
      })

    await expect(construct(0)).rejects.toThrow('simulated_process_crash')
    const recovered = await construct(null)

    expect(recovered).toEqual([
      `studio-run:${claims.receiptId}:0`,
      `studio-run:${claims.receiptId}:1`,
      `studio-run:${claims.receiptId}:2`,
    ])
    expect(persisted.size).toBe(3)
  })
})
