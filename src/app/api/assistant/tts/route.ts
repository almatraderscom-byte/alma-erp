import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { googleTtsConfigured, synthesizeBanglaMp3 } from '@/agent/lib/google-tts'
import { getToken } from 'next-auth/jwt'

export const runtime = 'nodejs'
export const maxDuration = 30

/** Strip markdown before synthesis (asterisks, backticks, headings, etc.). */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')         // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1')      // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline + block code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^[-*+]\s+/gm, '')        // bullet points
    .replace(/^\d+\.\s+/gm, '')        // numbered lists
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  // Any authenticated user — the staff navigator speaks the assistant's reply via
  // Google TTS (text→audio only, no ERP data exposed). The owner agent also uses this.
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  if (!googleTtsConfigured()) {
    return Response.json(
      { error: 'GOOGLE_TTS_CREDENTIALS সেট করা নেই। Vercel-এ GOOGLE_TTS_CREDENTIALS (JSON string) যোগ করুন।' },
      { status: 503 },
    )
  }

  let body: { text?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid request body' }, { status: 400 })
  }

  const rawText = String(body.text ?? '').trim()
  if (!rawText) return Response.json({ error: 'text is required' }, { status: 400 })

  // Strip markdown and cap at ~600 chars
  const cleaned = stripMarkdown(rawText)
  const text = cleaned.slice(0, 600)
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  try {
    // Shared synthesis helper (creds → JWT → Google TTS → cost log) lives in
    // @/agent/lib/google-tts so camera announcements reuse the same agent voice.
    const audioBuffer = await synthesizeBanglaMp3(text, 'web_voice')

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `TTS ব্যর্থ হয়েছে: ${msg}` }, { status: 500 })
  }
}
