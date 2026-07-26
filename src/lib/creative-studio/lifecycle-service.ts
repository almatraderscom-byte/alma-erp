import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { downloadStorageObject } from '@/lib/supabase-storage'
import { isAgentEnabled } from '@/lib/agent-runtime-flag'
import {
  requireStudioBrandAccess,
  studioRoleToDb,
  type StudioActor,
  type StudioBrandAccess,
} from './studio-access'
import {
  assertLifecycleReviewPin,
  assertStudioLifecycleCapability,
  buildStudioRenderFingerprint,
  lifecycleFingerprint,
  StudioLifecycleError,
  type StudioCompositionPin,
  type StudioReviewSnapshot,
} from './lifecycle-contract'
import {
  evaluateStudioLifecycleRollout,
  toStudioLifecycleOperationsView,
  type StudioLifecycleFlagScope,
  type StudioLifecycleScopedFlag,
} from './lifecycle-rollout'
import type { StudioFoundationLifecyclePort } from './lifecycle-adapters'

// Prisma is generated after additive migrations exist.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any
type Db = typeof db
type Row = Record<string, unknown>
const LIFECYCLE_CAPABILITIES = [
  'preview',
  'render',
  'export',
  'dry_run',
  'schedule',
  'live_publish',
] as const
const LIFECYCLE_ROLES = ['owner', 'creator', 'reviewer'] as const

export type LifecycleJobKind = 'render' | 'export'
export type LifecycleJobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'canceled' | 'needs_review'
export type LifecycleEffectClass = 'zero_cost_local' | 'paid'

export type LifecycleJobView = {
  id: string
  ownerId: string
  brandProfileId: string
  projectId: string
  compositionId: string
  compositionVersionId: string
  compositionVersion: number
  compositionDocumentHash: string
  operationBatchId: string | null
  sourceArtifactVersionId: string
  sourceStoragePath: string
  sourceChecksum: string
  sourceBytes: number
  approvedReviewEventId: string | null
  approvedArtifactVersionId: string | null
  reviewFingerprint: string | null
  kind: LifecycleJobKind
  renderFingerprint: string
  idempotencyKey: string
  effectClass: LifecycleEffectClass
  estimatedCostBdt: number
  paidExecutionAllowed: boolean
  status: LifecycleJobStatus
  progress: { completed: number; total: number }
  resultStoragePath: string | null
  resultChecksum: string | null
  resultBytes: number | null
  resultArtifactVersionId: string | null
  verifiedAt: string | null
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
}

export type LifecycleClaimView = LifecycleJobView & {
  leaseToken: string
  leaseExpiresAt: string
  renderProfile: string
  outputFormat: string
  rendererVersion: string
  compositionDocument: unknown
}

export class LifecycleServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'LifecycleServiceError'
  }
}

function assertLifecycleRuntimeEnabled(): void {
  if (!isAgentEnabled()) throw new LifecycleServiceError('agent_disabled', 503)
}

function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}

function text(value: unknown, code: string, max = 256): string {
  const result = typeof value === 'string' ? value.trim().slice(0, max) : ''
  if (!result) throw new LifecycleServiceError(code)
  return result
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function nullableIso(value: unknown): string | null {
  return value ? iso(value) : null
}

function status(value: unknown): LifecycleJobStatus {
  return String(value ?? '').toLowerCase() as LifecycleJobStatus
}

function kind(value: unknown): LifecycleJobKind {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'render' || normalized === 'export') return normalized
  throw new LifecycleServiceError('invalid_lifecycle_job_kind')
}

function effectClass(value: unknown): LifecycleEffectClass {
  const normalized = String(value ?? 'zero_cost_local').toLowerCase()
  if (normalized === 'zero_cost_local' || normalized === 'paid') return normalized
  throw new LifecycleServiceError('invalid_lifecycle_effect_class')
}

function estimatedCost(value: unknown): number {
  const result = Number(value ?? 0)
  if (!Number.isFinite(result) || result < 0 || result > 100_000_000) {
    throw new LifecycleServiceError('invalid_lifecycle_cost')
  }
  return Math.round(result)
}

function artifactIdentity(row: Row): string {
  const metadata = object(row.metadata)
  const checksum = typeof metadata.checksumSha256 === 'string'
    ? metadata.checksumSha256.trim().toLowerCase()
    : typeof metadata.checksum === 'string'
      ? metadata.checksum.trim().toLowerCase()
      : ''
  if (/^[a-f0-9]{64}$/.test(checksum)) return checksum
  return lifecycleFingerprint({
    kind: 'creative_asset_version_identity_v1',
    assetVersionId: row.id,
    assetId: row.assetId,
    version: row.version,
    storagePath: row.storagePath ?? null,
    metadata,
  })
}

function immutableSourceEvidence(row: Row): {
  storagePath: string
  checksum: string
  sizeBytes: number
} {
  const metadata = object(row.metadata)
  const storagePath = typeof row.storagePath === 'string' ? row.storagePath.trim() : ''
  const checksum = typeof metadata.checksumSha256 === 'string'
    ? metadata.checksumSha256.trim().toLowerCase()
    : ''
  const sizeBytes = Number(metadata.byteSize ?? metadata.sizeBytes)
  if (
    !storagePath
    || !/^[a-f0-9]{64}$/.test(checksum)
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
  ) throw new LifecycleServiceError('source_artifact_evidence_incomplete', 409)
  return { storagePath, checksum, sizeBytes }
}

