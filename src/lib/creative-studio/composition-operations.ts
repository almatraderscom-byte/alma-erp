import { z } from 'zod'
import {
  assertCreativeCompositionRestoreSize,
  canonicalizeCreativeJson,
  CREATIVE_COMPOSITION_RESTORE_MAX_BYTES,
  creativeCanonicalByteLength,
  creativeCompositionCanvasSchema,
  creativeCompositionClipSchema,
  creativeCompositionNodeSchema,
  creativeCompositionTrackSchema,
  creativeSha256,
  CreativeCompositionEncodingError,
  CreativeCompositionSizeError,
  finalizeCreativeCompositionDocument,
  parseCreativeCompositionDocument,
  type CanonicalJson,
  type CreativeCompositionDocument,
} from '@/lib/creative-studio/composition-document'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'

export const CREATIVE_EDIT_OPERATION_SCHEMA_VERSION = 1 as const
export const CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES = 1024 * 1024
export const CREATIVE_EDIT_OPERATION_AUDIT_MAX_BYTES = 4 * 1024 * 1024
export const CREATIVE_RESTORE_OPERATION_AUDIT_MAX_BYTES =
  (4 * CREATIVE_COMPOSITION_RESTORE_MAX_BYTES) + (1024 * 1024)

const operationIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'invalid_operation_target_id')

const selectionSchema = z.object({
  nodeIds: z.array(operationIdSchema).max(1_000).default([]),
  trackIds: z.array(operationIdSchema).max(512).default([]),
  clipIds: z.array(operationIdSchema).max(10_000).default([]),
}).strict()

const timeRangeSchema = z.object({
  startMs: z.number().int().nonnegative().max(86_400_000),
  endMs: z.number().int().positive().max(86_400_000),
}).strict().refine((range) => range.endMs > range.startMs, 'invalid_time_range')

const operationMeta = {
  selection: selectionSchema.optional(),
  timeRange: timeRangeSchema.optional(),
}

const nodeInsertSchema = z.object({
  type: z.literal('node.insert'),
  node: creativeCompositionNodeSchema,
  index: z.number().int().nonnegative().max(10_000).optional(),
  ...operationMeta,
}).strict()

const nodeReplaceSchema = z.object({
  type: z.literal('node.replace'),
  nodeId: operationIdSchema,
  node: creativeCompositionNodeSchema,
  ...operationMeta,
}).strict()

const nodeRemoveSchema = z.object({
  type: z.literal('node.remove'),
  nodeId: operationIdSchema,
  ...operationMeta,
}).strict()

const canvasReplaceSchema = z.object({
  type: z.literal('canvas.replace'),
  canvasId: operationIdSchema,
  canvas: creativeCompositionCanvasSchema,
  ...operationMeta,
}).strict()

const trackInsertSchema = z.object({
  type: z.literal('track.insert'),
  track: creativeCompositionTrackSchema,
  index: z.number().int().nonnegative().max(2_000).optional(),
  ...operationMeta,
}).strict()

const trackReplaceSchema = z.object({
  type: z.literal('track.replace'),
  trackId: operationIdSchema,
  track: creativeCompositionTrackSchema,
  ...operationMeta,
}).strict()

const trackRemoveSchema = z.object({
  type: z.literal('track.remove'),
  trackId: operationIdSchema,
  ...operationMeta,
}).strict()

const clipInsertSchema = z.object({
  type: z.literal('clip.insert'),
  trackId: operationIdSchema,
  clip: creativeCompositionClipSchema,
  index: z.number().int().nonnegative().max(10_000).optional(),
  ...operationMeta,
}).strict()

const clipReplaceSchema = z.object({
  type: z.literal('clip.replace'),
  trackId: operationIdSchema,
  clipId: operationIdSchema,
  clip: creativeCompositionClipSchema,
  ...operationMeta,
}).strict()

const clipRemoveSchema = z.object({
  type: z.literal('clip.remove'),
  trackId: operationIdSchema,
  clipId: operationIdSchema,
  ...operationMeta,
}).strict()

export const creativeEditOperationSchema = z.discriminatedUnion('type', [
  nodeInsertSchema,
  nodeReplaceSchema,
  nodeRemoveSchema,
  canvasReplaceSchema,
  trackInsertSchema,
  trackReplaceSchema,
  trackRemoveSchema,
  clipInsertSchema,
  clipReplaceSchema,
  clipRemoveSchema,
])

