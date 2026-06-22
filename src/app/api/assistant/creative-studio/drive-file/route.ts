import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { fetchDriveFile } from '@/agent/lib/drive'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Streams a Creative Studio original from Google Drive after the Supabase copy
 * has been archived + cleaned up. The owner only ever passes a pendingActionId
 * (and optionally the original Supabase path) — never a raw Drive file id — so
 * we can only ever serve files that belong to a real Creative Studio item.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id')?.trim()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })
  const wantPath = req.nextUrl.searchParams.get('path')?.trim() || null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const action = await db.agentPendingAction.findUnique({ where: { id } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  const payload = (action.payload ?? {}) as Record<string, unknown>
  if (payload.creativeStudio !== true) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = (action.result ?? {}) as Record<string, unknown>
  const driveFiles = (result.driveFiles ?? {}) as Record<string, { fileId?: string }>

  // Resolve which archived file to serve: explicit path, else the primary one.
  const primaryPath =
    (result.storagePath as string | undefined)
    ?? (result.videoPath as string | undefined)
    ?? null
  const key = wantPath ?? primaryPath
  const fileId = key ? driveFiles[key]?.fileId : undefined
  if (!fileId) return Response.json({ error: 'not_archived' }, { status: 404 })

  let upstream: Response | null
  try {
    upstream = await fetchDriveFile(fileId)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown'
    console.error('[drive-file] fetch failed:', detail)
    return Response.json({ error: 'drive_unavailable', detail }, { status: 502 })
  }
  if (!upstream || !upstream.body) {
    return Response.json({ error: 'drive_unavailable' }, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const headers = new Headers({
    'Content-Type': contentType,
    // Originals are immutable once archived — cache aggressively on the client.
    'Cache-Control': 'private, max-age=86400',
  })
  const len = upstream.headers.get('content-length')
  if (len) headers.set('Content-Length', len)

  return new Response(upstream.body, { status: 200, headers })
}
