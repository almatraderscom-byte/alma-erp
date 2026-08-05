import type { CreativeCompositionDocument } from '@/lib/creative-studio/composition-document'
import {
  compileCreativeOperationBatch,
  CompositionOperationError,
  type CreativeInverseOperation,
  type CreativeOperationBatch,
} from '@/lib/creative-studio/composition-operations'
import { projectToReadonlyComposition } from '@/lib/creative-studio/composition-projection'
import type { CreativeCompositionView } from '@/lib/creative-studio/composition-service'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import { stableStringify } from '@/lib/creative-studio/editor-agent/fingerprint'

type AnyRecord = Record<string, unknown>

type RecordedRequest = {
  method: string
  pathname: string
  body: AnyRecord | null
}

type StoredHistoryBatch = {
  batchId: string
  forward: CreativeInverseOperation[]
  inverse: CreativeInverseOperation[]
}

type StoredResponse = {
  signature: string
  response: AnyRecord
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function requestRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}
}

function initialView(): CreativeCompositionView {
  const projected = projectToReadonlyComposition({
    compositionId: 'composition-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    brandProfileId: 'brand-alma',
    name: 'Eid launch',
    defaultFolder: 'Campaign',
    product: {
      code: 'ALMA-001',
      name: 'Coral Panjabi',
      priceBdt: 2_500,
      sourceImage: 'products/alma-001.png',
    },
    recipe: {
      id: 'recipe-1',
      version: 3,
      name: 'Warm editorial',
    },
    assets: [{
      id: 'asset-video',
      assetType: 'video',
      title: 'Opening',
      versionId: 'version-video-1',
      version: 1,
      durationMs: 6_000,
    }, {
      id: 'asset-video-2',
      assetType: 'video',
      title: 'Detail',
      versionId: 'version-video-2',
      version: 1,
      durationMs: 4_000,
    }, {
      id: 'asset-caption',
      assetType: 'caption',
      title: 'ঈদের নতুন গল্প',
      versionId: 'version-caption-1',
      version: 1,
      durationMs: 4_000,
    }, {
      id: 'asset-music',
      assetType: 'music',
      title: 'Eid pulse',
      versionId: 'version-music-1',
      version: 1,
      durationMs: 10_000,
    }],
    readonly: false,
  })
  return {
    id: 'composition-1',
    ownerId: 'owner-1',
    brandProfileId: 'brand-alma',
    projectId: 'project-1',
    title: 'Eid launch composition',
    sourceKind: 'project_projection',
    schemaVersion: 1,
    currentVersion: 1,
    concurrencyToken: projected.concurrencyToken,
    readonly: false,
    createdById: 'owner-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    document: projected.document,
    documentHash: projected.documentHash,
    accessRole: 'owner',
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0,
      currentUndoBatchId: null,
      currentRedoBatchId: null,
      latestAgentBatchId: null,
      canRollbackLatestAgentBatch: false,
      rollbackPoints: [],
      activity: [],
    },
  }
}

/**
 * Stateful contract double built from the real Foundation operation compiler.
 * It exists only in test fixtures; production always calls authenticated APIs.
 */
export class FoundationApiHarness {
  readonly requests: RecordedRequest[] = []
  private view: CreativeCompositionView = initialView()
  private actor: { userId: string; role: StudioAccessRole } = {
    userId: 'owner-1',
    role: 'owner',
  }
  private readonly idempotency = new Map<string, StoredResponse>()
  private readonly rollbackDocuments = new Map<string, CreativeCompositionDocument>()
  private readonly undoStack: StoredHistoryBatch[] = []
  private readonly redoStack: StoredHistoryBatch[] = []
  private dropApplyResponse = false
  private conflictApply = false
  private offline = false

  readonly fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (this.offline) throw new Error('offline')
    const url = new URL(String(input), 'http://local')
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string'
      ? requestRecord(JSON.parse(init.body) as unknown)
      : null
    this.requests.push({ method, pathname: url.pathname, body })

