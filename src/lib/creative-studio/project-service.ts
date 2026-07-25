import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import {
  DEFAULT_PROJECT_FOLDER,
  LEGACY_PROJECT_ID,
  ProjectContractError,
  assetTypeFromJob,
  erpStockRowsToProductOptions,
  normalizeProjectAssetLinkInput,
  normalizeProjectAssetPatchInput,
  normalizeProjectCreateInput,
  normalizeProjectPatchInput,
  ownedProjectWhere,
  ownedRecipeWhere,
  slugifyAssetTag,
  type StudioBrandRecipe,
  type StudioProductOption,
  type StudioProjectAsset,
  type StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import {
  assertRecipeMutable,
  buildRecipeSnapshot,
  nextRecipeVersion,
  normalizeBrandRecipeInput,
  recipeKeyFor,
} from '@/lib/creative-studio/brand-recipe'
import {
  artifactFieldsFromResult,
  artifactVersionMetadata,
} from '@/lib/creative-studio/artifact-metadata'

// The generated Prisma client is refreshed by `prisma generate` in build and
// postinstall. Keeping this boundary structural lets targeted contract tests run
// before generation without weakening any runtime owner filters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const STUDIO_JOB_TYPES = ['image_gen', 'video_gen', 'video_edit', 'audio_gen']

type AnyRecord = Record<string, unknown>

export class ContentOsServiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 400, message = code) {
    super(message)
    this.name = 'ContentOsServiceError'
    this.code = code
    this.status = status
  }
}

function failContract(error: unknown): never {
  if (error instanceof ContentOsServiceError) throw error
  if (error instanceof ProjectContractError) {
    throw new ContentOsServiceError(error.code, 422, error.message)
  }
  throw error
}

function object(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value ?? ''))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString()
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeCostBdt(value: unknown): number {
  const parsed = numberOrNull(value)
  return parsed === null ? 0 : Math.max(0, roundMoney(parsed))
}

function studioJobWhere() {
  return {
    payload: { path: ['creativeStudio'], equals: true },
    type: { in: STUDIO_JOB_TYPES },
  }
}

function resultStoragePath(result: AnyRecord): string | null {
  const path = result.storagePath ?? result.videoPath ?? result.audioPath
  return typeof path === 'string' && path.trim() ? path.trim() : null
}

function resultProvider(payload: AnyRecord, result: AnyRecord): string | null {
  const provider = result.provider ?? payload.provider
  return typeof provider === 'string' && provider.trim() ? provider.trim().slice(0, 80) : null
}

function resultEngine(payload: AnyRecord, result: AnyRecord): string | null {
  const engine =
    result.falEngine
    ?? result.xaiEngine
    ?? result.engine
    ?? payload.falEngine
    ?? payload.xaiEngine
    ?? payload.vtonEngine
  return typeof engine === 'string' && engine.trim() ? engine.trim().slice(0, 120) : null
}

function resultQc(result: AnyRecord): AnyRecord | null {
  const qc = result.qc ?? result.videoQc ?? result.audioQc
  return qc && typeof qc === 'object' && !Array.isArray(qc) ? qc as AnyRecord : null
}

export function buildStudioVersionMetadata(action: {
  status?: unknown
  summary?: unknown
  payload?: unknown
  result?: unknown
}) {
  const payload = object(action.payload)
  const result = object(action.result)
  return {
    status: typeof action.status === 'string' ? action.status : 'unknown',
    summary: typeof action.summary === 'string' ? action.summary.slice(0, 300) : null,
    studioMode: typeof payload.studioMode === 'string' ? payload.studioMode : null,
    productCode: typeof payload.productCode === 'string' ? payload.productCode : null,
    familyPreset: typeof payload.familyPreset === 'string' ? payload.familyPreset : null,
    requestId: typeof result.requestId === 'string' ? result.requestId.slice(0, 160) : null,
    ...artifactVersionMetadata(result),
  }
}

