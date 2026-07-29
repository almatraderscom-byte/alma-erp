/**
 * Agent → owner IN-APP two-way call (plan C1, docs/AGENT_APP_CALL_PLAN.md).
 *
 * The ring is an APNs VoIP push (+ FCM on Android) into the owner's own app —
 * CallKit shows a WhatsApp-style full-screen incoming call anywhere in the
 * world, including the UAE where WhatsApp calls are blocked. On answer the app
 * opens a Gemini Live session carrying this call's `purpose` as the opening
 * brief (C2). No Agora, no PSTN, no new vendor.
 *
 * Ring lifecycle: 'ringing' → app posts 'answered'/'declined' → 'completed'.
 * There is no server timer — `getAgentAppCallStatus()` lazily marks a ring
 * older than RING_WINDOW_MS as 'unanswered' and fires the cancel push, so the
 * PA-2 ladder cron and the salah scheduler can poll it without extra infra.
 *
 * Kill switch: AGENT_APP_CALL_ENABLED === 'false' disables ringing (default ON —
 * the owner asked for this path explicitly; flip the env to stop it).
 */
import { prisma } from '@/lib/prisma'
import { getCallPushTargets } from '@/agent/lib/call-push'
import { sendVoipCall, type VoipCallPayload } from '@/agent/lib/apns-voip'
import { sendFcmCall, fcmCallConfigured } from '@/agent/lib/fcm-call'

/** CallKit rings ~60s; small buffer so a just-answered call is not swept. */
export const RING_WINDOW_MS = 75_000

export type AgentAppCallSource = 'ladder' | 'salah' | 'manual'

export type RingOwnerAppResult =
  | { ok: true; callId: string; voipSent: number; fcmSent: number }
  | { ok: false; error: 'disabled' | 'no_owner' | 'no_devices' | 'push_failed' | 'db_error' | 'busy' }

export function agentAppCallEnabled(): boolean {
  return process.env.AGENT_APP_CALL_ENABLED !== 'false'
}

