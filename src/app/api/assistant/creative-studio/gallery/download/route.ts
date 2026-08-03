import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { fetchDriveFile } from '@/agent/lib/drive'
import { prisma } from '@/lib/prisma'
import { downloadStorageObject } from '@/lib/supabase-storage'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
} from '@/lib/creative-studio/studio-access'
import { artifactFieldsFromResult } from '@/lib/creative-studio/artifact-metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function clean(value: string | null, max = 220): string {
  return value?.trim().slice(0, max) ?? ''
}

function contentTypeForPath(path: string): string {
  const extension = path.split('?')[0]?.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'mp4') return 'video/mp4'
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'wav') return 'audio/wav'
  return 'image/jpeg'
}

function downloadName(id: string, path: string): string {
  const extension = path.split('?')[0]?.split('.').pop()?.toLowerCase()
  const safeExtension = extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : 'bin'
  return `alma-${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'studio-asset'}.${safeExtension}`
}

function downloadHeaders(id: string, path: string, contentType?: string | null): Headers {
  const filename = downloadName(id, path)
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Type': contentType || contentTypeForPath(path),
    'X-Content-Type-Options': 'nosniff',
  })
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = clean(req.nextUrl.searchParams.get('id'))
  const brandProfileId = clean(req.nextUrl.searchParams.get('brandProfileId'))
  const projectId = clean(req.nextUrl.searchParams.get('projectId'))
  const projectAssetId = clean(req.nextUrl.searchParams.get('projectAssetId'))
  const assetVersionId = clean(req.nextUrl.searchParams.get('assetVersionId'))
  const rawReviewSequence = req.nextUrl.searchParams.get('reviewSequence')
  const reviewSequence = rawReviewSequence === null ? Number.NaN : Number(rawReviewSequence)
  if (
    !id
    || !brandProfileId
    || !projectId
    || !projectAssetId
    || !assetVersionId
    || !Number.isInteger(reviewSequence)
    || reviewSequence < 0
  ) {
    return Response.json({ error: 'download_asset_snapshot_required' }, { status: 422 })
  }

  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor

  try {
    const access = await requireStudioBrandAccess(actor, brandProfileId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const asset = await db.creativeProjectAsset.findFirst({
      where: {
        id: projectAssetId,
        projectId,
        pendingActionId: id,
        reviewSequence,
        project: {
          ownerId: access.ownerId,
          brandProfileId,
        },
      },
      select: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    })
    if (!asset) return Response.json({ error: 'download_asset_not_found' }, { status: 404 })
    if (asset.versions[0]?.id !== assetVersionId) {
      return Response.json({ error: 'download_asset_snapshot_changed' }, { status: 409 })
    }

    const action = await db.agentPendingAction.findUnique({
      where: { id },
      select: { result: true },
    })
    if (!action) return Response.json({ error: 'download_asset_not_found' }, { status: 404 })
    const result = (action.result ?? {}) as Record<string, unknown>
    const artifacts = artifactFieldsFromResult(result)
    const storagePath = artifacts.original?.storagePath
      ?? (typeof result.storagePath === 'string' ? result.storagePath : null)
      ?? (typeof result.videoPath === 'string' ? result.videoPath : null)
    if (!storagePath) return Response.json({ error: 'download_original_unavailable' }, { status: 404 })

    try {
      const bytes = await downloadStorageObject('agent-files', storagePath)
      const headers = downloadHeaders(id, storagePath, artifacts.original?.mimeType)
      headers.set('Content-Length', String(bytes.byteLength))
      return new Response(new Uint8Array(bytes), { status: 200, headers })
    } catch (storageError) {
      const driveFiles = (result.driveFiles ?? {}) as Record<string, { fileId?: string }>
      const fileId = driveFiles[storagePath]?.fileId
      if (!fileId) throw storageError
      const upstream = await fetchDriveFile(fileId)
      if (!upstream?.body) throw storageError
      const headers = downloadHeaders(id, storagePath, upstream.headers.get('content-type'))
      const length = upstream.headers.get('content-length')
      if (length) headers.set('Content-Length', length)
      return new Response(upstream.body, { status: 200, headers })
    }
  } catch (error) {
    if (error instanceof StudioAccessError) {
      return Response.json({ error: error.code }, { status: error.status })
    }
    console.error('[creative-studio-download] failed', error)
    return Response.json({ error: 'download_original_failed' }, { status: 502 })
  }
}
