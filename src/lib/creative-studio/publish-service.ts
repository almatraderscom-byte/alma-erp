import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import {
  requireStudioBrandAccess,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  lifecycleFingerprint,
  normalizeLifecycleScheduleAt,
} from '@/lib/creative-studio/lifecycle-contract'
import {
  evaluateStudioLifecycleRollout,
  type StudioLifecycleFlagScope,
} from '@/lib/creative-studio/lifecycle-rollout'

// Prisma Client is generated during build after the phase migration exists.
// Keeping this structural mirrors the earlier CSE services and lets the pure
// contract tests run before `prisma generate`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type AnyRecord = Record<string, unknown>

export type StudioPublishPlatform = 'facebook' | 'instagram'
export type StudioPublishStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed_retryable'
  | 'needs_review'
  | 'canceled'

export type StudioPublishPreview = {
  dryRun: true
  idempotencyKey: string
  requestFingerprint: string
  platform: StudioPublishPlatform
  pageRef: string
  caption: string
  scheduledFor: string
  assetId: string
  assetVersionId: string
  approvedReviewEventId: string
  projectId: string
  brandProfileId: string
  campaignPackId: string | null
  compositionId: string | null
  compositionVersionId: string | null
  compositionVersion: number | null
  compositionDocumentHash: string | null
  operationBatchId: string | null
  reviewFingerprint: string | null
  renderFingerprint: string | null
  sceneKey: string
  mediaStoragePath: string
  estimatedCostUsd: 0
  publishingEnabled: boolean
  receipt: {
    mode: 'dry_run'
    externalEffect: false
    approvedVersionPinned: true
    duplicateProtection: 'owner_id+idempotency_key'
  }
}

export type StudioPublishDeliveryView = {
  id: string
  ownerId: string
  brandProfileId: string
  projectId: string
  assetId: string
  assetVersionId: string
  campaignPackId: string | null
  compositionId: string | null
  compositionVersionId: string | null
  compositionVersion: number | null
  compositionDocumentHash: string | null
  operationBatchId: string | null
  reviewFingerprint: string | null
  renderFingerprint: string | null
  sceneKey: string
  platform: StudioPublishPlatform
  pageRef: string
  caption: string
  adId: string | null
  idempotencyKey: string
  status: StudioPublishStatus
  scheduledFor: string
  attempts: number
  externalPostId: string | null
  permalinkUrl: string | null
  verifiedAt: string | null
  publishedAt: string | null
  receipt: AnyRecord
  lastErrorCode: string | null
  lastErrorMessage: string | null
  metricsLastSyncedAt: string | null
  metricsLastError: string | null
  costUsd: number
  createdAt: string
  updatedAt: string
}

export type StudioPublisher = (entry: {
  id: string
  platform: StudioPublishPlatform
  pageRef: string
  caption: string
  imageRef: string
}) => Promise<{
  ok: boolean
  postId?: string
  permalinkUrl?: string
  verified?: boolean
  error?: string
  errorCode?: string
  safeToRetry?: boolean
  providerReceipt?: AnyRecord
}>

export class StudioPublishError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: AnyRecord

  constructor(code: string, status = 422, details?: AnyRecord) {
    super(code)
    this.name = 'StudioPublishError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function record(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString()
}

function nullableIso(value: unknown): string | null {
  return value ? iso(value) : null
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/\r\n/g, '\n').slice(0, max)
    : ''
}

export function normalizePublishPlatform(value: unknown): StudioPublishPlatform {
  const platform = String(value ?? '').trim().toLowerCase()
  if (platform === 'facebook' || platform === 'instagram') return platform
  throw new StudioPublishError('invalid_publish_platform')
}

export function normalizePublishIdempotencyKey(value: unknown): string {
  const key = cleanText(value, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(key)) {
    throw new StudioPublishError('idempotency_key_required')
  }
  return key
}

function normalizePageRef(value: unknown): string {
  const pageRef = cleanText(value, 80).toLowerCase()
  if (pageRef === 'lifestyle' || pageRef === 'onlineshop') return pageRef
  throw new StudioPublishError('invalid_meta_page')
}

function normalizeCaption(value: unknown, platform: StudioPublishPlatform): string {
  const max = platform === 'instagram' ? 2_200 : 10_000
  const caption = cleanText(value, max)
  if (!caption) throw new StudioPublishError('publish_caption_required')
  return caption
}

function normalizeAdId(value: unknown): string | null {
  const adId = cleanText(value, 128)
  if (!adId) return null
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(adId)) throw new StudioPublishError('invalid_meta_ad_id')
  return adId
}

