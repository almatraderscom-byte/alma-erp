/**
 * Office Live Intercom
 *   GET  /api/assistant/office/intercom → live feed (broadcasts + receipts)
 *   POST /api/assistant/office/intercom → owner sends a broadcast
 *        multipart (kind=voice): audio file + durationSec + targetStaffId?
 *        JSON      (kind=urgent): { kind:'urgent', targetStaffId? }
 *
 * Owner-only send (v1). Staff GET marks their receipts delivered server-side.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import { createIntercomBroadcast, getIntercomFeed } from '@/agent/lib/office-intercom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'
const MAX_AUDIO_BYTES = 15 * 1024 * 1024 // PTT clips are short; 15 MB is generous
const MAX_DURATION_SEC = 180
const SIGNED_TTL = 60 * 60 * 24 * 365 // 1 year, same policy as office image proofs

/** Recorder mimeTypes we accept (Chrome webm/opus, iOS WKWebView mp4/aac). */
const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-m4a']

function extForAudio(mime: string): string {
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a'
  if (/ogg/i.test(mime)) return 'ogg'
  if (/mpeg|mp3/i.test(mime)) return 'mp3'
  if (/wav/i.test(mime)) return 'wav'
  return 'webm'
}

type Identity =
  | { ok: true; role: 'owner'; userId: string; businessId: string }
  | { ok: true; role: 'staff'; staffId: string; businessId: string }
  | { ok: false; error: string; code: number }

async function identify(req: NextRequest): Promise<Identity> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { ok: false, error: 'unauthorized', code: 401 }
  if (isSystemOwner(token)) {
    const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
    return { ok: true, role: 'owner', userId: token.sub, businessId }
  }
  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return { ok: false, error: 'forbidden', code: 403 }
  return { ok: true, role: 'staff', staffId: staff.id, businessId: staff.businessId }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identify(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })

  const feed = await getIntercomFeed(
    id.businessId,
    id.role === 'owner' ? { role: 'owner' } : { role: 'staff', staffId: id.staffId },
  )
  return Response.json(feed)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identify(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })
  if (id.role !== 'owner') return Response.json({ error: 'owner_only' }, { status: 403 })

  const contentType = req.headers.get('content-type') ?? ''

  // ── urgent alert / live-call ring (no audio) ──
  if (contentType.includes('application/json')) {
    let body: { kind?: string; targetStaffId?: string }
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    if (body.kind !== 'urgent' && body.kind !== 'call') {
      return Response.json({ error: 'unsupported_kind' }, { status: 400 })
    }
    // A live call rings ONE person — the Agora channel is itc_<broadcastId>.
    const targetStaffId = body.targetStaffId?.trim() || null
    if (body.kind === 'call' && !targetStaffId) {
      return Response.json({ error: 'call_needs_target' }, { status: 400 })
    }
    const res = await createIntercomBroadcast({
      businessId: id.businessId,
      senderUserId: id.userId,
      kind: body.kind,
      targetStaffId,
    })
    if ('error' in res) return Response.json({ error: res.error }, { status: 422 })
    return Response.json({ ok: true, ...res }, { status: 201 })
  }

  // ── voice broadcast (multipart) ──
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const file = formData.get('audio') as File | null
  if (!file || file.size === 0) return Response.json({ error: 'audio_required' }, { status: 400 })
  if (file.size > MAX_AUDIO_BYTES) return Response.json({ error: 'audio_too_large', maxMb: 15 }, { status: 413 })

  const mime = (file.type || 'audio/webm').split(';')[0].trim().toLowerCase()
  if (!AUDIO_TYPES.includes(mime)) return Response.json({ error: 'unsupported_audio_type', got: mime }, { status: 415 })

  const durationSec = Math.min(MAX_DURATION_SEC, Math.max(1, Number(formData.get('durationSec')) || 1))
  const targetStaffId = String(formData.get('targetStaffId') ?? '').trim() || null

  const ext = extForAudio(mime)
  const objectPath = `office-intercom/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  let audioUrl: string
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    await agentStorageUpload(objectPath, buffer, mime)
    audioUrl = await agentStorageSignedUrl(objectPath, SIGNED_TTL)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown storage error'
    console.error('[office/intercom] storage failed:', detail)
    return Response.json({ error: 'storage_unavailable', detail }, { status: 502 })
  }

  const res = await createIntercomBroadcast({
    businessId: id.businessId,
    senderUserId: id.userId,
    kind: 'voice',
    audioPath: objectPath,
    audioUrl,
    mediaType: mime,
    durationSec,
    targetStaffId,
  })
  if ('error' in res) return Response.json({ error: res.error }, { status: 422 })
  return Response.json({ ok: true, ...res }, { status: 201 })
}
