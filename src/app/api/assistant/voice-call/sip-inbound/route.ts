/**
 * POST /api/assistant/voice-call/sip-inbound — persona resolver for INBOUND calls that
 * arrive on our OWN Asterisk (self-hosted SIP, Phase 2). The SIP gateway on the VPS
 * (worker/src/voice-relay/sip-gateway-service.mjs) calls this the moment a call hits the
 * from-alma dialplan, passing the REAL caller number taken from the SIP From header.
 *
 * THE POINT: NGS's inbound webhook carried no caller variable at all (the provider strips
 * it and won't expose their template var), so owner-recognition was impossible — the boss
 * calling his own number got the receptionist. Self-hosted, the caller-ID is simply there,
 * so `isOwnerNumber(caller)` finally works and the boss gets "জি বস" + the full assistant.
 *
 * Returns JSON (not NGS XML): the gateway drives the media session itself, so all it needs
 * is the persona + a signed bot token + the DB row id for the post-call report.
 *
 * Security: reachable without a session (the VPS calls it), so it is guarded by a shared
 * secret (`?k=SIP_INBOUND_SECRET`) plus requireAgentEnabled() + VOICE_CALL_ENABLED. The
 * media session itself is still protected by the bot's HMAC start-frame auth.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { isOwnerNumber } from '@/agent/lib/voice-call'

export const runtime = 'nodejs'
export const maxDuration = 20

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const deny = () => NextResponse.json({ ok: false }, { status: 200 })

function secretOk(provided: string): boolean {
  const expected = process.env.SIP_INBOUND_SECRET ?? process.env.NGS_INBOUND_SECRET ?? ''
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

/**
 * Multi-DID (owner ask): each incoming DID can answer with its own persona and its own
 * forward number — the boss line runs the full assistant, a support/staff line answers as
 * the shop and forwards elsewhere. Configured without a redeploy via SIP_DID_MAP, e.g.
 *   SIP_DID_MAP={"09649777738":{"line":"boss"},"09649777739":{"line":"support","forward":"01XXXXXXXXX"}}
 * Unknown/absent DIDs fall back to the default assistant behaviour.
 */
type DidConfig = { line?: string; forward?: string; label?: string }
function didConfig(did: string): DidConfig {
  try {
    const map = JSON.parse(process.env.SIP_DID_MAP ?? '{}') as Record<string, DidConfig>
    const tail = (n: string) => n.replace(/\D/g, '').slice(-9)
    if (map[did]) return map[did]
    const hit = Object.entries(map).find(([k]) => tail(k) === tail(did))
    return hit?.[1] ?? {}
  } catch {
    return {}
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return deny()

  const url = new URL(req.url)
  if (!secretOk(url.searchParams.get('k') ?? '')) return deny()
  if (process.env.VOICE_CALL_ENABLED !== 'true') return deny()

  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!internalToken) return deny()

  const body = (await req.json().catch(() => ({}))) as { caller?: string; did?: string }
  const caller = String(body.caller ?? '').trim() || 'unknown'
  const did = String(body.did ?? '').trim()
  const cfg = didConfig(did)

  // The whole reason for self-hosting: a REAL caller number, so the boss calling his own
  // line gets the full assistant (ERP tools + submit_boss_instruction), not the receptionist.
  const ownerCalling = caller !== 'unknown' && isOwnerNumber(caller)

  // Human-PA point 7: transfer policy. 'direct' dials the team number; 'ask_first' makes
  // the bot take a message + ping the boss instead of blind-transferring (KV-flipped).
  let transferMode = 'direct'
  try {
    const kv = await db.agentKvSetting.findUnique({ where: { key: 'inbound_transfer_mode' } })
    if (kv?.value === 'ask_first') transferMode = 'ask_first'
  } catch { /* default */ }

  // Pre-create the row so the bot's post-call report has a target + the owner gets a summary.
  let recordId: string
  try {
    const rec = await db.agentVoiceCall.create({
      data: {
        toNumber: caller,
        recipientName: ownerCalling ? 'Boss' : `ইনকামিং কল: ${caller}`,
        purpose: ownerCalling ? 'inbound_owner_call' : 'inbound_call',
        firstMessage: '',
        status: 'ringing',
        provider: 'sip',
        providerStatus: 'ringing',
      },
    })
    recordId = rec.id
  } catch {
    return deny()
  }

  const exp = Date.now() + 15 * 60_000
  const t = createHmac('sha256', internalToken).update(`relay:${recordId}:${exp}`).digest('hex')

  const purpose = ownerCalling
    ? 'Boss নিজে ফোন করেছেন — পূর্ণ সহকারী মোডে সালাম দিয়ে জিজ্ঞেস করো কী লাগবে; তথ্য চাইলে টুল দিয়ে দাও, কাজের নির্দেশ দিলে submit_boss_instruction-এ পাঠাও।'
    : cfg.line === 'support'
      ? `ইনকামিং কল${cfg.label ? ` (${cfg.label} লাইন)` : ''} — ALMA-র সাপোর্ট সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও।`
      : 'ইনকামিং কল — ব্যবসার সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও'

  return NextResponse.json({
    ok: true,
    params: {
      id: recordId,
      exp,
      t,
      purpose,
      recipientName: ownerCalling ? 'Boss' : caller,
      voice: process.env.SIP_INBOUND_VOICE ?? process.env.NGS_INBOUND_VOICE ?? 'Charon',
      callType: ownerCalling ? 'owner' : 'inbound',
      transferMode,
      // Per-DID forward target (multi-DID); the bot falls back to its own env when absent.
      ...(cfg.forward ? { forwardNumber: cfg.forward } : {}),
    },
  })
}
