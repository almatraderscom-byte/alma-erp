/**
 * Office Live Intercom — walkie-talkie voice broadcasts from the owner to staff
 * phones, inside the office group chat.
 *
 * Flow: the owner press-and-holds the mic (PTT) → audio uploads to storage →
 * a broadcast row + one receipt per targeted staff are created → staff clients
 * poll the feed (fast poll), auto-play the audio full-screen, and confirm.
 * Receipts advance delivered → played → confirmed; the owner watches them live
 * on the voice bubble. Telegram/ntfy pings fire best-effort for closed apps.
 *
 * Only the OWNER can broadcast in v1; staff reply by normal chat. The agent
 * fills `transcript` asynchronously (Bangla STT) via the transcribe route.
 */
import { prisma } from '@/lib/prisma'
import { pushStaffPing, pushStaffDevice } from '@/agent/lib/office-notify'
import { getCallPushTargets } from '@/agent/lib/call-push'
import { sendVoipCall } from '@/agent/lib/apns-voip'
import { sendFcmCall } from '@/agent/lib/fcm-call'
import {
  safeRecordOfficeCallEvent,
  summarizeCallDelivery,
} from '@/agent/lib/office-call-observability'
import {
  createCanonicalOfficeCall,
  isCanonicalOfficeCallEnabled,
  resolveBusinessOwnerUserId,
  transitionCanonicalOfficeCall,
} from '@/agent/lib/office-call-domain'

/** 'voice' = PTT audio · 'urgent' = full-volume text alert · 'call' = live VoIP ring (Agora channel = itc_<broadcastId>). */
export type IntercomKind = 'voice' | 'urgent' | 'call'

export type IntercomReceipt = {
  staffId: string
  staffName: string
  deliveredAt: string | null
  playedAt: string | null
  confirmedAt: string | null
}

/** How a live call ended — drives the "stop ringing" signal + missed-call history. */
export type CallEndReason = 'cancelled' | 'declined' | 'missed' | 'completed' | 'failed' | 'busy' | 'push_unreachable'

export type IntercomBroadcast = {
  id: string
  kind: IntercomKind
  audioUrl: string | null
  mediaType: string | null
  durationSec: number
  transcript: string | null
  targetStaffId: string | null
  createdAt: string
  /** Call display name of the caller (staff name or "বস — মারুফ"); null otherwise. */
  callerName: string | null
  /** Set once a call is over (cancelled/declined/missed/completed) — every client
   *  stops ringing / closes the call the moment this is non-null. */
  endedAt: string | null
  endedReason: CallEndReason | null
  canonicalState: string | null
  answeredAt: string | null
  connectedAt: string | null
  callDurationSec: number | null
  /** True when this call row is an INCOMING ring for the polling viewer (they are
   *  the callee and did not place it). The client rings on this — works for both
   *  owner→staff and staff→owner without the client knowing its own user id. */
  incomingForMe: boolean
  /** True when the viewer PLACED this call (they are the caller). */
  outgoingByMe: boolean
  /** Owner feed only — per-staff receipt states. */
  receipts: IntercomReceipt[]
  /** Staff feed only — the polling staff's own receipt. */
  mine: Omit<IntercomReceipt, 'staffId' | 'staffName'> | null
}

export type IntercomStaffInfo = {
  id: string
  name: string
  /** Linked User.phone when present — enables the owner's native tel: live call. */
  phone: string | null
  /** Linked User.profileImageUrl — the call screen shows a real face, not an initial. */
  imageUrl: string | null
}

export type IntercomFeed = {
  broadcasts: IntercomBroadcast[]
  /** Active staff roster (owner clients use it for target pills + call buttons). */
  staff: IntercomStaffInfo[]
  /** Shared Agora channel for the live walkie-talkie (owner + all staff join it). */
  liveChannel: string
  serverNow: string
}

const OFFICE_URL = `${(process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')}/portal/office`

