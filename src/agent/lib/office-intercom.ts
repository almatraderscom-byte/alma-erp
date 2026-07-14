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

/** 'voice' = PTT audio · 'urgent' = full-volume text alert · 'call' = live VoIP ring (Agora channel = itc_<broadcastId>). */
export type IntercomKind = 'voice' | 'urgent' | 'call'

export type IntercomReceipt = {
  staffId: string
  staffName: string
  deliveredAt: string | null
  playedAt: string | null
  confirmedAt: string | null
}

export type IntercomBroadcast = {
  id: string
  kind: IntercomKind
  audioUrl: string | null
  mediaType: string | null
  durationSec: number
  transcript: string | null
  targetStaffId: string | null
  createdAt: string
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
async function activeStaff(businessId: string): Promise<{ id: string; name: string; telegramChatId: string | null; ntfyTopic: string | null; phone: string | null; userId: string | null }[]> {
  const rows = await prisma.agentStaff.findMany({
    where: { businessId, active: true },
    select: {
      id: true,
      name: true,
      telegramChatId: true,
      ntfyTopic: true,
      // user.id = the OneSignal external_id the device registered with, so a
      // call/alert can ring the installed app directly (not only Telegram/ntfy).
      user: { select: { id: true, phone: true } },
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
  }))
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
}): Promise<{ id: string; createdAt: string } | { error: 'no_target_staff' }> {
  const staff = await activeStaff(args.businessId)
  const targets = args.targetStaffId ? staff.filter((s) => s.id === args.targetStaffId) : staff
  if (targets.length === 0) return { error: 'no_target_staff' }

  const row = await prisma.officeIntercomBroadcast.create({
    data: {
      businessId: args.businessId,
      senderUserId: args.senderUserId,
      kind: args.kind,
      audioPath: args.audioPath ?? null,
      audioUrl: args.audioUrl ?? null,
      mediaType: args.mediaType ?? null,
      durationSec: Math.max(0, Math.round(args.durationSec ?? 0)),
      targetStaffId: args.targetStaffId ?? null,
      receipts: { create: targets.map((t) => ({ staffId: t.id })) },
    },
    select: { id: true, createdAt: true },
  })

  // Best-effort push so a closed app still gets a ping. Never blocks the send.
  const title =
    args.kind === 'urgent' ? '🚨 বসের জরুরি এলার্ট' : args.kind === 'call' ? '📞 বস লাইভ কল করছেন' : '🎙️ বসের ভয়েস মেসেজ'
  const body =
    args.kind === 'urgent'
      ? 'এখনই অফিস অ্যাপ খুলুন।'
      : args.kind === 'call'
        ? 'এখনই অফিস অ্যাপ খুলে কল ধরুন।'
        : 'অফিস অ্যাপ খুলে শুনে কনফার্ম করুন।'
  // A call/urgent ring must reach the installed app itself — not just Telegram.
  // OneSignal push (high-priority for call/urgent) carries the broadcast id so
  // the in-app listener can raise the incoming-call ring; Telegram/ntfy stay as
  // the closed-app fallback. All best-effort, in parallel, never blocks.
  const deviceUserIds = targets.map((t) => t.userId).filter((x): x is string => Boolean(x))
  const highPriority = args.kind === 'call' || args.kind === 'urgent'
  const callData =
    args.kind === 'call'
      ? { type: 'office_call', broadcastId: row.id, channel: `itc_${row.id}`, actionUrl: `${OFFICE_URL}` }
      : { type: `office_${args.kind}`, broadcastId: row.id, actionUrl: `${OFFICE_URL}` }
  await Promise.allSettled([
    ...targets.map((t) => pushStaffPing(t, title, body)),
    pushStaffDevice(deviceUserIds, title, body, callData, highPriority),
  ])

  return { id: row.id, createdAt: row.createdAt.toISOString() }
}

/**
 * Intercom feed. Owner gets full receipts per broadcast; a staff caller gets
 * only their own receipt state, and their undelivered receipts are marked
 * delivered as a side effect (their device just fetched the audio).
 */
export async function getIntercomFeed(
  businessId: string,
  viewer: { role: 'owner' } | { role: 'staff'; staffId: string },
): Promise<IntercomFeed> {
  const sinceDate = new Date(Date.now() - FEED_HOURS * 3600_000)

  const rows = await prisma.officeIntercomBroadcast.findMany({
    where: {
      businessId,
      createdAt: { gte: sinceDate },
      // Staff only see broadcasts addressed to them (receipt row exists).
      ...(viewer.role === 'staff' ? { receipts: { some: { staffId: viewer.staffId } } } : {}),
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
    return {
      id: r.id,
      kind: (r.kind as IntercomKind) ?? 'voice',
      audioUrl: r.audioUrl,
      mediaType: r.mediaType,
      durationSec: r.durationSec,
      transcript: r.transcript,
      targetStaffId: r.targetStaffId,
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
        ? staff.map((s) => ({ id: s.id, name: s.name, phone: s.phone }))
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
