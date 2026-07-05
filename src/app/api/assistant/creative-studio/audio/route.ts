// E1: Audio Lab — owner-only. GET = status (voice cloned?); POST = queue an
// audio_gen job. Prompts/lyrics come from the pure builders; the owner's
// cloned voice is reachable ONLY through this owner-auth route (guardrail).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  buildMusicPrompt,
  buildWishSong,
  audioCostBdt,
  MUSIC_STYLES,
  WISH_OCCASIONS,
  type AudioLabKind,
} from '@/lib/creative-studio/audio-lab'

export const runtime = 'nodejs'

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
  const row = await db.agentKvSetting.findUnique({ where: { key: 'studio_owner_voice_id' } }).catch(() => null)
  return Response.json({
    voiceCloned: Boolean(row?.value),
    styles: MUSIC_STYLES.map(({ id, labelBn }) => ({ id, labelBn })),
    occasions: WISH_OCCASIONS,
  })
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: {
    kind?: AudioLabKind
    styleId?: string
    line?: string
    seconds?: number
    occasionId?: string
    name?: string
    text?: string
    sourcePath?: string
    samplePaths?: string[]
  }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const kind = body.kind as AudioLabKind
  const seconds = Math.min(120, Math.max(5, Number(body.seconds ?? 30)))
  const payload: Record<string, unknown> = {
    audioLab: true,
    creativeStudio: true,
    skipTelegramCard: true,
    studioMode: 'audio_lab',
    provider: 'elevenlabs',
    kind,
    seconds,
  }
  let summary = ''

  if (kind === 'music') {
    payload.prompt = buildMusicPrompt(String(body.styleId ?? ''), body.line)
    summary = `🎵 মিউজিক (${MUSIC_STYLES.find((s) => s.id === body.styleId)?.labelBn ?? 'উৎসব'}) ${seconds}s`
  } else if (kind === 'wish_song') {
    const built = buildWishSong(String(body.occasionId ?? ''), String(body.name ?? ''))
    payload.prompt = built.prompt
    payload.lyrics = built.lyrics
    summary = `🎁 উইশ গান — ${WISH_OCCASIONS.find((o) => o.id === body.occasionId)?.labelBn ?? ''} (${String(body.name ?? '').slice(0, 30)})`
  } else if (kind === 'owner_voice') {
    const text = String(body.text ?? '').trim().slice(0, 600)
    if (!text) return Response.json({ error: 'লাইনটা লিখুন।' }, { status: 422 })
    payload.text = text
    summary = `🎙️ আমার ভয়েসে — "${text.slice(0, 40)}…"`
  } else if (kind === 'clean_voice') {
    const src = String(body.sourcePath ?? '')
    if (!src.startsWith('studio-video/audio/')) return Response.json({ error: 'আগে ভয়েস নোট আপলোড করুন।' }, { status: 422 })
    payload.sourcePath = src
    summary = '🎧 স্টুডিও কোয়ালিটি ভয়েস ক্লিনআপ'
  } else if (kind === 'sfx') {
    const text = String(body.text ?? '').trim().slice(0, 200)
    if (!text) return Response.json({ error: 'কেমন সাউন্ড চান লিখুন।' }, { status: 422 })
    payload.text = text
    payload.seconds = Math.min(10, seconds)
    summary = `🔊 SFX — ${text.slice(0, 30)}`
  } else if (kind === 'voice_clone') {
    const paths = (body.samplePaths ?? []).filter((p) => typeof p === 'string' && p.startsWith('studio-video/audio/'))
    if (paths.length === 0) return Response.json({ error: 'আগে ১-৩টা ভয়েস স্যাম্পল আপলোড করুন।' }, { status: 422 })
    payload.samplePaths = paths.slice(0, 5)
    summary = '🧬 আপনার ভয়েস ক্লোন (এক-বার)'
  } else {
    return Response.json({ error: 'invalid_kind' }, { status: 422 })
  }

  const costUsd = audioCostBdt(kind, seconds) / 125
  payload.costUsd = costUsd

  const row = await db.agentPendingAction.create({
    data: {
      conversationId: null,
      type: 'audio_gen',
      payload,
      summary,
      costEstimate: costUsd,
      status: 'approved',
    },
  })
  return Response.json({ ok: true, pendingActionId: row.id, costBdt: audioCostBdt(kind, seconds) })
}
