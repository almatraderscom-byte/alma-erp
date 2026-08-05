// Phase V2: owner-approved music-bed library.
// GET    → list tracks · POST → register a finished upload (verifies object)
// DELETE → remove a track. Registry in agent_kv_settings (`studio_music_track:<id>`).
import { type NextRequest } from 'next/server'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageObjectInfo, agentStorageDelete } from '@/agent/lib/storage'
import { MUSIC_VIBES, type MusicVibe } from '@/lib/creative-studio/video-recipes'
import { listMusicTracks, MUSIC_KV_PREFIX, type StudioMusicTrack } from '@/lib/creative-studio/music-library'
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

const KV_PREFIX = MUSIC_KV_PREFIX

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function ownerActor(req: NextRequest): Promise<StudioActor | Response> {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return actor
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
        tracks: await filterStudioResourcesToScope('music', await listMusicTracks(), {
          ownerId: context.access.ownerId,
          brandProfileId: context.brandProfileId,
          projectId: context.projectId,
        }),
        vibes: MUSIC_VIBES,
      })
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-music-list')
    }
  }
  if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return Response.json({ tracks: await listMusicTracks(), vibes: MUSIC_VIBES })
}

export async function POST(req: NextRequest) {
  const actor = await ownerActor(req)
  if (actor instanceof Response) return actor

  let body: {
    uploadId?: string
    path?: string
    name?: string
    vibe?: string
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
      return studioAccessErrorResponse(error, 'creative-music-register')
    }
  }
  const uploadId = String(body.uploadId ?? '').trim()
  const path = String(body.path ?? '').trim()
  if (!uploadId || !path.startsWith('studio-video/music/') || path.includes('..')) {
    return Response.json({ error: 'invalid_upload' }, { status: 422 })
  }
  const vibe = MUSIC_VIBES.some((v) => v.id === body.vibe) ? (body.vibe as MusicVibe) : 'celebration'

  const info = await agentStorageObjectInfo(path).catch(() => null)
  if (!info) {
    return Response.json({ error: 'ট্র্যাকটি আপলোড শেষ হয়নি — আবার চেষ্টা করুন।' }, { status: 422 })
  }

  const track: Omit<StudioMusicTrack, 'id'> = {
    path,
    name: String(body.name ?? 'track').slice(0, 120),
    vibe,
    sizeBytes: info.size > 0 ? info.size : Math.max(0, Number(body.sizeBytes ?? 0)),
    uploadedAt: new Date().toISOString(),
  }
  await db.agentKvSetting.upsert({
    where: { key: `${KV_PREFIX}${uploadId}` },
    update: { value: JSON.stringify(track) },
    create: { key: `${KV_PREFIX}${uploadId}`, value: JSON.stringify(track) },
  })
  if (resourceContext) {
    await writeStudioResourceScope('music', uploadId, {
      ownerId: resourceContext.access.ownerId,
      brandProfileId: resourceContext.brandProfileId,
      projectId: resourceContext.projectId,
      createdById: actor.userId,
    })
  }
  return Response.json({ ok: true, track: { id: uploadId, ...track } })
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
      await assertStudioResourceScope('music', id, {
        ownerId: context.access.ownerId,
        brandProfileId: context.brandProfileId,
        projectId: context.projectId,
      })
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-music-delete')
    }
  }

  const row = await db.agentKvSetting.findUnique({ where: { key: `${KV_PREFIX}${id}` } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  try {
    const parsed = JSON.parse(row.value) as { path?: string }
    if (parsed.path) {
      await agentStorageDelete([parsed.path]).catch((err) =>
        console.warn('[studio-music] storage delete failed:', err?.message),
      )
    }
  } catch { /* registry entry still removed */ }

  await db.agentKvSetting.delete({ where: { key: `${KV_PREFIX}${id}` } })
  await deleteStudioResourceScope('music', id)
  return Response.json({ ok: true })
}