function serializeRecipe(row: AnyRecord): StudioBrandRecipe {
  const profile = object(row.brandProfile)
  const qc = row.qcLevel === 'off' || row.qcLevel === 'normal' ? row.qcLevel : 'strict'
  return {
    id: String(row.id),
    brandProfileId: String(row.brandProfileId),
    brandName: typeof profile.name === 'string' ? profile.name : 'ALMA Lifestyle',
    recipeKey: String(row.recipeKey),
    version: Number(row.version),
    name: String(row.name),
    sceneSubset: Array.isArray(row.sceneSubset) ? row.sceneSubset.map(String) : [],
    modelRoles: Array.isArray(row.modelRoles) ? row.modelRoles.map(String) : [],
    finishTheme: String(row.finishTheme),
    captionTone: String(row.captionTone),
    aspectPack: Array.isArray(row.aspectPack) ? row.aspectPack.map(String) : [],
    musicVibe: String(row.musicVibe),
    qcLevel: qc,
    spendCeilingBdt: safeCostBdt(row.spendCeilingBdt),
    locked: Boolean(row.lockedAt),
    lockedAt: row.lockedAt ? dateIso(row.lockedAt) : null,
    createdAt: dateIso(row.createdAt),
    updatedAt: dateIso(row.updatedAt),
  }
}

function serializeProject(row: AnyRecord): StudioProjectSummary {
  const recipe = row.currentRecipe ? object(row.currentRecipe) : null
  const counts = object(row._count)
  const hasProduct = typeof row.productCode === 'string' && row.productCode.length > 0
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    readonly: false,
    assetCount: Number(counts.assets ?? 0),
    brandProfileId: typeof row.brandProfileId === 'string' ? row.brandProfileId : null,
    currentRecipeId: typeof row.currentRecipeId === 'string' ? row.currentRecipeId : null,
    currentRecipe: recipe
      ? {
          id: String(recipe.id),
          name: String(recipe.name),
          version: Number(recipe.version),
          locked: Boolean(recipe.lockedAt),
        }
      : null,
    product: hasProduct
      ? {
          code: String(row.productCode),
          name: typeof row.productName === 'string' ? row.productName : String(row.productCode),
          priceBdt: safeCostBdt(row.productPriceBdt),
          sourceImage: typeof row.productSourceImage === 'string' ? row.productSourceImage : null,
          available: null,
        }
      : null,
    defaultFolder: typeof row.defaultFolder === 'string' ? row.defaultFolder : DEFAULT_PROJECT_FOLDER,
    updatedAt: row.updatedAt ? dateIso(row.updatedAt) : null,
  }
}

async function requireOwnedProject(ownerId: string, projectId: string) {
  const project = await db.creativeProject.findFirst({
    where: ownedProjectWhere(ownerId, projectId),
    include: {
      currentRecipe: true,
      _count: { select: { assets: true } },
    },
  })
  if (!project) throw new ContentOsServiceError('project_not_found', 404)
  return project
}

async function countLegacyAssets(ownerId: string): Promise<number> {
  const assigned = await db.creativeProjectAsset.findMany({
    where: { project: { ownerId } },
    select: { pendingActionId: true },
  })
  const assignedIds = assigned
    .map((row: { pendingActionId: string | null }) => row.pendingActionId)
    .filter((id: string | null): id is string => Boolean(id))
  return db.agentPendingAction.count({
    where: {
      ...studioJobWhere(),
      ...(assignedIds.length ? { id: { notIn: assignedIds } } : {}),
    },
  })
}