/** Everyone in a business shares one live-intercom Agora channel. */
export function liveIntercomChannel(businessId: string): string {
  return `itc_live_${businessId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64)
}

/** Feed window — broadcasts older than this are history, not live intercom. */
const FEED_HOURS = 24
const FEED_LIMIT = 30

/** Active staff of a business (receipt fan-out + owner roster). */
async function activeStaff(businessId: string): Promise<{ id: string; name: string; telegramChatId: string | null; ntfyTopic: string | null; phone: string | null; userId: string | null; imageUrl: string | null }[]> {
  const rows = await prisma.agentStaff.findMany({
    where: { businessId, active: true },
    select: {
      id: true,
      name: true,
      telegramChatId: true,
      ntfyTopic: true,
      // user.id = the OneSignal external_id the device registered with, so a
      // call/alert can ring the installed app directly (not only Telegram/ntfy).
      user: { select: { id: true, phone: true, profileImageUrl: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    telegramChatId: r.telegramChatId,
    ntfyTopic: r.ntfyTopic,
    phone: r.user?.phone ?? null,
    userId: r.user?.id ?? null,
    imageUrl: r.user?.profileImageUrl ?? null,
  }))
}

const OWNER_LABEL = 'বস — মারুফ'

/** Business-scoped owner resolution — never a global earliest-admin lookup. */
export async function resolveOwnerUserId(businessId: string): Promise<string | null> {
  return resolveBusinessOwnerUserId(businessId)
}

export async function createIntercomBroadcast(args: {
  businessId: string
  senderUserId: string
  kind: IntercomKind
  audioPath?: string | null
  audioUrl?: string | null
  mediaType?: string | null
  durationSec?: number
  targetStaffId?: string | null
  /** kind='call' only: the single callee's User.id (staff.user.id, or the owner's
   *  id for a staff→owner call). Drives the wake push + incoming-ring targeting. */
  targetUserId?: string | null
  /** kind='call' only: caller display name shown on the callee's ring/CallKit. */
  callerName?: string | null
  clientRequestId?: string | null
}): Promise<
  | { id: string; createdAt: string; idempotent?: boolean }
  | { error: 'no_target_staff' | 'busy' | 'idempotency_conflict' | 'invalid_participants' }
> {
  const isCall = args.kind === 'call'
  const staff = await activeStaff(args.businessId)
  // Voice/urgent fan out to a staff subset (targetStaffId, or everyone). A call
  // rings exactly ONE callee: owner→staff has a targetStaffId (one receipt);
  // staff→owner has none (no staff receipts — the owner acks via Agora presence).
  const targets = args.targetStaffId
    ? staff.filter((s) => s.id === args.targetStaffId)
    : isCall
      ? []
      : staff
  if (!isCall && targets.length === 0) return { error: 'no_target_staff' }

  // Resolve the call's single callee user id: an explicit targetUserId (staff→owner)
  // wins; otherwise derive it from the targeted staff row (owner→staff).
  const callTargetUserId = isCall
    ? args.targetUserId ?? (args.targetStaffId ? targets[0]?.userId ?? null : null)
    : null
  if (isCall && !callTargetUserId) return { error: 'no_target_staff' }

  const canonical = isCall && isCanonicalOfficeCallEnabled()
  const canonicalResult = canonical
    ? await createCanonicalOfficeCall({
        businessId: args.businessId,
        callerUserId: args.senderUserId,
        calleeUserId: callTargetUserId!,
        targetStaffId: args.targetStaffId ?? null,
        receiptStaffIds: targets.map((target) => target.id),
        callerName: args.callerName ?? OWNER_LABEL,
        clientRequestId: args.clientRequestId ?? null,
      })
    : null
  if (canonicalResult && !canonicalResult.ok) return { error: canonicalResult.error }

  const row = canonicalResult?.ok
    ? { id: canonicalResult.id, createdAt: new Date(canonicalResult.createdAt) }
    : await prisma.officeIntercomBroadcast.create({
        data: {
          businessId: args.businessId,
          senderUserId: args.senderUserId,
          kind: args.kind,
          audioPath: args.audioPath ?? null,
          audioUrl: args.audioUrl ?? null,
          mediaType: args.mediaType ?? null,
          durationSec: Math.max(0, Math.round(args.durationSec ?? 0)),
          targetStaffId: args.targetStaffId ?? null,
          targetUserId: callTargetUserId,
          callerName: isCall ? args.callerName ?? OWNER_LABEL : null,
          receipts: { create: targets.map((t) => ({ staffId: t.id })) },
        },
        select: { id: true, createdAt: true },
      })

  // A retried create returns the original call without dispatching duplicate wake pushes.
  if (canonicalResult?.ok && canonicalResult.idempotent) {
    return { id: row.id, createdAt: row.createdAt.toISOString(), idempotent: true }
  }

  if (isCall && !canonical) {
    await safeRecordOfficeCallEvent({
      callId: row.id,
      businessId: args.businessId,
      actorUserId: args.senderUserId,
      source: 'server',
      event: 'call.created',
      state: 'ringing',
      metadata: {
        direction: args.targetStaffId ? 'owner_to_staff' : 'staff_to_owner',
        hasTargetUser: Boolean(callTargetUserId),
      },
    })
  }

  // Canonical calls are delivered only by the durable outbox created in the
  // same transaction. The legacy direct-send block remains for flag-off calls.
  if (canonical) {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      ...(canonicalResult?.ok && canonicalResult.idempotent ? { idempotent: true } : {}),
    }
  }

  // Best-effort push so a closed app still gets a ping. Never blocks the send.
  const callerName = args.callerName ?? OWNER_LABEL
  const title =
    args.kind === 'urgent' ? '🚨 বসের জরুরি এলার্ট' : isCall ? `📞 ${callerName} কল করছেন` : '🎙️ বসের ভয়েস মেসেজ'
  const body =
    args.kind === 'urgent'
      ? 'এখনই অফিস অ্যাপ খুলুন।'
      : isCall
        ? 'এখনই অফিস অ্যাপ খুলে কল ধরুন।'
        : 'অফিস অ্যাপ খুলে শুনে কনফার্ম করুন।'
  // A call/urgent ring must reach the installed app itself — not just Telegram.
  // OneSignal push (high-priority for call/urgent) carries the broadcast id so
  // the in-app listener can raise the incoming-call ring; Telegram/ntfy stay as
  // the closed-app fallback. All best-effort, in parallel, never blocks.
  // A call rings its ONE callee (targetUserId); voice/urgent fan out to staff.
  const deviceUserIds = isCall
    ? (callTargetUserId ? [callTargetUserId] : [])
    : targets.map((t) => t.userId).filter((x): x is string => Boolean(x))
  const highPriority = isCall || args.kind === 'urgent'
  const callData = isCall
    ? { type: 'office_call', broadcastId: row.id, channel: `itc_${row.id}`, caller: callerName, actionUrl: `${OFFICE_URL}` }
    : { type: `office_${args.kind}`, broadcastId: row.id, actionUrl: `${OFFICE_URL}` }

  const pushes: Promise<unknown>[] = [
    // Telegram/ntfy fallback only reaches staff (owner has no staff ping row).
    ...(isCall ? [] : targets.map((t) => pushStaffPing(t, title, body))),
    (async () => {
      const startedAt = Date.now()
      const result = await pushStaffDevice(deviceUserIds, title, body, callData, highPriority)
      if (isCall) {
        await safeRecordOfficeCallEvent({
          callId: row.id,
          businessId: args.businessId,
          source: 'server',
          event: 'push.completed',
          provider: 'onesignal',
          success: result.ok,
          latencyMs: Date.now() - startedAt,
          metadata: {
            attempted: result.attempted,
            status: result.status,
            reason: result.reason,
          },
        })
      }
      return result
    })(),
  ]

  // A live call additionally fires the real wake layer: an APNs VoIP push (iOS
  // CallKit) + an FCM high-priority data message (Android full-screen) so the
  // callee's phone rings a native incoming call even when the app is closed.
  // OneSignal/Telegram above stay as fallbacks. All best-effort, never blocks.
  if (isCall && deviceUserIds.length > 0) {
    const voipPayload = {
      type: 'office_call' as const,
      broadcastId: row.id,
      channel: `itc_${row.id}`,
      caller: callerName,
      event: 'ring' as const,
    }
    pushes.push(
      (async () => {
        try {
          const { voip, fcm } = await getCallPushTargets(deviceUserIds)
          await safeRecordOfficeCallEvent({
            callId: row.id,
            businessId: args.businessId,
            source: 'server',
            event: 'push.targets_resolved',
            metadata: { targetUsers: deviceUserIds.length, apnsVoip: voip.length, fcm: fcm.length },
          })
          const apnsStartedAt = Date.now()
          const apnsPromise = (voip.length ? sendVoipCall(voip, voipPayload) : Promise.resolve([])).then(async (results) => {
            const summary = summarizeCallDelivery(results)
            await safeRecordOfficeCallEvent({
              callId: row.id,
              businessId: args.businessId,
              source: 'server',
              event: 'push.completed',
              provider: 'apns_voip',
              success: summary.failed === 0 && summary.attempted > 0,
              latencyMs: Date.now() - apnsStartedAt,
              metadata: summary,
            })
            return results
          })
          const fcmStartedAt = Date.now()
          const fcmPromise = (fcm.length ? sendFcmCall(fcm, voipPayload) : Promise.resolve([])).then(async (results) => {
            const summary = summarizeCallDelivery(results)
            await safeRecordOfficeCallEvent({
              callId: row.id,
              businessId: args.businessId,
              source: 'server',
              event: 'push.completed',
              provider: 'fcm',
              success: summary.failed === 0 && summary.attempted > 0,
              latencyMs: Date.now() - fcmStartedAt,
              metadata: summary,
            })
            return results
          })
          await Promise.allSettled([apnsPromise, fcmPromise])
        } catch (err) {
          console.warn('[office-intercom] call wake push failed:', (err as Error)?.message)
          await safeRecordOfficeCallEvent({
            callId: row.id,
            businessId: args.businessId,
            source: 'server',
            event: 'push.dispatch_failed',
            success: false,
            metadata: { stage: 'target_resolution_or_dispatch' },
          })
        }
      })(),
    )
  }

  await Promise.allSettled(pushes)

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    ...(canonicalResult?.ok && canonicalResult.idempotent ? { idempotent: true } : {}),
  }
}

/**
 * End a live call — cancelled by the caller, declined by the callee, missed
 * (ring timed out), or completed (hung up after talking). First writer wins
 * (endedAt is set only once). Fires a "cancel" wake push to the callee's devices
 * so a still-ringing closed phone stops instantly (WhatsApp-style), and leaves
 * the row as the missed-/completed-call history item the feed renders.
 */
export async function endCall(args: {
  broadcastId: string
  businessId: string
  reason: CallEndReason
  actorUserId: string
}): Promise<{ ok: boolean; alreadyEnded?: boolean; error?: string }> {
  const participant = await prisma.officeIntercomBroadcast.findFirst({
    where: {
      id: args.broadcastId,
      businessId: args.businessId,
      kind: 'call',
      OR: [{ senderUserId: args.actorUserId }, { targetUserId: args.actorUserId }],
    },
    select: { id: true },
  })
  if (!participant) return { ok: false, error: 'forbidden' }

  let canonicalHandled = false
  if (isCanonicalOfficeCallEnabled()) {
    const session = await prisma.officeCallSession.findUnique({ where: { id: args.broadcastId }, select: { id: true } })
    if (session) {
      const reason = args.reason.toUpperCase() as 'DECLINED' | 'CANCELLED' | 'MISSED' | 'COMPLETED' | 'FAILED' | 'BUSY' | 'PUSH_UNREACHABLE'
      const transitioned = await transitionCanonicalOfficeCall({
        callId: args.broadcastId,
        businessId: args.businessId,
        actorUserId: args.actorUserId,
        target: 'ENDED',
        reason,
      })
      if (!transitioned.ok) return { ok: false, error: transitioned.error }
      canonicalHandled = true
    }
  }
  // Atomically claim the end — updateMany with endedAt IS NULL guard.
  const claimed = await prisma.officeIntercomBroadcast.updateMany({
    where: { id: args.broadcastId, businessId: args.businessId, kind: 'call', endedAt: null },
    data: { endedAt: new Date(), endedReason: args.reason },
  })
  if (claimed.count === 0) {
    if (!canonicalHandled) await safeRecordOfficeCallEvent({
      callId: args.broadcastId,
      businessId: args.businessId,
      actorUserId: args.actorUserId,
      source: 'server',
      event: 'call.end_duplicate',
      metadata: { attemptedReason: args.reason },
    })
    return { ok: true, alreadyEnded: true }
  }

  if (!canonicalHandled) await safeRecordOfficeCallEvent({
    callId: args.broadcastId,
    businessId: args.businessId,
    actorUserId: args.actorUserId,
    source: 'server',
    event: 'call.ended',
    state: 'ended',
    metadata: { reason: args.reason },
  })

  const row = await prisma.officeIntercomBroadcast.findFirst({
    where: { id: args.broadcastId, businessId: args.businessId },
    select: { id: true, targetUserId: true, senderUserId: true, callerName: true },
  })
  if (!row) return { ok: true }

  // Ring the "stop" to whoever might still be ringing: the callee (targetUserId).
  // If the callee ended it (decline), also poke the caller so its UI closes fast.
  const notify = new Set<string>()
  if (row.targetUserId) notify.add(row.targetUserId)
  if (row.senderUserId) notify.add(row.senderUserId)
  notify.delete(args.actorUserId) // the actor already knows locally
  const notifyIds = [...notify].filter(Boolean)

  if (notifyIds.length > 0) {
    const cancelData = { type: 'office_call_cancel', broadcastId: row.id, reason: args.reason }
    const voipPayload = {
      type: 'office_call' as const,
      broadcastId: row.id,
      channel: `itc_${row.id}`,
      caller: row.callerName ?? OWNER_LABEL,
      event: 'cancel' as const,
    }
    try {
      const { voip, fcm } = await getCallPushTargets(notifyIds)
      await Promise.allSettled([
        // OneSignal silent-ish cancel (Android extension + web listener close the ring).
        pushStaffDevice(notifyIds, '📞 কল শেষ', 'কল কেটে দেওয়া হয়েছে।', cancelData, true),
        voip.length ? sendVoipCall(voip, voipPayload) : Promise.resolve([]),
        fcm.length ? sendFcmCall(fcm, voipPayload) : Promise.resolve([]),
      ])
    } catch (err) {
      console.warn('[office-intercom] call cancel push failed:', (err as Error)?.message)
    }
  }

  return { ok: true }
}

/**
 * Intercom feed. Owner gets full receipts per broadcast; a staff caller gets
 * only their own receipt state, and their undelivered receipts are marked
 * delivered as a side effect (their device just fetched the audio).
 */
export async function getIntercomFeed(
  businessId: string,
  viewer:
    | { role: 'owner'; userId: string }
    | { role: 'staff'; staffId: string; userId: string },
): Promise<IntercomFeed> {
  const sinceDate = new Date(Date.now() - FEED_HOURS * 3600_000)

  const rows = await prisma.officeIntercomBroadcast.findMany({
    where: {
      businessId,
      createdAt: { gte: sinceDate },
      // Staff see broadcasts addressed to them (receipt row exists) OR calls they
      // placed themselves (their staff→owner outgoing call has no staff receipt).
      ...(viewer.role === 'staff'
        ? { OR: [{ receipts: { some: { staffId: viewer.staffId } } }, { senderUserId: viewer.userId }] }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: FEED_LIMIT,
    select: {
      id: true,
      kind: true,
      audioUrl: true,
      mediaType: true,
      durationSec: true,
      transcript: true,
      targetStaffId: true,
      targetUserId: true,
      senderUserId: true,
      callerName: true,
      endedAt: true,
      endedReason: true,
      createdAt: true,
      receipts: {
        select: { staffId: true, deliveredAt: true, playedAt: true, confirmedAt: true },
      },
    },
  })

  // Staff poll = delivery. Mark this staff's undelivered receipts in one shot.
  if (viewer.role === 'staff' && rows.length > 0) {
    const undelivered = rows
      .filter((r) => r.receipts.some((x) => x.staffId === viewer.staffId && !x.deliveredAt))
      .map((r) => r.id)
    if (undelivered.length > 0) {
      const now = new Date()
      await prisma.officeIntercomReceipt.updateMany({
        where: { broadcastId: { in: undelivered }, staffId: viewer.staffId, deliveredAt: null },
        data: { deliveredAt: now },
      })
      // Reflect in the response without a re-query.
      for (const r of rows) {
        for (const x of r.receipts) {
          if (x.staffId === viewer.staffId && !x.deliveredAt) x.deliveredAt = now
        }
      }
    }
  }

  const staff = await activeStaff(businessId)
  const nameOf = new Map(staff.map((s) => [s.id, s.name]))
  const callIds = rows.filter((row) => row.kind === 'call').map((row) => row.id)
  const canonicalCalls = isCanonicalOfficeCallEnabled() && callIds.length > 0
    ? await prisma.officeCallSession.findMany({
        where: { id: { in: callIds }, businessId },
        select: { id: true, state: true, answeredAt: true, connectedAt: true, endedAt: true },
      })
    : []
  const canonicalOf = new Map(canonicalCalls.map((call) => [call.id, call]))

  const broadcasts: IntercomBroadcast[] = rows.reverse().map((r) => {
    const receipts: IntercomReceipt[] =
      viewer.role === 'owner'
        ? r.receipts.map((x) => ({
            staffId: x.staffId,
            staffName: nameOf.get(x.staffId) ?? 'স্টাফ',
            deliveredAt: x.deliveredAt?.toISOString() ?? null,
            playedAt: x.playedAt?.toISOString() ?? null,
            confirmedAt: x.confirmedAt?.toISOString() ?? null,
          }))
        : []
    const my = viewer.role === 'staff' ? r.receipts.find((x) => x.staffId === viewer.staffId) : undefined
    const isCall = (r.kind as IntercomKind) === 'call'
    const canonical = canonicalOf.get(r.id)
    const effectiveEndedAt = canonical?.endedAt ?? r.endedAt
    const durationSec = canonical?.connectedAt && effectiveEndedAt
      ? Math.max(0, Math.round((effectiveEndedAt.getTime() - canonical.connectedAt.getTime()) / 1000))
      : null
    return {
      id: r.id,
      kind: (r.kind as IntercomKind) ?? 'voice',
      audioUrl: r.audioUrl,
      mediaType: r.mediaType,
      durationSec: r.durationSec,
      transcript: r.transcript,
      targetStaffId: r.targetStaffId,
      callerName: r.callerName ?? null,
      endedAt: effectiveEndedAt?.toISOString() ?? null,
      endedReason: (r.endedReason as CallEndReason | null) ?? null,
      canonicalState: canonical?.state ?? null,
      answeredAt: canonical?.answeredAt?.toISOString() ?? null,
      connectedAt: canonical?.connectedAt?.toISOString() ?? null,
      callDurationSec: durationSec,
      // I'm the callee (ring me) — a call aimed at my user id that I didn't place.
      incomingForMe: isCall && r.targetUserId === viewer.userId && r.senderUserId !== viewer.userId,
      // I placed this call (show my outgoing/waiting UI + call history on my side).
      outgoingByMe: isCall && r.senderUserId === viewer.userId,
      createdAt: r.createdAt.toISOString(),
      receipts,
      mine: my
        ? {
            deliveredAt: my.deliveredAt?.toISOString() ?? null,
            playedAt: my.playedAt?.toISOString() ?? null,
            confirmedAt: my.confirmedAt?.toISOString() ?? null,
          }
        : null,
    }
  })

  return {
    broadcasts,
    staff:
      viewer.role === 'owner'
        ? staff.map((s) => ({ id: s.id, name: s.name, phone: s.phone, imageUrl: s.imageUrl }))
        : [],
    liveChannel: liveIntercomChannel(businessId),
    serverNow: new Date().toISOString(),
  }
}

/** Staff advances their receipt: audio started playing, or they confirmed. */
export async function markIntercomReceipt(args: {
  broadcastId: string
  staffId: string
  action: 'played' | 'confirmed'
}): Promise<boolean> {
  const now = new Date()
  const data =
    args.action === 'played'
      ? { playedAt: now }
      : // Confirming implies the audio reached them even if 'played' never fired.
        { confirmedAt: now }
  const res = await prisma.officeIntercomReceipt.updateMany({
    where: {
      broadcastId: args.broadcastId,
      staffId: args.staffId,
      ...(args.action === 'played' ? { playedAt: null } : { confirmedAt: null }),
    },
    data,
  })
  return res.count > 0
}

/** Idempotent transcript setter — first writer wins. Returns the stored text. */
export async function setIntercomTranscript(args: {
  broadcastId: string
  businessId: string
  text: string
}): Promise<string | null> {
  const row = await prisma.officeIntercomBroadcast.findFirst({
    where: { id: args.broadcastId, businessId: args.businessId },
    select: { id: true, transcript: true },
  })
  if (!row) return null
  if (row.transcript) return row.transcript
  const text = args.text.trim()
  if (!text) return null
  await prisma.officeIntercomBroadcast.update({ where: { id: row.id }, data: { transcript: text } })
  return text
}

/** Fetch one broadcast (transcribe route needs the audio path). */
export async function getIntercomBroadcast(id: string, businessId: string) {
  return prisma.officeIntercomBroadcast.findFirst({
    where: { id, businessId },
    select: { id: true, kind: true, audioPath: true, mediaType: true, transcript: true, durationSec: true },
  })
}
