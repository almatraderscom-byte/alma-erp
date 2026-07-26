import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  assertStudioBrandScope,
  assertStudioCapability,
  listAccessibleStudioBrands,
  requireStudioBrandAccess,
  studioRoleToDb,
  StudioAccessError,
  type StudioActor,
  type StudioBrandAccess,
} from '@/lib/creative-studio/studio-access'
import {
  creativeCompositionNodeIndexRows,
  creativeSha256,
  CreativeCompositionEncodingError,
  CreativeCompositionSizeError,
  parseCreativeCompositionDocument,
  type CreativeCompositionDocument,
} from '@/lib/creative-studio/composition-document'
import {
  CompositionOperationError,
  compileCreativeOperationBatch,
  creativeOperationRequestFingerprint,
  normalizeCreativeIdempotencyKey,
  parseCreativeEditOperations,
  parseCreativeInverseOperation,
  type CreativeEditOperationInput,
  type CreativeInverseOperation,
  type CreativeOperationBatch,
  type CreativeOperationBatchKind,
} from '@/lib/creative-studio/composition-operations'
import {
  projectToReadonlyComposition,
  type ExistingProjectProjectionInput,
} from '@/lib/creative-studio/composition-projection'

// Structural boundary keeps focused tests independent from a freshly generated
// Prisma client while schema and migration are reviewed together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type AnyRecord = Record<string, unknown>
type DbClient = typeof db

const createCompositionSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  brandProfileId: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  idempotencyKey: z.unknown(),
}).strict()

const compositionCommandSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedConcurrencyToken: z.string().min(16).max(128),
  idempotencyKey: z.unknown(),
  brandProfileId: z.string().trim().min(1).max(160).optional(),
  operations: z.unknown(),
}).strict()

const historyCommandSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedConcurrencyToken: z.string().min(16).max(128),
  idempotencyKey: z.unknown(),
  brandProfileId: z.string().trim().min(1).max(160).optional(),
  batchId: z.string().trim().min(1).max(160).optional(),
}).strict()

const rollbackCommandSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedConcurrencyToken: z.string().min(16).max(128),
  idempotencyKey: z.unknown(),
  brandProfileId: z.string().trim().min(1).max(160).optional(),
  rollbackPointId: z.string().trim().min(1).max(160),
}).strict()

type NormalizedCommand = {
  expectedVersion: number
  expectedConcurrencyToken: string
  idempotencyKey: string
  brandProfileId?: string
}

export type CreativeCompositionSummary = {
  id: string
  ownerId: string
  brandProfileId: string
  projectId: string
  title: string
  sourceKind: 'project_projection' | 'native'
  schemaVersion: number
  currentVersion: number
  concurrencyToken: string
  readonly: boolean
  createdById: string
  createdAt: string
  updatedAt: string
}

export type CreativeCompositionView = CreativeCompositionSummary & {
  document: CreativeCompositionDocument
  documentHash: string
  accessRole: StudioBrandAccess['role']
  history: CreativeCompositionHistoryView
}

export type CreativeCompositionHistoryActivity = {
  id: string
  kind: 'apply' | 'undo' | 'redo' | 'rollback'
  origin: 'human' | 'agent' | 'system'
  actorId: string
  actorName: string
  actorRole: StudioBrandAccess['role']
  resultVersion: number
  targetBatchId: string | null
  rollbackPointId: string
  createdAt: string
  operationIds: string[]
}

export type CreativeCompositionHistoryView = {
  canUndo: boolean
  canRedo: boolean
  undoDepth: number
  redoDepth: number
  currentUndoBatchId: string | null
  currentRedoBatchId: string | null
  latestAgentBatchId: string | null
  canRollbackLatestAgentBatch: boolean
  rollbackPoints: Array<{
    batchId: string
    rollbackPointId: string
  }>
  activity: CreativeCompositionHistoryActivity[]
}

export type CreativeCompositionProjectionView = {
  projectId: string
  brandProfileId: string
  accessRole: StudioBrandAccess['role']
  readonly: true
  persisted: false
  document: CreativeCompositionDocument
  documentHash: string
}

export type CreativeCompositionCommandResult = {
  idempotent: boolean
  batch: {
    id: string
    kind: CreativeOperationBatchKind
    requestFingerprint: string
    expectedVersion: number
    resultVersion: number
    operationCount: number
    targetBatchId: string | null
    targetVersion: number | null
  }
  version: {
    version: number
    concurrencyToken: string
    documentHash: string
    document: CreativeCompositionDocument
  }
  rollbackPointId: string
}

export class CompositionServiceError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    status = 422,
    details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'CompositionServiceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function object(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const date = new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function dbSourceKind(value: unknown): 'project_projection' | 'native' {
  return String(value).toUpperCase() === 'NATIVE' ? 'native' : 'project_projection'
}