export async function listProjects(ownerId: string): Promise<StudioProjectSummary[]> {
  const [legacyCount, rows] = await Promise.all([
    countLegacyAssets(ownerId),
    db.creativeProject.findMany({
      where: { ownerId, archivedAt: null },
      include: {
        currentRecipe: true,
        _count: { select: { assets: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    }),
  ])
  return [
    {
      id: LEGACY_PROJECT_ID,
      name: 'Legacy',
      description: 'আগের সব unassigned Creative — read-only collection',
      readonly: true,
      assetCount: legacyCount,
      brandProfileId: null,
      currentRecipeId: null,
      currentRecipe: null,
      product: null,
      defaultFolder: 'Legacy',
      updatedAt: null,
    },
    ...rows.map((row: AnyRecord) => serializeProject(row)),
  ]
}

export async function getProject(ownerId: string, projectId: string): Promise<StudioProjectSummary> {
  return serializeProject(await requireOwnedProject(ownerId, projectId))
}

export async function createProject(ownerId: string, value: unknown): Promise<StudioProjectSummary> {
  try {
    const input = normalizeProjectCreateInput(value)
    const project = await db.$transaction(async (tx: typeof db) => {
      const brandProfile = await tx.creativeBrandProfile.upsert({
        where: { ownerId_name: { ownerId, name: input.brandName } },
        create: {
          ownerId,
          name: input.brandName,
          organization: input.brandName,
        },
        update: {},
      })
      return tx.creativeProject.create({
        data: {
          ownerId,
          name: input.name,
          description: input.description,
          defaultFolder: input.defaultFolder,
          brandProfileId: brandProfile.id,
        },
        include: {
          currentRecipe: true,
          _count: { select: { assets: true } },
        },
      })
    })
    return serializeProject(project)
  } catch (error) {
    return failContract(error)
  }
}

export async function updateProject(
  ownerId: string,
  projectId: string,
  value: unknown,
): Promise<StudioProjectSummary> {
  try {
    await requireOwnedProject(ownerId, projectId)
    const patch = normalizeProjectPatchInput(value)
    const data: AnyRecord = { ...patch }
    delete data.archive

    if (patch.brandProfileId) {
      const profile = await db.creativeBrandProfile.findFirst({
        where: { id: patch.brandProfileId, ownerId },
      })
      if (!profile) throw new ContentOsServiceError('brand_profile_not_found', 404)
    }
    if (patch.currentRecipeId) {
      const recipe = await db.creativeBrandRecipe.findFirst({
        where: ownedRecipeWhere(ownerId, patch.currentRecipeId),
      })
      if (!recipe) throw new ContentOsServiceError('recipe_not_found', 404)
      data.brandProfileId = recipe.brandProfileId
    }
    if (patch.archive) data.archivedAt = new Date()

    const updated = await db.creativeProject.update({
      where: { id: projectId },
      data,
      include: {
        currentRecipe: true,
        _count: { select: { assets: true } },
      },
    })
    return serializeProject(updated)
  } catch (error) {
    return failContract(error)
  }
}

export async function listBrandRecipes(
  ownerId: string,
  brandProfileId?: string | null,
): Promise<StudioBrandRecipe[]> {
  const rows = await db.creativeBrandRecipe.findMany({
    where: {
      ownerId,
      ...(brandProfileId ? { brandProfileId } : {}),
    },
    include: { brandProfile: true },
    orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
  })
  return rows.map((row: AnyRecord) => serializeRecipe(row))
}

async function resolveOwnedBrandProfile(
  ownerId: string,
  brandProfileId: string | null,
  brandName: string,
) {
  if (brandProfileId) {
    const profile = await db.creativeBrandProfile.findFirst({
      where: { id: brandProfileId, ownerId },
    })
    if (!profile) throw new ContentOsServiceError('brand_profile_not_found', 404)
    return profile
  }
  return db.creativeBrandProfile.upsert({
    where: { ownerId_name: { ownerId, name: brandName } },
    create: { ownerId, name: brandName, organization: brandName },
    update: {},
  })
}

export async function createBrandRecipe(ownerId: string, value: unknown): Promise<StudioBrandRecipe> {
  try {
    const input = normalizeBrandRecipeInput(value)
    const profile = await resolveOwnedBrandProfile(ownerId, input.brandProfileId, input.brandName)
    const key = recipeKeyFor(input)
    const latest = await db.creativeBrandRecipe.findFirst({
      where: { ownerId, brandProfileId: profile.id, recipeKey: key },
      orderBy: { version: 'desc' },
    })
    const row = await db.creativeBrandRecipe.create({
      data: {
        ownerId,
        brandProfileId: profile.id,
        recipeKey: key,
        version: latest ? nextRecipeVersion(latest) : 1,
        name: input.name,
        sceneSubset: input.sceneSubset,
        modelRoles: input.modelRoles,
        finishTheme: input.finishTheme,
        captionTone: input.captionTone,
        aspectPack: input.aspectPack,
        musicVibe: input.musicVibe,
        qcLevel: input.qcLevel,
        spendCeilingBdt: input.spendCeilingBdt,
      },
      include: { brandProfile: true },
    })
    return serializeRecipe(row)
  } catch (error) {
    return failContract(error)
  }
}

export async function getBrandRecipe(ownerId: string, recipeId: string): Promise<StudioBrandRecipe> {
  const row = await db.creativeBrandRecipe.findFirst({
    where: ownedRecipeWhere(ownerId, recipeId),
    include: { brandProfile: true },
  })
  if (!row) throw new ContentOsServiceError('recipe_not_found', 404)
  return serializeRecipe(row)
}

export async function updateBrandRecipe(
  ownerId: string,
  recipeId: string,
  value: unknown,
): Promise<StudioBrandRecipe> {
  try {
    const current = await db.creativeBrandRecipe.findFirst({
      where: ownedRecipeWhere(ownerId, recipeId),
      include: { brandProfile: true },
    })
    if (!current) throw new ContentOsServiceError('recipe_not_found', 404)
    assertRecipeMutable(current)
    const patch = object(value)
    const input = normalizeBrandRecipeInput({
      brandProfileId: current.brandProfileId,
      brandName: current.brandProfile.name,
      recipeKey: current.recipeKey,
      name: current.name,
      sceneSubset: current.sceneSubset,
      modelRoles: current.modelRoles,
      finishTheme: current.finishTheme,
      captionTone: current.captionTone,
      aspectPack: current.aspectPack,
      musicVibe: current.musicVibe,
      qcLevel: current.qcLevel,
      spendCeilingBdt: current.spendCeilingBdt,
      ...patch,
    })
    const row = await db.creativeBrandRecipe.update({
      where: { id: recipeId },
      data: {
        name: input.name,
        sceneSubset: input.sceneSubset,
        modelRoles: input.modelRoles,
        finishTheme: input.finishTheme,
        captionTone: input.captionTone,
        aspectPack: input.aspectPack,
        musicVibe: input.musicVibe,
        qcLevel: input.qcLevel,
        spendCeilingBdt: input.spendCeilingBdt,
      },
      include: { brandProfile: true },
    })
    return serializeRecipe(row)
  } catch (error) {
    return failContract(error)
  }
}

export async function lockBrandRecipe(
  ownerId: string,
  recipeId: string,
): Promise<StudioBrandRecipe> {
  const current = await db.creativeBrandRecipe.findFirst({
    where: ownedRecipeWhere(ownerId, recipeId),
  })
  if (!current) throw new ContentOsServiceError('recipe_not_found', 404)
  const row = current.lockedAt
    ? await db.creativeBrandRecipe.findUnique({
        where: { id: recipeId },
        include: { brandProfile: true },
      })
    : await db.creativeBrandRecipe.update({
        where: { id: recipeId },
        data: { lockedAt: new Date(), lockedById: ownerId },
        include: { brandProfile: true },
      })
  return serializeRecipe(row)
}

export async function cloneBrandRecipeVersion(
  ownerId: string,
  recipeId: string,
): Promise<StudioBrandRecipe> {
  const current = await db.creativeBrandRecipe.findFirst({
    where: ownedRecipeWhere(ownerId, recipeId),
    include: { brandProfile: true },
  })
  if (!current) throw new ContentOsServiceError('recipe_not_found', 404)
  const row = await db.creativeBrandRecipe.create({
    data: {
      ownerId,
      brandProfileId: current.brandProfileId,
      recipeKey: current.recipeKey,
      version: nextRecipeVersion(current),
      name: current.name,
      sceneSubset: current.sceneSubset,
      modelRoles: current.modelRoles,
      finishTheme: current.finishTheme,
      captionTone: current.captionTone,
      aspectPack: current.aspectPack,
      musicVibe: current.musicVibe,
      qcLevel: current.qcLevel,
      spendCeilingBdt: current.spendCeilingBdt,
    },
    include: { brandProfile: true },
  })
  return serializeRecipe(row)
}

async function ownedSourceAssetIds(
  ownerId: string,
  explicitIds: string[],
  pendingActionIds: string[],
): Promise<string[]> {
  const rows = await db.creativeProjectAsset.findMany({
    where: {
      project: { ownerId, archivedAt: null },
      OR: [
        ...(explicitIds.length ? [{ id: { in: explicitIds } }] : []),
        ...(pendingActionIds.length ? [{ pendingActionId: { in: pendingActionIds } }] : []),
      ],
    },
    select: { id: true },
  })
  const ids: string[] = rows.map((row: { id: string }) => row.id)
  return [...new Set(ids)]
}

async function replaceAssetTags(
  tx: typeof db,
  ownerId: string,
  assetId: string,
  tagNames: string[],
) {
  await tx.creativeProjectAssetTag.deleteMany({ where: { assetId } })
  if (!tagNames.length) return
  for (const name of tagNames) {
    const slug = slugifyAssetTag(name)
    if (!slug) continue
    const tag = await tx.creativeAssetTag.upsert({
      where: { ownerId_slug: { ownerId, slug } },
      create: { ownerId, name, slug },
      update: { name },
    })
    await tx.creativeProjectAssetTag.create({
      data: { assetId, tagId: tag.id },
    })
  }
}

function versionDataFromAction(
  ownerId: string,
  action: AnyRecord,
  recipe: AnyRecord | null,
) {
  const payload = object(action.payload)
  const result = object(action.result)
  const costUsd = numberOrNull(result.costUsd ?? action.costEstimate)
  return {
    storagePath: resultStoragePath(result),
    recipeId: recipe?.id ?? null,
    recipeVersion: recipe ? Number(recipe.version) : null,
    provider: resultProvider(payload, result),
    engine: resultEngine(payload, result),
    jobId: String(action.id),
    costBdt: safeCostBdt(result.costBdt),
    costUsd: costUsd === null ? null : Math.max(0, costUsd),
    qc: resultQc(result),
    metadata: {
      ...buildStudioVersionMetadata(action),
      recipe: recipe ? buildRecipeSnapshot(recipe as Parameters<typeof buildRecipeSnapshot>[0]) : null,
    },
    createdById: ownerId,
  }
}

export async function attachProjectAsset(
  ownerId: string,
  projectId: string,
  value: unknown,
): Promise<StudioProjectAsset> {
  try {
    const project = await requireOwnedProject(ownerId, projectId)
    const input = normalizeProjectAssetLinkInput(value)
    const action = await db.agentPendingAction.findFirst({
      where: {
        id: input.pendingActionId,
        ...studioJobWhere(),
      },
    })
    if (!action) throw new ContentOsServiceError('studio_asset_not_found', 404)

    const recipeId = input.recipeId ?? project.currentRecipeId ?? null
    const recipe = recipeId
      ? await db.creativeBrandRecipe.findFirst({ where: ownedRecipeWhere(ownerId, recipeId) })
      : null
    if (recipeId && !recipe) throw new ContentOsServiceError('recipe_not_found', 404)

    const sourceAssetIds = await ownedSourceAssetIds(
      ownerId,
      input.sourceAssetIds,
      input.sourcePendingActionIds,
    )
    const versionData = versionDataFromAction(ownerId, action, recipe)
    const row = await db.$transaction(async (tx: typeof db) => {
      const existing = await tx.creativeProjectAsset.findFirst({
        where: { projectId, pendingActionId: input.pendingActionId },
      })
      const asset = existing
        ? await tx.creativeProjectAsset.update({
            where: { id: existing.id },
            data: {
              ...(input.title ? { title: input.title } : {}),
              latestStoragePath: versionData.storagePath ?? existing.latestStoragePath,
            },
          })
        : await tx.creativeProjectAsset.create({
            data: {
              projectId,
              pendingActionId: input.pendingActionId,
              assetType: assetTypeFromJob(action.type),
              title: input.title ?? (typeof action.summary === 'string' ? action.summary.slice(0, 160) : null),
              folder: input.folder || project.defaultFolder,
              latestStoragePath: versionData.storagePath,
              createdById: ownerId,
            },
          })

      const currentVersion = await tx.creativeAssetVersion.findFirst({
        where: { assetId: asset.id, jobId: input.pendingActionId },
      })
      const version = currentVersion
        ? await tx.creativeAssetVersion.update({
            where: { id: currentVersion.id },
            data: versionData,
          })
        : await tx.creativeAssetVersion.create({
            data: { assetId: asset.id, version: 1, ...versionData },
          })

      for (const sourceAssetId of sourceAssetIds.filter((id) => id !== asset.id)) {
        await tx.creativeAssetLineage.upsert({
          where: {
            versionId_sourceAssetId_relationKind: {
              versionId: version.id,
              sourceAssetId,
              relationKind: 'derived_from',
            },
          },
          create: {
            versionId: version.id,
            sourceAssetId,
            relationKind: 'derived_from',
          },
          update: {},
        })
      }
      if (input.tags.length) await replaceAssetTags(tx, ownerId, asset.id, input.tags)
      return asset
    })
    const full = await getProjectAsset(ownerId, projectId, row.id)
    if (!full) throw new ContentOsServiceError('asset_not_found', 404)
    return full
  } catch (error) {
    return failContract(error)
  }
}

async function synchronizeProjectAssets(ownerId: string, projectId: string) {
  const assets = await db.creativeProjectAsset.findMany({
    where: { projectId, project: { ownerId, archivedAt: null }, pendingActionId: { not: null } },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 1 },
    },
  })
  const ids = assets
    .map((asset: AnyRecord) => asset.pendingActionId)
    .filter((id: unknown): id is string => typeof id === 'string')
  if (!ids.length) return
  const actions = await db.agentPendingAction.findMany({ where: { id: { in: ids } } })
  const byId = new Map<string, AnyRecord>(
    actions.map((action: AnyRecord) => [String(action.id), action]),
  )
  for (const asset of assets as AnyRecord[]) {
    const action = byId.get(String(asset.pendingActionId))
    const version = Array.isArray(asset.versions) ? asset.versions[0] : null
    if (!action || !version) continue
    const recipe = version.recipeId
      ? await db.creativeBrandRecipe.findFirst({ where: ownedRecipeWhere(ownerId, version.recipeId) })
      : null
    const data = versionDataFromAction(ownerId, action, recipe as AnyRecord | null)
    await db.$transaction([
      db.creativeAssetVersion.update({ where: { id: version.id }, data }),
      db.creativeProjectAsset.update({
        where: { id: asset.id },
        data: { latestStoragePath: data.storagePath ?? asset.latestStoragePath },
      }),
    ])
  }
}

function serializeProjectAsset(row: AnyRecord, action?: AnyRecord | null): StudioProjectAsset {
  const assignments = Array.isArray(row.tagAssignments) ? row.tagAssignments : []
  const versions = Array.isArray(row.versions) ? row.versions : []
  const actionStatus = typeof action?.status === 'string'
    ? action.status
    : String(object(versions[0]?.metadata).status ?? 'recorded')
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    pendingActionId: typeof row.pendingActionId === 'string' ? row.pendingActionId : null,
    assetType: String(row.assetType ?? 'image'),
    title: typeof row.title === 'string' ? row.title : null,
    folder: String(row.folder ?? DEFAULT_PROJECT_FOLDER),
    previewUrl: null,
    storagePath: typeof row.latestStoragePath === 'string' ? row.latestStoragePath : null,
    status: actionStatus,
    tags: assignments.map((assignment: AnyRecord) => {
      const tag = object(assignment.tag)
      return {
        id: String(tag.id),
        name: String(tag.name),
        slug: String(tag.slug),
        color: String(tag.color),
      }
    }),
    versions: versions.map((version: AnyRecord) => {
      const recipe = version.recipe ? object(version.recipe) : null
      const lineage = Array.isArray(version.lineage) ? version.lineage : []
      const artifactFields = artifactFieldsFromResult(version.metadata)
      return {
        id: String(version.id),
        version: Number(version.version),
        storagePath: typeof version.storagePath === 'string' ? version.storagePath : null,
        previewUrl: null,
        recipeId: typeof version.recipeId === 'string' ? version.recipeId : null,
        recipeName: recipe ? String(recipe.name) : null,
        recipeVersion: version.recipeVersion == null ? null : Number(version.recipeVersion),
        provider: typeof version.provider === 'string' ? version.provider : null,
        engine: typeof version.engine === 'string' ? version.engine : null,
        jobId: typeof version.jobId === 'string' ? version.jobId : null,
        costBdt: safeCostBdt(version.costBdt),
        costUsd: numberOrNull(version.costUsd),
        qc: version.qc && typeof version.qc === 'object' ? version.qc as AnyRecord : null,
        resolutionIntegrity: artifactFields.resolutionIntegrity,
        variants: artifactFields.variants,
        createdById: String(version.createdById),
        createdAt: dateIso(version.createdAt),
        sources: lineage.map((edge: AnyRecord) => {
          const source = object(edge.sourceAsset)
          return {
            id: String(source.id),
            title: typeof source.title === 'string' ? source.title : null,
            pendingActionId: typeof source.pendingActionId === 'string' ? source.pendingActionId : null,
            relationKind: String(edge.relationKind),
          }
        }),
      }
    }),
    createdById: String(row.createdById),
    createdAt: dateIso(row.createdAt),
    updatedAt: dateIso(row.updatedAt),
  }
}

