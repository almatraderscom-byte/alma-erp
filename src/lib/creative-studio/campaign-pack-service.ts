import { prisma } from '@/lib/prisma'
import { attachProjectAsset } from '@/lib/creative-studio/project-service'
import {
  assertCampaignPackConfirmation,
  buildCampaignPackManifest,
  campaignPackDedupeKey,
  campaignPackRequestFingerprint,
  campaignStageDedupeKey,
  campaignStagePrefix,
  campaignStagesMissingForResume,
  latestCampaignStageAttempts,
  normalizeCampaignPackOptions,
  type CampaignPackManifest,
  type CampaignPackStageDefinition,
  type CampaignPackStageId,
  type CampaignPackStageSnapshot,
} from '@/lib/creative-studio/campaign-pack'

// CSE3 deliberately stores Studio lineage in AgentPendingAction payload/result
// plus CreativeAssetVersion metadata. CSE4 uses that existing durable substrate:
// one campaign_pack ledger row and one deduped row per stage attempt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type AnyRecord = Record<string, unknown>

export type CampaignPackStageView = {
  stageId: CampaignPackStageId
  actionId: string | null
  attempt: number
  labelBn: string
  mediaType: 'image' | 'text' | 'video'
  engine: string
  estimatedCostUsd: number
  status: 'not_started' | 'queued' | 'running' | 'ready' | 'failed' | 'rejected'
  storagePath: string | null
  previewUrl: string | null
  captionBn: string | null
  error: string | null
}

export type CampaignPackView = {
  id: string
  status: 'drafting' | 'waiting_selection' | 'processing' | 'ready' | 'attention'
  manifest: CampaignPackManifest
  selectedDraftStageId: CampaignPackStageId | null
  progressPercent: number
  estimatedCostUsd: number
  actualCostUsd: number
  createdAt: string
  updatedAt: string
  stages: CampaignPackStageView[]
}

export class CampaignPackServiceError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: AnyRecord

  constructor(code: string, status = 400, message = code, details?: AnyRecord) {
    super(message)
    this.name = 'CampaignPackServiceError'
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

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const date = new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function cleanId(value: unknown, code: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(text)) throw new CampaignPackServiceError(code, 422)
  return text
}

function packMeta(row: AnyRecord): AnyRecord {
  return object(row.payload)
}

function stageMeta(row: AnyRecord): AnyRecord {
  return object(object(row.payload).campaignPack)
}

function stageAttempt(row: AnyRecord): number {
  return Math.max(1, Math.round(number(stageMeta(row).attempt) || 1))
}

function stageId(row: AnyRecord): CampaignPackStageId | null {
  const id = stageMeta(row).stageId
  return typeof id === 'string' ? id as CampaignPackStageId : null
}

function resultStoragePath(row: AnyRecord): string | null {
  const result = object(row.result)
  const path = result.storagePath ?? result.videoPath
  return typeof path === 'string' && path.trim() ? path.trim() : null
}

function rowSnapshot(row: AnyRecord): CampaignPackStageSnapshot | null {
  const id = stageId(row)
  return id ? { stageId: id, attempt: stageAttempt(row), status: String(row.status ?? '') } : null
}

function rowStatus(row: AnyRecord | undefined): CampaignPackStageView['status'] {
  if (!row) return 'not_started'
  if (row.status === 'executed') return 'ready'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'rejected') return 'rejected'
  if (row.status === 'approved') return 'queued'
  return 'running'
}

function manifestFromPack(row: AnyRecord): CampaignPackManifest {
  const manifest = packMeta(row).manifest
  if (!manifest || typeof manifest !== 'object') {
    throw new CampaignPackServiceError('campaign_pack_corrupt', 500)
  }
  return manifest as CampaignPackManifest
}