async function requireCompositionPublishCapability(input: {
  ownerId: string
  brandProfileId: string
  projectId: string
  intent: unknown
}): Promise<void> {
  const capability: StudioLifecycleFlagScope['capability'] = input.intent === 'publish_now'
    ? 'live_publish'
    : input.intent === 'schedule'
      ? 'schedule'
      : 'dry_run'
  const rows = await db.creativeLifecycleFeatureFlag.findMany({
    where: {
      ownerId: input.ownerId,
      capability,
      OR: [{ brandProfileId: null }, { brandProfileId: input.brandProfileId }],
    },
  })
  const decision = evaluateStudioLifecycleRollout({
    scope: {
      ownerId: input.ownerId,
      brandProfileId: input.brandProfileId,
      projectId: input.projectId,
      role: 'owner',
      capability,
    },
    flags: rows.map((row: AnyRecord) => ({
      id: String(row.id),
      scope: {
        ownerId: String(row.ownerId),
        ...(typeof row.brandProfileId === 'string' ? { brandProfileId: row.brandProfileId } : {}),
        ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
        ...(row.role ? { role: String(row.role).toLowerCase() as 'owner' } : {}),
        capability: String(row.capability) as StudioLifecycleFlagScope['capability'],
      },
      enabled: row.enabled === true,
      dualReadEnabled: row.dualReadEnabled === true,
      legacyFallbackEnabled: row.legacyFallbackEnabled !== false,
      canaryPercent: Number(row.canaryPercent ?? 0),
      canarySalt: typeof row.canarySalt === 'string' ? row.canarySalt : undefined,
    })),
  })
  if (!decision.enabled) {
    throw new StudioPublishError('v3_publish_capability_disabled', 409, {
      capability,
      legacyFallbackAvailable: decision.legacyFallbackAvailable,
      fallbackExecution: decision.fallbackExecution,
    })
  }
  if (
    capability === 'live_publish'
    && process.env.CREATIVE_STUDIO_V3_LIVE_PUBLISH_ENABLED !== 'true'
  ) throw new StudioPublishError('v3_live_publish_disabled', 409)
}

export function normalizeScheduledFor(value: unknown, now = new Date()): Date {
  const parsed = value ? new Date(String(value)) : now
  if (!Number.isFinite(parsed.getTime())) throw new StudioPublishError('invalid_publish_schedule')
  const oneYear = now.getTime() + 366 * 24 * 60 * 60 * 1_000
  if (parsed.getTime() > oneYear) throw new StudioPublishError('publish_schedule_too_far')
  return parsed.getTime() < now.getTime() ? now : parsed
}

