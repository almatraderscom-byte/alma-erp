import {
  assertLifecycleReviewPin,
  assertStudioLifecycleCapability,
  buildStudioRenderFingerprint,
  lifecycleFingerprint,
  normalizeLifecycleScheduleAt,
  StudioLifecycleError,
  type StudioCompositionPin,
  type StudioLifecycleCapability,
  type StudioLifecycleMode,
  type StudioLifecycleRole,
  type StudioReviewSnapshot,
} from './lifecycle-contract'

/** Foundation supplies this snapshot later; no Foundation model is imported here. */
export interface StudioFoundationLifecyclePort {
  getCompositionPin(input: {
    compositionId: string
    actorId: string
    artifactVersionId?: string
  }): Promise<StudioCompositionPin>
  getReviewSnapshot(input: { artifactId: string; actorId: string }): Promise<StudioReviewSnapshot>
}

export type StudioLifecycleIntent = {
  mode: StudioLifecycleMode
  composition: StudioCompositionPin
  fingerprint: string
  externalEffect: boolean
  paidAction: boolean
  scheduleAt: string | null
  executionGate: {
    requiresOwnerAcknowledgement: boolean
    ownerAcknowledged: boolean
    executionAllowed: false
  }
}

export type StudioLifecycleServerReceipt = {
  kind: 'scheduled' | 'published'
  intentFingerprint: string
  compositionVersionId: string
  artifactVersionId: string
  verifiedAt: string
  externalObjectId?: string | null
}

const MODE_CAPABILITY: Record<StudioLifecycleMode, StudioLifecycleCapability> = {
  preview: 'preview',
  render: 'render',
  export: 'export',
  dry_run: 'dry_run',
  schedule: 'schedule',
  live_publish: 'live_publish',
}

export async function createStudioLifecycleIntent(input: {
  foundation: StudioFoundationLifecyclePort
  actorId: string
  role: StudioLifecycleRole
  compositionId: string
  artifactVersionId?: string
  mode: StudioLifecycleMode
  renderProfile?: string
  outputFormat?: string
  rendererVersion?: string
  scheduleAt?: string
  ownerAcknowledged?: boolean
}): Promise<StudioLifecycleIntent> {
  assertStudioLifecycleCapability(input.role, MODE_CAPABILITY[input.mode])
  const composition = await input.foundation.getCompositionPin({
    compositionId: input.compositionId,
    actorId: input.actorId,
    artifactVersionId: input.artifactVersionId,
  })
  const executionMode = input.mode === 'schedule' || input.mode === 'live_publish'
  if (executionMode && input.ownerAcknowledged !== true) {
    throw new StudioLifecycleError('owner_execution_acknowledgement_required', 409)
  }
  const scheduleAt = input.mode === 'schedule'
    ? normalizeLifecycleScheduleAt(input.scheduleAt)
    : null
  if (executionMode || input.mode === 'dry_run') {
    const review = await input.foundation.getReviewSnapshot({ artifactId: composition.artifactId, actorId: input.actorId })
    assertLifecycleReviewPin(composition, review)
  }
  const render = input.mode === 'render' || input.mode === 'export'
  const fingerprint = render
    ? buildStudioRenderFingerprint({
        pin: composition,
        renderProfile: input.renderProfile ?? 'default',
        outputFormat: input.outputFormat ?? 'mp4',
        rendererVersion: input.rendererVersion ?? 'unwired-foundation',
      })
    : lifecycleFingerprint({
        kind: `studio_${input.mode}_v3`,
        compositionId: composition.compositionId,
        compositionVersionId: composition.compositionVersionId,
        artifactVersionId: composition.artifactVersionId,
        reviewEventId: composition.reviewEventId,
        campaignPackId: composition.campaignPackId,
        scheduleAt,
      })
  return {
    mode: input.mode,
    composition,
    fingerprint,
    externalEffect: input.mode === 'live_publish',
    paidAction: input.mode === 'render' || input.mode === 'export' || input.mode === 'live_publish',
    scheduleAt,
    executionGate: {
      requiresOwnerAcknowledgement: executionMode,
      ownerAcknowledged: executionMode,
      // This boundary cannot execute a command. Foundation and the existing
      // CSE7 owner-gated delivery service must independently admit it later.
      executionAllowed: false,
    },
  }
}

/** A typed, UI-safe view model; Studio desks decide presentation themselves. */
export function toStudioLifecycleView(intent: StudioLifecycleIntent, input: {
  receipt?: StudioLifecycleServerReceipt | null
} = {}) {
  const receipt = input.receipt
  const receiptTime = receipt?.verifiedAt ? new Date(receipt.verifiedAt).getTime() : Number.NaN
  const receiptKindMatchesMode = Boolean(
    receipt && (
      (intent.mode === 'schedule' && receipt.kind === 'scheduled')
      || (intent.mode === 'live_publish' && receipt.kind === 'published')
    ),
  )
  const receiptMatchesIntent = Boolean(
    receipt
    && receiptKindMatchesMode
    && Number.isFinite(receiptTime)
    && receipt.intentFingerprint === intent.fingerprint
    && receipt.compositionVersionId === intent.composition.compositionVersionId
    && receipt.artifactVersionId === intent.composition.artifactVersionId
    && (receipt.kind !== 'published' || Boolean(receipt.externalObjectId)),
  )
  const status = receiptMatchesIntent
    ? receipt!.kind === 'published' ? 'published' : 'scheduled'
    : 'planned'
  const reason = !receipt
    ? 'intent_not_executed'
    : !receiptKindMatchesMode
      ? 'receipt_kind_not_valid_for_intent'
      : !Number.isFinite(receiptTime)
        ? 'receipt_not_verified'
        : receipt.intentFingerprint !== intent.fingerprint
          || receipt.compositionVersionId !== intent.composition.compositionVersionId
          || receipt.artifactVersionId !== intent.composition.artifactVersionId
          ? 'receipt_identity_mismatch'
          : receipt.kind === 'published' && !receipt.externalObjectId
            ? 'receipt_external_object_missing'
            : 'verified_server_receipt'
  return {
    mode: intent.mode,
    compositionId: intent.composition.compositionId,
    compositionVersionId: intent.composition.compositionVersionId,
    artifactVersionId: intent.composition.artifactVersionId,
    campaignPackId: intent.composition.campaignPackId,
    fingerprint: intent.fingerprint,
    externalEffect: intent.externalEffect,
    paidAction: intent.paidAction,
    scheduleAt: intent.scheduleAt,
    executionGate: intent.executionGate,
    status,
    receiptVerified: receiptMatchesIntent,
    receiptKind: receiptMatchesIntent ? receipt!.kind : null,
    retryAllowed: false,
    reason,
  }
}
