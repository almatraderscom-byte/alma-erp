import {
  CompositionCommandError,
  type CompositionCommandPort,
  type EditorApplyRequest,
  type EditorCommandReceipt,
  type EditorCommandValidation,
  type EditorCompositionScope,
  type EditorCompositionSnapshot,
  type EditorHistoryRequest,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  acknowledgementMatchesProposal,
  computeProposalFingerprint,
  shortPlanFingerprint,
} from '@/lib/creative-studio/editor-agent/fingerprint'
import {
  applyEditorOperations,
  cloneEditorSnapshot,
} from '@/lib/creative-studio/editor-agent/operations'

type HistoryEntry = {
  batchId: string
  fingerprint: string
  before: EditorCompositionSnapshot
  after: EditorCompositionSnapshot
  operationIds: string[]
  actorName: string
}

function sameScope(
  left: EditorCompositionScope,
  right: EditorCompositionScope,
): boolean {
  return (
    left.brandProfileId === right.brandProfileId
    && left.projectId === right.projectId
    && left.compositionId === right.compositionId
  )
}

function validation(
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

function nextToken(snapshot: EditorCompositionSnapshot): string {
  return `memory-v${snapshot.version}-${snapshot.activity.length}`
}

function historyScopeValid(
  snapshot: EditorCompositionSnapshot,
  request: EditorHistoryRequest,
): boolean {
  return (
    sameScope(snapshot.scope, request.scope)
    && snapshot.version === request.expectedVersion
    && snapshot.concurrencyToken === request.expectedConcurrencyToken
  )
}

/**
 * Temporary Workstream-E adapter. It is intentionally process-local, does not
 * call an API, and must be replaced by the Foundation port before rollout.
 */
export class InMemoryCompositionCommandPort implements CompositionCommandPort {
  private current: EditorCompositionSnapshot
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []

  constructor(initial: EditorCompositionSnapshot) {
    this.current = cloneEditorSnapshot(initial)
  }

  async load(scope: EditorCompositionScope): Promise<EditorCompositionSnapshot> {
    if (!sameScope(this.current.scope, scope)) {
      throw new CompositionCommandError('scope_mismatch')
    }
    return cloneEditorSnapshot(this.current)
  }

  async validateLocal(request: EditorApplyRequest): Promise<EditorCommandValidation> {
    const proposal = request.proposal
    if (!sameScope(this.current.scope, proposal.scope)) {
      return validation(this.current, false, 'scope_mismatch')
    }
    if (request.actor.role === 'reviewer') {
      return validation(this.current, false, 'role_forbidden')
    }
    if (
      proposal.expectedVersion !== this.current.version
      || proposal.expectedConcurrencyToken !== this.current.concurrencyToken
    ) {
      return validation(this.current, false, 'stale_version')
    }

    const computed = await computeProposalFingerprint(proposal)
    if (computed !== proposal.fingerprint) {
      return validation(this.current, false, 'fingerprint_mismatch')
    }
    if (proposal.requiresClarification || proposal.operations.length === 0) {
      return validation(this.current, false, 'clarification_required')
    }

    if (proposal.origin === 'agent') {
      if (
        request.actor.role !== 'owner'
        || proposal.actorRoleAtPlan !== request.actor.role
      ) {
        return validation(this.current, false, 'role_forbidden')
      }
      if (!acknowledgementMatchesProposal(request.acknowledgement, proposal)) {
        return validation(this.current, false, 'approval_required')
      }
      if (
        request.acknowledgement?.acknowledgedByRole !== 'owner'
        || request.acknowledgement.acknowledgedByUserId !== request.actor.userId
      ) {
        return validation(this.current, false, 'role_forbidden')
      }
    }

    if (
      proposal.operations.some((operation) => (
        operation.effect !== 'local_reversible'
        || operation.estimatedCostBdt !== 0
        || operation.requiredRole === 'owner' && request.actor.role !== 'owner'
      ))
    ) {
      return validation(this.current, false, 'unsafe_operation')
    }

    try {
      applyEditorOperations(this.current, proposal.operations)
    } catch {
      return validation(this.current, false, 'stale_target')
    }
    return validation(this.current, true, 'valid')
  }

  async applyLocal(request: EditorApplyRequest): Promise<EditorCommandReceipt> {
    const result = await this.validateLocal(request)
    if (!result.ok) throw new CompositionCommandError(result.code)

    const before = cloneEditorSnapshot(this.current)
    const after = applyEditorOperations(this.current, request.proposal.operations)
    const shortFingerprint = shortPlanFingerprint(request.proposal.fingerprint)
    const batchId = `BATCH-${before.version + 1}-${shortFingerprint}`
    const auditId = `AUD-${before.version + 1}-${shortFingerprint}`

    after.version = before.version + 1
    after.review = {
      ...after.review,
      publishReady: false,
    }
    after.activity = [
      ...before.activity,
      {
        id: auditId,
        kind: 'edit',
        actorName: request.actor.name,
        summary: `${request.proposal.operations.length} reversible ৳0 operation applied.`,
        version: after.version,
        createdAt: new Date().toISOString(),
        operationIds: request.proposal.operations.map((operation) => operation.id),
      },
    ]
    after.canUndo = true
    after.canRedo = false
    after.concurrencyToken = nextToken(after)

    this.undoStack.push({
      batchId,
      fingerprint: request.proposal.fingerprint,
      before,
      after: cloneEditorSnapshot(after),
      operationIds: request.proposal.operations.map((operation) => operation.id),
      actorName: request.actor.name,
    })
    this.redoStack = []
    this.current = after

    return {
      status: 'applied',
      snapshot: cloneEditorSnapshot(this.current),
      batchId,
      auditId,
      operationIds: request.proposal.operations.map((operation) => operation.id),
      pendingActionIds: request.proposal.pendingActions.map((action) => action.id),
    }
  }

  async undo(request: EditorHistoryRequest): Promise<EditorCommandReceipt> {
    this.assertHistoryRequest(request)
    const entry = this.undoStack.pop()
    if (!entry) throw new CompositionCommandError('history_unavailable')
    this.redoStack.push(entry)
    return this.restoreFromHistory('undone', entry.before, entry, request.actor.name)
  }

  async redo(request: EditorHistoryRequest): Promise<EditorCommandReceipt> {
    this.assertHistoryRequest(request)
    const entry = this.redoStack.pop()
    if (!entry) throw new CompositionCommandError('history_unavailable')
    this.undoStack.push(entry)
    return this.restoreFromHistory('redone', entry.after, entry, request.actor.name)
  }

  async rollback(
    request: EditorHistoryRequest & { batchId: string },
  ): Promise<EditorCommandReceipt> {
    this.assertHistoryRequest(request)
    const entry = [...this.undoStack]
      .reverse()
      .find((candidate) => candidate.batchId === request.batchId)
    if (!entry) throw new CompositionCommandError('history_unavailable')
    this.redoStack = []
    return this.restoreFromHistory('rolled_back', entry.before, entry, request.actor.name)
  }

  private assertHistoryRequest(request: EditorHistoryRequest): void {
    if (request.actor.role === 'reviewer') {
      throw new CompositionCommandError('role_forbidden')
    }
    if (!sameScope(this.current.scope, request.scope)) {
      throw new CompositionCommandError('scope_mismatch')
    }
    if (!historyScopeValid(this.current, request)) {
      throw new CompositionCommandError('stale_version')
    }
  }

  private restoreFromHistory(
    status: EditorCommandReceipt['status'],
    source: EditorCompositionSnapshot,
    entry: HistoryEntry,
    actorName: string,
  ): EditorCommandReceipt {
    const previous = this.current
    const restored = cloneEditorSnapshot(source)
    restored.version = previous.version + 1
    restored.review = { ...restored.review, publishReady: false }
    const verb = status === 'undone'
      ? 'Undo'
      : status === 'redone'
        ? 'Redo'
        : 'Rollback'
    const auditId = `AUD-${restored.version}-${verb.toUpperCase()}-${shortPlanFingerprint(entry.fingerprint)}`
    restored.activity = [
      ...previous.activity,
      {
        id: auditId,
        kind: status === 'undone'
          ? 'undo'
          : status === 'redone'
            ? 'redo'
            : 'rollback',
        actorName,
        summary: `${verb} recorded as a new composition version.`,
        version: restored.version,
        createdAt: new Date().toISOString(),
        operationIds: entry.operationIds,
      },
    ]
    restored.canUndo = this.undoStack.length > 0
    restored.canRedo = this.redoStack.length > 0
    restored.concurrencyToken = nextToken(restored)
    this.current = restored

    return {
      status,
      snapshot: cloneEditorSnapshot(restored),
      batchId: entry.batchId,
      auditId,
      operationIds: entry.operationIds,
      pendingActionIds: [],
    }
  }
}

export function createInMemoryCompositionCommandPort(
  initial: EditorCompositionSnapshot,
): CompositionCommandPort {
  return new InMemoryCompositionCommandPort(initial)
}