export function publishRequestFingerprint(input: {
  ownerId: string
  assetVersionId: string
  platform: StudioPublishPlatform
  pageRef: string
  caption: string
  scheduledFor: Date | string
  adId?: string | null
  compositionId?: string | null
  compositionVersionId?: string | null
  compositionVersion?: number | null
  compositionDocumentHash?: string | null
  operationBatchId?: string | null
  reviewFingerprint?: string | null
  renderFingerprint?: string | null
}): string {
  const canonical = JSON.stringify({
    ownerId: input.ownerId,
    assetVersionId: input.assetVersionId,
    platform: input.platform,
    pageRef: input.pageRef,
    caption: input.caption,
    scheduledFor: iso(input.scheduledFor),
    adId: input.adId ?? null,
    compositionId: input.compositionId ?? null,
    compositionVersionId: input.compositionVersionId ?? null,
    compositionVersion: input.compositionVersion ?? null,
    compositionDocumentHash: input.compositionDocumentHash ?? null,
    operationBatchId: input.operationBatchId ?? null,
    reviewFingerprint: input.reviewFingerprint ?? null,
    renderFingerprint: input.renderFingerprint ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function studioPublishRetryDecision(input: {
  ok: boolean
  verified?: boolean
  postId?: string | null
  safeToRetry?: boolean
  attempts: number
}): {
  status: 'PUBLISHED' | 'FAILED_RETRYABLE' | 'NEEDS_REVIEW'
  retryDelayMs: number | null
  reason: string
} {
  if (input.ok && input.postId && input.verified === true) {
    return { status: 'PUBLISHED', retryDelayMs: null, reason: 'verified_receipt' }
  }
  if (input.ok || input.postId) {
    return { status: 'NEEDS_REVIEW', retryDelayMs: null, reason: 'published_but_unverified' }
  }
  if (input.safeToRetry === true && input.attempts < 3) {
    return {
      status: 'FAILED_RETRYABLE',
      retryDelayMs: 2 ** Math.max(0, input.attempts - 1) * 60_000,
      reason: 'provider_confirmed_no_effect',
    }
  }
  return { status: 'NEEDS_REVIEW', retryDelayMs: null, reason: 'ambiguous_no_auto_retry' }
}

const PUBLISHING_KEY_PREFIX = 'studio_meta_publish_enabled:'

export async function isStudioMetaPublishingEnabled(ownerId: string): Promise<boolean> {
  const row = await db.agentKvSetting.findUnique({
    where: { key: `${PUBLISHING_KEY_PREFIX}${ownerId}` },
    select: { value: true },
  })
  return row?.value === 'true'
}

export async function setStudioMetaPublishingEnabled(
  actor: StudioActor,
  brandProfileId: string,
  enabled: boolean,
): Promise<{ publishingEnabled: boolean }> {
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  if (access.role !== 'owner') throw new StudioPublishError('studio_publish_forbidden', 403)
  await db.agentKvSetting.upsert({
    where: { key: `${PUBLISHING_KEY_PREFIX}${access.ownerId}` },
    create: {
      key: `${PUBLISHING_KEY_PREFIX}${access.ownerId}`,
      value: enabled ? 'true' : 'false',
    },
    update: { value: enabled ? 'true' : 'false' },
  })
  return { publishingEnabled: enabled }
}

async function loadApprovedPublishContext(
  actor: StudioActor,
  input: AnyRecord,
): Promise<{
  ownerId: string
  brandProfileId: string
  projectId: string
  assetId: string
  assetVersionId: string
  recipeId: string | null
  campaignPackId: string | null
  compositionId: string | null
  compositionVersionId: string | null
  compositionVersion: number | null
  compositionDocumentHash: string | null
  operationBatchId: string | null
  reviewFingerprint: string | null
  renderFingerprint: string | null
  sceneKey: string
  approvedReviewEventId: string
  mediaStoragePath: string
}> {
  const assetId = cleanText(input.assetId, 128)
  if (!assetId) throw new StudioPublishError('asset_id_required')
  const asset = await db.creativeProjectAsset.findUnique({
    where: { id: assetId },
    include: {
      project: true,
      versions: {
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
      reviewEvents: {
        where: { toState: 'APPROVED' },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
    },
  })
  if (!asset) throw new StudioPublishError('asset_not_found', 404)
  const project = record(asset.project)
  const brandProfileId = typeof project.brandProfileId === 'string'
    ? project.brandProfileId
    : ''
  if (!brandProfileId) throw new StudioPublishError('asset_brand_missing', 409)
  const requestedBrandProfileId = cleanText(input.brandProfileId, 128)
  if (requestedBrandProfileId && requestedBrandProfileId !== brandProfileId) {
    throw new StudioPublishError('brand_scope_mismatch', 403)
  }
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  if (access.role !== 'owner') throw new StudioPublishError('studio_publish_forbidden', 403)
  if (project.ownerId !== access.ownerId) {
    throw new StudioPublishError('project_scope_mismatch', 403)
  }

  const versions = Array.isArray(asset.versions) ? asset.versions : []
  const latestVersion = versions[0] ? record(versions[0]) : null
  const events = Array.isArray(asset.reviewEvents) ? asset.reviewEvents : []
  const approvalEvent = events[0] ? record(events[0]) : null
  const approvalMetadata = record(approvalEvent?.metadata)
  if (
    String(asset.reviewState) !== 'APPROVED'
    || !latestVersion?.id
    || !approvalEvent?.id
    || approvalMetadata.approvedVersionId !== latestVersion.id
  ) {
    throw new StudioPublishError('approved_version_required', 409)
  }
  let mediaStoragePath = cleanText(latestVersion.storagePath ?? asset.latestStoragePath, 2_000)
  if (!mediaStoragePath) throw new StudioPublishError('publish_media_required', 409)

  const action = latestVersion.jobId
    ? await db.agentPendingAction.findUnique({
        where: { id: String(latestVersion.jobId) },
        select: { payload: true },
      })
    : null
  const actionPayload = record(action?.payload)
  const campaign = record(actionPayload.campaignPack)
  const campaignPackId = typeof campaign.packId === 'string' ? campaign.packId : null
  const sceneKey = cleanText(
    campaign.stageId ?? record(latestVersion.metadata).studioMode ?? 'unclassified',
    80,
  ) || 'unclassified'

  const requestedCompositionId = cleanText(input.compositionId, 128)
  const requestedCompositionVersionId = cleanText(input.compositionVersionId, 128)
  if (Boolean(requestedCompositionId) !== Boolean(requestedCompositionVersionId)) {
    throw new StudioPublishError('composition_publish_pin_incomplete')
  }
  let compositionId: string | null = null
  let compositionVersionId: string | null = null
  let compositionVersion: number | null = null
  let compositionDocumentHash: string | null = null
  let operationBatchId: string | null = null
  let reviewFingerprint: string | null = null
  let renderFingerprint: string | null = null
  if (requestedCompositionId && requestedCompositionVersionId) {
    const [composition, version] = await Promise.all([
      db.creativeComposition.findUnique({ where: { id: requestedCompositionId } }),
      db.creativeCompositionVersion.findUnique({
        where: { id: requestedCompositionVersionId },
      }),
    ])
    if (
      !composition
      || composition.archivedAt
      || composition.ownerId !== access.ownerId
      || composition.brandProfileId !== brandProfileId
      || composition.projectId !== project.id
    ) throw new StudioPublishError('composition_scope_mismatch', 403)
    if (
      !version
      || version.compositionId !== composition.id
      || Number(version.version) !== Number(composition.currentVersion)
    ) throw new StudioPublishError('stale_composition_version', 409)
    await requireCompositionPublishCapability({
      ownerId: access.ownerId,
      brandProfileId,
      projectId: String(project.id),
      intent: input.intent,
    })
    if (
      approvalEvent.compositionId !== composition.id
      || approvalEvent.compositionVersionId !== version.id
      || Number(approvalEvent.compositionVersion) !== Number(version.version)
      || approvalEvent.compositionDocumentHash !== version.documentHash
      || approvalEvent.approvedArtifactVersionId !== latestVersion.id
    ) throw new StudioPublishError('approved_composition_version_required', 409)
    const requestedApprovedArtifactVersionId = cleanText(input.approvedArtifactVersionId, 128)
    if (
      requestedApprovedArtifactVersionId
      && requestedApprovedArtifactVersionId !== latestVersion.id
    ) throw new StudioPublishError('approved_artifact_version_mismatch', 409)
    const requestedReviewEventId = cleanText(input.approvedReviewEventId, 128)
    if (requestedReviewEventId && requestedReviewEventId !== approvalEvent.id) {
      throw new StudioPublishError('approved_review_event_mismatch', 409)
    }
    compositionId = String(composition.id)
    compositionVersionId = String(version.id)
    compositionVersion = Number(version.version)
    compositionDocumentHash = String(version.documentHash)
    reviewFingerprint = lifecycleFingerprint({
      reviewEventId: approvalEvent.id,
      assetVersionId: latestVersion.id,
      compositionId,
      compositionVersionId,
      compositionVersion,
      compositionDocumentHash,
    })
    const requestedReviewFingerprint = cleanText(input.reviewFingerprint, 128)
    if (requestedReviewFingerprint && requestedReviewFingerprint !== reviewFingerprint) {
      throw new StudioPublishError('review_fingerprint_mismatch', 409)
    }
    const requestedOperationBatchId = cleanText(input.operationBatchId, 128)
    if (requestedOperationBatchId) {
      const operationBatch = await db.creativeOperationBatch.findUnique({
        where: { id: requestedOperationBatchId },
      })
      if (
        !operationBatch
        || operationBatch.compositionId !== compositionId
        || Number(operationBatch.resultVersion) !== compositionVersion
      ) throw new StudioPublishError('operation_batch_version_mismatch', 409)
      operationBatchId = String(operationBatch.id)
    } else if (typeof version.operationBatchId === 'string') {
      operationBatchId = version.operationBatchId
    }
    const requestedRenderFingerprint = cleanText(input.renderFingerprint, 128)
    if (requestedRenderFingerprint) {
      const renderJob = await db.creativeLifecycleJob.findUnique({
        where: {
          ownerId_renderFingerprint: {
            ownerId: access.ownerId,
            renderFingerprint: requestedRenderFingerprint,
          },
        },
      })
      const renderArtifact = renderJob?.resultArtifactVersionId
        ? await db.creativeAssetVersion.findUnique({
            where: { id: String(renderJob.resultArtifactVersionId) },
            include: { asset: true },
          })
        : null
      const renderArtifactMetadata = record(renderArtifact?.metadata)
      const renderLineage = record(renderArtifactMetadata.lifecycle)
      if (
        !renderJob
        || renderJob.status !== 'READY'
        || !renderJob.verifiedAt
        || !renderJob.resultStoragePath
        || !renderJob.resultChecksum
        || !renderJob.resultArtifactVersionId
        || !renderArtifact
        || record(renderArtifact.asset).projectId !== project.id
        || renderArtifact.storagePath !== renderJob.resultStoragePath
        || renderArtifactMetadata.checksumSha256 !== renderJob.resultChecksum
        || renderJob.kind !== 'RENDER'
        || !['png', 'jpg', 'jpeg', 'webp', 'mp4'].includes(String(renderJob.outputFormat).toLowerCase())
        || renderJob.brandProfileId !== brandProfileId
        || renderJob.projectId !== project.id
        || renderJob.compositionId !== compositionId
        || renderJob.compositionVersionId !== compositionVersionId
        || Number(renderJob.compositionVersion) !== compositionVersion
        || renderJob.compositionDocumentHash !== compositionDocumentHash
        || (renderJob.operationBatchId ?? null) !== (operationBatchId ?? null)
        || renderJob.sourceArtifactVersionId !== latestVersion.id
        || renderJob.approvedReviewEventId !== approvalEvent.id
        || renderJob.approvedArtifactVersionId !== latestVersion.id
        || renderJob.reviewFingerprint !== reviewFingerprint
        || renderLineage.jobId !== renderJob.id
        || renderLineage.compositionVersionId !== compositionVersionId
        || renderLineage.sourceArtifactVersionId !== latestVersion.id
        || renderLineage.renderFingerprint !== requestedRenderFingerprint
      ) throw new StudioPublishError('verified_render_receipt_required', 409)
      renderFingerprint = requestedRenderFingerprint
      mediaStoragePath = String(renderJob.resultStoragePath)
    }
  } else if (
    input.operationBatchId
    || input.reviewFingerprint
    || input.renderFingerprint
    || input.approvedArtifactVersionId
    || input.approvedReviewEventId
  ) {
    throw new StudioPublishError('composition_publish_pin_required')
  }

  return {
    ownerId: access.ownerId,
    brandProfileId,
    projectId: String(project.id),
    assetId: String(asset.id),
    assetVersionId: String(latestVersion.id),
    recipeId: typeof latestVersion.recipeId === 'string' ? latestVersion.recipeId : null,
    campaignPackId,
    compositionId,
    compositionVersionId,
    compositionVersion,
    compositionDocumentHash,
    operationBatchId,
    reviewFingerprint,
    renderFingerprint,
    sceneKey,
    approvedReviewEventId: String(approvalEvent.id),
    mediaStoragePath,
  }
}

async function buildPreview(
  actor: StudioActor,
  value: unknown,
): Promise<StudioPublishPreview & {
  ownerId: string
  recipeId: string | null
  adId: string | null
}> {
  const input = record(value)
  const context = await loadApprovedPublishContext(actor, input)
  const platform = normalizePublishPlatform(input.platform)
  const pageRef = normalizePageRef(input.pageRef)
  const caption = normalizeCaption(input.caption, platform)
  if (input.intent === 'schedule' && (typeof input.scheduledFor !== 'string' || !input.scheduledFor.trim())) {
    throw new StudioPublishError('publish_schedule_required')
  }
  let normalizedRequestedSchedule: string | null = null
  if (input.scheduledFor != null) {
    try {
      normalizedRequestedSchedule = normalizeLifecycleScheduleAt(input.scheduledFor)
    } catch {
      throw new StudioPublishError('invalid_publish_schedule')
    }
  }
  const scheduledFor = normalizeScheduledFor(normalizedRequestedSchedule)
  // Fingerprint the owner's canonical request, not the moving execution-time
  // clamp. Otherwise two retries of the same past/immediate request produce
  // different `now` values and falsely trip the idempotency conflict gate.
  const fingerprintScheduledFor = normalizedRequestedSchedule
    ? new Date(normalizedRequestedSchedule)
    : new Date(0)
  const idempotencyKey = normalizePublishIdempotencyKey(input.idempotencyKey)
  const adId = normalizeAdId(input.adId)
  const requestFingerprint = publishRequestFingerprint({
    ownerId: context.ownerId,
    assetVersionId: context.assetVersionId,
    platform,
    pageRef,
    caption,
    scheduledFor: fingerprintScheduledFor,
    adId,
    compositionId: context.compositionId,
    compositionVersionId: context.compositionVersionId,
    compositionVersion: context.compositionVersion,
    compositionDocumentHash: context.compositionDocumentHash,
    operationBatchId: context.operationBatchId,
    reviewFingerprint: context.reviewFingerprint,
    renderFingerprint: context.renderFingerprint,
  })
  return {
    dryRun: true,
    ...context,
    platform,
    pageRef,
    caption,
    scheduledFor: scheduledFor.toISOString(),
    idempotencyKey,
    requestFingerprint,
    adId,
    estimatedCostUsd: 0,
    publishingEnabled: await isStudioMetaPublishingEnabled(context.ownerId),
    receipt: {
      mode: 'dry_run',
      externalEffect: false,
      approvedVersionPinned: true,
      duplicateProtection: 'owner_id+idempotency_key',
    },
  }
}

export async function previewStudioPublish(
  actor: StudioActor,
  value: unknown,
): Promise<StudioPublishPreview> {
  const preview = await buildPreview(actor, value)
  const {
    adId: _adId,
    ownerId: _ownerId,
    recipeId: _recipeId,
    ...view
  } = preview
  return view
}

function status(value: unknown): StudioPublishStatus {
  return String(value ?? '').toLowerCase() as StudioPublishStatus
}

function serializeDelivery(row: AnyRecord): StudioPublishDeliveryView {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    brandProfileId: String(row.brandProfileId),
    projectId: String(row.projectId),
    assetId: String(row.assetId),
    assetVersionId: String(row.assetVersionId),
    campaignPackId: typeof row.campaignPackId === 'string' ? row.campaignPackId : null,
    compositionId: typeof row.compositionId === 'string' ? row.compositionId : null,
    compositionVersionId: typeof row.compositionVersionId === 'string'
      ? row.compositionVersionId
      : null,
    compositionVersion: Number.isInteger(row.compositionVersion)
      ? Number(row.compositionVersion)
      : null,
    compositionDocumentHash: typeof row.compositionDocumentHash === 'string'
      ? row.compositionDocumentHash
      : null,
    operationBatchId: typeof row.operationBatchId === 'string' ? row.operationBatchId : null,
    reviewFingerprint: typeof row.reviewFingerprint === 'string' ? row.reviewFingerprint : null,
    renderFingerprint: typeof row.renderFingerprint === 'string' ? row.renderFingerprint : null,
    sceneKey: String(row.sceneKey ?? 'unclassified'),
    platform: String(row.platform).toLowerCase() as StudioPublishPlatform,
    pageRef: String(row.pageRef),
    caption: String(row.caption),
    adId: typeof row.adId === 'string' ? row.adId : null,
    idempotencyKey: String(row.idempotencyKey),
    status: status(row.status),
    scheduledFor: iso(row.scheduledFor),
    attempts: Number(row.attempts ?? 0),
    externalPostId: typeof row.externalPostId === 'string' ? row.externalPostId : null,
    permalinkUrl: typeof row.permalinkUrl === 'string' ? row.permalinkUrl : null,
    verifiedAt: nullableIso(row.verifiedAt),
    publishedAt: nullableIso(row.publishedAt),
    receipt: record(row.receipt),
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
    lastErrorMessage: typeof row.lastErrorMessage === 'string' ? row.lastErrorMessage : null,
    metricsLastSyncedAt: nullableIso(row.metricsLastSyncedAt),
    metricsLastError: typeof row.metricsLastError === 'string' ? row.metricsLastError : null,
    costUsd: Number(row.costUsd ?? 0),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export async function scheduleStudioPublish(
  actor: StudioActor,
  value: unknown,
): Promise<{ delivery: StudioPublishDeliveryView; idempotent: boolean }> {
  const input = record(value)
  if (input.confirmedOwnerApproval !== true) {
    throw new StudioPublishError('owner_publish_confirmation_required', 409)
  }
  const preview = await buildPreview(actor, input)
  const existing = await db.creativePublishDelivery.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId: preview.ownerId,
        idempotencyKey: preview.idempotencyKey,
      },
    },
  })
  if (existing) {
    if (existing.requestFingerprint !== preview.requestFingerprint) {
      throw new StudioPublishError('idempotency_conflict', 409)
    }
    return { delivery: serializeDelivery(existing), idempotent: true }
  }

  try {
    const delivery = await db.creativePublishDelivery.create({
      data: {
        ownerId: preview.ownerId,
        brandProfileId: preview.brandProfileId,
        projectId: preview.projectId,
        assetId: preview.assetId,
        assetVersionId: preview.assetVersionId,
        recipeId: preview.recipeId,
        campaignPackId: preview.campaignPackId,
        compositionId: preview.compositionId,
        compositionVersionId: preview.compositionVersionId,
        compositionVersion: preview.compositionVersion,
        compositionDocumentHash: preview.compositionDocumentHash,
        operationBatchId: preview.operationBatchId,
        reviewFingerprint: preview.reviewFingerprint,
        renderFingerprint: preview.renderFingerprint,
        sceneKey: preview.sceneKey,
        approvedReviewEventId: preview.approvedReviewEventId,
        createdById: actor.userId,
        platform: preview.platform.toUpperCase(),
        pageRef: preview.pageRef,
        caption: preview.caption,
        mediaStoragePath: preview.mediaStoragePath,
        adId: preview.adId,
        idempotencyKey: preview.idempotencyKey,
        requestFingerprint: preview.requestFingerprint,
        scheduledFor: new Date(preview.scheduledFor),
        status: 'SCHEDULED',
        receipt: {
          scheduledBy: actor.userId,
          approvedReviewEventId: preview.approvedReviewEventId,
          approvedVersionPinned: true,
          compositionVersionPinned: Boolean(preview.compositionVersionId),
          compositionId: preview.compositionId,
          compositionVersionId: preview.compositionVersionId,
          operationBatchId: preview.operationBatchId,
          reviewFingerprint: preview.reviewFingerprint,
          renderFingerprint: preview.renderFingerprint,
          externalEffect: false,
        },
        costUsd: 0,
      },
    })
    return { delivery: serializeDelivery(delivery), idempotent: false }
  } catch (error) {
    if (record(error).code !== 'P2002') throw error
    const raced = await db.creativePublishDelivery.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: preview.ownerId,
          idempotencyKey: preview.idempotencyKey,
        },
      },
    })
    if (!raced || raced.requestFingerprint !== preview.requestFingerprint) {
      throw new StudioPublishError('idempotency_conflict', 409)
    }
    return { delivery: serializeDelivery(raced), idempotent: true }
  }
}

