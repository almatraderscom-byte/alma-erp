// Phase V2: reel cover picker — the owner taps one of the worker's candidate
// frames and it becomes the reel's thumbnail (FB/IG reels need a cover frame).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { pendingActionId?: string; coverPath?: string }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const id = String(body.pendingActionId ?? '').trim()
  const coverPath = String(body.coverPath ?? '').trim()
  if (!id || !coverPath) return Response.json({ error: 'invalid_input' }, { status: 422 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id } })
  if (!row || row.type !== 'video_edit') return Response.json({ error: 'not_found' }, { status: 404 })

  const result = (row.result ?? {}) as Record<string, unknown>
  const candidates = Array.isArray(result.coverCandidates) ? (result.coverCandidates as string[]) : []
  if (!candidates.includes(coverPath)) {
    return Response.json({ error: 'invalid_cover' }, { status: 422 })
  }

  await db.agentPendingAction.update({
    where: { id },
    data: { result: { ...result, thumbPath: coverPath, coverPickedAt: new Date().toISOString() } },
  })

  const thumbUrl = await agentStorageSignedUrl(coverPath, 3600).catch(() => null)
  return Response.json({ ok: true, thumbPath: coverPath, thumbUrl })
}
