/**
 * POST (or GET) /api/assistant/voice-call/ngs-inbound — answer URL for INBOUND calls to
 * the infosoftbd (NextGenSwitch) BD number. When someone dials 09649777738, NGS fetches
 * this URL and plays back the NGS verbs we return; we return
 * `<connect><stream url=BOT>` so the Gemini Live bot answers the caller in Bangla as
 * ALMA's assistant (worker/scripts/gemini-live-bot.mjs, callType='inbound').
 *
 * Security: this endpoint is reachable without a session (NGS calls it), so it is guarded
 * by a shared secret in the URL (`?k=NGS_INBOUND_SECRET`, configured in the portal inbound
 * route) — without it we return an empty <response/> so nobody can mint a signed bot URL.
 * The media session itself is still protected by the bot's HMAC start-frame auth. Also
 * gated by requireAgentEnabled() + VOICE_CALL_ENABLED.
 *
 * We pre-create an agent_voice_calls row (direction inbound) so the bot's post-call report
 * (/relay-report) updates it and the owner gets a Bangla summary of who called + why.
 */
import { type NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 20

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function xml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}
const EMPTY = '<response></response>'

function escapeXmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function secretOk(provided: string): boolean {
  const expected = process.env.NGS_INBOUND_SECRET ?? ''
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

async function readParams(req: NextRequest): Promise<Record<string, string>> {
  const url = new URL(req.url)
  const out: Record<string, string> = {}
  url.searchParams.forEach((v, k) => { out[k] = v })
  if (req.method === 'POST') {
    const ct = req.headers.get('content-type') ?? ''
    try {
      if (ct.includes('application/json')) {
        Object.assign(out, await req.json())
      } else {
        const form = await req.formData()
        form.forEach((v, k) => { out[k] = String(v) })
      }
    } catch { /* no/invalid body — query params may still carry it */ }
  }
  return out
}

async function handle(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return xml(EMPTY) // agent off → don't answer with a stream

  const p = await readParams(req)
  if (!secretOk(String(p.k ?? ''))) {
    // Unauthenticated hit — never mint a signed bot URL. Silent empty response.
    return xml(EMPTY)
  }
  if (process.env.VOICE_CALL_ENABLED !== 'true') return xml(EMPTY)

  const wsUrl = process.env.NGS_LIVE_WS_URL ?? ''
  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!wsUrl || !internalToken) return xml(EMPTY)

  // NGS field names vary; accept the common variants.
  const caller = String(p.from ?? p.caller ?? p.src ?? p.caller_id ?? p.callerId ?? '').trim() || 'unknown'
  const voice = process.env.NGS_INBOUND_VOICE || 'Charon'

  // Pre-create the row so the post-call report has a target + the owner gets a summary.
  let recordId: string
  try {
    const rec = await db.agentVoiceCall.create({
      data: {
        toNumber: caller,
        recipientName: `ইনকামিং কল: ${caller}`,
        purpose: 'inbound_call',
        firstMessage: '',
        status: 'ringing',
      },
    })
    recordId = rec.id
  } catch {
    return xml(EMPTY)
  }

  const exp = Date.now() + 15 * 60_000
  const t = createHmac('sha256', internalToken).update(`relay:${recordId}:${exp}`).digest('hex')
  const P = (n: string, v: string) => `<parameter name="${escapeXmlAttr(n)}" value="${escapeXmlAttr(v)}"/>`
  const body =
    `<response><connect><stream name="alma" url="${escapeXmlAttr(wsUrl)}">` +
    P('id', recordId) + P('exp', String(exp)) + P('t', t) +
    P('purpose', 'ইনকামিং কল — ব্যবসার সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও') +
    P('recipientName', caller) + P('voice', voice) + P('callType', 'inbound') +
    '</stream></connect></response>'
  return xml(body)
}

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest) { return handle(req) }