export async function listStudioPublishDeliveries(
  actor: StudioActor,
  assetId: string,
  brandProfileId?: string | null,
): Promise<{
  deliveries: StudioPublishDeliveryView[]
  publishingEnabled: boolean
  canPublish: boolean
}> {
  const asset = await db.creativeProjectAsset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      project: { select: { brandProfileId: true } },
    },
  })
  if (!asset) throw new StudioPublishError('asset_not_found', 404)
  const actualBrandProfileId = String(asset.project?.brandProfileId ?? '')
  if (!actualBrandProfileId) throw new StudioPublishError('asset_brand_missing', 409)
  if (brandProfileId && brandProfileId !== actualBrandProfileId) {
    throw new StudioPublishError('brand_scope_mismatch', 403)
  }
  const access = await requireStudioBrandAccess(actor, actualBrandProfileId)
  const rows = await db.creativePublishDelivery.findMany({
    where: { assetId, ownerId: access.ownerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 25,
  })
  return {
    deliveries: rows.map(serializeDelivery),
    publishingEnabled: await isStudioMetaPublishingEnabled(access.ownerId),
    canPublish: access.role === 'owner',
  }
}

export async function cancelStudioPublish(
  actor: StudioActor,
  deliveryId: string,
): Promise<StudioPublishDeliveryView> {
  const delivery = await db.creativePublishDelivery.findUnique({ where: { id: deliveryId } })
  if (!delivery) throw new StudioPublishError('publish_delivery_not_found', 404)
  const access = await requireStudioBrandAccess(actor, delivery.brandProfileId)
  if (access.role !== 'owner') throw new StudioPublishError('studio_publish_forbidden', 403)
  const updated = await db.creativePublishDelivery.updateMany({
    where: { id: deliveryId, ownerId: access.ownerId, status: 'SCHEDULED' },
    data: {
      status: 'CANCELED',
      receipt: { ...record(delivery.receipt), canceledBy: actor.userId, canceledAt: new Date().toISOString() },
    },
  })
  if (updated.count !== 1) throw new StudioPublishError('publish_not_cancelable', 409)
  return serializeDelivery(await db.creativePublishDelivery.findUnique({ where: { id: deliveryId } }))
}