const documentRestoreSchema = z.object({
  type: z.literal('document.restore'),
  document: z.unknown(),
  ...operationMeta,
}).strict()

const internalCreativeEditOperationSchema = z.union([
  creativeEditOperationSchema,
  documentRestoreSchema,
])

export type CreativeEditOperationInput = z.infer<typeof creativeEditOperationSchema>
export type CreativeInverseOperation = z.infer<typeof internalCreativeEditOperationSchema>
export type CreativeOperationSelection = z.infer<typeof selectionSchema>
export type CreativeOperationTimeRange = z.infer<typeof timeRangeSchema>
export type CreativeOperationBatchKind = 'APPLY' | 'UNDO' | 'REDO' | 'ROLLBACK'

export type CreativeEditOperation = {
  schemaVersion: typeof CREATIVE_EDIT_OPERATION_SCHEMA_VERSION
  operationId: string
  type: CreativeInverseOperation['type']
  payload: CanonicalJson
  inverse: CreativeInverseOperation
  beforeProjection: CanonicalJson
  afterProjection: CanonicalJson
  selection: CreativeOperationSelection | null
  timeRange: CreativeOperationTimeRange | null
  effectClass: 'zero_cost_local'
  estimatedCostBdt: 0
}

export type CreativeOperationBatch = {
  schemaVersion: typeof CREATIVE_EDIT_OPERATION_SCHEMA_VERSION
  batchId: string
  compositionId: string
  kind: CreativeOperationBatchKind
  idempotencyKey: string
  requestFingerprint: string
  expectedVersion: number
  expectedConcurrencyToken: string
  resultVersion: number
  resultConcurrencyToken: string
  actor: {
    userId: string
    role: StudioAccessRole
  }
  operations: CreativeEditOperation[]
  inverseOperations: CreativeInverseOperation[]
  effectClass: 'zero_cost_local'
  estimatedCostBdt: 0
  document: CreativeCompositionDocument
  documentHash: string
}

export type CreativeRollbackRequest = {
  expectedVersion: number
  expectedConcurrencyToken: string
  idempotencyKey: string
  rollbackPointId: string
}

export class CompositionOperationError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    status = 422,
    details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'CompositionOperationError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function cloneDocument(document: CreativeCompositionDocument): CreativeCompositionDocument {
  return JSON.parse(JSON.stringify(document)) as CreativeCompositionDocument
}

function failValidation(error: unknown): never {
  if (error instanceof CompositionOperationError) throw error
  if (error instanceof CreativeCompositionSizeError) {
    throw new CompositionOperationError(error.code, error.status, {
      actualBytes: error.actualBytes,
      maxBytes: error.maxBytes,
    })
  }
  if (error instanceof CreativeCompositionEncodingError) {
    throw new CompositionOperationError(error.code, error.status)
  }
  if (error instanceof z.ZodError) {
    throw new CompositionOperationError('invalid_composition_operation', 422, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
  throw error
}

export function normalizeCreativeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new CompositionOperationError('idempotency_key_required', 422)
  }
  return key
}

export function assertCreativeEditOperationBatchSize(value: unknown): number {
  let actualBytes: number
  try {
    actualBytes = creativeCanonicalByteLength(value)
  } catch {
    throw new CompositionOperationError('invalid_creative_operation_json', 422)
  }
  if (actualBytes > CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES) {
    throw new CompositionOperationError('creative_operation_batch_too_large', 413, {
      actualBytes,
      maxBytes: CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES,
    })
  }
  return actualBytes
}

function assertCreativeOperationAuditSize(
  value: unknown,
  restore: boolean,
): number {
  const actualBytes = creativeCanonicalByteLength(value)
  const maxBytes = restore
    ? CREATIVE_RESTORE_OPERATION_AUDIT_MAX_BYTES
    : CREATIVE_EDIT_OPERATION_AUDIT_MAX_BYTES
  if (actualBytes > maxBytes) {
    throw new CompositionOperationError(
      restore
        ? 'composition_restore_audit_too_large'
        : 'creative_operation_audit_too_large',
      413,
      { actualBytes, maxBytes },
    )
  }
  return actualBytes
}

