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
  audioProviderLabel,
  MUSIC_STYLES,
  WISH_OCCASIONS,
  type AudioLabKind,
} from '@/lib/creative-studio/audio-lab'
import {
  checkStudioCostConfirmation,
  normalizeStudioRunCap,
} from '@/lib/creative-studio/studio-policy'
import {
  isWithinPaidPreviewCeiling,
  OWNER_STUDIO_USAGE_CONTEXT,
  ownerVoicePolicyBlockReason,
} from '@/lib/creative-studio/voice-policy'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function ownerId(req: NextRequest): Promise<string | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return token.sub
}

export async function GET(req: NextRequest) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  const row = await db.agentKvSetting.findUnique({ where: { key: 'studio_owner_voice_id' } }).catch(() => null)
  const voice = await db.creativeVoice.findFirst({
    where: { ownerId: owner, ownerOnly: true, activeVersionId: { not: null } },
    select: {
      activeVersionId: true,
      activeVersion: { select: { id: true, version: true, status: true } },
    },
  }).catch(() => null)
  return Response.json({
    voiceCloned: Boolean(voice?.activeVersion?.status === 'active' || row?.value),
    activeVoiceVersionId: voice?.activeVersion?.status === 'active' ? voice.activeVersion.id : null,
    activeVoiceVersion: voice?.activeVersion?.status === 'active' ? voice.activeVersion.version : null,
    legacyVoiceAvailable: Boolean(row?.value),
    styles: MUSIC_STYLES.map(({ id, labelBn }) => ({ id, labelBn })),
    occasions: WISH_OCCASIONS,
    maxCostBdt: normalizeStudioRunCap(process.env.CREATIVE_STUDIO_MAX_RUN_COST_BDT),
  })
}

