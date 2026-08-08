import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import { prisma } from '@/lib/prisma'
import { isSystemOwner } from '@/lib/roles'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
  studioAccessErrorResponse,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  ContentOsServiceError,
  attachProjectAsset,
  listLegacyAssets,
  listProjectAssets,
  updateProjectAsset,
} from '@/lib/creative-studio/project-service'
import {
  isLegacyProjectId,
  type StudioProjectAsset,
} from '@/lib/creative-studio/project-contract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Structural boundary keeps this route compatible while additive Prisma
// migrations and generated clients are deployed together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function ownerId(req: NextRequest): Promise<string | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return token.sub
}

function errorResponse(error: unknown) {
  if (error instanceof ContentOsServiceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  console.error('[creative-project-assets] request failed', error)
  return Response.json({ error: 'content_os_failed' }, { status: 500 })
}

async function readableProjectOwnerId(
  actor: StudioActor,
  projectId: string,
): Promise<string> {
  const project = await db.creativeProject.findUnique({
    where: { id: projectId },
    select: { ownerId: true, brandProfileId: true, archivedAt: true },
  })
  if (!project || project.archivedAt) {
    throw new StudioAccessError('project_access_forbidden', 403)
  }
  if (!project.brandProfileId) {
    throw new StudioAccessError('asset_brand_missing', 409)
  }
  const access = await requireStudioBrandAccess(actor, String(project.brandProfileId))
  if (String(project.ownerId) !== access.ownerId) {
    throw new StudioAccessError('project_access_forbidden', 403)
  }
  return access.ownerId
}

async function withSignedPreviews(assets: StudioProjectAsset[]) {
  const paths = new Set<string>()
  for (const asset of assets) {
    if (asset.storagePath) paths.add(asset.storagePath)
    for (const version of asset.versions) if (version.storagePath) paths.add(version.storagePath)
  }
  let signed: Record<string, string> = {}
  if (paths.size) {
    try {
      signed = await agentStorageSignedUrls([...paths], 3600)
    } catch {
      signed = {}
    }
  }
  return assets.map((asset) => {
    const versions = asset.versions.map((version) => ({
      ...version,
      previewUrl: version.storagePath
        ? signed[version.storagePath]
          ?? (version.jobId
            ? `/api/assistant/creative-studio/drive-file?id=${encodeURIComponent(version.jobId)}&path=${encodeURIComponent(version.storagePath)}`
            : null)
        : null,
    }))
    return {
      ...asset,
      versions,
      previewUrl: asset.storagePath
        ? signed[asset.storagePath]
          ?? (asset.pendingActionId
            ? `/api/assistant/creative-studio/drive-file?id=${encodeURIComponent(asset.pendingActionId)}&path=${encodeURIComponent(asset.storagePath)}`
            : null)
        : versions[0]?.previewUrl ?? null,
    }
  })
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  try {
    let assets: StudioProjectAsset[]
    if (isLegacyProjectId(params.id)) {
      if (!isSystemOwner(actor.erpRole)) {
        throw new StudioAccessError('legacy_owner_only', 403)
      }
      assets = await listLegacyAssets(actor.userId)
    } else {
      const owner = await readableProjectOwnerId(actor, params.id)
      assets = await listProjectAssets(owner, params.id)
    }
    return Response.json({ assets: await withSignedPreviews(assets) })
  } catch (error) {
    if (error instanceof ContentOsServiceError) return errorResponse(error)
    return studioAccessErrorResponse(error, 'creative-project-assets-list')
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  if (isLegacyProjectId(params.id)) {
    return Response.json({ error: 'legacy_readonly' }, { status: 409 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const asset = await attachProjectAsset(owner, params.id, body)
    const [signed] = await withSignedPreviews([asset])
    return Response.json({ asset: signed }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  if (isLegacyProjectId(params.id)) {
    return Response.json({ error: 'legacy_readonly' }, { status: 409 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const asset = await updateProjectAsset(owner, params.id, body)
    const [signed] = await withSignedPreviews([asset])
    return Response.json({ asset: signed })
  } catch (error) {
    return errorResponse(error)
  }
}
