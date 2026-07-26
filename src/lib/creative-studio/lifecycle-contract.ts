import { createHash } from 'node:crypto'

/**
 * V3 lifecycle contracts deliberately sit outside the Foundation composition
 * schema. Foundation supplies an immutable snapshot through a narrow port; this
 * layer can then prove what was reviewed, rendered, scheduled, and attributed.
 */
export type StudioLifecycleMode = 'preview' | 'render' | 'export' | 'dry_run' | 'schedule' | 'live_publish'
export type StudioLifecycleStatus =
  | 'planned'
  | 'rendering'
  | 'ready'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'canceled'
  | 'failed_retryable'
  | 'needs_review'

export type StudioLifecycleRole = 'owner' | 'creator' | 'reviewer'
export type StudioLifecycleCapability =
  | 'preview'
  | 'render'
  | 'export'
  | 'dry_run'
  | 'schedule'
  | 'live_publish'
  | 'cancel'
  | 'retry'
  | 'inspect_operations'

export type StudioCompositionPin = {
  compositionId: string
  compositionVersionId: string
  compositionVersion: number
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  reviewEventId: string
  approvedVersionId: string
  campaignPackId: string | null
  batchId: string | null
}

export type StudioReviewSnapshot = {
  assetId: string
  state: 'draft' | 'changes_requested' | 'approved'
  latestVersionId: string
  approvedReviewEventId: string | null
  approvedVersionId: string | null
  approvedCompositionId: string | null
  approvedCompositionVersionId: string | null
}

export type StudioRenderProgress = {
  stage: 'queued' | 'composing' | 'rendering' | 'uploading' | 'complete' | 'failed'
  completedSteps: number
  totalSteps: number
  terminal: boolean
  message: string
}

export type StudioArchiveManifest = {
  compositionId: string
  compositionVersionId: string
  compositionVersion: number
  compositionDocumentHash: string
  operationBatchId: string | null
  operationPackageChecksum: string
  artifactVersionId: string
  artifactChecksum: string
  archiveChecksum: string
  fetchBackChecksum: string
  storagePath: string
  playableProxyPath: string | null
  originalStoragePath: string
  renderStoragePath: string
  driveFileId: string
  fetchedBackAt: string | null
  verifiedAt: string | null
}

export class StudioLifecycleError extends Error {
  constructor(readonly code: string, readonly status = 422) {
    super(code)
  }
}