export function parseCreativeEditOperations(value: unknown): CreativeEditOperationInput[] {
  try {
    assertCreativeEditOperationBatchSize(value)
    const parsed = z.array(creativeEditOperationSchema).min(1).max(100).parse(value)
    assertCreativeEditOperationBatchSize(parsed)
    return parsed
  } catch (error) {
    return failValidation(error)
  }
}

export function parseCreativeInverseOperation(value: unknown): CreativeInverseOperation {
  try {
    if (value && typeof value === 'object' && objectType(value) === 'document.restore') {
      assertCreativeCompositionRestoreSize(
        (value as { document?: unknown }).document,
      )
    }
    const parsed = internalCreativeEditOperationSchema.parse(value)
    if (parsed.type === 'document.restore') {
      const restored = {
        ...parsed,
        document: parseCreativeCompositionDocument(parsed.document),
      }
      assertCreativeCompositionRestoreSize(restored.document)
      return restored
    }
    assertCreativeEditOperationBatchSize([parsed])
    return parsed
  } catch (error) {
    return failValidation(error)
  }
}

function objectType(value: object): unknown {
  return 'type' in value ? (value as { type?: unknown }).type : undefined
}

function operationPayload(operation: CreativeInverseOperation): CanonicalJson {
  const {
    type: _type,
    selection: _selection,
    timeRange: _timeRange,
    ...payload
  } = operation
  return canonicalizeCreativeJson(payload)
}

function operationSelection(
  operation: CreativeInverseOperation,
): CreativeOperationSelection | null {
  return operation.selection ?? null
}

function operationTimeRange(
  operation: CreativeInverseOperation,
): CreativeOperationTimeRange | null {
  return operation.timeRange ?? null
}

function assertIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new CompositionOperationError('operation_index_out_of_bounds')
  }
}

function rebuildCanvasTrackIndexes(document: CreativeCompositionDocument): void {
  const trackIdsByCanvas = new Map<string, string[]>()
  for (const track of document.tracks) {
    const trackIds = trackIdsByCanvas.get(track.canvasId) ?? []
    trackIds.push(track.id)
    trackIdsByCanvas.set(track.canvasId, trackIds)
  }
  document.canvases = document.canvases.map((canvas) => ({
    ...canvas,
    trackIds: trackIdsByCanvas.get(canvas.id) ?? [],
  }))
}

function ensureOperationDocument(
  current: CreativeCompositionDocument,
  next: CreativeCompositionDocument,
): CreativeCompositionDocument {
  try {
    const parsed = parseCreativeCompositionDocument(next)
    if (parsed.compositionId !== current.compositionId) {
      throw new CompositionOperationError('composition_identity_change_forbidden')
    }
    if (parsed.project.projectId !== current.project.projectId) {
      throw new CompositionOperationError('project_identity_change_forbidden')
    }
    if (parsed.project.ownerId !== current.project.ownerId) {
      throw new CompositionOperationError('owner_identity_change_forbidden')
    }
    if (parsed.project.brandProfileId !== current.project.brandProfileId) {
      throw new CompositionOperationError('brand_identity_change_forbidden')
    }
    return parsed
  } catch (error) {
    return failValidation(error)
  }
}

