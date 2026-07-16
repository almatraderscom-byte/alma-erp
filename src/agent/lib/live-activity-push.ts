/**
 * ActivityKit push sender — the "Business Pulse" Dynamic Panel while the app is
 * closed.
 *
 * A Live Activity can only update itself while the app runs. To make an approval
 * appear on the lock screen seconds after it is created — with a sound — the
 * server must push the new content-state directly to ActivityKit. That is a
 * dedicated APNs push type (`liveactivity`) addressed to a per-activity token
 * the app reports via `activity.pushTokenUpdates`.
 *
 * Config: the SAME APNs .p8 key the VoIP sender already uses (APNS_AUTH_KEY /
 * APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID / APNS_PRODUCTION) — we reuse
 * `apnsJwt()` from apns-voip.ts so there is one signing path and one cached JWT.
 * Only the topic differs: `<bundle>.push-type.liveactivity`.
 *
 * Tokens live on the existing PushSubscription model under a new provider
 * ('apns_liveactivity'), exactly like the VoIP tokens — so NO migration.
 *
 * Everything is fail-open: unconfigured, or a per-token error, never throws to
 * the caller. The panel is a nice-to-have; the ERP must not care if it fails.
 *
 * PRIVACY (spec §15): raw push tokens are NEVER logged.
 */
import http2 from 'node:http2'
import { prisma } from '@/lib/prisma'
import { apnsJwt } from '@/agent/lib/apns-voip'
import type { PulseContentState } from '@/lib/pulse-state'

const PROVIDER = 'apns_liveactivity'

/** Upsert a device's ActivityKit push token, keyed to its ERP user. */
export async function registerLiveActivityToken(args: {
  userId: string
  token: string
  platform?: string
}): Promise<void> {
  const token = args.token.trim()
  if (!token) return
  await prisma.pushSubscription.upsert({
    where: { provider_playerId: { provider: PROVIDER, playerId: token } },
    create: {
      userId: args.userId,
      provider: PROVIDER,
      playerId: token,
      platform: args.platform ?? 'ios',
      enabled: true,
      lastSeenAt: new Date(),
    },
    update: { userId: args.userId, enabled: true, lastSeenAt: new Date() },
  })
}

/** Disable a token APNs reports as dead (410 / BadDeviceToken / Unregistered). */
export async function disableLiveActivityToken(token: string): Promise<void> {
  try {
    await prisma.pushSubscription.updateMany({
      where: { provider: PROVIDER, playerId: token },
      data: { enabled: false },
    })
  } catch {
    /* best-effort */
  }
}

/** Active ActivityKit push tokens for a set of ERP user ids (deduped). */
export async function getLiveActivityTokens(userIds: string[]): Promise<string[]> {
  const ids = userIds.filter(Boolean)
  if (ids.length === 0) return []
  const rows = await prisma.pushSubscription.findMany({
    where: { userId: { in: ids }, enabled: true, provider: PROVIDER },
    select: { playerId: true },
  })
  return [...new Set(rows.map((r) => r.playerId).filter((t): t is string => Boolean(t)))]
}

export type PulsePushAlert = {
  title: string
  body: string
  /** Bundled .caf in the main app bundle. Falls back to 'default' if absent. */
  sound: string
}

export type PulsePushResult = { ok: boolean; status?: number; reason?: string }

/**
 * Push one content-state to every Live Activity token.
 *
 * `alert` is the ONLY thing that makes a sound. Ordinary count/progress updates
 * must pass it as undefined and go out at priority 5 (spec §11.1) — an alerting
 * push goes at priority 10 because it is the thing the owner must see now.
 */
export async function sendPulsePush(
  tokens: string[],
  contentState: PulseContentState,
  alert?: PulsePushAlert,
  opts?: { event?: 'update' | 'end'; dismissAt?: Date },
): Promise<PulsePushResult[]> {
  const uniq = [...new Set(tokens.filter(Boolean))]
  if (uniq.length === 0) return []

  const jwt = apnsJwt()
  if (!jwt) return uniq.map(() => ({ ok: false, reason: 'apns_unconfigured' }))

  const bundle = process.env.APNS_BUNDLE_ID?.trim() || 'com.almatraders.erp'
  const topic = `${bundle}.push-type.liveactivity`
  const host =
    process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'

  const event = opts?.event ?? 'update'
  const aps: Record<string, unknown> = {
    // Seconds, per Apple's ActivityKit push schema.
    timestamp: Math.floor(Date.now() / 1000),
    event,
    'content-state': contentState,
    // Let iOS retire the panel on its own if we ever stop pushing.
    'stale-date': contentState.staleAfterEpoch,
  }
  if (event === 'end' && opts?.dismissAt) {
    aps['dismissal-date'] = Math.floor(opts.dismissAt.getTime() / 1000)
  }
  if (alert) {
    aps.alert = { title: alert.title, body: alert.body, sound: alert.sound }
  }
  const body = JSON.stringify({ aps })

  let client: http2.ClientHttp2Session
  try {
    client = http2.connect(`https://${host}`)
  } catch (err) {
    return uniq.map(() => ({ ok: false, reason: (err as Error)?.message || 'connect_failed' }))
  }

  const sendOne = (deviceToken: string) =>
    new Promise<PulsePushResult>((resolve) => {
      let status = 0
      let data = ''
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'liveactivity',
        // 10 = deliver now (the owner must see it); 5 = power-friendly ambient.
        'apns-priority': alert ? '10' : '5',
        'content-type': 'application/json',
      })
      req.setEncoding('utf8')
      req.on('response', (h) => {
        status = Number(h[':status']) || 0
      })
      req.on('data', (c) => {
        data += c
      })
      req.on('end', () => {
        const ok = status === 200
        let reason: string | undefined
        if (!ok) {
          try {
            reason = (JSON.parse(data || '{}') as { reason?: string }).reason
          } catch {
            reason = data?.slice(0, 120)
          }
          if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
            void disableLiveActivityToken(deviceToken)
          }
        }
        resolve({ ok, status, reason })
      })
      req.on('error', (err) => resolve({ ok: false, reason: err.message }))
      req.setTimeout(8_000, () => {
        req.close()
        resolve({ ok: false, reason: 'timeout' })
      })
      req.end(body)
    })

  try {
    return await Promise.all(uniq.map(sendOne))
  } catch (err) {
    return uniq.map(() => ({ ok: false, reason: (err as Error)?.message || 'send_failed' }))
  } finally {
    try {
      client.close()
    } catch {
      /* already closed */
    }
  }
}
