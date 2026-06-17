// Internal transcription endpoint — used by the VPS worker to transcribe Telegram voice notes.
// Authenticated with AGENT_INTERNAL_TOKEN; accepts multipart/form-data with an "audio" file.
import { type NextRequest } from 'next/server'
import { calcWhisperCostUsd, estimateAudioDurationSeconds } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { transcribeVoiceBangla } from '@/agent/lib/voice-bangla'
import OpenAI from 'openai'

export const runtime = 'nodejs'
export const maxDuration = 60

const globalForOpenAI = globalThis as unknown as { openaiInternalWhisper: OpenAI | undefined }
function getClient(): OpenAI {
  if (!globalForOpenAI.openaiInternalWhisper) {
    globalForOpenAI.openaiInternalWhisper = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })
  }
  return globalForOpenAI.openaiInternalWhisper
}

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

function blobToAudioFile(blob: Blob, fallbackType = 'audio/ogg'): File {
  return new File([blob], 'voice.ogg', { type: blob.type || fallbackType })
}

async function parseAudioFile(req: NextRequest): Promise<File | null> {
  const contentType = req.headers.get('content-type') ?? ''

  // Preferred for VPS worker / Telegram bridge (raw OGG bytes).
  if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
    const buf = await req.arrayBuffer()
    if (buf.byteLength === 0) return null
    const mime = contentType.split(';')[0].trim() || 'audio/ogg'
    return new File([buf], 'voice.ogg', { type: mime })
  }

  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await req.formData()
      const audio = formData.get('audio')
      if (audio instanceof File) return audio
      if (audio && typeof audio !== 'string') return blobToAudioFile(audio as Blob)

      // curl -F or some clients use a different field name — take first file-like part.
      for (const [, value] of formData.entries()) {
        if (value instanceof File) return value
        if (value && typeof value !== 'string') return blobToAudioFile(value as Blob)
      }
    } catch (err) {
      console.warn('[internal/transcribe] multipart parse failed:', err)
    }
  }

  return null
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

  try {
    const audioFile = await parseAudioFile(req)
    if (!audioFile) return Response.json({ error: 'audio file missing' }, { status: 400 })
    if (audioFile.size > 25 * 1024 * 1024) {
      return Response.json({ error: 'audio too large (max 25 MB)' }, { status: 400 })
    }

    const client = getClient()
    const transcription = await transcribeVoiceBangla(client, audioFile)

    const durationSec = estimateAudioDurationSeconds(audioFile.size)
    const costUsd = calcWhisperCostUsd(durationSec)
    void logCost({
      provider: 'openai',
      kind: 'transcribe',
      units: { duration_seconds: durationSec, bytes: audioFile.size, model: 'whisper-1' },
      costUsd,
      dedupKey: `whisper:${audioFile.size}:${transcription.text.slice(0, 20)}`,
    })

    return Response.json({ text: transcription.text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `transcription failed: ${msg}` }, { status: 500 })
  }
}
