// Phase V1: the owner's uploaded shoot library.
// GET    → list registered uploads (newest first)
// POST   → register a finished signed direct upload (verifies the object landed)
// DELETE → remove an upload (storage object + registry entry)
//
// Registry lives in agent_kv_settings (`studio_video_upload:<id>`) — the same
// no-new-tables pattern as the child-garment cache.
import { type NextRequest } from 'next/server'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageObjectInfo, agentStorageDelete, agentStorageSignedUrls } from '@/agent/lib/storage'
import { createHash } from 'crypto'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  assertStudioResourceScope,
  deleteStudioResourceScope,
  filterStudioResourcesToScope,
  requireStudioResourceContext,
  writeStudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'

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
  /** CS11 — content fingerprint (size + head sample) for duplicate detection */
  contentHash?: string
}

/**
 * CS11 — cheap content fingerprint WITHOUT downloading a 500MB file: sha256 of
 * (size + first 256KB). Re-uploading the same shoot yields the same hash, so
 * a duplicate registration returns the EXISTING record instead of a second one.
 */
async function computeContentHash(path: string, sizeBytes: number): Promise<string | null> {
  try {
    const signed = await agentStorageSignedUrls([path], 300)
    const url = signed[path]
    if (!url) return null
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-262143' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok && res.status !== 206) return null
    const head = Buffer.from(await res.arrayBuffer())
    return createHash('sha256').update(String(sizeBytes)).update(head).digest('hex').slice(0, 32)
  } catch {
    return null // fingerprinting is best-effort — registration never blocks on it
  }
}

async function ownerActor(req: NextRequest): Promise<StudioActor | Response> {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return actor
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
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  const projectId = req.nextUrl.searchParams.get('projectId')
  if (brandProfileId || projectId) {
    try {
      const context = await requireStudioResourceContext(actor, {
        brandProfileId,
        projectId,
      })
      return Response.json({
        uploads: await filterStudioResourcesToScope('video', await listUploads(), {
          ownerId: context.access.ownerId,
          brandProfileId: context.brandProfileId,
          projectId: context.projectId,
        }),
      })
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-video-list')
    }
  }
  if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return Response.json({ uploads: await listUploads() })
}

export async function POST(req: NextRequest) {
  const actor = await ownerActor(req)
  if (actor instanceof Response) return actor

  let body: {
    uploadId?: string
    path?: string
    name?: string
    sizeBytes?: number
    brandProfileId?: string
    projectId?: string
  }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  let resourceContext: Awaited<ReturnType<typeof requireStudioResourceContext>> | null = null
  if (body.brandProfileId || body.projectId) {
    try {
      resourceContext = await requireStudioResourceContext(actor, body)
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-video-register')
    }
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

  const sizeBytes = info.size > 0 ? info.size : Math.max(0, Number(body.sizeBytes ?? 0))

  // CS11 — duplicate-upload gate: same content fingerprint ⇒ ONE logical
  // source record. The new storage object is removed; the existing record
  // comes back so recipes/scene caches keep working on one path.
  const contentHash = await computeContentHash(path, sizeBytes)
  if (contentHash) {
    const existing = (await listUploads()).find((u) => u.contentHash === contentHash)
    if (existing && existing.path !== path) {
      await agentStorageDelete([path]).catch(() => { /* best-effort cleanup */ })
      if (resourceContext) {
        try {
          await assertStudioResourceScope('video', existing.id, {
            ownerId: resourceContext.access.ownerId,
            brandProfileId: resourceContext.brandProfileId,
            projectId: resourceContext.projectId,
          })
        } catch {
          return Response.json({ error: 'duplicate_exists_outside_scope' }, { status: 409 })
        }
      }
      return Response.json({
        ok: true,
        duplicate: true,
        upload: existing,
        message: 'এই ভিডিওটা আগেই লাইব্রেরিতে আছে — সেটাই ব্যবহার হবে (ডুপ্লিকেট বাদ)।',
      })
    }
  }

  const upload: Omit<StudioVideoUpload, 'id'> = {
    path,
    name: String(body.name ?? 'shoot').slice(0, 120),
    // some storage-api versions omit content-length on HEAD — trust the client's number then
    sizeBytes,
    uploadedAt: new Date().toISOString(),
    contentHash: contentHash ?? undefined,
  }
  await db.agentKvSetting.upsert({
    where: { key: `${KV_PREFIX}${uploadId}` },
    update: { value: JSON.stringify(upload) },
    create: { key: `${KV_PREFIX}${uploadId}`, value: JSON.stringify(upload) },
  })
  if (resourceContext) {
    await writeStudioResourceScope('video', uploadId, {
      ownerId: resourceContext.access.ownerId,
      brandProfileId: resourceContext.brandProfileId,
      projectId: resourceContext.projectId,
      createdById: actor.userId,
    })
  }
  return Response.json({ ok: true, upload: { id: uploadId, ...upload } })
}

export async function DELETE(req: NextRequest) {
  const actor = await ownerActor(req)
  if (actor instanceof Response) return actor

  const id = req.nextUrl.searchParams.get('id')?.trim()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  const projectId = req.nextUrl.searchParams.get('projectId')
  if (brandProfileId || projectId) {
    try {
      const context = await requireStudioResourceContext(actor, {
        brandProfileId,
        projectId,
      })
      await assertStudioResourceScope('video', id, {
        ownerId: context.access.ownerId,
        brandProfileId: context.brandProfileId,
        projectId: context.projectId,
      })
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-video-delete')
    }
  }

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
  await deleteStudioResourceScope('video', id)
  return Response.json({ ok: true })
}
