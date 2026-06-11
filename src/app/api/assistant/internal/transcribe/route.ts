// Internal transcription endpoint — used by the VPS worker to transcribe Telegram voice notes.
// Authenticated with AGENT_INTERNAL_TOKEN; accepts multipart/form-data with an "audio" file.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
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
    const formData = await req.formData()
    const audioFile = formData.get('audio') as File | null
    if (!audioFile) return Response.json({ error: 'audio file missing' }, { status: 400 })
    if (audioFile.size > 25 * 1024 * 1024) {
      return Response.json({ error: 'audio too large (max 25 MB)' }, { status: 400 })
    }

    const client = getClient()
    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'bn',
      response_format: 'json',
    })

    return Response.json({ text: transcription.text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `transcription failed: ${msg}` }, { status: 500 })
  }
}