function serializeJob(row: Row): LifecycleJobView {
  const resultBytes = row.resultBytes == null ? null : Number(row.resultBytes)
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    brandProfileId: String(row.brandProfileId),
    projectId: String(row.projectId),
    compositionId: String(row.compositionId),
    compositionVersionId: String(row.compositionVersionId),
    compositionVersion: Number(row.compositionVersion),
    compositionDocumentHash: String(row.compositionDocumentHash),
    operationBatchId: typeof row.operationBatchId === 'string' ? row.operationBatchId : null,
    sourceArtifactVersionId: String(row.sourceArtifactVersionId),
    sourceStoragePath: String(row.sourceStoragePath),
    sourceChecksum: String(row.sourceChecksum),
    sourceBytes: Number(row.sourceBytes),
    approvedReviewEventId: typeof row.approvedReviewEventId === 'string' ? row.approvedReviewEventId : null,
    approvedArtifactVersionId: typeof row.approvedArtifactVersionId === 'string' ? row.approvedArtifactVersionId : null,
    reviewFingerprint: typeof row.reviewFingerprint === 'string' ? row.reviewFingerprint : null,
    kind: String(row.kind).toLowerCase() as LifecycleJobKind,
    renderFingerprint: String(row.renderFingerprint),
    idempotencyKey: String(row.idempotencyKey),
    effectClass: String(row.effectClass).toLowerCase() as LifecycleEffectClass,
    estimatedCostBdt: Number(row.estimatedCostBdt ?? 0),
    paidExecutionAllowed: Boolean(row.paidExecutionAllowed),
    status: status(row.status),
    progress: {
      completed: Number(row.progressCompleted ?? 0),
      total: Number(row.progressTotal ?? 4),
    },
    resultStoragePath: typeof row.resultStoragePath === 'string' ? row.resultStoragePath : null,
    resultChecksum: typeof row.resultChecksum === 'string' ? row.resultChecksum : null,
    resultBytes: Number.isFinite(resultBytes) ? resultBytes : null,
    resultArtifactVersionId: typeof row.resultArtifactVersionId === 'string'
      ? row.resultArtifactVersionId
      : null,
    verifiedAt: nullableIso(row.verifiedAt),
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

type LifecycleContext = {
  access: StudioBrandAccess
  composition: Row
  version: Row
  artifactVersion: Row
  artifact: Row
  reviewEvent: Row | null
  operationBatch: Row | null
  reviewFingerprint: string | null
  sourceEvidence: ReturnType<typeof immutableSourceEvidence>
}

function reviewSnapshot(
  event: Row,
  artifactId: string,
  latestVersionId: string,
  assetReviewState: unknown,
): StudioReviewSnapshot {
  const metadata = object(event.metadata)
  return {
    assetId: artifactId,
    state: String(assetReviewState).toUpperCase() === 'APPROVED' ? 'approved' : 'draft',
    latestVersionId,
    approvedReviewEventId: String(event.id),
    approvedVersionId: typeof event.approvedArtifactVersionId === 'string'
      ? event.approvedArtifactVersionId
      : typeof metadata.approvedVersionId === 'string' ? metadata.approvedVersionId : null,
    approvedCompositionId: typeof event.compositionId === 'string'
      ? event.compositionId
      : typeof metadata.approvedCompositionId === 'string' ? metadata.approvedCompositionId : null,
    approvedCompositionVersionId: typeof event.compositionVersionId === 'string'
      ? event.compositionVersionId
      : typeof metadata.approvedCompositionVersionId === 'string'
        ? metadata.approvedCompositionVersionId
        : null,
  }
}

async function lifecycleContext(
  actor: StudioActor,
  input: Row,
  client: Db = db,
): Promise<LifecycleContext> {
  const compositionId = text(input.compositionId, 'composition_id_required')
  const composition = await client.creativeComposition.findUnique({ where: { id: compositionId } })
  if (!composition || composition.archivedAt) throw new LifecycleServiceError('composition_not_found', 404)
  const requestedBrand = typeof input.brandProfileId === 'string' ? input.brandProfileId : null
  if (requestedBrand && requestedBrand !== composition.brandProfileId) {
    throw new LifecycleServiceError('brand_scope_mismatch', 403)
  }
  const requestedProject = typeof input.projectId === 'string' ? input.projectId : null
  if (requestedProject && requestedProject !== composition.projectId) {
    throw new LifecycleServiceError('project_scope_mismatch', 403)
  }
  const access = await requireStudioBrandAccess(actor, String(composition.brandProfileId))
  const compositionVersionId = text(input.compositionVersionId, 'composition_version_id_required')
  const version = await client.creativeCompositionVersion.findUnique({ where: { id: compositionVersionId } })
  if (
    !version
    || version.compositionId !== composition.id
    || version.id !== compositionVersionId
    || Number(version.version) !== Number(composition.currentVersion)
  ) throw new LifecycleServiceError('stale_composition_version', 409)

  const artifactVersionId = text(input.sourceArtifactVersionId, 'source_artifact_version_required')
  const artifactVersion = await client.creativeAssetVersion.findUnique({
    where: { id: artifactVersionId },
    include: { asset: true },
  })
  const artifact = object(artifactVersion?.asset)
  if (!artifactVersion || String(artifact.projectId) !== String(composition.projectId)) {
    throw new LifecycleServiceError('artifact_scope_mismatch', 403)
  }
  const authoritativeAsset = await client.creativeProjectAsset.findUnique({
    where: { id: String(artifact.id) },
    include: {
      versions: {
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
      reviewEvents: {
        where: { toState: 'APPROVED' },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
  })
  const actualLatestVersion = Array.isArray(authoritativeAsset?.versions)
    ? object(authoritativeAsset.versions[0])
    : {}
  if (
    !authoritativeAsset
    || String(authoritativeAsset.projectId) !== String(composition.projectId)
    || String(actualLatestVersion.id) !== String(artifactVersion.id)
  ) throw new LifecycleServiceError('source_artifact_version_stale', 409)
  const compositionNode = await client.creativeCompositionNode.findFirst({
    where: {
      compositionVersionId: String(version.id),
      assetVersionId: String(artifactVersion.id),
    },
    select: { id: true },
  })
  if (!compositionNode) {
    throw new LifecycleServiceError('composition_source_artifact_mismatch', 409)
  }
  const sourceEvidence = immutableSourceEvidence(artifactVersion)

  const operationBatchId = typeof input.operationBatchId === 'string' ? input.operationBatchId : null
  const operationBatch = operationBatchId
    ? await client.creativeOperationBatch.findUnique({ where: { id: operationBatchId } })
    : null
  if (
    operationBatchId
    && (
      !operationBatch
      || operationBatch.compositionId !== composition.id
      || Number(operationBatch.resultVersion) !== Number(version.version)
    )
  ) throw new LifecycleServiceError('operation_batch_scope_mismatch', 409)

  const approvedReviewEventId = typeof input.approvedReviewEventId === 'string'
    ? input.approvedReviewEventId
    : null
  const actualApproval = Array.isArray(authoritativeAsset.reviewEvents)
    ? object(authoritativeAsset.reviewEvents[0])
    : {}
  const reviewEvent = approvedReviewEventId ? actualApproval : null
  if (
    approvedReviewEventId
    && (
      !actualApproval.id
      || String(actualApproval.id) !== approvedReviewEventId
      || String(actualApproval.assetId) !== String(artifact.id)
    )
  ) throw new LifecycleServiceError('review_event_invalidated', 409)
  const pin: StudioCompositionPin = {
    compositionId: String(composition.id),
    compositionVersionId: String(version.id),
    compositionVersion: Number(version.version),
    artifactId: String(artifact.id),
    artifactVersionId: String(artifactVersion.id),
    artifactChecksum: artifactIdentity(artifactVersion),
    reviewEventId: approvedReviewEventId ?? '',
    approvedVersionId: String(artifactVersion.id),
    campaignPackId: typeof input.campaignPackId === 'string' ? input.campaignPackId : null,
    batchId: operationBatchId,
  }
  let reviewFingerprint: string | null = null
  if (reviewEvent) {
    assertLifecycleReviewPin(pin, reviewSnapshot(
      reviewEvent,
      String(artifact.id),
      String(actualLatestVersion.id),
      authoritativeAsset.reviewState,
    ))
    if (
      Number(reviewEvent.compositionVersion) !== Number(version.version)
      || reviewEvent.compositionDocumentHash !== version.documentHash
    ) throw new LifecycleServiceError('review_composition_version_invalidated', 409)
    reviewFingerprint = lifecycleFingerprint({
      reviewEventId: reviewEvent.id,
      assetVersionId: artifactVersion.id,
      compositionId: composition.id,
      compositionVersionId: version.id,
      compositionVersion: version.version,
      compositionDocumentHash: version.documentHash,
    })
  }
  return {
    access,
    composition,
    version,
    artifactVersion,
    artifact,
    reviewEvent,
    operationBatch,
    reviewFingerprint,
    sourceEvidence,
  }
}

async function serializableLifecycleTransaction<T>(
  callback: (tx: Db) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await db.$transaction(callback, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (object(error).code !== 'P2034' || attempt === 1) throw error
    }
  }
  throw new LifecycleServiceError('lifecycle_concurrent_change', 409)
}

function dbScopedFlag(row: Row): StudioLifecycleScopedFlag {
  return {
    id: String(row.id),
    scope: {
      ownerId: String(row.ownerId),
      ...(typeof row.brandProfileId === 'string' ? { brandProfileId: row.brandProfileId } : {}),
      ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
      ...(row.role ? { role: String(row.role).toLowerCase() as StudioLifecycleFlagScope['role'] } : {}),
      capability: String(row.capability) as StudioLifecycleFlagScope['capability'],
    },
    enabled: Boolean(row.enabled),
    legacyFallbackEnabled: row.legacyFallbackEnabled !== false,
    dualReadEnabled: row.dualReadEnabled === true,
    canaryPercent: Number(row.canaryPercent ?? 0),
    canarySalt: typeof row.canarySalt === 'string' ? row.canarySalt : undefined,
  }
}

type LifecycleFlagRole = typeof LIFECYCLE_ROLES[number]
type LifecycleFlagCapability = typeof LIFECYCLE_CAPABILITIES[number]

export type LifecycleFeatureFlagView = {
  id: string
  ownerId: string
  brandProfileId: string
  projectId: string
  role: LifecycleFlagRole
  capability: LifecycleFlagCapability
  enabled: boolean
  dualReadEnabled: boolean
  legacyFallbackAvailable: boolean
  fallbackExecution: 'client_orchestrated'
  canaryPercent: number
  updatedById: string
  createdAt: string
  updatedAt: string
  execution: {
    configOnly: true
    paidRenderAllowed: false
    voiceProviderAllowed: false
    externalPublishAllowed: false
  }
}

function lifecycleFlagRole(value: unknown): LifecycleFlagRole {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (LIFECYCLE_ROLES.includes(normalized as LifecycleFlagRole)) {
    return normalized as LifecycleFlagRole
  }
  throw new LifecycleServiceError('invalid_lifecycle_flag_role')
}

function lifecycleFlagCapability(value: unknown): LifecycleFlagCapability {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (LIFECYCLE_CAPABILITIES.includes(normalized as LifecycleFlagCapability)) {
    return normalized as LifecycleFlagCapability
  }
  throw new LifecycleServiceError('invalid_lifecycle_flag_capability')
}

function lifecycleCanaryPercent(value: unknown): number {
  const percent = Number(value)
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new LifecycleServiceError('invalid_lifecycle_canary_percent')
  }
  return percent
}

function serializeLifecycleFlag(row: Row): LifecycleFeatureFlagView {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    brandProfileId: String(row.brandProfileId),
    projectId: String(row.projectId),
    role: String(row.role).toLowerCase() as LifecycleFlagRole,
    capability: String(row.capability) as LifecycleFlagCapability,
    enabled: Boolean(row.enabled),
    dualReadEnabled: row.dualReadEnabled === true,
    legacyFallbackAvailable: row.legacyFallbackEnabled !== false,
    fallbackExecution: 'client_orchestrated',
    canaryPercent: Number(row.canaryPercent ?? 0),
    updatedById: String(row.updatedById),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    execution: {
      configOnly: true,
      paidRenderAllowed: false,
      voiceProviderAllowed: false,
      externalPublishAllowed: false,
    },
  }
}

async function lifecycleFlagOwnerScope(
  actor: StudioActor,
  value: unknown,
  client: Db = db,
): Promise<{
  access: StudioBrandAccess
  projectId: string
  role: LifecycleFlagRole
  capability: LifecycleFlagCapability
}> {
  const input = object(value)
  const brandProfileId = text(input.brandProfileId, 'brand_profile_id_required')
  const projectId = text(input.projectId, 'project_id_required')
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  if (access.role !== 'owner' || access.ownerId !== actor.userId) {
    throw new LifecycleServiceError('lifecycle_flag_owner_required', 403)
  }
  const project = await client.creativeProject.findUnique({ where: { id: projectId } })
  if (
    !project
    || project.id !== projectId
    || project.ownerId !== access.ownerId
    || project.brandProfileId !== access.brandProfileId
  ) throw new LifecycleServiceError('project_scope_mismatch', 403)
  return {
    access,
    projectId,
    role: lifecycleFlagRole(input.role),
    capability: lifecycleFlagCapability(input.capability),
  }
}

export async function listLifecycleFeatureFlags(
  actor: StudioActor,
  value: unknown,
): Promise<LifecycleFeatureFlagView[]> {
  assertLifecycleRuntimeEnabled()
  const scope = await lifecycleFlagOwnerScope(actor, value)
  const rows = await db.creativeLifecycleFeatureFlag.findMany({
    where: {
      ownerId: scope.access.ownerId,
      brandProfileId: scope.access.brandProfileId,
      projectId: scope.projectId,
      role: studioRoleToDb(scope.role),
      capability: scope.capability,
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  })
  return rows.map((row: Row) => serializeLifecycleFlag(row))
}

export async function configureLifecycleFeatureFlag(
  actor: StudioActor,
  value: unknown,
): Promise<{ flag: LifecycleFeatureFlagView; idempotent: boolean }> {
  assertLifecycleRuntimeEnabled()
  const input = object(value)
  const scope = await lifecycleFlagOwnerScope(actor, input)
  const idempotencyKey = text(input.idempotencyKey, 'idempotency_key_required', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(idempotencyKey)) {
    throw new LifecycleServiceError('idempotency_key_required')
  }
  if (typeof input.enabled !== 'boolean') {
    throw new LifecycleServiceError('lifecycle_flag_enabled_required')
  }
  const enabled = input.enabled
  const dualReadEnabled = input.dualReadEnabled === true
  const legacyFallbackEnabled = input.legacyFallbackEnabled !== false
  const canaryPercent = lifecycleCanaryPercent(input.canaryPercent ?? 0)
  if (
    scope.capability === 'live_publish'
    && enabled
    && process.env.CREATIVE_STUDIO_V3_LIVE_PUBLISH_ENABLED !== 'true'
  ) {
    throw new LifecycleServiceError('live_publish_execution_disabled', 409)
  }
  const exactScope = {
    ownerId: scope.access.ownerId,
    brandProfileId: scope.access.brandProfileId,
    projectId: scope.projectId,
    role: studioRoleToDb(scope.role),
    capability: scope.capability,
  }
  const requestFingerprint = lifecycleFingerprint({
    kind: 'creative_lifecycle_feature_flag_config_v1',
    exactScope,
    enabled,
    dualReadEnabled,
    legacyFallbackEnabled,
    canaryPercent,
    actorId: actor.userId,
    idempotencyKey,
  })
  const prior = await db.creativeLifecycleFlagAuditEvent.findUnique({
    where: {
      ownerId_idempotencyKey: {
        ownerId: scope.access.ownerId,
        idempotencyKey,
      },
    },
  })
  if (prior) {
    if (prior.requestFingerprint !== requestFingerprint) {
      throw new LifecycleServiceError('idempotency_conflict', 409)
    }
    const existing = await db.creativeLifecycleFeatureFlag.findUnique({
      where: { id: String(prior.featureFlagId) },
    })
    if (!existing) throw new LifecycleServiceError('lifecycle_flag_audit_target_missing', 500)
    return { flag: serializeLifecycleFlag(existing), idempotent: true }
  }

  try {
    const row = await serializableLifecycleTransaction(async (tx: Db) => {
      const existing = await tx.creativeLifecycleFeatureFlag.findFirst({ where: exactScope })
      const before = existing ? serializeLifecycleFlag(existing) : null
      const data = {
        ...exactScope,
        enabled,
        dualReadEnabled,
        legacyFallbackEnabled,
        canaryPercent,
        canarySalt: existing?.canarySalt ?? randomUUID(),
        updatedById: actor.userId,
      }
      const flag = existing
        ? await tx.creativeLifecycleFeatureFlag.update({
          where: { id: existing.id },
          data,
        })
        : await tx.creativeLifecycleFeatureFlag.create({ data })
      await tx.creativeLifecycleFlagAuditEvent.create({
        data: {
          ownerId: scope.access.ownerId,
          featureFlagId: flag.id,
          actorId: actor.userId,
          actorRole: 'OWNER',
          idempotencyKey,
          requestFingerprint,
          eventType: existing ? 'feature_flag_updated' : 'feature_flag_created',
          before,
          after: serializeLifecycleFlag(flag),
        },
      })
      return flag
    })
    return { flag: serializeLifecycleFlag(row), idempotent: false }
  } catch (error) {
    if (object(error).code !== 'P2002') throw error
    const raced = await db.creativeLifecycleFlagAuditEvent.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: scope.access.ownerId,
          idempotencyKey,
        },
      },
    })
    if (!raced || raced.requestFingerprint !== requestFingerprint) {
      throw new LifecycleServiceError('idempotency_conflict', 409)
    }
    const flag = await db.creativeLifecycleFeatureFlag.findUnique({
      where: { id: String(raced.featureFlagId) },
    })
    if (!flag) throw new LifecycleServiceError('lifecycle_flag_audit_target_missing', 500)
    return { flag: serializeLifecycleFlag(flag), idempotent: true }
  }
}