export function applyCreativeEditOperation(
  document: CreativeCompositionDocument,
  rawOperation: CreativeInverseOperation,
): {
  document: CreativeCompositionDocument
  inverse: CreativeInverseOperation
  beforeProjection: CanonicalJson
  afterProjection: CanonicalJson
} {
  if (document.readonly) throw new CompositionOperationError('composition_readonly', 409)
  const operation = parseCreativeInverseOperation(rawOperation)
  const next = cloneDocument(document)
  let inverse: CreativeInverseOperation
  let beforeProjection: CanonicalJson
  let afterProjection: CanonicalJson

  switch (operation.type) {
    case 'node.insert': {
      if (next.nodes.some((node) => node.id === operation.node.id)) {
        throw new CompositionOperationError('node_already_exists', 409)
      }
      const index = operation.index ?? next.nodes.length
      assertIndex(index, next.nodes.length)
      next.nodes.splice(index, 0, operation.node)
      inverse = {
        type: 'node.remove',
        nodeId: operation.node.id,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = null
      afterProjection = canonicalizeCreativeJson(operation.node)
      break
    }
    case 'node.replace': {
      const index = next.nodes.findIndex((node) => node.id === operation.nodeId)
      if (index < 0) throw new CompositionOperationError('node_not_found', 404)
      if (operation.node.id !== operation.nodeId) {
        throw new CompositionOperationError('node_identity_change_forbidden')
      }
      const previous = next.nodes[index]
      next.nodes[index] = operation.node
      inverse = {
        type: 'node.replace',
        nodeId: operation.nodeId,
        node: previous,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(previous)
      afterProjection = canonicalizeCreativeJson(operation.node)
      break
    }
    case 'node.remove': {
      const index = next.nodes.findIndex((node) => node.id === operation.nodeId)
      if (index < 0) throw new CompositionOperationError('node_not_found', 404)
      if (next.tracks.some((track) => track.clips.some((clip) => clip.nodeId === operation.nodeId))) {
        throw new CompositionOperationError('node_in_use', 409)
      }
      const [removed] = next.nodes.splice(index, 1)
      inverse = {
        type: 'node.insert',
        node: removed,
        index,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(removed)
      afterProjection = null
      break
    }
    case 'canvas.replace': {
      const index = next.canvases.findIndex((canvas) => canvas.id === operation.canvasId)
      if (index < 0) throw new CompositionOperationError('canvas_not_found', 404)
      if (operation.canvas.id !== operation.canvasId) {
        throw new CompositionOperationError('canvas_identity_change_forbidden')
      }
      const previous = next.canvases[index]
      next.canvases[index] = operation.canvas
      inverse = {
        type: 'canvas.replace',
        canvasId: operation.canvasId,
        canvas: previous,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(previous)
      afterProjection = canonicalizeCreativeJson(operation.canvas)
      break
    }
    case 'track.insert': {
      if (next.tracks.some((track) => track.id === operation.track.id)) {
        throw new CompositionOperationError('track_already_exists', 409)
      }
      if (!next.canvases.some((canvas) => canvas.id === operation.track.canvasId)) {
        throw new CompositionOperationError('track_canvas_not_found', 404)
      }
      const index = operation.index ?? next.tracks.length
      assertIndex(index, next.tracks.length)
      next.tracks.splice(index, 0, operation.track)
      rebuildCanvasTrackIndexes(next)
      inverse = {
        type: 'track.remove',
        trackId: operation.track.id,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = null
      afterProjection = canonicalizeCreativeJson(operation.track)
      break
    }
    case 'track.replace': {
      const index = next.tracks.findIndex((track) => track.id === operation.trackId)
      if (index < 0) throw new CompositionOperationError('track_not_found', 404)
      if (operation.track.id !== operation.trackId) {
        throw new CompositionOperationError('track_identity_change_forbidden')
      }
      const previous = next.tracks[index]
      if (operation.track.canvasId !== previous.canvasId) {
        throw new CompositionOperationError('track_canvas_change_forbidden')
      }
      next.tracks[index] = operation.track
      rebuildCanvasTrackIndexes(next)
      inverse = {
        type: 'track.replace',
        trackId: operation.trackId,
        track: previous,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(previous)
      afterProjection = canonicalizeCreativeJson(operation.track)
      break
    }
    case 'track.remove': {
      const index = next.tracks.findIndex((track) => track.id === operation.trackId)
      if (index < 0) throw new CompositionOperationError('track_not_found', 404)
      const [removed] = next.tracks.splice(index, 1)
      rebuildCanvasTrackIndexes(next)
      inverse = {
        type: 'track.insert',
        track: removed,
        index,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(removed)
      afterProjection = null
      break
    }
    case 'clip.insert': {
      const trackIndex = next.tracks.findIndex((track) => track.id === operation.trackId)
      if (trackIndex < 0) throw new CompositionOperationError('track_not_found', 404)
      if (next.tracks.some((track) => track.clips.some((clip) => clip.id === operation.clip.id))) {
        throw new CompositionOperationError('clip_already_exists', 409)
      }
      const clips = next.tracks[trackIndex].clips
      const index = operation.index ?? clips.length
      assertIndex(index, clips.length)
      clips.splice(index, 0, operation.clip)
      inverse = {
        type: 'clip.remove',
        trackId: operation.trackId,
        clipId: operation.clip.id,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = null
      afterProjection = canonicalizeCreativeJson(operation.clip)
      break
    }
    case 'clip.replace': {
      const trackIndex = next.tracks.findIndex((track) => track.id === operation.trackId)
      if (trackIndex < 0) throw new CompositionOperationError('track_not_found', 404)
      const clipIndex = next.tracks[trackIndex].clips.findIndex(
        (clip) => clip.id === operation.clipId,
      )
      if (clipIndex < 0) throw new CompositionOperationError('clip_not_found', 404)
      if (operation.clip.id !== operation.clipId) {
        throw new CompositionOperationError('clip_identity_change_forbidden')
      }
      const previous = next.tracks[trackIndex].clips[clipIndex]
      next.tracks[trackIndex].clips[clipIndex] = operation.clip
      inverse = {
        type: 'clip.replace',
        trackId: operation.trackId,
        clipId: operation.clipId,
        clip: previous,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(previous)
      afterProjection = canonicalizeCreativeJson(operation.clip)
      break
    }
    case 'clip.remove': {
      const trackIndex = next.tracks.findIndex((track) => track.id === operation.trackId)
      if (trackIndex < 0) throw new CompositionOperationError('track_not_found', 404)
      const clipIndex = next.tracks[trackIndex].clips.findIndex(
        (clip) => clip.id === operation.clipId,
      )
      if (clipIndex < 0) throw new CompositionOperationError('clip_not_found', 404)
      const [removed] = next.tracks[trackIndex].clips.splice(clipIndex, 1)
      inverse = {
        type: 'clip.insert',
        trackId: operation.trackId,
        clip: removed,
        index: clipIndex,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(removed)
      afterProjection = null
      break
    }
    case 'document.restore': {
      const restored = parseCreativeCompositionDocument(operation.document)
      const currentSnapshot = cloneDocument(document)
      const restoredSnapshot: CreativeCompositionDocument = {
        ...restored,
        compositionId: document.compositionId,
        documentVersion: document.documentVersion,
        concurrencyToken: document.concurrencyToken,
        readonly: false,
        project: {
          ...restored.project,
          projectId: document.project.projectId,
          ownerId: document.project.ownerId,
          brandProfileId: document.project.brandProfileId,
        },
      }
      inverse = {
        type: 'document.restore',
        document: currentSnapshot,
        selection: operation.selection,
        timeRange: operation.timeRange,
      }
      beforeProjection = canonicalizeCreativeJson(currentSnapshot)
      afterProjection = canonicalizeCreativeJson(restoredSnapshot)
      return {
        document: ensureOperationDocument(document, restoredSnapshot),
        inverse,
        beforeProjection,
        afterProjection,
      }
    }
  }

  return {
    document: ensureOperationDocument(document, next),
    inverse,
    beforeProjection,
    afterProjection,
  }
}

export function creativeOperationRequestFingerprint(input: {
  compositionId: string
  kind: CreativeOperationBatchKind
  expectedVersion: number
  expectedConcurrencyToken: string
  idempotencyKey: string
  actorId: string
  actorRole: StudioAccessRole
  operations: CreativeInverseOperation[]
  targetBatchId?: string | null
  targetVersion?: number | null
  targetReference?: string | null
}): string {
  const restoreOperations = input.operations.filter(
    (
      operation,
    ): operation is Extract<CreativeInverseOperation, { type: 'document.restore' }> =>
      operation.type === 'document.restore',
  )
  if (restoreOperations.length) {
    if (restoreOperations.length !== 1 || input.operations.length !== 1) {
      throw new CompositionOperationError('restore_batch_must_be_single_operation')
    }
    try {
      assertCreativeCompositionRestoreSize(restoreOperations[0].document)
    } catch (error) {
      return failValidation(error)
    }
  } else {
    assertCreativeEditOperationBatchSize(input.operations)
  }
  return creativeSha256({
    schemaVersion: CREATIVE_EDIT_OPERATION_SCHEMA_VERSION,
    ...input,
    targetBatchId: input.targetBatchId ?? null,
    targetVersion: input.targetVersion ?? null,
    targetReference: input.targetReference ?? null,
  })
}

/**
 * Pure deterministic compiler. Authorization is deliberately not performed
 * here; the server composition service is the only caller allowed to supply
 * the actor/role after resolving them from the authenticated request and brand
 * assignment. The compiler never accepts a caller-provided fingerprint.
 */
export function compileCreativeOperationBatch(input: {
  document: CreativeCompositionDocument
  kind: CreativeOperationBatchKind
  expectedVersion: number
  expectedConcurrencyToken: string
  idempotencyKey: unknown
  actor: {
    userId: string
    role: StudioAccessRole
  }
  operations: CreativeInverseOperation[]
  targetBatchId?: string | null
  targetVersion?: number | null
  targetReference?: string | null
}): CreativeOperationBatch {
  const document = parseCreativeCompositionDocument(input.document)
  if (document.readonly) throw new CompositionOperationError('composition_readonly', 409)
  if (
    document.documentVersion !== input.expectedVersion
    || document.concurrencyToken !== input.expectedConcurrencyToken
  ) {
    throw new CompositionOperationError('composition_conflict', 409, {
      currentVersion: document.documentVersion,
      currentConcurrencyToken: document.concurrencyToken,
    })
  }
  if (input.operations.length < 1 || input.operations.length > 100) {
    throw new CompositionOperationError('operation_batch_size_invalid')
  }
  const restoreBatch = input.operations.some(
    (operation) => operation.type === 'document.restore',
  )
  if (restoreBatch) {
    if (
      input.operations.length !== 1
      || input.operations[0].type !== 'document.restore'
    ) {
      throw new CompositionOperationError('restore_batch_must_be_single_operation')
    }
    try {
      assertCreativeCompositionRestoreSize(input.operations[0].document)
    } catch (error) {
      return failValidation(error)
    }
  } else {
    assertCreativeEditOperationBatchSize(input.operations)
  }
  const idempotencyKey = normalizeCreativeIdempotencyKey(input.idempotencyKey)
  const operations = input.operations.map(parseCreativeInverseOperation)
  const requestFingerprint = creativeOperationRequestFingerprint({
    compositionId: document.compositionId,
    kind: input.kind,
    expectedVersion: input.expectedVersion,
    expectedConcurrencyToken: input.expectedConcurrencyToken,
    idempotencyKey,
    actorId: input.actor.userId,
    actorRole: input.actor.role,
    operations,
    targetBatchId: input.targetBatchId,
    targetVersion: input.targetVersion,
    targetReference: input.targetReference,
  })
  const batchId = `cob_${requestFingerprint.slice(0, 32)}`
  let nextDocument = cloneDocument(document)
  const planned: CreativeEditOperation[] = []

  for (const [index, operation] of operations.entries()) {
    const applied = applyCreativeEditOperation(nextDocument, operation)
    const operationId = `ceo_${creativeSha256({
      batchId,
      sequence: index + 1,
      operation,
    }).slice(0, 32)}`
    planned.push({
      schemaVersion: CREATIVE_EDIT_OPERATION_SCHEMA_VERSION,
      operationId,
      type: operation.type,
      payload: operationPayload(operation),
      inverse: applied.inverse,
      beforeProjection: applied.beforeProjection,
      afterProjection: applied.afterProjection,
      selection: operationSelection(operation),
      timeRange: operationTimeRange(operation),
      effectClass: 'zero_cost_local',
      estimatedCostBdt: 0,
    })
    nextDocument = applied.document
  }

  const finalized = finalizeCreativeCompositionDocument(nextDocument, {
    compositionId: document.compositionId,
    documentVersion: input.expectedVersion + 1,
    readonly: false,
  })
  assertCreativeOperationAuditSize(planned, restoreBatch)
  return {
    schemaVersion: CREATIVE_EDIT_OPERATION_SCHEMA_VERSION,
    batchId,
    compositionId: document.compositionId,
    kind: input.kind,
    idempotencyKey,
    requestFingerprint,
    expectedVersion: input.expectedVersion,
    expectedConcurrencyToken: input.expectedConcurrencyToken,
    resultVersion: input.expectedVersion + 1,
    resultConcurrencyToken: finalized.concurrencyToken,
    actor: input.actor,
    operations: planned,
    inverseOperations: [...planned].reverse().map((operation) => operation.inverse),
    effectClass: 'zero_cost_local',
    estimatedCostBdt: 0,
    document: finalized.document,
    documentHash: finalized.documentHash,
  }
}