export async function retryStudioPublish(
  actor: StudioActor,
  deliveryId: string,
): Promise<StudioPublishDeliveryView> {
  const delivery = await db.creativePublishDelivery.findUnique({ where: { id: deliveryId } })
  if (!delivery) throw new StudioPublishError('publish_delivery_not_found', 404)
  const access = await requireStudioBrandAccess(actor, delivery.brandProfileId)
  if (access.role !== 'owner') throw new StudioPublishError('studio_publish_forbidden', 403)
  if (delivery.status !== 'FAILED_RETRYABLE') {
    throw new StudioPublishError('publish_retry_requires_confirmed_no_effect', 409)
  }
  await db.creativePublishDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'SCHEDULED',
      scheduledFor: new Date(),
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  })
  return serializeDelivery(await db.creativePublishDelivery.findUnique({ where: { id: deliveryId } }))
}

async function markStaleClaims(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 15 * 60_000)
  const result = await db.creativePublishDelivery.updateMany({
    where: {
      status: 'PUBLISHING',
      leaseStartedAt: { lt: cutoff },
    },
    data: {
      status: 'NEEDS_REVIEW',
      lastErrorCode: 'ambiguous_worker_interruption',
      lastErrorMessage: 'Provider call may have happened; automatic retry blocked to prevent a duplicate post.',
    },
  })
  return Number(result.count ?? 0)
}