async function requireLifecycleFlag(
  context: LifecycleContext,
  capability: StudioLifecycleFlagScope['capability'],
  client: Db = db,
): Promise<void> {
  const rows = await client.creativeLifecycleFeatureFlag.findMany({
    where: {
      ownerId: context.access.ownerId,
      capability,
      OR: [{ brandProfileId: null }, { brandProfileId: context.access.brandProfileId }],
    },
  })
  const decision = evaluateStudioLifecycleRollout({
    scope: {
      ownerId: context.access.ownerId,
      brandProfileId: context.access.brandProfileId,
      projectId: String(context.composition.projectId),
      role: context.access.role,
      capability,
    },
    flags: rows.map((row: Row) => dbScopedFlag(row)),
  })
  if (!decision.enabled) {
    throw new LifecycleServiceError('lifecycle_capability_disabled', 409, {
      capability,
      legacyFallbackAvailable: decision.legacyFallbackAvailable,
      fallbackExecution: decision.fallbackExecution,
      canary: decision.canary,
    })
  }
}

function buildLifecycleJobPreview(
  context: LifecycleContext,
  input: Row,
): Record<string, unknown> {
  const jobKind = kind(input.kind)
  const classification = effectClass(input.effectClass)
  const estimatedCostBdt = estimatedCost(input.estimatedCostBdt)
  const renderProfile = text(input.renderProfile, 'render_profile_required')
  const outputFormat = text(input.outputFormat, 'output_format_required', 32)
  const rendererVersion = text(input.rendererVersion, 'renderer_version_required', 64)
  const baseRenderFingerprint = buildStudioRenderFingerprint({
    pin: {
      compositionId: String(context.composition.id),
      compositionVersionId: String(context.version.id),
      compositionVersion: Number(context.version.version),
      artifactId: String(context.artifact.id),
      artifactVersionId: String(context.artifactVersion.id),
      artifactChecksum: context.sourceEvidence.checksum,
      reviewEventId: context.reviewEvent ? String(context.reviewEvent.id) : '',
      approvedVersionId: String(context.artifactVersion.id),
      campaignPackId: null,
      batchId: context.operationBatch ? String(context.operationBatch.id) : null,
    },
    renderProfile,
    outputFormat,
    rendererVersion,
  })
  const renderFingerprint = lifecycleFingerprint({
    kind: `creative_lifecycle_${jobKind}_v1`,
    baseRenderFingerprint,
    ownerId: context.access.ownerId,
    brandProfileId: context.access.brandProfileId,
    projectId: context.composition.projectId,
    compositionId: context.composition.id,
    compositionVersionId: context.version.id,
    compositionVersion: context.version.version,
    compositionDocumentHash: context.version.documentHash,
    sourceArtifactVersionId: context.artifactVersion.id,
    sourceArtifactChecksum: context.sourceEvidence.checksum,
    sourceStoragePath: context.sourceEvidence.storagePath,
    sourceBytes: context.sourceEvidence.sizeBytes,
    approvedArtifactVersionId: context.reviewEvent ? context.artifactVersion.id : null,
    approvedReviewEventId: context.reviewEvent?.id ?? null,
    reviewFingerprint: context.reviewFingerprint,
    operationBatchId: context.operationBatch?.id ?? null,
  })
  return {
    mode: 'preview',
    externalEffect: false,
    jobKind,
    effectClass: classification,
    estimatedCostBdt,
    renderProfile,
    outputFormat,
    rendererVersion,
    paidExecutionAllowed: false,
    compositionId: context.composition.id,
    compositionVersionId: context.version.id,
    compositionVersion: context.version.version,
    compositionDocumentHash: context.version.documentHash,
    sourceArtifactVersionId: context.artifactVersion.id,
    approvedReviewEventId: context.reviewEvent?.id ?? null,
    reviewFingerprint: context.reviewFingerprint,
    renderFingerprint,
  }
}

