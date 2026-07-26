import {
  requireStudioBrandAccess,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  transitionStudioAssetReview,
  type StudioReviewThread,
} from '@/lib/creative-studio/review-workflow'

type Row = Record<string, unknown>
const V3_REVIEW_TARGET_STATES = [
  'changes_requested',
  'revised',
  'approved',
] as const
type V3ReviewTargetState = typeof V3_REVIEW_TARGET_STATES[number]

export class LifecycleReviewServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code)
    this.name = 'LifecycleReviewServiceError'
  }
}

function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : {}
}

function requiredText(value: unknown, code: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new LifecycleReviewServiceError(code)
  return result
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null
}

function exactExpectedSequence(value: unknown): number {
  if (value == null) {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_expected_sequence_required',
    )
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_expected_sequence_invalid',
    )
  }
  return Number(value)
}

function exactTargetState(value: unknown): V3ReviewTargetState {
  if (typeof value !== 'string') {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_target_state_invalid',
    )
  }
  const normalized = value.trim().toLowerCase()
  if (
    !V3_REVIEW_TARGET_STATES.includes(
      normalized as V3ReviewTargetState,
    )
  ) {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_target_state_invalid',
    )
  }
  return normalized as V3ReviewTargetState
}

/**
 * V3 Lifecycle Review is intentionally stricter than the shared CSE6 review
 * workflow. The authenticated brand role is re-derived here before the
 * canonical transition is called; caller-provided role data is ignored.
 */
export async function transitionStudioLifecycleReview(
  actor: StudioActor,
  value: unknown,
): Promise<StudioReviewThread> {
  const input = object(value)
  const assetId = requiredText(input.assetId, 'asset_id_required')
  const brandProfileId = requiredText(
    input.brandProfileId,
    'brand_profile_id_required',
  )
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  if (access.role !== 'owner') {
    throw new LifecycleReviewServiceError('lifecycle_owner_required', 403)
  }
  const targetState = exactTargetState(input.targetState)
  const expectedSequence = exactExpectedSequence(input.expectedSequence)
  const compositionId = optionalText(input.compositionId)
  const compositionVersionId = optionalText(input.compositionVersionId)
  const hasCompositionId = Boolean(compositionId)
  const hasCompositionVersionId = Boolean(compositionVersionId)
  if (hasCompositionId !== hasCompositionVersionId) {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_composition_pin_incomplete',
    )
  }
  if (
    targetState === 'approved'
    && (!hasCompositionId || !hasCompositionVersionId)
  ) {
    throw new LifecycleReviewServiceError(
      'lifecycle_review_composition_pin_required',
    )
  }

  return transitionStudioAssetReview(actor, {
    assetId,
    brandProfileId,
    targetState,
    expectedSequence,
    note: input.note,
    ...(targetState === 'approved' && compositionId && compositionVersionId
      ? { compositionId, compositionVersionId }
      : {}),
  })
}

export function lifecycleReviewServiceErrorResponse(
  error: unknown,
): Response | null {
  if (!(error instanceof LifecycleReviewServiceError)) return null
  return Response.json(
    { error: error.code, message: error.message },
    { status: error.status },
  )
}