function failInput(error: unknown): never {
  if (
    error instanceof CompositionServiceError
    || error instanceof StudioAccessError
    || error instanceof CompositionOperationError
    || error instanceof CreativeCompositionSizeError
    || error instanceof CreativeCompositionEncodingError
  ) throw error
  if (error instanceof z.ZodError) {
    throw new CompositionServiceError('invalid_composition_request', 422, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
  throw error
}

function normalizeCommand(value: unknown): NormalizedCommand & {
  operations: CreativeEditOperationInput[]
} {
  try {
    const parsed = compositionCommandSchema.parse(value)
    return {
      expectedVersion: parsed.expectedVersion,
      expectedConcurrencyToken: parsed.expectedConcurrencyToken,
      idempotencyKey: normalizeCreativeIdempotencyKey(parsed.idempotencyKey),
      brandProfileId: parsed.brandProfileId,
      operations: parseCreativeEditOperations(parsed.operations),
    }
  } catch (error) {
    return failInput(error)
  }
}

function normalizeHistoryCommand(value: unknown): NormalizedCommand & { batchId?: string } {
  try {
    const parsed = historyCommandSchema.parse(value)
    return {
      expectedVersion: parsed.expectedVersion,
      expectedConcurrencyToken: parsed.expectedConcurrencyToken,
      idempotencyKey: normalizeCreativeIdempotencyKey(parsed.idempotencyKey),
      brandProfileId: parsed.brandProfileId,
      batchId: parsed.batchId,
    }
  } catch (error) {
    return failInput(error)
  }
}

function normalizeRollbackCommand(value: unknown): NormalizedCommand & {
  rollbackPointId: string
} {
  try {
    const parsed = rollbackCommandSchema.parse(value)
    return {
      expectedVersion: parsed.expectedVersion,
      expectedConcurrencyToken: parsed.expectedConcurrencyToken,
      idempotencyKey: normalizeCreativeIdempotencyKey(parsed.idempotencyKey),
      brandProfileId: parsed.brandProfileId,
      rollbackPointId: parsed.rollbackPointId,
    }
  } catch (error) {
    return failInput(error)
  }
}

function summary(row: AnyRecord): CreativeCompositionSummary {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    brandProfileId: String(row.brandProfileId),
    projectId: String(row.projectId),
    title: String(row.title),
    sourceKind: dbSourceKind(row.sourceKind),
    schemaVersion: Number(row.schemaVersion),
    currentVersion: Number(row.currentVersion),
    concurrencyToken: String(row.concurrencyToken),
    readonly: Boolean(row.readOnly),
    createdById: String(row.createdById),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function assertVersionCoherence(
  row: AnyRecord,
  versionRow: AnyRecord,
): CreativeCompositionDocument {
  const document = parseCreativeCompositionDocument(versionRow.document)
  if (
    document.compositionId !== String(row.id)
    || document.project.projectId !== String(row.projectId)
    || document.project.ownerId !== String(row.ownerId)
    || document.project.brandProfileId !== String(row.brandProfileId)
    || document.documentVersion !== Number(versionRow.version)
    || document.documentVersion !== Number(row.currentVersion)
    || document.concurrencyToken !== String(row.concurrencyToken)
  ) {
    throw new CompositionServiceError('composition_integrity_failed', 500)
  }
  return document
}

async function currentVersionRow(client: DbClient, row: AnyRecord): Promise<AnyRecord> {
  const version = await client.creativeCompositionVersion.findUnique({
    where: {
      compositionId_version: {
        compositionId: String(row.id),
        version: Number(row.currentVersion),
      },
    },
  })
  if (!version) throw new CompositionServiceError('composition_version_missing', 500)
  return version
}

async function compositionAccess(
  actor: StudioActor,
  compositionId: string,
): Promise<{ row: AnyRecord; access: StudioBrandAccess; versionRow: AnyRecord }> {
  const row = await db.creativeComposition.findUnique({ where: { id: compositionId } })
  if (!row || row.archivedAt) throw new CompositionServiceError('composition_not_found', 404)
  const access = await requireStudioBrandAccess(actor, String(row.brandProfileId))
  const versionRow = await currentVersionRow(db, row)
  assertVersionCoherence(row, versionRow)
  return { row, access, versionRow }
}

function projectionDuration(metadata: unknown): number | null {
  const values = object(metadata)
  const raw = values.durationMs ?? values.duration_ms
  const duration = Number(raw)
  return Number.isInteger(duration) && duration > 0 ? duration : null
}

async function projectProjectionContext(
  actor: StudioActor,
  projectId: string,
  requestedBrandProfileId?: string | null,
): Promise<{
  row: AnyRecord
  access: StudioBrandAccess
  projectionInput: ExistingProjectProjectionInput
}> {
  if (projectId === 'legacy') throw new CompositionServiceError('legacy_project_readonly', 409)
  const row = await db.creativeProject.findUnique({
    where: { id: projectId },
    include: {
      currentRecipe: true,
      assets: {
        include: {
          versions: {
            orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      },
    },
  })
  if (!row || row.archivedAt) throw new CompositionServiceError('project_not_found', 404)
  const brandProfileId = typeof row.brandProfileId === 'string' ? row.brandProfileId : null
  if (!brandProfileId) {
    throw new CompositionServiceError('project_brand_missing', 409, {
      projectId: String(row.id),
    })
  }
  assertStudioBrandScope(brandProfileId, requestedBrandProfileId)
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  const recipe = object(row.currentRecipe)
  const assets = Array.isArray(row.assets) ? row.assets : []
  const projectionAssets = assets.flatMap((entry: unknown) => {
    const asset = object(entry)
    const versions = Array.isArray(asset.versions) ? asset.versions : []
    const version = object(versions[0])
    if (!version.id) return []
    return [{
      id: String(asset.id),
      assetType: String(asset.assetType ?? 'image'),
      title: typeof asset.title === 'string' ? asset.title : null,
      versionId: String(version.id),
      version: Number(version.version),
      durationMs: projectionDuration(version.metadata),
    }]
  })
  const hasProduct = typeof row.productCode === 'string' && row.productCode.trim()
  return {
    row,
    access,
    projectionInput: {
      projectId: String(row.id),
      ownerId: String(row.ownerId),
      brandProfileId,
      name: String(row.name),
      defaultFolder: String(row.defaultFolder ?? 'Unsorted'),
      product: hasProduct
        ? {
            code: String(row.productCode),
            name: String(row.productName ?? row.productCode),
            priceBdt: row.productPriceBdt == null ? null : Number(row.productPriceBdt),
            sourceImage: typeof row.productSourceImage === 'string'
              ? row.productSourceImage
              : null,
          }
        : null,
      recipe: recipe.id
        ? {
            id: String(recipe.id),
            version: Number(recipe.version),
            name: String(recipe.name),
          }
        : null,
      assets: projectionAssets,
      readonly: true,
    },
  }
}

export async function getExistingProjectCompositionProjection(
  actor: StudioActor,
  projectId: string,
  requestedBrandProfileId?: string | null,
): Promise<CreativeCompositionProjectionView> {
  const { access, projectionInput } = await projectProjectionContext(
    actor,
    projectId,
    requestedBrandProfileId,
  )
  const projection = projectToReadonlyComposition(projectionInput)
  return {
    projectId,
    brandProfileId: access.brandProfileId,
    accessRole: access.role,
    readonly: true,
    persisted: false,
    document: projection.document,
    documentHash: projection.documentHash,
  }
}

export async function listCreativeCompositions(
  actor: StudioActor,
  filters: {
    brandProfileId?: string | null
    projectId?: string | null
  } = {},
): Promise<CreativeCompositionSummary[]> {
  let brandProfileIds: string[]
  if (filters.projectId) {
    const context = await projectProjectionContext(
      actor,
      filters.projectId,
      filters.brandProfileId,
    )
    brandProfileIds = [context.access.brandProfileId]
  } else if (filters.brandProfileId) {
    const access = await requireStudioBrandAccess(actor, filters.brandProfileId)
    brandProfileIds = [access.brandProfileId]
  } else {
    brandProfileIds = (await listAccessibleStudioBrands(actor))
      .map((brand) => brand.brandProfileId)
  }
  if (!brandProfileIds.length) return []
  const rows = await db.creativeComposition.findMany({
    where: {
      brandProfileId: { in: brandProfileIds },
      archivedAt: null,
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  })
  return rows.map((row: AnyRecord) => summary(row))
}

export async function getCreativeComposition(
  actor: StudioActor,
  compositionId: string,
  requestedBrandProfileId?: string | null,
): Promise<CreativeCompositionView> {
  const { row, access, versionRow } = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(row.brandProfileId), requestedBrandProfileId)
  const history = await getCompositionHistory(
    db,
    String(row.id),
    Number(row.currentVersion),
  )
  return {
    ...summary(row),
    document: assertVersionCoherence(row, versionRow),
    documentHash: String(versionRow.documentHash),
    accessRole: access.role,
    history,
  }
}

async function replayCreatedComposition(
  actor: StudioActor,
  ownerId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<CreativeCompositionView | null> {
  const existing = await db.creativeComposition.findUnique({
    where: { ownerId_creationIdempotencyKey: { ownerId, creationIdempotencyKey: idempotencyKey } },
  })
  if (!existing) return null
  if (existing.creationRequestFingerprint !== requestFingerprint) {
    throw new CompositionServiceError('idempotency_conflict', 409)
  }
  return getCreativeComposition(actor, String(existing.id), String(existing.brandProfileId))
}

export async function createCreativeComposition(
  actor: StudioActor,
  value: unknown,
): Promise<{ composition: CreativeCompositionView; idempotent: boolean }> {
  let parsed: z.infer<typeof createCompositionSchema>
  try {
    parsed = createCompositionSchema.parse(value)
  } catch (error) {
    return failInput(error)
  }
  const idempotencyKey = normalizeCreativeIdempotencyKey(parsed.idempotencyKey)
  const context = await projectProjectionContext(
    actor,
    parsed.projectId,
    parsed.brandProfileId,
  )
  assertStudioCapability(context.access.role, 'draft')
  const title = parsed.title ?? `${context.projectionInput.name} composition`
  const requestFingerprint = creativeSha256({
    schemaVersion: 1,
    intent: 'create_composition',
    actorId: actor.userId,
    actorRole: context.access.role,
    ownerId: context.access.ownerId,
    projectId: parsed.projectId,
    brandProfileId: context.access.brandProfileId,
    title,
  })
  const replay = await replayCreatedComposition(
    actor,
    context.access.ownerId,
    idempotencyKey,
    requestFingerprint,
  )
  if (replay) return { composition: replay, idempotent: true }

  const compositionId = randomUUID()
  const projected = projectToReadonlyComposition({
    ...context.projectionInput,
    compositionId,
    readonly: false,
  })
  const createBatchId = `cob_${creativeSha256({
    requestFingerprint,
    idempotencyKey,
  }).slice(0, 32)}`

  try {
    const created = await db.$transaction(async (tx: DbClient) => {
      const composition = await tx.creativeComposition.create({
        data: {
          id: compositionId,
          ownerId: context.access.ownerId,
          brandProfileId: context.access.brandProfileId,
          projectId: parsed.projectId,
          title,
          sourceKind: 'PROJECT_PROJECTION',
          schemaVersion: projected.document.schemaVersion,
          currentVersion: projected.document.documentVersion,
          concurrencyToken: projected.concurrencyToken,
          readOnly: false,
          creationIdempotencyKey: idempotencyKey,
          creationRequestFingerprint: requestFingerprint,
          createdById: actor.userId,
        },
      })
      await tx.creativeOperationBatch.create({
        data: {
          id: createBatchId,
          compositionId,
          idempotencyKey,
          requestFingerprint,
          kind: 'CREATE',
          expectedVersion: 0,
          resultVersion: 1,
          actorId: actor.userId,
          actorRole: studioRoleToDb(context.access.role),
          operationCount: 0,
          effectClass: 'ZERO_COST_LOCAL',
          estimatedCostBdt: 0,
        },
      })
      const version = await tx.creativeCompositionVersion.create({
        data: {
          compositionId,
          version: 1,
          schemaVersion: projected.document.schemaVersion,
          parentVersion: null,
          document: projected.document,
          documentHash: projected.documentHash,
          operationBatchId: createBatchId,
          createdById: actor.userId,
        },
      })
      const nodes = creativeCompositionNodeIndexRows(projected.document)
      if (nodes.length) {
        await tx.creativeCompositionNode.createMany({
          data: nodes.map((node) => ({
            compositionVersionId: version.id,
            ...node,
          })),
        })
      }
      return { composition, version }
    })
    return {
      composition: {
        ...summary(created.composition),
        document: projected.document,
        documentHash: projected.documentHash,
        accessRole: context.access.role,
        history: emptyCompositionHistory(),
      },
      idempotent: false,
    }
  } catch (error) {
    if (object(error).code !== 'P2002') throw error
    const raced = await replayCreatedComposition(
      actor,
      context.access.ownerId,
      idempotencyKey,
      requestFingerprint,
    )
    if (!raced) throw new CompositionServiceError('idempotency_conflict', 409)
    return { composition: raced, idempotent: true }
  }
}

function commandFingerprint(input: {
  compositionId: string
  kind: CreativeOperationBatchKind
  actor: StudioActor
  access: StudioBrandAccess
  command: NormalizedCommand
  operations: CreativeInverseOperation[]
  batchId?: string | null
  targetVersion?: number | null
  targetReference?: string | null
}): string {
  return creativeOperationRequestFingerprint({
    compositionId: input.compositionId,
    kind: input.kind,
    expectedVersion: input.command.expectedVersion,
    expectedConcurrencyToken: input.command.expectedConcurrencyToken,
    idempotencyKey: input.command.idempotencyKey,
    actorId: input.actor.userId,
    actorRole: input.access.role,
    operations: input.operations,
    targetBatchId: input.batchId,
    targetVersion: input.targetVersion,
    targetReference: input.targetReference,
  })
}

async function replayCommand(
  compositionId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<CreativeCompositionCommandResult | null> {
  const batch = await db.creativeOperationBatch.findUnique({
    where: {
      compositionId_idempotencyKey: {
        compositionId,
        idempotencyKey,
      },
    },
  })
  if (!batch) return null
  if (batch.requestFingerprint !== requestFingerprint) {
    throw new CompositionServiceError('idempotency_conflict', 409)
  }
  const version = await db.creativeCompositionVersion.findUnique({
    where: {
      compositionId_version: {
        compositionId,
        version: Number(batch.resultVersion),
      },
    },
  })
  const rollbackPoint = await db.creativeRollbackPoint.findUnique({
    where: { sourceBatchId: String(batch.id) },
  })
  if (!version || !rollbackPoint) {
    throw new CompositionServiceError('composition_audit_incomplete', 500)
  }
  const document = parseCreativeCompositionDocument(version.document)
  return {
    idempotent: true,
    batch: {
      id: String(batch.id),
      kind: String(batch.kind) as CreativeOperationBatchKind,
      requestFingerprint: String(batch.requestFingerprint),
      expectedVersion: Number(batch.expectedVersion),
      resultVersion: Number(batch.resultVersion),
      operationCount: Number(batch.operationCount),
      targetBatchId: typeof batch.targetBatchId === 'string' ? batch.targetBatchId : null,
      targetVersion: batch.targetVersion == null ? null : Number(batch.targetVersion),
    },
    version: {
      version: Number(version.version),
      concurrencyToken: document.concurrencyToken,
      documentHash: String(version.documentHash),
      document,
    },
    rollbackPointId: String(rollbackPoint.id),
  }
}

function conflict(row: AnyRecord): CompositionServiceError {
  return new CompositionServiceError('composition_conflict', 409, {
    currentVersion: Number(row.currentVersion),
    currentConcurrencyToken: String(row.concurrencyToken),
  })
}

function assertExpected(row: AnyRecord, command: NormalizedCommand): void {
  if (
    Number(row.currentVersion) !== command.expectedVersion
    || String(row.concurrencyToken) !== command.expectedConcurrencyToken
  ) throw conflict(row)
}

function assertExpectedVersionNotFuture(row: AnyRecord, command: NormalizedCommand): void {
  if (command.expectedVersion > Number(row.currentVersion)) throw conflict(row)
}

async function persistOperationPlan(
  tx: DbClient,
  actor: StudioActor,
  access: StudioBrandAccess,
  row: AnyRecord,
  priorVersion: AnyRecord,
  plan: CreativeOperationBatch,
  input: {
    targetBatchId?: string | null
    targetVersion?: number | null
    rollbackLabel: string
  },
): Promise<string> {
  await tx.creativeOperationBatch.create({
    data: {
      id: plan.batchId,
      compositionId: plan.compositionId,
      idempotencyKey: plan.idempotencyKey,
      requestFingerprint: plan.requestFingerprint,
      kind: plan.kind,
      expectedVersion: plan.expectedVersion,
      resultVersion: plan.resultVersion,
      actorId: actor.userId,
      actorRole: studioRoleToDb(access.role),
      operationCount: plan.operations.length,
      effectClass: 'ZERO_COST_LOCAL',
      estimatedCostBdt: 0,
      targetBatchId: input.targetBatchId ?? null,
      targetVersion: input.targetVersion ?? null,
    },
  })
  for (const [index, operation] of plan.operations.entries()) {
    await tx.creativeEditOperation.create({
      data: {
        id: operation.operationId,
        compositionId: plan.compositionId,
        batchId: plan.batchId,
        sequence: index + 1,
        operationType: operation.type,
        payload: operation.payload,
        inverse: operation.inverse,
        beforeProjection: operation.beforeProjection ?? undefined,
        afterProjection: operation.afterProjection ?? undefined,
        selection: operation.selection ?? undefined,
        timeRange: operation.timeRange ?? undefined,
        effectClass: 'ZERO_COST_LOCAL',
        estimatedCostBdt: 0,
        actorId: actor.userId,
        actorRole: studioRoleToDb(access.role),
        expectedVersion: plan.expectedVersion,
        resultVersion: plan.resultVersion,
      },
    })
  }
  const version = await tx.creativeCompositionVersion.create({
    data: {
      compositionId: plan.compositionId,
      version: plan.resultVersion,
      schemaVersion: plan.document.schemaVersion,
      parentVersion: plan.expectedVersion,
      document: plan.document,
      documentHash: plan.documentHash,
      operationBatchId: plan.batchId,
      createdById: actor.userId,
    },
  })
  const nodes = creativeCompositionNodeIndexRows(plan.document)
  if (nodes.length) {
    await tx.creativeCompositionNode.createMany({
      data: nodes.map((node) => ({
        compositionVersionId: version.id,
        ...node,
      })),
    })
  }
  const rollbackPointId = `crp_${plan.batchId.slice(4)}`
  await tx.creativeRollbackPoint.create({
    data: {
      id: rollbackPointId,
      compositionId: plan.compositionId,
      versionId: String(priorVersion.id),
      versionNumber: plan.expectedVersion,
      sourceBatchId: plan.batchId,
      label: input.rollbackLabel,
      createdById: actor.userId,
    },
  })
  const updated = await tx.creativeComposition.updateMany({
    where: {
      id: String(row.id),
      currentVersion: plan.expectedVersion,
      concurrencyToken: plan.expectedConcurrencyToken,
      readOnly: false,
      archivedAt: null,
    },
    data: {
      currentVersion: plan.resultVersion,
      concurrencyToken: plan.resultConcurrencyToken,
    },
  })
  if (updated.count !== 1) throw conflict(row)
  return rollbackPointId
}

function commandResult(
  plan: CreativeOperationBatch,
  rollbackPointId: string,
): CreativeCompositionCommandResult {
  return {
    idempotent: false,
    batch: {
      id: plan.batchId,
      kind: plan.kind,
      requestFingerprint: plan.requestFingerprint,
      expectedVersion: plan.expectedVersion,
      resultVersion: plan.resultVersion,
      operationCount: plan.operations.length,
      targetBatchId: null,
      targetVersion: null,
    },
    version: {
      version: plan.resultVersion,
      concurrencyToken: plan.resultConcurrencyToken,
      documentHash: plan.documentHash,
      document: plan.document,
    },
    rollbackPointId,
  }
}

type CommandResolution = {
  operations: CreativeInverseOperation[]
  targetBatchId?: string | null
  targetVersion?: number | null
  targetReference?: string | null
  rollbackLabel: string
}

/**
 * The single mutation boundary for apply/undo/redo/rollback. Validation,
 * optimistic compare-and-swap, version append, operation audit, rollback point,
 * and idempotency all live in the same database transaction.
 */
async function executeCompositionCommand(input: {
  actor: StudioActor
  compositionId: string
  kind: CreativeOperationBatchKind
  command: NormalizedCommand
  requestFingerprint: string
  resolve: (
    tx: DbClient,
    row: AnyRecord,
    currentDocument: CreativeCompositionDocument,
  ) => Promise<CommandResolution> | CommandResolution
}): Promise<CreativeCompositionCommandResult> {
  const context = await compositionAccess(input.actor, input.compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), input.command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')

  const existing = await replayCommand(
    input.compositionId,
    input.command.idempotencyKey,
    input.requestFingerprint,
  )
  if (existing) return existing

  try {
    const result = await db.$transaction(async (tx: DbClient) => {
      const racedBatch = await tx.creativeOperationBatch.findUnique({
        where: {
          compositionId_idempotencyKey: {
            compositionId: input.compositionId,
            idempotencyKey: input.command.idempotencyKey,
          },
        },
      })
      if (racedBatch) {
        if (racedBatch.requestFingerprint !== input.requestFingerprint) {
          throw new CompositionServiceError('idempotency_conflict', 409)
        }
        throw new CompositionServiceError('idempotency_replay_race', 409)
      }
      const row = await tx.creativeComposition.findUnique({
        where: { id: input.compositionId },
      })
      if (
        !row
        || row.archivedAt
        || String(row.brandProfileId) !== context.access.brandProfileId
      ) throw new CompositionServiceError('composition_not_found', 404)
      assertExpected(row, input.command)
      const versionRow = await currentVersionRow(tx, row)
      const currentDocument = assertVersionCoherence(row, versionRow)
      const resolved = await input.resolve(tx, row, currentDocument)
      const plan = compileCreativeOperationBatch({
        document: currentDocument,
        kind: input.kind,
        expectedVersion: input.command.expectedVersion,
        expectedConcurrencyToken: input.command.expectedConcurrencyToken,
        idempotencyKey: input.command.idempotencyKey,
        actor: {
          userId: input.actor.userId,
          role: context.access.role,
        },
        operations: resolved.operations,
        targetBatchId: resolved.targetBatchId,
        targetVersion: resolved.targetVersion,
        targetReference: resolved.targetReference,
      })
      if (plan.requestFingerprint !== input.requestFingerprint) {
        throw new CompositionServiceError('request_fingerprint_mismatch', 409)
      }
      const rollbackPointId = await persistOperationPlan(
        tx,
        input.actor,
        context.access,
        row,
        versionRow,
        plan,
        resolved,
      )
      const response = commandResult(plan, rollbackPointId)
      response.batch.targetBatchId = resolved.targetBatchId ?? null
      response.batch.targetVersion = resolved.targetVersion ?? null
      return response
    })
    return result
  } catch (error) {
    if (
      object(error).code !== 'P2002'
      && !(error instanceof CompositionServiceError && error.code === 'idempotency_replay_race')
    ) throw error
    const replay = await replayCommand(
      input.compositionId,
      input.command.idempotencyKey,
      input.requestFingerprint,
    )
    if (!replay) throw new CompositionServiceError('idempotency_conflict', 409)
    return replay
  }
}

async function planOrValidate(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeOperationBatch> {
  const command = normalizeCommand(value)
  const context = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')
  const fingerprint = commandFingerprint({
    compositionId,
    kind: 'APPLY',
    actor,
    access: context.access,
    command,
    operations: command.operations,
  })
  const plan = compileCreativeOperationBatch({
    document: assertVersionCoherence(context.row, context.versionRow),
    kind: 'APPLY',
    expectedVersion: command.expectedVersion,
    expectedConcurrencyToken: command.expectedConcurrencyToken,
    idempotencyKey: command.idempotencyKey,
    actor: { userId: actor.userId, role: context.access.role },
    operations: command.operations,
  })
  if (plan.requestFingerprint !== fingerprint) {
    throw new CompositionServiceError('request_fingerprint_mismatch', 409)
  }
  return plan
}

export async function planCreativeCompositionOperations(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeOperationBatch> {
  return planOrValidate(actor, compositionId, value)
}

export async function validateCreativeCompositionOperations(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<{
  valid: true
  batchId: string
  requestFingerprint: string
  expectedVersion: number
  resultVersion: number
  operationCount: number
  inverseOperations: CreativeInverseOperation[]
  documentHash: string
  resultConcurrencyToken: string
}> {
  const plan = await planOrValidate(actor, compositionId, value)
  return {
    valid: true,
    batchId: plan.batchId,
    requestFingerprint: plan.requestFingerprint,
    expectedVersion: plan.expectedVersion,
    resultVersion: plan.resultVersion,
    operationCount: plan.operations.length,
    inverseOperations: plan.inverseOperations,
    documentHash: plan.documentHash,
    resultConcurrencyToken: plan.resultConcurrencyToken,
  }
}

export async function applyCreativeCompositionOperations(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeCompositionCommandResult> {
  const command = normalizeCommand(value)
  const context = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')
  const requestFingerprint = commandFingerprint({
    compositionId,
    kind: 'APPLY',
    actor,
    access: context.access,
    command,
    operations: command.operations,
  })
  return executeCompositionCommand({
    actor,
    compositionId,
    kind: 'APPLY',
    command,
    requestFingerprint,
    resolve: () => ({
      operations: command.operations,
      rollbackLabel: `Before apply v${command.expectedVersion + 1}`,
    }),
  })
}

function inverseOperations(rows: unknown[]): CreativeInverseOperation[] {
  return [...rows]
    .sort((left, right) => Number(object(right).sequence) - Number(object(left).sequence))
    .map((row) => parseCreativeInverseOperation(object(row).inverse))
}

function forwardOperations(rows: unknown[]): CreativeInverseOperation[] {
  return [...rows]
    .sort((left, right) => Number(object(left).sequence) - Number(object(right).sequence))
    .map((row) => {
      const record = object(row)
      return parseCreativeInverseOperation({
        ...object(record.payload),
        type: String(record.operationType),
        ...(record.selection == null ? {} : { selection: record.selection }),
        ...(record.timeRange == null ? {} : { timeRange: record.timeRange }),
      })
    })
}

function assertOperationRowsComplete(target: AnyRecord, rows: unknown[]): void {
  if (
    rows.length !== Number(target.operationCount)
    || rows.some((row, index) => Number(object(row).sequence) !== index + 1)
  ) {
    throw new CompositionServiceError('composition_audit_incomplete', 500, {
      batchId: String(target.id),
    })
  }
}

type CompositionHistoryStacks = {
  undo: AnyRecord[]
  redo: AnyRecord[]
  activity: AnyRecord[]
}

async function reconstructCompositionHistoryStacks(
  client: DbClient,
  compositionId: string,
  throughVersion: number,
): Promise<CompositionHistoryStacks> {
  const history = await client.creativeOperationBatch.findMany({
    where: {
      compositionId,
      resultVersion: { lte: throughVersion },
      kind: { in: ['APPLY', 'UNDO', 'REDO', 'ROLLBACK'] },
    },
    include: {
      actor: { select: { id: true, name: true, email: true } },
      operations: {
        orderBy: [{ sequence: 'asc' }],
        select: { id: true },
      },
      rollbackPointsCreated: {
        select: { id: true },
        take: 1,
      },
    },
    orderBy: [{ resultVersion: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const undo: AnyRecord[] = []
  const redo: AnyRecord[] = []
  let lastResultVersion = 1

  for (const rawBatch of history) {
    const batch = object(rawBatch)
    const expectedVersion = Number(batch.expectedVersion)
    const resultVersion = Number(batch.resultVersion)
    if (
      expectedVersion !== lastResultVersion
      || resultVersion !== expectedVersion + 1
    ) {
      throw new CompositionServiceError('composition_history_invalid', 500)
    }
    lastResultVersion = resultVersion
    const kind = String(batch.kind)
    if (kind === 'APPLY' || kind === 'ROLLBACK') {
      undo.push(batch)
      redo.splice(0)
      continue
    }
    const targetBatchId = typeof batch.targetBatchId === 'string'
      ? batch.targetBatchId
      : null
    if (kind === 'UNDO') {
      const target = undo.at(-1)
      if (!target || String(target.id) !== targetBatchId) {
        throw new CompositionServiceError('composition_history_invalid', 500)
      }
      undo.pop()
      redo.push(target)
      continue
    }
    if (kind === 'REDO') {
      const target = redo.at(-1)
      if (!target || String(target.id) !== targetBatchId) {
        throw new CompositionServiceError('composition_history_invalid', 500)
      }
      redo.pop()
      undo.push(target)
      continue
    }
    throw new CompositionServiceError('composition_history_invalid', 500)
  }

  if (lastResultVersion !== throughVersion) {
    throw new CompositionServiceError('composition_history_invalid', 500)
  }
  return { undo, redo, activity: history.map(object) }
}

function emptyCompositionHistory(): CreativeCompositionHistoryView {
  return {
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
  }
}

function serializeCompositionHistory(
  stacks: CompositionHistoryStacks,
): CreativeCompositionHistoryView {
  const activity = stacks.activity.map((batch): CreativeCompositionHistoryActivity => {
    const kind = String(batch.kind).toLowerCase()
    if (!['apply', 'undo', 'redo', 'rollback'].includes(kind)) {
      throw new CompositionServiceError('composition_history_invalid', 500)
    }
    const actor = object(batch.actor)
    const operations = Array.isArray(batch.operations) ? batch.operations : []
    const rollbackPoints = Array.isArray(batch.rollbackPointsCreated)
      ? batch.rollbackPointsCreated
      : []
    const rollbackPoint = object(rollbackPoints[0])
    if (!rollbackPoint.id) {
      throw new CompositionServiceError('composition_audit_incomplete', 500)
    }
    return {
      id: String(batch.id),
      kind: kind as CreativeCompositionHistoryActivity['kind'],
      origin: kind === 'apply'
        ? String(batch.idempotencyKey ?? '').startsWith('editor-agent-apply-')
          ? 'agent'
          : 'human'
        : 'system',
      actorId: String(batch.actorId),
      actorName: String(actor.name ?? actor.email ?? 'Studio user'),
      actorRole: String(batch.actorRole).toLowerCase() as StudioBrandAccess['role'],
      resultVersion: Number(batch.resultVersion),
      targetBatchId: typeof batch.targetBatchId === 'string'
        ? batch.targetBatchId
        : null,
      rollbackPointId: String(rollbackPoint.id),
      createdAt: iso(batch.createdAt),
      operationIds: operations.map((operation) => String(object(operation).id)),
    }
  })
  const rollbackPoints = activity.map((entry) => ({
    batchId: entry.id,
    rollbackPointId: entry.rollbackPointId,
  }))
  const latestAgentBatchId = activity
    .filter((entry) => entry.kind === 'apply' && entry.origin === 'agent')
    .at(-1)?.id ?? null
  return {
    canUndo: stacks.undo.length > 0,
    canRedo: stacks.redo.length > 0,
    undoDepth: stacks.undo.length,
    redoDepth: stacks.redo.length,
    currentUndoBatchId: stacks.undo.at(-1)?.id
      ? String(stacks.undo.at(-1)!.id)
      : null,
    currentRedoBatchId: stacks.redo.at(-1)?.id
      ? String(stacks.redo.at(-1)!.id)
      : null,
    latestAgentBatchId,
    canRollbackLatestAgentBatch: Boolean(
      latestAgentBatchId
      && rollbackPoints.some((entry) => entry.batchId === latestAgentBatchId),
    ),
    rollbackPoints,
    activity,
  }
}

async function getCompositionHistory(
  client: DbClient,
  compositionId: string,
  currentVersion: number,
): Promise<CreativeCompositionHistoryView> {
  if (currentVersion <= 1) return emptyCompositionHistory()
  return serializeCompositionHistory(
    await reconstructCompositionHistoryStacks(client, compositionId, currentVersion),
  )
}

async function resolveUndoOrRedo(
  client: DbClient,
  compositionId: string,
  command: NormalizedCommand & { batchId?: string },
  kind: 'UNDO' | 'REDO',
  exactBatchId?: string,
): Promise<CommandResolution> {
  const stacks = await reconstructCompositionHistoryStacks(
    client,
    compositionId,
    command.expectedVersion,
  )
  const target = kind === 'UNDO' ? stacks.undo.at(-1) : stacks.redo.at(-1)
  const requestedBatchId = exactBatchId ?? command.batchId
  if (!target) {
    throw new CompositionServiceError(
      kind === 'UNDO' ? 'undo_target_not_found' : 'redo_target_not_found',
      409,
    )
  }
  if (requestedBatchId && String(target.id) !== requestedBatchId) {
    throw new CompositionServiceError(
      kind === 'UNDO' ? 'undo_target_not_current' : 'redo_target_not_current',
      409,
      { currentTargetBatchId: String(target.id) },
    )
  }
  const rows = await client.creativeEditOperation.findMany({
    where: { batchId: String(target.id) },
    orderBy: [{ sequence: 'asc' }],
  })
  assertOperationRowsComplete(target, rows)
  if (!rows.length) {
    throw new CompositionServiceError(
      kind === 'UNDO' ? 'undo_target_empty' : 'redo_target_empty',
      409,
    )
  }
  return {
    operations: kind === 'UNDO' ? inverseOperations(rows) : forwardOperations(rows),
    targetBatchId: String(target.id),
    targetVersion: kind === 'UNDO'
      ? Number(target.expectedVersion)
      : Number(target.resultVersion),
    targetReference: String(target.id),
    rollbackLabel: `Before ${kind.toLowerCase()} ${String(target.id)}`,
  }
}

async function resolveRollback(
  client: DbClient,
  compositionId: string,
  command: NormalizedCommand & { rollbackPointId: string },
): Promise<CommandResolution> {
  const point = await client.creativeRollbackPoint.findFirst({
    where: {
      id: command.rollbackPointId,
      compositionId,
    },
  })
  if (!point) throw new CompositionServiceError('rollback_point_not_found', 404)
  if (Number(point.versionNumber) === command.expectedVersion) {
    throw new CompositionServiceError('rollback_target_unchanged', 409)
  }
  const targetVersion = await client.creativeCompositionVersion.findUnique({
    where: { id: String(point.versionId) },
  })
  if (
    !targetVersion
    || String(targetVersion.compositionId) !== compositionId
    || Number(targetVersion.version) !== Number(point.versionNumber)
  ) throw new CompositionServiceError('rollback_version_missing', 500)
  return {
    operations: [{
      type: 'document.restore',
      document: parseCreativeCompositionDocument(targetVersion.document),
    }],
    targetVersion: Number(point.versionNumber),
    targetReference: command.rollbackPointId,
    rollbackLabel: `Before rollback to v${Number(point.versionNumber)}`,
  }
}

export async function undoCreativeCompositionOperations(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeCompositionCommandResult> {
  const command = normalizeHistoryCommand(value)
  const context = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')
  assertExpectedVersionNotFuture(context.row, command)
  const resolved = await resolveUndoOrRedo(db, compositionId, command, 'UNDO')
  const requestFingerprint = commandFingerprint({
    compositionId,
    kind: 'UNDO',
    actor,
    access: context.access,
    command,
    operations: resolved.operations,
    batchId: resolved.targetBatchId,
    targetVersion: resolved.targetVersion,
    targetReference: resolved.targetReference,
  })
  return executeCompositionCommand({
    actor,
    compositionId,
    kind: 'UNDO',
    command,
    requestFingerprint,
    resolve: (tx) => resolveUndoOrRedo(
      tx,
      compositionId,
      command,
      'UNDO',
      resolved.targetBatchId ?? undefined,
    ),
  })
}

export async function redoCreativeCompositionOperations(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeCompositionCommandResult> {
  const command = normalizeHistoryCommand(value)
  const context = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')
  assertExpectedVersionNotFuture(context.row, command)
  const resolved = await resolveUndoOrRedo(db, compositionId, command, 'REDO')
  const requestFingerprint = commandFingerprint({
    compositionId,
    kind: 'REDO',
    actor,
    access: context.access,
    command,
    operations: resolved.operations,
    batchId: resolved.targetBatchId,
    targetVersion: resolved.targetVersion,
    targetReference: resolved.targetReference,
  })
  return executeCompositionCommand({
    actor,
    compositionId,
    kind: 'REDO',
    command,
    requestFingerprint,
    resolve: (tx) => resolveUndoOrRedo(
      tx,
      compositionId,
      command,
      'REDO',
      resolved.targetBatchId ?? undefined,
    ),
  })
}

export async function rollbackCreativeComposition(
  actor: StudioActor,
  compositionId: string,
  value: unknown,
): Promise<CreativeCompositionCommandResult> {
  const command = normalizeRollbackCommand(value)
  const context = await compositionAccess(actor, compositionId)
  assertStudioBrandScope(String(context.row.brandProfileId), command.brandProfileId)
  assertStudioCapability(context.access.role, 'draft')
  const resolved = await resolveRollback(db, compositionId, command)
  const requestFingerprint = commandFingerprint({
    compositionId,
    kind: 'ROLLBACK',
    actor,
    access: context.access,
    command,
    operations: resolved.operations,
    targetVersion: resolved.targetVersion,
    targetReference: resolved.targetReference,
  })
  return executeCompositionCommand({
    actor,
    compositionId,
    kind: 'ROLLBACK',
    command,
    requestFingerprint,
    resolve: (tx) => resolveRollback(tx, compositionId, command),
  })
}

export function compositionServiceErrorResponse(error: unknown, event: string): Response {
  if (error instanceof StudioAccessError) {
    return Response.json({
      error: error.code,
      message: error.message,
    }, { status: error.status })
  }
  if (error instanceof CompositionOperationError || error instanceof CompositionServiceError) {
    return Response.json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    }, { status: error.status })
  }
  if (error instanceof CreativeCompositionSizeError) {
    return Response.json({
      error: error.code,
      message: error.message,
      details: {
        actualBytes: error.actualBytes,
        maxBytes: error.maxBytes,
      },
    }, { status: error.status })
  }
  if (error instanceof CreativeCompositionEncodingError) {
    return Response.json({
      error: error.code,
      message: error.message,
    }, { status: error.status })
  }
  console.error(`[${event}] request failed`, error)
  return Response.json({ error: 'creative_composition_failed' }, { status: 500 })
}

export const creativeCompositionCommandService = {
  plan: planCreativeCompositionOperations,
  validate: validateCreativeCompositionOperations,
  apply: applyCreativeCompositionOperations,
  undo: undoCreativeCompositionOperations,
  redo: redoCreativeCompositionOperations,
  rollback: rollbackCreativeComposition,
}
