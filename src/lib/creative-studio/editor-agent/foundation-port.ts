import type { CreativeCompositionView } from '@/lib/creative-studio/composition-service'
import type { CreativeEditOperationInput } from '@/lib/creative-studio/composition-operations'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import {
  CompositionCommandError,
  type CompositionCommandPort,
  type EditorActivityEntry,
  type EditorApplyRequest,
  type EditorCommandReceipt,
  type EditorCommandValidation,
  type EditorCompositionScope,
  type EditorCompositionSnapshot,
  type EditorHistoryRequest,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  FoundationCompositionPortError,
} from '@/lib/creative-studio/editor-agent/foundation-errors'
import {
  compileFoundationEditorOperations,
} from '@/lib/creative-studio/editor-agent/foundation-operation-compiler'
import {
  parseFoundationCompositionView,
  projectFoundationCompositionToEditor,
  type FoundationEditorSnapshotContext,
} from '@/lib/creative-studio/editor-agent/foundation-projection'
import {
  sha256Hex,
  stableStringify,
} from '@/lib/creative-studio/editor-agent/fingerprint'
import {
  sameEditorCompositionScope,
  validateEditorApplyPolicy,
} from '@/lib/creative-studio/editor-agent/proposal-policy'

type AnyRecord = Record<string, unknown>
type FoundationFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type FoundationValidationReceipt = {
  requestFingerprint: string
  expectedVersion: number
  resultVersion: number
  operationCount: number
}

type FoundationCommandReceipt = {
  idempotent: boolean
  batch: {
    id: string
    kind: 'APPLY' | 'UNDO' | 'REDO' | 'ROLLBACK'
    requestFingerprint: string
    expectedVersion: number
    resultVersion: number
    operationCount: number
    targetBatchId: string | null
  }
  version: {
    version: number
    concurrencyToken: string
    documentHash: string
    document: CreativeCompositionView['document']
  }
  rollbackPointId: string
}

type ScopeState = {
  view: CreativeCompositionView
  context: FoundationEditorSnapshotContext
  snapshot: EditorCompositionSnapshot
  accessRole: StudioAccessRole
  undoDepth: number
  redoDepth: number
  rollbackPointByBatch: Map<string, string>
  editorOperationIdsByBatch: Map<string, string[]>
  preparedApplyByFingerprint: Map<string, {
    expectedVersion: number
    expectedConcurrencyToken: string
    operations: CreativeEditOperationInput[]
    serverFingerprint: string
  }>
}

export type FoundationCompositionCommandPortOptions = {
  fetcher?: FoundationFetch
  loadSnapshotContext?: (
    view: CreativeCompositionView,
  ) => FoundationEditorSnapshotContext | Promise<FoundationEditorSnapshotContext>
  now?: () => string
}

const FOUNDATION_COMPOSITION_API_BASE_PATH =
  '/api/assistant/creative-studio/compositions'

class FoundationApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: AnyRecord | null

  constructor(status: number, code: string, details: AnyRecord | null) {
    super(code)
    this.name = 'FoundationApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function record(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value as AnyRecord
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value as number
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  return string(value)
}

function canonicalDigest(value: unknown): string {
  const digest = string(value)
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return digest
}