export async function previewLifecycleJob(
  actor: StudioActor,
  value: unknown,
): Promise<Record<string, unknown>> {
  assertLifecycleRuntimeEnabled()
  const input = object(value)
  return serializableLifecycleTransaction(async (tx) => {
    const context = await lifecycleContext(actor, input, tx)
    assertStudioLifecycleCapability(context.access.role, 'preview')
    await requireLifecycleFlag(context, 'preview', tx)
    return buildLifecycleJobPreview(context, input)
  })
}

export async function createLifecycleJob(
  actor: StudioActor,
  value: unknown,
): Promise<{ job: LifecycleJobView; idempotent: boolean }> {
  assertLifecycleRuntimeEnabled()
  const input = object(value)
  const idempotencyKey = text(input.idempotencyKey, 'idempotency_key_required', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(idempotencyKey)) {
    throw new LifecycleServiceError('idempotency_key_required')
  }
  for (let uniqueAttempt = 0; uniqueAttempt < 2; uniqueAttempt += 1) {
    try {
      return await serializableLifecycleTransaction(async (tx: Db) => {
        const context = await lifecycleContext(actor, input, tx)
        const jobKind = kind(input.kind)
        const capability = jobKind === 'render' ? 'render' : 'export'
        assertStudioLifecycleCapability(context.access.role, capability)
        await requireLifecycleFlag(context, capability, tx)
        const classification = effectClass(input.effectClass)
        const estimatedCostBdt = estimatedCost(input.estimatedCostBdt)
        if (jobKind === 'export' && !context.reviewEvent) {
          throw new LifecycleServiceError('approved_review_required_for_export', 409)
        }
        if (classification === 'paid') {
          if (
            process.env.CREATIVE_STUDIO_V3_PAID_RENDER_ENABLED !== 'true'
            || context.access.role !== 'owner'
            || input.confirmedPaidExecution !== true
          ) throw new LifecycleServiceError('paid_lifecycle_execution_disabled', 409)
        }
        const preview = buildLifecycleJobPreview(context, input)
        const requestFingerprint = lifecycleFingerprint({
          intent: 'creative_lifecycle_job_v3',
          ownerId: context.access.ownerId,
          brandProfileId: context.access.brandProfileId,
          projectId: context.composition.projectId,
          actorId: actor.userId,
          actorRole: context.access.role,
          idempotencyKey,
          ...preview,
        })
        const existing = await tx.creativeLifecycleJob.findUnique({
          where: { ownerId_idempotencyKey: { ownerId: context.access.ownerId, idempotencyKey } },
        })
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new LifecycleServiceError('idempotency_conflict', 409)
          }
          return { job: serializeJob(existing), idempotent: true }
        }
        const duplicateExecution = await tx.creativeLifecycleJob.findUnique({
          where: {
            ownerId_renderFingerprint: {
              ownerId: context.access.ownerId,
              renderFingerprint: String(preview.renderFingerprint),
            },
          },
        })
        if (duplicateExecution) {
          const exactSameExecution = (
            duplicateExecution.brandProfileId === context.access.brandProfileId
            && duplicateExecution.projectId === context.composition.projectId
            && duplicateExecution.compositionId === context.composition.id
            && duplicateExecution.compositionVersionId === context.version.id
            && Number(duplicateExecution.compositionVersion) === Number(context.version.version)
            && duplicateExecution.compositionDocumentHash === context.version.documentHash
            && (duplicateExecution.operationBatchId ?? null) === (context.operationBatch?.id ?? null)
            && duplicateExecution.sourceArtifactVersionId === context.artifactVersion.id
            && duplicateExecution.sourceStoragePath === context.sourceEvidence.storagePath
            && duplicateExecution.sourceChecksum === context.sourceEvidence.checksum
            && Number(duplicateExecution.sourceBytes) === context.sourceEvidence.sizeBytes
            && (duplicateExecution.approvedReviewEventId ?? null) === (context.reviewEvent?.id ?? null)
            && (duplicateExecution.approvedArtifactVersionId ?? null)
              === (context.reviewEvent ? context.artifactVersion.id : null)
            && (duplicateExecution.reviewFingerprint ?? null) === context.reviewFingerprint
            && String(duplicateExecution.kind).toLowerCase() === jobKind
            && duplicateExecution.renderProfile === preview.renderProfile
            && duplicateExecution.outputFormat === preview.outputFormat
            && duplicateExecution.rendererVersion === preview.rendererVersion
            && String(duplicateExecution.effectClass).toLowerCase() === classification
            && Number(duplicateExecution.estimatedCostBdt) === estimatedCostBdt
          )
          if (!exactSameExecution) {
            throw new LifecycleServiceError('render_fingerprint_conflict', 409)
          }
          return { job: serializeJob(duplicateExecution), idempotent: true }
        }
        const created = await tx.creativeLifecycleJob.create({
          data: {
            ownerId: context.access.ownerId,
            brandProfileId: context.access.brandProfileId,
            projectId: String(context.composition.projectId),
            compositionId: String(context.composition.id),
            compositionVersionId: String(context.version.id),
            compositionVersion: Number(context.version.version),
            compositionDocumentHash: String(context.version.documentHash),
            operationBatchId: context.operationBatch ? String(context.operationBatch.id) : null,
            sourceArtifactVersionId: String(context.artifactVersion.id),
            sourceStoragePath: context.sourceEvidence.storagePath,
            sourceChecksum: context.sourceEvidence.checksum,
            sourceBytes: BigInt(context.sourceEvidence.sizeBytes),
            approvedReviewEventId: context.reviewEvent ? String(context.reviewEvent.id) : null,
            approvedArtifactVersionId: context.reviewEvent ? String(context.artifactVersion.id) : null,
            reviewFingerprint: context.reviewFingerprint,
            kind: jobKind.toUpperCase(),
            renderProfile: String(preview.renderProfile),
            outputFormat: String(preview.outputFormat),
            rendererVersion: String(preview.rendererVersion),
            renderFingerprint: String(preview.renderFingerprint),
            idempotencyKey,
            requestFingerprint,
            effectClass: classification === 'paid' ? 'PAID' : 'ZERO_COST_LOCAL',
            estimatedCostBdt,
            paidExecutionAllowed: classification === 'paid',
            status: 'QUEUED',
            createdById: actor.userId,
            createdByRole: studioRoleToDb(context.access.role),
          },
        })
        await tx.creativeLifecycleAuditEvent.create({
          data: {
            jobId: created.id,
            actorId: actor.userId,
            actorRole: studioRoleToDb(context.access.role),
            eventType: 'job_queued',
            fromStatus: null,
            toStatus: 'QUEUED',
            metadata: { requestFingerprint, renderFingerprint: preview.renderFingerprint },
          },
        })
        return { job: serializeJob(created), idempotent: false }
      })
    } catch (error) {
      if (object(error).code !== 'P2002' || uniqueAttempt === 1) throw error
    }
  }
  throw new LifecycleServiceError('idempotency_conflict', 409)
}

