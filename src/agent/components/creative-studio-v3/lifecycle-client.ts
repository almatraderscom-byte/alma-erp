import type {
  LifecycleFeatureFlagView,
  LifecycleJobView,
} from '@/lib/creative-studio/lifecycle-service'
import type { StudioCompositionPin } from '@/lib/creative-studio/lifecycle-contract'
import type { StudioLifecycleRolloutDecision } from '@/lib/creative-studio/lifecycle-rollout'
import {
  StudioClientError,
  studioRequest,
  type StudioReviewState,
  type StudioReviewThread,
} from '@/agent/components/creative-studio/studio-api'

export const STUDIO_V3_LIFECYCLE_CAPABILITIES = [
  'preview',
  'render',
  'export',
  'dry_run',
  'schedule',
  'live_publish',
] as const

export type StudioV3LifecycleCapability =
  typeof STUDIO_V3_LIFECYCLE_CAPABILITIES[number]
export type StudioV3LifecycleRole = 'owner' | 'creator' | 'reviewer'
export type StudioV3LifecycleJobKind = 'render' | 'export'

export type StudioV3LifecycleOperations = ReturnType<
  typeof import('@/lib/creative-studio/lifecycle-rollout').toStudioLifecycleOperationsView
>

export type StudioV3LifecycleWorkspace = {
  jobs: LifecycleJobView[]
  operations: StudioV3LifecycleOperations
  execution: {
    paidRender: false
    voiceProvider: false
    externalPublish: false
    localWorkerFlagEnabled: boolean
    legacyFallbackAvailable: boolean
    legacyFallbackExecution: 'client_orchestrated' | 'none'
  }
  rollout: StudioLifecycleRolloutDecision
  rollouts: Record<StudioV3LifecycleCapability, StudioLifecycleRolloutDecision>
  pin: StudioCompositionPin | null
}

export type StudioV3LifecyclePinnedRequest = {
  brandProfileId: string
  projectId: string
  compositionId: string
  compositionVersionId: string
  sourceArtifactVersionId: string
  approvedReviewEventId?: string | null
  operationBatchId?: string | null
}

export type StudioV3LifecyclePreview = {
  mode: 'preview'
  externalEffect: false
  jobKind: StudioV3LifecycleJobKind
  effectClass: 'zero_cost_local'
  estimatedCostBdt: 0
  renderProfile: 'composition-manifest-v1'
  outputFormat: 'json'
  rendererVersion: 'composition-manifest-v1'
  paidExecutionAllowed: false
  compositionId: string
  compositionVersionId: string
  compositionVersion: number
  compositionDocumentHash: string
  sourceArtifactVersionId: string
  approvedReviewEventId: string | null
  reviewFingerprint: string | null
  renderFingerprint: string
}

export type StudioV3LifecycleFlagsResponse = {
  flags: LifecycleFeatureFlagView[]
  execution: {
    configOnly: true
    paidRenderAllowed: false
    voiceProviderAllowed: false
    externalPublishAllowed: false
  }
}

export type StudioV3LifecycleClient = {
  loadWorkspace(input: {
    brandProfileId: string
    projectId: string
    compositionId?: string | null
  }): Promise<StudioV3LifecycleWorkspace>
  resolvePin(input: {
    brandProfileId: string
    projectId: string
    compositionId: string
    artifactVersionId: string
  }): Promise<StudioCompositionPin>
  transitionReview(input: {
    actorRole: StudioV3LifecycleRole
    assetId: string
    brandProfileId: string
    targetState: StudioReviewState
    expectedSequence: number
    note?: string
    compositionId?: string
    compositionVersionId?: string
  }): Promise<StudioReviewThread>
  previewLocal(input: StudioV3LifecyclePinnedRequest & {
    actorRole: StudioV3LifecycleRole
    kind: StudioV3LifecycleJobKind
  }): Promise<StudioV3LifecyclePreview>
  queueLocal(input: StudioV3LifecyclePinnedRequest & {
    actorRole: StudioV3LifecycleRole
    kind: StudioV3LifecycleJobKind
    idempotencyKey: string
  }): Promise<{ job: LifecycleJobView; idempotent: boolean }>
  controlJob(input: {
    actorRole: StudioV3LifecycleRole
    jobId: string
    intent: 'cancel' | 'retry'
    idempotencyKey: string
  }): Promise<{ job: LifecycleJobView; idempotent: boolean }>
  listFlags(input: {
    brandProfileId: string
    projectId: string
    role: StudioV3LifecycleRole
    capability: StudioV3LifecycleCapability
  }): Promise<StudioV3LifecycleFlagsResponse>
  configureFlag(input: {
    actorRole: StudioV3LifecycleRole
    brandProfileId: string
    projectId: string
    role: StudioV3LifecycleRole
    capability: StudioV3LifecycleCapability
    enabled: boolean
    canaryPercent: number
    dualReadEnabled: boolean
    legacyFallbackEnabled: boolean
    idempotencyKey: string
  }): Promise<{ flag: LifecycleFeatureFlagView; idempotent: boolean }>
}

