/**
 * POST /api/assistant/office/intercom/transcribe   { id }
 *
 * Fills the agent transcript on a voice broadcast (Bangla STT). Called by the
 * owner's client right after a send (fire-and-forget); idempotent — if a
 * transcript already exists it is returned as-is, so retries are free.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import OpenAI, { toFile } from 'openai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageDownload } from '@/agent/lib/storage'
import { transcribeVoiceBangla } from '@/agent/lib/voice-bangla'
import { calcWhisperCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { getIntercomBroadcast, setIntercomTranscript } from '@/agent/lib/office-intercom'

export const runtime = 'nodejs'
export const maxDuration = 60

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

const globalForOpenAI = globalThis as unknown as { openaiIntercomStt: OpenAI | undefined }
function getClient(): OpenAI {
  if (!globalForOpenAI.openaiIntercomStt) {
    globalForOpenAI.openaiIntercomStt = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })
  }
  return globalForOpenAI.openaiIntercomStt
}

function fileNameFor(mediaType: string | null): string {
  const mt = mediaType ?? 'audio/webm'
  if (/mp4|m4a|aac/i.test(mt)) return 'intercom.m4a'
  if (/ogg/i.test(mt)) return 'intercom.ogg'
  if (/mpeg|mp3/i.test(mt)) return 'intercom.mp3'
  if (/wav/i.test(mt)) return 'intercom.wav'
  return 'intercom.webm'
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'owner_only' }, { status: 403 })

  if (!process.env.OPENAI_API_KEY) return Response.json({ error: 'stt_unconfigured' }, { status: 503 })

  let body: { id?: string; businessId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const id = body.id?.trim()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })
  const businessId = body.businessId?.trim() || DEFAULT_BUSINESS

  const bc = await getIntercomBroadcast(id, businessId)
  if (!bc) return Response.json({ error: 'not_found' }, { status: 404 })
  if (bc.transcript) return Response.json({ ok: true, transcript: bc.transcript })
  if (bc.kind !== 'voice' || !bc.audioPath) return Response.json({ error: 'no_audio' }, { status: 422 })

  try {
    const buffer = await agentStorageDownload(bc.audioPath)
    const file = await toFile(buffer, fileNameFor(bc.mediaType), { type: bc.mediaType ?? 'audio/webm' })
    const result = await transcribeVoiceBangla(getClient(), file)

    const stored = await setIntercomTranscript({ broadcastId: id, businessId, text: result.text })

    const durationSec = Math.max(1, bc.durationSec)
    void logCost({
      provider: 'openai',
      kind: 'transcribe',
      units: { duration_seconds: durationSec, bytes: buffer.length, model: result.model },
      costUsd: calcWhisperCostUsd(durationSec),
      dedupKey: `whisper:intercom:${id}`,
    })

    return Response.json({ ok: true, transcript: stored ?? result.text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[office/intercom/transcribe] failed:', msg)
    return Response.json({ error: 'transcribe_failed', detail: msg }, { status: 500 })
  }
}
