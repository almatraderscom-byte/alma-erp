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
import { buildOwnerCallFacts } from '@/agent/lib/call-facts'
import { decideInbound, isKnownCaller, readDidRoutes, readInboundSettings } from '@/agent/lib/phone-routing'

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

/*
 * Multi-DID and the time rules used to live here as three private helpers. They moved to
 * `phone-routing.ts` in the console's step 4 for one reason: the ROUTING PREVIEW screen has
 * to answer "a call from 01712345678 at 21:30 would reach …", and a preview that
 * re-implements the rules is a second set of rules. The moment the two disagree the screen
 * is lying — about the one thing (routing) whose bugs are invisible until a customer hits
 * them. So the preview and this route now call the same `decideInbound()`.
 */

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return deny()

  // Either credential is accepted: the ?k= shared secret, or a Bearer AGENT_INTERNAL_TOKEN
  // — the secret this app and the VPS already share. Allowing the token means the cutover
  // needs no new secret copied between machines, and an untransported secret cannot leak.
  const url = new URL(req.url)
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const internal = process.env.AGENT_INTERNAL_TOKEN ?? ''
  const tokenOk = Boolean(internal && bearer && bearer.length === internal.length
    && timingSafeEqual(Buffer.from(bearer), Buffer.from(internal)))
  if (!tokenOk && !secretOk(url.searchParams.get('k') ?? '')) return deny()
  if (process.env.VOICE_CALL_ENABLED !== 'true') return deny()

  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!internalToken) return deny()

  const body = (await req.json().catch(() => ({}))) as { caller?: string; did?: string }
  const caller = String(body.caller ?? '').trim() || 'unknown'
  const did = String(body.did ?? '').trim()

  // The whole reason for self-hosting: a REAL caller number, so the boss calling his own
  // line gets the full assistant (ERP tools + submit_boss_instruction), not the receptionist.
  const ownerCalling = caller !== 'unknown' && isOwnerNumber(caller)

  // One decision, made by the same function the console's preview screen calls. Both reads
  // are best-effort: an inbound call must never fail because a settings or routing lookup
  // did, and every value falls back to the env var that used to control it.
  const [settings, routes, known] = await Promise.all([
    readInboundSettings(),
    readDidRoutes().catch(() => []),
    // Whether the agent already knows this number decides who picks up: a known caller gets
    // the assistant straight away, an unknown one gets a human first. Best-effort — a failed
    // lookup means "unknown", which errs toward a person answering rather than a machine.
    ownerCalling ? Promise.resolve(true) : isKnownCaller(caller).catch(() => false),
  ])
  const decision = decideInbound({ caller, did, at: new Date(), owner: ownerCalling, known, settings, routes })
  const cfg = decision.route

  // Blocked numbers are refused before anything is answered, so they cost nothing.
  if (decision.blocked) {
    console.warn('[sip-inbound] blocked caller refused:', caller)
    return NextResponse.json({ ok: true, reject: true, reason: 'blocked' })
  }

  const transferMode = decision.transferMode
  const office = decision.time

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

  const lineLabel = cfg?.label ? ` (${cfg.label} লাইন)` : ''
  const purpose = ownerCalling
    ? 'Boss নিজে ফোন করেছেন — পূর্ণ সহকারী মোডে সালাম দিয়ে জিজ্ঞেস করো কী লাগবে; তথ্য চাইলে টুল দিয়ে দাও, কাজের নির্দেশ দিলে submit_boss_instruction-এ পাঠাও।'
    : !office.open
      // The AI now says WHY it is closed — "আজ ছুটির দিন" reads very differently from
      // "এখন অফিস সময়ের বাইরে" to a customer, and the routing rules already know which.
      ? `ইনকামিং কল${lineLabel} — এখন অফিস বন্ধ (${office.reason})। বিনয়ের সাথে সালাম দিয়ে সেটা জানাও, তারপর গ্রাহকের নাম, নম্বর ও প্রয়োজনটা মন দিয়ে জেনে নাও এবং আশ্বস্ত করো অফিস খুললেই টিম যোগাযোগ করবে। কাউকে ফোন যুক্ত করার প্রতিশ্রুতি দেবে না।`
      : cfg?.line === 'support'
        ? `ইনকামিং কল${lineLabel} — ALMA-র সাপোর্ট সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও।`
        : 'ইনকামিং কল — ব্যবসার সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও'

  // The owner asks about his staff on these calls, and a name must never be improvised: a
  // mid-call tool round-trip is unreliable (Gemini Live drops a functionResponse that lands
  // while it is speaking, and on 2026-07-25 it answered with two invented names). So the real
  // names ride along with the call. Best-effort — an inbound call must never fail for this.
  const facts = ownerCalling ? await buildOwnerCallFacts().catch(() => '') : ''

  return NextResponse.json({
    ok: true,
    params: {
      id: recordId,
      exp,
      t,
      purpose,
      ...(facts ? { facts } : {}),
      recipientName: ownerCalling ? 'Boss' : caller,
      voice: process.env.SIP_INBOUND_VOICE ?? process.env.NGS_INBOUND_VOICE ?? 'Charon',
      callType: ownerCalling ? 'owner' : 'inbound',
      transferMode,
      afterHours: !office.open,
      // Who picks up, and for how long the team's phones ring first. The gateway resolves an
      // empty ringGroup to "every browser phone open right now".
      answerMode: decision.answerMode,
      ringSecs: decision.ringSecs,
      ringGroup: decision.ringGroup,
      // Where a live transfer can go. Self-hosted SIP lifted NGS's single-forward limit, so
      // the bot picks per call: customer-service topics reach the business line, and only a
      // caller who genuinely needs the owner reaches his personal number (owner rule
      // 2026-07-25 — a routine order question must never ring the boss's phone).
      // A DID-specific override still wins; otherwise the console's setting, which itself
      // falls back to the env vars these used to read directly.
      // Resolved by decideInbound(): a DID-specific override wins, otherwise the console's
      // setting, which itself falls back to the env vars these used to read directly.
      forwardSupport: decision.forwardSupport,
      forwardBoss: decision.forwardBoss,
      // Legacy single-target field, still honoured as a fallback by the bot.
      ...(cfg?.forward ? { forwardNumber: cfg.forward } : {}),
    },
  })
}
