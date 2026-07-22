import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { enqueueAgentContinuation } from '@/agent/lib/approval-continuation'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type VoiceCallTerminalStatus = 'completed' | 'no_answer' | 'busy' | 'failed' | 'report_missing'
export type VoiceCallTranscriptTurn = { role?: string; message?: string }

export interface PersistVoiceCallReportInput {
  callRecordId: string
  callSid?: string | null
  transcript?: VoiceCallTranscriptTurn[]
  summary?: string | null
  durationSecs?: number | null
  status: VoiceCallTerminalStatus
  costBdt?: number | null
  provider?: string | null
  /** False for the NGS reconciler's “ended but bot report missing” synthetic alert. */
  authoritativeReport?: boolean
}

// Keep retrying across a multi-hour provider outage. With the capped delay this
// covers several days before a row is quarantined as dead for manual inspection.
const MAX_ATTEMPTS = 20
const LEASE_MS = 2 * 60_000

function retryDelayMs(attempt: number): number {
  return Math.min(6 * 60 * 60_000, 15_000 * 2 ** Math.max(0, Math.min(attempt, 12) - 1))
}

function cleanTurns(value: unknown): VoiceCallTranscriptTurn[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((turn) => {
    if (!turn || typeof turn !== 'object') return []
    const item = turn as VoiceCallTranscriptTurn
    const message = typeof item.message === 'string' ? item.message.trim() : ''
    if (!message) return []
    return [{ role: item.role === 'agent' ? 'agent' : 'caller', message: message.slice(0, 4000) }]
  }).slice(0, 200)
}

function banglaNumber(value: number): string {
  return String(value).replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)] ?? digit)
}

export function formatVoiceCallReport(record: {
  recipientName?: string | null
  toNumber?: string | null
  summary?: string | null
  durationSecs?: number | null
  costCredits?: number | null
  transcript?: unknown
  status?: string | null
}): { title: string; telegram: string; chat: string } {
  const who = record.recipientName || record.toNumber || 'কল'
  const mins = record.durationSecs != null
    ? `${banglaNumber(Math.max(1, Math.ceil(record.durationSecs / 60)))} মিনিট`
    : ''
  const prefix = record.status === 'report_missing'
    ? `কল শেষ — ${who}, কিন্তু রিপোর্ট এখনও আসেনি`
    : record.status === 'no_answer'
      ? `কল শেষ — ${who} কল ধরেননি`
      : record.status === 'busy'
        ? `কল শেষ — ${who}-এর লাইন ব্যস্ত ছিল`
        : record.status === 'failed'
          ? `কল ব্যর্থ — ${who}`
          : `কল শেষ — ${who}${mins ? ` (${mins})` : ''}`
  const turns = cleanTurns(record.transcript)
  const fullTranscript = turns
    .map((turn) => `${turn.role === 'agent' ? 'এজেন্ট' : who}: ${turn.message}`)
    .join('\n')
  const transcript = fullTranscript.length > 12_000
    ? `${fullTranscript.slice(0, 12_000)}\n…(পূর্ণ transcript database-এ সংরক্ষিত)`
    : fullTranscript
  const costLine = record.costCredits != null ? `আনুমানিক খরচ: ৳${record.costCredits}\n` : ''
  const summaryLine = record.summary ? `সারাংশ: ${record.summary}\n\n` : ''
  const body = transcript ? `কথোপকথন:\n${transcript}` : 'কথোপকথনের transcript পাওয়া যায়নি।'
  return {
    title: prefix,
    telegram: `${prefix}\n${costLine}\n${summaryLine}${body}`.trim(),
    chat: `${prefix}।${record.summary
      ? ` সারাংশ: ${record.summary}`
      : transcript
        ? ` কথোপকথন: ${transcript.slice(0, 2000)}`
        : ' কোনো কথোপকথন পাওয়া যায়নি।'}`,
  }
}

