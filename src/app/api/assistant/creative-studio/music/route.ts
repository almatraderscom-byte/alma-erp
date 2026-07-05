// Phase V2: owner-approved music-bed library.
// GET    → list tracks · POST → register a finished upload (verifies object)
// DELETE → remove a track. Registry in agent_kv_settings (`studio_music_track:<id>`).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageObjectInfo, agentStorageDelete } from '@/agent/lib/storage'
import { MUSIC_VIBES, type MusicVibe } from '@/lib/creative-studio/video-recipes'
import { listMusicTracks, MUSIC_KV_PREFIX, type StudioMusicTrack } from '@/lib/creative-studio/music-library'

export const runtime = 'nodejs'

const KV_PREFIX = MUSIC_KV_PREFIX

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  return Response.json({ tracks: await listMusicTracks(), vibes: MUSIC_VIBES })
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: { uploadId?: string; path?: string; name?: string; vibe?: string; sizeBytes?: number }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
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
  return Response.json({ ok: true, track: { id: uploadId, ...track } })
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
        console.warn('[studio-music] storage delete failed:', err?.message),
      )
    }
  } catch { /* registry entry still removed */ }

  await db.agentKvSetting.delete({ where: { key: `${KV_PREFIX}${id}` } })
  return Response.json({ ok: true })
}
