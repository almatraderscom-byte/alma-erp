/**
 * Phase V2 — owner-approved music-bed library (kv registry, no new tables).
 * Shared by the music routes and the video run route (round-robin pick).
 */
import { prisma } from '@/lib/prisma'
import type { MusicVibe } from '@/lib/creative-studio/video-recipes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const MUSIC_KV_PREFIX = 'studio_music_track:'
const RR_KEY = 'studio_music_rr'

export type StudioMusicTrack = {
  id: string
  path: string
  name: string
  vibe: MusicVibe
  sizeBytes: number
  uploadedAt: string
}

export async function listMusicTracks(): Promise<StudioMusicTrack[]> {
  const rows = await db.agentKvSetting.findMany({ where: { key: { startsWith: MUSIC_KV_PREFIX } } })
  const tracks: StudioMusicTrack[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as Omit<StudioMusicTrack, 'id'>
      if (parsed.path) tracks.push({ id: row.key.slice(MUSIC_KV_PREFIX.length), ...parsed })
    } catch { /* skip malformed */ }
  }
  tracks.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
  return tracks
}

/**
 * Deterministic variety (the roadmap's round-robin rule): a kv counter walks
 * the track list sorted by id, so consecutive runs get different beds and the
 * same counter state always yields the same pick. No taste, no LLM.
 */
export async function pickMusicTrackAuto(): Promise<StudioMusicTrack | null> {
  const tracks = (await listMusicTracks()).sort((a, b) => (a.id < b.id ? -1 : 1))
  if (tracks.length === 0) return null

  const row = await db.agentKvSetting.findUnique({ where: { key: RR_KEY } })
  const counter = Number(row?.value ?? 0) || 0
  const pick = tracks[counter % tracks.length]

  await db.agentKvSetting.upsert({
    where: { key: RR_KEY },
    update: { value: String(counter + 1) },
    create: { key: RR_KEY, value: '1' },
  })
  return pick
}

export async function getMusicTrack(id: string): Promise<StudioMusicTrack | null> {
  const row = await db.agentKvSetting.findUnique({ where: { key: `${MUSIC_KV_PREFIX}${id}` } })
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Omit<StudioMusicTrack, 'id'>
    return parsed.path ? { id, ...parsed } : null
  } catch {
    return null
  }
}
