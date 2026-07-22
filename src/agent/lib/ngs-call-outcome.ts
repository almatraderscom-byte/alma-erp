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
import { persistVoiceCallReport } from '@/agent/lib/voice-call-delivery'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'report_missing'])

export type NgsOutcome = 'answered' | 'report_missing' | 'no_answer' | 'busy' | 'failed' | 'pending' | 'skip'

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
  const raw = String(call.status ?? '').toLowerCase()
  if (!ended) {
    await db.agentVoiceCall.update({
      where: { id: rowId },
      data: established
        ? { status: 'answered', providerStatus: raw || 'answered', answeredAt: row.answeredAt ?? new Date() }
        : { providerStatus: raw || 'ringing' },
    }).catch(() => {})
    return established ? 'answered' : 'pending'
  }
  if (established) {
    if (row.reportReceivedAt) return 'skip'
    const providerEndedAt = Date.parse(String(call.end_time ?? ''))
    const reference = Number.isFinite(providerEndedAt) ? providerEndedAt : new Date(row.createdAt).getTime()
    if (Date.now() - reference < 90_000) {
      await db.agentVoiceCall.update({
        where: { id: rowId },
        data: { status: 'report_pending', providerStatus: raw || 'completed', answeredAt: row.answeredAt ?? new Date() },
      }).catch(() => {})
      return 'answered'
    }
    const who = row.recipientName || row.toNumber || 'কল'
    await persistVoiceCallReport({
      callRecordId: rowId,
      status: 'report_missing',
      summary: `${who}-এর সঙ্গে কল সংযুক্ত হয়ে শেষ হয়েছে, কিন্তু voice worker-এর transcript/report ৯০ সেকেন্ডের মধ্যে পৌঁছায়নি। Recovery চলছে।`,
      provider: 'ngs',
      authoritativeReport: false,
    })
    return 'report_missing'
  }

  const mapped: 'busy' | 'no_answer' | 'failed' =
    raw.includes('busy') ? 'busy' : raw.includes('noanswer') || raw.includes('no answer') || raw.includes('no-answer') ? 'no_answer' : 'failed'
  const who = row.recipientName || row.toNumber || 'কল'
  const reason = mapped === 'busy' ? 'লাইন ব্যস্ত ছিল' : mapped === 'no_answer' ? 'কেউ ধরেননি' : 'কল যায়নি'
  const text = `Boss, ${who} নম্বরে কল দেওয়া হয়েছিল—কিন্তু ${reason}। কথা হয়নি।`

  await persistVoiceCallReport({
    callRecordId: rowId,
    status: mapped,
    summary: text,
    provider: 'ngs',
  })
  return mapped
}