/** Active SUPER_ADMIN users — the owner's ERP identities (device-token keys). */
async function ownerUserIds(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

function ringPayload(callId: string, event: 'ring' | 'cancel'): VoipCallPayload {
  return {
    type: 'agent_call',
    schemaVersion: 1,
    broadcastId: callId,
    callId,
    callUUID: callId,
    channel: `agent_${callId}`,
    caller: 'ALMA',
    expiresAt: new Date(Date.now() + RING_WINDOW_MS).toISOString(),
    event,
  }
}

/**
 * Ring the owner's app. Creates the call row first (the app fetches the brief by
 * id on answer), then fires VoIP + FCM pushes. Best-effort on the push layer but
 * honest in the result: zero delivered pushes = ok:false so callers escalate.
 */
export async function ringOwnerApp(args: {
  purpose: string
  source: AgentAppCallSource
}): Promise<RingOwnerAppResult> {
  if (!agentAppCallEnabled()) return { ok: false, error: 'disabled' }
  void sweepStaleAgentAppCalls().catch(() => 0)

  const owners = await ownerUserIds().catch(() => [])
  if (owners.length === 0) return { ok: false, error: 'no_owner' }

  const { voip, fcm } = await getCallPushTargets(owners).catch(() => ({ voip: [], fcm: [] }))
  if (voip.length === 0 && fcm.length === 0) return { ok: false, error: 'no_devices' }

  // One call at a time (review-bot P2s on PR #653): CallKit is configured for a
  // single call group, so a second ring while ANY call is live/ringing would be
  // rejected on-device while the server happily reported 'ringing'. That covers
  // both our own agent calls AND staff/office calls (OfficeCallSession). This
  // fast check is backed by a partial unique index on agent_app_calls (one
  // active row) so two concurrent ringers cannot both pass check-then-create.
  const busy = await prisma.agentAppCall.findFirst({
    where: {
      OR: [
        { status: 'ringing', createdAt: { gt: new Date(Date.now() - RING_WINDOW_MS) } },
        { status: 'answered', endedAt: null, answeredAt: { gt: new Date(Date.now() - 2 * 3600_000) } },
      ],
    },
    select: { id: true },
  }).catch(() => null)
  if (busy) return { ok: false, error: 'busy' }

  const officeBusy = await prisma.officeCallSession.findFirst({
    where: {
      state: { in: ['RINGING', 'ANSWERED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'] },
      endedAt: null,
      maxEndsAt: { gt: new Date() },
    },
    select: { id: true },
  }).catch(() => null)
  if (officeBusy) return { ok: false, error: 'busy' }

  let callId: string
  try {
    const row = await prisma.agentAppCall.create({
      data: { purpose: args.purpose.slice(0, 2000), source: args.source },
      select: { id: true },
    })
    callId = row.id
  } catch (err) {
    // agent_app_calls_single_active (partial unique index): a concurrent ringer
    // won the claim between our check and this insert — that is 'busy', not a
    // database failure (review-bot P2: check-then-create must be atomic).
    const msg = (err as Error)?.message ?? ''
    const code = (err as { code?: string })?.code
    if (code === 'P2002' || msg.includes('agent_app_calls_single_active')) {
      return { ok: false, error: 'busy' }
    }
    console.warn('[agent-app-call] create failed:', msg)
    return { ok: false, error: 'db_error' }
  }

  const payload = ringPayload(callId, 'ring')
  const [voipResults, fcmResults] = await Promise.all([
    voip.length ? sendVoipCall(voip, payload) : Promise.resolve([]),
    fcm.length && fcmCallConfigured() ? sendFcmCall(fcm, payload) : Promise.resolve([]),
  ])
  const voipSent = voipResults.filter((r) => r.ok).length
  const fcmSent = fcmResults.filter((r) => r.ok).length

  // Only iOS VoIP counts as a RING today: the Android service ignores
  // 'agent_call' payloads until C5, so an FCM delivery must not make the
  // ladder wait through a ring stage nothing actually rang (review-bot P2).
  const rang = voipSent > 0

  await prisma.agentAppCall.update({
    where: { id: callId },
    data: {
      pushResult: {
        voip: { attempted: voip.length, delivered: voipSent },
        fcm: { attempted: fcm.length, delivered: fcmSent, countsAsRing: false },
      },
      ...(rang ? {} : { status: 'failed', endedAt: new Date() }),
    },
  }).catch(() => {})

  if (!rang) return { ok: false, error: 'push_failed' }
  console.log(`[agent-app-call] ring ${callId} (${args.source}) voip=${voipSent} fcm=${fcmSent}`)
  return { ok: true, callId, voipSent, fcmSent }
}

/**
 * Expire every stale ring (review-bot P1: salah rings are fire-and-forget —
 * nobody polls them, so without this they stay 'ringing' forever and the
 * cancel + missed-call pushes never fire). Runs from the 1-min call-escalations
 * cron and opportunistically before each new ring.
 */
export async function sweepStaleAgentAppCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - RING_WINDOW_MS)
  const stale = await prisma.agentAppCall.findMany({
    where: { status: 'ringing', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 20,
  })
  for (const row of stale) await getAgentAppCallStatus(row.id).catch(() => null)

  // An 'answered' row whose end never arrived (app killed mid-call, network
  // drop) would hold the single-active unique index FOREVER and block every
  // future ring. Close anything past the 2h max-call policy.
  const zombie = await prisma.agentAppCall.updateMany({
    where: { status: 'answered', endedAt: null, answeredAt: { lt: new Date(Date.now() - 2 * 3600_000) } },
    data: { status: 'completed', endedAt: new Date() },
  }).catch(() => ({ count: 0 }))

  return stale.length + zombie.count
}

export type AgentAppCallStatus =
  | 'ringing' | 'answered' | 'completed' | 'declined' | 'unanswered' | 'failed'

