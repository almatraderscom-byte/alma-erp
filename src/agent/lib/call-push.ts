/**
 * Call-push token registry — the wake layer for WhatsApp-style incoming calls.
 *
 * A live 1:1 office call must ring the callee's phone even when the app is
 * backgrounded or killed. That needs a platform push the OS delivers to a dead
 * process:
 *   • iOS  → an APNs **VoIP** push (PushKit) that CallKit turns into a native
 *            full-screen incoming call. OneSignal cannot send VoIP pushes, so
 *            the app registers its PushKit token here and the server sends the
 *            VoIP push directly (see apns-voip.ts).
 *   • Android → an FCM high-priority **data** message the app turns into a
 *            full-screen-intent call notification.
 *
 * Tokens are stored as rows on the existing PushSubscription model (no schema
 * change) under new providers 'apns_voip' / 'fcm', keyed by the ERP user id —
 * exactly like the OneSignal rows, so senders can target a staff member the
 * same way. Everything here is additive and fail-open: a push-registry hiccup
 * must never break a call or the DB action that placed it.
 */
import { prisma } from '@/lib/prisma'

export type CallPushKind = 'voip' | 'fcm'
const PROVIDER: Record<CallPushKind, string> = { voip: 'apns_voip', fcm: 'fcm' }

/** Upsert a device's call-push token (PushKit VoIP token or FCM token). */
export async function registerCallToken(args: {
  userId: string
  platform: 'ios' | 'android'
  kind: CallPushKind
  token: string
}): Promise<void> {
  const provider = PROVIDER[args.kind]
  const token = args.token.trim()
  if (!token) return
  await prisma.pushSubscription.upsert({
    where: { provider_playerId: { provider, playerId: token } },
    create: {
      userId: args.userId,
      provider,
      playerId: token,
      platform: args.platform,
      enabled: true,
      lastSeenAt: new Date(),
    },
    update: { userId: args.userId, platform: args.platform, enabled: true, lastSeenAt: new Date() },
  })
}

/** Disable a token (called when APNs/FCM reports it stale — 410 / Unregistered). */
export async function disableCallToken(kind: CallPushKind, token: string): Promise<void> {
  try {
    await prisma.pushSubscription.updateMany({
      where: { provider: PROVIDER[kind], playerId: token },
      data: { enabled: false },
    })
  } catch {
    /* best-effort */
  }
}

export type CallPushTargets = { voip: string[]; fcm: string[] }

/** All active VoIP + FCM tokens for a set of ERP user ids (deduped). */
export async function getCallPushTargets(userIds: string[]): Promise<CallPushTargets> {
  const ids = userIds.filter(Boolean)
  if (ids.length === 0) return { voip: [], fcm: [] }
  const rows = await prisma.pushSubscription.findMany({
    where: {
      userId: { in: ids },
      enabled: true,
      provider: { in: [PROVIDER.voip, PROVIDER.fcm] },
    },
    select: { provider: true, playerId: true },
  })
  const voip = new Set<string>()
  const fcm = new Set<string>()
  for (const r of rows) {
    if (!r.playerId) continue
    if (r.provider === PROVIDER.voip) voip.add(r.playerId)
    else if (r.provider === PROVIDER.fcm) fcm.add(r.playerId)
  }
  return { voip: [...voip], fcm: [...fcm] }
}
