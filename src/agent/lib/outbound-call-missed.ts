/**
 * When an owner-approved outbound call is not answered, offer a retry confirm card.
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type MissedInput = {
  callSid: string
  callStatus: string
  durationSec?: number
  toNumber?: string
}

function statusLabel(status: string, durationSec: number): string {
  if (status === 'no-answer') return 'কেউ ধরেননি'
  if (status === 'busy') return 'লাইন ব্যস্ত'
  if (status === 'failed') return 'কল যায়নি'
  if (status === 'completed' && durationSec > 0 && durationSec < 12) return 'ফোন রিং হয়নি (ghost)'
  return status
}

function isMissedCall(status: string, durationSec: number): boolean {
  return (
    status === 'no-answer'
    || status === 'busy'
    || status === 'failed'
    || (status === 'completed' && durationSec > 0 && durationSec < 12)
  )
}

async function findActionByCallSid(callSid: string) {
  const rows = await db.agentPendingAction.findMany({
    where: { type: 'outbound_call', status: 'executed' },
    orderBy: { resolvedAt: 'desc' },
    take: 40,
  })
  return rows.find((r: { result?: { callSid?: string } }) => r.result?.callSid === callSid) ?? null
}

export async function handleOutboundCallMissed(input: MissedInput) {
  const durationSec = Number(input.durationSec ?? 0)
  if (!isMissedCall(input.callStatus, durationSec)) {
    return { handled: false as const, reason: 'not_missed' }
  }

  const original = await findActionByCallSid(input.callSid)
  if (!original) {
    return { handled: false as const, reason: 'action_not_found' }
  }

  const prevResult = (original.result ?? {}) as Record<string, unknown>
  if (prevResult.missedNotified) {
    return { handled: false as const, reason: 'already_notified', retryActionId: prevResult.retryPendingActionId }
  }

  const payload = original.payload as { phone?: string; message?: string; conversationId?: string }
  const phone = String(payload.phone ?? input.toNumber ?? '')
  const message = String(payload.message ?? '')
  if (!phone || !message) {
    return { handled: false as const, reason: 'missing_payload' }
  }

  const label = statusLabel(input.callStatus, durationSec)
  const summary =
    `📞 স্যার, ${phone} নম্বরে কল গেছে — ${label}।\n\n` +
    `আবার একই মেসেজ দিয়ে কল দিব?\n\n` +
    `🗣️ "${message.slice(0, 300)}"`

  const retryAction = await db.agentPendingAction.create({
    data: {
      conversationId: original.conversationId,
      type: 'outbound_call',
      payload: { phone, message, isRetry: true, originalActionId: original.id },
      summary,
      costEstimate: 0.05,
      status: 'pending',
    },
  })

  await db.agentPendingAction.update({
    where: { id: original.id },
    data: {
      result: {
        ...prevResult,
        callSid: input.callSid,
        missedNotified: true,
        missedStatus: input.callStatus,
        missedAt: new Date().toISOString(),
        retryPendingActionId: retryAction.id,
      },
    },
  })

  const tg = await sendOwnerApprovalCard({
    summary,
    pendingActionId: retryAction.id,
    approveLabel: '✅ আবার কল দিন',
    rejectLabel: '❌ থাক',
  })

  return {
    handled: true as const,
    retryActionId: retryAction.id,
    telegram: tg,
  }
}
