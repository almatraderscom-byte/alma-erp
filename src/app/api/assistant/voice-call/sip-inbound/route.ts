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
import { dhakaHour } from '@/agent/lib/quiet-hours'
import { readSettingMap } from '@/agent/lib/phone-settings'

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
type DidConfig = { line?: string; forward?: string; forwardBoss?: string; forwardSupport?: string; label?: string }
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

/**
 * Is the shop open right now (Asia/Dhaka)? Outside these hours the AI still answers — a
 * caller should never hear a dead line — but it says the office is closed and takes a
 * message instead of ringing staff who are not there.
 *
 * Both the window and the holiday list come from the phone console's settings screen, which
 * falls back to `SIP_OFFICE_HOURS` when no row has been saved — so this behaves exactly as it
 * did before the screen existed until the owner actually changes something.
 */
async function officeOpenNow(settings: Record<string, string>): Promise<{ open: boolean; window: string; holiday: boolean }> {
  const raw = settings.office_hours_dhaka?.trim() || process.env.SIP_OFFICE_HOURS?.trim()
  const window = raw && /^\d{1,2}-\d{1,2}$/.test(raw) ? raw : '10-21'

  // A declared holiday closes the whole day regardless of the hour. Compared as a Dhaka
  // calendar date (UTC+6) rather than with a timezone library, for the same reason the quiet
  // hours are: fewer moving parts on a path an inbound call waits on.
  const today = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10)
  const holiday = (settings.phone_holidays ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
    .includes(today)
  if (holiday) return { open: false, window, holiday: true }

  const [fromRaw, toRaw] = window.split('-').map((x) => Number(x))
  const from = Number.isFinite(fromRaw) ? fromRaw : 10
  const to = Number.isFinite(toRaw) ? toRaw : 21
  const h = dhakaHour()
  // A window that wraps midnight (e.g. 22-6) is still handled correctly.
  const open = from <= to ? h >= from && h < to : h >= from || h < to
  return { open, window, holiday: false }
}

/**
 * Numbers we refuse outright. Nuisance callers should not reach the assistant at all —
 * every answered call costs Gemini minutes and, for a repeat caller, the owner's attention.
 * Matched on the last 9 digits, so prefixes and formatting cannot be used to slip past it.
 * The gateway keeps the same list and checks it BEFORE answering; this is the second gate,
 * for the case where the gateway's copy is a minute stale.
 */
function isBlockedCaller(caller: string, list: string): boolean {
  const tail = (n: string) => n.replace(/\D/g, '').slice(-9)
  const target = tail(caller)
  if (!target) return false
  return list.split(',').map((n) => tail(n)).filter(Boolean).includes(target)
}

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
  const cfg = didConfig(did)

  // Everything the owner can change from the phone console, in one query rather than four on
  // a path an inbound caller is waiting on. Each falls back to the env var that used to
  // control it, so an untouched settings table answers calls exactly as before.
  const settings = await readSettingMap([
    'office_hours_dhaka',
    'phone_holidays',
    'blocked_callers',
    'inbound_transfer_mode',
    'phone_forward_support',
    'phone_forward_boss',
  ]).catch(() => ({}) as Record<string, string>)

  // The whole reason for self-hosting: a REAL caller number, so the boss calling his own
  // line gets the full assistant (ERP tools + submit_boss_instruction), not the receptionist.
  const ownerCalling = caller !== 'unknown' && isOwnerNumber(caller)

  // Blocked numbers are refused before anything is answered, so they cost nothing.
  if (!ownerCalling && isBlockedCaller(caller, settings.blocked_callers ?? '')) {
    console.warn('[sip-inbound] blocked caller refused:', caller)
    return NextResponse.json({ ok: true, reject: true, reason: 'blocked' })
  }

  // Human-PA point 7: transfer policy. 'direct' dials the team number; 'ask_first' makes
  // the bot take a message + ping the boss instead of blind-transferring.
  let transferMode = settings.inbound_transfer_mode === 'ask_first' ? 'ask_first' : 'direct'

  // Outside office hours nobody is at the support line, so a blind transfer would ring an
  // empty desk and drop the customer. Take the message instead — the boss himself is always
  // allowed through, since he is calling his own assistant.
  const office = await officeOpenNow(settings)
  if (!office.open && !ownerCalling) transferMode = 'ask_first'

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
    : !office.open
      ? office.holiday
        ? 'ইনকামিং কল — আজ অফিস ছুটি। বিনয়ের সাথে সালাম দিয়ে বলো আজ অফিস বন্ধ, তারপর গ্রাহকের নাম, নম্বর ও প্রয়োজনটা মন দিয়ে জেনে নাও এবং আশ্বস্ত করো অফিস খুললেই টিম যোগাযোগ করবে। কাউকে ফোন যুক্ত করার প্রতিশ্রুতি দেবে না।'
        : `ইনকামিং কল — এখন অফিস সময়ের বাইরে (অফিস সময় প্রতিদিন ${office.window} টা)। বিনয়ের সাথে সালাম দিয়ে বলো এখন অফিস বন্ধ, তারপর গ্রাহকের নাম, নম্বর ও প্রয়োজনটা মন দিয়ে জেনে নাও এবং আশ্বস্ত করো অফিস খুললেই টিম যোগাযোগ করবে। কাউকে ফোন যুক্ত করার প্রতিশ্রুতি দেবে না।`
    : cfg.line === 'support'
      ? `ইনকামিং কল${cfg.label ? ` (${cfg.label} লাইন)` : ''} — ALMA-র সাপোর্ট সহকারী হিসেবে সাহায্য করো এবং কী দরকার জেনে নাও।`
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
      // Where a live transfer can go. Self-hosted SIP lifted NGS's single-forward limit, so
      // the bot picks per call: customer-service topics reach the business line, and only a
      // caller who genuinely needs the owner reaches his personal number (owner rule
      // 2026-07-25 — a routine order question must never ring the boss's phone).
      // A DID-specific override still wins; otherwise the console's setting, which itself
      // falls back to the env vars these used to read directly.
      forwardSupport: cfg.forwardSupport ?? settings.phone_forward_support ?? '',
      forwardBoss: cfg.forwardBoss ?? settings.phone_forward_boss ?? process.env.NGS_FORWARD_NUMBER ?? '',
      // Legacy single-target field, still honoured as a fallback by the bot.
      ...(cfg.forward ? { forwardNumber: cfg.forward } : {}),
    },
  })
}
