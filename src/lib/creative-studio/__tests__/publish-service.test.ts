import { beforeEach, describe, expect, it, vi } from 'vitest'

const publishHarness = vi.hoisted(() => {
  const state = {
    delivery: null as Record<string, unknown> | null,
    creates: 0,
  }
  const prisma = {
    creativeProjectAsset: {
      findUnique: vi.fn(async () => ({
        id: 'asset-1',
        reviewState: 'APPROVED',
        latestStoragePath: 'generated/approved.png',
        project: {
          id: 'project-1',
          brandProfileId: 'brand-alma',
        },
        versions: [{
          id: 'version-1',
          version: 1,
          storagePath: 'generated/approved.png',
          recipeId: 'recipe-1',
          jobId: 'action-1',
          metadata: { studioMode: 'campaign_pack' },
        }],
        reviewEvents: [{
          id: 'review-event-1',
          metadata: { approvedVersionId: 'version-1' },
        }],
      })),
    },
    agentPendingAction: {
      findUnique: vi.fn(async () => ({
        payload: {
          campaignPack: {
            packId: 'pack-1',
            stageId: 'hero-4x5',
          },
        },
      })),
    },
    agentKvSetting: {
      findUnique: vi.fn(async () => null),
    },
    creativePublishDelivery: {
      findUnique: vi.fn(async () => state.delivery),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.creates += 1
        state.delivery = {
          id: 'delivery-1',
          attempts: 0,
          receipt: {},
          createdAt: new Date('2026-07-25T00:00:00.000Z'),
          updatedAt: new Date('2026-07-25T00:00:00.000Z'),
          ...data,
        }
        return state.delivery
      }),
    },
  }
  return {
    prisma,
    state,
    reset() {
      state.delivery = null
      state.creates = 0
      vi.clearAllMocks()
    },
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: publishHarness.prisma }))
vi.mock('@/lib/creative-studio/studio-access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/creative-studio/studio-access')>(
    '@/lib/creative-studio/studio-access',
  )
  return {
    ...actual,
    requireStudioBrandAccess: vi.fn(async (actor: { userId: string }) => ({
      brandProfileId: 'brand-alma',
      ownerId: 'owner-1',
      role: actor.userId === 'owner-1' ? 'owner' : 'creator',
      approvalSpendThresholdBdt: 0,
    })),
  }
})

import {
  normalizePublishIdempotencyKey,
  normalizePublishPlatform,
  previewStudioPublish,
  publishRequestFingerprint,
  scheduleStudioPublish,
  studioPublishRetryDecision,
} from '@/lib/creative-studio/publish-service'

beforeEach(() => publishHarness.reset())

describe('CSE7 publish contract', () => {
  it('builds a stable fingerprint and rejects an unsafe idempotency key', () => {
    const input = {
      ownerId: 'owner-1',
      assetVersionId: 'version-7',
      platform: 'facebook' as const,
      pageRef: 'lifestyle',
      caption: 'অনুমোদিত ঈদ ক্যাম্পেইন',
      scheduledFor: '2026-07-25T12:00:00.000Z',
      adId: null,
    }
    expect(publishRequestFingerprint(input)).toBe(publishRequestFingerprint(input))
    expect(publishRequestFingerprint({ ...input, caption: `${input.caption}!` }))
      .not.toBe(publishRequestFingerprint(input))
    expect(normalizePublishIdempotencyKey('studio-publish:asset-1:request-1'))
      .toBe('studio-publish:asset-1:request-1')
    expect(() => normalizePublishIdempotencyKey('short')).toThrow('idempotency_key_required')
    expect(normalizePublishPlatform('Instagram')).toBe('instagram')
  })

  it('never auto-retries an ambiguous or unverified Meta side effect', () => {
    expect(studioPublishRetryDecision({
      ok: true,
      verified: true,
      postId: 'page_post',
      attempts: 1,
    })).toEqual({
      status: 'PUBLISHED',
      retryDelayMs: null,
      reason: 'verified_receipt',
    })
    expect(studioPublishRetryDecision({
      ok: true,
      verified: false,
      postId: 'page_post',
      attempts: 1,
    }).status).toBe('NEEDS_REVIEW')
    expect(studioPublishRetryDecision({
      ok: false,
      safeToRetry: false,
      attempts: 1,
    }).status).toBe('NEEDS_REVIEW')
  })

  it('retries only when the provider confirmed no effect, with a hard attempt cap', () => {
    expect(studioPublishRetryDecision({
      ok: false,
      safeToRetry: true,
      attempts: 1,
    })).toMatchObject({
      status: 'FAILED_RETRYABLE',
      retryDelayMs: 60_000,
    })
    expect(studioPublishRetryDecision({
      ok: false,
      safeToRetry: true,
      attempts: 3,
    }).status).toBe('NEEDS_REVIEW')
  })

  it('enforces owner/brand/approved-version scope and creates one delivery per key', async () => {
    const request = {
      assetId: 'asset-1',
      brandProfileId: 'brand-alma',
      platform: 'facebook',
      pageRef: 'lifestyle',
      caption: 'Approved caption',
      scheduledFor: '2026-07-25T12:00:00.000Z',
      idempotencyKey: 'studio-publish:asset-1:request-1',
      confirmedOwnerApproval: true,
    }
    await expect(previewStudioPublish({
      userId: 'creator-1',
      name: 'Creator',
      email: null,
      erpRole: 'STAFF',
    }, request)).rejects.toThrow('studio_publish_forbidden')
    await expect(previewStudioPublish({
      userId: 'owner-1',
      name: 'Owner',
      email: null,
      erpRole: 'SUPER_ADMIN',
    }, { ...request, brandProfileId: 'brand-trading' }))
      .rejects.toThrow('brand_scope_mismatch')

    const owner = {
      userId: 'owner-1',
      name: 'Owner',
      email: null,
      erpRole: 'SUPER_ADMIN',
    }
    const first = await scheduleStudioPublish(owner, request)
    const duplicate = await scheduleStudioPublish(owner, request)
    expect(first.idempotent).toBe(false)
    expect(duplicate.idempotent).toBe(true)
    expect(duplicate.delivery.id).toBe(first.delivery.id)
    expect(publishHarness.state.creates).toBe(1)
    expect(first.delivery.campaignPackId).toBe('pack-1')
    expect(first.delivery.assetVersionId).toBe('version-1')
  })
})
