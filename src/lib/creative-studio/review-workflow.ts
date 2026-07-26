import { prisma } from '@/lib/prisma'
import {
  assertStudioBrandScope,
  assertStudioCapability,
  assertStudioSpendAllowed,
  requireStudioBrandAccess,
  studioRoleToDb,
  type StudioAccessRole,
  type StudioActor,
  type StudioBrandAccess,
} from '@/lib/creative-studio/studio-access'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type StudioReviewState = 'draft' | 'changes_requested' | 'revised' | 'approved'

export type StudioReviewComment = {
  id: string
  authorId: string
  authorName: string
  authorRole: StudioAccessRole
  body: string
  createdAt: string
}

export type StudioReviewEvent = {
  id: string
  sequence: number
  fromState: StudioReviewState | null
  toState: StudioReviewState
  actorId: string
  actorName: string
  actorRole: StudioAccessRole
  note: string | null
  approvedVersionId: string | null
  approvedCompositionId: string | null
  approvedCompositionVersionId: string | null
  approvedCompositionVersion: number | null
  approvedCompositionDocumentHash: string | null
  createdAt: string
}

export type StudioReviewThread = {
  assetId: string
  brandProfileId: string
  brandName: string
  projectId: string
  projectName: string
  assetTitle: string | null
  currentState: StudioReviewState
  currentSequence: number
  latestVersionId: string | null
  approvedVersionId: string | null
  approvedCompositionId: string | null
  approvedCompositionVersionId: string | null
  approvedCompositionVersion: number | null
  approvedCompositionDocumentHash: string | null
  approvalInvalidatedReason: string | null
  publishReady: boolean
  role: StudioAccessRole
  approvalSpendThresholdBdt: number
  capabilities: {
    comment: boolean
    requestChanges: boolean
    markRevised: boolean
    approve: boolean
  }
  comments: StudioReviewComment[]
  events: StudioReviewEvent[]
}

export class ReviewWorkflowError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 422, message = code) {
    super(message)
    this.name = 'ReviewWorkflowError'
    this.code = code
    this.status = status
  }
}

const DB_STATE: Record<StudioReviewState, 'DRAFT' | 'CHANGES_REQUESTED' | 'REVISED' | 'APPROVED'> = {
  draft: 'DRAFT',
  changes_requested: 'CHANGES_REQUESTED',
  revised: 'REVISED',
  approved: 'APPROVED',
}

function reviewState(value: unknown): StudioReviewState {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (
    normalized === 'draft'
    || normalized === 'changes_requested'
    || normalized === 'revised'
    || normalized === 'approved'
  ) return normalized
  throw new ReviewWorkflowError('invalid_review_state')
}

function role(value: unknown): StudioAccessRole {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'owner' || normalized === 'creator' || normalized === 'reviewer') {
    return normalized
  }
  throw new ReviewWorkflowError('invalid_review_role', 500)
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString()
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanNote(value: unknown, required = false): string | null {
  const note = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 2_000)
    : ''
  if (required && !note) throw new ReviewWorkflowError('review_note_required')
  return note || null
}

export function normalizeStudioReviewState(value: unknown): StudioReviewState {
  return reviewState(value)
}

export function assertStudioReviewTransition(
  current: StudioReviewState,
  target: StudioReviewState,
  actorRole: StudioAccessRole,
): void {
  if (current === target) throw new ReviewWorkflowError('review_state_unchanged')

  if (target === 'approved') {
    assertStudioCapability(actorRole, 'approve')
    if (current !== 'draft' && current !== 'revised') {
      throw new ReviewWorkflowError('invalid_review_transition')
    }
    return
  }
  if (target === 'changes_requested') {
    assertStudioCapability(actorRole, 'request_changes')
    if (current !== 'draft' && current !== 'revised') {
      throw new ReviewWorkflowError('invalid_review_transition')
    }
    return
  }
  if (target === 'revised') {
    assertStudioCapability(actorRole, 'revise')
    if (current !== 'changes_requested' && current !== 'approved') {
      throw new ReviewWorkflowError('invalid_review_transition')
    }
    return
  }
  throw new ReviewWorkflowError('invalid_review_transition')
}

