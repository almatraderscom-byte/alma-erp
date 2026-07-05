// Phase V1: the owner's uploaded shoot library.
// GET    → list registered uploads (newest first)
// POST   → register a finished signed direct upload (verifies the object landed)
// DELETE → remove an upload (storage object + registry entry)
//
// Registry lives in agent_kv_settings (`studio_video_upload:<id>`) — the same
// no-new-tables pattern as the child-garment cache.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageObjectInfo, agentStorageDelete } from '@/agent/lib/storage'

export const runtime = 'nodejs'

const KV_PREFIX = 'studio_video_upload:'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type StudioVideoUpload = {
  id: string
  path: string
  name: string
  sizeBytes: number
  uploadedAt: string
}

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

async function listUploads(): Promise<StudioVideoUpload[]> {
  const rows = await db.agentKvSetting.findMany({
    where: { key: { startsWith: KV_PREFIX } },
  })
  const uploads: StudioVideoUpload[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as Omit<StudioVideoUpload, 'id'>
      if (parsed.path) uploads.push({ id: row.key.slice(KV_PREFIX.length), ...parsed })
    } catch { /* skip malformed entry */ }
  }
  uploads.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
  return uploads
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  return Response.json({ uploads: await listUploads() })
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: { uploadId?: string; path?: string; name?: string; sizeBytes?: number }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const uploadId = String(body.uploadId ?? '').trim()
  const path = String(body.path ?? '').trim()
  if (!uploadId || !path.startsWith('studio-video/uploads/') || path.includes('..')) {
    return Response.json({ error: 'invalid_upload' }, { status: 422 })
  }

  // Verify the direct upload actually landed before it enters the library.
  const info = await agentStorageObjectInfo(path).catch(() => null)
  if (!info) {
    return Response.json({ error: 'ভিডিওটি আপলোড শেষ হয়নি — আবার চেষ্টা করুন।' }, { status: 422 })
  }

  const upload: Omit<StudioVideoUpload, 'id'> = {
    path,
    name: String(body.name ?? 'shoot').slice(0, 120),
    // some storage-api versions omit content-length on HEAD — trust the client's number then
    sizeBytes: info.size > 0 ? info.size : Math.max(0, Number(body.sizeBytes ?? 0)),
    uploadedAt: new Date().toISOString(),
  }
  await db.agentKvSetting.upsert({
    where: { key: `${KV_PREFIX}${uploadId}` },
    update: { value: JSON.stringify(upload) },
    create: { key: `${KV_PREFIX}${uploadId}`, value: JSON.stringify(upload) },
  })
  return Response.json({ ok: true, upload: { id: uploadId, ...upload } })
}

export async function DELETE(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  const id = req.nextUrl.searchParams.get('id')?.trim()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })

  const row = await db.agentKvSetting.findUnique({ where: { key: `${KV_PREFIX}${id}` } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  try {
    const parsed = JSON.parse(row.value) as { path?: string }
    if (parsed.path) {
      await agentStorageDelete([parsed.path]).catch((err) =>
        console.warn('[studio-video] storage delete failed:', err?.message),
      )
      // The worker caches scdet timestamps per source path — drop that too.
      await db.agentKvSetting.deleteMany({ where: { key: `studio_video_scenes:${parsed.path}` } })
    }
  } catch { /* registry entry still removed below */ }

  await db.agentKvSetting.delete({ where: { key: `${KV_PREFIX}${id}` } })
  return Response.json({ ok: true })
}
