import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

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

  const items = await Promise.all(
    slice.map(async (row: {
      id: string
      type: string
      status: string
      summary: string | null
      createdAt: Date
      payload: Record<string, unknown>
      result: Record<string, unknown> | null
    }) => {
      const payload = row.payload ?? {}
      const result = (row.result ?? {}) as Record<string, unknown>
      const storagePath =
        (result.storagePath as string | undefined)
        ?? (result.videoPath as string | undefined)
        ?? null
      let previewUrl: string | null = null
      if (storagePath) {
        try {
          previewUrl = await agentStorageSignedUrl(storagePath, 3600)
        } catch {
          previewUrl = null
        }
      }
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
        storagePath,
        error: result.error ?? null,
      }
    }),
  )

  return Response.json({
    items,
    page,
    total: filtered.length,
    hasMore: skip + limit < filtered.length,
  })
}