const ASSET_INCLUDE = {
  tagAssignments: { include: { tag: true } },
  versions: {
    include: {
      recipe: true,
      lineage: { include: { sourceAsset: true } },
    },
    orderBy: { version: 'desc' },
  },
}

async function getProjectAsset(
  ownerId: string,
  projectId: string,
  assetId: string,
): Promise<StudioProjectAsset | null> {
  const row = await db.creativeProjectAsset.findFirst({
    where: {
      id: assetId,
      projectId,
      project: { ownerId, archivedAt: null },
    },
    include: ASSET_INCLUDE,
  })
  if (!row) return null
  const action = row.pendingActionId
    ? await db.agentPendingAction.findUnique({ where: { id: row.pendingActionId } })
    : null
  return serializeProjectAsset(row, action)
}

export async function listProjectAssets(
  ownerId: string,
  projectId: string,
): Promise<StudioProjectAsset[]> {
  await requireOwnedProject(ownerId, projectId)
  await synchronizeProjectAssets(ownerId, projectId)
  const rows = await db.creativeProjectAsset.findMany({
    where: { projectId, project: { ownerId, archivedAt: null } },
    include: ASSET_INCLUDE,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  })
  const pendingIds = rows
    .map((row: AnyRecord) => row.pendingActionId)
    .filter((id: unknown): id is string => typeof id === 'string')
  const actions = pendingIds.length
    ? await db.agentPendingAction.findMany({ where: { id: { in: pendingIds } } })
    : []
  const byId = new Map<string, AnyRecord>(
    actions.map((action: AnyRecord) => [String(action.id), action]),
  )
  return rows.map((row: AnyRecord) => serializeProjectAsset(
    row,
    row.pendingActionId ? byId.get(String(row.pendingActionId)) : null,
  ))
}

