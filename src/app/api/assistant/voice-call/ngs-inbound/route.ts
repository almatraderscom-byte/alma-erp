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
import { isOwnerNumber } from '@/agent/lib/voice-call'

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
  // NGS action-callback naming uses event_* prefixes (docs: event_from/event_to/
  // event_call_id) — live 2026-07-24 the inbound webhook sent NONE of our old
  // variants and every caller landed as 'unknown' (boss got the receptionist).
  const caller = String(
    p.from ?? p.caller ?? p.src ?? p.caller_id ?? p.callerId
    ?? p.event_from ?? p.eventFrom ?? p.caller_id_number ?? p.ani ?? '',
  ).trim() || 'unknown'
  if (caller === 'unknown') {
    // One safe breadcrumb so the NEXT inbound call reveals the real field name.
    console.warn('[ngs-inbound] caller id missing — payload keys:', Object.keys(p).join(','))
  }
  const voice = process.env.NGS_INBOUND_VOICE || 'Charon'
  // Human-PA point 1 (owner audit 2026-07-24): the BOSS calling his own agent
  // must get the full assistant, not the receptionist. Owner number ⇒ owner
  // persona + ERP tools + submit_boss_instruction (the record's toNumber is the
  // caller, so the submit route's owner-call gate passes naturally).
  const ownerCalling = caller !== 'unknown' && isOwnerNumber(caller)
  // Human-PA point 7: transfer policy. 'direct' (default) dials the team number
  // as before; 'ask_first' makes the bot take a message + ping the boss instead
  // of blind-transferring (owner flips via KV inbound_transfer_mode).
  let transferMode = 'direct'
  try {
    const kv = await db.agentKvSetting.findUnique({ where: { key: 'inbound_transfer_mode' } })
    if (kv?.value === 'ask_first') transferMode = 'ask_first'
  } catch { /* default */ }

  // Pre-create the row so the post-call report has a target + the owner gets a summary.
  let recordId: string
  try {
    const rec = await db.agentVoiceCall.create({
      data: {
        toNumber: caller,
        recipientName: ownerCalling ? 'Boss' : `ইনকামিং কল: ${caller}`,
        purpose: ownerCalling ? 'inbound_owner_call' : 'inbound_call',
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
    P('purpose', ownerCalling
      ? 'Boss নিজে ফোন করেছেন — পূর্ণ সহকারী মোডে সালাম দিয়ে জিজ্ঞেস করো কী লাগবে; তথ্য চাইলে টুল দিয়ে দাও, কাজের নির্দেশ দিলে submit_boss_instruction-এ পাঠাও।'
      : 'ইনকামিং কল — ব্যবসার সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও') +
    P('recipientName', ownerCalling ? 'Boss' : caller) + P('voice', voice) +
    P('callType', ownerCalling ? 'owner' : 'inbound') +
    P('transferMode', transferMode) +
    '</stream></connect></response>'
  return xml(body)
}

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest) { return handle(req) }
