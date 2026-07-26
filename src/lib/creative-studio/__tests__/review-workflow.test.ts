import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const workflowHarness = vi.hoisted(() => {
  type Role = 'CREATOR' | 'REVIEWER'
  type CommentRow = Record<string, unknown>
  type EventRow = Record<string, unknown>
  const state = {
    reviewState: 'DRAFT',
    reviewSequence: 0,
    comments: [] as CommentRow[],
    events: [] as EventRow[],
    compositionCurrentVersion: 1,
    compositionNodePresent: true,
    token: {
      sub: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      role: 'SUPER_ADMIN',
    },
    roles: new Map<string, Role>([
      ['creator-1', 'CREATOR'],
      ['reviewer-1', 'REVIEWER'],
    ]),
  }
  const users: Record<string, { id: string; name: string }> = {
    'owner-1': { id: 'owner-1', name: 'Owner' },
    'creator-1': { id: 'creator-1', name: 'Creator' },
    'reviewer-1': { id: 'reviewer-1', name: 'Reviewer' },
  }
  const prisma: Record<string, unknown> = {}

  const assetRow = () => ({
    id: 'asset-1',
    projectId: 'project-1',
    title: 'ঈদ পোস্ট',
    reviewState: state.reviewState,
    reviewSequence: state.reviewSequence,
    project: {
      id: 'project-1',
      name: 'ঈদ ক্যাম্পেইন',
      ownerId: 'owner-1',
      brandProfileId: 'brand-alma',
      brandProfile: {
        id: 'brand-alma',
        ownerId: 'owner-1',
        name: 'ALMA Lifestyle',
      },
    },
    versions: [{
      id: 'version-1',
      version: 1,
      costBdt: 0,
      createdAt: new Date('2026-07-25T00:00:00.000Z'),
    }],
    reviewComments: state.comments,
    reviewEvents: state.events,
  })

  Object.assign(prisma, {
    creativeProjectAsset: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'asset-1' ? assetRow() : null),
      updateMany: vi.fn(async ({ where, data }: {
        where: { id: string; reviewState: string; reviewSequence: number }
        data: { reviewState: string; reviewSequence: { increment: number } }
      }) => {
        if (
          where.id !== 'asset-1'
          || where.reviewState !== state.reviewState
          || where.reviewSequence !== state.reviewSequence
        ) return { count: 0 }
        state.reviewState = data.reviewState
        state.reviewSequence += data.reviewSequence.increment
        return { count: 1 }
      }),
    },
    creativeBrandProfile: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'brand-alma'
          ? { id: 'brand-alma', ownerId: 'owner-1', approvalSpendThresholdBdt: 100 }
          : null),
    },
    creativeStudioRoleAssignment: {
      findUnique: vi.fn(async ({ where }: {
        where: { brandProfileId_userId: { brandProfileId: string; userId: string } }
      }) => {
        const { brandProfileId, userId } = where.brandProfileId_userId
        const role = state.roles.get(userId)
        return brandProfileId === 'brand-alma' && role
          ? { ownerId: 'owner-1', role }
          : null
      }),
    },
    creativeAssetReviewComment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `comment-${state.comments.length + 1}`,
          createdAt: new Date(`2026-07-25T00:0${state.comments.length + 1}:00.000Z`),
          ...data,
          author: users[String(data.authorId)],
        }
        state.comments.push(row)
        return row
      }),
    },
    creativeAssetReviewEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `event-${state.events.length + 1}`,
          createdAt: new Date(`2026-07-25T00:1${state.events.length + 1}:00.000Z`),
          ...data,
          actor: users[String(data.actorId)],
        }
        state.events.push(row)
        return row
      }),
    },
    creativeComposition: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'composition-1'
          ? {
              id: 'composition-1',
              ownerId: 'owner-1',
              brandProfileId: 'brand-alma',
              projectId: 'project-1',
              currentVersion: state.compositionCurrentVersion,
              archivedAt: null,
            }
          : null),
    },
    creativeCompositionVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'composition-version-1'
          ? {
              id: 'composition-version-1',
              compositionId: 'composition-1',
              version: 1,
              documentHash: 'a'.repeat(64),
            }
          : null),
    },
    creativeCompositionNode: {
      findFirst: vi.fn(async () => state.compositionNodePresent ? { id: 'node-1' } : null),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma)),
  })

  return {
    prisma,
    state,
    reset() {
      state.reviewState = 'DRAFT'
      state.reviewSequence = 0
      state.comments.splice(0)
      state.events.splice(0)
      state.compositionCurrentVersion = 1
      state.compositionNodePresent = true
      state.token = {
        sub: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        role: 'SUPER_ADMIN',
      }
      for (const model of Object.values(prisma)) {
        if (!model || typeof model !== 'object') continue
        for (const method of Object.values(model)) {
          if (typeof method === 'function' && 'mockClear' in method) {
            ;(method as { mockClear: () => void }).mockClear()
          }
        }
      }
    },
    useActor(
      userId: 'owner-1' | 'creator-1' | 'reviewer-1',
      role: 'SUPER_ADMIN' | 'STAFF' = userId === 'owner-1' ? 'SUPER_ADMIN' : 'STAFF',
    ) {
      state.token = {
        sub: userId,
        name: users[userId].name,
        email: `${userId}@example.com`,
        role,
      }
    },
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: workflowHarness.prisma }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => workflowHarness.state.token),
}))