    try {
      if (
        method === 'GET'
        && url.pathname.endsWith(`/compositions/${this.view.id}`)
      ) {
        const brandProfileId = url.searchParams.get('brandProfileId')
        if (brandProfileId !== this.view.brandProfileId) {
          return json({ error: 'brand_scope_mismatch' }, 403)
        }
        return json({
          composition: {
            ...this.view,
            accessRole: this.actor.role,
          },
          legacyDefault: true,
          legacyFallback: true,
        })
      }
      if (!body) return json({ error: 'invalid_json' }, 400)
      if (body.brandProfileId !== this.view.brandProfileId) {
        return json({ error: 'brand_scope_mismatch' }, 403)
      }
      if (this.actor.role === 'reviewer') {
        return json({ error: 'studio_draft_forbidden' }, 403)
      }

      if (url.pathname.endsWith('/operations/validate')) {
        const plan = this.plan('APPLY', body, body.operations as CreativeInverseOperation[])
        return json({
          validation: {
            valid: true,
            batchId: plan.batchId,
            requestFingerprint: plan.requestFingerprint,
            expectedVersion: plan.expectedVersion,
            resultVersion: plan.resultVersion,
            operationCount: plan.operations.length,
            inverseOperations: plan.inverseOperations,
            documentHash: plan.documentHash,
            resultConcurrencyToken: plan.resultConcurrencyToken,
          },
        })
      }
      if (url.pathname.endsWith('/operations/apply')) {
        if (this.conflictApply) {
          this.conflictApply = false
          return json({ error: 'idempotency_conflict' }, 409)
        }
        const response = this.apply(body)
        if (this.dropApplyResponse) {
          this.dropApplyResponse = false
          throw new Error('response_lost_after_commit')
        }
        return json(response, response.idempotent ? 200 : 201)
      }
      if (url.pathname.endsWith('/undo')) {
        return json(this.history(body, 'UNDO'), 201)
      }
      if (url.pathname.endsWith('/redo')) {
        return json(this.history(body, 'REDO'), 201)
      }
      if (url.pathname.endsWith('/rollback')) {
        return json(this.rollback(body), 201)
      }
      return json({ error: 'not_found' }, 404)
    } catch (error) {
      if (error instanceof CompositionOperationError) {
        return json({
          error: error.code,
          ...(error.details ? { details: error.details } : {}),
        }, error.status)
      }
      throw error
    }
  }

  snapshot(): CreativeCompositionView {
    return structuredClone(this.view)
  }

  setRole(role: StudioAccessRole, userId = `${role}-1`): void {
    this.actor = { userId, role }
  }

  setOffline(value: boolean): void {
    this.offline = value
  }

  loseNextApplyResponseAfterCommit(): void {
    this.dropApplyResponse = true
  }

  rejectNextApplyAsIdempotencyConflict(): void {
    this.conflictApply = true
  }

  advanceExternally(): void {
    const node = this.view.document.nodes[0]
    const body = {
      expectedVersion: this.view.currentVersion,
      expectedConcurrencyToken: this.view.concurrencyToken,
      idempotencyKey: `external-apply-${this.view.currentVersion}`,
      brandProfileId: this.view.brandProfileId,
      operations: [{
        type: 'node.replace',
        nodeId: node.id,
        node: { ...node, name: `${node.name} external` },
      }],
    }
    this.apply(body)
  }

  private plan(
    kind: 'APPLY' | 'UNDO' | 'REDO' | 'ROLLBACK',
    body: AnyRecord,
    operations: CreativeInverseOperation[],
    target?: {
      batchId?: string
      version?: number
      reference?: string
    },
  ): CreativeOperationBatch {
    return compileCreativeOperationBatch({
      document: this.view.document,
      kind,
      expectedVersion: Number(body.expectedVersion),
      expectedConcurrencyToken: String(body.expectedConcurrencyToken),
      idempotencyKey: body.idempotencyKey,
      actor: this.actor,
      operations,
      targetBatchId: target?.batchId,
      targetVersion: target?.version,
      targetReference: target?.reference,
    })
  }

  private signature(endpoint: string, body: AnyRecord): string {
    return stableStringify({
      endpoint,
      actor: this.actor,
      body,
    })
  }

  private replay(endpoint: string, body: AnyRecord): AnyRecord | null {
    const key = String(body.idempotencyKey)
    const stored = this.idempotency.get(key)
    if (!stored) return null
    if (stored.signature !== this.signature(endpoint, body)) {
      throw new CompositionOperationError('idempotency_conflict', 409)
    }
    return structuredClone({
      ...stored.response,
      idempotent: true,
    })
  }

  private apply(body: AnyRecord): AnyRecord {
    const replay = this.replay('apply', body)
    if (replay) return replay
    const forward = body.operations as CreativeInverseOperation[]
    const plan = this.plan('APPLY', body, forward)
    const response = this.commit(plan, null)
    this.undoStack.push({
      batchId: plan.batchId,
      forward: structuredClone(forward),
      inverse: structuredClone(plan.inverseOperations),
    })
    this.redoStack.splice(0)
    this.idempotency.set(String(body.idempotencyKey), {
      signature: this.signature('apply', body),
      response: structuredClone(response),
    })
    return response
  }

  private history(body: AnyRecord, kind: 'UNDO' | 'REDO'): AnyRecord {
    const endpoint = kind.toLowerCase()
    const replay = this.replay(endpoint, body)
    if (replay) return replay
    this.assertExpected(body)
    const source = kind === 'UNDO' ? this.undoStack : this.redoStack
    const target = source.at(-1)
    if (!target) {
      throw new CompositionOperationError(
        kind === 'UNDO' ? 'undo_target_not_found' : 'redo_target_not_found',
        409,
      )
    }
    if (body.batchId && body.batchId !== target.batchId) {
      throw new CompositionOperationError(
        kind === 'UNDO' ? 'undo_target_not_current' : 'redo_target_not_current',
        409,
      )
    }
    const operations = kind === 'UNDO' ? target.inverse : target.forward
    const plan = this.plan(kind, body, operations, {
      batchId: target.batchId,
      version: kind === 'UNDO'
        ? this.view.currentVersion - 1
        : this.view.currentVersion + 1,
      reference: target.batchId,
    })
    const response = this.commit(plan, target.batchId)
    source.pop()
    if (kind === 'UNDO') this.redoStack.push(target)
    else this.undoStack.push(target)
    this.idempotency.set(String(body.idempotencyKey), {
      signature: this.signature(endpoint, body),
      response: structuredClone(response),
    })
    return response
  }

  private rollback(body: AnyRecord): AnyRecord {
    const replay = this.replay('rollback', body)
    if (replay) return replay
    this.assertExpected(body)
    const rollbackPointId = String(body.rollbackPointId)
    const document = this.rollbackDocuments.get(rollbackPointId)
    if (!document) {
      throw new CompositionOperationError('rollback_point_not_found', 404)
    }
    const plan = this.plan('ROLLBACK', body, [{
      type: 'document.restore',
      document,
    }], {
      version: document.documentVersion,
      reference: rollbackPointId,
    })
    const response = this.commit(plan, null)
    this.undoStack.push({
      batchId: plan.batchId,
      forward: [{
        type: 'document.restore',
        document: structuredClone(document),
      }],
      inverse: structuredClone(plan.inverseOperations),
    })
    this.redoStack.splice(0)
    this.idempotency.set(String(body.idempotencyKey), {
      signature: this.signature('rollback', body),
      response: structuredClone(response),
    })
    return response
  }

  private assertExpected(body: AnyRecord): void {
    if (
      Number(body.expectedVersion) !== this.view.currentVersion
      || String(body.expectedConcurrencyToken) !== this.view.concurrencyToken
    ) {
      throw new CompositionOperationError('composition_conflict', 409, {
        currentVersion: this.view.currentVersion,
        currentConcurrencyToken: this.view.concurrencyToken,
      })
    }
  }

  private commit(
    plan: CreativeOperationBatch,
    targetBatchId: string | null,
  ): AnyRecord {
    const before = structuredClone(this.view.document)
    const rollbackPointId = `crp_${plan.batchId.slice(4)}`
    this.rollbackDocuments.set(rollbackPointId, before)
    const kind = plan.kind.toLowerCase() as 'apply' | 'undo' | 'redo' | 'rollback'
    const origin = kind === 'apply'
      ? String(plan.idempotencyKey).startsWith('editor-agent-apply-')
        ? 'agent' as const
        : 'human' as const
      : 'system' as const
    const activity = [
      ...this.view.history.activity,
      {
        id: plan.batchId,
        kind,
        origin,
        actorId: this.actor.userId,
        actorName: 'Authenticated Studio actor',
        actorRole: this.actor.role,
        resultVersion: plan.resultVersion,
        targetBatchId,
        rollbackPointId,
        createdAt: `2026-07-26T00:${String(plan.resultVersion).padStart(2, '0')}:00.000Z`,
        operationIds: plan.operations.map((operation) => operation.operationId),
      },
    ]
    const rollbackPoints = [
      ...this.view.history.rollbackPoints,
      { batchId: plan.batchId, rollbackPointId },
    ]
    const latestAgentBatchId = origin === 'agent'
      ? plan.batchId
      : this.view.history.latestAgentBatchId
    const undoDepth = kind === 'undo'
      ? Math.max(0, this.view.history.undoDepth - 1)
      : this.view.history.undoDepth + 1
    const redoDepth = kind === 'undo'
      ? this.view.history.redoDepth + 1
      : kind === 'redo'
        ? Math.max(0, this.view.history.redoDepth - 1)
        : 0
    this.view = {
      ...this.view,
      currentVersion: plan.resultVersion,
      concurrencyToken: plan.resultConcurrencyToken,
      updatedAt: `2026-07-26T00:${String(plan.resultVersion).padStart(2, '0')}:00.000Z`,
      document: structuredClone(plan.document),
      documentHash: plan.documentHash,
      accessRole: this.actor.role,
      history: {
        canUndo: undoDepth > 0,
        canRedo: redoDepth > 0,
        undoDepth,
        redoDepth,
        currentUndoBatchId: undoDepth > 0 ? plan.batchId : null,
        currentRedoBatchId: redoDepth > 0 ? targetBatchId : null,
        latestAgentBatchId,
        canRollbackLatestAgentBatch: Boolean(
          latestAgentBatchId
          && rollbackPoints.some((entry) =>
            entry.batchId === latestAgentBatchId),
        ),
        rollbackPoints,
        activity,
      },
    }
    return {
      idempotent: false,
      batch: {
        id: plan.batchId,
        kind: plan.kind,
        requestFingerprint: plan.requestFingerprint,
        expectedVersion: plan.expectedVersion,
        resultVersion: plan.resultVersion,
        operationCount: plan.operations.length,
        targetBatchId,
        targetVersion: null,
      },
      version: {
        version: plan.resultVersion,
        concurrencyToken: plan.resultConcurrencyToken,
        documentHash: plan.documentHash,
        document: structuredClone(plan.document),
      },
      rollbackPointId,
    }
  }
}
