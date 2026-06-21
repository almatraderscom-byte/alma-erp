import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrls } from '@/agent/lib/storage'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page') ?? 1))
  const limit = Math.min(48, Math.max(12, Number(req.nextUrl.searchParams.get('limit') ?? 24)))
  const skip = (page - 1) * limit

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: { in: ['image_gen', 'video_gen'] },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 50,
    skip: 0,
  })

  const filtered = rows.filter((r: { payload: unknown }) => {
    const p = r.payload as Record<string, unknown> | null
    return p?.creativeStudio === true
  })

  const slice = filtered.slice(skip, skip + limit)

  type Row = {
    id: string
    type: string
    status: string
    summary: string | null
    createdAt: Date
    payload: Record<string, unknown>
    result: Record<string, unknown> | null
  }

  type Meta = {
    row: Row
    result: Record<string, unknown>
    storagePath: string | null
    brandedPath: string | null
    thumbPath: string | null
  }

  // Collect every object path across the page, then sign them all in ONE batch
  // request (was one signed-URL round-trip per image → slow gallery).
  const pathsToSign = new Set<string>()
  const meta: Meta[] = slice.map((row: Row): Meta => {
    const result = (row.result ?? {}) as Record<string, unknown>
    const storagePath =
      (result.storagePath as string | undefined)
      ?? (result.videoPath as string | undefined)
      ?? null
    const brandedPath = (result.brandedPath as string | undefined) ?? null
    // Prefer the (small) thumbnail for the grid; branded thumb if it exists.
    const thumbPath =
      (result.brandedThumbPath as string | undefined)
      ?? (result.thumbPath as string | undefined)
      ?? null
    if (storagePath) pathsToSign.add(storagePath)
    if (brandedPath) pathsToSign.add(brandedPath)
    if (thumbPath) pathsToSign.add(thumbPath)
    return { row, result, storagePath, brandedPath, thumbPath }
  })

  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(Array.from(pathsToSign), 3600)
  } catch {
    signed = {}
  }

  const items = meta.map(({ row, result, storagePath, brandedPath, thumbPath }) => {
    const payload = row.payload ?? {}
    const previewUrl = storagePath ? signed[storagePath] ?? null : null
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
      mode: payload.studioMode ?? payload.tryOnVariant ?? 'try_on',
      provider: payload.provider ?? 'gemini',
      familyPreset: payload.familyPreset ?? null,
      previewUrl,
      // small image for the grid tile — falls back to the full preview
      thumbUrl: (thumbPath && signed[thumbPath]) || previewUrl,
      // branded (logo + code + hook) variant, when the worker produced one
      brandedUrl: brandedPath ? signed[brandedPath] ?? null : null,
      storagePath,
      error: result.error ?? null,
    }
  })

  return Response.json({
    items,
    page,
    total: filtered.length,
    hasMore: skip + limit < filtered.length,
  })
}