export async function listLegacyAssets(ownerId: string): Promise<StudioProjectAsset[]> {
  const assigned = await db.creativeProjectAsset.findMany({
    where: { project: { ownerId } },
    select: { pendingActionId: true },
  })
  const assignedIds = assigned
    .map((row: { pendingActionId: string | null }) => row.pendingActionId)
    .filter((id: string | null): id is string => Boolean(id))
  const rows = await db.agentPendingAction.findMany({
    where: {
      ...studioJobWhere(),
      ...(assignedIds.length ? { id: { notIn: assignedIds } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 120,
  })
  return rows.map((row: AnyRecord) => {
    const payload = object(row.payload)
    const result = object(row.result)
    const storagePath = resultStoragePath(result)
    const version = versionDataFromAction(ownerId, row, null)
    const artifactFields = artifactFieldsFromResult(result)
    return {
      id: `legacy:${row.id}`,
      projectId: LEGACY_PROJECT_ID,
      pendingActionId: String(row.id),
      assetType: assetTypeFromJob(row.type),
      title: typeof row.summary === 'string' ? row.summary : null,
      folder: 'Legacy',
      previewUrl: null,
      storagePath,
      status: typeof row.status === 'string' ? row.status : 'unknown',
      tags: [],
      versions: [{
        id: `legacy-version:${row.id}`,
        version: 1,
        storagePath,
        previewUrl: null,
        recipeId: null,
        recipeName: null,
        recipeVersion: null,
        provider: resultProvider(payload, result),
        engine: resultEngine(payload, result),
        jobId: String(row.id),
        costBdt: version.costBdt,
        costUsd: numberOrNull(version.costUsd),
        qc: resultQc(result),
        resolutionIntegrity: artifactFields.resolutionIntegrity,
        variants: artifactFields.variants,
        createdById: ownerId,
        createdAt: dateIso(row.createdAt),
        sources: [],
      }],
      createdById: ownerId,
      createdAt: dateIso(row.createdAt),
      updatedAt: dateIso(row.resolvedAt ?? row.createdAt),
      readonly: true,
    }
  })
}

export async function updateProjectAsset(
  ownerId: string,
  projectId: string,
  value: unknown,
): Promise<StudioProjectAsset> {
  try {
    const input = normalizeProjectAssetPatchInput(value)
    const existing = await db.creativeProjectAsset.findFirst({
      where: {
        id: input.assetId,
        projectId,
        project: { ownerId, archivedAt: null },
      },
    })
    if (!existing) throw new ContentOsServiceError('asset_not_found', 404)
    await db.$transaction(async (tx: typeof db) => {
      await tx.creativeProjectAsset.update({
        where: { id: existing.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.folder !== undefined ? { folder: input.folder } : {}),
        },
      })
      if (input.tags !== undefined) {
        await replaceAssetTags(tx, ownerId, existing.id, input.tags)
      }
    })
    const updated = await getProjectAsset(ownerId, projectId, existing.id)
    if (!updated) throw new ContentOsServiceError('asset_not_found', 404)
    return updated
  } catch (error) {
    return failContract(error)
  }
}

export async function searchErpProducts(query: string): Promise<StudioProductOption[]> {
  const clean = query.trim().slice(0, 80)
  const [products, stockRows] = await Promise.all([
    db.lifestyleProduct.findMany({
      where: {
        active: true,
        ...(clean
          ? {
              OR: [
                { sku: { contains: clean, mode: 'insensitive' } },
                { name: { contains: clean, mode: 'insensitive' } },
                { category: { contains: clean, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { sku: 'asc' }],
      take: 30,
    }),
    db.lifestyleStockItem.findMany({
      where: {
        archived: false,
        active: true,
        ...(clean
          ? {
              OR: [
                { sku: { contains: clean, mode: 'insensitive' } },
                { product: { contains: clean, mode: 'insensitive' } },
                { category: { contains: clean, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { sku: 'asc' }],
      select: {
        sku: true,
        product: true,
        currentStock: true,
        available: true,
        sellValue: true,
        imageUrl: true,
      },
      take: 240,
    }),
  ])
  const candidates = new Map<string, StudioProductOption>()
  for (const product of products as AnyRecord[]) {
    const code = String(product.sku)
    candidates.set(code, {
      code,
      name: String(product.name),
      priceBdt: safeCostBdt(product.defaultPrice),
      sourceImage: typeof product.imageUrl === 'string' && product.imageUrl ? product.imageUrl : null,
      available: null,
    })
  }
  for (const product of erpStockRowsToProductOptions(stockRows)) {
    if (!candidates.has(product.code)) candidates.set(product.code, product)
    if (candidates.size >= 30) break
  }
  const selected = [...candidates.values()].slice(0, 30)
  const codes = selected.map((product) => product.code)
  if (!codes.length) return []
  const [images, stock] = await Promise.all([
    db.productImage.findMany({
      where: { productCode: { in: codes } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    }),
    db.lifestyleStockItem.groupBy({
      by: ['sku'],
      where: { sku: { in: codes }, archived: false, active: true },
      _sum: { available: true },
    }),
  ])
  const imageByCode = new Map<string, AnyRecord>()
  for (const image of images as AnyRecord[]) {
    if (!imageByCode.has(String(image.productCode))) imageByCode.set(String(image.productCode), image)
  }
  const stockByCode = new Map(
    (stock as AnyRecord[]).map((row) => [String(row.sku), Number(object(row._sum).available ?? 0)]),
  )
  return selected.map((product) => {
    const image = imageByCode.get(product.code)
    const sourceImage =
      (typeof image?.storagePath === 'string' && image.storagePath)
      || (typeof image?.url === 'string' && image.url)
      || product.sourceImage
      || null
    return {
      ...product,
      sourceImage,
      available: stockByCode.has(product.code)
        ? stockByCode.get(product.code)!
        : product.available,
    }
  })
}