export async function processDueStudioPublishes(input: {
  publish: StudioPublisher
  now?: Date
  limit?: number
  deliveryId?: string
}): Promise<{
  processed: number
  published: number
  needsReview: number
  retryable: number
  skippedDisabled: number
  staleClaimsQuarantined: number
  results: Array<{ id: string; status: StudioPublishStatus; postId: string | null }>
}> {
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(10, Math.round(input.limit ?? 5)))
  const staleClaimsQuarantined = await markStaleClaims(now)
  const rows = await db.creativePublishDelivery.findMany({
    where: input.deliveryId
      ? { id: input.deliveryId, status: { in: ['SCHEDULED', 'FAILED_RETRYABLE'] } }
      : {
          status: { in: ['SCHEDULED', 'FAILED_RETRYABLE'] },
          scheduledFor: { lte: now },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
    orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
    take: limit,
  })

  const summary = {
    processed: 0,
    published: 0,
    needsReview: 0,
    retryable: 0,
    skippedDisabled: 0,
    staleClaimsQuarantined,
    results: [] as Array<{ id: string; status: StudioPublishStatus; postId: string | null }>,
  }

  for (const row of rows) {
    if (
      row.compositionId
      && process.env.CREATIVE_STUDIO_V3_LIVE_PUBLISH_ENABLED !== 'true'
    ) {
      summary.skippedDisabled += 1
      continue
    }
    if (!(await isStudioMetaPublishingEnabled(String(row.ownerId)))) {
      summary.skippedDisabled += 1
      continue
    }
    const claim = await db.creativePublishDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: 'PUBLISHING',
        leaseStartedAt: now,
        attempts: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })
    if (claim.count !== 1) continue
    summary.processed += 1
    const attempts = Number(row.attempts ?? 0) + 1
    let outcome: Awaited<ReturnType<StudioPublisher>>
    try {
      outcome = await input.publish({
        id: String(row.id),
        platform: String(row.platform).toLowerCase() as StudioPublishPlatform,
        pageRef: String(row.pageRef),
        caption: String(row.caption),
        imageRef: String(row.mediaStoragePath),
      })
    } catch (error) {
      outcome = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'publisher_threw',
        // A thrown transport error can be ambiguous: never retry it.
        safeToRetry: false,
      }
    }
    const decision = studioPublishRetryDecision({
      ...outcome,
      postId: outcome.postId ?? null,
      attempts,
    })
    const publishedAt = outcome.ok || outcome.postId ? now : null
    const nextAttemptAt = decision.retryDelayMs === null
      ? null
      : new Date(now.getTime() + decision.retryDelayMs)
    const receipt = {
      ...record(row.receipt),
      provider: 'meta_graph',
      attemptedAt: now.toISOString(),
      attempt: attempts,
      decision: decision.reason,
      postId: outcome.postId ?? null,
      permalinkUrl: outcome.permalinkUrl ?? null,
      verified: outcome.verified === true,
      providerReceipt: outcome.providerReceipt ?? null,
    }
    await db.creativePublishDelivery.update({
      where: { id: row.id },
      data: {
        status: decision.status,
        externalPostId: outcome.postId ?? null,
        permalinkUrl: outcome.permalinkUrl ?? null,
        verifiedAt: decision.status === 'PUBLISHED' ? now : null,
        publishedAt,
        receipt,
        leaseStartedAt: null,
        nextAttemptAt,
        lastErrorCode: decision.status === 'PUBLISHED'
          ? null
          : outcome.errorCode ?? decision.reason,
        lastErrorMessage: decision.status === 'PUBLISHED'
          ? null
          : cleanText(outcome.error ?? decision.reason, 2_000),
        metricsNextSyncAt: decision.status === 'PUBLISHED'
          ? new Date(now.getTime() + 60 * 60_000)
          : null,
      },
    })
    const viewStatus = decision.status.toLowerCase() as StudioPublishStatus
    if (viewStatus === 'published') summary.published += 1
    if (viewStatus === 'needs_review') summary.needsReview += 1
    if (viewStatus === 'failed_retryable') summary.retryable += 1
    summary.results.push({
      id: String(row.id),
      status: viewStatus,
      postId: outcome.postId ?? null,
    })
  }
  return summary
}

export function studioPublishErrorResponse(error: unknown, event: string): Response {
  if (error instanceof StudioPublishError) {
    return Response.json({
      error: error.code,
      message: error.message,
      ...error.details,
    }, { status: error.status })
  }
  console.error(`[${event}] request failed`, error)
  return Response.json({ error: 'creative_publish_failed' }, { status: 500 })
}
