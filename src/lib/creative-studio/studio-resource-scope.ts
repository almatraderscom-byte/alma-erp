import { prisma } from '@/lib/prisma'
import {
  requireStudioBrandAccess,
  StudioAccessError,
  type StudioActor,
  type StudioBrandAccess,
} from '@/lib/creative-studio/studio-access'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type StudioScopedResourceKind = 'model' | 'voice' | 'video' | 'music' | 'mask'

export type StudioResourceScope = {
  version: 1
  ownerId: string
  brandProfileId: string
  projectId: string
  createdById: string
  createdAt: string
  sourceAssetIds?: string[]
  sourcePath?: string
}

export type StudioResourceContext = {
  access: StudioBrandAccess
  brandProfileId: string
  projectId: string
}

export type StudioProjectAssetContext = StudioResourceContext & {
  projectAssetId: string
  pendingActionId: string
  allowedStoragePaths: string[]
}

function cleanScopeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 180) : ''
}

export async function requireStudioResourceContext(
  actor: StudioActor,
  input: {
    brandProfileId?: string | null
    projectId?: string | null
  },
): Promise<StudioResourceContext> {
  const brandProfileId = cleanScopeId(input.brandProfileId)
  const projectId = cleanScopeId(input.projectId)
  if (!brandProfileId || !projectId) {
    throw new StudioAccessError('studio_resource_scope_required', 422)
  }
  const access = await requireStudioBrandAccess(actor, brandProfileId)
  const project = await db.creativeProject.findFirst({
    where: {
      id: projectId,
      ownerId: access.ownerId,
      brandProfileId,
      archivedAt: null,
    },
    select: { id: true },
  })
  if (!project) throw new StudioAccessError('project_access_forbidden', 403)
  return { access, brandProfileId, projectId }
}

/**
 * Resolve a canonical project asset from the authenticated actor's accessible
 * brand and project. Caller-provided ids and storage paths are selectors only;
 * every relationship is re-derived from the database before a derivative job
 * can be created.
 */
export async function requireStudioProjectAssetContext(
  actor: StudioActor,
  input: {
    brandProfileId?: string | null
    projectId?: string | null
    projectAssetId?: string | null
    pendingActionId?: string | null
    storagePath?: string | null
  },
): Promise<StudioProjectAssetContext> {
  const context = await requireStudioResourceContext(actor, input)
  const projectAssetId = cleanScopeId(input.projectAssetId)
  const pendingActionId = cleanScopeId(input.pendingActionId)
  if (!projectAssetId || !pendingActionId) {
    throw new StudioAccessError('studio_asset_scope_required', 422)
  }
  const asset = await db.creativeProjectAsset.findFirst({
    where: {
      id: projectAssetId,
      projectId: context.projectId,
      pendingActionId,
      project: {
        ownerId: context.access.ownerId,
        brandProfileId: context.brandProfileId,
        archivedAt: null,
      },
    },
    select: {
      id: true,
      pendingActionId: true,
      latestStoragePath: true,
      versions: {
        select: { storagePath: true },
        orderBy: { version: 'desc' },
      },
    },
  })
  if (!asset || asset.pendingActionId !== pendingActionId) {
    throw new StudioAccessError('project_asset_access_forbidden', 403)
  }
  const allowedStoragePaths = [...new Set([
    typeof asset.latestStoragePath === 'string' ? asset.latestStoragePath : '',
    ...asset.versions.map((version: { storagePath: string | null }) =>
      typeof version.storagePath === 'string' ? version.storagePath : ''),
  ].filter(Boolean))]
  const storagePath = typeof input.storagePath === 'string' ? input.storagePath.trim() : ''
  if (storagePath && !allowedStoragePaths.includes(storagePath)) {
    throw new StudioAccessError('source_lineage_scope_mismatch', 403)
  }
  return {
    ...context,
    projectAssetId,
    pendingActionId,
    allowedStoragePaths,
  }
}

export async function filterStudioResourcesToScope<T extends { id: string }>(
  kind: StudioScopedResourceKind,
  resources: T[],
  expected: { ownerId: string; brandProfileId: string; projectId: string },
): Promise<T[]> {
  const scopes = await Promise.all(
    resources.map((resource) => readStudioResourceScope(kind, resource.id)),
  )
  return resources.filter((_, index) =>
    studioResourceScopeMatches(scopes[index], expected))
}

export function studioResourceScopeKey(kind: StudioScopedResourceKind, id: string): string {
  return `studio_scope:${kind}:${id}`.slice(0, 240)
}

export async function readStudioResourceScope(
  kind: StudioScopedResourceKind,
  id: string,
): Promise<StudioResourceScope | null> {
  const row = await db.agentKvSetting.findUnique({
    where: { key: studioResourceScopeKey(kind, id) },
  })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as StudioResourceScope
    return parsed?.version === 1
      && parsed.ownerId
      && parsed.brandProfileId
      && parsed.projectId
      ? parsed
      : null
  } catch {
    return null
  }
}

export async function writeStudioResourceScope(
  kind: StudioScopedResourceKind,
  id: string,
  scope: Omit<StudioResourceScope, 'version' | 'createdAt'>,
): Promise<StudioResourceScope> {
  const record: StudioResourceScope = {
    version: 1,
    ...scope,
    createdAt: new Date().toISOString(),
  }
  await db.agentKvSetting.upsert({
    where: { key: studioResourceScopeKey(kind, id) },
    create: { key: studioResourceScopeKey(kind, id), value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  })
  return record
}

export async function deleteStudioResourceScope(
  kind: StudioScopedResourceKind,
  id: string,
): Promise<void> {
  await db.agentKvSetting.deleteMany({
    where: { key: studioResourceScopeKey(kind, id) },
  })
}

export function studioResourceScopeMatches(
  scope: StudioResourceScope | null,
  expected: { ownerId: string; brandProfileId: string; projectId?: string | null },
): boolean {
  return Boolean(
    scope
    && scope.ownerId === expected.ownerId
    && scope.brandProfileId === expected.brandProfileId
    && (!expected.projectId || scope.projectId === expected.projectId),
  )
}

export async function assertStudioResourceScope(
  kind: StudioScopedResourceKind,
  id: string,
  expected: { ownerId: string; brandProfileId: string; projectId?: string | null },
): Promise<StudioResourceScope> {
  const scope = await readStudioResourceScope(kind, id)
  if (!studioResourceScopeMatches(scope, expected)) {
    throw new StudioAccessError(`${kind}_scope_mismatch`, 403)
  }
  return scope!
}
