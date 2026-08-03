import type { CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { prisma } from '@/lib/prisma'
import { isSystemOwner } from '@/lib/roles'
import {
  assertStudioSpendAllowed,
  requireStudioBrandAccess,
  StudioAccessError,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import type {
  StudioRunFamilyModelPin,
  StudioRunFamilyRole,
  StudioRunReferencePin,
  StudioRunScope,
} from '@/lib/creative-studio/studio-run-authorization'
import { assertStudioResourceScope } from '@/lib/creative-studio/studio-resource-scope'
import { getModelByRole } from '@/lib/tryon/model-library'
import { resolvePersonRef } from '@/lib/tryon/model-avatar'
import { listProductImages } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'
import { isLegacyStudioProductPath } from '@/lib/creative-studio/studio-product-source'

// Kept structural so this boundary can ship without regenerating Prisma in UI-only
// worktrees that consume the already-accepted Foundation schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ScopedStudioRunRequest = CreativeStudioRunInput & {
  auto?: boolean
  includeFamily?: boolean
  includeReel?: boolean
  sourcePendingActionId?: string
  sourceAssetIds?: string[]
  brandProfileId?: string
  projectId?: string
  productId?: string
  productReferenceId?: string
  modelReferenceId?: string
  requestedCapBdt?: number
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 180) : ''
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(cleanId).filter(Boolean))].slice(0, 20)
}

function pathValues(request: ScopedStudioRunRequest): string[] {
  return [
    request.sourceImagePath,
    request.secondSourceImagePath,
    request.productImagePath,
  ].filter((value): value is string => Boolean(value?.trim()))
}

const FAMILY_SCOPE_ROLES: Record<string, StudioRunFamilyRole[]> = {
  father_son: ['father', 'son'],
  mother_son: ['mother', 'son'],
  mother_daughter: ['mother', 'daughter'],
  father_daughter: ['father', 'daughter'],
  couple: ['father', 'mother'],
  full_family: ['father', 'mother', 'son', 'daughter'],
}

