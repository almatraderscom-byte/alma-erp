/**
 * GET/POST /api/assistant/voice-call/ngs-status?rid=<agent_voice_calls.id>&k=<secret>
 *
 * NGS/infosoftbd status callback for OUTBOUND two-way calls. placeNgsLiveCall sets this as
 * the statusCallback, so NGS pings it on every call-state change. Its job: catch calls that
 * NEVER CONNECT (busy / no-answer / failed) — the bot's /relay-report only fires when a call
 * is answered, so before this a failed call sat at 'ringing' forever and the owner was never
 * told. We read the authoritative status from NGS (GET /api/v1/call/{id}), and on a terminal
 * FAILURE update the row + drop a clear line into the agent chat AND Telegram. Answered calls
 * are left to /relay-report (the bot's transcript+summary).
 *
 * Guarded by the ?k shared secret (NGS_INBOUND_SECRET) + requireAgentEnabled.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

export const runtime = 'nodejs'
export const maxDuration = 20

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'failed'])

function secretOk(provided: string): boolean {
  const expected = process.env.NGS_INBOUND_SECRET ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8'); const b = Buffer.from(provided, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

const ok = () => Response.json({ ok: true })

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest) { return handle(req) }

async function handle(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return ok() // never error back to the carrier
  const url = new URL(req.url)
  if (!secretOk(url.searchParams.get('k') ?? '')) return ok()
  const rid = url.searchParams.get('rid') ?? ''
  if (!rid) return ok()

  const row = await db.agentVoiceCall.findUnique({ where: { id: rid } }).catch(() => null)
  if (!row || !row.callSid || TERMINAL.has(row.status)) return ok() // unknown or already resolved

  // Authoritative status from NGS (the callback body format is undocumented; the call object
  // is reliable). establihed_at (NGS's spelling) set = answered; end_time set + not
  // established = it ended without ever connecting.
  const apiBase = (process.env.NGS_API_BASE ?? 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
  const key = process.env.NGS_API_KEY ?? ''
  const secret = process.env.NGS_API_SECRET ?? ''
  let call: Record<string, unknown> = {}
  try {
    const res = await fetch(`${apiBase}/api/v1/call/${row.callSid}`, {
      headers: { 'X-Authorization': key, 'X-Authorization-Secret': secret },
      signal: AbortSignal.timeout(12_000),
    })
    call = (await res.json().catch(() => ({}))) as Record<string, unknown>
  } catch { return ok() }

  const ended = Boolean(String(call.end_time ?? '').trim())
  const established = Boolean(call.establihed_at ?? call.established_at)
  if (!ended) return ok()            // still ringing/dialing — wait
  if (established) return ok()        // answered → the bot's /relay-report handles it

  // Terminal, never connected → map to a failure status + a plain-Bangla reason.
  const raw = String(call.status ?? '').toLowerCase()
  const mapped = raw.includes('busy') ? 'busy' : raw.includes('no') ? 'no_answer' : 'failed'
  const who = row.recipientName || row.toNumber || 'কল'
  const reason = mapped === 'busy' ? 'লাইন ব্যস্ত ছিল' : mapped === 'no_answer' ? 'কেউ ধরেননি' : 'কল যায়নি'
  const text = `📞 বস, ${who} নম্বরে কল দেওয়া হয়েছিল — কিন্তু ${reason}। কথা হয়নি।`

  await db.agentVoiceCall.update({
    where: { id: rid },
    data: { status: mapped, endedAt: new Date(), summary: text },
  }).catch(() => {})

  // Into the agent chat (so the owner SEES the result on screen), then Telegram.
  if (row.conversationId) {
    await db.agentMessage.create({
      data: { conversationId: row.conversationId, role: 'assistant', content: [{ type: 'text', text }], tokensIn: 0, tokensOut: 0, costUsd: 0 },
    }).catch(() => {})
  }
  await sendOwnerText(text).catch(() => {})
  return ok()
}