export async function POST(req: NextRequest) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner

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
    voiceVersionId?: string
    usageContext?: string
    targetLanguage?: string
    intent?: 'estimate' | 'queue'
    confirmedCostBdt?: number
    costCapBdt?: number
  }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const kind = body.kind as AudioLabKind
  const seconds = Math.min(kind === 'dub' || kind === 'voice_change' ? 600 : 120, Math.max(5, Number(body.seconds ?? 30)))
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
  let lifecycleVersion: {
    id: string
    status: string
    voiceId: string
    voice: { ownerId: string; ownerOnly: boolean; activeVersionId: string | null }
  } | null = null

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
    return Response.json({
      error: 'voice_clone_use_lifecycle_route',
      message: 'Consent ও immutable version history-সহ নতুন Voice Library থেকে clone করুন।',
    }, { status: 409 })
  } else if (kind === 'dub') {
    const src = String(body.sourcePath ?? '')
    if (!src.startsWith('studio-video/audio/') || src.includes('..')) {
      return Response.json({ error: 'আগে dubbing audio আপলোড করুন।' }, { status: 422 })
    }
    const targetLanguage = String(body.targetLanguage ?? 'bn').toLowerCase()
    if (!['bn', 'en', 'hi', 'ar'].includes(targetLanguage)) {
      return Response.json({ error: 'unsupported_target_language' }, { status: 422 })
    }
    payload.sourcePath = src
    payload.targetLanguage = targetLanguage
    payload.disableVoiceCloning = true
    summary = `🌐 Dubbing → ${targetLanguage.toUpperCase()} (${seconds}s) · ${audioProviderLabel(kind)}`
  } else if (kind === 'voice_change') {
    const src = String(body.sourcePath ?? '')
    if (!src.startsWith('studio-video/audio/') || src.includes('..')) {
      return Response.json({ error: 'আগে voice-change audio আপলোড করুন।' }, { status: 422 })
    }
    payload.sourcePath = src
    summary = `🎭 Owner voice change (${seconds}s) · ${audioProviderLabel(kind)}`
  } else {
    return Response.json({ error: 'invalid_kind' }, { status: 422 })
  }

  if (kind === 'owner_voice' || kind === 'voice_change') {
    if (body.usageContext !== OWNER_STUDIO_USAGE_CONTEXT) {
      return Response.json({ error: 'owner_voice_context_forbidden' }, { status: 403 })
    }
    lifecycleVersion = await db.creativeVoiceVersion.findFirst({
      where: body.voiceVersionId
        ? { id: body.voiceVersionId, voice: { ownerId: owner, ownerOnly: true } }
        : { voice: { ownerId: owner, ownerOnly: true, activeVersionId: { not: null } }, status: 'active' },
      include: { voice: true },
    }).catch(() => null)
    if (lifecycleVersion) {
      const blocked = ownerVoicePolicyBlockReason({
        authenticatedOwnerId: owner,
        voiceOwnerId: lifecycleVersion.voice.ownerId,
        ownerOnly: lifecycleVersion.voice.ownerOnly,
        usageContext: body.usageContext,
        autonomous: false,
        customerFacing: false,
        status: lifecycleVersion.status,
        activeVersionId: lifecycleVersion.voice.activeVersionId,
        requestedVersionId: lifecycleVersion.id,
      })
      if (blocked) return Response.json({ error: 'owner_voice_forbidden', reason: blocked }, { status: 403 })
      payload.ownerVoice = true
      payload.ownerId = owner
      payload.usageContext = OWNER_STUDIO_USAGE_CONTEXT
      payload.voiceId = lifecycleVersion.voiceId
      payload.voiceVersionId = lifecycleVersion.id
    } else if (kind === 'owner_voice') {
      const legacy = await db.agentKvSetting.findUnique({ where: { key: 'studio_owner_voice_id' } }).catch(() => null)
      if (!legacy?.value) return Response.json({ error: 'owner_voice_not_active' }, { status: 409 })
      payload.ownerVoice = true
      payload.ownerId = owner
      payload.usageContext = OWNER_STUDIO_USAGE_CONTEXT
      payload.legacyOwnerVoice = true
    } else {
      return Response.json({ error: 'active_lifecycle_voice_required' }, { status: 409 })
    }
  }

  const costBdt = audioCostBdt(kind, seconds)
  if ((kind === 'dub' || kind === 'voice_change') && !isWithinPaidPreviewCeiling(costBdt)) {
    return Response.json({
      error: 'paid_preview_ceiling_exceeded',
      message: 'এই preview-এর আনুমানিক provider খরচ $1-এর বেশি। অডিও ছোট করুন।',
      costBdt,
      ceilingUsd: 1,
    }, { status: 409 })
  }
  const defaultCapBdt = normalizeStudioRunCap(process.env.CREATIVE_STUDIO_MAX_RUN_COST_BDT)
  const costGate = checkStudioCostConfirmation({
    estimateBdt: costBdt,
    confirmedCostBdt: body.intent === 'queue' ? body.confirmedCostBdt : undefined,
    capBdt: body.costCapBdt ?? defaultCapBdt,
  })

  if (body.intent !== 'queue' || (!costGate.ok && costGate.reason === 'confirmation_required')) {
    return Response.json({
      ok: true,
      requiresConfirmation: true,
      summary,
      provider: audioProviderLabel(kind),
      costBdt,
      maxCostBdt: costGate.capBdt,
      ceilingUsd: kind === 'dub' || kind === 'voice_change' ? 1 : undefined,
    })
  }
  if (!costGate.ok) {
    const capExceeded = costGate.reason === 'cap_exceeded'
    return Response.json({
      error: capExceeded ? 'cost_cap_exceeded' : 'cost_estimate_changed',
      message: capExceeded
        ? `এই কাজের আনুমানিক খরচ ৳${costGate.estimateBdt}, কিন্তু আপনার সীমা ৳${costGate.capBdt}।`
        : `খরচ এখন ৳${costGate.estimateBdt}। নতুন হিসাব দেখে আবার নিশ্চিত করুন।`,
      costBdt: costGate.estimateBdt,
      maxCostBdt: costGate.capBdt,
    }, { status: 409 })
  }

  const costUsd = costBdt / 125
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
  return Response.json({ ok: true, pendingActionId: row.id, costBdt, maxCostBdt: costGate.capBdt })
}
