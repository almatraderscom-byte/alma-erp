import { createHash } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  buildOpenAIRealtimeTrialSession,
  isOpenAIRealtimeTrialEnabled,
  parseOpenAIRealtimeInputProfile,
  parseOpenAIRealtimeTrialVoice,
} from '@/agent/lib/openai-realtime-trial'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

const MAX_SDP_BYTES = 64 * 1024

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (!isOpenAIRealtimeTrialEnabled()) {
    return Response.json({ error: 'trial_disabled' }, { status: 404 })
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY সেট করা নেই।' }, { status: 503 })
  }

  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/sdp')) {
    return Response.json({ error: 'invalid_content_type' }, { status: 415 })
  }

  const sdp = await req.text()
  if (!sdp.trim() || Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) {
    return Response.json({ error: 'invalid_sdp' }, { status: 400 })
  }

  const voice = parseOpenAIRealtimeTrialVoice(req.nextUrl.searchParams.get('voice'))
  const inputProfile = parseOpenAIRealtimeInputProfile(req.nextUrl.searchParams.get('input'))
  const form = new FormData()
  form.set('sdp', sdp)
  form.set('session', JSON.stringify(buildOpenAIRealtimeTrialSession(voice, inputProfile)))

  const safetyId = createHash('sha256').update(`alma-realtime-trial:${owner.sub}`).digest('hex')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  try {
    const openaiResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Safety-Identifier': safetyId,
      },
      body: form,
      signal: controller.signal,
    })
    const answer = await openaiResponse.text()

    if (!openaiResponse.ok) {
      console.warn('[openai-realtime-trial] call creation failed:', openaiResponse.status, answer.slice(0, 300))
      return Response.json(
        { error: 'realtime_call_failed', status: openaiResponse.status, detail: answer.slice(0, 300) },
        { status: 502 },
      )
    }

    return new Response(answer, {
      status: 200,
      headers: {
        'Content-Type': 'application/sdp',
        'Cache-Control': 'no-store, private',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[openai-realtime-trial] connection failed:', message)
    return Response.json({ error: 'realtime_connection_failed' }, { status: 502 })
  } finally {
    clearTimeout(timeout)
  }
}