import { PATCH as changeState } from '@/app/api/assistant/creative-studio/assets/[id]/state/route'
import {
  GET as getReview,
  POST as postReview,
} from '@/app/api/assistant/creative-studio/reviews/route'

function stateRequest(body: Record<string, unknown>) {
  return new NextRequest('http://local/api/assistant/creative-studio/assets/asset-1/state', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function reviewRequest(body: Record<string, unknown>) {
  return new NextRequest('http://local/api/assistant/creative-studio/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  workflowHarness.reset()
})

describe('Creative review direct API enforcement', () => {
  it('rejects a cross-brand state change before writing an event', async () => {
    workflowHarness.useActor('reviewer-1')
    const response = await changeState(stateRequest({
      brandProfileId: 'brand-trading',
      targetState: 'changes_requested',
      expectedSequence: 0,
      note: 'রঙ ঠিক করুন',
    }), { params: { id: 'asset-1' } })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'brand_scope_mismatch' })
    expect(workflowHarness.state.events).toHaveLength(0)
  })

  it('rejects Creator approval and Creator review comments server-side', async () => {
    workflowHarness.useActor('creator-1')
    const approval = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'approved',
      expectedSequence: 0,
    }), { params: { id: 'asset-1' } })
    expect(approval.status).toBe(403)
    await expect(approval.json()).resolves.toMatchObject({ error: 'studio_approve_forbidden' })

    const comment = await postReview(reviewRequest({
      intent: 'comment',
      assetId: 'asset-1',
      brandProfileId: 'brand-alma',
      comment: 'আমি মন্তব্য করছি',
    }))
    expect(comment.status).toBe(403)
    await expect(comment.json()).resolves.toMatchObject({ error: 'studio_comment_forbidden' })
  })

  it('records Draft → changes requested → revised → approved as immutable ordered history', async () => {
    workflowHarness.useActor('reviewer-1')
    const requested = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'changes_requested',
      expectedSequence: 0,
      note: 'শিরোনামের রঙ আরও গাঢ় করুন',
    }), { params: { id: 'asset-1' } })
    expect(requested.status).toBe(200)

    workflowHarness.useActor('creator-1')
    const revised = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'revised',
      expectedSequence: 1,
      note: 'রঙ সংশোধন করা হয়েছে',
    }), { params: { id: 'asset-1' } })
    expect(revised.status).toBe(200)

    workflowHarness.useActor('owner-1')
    const approved = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'approved',
      expectedSequence: 2,
      note: 'প্রকাশের অনুমোদন',
    }), { params: { id: 'asset-1' } })
    expect(approved.status).toBe(200)
    await expect(approved.json()).resolves.toMatchObject({
      review: {
        currentState: 'approved',
        currentSequence: 3,
        latestVersionId: 'version-1',
        approvedVersionId: 'version-1',
        publishReady: true,
      },
    })

    expect(workflowHarness.state.events.map((event) => ({
      sequence: event.sequence,
      from: event.fromState,
      to: event.toState,
      actor: event.actorRole,
    }))).toEqual([
      { sequence: 1, from: 'DRAFT', to: 'CHANGES_REQUESTED', actor: 'REVIEWER' },
      { sequence: 2, from: 'CHANGES_REQUESTED', to: 'REVISED', actor: 'CREATOR' },
      { sequence: 3, from: 'REVISED', to: 'APPROVED', actor: 'OWNER' },
    ])
    expect(workflowHarness.state.comments).toHaveLength(1)
  })

  it('pins a V3 approval to the immutable composition and visibly invalidates it after an edit', async () => {
    workflowHarness.useActor('owner-1')
    const approved = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'approved',
      expectedSequence: 0,
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-1',
    }), { params: { id: 'asset-1' } })
    expect(approved.status).toBe(200)
    await expect(approved.json()).resolves.toMatchObject({
      review: {
        publishReady: true,
        approvedVersionId: 'version-1',
        approvedCompositionId: 'composition-1',
        approvedCompositionVersionId: 'composition-version-1',
        approvedCompositionVersion: 1,
        approvedCompositionDocumentHash: 'a'.repeat(64),
        approvalInvalidatedReason: null,
      },
    })

    workflowHarness.state.compositionCurrentVersion = 2
    const stale = await getReview(new NextRequest(
      'http://local/api/assistant/creative-studio/reviews?assetId=asset-1&brandProfileId=brand-alma',
    ))
    expect(stale.status).toBe(200)
    await expect(stale.json()).resolves.toMatchObject({
      review: {
        publishReady: false,
        approvalInvalidatedReason: 'approved_composition_version_stale',
      },
    })
  })

  it('rejects a composition approval when the exact artifact version is absent', async () => {
    workflowHarness.useActor('owner-1')
    workflowHarness.state.compositionNodePresent = false
    const response = await changeState(stateRequest({
      brandProfileId: 'brand-alma',
      targetState: 'approved',
      expectedSequence: 0,
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-1',
    }), { params: { id: 'asset-1' } })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'composition_artifact_version_mismatch',
    })
    expect(workflowHarness.state.events).toHaveLength(0)
  })

  it('lets Reviewer append comments without changing review state', async () => {
    workflowHarness.useActor('reviewer-1')
    const response = await postReview(reviewRequest({
      intent: 'comment',
      assetId: 'asset-1',
      brandProfileId: 'brand-alma',
      comment: 'লোগোর পাশে একটু বেশি ফাঁকা রাখুন',
    }))
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      review: {
        currentState: 'draft',
        comments: [{ body: 'লোগোর পাশে একটু বেশি ফাঁকা রাখুন', authorRole: 'reviewer' }],
      },
    })
    expect(workflowHarness.state.events).toHaveLength(0)
  })

  it('requires Owner above the brand spend threshold through the direct API', async () => {
    workflowHarness.useActor('creator-1')
    const overThreshold = await postReview(reviewRequest({
      intent: 'authorize_spend',
      assetId: 'asset-1',
      brandProfileId: 'brand-alma',
      estimatedCostBdt: 101,
    }))
    expect(overThreshold.status).toBe(403)
    await expect(overThreshold.json()).resolves.toMatchObject({
      error: 'owner_spend_approval_required',
    })

    const withinThreshold = await postReview(reviewRequest({
      intent: 'authorize_spend',
      assetId: 'asset-1',
      brandProfileId: 'brand-alma',
      estimatedCostBdt: 100,
    }))
    expect(withinThreshold.status).toBe(200)
    await expect(withinThreshold.json()).resolves.toMatchObject({
      authorized: true,
      role: 'creator',
      estimatedCostBdt: 100,
      approvalSpendThresholdBdt: 100,
    })
  })
})

describe('review ledger database guard', () => {
  it('prevents UPDATE and DELETE of comments and state events in the migration', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260724210000_creative_review_multibrand/migration.sql',
      ),
      'utf8',
    )
    expect(sql).toContain('creative_asset_review_comments_append_only')
    expect(sql).toContain('creative_asset_review_events_append_only')
    expect(sql.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(2)
    expect(sql).toContain("RAISE EXCEPTION 'creative review history is append-only'")
  })
})
