/**
 * Report the outcome of an NGS/infosoftbd outbound two-way call that NEVER CONNECTED
 * (busy / no-answer / failed). NGS does NOT reliably call our statusCallback, so the
 * reliable path is to ASK NGS ourselves (GET /api/v1/call/{id}) — done by the
 * /api/cron/ngs-call-sweep cron for any row stuck at 'ringing'. Answered calls are left
 * to the bot's /relay-report (transcript + summary).
 *
 * Shared by the sweep and the (best-effort) ngs-status webhook.
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'failed'])

export type NgsOutcome = 'answered' | 'no_answer' | 'busy' | 'failed' | 'pending' | 'skip'

/** Ask NGS for the authoritative call state and report a FAILED (never-connected) call
 * into the row + agent chat + Telegram. Returns what happened (for logging). */
export async function reportNgsCallOutcome(rowId: string): Promise<NgsOutcome> {
  const row = await db.agentVoiceCall.findUnique({ where: { id: rowId } }).catch(() => null)
  if (!row || !row.callSid || TERMINAL.has(row.status)) return 'skip'

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
  } catch {
    return 'pending'
  }

  const ended = Boolean(String(call.end_time ?? '').trim())
  const established = Boolean(call.establihed_at ?? call.established_at) // NGS misspells "establihed_at"
  if (!ended) return 'pending'      // still dialing/ringing
  if (established) return 'answered' // the bot's /relay-report handles the transcript+summary

  const raw = String(call.status ?? '').toLowerCase()
  const mapped: 'busy' | 'no_answer' | 'failed' =
    raw.includes('busy') ? 'busy' : raw.includes('noanswer') || raw.includes('no answer') || raw.includes('no-answer') ? 'no_answer' : 'failed'
  const who = row.recipientName || row.toNumber || 'কল'
  const reason = mapped === 'busy' ? 'লাইন ব্যস্ত ছিল' : mapped === 'no_answer' ? 'কেউ ধরেননি' : 'কল যায়নি'
  const text = `📞 বস, ${who} নম্বরে কল দেওয়া হয়েছিল — কিন্তু ${reason}। কথা হয়নি।`

  await db.agentVoiceCall.update({
    where: { id: rowId },
    data: { status: mapped, endedAt: new Date(), summary: text },
  }).catch(() => {})

  if (row.conversationId) {
    await db.agentMessage.create({
      data: { conversationId: row.conversationId, role: 'assistant', content: [{ type: 'text', text }], tokensIn: 0, tokensOut: 0, costUsd: 0 },
    }).catch(() => {})
  }
  await sendOwnerText(text).catch(() => {})
  return mapped
}
