import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import OpenAI from 'openai'

export const runtime = 'nodejs'
export const maxDuration = 60

const globalForOpenAI = globalThis as unknown as { openaiWhisper: OpenAI | undefined }
function getClient(): OpenAI {
  if (!globalForOpenAI.openaiWhisper) {
    globalForOpenAI.openaiWhisper = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })
  }
  return globalForOpenAI.openaiWhisper
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'OPENAI_API_KEY সেট করা নেই। Vercel-এ OPENAI_API_KEY যোগ করুন।' }, { status: 503 })
  }

  try {
    const formData = await req.formData()
    const audioFile = formData.get('audio') as File | null
    if (!audioFile) {
      return Response.json({ error: 'অডিও ফাইল পাওয়া যায়নি।' }, { status: 400 })
    }

    // Max 2 minutes ≈ ~2.4 MB at 160 kbps — we cap at 25 MB (Whisper limit)
    if (audioFile.size > 25 * 1024 * 1024) {
      return Response.json({ error: 'অডিও ফাইল খুব বড় (সর্বোচ্চ ২৫ MB)।' }, { status: 400 })
    }

    const client = getClient()
    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'bn', // Bangla hint; Whisper auto-detects Banglish naturally
      response_format: 'json',
    })

    return Response.json({ text: transcription.text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: `ট্রান্সক্রিপশন ব্যর্থ হয়েছে: ${msg}` },
      { status: 500 },
    )
  }
}
