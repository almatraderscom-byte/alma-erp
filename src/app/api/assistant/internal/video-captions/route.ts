// Phase V2: the VPS worker posts the RENDERED reel's audio here and gets back
// ready-to-burn ASS captions. Two Whisper passes married mechanically:
//   gpt-4o-transcribe → accurate Bangla text (no timestamps)
//   whisper-1 verbose_json → timed windows (sloppier text, used only for timing)
// alignCaptions/buildAss are pure + unit-tested (src/lib/creative-studio/captions.ts).
// Authenticated with AGENT_INTERNAL_TOKEN.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import OpenAI from 'openai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { transcribeVoiceBangla, WHISPER_BANGLA_PROMPT } from '@/agent/lib/voice-bangla'
import { alignCaptions, buildAss, type TimedSegment } from '@/lib/creative-studio/captions'
import { calcWhisperCostUsd, estimateAudioDurationSeconds } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'

export const runtime = 'nodejs'
export const maxDuration = 60

const globalForOpenAI = globalThis as unknown as { openaiVideoCaptions: OpenAI | undefined }
function getClient(): OpenAI {
  if (!globalForOpenAI.openaiVideoCaptions) {
    globalForOpenAI.openaiVideoCaptions = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })
  }
  return globalForOpenAI.openaiVideoCaptions
}

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'OPENAI_API_KEY not set' }, { status: 503 })
  }

  const width = Math.max(240, Number(req.nextUrl.searchParams.get('width') ?? 1080))
  const height = Math.max(240, Number(req.nextUrl.searchParams.get('height') ?? 1920))

  const contentType = req.headers.get('content-type') ?? 'audio/mpeg'
  const buf = await req.arrayBuffer()
  if (buf.byteLength === 0) return Response.json({ error: 'audio missing' }, { status: 400 })
  if (buf.byteLength > 25 * 1024 * 1024) {
    return Response.json({ error: 'audio too large (max 25 MB)' }, { status: 400 })
  }
  const file = new File([buf], 'reel.mp3', { type: contentType.split(';')[0].trim() })

  // When the caller already KNOWS the words (owner-typed voiceover), skip the
  // accuracy pass — whisper-1 below is only needed for timing.
  const knownText = req.nextUrl.searchParams.get('text')?.trim() ?? ''

  try {
    const client = getClient()

    // Pass 1 — accurate Bangla text (quality model, no timestamps available).
    const accurate = knownText
      ? { text: knownText, model: 'owner-text' }
      : await transcribeVoiceBangla(client, file)

    if (!accurate.text.trim()) {
      return Response.json({ ok: true, empty: true, text: '', cues: [], ass: null })
    }

    // Pass 2 — timed windows from whisper-1 (the only model that returns
    // segments). NOTE: the API rejects language:'bn' ("Language 'bn' is not
    // supported", live-e2e 2026-07-05) even though the model handles Bangla —
    // try the hint first, fall back to auto-detect steered by the prompt.
    const timedBase = {
      model: 'whisper-1',
      response_format: 'verbose_json',
      prompt: WHISPER_BANGLA_PROMPT,
      temperature: 0,
    } as const
    let timed
    try {
      timed = await client.audio.transcriptions.create({
        ...timedBase,
        file: new File([buf], 'reel.mp3', { type: file.type }),
        language: 'bn',
      })
    } catch {
      timed = await client.audio.transcriptions.create({
        ...timedBase,
        file: new File([buf], 'reel.mp3', { type: file.type }),
      })
    }
    const segments: TimedSegment[] = (timed.segments ?? []).map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? ''),
    }))

    const cues = alignCaptions(accurate.text, segments)
    const ass = cues.length > 0 ? buildAss(cues, { width, height }) : null

    const durationSec = estimateAudioDurationSeconds(buf.byteLength)
    void logCost({
      provider: 'openai',
      kind: 'transcribe',
      units: { duration_seconds: durationSec * 2, purpose: 'video_captions', model: `${accurate.model}+whisper-1` },
      costUsd: calcWhisperCostUsd(durationSec) * 2,
      dedupKey: `captions:${buf.byteLength}:${accurate.text.slice(0, 20)}`,
    })

    return Response.json({ ok: true, text: accurate.text, cues, ass })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[video-captions] failed:', msg)
    return Response.json({ error: `captions failed: ${msg}` }, { status: 500 })
  }
}