const LIFECYCLE_API = '/api/assistant/creative-studio/lifecycle'
const LOCAL_RENDER_CONTRACT = {
  renderProfile: 'composition-manifest-v1',
  outputFormat: 'json',
  rendererVersion: 'composition-manifest-v1',
  effectClass: 'zero_cost_local',
  estimatedCostBdt: 0,
} as const

function exactScopeQuery(input: {
  brandProfileId: string
  projectId: string
  compositionId?: string | null
  artifactVersionId?: string | null
}) {
  const query = new URLSearchParams({
    brandProfileId: input.brandProfileId,
    projectId: input.projectId,
  })
  if (input.compositionId) query.set('compositionId', input.compositionId)
  if (input.artifactVersionId) {
    query.set('artifactVersionId', input.artifactVersionId)
  }
  return query
}

function assertJobScope(
  job: LifecycleJobView,
  input: {
    brandProfileId: string
    projectId: string
    compositionId?: string | null
  },
): LifecycleJobView {
  if (
    job.brandProfileId !== input.brandProfileId
    || job.projectId !== input.projectId
    || (input.compositionId && job.compositionId !== input.compositionId)
  ) {
    throw new StudioClientError(
      'The Lifecycle response crossed the requested brand/project/composition scope.',
      502,
      'lifecycle_scope_mismatch',
    )
  }
  return job
}

function assertOwnerClientMutation(actorRole: StudioV3LifecycleRole): void {
  // This is presentation fail-fast only. The server always re-derives the
  // authenticated actor's exact brand role and remains the authority.
  if (actorRole !== 'owner') {
    throw new StudioClientError(
      'Lifecycle mutations require Owner access.',
      403,
      'lifecycle_owner_required',
    )
  }
}

function pinnedBody(
  input: StudioV3LifecyclePinnedRequest & {
    kind: StudioV3LifecycleJobKind
  },
) {
  return {
    brandProfileId: input.brandProfileId,
    projectId: input.projectId,
    compositionId: input.compositionId,
    compositionVersionId: input.compositionVersionId,
    sourceArtifactVersionId: input.sourceArtifactVersionId,
    ...(input.approvedReviewEventId
      ? { approvedReviewEventId: input.approvedReviewEventId }
      : {}),
    ...(input.operationBatchId
      ? { operationBatchId: input.operationBatchId }
      : {}),
    kind: input.kind,
    ...LOCAL_RENDER_CONTRACT,
  }
}