export async function resolveScopedStudioRun(
  actor: StudioActor,
  request: ScopedStudioRunRequest,
): Promise<{
  request: ScopedStudioRunRequest
  scope: StudioRunScope
  access: Awaited<ReturnType<typeof requireStudioBrandAccess>>
}> {
  const brandProfileId = cleanId(request.brandProfileId)
  const projectId = cleanId(request.projectId)
  if (!brandProfileId || !projectId) {
    throw new StudioAccessError('studio_run_scope_required', 422)
  }
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  const legacyModelActor = access.role === 'owner'
    && access.ownerId === actor.userId
    && isSystemOwner(actor.erpRole)
    ? { userId: actor.userId, erpRole: actor.erpRole }
    : undefined
  // A reviewer never gains a paid/draft path merely by knowing a project id.
  assertStudioSpendAllowed(access.role, 0, access.approvalSpendThresholdBdt)

  const project = await db.creativeProject.findFirst({
    where: {
      id: projectId,
      ownerId: access.ownerId,
      brandProfileId,
    },
    select: {
      id: true,
      ownerId: true,
      brandProfileId: true,
      archivedAt: true,
      productCode: true,
      productName: true,
      productSourceImage: true,
    },
  })
  if (!project) throw new StudioAccessError('project_access_forbidden', 403)
  if (project.archivedAt) throw new StudioAccessError('project_archived', 409)

  const requestedAssetIds = cleanIds(request.sourceAssetIds)
  const sourcePendingActionId = cleanId(request.sourcePendingActionId)
  const assets = requestedAssetIds.length || sourcePendingActionId
    ? await db.creativeProjectAsset.findMany({
        where: {
          projectId,
          OR: [
            ...(requestedAssetIds.length ? [{ id: { in: requestedAssetIds } }] : []),
            ...(sourcePendingActionId ? [{ pendingActionId: sourcePendingActionId }] : []),
          ],
        },
        select: {
          id: true,
          pendingActionId: true,
          latestStoragePath: true,
          versions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: { storagePath: true },
          },
        },
      })
    : []
  if (requestedAssetIds.some((id) => !assets.some((asset: { id: string }) => asset.id === id))) {
    throw new StudioAccessError('source_asset_access_forbidden', 403)
  }
  if (
    sourcePendingActionId
    && !assets.some((asset: { pendingActionId: string | null }) =>
      asset.pendingActionId === sourcePendingActionId)
  ) {
    throw new StudioAccessError('source_asset_access_forbidden', 403)
  }

  const allowedPaths = new Set<string>()
  const referencePins: StudioRunReferencePin[] = []
  if (project.productSourceImage) {
    if (isLegacyStudioProductPath(String(project.productSourceImage)) && project.productCode) {
      const [catalogImage] = await listProductImages(
        String(project.productCode),
        DEFAULT_CATALOG_BUSINESS,
        1,
      )
      if (catalogImage?.storagePath) allowedPaths.add(catalogImage.storagePath)
    } else {
      allowedPaths.add(String(project.productSourceImage))
    }
  }
  for (const asset of assets as Array<{
    latestStoragePath: string | null
    versions: Array<{ storagePath: string | null }>
  }>) {
    if (asset.latestStoragePath) allowedPaths.add(asset.latestStoragePath)
    if (asset.versions[0]?.storagePath) allowedPaths.add(asset.versions[0].storagePath)
  }
  const productId = cleanId(request.productId) || null
  if (productId && productId !== String(project.productCode ?? '')) {
    throw new StudioAccessError('project_product_scope_mismatch', 403)
  }
  if (
    request.productImagePath
    && project.productSourceImage
    && request.productImagePath === project.productSourceImage
    && !productId
  ) {
    throw new StudioAccessError('project_product_id_required', 422)
  }
  const productReferenceId = cleanId(request.productReferenceId)
  if (productReferenceId) {
    if (!request.productImagePath) {
      throw new StudioAccessError('product_reference_path_required', 422)
    }
    const referenceScope = await assertStudioResourceScope('reference', productReferenceId, {
      ownerId: access.ownerId,
      brandProfileId,
      projectId,
    })
    if (
      referenceScope.referenceKind !== 'product'
      || referenceScope.sourcePath !== request.productImagePath
    ) {
      throw new StudioAccessError('product_reference_lineage_mismatch', 403)
    }
    allowedPaths.add(request.productImagePath)
    referencePins.push({
      id: productReferenceId,
      kind: 'product',
      sourcePath: request.productImagePath,
    })
  }

  const modelId = cleanId(request.modelId)
  const modelReferenceId = cleanId(request.modelReferenceId)
  if (modelId && modelReferenceId) {
    throw new StudioAccessError('model_reference_ambiguous', 422)
  }
  if (modelId) {
    await assertStudioResourceScope('model', modelId, {
      ownerId: access.ownerId,
      brandProfileId,
      projectId,
    }, { legacyModelActor })
    const model = await db.agentBrandModel.findUnique({
      where: { id: modelId },
      select: { imagePath: true },
    })
    if (!model) throw new StudioAccessError('model_not_found', 404)
    allowedPaths.add(String(model.imagePath))
    const resolvedModelSource = await resolvePersonRef({
      id: modelId,
      imagePath: String(model.imagePath),
    })
    allowedPaths.add(resolvedModelSource.path)
    if (resolvedModelSource.sheetPath) {
      allowedPaths.add(resolvedModelSource.sheetPath)
    }
    if (
      request.modelImagePath
      && request.modelImagePath !== model.imagePath
    ) {
      throw new StudioAccessError('model_lineage_scope_mismatch', 403)
    }
    if (
      request.faceReferencePath
      && request.faceReferencePath !== model.imagePath
    ) {
      throw new StudioAccessError('model_lineage_scope_mismatch', 403)
    }
    if (
      request.avatarSheetPath
      && request.avatarSheetPath !== model.imagePath
    ) {
      // Avatar sheet hydration remains server-owned. A caller cannot smuggle
      // an arbitrary private path through an otherwise valid scoped model id.
      throw new StudioAccessError('avatar_lineage_scope_mismatch', 403)
    }
  } else if (modelReferenceId) {
    if (!request.modelImagePath) {
      throw new StudioAccessError('model_reference_path_required', 422)
    }
    const referenceScope = await assertStudioResourceScope('reference', modelReferenceId, {
      ownerId: access.ownerId,
      brandProfileId,
      projectId,
    })
    if (
      referenceScope.referenceKind !== 'model'
      || referenceScope.sourcePath !== request.modelImagePath
      || (
        request.faceReferencePath
        && request.faceReferencePath !== referenceScope.sourcePath
      )
    ) {
      throw new StudioAccessError('model_reference_lineage_mismatch', 403)
    }
    if (request.avatarSheetPath) {
      throw new StudioAccessError('scoped_model_id_required', 422)
    }
    referencePins.push({
      id: modelReferenceId,
      kind: 'model',
      sourcePath: request.modelImagePath,
    })
  } else if (request.modelImagePath || request.faceReferencePath || request.avatarSheetPath) {
      throw new StudioAccessError('scoped_model_id_required', 422)
  }
  const requiredFamilyRoles = request.auto && request.includeFamily
    ? (['father', 'mother', 'son', 'daughter'] as StudioRunFamilyRole[])
    : request.familyPreset
      && request.familyPreset !== 'single'
      && !(request.familyPreset === 'full_family'
        && request.sourceImagePath
        && request.secondSourceImagePath)
        ? FAMILY_SCOPE_ROLES[request.familyPreset] ?? []
        : []
  const familyModelPins: StudioRunFamilyModelPin[] = []
  if (requiredFamilyRoles.length) {
    const familyModels = await Promise.all(
      requiredFamilyRoles.map(async (role) => ({
        role,
        model: await getModelByRole(role),
      })),
    )
    const missing = familyModels
      .filter((entry) => !entry.model || entry.model.role !== entry.role)
      .map((entry) => entry.role)
    if (!request.auto && missing.length) {
      throw new StudioAccessError(`missing_models:${missing.join(',')}`, 422)
    }
    for (const entry of familyModels) {
      if (!entry.model || entry.model.role !== entry.role) continue
      await assertStudioResourceScope('model', entry.model.id, {
        ownerId: access.ownerId,
        brandProfileId,
        projectId,
      }, { legacyModelActor })
      const personRef = await resolvePersonRef(entry.model)
      familyModelPins.push({
        role: entry.role,
        modelId: entry.model.id,
        modelImagePath: entry.model.imagePath,
        sourceImagePath: personRef.path,
        ...(personRef.sheetPath
          ? { avatarSheetPath: personRef.sheetPath }
          : {}),
        modelName: entry.model.name,
        ...(entry.model.notes ? { modelNotes: entry.model.notes } : {}),
      })
    }
  }
  if (request.maskPath) {
    const maskScope = await assertStudioResourceScope('mask', request.maskPath, {
      ownerId: access.ownerId,
      brandProfileId,
      projectId,
    })
    if (
      !request.sourceImagePath
      || maskScope.sourcePath !== request.sourceImagePath
      || !maskScope.sourceAssetIds?.some((id) =>
        assets.some((asset: { id: string }) => asset.id === id))
    ) {
      throw new StudioAccessError('mask_source_lineage_mismatch', 403)
    }
  }
  for (const path of pathValues(request)) {
    if (!allowedPaths.has(path)) {
      throw new StudioAccessError('source_lineage_scope_mismatch', 403)
    }
  }

  return {
    request: {
      ...request,
      brandProfileId,
      projectId,
      productId: productId ?? undefined,
      productName: typeof project.productName === 'string' ? project.productName : undefined,
      sourceAssetIds: assets.map((asset: { id: string }) => asset.id),
      sourcePendingActionId: sourcePendingActionId || undefined,
      familyModelPins,
      productReferenceId: productReferenceId || undefined,
      modelReferenceId: modelReferenceId || undefined,
    },
    scope: {
      actorUserId: actor.userId,
      ownerId: access.ownerId,
      role: access.role,
      brandProfileId,
      projectId,
      productId,
      sourceAssetIds: assets.map((asset: { id: string }) => asset.id),
      familyModelPins,
      referencePins,
    },
    access,
  }
}