async function ownedProjectInputs(ownerId: string, projectId: string) {
  const project = await db.creativeProject.findFirst({
    where: { id: projectId, ownerId, archivedAt: null },
    include: { currentRecipe: true },
  })
  if (!project) throw new CampaignPackServiceError('project_not_found', 404)
  if (
    !project.productCode
    || !project.productName
    || !project.productSourceImage
  ) {
    throw new CampaignPackServiceError('product_required', 422)
  }
  const recipe = project.currentRecipe
  if (!recipe || recipe.ownerId !== ownerId) {
    throw new CampaignPackServiceError('recipe_required', 422)
  }
  if (!recipe.lockedAt) {
    throw new CampaignPackServiceError('recipe_must_be_locked', 409)
  }
  // Reuse the newest completed CSE3 asset made with this locked recipe. This is
  // the approved master for all free crops; the ERP product image is the safe
  // fallback when the project has no reusable result yet.
  const candidate = await db.creativeProjectAsset.findFirst({
    where: {
      projectId,
      pendingActionId: { not: null },
      latestStoragePath: { not: null },
      versions: { some: { recipeId: recipe.id } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  const candidateAction = candidate?.pendingActionId
    ? await db.agentPendingAction.findUnique({
        where: { id: candidate.pendingActionId },
        select: { status: true },
      })
    : null
  const masterSource = candidate && candidateAction?.status === 'executed'
    ? {
        kind: 'approved_project_asset' as const,
        storagePath: String(candidate.latestStoragePath),
        assetId: String(candidate.id),
        pendingActionId: String(candidate.pendingActionId),
      }
    : {
        kind: 'erp_product' as const,
        storagePath: String(project.productSourceImage),
        assetId: null,
        pendingActionId: null,
      }
  return {
    project,
    manifestInput: {
      projectId,
      product: {
        code: project.productCode,
        name: project.productName,
        priceBdt: project.productPriceBdt ?? 0,
        sourceImage: project.productSourceImage,
      },
      recipe: {
        id: recipe.id,
        name: recipe.name,
        version: recipe.version,
        lockedAt: dateIso(recipe.lockedAt),
        captionTone: recipe.captionTone,
        finishTheme: recipe.finishTheme,
        musicVibe: recipe.musicVibe,
        qcLevel: recipe.qcLevel,
        spendCeilingBdt: recipe.spendCeilingBdt,
      },
      masterSource,
    },
  }
}

export async function previewCampaignPack(ownerId: string, value: unknown): Promise<{
  manifest: CampaignPackManifest
}> {
  const body = object(value)
  const projectId = cleanId(body.projectId, 'project_required')
  const { manifestInput } = await ownedProjectInputs(ownerId, projectId)
  const manifest = buildCampaignPackManifest({
    ...manifestInput,
    options: normalizeCampaignPackOptions(body.options),
  })
  return { manifest }
}

function stageActionData(input: {
  packId: string
  ownerId: string
  manifest: CampaignPackManifest
  stage: CampaignPackStageDefinition
  attempt: number
  sourceRef: string
}) {
  const { packId, ownerId, manifest, stage, attempt, sourceRef } = input
  const common = {
    creativeStudio: true,
    skipTelegramCard: true,
    studioMode: 'campaign_pack',
    productCode: manifest.product.code,
    campaignPack: {
      packId,
      ownerId,
      projectId: manifest.projectId,
      recipeId: manifest.recipe.id,
      recipeVersion: manifest.recipe.version,
      stageId: stage.id,
      attempt,
      phase: stage.phase,
      output: stage.outputLabelBn,
      engine: stage.engine,
    },
  }
  let type = 'image_gen'
  let payload: AnyRecord

  if (stage.id === 'reel-6s') {
    type = 'video_gen'
    payload = {
      ...common,
      provider: 'gemini',
      vtonEngine: 'veo-3.1-generate-preview',
      prompt:
        `${manifest.product.name} (${manifest.product.code}) premium vertical fashion reel. `
        + 'Preserve the exact product, modest presentation, clean ALMA campaign motion, no added text.',
      referenceImageId: sourceRef,
      durationSec: 6,
      aspect: '9:16',
      productCode: manifest.product.code,
    }
  } else if (stage.id === 'family-4x5') {
    payload = {
      ...common,
      provider: 'gemini',
      vtonEngine: 'gemini-3.1-flash-image',
      quality: 'standard',
      referenceImageId: sourceRef,
      aspectRatio: '4:5',
      imageSize: '1K',
      prompt:
        `Create a modest Bangladeshi family fashion campaign for ${manifest.product.name} `
        + `(${manifest.product.code}). Preserve the exact product design and colors from the approved master. `
        + `Premium ${manifest.recipe.finishTheme} finish, no text or logo.`,
    }
  } else {
    payload = {
      ...common,
      provider: 'campaign_pack_local',
      vtonEngine: stage.engine,
      operation: stage.id === 'caption-bn' ? 'caption' : 'layout',
      sourceRef,
      width: stage.width,
      height: stage.height,
      variant: stage.id,
      product: manifest.product,
      recipe: manifest.recipe,
    }
  }

  return {
    dedupeKey: campaignStageDedupeKey(packId, stage.id, attempt),
    conversationId: null,
    type,
    payload,
    summary: `Campaign Pack · ${stage.labelBn} · ${manifest.product.code}`,
    costEstimate: stage.estimatedCostUsd,
    status: 'approved',
  }
}

async function ensureStage(input: {
  packId: string
  ownerId: string
  manifest: CampaignPackManifest
  stage: CampaignPackStageDefinition
  attempt: number
  sourceRef: string
}) {
  const data = stageActionData(input)
  return db.agentPendingAction.upsert({
    where: { dedupeKey: data.dedupeKey },
    create: data,
    update: {},
  })
}

async function stageRows(packId: string): Promise<AnyRecord[]> {
  return db.agentPendingAction.findMany({
    where: { dedupeKey: { startsWith: campaignStagePrefix(packId) } },
    orderBy: { createdAt: 'asc' },
  })
}

function latestRows(rows: AnyRecord[]): Map<CampaignPackStageId, AnyRecord> {
  const latest = new Map<CampaignPackStageId, AnyRecord>()
  for (const row of rows) {
    const id = stageId(row)
    if (!id) continue
    const current = latest.get(id)
    if (!current || stageAttempt(row) > stageAttempt(current)) latest.set(id, row)
  }
  return latest
}

function selectedDraftId(pack: AnyRecord): CampaignPackStageId | null {
  const id = object(pack.result).selectedDraftStageId
  return id === 'draft-a' || id === 'draft-b' ? id : null
}

function stateFor(
  manifest: CampaignPackManifest,
  latest: Map<CampaignPackStageId, AnyRecord>,
  selected: CampaignPackStageId | null,
): CampaignPackView['status'] {
  const draftRows = manifest.stages
    .filter((stage) => stage.phase === 'draft')
    .map((stage) => latest.get(stage.id))
  if (draftRows.some((row) => rowStatus(row) === 'failed' || rowStatus(row) === 'rejected')) return 'attention'
  if (!draftRows.every((row) => rowStatus(row) === 'ready')) return 'drafting'
  if (!selected) return 'waiting_selection'
  const finalRows = manifest.stages
    .filter((stage) => stage.phase === 'after_selection')
    .map((stage) => latest.get(stage.id))
  if (finalRows.some((row) => rowStatus(row) === 'failed' || rowStatus(row) === 'rejected')) return 'attention'
  if (finalRows.every((row) => rowStatus(row) === 'ready')) return 'ready'
  return 'processing'
}

function rootStatus(state: CampaignPackView['status']): string {
  if (state === 'ready') return 'executed'
  if (state === 'attention') return 'failed'
  if (state === 'waiting_selection') return 'pending'
  return 'approved'
}

function actualCost(rows: AnyRecord[]): number {
  return Math.round(rows.reduce((sum, row) => {
    // A rejected output still consumed its provider call; changing the review
    // verdict must never erase real spend from the owner-visible pack total.
    if (row.status !== 'executed' && row.status !== 'rejected') return sum
    const reported = object(row.result).costUsd
    return sum + (reported == null ? number(row.costEstimate) : number(reported))
  }, 0) * 1000) / 1000
}

function reservedCost(rows: AnyRecord[]): number {
  return Math.round(rows.reduce((sum, row) => sum + number(row.costEstimate), 0) * 1000) / 1000
}

async function requireOwnedPack(ownerId: string, packId: string): Promise<AnyRecord> {
  const row = await db.agentPendingAction.findFirst({
    where: {
      id: packId,
      type: 'campaign_pack',
      payload: { path: ['ownerId'], equals: ownerId },
    },
  })
  if (!row) throw new CampaignPackServiceError('campaign_pack_not_found', 404)
  return row
}

async function reconcilePackRow(pack: AnyRecord): Promise<{
  pack: AnyRecord
  rows: AnyRecord[]
  latest: Map<CampaignPackStageId, AnyRecord>
  state: CampaignPackView['status']
}> {
  const manifest = manifestFromPack(pack)
  let rows = await stageRows(String(pack.id))
  const selected = selectedDraftId(pack)
  const snapshots = rows.map(rowSnapshot).filter((row): row is CampaignPackStageSnapshot => Boolean(row))
  const missing = campaignStagesMissingForResume({
    manifest,
    snapshots,
    selectedDraftStageId: selected,
  })

  for (const stage of missing) {
    const sourceRef = stage.phase === 'draft'
      ? manifest.masterSource.storagePath
      : (() => {
          const selectedRow = selected ? latestRows(rows).get(selected) : null
          return selectedRow ? resultStoragePath(selectedRow) : null
        })()
    if (sourceRef) {
      await ensureStage({
        packId: String(pack.id),
        ownerId: String(packMeta(pack).ownerId),
        manifest,
        stage,
        attempt: 1,
        sourceRef,
      })
    }
  }
  if (missing.length) rows = await stageRows(String(pack.id))

  const latest = latestRows(rows)
  const state = stateFor(manifest, latest, selected)
  const previousResult = object(pack.result)
  const updated = await db.agentPendingAction.update({
    where: { id: pack.id },
    data: {
      status: rootStatus(state),
      result: {
        ...previousResult,
        state,
        actualCostUsd: actualCost(rows),
        updatedAt: new Date().toISOString(),
      },
      resolvedAt: state === 'ready' || state === 'attention' ? new Date() : null,
    },
  })
  return { pack: updated, rows, latest, state }
}

function serializePack(input: {
  pack: AnyRecord
  rows: AnyRecord[]
  latest: Map<CampaignPackStageId, AnyRecord>
  state: CampaignPackView['status']
}): CampaignPackView {
  const manifest = manifestFromPack(input.pack)
  const selected = selectedDraftId(input.pack)
  const eligibleStages = selected
    ? manifest.stages
    : manifest.stages.filter((stage) => stage.phase === 'draft')
  const ready = eligibleStages.filter((stage) => rowStatus(input.latest.get(stage.id)) === 'ready').length
  return {
    id: String(input.pack.id),
    status: input.state,
    manifest,
    selectedDraftStageId: selected,
    progressPercent: eligibleStages.length ? Math.round((ready / eligibleStages.length) * 100) : 0,
    estimatedCostUsd: manifest.estimatedCostUsd,
    actualCostUsd: actualCost(input.rows),
    createdAt: dateIso(input.pack.createdAt),
    updatedAt: dateIso(input.pack.updatedAt),
    stages: manifest.stages.map((stage) => {
      const row = input.latest.get(stage.id)
      const result = object(row?.result)
      return {
        stageId: stage.id,
        actionId: row ? String(row.id) : null,
        attempt: row ? stageAttempt(row) : 0,
        labelBn: stage.labelBn,
        mediaType: stage.mediaType,
        engine: stage.engine,
        estimatedCostUsd: stage.estimatedCostUsd,
        status: rowStatus(row),
        storagePath: row ? resultStoragePath(row) : null,
        previewUrl: null,
        captionBn: typeof result.captionBn === 'string' ? result.captionBn : null,
        error: row?.status === 'failed'
          ? String(object(row.result).error ?? 'stage_failed')
          : null,
      }
    }),
  }
}

export async function createCampaignPack(ownerId: string, value: unknown): Promise<{
  pack: CampaignPackView
  idempotent: boolean
}> {
  const body = object(value)
  const idempotencyKey = cleanId(body.idempotencyKey, 'idempotency_key_required')
  const { manifest } = await previewCampaignPack(ownerId, body)
  try {
    assertCampaignPackConfirmation(manifest, body.confirmedCostUsd)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'cost_confirmation_required'
    throw new CampaignPackServiceError(code, 409, code, {
      estimatedCostUsd: manifest.estimatedCostUsd,
      hardCostCeilingUsd: manifest.hardCostCeilingUsd,
    })
  }

  const dedupeKey = campaignPackDedupeKey(ownerId, idempotencyKey)
  const fingerprint = campaignPackRequestFingerprint(manifest)
  const existing = await db.agentPendingAction.findUnique({ where: { dedupeKey } })
  if (existing) {
    if (packMeta(existing).fingerprint !== fingerprint) {
      throw new CampaignPackServiceError('idempotency_conflict', 409)
    }
    return { pack: serializePack(await reconcilePackRow(existing)), idempotent: true }
  }

  const row = await db.agentPendingAction.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      conversationId: null,
      type: 'campaign_pack',
      payload: {
        campaignPack: true,
        version: 1,
        ownerId,
        idempotencyKey,
        fingerprint,
        manifest,
      },
      summary: `Campaign Pack · ${manifest.product.code} · ${manifest.recipe.name} v${manifest.recipe.version}`,
      costEstimate: manifest.estimatedCostUsd,
      status: 'pending',
    },
    update: {},
  })
  if (packMeta(row).fingerprint !== fingerprint) {
    throw new CampaignPackServiceError('idempotency_conflict', 409)
  }
  return { pack: serializePack(await reconcilePackRow(row)), idempotent: false }
}

export async function getCampaignPack(ownerId: string, packId: string): Promise<CampaignPackView> {
  const row = await requireOwnedPack(ownerId, packId)
  return serializePack(await reconcilePackRow(row))
}

export async function listCampaignPacks(
  ownerId: string,
  projectId?: string | null,
): Promise<CampaignPackView[]> {
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: 'campaign_pack',
      payload: { path: ['ownerId'], equals: ownerId },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  const filtered = projectId
    ? rows.filter((row: AnyRecord) => manifestFromPack(row).projectId === projectId)
    : rows
  const packs: CampaignPackView[] = []
  for (const row of filtered) packs.push(serializePack(await reconcilePackRow(row)))
  return packs
}

export async function selectCampaignPackDraft(
  ownerId: string,
  packId: string,
  value: unknown,
): Promise<CampaignPackView> {
  const body = object(value)
  const selected = body.selectedDraftStageId
  if (selected !== 'draft-a' && selected !== 'draft-b') {
    throw new CampaignPackServiceError('invalid_draft_selection', 422)
  }
  const pack = await requireOwnedPack(ownerId, packId)
  const manifest = manifestFromPack(pack)
  const rows = await stageRows(packId)
  const latest = latestRows(rows)
  const selectedRow = latest.get(selected)
  const sourceRef = selectedRow ? resultStoragePath(selectedRow) : null
  if (!selectedRow || selectedRow.status !== 'executed' || !sourceRef) {
    throw new CampaignPackServiceError('draft_not_ready', 409)
  }

  await db.agentPendingAction.update({
    where: { id: packId },
    data: {
      status: 'approved',
      result: {
        ...object(pack.result),
        selectedDraftStageId: selected,
        selectedDraftActionId: selectedRow.id,
        selectedAt: new Date().toISOString(),
      },
    },
  })
  for (const stage of manifest.stages.filter((item) => item.phase === 'after_selection')) {
    await ensureStage({ packId, ownerId, manifest, stage, attempt: 1, sourceRef })
  }
  return getCampaignPack(ownerId, packId)
}

export async function retryCampaignPackStage(
  ownerId: string,
  packId: string,
  value: unknown,
): Promise<CampaignPackView> {
  const body = object(value)
  const requestedStageId = cleanId(body.stageId, 'stage_required') as CampaignPackStageId
  const pack = await requireOwnedPack(ownerId, packId)
  const manifest = manifestFromPack(pack)
  const definition = manifest.stages.find((stage) => stage.id === requestedStageId)
  if (!definition) throw new CampaignPackServiceError('stage_not_found', 404)
  const rows = await stageRows(packId)
  const latest = latestRows(rows)
  const previous = latest.get(requestedStageId)
  if (!previous || !['executed', 'failed'].includes(String(previous.status))) {
    throw new CampaignPackServiceError('stage_not_retryable', 409)
  }

  const nextAttempt = stageAttempt(previous) + 1
  const projectedCost = Math.round((reservedCost(rows) + definition.estimatedCostUsd) * 1000) / 1000
  if (projectedCost > manifest.hardCostCeilingUsd) {
    throw new CampaignPackServiceError('hard_cost_cap_exceeded', 409, 'hard_cost_cap_exceeded', {
      projectedCostUsd: projectedCost,
      hardCostCeilingUsd: manifest.hardCostCeilingUsd,
    })
  }
  if (definition.paid && Math.abs(number(body.confirmedCostUsd) - definition.estimatedCostUsd) > 0.0001) {
    throw new CampaignPackServiceError('cost_confirmation_required', 409, 'cost_confirmation_required', {
      estimatedCostUsd: definition.estimatedCostUsd,
    })
  }

  const selected = selectedDraftId(pack)
  let sourceRef = manifest.masterSource.storagePath
  if (definition.phase === 'after_selection') {
    const selectedRow = selected ? latest.get(selected) : null
    sourceRef = selectedRow ? resultStoragePath(selectedRow) ?? '' : ''
  }
  if (!sourceRef) throw new CampaignPackServiceError('source_not_ready', 409)

  if (previous.status === 'executed') {
    await db.agentPendingAction.update({
      where: { id: previous.id },
      data: {
        status: 'rejected',
        result: {
          ...object(previous.result),
          rejectedAt: new Date().toISOString(),
          rejectionReason: typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : 'owner_retry',
        },
      },
    })
  }
  await ensureStage({
    packId,
    ownerId,
    manifest,
    stage: definition,
    attempt: nextAttempt,
    sourceRef,
  })
  return getCampaignPack(ownerId, packId)
}

export async function reconcileCampaignPackStageResult(stageActionId: string): Promise<void> {
  const action = await db.agentPendingAction.findUnique({ where: { id: stageActionId } })
  if (!action) return
  const meta = stageMeta(action)
  if (!meta.packId || !meta.ownerId || !meta.projectId || !meta.recipeId) return
  const pack = await db.agentPendingAction.findUnique({ where: { id: String(meta.packId) } })
  if (!pack || pack.type !== 'campaign_pack') return

  const storagePath = resultStoragePath(action)
  if (action.status === 'executed' && storagePath) {
    const manifest = manifestFromPack(pack)
    const rows = await stageRows(String(meta.packId))
    const latest = latestRows(rows)
    const selected = selectedDraftId(pack)
    const selectedRow = selected ? latest.get(selected) : null
    const sourcePendingActionIds = meta.phase === 'after_selection'
      ? selectedRow && selectedRow.id !== action.id
        ? [String(selectedRow.id)]
        : []
      : manifest.masterSource.pendingActionId
        ? [manifest.masterSource.pendingActionId]
        : []
    await attachProjectAsset(String(meta.ownerId), String(meta.projectId), {
      pendingActionId: String(action.id),
      title: String(meta.output ?? action.summary ?? 'Campaign Pack asset'),
      folder: 'Campaign Packs',
      tags: ['campaign-pack', String(meta.stageId ?? 'output')],
      recipeId: String(meta.recipeId),
      sourcePendingActionIds,
    })
  }
  await reconcilePackRow(pack)
}

export function latestCampaignPackStageRowsForTest(rows: AnyRecord[]) {
  return latestCampaignStageAttempts(
    rows.map(rowSnapshot).filter((row): row is CampaignPackStageSnapshot => Boolean(row)),
  )
}