export async function listLifecycleJobs(
  actor: StudioActor,
  input: { brandProfileId: string; projectId: string; compositionId?: string | null },
): Promise<LifecycleJobView[]> {
  assertLifecycleRuntimeEnabled()
  const access = await requireStudioBrandAccess(actor, input.brandProfileId)
  const project = await db.creativeProject.findUnique({ where: { id: input.projectId } })
  if (!project || project.brandProfileId !== access.brandProfileId || project.ownerId !== access.ownerId) {
    throw new LifecycleServiceError('project_scope_mismatch', 403)
  }
  const rows = await db.creativeLifecycleJob.findMany({
    where: {
      ownerId: access.ownerId,
      brandProfileId: access.brandProfileId,
      projectId: input.projectId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  return rows.map((row: Row) => serializeJob(row))
}

export async function controlLifecycleJob(
  actor: StudioActor,
  value: unknown,
): Promise<{ job: LifecycleJobView; idempotent: boolean }> {
  assertLifecycleRuntimeEnabled()
  const input = object(value)
  const jobId = text(input.jobId, 'lifecycle_job_id_required')
  const intent = String(input.intent ?? '').trim().toLowerCase()
  if (intent !== 'cancel' && intent !== 'retry') {
    throw new LifecycleServiceError('invalid_lifecycle_control_intent')
  }
  const idempotencyKey = text(input.idempotencyKey, 'idempotency_key_required', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(idempotencyKey)) {
    throw new LifecycleServiceError('idempotency_key_required')
  }
  const row = await db.creativeLifecycleJob.findUnique({ where: { id: jobId } })
  if (!row) throw new LifecycleServiceError('lifecycle_job_not_found', 404)
  const access = await requireStudioBrandAccess(actor, String(row.brandProfileId))
  if (access.ownerId !== row.ownerId) throw new LifecycleServiceError('lifecycle_job_scope_mismatch', 403)
  const project = await db.creativeProject.findUnique({ where: { id: String(row.projectId) } })
  if (
    !project
    || project.ownerId !== access.ownerId
    || project.brandProfileId !== access.brandProfileId
  ) throw new LifecycleServiceError('project_scope_mismatch', 403)
  assertStudioLifecycleCapability(access.role, intent)
  const requestFingerprint = lifecycleFingerprint({
    kind: 'creative_lifecycle_control_v1',
    jobId,
    intent,
    idempotencyKey,
    actorId: actor.userId,
    actorRole: access.role,
  })
  const prior = await db.creativeLifecycleAuditEvent.findUnique({
    where: { jobId_idempotencyKey: { jobId, idempotencyKey } },
  })
  if (prior) {
    if (prior.requestFingerprint !== requestFingerprint) {
      throw new LifecycleServiceError('idempotency_conflict', 409)
    }
    const current = await db.creativeLifecycleJob.findUnique({ where: { id: jobId } })
    return { job: serializeJob(current), idempotent: true }
  }

  let fromStatus: 'QUEUED' | 'RUNNING' | 'FAILED'
  let toStatus: 'CANCELED' | 'NEEDS_REVIEW' | 'QUEUED'
  let eventType: string
  if (intent === 'cancel') {
    if (row.status === 'CANCELED') {
      const winner = await db.creativeLifecycleAuditEvent.findUnique({
        where: { jobId_idempotencyKey: { jobId, idempotencyKey } },
      })
      if (winner?.requestFingerprint === requestFingerprint) {
        const current = await db.creativeLifecycleJob.findUnique({ where: { id: jobId } })
        return { job: serializeJob(current), idempotent: true }
      }
      throw new LifecycleServiceError('lifecycle_job_already_canceled', 409)
    }
    if (row.status !== 'QUEUED' && row.status !== 'RUNNING') {
      throw new LifecycleServiceError('lifecycle_job_not_cancelable', 409)
    }
    fromStatus = row.status
    toStatus = row.status === 'RUNNING' ? 'NEEDS_REVIEW' : 'CANCELED'
    eventType = row.status === 'RUNNING'
      ? 'running_cancel_quarantined'
      : 'job_canceled'
  } else {
    if (row.status === 'QUEUED') {
      const winner = await db.creativeLifecycleAuditEvent.findUnique({
        where: { jobId_idempotencyKey: { jobId, idempotencyKey } },
      })
      if (winner?.requestFingerprint === requestFingerprint) {
        const current = await db.creativeLifecycleJob.findUnique({ where: { id: jobId } })
        return { job: serializeJob(current), idempotent: true }
      }
    }
    if (row.status === 'NEEDS_REVIEW') {
      throw new LifecycleServiceError('ambiguous_job_requires_manual_reconciliation', 409)
    }
    if (row.status !== 'FAILED') {
      throw new LifecycleServiceError('lifecycle_job_not_retryable', 409)
    }
    fromStatus = 'FAILED'
    toStatus = 'QUEUED'
    eventType = 'job_retry_queued'
  }

  try {
    const updated = await serializableLifecycleTransaction(async (tx: Db) => {
      if (intent === 'retry') {
        const retryContext = await lifecycleContext(actor, {
          brandProfileId: row.brandProfileId,
          projectId: row.projectId,
          compositionId: row.compositionId,
          compositionVersionId: row.compositionVersionId,
          sourceArtifactVersionId: row.sourceArtifactVersionId,
          operationBatchId: row.operationBatchId,
          approvedReviewEventId: row.approvedReviewEventId,
        }, tx)
        await requireLifecycleFlag(
          retryContext,
          String(row.kind).toLowerCase() === 'export' ? 'export' : 'render',
          tx,
        )
      }
      const result = await tx.creativeLifecycleJob.updateMany({
        where: { id: jobId, status: fromStatus },
        data: {
          status: toStatus,
          progressCompleted: toStatus === 'QUEUED' ? 0 : row.progressCompleted,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: toStatus === 'NEEDS_REVIEW'
            ? 'cancel_requested_during_execution'
            : toStatus === 'CANCELED' ? 'owner_canceled_before_execution' : null,
          lastErrorMessage: toStatus === 'NEEDS_REVIEW'
            ? 'Cancellation arrived during execution; outcome is quarantined.'
            : null,
        },
      })
      if (result.count !== 1) throw new LifecycleServiceError('lifecycle_control_conflict', 409)
      await tx.creativeLifecycleAuditEvent.create({
        data: {
          jobId,
          actorId: actor.userId,
          actorRole: studioRoleToDb(access.role),
          idempotencyKey,
          requestFingerprint,
          eventType,
          fromStatus,
          toStatus,
          metadata: {
            ambiguous: toStatus === 'NEEDS_REVIEW',
            autoRetryAllowed: toStatus === 'QUEUED',
          },
        },
      })
      return tx.creativeLifecycleJob.findUnique({ where: { id: jobId } })
    })
    return { job: serializeJob(updated), idempotent: false }
  } catch (error) {
    if (
      object(error).code !== 'P2002'
      && !(error instanceof LifecycleServiceError && error.code === 'lifecycle_control_conflict')
    ) throw error
    const raced = await db.creativeLifecycleAuditEvent.findUnique({
      where: { jobId_idempotencyKey: { jobId, idempotencyKey } },
    })
    if (!raced || raced.requestFingerprint !== requestFingerprint) {
      throw new LifecycleServiceError('idempotency_conflict', 409)
    }
    const current = await db.creativeLifecycleJob.findUnique({ where: { id: jobId } })
    return { job: serializeJob(current), idempotent: true }
  }
}

async function validateLifecycleClaimPins(client: Db, row: Row): Promise<Row> {
  const composition = await client.creativeComposition.findUnique({
    where: { id: String(row.compositionId) },
  })
  const version = await client.creativeCompositionVersion.findUnique({
    where: { id: String(row.compositionVersionId) },
  })
  if (
    !composition
    || composition.archivedAt
    || composition.ownerId !== row.ownerId
    || composition.brandProfileId !== row.brandProfileId
    || composition.projectId !== row.projectId
    || Number(composition.currentVersion) !== Number(row.compositionVersion)
    || !version
    || version.compositionId !== row.compositionId
    || Number(version.version) !== Number(row.compositionVersion)
    || version.documentHash !== row.compositionDocumentHash
  ) throw new LifecycleServiceError('composition_version_evidence_mismatch', 409)

  const source = await client.creativeAssetVersion.findUnique({
    where: { id: String(row.sourceArtifactVersionId) },
    include: { asset: true },
  })
  const evidence = source ? immutableSourceEvidence(source) : null
  if (
    !source
    || source.asset?.projectId !== row.projectId
    || evidence?.storagePath !== row.sourceStoragePath
    || evidence?.checksum !== row.sourceChecksum
    || evidence?.sizeBytes !== Number(row.sourceBytes)
  ) throw new LifecycleServiceError('source_artifact_evidence_mismatch', 409)
  const authoritativeAsset = await client.creativeProjectAsset.findUnique({
    where: { id: String(source.assetId) },
    include: {
      versions: {
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
      reviewEvents: {
        where: { toState: 'APPROVED' },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
  })
  const latest = object(authoritativeAsset?.versions?.[0])
  if (
    !authoritativeAsset
    || authoritativeAsset.projectId !== row.projectId
    || latest.id !== row.sourceArtifactVersionId
  ) throw new LifecycleServiceError('source_artifact_version_stale', 409)
  const node = await client.creativeCompositionNode.findFirst({
    where: {
      compositionVersionId: row.compositionVersionId,
      assetVersionId: row.sourceArtifactVersionId,
    },
    select: { id: true },
  })
  if (!node) throw new LifecycleServiceError('composition_source_artifact_mismatch', 409)

  if (row.operationBatchId) {
    const batch = await client.creativeOperationBatch.findUnique({
      where: { id: String(row.operationBatchId) },
    })
    if (
      !batch
      || batch.compositionId !== row.compositionId
      || Number(batch.resultVersion) !== Number(row.compositionVersion)
    ) throw new LifecycleServiceError('operation_batch_scope_mismatch', 409)
  }

  if (row.approvedReviewEventId) {
    const approval = object(authoritativeAsset.reviewEvents?.[0])
    const expectedFingerprint = lifecycleFingerprint({
      reviewEventId: approval.id,
      assetVersionId: row.sourceArtifactVersionId,
      compositionId: row.compositionId,
      compositionVersionId: row.compositionVersionId,
      compositionVersion: row.compositionVersion,
      compositionDocumentHash: row.compositionDocumentHash,
    })
    if (
      authoritativeAsset.reviewState !== 'APPROVED'
      || approval.id !== row.approvedReviewEventId
      || approval.assetId !== source.assetId
      || approval.approvedArtifactVersionId !== row.sourceArtifactVersionId
      || approval.compositionId !== row.compositionId
      || approval.compositionVersionId !== row.compositionVersionId
      || Number(approval.compositionVersion) !== Number(row.compositionVersion)
      || approval.compositionDocumentHash !== row.compositionDocumentHash
      || row.approvedArtifactVersionId !== row.sourceArtifactVersionId
      || row.reviewFingerprint !== expectedFingerprint
    ) throw new LifecycleServiceError('review_event_invalidated', 409)
  } else if (row.kind === 'EXPORT') {
    throw new LifecycleServiceError('export_review_required', 409)
  }
  return version
}

export async function claimLifecycleJobs(input: {
  now?: Date
  limit?: number
  workerEnabled?: boolean
} = {}): Promise<LifecycleClaimView[]> {
  assertLifecycleRuntimeEnabled()
  if (input.workerEnabled !== true && process.env.STUDIO_LIFECYCLE_LOCAL_WORKER_ENABLED !== 'true') return []
  const now = input.now ?? new Date()
  const expired = await db.creativeLifecycleJob.findMany({
    where: { status: 'RUNNING', leaseExpiresAt: { lt: now } },
    take: 50,
  })
  for (const row of expired) {
    await db.$transaction(async (tx: Db) => {
      const quarantined = await tx.creativeLifecycleJob.updateMany({
        where: { id: row.id, status: 'RUNNING', leaseExpiresAt: { lt: now } },
        data: {
          status: 'NEEDS_REVIEW',
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: 'ambiguous_worker_interruption',
          lastErrorMessage: 'Worker lease expired; effect is quarantined and will not auto-retry.',
        },
      })
      if (quarantined.count !== 1) return
      await tx.creativeLifecycleAuditEvent.create({
        data: {
          jobId: row.id,
          actorId: row.createdById,
          actorRole: row.createdByRole,
          eventType: 'worker_lease_quarantined',
          fromStatus: 'RUNNING',
          toStatus: 'NEEDS_REVIEW',
          metadata: { reason: 'ambiguous_worker_interruption' },
        },
      })
    })
  }
  const rows = await db.creativeLifecycleJob.findMany({
    where: {
      status: 'QUEUED',
      effectClass: 'ZERO_COST_LOCAL',
      paidExecutionAllowed: false,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(10, input.limit ?? 5)),
  })
  const claimed: LifecycleClaimView[] = []
  for (const row of rows) {
    const leaseToken = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + 15 * 60_000)
    const outcome = await serializableLifecycleTransaction(async (tx: Db) => {
      const current = await tx.creativeLifecycleJob.findUnique({ where: { id: row.id } })
      if (!current || current.status !== 'QUEUED' || current.paidExecutionAllowed !== false) {
        return null
      }
      let version: Row
      try {
        version = await validateLifecycleClaimPins(tx, current)
      } catch (error) {
        const code = error instanceof LifecycleServiceError
          ? error.code
          : 'claim_evidence_invalid'
        const invalidated = await tx.creativeLifecycleJob.updateMany({
          where: { id: current.id, status: 'QUEUED', paidExecutionAllowed: false },
          data: {
            status: 'NEEDS_REVIEW',
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: code,
            lastErrorMessage: 'Authoritative lifecycle pins changed before worker execution.',
          },
        })
        if (invalidated.count === 1) {
          await tx.creativeLifecycleAuditEvent.create({
            data: {
              jobId: current.id,
              actorId: current.createdById,
              actorRole: current.createdByRole,
              eventType: 'claim_evidence_quarantined',
              fromStatus: 'QUEUED',
              toStatus: 'NEEDS_REVIEW',
              metadata: { reason: code },
            },
          })
        }
        return { quarantined: true as const }
      }
      const result = await tx.creativeLifecycleJob.updateMany({
        where: { id: current.id, status: 'QUEUED', paidExecutionAllowed: false },
        data: {
          status: 'RUNNING',
          progressCompleted: 1,
          attempts: { increment: 1 },
          leaseToken,
          leaseExpiresAt,
        },
      })
      if (result.count !== 1) return null
      await tx.creativeLifecycleAuditEvent.create({
        data: {
          jobId: current.id,
          actorId: current.createdById,
          actorRole: current.createdByRole,
          eventType: 'worker_claimed',
          fromStatus: 'QUEUED',
          toStatus: 'RUNNING',
          metadata: { leaseExpiresAt: leaseExpiresAt.toISOString() },
        },
      })
      return {
        quarantined: false as const,
        job: await tx.creativeLifecycleJob.findUnique({ where: { id: current.id } }),
        version,
      }
    })
    if (outcome && !outcome.quarantined && outcome.job) {
      const updated = outcome.job
      claimed.push({
        ...serializeJob(updated),
        leaseToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        renderProfile: String(updated.renderProfile),
        outputFormat: String(updated.outputFormat),
        rendererVersion: String(updated.rendererVersion),
        compositionDocument: outcome.version.document,
      })
    }
  }
  return claimed
}

export type LifecycleArtifactVerifier = (input: {
  storagePath: string
  checksum: string
  sizeBytes: number
}) => Promise<boolean>

export const verifyLifecycleArtifactFromStorage: LifecycleArtifactVerifier = async (input) => {
  const bytes = await downloadStorageObject('agent-files', input.storagePath)
  return bytes.length === input.sizeBytes
    && createHash('sha256').update(bytes).digest('hex') === input.checksum
}

export async function recordLifecycleWorkerResult(input: {
  jobId: string
  leaseToken: string
  outcome: 'ready' | 'failed'
  storagePath?: string
  checksum?: string
  sizeBytes?: number
  artifactVersionId?: string
  errorCode?: string
  errorMessage?: string
  ambiguousEffect?: boolean
  operationPackageChecksum?: string
  playableProxyPath?: string
  originalStoragePath?: string
  verifier?: LifecycleArtifactVerifier
}): Promise<LifecycleJobView> {
  assertLifecycleRuntimeEnabled()
  const row = await db.creativeLifecycleJob.findUnique({ where: { id: input.jobId } })
  if (!row) throw new LifecycleServiceError('lifecycle_job_not_found', 404)
  if (row.status === 'READY') {
    const receipt = await db.creativeLifecycleReceipt.findFirst({
      where: { jobId: row.id, status: 'READY' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (
      input.outcome === 'ready'
      && row.resultChecksum === input.checksum
      && row.resultArtifactVersionId
      && row.resultStoragePath
      && row.verifiedAt
      && receipt?.artifactVersionId === row.resultArtifactVersionId
      && receipt.storagePath === row.resultStoragePath
      && receipt.checksum === row.resultChecksum
      && receipt.artifactVerified === true
    ) return serializeJob(row)
    throw new LifecycleServiceError(
      receipt ? 'lifecycle_result_conflict' : 'lifecycle_ready_evidence_incomplete',
      409,
    )
  }
  if (row.status !== 'RUNNING' || row.leaseToken !== input.leaseToken) {
    throw new LifecycleServiceError('lifecycle_lease_conflict', 409)
  }
  let nextStatus: 'READY' | 'FAILED' | 'NEEDS_REVIEW'
  let artifactVerified = false
  let errorCode = input.errorCode ?? null
  if (input.outcome === 'ready') {
    if (input.artifactVersionId) {
      throw new LifecycleServiceError('worker_artifact_identity_not_authoritative', 409)
    }
    const storagePath = text(input.storagePath, 'result_storage_path_required', 2_000)
    const checksum = text(input.checksum, 'result_checksum_required', 128)
    const sizeBytes = Number(input.sizeBytes)
    if (!/^[a-f0-9]{64}$/.test(checksum) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new LifecycleServiceError('invalid_artifact_receipt')
    }
    if (!/^[a-f0-9]{64}$/.test(String(input.operationPackageChecksum ?? ''))) {
      throw new LifecycleServiceError('operation_package_checksum_required')
    }
    try {
      artifactVerified = await (input.verifier ?? verifyLifecycleArtifactFromStorage)({
        storagePath,
        checksum,
        sizeBytes,
      })
    } catch {
      artifactVerified = false
    }
    nextStatus = artifactVerified ? 'READY' : 'FAILED'
    if (!artifactVerified) errorCode = 'artifact_verification_failed'
  } else {
    nextStatus = input.ambiguousEffect ? 'NEEDS_REVIEW' : 'FAILED'
    if (!errorCode) errorCode = input.ambiguousEffect ? 'ambiguous_worker_effect' : 'render_failed'
  }
  const updated = await serializableLifecycleTransaction(async (tx: Db) => {
    let resultArtifactVersionId: string | null = null
    let originalStoragePath = input.originalStoragePath ?? null
    if (artifactVerified) {
      const sourceArtifactVersion = await tx.creativeAssetVersion.findUnique({
        where: { id: String(row.sourceArtifactVersionId) },
        include: { asset: true },
      })
      const sourceAsset = object(sourceArtifactVersion?.asset)
      const authoritativeAsset = sourceArtifactVersion
        ? await tx.creativeProjectAsset.findUnique({
            where: { id: String(sourceArtifactVersion.assetId) },
            include: {
              versions: {
                orderBy: [{ version: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
              },
              reviewEvents: {
                where: { toState: 'APPROVED' },
                orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
              },
            },
          })
        : null
      const actualLatestVersion = Array.isArray(authoritativeAsset?.versions)
        ? object(authoritativeAsset.versions[0])
        : {}
      const actualApproval = Array.isArray(authoritativeAsset?.reviewEvents)
        ? object(authoritativeAsset.reviewEvents[0])
        : {}
      if (
        !sourceArtifactVersion
        || !authoritativeAsset
        || String(sourceAsset.projectId) !== String(row.projectId)
        || String(authoritativeAsset.projectId) !== String(row.projectId)
        || String(actualLatestVersion.id) !== String(row.sourceArtifactVersionId)
        || (
          row.approvedReviewEventId
          && (
            String(authoritativeAsset.reviewState).toUpperCase() !== 'APPROVED'
            || String(actualApproval.id) !== String(row.approvedReviewEventId)
            || String(actualApproval.approvedArtifactVersionId) !== String(row.sourceArtifactVersionId)
            || String(actualApproval.compositionId) !== String(row.compositionId)
            || String(actualApproval.compositionVersionId) !== String(row.compositionVersionId)
            || Number(actualApproval.compositionVersion) !== Number(row.compositionVersion)
            || String(actualApproval.compositionDocumentHash) !== String(row.compositionDocumentHash)
          )
        )
      ) throw new LifecycleServiceError('result_approval_or_source_invalidated', 409)
      const [sourceNode, operationBatch, project] = await Promise.all([
        tx.creativeCompositionNode.findFirst({
          where: {
            compositionVersionId: String(row.compositionVersionId),
            assetVersionId: String(row.sourceArtifactVersionId),
          },
          select: { id: true },
        }),
        row.operationBatchId
          ? tx.creativeOperationBatch.findUnique({ where: { id: String(row.operationBatchId) } })
          : Promise.resolve(null),
        tx.creativeProject.findUnique({ where: { id: String(row.projectId) } }),
      ])
      if (
        !sourceNode
        || !project
        || String(project.ownerId) !== String(row.ownerId)
        || String(project.brandProfileId) !== String(row.brandProfileId)
        || (
          row.operationBatchId
          && (
            !operationBatch
            || operationBatch.compositionId !== row.compositionId
            || Number(operationBatch.resultVersion) !== Number(row.compositionVersion)
          )
        )
      ) throw new LifecycleServiceError('result_relational_lineage_mismatch', 409)
      originalStoragePath = input.originalStoragePath
        ?? (typeof sourceArtifactVersion.storagePath === 'string'
          ? sourceArtifactVersion.storagePath
          : null)
      const operationPackageChecksum = String(input.operationPackageChecksum)
      const renderStoragePath = String(input.storagePath)
      const outputAsset = await tx.creativeProjectAsset.create({
        data: {
          projectId: row.projectId,
          assetType: ['mp4', 'mov', 'webm'].includes(String(row.outputFormat).toLowerCase())
            ? 'video'
            : ['mp3', 'wav', 'm4a'].includes(String(row.outputFormat).toLowerCase())
              ? 'audio'
              : String(row.outputFormat).toLowerCase() === 'json' ? 'document' : 'image',
          title: `${String(row.kind).toLowerCase()} ${String(row.compositionId)} v${Number(row.compositionVersion)}`,
          folder: 'Lifecycle',
          latestStoragePath: input.storagePath,
          createdById: row.createdById,
        },
      })
      const outputVersion = await tx.creativeAssetVersion.create({
        data: {
          assetId: outputAsset.id,
          version: 1,
          storagePath: input.storagePath,
          provider: 'lifecycle_local',
          engine: row.rendererVersion,
          jobId: row.id,
          costBdt: Number(row.estimatedCostBdt ?? 0),
          metadata: {
            checksumSha256: input.checksum,
            byteSize: input.sizeBytes,
            outputFormat: row.outputFormat,
            lifecycle: {
              jobId: row.id,
              ownerId: row.ownerId,
              brandProfileId: row.brandProfileId,
              projectId: row.projectId,
              compositionId: row.compositionId,
              compositionVersionId: row.compositionVersionId,
              compositionVersion: row.compositionVersion,
              compositionDocumentHash: row.compositionDocumentHash,
              operationBatchId: row.operationBatchId ?? null,
              sourceArtifactVersionId: row.sourceArtifactVersionId,
              approvedReviewEventId: row.approvedReviewEventId ?? null,
              approvedArtifactVersionId: row.approvedArtifactVersionId ?? null,
              reviewFingerprint: row.reviewFingerprint ?? null,
              renderFingerprint: row.renderFingerprint,
              operationPackageChecksum,
              playableProxyPath: input.playableProxyPath ?? null,
              originalStoragePath,
              renderStoragePath,
            },
          },
          createdById: row.createdById,
        },
      })
      resultArtifactVersionId = String(outputVersion.id)
      await tx.creativeAssetLineage.create({
        data: {
          versionId: resultArtifactVersionId,
          sourceAssetId: String(sourceArtifactVersion.assetId),
          relationKind: `lifecycle_${String(row.kind).toLowerCase()}`,
        },
      })
    }
    const result = await tx.creativeLifecycleJob.updateMany({
      where: { id: row.id, status: 'RUNNING', leaseToken: input.leaseToken },
      data: {
        status: nextStatus,
        progressCompleted: nextStatus === 'READY' ? row.progressTotal : row.progressCompleted,
        leaseToken: null,
        leaseExpiresAt: null,
        resultStoragePath: artifactVerified ? input.storagePath : null,
        resultChecksum: artifactVerified ? input.checksum : null,
        resultBytes: artifactVerified ? BigInt(input.sizeBytes!) : null,
        resultArtifactVersionId,
        verifiedAt: artifactVerified ? new Date() : null,
        lastErrorCode: nextStatus === 'READY' ? null : errorCode,
        lastErrorMessage: nextStatus === 'READY' ? null : input.errorMessage ?? errorCode,
      },
    })
    if (result.count !== 1) throw new LifecycleServiceError('lifecycle_lease_conflict', 409)
    await tx.creativeLifecycleReceipt.create({
      data: {
        jobId: row.id,
        status: nextStatus,
        storagePath: input.storagePath ?? null,
        checksum: input.checksum ?? null,
        sizeBytes: input.sizeBytes ? BigInt(input.sizeBytes) : null,
        artifactVerified,
        artifactVersionId: resultArtifactVersionId,
        compositionDocumentHash: row.compositionDocumentHash,
        operationPackageChecksum: input.operationPackageChecksum ?? null,
        playableProxyPath: input.playableProxyPath ?? null,
        originalStoragePath,
        renderStoragePath: input.storagePath ?? null,
        metadata: { errorCode, ambiguousEffect: input.ambiguousEffect === true },
      },
    })
    await tx.creativeLifecycleAuditEvent.create({
      data: {
        jobId: row.id,
        actorId: row.createdById,
        actorRole: row.createdByRole,
        eventType: nextStatus === 'READY' ? 'artifact_verified' : nextStatus === 'NEEDS_REVIEW' ? 'effect_quarantined' : 'job_failed',
        fromStatus: 'RUNNING',
        toStatus: nextStatus,
        metadata: { artifactVerified, errorCode, resultArtifactVersionId },
      },
    })
    return tx.creativeLifecycleJob.findUnique({ where: { id: row.id } })
  })
  return serializeJob(updated)
}

export async function getLifecycleOperations(
  actor: StudioActor,
  input: { brandProfileId: string; projectId: string },
) {
  assertLifecycleRuntimeEnabled()
  const jobs = await listLifecycleJobs(actor, input)
  const now = Date.now()
  const queued = jobs.filter((job) => job.status === 'queued')
  return toStudioLifecycleOperationsView({
    queuedJobs: queued.length,
    oldestJobAgeMinutes: queued.length
      ? Math.max(...queued.map((job) => Math.floor((now - new Date(job.createdAt).getTime()) / 60_000)))
      : 0,
    providerBalanceBdt: null,
    workerHeartbeatAgeMinutes: null,
    artifactsPendingVerification: jobs.filter((job) => job.status === 'running').length,
  })
}

export async function getLifecycleRolloutDecision(
  actor: StudioActor,
  input: {
    brandProfileId: string
    projectId: string
    capability: StudioLifecycleFlagScope['capability']
  },
) {
  assertLifecycleRuntimeEnabled()
  const access = await requireStudioBrandAccess(actor, input.brandProfileId)
  const project = await db.creativeProject.findUnique({ where: { id: input.projectId } })
  if (
    !project
    || project.ownerId !== access.ownerId
    || project.brandProfileId !== access.brandProfileId
  ) throw new LifecycleServiceError('project_scope_mismatch', 403)
  const rows = await db.creativeLifecycleFeatureFlag.findMany({
    where: {
      ownerId: access.ownerId,
      capability: input.capability,
      OR: [{ brandProfileId: null }, { brandProfileId: access.brandProfileId }],
    },
  })
  return evaluateStudioLifecycleRollout({
    scope: {
      ownerId: access.ownerId,
      brandProfileId: access.brandProfileId,
      projectId: input.projectId,
      role: access.role,
      capability: input.capability,
    },
    flags: rows.map((row: Row) => dbScopedFlag(row)),
  })
}

export function createStudioFoundationLifecyclePort(
  actor: StudioActor,
): StudioFoundationLifecyclePort {
  return {
    async getCompositionPin({ compositionId, actorId, artifactVersionId }) {
      if (actorId !== actor.userId) throw new LifecycleServiceError('lifecycle_actor_mismatch', 403)
      const composition = await db.creativeComposition.findUnique({ where: { id: compositionId } })
      if (!composition || composition.archivedAt) throw new LifecycleServiceError('composition_not_found', 404)
      await requireStudioBrandAccess(actor, String(composition.brandProfileId))
      const version = await db.creativeCompositionVersion.findUnique({
        where: {
          compositionId_version: {
            compositionId,
            version: Number(composition.currentVersion),
          },
        },
      })
      if (!version) throw new LifecycleServiceError('composition_version_missing', 500)
      const nodes = await db.creativeCompositionNode.findMany({
        where: {
          compositionVersionId: version.id,
          assetVersionId: { not: null },
        },
        select: { assetVersionId: true },
      })
      const candidates = [...new Set(
        nodes
          .map((node: Row) => typeof node.assetVersionId === 'string' ? node.assetVersionId : null)
          .filter((value: string | null): value is string => Boolean(value)),
      )]
      const targetVersionId = artifactVersionId
        ? text(artifactVersionId, 'artifact_version_id_required')
        : candidates.length === 1
          ? candidates[0]
          : null
      if (!targetVersionId || !candidates.includes(targetVersionId)) {
        throw new LifecycleServiceError('composition_artifact_target_required', 409)
      }
      const artifactVersion = await db.creativeAssetVersion.findUnique({
        where: { id: targetVersionId },
        include: {
          asset: {
            include: {
              project: true,
              reviewEvents: {
                where: { toState: 'APPROVED' },
                orderBy: [{ sequence: 'desc' }],
                take: 1,
              },
            },
          },
        },
      })
      if (
        !artifactVersion
        || artifactVersion.asset?.projectId !== composition.projectId
        || artifactVersion.asset?.project?.brandProfileId !== composition.brandProfileId
      ) throw new LifecycleServiceError('artifact_scope_mismatch', 403)
      const event = artifactVersion.asset.reviewEvents?.[0] ?? null
      return {
        compositionId,
        compositionVersionId: String(version.id),
        compositionVersion: Number(version.version),
        artifactId: String(artifactVersion.asset.id),
        artifactVersionId: String(artifactVersion.id),
        artifactChecksum: artifactIdentity(artifactVersion),
        reviewEventId: event ? String(event.id) : '',
        approvedVersionId: event?.approvedArtifactVersionId
          ? String(event.approvedArtifactVersionId)
          : String(object(event?.metadata).approvedVersionId ?? ''),
        campaignPackId: null,
        batchId: typeof version.operationBatchId === 'string' ? version.operationBatchId : null,
      }
    },
    async getReviewSnapshot({ artifactId, actorId }) {
      if (actorId !== actor.userId) throw new LifecycleServiceError('lifecycle_actor_mismatch', 403)
      const asset = await db.creativeProjectAsset.findUnique({
        where: { id: artifactId },
        include: {
          project: true,
          versions: { orderBy: [{ version: 'desc' }], take: 1 },
          reviewEvents: { where: { toState: 'APPROVED' }, orderBy: [{ sequence: 'desc' }], take: 1 },
        },
      })
      if (!asset) throw new LifecycleServiceError('asset_not_found', 404)
      await requireStudioBrandAccess(actor, String(asset.project?.brandProfileId ?? ''))
      const version = asset.versions?.[0]
      const event = asset.reviewEvents?.[0]
      if (!version || !event) {
        return {
          assetId: artifactId,
          state: 'draft',
          latestVersionId: version ? String(version.id) : '',
          approvedReviewEventId: null,
          approvedVersionId: null,
          approvedCompositionId: null,
          approvedCompositionVersionId: null,
        }
      }
      return reviewSnapshot(event, artifactId, String(version.id), asset.reviewState)
    },
  }
}

export function lifecycleServiceErrorResponse(error: unknown, event: string): Response {
  if (error instanceof StudioLifecycleError) {
    return Response.json({ error: error.code }, { status: error.status })
  }
  if (error instanceof LifecycleServiceError) {
    return Response.json({ error: error.code, details: error.details }, { status: error.status })
  }
  console.error(`[${event}] failed`, error)
  return Response.json({ error: 'creative_lifecycle_failed' }, { status: 500 })
}
