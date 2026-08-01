/**
 * L4 — tap-to-reply: the owner answers a session straight from the live dock.
 *
 * When a session on his Mac asks a question, the dock shows it; this endpoint
 * carries his answer to `session_send` without leaving the chat. Owner-session
 * only (cookie auth, same gate as the live-activity feed it pairs with) — this
 * is his own control surface, so it is deliberately NOT in the middleware
 * bypass list.
 *
 * Sending words into an already-running session changes nothing about what the
 * session is ALLOWED to do — the permission mode was fixed at open (plan /
 * acceptEdits / approved bypass), and every command the session runs is still
 * re-judged by the daemon. So a reply is green by construction.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { activeDevice, awaitResult, enqueueCommand, isMacAgentEnabled, listDevices } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REPLY_CHARS = 4_000
/** The daemon writes to the session's stdin — quick; don't hold the phone long. */
const REPLY_WAIT_MS = 30_000

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { sessionId?: string; text?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const sessionId = String(body.sessionId ?? '').trim()
  const text = String(body.text ?? '').trim().slice(0, MAX_REPLY_CHARS)
  if (!sessionId) return Response.json({ error: 'sessionId_required' }, { status: 400 })
  if (!text) return Response.json({ error: 'text_required' }, { status: 400 })

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 })
  }

  // The session lives in ONE daemon's memory — the one that emitted its events.
  // With two Macs online, "most recently seen" could pick the other machine and
  // the reply would deterministically die with session_not_found (Codex round
  // 3). The event stream already records which device spoke; trust it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const originDeviceId: string | null = await db.macAgentSessionEvent
    .findFirst({
      where: { sessionId },
      orderBy: { at: 'desc' },
      select: { deviceId: true },
    })
    .then((r: { deviceId: string } | null) => r?.deviceId ?? null)
    .catch(() => null)

  let device = null
  if (originDeviceId) {
    device = (await listDevices()).find((d) => d.id === originDeviceId && d.online) ?? null
    if (!device) {
      return Response.json(
        { error: 'origin_mac_offline', messageBn: 'সেশনটা যে Mac-এ চলছে সেটা এখন অফলাইন।' },
        { status: 409 },
      )
    }
  } else {
    // No events recorded for this session (pre-L4 daemon) — best effort.
    device = await activeDevice()
  }
  if (!device) {
    return Response.json(
      { error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন — উত্তরটা পৌঁছানো যায়নি।' },
      { status: 409 },
    )
  }

  const { id } = await enqueueCommand({
    deviceId: device.id,
    action: 'session_send',
    params: { sessionId, text },
  })
  const outcome = await awaitResult(id, REPLY_WAIT_MS)

  if (outcome.timedOut) {
    // Queued and will still be delivered when the daemon picks it up; the owner
    // just doesn't get a synchronous confirmation.
    return Response.json({ ok: true, delivered: false, commandId: id })
  }
  if (outcome.status !== 'done') {
    return Response.json(
      { error: outcome.error ?? 'daemon_error', messageBn: 'সেশনে পাঠানো যায়নি — সেশনটা হয়তো শেষ হয়ে গেছে।' },
      { status: 409 },
    )
  }
  return Response.json({ ok: true, delivered: true, commandId: id })
}
