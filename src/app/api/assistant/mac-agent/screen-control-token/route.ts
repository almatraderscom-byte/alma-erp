/**
 * RC-1 — the owner's "🖐 control" switch: mint a CONTROL token for the Mac
 * screen channel, or revoke it.
 *
 * Why a separate token at all (and not the video subscriber token): the video
 * token carries only a join privilege, so it cannot send stream messages —
 * which is exactly the property we want. Control is minted with a granular
 * privilege set (join + publishDataStream, audio/video publish deliberately
 * expired) so a phone holding a control token still cannot push audio or video
 * into the owner's channel. Seeing and touching stay separate rights.
 *
 * The uid is NOT chosen by the caller: it must be one this server minted for
 * this owner in the last few minutes (video-token registers them). Renewing
 * the token on the connection the phone already holds avoids a rejoin — a
 * rejoin would black out the video for a second every time control is armed.
 *
 * Owner session only, kill-switch gated, TTL 120s (the phone renews). Control
 * dies three ways: stream stops (the broadcaster process IS the injector),
 * token/pin expires, or the owner revokes.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { RtcTokenBuilder } from 'agora-token'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isMacAgentEnabled, listDevices } from '@/agent/lib/mac-agent/bus'
import {
  CONTROL_TTL_SEC, ControlHeldByAnother, grantControl, isKnownViewUid, listControlAudit,
  revokeControl,
} from '@/agent/lib/mac-agent/remote-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const appId = process.env.AGORA_APP_ID?.trim()
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim()
  if (!appId || !appCertificate) {
    return Response.json({ error: 'agora_not_configured' }, { status: 503 })
  }
  if (!(await isMacAgentEnabled())) {
    return Response.json(
      { error: 'mac_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 },
    )
  }

  let body: { deviceId?: string; uid?: number; on?: boolean }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const devices = await listDevices()
  const device = body.deviceId
    ? devices.find((d) => d.id === body.deviceId)
    : devices.find((d) => d.online && d.pairedAt)
  if (!device) {
    return Response.json({ error: 'no_device', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 404 })
  }

  if (body.on === false) {
    await revokeControl(device.id, 'owner')
    return Response.json({ ok: true, on: false })
  }

  const uid = Number(body.uid)
  if (!Number.isInteger(uid) || uid <= 0) {
    return Response.json({ error: 'bad_uid' }, { status: 400 })
  }
  // The caller may only upgrade a uid THIS server handed it for THIS device.
  if (!(await isKnownViewUid(device.id, uid))) {
    return Response.json(
      { error: 'uid_not_registered', messageBn: 'আগে লাইভ ভিউ চালু করুন।' }, { status: 409 },
    )
  }

  const channel = `mac-screen-${device.id}`
  // Durations, not timestamps: join + data-stream live for the grant window,
  // audio/video publish expire immediately (0) so this token can never push
  // media into the owner's channel.
  const token = RtcTokenBuilder.buildTokenWithUidAndPrivilege(
    appId, appCertificate, channel, uid,
    CONTROL_TTL_SEC, // tokenExpire
    CONTROL_TTL_SEC, // joinChannel
    0,               // publishAudio  — denied
    0,               // publishVideo  — denied
    CONTROL_TTL_SEC, // publishDataStream
  )
  let pin
  try {
    pin = await grantControl(device.id, uid)
  } catch (err) {
    if (err instanceof ControlHeldByAnother) {
      return Response.json(
        {
          error: 'control_held',
          messageBn: 'আপনার আরেকটি ডিভাইস এখন Mac চালাচ্ছে — সেখানে বন্ধ করে আবার চেষ্টা করুন।',
        },
        { status: 409 },
      )
    }
    throw err
  }

  return Response.json({
    ok: true,
    on: true,
    appId,
    channel,
    uid,
    token,
    sessionId: pin.sessionId,
    expiresAt: Math.floor(Date.parse(pin.expiresAt) / 1000),
    ttlSec: CONTROL_TTL_SEC,
  })
}

/** Owner-facing audit read: the last control sessions with their event counts. */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const deviceId = req.nextUrl.searchParams.get('deviceId')
  const devices = await listDevices()
  const device = deviceId
    ? devices.find((d) => d.id === deviceId)
    : devices.find((d) => d.online && d.pairedAt)
  if (!device) return Response.json({ error: 'no_device' }, { status: 404 })
  return Response.json({ ok: true, deviceId: device.id, sessions: await listControlAudit(device.id) })
}
