import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycleReviewHarness = vi.hoisted(() => ({
  actor: {
    userId: 'owner-1',
    name: 'Owner',
    email: null,
    erpRole: 'SUPER_ADMIN',
  },
  role: 'owner' as 'owner' | 'creator' | 'reviewer',
  requireAccess: vi.fn(),
  transition: vi.fn(),
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  authenticateStudioRequest: vi.fn(async () => lifecycleReviewHarness.actor),
  requireStudioBrandAccess: lifecycleReviewHarness.requireAccess,
  studioAccessErrorResponse: vi.fn(() =>
    Response.json({ error: 'access_error' }, { status: 403 })),
}))

vi.mock('@/lib/creative-studio/review-workflow', () => ({
  reviewWorkflowErrorResponse: vi.fn((error: unknown) => {
    throw error
  }),
  transitionStudioAssetReview: lifecycleReviewHarness.transition,
}))

import {
  transitionStudioLifecycleReview,
} from '@/lib/creative-studio/lifecycle-review-service'
import {
  PATCH as patchLifecycleReview,
} from '@/app/api/assistant/creative-studio/lifecycle/review/[id]/route'

const ownerCommand = {
  assetId: 'asset-1',
  brandProfileId: 'brand-1',
  targetState: 'approved',
  expectedSequence: 7,
  note: 'Exact pin approved',
  compositionId: 'composition-1',
  compositionVersionId: 'composition-version-4',
}

