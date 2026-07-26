import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import {
  type EditorApplyRequest,
  type EditorCommandValidation,
  type EditorCompositionScope,
  type EditorCompositionSnapshot,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  acknowledgementMatchesProposal,
  computeProposalFingerprint,
} from '@/lib/creative-studio/editor-agent/fingerprint'
import { applyEditorOperations } from '@/lib/creative-studio/editor-agent/operations'

export function sameEditorCompositionScope(
  left: EditorCompositionScope,
  right: EditorCompositionScope,
): boolean {
  return (
    left.brandProfileId === right.brandProfileId
    && left.projectId === right.projectId
    && left.compositionId === right.compositionId
  )
}

function result(
  snapshot: EditorCompositionSnapshot,
  ok: boolean,
  code: EditorCommandValidation['code'],
): EditorCommandValidation {
  return {
    ok,
    code,
    currentVersion: snapshot.version,
    currentConcurrencyToken: snapshot.concurrencyToken,
  }
}

/**
 * Presentation-layer policy shared by the production Foundation adapter and
 * test command double. The authenticated Foundation service remains the final
 * authority; these checks prevent unsafe or stale requests from reaching it.
 */
export async function validateEditorApplyPolicy(
  snapshot: EditorCompositionSnapshot,
  request: EditorApplyRequest,
  authoritativeRole: StudioAccessRole,
): Promise<EditorCommandValidation> {
  const { proposal } = request
  if (!sameEditorCompositionScope(snapshot.scope, proposal.scope)) {
    return result(snapshot, false, 'scope_mismatch')
  }
  if (
    request.actor.role === 'reviewer'
    || request.actor.role !== authoritativeRole
    || proposal.actorRoleAtPlan !== request.actor.role
  ) {
    return result(snapshot, false, 'role_forbidden')
  }
  if (
    proposal.expectedVersion !== snapshot.version
    || proposal.expectedConcurrencyToken !== snapshot.concurrencyToken
  ) {
    return result(snapshot, false, 'stale_version')
  }

  const computed = await computeProposalFingerprint(proposal)
  if (computed !== proposal.fingerprint) {
    return result(snapshot, false, 'fingerprint_mismatch')
  }
  if (proposal.requiresClarification || proposal.operations.length === 0) {
    return result(snapshot, false, 'clarification_required')
  }

  if (proposal.origin === 'agent') {
    if (request.actor.role !== 'owner') {
      return result(snapshot, false, 'role_forbidden')
    }
    if (!acknowledgementMatchesProposal(request.acknowledgement, proposal)) {
      return result(snapshot, false, 'approval_required')
    }
    if (
      request.acknowledgement?.acknowledgedByRole !== 'owner'
      || request.acknowledgement.acknowledgedByUserId !== request.actor.userId
    ) {
      return result(snapshot, false, 'role_forbidden')
    }
  }

  if (
    proposal.operations.some((operation) => (
      operation.effect !== 'local_reversible'
      || operation.estimatedCostBdt !== 0
      || (operation.requiredRole === 'owner' && request.actor.role !== 'owner')
    ))
  ) {
    return result(snapshot, false, 'unsafe_operation')
  }

  try {
    applyEditorOperations(snapshot, proposal.operations)
  } catch {
    return result(snapshot, false, 'stale_target')
  }
  return result(snapshot, true, 'valid')
}
