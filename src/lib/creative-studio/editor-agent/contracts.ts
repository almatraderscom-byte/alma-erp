import type { StudioReferenceContract } from '@/lib/creative-studio/advanced-image-capabilities'
import type { StudioArtifactDescriptor } from '@/lib/creative-studio/artifact-metadata'
import type { StudioEngineId } from '@/lib/creative-studio/provider-registry'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'

export const EDITOR_AGENT_CONTRACT_VERSION = 1 as const

export type EditorActor = {
  userId: string
  name: string
  role: StudioAccessRole
}

export type EditorCompositionScope = {
  brandProfileId: string
  projectId: string
  compositionId: string
}

export type EditorCanvas = {
  aspectRatio: '4:5' | '1:1' | '9:16' | '16:9'
  width: number
  height: number
  durationSec: number
  safeZone: boolean
  background: string
}

export type EditorTransform = {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export type EditorTrackKind =
  | 'video'
  | 'overlay'
  | 'caption'
  | 'voice'
  | 'music'
  | 'sfx'

export type EditorClipKind = 'video' | 'image' | 'caption' | 'voice' | 'music' | 'sfx'

export type EditorAssetReference = {
  assetId: string
  assetVersionId: string
  title: string
  mediaType: EditorClipKind
  previewUrl: string | null
  storagePath: string | null
  status: 'draft' | 'qc_failed' | 'ready' | 'approved' | 'archived'
  provider: string | null
  engine: string | null
  recipeVersion: number | null
  costBdt: number | null
  qcLabel: string | null
  artifact: StudioArtifactDescriptor | null
  referenceContract: StudioReferenceContract | null
}

export type EditorClip = {
  id: string
  trackId: string
  kind: EditorClipKind
  label: string
  startSec: number
  endSec: number
  sourceStartSec: number
  sourceEndSec: number
  assetId: string | null
  assetVersionId: string | null
  text: string | null
  volume: number
  transform: EditorTransform
  locked: boolean
  status: 'local' | 'queued' | 'running' | 'ready' | 'failed' | 'needs_review'
}

export type EditorTrack = {
  id: string
  kind: EditorTrackKind
  label: string
  muted: boolean
  locked: boolean
  clips: EditorClip[]
}

export type EditorReviewSummary = {
  state: 'draft' | 'changes_requested' | 'revised' | 'approved'
  approvedVersion: number | null
  publishReady: boolean
  openComments: number
}

export type EditorActivityEntry = {
  id: string
  kind: 'edit' | 'undo' | 'redo' | 'rollback' | 'review' | 'system'
  actorName: string
  summary: string
  version: number
  createdAt: string
  operationIds: string[]
}

/**
 * Presentation projection only. The Foundation composition document remains
 * authoritative; this shape deliberately contains no provider request payload.
 */
export type EditorCompositionSnapshot = {
  contractVersion: typeof EDITOR_AGENT_CONTRACT_VERSION
  scope: EditorCompositionScope
  name: string
  brandName: string
  projectName: string
  recipeName: string | null
  recipeVersion: number | null
  productCode: string | null
  productName: string | null
  version: number
  concurrencyToken: string
  canvas: EditorCanvas
  tracks: EditorTrack[]
  assets: EditorAssetReference[]
  review: EditorReviewSummary
  activity: EditorActivityEntry[]
  canUndo: boolean
  canRedo: boolean
}

export type EditorOperationTarget = {
  trackId: string
  clipId?: string
}

type EditorLocalOperationBase = {
  id: string
  label: string
  effect: 'local_reversible'
  estimatedCostBdt: 0
  requiredRole: 'owner' | 'creator'
  target: EditorOperationTarget
}

export type EditorCaptionTextOperation = EditorLocalOperationBase & {
  kind: 'caption.text.set'
  before: string
  after: string
}

export type EditorCaptionTimingOperation = EditorLocalOperationBase & {
  kind: 'caption.timing.set'
  before: { startSec: number; endSec: number }
  after: { startSec: number; endSec: number }
}

export type EditorClipTrimOperation = EditorLocalOperationBase & {
  kind: 'clip.trim'
  before: {
    startSec: number
    endSec: number
    sourceStartSec: number
    sourceEndSec: number
  }
  after: {
    startSec: number
    endSec: number
    sourceStartSec: number
    sourceEndSec: number
  }
}

export type EditorClipSplitOperation = EditorLocalOperationBase & {
  kind: 'clip.split'
  before: { clipId: string; startSec: number; endSec: number }
  after: {
    leftClipId: string
    rightClipId: string
    splitAtSec: number
  }
}

export type EditorClipMoveOperation = EditorLocalOperationBase & {
  kind: 'clip.move'
  before: { index: number }
  after: { index: number }
}

export type EditorTransformOperation = EditorLocalOperationBase & {
  kind: 'node.transform.set'
  before: EditorTransform
  after: EditorTransform
}

export type EditorTrackVolumeOperation = EditorLocalOperationBase & {
  kind: 'track.volume.set'
  before: number
  after: number
}

export type EditorLocalOperation =
  | EditorCaptionTextOperation
  | EditorCaptionTimingOperation
  | EditorClipTrimOperation
  | EditorClipSplitOperation
  | EditorClipMoveOperation
  | EditorTransformOperation
  | EditorTrackVolumeOperation

export type EditorPendingActionKind =
  | 'paid_generation'
  | 'voice_generation'
  | 'render_export'
  | 'external_publish'

export type EditorPendingAction = {
  id: string
  kind: EditorPendingActionKind
  label: string
  targetIds: string[]
  requiredRole: 'owner'
  state: 'requires_separate_confirmation' | 'blocked'
  blockedReason:
    | 'provider_unavailable'
    | 'provider_disabled'
    | 'invalid_cost'
    | 'cost_cap_exceeded'
    | 'voice_inactive'
    | 'voice_revoked'
    | 'voice_not_consented'
    | 'external_effect_not_allowed'
    | 'separate_render_required'
    | null
  provider: {
    engineId: StudioEngineId | null
    model: string | null
    enabled: boolean
    payloadDigest: string
  } | null
  voice: {
    versionId: string
    active: boolean
    consented: boolean
    revoked: boolean
  } | null
  destination: string | null
  estimatedCostBdt: number
  maxCostBdt: number
}

export type EditorPlanWarningCode =
  | 'prompt_injection_ignored'
  | 'role_claim_ignored'
  | 'ambiguous_target'
  | 'unsupported_instruction'
  | 'provider_unavailable'
  | 'provider_disabled'
  | 'invalid_cost'
  | 'cost_cap_exceeded'
  | 'voice_inactive'
  | 'voice_revoked'
  | 'voice_not_consented'
  | 'external_publish_separated'
  | 'render_export_separated'
  | 'paid_generation_separated'

export type EditorPlanWarning = {
  code: EditorPlanWarningCode
  message: string
}

export type EditorOperationProposal = {
  contractVersion: typeof EDITOR_AGENT_CONTRACT_VERSION
  id: string
  origin: 'human' | 'agent'
  scope: EditorCompositionScope
  expectedVersion: number
  expectedConcurrencyToken: string
  actorRoleAtPlan: StudioAccessRole
  instruction: string
  normalizedInstruction: string
  operations: EditorLocalOperation[]
  pendingActions: EditorPendingAction[]
  warnings: EditorPlanWarning[]
  requiresClarification: boolean
  totalLocalCostBdt: 0
  totalPendingCostBdt: number
  fingerprint: string
}

export type OwnerPlanAcknowledgement = {
  fingerprint: string
  scope: EditorCompositionScope
  expectedVersion: number
  acknowledgedByUserId: string
  acknowledgedByRole: 'owner'
  acknowledgedAt: string
}

export type EditorCommandValidation = {
  ok: boolean
  code:
    | 'valid'
    | 'approval_required'
    | 'fingerprint_mismatch'
    | 'scope_mismatch'
    | 'stale_version'
    | 'stale_target'
    | 'role_forbidden'
    | 'unsafe_operation'
    | 'clarification_required'
  currentVersion: number
  currentConcurrencyToken: string
}

export type EditorCommandReceipt = {
  status: 'applied' | 'undone' | 'redone' | 'rolled_back'
  snapshot: EditorCompositionSnapshot
  batchId: string
  auditId: string
  operationIds: string[]
  pendingActionIds: string[]
}

export type EditorHistoryRequest = {
  scope: EditorCompositionScope
  expectedVersion: number
  expectedConcurrencyToken: string
  actor: EditorActor
  batchId?: string
}

export type EditorApplyRequest = {
  proposal: EditorOperationProposal
  acknowledgement?: OwnerPlanAcknowledgement
  actor: EditorActor
}

/**
 * Narrow adapter boundary for Workstream E. The Foundation adapter owns auth,
 * persistence, validation, transactions and audit durability. No provider,
 * render, voice or publish method belongs on this port.
 */
export interface CompositionCommandPort {
  load(scope: EditorCompositionScope): Promise<EditorCompositionSnapshot>
  validateLocal(request: EditorApplyRequest): Promise<EditorCommandValidation>
  applyLocal(request: EditorApplyRequest): Promise<EditorCommandReceipt>
  undo(request: EditorHistoryRequest): Promise<EditorCommandReceipt>
  redo(request: EditorHistoryRequest): Promise<EditorCommandReceipt>
  rollback(request: EditorHistoryRequest & { batchId: string }): Promise<EditorCommandReceipt>
}

export type AgentProviderContext = {
  engineId: StudioEngineId | null
  model: string | null
  enabled: boolean
  estimatedCostBdt: number
  maxCostBdt: number
  payloadDigest: string
}

export type AgentVoiceContext = {
  versionId: string
  active: boolean
  consented: boolean
  revoked: boolean
  estimatedCostBdt: number
  maxCostBdt: number
  provider: AgentProviderContext
}

export type AgentPlanningContext = {
  snapshot: EditorCompositionSnapshot
  actor: EditorActor
  selectedTrackId: string | null
  selectedClipId: string | null
  playheadSec: number
  firstBeatSec: number
  generationProvider: AgentProviderContext | null
  voice: AgentVoiceContext | null
}

export type EditorJobObservation = {
  status: 'queued' | 'running' | 'failed' | 'needs_review' | 'executed'
  artifact: StudioArtifactDescriptor | null
  providerRequestId: string | null
  errorCode: string | null
}

export type EditorVerifiedOutcome =
  | { complete: true; artifact: StudioArtifactDescriptor; status: 'executed' }
  | {
      complete: false
      artifact: null
      status: 'queued' | 'running' | 'failed' | 'needs_review'
      reason:
        | 'not_finished'
        | 'failed'
        | 'ambiguous_result'
        | 'artifact_missing'
        | 'artifact_invalid'
    }

export class CompositionCommandError extends Error {
  readonly code: EditorCommandValidation['code'] | 'history_unavailable'

  constructor(
    code: EditorCommandValidation['code'] | 'history_unavailable',
    message = code,
  ) {
    super(message)
    this.name = 'CompositionCommandError'
    this.code = code
  }
}
