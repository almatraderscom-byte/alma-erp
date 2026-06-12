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
    `✅ স্যার, কল দেওয়া হয়েছে — ${phone}।\n\n` +
    `লাইনে রিং চলছে; কেউ ধরলে বা না ধরলে আলাদা মেসেজ পাবেন।` +
    (callSid ? `\n(Ref: ${callSid.slice(0, 12)}…)` : '')
  )
}