export function createStudioV3LifecycleClient(): StudioV3LifecycleClient {
  return {
    async loadWorkspace(input) {
      const workspace = await studioRequest<StudioV3LifecycleWorkspace>(
        `${LIFECYCLE_API}?${exactScopeQuery(input).toString()}`,
        { method: 'GET', cache: 'no-store' },
        'lifecycle_workspace_failed',
      )
      return {
        ...workspace,
        jobs: workspace.jobs.map((job) => assertJobScope(job, input)),
      }
    },

    async resolvePin(input) {
      const workspace = await studioRequest<StudioV3LifecycleWorkspace>(
        `${LIFECYCLE_API}?${exactScopeQuery(input).toString()}`,
        { method: 'GET', cache: 'no-store' },
        'lifecycle_pin_failed',
      )
      const pin = workspace.pin
      if (
        !pin
        || pin.compositionId !== input.compositionId
        || pin.artifactVersionId !== input.artifactVersionId
      ) {
        throw new StudioClientError(
          'The server did not return the requested exact Lifecycle pin.',
          409,
          'lifecycle_pin_unavailable',
        )
      }
      workspace.jobs.forEach((job) => assertJobScope(job, input))
      return pin
    },

    async transitionReview(input) {
      assertOwnerClientMutation(input.actorRole)
      const response = await studioRequest<{ review: StudioReviewThread }>(
        `${LIFECYCLE_API}/review/${encodeURIComponent(input.assetId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brandProfileId: input.brandProfileId,
            targetState: input.targetState,
            expectedSequence: input.expectedSequence,
            ...(input.note ? { note: input.note } : {}),
            ...(input.compositionId
              ? { compositionId: input.compositionId }
              : {}),
            ...(input.compositionVersionId
              ? { compositionVersionId: input.compositionVersionId }
              : {}),
          }),
        },
        'lifecycle_review_transition_failed',
      )
      return response.review
    },

    async previewLocal(input) {
      assertOwnerClientMutation(input.actorRole)
      const response = await studioRequest<{ preview: StudioV3LifecyclePreview }>(
        LIFECYCLE_API,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: 'preview',
            ...pinnedBody(input),
          }),
        },
        'lifecycle_preview_failed',
      )
      if (
        response.preview.externalEffect !== false
        || response.preview.effectClass !== 'zero_cost_local'
        || response.preview.estimatedCostBdt !== 0
        || response.preview.paidExecutionAllowed !== false
        || response.preview.compositionId !== input.compositionId
        || response.preview.compositionVersionId !== input.compositionVersionId
        || response.preview.sourceArtifactVersionId !== input.sourceArtifactVersionId
      ) {
        throw new StudioClientError(
          'The server returned an unsafe or mismatched Lifecycle preview.',
          502,
          'lifecycle_preview_mismatch',
        )
      }
      return response.preview
    },

    async queueLocal(input) {
      assertOwnerClientMutation(input.actorRole)
      const response = await studioRequest<{
        job: LifecycleJobView
        idempotent: boolean
      }>(
        LIFECYCLE_API,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: 'queue',
            idempotencyKey: input.idempotencyKey,
            ...pinnedBody(input),
          }),
        },
        'lifecycle_queue_failed',
      )
      const job = assertJobScope(response.job, input)
      if (
        job.effectClass !== 'zero_cost_local'
        || job.estimatedCostBdt !== 0
        || job.paidExecutionAllowed !== false
      ) {
        throw new StudioClientError(
          'The server returned a non-local Lifecycle job to the zero-cost client.',
          502,
          'lifecycle_execution_mismatch',
        )
      }
      return { ...response, job }
    },

    async controlJob(input) {
      assertOwnerClientMutation(input.actorRole)
      return studioRequest(
        `${LIFECYCLE_API}/${encodeURIComponent(input.jobId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: input.intent,
            idempotencyKey: input.idempotencyKey,
          }),
        },
        'lifecycle_control_failed',
      )
    },

    listFlags(input) {
      const query = new URLSearchParams(input)
      return studioRequest(
        `${LIFECYCLE_API}/flags?${query.toString()}`,
        { method: 'GET', cache: 'no-store' },
        'lifecycle_flags_failed',
      )
    },

    async configureFlag(input) {
      assertOwnerClientMutation(input.actorRole)
      if (input.capability === 'live_publish' && input.enabled) {
        throw new StudioClientError(
          'Live publish stays hard-disabled in the V3 zero-cost rollout.',
          409,
          'live_publish_execution_disabled',
        )
      }
      return studioRequest(
        `${LIFECYCLE_API}/flags`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brandProfileId: input.brandProfileId,
            projectId: input.projectId,
            role: input.role,
            capability: input.capability,
            enabled: input.enabled,
            canaryPercent: input.canaryPercent,
            dualReadEnabled: input.dualReadEnabled,
            legacyFallbackEnabled: input.legacyFallbackEnabled,
            idempotencyKey: input.idempotencyKey,
          }),
        },
        'lifecycle_flag_update_failed',
      )
    },
  }
}

export const studioV3LifecycleClient = createStudioV3LifecycleClient()
