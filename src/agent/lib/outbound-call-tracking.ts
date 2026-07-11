import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function findOutboundActionByCallSid(callSid: string) {
  const rows = await db.agentPendingAction.findMany({
    where: { type: 'outbound_call', status: { in: ['executed', 'failed'] } },
    orderBy: { resolvedAt: 'desc' },
    take: 40,
  })
  return rows.find((r: { result?: { callSid?: string; ok?: boolean } }) => {
    if (r.result?.callSid !== callSid) return false
    // Legacy rows: status failed but call actually placed (ok: true).
    return true
  }) ?? null
}

export function buildOutboundDialMessage(phone: string, callSid?: string): string {
  return (
    `✅ বস, কল দেওয়া হয়েছে — ${phone}।\n\n` +
    `লাইনে রিং চলছে; কেউ ধরলে বা না ধরলে আলাদা মেসেজ পাবেন।` +
    (callSid ? `\n(Ref: ${callSid.slice(0, 12)}…)` : '')
  )
}

type OutboundRow = {
  id: string
  status: string
  payload: { phone?: string; message?: string }
  result?: {
    ok?: boolean
    callSid?: string
    answeredNotified?: boolean
    answeredDurationSec?: number
    retryOffered?: boolean
  } | null
  createdAt: Date | string
  resolvedAt?: Date | string | null
}

/** True when Twilio actually placed the call (incl. legacy failed+ok rows). */
export function outboundWasDialed(row: OutboundRow): boolean {
  if (row.status === 'executed') return true
  if (row.status === 'failed' && row.result?.ok && row.result?.callSid) return true
  return false
}

export function summarizeOutboundAction(row: OutboundRow) {
  const phone = String(row.payload?.phone ?? '')
  const callSid = row.result?.callSid
  const dialed = outboundWasDialed(row)
  let phase: string
  if (row.status === 'pending') phase = 'awaiting_approve'
  else if (row.status === 'approved') phase = 'approved_queued'
  else if (dialed && row.result?.answeredNotified) phase = 'answered'
  else if (dialed && row.result?.retryOffered) phase = 'no_answer_retry_offered'
  else if (dialed) phase = 'dialed'
  else if (row.status === 'failed') phase = 'failed'
  else if (row.status === 'rejected') phase = 'rejected'
  else if (row.status === 'expired') phase = 'expired'
  else phase = row.status

  return {
    pendingActionId: row.id,
    phone,
    status: row.status,
    phase,
    callSid: callSid ?? null,
    dialed,
    answered: Boolean(row.result?.answeredNotified),
    answeredDurationSec: row.result?.answeredDurationSec ?? null,
    message: String(row.payload?.message ?? '').slice(0, 200),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  }
}