function batchId(value: unknown): string {
  const id = string(value)
  if (!/^cob_[a-f0-9]{32}$/.test(id)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return id
}

function rollbackPointId(value: unknown): string {
  const id = string(value)
  if (!/^crp_[a-f0-9]{32}$/.test(id)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return id
}

function scopeKey(scope: EditorCompositionScope): string {
  return `${scope.brandProfileId}\u0000${scope.projectId}\u0000${scope.compositionId}`
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

function currentValidation(
  state: ScopeState,
  ok: boolean,
  code: EditorCommandValidation['code'],
  currentVersion = state.snapshot.version,
  currentConcurrencyToken = state.snapshot.concurrencyToken,
): EditorCommandValidation {
  return {
    ok,
    code,
    currentVersion,
    currentConcurrencyToken,
  }
}

function errorDetails(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null
}

function apiValidationCode(error: FoundationApiError): EditorCommandValidation['code'] | null {
  if (error.code === 'composition_conflict') return 'stale_version'
  if (error.code === 'brand_scope_mismatch') return 'scope_mismatch'
  if (
    error.code === 'studio_draft_forbidden'
    || error.code === 'forbidden'
    || error.status === 403
  ) return 'role_forbidden'
  if (
    error.code.includes('not_found')
    || error.code.includes('target')
    || error.code === 'invalid_composition_operation'
  ) return 'stale_target'
  if (
    error.code.includes('readonly')
    || error.code.includes('operation')
    || error.status === 422
  ) return 'unsafe_operation'
  return null
}

function throwPortError(error: FoundationApiError): never {
  if (
    error.code === 'undo_target_not_found'
    || error.code === 'redo_target_not_found'
    || error.code === 'rollback_point_not_found'
    || error.code === 'undo_target_not_current'
    || error.code === 'redo_target_not_current'
  ) {
    throw new CompositionCommandError('history_unavailable')
  }
  const validationCode = apiValidationCode(error)
  if (validationCode) throw new CompositionCommandError(validationCode)
  if (error.code === 'idempotency_conflict') {
    throw new FoundationCompositionPortError(
      'idempotency_conflict',
      error.status,
      error.details,
    )
  }
  throw new FoundationCompositionPortError(
    'foundation_unavailable',
    error.status,
    { serverCode: error.code, ...(error.details ?? {}) },
  )
}

function parseValidationReceipt(
  value: unknown,
  expectedVersion: number,
  expectedOperationCount: number,
): FoundationValidationReceipt {
  const envelope = record(value)
  const validation = record(envelope.validation)
  if (validation.valid !== true) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  const receipt = {
    requestFingerprint: canonicalDigest(validation.requestFingerprint),
    expectedVersion: integer(validation.expectedVersion),
    resultVersion: integer(validation.resultVersion),
    operationCount: integer(validation.operationCount),
  }
  if (
    receipt.expectedVersion !== expectedVersion
    || receipt.resultVersion !== expectedVersion + 1
    || receipt.operationCount !== expectedOperationCount
  ) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502, {
      reason: 'validation_receipt_mismatch',
    })
  }
  batchId(validation.batchId)
  canonicalDigest(validation.documentHash)
  string(validation.resultConcurrencyToken)
  if (!Array.isArray(validation.inverseOperations)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return receipt
}

function parseCommandReceipt(
  value: unknown,
  expected: {
    kind: FoundationCommandReceipt['batch']['kind']
    version: number
    operationCount?: number
    requestFingerprint?: string
  },
): FoundationCommandReceipt {
  const root = record(value)
  const batch = record(root.batch)
  const version = record(root.version)
  const kind = string(batch.kind)
  if (!['APPLY', 'UNDO', 'REDO', 'ROLLBACK'].includes(kind)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  const document = record(version.document)
  integer(document.documentVersion)
  string(document.concurrencyToken)
  const receipt: FoundationCommandReceipt = {
    idempotent: typeof root.idempotent === 'boolean'
      ? root.idempotent
      : (() => {
          throw new FoundationCompositionPortError('invalid_foundation_response', 502)
        })(),
    batch: {
      id: batchId(batch.id),
      kind: kind as FoundationCommandReceipt['batch']['kind'],
      requestFingerprint: canonicalDigest(batch.requestFingerprint),
      expectedVersion: integer(batch.expectedVersion),
      resultVersion: integer(batch.resultVersion),
      operationCount: integer(batch.operationCount),
      targetBatchId: nullableString(batch.targetBatchId),
    },
    version: {
      version: integer(version.version),
      concurrencyToken: string(version.concurrencyToken),
      documentHash: canonicalDigest(version.documentHash),
      document: version.document as CreativeCompositionView['document'],
    },
    rollbackPointId: rollbackPointId(root.rollbackPointId),
  }
  if (
    receipt.batch.kind !== expected.kind
    || receipt.batch.expectedVersion !== expected.version
    || receipt.batch.resultVersion !== expected.version + 1
    || receipt.version.version !== receipt.batch.resultVersion
    || receipt.version.document.documentVersion !== receipt.version.version
    || receipt.version.document.concurrencyToken !== receipt.version.concurrencyToken
    || (
      expected.operationCount !== undefined
      && receipt.batch.operationCount !== expected.operationCount
    )
    || (
      expected.requestFingerprint !== undefined
      && receipt.batch.requestFingerprint !== expected.requestFingerprint
    )
  ) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502, {
      reason: 'command_receipt_mismatch',
    })
  }
  return receipt
}

function apiCurrent(
  state: ScopeState,
  error: FoundationApiError,
): { version: number; token: string } {
  const version = Number(error.details?.currentVersion)
  const token = error.details?.currentConcurrencyToken
  return {
    version: Number.isInteger(version) ? version : state.snapshot.version,
    token: typeof token === 'string' && token.length > 0
      ? token
      : state.snapshot.concurrencyToken,
  }
}

export class FoundationCompositionCommandPort implements CompositionCommandPort {
  private readonly fetcher: FoundationFetch
  private readonly loadSnapshotContext?: FoundationCompositionCommandPortOptions['loadSnapshotContext']
  private readonly now: () => string
  private readonly states = new Map<string, ScopeState>()

  constructor(options: FoundationCompositionCommandPortOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init))
    this.loadSnapshotContext = options.loadSnapshotContext
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async load(scope: EditorCompositionScope): Promise<EditorCompositionSnapshot> {
    const query = new URLSearchParams({ brandProfileId: scope.brandProfileId })
    let payload: unknown
    try {
      payload = await this.requestJson(
        `${FOUNDATION_COMPOSITION_API_BASE_PATH}/${encodePath(scope.compositionId)}?${query.toString()}`,
        { method: 'GET', cache: 'no-store', credentials: 'same-origin' },
      )
    } catch (error) {
      if (!(error instanceof FoundationApiError)) throw error
      throwPortError(error)
    }
    const envelope = record(payload)
    const view = parseFoundationCompositionView(envelope.composition)
    const loadedContext = structuredClone(
      this.loadSnapshotContext
        ? await this.loadSnapshotContext(structuredClone(view))
        : {},
    )
    const durableActivity: EditorActivityEntry[] = view.history.activity.map((entry) => ({
      id: entry.id,
      kind: entry.kind === 'apply' ? 'edit' : entry.kind,
      actorName: entry.actorName,
      summary: `Foundation ${entry.kind} batch committed as composition v${entry.resultVersion}.`,
      version: entry.resultVersion,
      createdAt: entry.createdAt,
      operationIds: [...entry.operationIds],
    }))
    const activityById = new Map(
      [...durableActivity, ...(loadedContext.activity ?? [])]
        .map((entry) => [entry.id, entry] as const),
    )
    const context: FoundationEditorSnapshotContext = {
      ...loadedContext,
      activity: [...activityById.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)),
      canUndo: view.history.canUndo,
      canRedo: view.history.canRedo,
      latestAgentBatchId: view.history.latestAgentBatchId,
      canRollbackLatestAgentBatch:
        view.history.canRollbackLatestAgentBatch,
      hydration: {
        projectAssets: loadedContext.hydration?.projectAssets ?? 'not_hydrated',
        review: loadedContext.hydration?.review ?? 'not_hydrated',
        activity: loadedContext.hydration?.activity ?? 'not_hydrated',
        history: 'hydrated',
      },
    }
    const previous = this.states.get(scopeKey(scope))
    const sameVersion = previous
      && previous.view.currentVersion === view.currentVersion
      && previous.view.concurrencyToken === view.concurrencyToken
    const undoDepth = view.history.undoDepth
    const redoDepth = view.history.redoDepth
    const projectedContext: FoundationEditorSnapshotContext = {
      ...context,
      canUndo: context.canUndo ?? undoDepth > 0,
      canRedo: context.canRedo ?? redoDepth > 0,
    }
    const snapshot = projectFoundationCompositionToEditor(
      view,
      scope,
      projectedContext,
    )
    const state: ScopeState = {
      view,
      context,
      snapshot,
      accessRole: view.accessRole,
      undoDepth,
      redoDepth,
      rollbackPointByBatch: new Map(
        view.history.rollbackPoints.map((entry) => [
          entry.batchId,
          entry.rollbackPointId,
        ]),
      ),
      editorOperationIdsByBatch: new Map(
        view.history.activity.map((entry) => [
          entry.id,
          [...entry.operationIds],
        ]),
      ),
      preparedApplyByFingerprint: sameVersion
        ? previous.preparedApplyByFingerprint
        : new Map(),
    }
    this.states.set(scopeKey(scope), state)
    return structuredClone(snapshot)
  }

  async validateLocal(request: EditorApplyRequest): Promise<EditorCommandValidation> {
    const state = await this.ensureState(request.proposal.scope)
    const prepared = await this.prepareApply(state, request)
    return prepared.validation
  }

  async applyLocal(request: EditorApplyRequest): Promise<EditorCommandReceipt> {
    const state = await this.ensureState(request.proposal.scope)
    const prepared = await this.prepareApply(state, request)
    if (!prepared.validation.ok || !prepared.operations || !prepared.serverFingerprint) {
      throw new CompositionCommandError(prepared.validation.code)
    }
    let payload: unknown
    try {
      payload = await this.postCommand(
        state,
        'operations/apply',
        {
          expectedVersion: request.proposal.expectedVersion,
          expectedConcurrencyToken: request.proposal.expectedConcurrencyToken,
          idempotencyKey: this.applyIdempotencyKey(
            request.proposal.fingerprint,
            request.proposal.origin,
          ),
          brandProfileId: request.proposal.scope.brandProfileId,
          operations: prepared.operations,
        },
      )
    } catch (error) {
      if (!(error instanceof FoundationApiError)) throw error
      throwPortError(error)
    }
    const result = parseCommandReceipt(payload, {
      kind: 'APPLY',
      version: request.proposal.expectedVersion,
      operationCount: prepared.operations.length,
      requestFingerprint: prepared.serverFingerprint,
    })
    const operationIds = request.proposal.operations.map((operation) => operation.id)
    return this.acceptCommand(
      state,
      request.proposal.scope,
      result,
      'applied',
      operationIds,
      request.proposal.pendingActions.map((action) => action.id),
      request.proposal.origin === 'agent' ? result.batch.id : undefined,
    )
  }

  async undo(request: EditorHistoryRequest): Promise<EditorCommandReceipt> {
    return this.runHistory('undo', 'UNDO', 'undone', request)
  }

  async redo(request: EditorHistoryRequest): Promise<EditorCommandReceipt> {
    return this.runHistory('redo', 'REDO', 'redone', request)
  }

  async rollback(
    request: EditorHistoryRequest & { batchId: string },
  ): Promise<EditorCommandReceipt> {
    const state = await this.ensureState(request.scope)
    this.assertHistoryRequest(state, request)
    const rollbackPointId = state.rollbackPointByBatch.get(request.batchId)
    if (!rollbackPointId) throw new CompositionCommandError('history_unavailable')
    const idempotencyKey = await this.historyIdempotencyKey('rollback', request)
    let payload: unknown
    try {
      payload = await this.postCommand(state, 'rollback', {
        expectedVersion: request.expectedVersion,
        expectedConcurrencyToken: request.expectedConcurrencyToken,
        idempotencyKey,
        brandProfileId: request.scope.brandProfileId,
        rollbackPointId,
      })
    } catch (error) {
      if (!(error instanceof FoundationApiError)) throw error
      throwPortError(error)
    }
    const result = parseCommandReceipt(payload, {
      kind: 'ROLLBACK',
      version: request.expectedVersion,
    })
    return this.acceptCommand(
      state,
      request.scope,
      result,
      'rolled_back',
      state.editorOperationIdsByBatch.get(request.batchId) ?? [],
      [],
    )
  }

  private async prepareApply(
    state: ScopeState,
    request: EditorApplyRequest,
  ): Promise<{
    validation: EditorCommandValidation
    operations?: CreativeEditOperationInput[]
    serverFingerprint?: string
  }> {
    if (state.view.readonly) {
      return { validation: currentValidation(state, false, 'unsafe_operation') }
    }
    const local = await validateEditorApplyPolicy(
      state.snapshot,
      request,
      state.accessRole,
    )
    if (!local.ok) return { validation: local }
    const cached = state.preparedApplyByFingerprint.get(
      request.proposal.fingerprint,
    )
    if (
      cached
      && cached.expectedVersion === request.proposal.expectedVersion
      && cached.expectedConcurrencyToken
        === request.proposal.expectedConcurrencyToken
    ) {
      return {
        validation: currentValidation(state, true, 'valid'),
        operations: structuredClone(cached.operations),
        serverFingerprint: cached.serverFingerprint,
      }
    }

    let operations: CreativeEditOperationInput[]
    try {
      operations = compileFoundationEditorOperations(
        state.view.document,
        request.proposal.operations,
      ).operations
    } catch (error) {
      if (
        error instanceof FoundationCompositionPortError
        && error.code === 'unsupported_foundation_mapping'
      ) {
        return {
          validation: currentValidation(state, false, 'unsafe_operation'),
        }
      }
      throw error
    }

    try {
      const payload = await this.postCommand(
        state,
        'operations/validate',
        {
          expectedVersion: request.proposal.expectedVersion,
          expectedConcurrencyToken: request.proposal.expectedConcurrencyToken,
          idempotencyKey: this.applyIdempotencyKey(
            request.proposal.fingerprint,
            request.proposal.origin,
          ),
          brandProfileId: request.proposal.scope.brandProfileId,
          operations,
        },
      )
      const serverValidation = parseValidationReceipt(
        payload,
        request.proposal.expectedVersion,
        operations.length,
      )
      state.preparedApplyByFingerprint.set(request.proposal.fingerprint, {
        expectedVersion: request.proposal.expectedVersion,
        expectedConcurrencyToken: request.proposal.expectedConcurrencyToken,
        operations: structuredClone(operations),
        serverFingerprint: serverValidation.requestFingerprint,
      })
      return {
        validation: currentValidation(state, true, 'valid'),
        operations,
        serverFingerprint: serverValidation.requestFingerprint,
      }
    } catch (error) {
      if (!(error instanceof FoundationApiError)) throw error
      const code = apiValidationCode(error)
      if (!code) throwPortError(error)
      const current = apiCurrent(state, error)
      return {
        validation: currentValidation(
          state,
          false,
          code,
          current.version,
          current.token,
        ),
      }
    }
  }

  private async runHistory(
    endpoint: 'undo' | 'redo',
    foundationKind: 'UNDO' | 'REDO',
    status: 'undone' | 'redone',
    request: EditorHistoryRequest,
  ): Promise<EditorCommandReceipt> {
    const state = await this.ensureState(request.scope)
    this.assertHistoryRequest(state, request)
    const idempotencyKey = await this.historyIdempotencyKey(endpoint, request)
    try {
      const payload = await this.postCommand(state, endpoint, {
        expectedVersion: request.expectedVersion,
        expectedConcurrencyToken: request.expectedConcurrencyToken,
        idempotencyKey,
        brandProfileId: request.scope.brandProfileId,
        ...(request.batchId ? { batchId: request.batchId } : {}),
      })
      const result = parseCommandReceipt(payload, {
        kind: foundationKind,
        version: request.expectedVersion,
      })
      const operationIds = result.batch.targetBatchId
        ? state.editorOperationIdsByBatch.get(result.batch.targetBatchId) ?? []
        : []
      return this.acceptCommand(
        state,
        request.scope,
        result,
        status,
        operationIds,
        [],
      )
    } catch (error) {
      if (!(error instanceof FoundationApiError)) throw error
      if (
        error.code === 'undo_target_not_found'
        || error.code === 'redo_target_not_found'
        || error.code === 'undo_target_not_current'
        || error.code === 'redo_target_not_current'
      ) {
        if (endpoint === 'undo') state.snapshot.canUndo = false
        else state.snapshot.canRedo = false
        throw new CompositionCommandError('history_unavailable')
      }
      throwPortError(error)
    }
  }

  private assertHistoryRequest(
    state: ScopeState,
    request: EditorHistoryRequest,
  ): void {
    if (
      !sameEditorCompositionScope(state.snapshot.scope, request.scope)
      || state.view.projectId !== request.scope.projectId
      || state.view.brandProfileId !== request.scope.brandProfileId
    ) {
      throw new CompositionCommandError('scope_mismatch')
    }
    if (
      request.actor.role === 'reviewer'
      || request.actor.role !== state.accessRole
    ) {
      throw new CompositionCommandError('role_forbidden')
    }
    if (
      request.expectedVersion !== state.snapshot.version
      || request.expectedConcurrencyToken !== state.snapshot.concurrencyToken
    ) {
      throw new CompositionCommandError('stale_version')
    }
    if (state.view.readonly) {
      throw new CompositionCommandError('unsafe_operation')
    }
  }

  private async ensureState(scope: EditorCompositionScope): Promise<ScopeState> {
    const existing = this.states.get(scopeKey(scope))
    if (existing) return existing
    await this.load(scope)
    const loaded = this.states.get(scopeKey(scope))
    if (!loaded) {
      throw new FoundationCompositionPortError('invalid_foundation_response', 502)
    }
    return loaded
  }

  private async postCommand(
    state: ScopeState,
    endpoint: string,
    body: AnyRecord,
  ): Promise<unknown> {
    return this.requestJson(
      `${FOUNDATION_COMPOSITION_API_BASE_PATH}/${encodePath(state.view.id)}/${endpoint}`,
      {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  }

  private async requestJson(
    input: RequestInfo | URL,
    init: RequestInit,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(input, init)
    } catch (error) {
      throw new FoundationCompositionPortError('network_unavailable', 0, {
        cause: error instanceof Error ? error.message : 'fetch_failed',
      })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new FoundationCompositionPortError(
        'invalid_foundation_response',
        response.status,
      )
    }
    if (!response.ok) {
      const data = record(payload)
      throw new FoundationApiError(
        response.status,
        typeof data.error === 'string' ? data.error : 'foundation_request_failed',
        errorDetails(data.details),
      )
    }
    return payload
  }

  private applyIdempotencyKey(
    fingerprint: string,
    origin: 'human' | 'agent',
  ): string {
    const digest = fingerprint.replace(/^csplan-v1-/, '')
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new CompositionCommandError('fingerprint_mismatch')
    }
    return `editor-${origin}-apply-${digest}`
  }

  private async historyIdempotencyKey(
    kind: 'undo' | 'redo' | 'rollback',
    request: EditorHistoryRequest,
  ): Promise<string> {
    const digest = await sha256Hex(stableStringify({
      contractVersion: 1,
      kind,
      scope: request.scope,
      expectedVersion: request.expectedVersion,
      expectedConcurrencyToken: request.expectedConcurrencyToken,
      batchId: request.batchId ?? null,
    }))
    return `editor-${kind}-${digest}`
  }

  private acceptCommand(
    state: ScopeState,
    scope: EditorCompositionScope,
    result: FoundationCommandReceipt,
    status: EditorCommandReceipt['status'],
    operationIds: string[],
    pendingActionIds: string[],
    latestAgentBatchId?: string,
  ): EditorCommandReceipt {
    const committedAt = this.now()
    const nextView = parseFoundationCompositionView({
      ...state.view,
      currentVersion: result.version.version,
      concurrencyToken: result.version.concurrencyToken,
      updatedAt: committedAt,
      documentHash: result.version.documentHash,
      document: result.version.document,
    })
    if (
      nextView.id !== scope.compositionId
      || nextView.projectId !== scope.projectId
      || nextView.brandProfileId !== scope.brandProfileId
    ) {
      throw new FoundationCompositionPortError('invalid_foundation_response', 502)
    }

    if (status === 'applied' || status === 'rolled_back') {
      state.undoDepth += 1
      state.redoDepth = 0
    } else if (status === 'undone') {
      state.undoDepth = Math.max(0, state.undoDepth - 1)
      state.redoDepth += 1
    } else {
      state.undoDepth += 1
      state.redoDepth = Math.max(0, state.redoDepth - 1)
    }

    const activity: EditorActivityEntry = {
      id: result.batch.id,
      kind: status === 'applied'
        ? 'edit'
        : status === 'undone'
          ? 'undo'
          : status === 'redone'
            ? 'redo'
            : 'rollback',
      actorName: 'Authenticated Studio actor',
      summary: `Foundation ${result.batch.kind.toLowerCase()} batch committed as composition v${result.version.version}.`,
      version: result.version.version,
      createdAt: committedAt,
      operationIds,
    }
    const review = {
      ...state.snapshot.review,
      publishReady: false,
    }
    const context: FoundationEditorSnapshotContext = {
      ...state.context,
      review,
      activity: [...state.snapshot.activity, activity],
      canUndo: state.undoDepth > 0,
      canRedo: state.redoDepth > 0,
      latestAgentBatchId:
        latestAgentBatchId ?? state.snapshot.latestAgentBatchId,
      canRollbackLatestAgentBatch:
        Boolean(latestAgentBatchId)
        || state.snapshot.canRollbackLatestAgentBatch,
    }
    const snapshot = projectFoundationCompositionToEditor(nextView, scope, context)
    state.view = nextView
    state.context = {
      ...state.context,
      review,
      activity: snapshot.activity,
      latestAgentBatchId: snapshot.latestAgentBatchId,
      canRollbackLatestAgentBatch:
        snapshot.canRollbackLatestAgentBatch,
    }
    state.snapshot = snapshot
    state.preparedApplyByFingerprint.clear()
    state.rollbackPointByBatch.set(result.batch.id, result.rollbackPointId)
    state.editorOperationIdsByBatch.set(result.batch.id, [...operationIds])

    return {
      status,
      snapshot: structuredClone(snapshot),
      batchId: result.batch.id,
      auditId: result.batch.id,
      operationIds: [...operationIds],
      pendingActionIds: [...pendingActionIds],
    }
  }
}

export function createFoundationCompositionCommandPort(
  options: FoundationCompositionCommandPortOptions = {},
): CompositionCommandPort {
  return new FoundationCompositionCommandPort(options)
}
