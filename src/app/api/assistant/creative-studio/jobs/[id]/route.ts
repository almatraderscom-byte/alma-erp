import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  const payload = (row.payload ?? {}) as Record<string, unknown>
  const result = (row.result ?? {}) as Record<string, unknown>
  const storagePath = (result.storagePath ?? result.videoPath) as string | undefined

  let previewUrl: string | null = null
  if (storagePath) {
    try {
      previewUrl = await agentStorageSignedUrl(storagePath, 3600)
    } catch {
      previewUrl = null
    }
  }

  return Response.json({
    id: row.id,
    status: row.status,
    type: row.type,
    summary: row.summary,
    mode: payload.studioMode,
    provider: payload.provider,
    previewUrl,
    storagePath,
    error: result.error ?? row.error ?? null,
  })
}