function request(body: Record<string, unknown>) {
  return new NextRequest(
    'http://local/api/assistant/creative-studio/lifecycle/review/asset-1',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

beforeEach(() => {
  lifecycleReviewHarness.role = 'owner'
  lifecycleReviewHarness.actor.userId = 'owner-1'
  lifecycleReviewHarness.actor.name = 'Owner'
  lifecycleReviewHarness.actor.email = null
  lifecycleReviewHarness.actor.erpRole = 'SUPER_ADMIN'
  lifecycleReviewHarness.requireAccess.mockReset().mockImplementation(
    async (actor: { userId: string }, brandProfileId: string) => ({
      ownerId: 'owner-1',
      brandProfileId,
      role: lifecycleReviewHarness.role,
      approvalSpendThresholdBdt: 0,
      actorId: actor.userId,
    }),
  )
  lifecycleReviewHarness.transition.mockReset().mockResolvedValue({
    assetId: 'asset-1',
    brandProfileId: 'brand-1',
    currentState: 'approved',
    currentSequence: 8,
    approvedCompositionId: 'composition-1',
    approvedCompositionVersionId: 'composition-version-4',
    publishReady: true,
    approvalInvalidatedReason: null,
  })
})

describe('V3 Lifecycle Review owner service boundary', () => {
  it.each(['creator', 'reviewer'] as const)(
    'rejects authenticated %s access before the canonical CSE6 transition',
    async (role) => {
      lifecycleReviewHarness.role = role
      await expect(transitionStudioLifecycleReview(
        {
          ...lifecycleReviewHarness.actor,
          userId: `${role}-1`,
          erpRole: 'STAFF',
        },
        ownerCommand,
      )).rejects.toMatchObject({
        code: 'lifecycle_owner_required',
        status: 403,
      })
      expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'missing sequence',
      command: { ...ownerCommand, expectedSequence: undefined },
      code: 'lifecycle_review_expected_sequence_required',
    },
    {
      name: 'negative sequence',
      command: { ...ownerCommand, expectedSequence: -1 },
      code: 'lifecycle_review_expected_sequence_invalid',
    },
    {
      name: 'fractional sequence',
      command: { ...ownerCommand, expectedSequence: 1.5 },
      code: 'lifecycle_review_expected_sequence_invalid',
    },
    {
      name: 'approval missing both pins',
      command: {
        ...ownerCommand,
        compositionId: undefined,
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_required',
    },
    {
      name: 'approval with a partial pin',
      command: {
        ...ownerCommand,
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_incomplete',
    },
    {
      name: 'non-approval transition with a partial pin',
      command: {
        ...ownerCommand,
        targetState: 'changes_requested',
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_incomplete',
    },
  ])('rejects $name before the canonical CSE6 transition', async ({
    command,
    code,
  }) => {
    await expect(transitionStudioLifecycleReview(
      lifecycleReviewHarness.actor,
      command,
    )).rejects.toMatchObject({ code, status: 422 })
    expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
  })

  it.each([
    ['array coercion', ['approved']],
    ['object coercion', { toString: () => 'approved' }],
    ['numeric coercion', 1],
    ['boolean coercion', true],
    ['null', null],
    ['whitespace', '   '],
    ['unknown string', 'published'],
  ])('rejects %s targetState before the canonical transition', async (
    _name,
    targetState,
  ) => {
    await expect(transitionStudioLifecycleReview(
      lifecycleReviewHarness.actor,
      { ...ownerCommand, targetState },
    )).rejects.toMatchObject({
      code: 'lifecycle_review_target_state_invalid',
      status: 422,
    })
    expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
  })

  it('omits complete pins from a non-approval transition instead of fabricating lineage', async () => {
    await transitionStudioLifecycleReview(
      lifecycleReviewHarness.actor,
      {
        ...ownerCommand,
        targetState: 'changes_requested',
      },
    )
    expect(lifecycleReviewHarness.transition).toHaveBeenCalledWith(
      lifecycleReviewHarness.actor,
      {
        assetId: 'asset-1',
        brandProfileId: 'brand-1',
        targetState: 'changes_requested',
        expectedSequence: 7,
        note: 'Exact pin approved',
      },
    )
  })

  it('delegates the exact Owner sequence and immutable pin to the durable CSE6 workflow', async () => {
    await expect(transitionStudioLifecycleReview(
      lifecycleReviewHarness.actor,
      {
        ...ownerCommand,
        actorRole: 'reviewer',
      },
    )).resolves.toMatchObject({
      currentState: 'approved',
      currentSequence: 8,
      publishReady: true,
    })
    expect(lifecycleReviewHarness.requireAccess).toHaveBeenCalledWith(
      lifecycleReviewHarness.actor,
      'brand-1',
    )
    expect(lifecycleReviewHarness.transition).toHaveBeenCalledWith(
      lifecycleReviewHarness.actor,
      ownerCommand,
    )
    expect(lifecycleReviewHarness.transition.mock.calls[0][1])
      .not.toHaveProperty('actorRole')
  })
})

describe('V3 Lifecycle Review authenticated route', () => {
  it.each(['creator', 'reviewer'] as const)(
    'returns 403 for authenticated %s before the canonical transition',
    async (role) => {
      lifecycleReviewHarness.role = role
      lifecycleReviewHarness.actor.userId = `${role}-1`
      lifecycleReviewHarness.actor.erpRole = 'STAFF'
      const response = await patchLifecycleReview(
        request(ownerCommand),
        { params: { id: 'asset-1' } },
      )
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: 'lifecycle_owner_required',
      })
      expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
    },
  )

  it('ignores a forged owner role in the request body and re-derives Creator access', async () => {
    lifecycleReviewHarness.role = 'creator'
    lifecycleReviewHarness.actor.userId = 'creator-1'
    lifecycleReviewHarness.actor.erpRole = 'STAFF'
    const response = await patchLifecycleReview(
      request({ ...ownerCommand, actorRole: 'owner' }),
      { params: { id: 'asset-1' } },
    )
    expect(response.status).toBe(403)
    expect(lifecycleReviewHarness.requireAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'creator-1' }),
      'brand-1',
    )
    expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'missing sequence',
      command: { ...ownerCommand, expectedSequence: undefined },
      code: 'lifecycle_review_expected_sequence_required',
    },
    {
      name: 'approval missing both pins',
      command: {
        ...ownerCommand,
        compositionId: undefined,
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_required',
    },
    {
      name: 'approval with a partial pin',
      command: {
        ...ownerCommand,
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_incomplete',
    },
    {
      name: 'non-approval transition with a partial pin',
      command: {
        ...ownerCommand,
        targetState: 'changes_requested',
        compositionVersionId: undefined,
      },
      code: 'lifecycle_review_composition_pin_incomplete',
    },
  ])('returns 422 for Owner $name before delegation', async ({
    command,
    code,
  }) => {
    const response = await patchLifecycleReview(
      request(command),
      { params: { id: 'asset-1' } },
    )
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: code })
    expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
  })

  it.each([
    ['array coercion', ['approved']],
    ['object coercion', { toString: 'approved' }],
    ['numeric coercion', 1],
    ['boolean coercion', true],
    ['null', null],
    ['whitespace', '   '],
    ['unknown string', 'published'],
  ])('returns 422 for Owner %s targetState', async (
    _name,
    targetState,
  ) => {
    const response = await patchLifecycleReview(
      request({ ...ownerCommand, targetState }),
      { params: { id: 'asset-1' } },
    )
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: 'lifecycle_review_target_state_invalid',
    })
    expect(lifecycleReviewHarness.transition).not.toHaveBeenCalled()
  })

  it('allows authenticated Owner delegation without serializing caller role authority', async () => {
    const response = await patchLifecycleReview(
      request({ ...ownerCommand, actorRole: 'reviewer' }),
      { params: { id: 'asset-1' } },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      review: {
        currentState: 'approved',
        currentSequence: 8,
        approvedCompositionId: 'composition-1',
        approvedCompositionVersionId: 'composition-version-4',
      },
    })
    expect(lifecycleReviewHarness.transition).toHaveBeenCalledWith(
      lifecycleReviewHarness.actor,
      ownerCommand,
    )
    expect(lifecycleReviewHarness.transition.mock.calls[0][1])
      .not.toHaveProperty('actorRole')
  })
})