function nonEmpty(value: string, code: string): string {
  const clean = value.trim()
  if (!clean) throw new StudioLifecycleError(code)
  return clean
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`
}

export function lifecycleFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export function assertStudioLifecycleCapability(
  role: StudioLifecycleRole,
  capability: StudioLifecycleCapability,
): void {
  const allowed: Record<StudioLifecycleRole, readonly StudioLifecycleCapability[]> = {
    owner: ['preview', 'render', 'export', 'dry_run', 'schedule', 'live_publish', 'cancel', 'retry', 'inspect_operations'],
    creator: ['preview', 'render', 'export'],
    reviewer: ['preview'],
  }
  if (!allowed[role].includes(capability)) {
    throw new StudioLifecycleError('studio_lifecycle_forbidden', 403)
  }
}

/** Approval is bound to the exact rendered artifact version, not a mutable asset. */
export function assertLifecycleReviewPin(
  pin: StudioCompositionPin,
  review: StudioReviewSnapshot,
): void {
  if (review.assetId !== pin.artifactId) throw new StudioLifecycleError('review_asset_mismatch', 409)
  if (review.state !== 'approved') throw new StudioLifecycleError('review_not_approved', 409)
  if (!review.approvedReviewEventId || review.approvedReviewEventId !== pin.reviewEventId) {
    throw new StudioLifecycleError('review_event_invalidated', 409)
  }
  if (review.approvedVersionId !== pin.artifactVersionId || review.latestVersionId !== pin.artifactVersionId) {
    throw new StudioLifecycleError('review_version_invalidated', 409)
  }
  if (
    review.approvedCompositionId !== pin.compositionId
    || review.approvedCompositionVersionId !== pin.compositionVersionId
  ) {
    throw new StudioLifecycleError('review_composition_version_invalidated', 409)
  }
  if (pin.approvedVersionId !== pin.artifactVersionId) {
    throw new StudioLifecycleError('composition_approval_pin_invalid', 409)
  }
}

export function normalizeLifecycleScheduleAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StudioLifecycleError('schedule_at_required')
  }
  // ISO 8601 with an explicit UTC designator or offset; Date alone accepts too
  // many implementation-defined values to be a lifecycle contract.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) {
    throw new StudioLifecycleError('schedule_at_invalid')
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]),
    match[8] == null ? 0 : Number(match[8]), match[9] == null ? 0 : Number(match[9]),
  ]
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (
    calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) throw new StudioLifecycleError('schedule_at_invalid')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new StudioLifecycleError('schedule_at_invalid')
  return parsed.toISOString()
}

export function buildStudioRenderFingerprint(input: {
  pin: StudioCompositionPin
  renderProfile: string
  outputFormat: string
  rendererVersion: string
}): string {
  return lifecycleFingerprint({
    kind: 'studio_render_v3',
    compositionId: nonEmpty(input.pin.compositionId, 'composition_id_required'),
    compositionVersionId: nonEmpty(input.pin.compositionVersionId, 'composition_version_required'),
    artifactVersionId: nonEmpty(input.pin.artifactVersionId, 'artifact_version_required'),
    artifactChecksum: nonEmpty(input.pin.artifactChecksum, 'artifact_checksum_required'),
    renderProfile: nonEmpty(input.renderProfile, 'render_profile_required'),
    outputFormat: nonEmpty(input.outputFormat, 'output_format_required'),
    rendererVersion: nonEmpty(input.rendererVersion, 'renderer_version_required'),
  })
}

export function renderProgress(input: {
  stage: StudioRenderProgress['stage']
  completedSteps: number
  totalSteps: number
  error?: string | null
}): StudioRenderProgress {
  const totalSteps = Math.max(1, Math.floor(input.totalSteps))
  const terminal = input.stage === 'complete' || input.stage === 'failed'
  const completedSteps = terminal && input.stage === 'complete'
    ? totalSteps
    : Math.max(0, Math.min(totalSteps - 1, Math.floor(input.completedSteps)))
  return {
    stage: input.stage,
    completedSteps,
    totalSteps,
    terminal,
    message: input.stage === 'failed'
      ? (input.error?.trim() || 'render_failed')
      : input.stage === 'complete'
        ? 'render_complete'
        : `${input.stage}:${completedSteps}/${totalSteps}`,
  }
}

export function lifecycleExternalEffectDecision(input: {
  providerConfirmedNoEffect?: boolean
  externalObjectId?: string | null
  verified?: boolean
  canceled?: boolean
}): { status: StudioLifecycleStatus; retryAllowed: boolean; reason: string } {
  if (input.canceled) return { status: 'canceled', retryAllowed: false, reason: 'owner_canceled_before_effect' }
  if (input.externalObjectId || input.verified) {
    return input.verified
      ? { status: 'published', retryAllowed: false, reason: 'verified_external_receipt' }
      : { status: 'needs_review', retryAllowed: false, reason: 'ambiguous_external_effect' }
  }
  if (input.providerConfirmedNoEffect) {
    return { status: 'failed_retryable', retryAllowed: true, reason: 'provider_confirmed_no_effect' }
  }
  return { status: 'needs_review', retryAllowed: false, reason: 'ambiguous_external_effect' }
}

export function assertArchiveFetchBackManifest(manifest: StudioArchiveManifest): void {
  if (!manifest.fetchedBackAt || !manifest.verifiedAt) {
    throw new StudioLifecycleError('archive_fetch_back_required', 409)
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.artifactChecksum)
    || manifest.artifactChecksum !== manifest.archiveChecksum
    || manifest.artifactChecksum !== manifest.fetchBackChecksum
  ) {
    throw new StudioLifecycleError('archive_checksum_mismatch', 409)
  }
  if (
    !manifest.driveFileId
    || !manifest.storagePath
    || !manifest.compositionId
    || !manifest.compositionVersionId
    || !Number.isInteger(manifest.compositionVersion)
    || manifest.compositionVersion < 1
    || !/^[a-f0-9]{64}$/.test(manifest.compositionDocumentHash)
    || !/^[a-f0-9]{64}$/.test(manifest.operationPackageChecksum)
  ) {
    throw new StudioLifecycleError('archive_receipt_incomplete', 409)
  }
  const lineage = [
    manifest.originalStoragePath,
    manifest.renderStoragePath,
    manifest.playableProxyPath,
  ].filter((path): path is string => Boolean(path))
  if (!lineage.includes(manifest.storagePath) || !manifest.originalStoragePath || !manifest.renderStoragePath) {
    throw new StudioLifecycleError('archive_lineage_incomplete', 409)
  }
}