const REVIEW_INCLUDE = {
  project: {
    include: { brandProfile: true },
  },
  versions: {
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    take: 1,
    select: { id: true, version: true, costBdt: true, createdAt: true },
  },
  reviewComments: {
    include: { author: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  reviewEvents: {
    include: { actor: { select: { id: true, name: true } } },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  },
}

async function loadReviewContext(
  actor: StudioActor,
  assetId: string,
  requestedBrandProfileId?: string | null,
): Promise<{
  row: Record<string, unknown>
  access: StudioBrandAccess
}> {
  const row = await db.creativeProjectAsset.findUnique({
    where: { id: assetId },
    include: REVIEW_INCLUDE,
  })
  if (!row) throw new ReviewWorkflowError('asset_not_found', 404)
  const project = object(row.project)
  const brandProfileId = typeof project.brandProfileId === 'string'
    ? project.brandProfileId
    : null
  assertStudioBrandScope(brandProfileId, requestedBrandProfileId)
  const access = await requireStudioBrandAccess(actor, brandProfileId!)
  return { row, access }
}

function serializeThread(
  row: Record<string, unknown>,
  access: StudioBrandAccess,
): StudioReviewThread {
  const project = object(row.project)
  const brand = object(project.brandProfile)
  const versions = Array.isArray(row.versions) ? row.versions : []
  const events = Array.isArray(row.reviewEvents) ? row.reviewEvents : []
  const comments = Array.isArray(row.reviewComments) ? row.reviewComments : []
  const latestVersion = versions[0] && typeof versions[0] === 'object'
    ? versions[0] as Record<string, unknown>
    : null
  const serializedEvents: StudioReviewEvent[] = events.map((entry) => {
    const event = object(entry)
    const actor = object(event.actor)
    const metadata = object(event.metadata)
    return {
      id: String(event.id),
      sequence: Number(event.sequence),
      fromState: event.fromState ? reviewState(event.fromState) : null,
      toState: reviewState(event.toState),
      actorId: String(event.actorId),
      actorName: String(actor.name ?? 'Studio user'),
      actorRole: role(event.actorRole),
      note: typeof event.note === 'string' ? event.note : null,
      approvedVersionId: typeof event.approvedArtifactVersionId === 'string'
        ? event.approvedArtifactVersionId
        : typeof metadata.approvedVersionId === 'string'
          ? metadata.approvedVersionId
          : null,
      approvedCompositionId: typeof event.compositionId === 'string'
        ? event.compositionId
        : typeof metadata.approvedCompositionId === 'string'
          ? metadata.approvedCompositionId
          : null,
      approvedCompositionVersionId: typeof event.compositionVersionId === 'string'
        ? event.compositionVersionId
        : typeof metadata.approvedCompositionVersionId === 'string'
          ? metadata.approvedCompositionVersionId
          : null,
      approvedCompositionVersion: Number.isInteger(event.compositionVersion)
        ? Number(event.compositionVersion)
        : Number.isInteger(metadata.approvedCompositionVersion)
          ? Number(metadata.approvedCompositionVersion)
          : null,
      approvedCompositionDocumentHash: typeof event.compositionDocumentHash === 'string'
        ? event.compositionDocumentHash
        : typeof metadata.approvedCompositionDocumentHash === 'string'
          ? metadata.approvedCompositionDocumentHash
          : null,
      createdAt: iso(event.createdAt),
    }
  })
  const approvalEvent = [...serializedEvents].reverse().find((event) => (
    event.toState === 'approved'
  ))
  const approvedVersionId = approvalEvent?.approvedVersionId ?? null
  const latestVersionId = latestVersion ? String(latestVersion.id) : null
  const currentState = reviewState(row.reviewState)
  const approvedCompositionId = approvalEvent?.approvedCompositionId ?? null
  const approvedCompositionVersionId = approvalEvent?.approvedCompositionVersionId ?? null
  const approvedCompositionVersion = approvalEvent?.approvedCompositionVersion ?? null
  const approvedCompositionDocumentHash = approvalEvent?.approvedCompositionDocumentHash ?? null

  return {
    assetId: String(row.id),
    brandProfileId: access.brandProfileId,
    brandName: String(brand.name ?? 'Brand'),
    projectId: String(project.id),
    projectName: String(project.name ?? 'Project'),
    assetTitle: typeof row.title === 'string' ? row.title : null,
    currentState,
    currentSequence: Number(row.reviewSequence ?? 0),
    latestVersionId,
    approvedVersionId,
    approvedCompositionId,
    approvedCompositionVersionId,
    approvedCompositionVersion,
    approvedCompositionDocumentHash,
    approvalInvalidatedReason: null,
    publishReady: currentState === 'approved'
      && Boolean(latestVersionId)
      && latestVersionId === approvedVersionId,
    role: access.role,
    approvalSpendThresholdBdt: access.approvalSpendThresholdBdt,
    capabilities: {
      comment: access.role === 'owner' || access.role === 'reviewer',
      requestChanges: access.role === 'owner' || access.role === 'reviewer',
      markRevised: access.role === 'owner' || access.role === 'creator',
      approve: access.role === 'owner',
    },
    comments: comments.map((entry) => {
      const comment = object(entry)
      const author = object(comment.author)
      return {
        id: String(comment.id),
        authorId: String(comment.authorId),
        authorName: String(author.name ?? 'Studio user'),
        authorRole: role(comment.authorRole),
        body: String(comment.body),
        createdAt: iso(comment.createdAt),
      }
    }),
    events: serializedEvents,
  }
}

export async function getStudioReviewThread(
  actor: StudioActor,
  assetId: string,
  brandProfileId?: string | null,
): Promise<StudioReviewThread> {
  const { row, access } = await loadReviewContext(actor, assetId, brandProfileId)
  const thread = serializeThread(row, access)
  if (!thread.approvedCompositionId && !thread.approvedCompositionVersionId) return thread
  if (!thread.approvedCompositionId || !thread.approvedCompositionVersionId) {
    return {
      ...thread,
      publishReady: false,
      approvalInvalidatedReason: 'approval_composition_pin_incomplete',
    }
  }
  const [composition, version] = await Promise.all([
    db.creativeComposition.findUnique({ where: { id: thread.approvedCompositionId } }),
    db.creativeCompositionVersion.findUnique({
      where: { id: thread.approvedCompositionVersionId },
    }),
  ])
  const currentVersionMatches = Boolean(
    composition
    && !composition.archivedAt
    && composition.projectId === thread.projectId
    && composition.brandProfileId === thread.brandProfileId
    && version
    && version.compositionId === composition.id
    && Number(version.version) === Number(composition.currentVersion)
    && Number(version.version) === thread.approvedCompositionVersion
    && version.documentHash === thread.approvedCompositionDocumentHash,
  )
  return currentVersionMatches
    ? thread
    : {
        ...thread,
        publishReady: false,
        approvalInvalidatedReason: 'approved_composition_version_stale',
      }
}

export async function addStudioReviewComment(
  actor: StudioActor,
  input: {
    assetId: string
    brandProfileId?: string | null
    body: unknown
  },
): Promise<StudioReviewThread> {
  const { row, access } = await loadReviewContext(actor, input.assetId, input.brandProfileId)
  assertStudioCapability(access.role, 'comment')
  const body = cleanNote(input.body, true)!
  await db.creativeAssetReviewComment.create({
    data: {
      assetId: String(row.id),
      brandProfileId: access.brandProfileId,
      authorId: actor.userId,
      authorRole: studioRoleToDb(access.role),
      body,
    },
  })
  return getStudioReviewThread(actor, input.assetId, access.brandProfileId)
}

export async function transitionStudioAssetReview(
  actor: StudioActor,
  input: {
    assetId: string
    brandProfileId?: string | null
    targetState: unknown
    note?: unknown
    expectedSequence?: unknown
    compositionId?: unknown
    compositionVersionId?: unknown
  },
): Promise<StudioReviewThread> {
  const { row, access } = await loadReviewContext(actor, input.assetId, input.brandProfileId)
  const current = reviewState(row.reviewState)
  const target = reviewState(input.targetState)
  assertStudioReviewTransition(current, target, access.role)
  const note = cleanNote(input.note, target === 'changes_requested')
  const currentSequence = Number(row.reviewSequence ?? 0)
  const expectedSequence = input.expectedSequence == null
    ? currentSequence
    : Number(input.expectedSequence)
  if (!Number.isInteger(expectedSequence) || expectedSequence !== currentSequence) {
    throw new ReviewWorkflowError('review_conflict', 409)
  }
  const versions = Array.isArray(row.versions) ? row.versions : []
  const latestVersion = versions[0] && typeof versions[0] === 'object'
    ? versions[0] as Record<string, unknown>
    : null
  if (target === 'approved' && !latestVersion?.id) {
    throw new ReviewWorkflowError('asset_version_required', 409)
  }
  const requestedCompositionId = typeof input.compositionId === 'string'
    ? input.compositionId.trim()
    : ''
  const requestedCompositionVersionId = typeof input.compositionVersionId === 'string'
    ? input.compositionVersionId.trim()
    : ''
  if (
    target === 'approved'
    && Boolean(requestedCompositionId) !== Boolean(requestedCompositionVersionId)
  ) throw new ReviewWorkflowError('composition_approval_pin_incomplete', 422)

  let approvedComposition: Record<string, unknown> | null = null
  let approvedCompositionVersion: Record<string, unknown> | null = null
  if (target === 'approved' && requestedCompositionId && requestedCompositionVersionId) {
    const [composition, compositionVersion] = await Promise.all([
      db.creativeComposition.findUnique({ where: { id: requestedCompositionId } }),
      db.creativeCompositionVersion.findUnique({
        where: { id: requestedCompositionVersionId },
      }),
    ])
    if (
      !composition
      || composition.archivedAt
      || composition.projectId !== object(row.project).id
      || composition.brandProfileId !== access.brandProfileId
    ) throw new ReviewWorkflowError('composition_scope_mismatch', 403)
    if (
      !compositionVersion
      || compositionVersion.compositionId !== composition.id
      || Number(compositionVersion.version) !== Number(composition.currentVersion)
    ) throw new ReviewWorkflowError('stale_composition_version', 409)
    const referencedNode = await db.creativeCompositionNode.findFirst({
      where: {
        compositionVersionId: compositionVersion.id,
        assetVersionId: String(latestVersion!.id),
      },
      select: { id: true },
    })
    if (!referencedNode) {
      throw new ReviewWorkflowError('composition_artifact_version_mismatch', 409)
    }
    approvedComposition = composition
    approvedCompositionVersion = compositionVersion
  }

  await db.$transaction(async (tx: typeof db) => {
    const updated = await tx.creativeProjectAsset.updateMany({
      where: {
        id: String(row.id),
        reviewState: DB_STATE[current],
        reviewSequence: currentSequence,
      },
      data: {
        reviewState: DB_STATE[target],
        reviewSequence: { increment: 1 },
      },
    })
    if (updated.count !== 1) throw new ReviewWorkflowError('review_conflict', 409)

    await tx.creativeAssetReviewEvent.create({
      data: {
        assetId: String(row.id),
        brandProfileId: access.brandProfileId,
        sequence: currentSequence + 1,
        fromState: DB_STATE[current],
        toState: DB_STATE[target],
        actorId: actor.userId,
        actorRole: studioRoleToDb(access.role),
        note,
        compositionId: approvedComposition ? String(approvedComposition.id) : null,
        compositionVersionId: approvedCompositionVersion
          ? String(approvedCompositionVersion.id)
          : null,
        compositionVersion: approvedCompositionVersion
          ? Number(approvedCompositionVersion.version)
          : null,
        compositionDocumentHash: approvedCompositionVersion
          ? String(approvedCompositionVersion.documentHash)
          : null,
        approvedArtifactVersionId: target === 'approved'
          ? String(latestVersion!.id)
          : null,
        metadata: target === 'approved'
          ? {
              approvedVersionId: String(latestVersion!.id),
              approvedVersion: Number(latestVersion!.version ?? 0),
              ...(approvedComposition && approvedCompositionVersion
                ? {
                    approvedCompositionId: String(approvedComposition.id),
                    approvedCompositionVersionId: String(approvedCompositionVersion.id),
                    approvedCompositionVersion: Number(approvedCompositionVersion.version),
                    approvedCompositionDocumentHash: String(approvedCompositionVersion.documentHash),
                  }
                : {}),
            }
          : {},
      },
    })
    if (target === 'changes_requested') {
      await tx.creativeAssetReviewComment.create({
        data: {
          assetId: String(row.id),
          brandProfileId: access.brandProfileId,
          authorId: actor.userId,
          authorRole: studioRoleToDb(access.role),
          body: note!,
        },
      })
    }
  })

  return getStudioReviewThread(actor, input.assetId, access.brandProfileId)
}

export async function authorizeStudioAssetSpend(
  actor: StudioActor,
  input: {
    assetId: string
    brandProfileId?: string | null
    estimatedCostBdt: unknown
  },
): Promise<{
  authorized: true
  role: StudioAccessRole
  estimatedCostBdt: number
  approvalSpendThresholdBdt: number
}> {
  const { access } = await loadReviewContext(actor, input.assetId, input.brandProfileId)
  const estimatedCostBdt = Number(input.estimatedCostBdt)
  if (!Number.isFinite(estimatedCostBdt) || estimatedCostBdt < 0) {
    throw new ReviewWorkflowError('invalid_spend_estimate')
  }
  assertStudioSpendAllowed(
    access.role,
    estimatedCostBdt,
    access.approvalSpendThresholdBdt,
  )
  return {
    authorized: true,
    role: access.role,
    estimatedCostBdt: Math.round(estimatedCostBdt),
    approvalSpendThresholdBdt: access.approvalSpendThresholdBdt,
  }
}

export function reviewWorkflowErrorResponse(error: unknown, _event: string): Response {
  if (error instanceof ReviewWorkflowError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  throw error
}