/**
 * Current status with lazy ring expiry: a still-'ringing' row older than the
 * ring window becomes 'unanswered' and the devices get a cancel push so a
 * delayed delivery cannot ring a phone for a call the ladder already escalated.
 */
export async function getAgentAppCallStatus(id: string): Promise<AgentAppCallStatus | null> {
  const row = await prisma.agentAppCall.findUnique({
    where: { id },
    select: { status: true, createdAt: true },
  })
  if (!row) return null
  if (row.status !== 'ringing') return row.status as AgentAppCallStatus
  if (Date.now() - row.createdAt.getTime() <= RING_WINDOW_MS) return 'ringing'

  const swept = await prisma.agentAppCall.updateMany({
    where: { id, status: 'ringing' },
    data: { status: 'unanswered', endedAt: new Date() },
  })
  if (swept.count === 1) {
    void (async () => {
      try {
        const owners = await ownerUserIds()
        const { voip, fcm } = await getCallPushTargets(owners)
        const cancel = ringPayload(id, 'cancel')
        await Promise.all([
          voip.length ? sendVoipCall(voip, cancel) : Promise.resolve([]),
          fcm.length && fcmCallConfigured() ? sendFcmCall(fcm, cancel) : Promise.resolve([]),
        ])
      } catch { /* cancel is best-effort */ }
      // Missed-call notification (owner request 2026-07-29) — WhatsApp parity.
      // Salah rings are excluded: the salah ladder already notifies on its own
      // cadence, and a missed push per escalation ring would spam every waqt.
      try {
        const row = await prisma.agentAppCall.findUnique({
          where: { id },
          select: { source: true, purpose: true },
        })
        if (row && row.source !== 'salah') {
          const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
          await pushNativeToOwner({
            tier: 1,
            title: '📞 মিসড কল — ALMA',
            message: `ALMA আপনাকে কল দিয়েছিল: ${row.purpose.slice(0, 160)}`,
            category: 'urgent',
            actionUrl: '/agent',
            deliveryId: `agent-call-missed:${id}`,
          })
        }
      } catch { /* missed push is best-effort */ }
    })()
  }
  return 'unanswered'
}

/** App-side status update (answer/decline/hangup) — validated transition only. */
export async function markAgentAppCall(
  id: string,
  status: 'answered' | 'declined' | 'completed',
  summary?: string,
): Promise<boolean> {
  const now = new Date()
  const where =
    status === 'answered'
      ? { id, status: 'ringing' }
      : status === 'declined'
        ? { id, status: { in: ['ringing', 'answered'] } }
        : { id, status: { in: ['ringing', 'answered'] } }
  const data =
    status === 'answered'
      ? { status, answeredAt: now }
      : { status, endedAt: now, ...(summary ? { summary: summary.slice(0, 4000) } : {}) }
  const res = await prisma.agentAppCall.updateMany({ where, data })

  // One device answered → stop the ring on the owner's OTHER devices
  // (review-bot P2). The answering device ignores this cancel: its local call
  // is already marked answered (CallKitVoIP skips cancels for answered calls).
  if (res.count === 1 && status === 'answered') {
    void (async () => {
      try {
        const owners = await ownerUserIds()
        const { voip, fcm } = await getCallPushTargets(owners)
        const cancel = ringPayload(id, 'cancel')
        await Promise.all([
          voip.length ? sendVoipCall(voip, cancel) : Promise.resolve([]),
          fcm.length && fcmCallConfigured() ? sendFcmCall(fcm, cancel) : Promise.resolve([]),
        ])
      } catch { /* best-effort */ }
    })()
  }
  return res.count === 1
}

/** The call's brief for the live session (C2 — /api/assistant/live-session?callId=). */
export async function getAgentAppCallBrief(id: string): Promise<{ purpose: string; source: string } | null> {
  const row = await prisma.agentAppCall.findUnique({
    where: { id },
    select: { purpose: true, source: true },
  })
  return row ?? null
}