/** Store the terminal outcome and enqueue each owner-facing channel atomically. */
export async function persistVoiceCallReport(input: PersistVoiceCallReportInput) {
  const authoritative = input.authoritativeReport !== false
  const now = new Date()
  return db.$transaction(async (tx: any) => {
    const record = await tx.agentVoiceCall.findUnique({ where: { id: input.callRecordId } })
    if (!record) return null

    const transcript = cleanTurns(input.transcript)
    const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 2000) : null
    const durationSecs = Number.isFinite(input.durationSecs)
      ? Math.max(0, Math.round(Number(input.durationSecs))) : null
    const costBdt = Number.isFinite(input.costBdt) ? Math.max(0, Math.round(Number(input.costBdt))) : null
    const upgradedFromMissing = authoritative && record.status === 'report_missing'

    const updated = await tx.agentVoiceCall.update({
      where: { id: input.callRecordId },
      data: {
        status: input.status,
        providerStatus: input.status,
        transcript: transcript.length ? transcript : record.transcript,
        summary: summary ?? (upgradedFromMissing ? null : record.summary),
        durationSecs: durationSecs ?? record.durationSecs,
        costCredits: costBdt ?? record.costCredits,
        callSid: record.callSid ?? input.callSid ?? null,
        provider: record.provider ?? input.provider ?? null,
        endedAt: record.endedAt ?? now,
        reportReceivedAt: authoritative ? (record.reportReceivedAt ?? now) : record.reportReceivedAt,
      },
    })

    if (record.pendingActionId) {
      const action = await tx.agentPendingAction.findUnique({ where: { id: record.pendingActionId } })
      if (action) {
        const previousResult = action.result && typeof action.result === 'object' ? action.result : {}
        await tx.agentPendingAction.update({
          where: { id: action.id },
          data: {
            status: authoritative ? 'executed' : 'failed',
            resolvedAt: now,
            result: {
              ...previousResult,
              callRecordId: record.id,
              callStatus: input.status,
              reportReady: authoritative,
              summary: summary ?? record.summary ?? null,
            },
          },
        })
      }
    }

    if (record.conversationId) {
      const formatted = formatVoiceCallReport(updated)
      await tx.agentMessage.upsert({
        where: { clientRequestId: `voice-call-report:${record.id}` },
        create: {
          conversationId: record.conversationId,
          clientRequestId: `voice-call-report:${record.id}`,
          role: 'assistant',
          content: [{ type: 'text', text: formatted.chat }],
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        },
        update: { content: [{ type: 'text', text: formatted.chat }] },
      })
      await tx.agentConversation.update({ where: { id: record.conversationId }, data: { updatedAt: now } })
    }

    for (const channel of ['telegram', 'push', 'continuation']) {
      const existing = await tx.agentVoiceCallDelivery.findUnique({
        where: { callId_channel: { callId: record.id, channel } },
      })
      if (!existing) {
        await tx.agentVoiceCallDelivery.create({ data: { callId: record.id, channel } })
      } else if (upgradedFromMissing && existing.status === 'delivered') {
        await tx.agentVoiceCallDelivery.update({
          where: { id: existing.id },
          data: { status: 'pending', attempts: 0, availableAt: now, leaseUntil: null, lastError: null, deliveredAt: null },
        })
      }
    }
    return updated
  })
}

async function runDelivery(row: any): Promise<void> {
  const call = await db.agentVoiceCall.findUnique({ where: { id: row.callId } })
  if (!call) throw new Error('call_not_found')
  const formatted = formatVoiceCallReport(call)

  if (row.channel === 'telegram') {
    const sent = await sendOwnerText(formatted.telegram)
    if (!sent.ok) throw new Error(sent.error ?? 'telegram_not_delivered')
    return
  }
  if (row.channel === 'push') {
    const result = await notifyOwner({
      tier: 2,
      title: formatted.title,
      message: formatted.chat,
      category: 'report',
      actionUrl: '/agent',
      telegramMode: 'never',
    })
    const landed = Object.values(result.statuses).some((status) => status === 'sent' || status === 'held')
    if (!landed) throw new Error(`push_not_delivered:${JSON.stringify(result.statuses).slice(0, 500)}`)
    return
  }
  if (row.channel === 'continuation') {
    if (!call.conversationId) return
    let progressTurnId: string | null = null
    if (call.pendingActionId) {
      const action = await db.agentPendingAction.findUnique({ where: { id: call.pendingActionId } })
      const payload = action?.payload && typeof action.payload === 'object' ? action.payload as Record<string, unknown> : {}
      progressTurnId = typeof payload.progressTurnId === 'string' ? payload.progressTurnId : null
    }
    await enqueueAgentContinuation({
      conversationId: call.conversationId,
      turnId: progressTurnId,
      message:
        `[সিস্টেম নোট — ফোন কলের terminal report database-এ সংরক্ষিত] ${formatted.chat} ` +
        'এখন নতুন conversation history re-read করে Boss-কে call outcome বলো। Approval-কে completion হিসেবে ধরবে না; এই report-ই source of truth।',
    })
    return
  }
  throw new Error(`unknown_delivery_channel:${row.channel}`)
}

export async function dispatchVoiceCallDeliveries(callId?: string, limit = 20, channels?: string[]) {
  const now = new Date()
  const candidates = await db.agentVoiceCallDelivery.findMany({
    where: {
      ...(callId ? { callId } : {}),
      ...(channels?.length ? { channel: { in: channels } } : {}),
      availableAt: { lte: now },
      OR: [
        { status: { in: ['pending', 'retry'] } },
        { status: 'processing', leaseUntil: { lte: now } },
      ],
    },
    orderBy: { availableAt: 'asc' },
    take: limit,
  })
  const results: Array<{ id: string; channel: string; status: string }> = []

  for (const row of candidates) {
    const claimed = await db.agentVoiceCallDelivery.updateMany({
      where: { id: row.id, status: row.status, leaseUntil: row.leaseUntil },
      data: { status: 'processing', leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    })
    if (claimed.count !== 1) continue
    const attempt = row.attempts + 1
    try {
      await runDelivery({ ...row, attempts: attempt })
      await db.agentVoiceCallDelivery.update({
        where: { id: row.id },
        data: { status: 'delivered', deliveredAt: new Date(), leaseUntil: null, lastError: null },
      })
      results.push({ id: row.id, channel: row.channel, status: 'delivered' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const dead = attempt >= MAX_ATTEMPTS
      await db.agentVoiceCallDelivery.update({
        where: { id: row.id },
        data: {
          status: dead ? 'dead' : 'retry',
          availableAt: new Date(Date.now() + retryDelayMs(attempt)),
          leaseUntil: null,
          lastError: message.slice(0, 2000),
        },
      })
      results.push({ id: row.id, channel: row.channel, status: dead ? 'dead' : 'retry' })
    }
  }
  return results
}
